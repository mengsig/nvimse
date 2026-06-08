// Shared webview HTML scaffold — Tokyo-Night-Moon palette, transcript + prompt.
export function escapeHtml(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Shared chrome for the simple command panels (plan / bigchange / dashboard):
// the Tokyo-Night palette, header, wrap, button base, and the acquireVsCodeApi
// `post()` bridge. Panels pass their bespoke CSS via `css` and extra client
// helpers via `script`; dashboard overrides the header via `headerHtml`.
export const PANEL_BASE_CSS = `
  body{margin:0;background:#1a1b26;color:#c8d3f5;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;}
  header{padding:12px 16px;border-bottom:1px solid #2f334d;color:#86e1fc;font-weight:bold;}
  .wrap{padding:14px 16px;}
  button{background:#16161e;color:#c8d3f5;border:1px solid #2f334d;border-radius:5px;padding:5px 11px;margin:3px;cursor:pointer;font-family:inherit;}
  button.primary{background:#82aaff;color:#1a1b26;border:none;font-weight:bold;}
  .meta{color:#828bb8;font-size:12px;} .empty{color:#828bb8;font-style:italic;}
`;

export function panelShell(title: string, body: string, opts: { css?: string; script?: string; headerHtml?: string } = {}): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${PANEL_BASE_CSS}${opts.css || ""}</style></head>
<body>${opts.headerHtml ?? `<header>${escapeHtml(title)}</header>`}<div class="wrap">${body}</div>
<script>const v=acquireVsCodeApi();function post(m){v.postMessage(m);}
${opts.script || ""}</script></body></html>`;
}

export interface WebviewOpts {
  title: string;
  subtitle: string;
  body: string;
  promptPlaceholder?: string;
  providers?: string[];
  activeProvider?: string;
  noInput?: boolean;
  prefill?: string;
}

export function webviewHtml(o: WebviewOpts): string {
  const providerChips = (o.providers || [])
    .map((p) => `<button class="chip ${p === o.activeProvider ? "active" : ""}" onclick="setProvider('${p}')">${escapeHtml(p)}</button>`)
    .join("");
  const input = o.noInput
    ? ""
    : `<div class="promptbar">
        <textarea id="prompt" placeholder="${escapeHtml(o.promptPlaceholder || "message…")}" rows="2">${escapeHtml(o.prefill || "")}</textarea>
        <button id="send" onclick="send()">Send ⏎</button>
       </div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  :root{--bg:#1a1b26;--fg:#c8d3f5;--muted:#828bb8;--blue:#82aaff;--cyan:#86e1fc;--green:#c3e88d;--orange:#ff966c;--red:#ff757f;--border:#2f334d;}
  html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font-family:var(--vscode-editor-font-family,monospace);font-size:13px;height:100%;}
  .wrap{display:flex;flex-direction:column;height:100vh;}
  header{padding:10px 14px;border-bottom:1px solid var(--border);}
  header .title{color:var(--cyan);font-weight:bold;}
  header .subtitle{color:var(--muted);margin-top:2px;font-size:12px;}
  .chips{margin-top:6px;}
  .chip{background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:4px;padding:2px 8px;margin-right:4px;cursor:pointer;font-size:11px;}
  .chip.active{border-color:var(--blue);color:var(--blue);}
  .scroll{flex:1;overflow:auto;padding:10px 14px;}
  .msg{margin-bottom:14px;}
  .msg .label{color:var(--orange);font-size:11px;margin-bottom:2px;}
  .msg.agent .label{color:var(--blue);}
  .msg pre{white-space:pre-wrap;margin:0;background:rgba(255,255,255,0.02);padding:8px;border-radius:6px;border:1px solid var(--border);}
  .empty{color:var(--muted);font-style:italic;}
  .promptbar{display:flex;gap:8px;padding:10px 14px;border-top:1px solid var(--border);}
  textarea{flex:1;background:#16161e;color:var(--fg);border:1px solid var(--border);border-radius:6px;padding:8px;resize:vertical;font-family:inherit;}
  button#send{background:var(--blue);color:#1a1b26;border:none;border-radius:6px;padding:0 14px;cursor:pointer;font-weight:bold;}
</style></head>
<body><div class="wrap">
  <header><div class="title">${escapeHtml(o.title)}</div><div class="subtitle">${escapeHtml(o.subtitle)}</div>
  <div class="chips">${providerChips}</div></header>
  <div class="scroll" id="scroll">${o.body}</div>
  ${input}
</div>
<script>
  const vscode = acquireVsCodeApi();
  function send(){const t=document.getElementById('prompt'); if(!t)return; const v=t.value; t.value=''; vscode.postMessage({type:'submit',text:v});}
  function setProvider(p){vscode.postMessage({type:'provider',provider:p});}
  const ta=document.getElementById('prompt');
  if(ta){ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}}); ta.focus();}
  const sc=document.getElementById('scroll'); if(sc) sc.scrollTop=sc.scrollHeight;
</script>
</body></html>`;
}
