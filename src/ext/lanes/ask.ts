import * as vscode from "vscode";
import { resolveSelection, toProtoSelection, isNamedFile, ResolvedSelection } from "../selectionUtil";
import { buildAskPrompt, responseHasPatch, wantsEditFollowup } from "../../core/prompts";
import { startSession } from "../../core/protocol";
import { runAgent, isStaleResume } from "../agentRunner";
import { config } from "../runtime";
import { svc, currentProvider, currentModel } from "../services";
import { ensureSelectionSession, recordSelectionTurn, selectionStore } from "../sessions";
import { startEdit } from "./edit";

export interface AskOpts {
  question?: string;
  provider?: string;
  selection?: ResolvedSelection;
}

export async function startAsk(opts: AskOpts = {}): Promise<void> {
  const sel = opts.selection || (await resolveSelection());
  if (!sel) return;
  if (!isNamedFile(sel.uri)) {
    vscode.window.showWarningMessage("nvimse: ask requires a saved file");
    return;
  }
  const provider = opts.provider || currentProvider("selection");
  let question = opts.question;
  if (!question) {
    question = await vscode.window.showInputBox({
      prompt: `nvimse ask · ${sel.relPath}:${sel.line1}-${sel.line2}`,
      placeHolder: "Ask about the selected code (read-only)",
    });
    if (!question) return;
  }
  await runAsk(sel, question, provider);
}

async function runAsk(sel: ResolvedSelection, question: string, provider: string): Promise<void> {
  const out = svc().output;
  const protoSel = toProtoSelection(sel);
  const prompt = buildAskPrompt(
    { path: sel.relPath, line1: sel.line1, line2: sel.line2, source: sel.source },
    question,
    sel.bodyLines.join("\n")
  );
  out.appendLine(`\n[nvimse] ${provider} ask · ${sel.relPath}:${sel.line1}-${sel.line2}\nQ: ${question}`);

  const session = ensureSelectionSession({ path: sel.relPath, line1: sel.line1, line2: sel.line2, source: sel.source }, provider, "ask");
  session.busy = true;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `nvimse ${provider} ask…`, cancellable: true },
    async (progress, token) => {
      let proc: any;
      token.onCancellationRequested(() => proc?.kill?.("SIGTERM"));
      return runAgent({
        provider,
        lane: "ask",
        prompt,
        model: currentModel("selection"),
        maxTurns: config().edit.maxTurns,
        persistSession: true,
        resumeSessionId: session.provider_sessions[provider],
        onSessionId: (id) => {
          session.provider_sessions[provider] = id;
        },
        onProgress: (t) => progress.report({ message: t.replace(/\n/g, " ").slice(0, 60) }),
        onText: (t) => out.append(t),
        onHandle: (p) => (proc = p),
      });
    }
  );

  session.busy = false;
  const answer = result.text.trim();
  if (result.code !== 0 || answer === "") {
    if (isStaleResume(result.text)) {
      delete session.provider_sessions[provider];
      selectionStore.touch(session);
      vscode.window.showWarningMessage("nvimse: provider session expired — ask again to start a fresh conversation");
    }
    out.appendLine("\n[nvimse] ask produced no answer.");
    return;
  }
  recordSelectionTurn(session, question, answer, "ask");
  out.appendLine("\n[nvimse] ask answer:\n" + answer);
  out.show(true);

  // a read-only answer that volunteers a patch still opens an inline diff
  if (responseHasPatch(answer)) {
    try {
      const res = startSession(protoSel, answer, provider, prompt);
      if (res.status === "diff" && res.session) {
        await svc().diff.open(res.session);
        return;
      }
    } catch {
      /* fall through */
    }
  }

  // offer an answer + follow-up loop
  const followup = await vscode.window.showInputBox({
    prompt: "nvimse ask follow-up (or 'fix this' / 'proceed' to switch to edit)",
    placeHolder: "follow-up question, or a fix request to reroute to edit",
  });
  if (!followup) return;
  if (wantsEditFollowup(followup)) {
    await startEdit({ intent: followup, provider, selection: sel, forceEdit: false });
  } else {
    await runAsk(sel, followup, provider);
  }
}
