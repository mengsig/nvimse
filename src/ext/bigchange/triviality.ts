// Self-evident-block classifier for Big Change auto-clear — port of triviality.lua.
import { config } from "../runtime";
import { pathMatchesAny } from "../glob";

const CONFIG_GLOBS = [
  "**/version.lua", "VERSION", "**/VERSION", "version.txt",
  "*.toml", "**/*.toml", "*.ini", "**/*.ini", "*.cfg", "**/*.cfg", "*.conf", "**/*.conf",
  "*.yaml", "**/*.yaml", "*.yml", "**/*.yml", "package.json", "**/package.json",
];

const COMMENT_PREFIXES: Record<string, string[]> = {
  lua: ["--"],
  py: ["#"], sh: ["#"], bash: ["#"], zsh: ["#"], rb: ["#"], yaml: ["#"], yml: ["#"], toml: ["#"], ini: ["#"], cfg: ["#"], conf: ["#"],
  js: ["//", "/*", "*/", "*"], ts: ["//", "/*", "*/", "*"], jsx: ["//", "/*", "*/", "*"], tsx: ["//", "/*", "*/", "*"],
  go: ["//", "/*", "*/", "*"], c: ["//", "/*", "*/", "*"], cpp: ["//", "/*", "*/", "*"], cc: ["//", "/*", "*/", "*"],
  h: ["//", "/*", "*/", "*"], hpp: ["//", "/*", "*/", "*"], java: ["//", "/*", "*/", "*"], rs: ["//", "/*", "*/", "*"], zig: ["//"],
};

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  py: [/^import\s/, /^from\s+[\w.]+\s+import\s/],
  lua: [/^local\s+[\w_,\s]+=\s*require/, /^require\s*\(/],
  js: [/^import\s/, /^export\s+.*\sfrom\s/, /=\s*require\s*\(/],
  ts: [/^import\s/, /^export\s+.*\sfrom\s/, /=\s*require\s*\(/],
  tsx: [/^import\s/, /^export\s+.*\sfrom\s/, /=\s*require\s*\(/],
  go: [/^import\s/],
  rs: [/^use\s/],
  c: [/^#include/], cpp: [/^#include/], h: [/^#include/],
  java: [/^import\s/],
};

function ext(file: string): string {
  const m = file.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "";
}

function lineCategory(line: string, e: string): string {
  const trimmed = line.trim();
  if (trimmed === "") return "blank";
  const comments = COMMENT_PREFIXES[e] || [];
  if (comments.some((c) => trimmed.startsWith(c))) return "comment";
  const imports = IMPORT_PATTERNS[e] || [];
  if (imports.some((re) => re.test(trimmed))) return "import";
  return "code";
}

export interface TrivialResult {
  trivial: boolean;
  category?: string;
  source?: "heuristic" | "agent";
}

/** changedLines = the added/removed line texts of the block. */
export function classify(file: string, changedLines: string[], agentTrivial: boolean, difficulty: string): TrivialResult {
  const cfg = config().bigchange.trivial;
  const applies = cfg.enabled !== false && (difficulty === "easy" || difficulty === "medium");
  if (!applies) return { trivial: false };
  if (changedLines.length === 0) return { trivial: false };

  if (pathMatchesAny(file, cfg.docGlobs)) return { trivial: true, category: "doc", source: "heuristic" };
  if (pathMatchesAny(file, CONFIG_GLOBS)) return { trivial: true, category: "config", source: "heuristic" };

  const e = ext(file);
  const cats = changedLines.map((l) => lineCategory(l, e));
  const nonBlank = cats.filter((c) => c !== "blank");
  const allImports = nonBlank.length > 0 && nonBlank.every((c) => c === "import");
  const allComments = nonBlank.length > 0 && nonBlank.every((c) => c === "comment");
  if (allImports) return { trivial: true, category: "import", source: "heuristic" };
  if (allComments) return { trivial: true, category: "comment", source: "heuristic" };

  const hasCode = cats.includes("code");
  if (agentTrivial && !hasCode) return { trivial: true, category: "mixed", source: "agent" };
  return { trivial: false };
}
