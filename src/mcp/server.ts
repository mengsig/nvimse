// nvimse self MCP server — newline-delimited JSON-RPC 2.0 over stdio. Exposes the
// nvime project-context tools (attribution, plans, audits, usage, git, verify,
// test runner). Self-contained: no vscode imports; reads .nvime/* directly.

import * as fs from "fs";
import * as path from "path";
import { execFile, execFileSync } from "child_process";

const SERVER_INFO = { name: "nvime", version: "0.3.0" };
const PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED = new Set(["2025-03-26", "2024-11-05"]);

function repoRoot(): string {
  const env = process.env.NVIME_REPO_ROOT;
  if (env && fs.existsSync(env)) return env;
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}
const ROOT = repoRoot();

function safeJoin(rel: string): string | null {
  if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) return null;
  const p = path.join(ROOT, rel);
  if (!p.startsWith(ROOT)) return null;
  return p;
}

function readJson(file: string, fallback: any): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const TOOLS = [
  { name: "nvime.search_attribution", description: "Attribution entries for a (file, line).", inputSchema: { type: "object", properties: { file: { type: "string" }, line: { type: "number" } }, required: ["file", "line"] } },
  { name: "nvime.list_plans", description: "List plans under .nvime/plans.", inputSchema: { type: "object", properties: {} } },
  { name: "nvime.get_plan", description: "Read a plan's plan.json + plan.md.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "nvime.recent_audits", description: "Tail of audit.jsonl.", inputSchema: { type: "object", properties: { limit: { type: "number" }, kind: { type: "string" } } } },
  { name: "nvime.usage_summary", description: "Token + cost usage summary.", inputSchema: { type: "object", properties: {} } },
  { name: "nvime.git_log", description: "Recent commits, optionally path-scoped.", inputSchema: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } } },
  { name: "nvime.git_blame", description: "Blame metadata for one line.", inputSchema: { type: "object", properties: { path: { type: "string" }, line: { type: "number" } }, required: ["path", "line"] } },
  { name: "nvime.test_run", description: "Run the configured/auto-detected test runner.", inputSchema: { type: "object", properties: { runner: { type: "string" }, timeout: { type: "number" } } } },
  { name: "nvime.recent_diffs", description: "Recent accepted-diff metadata.", inputSchema: { type: "object", properties: { limit: { type: "number" } } } },
  { name: "nvime.verify_file", description: "Run the pre-accept verify lane (parse/lint) on path+content.", inputSchema: { type: "object", properties: { file: { type: "string" }, content: { type: "string" }, wait_ms: { type: "number" } }, required: ["file"] } },
];

function auditTail(predicate: (e: any) => boolean, limit: number): any[] {
  const file = path.join(ROOT, ".nvime", "audit.jsonl");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).slice(-5000);
  const out: any[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (predicate(e)) out.push(e);
    } catch {
      /* skip */
    }
  }
  return out.reverse();
}

