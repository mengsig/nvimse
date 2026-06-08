// After-diff test feedback loop — port of test_loop.lua. When enabled, runs the
// project test runner after an edit diff resolves with accepted blocks and, on
// failure, offers to fix (re-run the edit lane), revert, or ignore.
import * as vscode from "vscode";
import { execFile } from "child_process";
import { config } from "./runtime";
import { audit } from "./audit";
import { repoRoot } from "./git";
import { workspaceRoot } from "./paths";
import { detectTestRunner } from "./testRunner";
import { ResolveSummary } from "./diffReview";

const retries = new Map<string, number>();

const FOLLOWUP = (runner: string, captured: string, planMeta: string) =>
  `NVIME TEST-FEEDBACK FOLLOWUP.
The patch you just helped land caused the project test runner to fail.
Read the failure tail below, identify the smallest correct fix, and propose a focused patch.
${planMeta}
Test runner: \`${runner}\`

Failure tail (last lines of stdout+stderr):
----
${captured}
----

Constraints:
  - Stay inside the file you just modified unless the failure clearly points elsewhere.
  - Make the smallest reviewable change.
  - Re-run the same test command, or use the nvime test_run MCP tool if it is available.
  - If the test is wrong (rather than the code), say so explicitly and propose updating the test instead.`;

export async function maybeRunAfterDiff(summary: ResolveSummary): Promise<void> {
  const cfg = config().testLoop;
  if (cfg.enabled !== true || summary.accepted <= 0) return;
  if (summary.planId) return; // plan executor runs its own step tests
  const root = repoRoot(workspaceRoot());
  const runner = cfg.runner || detectTestRunner(root);
  if (!runner) return;
  const key = summary.path;
  audit({ event: "test_loop_start", runner, path: summary.path });

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `nvimse: running tests (${runner})…` }, () =>
    new Promise<void>((resolve) => {
      execFile("sh", ["-c", runner], { cwd: root, timeout: 180000, maxBuffer: 8 * 1024 * 1024 }, async (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
        const captureLines = cfg.captureLines > 0 ? cfg.captureLines : 200;
        const captured = (stdout + stderr).split("\n").slice(-captureLines).join("\n");
        audit({ event: "test_loop_done", runner, code, path: summary.path });
        if (code === 0) {
          retries.set(key, 0);
          vscode.window.setStatusBarMessage("nvimse: tests passed ✓", 4000);
          resolve();
          return;
        }
        const n = (retries.get(key) || 0) + 1;
        retries.set(key, n);
        if (n > cfg.maxRetries) {
          retries.set(key, 0);
          vscode.window.showWarningMessage("nvimse: tests still failing after retries — stopping the loop.");
          resolve();
          return;
        }
        const tail = captured.slice(-400);
        const choice = cfg.autoFix
          ? "Fix with agent"
          : await vscode.window.showWarningMessage(`nvimse: tests failed.\n${tail}`, { modal: true }, "Fix with agent", "Ignore");
        if (choice === "Fix with agent") {
          const { startEdit } = require("./lanes/edit");
          const { resolveSelection } = require("./selectionUtil");
          // open the patched file and re-run the edit lane on the whole file
          try {
            const doc = await vscode.workspace.openTextDocument(require("path").join(root, summary.path));
            await vscode.window.showTextDocument(doc);
          } catch {
            /* ignore */
          }
          const sel = await resolveSelection();
          if (sel) {
            await startEdit({
              intent: FOLLOWUP(runner, captured, ""),
              selection: { ...sel, line1: 1, line2: sel.allLines.length, bodyLines: sel.allLines },
              forceEdit: true,
              provider: summary.provider,
            });
          }
        }
        resolve();
      });
    })
  );
}

export function resetCounters(): void {
  retries.clear();
}
