// Provider CLI invocation + streaming JSON parser — a faithful port of
// nvime's lua/nvime/agents.lua. Pure node (child_process); no vscode imports so
// it is reusable by the bench harness and unit tests.

import { spawn, ChildProcess } from "child_process";

export type Lane = "edit" | "perf" | "quick" | "ask" | "review" | "plan" | "critic" | "bigchange";

export interface ProviderConfig {
  cmd: string;
  models?: string[];
  reasoningEffort?: string | null;
}

export interface ToolPolicy {
  reviewAllowShell: boolean;
  reviewAllowWeb: boolean;
  reviewAllowMarkdownWrites: boolean;
  selectionAllowShell: boolean;
  selectionAllowWeb: boolean;
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  reviewAllowShell: true,
  reviewAllowWeb: true,
  reviewAllowMarkdownWrites: true,
  selectionAllowShell: true,
  selectionAllowWeb: true,
};

const BLOCKED_GIT = [
  "commit", "push", "pull", "fetch", "reset", "rebase", "merge", "revert", "tag",
  "clean", "checkout", "switch", "restore", "remote", "config", "apply", "am",
  "cherry-pick", "init", "submodule", "worktree", "filter-branch", "filter-repo",
  "gc", "prune", "repack", "update-ref", "symbolic-ref", "fast-import", "fast-export",
];
const BRANCH_DELETE_FLAGS = ["-d", "-D", "--delete"];
const STASH_DESTRUCTIVE = ["drop", "clear", "pop"];

export function claudeDisallowPatterns(): string {
  const patterns: string[] = [];
  for (const sub of BLOCKED_GIT) patterns.push(`Bash(git ${sub}:*)`);
  for (const flag of BRANCH_DELETE_FLAGS) patterns.push(`Bash(git branch ${flag}:*)`);
  for (const sub of STASH_DESTRUCTIVE) patterns.push(`Bash(git stash ${sub}:*)`);
  for (const shape of ["rm -rf", "rm -fr", "rm -Rf", "rm -fR"]) patterns.push(`Bash(${shape}:*)`);
  return patterns.join(",");
}

function claudeReadTools(allowShell: boolean, allowWeb: boolean): string {
  const tools = ["Read", "Glob", "Grep", "LS"];
  if (allowWeb) tools.push("WebFetch", "WebSearch");
  if (allowShell) tools.push("Bash");
  return tools.join(",");
}

export interface RunOpts {
  provider: string;
  providerConfig: ProviderConfig;
  lane: Lane;
  prompt: string;
  cwd: string;
  input?: string;
  model?: string | null;
  maxTurns?: number | null;
  persistSession?: boolean;
  resumeSessionId?: string | null;
  policy?: ToolPolicy;
  mcpConfigPath?: string | null;
  env?: NodeJS.ProcessEnv;
  onText?: (text: string) => void;
  onProgress?: (text: string) => void;
  onSessionId?: (id: string) => void;
  onHandle?: (proc: ChildProcess) => void;
}

