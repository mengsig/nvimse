import { config, isDisabled } from "./runtime";
import { nvimePath, writeJsonLine, isoTimestamp, workspaceRoot } from "./paths";
import { shortRef, branch, gitRoot } from "./git";
import * as fs from "fs";

export function auditPath(): string {
  return nvimePath("audit.jsonl", config().audit.path);
}

let writeDisabled = false;

function redact(event: any): any {
  if (config().audit.logPrompts) return event;
  const copy = { ...event };
  delete copy.prompt;
  delete copy.input;
  delete copy.response;
  if (copy.argv) {
    const tool = String(copy.tool || "").split("/").pop();
    if (tool === "claude" || tool === "codex") copy.argv = `${tool} [redacted]`;
  }
  return copy;
}

export function audit(event: Record<string, any>): void {
  if (config().audit.enabled === false || isDisabled() || writeDisabled) return;
  const root = workspaceRoot();
  const enriched = {
    ts: isoTimestamp(),
    cwd: process.cwd(),
    git_root: gitRoot(root) || root,
    git_ref: shortRef(root),
    git_branch: branch(root),
    nvim_pid: process.pid,
    ...redact(event),
  };
  try {
    writeJsonLine(auditPath(), enriched);
  } catch {
    writeDisabled = true;
  }
}

export interface AuditEvent {
  ts?: string;
  event?: string;
  [k: string]: any;
}

export function readEvents(limit = 5000): AuditEvent[] {
  const file = auditPath();
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  const tail = raw.slice(-limit);
  const out: AuditEvent[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

export function readForKind(kind: string, limit = 200): AuditEvent[] {
  return readEvents().filter((e) => e.event === kind).slice(-limit);
}
