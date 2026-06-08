import * as vscode from "vscode";
import { refreshConfig, config, setDisabled } from "./ext/runtime";
import { DiffReviewManager } from "./ext/diffReview";
import { setServices, setProvider, currentProvider, setModel } from "./ext/services";
import { startEdit, quickFix } from "./ext/lanes/edit";
import { startAsk } from "./ext/lanes/ask";
import { openChat } from "./ext/ui/chatPanel";
import { openDashboard } from "./ext/ui/dashboard";
import { openPlanPanel, newPlan, focusPlanPanel, closePlanPanel } from "./ext/ui/planPanel";
import * as bigchange from "./ext/bigchange";
import { setExtensionDir } from "./ext/mcp";
import * as mcp from "./ext/mcp";
import { cancelAll } from "./ext/agentRunner";
import { auditPath } from "./ext/audit";
import * as digest from "./ext/digest";
import * as attributionOverlay from "./ext/attributionOverlay";
import { stageReference } from "./ext/ui/chatPanel";
import * as usage from "./ext/usage";
import * as hooks from "./ext/hooks";
import * as pr from "./ext/pr";
import * as policyRules from "./ext/policyRules";
import { recap } from "./ext/recap";
import { resolveLast, flushAll, selectionStore } from "./ext/sessions";
import { updateStatusBar } from "./ext/statusbar";
import { clearRootCache } from "./ext/git";
import { runHealthCheck } from "./ext/health";