export function buildClaudeArgs(opts: RunOpts): string[] {
  const policy = opts.policy ?? DEFAULT_TOOL_POLICY;
  const args: string[] = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--strict-mcp-config",
    "--exclude-dynamic-system-prompt-sections",
  ];
  if (opts.model && opts.model !== "") args.push("--model", opts.model);
  if (opts.maxTurns && opts.maxTurns > 0) args.push("--max-turns", String(Math.floor(opts.maxTurns)));
  if (opts.resumeSessionId && opts.resumeSessionId !== "") {
    args.push("--resume", opts.resumeSessionId);
  } else if (!opts.persistSession) {
    args.push("--no-session-persistence");
  }

  const lane = opts.lane;
  if (lane === "bigchange") {
    args.push("--dangerously-skip-permissions");
  } else if (lane === "review") {
    const md = policy.reviewAllowMarkdownWrites;
    let tools = claudeReadTools(policy.reviewAllowShell, policy.reviewAllowWeb);
    if (md) tools += ",Write,Edit,MultiEdit";
    const disallowed: string[] = [];
    if (md) disallowed.push("NotebookEdit");
    else disallowed.push("Edit,Write,MultiEdit,NotebookEdit");
    if (!policy.reviewAllowWeb) disallowed.push("WebFetch,WebSearch");
    if (policy.reviewAllowShell) disallowed.push(claudeDisallowPatterns());
    args.push("--permission-mode", "dontAsk", "--tools", tools, "--allowedTools", tools, "--disallowedTools", disallowed.join(","));
  } else if (lane === "plan") {
    const tools = claudeReadTools(true, policy.reviewAllowWeb) + ",Write,Edit,MultiEdit";
    const disallowed = ["NotebookEdit"];
    if (!policy.reviewAllowWeb) disallowed.push("WebFetch,WebSearch");
    disallowed.push(claudeDisallowPatterns());
    args.push("--permission-mode", "dontAsk", "--tools", tools, "--allowedTools", tools, "--disallowedTools", disallowed.join(","));
  } else if (lane === "quick") {
    args.push("--permission-mode", "dontAsk", "--tools", "");
  } else if (lane === "critic") {
    const tools = "Read,Glob,Grep,LS";
    args.push("--permission-mode", "dontAsk", "--tools", tools, "--allowedTools", tools, "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit,Bash,WebFetch,WebSearch");
  } else {
    // edit / perf / ask (selection lanes)
    const tools = claudeReadTools(policy.selectionAllowShell, policy.selectionAllowWeb);
    const disallowed = ["Edit,Write,MultiEdit,NotebookEdit"];
    if (!policy.selectionAllowWeb) disallowed.push("WebFetch,WebSearch");
    if (policy.selectionAllowShell) disallowed.push(claudeDisallowPatterns());
    args.push("--permission-mode", "dontAsk", "--tools", tools, "--allowedTools", tools, "--disallowedTools", disallowed.join(","));
  }

  if ((lane === "review" || lane === "plan") && opts.mcpConfigPath) {
    args.push("--mcp-config", opts.mcpConfigPath);
  }
  return args;
}

export function buildCodexArgs(opts: RunOpts): string[] {
  const cfg = opts.providerConfig;
  const modelOverrides: string[] = [];
  if (opts.model && opts.model !== "") modelOverrides.push("-c", `model="${opts.model}"`);
  if (cfg.reasoningEffort) modelOverrides.push("-c", `model_reasoning_effort="${cfg.reasoningEffort}"`);

  if (opts.resumeSessionId && opts.resumeSessionId !== "") {
    return [
      "exec", "resume", "--json", "--ignore-user-config", "--ignore-rules",
      "--skip-git-repo-check", ...modelOverrides, opts.resumeSessionId, "-",
    ];
  }

  let sandbox = "read-only";
  const lane = opts.lane;
  if (lane === "bigchange") sandbox = "workspace-write";
  else if (lane === "review" && (opts.policy ?? DEFAULT_TOOL_POLICY).reviewAllowMarkdownWrites) sandbox = "workspace-write";
  else if (lane === "plan") sandbox = "workspace-write";
  else if (lane === "perf") sandbox = "workspace-write";

  const args = ["exec", "--json", ...modelOverrides];
  if (!opts.persistSession) args.push("--ephemeral");
  args.push("--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--color", "never", "-s", sandbox, "-C", opts.cwd);
  if (lane === "bigchange") args.push("-c", 'approval_policy="never"');
  return args;
}

// ----- stream parsers --------------------------------------------------------

interface ParsedChunk {
  text?: string;
  textKind?: "delta" | "aggregate";
  progress?: string;
  sessionId?: string;
  usage?: UsageSample;
}

export interface UsageSample {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
  costUsd: number;
  model: string;
}

function toolDetail(input: any): string {
  if (!input || typeof input !== "object") return "";
  return (
    input.command || input.file_path || input.pattern || input.path || input.description ||
    input.uri || input.symbol || input.query || input.name || input.action || input.method || ""
  );
}

function toolProgress(provider: string, name: string, input: any): string {
  const detail = toolDetail(input);
  if (detail) return `[${provider}] tool: ${(name + ": " + String(detail)).trim()}\n`;
  return `[${provider}] tool: ${name}\n`;
}

