// Headless unit tests for the protocol parser + diff engine. Runs under plain
// node (no vscode). Validates parsing rules and replays every nvime bench
// fixture offline by synthesizing the ideal agent response from the expected
// diff — proving the diff engine reproduces expected output deterministically.

import * as fs from "fs";
import * as path from "path";
import {
  responseMode,
  fencedBody,
  startSession,
  applyBlocksToLines,
  acceptBlock,
  undoLastAccept,
  blockStartLine,
  extractRationale,
  extractVerifyLine,
  Selection,
  DiffBlock,
} from "../core/protocol";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
    console.error("  FAIL: " + msg);
  }
}

function eq<T>(a: T, b: T, msg: string) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// ----- response_mode ---------------------------------------------------------

function testResponseMode() {
  console.log("response_mode:");
  eq(responseMode("NVIME_NO_CHANGE\nlooks fine").mode, "NVIME_NO_CHANGE", "no_change marker");
  eq(responseMode("RATIONALE: x\nNVIME_DIFF\n```diff\n@@ -1,1 +1,1 @@\n-a\n+b\n```").mode, "NVIME_DIFF", "diff marker after prose");
  eq(responseMode("```NVIME_REPLACEMENT").mode, "NVIME_REPLACEMENT", "glued fence normalized");
  eq(responseMode("just prose, no marker").mode, null, "no marker");
  eq(responseMode("NVIME_FOOBAR\nx").mode, null, "unknown marker ignored");
  eq(responseMode("NVIME_DIFF rest here").body.startsWith("rest here"), true, "trailing text becomes body");
}

// ----- fenced_body -----------------------------------------------------------

function testFencedBody() {
  console.log("fenced_body:");
  eq(fencedBody("```\nhello\nworld\n```"), "hello\nworld", "basic fence");
  eq(fencedBody("```python\nx = 1\n```"), "x = 1", "lang tag fence");
  eq(fencedBody("not a fence"), null, "no fence");
  eq(fencedBody("~~~\nabc\n~~~"), "abc", "tilde fence");
  eq(fencedBody("````\n```\ninner\n```\n````"), "```\ninner\n```", "longer outer fence wraps inner");
}

// ----- rationale / verify ----------------------------------------------------

function testRationaleVerify() {
  console.log("rationale/verify:");
  eq(extractRationale("RATIONALE: flips the operator\nNVIME_DIFF"), "flips the operator", "single rationale");
  eq(extractRationale("RATIONALE: line one\n  continued\nNVIME_DIFF"), "line one continued", "continuation");
  eq(extractRationale("no rationale\nNVIME_DIFF"), null, "no rationale");
  eq(extractVerifyLine("VERIFY: ok\nNVIME_DIFF"), "ok", "verify line");
  eq(extractVerifyLine("VERIFY: 3 findings\nNVIME_DIFF"), "3 findings", "verify findings");
}

// ----- diff apply ------------------------------------------------------------

function applyResult(sel: Selection, response: string): string[] | null {
  const res = startSession(sel, response, "claude", "prompt");
  if (res.status === "no_change") return [...sel.lines];
  if (res.status === "diff" && res.session) {
    return applyBlocksToLines(res.session.originalLines, res.session.blocks, (b: DiffBlock) => b.status !== "rejected");
  }
  return null;
}

function testDiffApply() {
  console.log("diff apply:");
  const lines = ["def is_even(n):", "    return n % 2 == 1"];
  const sel: Selection = { path: "f.py", lines, line1: 1, line2: 2, source: "range" };
  const resp = "RATIONALE: flip\nNVIME_DIFF\n```diff\n--- a/f.py\n+++ b/f.py\n@@ -2,1 +2,1 @@\n-    return n % 2 == 1\n+    return n % 2 == 0\n```";
  eq(applyResult(sel, resp), ["def is_even(n):", "    return n % 2 == 0"], "single-line diff");

  // replacement
  const repl = "NVIME_REPLACEMENT\n```\ndef is_even(n):\n    return n % 2 == 0\n```";
  eq(applyResult(sel, repl), ["def is_even(n):", "    return n % 2 == 0"], "replacement");

  // no change when identical replacement
  const same = "NVIME_REPLACEMENT\n```\ndef is_even(n):\n    return n % 2 == 1\n```";
  eq(applyResult(sel, same), lines, "identical replacement -> no change");

  // unranged hunk fallback
  const unranged = "NVIME_DIFF\n```diff\n@@\n-    return n % 2 == 1\n+    return n % 2 == 0\n```";
  eq(applyResult(sel, unranged), ["def is_even(n):", "    return n % 2 == 0"], "unranged hunk anchored");
}

