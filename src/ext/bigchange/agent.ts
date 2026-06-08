// Big Change agent prompts (verbatim) + extractors — port of bigchange/agent.lua.
import { DIFFICULTY } from "./store";

export const INTAKE_PROTOCOL = `You drive a PLANNING UI (think Claude Code's plan mode): instead of free-form
prose questions, you present the user with structured DECISIONS they resolve by
picking options, so planning is fast and concrete.

Each turn you MUST output exactly ONE of:

1) A PLAN of clarifying decisions, wrapped EXACTLY in <PLAN> and </PLAN> as JSON:
   {
     "summary": "one or two sentences on what you now understand / are deciding",
     "questions": [
       {
         "id": "kebab-id",
         "prompt": "the decision, phrased plainly",
         "kind": "single" | "multi" | "text",
         "options": [ {"label": "short label", "detail": "one-line tradeoff"} ],
         "recommended": [<0-based option index you suggest>],
         "allow_custom": true
       }
     ]
   }
   - kind "single": pick exactly one option. kind "multi": pick k of N.
   - kind "text": no options; a free-text answer (omit "options").
   - Give 2-5 options with REAL tradeoffs; mark a sensible default in recommended.
   - Ask only what you cannot decide yourself from the repo. 1-4 questions per turn.
   - Put NOTHING outside the <PLAN></PLAN> tags.

2) The final implementation SPEC, wrapped EXACTLY in <SPEC> and </SPEC> (markdown:
   Goal, Scope (in/out), Files & modules, Data shapes / APIs, Step-by-step plan,
   Acceptance criteria). Emit this ONLY when every decision is settled and the build
   is unambiguous. Put nothing outside the tags.

Read the repository freely to ask informed questions and to ground the spec.`;

export function intakeKickoff(goal: string): string {
  return `You are in INTAKE mode for a large feature that ANOTHER agent will implement fully
autonomously afterward. Interrogate the user until EVERYTHING needed to implement
this is crystal clear — leave nothing to the imagination.

${INTAKE_PROTOCOL}

The user wants to build:
<goal>
${goal || "(no goal given)"}
</goal>

Emit your first <PLAN> of decisions now (or the <SPEC> if it is already fully
unambiguous and confirmed against the repo).`;
}

export function intakeFollowup(decisions: string): string {
  return `The user resolved your previous decisions:

${decisions || "(no selections)"}

Incorporate these. If anything is still ambiguous, emit another <PLAN>; otherwise
emit the final <SPEC>. Follow the same protocol:

${INTAKE_PROTOCOL}`;
}

export function buildPrompt(spec: string): string {
  return `You are now in BUILD mode. Implement the feature described by the approved spec
below, fully and autonomously, in the current working directory (an isolated git
worktree). You have full tool access.

Requirements:
- Implement everything in the spec. Match the surrounding code's style and idioms.
- Run the project's tests/build if present and fix what you break.
- Do NOT git commit and do NOT git push. Leave all changes in the working tree.
- When done, output a SHORT (<=5 line) summary of what you changed. No spec dump.

<spec>
${spec}
</spec>`;
}

const PREVIEW_LIMIT = 60;

export function groupPrompt(hunks: { id: string; file: string; header: string; lines: { kind: string; text: string }[] }[]): string {
  const lines: string[] = [
    "Group the following diff hunks into semantic REVIEW BLOCKS — meaningful",
    "units of change (a new function, a wired-up call site, a config change, a",
    "migration, etc.). Rules:",
    "- Each block groups hunks from ONE file only.",
    "- Every hunk must belong to exactly one block.",
    "- Give each block a SHORT descriptive title (<= 60 chars). Do NOT explain the code.",
    '- Mark a block "trivial": true ONLY when it is self-evident and needs no comprehension check — import/require/use lines, documentation/markdown prose, comment-only edits, or version/config value bumps. Otherwise omit it or set false.',
    "- Output ONLY a JSON array wrapped in <JSON></JSON>, no prose:",
    '  [{"title": "...", "file": "path", "hunk_ids": ["path#1"], "trivial": false}]',
    "",
    "Hunks:",
  ];
  for (const h of hunks) {
    lines.push("", `[${h.id}] ${h.file}`, h.header);
    const body = h.lines.slice(0, PREVIEW_LIMIT).map((l) => (l.kind === "add" ? "+" : l.kind === "del" ? "-" : " ") + l.text);
    lines.push(...body);
    if (h.lines.length > PREVIEW_LIMIT) lines.push("  … (truncated)");
  }
  return lines.join("\n");
}

export function gradePrompt(
  difficulty: string,
  blocks: { id: number; title: string; file: string; action: string; comment: string; diff: string }[]
): string {
  const d = DIFFICULTY[difficulty];
  const lines: string[] = [
    "You are grading a forced-comprehension review of code YOU implemented.",
    `Difficulty: ${difficulty} — explanations should demonstrate: ${d.detail}.`,
    `Passing grade is ${d.threshold}% or higher.`,
    "",
    "For each block below:",
    "- action=approve: the user EXPLAINS the code. Grade 0-100 how accurately and",
    "  completely their explanation matches what the code actually DOES and WHY, at",
    "  this difficulty. Reward genuine understanding in the user's OWN words.",
    "  ANTI-CHEAT — grade these <= 15 (failing) regardless of difficulty:",
    "    * the explanation merely restates or lightly rephrases the block TITLE,",
    "    * it parrots identifiers/comments/strings copied verbatim from the diff",
    "      without saying what they mean or why they're there,",
    "    * it is generic boilerplate that would fit almost any code change.",
    "  An explanation must add information not already visible in the title/diff to",
    "  pass. If below passing, give a SOCRATIC hint (see below).",
    "- action=request_changes: the user CRITIQUES your code. If the critique is valid,",
    "  FIX the code now (edit the files in this worktree) and set revised=true. If the",
    "  critique is wrong or misguided, set valid=false and explain why in response.",
    "",
    "HINTS must be Socratic: pose a question or point at the concept/area the user",
    '  MISSED — e.g. "What happens to the second branch when the list is empty?" — and',
    "  NEVER state the correct explanation, name the answer, or quote the fix. A reader",
    "  should still have to think. One line, no spoilers.",
    "",
    "Output ONLY a JSON array wrapped in <JSON></JSON>:",
    '  [{"id": <int>, "action": "approve"|"request_changes",',
    '    "grade": <int 0-100>, "verdict": "...", "hint": "...",',
    '    "valid": <bool>, "revised": <bool>, "response": "..."}]',
    "",
  ];
  for (const b of blocks) {
    lines.push(`### Block ${b.id} — ${b.title} (${b.file}) — action=${b.action}`);
    lines.push("diff:", b.diff);
    lines.push(b.action === "approve" ? "user explanation:" : "user critique:", b.comment, "");
  }
  return lines.join("\n");
}

export function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export function extractJsonArray(text: string): any | null {
  const tagged = extractTag(text, "JSON");
  const candidate = tagged || fencedJson(text) || firstBalanced(text);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function fencedJson(text: string): string | null {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : null;
}

function firstBalanced(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
