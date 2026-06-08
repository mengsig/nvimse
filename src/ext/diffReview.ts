// Inline diff review — the signature nvime UX, adapted to VS Code.
//
// Each agent patch becomes a DiffSession. We render it in the target editor with:
//   - per-block CodeLenses (Accept / Reject / Accept all / Reject all / Discuss)
//     carrying the RATIONALE / risk / critic verdict banner,
//   - line decorations marking pending / accepted / rejected / conflict blocks,
//   - an on-demand two-pane workspace (native diff) via the Diff command.
// Accepting a block applies it to the live file via a WorkspaceEdit and records
// attribution; conflict detection compares the live slice with the reviewed old
// lines exactly as nvime does.

import * as vscode from "vscode";
import * as path from "path";
import { workspaceRoot } from "./paths";
import {
  DiffSession,
  DiffBlock,
  acceptBlock,
  rejectBlock,
  blockStartLine,
  applyBlocksToLines,
  undoLastAccept,
} from "../core/protocol";
import * as attribution from "./attribution";
import * as risk from "./risk";
import * as verify from "./verify";
import * as policyRules from "./policyRules";
import { audit } from "./audit";
import { config } from "./runtime";

interface ActiveEntry {
  session: DiffSession;
  uri: vscode.Uri;
  onResolved?: (summary: ResolveSummary) => void;
}

export interface ResolveSummary {
  accepted: number;
  total: number;
  forced: number;
  provider: string;
  rationale?: string;
  verdict?: { decision: string; justification?: string };
  path: string;
  originalLines: string[];
  planId?: string;
  planStepId?: number | string;
}

const PROPOSED_SCHEME = "nvimse-proposed";

export class DiffReviewManager implements vscode.CodeLensProvider, vscode.TextDocumentContentProvider {
  private active = new Map<string, ActiveEntry>(); // key: uri.fsPath
  private queue = new Map<string, ActiveEntry[]>();
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  private _onDidChangeProposed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
  readonly onDidChange = this._onDidChangeProposed.event;

