// Big Change lane — autonomous feature build in an isolated worktree, gated by a
// forced-comprehension review. Port of nvime's bigchange/* modules. The agent
// builds freely in a detached git worktree; the user must explain every semantic
// block (graded by the agent against the difficulty threshold) before merge.
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import * as store from "./store";
import { BcSession, BcBlock, DIFFICULTY, DIFFICULTY_ORDER } from "./store";
import * as bcAgent from "./agent";
import { parseDiff, hunkSignature, changedLines, BcHunk } from "./diffparse";
import { classify } from "./triviality";
import { runAgent } from "../agentRunner";
import { withTrusted } from "../runtime";
import { workspaceRoot, slugify } from "../paths";
import { repoRoot } from "../git";
import { currentProvider } from "../services";
import { audit } from "../audit";
import { escapeHtml, panelShell } from "../ui/webviewHtml";

let extensionContext: vscode.ExtensionContext;
export function initBigChange(ctx: vscode.ExtensionContext): void {
  extensionContext = ctx;
}

const panels = new Map<number, BigChangePanel>();

export async function createInteractive(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    DIFFICULTY_ORDER.map((d) => ({ label: d, description: DIFFICULTY[d].detail })),
    { placeHolder: "Big Change difficulty (controls review strictness)" }
  );
  if (!pick) return;
  const s = store.create(pick.label as BcSession["difficulty"], currentProvider());
  openSession(s.id);
}

export function openPicker(): void {
  const sessions = store.all();
  if (sessions.length === 0) {
    createInteractive();
    return;
  }
  vscode.window
    .showQuickPick(
      [
        { label: "＋ New Big Change", id: -1 },
        ...sessions.map((s) => ({ label: `[${s.status}] ${s.title}`, description: `${s.difficulty} · #${s.id}`, id: s.id })),
      ],
      { placeHolder: "Big Change projects" }
    )
    .then((pick) => {
      if (!pick) return;
      if ((pick as any).id === -1) createInteractive();
      else openSession((pick as any).id);
    });
}

export function open(): void {
  // resume the most recent in-progress draft, else picker
  const drafts = store.all().filter((s) => s.status === "draft");
  if (drafts.length) openSession(drafts[0].id);
  else openPicker();
}

function openSession(id: number): void {
  let panel = panels.get(id);
  if (panel) {
    panel.reveal();
    return;
  }
  panel = new BigChangePanel(id);
  panels.set(id, panel);
}

const DRAFT_TEMPLATE = `# Title:

## Context
<!-- What exists today and why this change is needed. -->

## Goal
<!-- What the agent should build. Be concrete. -->

## Notes
<!-- Constraints, gotchas, file pointers (reference files with @path/to/file). -->

## Acceptance criteria
- [ ]
`;

class BigChangePanel {
  private panel: vscode.WebviewPanel;
  private busy = false;
  private progress = "";

