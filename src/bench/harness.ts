// nvimse prompt benchmark harness — the editor-agnostic parity check.
//
// For each fixture in nvime's bench/fixtures (or a local fixtures dir), it:
//   1. Builds the exact NVIMSE edit/ask prompt (src/core/prompts.ts).
//   2. Spawns claude/codex with the exact argv (src/core/agent.ts).
//   3. Parses the stream, applies NVIME_DIFF/REPLACEMENT (src/core/protocol.ts).
//   4. Compares against the expected file.
//
// This is the SAME methodology as nvime/bench/harness.py; if pass rates match,
// agent performance has parity. Run with: node dist/bench/harness.js [--options]

import * as fs from "fs";
import * as path from "path";
import {
  startSession,
  applyBlocksToLines,
  Selection,
  DiffBlock,
} from "../core/protocol";
import { buildEditPrompt, buildAskPrompt, buildPerfPrompt } from "../core/prompts";
import { run, DEFAULT_TOOL_POLICY, Lane } from "../core/agent";

interface Meta {
  id: string;
  file: string;
  expected: string;
  line1: number;
  line2: number;
  intent: string;
  lane?: string;
  ask_question?: string;
  ask_keywords_any?: string[];
  ask_no_bug?: boolean;
  ask_no_bug_keywords?: string[];
  ask_skip?: boolean;
  dir: string;
  originalLines: string[];
  expectedLines: string[];
}

function splitFileLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function loadFixture(dir: string): Meta {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  meta.dir = dir;
  const orig = fs.readFileSync(path.join(dir, meta.file), "utf8");
  const exp = fs.readFileSync(path.join(dir, meta.expected), "utf8");
  meta.originalLines = splitFileLines(orig);
  meta.expectedLines = splitFileLines(exp);
  return meta;
}

function selectedText(meta: Meta): string {
  return meta.originalLines.slice(meta.line1 - 1, meta.line2).join("\n");
}

interface RunRecord {
  fixture: string;
  provider: string;
  config: string;
  elapsed: number;
  parsedMode: string | null;
  matches: boolean;
  formatCompliant: boolean;
  notes: string[];
}

