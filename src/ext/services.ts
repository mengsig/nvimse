import * as vscode from "vscode";
import { DiffReviewManager } from "./diffReview";

export interface Services {
  context: vscode.ExtensionContext;
  diff: DiffReviewManager;
  output: vscode.OutputChannel;
  statusBar: vscode.StatusBarItem;
}

let services: Services | null = null;

export function setServices(s: Services): void {
  services = s;
}

export function svc(): Services {
  if (!services) throw new Error("nvimse services not initialized");
  return services;
}

/** Per-scope provider/model state (chat + selection). */
const providerState = {
  global: "claude",
  chat: { provider: null as string | null, model: null as string | null },
  selection: { provider: null as string | null, model: null as string | null },
};

export function currentProvider(scope?: "chat" | "selection"): string {
  if (scope && providerState[scope].provider) return providerState[scope].provider!;
  return providerState.global;
}

export function setProvider(name: string, scope?: "chat" | "selection"): void {
  providerState.global = name;
  if (scope) providerState[scope].provider = name;
}

export function currentModel(scope?: "chat" | "selection"): string | null {
  if (scope) return providerState[scope].model;
  return null;
}

export function setModel(model: string | null, scope?: "chat" | "selection"): void {
  if (scope) providerState[scope].model = model;
}
