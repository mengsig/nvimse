import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Plan, PlanStep, getPlan, planContextBlock, setStepStatus, savePlan } from "./plan";
import { ResolvedSelection } from "./selectionUtil";
import { repoRelative, repoRoot } from "./git";
import { workspaceRoot } from "./paths";
import { config } from "./runtime";
import { startEdit } from "./lanes/edit";
import { execFile } from "child_process";

function reanchor(allLines: string[], range: { line1: number; line2: number }, anchor?: string): { line1: number; line2: number } {
  if (!anchor || !anchor.trim()) return range;
  const anchorLines = anchor.split("\n").filter((l) => l !== "");
  if (anchorLines.length === 0) return range;
  const matches: number[] = [];
  for (let i = 0; i <= allLines.length - anchorLines.length; i++) {
    let ok = true;
    for (let j = 0; j < anchorLines.length; j++) {
      if (allLines[i + j] !== anchorLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i + 1);
  }
  if (matches.length === 0) return range;
  // nearest to recorded line1
  matches.sort((a, b) => Math.abs(a - range.line1) - Math.abs(b - range.line1));
  const start = matches[0];
  const span = range.line2 - range.line1;
  return { line1: start, line2: start + span };
}

export async function executeStep(planId: string, stepId: number, intentOverride?: string): Promise<void> {
  const plan = getPlan(planId);
  if (!plan) {
    vscode.window.showErrorMessage("nvimse: plan not found: " + planId);
    return;
  }
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) {
    vscode.window.showErrorMessage("nvimse: step not found");
    return;
  }

  // dependency gate
  const unmet = step.depends_on.filter((d) => {
    const dep = plan.steps.find((s) => s.id === d);
    return dep && dep.status !== "done";
  });
  if (unmet.length) {
    const pick = await vscode.window.showWarningMessage(`Step ${stepId} has unfinished dependencies (${unmet.join(", ")}). Run anyway?`, "Run anyway", "Cancel");
    if (pick !== "Run anyway") return;
  }

  const root = repoRoot(workspaceRoot());
  const absFile = path.isAbsolute(step.file) ? step.file : path.join(root, step.file);

  if (step.range === "new") {
    if (!fs.existsSync(absFile)) {
      fs.mkdirSync(path.dirname(absFile), { recursive: true });
      fs.writeFileSync(absFile, "");
    }
  } else if (!fs.existsSync(absFile)) {
    vscode.window.showErrorMessage("nvimse: step file does not exist: " + step.file);
    return;
  }

  const doc = await vscode.workspace.openTextDocument(absFile);
  const editor = await vscode.window.showTextDocument(doc);
  const allLines = doc.getText().split(/\r?\n/);

  let line1: number;
  let line2: number;
  if (step.range === "new") {
    line1 = 1;
    line2 = Math.max(1, allLines.length);
  } else {
    const r = reanchor(allLines, step.range, step.range_anchor);
    line1 = r.line1;
    line2 = r.line2;
  }
  const startPos = new vscode.Position(line1 - 1, 0);
  const endPos = new vscode.Position(Math.min(line2 - 1, doc.lineCount - 1), doc.lineAt(Math.min(line2 - 1, doc.lineCount - 1)).text.length);
  editor.selection = new vscode.Selection(startPos, endPos);

  if (config().plan.autoOpen !== false) setStepStatus(planId, stepId, "in_progress");

  const sel: ResolvedSelection = {
    editor,
    uri: doc.uri,
    relPath: repoRelative(absFile),
    line1,
    line2,
    source: "plan-step",
    bodyLines: allLines.slice(line1 - 1, line2),
    allLines,
  };
  const context = planContextBlock(plan, step);
  const intent = intentOverride || `${step.intent}\n\n${context}`;

  await startEdit({
    intent,
    selection: sel,
    forceEdit: true,
    devilsAdvocate: config().plan.devilsAdvocate !== false,
    planId,
    planStepId: stepId,
    onResolved: async (summary) => {
      if (summary.accepted === 0) {
        const pick = await vscode.window.showWarningMessage(`Step ${stepId}: every block rejected. Mark blocked?`, "Blocked", "Pending");
        setStepStatus(planId, stepId, pick === "Blocked" ? "blocked" : "pending");
        return;
      }
      await doc.save();
      if (step.tests.length === 0) {
        const pick = await vscode.window.showInformationMessage(`Step ${stepId} applied (${summary.accepted}/${summary.total}). Mark done?`, "Done", "Pending");
        setStepStatus(planId, stepId, pick === "Done" ? "done" : "pending");
        return;
      }
      await runStepTests(plan, step, root);
    },
  });
}