export function activate(context: vscode.ExtensionContext): void {
  (global as any).__nvimseWorkspaceFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  setExtensionDir(context.extensionPath);
  refreshConfig();

  const output = vscode.window.createOutputChannel("nvimse");
  const diff = new DiffReviewManager(context);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  setServices({ context, diff, output, statusBar });
  setProvider(config().provider);
  bigchange.initBigChange(context);

  const refresh = () => updateStatusBar(statusBar);
  refresh();

  const reg = (id: string, fn: (...a: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // lanes
  reg("nvimse.edit", () => startEdit());
  reg("nvimse.ask", () => startAsk());
  reg("nvimse.quickFix", () => quickFix());
  reg("nvimse.chat", () => openChat());
  reg("nvimse.chats", () => openDashboard());
  reg("nvimse.dashboard", () => openDashboard());
  reg("nvimse.review", () => openChat());
  reg("nvimse.reviewNow", () => openChat());

  // diff review
  reg("nvimse.accept", (id?: number) => diff.accept(id, false));
  reg("nvimse.acceptForce", (id?: number) => diff.accept(id, true));
  reg("nvimse.acceptAll", () => diff.acceptAll(false));
  reg("nvimse.acceptAllForce", () => diff.acceptAll(true));
  reg("nvimse.reject", (id?: number) => diff.reject(id));
  reg("nvimse.rejectAll", () => diff.rejectAll());
  reg("nvimse.nextBlock", () => diff.navigate(1));
  reg("nvimse.prevBlock", () => diff.navigate(-1));
  reg("nvimse.undoAccept", () => diff.undo());
  reg("nvimse.diff", () => diff.openWorkspace());
  reg("nvimse.discussDiff", async () => {
    const ctx = diff.activeSessionInEditor();
    if (!ctx) {
      vscode.window.showInformationMessage("nvimse: no active diff to discuss");
      return;
    }
    const msg = await vscode.window.showInputBox({ prompt: "nvimse: discuss the active diff with the edit agent" });
    if (!msg) return;
    const state = diff.diffStateSummary(ctx.session);
    const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(ctx.uri));
    const allLines = editor.document.getText().split(/\r?\n/);
    const sel = ctx.session.selection;
    const discussIntent = [
      "NVIME DIFF DISCUSSION MODE.",
      msg,
      "",
      "Current diff review state:",
      `- accepted lines: ${state.accepted.join(" | ") || "(none)"}`,
      `- rejected lines: ${state.rejected.join(" | ") || "(none)"}`,
      `- unresolved lines: ${state.unresolved.join(" | ") || "(none)"}`,
    ].join("\n");
    await startEdit({
      intent: discussIntent,
      forceEdit: true,
      provider: currentProvider("selection"),
      selection: {
        editor,
        uri: ctx.uri,
        relPath: ctx.session.file,
        line1: sel.line1,
        line2: Math.min(sel.line2, allLines.length),
        source: "discuss",
        bodyLines: allLines.slice(sel.line1 - 1, sel.line2),
        allLines,
      },
    });
  });

  // provider / model
  reg("nvimse.provider", async () => {
    const pick = await vscode.window.showQuickPick(["claude", "codex"], { placeHolder: "nvimse provider (current: " + currentProvider() + ")" });
    if (pick) {
      setProvider(pick);
      refresh();
    }
  });
  reg("nvimse.model", async () => {
    const cfg = config();
    const models = currentProvider() === "claude" ? cfg.providers.claude.models : cfg.providers.codex.models;
    const pick = await vscode.window.showQuickPick(["(provider default)", ...models], { placeHolder: "nvimse model" });
    if (pick) setModel(pick === "(provider default)" ? null : pick, "selection");
  });

  // plans
  reg("nvimse.plan", () => openPlanPanel());
  reg("nvimse.planNew", () => newPlan());
  reg("nvimse.planAddTest", () => openPlanPanel());
  reg("nvimse.planFocus", () => focusPlanPanel());
  reg("nvimse.planClose", () => closePlanPanel());

  // big change
  reg("nvimse.bigChange", () => bigchange.open());
  reg("nvimse.bigChangeNew", () => bigchange.createInteractive());

  // recap / pr / hooks / policy / mcp / usage / audit
  reg("nvimse.recap", async () => {
    const arg = await vscode.window.showInputBox({ prompt: "nvimse recap args (e.g. --cached, HEAD~3..HEAD, claude)", value: "" });
    try {
      await recap((arg || "").split(/\s+/).filter(Boolean));
    } catch (e: any) {
      vscode.window.showErrorMessage(e?.message || String(e));
    }
  });
  reg("nvimse.pr", async () => {
    const r = pr.render();
    const doc = await vscode.workspace.openTextDocument(r.path);
    vscode.window.showTextDocument(doc);
  });
  reg("nvimse.hooks", async () => {
    const pick = await vscode.window.showQuickPick(["status", "install", "uninstall"], { placeHolder: "nvimse git hooks" });
    if (pick === "install") vscode.window.showInformationMessage(hooks.install().message);
    else if (pick === "uninstall") vscode.window.showInformationMessage(hooks.uninstall().message);
    else if (pick === "status") {
      const s = hooks.status();
      vscode.window.showInformationMessage(`nvimse hooks: installed=${s.installed} chained=${!!s.chained}`);
    }
  });
  reg("nvimse.policy", async () => {
    const pick = await vscode.window.showQuickPick(["list", "check", "edit"], { placeHolder: "nvimse policy" });
    if (pick === "list") {
      const rules = policyRules.listRules();
      vscode.window.showInformationMessage("nvimse policy: " + rules.map((r) => r.match).join(", "));
    } else if (pick === "check") {
      const editor = vscode.window.activeTextEditor;
      const def = editor ? require("./ext/git").repoRelative(editor.document.uri.fsPath) : "";
      const file = await vscode.window.showInputBox({ prompt: "policy check — path", value: def });
      if (!file) return;
      const lane = (await vscode.window.showQuickPick(["edit", "ask", "plan", "accept"], { placeHolder: "lane" })) || "edit";
      const r = policyRules.evaluate(file, lane);
      vscode.window.showInformationMessage(`nvimse policy [${lane}] ${file}: ${r.allowed ? "ALLOWED" : "BLOCKED"} — ${r.reason}`);
    } else if (pick === "edit") {
      const p = policyRules.policyPath();
      const fs = require("fs");
      if (!fs.existsSync(p)) {
        fs.mkdirSync(require("path").dirname(p), { recursive: true });
        fs.writeFileSync(p, policyRules.defaultRulesJson() + "\n");
      }
      const doc = await vscode.workspace.openTextDocument(p);
      vscode.window.showTextDocument(doc);
    }
  });
  reg("nvimse.mcp", async () => {
    const pick = await vscode.window.showQuickPick(["list", "edit"], { placeHolder: "nvimse mcp" });
    if (pick === "list") {
      const servers = Object.keys(mcp.servers());
      vscode.window.showInformationMessage("nvimse mcp servers: " + (servers.join(", ") || "(none)"));
    } else if (pick === "edit") {
      const doc = await vscode.workspace.openTextDocument(mcp.ensureProjectConfig());
      vscode.window.showTextDocument(doc);
    }
  });
  reg("nvimse.usage", async () => {
    const action = await vscode.window.showQuickPick(["summary", "reset"], { placeHolder: "nvimse usage" });
    if (action === "reset") {
      usage.reset();
      vscode.window.showInformationMessage("nvimse: usage counters reset");
    } else {
      const doc = await vscode.workspace.openTextDocument({ content: usage.summaryText(), language: "markdown" });
      vscode.window.showTextDocument(doc);
    }
    refresh();
  });
  reg("nvimse.audit", async () => {
    const fs = require("fs");
    if (fs.existsSync(auditPath())) {
      const doc = await vscode.workspace.openTextDocument(auditPath());
      vscode.window.showTextDocument(doc);
    } else vscode.window.showInformationMessage("nvimse: no audit log yet");
  });
  reg("nvimse.auditSummary", async () => {
    const days = parseInt((await vscode.window.showInputBox({ prompt: "audit summary — days", value: "7" })) || "7", 10) || 7;
    const doc = await vscode.workspace.openTextDocument({ content: digest.summary(days), language: "markdown" });
    vscode.window.showTextDocument(doc);
  });
  reg("nvimse.auditForces", async () => {
    const doc = await vscode.workspace.openTextDocument({ content: digest.forcesReview(), language: "markdown" });
    vscode.window.showTextDocument(doc);
  });

  // attribution
  reg("nvimse.attribute", () => showAttribution());
  reg("nvimse.blame", () => showAttribution());
  reg("nvimse.attributeShow", () => attributionOverlay.show());
  reg("nvimse.attributeHide", () => attributionOverlay.hide());
  reg("nvimse.attributeToggle", () => attributionOverlay.toggle());
  attributionOverlay.registerAutoRepaint(context);

  // send
  reg("nvimse.send", () => sendToConversation());

  // perf lane
  reg("nvimse.perf", () => startEdit({ lane: "perf", forceEdit: true }));

  // last
  reg("nvimse.last", () => {
    const last = resolveLast();
    if (!last) {
      vscode.window.showInformationMessage("No nvimse conversation to reopen");
      return;
    }
    if (last.kind === "chat") {
      openChat(last.id);
      return;
    }
    const sel = selectionStore.get(last.id);
    if (!sel) return;
    const path = require("path");
    const abs = path.isAbsolute(sel.selection.path) ? sel.selection.path : path.join(require("./ext/paths").workspaceRoot(), sel.selection.path);
    vscode.workspace.openTextDocument(abs).then((doc) => {
      vscode.window.showTextDocument(doc).then((editor) => {
        const l1 = Math.max(0, sel.selection.line1 - 1);
        const l2 = Math.max(l1, Math.min(sel.selection.line2 - 1, doc.lineCount - 1));
        editor.selection = new vscode.Selection(l1, 0, l2, doc.lineAt(l2).text.length);
        editor.revealRange(new vscode.Range(l1, 0, l2, 0), vscode.TextEditorRevealType.InCenter);
        vscode.window.showInformationMessage(`nvimse: reopened ${sel.mode} discussion · ${sel.title}. Use Ask/Edit to continue (resumes the provider session).`);
      });
    });
  });

  // test loop config
  reg("nvimse.testLoop", async () => {
    const c = config().testLoop;
    const pick = await vscode.window.showQuickPick(["status", "reset"], {
      placeHolder: `test loop: enabled=${c.enabled} autoFix=${c.autoFix} maxRetries=${c.maxRetries} runner=${c.runner || "(auto)"} (change in settings)`,
    });
    if (pick === "reset") {
      require("./ext/testLoop").resetCounters();
      vscode.window.showInformationMessage("nvimse: test-loop retry counters reset");
    }
  });

  // lifecycle
  reg("nvimse.cancel", () => {
    cancelAll();
    vscode.window.showInformationMessage("nvimse: cancelled active agents");
  });
  reg("nvimse.disable", () => {
    cancelAll();
    setDisabled(true);
    vscode.window.showWarningMessage("nvimse disabled");
  });
  reg("nvimse.enable", () => {
    setDisabled(false);
    vscode.window.showInformationMessage("nvimse enabled");
  });
  reg("nvimse.health", () => runHealthCheck(output));

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("nvimse")) {
        refreshConfig();
        refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      (global as any).__nvimseWorkspaceFolders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      clearRootCache();
    }),
    output,
    statusBar
  );

  output.appendLine("nvimse activated — No Vibe In My Editor. The model is a guest; guests don't touch the knives.");
}