  constructor(private id: number) {
    this.panel = vscode.window.createWebviewPanel("nvimseBigChange", "Big Change", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.onDidDispose(() => panels.delete(id));
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.render();
    const s = store.get(id);
    if (s && s.status === "intake" && s.intake_history.length === 0 && !s.spec) this.runIntakeKickoff();
  }

  reveal(): void {
    this.panel.reveal();
  }

  private session(): BcSession {
    const s = store.get(this.id);
    if (!s) throw new Error("session gone");
    return s;
  }

  private async onMessage(m: any): Promise<void> {
    const s = this.session();
    switch (m.type) {
      case "saveDraft":
        s.draft = m.text;
        s.title = parseTitle(m.text) || s.title;
        store.save(s);
        break;
      case "submitDraft": {
        const title = parseTitle(m.text);
        if (!title) {
          vscode.window.showWarningMessage("nvimse: add a '# Title:' line before submitting");
          return;
        }
        s.draft = m.text;
        s.title = title;
        s.goal = m.text;
        s.status = "intake";
        store.save(s);
        this.render();
        this.runIntakeKickoff();
        break;
      }
      case "discard":
        await this.discard();
        break;
      case "answerIntake":
        await this.runIntakeFollowup(m.text);
        break;
      case "approveSpec":
        if (!s.spec) {
          vscode.window.showWarningMessage("nvimse: no spec yet");
          return;
        }
        s.spec_approved = true;
        store.save(s);
        await this.build();
        break;
      case "editSpec": {
        const edited = await vscode.window.showInputBox({ prompt: "Edit spec", value: s.spec || "" });
        if (edited != null) {
          s.spec = edited;
          store.save(s);
          this.render();
        }
        break;
      }
      case "approveBlock":
        await this.approveBlock(m.blockId);
        break;
      case "requestChanges":
        await this.requestChanges(m.blockId);
        break;
      case "submitRound":
        await this.submitRound();
        break;
      case "merge":
        await this.merge();
        break;
      case "rebuild":
        await this.build();
        break;
    }
    this.render();
  }

  // ---- intake --------------------------------------------------------------

  private async runIntakeKickoff(): Promise<void> {
    const s = this.session();
    this.busy = true;
    this.render();
    await this.intakeTurn(bcAgent.intakeKickoff(s.goal));
  }

  private async runIntakeFollowup(answer: string): Promise<void> {
    const s = this.session();
    s.intake_history.push({ role: "user", content: answer });
    store.save(s);
    this.busy = true;
    this.render();
    await this.intakeTurn(bcAgent.intakeFollowup(answer));
  }

  private async intakeTurn(prompt: string): Promise<void> {
    const s = this.session();
    const root = repoRoot(workspaceRoot());
    try {
      const result = await runAgent({
        provider: s.provider,
        lane: "critic",
        prompt,
        cwd: root,
        persistSession: true,
        resumeSessionId: s.provider_sessions[s.provider],
        onSessionId: (id) => {
          s.provider_sessions[s.provider] = id;
        },
        onProgress: (t) => {
          this.progress = t.replace(/\n/g, " ").slice(0, 60);
          this.render();
        },
      });
      const spec = bcAgent.extractTag(result.text, "SPEC");
      if (spec) {
        s.spec = spec;
        s.intake_history.push({ role: "assistant", content: "📋 Spec ready — review below." });
      } else {
        const planTag = bcAgent.extractTag(result.text, "PLAN");
        s.intake_history.push({ role: "assistant", content: planTag || result.text.trim() || "(no response)" });
      }
    } catch (e: any) {
      s.intake_history.push({ role: "assistant", content: "[intake failed] " + (e?.message || String(e)) });
    } finally {
      this.busy = false;
      store.save(s);
      this.render();
    }
  }

  // ---- build ---------------------------------------------------------------

  private gitMain(args: string[]): string {
    return execFileSync("git", ["-C", repoRoot(workspaceRoot()), ...args], { encoding: "utf8" }).trim();
  }

  private ensureWorktree(s: BcSession): string {
    const root = repoRoot(workspaceRoot());
    const wtRoot = store.worktreeRoot(extensionContext.globalStorageUri.fsPath, root);
    const wt = path.join(wtRoot, String(s.id));
    if (s.worktree && fs.existsSync(s.worktree) && s.base_commit) return s.worktree;
    s.base_commit = this.gitMain(["rev-parse", "HEAD"]);
    s.base_branch = this.gitMain(["rev-parse", "--abbrev-ref", "HEAD"]);
    fs.mkdirSync(wtRoot, { recursive: true });
    withTrusted(() => execFileSync("git", ["-C", root, "worktree", "add", "--detach", wt, s.base_commit!], { stdio: "ignore" }));
    if (!fs.existsSync(wt)) throw new Error("git worktree add failed");
    s.worktree = wt;
    store.save(s);
    return wt;
  }

  private async build(): Promise<void> {
    const s = this.session();
    const spec = s.spec || s.goal;
    let wt: string;
    try {
      wt = this.ensureWorktree(s);
    } catch (e: any) {
      vscode.window.showErrorMessage("nvimse: " + (e?.message || String(e)));
      return;
    }
    s.status = "building";
    store.save(s);
    this.render();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Big Change: building ${s.title}…`, cancellable: true },
      async (progress, token) => {
        let proc: any;
        token.onCancellationRequested(() => proc?.kill?.("SIGTERM"));
        const result = await runAgent({
          provider: s.provider,
          lane: "bigchange",
          prompt: bcAgent.buildPrompt(spec),
          cwd: wt,
          persistSession: true,
          resumeSessionId: s.worktree_sessions[s.provider],
          onSessionId: (id) => {
            s.worktree_sessions[s.provider] = id;
          },
          onProgress: (t) => progress.report({ message: t.replace(/\n/g, " ").slice(0, 60) }),
          onHandle: (p) => (proc = p),
        });
        audit({ event: "bigchange_build_exit", id: s.id, code: result.code });
      }
    );
    await this.extractBlocks();
  }

  private async extractBlocks(): Promise<void> {
    const s = this.session();
    const wt = s.worktree!;
    withTrusted(() => execFileSync("git", ["-C", wt, "add", "-A", "-N"], { stdio: "ignore" }));
    const base = s.base_commit || "HEAD";
    const diff = withTrusted(() => execFileSync("git", ["-C", wt, "diff", "--no-color", base], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    if (!diff.trim()) {
      vscode.window.showWarningMessage("nvimse Big Change: the agent produced no diff. Stay in build to retry.");
      s.status = "building";
      store.save(s);
      this.render();
      return;
    }
    const hunks = parseDiff(diff);
    s.diff_hunks = hunks as any;

    let groups: any[] | null = null;
    try {
      const result = await runAgent({
        provider: s.provider,
        lane: "critic",
        prompt: bcAgent.groupPrompt(hunks),
        cwd: wt,
        persistSession: true,
        resumeSessionId: s.worktree_sessions[s.provider],
        onSessionId: (id) => (s.worktree_sessions[s.provider] = id),
      });
      groups = bcAgent.extractJsonArray(result.text);
    } catch {
      groups = null;
    }
    s.blocks = assembleBlocks(hunks, groups, s.difficulty, s.blocks);
    s.status = "review";
    store.save(s);
    this.render();
  }

  // ---- review --------------------------------------------------------------

  private blockDiff(block: BcBlock): string {
    const hunks = (this.session().diff_hunks as BcHunk[]).filter((h) => block.hunk_ids.includes(h.id));
    return hunks
      .map((h) => h.header + "\n" + h.lines.map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text).join("\n"))
      .join("\n");
  }

  private async approveBlock(blockId: number): Promise<void> {
    const s = this.session();
    const block = s.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const threshold = DIFFICULTY[s.difficulty].threshold;
    if (threshold === null) {
      block.state = "cleared";
      block.action = "approve";
      store.save(s);
      return;
    }
    const explanation = await vscode.window.showInputBox({
      prompt: `Explain block ${block.id}: ${block.title} (no paste — explain in your own words)`,
    });
    if (explanation == null) return;
    block.action = "approve";
    block.comment = explanation;
    block.state = "explaining";
    store.save(s);
  }

  private async requestChanges(blockId: number): Promise<void> {
    const s = this.session();
    const block = s.blocks.find((b) => b.id === blockId);
    if (!block) return;
    const critique = await vscode.window.showInputBox({ prompt: `Request changes on block ${block.id}: ${block.title}` });
    if (critique == null) return;
    block.action = "request_changes";
    block.comment = critique;
    block.state = "critiquing";
    store.save(s);
  }

  private async submitRound(): Promise<void> {
    const s = this.session();
    const pending = s.blocks.filter((b) => b.state === "explaining" || b.state === "critiquing");
    if (pending.length === 0) {
      vscode.window.showInformationMessage("nvimse: nothing to submit. Approve or request changes on blocks first.");
      return;
    }
    this.busy = true;
    this.render();
    const prompt = bcAgent.gradePrompt(
      s.difficulty,
      pending.map((b) => ({ id: b.id, title: b.title, file: b.file, action: b.action!, comment: b.comment || "", diff: this.blockDiff(b) }))
    );
    let results: any[] | null = null;
    try {
      const result = await runAgent({
        provider: s.provider,
        lane: "bigchange",
        prompt,
        cwd: s.worktree!,
        persistSession: true,
        resumeSessionId: s.worktree_sessions[s.provider],
        onSessionId: (id) => (s.worktree_sessions[s.provider] = id),
      });
      results = bcAgent.extractJsonArray(result.text);
    } catch (e: any) {
      vscode.window.showErrorMessage("nvimse: grading failed: " + (e?.message || String(e)));
    }
    const threshold = DIFFICULTY[s.difficulty].threshold ?? 0;
    let needRecapture = false;
    for (const b of pending) {
      const r = Array.isArray(results) ? results.find((x) => x.id === b.id) : null;
      if (!r) {
        b.agent_response = "[no grade returned — resubmit]";
        continue;
      }
      if (b.action === "approve") {
        const grade = typeof r.grade === "number" ? r.grade : 0;
        b.grade = grade;
        b.agent_response = r.verdict || r.response || null;
        if (grade >= threshold) {
          b.state = "cleared";
          b.hint = null;
        } else {
          b.state = "needs_explanation";
          b.hint = r.hint || "explain more precisely what this does and why";
        }
      } else {
        b.agent_response = r.response || (r.revised ? "fixed" : "critique declined");
        if (r.revised === true) needRecapture = true;
        else b.state = "critique_rejected";
      }
    }
    s.review_round += 1;
    this.busy = false;
    store.save(s);
    if (needRecapture) await this.extractBlocks();
    else this.render();
    if (s.blocks.every((b) => b.state === "cleared")) {
      vscode.window.showInformationMessage(`nvimse: all blocks cleared — grade ${overallGrade(s)}% — press Merge 🔓`);
    }
  }

  // ---- merge ---------------------------------------------------------------

  private async merge(): Promise<void> {
    const s = this.session();
    if (!s.blocks.every((b) => b.state === "cleared")) {
      const cleared = s.blocks.filter((b) => b.state === "cleared").length;
      vscode.window.showWarningMessage(`nvimse: merge locked 🔒 (${cleared}/${s.blocks.length} blocks cleared)`);
      return;
    }
    const root = repoRoot(workspaceRoot());
    // dirty-tree guard: applying the patch onto a dirty tree can conflict.
    const dirty = withTrusted(() => execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" })).trim();
    if (dirty) {
      const proceed = await vscode.window.showWarningMessage(
        "Main working tree has uncommitted changes; applying the Big Change may conflict. Proceed anyway?",
        { modal: true },
        "Proceed"
      );
      if (proceed !== "Proceed") return;
    }
    const defaultBranch = "bigchange/" + slugify(s.title, "change");
    const branch = await vscode.window.showInputBox({ prompt: "Branch name for the Big Change", value: defaultBranch });
    if (!branch) return;
    const wt = s.worktree!;
    try {
      withTrusted(() => execFileSync("git", ["-C", wt, "add", "-A", "-N"], { stdio: "ignore" }));
      const patch = withTrusted(() => execFileSync("git", ["-C", wt, "diff", "--binary", s.base_commit || "HEAD"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
      if (!patch.trim()) {
        vscode.window.showWarningMessage("nvimse: nothing to merge");
        return;
      }
      const patchFile = path.join(require("os").tmpdir(), `nvimse-bc-${s.id}.patch`);
      fs.writeFileSync(patchFile, patch);
      withTrusted(() => execFileSync("git", ["-C", root, "checkout", "-b", branch, s.base_commit || "HEAD"], { stdio: "ignore" }));
      try {
        withTrusted(() => execFileSync("git", ["-C", root, "apply", "--whitespace=nowarn", patchFile], { stdio: "ignore" }));
      } catch {
        withTrusted(() => execFileSync("git", ["-C", root, "apply", "--3way", "--whitespace=nowarn", patchFile], { stdio: "ignore" }));
      }
      fs.unlinkSync(patchFile);
      s.status = "merged";
      s.merged_branch = branch;
      store.save(s);
      audit({ event: "bigchange_merged", id: s.id, branch });
      vscode.window.showInformationMessage(`nvimse: applied Big Change as unstaged changes on '${branch}'. Worktree retained — discard it from the picker.`);
    } catch (e: any) {
      vscode.window.showErrorMessage("nvimse: merge failed: " + (e?.message || String(e)));
      try {
        withTrusted(() => execFileSync("git", ["-C", root, "checkout", s.base_branch || s.base_commit || "-"], { stdio: "ignore" }));
        withTrusted(() => execFileSync("git", ["-C", root, "branch", "-D", branch], { stdio: "ignore" }));
      } catch {
        /* ignore */
      }
    }
    this.render();
  }

  private async discard(): Promise<void> {
    const s = this.session();
    const ok = await vscode.window.showWarningMessage(`Discard Big Change '${s.title}'?`, { modal: true }, "Discard");
    if (ok !== "Discard") return;
    if (s.worktree && fs.existsSync(s.worktree)) {
      const root = repoRoot(workspaceRoot());
      try {
        withTrusted(() => execFileSync("git", ["-C", root, "worktree", "remove", "--force", s.worktree!], { stdio: "ignore" }));
        withTrusted(() => execFileSync("git", ["-C", root, "worktree", "prune"], { stdio: "ignore" }));
      } catch {
        /* ignore */
      }
    }
    store.remove(s.id);
    this.panel.dispose();
  }

  // ---- render --------------------------------------------------------------

  private render(): void {
    const s = store.get(this.id);
    if (!s) {
      this.panel.dispose();
      return;
    }
    this.panel.title = `Big Change · ${s.title}`;
    this.panel.webview.html = this.html(s);
  }

  private html(s: BcSession): string {
    let body = "";
    if (s.status === "draft") {
      const draft = s.draft || DRAFT_TEMPLATE;
      body = `<div class="hint">Structured brief — fill Title / Context / Goal / Notes / Acceptance, then submit.</div>
        <textarea id="draft" rows="22">${escapeHtml(draft)}</textarea>
        <div class="row"><button class="primary" onclick="submitDraft()">⏎ Submit brief</button>
          <button onclick="post({type:'discard'})">Discard</button></div>`;
    } else if (s.status === "intake") {
      const hist = s.intake_history
        .map((m) => `<div class="msg ${m.role}"><b>${m.role}</b><pre>${escapeHtml(m.content)}</pre></div>`)
        .join("");
      const specBlock = s.spec
        ? `<div class="spec"><b>SPEC</b><pre>${escapeHtml(s.spec)}</pre>
            <div class="row"><button class="primary" onclick="post({type:'approveSpec'})">✓ Approve & build</button>
              <button onclick="post({type:'editSpec'})">edit spec</button></div></div>`
        : "";
      body = `<div class="busy">${this.busy ? "agent thinking… " + escapeHtml(this.progress) : ""}</div>
        <div class="hist">${hist}</div>
        ${specBlock}
        <div class="row"><textarea id="answer" rows="3" placeholder="answer the agent's questions / add detail"></textarea>
          <button onclick="answerIntake()">Send</button></div>`;
    } else if (s.status === "building") {
      body = `<div class="hint">Building autonomously in an isolated worktree… (you can close this; it keeps going)</div>
        <div class="row"><button onclick="post({type:'rebuild'})">Retry build / re-extract</button></div>`;
    } else {
      // review / merged
      const grade = overallGrade(s);
      const cleared = s.blocks.filter((b) => b.state === "cleared").length;
      const blocks = s.blocks
        .map((b) => {
          const trivial = b.action === "auto_trivial";
          return `<div class="block ${b.state}">
            <div class="bh"><span class="state">${stateIcon(b.state)}</span> <b>${escapeHtml(b.title)}</b>
              <span class="meta">${escapeHtml(b.file)}${trivial ? " · ⚡ trivial · auto-cleared" : ""}${b.grade != null ? " · " + b.grade + "%" : ""}</span></div>
            ${b.hint ? `<div class="hint2">hint: ${escapeHtml(b.hint)}</div>` : ""}
            ${b.agent_response ? `<div class="resp">${escapeHtml(b.agent_response)}</div>` : ""}
            <pre class="diff">${escapeHtml(this.blockDiff(b))}</pre>
            ${b.state === "cleared" ? "" : `<div class="row"><button onclick="post({type:'approveBlock',blockId:${b.id}})">a · approve & explain</button>
              <button onclick="post({type:'requestChanges',blockId:${b.id}})">r · request changes</button></div>`}
          </div>`;
        })
        .join("");
      body = `<div class="toolbar">
          <span class="meta">${s.difficulty} · ${cleared}/${s.blocks.length} cleared${grade != null ? " · grade " + grade + "%" : ""}</span>
          <button class="primary" onclick="post({type:'submitRound'})">S · submit round</button>
          <button onclick="post({type:'merge'})">M · merge 🔓</button>
          <button onclick="post({type:'discard'})">discard</button>
        </div>
        ${s.status === "merged" ? `<div class="merged">✓ merged to ${escapeHtml(s.merged_branch || "")}</div>` : ""}
        <div class="busy">${this.busy ? "grading…" : ""}</div>
        <div class="blocks">${blocks}</div>`;
    }
    return shell(`Big Change · ${s.title} [${s.status}]`, body);
  }
}

function assembleBlocks(hunks: BcHunk[], groups: any[] | null, difficulty: string, previous: BcBlock[] = []): BcBlock[] {
  const byId = new Map(hunks.map((h) => [h.id, h]));
  const assigned = new Set<string>();
  // carry forward cleared/auto-trivial state for blocks whose content is unchanged
  const priorBySig = new Map(previous.filter((b) => b.state === "cleared").map((b) => [b.signature, b]));
  const blocks: BcBlock[] = [];
  let nextId = 1;
  const addBlock = (title: string, file: string, ids: string[], agentTrivial: boolean) => {
    const valid = ids.filter((id) => byId.has(id) && !assigned.has(id));
    if (valid.length === 0) return;
    valid.forEach((id) => assigned.add(id));
    const sig = valid.map((id) => hunkSignature(byId.get(id)!)).join("\n//\n");
    const changed = valid.flatMap((id) => changedLines(byId.get(id)!));
    const triv = classify(file, changed, agentTrivial, difficulty);
    const carried = priorBySig.get(sig);
    blocks.push({
      id: nextId++,
      title,
      file,
      hunk_ids: valid,
      signature: sig,
      state: carried ? "cleared" : triv.trivial ? "cleared" : "pending",
      action: carried ? carried.action : triv.trivial ? "auto_trivial" : null,
      comment: carried ? carried.comment : null,
      grade: carried ? carried.grade : null,
      hint: null,
      agent_response: carried ? carried.agent_response : null,
      agent_trivial: agentTrivial,
      trivial: carried ? carried.trivial : triv.trivial,
      trivial_category: carried ? carried.trivial_category : triv.category || null,
    });
  };
  if (Array.isArray(groups)) {
    for (const g of groups) {
      if (g && Array.isArray(g.hunk_ids)) addBlock(String(g.title || "change"), String(g.file || ""), g.hunk_ids, g.trivial === true);
    }
  }
  // sweep leftovers into per-file catch-alls
  const leftover = hunks.filter((h) => !assigned.has(h.id));
  const byFile = new Map<string, string[]>();
  for (const h of leftover) {
    const arr = byFile.get(h.file) || [];
    arr.push(h.id);
    byFile.set(h.file, arr);
  }
  for (const [file, ids] of byFile) addBlock(`${path.basename(file)} changes`, file, ids, false);
  return blocks;
}

function overallGrade(s: BcSession): number | null {
  const nonTrivial = s.blocks.filter((b) => b.action !== "auto_trivial");
  if (nonTrivial.length === 0) return null;
  const sum = nonTrivial.reduce((acc, b) => acc + (typeof b.grade === "number" ? b.grade : b.state === "cleared" ? 100 : 0), 0);
  return Math.round(sum / nonTrivial.length);
}

function stateIcon(state: string): string {
  return { pending: "●", explaining: "◐", critiquing: "◐", cleared: "✓", needs_explanation: "✗", critique_rejected: "⚠" }[state] || "●";
}

function parseTitle(text: string): string | null {
  const m = text.match(/#+\s*Title:\s*([^\n]*)/);
  const t = m ? m[1].trim() : "";
  return t || null;
}

function shell(title: string, body: string): string {
  return panelShell(title, body, {
    css: `
  textarea{width:100%;background:#16161e;color:#c8d3f5;border:1px solid #2f334d;border-radius:6px;padding:8px;font-family:inherit;box-sizing:border-box;}
  .row{margin:8px 0;display:flex;gap:6px;align-items:flex-start;} .hint,.hint2{color:#828bb8;font-style:italic;margin:6px 0;}
  .busy{color:#ffc777;min-height:16px;}
  .msg{margin:8px 0;} .msg b{color:#ff966c;} .msg.assistant b{color:#82aaff;} pre{white-space:pre-wrap;margin:4px 0;}
  .spec{border:1px solid #3d5a40;border-radius:6px;padding:10px;margin:10px 0;}
  .block{border:1px solid #2f334d;border-radius:6px;padding:10px;margin:8px 0;} .block.cleared{border-color:#3d5a40;}
  .block.needs_explanation,.block.critique_rejected{border-color:#5a3030;}
  .bh .state{margin-right:4px;} .diff{background:#11121a;padding:8px;border-radius:5px;font-size:12px;max-height:240px;overflow:auto;}
  .resp{color:#c3e88d;margin:4px 0;} .toolbar{margin-bottom:10px;} .merged{color:#c3e88d;font-weight:bold;margin:8px 0;}`,
    script: `
  function submitDraft(){post({type:'submitDraft',text:document.getElementById('draft').value});}
  function answerIntake(){const t=document.getElementById('answer');post({type:'answerIntake',text:t.value});t.value='';}
  const d=document.getElementById('draft'); if(d) d.addEventListener('change',()=>post({type:'saveDraft',text:d.value}));`,
  });
}
