import * as vscode from "vscode";
import { repoRelative } from "./git";
import { Selection as ProtoSelection } from "../core/protocol";

export interface ResolvedSelection {
  editor: vscode.TextEditor;
  uri: vscode.Uri;
  relPath: string;
  line1: number; // 1-based inclusive
  line2: number;
  source: string;
  bodyLines: string[]; // selected lines
  allLines: string[];
}

/** Resolve the active selection, or the enclosing function symbol at the cursor. */
export async function resolveSelection(): Promise<ResolvedSelection | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("nvimse: open a file first");
    return undefined;
  }
  const doc = editor.document;
  const allLines = doc.getText().split(/\r?\n/);
  let line1: number;
  let line2: number;
  let source: string;

  if (!editor.selection.isEmpty) {
    line1 = editor.selection.start.line + 1;
    line2 = editor.selection.end.line + 1;
    // if selection ends at col 0 of a line, exclude that trailing line
    if (editor.selection.end.character === 0 && line2 > line1) line2 -= 1;
    source = "range";
  } else {
    const sym = await enclosingSymbol(doc, editor.selection.active);
    if (sym) {
      line1 = sym.range.start.line + 1;
      line2 = sym.range.end.line + 1;
      source = "treesitter";
    } else {
      line1 = editor.selection.active.line + 1;
      line2 = line1;
      source = "range";
    }
  }

  const relPath = repoRelative(doc.uri.fsPath);
  return {
    editor,
    uri: doc.uri,
    relPath,
    line1,
    line2,
    source,
    bodyLines: allLines.slice(line1 - 1, line2),
    allLines,
  };
}

async function enclosingSymbol(
  doc: vscode.TextDocument,
  pos: vscode.Position
): Promise<vscode.DocumentSymbol | undefined> {
  try {
    const symbols = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      doc.uri
    )) || [];
    let best: vscode.DocumentSymbol | undefined;
    const wanted = new Set([
      vscode.SymbolKind.Function,
      vscode.SymbolKind.Method,
      vscode.SymbolKind.Constructor,
    ]);
    const walk = (syms: vscode.DocumentSymbol[]) => {
      for (const s of syms) {
        if (s.range.contains(pos)) {
          if (wanted.has(s.kind)) {
            if (!best || s.range.contains(best.range)) best = s;
          }
          if (s.children?.length) walk(s.children);
        }
      }
    };
    walk(symbols);
    return best;
  } catch {
    return undefined;
  }
}

export function toProtoSelection(sel: ResolvedSelection): ProtoSelection {
  return { path: sel.relPath, lines: sel.allLines, line1: sel.line1, line2: sel.line2, source: sel.source };
}

export function isNamedFile(uri: vscode.Uri): boolean {
  return uri.scheme === "file" && !!uri.fsPath;
}
