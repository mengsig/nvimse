import * as vscode from "vscode";
import { chatStore, selectionStore } from "./sessions";
import { listPlans, overallStatus } from "./plan";
import { config } from "./runtime";
import * as usage from "./usage";

export function statusline(): string {
  let running = 0;
  let total = 0;
  for (const s of [...chatStore.all(), ...selectionStore.all()]) {
    total++;
    if (s.busy) running++;
  }
  const plans = listPlans();
  const inProgress = plans.filter((p) => overallStatus(p) === "in_progress").length;
  const planLabel = plans.length ? (inProgress > 0 ? ` plans ${plans.length}⇢` : ` plans ${plans.length}`) : "";
  if (running > 0) return `nvimse ${running}/${total} running${planLabel}`;
  return `nvimse ${total}${planLabel}`;
}

export function updateStatusBar(item: vscode.StatusBarItem): void {
  const usageLabel = config().usage.statusline ? "  $(zap) " + usage.statuslineLabel() : "";
  item.text = "$(rocket) " + statusline() + usageLabel;
  item.tooltip = "nvimse — open command center";
  item.command = "nvimse.dashboard";
  item.show();
}
