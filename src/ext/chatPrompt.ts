// Conversation prompt builder — verbatim port of chat.lua build_conversation_prompt.
import { config } from "./runtime";
import { ChatMessage } from "./sessions";

export function buildConversationPrompt(
  text: string,
  history: ChatMessage[],
  opts: { resumeSessionId?: string | null; includeTranscript?: boolean }
): string {
  const review = config().review;
  const markdownPolicy = review.allowMarkdownWrites
    ? "You may create or update Markdown documentation files only (*.md, *.markdown). Do not edit source/config files directly."
    : "Markdown writes are disabled in this lane.";
  const shellPolicy = review.allowShell
    ? "You may run shell commands, including curl, for inspection, external docs, and tests."
    : "Shell commands are disabled.";
  const webPolicy = review.allowWeb !== false
    ? "You may use web fetch/search tools for external documentation and current information."
    : "Native web fetch/search tools are disabled.";

  const lines: string[] = [
    "NVIME CHAT MODE.",
    "You are the side agent inside Neovim.",
    "You may answer questions, review code, and suggest changes.",
    "Do not narrate tool use or progress. Answer with the final findings, reasoning, or next action after inspection.",
    markdownPolicy,
    shellPolicy,
    webPolicy,
    "Never edit non-Markdown files from this lane. Source changes must go through NVIME EDIT MODE and reviewed diffs.",
  ];

  if (opts.resumeSessionId) {
    lines.push("You are continuing this provider's native conversation via resume. Use that native context for prior turns.");
  } else {
    lines.push("Continue the conversation using the transcript below.");
  }

  lines.push("");
  if (!opts.resumeSessionId || opts.includeTranscript) {
    lines.push("Conversation so far:");
    if (history.length === 0) lines.push("(empty)");
    else for (const m of history) lines.push(`${m.role.toUpperCase()}: ${m.content}`);
  } else {
    lines.push("Conversation so far: available from the resumed native provider session.");
  }

  lines.push("");
  lines.push("USER: " + text);
  lines.push("");
  lines.push("Answer the latest user message with the prior conversation in mind.");
  return lines.join("\n");
}