async function evaluate(meta: Meta, provider: string, config: string, prompt: string, lane: Lane, timeoutMs: number): Promise<RunRecord> {
  const t0 = Date.now();
  const cmd = provider === "claude" ? "claude" : "codex";
  const { promise, child } = run({
    provider,
    providerConfig: { cmd },
    lane,
    prompt,
    cwd: meta.dir,
    policy: DEFAULT_TOOL_POLICY,
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  let result;
  try {
    result = await promise;
  } catch (e: any) {
    clearTimeout(timer);
    return { fixture: meta.id, provider, config, elapsed: (Date.now() - t0) / 1000, parsedMode: null, matches: false, formatCompliant: false, notes: ["spawn_error: " + String(e?.message || e)] };
  }
  clearTimeout(timer);
  const elapsed = (Date.now() - t0) / 1000;
  const raw = result.text;
  const notes: string[] = [];
  if (result.code !== 0) notes.push("return_code=" + result.code);

  const selection: Selection = {
    path: meta.file,
    lines: meta.originalLines,
    line1: meta.line1,
    line2: meta.line2,
    source: "range",
  };

  if (config === "ask") {
    const haystack = raw.toLowerCase();
    const containsDiff = raw.includes("NVIME_DIFF") || raw.includes("@@ -") || raw.includes("```diff");
    let matches: boolean;
    if (meta.ask_no_bug) {
      const noBug = (meta.ask_no_bug_keywords || []).filter((k) => haystack.includes(k.toLowerCase()));
      const assertsBug = ["this is a bug", "there is a bug", "is incorrect", "is wrong", "is broken", "the bug is", "has a bug", "the issue is", "the problem is"].some((p) => haystack.includes(p));
      matches = !containsDiff && noBug.length > 0 && !assertsBug;
      if (!matches) notes.push("ask_no_bug_failed");
    } else {
      const matched = (meta.ask_keywords_any || []).filter((k) => haystack.includes(k.toLowerCase()));
      matches = matched.length > 0 && !containsDiff;
      if (!matched.length) notes.push("ask_missed_keywords");
      if (containsDiff) notes.push("ask_produced_patch");
    }
    return { fixture: meta.id, provider, config, elapsed, parsedMode: null, matches, formatCompliant: true, notes };
  }

  let res;
  try {
    res = startSession(selection, raw, provider, prompt);
  } catch (e: any) {
    return { fixture: meta.id, provider, config, elapsed, parsedMode: null, matches: false, formatCompliant: false, notes: ["start_session_error: " + String(e?.message || e)] };
  }
  const { mode } = require("../core/protocol").responseMode(raw);
  const formatCompliant = mode !== null || config === "baseline";

  let finalLines: string[] | null = null;
  if (res.status === "no_change") {
    finalLines = [...meta.originalLines];
  } else if (res.status === "diff" && res.session) {
    finalLines = applyBlocksToLines(res.session.originalLines, res.session.blocks, (b: DiffBlock) => b.status !== "rejected");
  }

  const matches = finalLines !== null && arraysEqual(finalLines, meta.expectedLines);
  if (finalLines !== null && !matches) {
    notes.push("mismatch");
  }
  return { fixture: meta.id, provider, config, elapsed, parsedMode: mode, matches, formatCompliant, notes };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string, def?: string) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
  };
  const provider = opt("--provider", "claude")!;
  const configs = (opt("--configs", "edit") || "edit").split(",");
  const fixturesDir = opt("--fixtures-dir", path.resolve(__dirname, "../../../nvime/bench/fixtures"))!;
  const timeoutMs = parseInt(opt("--timeout", "180")!, 10) * 1000;
  const only = opt("--only");
  const outPath = opt("--out", path.resolve(__dirname, "results.json"))!;

  let dirs = fs.readdirSync(fixturesDir).filter((d) => fs.statSync(path.join(fixturesDir, d)).isDirectory()).sort();
  if (only) dirs = dirs.filter((d) => only.split(",").includes(d));

  const records: RunRecord[] = [];
  for (const d of dirs) {
    const meta = loadFixture(path.join(fixturesDir, d));
    console.log(`\n=== fixture ${meta.id} ===`);
    const selBody = selectedText(meta);
    for (const cfg of configs) {
      if (cfg === "ask" && (meta.ask_skip || (!meta.ask_question && !meta.ask_keywords_any && !meta.ask_no_bug))) {
        console.log(`  [skip] ask on ${meta.id}`);
        continue;
      }
      const sel = { path: meta.file, line1: meta.line1, line2: meta.line2, source: "range" };
      let prompt: string;
      let lane: Lane;
      if (cfg === "edit") {
        prompt = buildEditPrompt(sel, meta.intent, selBody);
        lane = "edit";
      } else if (cfg === "perf") {
        prompt = buildPerfPrompt(sel, meta.intent, selBody);
        lane = "perf";
      } else if (cfg === "ask") {
        prompt = buildAskPrompt(sel, meta.ask_question || meta.intent, selBody);
        lane = "ask";
      } else {
        continue;
      }
      console.log(`  [run] provider=${provider} cfg=${cfg} fixture=${meta.id}`);
      const rec = await evaluate(meta, provider, cfg, prompt, lane, timeoutMs);
      records.push(rec);
      console.log(`        mode=${rec.parsedMode} match=${rec.matches} elapsed=${rec.elapsed.toFixed(1)}s notes=${rec.notes.slice(0, 1)}`);
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(records, null, 2));
  console.log(`\nwrote ${outPath} (${records.length} runs)`);
  console.log("\n--- summary ---");
  let pass = 0;
  for (const r of records) {
    if (r.matches) pass++;
    const ok = r.matches ? "PASS" : "FAIL";
    const fmt = r.formatCompliant ? "fmt-ok" : "fmt-bad";
    console.log(`  ${ok.padEnd(4)} ${fmt.padEnd(7)} ${r.provider.padEnd(6)} ${r.config.padEnd(6)} ${r.fixture.padEnd(35)} mode=${String(r.parsedMode).padEnd(18)} ${r.elapsed.toFixed(1)}s`);
  }
  console.log(`\n${pass}/${records.length} passed`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
