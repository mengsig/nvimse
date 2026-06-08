// Central agent invocation wrapper. Wraps core/agent.run with config-derived
// tool policy, audit logging, usage recording, MCP injection, and the trusted
// scope used to bracket nvimse's own provider spawns.

import { ChildProcess } from "child_process";
import { run as coreRun, Lane, RunResult, UsageSample } from "../core/agent";
import { config, isDisabled, withTrusted } from "./runtime";
import { toolPolicy } from "./config";
import { audit } from "./audit";
import * as usage from "./usage";
import * as mcp from "./mcp";
import { workspaceRoot } from "./paths";
import { repoRoot } from "./git";

export interface AgentRun {
  provider: string;
  lane: Lane;
  prompt: string;
  cwd?: string;
  input?: string;
  model?: string | null;
  maxTurns?: number | null;
  persistSession?: boolean;
  resumeSessionId?: string | null;
  onText?: (t: string) => void;
  onProgress?: (t: string) => void;
  onSessionId?: (id: string) => void;
  onHandle?: (proc: ChildProcess) => void;
}

const active = new Set<ChildProcess>();

export function cancelAll(): void {
  for (const p of active) {
    try {
      p.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  active.clear();
}

export function hasActive(): boolean {
  return active.size > 0;
}

/** Detect a provider rejecting a --resume id (port of nvime's stale-resume check). */
export function isStaleResume(text: string): boolean {
  const t = (text || "").toLowerCase();
  return t.includes("no conversation found") || t.includes("session not found") || (t.includes("session_id") && t.includes("not found"));
}

export async function runAgent(opts: AgentRun): Promise<RunResult> {
  if (isDisabled()) {
    throw new Error("nvimse is disabled; run nvimse: Enable to re-enable it");
  }
  const cfg = config();
  const providerConfig =
    opts.provider === "claude"
      ? { cmd: cfg.providers.claude.cmd }
      : { cmd: cfg.providers.codex.cmd, reasoningEffort: cfg.providers.codex.reasoningEffort };
  const cwd = opts.cwd || repoRoot(workspaceRoot());
  const mcpConfigPath = opts.lane === "review" || opts.lane === "plan" ? mcp.configPath() : null;

  audit({
    event: "agent_start",
    lane: opts.lane,
    provider: opts.provider,
    cwd,
    persist_session: opts.persistSession,
    resume_session_id: opts.resumeSessionId,
    prompt: opts.prompt,
    input: opts.input,
  });

  let observedUsage: UsageSample | undefined;
  let observedSession = opts.resumeSessionId || undefined;

  const result = await withTrusted(() =>
    coreRun({
      provider: opts.provider,
      providerConfig,
      lane: opts.lane,
      prompt: opts.prompt,
      cwd,
      input: opts.input,
      model: opts.model,
      maxTurns: opts.maxTurns,
      persistSession: opts.persistSession,
      resumeSessionId: opts.resumeSessionId,
      policy: toolPolicy(cfg),
      mcpConfigPath,
      env: process.env,
      onText: opts.onText,
      onProgress: opts.onProgress,
      onSessionId: (id) => {
        observedSession = id;
        opts.onSessionId?.(id);
      },
      onHandle: (proc) => {
        active.add(proc);
        proc.on("close", () => active.delete(proc));
        opts.onHandle?.(proc);
      },
    }).promise
  );

  observedUsage = result.usage;
  if (observedUsage) {
    usage.record({ sample: observedUsage, provider: opts.provider, lane: opts.lane });
  }
  audit({
    event: "agent_exit",
    lane: opts.lane,
    provider: opts.provider,
    code: result.code,
    provider_session_id: observedSession,
    usage: observedUsage,
  });
  return result;
}