export function deactivate(): void {
  flushAll();
}

async function showAttribution(): Promise<void> {
  const attribution = require("./ext/attribution");
  const repoRelative = require("./ext/git").repoRelative;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const line = editor.selection.active.line + 1;
  const rel = repoRelative(editor.document.uri.fsPath);
  const bufLines = editor.document.getText().split(/\r?\n/);
  const entries = attribution.forLine(rel, line, bufLines);
  if (!entries.length) {
    vscode.window.showInformationMessage("nvimse: no attribution for this line");
    return;
  }
  const e = entries[0];
  vscode.window.showInformationMessage(
    `nvimse: ${e.plan_id ? "plan " + e.plan_id + " step " + e.step_id : "edit"} · ${e.provider || "?"}${e.forced ? " · FORCED" : ""} · ${e.rationale || "(no rationale)"} · ${e.iso_ts}`
  );
}

async function sendToConversation(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const repoRelative = require("./ext/git").repoRelative;
  const rel = repoRelative(editor.document.uri.fsPath);
  let ref = "@" + rel;
  if (!editor.selection.isEmpty) {
    const l1 = editor.selection.start.line + 1;
    const l2 = editor.selection.end.line + 1;
    ref += l1 === l2 ? ` (line ${l1})` : ` (lines ${l1}-${l2})`;
  }
  stageReference(ref);
}
