import * as vscode from "vscode";
import { execFileSync } from "child_process";
import { config } from "./runtime";
import { workspaceRoot } from "./paths";
import { gitRoot } from "./git";
import { listPlans } from "./plan";
import { readForKind } from "./audit";

export function runHealthCheck(output: vscode.OutputChannel): void {
  const lines: string[] = ["nvimse health check", "==================="];
  const cfg = config();
  for (const name of ["claude", "codex"] as const) {
    const cmd = name === "claude" ? cfg.providers.claude.cmd : cfg.providers.codex.cmd;
    try {
      execFileSync("which", [cmd], { stdio: "ignore" });
      lines.push(`✓ provider ${name}: ${cmd} found`);
    } catch {
      lines.push(`⚠ provider ${name}: ${cmd} NOT on PATH`);
    }
  }
  const root = gitRoot(workspaceRoot());
  lines.push(root ? `✓ git root: ${root}` : "⚠ not in a git repo (state falls back to ~/.local/state/nvime)");
  lines.push(`✓ plans: ${listPlans().length}`);
  const blocked = readForKind("blocked").length;
  lines.push(blocked ? `⚠ ${blocked} blocked guard events recorded` : "✓ no blocked guard events");
  lines.push(`provider default: ${cfg.provider}`);
  lines.push(`verify: ${cfg.verify.enabled ? "on" : "off"} · risk: ${cfg.risk.enabled ? "on" : "off"} · devils-advocate(diff): ${cfg.diff.devilsAdvocate} · plan: ${cfg.plan.devilsAdvocate}`);
  output.clear();
  output.appendLine(lines.join("\n"));
  output.show();
}