function testCrossFileReject() {
  console.log("cross-file rejection:");
  const sel: Selection = { path: "f.py", lines: ["a", "b"], line1: 1, line2: 2 };
  const resp = "NVIME_DIFF\n```diff\n--- a/other.py\n+++ b/other.py\n@@ -1,1 +1,1 @@\n-a\n+c\n```";
  let threw = false;
  try {
    startSession(sel, resp, "claude", "p");
  } catch {
    threw = true;
  }
  assert(threw, "cross-file diff throws");
}

// ----- fixture replay (offline) ---------------------------------------------

function unifiedDiffForRange(orig: string[], expected: string[]): string[] {
  // Minimal LCS-free diff: trim common prefix/suffix, emit removed then added.
  let prefix = 0;
  while (prefix < orig.length && prefix < expected.length && orig[prefix] === expected[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < orig.length - prefix &&
    suffix < expected.length - prefix &&
    orig[orig.length - 1 - suffix] === expected[expected.length - 1 - suffix]
  )
    suffix++;
  const removed = orig.slice(prefix, orig.length - suffix);
  const added = expected.slice(prefix, expected.length - suffix);
  return [...removed.map((l) => "-" + l), ...added.map((l) => "+" + l)];
}

function testFixtureReplay() {
  console.log("fixture replay (offline diff engine):");
  const fixturesDir = path.resolve(__dirname, "../../../nvime/bench/fixtures");
  if (!fs.existsSync(fixturesDir)) {
    console.log("  (skipped — nvime fixtures not found at " + fixturesDir + ")");
    return;
  }
  const dirs = fs.readdirSync(fixturesDir).filter((d) => fs.statSync(path.join(fixturesDir, d)).isDirectory()).sort();
  for (const d of dirs) {
    const dir = path.join(fixturesDir, d);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
    const orig = fs.readFileSync(path.join(dir, meta.file), "utf8").split("\n");
    if (orig.length && orig[orig.length - 1] === "") orig.pop();
    const expected = fs.readFileSync(path.join(dir, meta.expected), "utf8").split("\n");
    if (expected.length && expected[expected.length - 1] === "") expected.pop();

    const sel: Selection = { path: meta.file, lines: orig, line1: meta.line1, line2: meta.line2, source: "range" };

    if (JSON.stringify(orig) === JSON.stringify(expected)) {
      // no-change fixture: an NVIME_NO_CHANGE response must yield the original
      const result = applyResult(sel, "NVIME_NO_CHANGE\nalready correct");
      eq(result, orig, `${meta.id}: no-change replay`);
      continue;
    }

    // Synthesize the ideal NVIME_DIFF from the actual original→expected delta,
    // restricted to the changed window. The whole-file delta is what an ideal
    // agent would emit; the engine must reproduce `expected`.
    const body = unifiedDiffForRange(orig, expected);
    // anchor at the first changed original line
    let prefix = 0;
    while (prefix < orig.length && prefix < expected.length && orig[prefix] === expected[prefix]) prefix++;
    const startLine = prefix + 1;
    const removed = body.filter((l) => l[0] === "-").length;
    const added = body.filter((l) => l[0] === "+").length;
    const resp = [
      "RATIONALE: synthesized ideal patch",
      "NVIME_DIFF",
      "```diff",
      `--- a/${meta.file}`,
      `+++ b/${meta.file}`,
      `@@ -${startLine},${removed} +${startLine},${added} @@`,
      ...body,
      "```",
    ].join("\n");
    const result = applyResult(sel, resp);
    eq(result, expected, `${meta.id}: ideal-diff replay reproduces expected`);
  }
}

function testAgentArgs() {
  console.log("agent argv parity:");
  const agent = require("../core/agent");
  const opts = {
    provider: "claude",
    providerConfig: { cmd: "claude" },
    lane: "edit",
    prompt: "PROMPT",
    cwd: "/tmp",
    policy: agent.DEFAULT_TOOL_POLICY,
  };
  const a = agent.buildClaudeArgs(opts);
  assert(a[0] === "-p" && a[1] === "PROMPT", "claude -p prompt first");
  for (const flag of ["--output-format", "stream-json", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--exclude-dynamic-system-prompt-sections", "--no-session-persistence", "--permission-mode", "dontAsk"]) {
    assert(a.includes(flag), `claude edit args include ${flag}`);
  }
  const toolsIdx = a.indexOf("--tools");
  eq(a[toolsIdx + 1], "Read,Glob,Grep,LS,WebFetch,WebSearch,Bash", "claude edit --tools");
  const disIdx = a.indexOf("--disallowedTools");
  assert(a[disIdx + 1].startsWith("Edit,Write,MultiEdit,NotebookEdit"), "claude edit --disallowedTools starts with edit denials");

  // critic lane read-only
  const critic = agent.buildClaudeArgs({ ...opts, lane: "critic" });
  eq(critic[critic.indexOf("--tools") + 1], "Read,Glob,Grep,LS", "critic tools read-only");

  // codex edit
  const c = agent.buildCodexArgs({ provider: "codex", providerConfig: { cmd: "codex" }, lane: "edit", prompt: "P", cwd: "/repo" });
  assert(c[0] === "exec" && c.includes("--json"), "codex exec --json");
  assert(c.includes("-s") && c[c.indexOf("-s") + 1] === "read-only", "codex edit read-only sandbox");
  assert(c.includes("--ephemeral"), "codex edit ephemeral");
  eq(c[c.indexOf("-C") + 1], "/repo", "codex -C cwd");
}

function testEditPromptVerbatim() {
  console.log("edit prompt verbatim anchors:");
  const { buildEditPrompt, buildAskPrompt } = require("../core/prompts");
  const p = buildEditPrompt({ path: "lua/x.lua", line1: 3, line2: 9, source: "range" }, "fix the bug", "code here");
  assert(p.startsWith("NVIME EDIT MODE."), "edit prompt header");
  assert(p.includes("You are a constrained patch worker, not a reviewer."), "constrained patch worker line");
  assert(p.includes("NVIME_DIFF must include --- a/lua/x.lua, +++ b/lua/x.lua, and ranged @@ -line,count +line,count @@ headers."), "path interpolated into NVIME_DIFF instruction");
  assert(p.includes("RATIONALIZATION (mandatory before NVIME_DIFF or NVIME_REPLACEMENT):"), "rationalization block");
  assert(p.includes("File: lua/x.lua"), "file line");
  assert(p.includes("Allowed range: 3-9 (range)"), "allowed range line");
  assert(p.includes("Intent: fix the bug"), "intent line");
  const ask = buildAskPrompt({ path: "a.py", line1: 1, line2: 2, source: "range" }, "is this right?", "x=1");
  assert(ask.startsWith("NVIME READ-ONLY SELECTION CHAT — look, don't touch."), "ask prompt header");
  assert(ask.includes("Question: is this right?"), "ask question line");
}

function testIntentReroute() {
  console.log("intent reroute / followup:");
  const { looksLikeQuestion, wantsEditFollowup } = require("../core/prompts");
  eq(looksLikeQuestion("does this look right?"), true, "question reroutes");
  eq(looksLikeQuestion("fix the off-by-one"), false, "edit verb does not reroute");
  eq(looksLikeQuestion("review this and verify correctness"), true, "review/verify reroutes");
  eq(wantsEditFollowup("please proceed"), true, "proceed -> edit");
  eq(wantsEditFollowup("what does this do"), false, "what stays ask");
  eq(wantsEditFollowup("don't change anything"), false, "negation stays ask");
  eq(wantsEditFollowup("fix this"), true, "fix -> edit");
}

function testAcceptUndoAndDeletion() {
  console.log("accept / undo / deletion-idempotency:");
  // a deletion: remove line 2 of 3
  const lines = ["a", "b", "c"];
  const sel: Selection = { path: "f.txt", lines, line1: 1, line2: 3 };
  const resp = "NVIME_DIFF\n```diff\n--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,0 @@\n-b\n```";
  const res = startSession(sel, resp, "claude", "p");
  assert(res.status === "diff" && !!res.session, "deletion opens a diff");
  const session = res.session!;
  const block = session.blocks[0];

  // accept the deletion against the live buffer
  let r = acceptBlock(session, ["a", "b", "c"], block, false);
  eq(r.newLines, ["a", "c"], "deletion applied");
  assert(r.applied, "deletion applied flag");

  // re-accepting against the ALREADY-deleted buffer must be an idempotent no-op,
  // not a spurious conflict (the regression the review caught)
  block.status = "pending"; // simulate a re-accept attempt
  const r2 = acceptBlock(session, ["a", "c"], block, false);
  assert(r2.applied && !r2.conflict, "re-accept of applied deletion is idempotent (no conflict)");
  eq(r2.newLines, ["a", "c"], "idempotent deletion leaves buffer unchanged");

  // undo of an accepted block restores the original
  const lines2 = ["x", "y"];
  const sel2: Selection = { path: "g.txt", lines: lines2, line1: 1, line2: 2 };
  const res2 = startSession(sel2, "NVIME_DIFF\n```diff\n--- a/g.txt\n+++ b/g.txt\n@@ -2,1 +2,1 @@\n-y\n+z\n```", "claude", "p");
  const s2 = res2.session!;
  const b2 = s2.blocks[0];
  const a2 = acceptBlock(s2, ["x", "y"], b2, false);
  eq(a2.newLines, ["x", "z"], "edit applied");
  const u = undoLastAccept(s2, ["x", "z"]);
  assert(!!u, "undo returns a result");
  eq(u!.newLines, ["x", "y"], "undo restores original");
  eq(b2.status, "pending", "undone block back to pending");
  // undo refuses when accepted text changed
  acceptBlock(s2, ["x", "y"], b2, false);
  const u2 = undoLastAccept(s2, ["x", "CHANGED"]);
  eq(u2, null, "undo refuses when accepted text changed");
}

function testBlockStartLineOffset() {
  console.log("blockStartLine offset after accept:");
  const lines = ["1", "2", "3", "4"];
  const sel: Selection = { path: "f", lines, line1: 1, line2: 4 };
  // two insertions: +X after line1, change line3
  const resp = "NVIME_DIFF\n```diff\n--- a/f\n+++ b/f\n@@ -1,1 +1,2 @@\n 1\n+X\n@@ -3,1 +3,1 @@\n-3\n+Y\n```";
  const res = startSession(sel, resp, "claude", "p");
  const s = res.session!;
  // accept first block (insertion of X) → second block's live start shifts by +1
  const first = s.pendingBlocks()[0];
  acceptBlock(s, lines, first, false);
  const second = s.pendingBlocks().find((b) => b.oldStart >= 3)!;
  eq(blockStartLine(s, second), second.oldStart + 1, "second block start shifted by accepted insertion delta");
}

function main() {
  testResponseMode();
  testFencedBody();
  testRationaleVerify();
  testDiffApply();
  testCrossFileReject();
  testAcceptUndoAndDeletion();
  testBlockStartLineOffset();
  testAgentArgs();
  testEditPromptVerbatim();
  testIntentReroute();
  testFixtureReplay();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log("  - " + f);
    process.exit(1);
  }
}

main();
