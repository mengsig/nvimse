import * as vscode from "vscode";
import { resolveSelection, toProtoSelection, isNamedFile, ResolvedSelection } from "../selectionUtil";
import { buildEditPrompt, buildPerfPrompt, buildQuickPrompt, looksLikeQuestion } from "../../core/prompts";
import { startSession } from "../../core/protocol";
import { runAgent, isStaleResume } from "../agentRunner";
import { config } from "../runtime";
import * as policyRules from "../policyRules";
import * as intent from "../intent";
import { reviewSession } from "../critic";
import { svc, currentProvider, currentModel } from "../services";
import { ensureSelectionSession, recordSelectionTurn, selectionStore } from "../sessions";
import { buildProjectContext } from "../context";
import { startAsk } from "./ask";
import { ResolveSummary } from "../diffReview";

export interface EditOpts {
  intent?: string;
  provider?: string;
  lane?: "edit" | "perf" | "quick";
  forceEdit?: boolean;
  devilsAdvocate?: boolean;
  selection?: ResolvedSelection;
  planId?: string;
  planStepId?: number | string;
  onResolved?: (summary: ResolveSummary) => void;
}

export async function startEdit(opts: EditOpts = {}): Promise<void> {
  const sel = opts.selection || (await resolveSelection());
  if (!sel) return;
  if (!isNamedFile(sel.uri)) {
    vscode.window.showWarningMessage("nvimse: edit requires a saved file");
    return;
  }
  const lane = opts.lane || "edit";
  const provider = opts.provider || currentProvider("selection");

  // policy gate
  const pg = policyRules.guard(sel.relPath, "edit");
  if (!pg.allowed) {
    vscode.window.showWarningMessage("nvimse policy: " + pg.result.reason);
    return;
  }

  let editIntent = opts.intent;
  if (!editIntent) {
    editIntent = await vscode.window.showInputBox({
      prompt: `nvimse edit · ${sel.relPath}:${sel.line1}-${sel.line2}`,
      placeHolder: "What concrete change? (a bug to fix, feature to implement, literal edit)",
    });
    if (!editIntent) return;
  }

  // intent guard
  if (!opts.forceEdit) {
    const ok = await intent.guard(editIntent, {
      lane: "edit",
      confirm: async (msg) => (await vscode.window.showWarningMessage(msg, "Send", "Cancel")) === "Send",
      notify: (m) => vscode.window.setStatusBarMessage(m, 4000),
    });
    if (!ok) return;
  }

  // question-shaped reroute to ask lane
  if (!opts.forceEdit && lane === "edit" && looksLikeQuestion(editIntent)) {
    await startAsk({ question: editIntent, provider, selection: sel });
    return;
  }

  await runEdit(sel, editIntent, lane, provider, opts);
}

export async function quickFix(opts: { selection?: ResolvedSelection; provider?: string } = {}): Promise<void> {
  const sel = opts.selection || (await resolveSelection());
  if (!sel) return;
  const editIntent = await vscode.window.showInputBox({ prompt: `nvimse quick fix · ${sel.relPath}:${sel.line1}-${sel.line2}` });
  if (!editIntent) return;
  await runEdit(sel, editIntent, "quick", opts.provider || currentProvider("selection"), { forceEdit: true });
}

async function runEdit(sel: ResolvedSelection, editIntent: string, lane: "edit" | "perf" | "quick", provider: string, opts: EditOpts): Promise<void> {
  const out = svc().output;
  const protoSel = toProtoSelection(sel);
  const selBody = sel.bodyLines.join("\n");

  let prompt: string;
  if (lane === "perf") prompt = buildPerfPrompt({ path: sel.relPath, line1: sel.line1, line2: sel.line2, source: sel.source }, editIntent, selBody);
  else if (lane === "quick") prompt = buildQuickPrompt({ path: sel.relPath, line1: sel.line1, line2: sel.line2, source: sel.source }, editIntent, selBody);
  else {
    const projectContext = lane === "edit" ? await buildProjectContext(sel) : null;
    prompt = buildEditPrompt(
      { path: sel.relPath, line1: sel.line1, line2: sel.line2, source: sel.source },
      editIntent,
      selBody,
      { projectContext }
    );
  }

  out.appendLine(`\n[nvimse] ${provider} edit (${lane}) · ${sel.relPath}:${sel.line1}-${sel.line2}`);
  const model = currentModel("selection");
  // ad-hoc edits get a persisted, resumable selection discussion; plan steps use
  // the plan's own provider session, so skip session persistence for them.
  const session = opts.planId ? null : ensureSelectionSession({ path: sel.relPath, line1: sel.line1, line2: sel.line2, source: sel.source }, provider, "edit");
  if (session) session.busy = true;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `nvimse ${provider} edit…`, cancellable: true },
    async (progress, token) => {
      let proc: any;
      token.onCancellationRequested(() => proc?.kill?.("SIGTERM"));
      const result = await runAgent({
        provider,
        lane,
        prompt,
        model,
        maxTurns: config().edit.maxTurns,
        persistSession: !!session,
        resumeSessionId: session ? session.provider_sessions[provider] : null,
        onSessionId: (id) => {
          if (session) session.provider_sessions[provider] = id;
        },
        onProgress: (t) => {
          out.append(t);
          progress.report({ message: t.replace(/\n/g, " ").slice(0, 60) });
        },
        onText: (t) => out.append(t),
        onHandle: (p) => (proc = p),
      });
      if (session) session.busy = false;

      if (result.code !== 0) {
        if (session && isStaleResume(result.text)) {
          delete session.provider_sessions[provider];
          selectionStore.touch(session);
          vscode.window.showWarningMessage("nvimse: provider session expired — run the edit again to start fresh");
        } else {
          vscode.window.showErrorMessage(`nvimse: ${provider} exited ${result.code}`);
        }
        return;
      }
      // record the discussion turn only on a successful, non-empty run
      if (session && result.text.trim()) recordSelectionTurn(session, editIntent, result.text.trim(), "edit");

      let res;
      try {
        res = startSession(protoSel, result.text, provider, prompt);
      } catch (e: any) {
        vscode.window.showWarningMessage("nvimse: " + (e?.message || String(e)));
        return;
      }
      if (res.status === "no_change") {
        out.appendLine(`\n[nvimse] no patch opened${res.message ? " — " + res.message : ""}.`);
        vscode.window.setStatusBarMessage("nvimse: no patch needed", 4000);
        return;
      }
      if (res.session) {
        res.session.planId = opts.planId;
        res.session.planStepId = opts.planStepId;
        await svc().diff.open(res.session, opts.onResolved);

        const devils = opts.devilsAdvocate ?? config().diff.devilsAdvocate === true;
        if (devils) {
          const context = sel.allLines
            .slice(Math.max(0, sel.line1 - 5), Math.min(sel.allLines.length, sel.line2 + 4))
            .map((l, i) => `${String(Math.max(1, sel.line1 - 4) + i).padStart(4)}  ${l}`)
            .join("\n");
          reviewSession(res.session, editIntent, context, provider, (v) => {
            svc().diff.refreshSession(res.session!);
            const level = v.decision === "REJECT" ? vscode.window.showErrorMessage : v.decision === "FLAG" ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
            level(`nvimse critic ${v.decision}: ${v.justification || ""}`);
          });
        }
      }
    }
  );
}