async function callTool(name: string, args: any): Promise<any> {
  switch (name) {
    case "nvime.search_attribution": {
      const ledger = readJson(path.join(ROOT, ".nvime", "attribution.json"), { entries: [] });
      const matches = (ledger.entries || []).filter((e: any) => e.file === args.file && args.line >= e.line1 && args.line <= e.line2);
      return { file: args.file, line: args.line, matches };
    }
    case "nvime.list_plans": {
      const dir = path.join(ROOT, ".nvime", "plans");
      if (!fs.existsSync(dir)) return { plans: [] };
      const plans = fs.readdirSync(dir).map((id) => {
        const p = readJson(path.join(dir, id, "plan.json"), null);
        return p ? { id: p.id, title: p.title, steps: (p.steps || []).length, updated_at: p.updated_at } : null;
      }).filter(Boolean);
      return { plans };
    }
    case "nvime.get_plan": {
      const dir = path.join(ROOT, ".nvime", "plans", args.id);
      const plan = readJson(path.join(dir, "plan.json"), null);
      let md = "";
      try {
        md = fs.readFileSync(path.join(dir, "plan.md"), "utf8").split("\n").slice(0, 600).join("\n");
      } catch {
        /* ignore */
      }
      return { id: args.id, plan, plan_md: md };
    }
    case "nvime.recent_audits": {
      const limit = Math.min(args.limit || 50, 500);
      const kind = args.kind;
      return { audits: auditTail((e) => !kind || e.event === kind, limit), filter: kind || null };
    }
    case "nvime.usage_summary":
      return { usage: readJson(path.join(ROOT, ".nvime", "usage.json"), {}) };
    case "nvime.git_log": {
      const limit = Math.min(args.limit || 20, 200);
      const a = ["-C", ROOT, "log", `-${limit}`, "--format=%H%x1f%an%x1f%aI%x1f%s"];
      if (args.path) a.push("--", args.path);
      const out = gitSync(a);
      const commits = out.split("\n").filter(Boolean).map((l) => {
        const [sha, author, date, subject] = l.split("\x1f");
        return { sha, author, date, subject };
      });
      return { path: args.path || null, count: commits.length, commits };
    }
    case "nvime.git_blame": {
      const p = safeJoin(args.path) ? args.path : args.path;
      const out = gitSync(["-C", ROOT, "blame", "--line-porcelain", "-L", `${args.line},${args.line}`, "--", p]);
      const meta: any = { line: args.line, path: args.path };
      for (const l of out.split("\n")) {
        if (/^author /.test(l)) meta.author = l.slice(7);
        else if (/^summary /.test(l)) meta.summary = l.slice(8);
        else if (/^[0-9a-f]{40}/.test(l)) meta.sha = l.slice(0, 40);
      }
      return meta;
    }
    case "nvime.test_run": {
      const runner = args.runner || detectRunner();
      if (!runner) return { error: "no test runner" };
      const timeout = Math.min(Math.max(args.timeout || 60000, 1000), 300000);
      return await new Promise((resolve) => {
        execFile("sh", ["-c", runner], { cwd: ROOT, timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
          const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
          resolve({ runner, exit_code: code, timed_out: code === 124, stdout_tail: tail(stdout), stderr_tail: tail(stderr) });
        });
      });
    }
    case "nvime.recent_diffs": {
      const limit = Math.min(args.limit || 20, 200);
      const diffs = auditTail((e) => e.event === "diff_resolved", limit).map((e) => ({
        path: e.path, accepted: e.accepted, total: e.total, rationale: e.rationale, verdict: e.verdict, plan_id: e.plan_id, ts: e.ts, provider: e.provider,
      }));
      return { count: diffs.length, diffs };
    }
    case "nvime.verify_file":
      return verifyFile(args.file, args.content || "");
    default:
      throw new Error("unknown tool: " + name);
  }
}

function gitSync(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return "";
  }
}

function detectRunner(): string | null {
  const has = (f: string) => fs.existsSync(path.join(ROOT, f));
  if (has("scripts/test")) return "./scripts/test";
  if (has("Cargo.toml")) return "cargo test --quiet";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini")) return "pytest -q";
  if (has("package.json")) return "npm test --silent";
  if (has("Makefile")) return "make test";
  return null;
}

function tail(s: string, n = 200): string {
  return s.split("\n").slice(-n).join("\n");
}

function verifyFile(file: string, content: string): any {
  // best-effort: a couple of language sanity checks; parse errors gate accepts
  const findings: any[] = [];
  let parseError = false;
  if (/\.json$/.test(file)) {
    try {
      JSON.parse(content);
    } catch (e: any) {
      parseError = true;
      findings.push({ severity: "error", message: "JSON parse error: " + e.message, source: "parse" });
    }
  }
  const status = parseError ? "error" : findings.length ? "issues" : "ok";
  return { status, parse_error: parseError, findings, by_check: {}, file };
}

// ----- JSON-RPC loop ---------------------------------------------------------

function send(obj: any): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === "initialize") {
      const requested = params?.protocolVersion;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: SUPPORTED.has(requested) ? requested : PROTOCOL_VERSION,
          serverInfo: SERVER_INFO,
          capabilities: { tools: { listChanged: false } },
        },
      });
    } else if (method === "notifications/initialized" || method === "initialized") {
      /* no response */
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    } else if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await callTool(toolName, args);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      } catch (e: any) {
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "error: " + (e?.message || String(e)) }], isError: true } });
      }
    } else if (method === "shutdown") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (!isNotification) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
    }
  } catch (e: any) {
    if (!isNotification) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message || e) } });
  }
}

export function run(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line));
      } catch {
        /* drop malformed */
      }
    }
  });
}

if (require.main === module) {
  run();
}
