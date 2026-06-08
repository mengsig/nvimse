import * as vscode from "vscode";
import { chatStore, selectionStore } from "../sessions";
import { openChat } from "./chatPanel";
import { currentProvider } from "../services";
import { workspaceRoot } from "../paths";
import * as path from "path";
import { escapeHtml, panelShell } from "./webviewHtml";

function openSelection(id: number): void {
  const sel = selectionStore.get(id);
  if (!sel) return;
  const abs = path.isAbsolute(sel.selection.path) ? sel.selection.path : path.join(workspaceRoot(), sel.selection.path);
  vscode.workspace.openTextDocument(abs).then((doc) => {
    vscode.window.showTextDocument(doc).then((editor) => {
      const l1 = Math.max(0, sel.selection.line1 - 1);
      const l2 = Math.max(l1, Math.min(sel.selection.line2 - 1, doc.lineCount - 1));
      editor.selection = new vscode.Selection(l1, 0, l2, doc.lineAt(l2).text.length);
      editor.revealRange(new vscode.Range(l1, 0, l2, 0), vscode.TextEditorRevealType.InCenter);
    });
  });
}

let panel: vscode.WebviewPanel | undefined;

export function openDashboard(): void {
  if (!panel) {
    panel = vscode.window.createWebviewPanel("nvimseDashboard", "nvimse · command center", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => (panel = undefined));
    panel.webview.onDidReceiveMessage((m) => {
      if (m.type === "newChat") openChat(undefined);
      else if (m.type === "openChat") openChat(m.id);
      else if (m.type === "ask") vscode.commands.executeCommand("nvimse.ask");
      else if (m.type === "edit") vscode.commands.executeCommand("nvimse.edit");
      else if (m.type === "plan") vscode.commands.executeCommand("nvimse.plan");
      else if (m.type === "bigchange") vscode.commands.executeCommand("nvimse.bigChange");
      else if (m.type === "usage") vscode.commands.executeCommand("nvimse.usage");
      else if (m.type === "openSelection") openSelection(m.id);
    });
  }
  panel.reveal();
  render();
}

function render(): void {
  if (!panel) return;
  const chats = chatStore.all();
  const sels = selectionStore.all();
  const running = [...chats, ...sels].filter((s) => s.busy).length;
  const chatRows = chats
    .slice(0, 20)
    .map((c) => `<div class="row" onclick="post({type:'openChat',id:${c.id}})"><span class="dot ${c.busy ? "run" : ""}"></span>${escapeHtml(c.title)} <span class="meta">${c.provider}</span></div>`)
    .join("");
  const selRows = sels
    .slice(0, 24)
    .map((s) => `<div class="row" onclick="post({type:'openSelection',id:${s.id}})"><span class="dot ${s.busy ? "run" : ""}"></span>${escapeHtml(s.title)} <span class="meta">${s.mode} · ${s.provider}</span></div>`)
    .join("");

  const headerHtml = `<header style="padding:14px 18px;border-bottom:1px solid #2f334d;">
    <span class="brand">◆ nvimse</span><span class="ver">v0.3.0</span>
    <div class="sub">review/docs chat &nbsp;|&nbsp; scoped ask &nbsp;|&nbsp; reviewed edit</div></header>`;
  const body = `
    <div class="filter">◈ ${chats.length} chats &nbsp; ◇ ${sels.length} scoped &nbsp; ● ${running} running &nbsp; ◆ provider ${currentProvider()}</div>
    <div class="actions">
      <button onclick="post({type:'newChat'})">＋  new review/docs chat</button>
      <button onclick="post({type:'ask'})">?  ask about current function</button>
      <button onclick="post({type:'edit'})">✎  edit current function</button>
      <button onclick="post({type:'plan'})">≡  plans</button>
      <button onclick="post({type:'bigchange'})">◆  Big Change</button>
      <button onclick="post({type:'usage'})">$  token + cost usage</button>
    </div>
    <h3>General Conversations (${chats.length})</h3>
    ${chatRows || '<div class="empty">none yet</div>'}
    <h3>Selection Discussions (${sels.length})</h3>
    ${selRows || '<div class="empty">none yet</div>'}`;
  panel.webview.html = panelShell("nvimse", body, {
    headerHtml,
    css: `
  .brand{color:#86e1fc;font-weight:bold;font-size:15px;} .ver{color:#828bb8;float:right;}
  .sub{color:#828bb8;margin-top:4px;}
  .filter{color:#828bb8;margin:8px 0 14px;}
  .actions button{display:block;width:100%;text-align:left;padding:8px 12px;margin:4px 0;}
  .actions button:hover{border-color:#82aaff;}
  h3{color:#c3e88d;margin:16px 0 6px;font-size:13px;}
  .row{padding:7px 10px;border:1px solid #2f334d;border-radius:6px;margin:4px 0;cursor:pointer;}
  .row:hover{border-color:#82aaff;} .meta{margin-left:6px;}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#2f334d;margin-right:6px;}
  .dot.run{background:#ffc777;}`,
  });
}