function runStepTests(plan: Plan, step: PlanStep, root: string): Promise<void> {
  const cmd = step.tests.join(" && ");
  return new Promise((resolve) => {
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `nvimse: running step ${step.id} tests…` }, () =>
      new Promise<void>((res) => {
        execFile("sh", ["-lc", cmd], { cwd: root, timeout: 120000, maxBuffer: 8 * 1024 * 1024 }, async (err, stdout, stderr) => {
          const tail = (stdout + stderr).split("\n").slice(-20).join("\n");
          if (!err) {
            const pick = await vscode.window.showInformationMessage(`Step ${step.id} tests passed. Mark done?`, "Done", "Pending");
            setStepStatus(plan.id, step.id, pick === "Done" ? "done" : "pending");
          } else {
            const pick = await vscode.window.showWarningMessage(
              `Step ${step.id} tests FAILED:\n${tail.slice(-400)}`,
              { modal: true },
              "Fix with agent",
              "Mark done anyway",
              "Pending"
            );
            if (pick === "Fix with agent") {
              const fixIntent = `Plan step ${step.id}'s change was applied but its acceptance checks FAILED. Fix it.\n\nAcceptance checks (shell; each must exit 0):\n${cmd}\n\nCaptured output:\n${tail}\n\nAdjust the code in this step's range so every acceptance check passes. Keep the change minimal and focused; do not touch unrelated lines.`;
              await executeStep(plan.id, step.id, fixIntent);
            } else if (pick === "Mark done anyway") {
              setStepStatus(plan.id, step.id, "done");
            } else {
              setStepStatus(plan.id, step.id, "pending");
            }
          }
          res();
          resolve();
        });
      })
    );
  });
}

export function nextPendingStep(plan: Plan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "pending" || s.status === "in_progress");
}

export async function addTestForStep(planId: string, stepId: number): Promise<void> {
  const plan = getPlan(planId);
  const step = plan?.steps.find((s) => s.id === stepId);
  if (!plan || !step) return;
  const root = repoRoot(workspaceRoot());
  const { detectTestFile, detectTestRunner } = require("./testRunner");
  const testFile: string | null = detectTestFile(root);
  if (!testFile) {
    vscode.window.showWarningMessage("nvimse: no test file detected; set nvimse.plan.testFile");
    return;
  }
  const abs = path.join(root, testFile);
  const doc = await vscode.workspace.openTextDocument(abs);
  const editor = await vscode.window.showTextDocument(doc);
  const allLines = doc.getText().split(/\r?\n/);
  const first = Math.max(1, allLines.length - 5);
  const last = Math.max(1, allLines.length);
  editor.selection = new vscode.Selection(first - 1, 0, Math.min(last - 1, doc.lineCount - 1), 0);

  const rangeDesc = step.range === "new" ? "(new file)" : `L${step.range.line1}-${step.range.line2}`;
  const intent = `Add a regression test that exercises the change made by step ${step.id} of plan ${plan.id}.

Step intent (verbatim):
${step.intent}

The change was applied to ${step.file || "?"} ${rangeDesc}.

Required test discipline:
  1. The test MUST fail without the step's change and pass after it.
  2. Append to the END of the selected range; do not rewrite existing tests.
  3. Use the same harness pattern that surrounding tests in this file use.
  4. Keep the test self-contained; create temp files / fixtures as needed.
  5. Name the test clearly so future readers understand what it guards.

Target file: ${testFile}`;

  await startEdit({
    intent,
    forceEdit: true,
    planId,
    planStepId: stepId,
    selection: {
      editor,
      uri: doc.uri,
      relPath: repoRelative(abs),
      line1: first,
      line2: last,
      source: "plan-test-scaffold",
      bodyLines: allLines.slice(first - 1, last),
      allLines,
    },
    onResolved: (summary) => {
      if (summary.accepted === 0) {
        vscode.window.showWarningMessage(`nvimse: step ${stepId} still has no test`);
        return;
      }
      const runner = detectTestRunner(root) || "./scripts/test";
      const p = getPlan(planId)!;
      const st = p.steps.find((x) => x.id === stepId)!;
      if (!st.tests.includes(runner)) {
        st.tests.push(runner);
        savePlan(p);
      }
    },
  });
}
