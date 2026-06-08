// Verbatim prompt builders ported from nvime's lua/nvime/{edit,ask,plan,critic}.lua.
// These determine agent performance and are reproduced character-for-character.

import { codeFenceFor } from "./protocol";

export interface PromptSelection {
  path: string;
  line1: number;
  line2: number;
  source?: string;
}

function selectedDisplay(body: string): string {
  if (body.trim() === "") return "(selected range is empty or blank)";
  return body;
}

function allowedRange(line1: number, line2: number, source?: string): string {
  return `${line1 || 1}-${line2 || line1 || 1} (${source || "range"})`;
}

// ----- EDIT LANE -------------------------------------------------------------

export function buildEditPrompt(
  sel: PromptSelection,
  intent: string,
  selectedBody: string,
  opts?: { projectContext?: string | null; priorAsk?: { question: string; answer: string } | null }
): string {
  const display = selectedDisplay(selectedBody);
  const fence = codeFenceFor(display);
  const path = sel.path;
  const lines: string[] = [
    "NVIME EDIT MODE.",
    "You are a constrained patch worker, not a reviewer.",
    "Return exactly one machine-readable response block. The ONLY prose allowed before the block is a single `RATIONALE:` line (described below) — no analysis, caveats, or summaries beyond that.",
    "Do not narrate tool use or investigation steps. No 'I'll read...', no progress updates, no markdown outside the response block.",
    "You may only propose changes for the selected range in the current file.",
    "You may use read/search, web fetch/search, and shell commands such as curl for inspection, external docs, or tests when available.",
    "If nvime MCP tools are available, prefer their read-only project context helpers (symbols, recent diffs, session search, usage, git metadata) and bounded test runner before broad shell exploration.",
    "Before patching, you MUST do a verification pass. For each explicit requirement in the user's intent, simulate at least one edge case against the candidate. When tests/examples are available or a fast runner is obvious, inspect or run them before final output.",
    "For parsers, validators, normalizers, and path helpers: consume/validate the full input, preserve token boundaries, and reject or handle leftovers explicitly. Partial regex matches that ignore invalid text are bugs.",
    "Do not edit files directly. Do not mention patches for other files or ranges.",
    "A 'concrete change' means: a fix for an actual bug, an implementation for a documented-but-missing feature, or a literal textual change the intent asks for. Defensive code, type checks, comments, error-class additions, idiom polish, value-type substitutions (e.g. 0 vs 0.0, '' vs str()), and other speculative improvements are NOT concrete changes.",
    "If, after reading the selected code carefully, you cannot point to a specific incorrect behavior or a specific request the intent makes, return NVIME_NO_CHANGE with one short reason. NVIME_NO_CHANGE is the right answer when the code already meets its documented behavior.",
    "When the intent mixes review-style language ('check', 'verify', 'iterate through', 'make sure') with fix-style language ('fix', 'proceed'), still require a real bug before patching. Review framing alone never authorizes speculative edits.",
    "When the intent describes a bug ('crashes on X', 'hangs on Y', 'returns wrong value for Z') but the selected code already handles that exact case correctly, return NVIME_NO_CHANGE and briefly note that the described case is already handled. Do NOT silently re-implement a guard or fix that is already present.",
    "Before producing NVIME_DIFF, re-read the selected code: do not insert a line that already exists, do not duplicate an existing return/break/continue, and verify your hunk's context lines match the selected text exactly.",
    "Prefer NVIME_DIFF for any change to existing nonblank text. Use NVIME_DIFF with the smallest changed hunks only. NVIME_DIFF is required for Markdown, large selections, and selections containing code fences.",
    "NVIME_REPLACEMENT is acceptable for blank or near-blank selected ranges, tiny whole-range rewrites, or small selected ranges where several nearby lines must change and a minimal hunk would be brittle. The replacement is inserted verbatim at the selected range; no indentation is added for you. If the selection is a blank line inside an indented block (e.g. a Python function body), include the exact leading whitespace of the surrounding scope on every non-empty replacement line.",
    `NVIME_DIFF must include --- a/${path}, +++ b/${path}, and ranged @@ -line,count +line,count @@ headers.`,
    "",
    "RATIONALIZATION (mandatory before NVIME_DIFF or NVIME_REPLACEMENT):",
    "Before emitting a patch you must convince yourself the change is correct. Walk through it as a self-check:",
    "  1. What is the bug, missing feature, or literal request? State it in one clause.",
    "  2. What does the patch do? State it in one clause.",
    "  3. Does the patch actually fix step 1 — and only that — without breaking other behavior visible from the selected range?",
    "If you cannot answer all three to your own satisfaction, emit NVIME_NO_CHANGE instead. If you CAN, emit ONE rationale line of the form:",
    "  RATIONALE: <one sentence: bug → patch → why it's correct>",
    "directly above the NVIME_* marker. The user sees this verbatim in the diff review header before they accept any block, so be honest. No multi-line essays; one line. nvime drops the rationale if you over-explain.",
    "",
    "VERIFY: (optional but encouraged when MCP is available).",
    "If the nvime MCP tools are available, call `nvime.verify_file` on the proposed full-file content BEFORE emitting NVIME_DIFF / NVIME_REPLACEMENT. Pass {file: <selected file>, content: <the file after applying your patch>} and report the result:",
    "  VERIFY: ok                     — parse clean, no checks reported issues",
    "  VERIFY: <N> findings           — checks reported issues; emit only if you have read them and still believe the patch is correct",
    "  VERIFY: skipped (<reason>)     — verify_file unavailable or no checks shipped for this language",
    "Place the VERIFY: line on its own row, next to RATIONALE: and above the NVIME_* marker. If verify reports a parse error, do not emit a patch — fix the proposal until it parses or return NVIME_NO_CHANGE.",
    "",
    "Use one response form:",
    "",
    "NVIME_NO_CHANGE",
    "<brief explanation>",
    "",
    "RATIONALE: <one-line self-check>",
    "NVIME_REPLACEMENT",
    "```",
    "<full replacement for the selected range only>",
    "```",
    "",
    "RATIONALE: <one-line self-check>",
    "NVIME_DIFF",
    "```diff",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -<line>,<count> +<line>,<count> @@",
    "<minimal changed hunk lines only>",
    "```",
    "",
    `File: ${path}`,
    `Allowed range: ${allowedRange(sel.line1, sel.line2, sel.source)}`,
    `Intent: ${intent}`,
  ];

  if (opts?.priorAsk) {
    lines.push(
      "",
      "Previous read-only reviewer context for this exact selection:",
      `Question: ${opts.priorAsk.question}`,
      "Answer:",
      opts.priorAsk.answer || "(empty)"
    );
  }

  if (opts?.projectContext) {
    const cfence = codeFenceFor(opts.projectContext);
    lines.push("", "Precomputed context:", cfence, opts.projectContext, cfence);
  }

  lines.push("", "Selected code:", fence, display, fence);
  return lines.join("\n");
}

