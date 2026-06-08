// Inline attribution overlay — port of `:NvimeAttribute show/hide`. Paints
// virtual end-of-line annotations on every attributed line in the active editor.
import * as vscode from "vscode";
import * as attribution from "./attribution";
import { repoRelative } from "./git";

let shown = false;

const deco = vscode.window.createTextEditorDecorationType({
  after: { margin: "0 0 0 2em", color: new vscode.ThemeColor("editorCodeLens.foreground") },
});

function paint(editor: vscode.TextEditor): void {
  const rel = repoRelative(editor.document.uri.fsPath);
  const entries = attribution.forFile(rel);
  if (!entries.length) {
    editor.setDecorations(deco, []);
    return;
  }
  const bufLines = editor.document.getText().split(/\r?\n/);
  const options: vscode.DecorationOptions[] = [];
  const seen = new Set<number>();
  for (const e of entries) {
    const loc = attribution.locateAnchor(bufLines, e);
    if (!loc) continue;
    const line = loc.line1 - 1;
    if (seen.has(line) || line >= editor.document.lineCount) continue;
    seen.add(line);
    const who = e.plan_id ? `plan ${e.plan_id}/${e.step_id}` : "edit";
    const text = `  ◆ ${who} · ${e.provider || "?"}${e.forced ? " · FORCED" : ""}${e.rationale ? " · " + e.rationale.slice(0, 60) : ""}`;
    options.push({
      range: new vscode.Range(line, 0, line, 0),
      renderOptions: { after: { contentText: text } },
    });
  }
  editor.setDecorations(deco, options);
}

export function show(): void {
  shown = true;
  const editor = vscode.window.activeTextEditor;
  if (editor) paint(editor);
}

export function hide(): void {
  shown = false;
  const editor = vscode.window.activeTextEditor;
  if (editor) editor.setDecorations(deco, []);
}

export function toggle(): void {
  shown ? hide() : show();
}

export function registerAutoRepaint(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (shown && editor) paint(editor);
    }),
    deco
  );
}
