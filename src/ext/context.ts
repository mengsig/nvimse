// Precomputed project context for the edit lane — port of edit.lua's
// build_project_context (symbols, related tests, recent accepted diffs).
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { config } from "./runtime";
import { workspaceRoot } from "./paths";
import { gitRoot } from "./git";
import { readForKind } from "./audit";
import { ResolvedSelection } from "./selectionUtil";
import { detectTestRunner } from "./testRunner";

export async function buildProjectContext(sel: ResolvedSelection): Promise<string | null> {
  const cfg = config().edit;
  if (cfg.injectContext === false) return null;
  const root = gitRoot(path.dirname(sel.uri.fsPath)) || workspaceRoot();
  const related = relatedTestFiles(sel.relPath, root, cfg.relatedTestLimit);
  const runner = detectTestRunner(root, related) || "(none detected)";

  const lines: string[] = [
    "Precomputed nvime project context.",
    "Use this before broad exploration; if it conflicts with live source, trust live source.",
    `Repo root: ${root}`,
    `Detected test runner: ${runner}`,
    `Related test paths: ${related.length ? related.join(", ") : "(none detected)"}`,
  ];

  if (cfg.symbolLimit > 0) {
    const symbols = await symbolContext(sel);
    if (symbols.length) {
      lines.push("", "Current file symbol context:");
      for (const s of symbols.slice(0, cfg.symbolLimit)) lines.push(s);
    }
  }

  for (const rel of related) {
    const abs = path.join(root, rel);
    try {
      const content = fs.readFileSync(abs, "utf8").split("\n");
      lines.push("", `Related test file: ${rel}`, "```");
      const shown = content.slice(0, 120);
      lines.push(...shown);
      if (content.length > 120) lines.push(`... [truncated ${content.length - 120} lines]`);
      lines.push("```");
    } catch {
      /* ignore */
    }
  }

  if (cfg.recentDiffLimit > 0) {
    const diffs = readForKind("diff_resolved", Math.max(cfg.recentDiffLimit, 16));
    if (diffs.length) {
      lines.push("", "Recent accepted nvime diffs:");
      for (const d of diffs.slice(-cfg.recentDiffLimit)) {
        let row = `- ${d.path || "?"} accepted ${d.accepted ?? "?"}/${d.total ?? "?"}`;
        if (d.rationale) row += ` rationale: ${String(d.rationale).slice(0, 160)}`;
        if (d.verdict) row += ` verdict: ${d.verdict}`;
        lines.push(row);
      }
    }
  }

  let text = lines.join("\n");
  const maxChars = Math.max(1000, cfg.contextMaxChars);
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n... [precomputed context truncated]";
  return text;
}

async function symbolContext(sel: ResolvedSelection): Promise<string[]> {
  try {
    const symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      sel.uri
    )) || [];
    const rows: { text: string; start: number; end: number }[] = [];
    const walk = (syms: vscode.DocumentSymbol[], parent?: string) => {
      for (const s of syms) {
        const kind = vscode.SymbolKind[s.kind].toLowerCase();
        let row = `- ${kind} \`${s.name}\` lines ${s.range.start.line + 1}-${s.range.end.line + 1}`;
        if (parent) row += ` parent ${parent}`;
        rows.push({ text: row, start: s.range.start.line + 1, end: s.range.end.line + 1 });
        if (s.children?.length) walk(s.children, s.name);
      }
    };
    walk(symbols);
    const near = rows.filter((r) => r.end >= sel.line1 - 20 && r.start <= sel.line2 + 20);
    return (near.length ? near : rows).map((r) => r.text);
  } catch {
    return [];
  }
}

function relatedTestFiles(relPath: string, root: string, limit: number): string[] {
  if (limit <= 0 || !relPath) return [];
  const dir = path.dirname(relPath);
  const ext = path.extname(relPath);
  const base = path.basename(relPath, ext);
  const suffix = ext || "";
  const candidates = [
    `test_${base}${suffix}`,
    `${base}_test${suffix}`,
    `${base}_spec${suffix}`,
    `${dir}/test_${base}${suffix}`,
    `${dir}/${base}_test${suffix}`,
    `${dir}/${base}_spec${suffix}`,
    `tests/test_${base}${suffix}`,
    `tests/${base}_test${suffix}`,
    `tests/${base}_spec${suffix}`,
    `test/test_${base}${suffix}`,
    `test/${base}_test${suffix}`,
    `spec/${base}_spec${suffix}`,
  ];
  const out: string[] = [];
  for (const c of candidates) {
    const norm = c.replace(/\\/g, "/").replace(/^\.\//, "");
    if (norm.startsWith("/") || norm.includes("..")) continue;
    if (out.includes(norm)) continue;
    try {
      if (fs.existsSync(path.join(root, norm))) {
        out.push(norm);
        if (out.length >= limit) break;
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}