export function parseClaudeLine(line: string): ParsedChunk | null {
  let decoded: any;
  try {
    decoded = JSON.parse(line);
  } catch {
    return { text: line + "\n" };
  }
  if (typeof decoded !== "object" || decoded === null) return { text: line + "\n" };
  const sessionId = decoded.session_id;
  const attach = (p: ParsedChunk): ParsedChunk => {
    if (sessionId) p.sessionId = sessionId;
    return p;
  };
  const event = decoded.event || {};
  const delta = event.delta || decoded.delta || {};
  if (delta.type === "text_delta" && delta.text) {
    return attach({ text: delta.text, textKind: "delta" });
  }
  if (decoded.type === "assistant" && decoded.message && Array.isArray(decoded.message.content)) {
    const textParts: string[] = [];
    const progress: string[] = [];
    for (const block of decoded.message.content) {
      if (block.type === "text" && block.text) textParts.push(block.text);
      else if (block.type === "tool_use") progress.push(toolProgress("claude", block.name, block.input).replace(/\n$/, ""));
    }
    if (textParts.length) return attach({ text: textParts.join("\n"), textKind: "aggregate" });
    if (progress.length) return attach({ progress: progress.join("\n") + "\n" });
  }
  if (event.type === "content_block_start" && event.content_block && event.content_block.type === "tool_use") {
    return attach({ progress: toolProgress("claude", event.content_block.name, event.content_block.input) });
  }
  if (decoded.type === "system" && decoded.subtype === "init") {
    return attach({ progress: "[claude] session started\n" });
  }
  if (decoded.type === "result") {
    const sample = parseClaudeUsage(decoded);
    if (sample) return attach({ usage: sample });
  }
  return sessionId ? attach({}) : null;
}

export function parseCodexLine(line: string): ParsedChunk | null {
  if (/^Reading prompt from stdin/.test(line) || /^Reading additional input from stdin/.test(line)) return null;
  let decoded: any;
  try {
    decoded = JSON.parse(line);
  } catch {
    return { text: line + "\n" };
  }
  if (typeof decoded !== "object" || decoded === null) return { text: line + "\n" };
  let sessionId = decoded.session_id || decoded.conversation_id || decoded.thread_id;
  if (!sessionId && decoded.session && typeof decoded.session === "object") {
    sessionId = decoded.session.id || decoded.session.session_id;
  }
  const out = (p: ParsedChunk): ParsedChunk => {
    if (sessionId) p.sessionId = sessionId;
    return p;
  };
  const item = decoded.item;
  if (item && typeof item === "object") {
    if (item.type === "agent_message" && item.text) return out({ text: item.text, textKind: "aggregate" });
    if (item.type === "reasoning" && item.summary) {
      if (Array.isArray(item.summary)) {
        const summary = item.summary
          .map((part: any) => (typeof part === "string" ? part : part && part.text))
          .filter(Boolean);
        if (summary.length) return out({ progress: "[codex] " + summary.join("\n[codex] ") + "\n" });
      } else if (item.summary !== "") {
        return out({ progress: "[codex] " + String(item.summary) + "\n" });
      }
    }
    if (item.type === "command_execution" || item.type === "tool_call" || item.type === "function_call") {
      let detail = item.command || item.name || item.title || item.call_id || "tool";
      if (Array.isArray(detail)) detail = detail.join(" ");
      return out({ progress: "[codex] tool: " + String(detail) + "\n" });
    }
  }
  if (decoded.type === "turn.started") return out({ progress: "[codex] working\n" });
  if (decoded.type === "item.started" && item && typeof item === "object") return out({ progress: "[codex] " + String(item.type || "item") + "\n" });
  if (decoded.type === "error" && decoded.message) return out({ text: "\n[error] " + decoded.message + "\n" });
  if (decoded.type === "turn.failed" && decoded.error) return out({ text: "\n[failed] " + String(decoded.error) + "\n" });
  if (decoded.type === "turn.completed") {
    const sample = parseCodexUsage(decoded);
    if (sample) return out({ usage: sample });
  }
  return sessionId ? out({}) : null;
}

export function parseClaudeUsage(decoded: any): UsageSample | null {
  if (decoded.type !== "result") return null;
  const usage = decoded.usage || {};
  let model = "claude-default";
  if (decoded.modelUsage && typeof decoded.modelUsage === "object") {
    let best = -1;
    for (const [k, v] of Object.entries<any>(decoded.modelUsage)) {
      const c = (v && v.costUSD) || 0;
      if (c > best) {
        best = c;
        model = k;
      }
    }
  }
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheCreation: usage.cache_creation_input_tokens || 0,
    reasoning: 0,
    costUsd: decoded.total_cost_usd || 0,
    model,
  };
}

export function parseCodexUsage(decoded: any): UsageSample | null {
  if (decoded.type !== "turn.completed") return null;
  const usage = (decoded.usage || (decoded.item && decoded.item.usage)) || {};
  return {
    input: (usage.input_tokens || 0) - (usage.cached_input_tokens || 0),
    output: usage.output_tokens || 0,
    cacheRead: usage.cached_input_tokens || 0,
    cacheCreation: 0,
    reasoning: usage.reasoning_output_tokens || 0,
    costUsd: 0,
    model: "codex-default",
  };
}