export function buildPerfPrompt(sel: PromptSelection, intent: string, selectedBody: string): string {
  const display = selectedDisplay(selectedBody);
  const fence = codeFenceFor(display);
  return [
    "NVIME PERF EDIT MODE.",
    "You are a constrained patch worker focused on computational cost and scalability.",
    "Goal: produce a measurably faster or more memory-frugal version of the selected code, with behavior preserved on all inputs the original accepts.",
    "If you cannot prove a real win with numbers, return NVIME_NO_CHANGE.",
    "",
    "Mandatory workflow before answering:",
    "  1. Read the selected code carefully. Identify the asymptotic and constant-factor cost.",
    "  2. Pick at least one representative bench input (small, medium, large where appropriate).",
    "  3. Use Bash to create a scratch directory under /tmp (e.g. mktemp -d /tmp/nvime-bench.XXXXXX). NEVER write inside the user's repository.",
    "  4. Write the original selected code and your candidate replacement to two separate files in that scratch dir.",
    "  5. Construct a behavior parity check: feed both implementations the same fixed and randomized inputs and assert outputs are equal (and exception-shape if the function is documented to raise).",
    "  6. Run a microbenchmark appropriate for the language (python -m timeit, hyperfine, time, perf_hooks, os.clock) with at least 3 trials per side. Use sufficiently large input that timing dominates noise.",
    "  7. Compare. Only if candidate is correct AND faster by at least the threshold the intent implies (default ~30% wallclock or asymptotic improvement), produce NVIME_DIFF.",
    "  8. If correctness fails, behavior diverges, candidate is slower, or the gain is within measurement noise, return NVIME_NO_CHANGE with the measured numbers.",
    "",
    "Keep the candidate minimal. Your replacement must be the SMALLEST change that achieves the goal. Do not preserve undocumented edge cases (unhashable elements, exotic exception shapes, non-list iterables when the docstring talks about lists) at the cost of code complexity. Prefer one or two lines over ten.",
    "Match the original's documented behavior, not its accidental behavior. If the original raises X on empty input and the docstring/intent does not require it, do not write fallback code in the candidate just to keep raising X.",
    "Forbidden:",
    "  - writing to any path under the repo root or any ancestor directory (use only /tmp/nvime-bench.* paths);",
    "  - deleting any file you did not create in the scratch dir;",
    "  - importing heavy external dependencies (numpy/numba/etc.) unless the intent explicitly authorizes them;",
    "  - changes outside the selected range or in another file;",
    "  - any change whose only justification is style;",
    "  - candidates with try/except / type-dispatch fallbacks added solely to preserve corner cases the original happened to support.",
    "",
    "Response format:",
    "  - You MAY emit one short summary line BEFORE the NVIME_* marker, of the form:",
    "      BENCH: orig=<t1>s cand=<t2>s speedup=<x>x n=<size>",
    "    No other prose anywhere.",
    "  - Then exactly one machine-readable response block:",
    "",
    "NVIME_NO_CHANGE",
    "<one short reason; include the measured numbers if available>",
    "",
    "NVIME_REPLACEMENT",
    "```",
    "<full replacement for the selected range only, with surrounding indentation preserved>",
    "```",
    "",
    "NVIME_DIFF",
    "```diff",
    `--- a/${sel.path}`,
    `+++ b/${sel.path}`,
    "@@ -<line>,<count> +<line>,<count> @@",
    "<minimal changed hunk lines only>",
    "```",
    "",
    `File: ${sel.path}`,
    `Allowed range: ${allowedRange(sel.line1, sel.line2, sel.source)}`,
    `Intent: ${intent}`,
    "",
    "Selected code:",
    fence,
    display,
    fence,
  ].join("\n");
}

