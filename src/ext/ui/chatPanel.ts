// General chat / review conversation — a webview transcript with a prompt line,
// the nvime chat lane. One panel per session id.
import * as vscode from "vscode";
import { ChatSession, chatStore, setLast } from "../sessions";
import { buildConversationPrompt } from "../chatPrompt";
import { runAgent } from "../agentRunner";
import { config } from "../runtime";
import { currentProvider, setProvider, currentModel } from "../services";
import * as usage from "../usage";
import { unixSeconds } from "../paths";
import { escapeHtml, webviewHtml } from "./webviewHtml";

const panels = new Map<number, ChatPanel>();

export function stageReference(ref: string): void {
  // append an @path reference into the most recent chat (or a new one)
  const recent = chatStore.all()[0];
  openChat(recent ? recent.id : undefined);
  const panel = recent ? panels.get(recent.id) : panels.get(chatStore.all()[0]?.id);
  if (panel) panel.stage(ref);
}

export function openChat(sessionId?: number): void {
  let session: ChatSession | undefined = sessionId != null ? chatStore.get(sessionId) : undefined;
  if (!session) {
    const id = chatStore.nextId();
    session = {
      id,
      title: `Chat #${id}`,
      provider: currentProvider("chat"),
      model: currentModel("chat"),
      history: [],
      provider_sessions: {},
      created_at: unixSeconds(),
      updated_at: unixSeconds(),
    };
    chatStore.add(session);
  }
  let panel = panels.get(session.id);
  if (panel) {
    panel.reveal();
    return;
  }
  panel = new ChatPanel(session);
  panels.set(session.id, panel);
}

class ChatPanel {
  private panel: vscode.WebviewPanel;
  private busy = false;
  private staged = "";

  stage(ref: string): void {
    this.staged = this.staged ? this.staged + "\n" + ref : ref;
    this.reveal();
    this.render();
  }

  constructor(private session: ChatSession) {
    this.panel = vscode.window.createWebviewPanel(
      "nvimseChat",
      session.title,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel.onDidDispose(() => panels.delete(session.id));
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.render();
    setLast("chat", session.id);
  }

  reveal(): void {
    this.panel.reveal();
  }

  private render(progress?: string): void {
    this.panel.webview.html = webviewHtml({
      title: `nvimse chat · ${escapeHtml(this.session.title)}`,
      subtitle: `[${this.session.provider}]  ${this.busy ? "running…" : "idle"}${progress ? "  ·  " + escapeHtml(progress) : ""}`,
      body: this.transcriptHtml(),
      promptPlaceholder: `[${this.session.provider}]$ message…`,
      providers: ["claude", "codex"],
      activeProvider: this.session.provider,
      prefill: this.staged,
    });
  }

  private transcriptHtml(): string {
    if (this.session.history.length === 0) return `<div class="empty">New review/docs conversation. Type below and press Enter.</div>`;
    return this.session.history
      .map((m) => {
        const cls = m.role === "user" ? "user" : "agent";
        const label = m.role === "user" ? `[${this.session.provider}]$` : `[${this.session.provider} response]`;
        return `<div class="msg ${cls}"><div class="label">${escapeHtml(label)}</div><pre>${escapeHtml(m.content)}</pre></div>`;
      })
      .join("\n");
  }

  private async onMessage(m: any): Promise<void> {
    if (m.type === "submit") {
      await this.submit(String(m.text || ""));
    } else if (m.type === "provider") {
      this.session.provider = m.provider;
      setProvider(m.provider, "chat");
      chatStore.touch(this.session);
      this.render();
    } else if (m.type === "cancel") {
      // handled by agentRunner cancelAll from command palette; per-panel best-effort
    }
  }

  private async submit(text: string): Promise<void> {
    if (!text.trim() || this.busy) return;
    this.staged = "";
    this.busy = true;
    const provider = this.session.provider;
    this.session.history.push({ role: "user", content: text });
    this.render("starting…");

    const resume = this.session.provider_sessions[provider];
    const includeTranscript = !resume || this.session.last_provider !== provider;
    const prompt = buildConversationPrompt(text, this.session.history.slice(0, -1), { resumeSessionId: resume, includeTranscript });

    let answer = "";
    try {
      const result = await runAgent({
        provider,
        lane: "review",
        prompt,
        model: this.session.model,
        persistSession: true,
        resumeSessionId: resume,
        onProgress: (t) => this.render(t.replace(/\n/g, " ").slice(0, 60)),
        onText: (t) => {
          answer += t;
        },
        onSessionId: (id) => {
          this.session.provider_sessions[provider] = id;
        },
      });
      answer = result.text.trim() || answer.trim();
      this.session.last_provider = provider;
      if (result.usage) {
        answer += `\n\n— ${usage.runSummary(result.usage)}`;
      }
    } catch (e: any) {
      answer = "[error] " + (e?.message || String(e));
    }

    const max = config().chat.maxHistoryMessages;
    this.session.history.push({ role: "assistant", content: answer });
    if (this.session.history.length > max) this.session.history = this.session.history.slice(-max);
    if (/^Chat #\d+$/.test(this.session.title)) {
      const first = this.session.history.find((m) => m.role === "user");
      if (first) this.session.title = summarize(first.content);
    }
    this.busy = false;
    chatStore.touch(this.session);
    this.panel.title = this.session.title;
    this.render();
  }
}

function summarize(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 58 ? t.slice(0, 55) + "..." : t;
}
