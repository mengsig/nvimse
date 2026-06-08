// Intent classifier — heuristic port of nvime's lua/nvime/intent.lua.
import { config } from "./runtime";
import { audit } from "./audit";

const IMPERATIVE_VERBS = new Set([
  "add", "remove", "delete", "rename", "replace", "implement", "update", "fix",
  "refactor", "extract", "inline", "move", "write", "create", "change", "modify",
  "convert", "ensure", "validate", "parse", "return", "handle", "log", "raise",
  "throw", "reject", "accept", "guard", "cache", "memoize", "inject", "emit",
  "expose", "hide", "document", "test", "assert", "format", "sort", "normalize",
  "serialize", "deserialize", "encode", "decode", "split", "join", "trim",
  "escape", "unescape",
]);
const VAGUE_VERBS = new Set(["clean", "improve", "polish", "enhance", "optimize", "beautify", "tidy"]);
const VAGUE_PHRASES = [
  "fix bugs", "fix the bugs", "fix any bugs", "fix issues", "clean up", "clean this up",
  "make better", "make it better", "look at", "look into", "have a look", "make nicer",
  "polish this", "improve this", "improve the code", "do whatever", "whatever you think",
];
const ABSTRACT_OBJECTS = new Set(["it", "this", "that", "these", "those", "stuff", "things", "thing", "code"]);

export type Verdict = "ok" | "vague" | "questionable";

export function classify(intent: string): { verdict: Verdict; reason: string } {
  if (config().intent.enabled === false) return { verdict: "ok", reason: "disabled" };
  const trimmed = (intent || "").trim();
  if (trimmed === "") return { verdict: "ok", reason: "empty" };
  const words = (trimmed.toLowerCase().match(/[\w_]+/g) || []) as string[];
  const minWords = config().intent.minWords;
  if (words.length < minWords) return { verdict: "vague", reason: `intent has ${words.length} words, fewer than min_words=${minWords}` };
  const lower = trimmed.toLowerCase();
  if (VAGUE_PHRASES.some((p) => lower.includes(p))) return { verdict: "vague", reason: "vague phrase" };
  const hasImperative = words.some((w) => IMPERATIVE_VERBS.has(w));
  const hasVagueVerb = words.some((w) => VAGUE_VERBS.has(w));
  if (hasVagueVerb && !hasImperative) return { verdict: "vague", reason: "only vague verbs" };
  const looksConcrete =
    hasImperative && words.some((w) => !ABSTRACT_OBJECTS.has(w) && w.length > 2 && !VAGUE_VERBS.has(w));
  if (!looksConcrete) return { verdict: "questionable", reason: "lacks a concrete verb+object" };
  return { verdict: "ok", reason: "ok" };
}

/** Returns whether to proceed. `confirm` is invoked only for vague intents. */
export async function guard(
  intent: string,
  opts: { lane: string; assumeYes?: boolean; confirm?: (msg: string) => Promise<boolean>; notify?: (msg: string) => void }
): Promise<boolean> {
  if (config().intent.enabled === false) return true;
  const { verdict, reason } = classify(intent);
  if (verdict === "ok") return true;
  if (verdict === "questionable") {
    opts.notify?.("nvimse: intent is borderline — sending anyway");
    audit({ event: "intent_override", lane: opts.lane, reason });
    return true;
  }
  // vague
  if (opts.assumeYes) {
    audit({ event: "intent_override", lane: opts.lane, reason });
    return true;
  }
  const ok = opts.confirm ? await opts.confirm(`Intent looks vague (${reason}). Send anyway?`) : false;
  audit({ event: ok ? "intent_override" : "intent_block", lane: opts.lane, reason });
  return ok;
}