export function buildQuickPrompt(sel: PromptSelection, intent: string, selectedBody: string): string {
  const display = selectedDisplay(selectedBody);
  const fence = codeFenceFor(display);
  const path = sel.path || "file";
  return [
    "NVIME QUICK FIX. Minimal patch worker — no tools, no file exploration.",
    "Fix the selected code based on the intent using ONLY what is shown below.",
    "If you cannot fix it without seeing more code, return NVIME_NO_CHANGE and state exactly what context you need.",
    "",
    "Response format (pick one):",
    "",
    "NVIME_NO_CHANGE",
    "<reason or what context you need>",
    "",
    "NVIME_REPLACEMENT",
    "```",
    "<full replacement for the selected range>",
    "```",
    "",
    "NVIME_DIFF",
    "```diff",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -<line>,<count> +<line>,<count> @@",
    "<hunks>",
    "```",
    "",
    `File: ${sel.path || "unknown"}`,
    `Range: ${sel.line1}-${sel.line2}`,
    `Intent: ${intent}`,
    "",
    "Selected code:",
    fence,
    display,
    fence,
  ].join("\n");
}

// ----- ASK LANE --------------------------------------------------------------

export function buildAskPrompt(sel: PromptSelection, question: string, body: string): string {
  const fence = codeFenceFor(body);
  return [
    "NVIME READ-ONLY SELECTION CHAT — look, don't touch.",
    "You are the read-only blade inside Neovim: sharp eyes, hands tied.",
    "Answer the user's question about the selected code. You may use read/search, web fetch/search, and shell commands such as curl for inspection, external docs, or tests when available.",
    "Do not edit files directly. Do not produce a patch unless you are only narrating what a future patch would do.",
    "",
    `File: ${sel.path}`,
    `Selected range: ${allowedRange(sel.line1, sel.line2, sel.source)}`,
    `Question: ${question}`,
    "",
    "Selected code:",
    fence,
    body,
    fence,
  ].join("\n");
}

// ----- intent reroute --------------------------------------------------------

const EDIT_KEYWORDS_EDIT_LANE = [
  "make", "change", "fix", "add", "remove", "replace", "implement", "refactor",
  "rename", "convert", "update", "handle", "delete", "move", "extract", "inline",
  "wrap", "unwrap", "rewrite",
];

function hasWordBoundary(text: string, word: string): boolean {
  const re = new RegExp(`(^|[^\\w])${word}([^\\w]|$)`);
  return re.test(text);
}

export function looksLikeQuestion(intent: string): boolean {
  const text = (intent || "").toLowerCase();
  if (text === "") return false;
  if (EDIT_KEYWORDS_EDIT_LANE.some((kw) => hasWordBoundary(text, kw))) return false;
  const substrings = [
    "?", "look right", "looks right", "does this", "is this", "check ", "verify",
    "inspect", "audit", "iterate throughout", "correctness", "nitpick",
    "appropriate", "what ", "why ", "explain", "review",
  ];
  return substrings.some((s) => text.includes(s));
}

// ----- ask → edit follow-up --------------------------------------------------

const EDIT_KEYWORDS_FOLLOWUP = [
  "proceed", "go ahead", "fix", "change", "update", "apply", "implement",
  "refactor", "rename", "convert", "replace", "remove", "add", "patch", "diff", "make it",
];

const NEGATION_PATTERNS = [
  /don'?t/, /do not/, /doesn'?t/, /does not/, /shouldn'?t/, /should not/, /no need/, /never/,
];

function hasWordOrPhrase(text: string, phrase: string): boolean {
  if (phrase.includes(" ")) return text.includes(phrase);
  return hasWordBoundary(text, phrase);
}

export function wantsEditFollowup(input: string): boolean {
  const text = (input || "").toLowerCase();
  if (text === "") return false;
  if (/^\s*\/edit\b/.test(text) || /^\s*\/edit$/.test(text)) return true;
  if (/^\s*what\s/.test(text) || /^\s*why\s/.test(text) || /^\s*how\s/.test(text)) return false;
  if (NEGATION_PATTERNS.some((re) => re.test(text))) return false;
  if (text.includes("approv") && (text.includes("diff") || text.includes("patch"))) return true;
  if (EDIT_KEYWORDS_FOLLOWUP.some((kw) => hasWordOrPhrase(text, kw))) return true;
  return false;
}

export function responseHasPatch(answer: string): boolean {
  const t = (answer || "").trim();
  return (
    t.includes("NVIME_DIFF") ||
    t.includes("NVIME_REPLACEMENT") ||
    t.includes("```diff") ||
    t.includes("--- a/")
  );
}