// ----- line consumer with text dedup ----------------------------------------

export function makeConsumer(
  provider: string,
  onText: (t: string) => void,
  onProgress: (t: string) => void,
  onSessionId: (id: string) => void,
  onUsage: (s: UsageSample) => void
): { feed: (data: string) => void; drain: () => void } {
  const parse = provider === "claude" ? parseClaudeLine : provider === "codex" ? parseCodexLine : (l: string) => ({ text: l + "\n" });
  let pending = "";
  let lastProgress: string | null = null;
  let emittedText = "";

  const dedupeText = (chunk: ParsedChunk): string | null => {
    const text = chunk.text;
    if (!text) return null;
    if (chunk.textKind === "aggregate" && emittedText !== "") {
      if (text === emittedText) return null;
      if (text.startsWith(emittedText)) {
        const tail = text.slice(emittedText.length);
        emittedText = text;
        return tail === "" ? null : tail;
      }
      if (text.length < emittedText.length && emittedText.endsWith(text)) return null;
    }
    emittedText += text;
    return text;
  };

  const emit = (chunk: ParsedChunk | null) => {
    if (!chunk) return;
    if (chunk.sessionId) onSessionId(chunk.sessionId);
    if (chunk.text) {
      const t = dedupeText(chunk);
      if (t) onText(t);
    }
    if (chunk.progress && chunk.progress !== lastProgress) {
      lastProgress = chunk.progress;
      onProgress(chunk.progress);
    }
    if (chunk.usage) onUsage(chunk.usage);
  };

  return {
    feed(data: string) {
      pending += data;
      let idx: number;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        emit(parse(line));
      }
    },
    drain() {
      if (pending !== "") {
        const line = pending;
        pending = "";
        emit(parse(line));
      }
    },
  };
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  text: string;
  sessionId?: string;
  usage?: UsageSample;
}

export function run(opts: RunOpts): { promise: Promise<RunResult>; child: ChildProcess } {
  const args = opts.provider === "claude" ? buildClaudeArgs(opts) : buildCodexArgs(opts);
  let stdin: string | undefined = opts.input;
  if (opts.provider === "codex") {
    stdin = opts.prompt;
    if (opts.input && opts.input !== "") stdin = opts.prompt + "\n\n<context>\n" + opts.input + "\n</context>\n";
  }

  let collectedText = "";
  let observedSession = opts.resumeSessionId || undefined;
  let observedUsage: UsageSample | undefined;

  const onText = (t: string) => {
    collectedText += t;
    opts.onText?.(t);
  };
  const onProgress = (t: string) => opts.onProgress?.(t);
  const onSessionId = (id: string) => {
    observedSession = id;
    opts.onSessionId?.(id);
  };
  const onUsage = (s: UsageSample) => {
    // Codex `turn.completed` reports CUMULATIVE session usage, so the latest
    // sample is the run total — replace, don't sum. Claude emits one `result`
    // per turn (per-turn deltas), so those sum.
    if (!observedUsage || opts.provider === "codex") observedUsage = s;
    else {
      observedUsage.input += s.input;
      observedUsage.output += s.output;
      observedUsage.cacheRead += s.cacheRead;
      observedUsage.cacheCreation += s.cacheCreation;
      observedUsage.reasoning += s.reasoning;
      observedUsage.costUsd += s.costUsd;
      observedUsage.model = s.model || observedUsage.model;
    }
  };

  const stdoutConsumer = makeConsumer(opts.provider, onText, onProgress, onSessionId, onUsage);
  const stderrConsumer = makeConsumer(opts.provider, onText, onProgress, onSessionId, onUsage);

  const child = spawn(opts.providerConfig.cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
  opts.onHandle?.(child);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => stdoutConsumer.feed(d));
  child.stderr?.on("data", (d: string) => stderrConsumer.feed(d));

  if (stdin !== undefined) {
    child.stdin?.write(stdin);
    child.stdin?.end();
  } else {
    child.stdin?.end();
  }

  const promise = new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      stdoutConsumer.drain();
      stderrConsumer.drain();
      resolve({ code, signal, text: collectedText, sessionId: observedSession, usage: observedUsage });
    });
  });

  return { promise, child };
}
