// Devil's-advocate critic — verbatim prompt + verdict parser, port of critic.lua.
import { DiffSession } from "../core/protocol";
import { runAgent } from "./agentRunner";
import { audit } from "./audit";

const CRITIC_PROMPT_HEADER = [
  "NVIME PATCH CRITIC MODE.",
  "",
  "You are a critical reviewer of a proposed patch produced by a constrained patch worker.",
  "Your job is NOT to be agreeable. Find genuine reasons the patch should not land.",
  "You are read-only: you may use Read/Grep/Glob/LS to inspect the repository, but you cannot edit anything.",
  "",
  "Apply this critical lens, in order:",
  "  1. Does the patch actually solve the stated problem?",
  "  2. Does it introduce a new bug, break adjacent behavior, or violate a documented contract?",
  "  3. Is there a clearly simpler change that achieves the same goal?",
  "  4. Did the patch worker overreach (add defensive code, type checks, comments, or speculative changes outside the bug)?",
  "",
  "Output FORMAT (mandatory — the parser only reads the first verdict line):",
  "  - The FIRST non-empty line of your response MUST start with one of:",
  "      APPROVE",
  "      FLAG",
  "      REJECT",
  "    followed by a colon, a hyphen, or whitespace, then a one-sentence justification.",
  "  - Plain ASCII only on the verdict line. No markdown bold (**, __), no",
  "    backticks, no list markers (- / 1.), no headers (#), no blockquote (>).",
  "    Just `APPROVE: ...` / `FLAG: ...` / `REJECT: ...` flush left.",
  "  - One line. No multi-line essays. The parser stops at the newline.",
  "",
  "Examples:",
  "  APPROVE: minimal rename, semantics unchanged.",
  "  FLAG: this also touches the cache invalidation path; review that.",
  "  REJECT: the new branch removes the nil guard at line 42.",
  "",
  "Bias: prefer FLAG over REJECT unless the patch is unambiguously wrong. Prefer APPROVE only when you can name what the patch does correctly. The user makes the final call; your verdict is advisory.",
  "",
].join("\n");

export function buildCriticPrompt(session: DiffSession, intent: string, context: string): string {
  return [
    CRITIC_PROMPT_HEADER,
    `File: ${session.file}`,
    `Range: ${session.selection.line1}-${session.selection.line2}`,
    "",
    "User intent (verbatim):",
    intent,
    "",
    "Patch worker's stated rationale:",
    session.rationale || "(no rationale provided)",
    "",
    "Proposed patch (unified diff):",
    "```diff",
    session.diffText(),
    "```",
    "",
    "Selected range with surrounding context:",
    "```",
    context,
    "```",
  ].join("\n");
}

export function parseVerdict(text: string): { decision: string; justification?: string } | null {
  let cleaned = text.replace(/\*\*/g, "").replace(/__/g, "").replace(/`+/g, "");
  for (let raw of cleaned.split("\n")) {
    let line = raw.replace(/^\s+/, "");
    line = line.replace(/^[#>]+\s*/, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
    line = line.replace(/^[`*_]+/, "").replace(/[`*_]+$/, "").replace(/^\s+/, "");
    if (line.trim() === "") continue;
    const upper = line.toUpperCase();
    for (const decision of ["APPROVE", "FLAG", "REJECT"]) {
      if (upper.startsWith(decision)) {
        const next = upper[decision.length];
        if (next === undefined || !/[\w_]/.test(next)) {
          const justification = line.slice(decision.length).replace(/^[^\w]+/, "").trim();
          return { decision, justification: justification || undefined };
        }
      }
    }
    return null;
  }
  return null;
}

export async function reviewSession(
  session: DiffSession,
  intent: string,
  context: string,
  provider: string,
  onVerdict: (v: { decision: string; justification?: string }) => void
): Promise<void> {
  if ((session as any).criticStarted) return;
  (session as any).criticStarted = true;
  const prompt = buildCriticPrompt(session, intent, context);
  audit({ event: "critic_start", file: session.file, provider });
  try {
    const result = await runAgent({ provider, lane: "critic", prompt });
    let verdict = parseVerdict(result.text);
    if (!verdict && result.code === 0) {
      const first = result.text.split("\n").find((l) => l.trim() !== "");
      verdict = { decision: "FLAG", justification: (first || "advisory").slice(0, 200) };
    }
    audit({ event: "critic_exit", file: session.file, decision: verdict?.decision });
    if (verdict) {
      session.verdict = verdict;
      onVerdict(verdict);
    }
  } catch {
    /* critic is advisory; ignore failures */
  }
}
