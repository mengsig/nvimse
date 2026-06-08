// Pre-accept verification — port of nvime's lua/nvime/verify.lua, adapted for
// VS Code. nvime's tree-sitter parse gate is approximated here by (a) a built-in
// JSON parse check (language-agnostic, always on) and (b) opt-in external
// parse/lint checks (gofmt etc., when verify.externalChecks is enabled and the
// binary is on PATH). The gate signal (parse_error) blocks silent accept unless
// forced. There is no general tree-sitter parser in this port, so for languages
// without a configured parse check the gate is advisory, not blocking.

import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { config } from "./runtime";
import { audit } from "./audit";
import { pathMatchesAny } from "./glob";
import { DiffSession } from "../core/protocol";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_FINDINGS = 50;
const STDOUT_EXCERPT = 800;

export interface VerifyFinding {
  kind: string;
  severity: string;
  message: string;
  line?: number;
  col?: number;
  source: string;
}

export interface VerifyResult {
  status: "ok" | "issues" | "error";
  parse_error: boolean;
  findings: VerifyFinding[];
  by_check: Record<string, { code: number; count: number; excerpt?: string; kind?: string }>;
  summary: string;
}

interface ExternalCheck {
  name: string;
  kind: string;
  match: string[];
  cmd: (file: string) => string[];
  parse: (out: string, err: string) => VerifyFinding[];
}

const BUILTIN_CHECKS: ExternalCheck[] = [
  {
    name: "ruff",
    kind: "lint",
    match: ["*.py"],
    cmd: (f) => ["check", "--no-fix", "--output-format=concise", "--quiet", f],
    parse: (out) => parseLines(out, /^([^:]+):(\d+):(\d+): (.+)$/, "warn", "ruff"),
  },
  {
    name: "shellcheck",
    kind: "lint",
    match: ["*.sh", "*.bash"],
    cmd: (f) => ["--format=gcc", f],
    parse: (out) => parseLines(out, /^([^:]+):(\d+):(\d+): (\w+): (.+)$/, "warn", "shellcheck", 5, 4),
  },
  {
    name: "gofmt",
    kind: "parse",
    match: ["*.go"],
    cmd: (f) => ["-e", "-l", f],
    parse: (_o, e) => parseLines(e, /:(\d+):(\d+): (.+)$/, "error", "gofmt"),
  },
];

function parseLines(text: string, re: RegExp, sev: string, source: string, msgGroup = 4, sevGroup?: number): VerifyFinding[] {
  const out: VerifyFinding[] = [];
  for (const line of (text || "").split("\n")) {
    const m = line.match(re);
    if (!m) continue;
    const severity = sevGroup && m[sevGroup] ? (m[sevGroup].toLowerCase().includes("error") ? "error" : "warn") : sev;
    out.push({
      kind: "lint",
      severity,
      message: m[msgGroup] || line,
      line: parseInt(m[2] || m[1], 10) || undefined,
      source,
    });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

function binExists(cmd: string): boolean {
  const paths = (process.env.PATH || "").split(path.delimiter);
  return paths.some((p) => {
    try {
      fs.accessSync(path.join(p, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function runCheck(name: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(name, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
      resolve({ code, out: stdout || "", err: stderr || "" });
    });
  });
}

export async function verifyPath(file: string, content: string, waitMs = 0): Promise<VerifyResult> {
  const cfg = config().verify;
  const result: VerifyResult = { status: "ok", parse_error: false, findings: [], by_check: {}, summary: "ok" };
  if (cfg.enabled === false) return result;

  // Built-in language-agnostic parse check: JSON. Always on.
  if (/\.json$/i.test(file)) {
    try {
      JSON.parse(content);
    } catch (e: any) {
      result.parse_error = true;
      result.findings.push({ kind: "parse", severity: "error", message: "JSON parse error: " + (e?.message || ""), source: "json" });
      result.by_check["json"] = { code: 1, count: 1, kind: "parse" };
    }
  }

  if (cfg.externalChecks !== false && waitMs >= 0) {
    const tmp = path.join(os.tmpdir(), "nvimse-verify-" + Date.now() + "-" + path.basename(file));
    try {
      fs.writeFileSync(tmp, content);
      const checks = BUILTIN_CHECKS.filter((c) => pathMatchesAny(file, c.match) && binExists(c.name));
      const timeout = Math.min(cfg.timeoutMs || DEFAULT_TIMEOUT_MS, waitMs > 0 ? waitMs : cfg.timeoutMs || DEFAULT_TIMEOUT_MS);
      for (const check of checks) {
        const { code, out, err } = await runCheck(check.name, check.cmd(tmp), timeout);
        const findings = check.parse(out, err);
        result.findings.push(...findings);
        result.by_check[check.name] = {
          code,
          count: findings.length,
          excerpt: (out || err).slice(0, STDOUT_EXCERPT),
          kind: check.kind,
        };
        if (check.kind === "parse" && findings.length > 0) result.parse_error = true;
      }
    } catch {
      /* ignore */
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  const parts: string[] = [];
  if (result.parse_error) parts.push("parse error");
  if (result.findings.length > 0) parts.push(`${result.findings.length} findings`);
  result.status = result.parse_error ? "error" : result.findings.length > 0 ? "issues" : "ok";
  result.summary = parts.length ? parts.join(" · ") : "ok";
  return result;
}

export async function startForSession(session: DiffSession): Promise<VerifyResult> {
  const content = session.proposedLines().join("\n");
  audit({ event: "verify_start", file: session.file });
  const r = await verifyPath(session.file, content, 0);
  (session as any).verify = r;
  audit({ event: "verify_exit", file: session.file, status: r.status, parse_error: r.parse_error });
  return r;
}

export function shouldBlockAccept(session: DiffSession): { block: boolean; reason?: string } {
  const cfg = config().verify;
  const v = (session as any).verify as VerifyResult | undefined;
  if (cfg.enabled !== false && cfg.blockOnParseError && v && v.parse_error) {
    return { block: true, reason: "proposed file has a parse error; force-accept to override" };
  }
  return { block: false };
}