  private pendingDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
    isWholeLine: true,
    overviewRulerColor: "#82aaff",
    overviewRulerLane: vscode.OverviewRulerLane.Left,
  });
  private conflictDeco = vscode.window.createTextEditorDecorationType({
    backgroundColor: "rgba(255,150,108,0.25)",
    isWholeLine: true,
    overviewRulerColor: "#ff966c",
  });

  constructor(context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshContext()),
      this.pendingDeco,
      this.conflictDeco
    );
  }

  // --- registration / queueing ----------------------------------------------

  async open(session: DiffSession, onResolved?: (s: ResolveSummary) => void): Promise<{ queued: boolean }> {
    const uri = vscode.Uri.file(absolutePath(session));
    const key = uri.fsPath;
    const entry: ActiveEntry = { session, uri, onResolved };
    if (this.active.has(key) && !this.active.get(key)!.session.isResolved()) {
      const q = this.queue.get(key) || [];
      q.push(entry);
      this.queue.set(key, q);
      vscode.window.showInformationMessage("nvimse: patch queued behind the active diff for this file");
      return { queued: true };
    }
    this.active.set(key, entry);
    if (config().verify.enabled) {
      verify.startForSession(session).catch(() => undefined);
    }
    await this.reveal(entry);
    this.render();
    return { queued: false };
  }

  private async reveal(entry: ActiveEntry): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(entry.uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const first = entry.session.pendingBlocks()[0];
    if (first) {
      const line = Math.max(0, blockStartLine(entry.session, first) - 1);
      editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
    }
    this.setDiffActive(true);
    this.banner(entry);
  }

  private banner(entry: ActiveEntry): void {
    const s = entry.session;
    const parts: string[] = [];
    if (s.rationale) parts.push("RATIONALE: " + s.rationale);
    if (s.verifyAttestation) parts.push("VERIFY: " + s.verifyAttestation);
    const info = risk.assess(s);
    parts.push(risk.bannerText(info));
    if (s.verdict) parts.push(`critic ${s.verdict.decision}: ${s.verdict.justification || ""}`);
    if (s.warnings.length) parts.push("⚠ " + s.warnings.join("; "));
    if (parts.length) vscode.window.setStatusBarMessage("nvimse diff · " + parts.join("  ·  "), 8000);
  }

  sessionFor(uri: vscode.Uri | undefined): DiffSession | null {
    if (!uri) {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return null;
      uri = ed.document.uri;
    }
    const e = this.active.get(uri.fsPath);
    return e ? e.session : null;
  }

  refreshSession(session: DiffSession): void {
    this.banner({ session, uri: vscode.Uri.file(absolutePath(session)) });
    this.render();
  }

  // --- rendering -------------------------------------------------------------

  private render(): void {
    this._onDidChangeCodeLenses.fire();
    this.renderDecorations();
    for (const e of this.active.values()) {
      this._onDidChangeProposed.fire(this.proposedUri(e.session));
    }
  }

  private renderDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const entry = this.active.get(editor.document.uri.fsPath);
    if (!entry) {
      editor.setDecorations(this.pendingDeco, []);
      editor.setDecorations(this.conflictDeco, []);
      return;
    }
    const s = entry.session;
    const pending: vscode.Range[] = [];
    const conflict: vscode.Range[] = [];
    for (const b of s.blocks) {
      if (b.status !== "pending" && b.status !== "conflict") continue;
      const start = Math.max(0, blockStartLine(s, b) - 1);
      const end = Math.max(start, start + Math.max(b.oldCount, 1) - 1);
      const range = new vscode.Range(start, 0, Math.min(end, editor.document.lineCount - 1), 0);
      if (b.status === "conflict") conflict.push(range);
      else pending.push(range);
    }
    editor.setDecorations(this.pendingDeco, pending);
    editor.setDecorations(this.conflictDeco, conflict);
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const entry = this.active.get(document.uri.fsPath);
    if (!entry) return [];
    const s = entry.session;
    const lenses: vscode.CodeLens[] = [];
    const headerRange = new vscode.Range(0, 0, 0, 0);
    const banner = bannerLine(s);
    lenses.push(new vscode.CodeLens(headerRange, { title: `nvimse ▸ ${banner}`, command: "" }));
    lenses.push(new vscode.CodeLens(headerRange, { title: "✓ Accept all", command: "nvimse.acceptAll" }));
    lenses.push(new vscode.CodeLens(headerRange, { title: "✗ Reject all", command: "nvimse.rejectAll" }));
    lenses.push(new vscode.CodeLens(headerRange, { title: "⊞ Open workspace", command: "nvimse.diff" }));
    lenses.push(new vscode.CodeLens(headerRange, { title: "💬 Discuss", command: "nvimse.discussDiff" }));

    for (const b of s.blocks) {
      if (b.status !== "pending" && b.status !== "conflict") continue;
      const start = Math.max(0, blockStartLine(s, b) - 1);
      const line = Math.min(start, Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const label = b.status === "conflict" ? "⚠ conflict — force-accept" : "✓ Accept";
      lenses.push(new vscode.CodeLens(range, { title: label, command: b.status === "conflict" ? "nvimse.acceptForce" : "nvimse.accept", arguments: [b.id] }));
      lenses.push(new vscode.CodeLens(range, { title: "✗ Reject", command: "nvimse.reject", arguments: [b.id] }));
    }
    return lenses;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const fsPath = decodeURIComponent(uri.path);
    for (const e of this.active.values()) {
      if (absolutePath(e.session) === fsPath) {
        return applyBlocksToLines(e.session.originalLines, e.session.blocks, (b) => b.status !== "rejected").join("\n");
      }
    }
    return "";
  }

  private proposedUri(session: DiffSession): vscode.Uri {
    return vscode.Uri.parse(`${PROPOSED_SCHEME}:${encodeURIComponent(absolutePath(session))}?proposed`);
  }

  // --- operations ------------------------------------------------------------

  private currentBlock(session: DiffSession): DiffBlock | null {
    const editor = vscode.window.activeTextEditor;
    const pending = session.pendingBlocks();
    if (pending.length === 0) return null;
    if (!editor) return pending[0];
    const cursor = editor.selection.active.line + 1;
    let best = pending[0];
    let bestDist = Infinity;
    for (const b of pending) {
      const start = blockStartLine(session, b);
      const end = start + Math.max(b.oldCount, 1) - 1;
      if (cursor >= start && cursor <= end) return b;
      const d = Math.min(Math.abs(cursor - start), Math.abs(cursor - end));
      if (d < bestDist) {
        bestDist = d;
        best = b;
      }
    }
    return best;
  }

  private liveLines(uri: vscode.Uri): string[] {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (doc) return doc.getText().split(/\r?\n/);
    return [];
  }

  async accept(blockId?: number, force = false): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const entry = this.active.get(editor.document.uri.fsPath);
    if (!entry) {
      vscode.window.showWarningMessage("nvimse: no active diff in this file");
      return;
    }
    const session = entry.session;

    // gates
    const v = verify.shouldBlockAccept(session);
    if (v.block && !force) {
      vscode.window.showWarningMessage("nvimse: " + v.reason);
      audit({ event: "verify_block", file: session.file, reason: v.reason });
      return;
    }
    if (v.block && force) audit({ event: "verify_force", file: session.file, reason: v.reason });

    const changedLines = session.blocks.reduce((acc, b) => acc + b.oldCount + b.newLines.length, 0);
    const pg = policyRules.guard(session.file, "accept", { changed_lines: changedLines });
    if (!pg.allowed) {
      vscode.window.showWarningMessage("nvimse policy: " + pg.result.reason);
      return;
    }

    if (force) {
      const ok = await risk.confirmForceAccept(session, async (msg) => {
        const pick = await vscode.window.showWarningMessage(msg, { modal: true }, "Force-accept");
        return pick === "Force-accept";
      });
      if (!ok) return;
    }

    const block = blockId != null ? session.blocks.find((b) => b.id === blockId) || null : this.currentBlock(session);
    if (!block) return;

    await this.applyBlock(entry, block, force);
  }

  private async applyBlock(entry: ActiveEntry, block: DiffBlock, force: boolean, skipResolve = false): Promise<void> {
    const live = this.liveLines(entry.uri);
    const result = acceptBlock(entry.session, live, block, force);
    if (result.conflict) {
      vscode.window.showWarningMessage(
        `nvimse: block conflicts with live content (line ${result.conflict.startLine}). Force-accept to override.`
      );
      this.render();
      return;
    }
    if (force) audit({ event: "block_force_applied", file: entry.session.file, start: blockStartLine(entry.session, block) });
    if (result.applied && result.newLines !== live) {
      await this.writeLines(entry.uri, result.newLines);
      // attribution — anchored to the applied lines (or the deletion site).
      const anchorStart = blockStartLine(entry.session, block);
      const anchorLines = block.newLines.length ? block.newLines : block.oldLines;
      attribution.record({
        file: entry.session.file,
        line1: anchorStart,
        line2: anchorStart + Math.max(anchorLines.length, 1) - 1,
        lines: anchorLines,
        rationale: entry.session.rationale,
        user_rationale: entry.session.userRationale,
        verdict: entry.session.verdict,
        provider: entry.session.provider,
        plan_id: entry.session.planId,
        step_id: entry.session.planStepId,
        forced: force,
        diff_session_id: entry.session.id,
      });
    }
    this.render();
    if (!skipResolve) this.maybeResolve(entry);
  }

  async acceptAll(force = false): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const entry = this.active.get(editor.document.uri.fsPath);
    if (!entry) return;
    const v = verify.shouldBlockAccept(entry.session);
    if (v.block && !force) {
      vscode.window.showWarningMessage("nvimse: " + v.reason);
      audit({ event: "verify_block", file: entry.session.file, reason: v.reason });
      return;
    }
    if (force) {
      const ok = await risk.confirmForceAccept(entry.session, async (msg) => {
        const pick = await vscode.window.showWarningMessage(msg, { modal: true }, "Force-accept");
        return pick === "Force-accept";
      });
      if (!ok) return;
    }
    for (const b of entry.session.pendingBlocks()) {
      await this.applyBlock(entry, b, force, true);
    }
    this.maybeResolve(entry);
  }

  reject(blockId?: number): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const entry = this.active.get(editor.document.uri.fsPath);
    if (!entry) return;
    const block = blockId != null ? entry.session.blocks.find((b) => b.id === blockId) || null : this.currentBlock(entry.session);
    if (!block) return;
    rejectBlock(block);
    this.render();
    this.maybeResolve(entry);
  }

  rejectAll(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const entry = this.active.get(editor.document.uri.fsPath);
    if (!entry) return;
    for (const b of entry.session.pendingBlocks()) rejectBlock(b);
    this.render();
    this.maybeResolve(entry);
  }

  async undo(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    let entry = this.active.get(editor.document.uri.fsPath);
    // undo is allowed even after a session resolved, so long as it is still current
    if (!entry) {
      vscode.window.showInformationMessage("nvimse: no diff to undo here");
      return;
    }
    const live = this.liveLines(entry.uri);
    const res = undoLastAccept(entry.session, live);
    if (!res) {
      vscode.window.showWarningMessage("nvimse: cannot undo — the accepted text changed since it was applied");
      return;
    }
    await this.writeLines(entry.uri, res.newLines);
    audit({ event: "block_undo", file: entry.session.file });
    this.render();
  }

  /** Discuss the active diff with the edit agent (port of `gc` / continue_remaining). */
  diffStateSummary(session: DiffSession): { accepted: string[]; rejected: string[]; unresolved: string[] } {
    const accepted: string[] = [];
    const rejected: string[] = [];
    const unresolved: string[] = [];
    for (const b of session.blocks) {
      const text = (b.newLines.length ? b.newLines : b.oldLines).join(" ");
      if (b.status === "accepted") accepted.push(text);
      else if (b.status === "rejected") rejected.push(text);
      else unresolved.push(text);
    }
    return { accepted, rejected, unresolved };
  }

  activeSessionInEditor(): { session: DiffSession; uri: vscode.Uri } | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    const entry = this.active.get(editor.document.uri.fsPath);
    return entry ? { session: entry.session, uri: entry.uri } : null;
  }

  navigate(dir: 1 | -1): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const entry = this.active.get(editor.document.uri.fsPath);
    if (!entry) return;
    const pending = entry.session.pendingBlocks();
    if (!pending.length) return;
    const cursor = editor.selection.active.line + 1;
    const lines = pending.map((b) => blockStartLine(entry.session, b)).sort((a, b) => a - b);
    let target = lines[0];
    if (dir === 1) target = lines.find((l) => l > cursor) ?? lines[0];
    else target = [...lines].reverse().find((l) => l < cursor) ?? lines[lines.length - 1];
    const line = Math.max(0, target - 1);
    editor.selection = new vscode.Selection(line, 0, line, 0);
    editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
  }

  async openWorkspace(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const entry = this.active.get(editor.document.uri.fsPath);
    if (!entry) {
      vscode.window.showInformationMessage("nvimse: no active diff");
      return;
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.proposedUri(entry.session),
      entry.uri,
      `nvimse ◆ ${entry.session.file} — proposed ⟷ live`
    );
  }

  private async writeLines(uri: vscode.Uri, newLines: string[]): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(0, 0, doc.lineCount, 0);
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    edit.replace(uri, full, newLines.join(eol));
    await vscode.workspace.applyEdit(edit);
  }

  private maybeResolve(entry: ActiveEntry): void {
    if (!entry.session.isResolved()) return;
    const s = entry.session;
    const summary: ResolveSummary = {
      accepted: s.acceptedCount(),
      total: s.totalBlocks(),
      forced: s.blocks.filter((b) => b.wasForced).length,
      provider: s.provider,
      rationale: s.rationale,
      verdict: s.verdict,
      path: s.file,
      originalLines: s.originalLines,
      planId: s.planId,
      planStepId: s.planStepId,
    };
    audit({ event: "diff_resolved", path: s.file, accepted: summary.accepted, total: summary.total, rationale: s.rationale, provider: s.provider, verdict: s.verdict?.decision, plan_id: s.planId, plan_step_id: s.planStepId });
    this.active.delete(entry.uri.fsPath);
    this.setDiffActive(false);
    const q = this.queue.get(entry.uri.fsPath);
    if (q && q.length) {
      const next = q.shift()!;
      this.queue.set(entry.uri.fsPath, q);
      this.active.set(entry.uri.fsPath, next);
      this.reveal(next).then(() => this.render());
    }
    entry.onResolved?.(summary);
    if (!entry.onResolved) {
      // ad-hoc edit (no plan executor) — run the after-diff test loop
      import("./testLoop").then((tl) => tl.maybeRunAfterDiff(summary)).catch(() => undefined);
    }
  }

  private refreshContext(): void {
    const editor = vscode.window.activeTextEditor;
    const hasActive = editor ? this.active.has(editor.document.uri.fsPath) : false;
    this.setDiffActive(hasActive);
    this.renderDecorations();
  }

  private setDiffActive(v: boolean): void {
    vscode.commands.executeCommand("setContext", "nvimse.diffActive", v);
  }

  hasActive(uri?: vscode.Uri): boolean {
    if (uri) return this.active.has(uri.fsPath);
    return this.active.size > 0;
  }
}

function absolutePath(session: DiffSession): string {
  if (session.file.startsWith("/")) return session.file;
  return path.join(workspaceRoot(), session.file);
}

function bannerLine(s: DiffSession): string {
  const parts: string[] = [];
  if (s.rationale) parts.push(s.rationale);
  const info = risk.assess(s);
  parts.push(risk.bannerText(info));
  if (s.verdict) parts.push(`critic ${s.verdict.decision}`);
  return parts.join("  ·  ") || `${s.acceptedCount()}/${s.totalBlocks()} resolved`;
}
