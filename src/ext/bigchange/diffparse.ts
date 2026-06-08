// Unified-diff → hunks with stable ids, for Big Change review grouping.
export interface BcDiffLine {
  kind: "add" | "del" | "ctx";
  text: string;
}
export interface BcHunk {
  id: string;
  file: string;
  header: string;
  lines: BcDiffLine[];
}

export function parseDiff(diff: string): BcHunk[] {
  const out: BcHunk[] = [];
  let file = "";
  let counter: Record<string, number> = {};
  let current: BcHunk | null = null;
  for (const line of diff.split("\n")) {
    let m = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (m) {
      file = m[1];
      continue;
    }
    m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m && m[1] !== "/dev/null") {
      file = m[1];
      continue;
    }
    if (/^--- /.test(line)) continue;
    if (/^@@ /.test(line)) {
      counter[file] = (counter[file] || 0) + 1;
      current = { id: `${file}#${counter[file]}`, file, header: line, lines: [] };
      out.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) current.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) current.lines.push({ kind: "del", text: line.slice(1) });
    else if (line.startsWith(" ")) current.lines.push({ kind: "ctx", text: line.slice(1) });
    // ignore '\' no-newline markers
  }
  return out;
}

export function hunkSignature(h: BcHunk): string {
  return h.file + "\n" + h.lines.filter((l) => l.kind !== "ctx").map((l) => `${l.kind}:${l.text}`).join("\n");
}

export function changedLines(h: BcHunk): string[] {
  return h.lines.filter((l) => l.kind !== "ctx").map((l) => l.text);
}
