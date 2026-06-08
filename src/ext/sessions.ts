// Conversation session stores (chat + selection) — port of nvime's panel.lua
// persistence model. Persisted to .nvime/chat-sessions.json and
// .nvime/selection-sessions.json.

import { config, isDisabled } from "./runtime";
import { nvimePath, readJson, writeJson, unixSeconds } from "./paths";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSession {
  id: number;
  title: string;
  provider: string;
  model?: string | null;
  history: ChatMessage[];
  provider_sessions: Record<string, string>;
  last_provider?: string;
  created_at: number;
  updated_at: number;
  busy?: boolean;
}

export interface SelectionSession {
  id: number;
  key: string;
  title: string;
  selection: { path: string; line1: number; line2: number; source?: string };
  provider: string;
  model?: string | null;
  mode: "ask" | "edit" | "selection";
  last_run_mode?: string;
  history: ChatMessage[];
  provider_sessions: Record<string, string>;
  last_ask?: { question: string; answer: string };
  created_at: number;
  updated_at: number;
  busy?: boolean;
}

interface Store<T> {
  version: number;
  next_session_id: number;
  active_session_id: number | null;
  sessions: T[];
}

const SCHEMA = 1;

class SessionStore<T extends { id: number; updated_at: number; busy?: boolean }> {
  private data: Store<T> | null = null;
  constructor(private file: () => string) {}

  private load(): Store<T> {
    if (this.data) return this.data;
    const s = readJson<Store<T>>(this.file(), { version: SCHEMA, next_session_id: 1, active_session_id: null, sessions: [] });
    if (!Array.isArray(s.sessions)) s.sessions = [];
    s.sessions.forEach((x) => (x.busy = false));
    s.next_session_id = Math.max(s.next_session_id || 1, ...s.sessions.map((x) => x.id + 1), 1);
    this.data = s;
    return s;
  }

  private save(): void {
    if (isDisabled() || config().sessions.enabled === false || !this.data) return;
    const max = config().sessions.max || 100;
    this.data.sessions.sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
    if (this.data.sessions.length > max) this.data.sessions = this.data.sessions.slice(0, max);
    writeJson(this.file(), this.data);
  }

  all(): T[] {
    return [...this.load().sessions].sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
  }

  get(id: number): T | undefined {
    return this.load().sessions.find((s) => s.id === id);
  }

  nextId(): number {
    return this.load().next_session_id;
  }

  add(session: T): T {
    const s = this.load();
    s.next_session_id = Math.max(s.next_session_id, session.id + 1);
    s.sessions.push(session);
    s.active_session_id = session.id;
    this.save();
    return session;
  }

  touch(session: T): void {
    session.updated_at = unixSeconds();
    this.load().active_session_id = session.id;
    this.save();
  }

  remove(id: number): void {
    const s = this.load();
    s.sessions = s.sessions.filter((x) => x.id !== id);
    this.save();
  }

  setActive(id: number | null): void {
    this.load().active_session_id = id;
    this.save();
  }

  activeId(): number | null {
    return this.load().active_session_id;
  }

  flush(): void {
    this.save();
  }
}

export const chatStore = new SessionStore<ChatSession>(() => nvimePath("chat-sessions.json", null));
export const selectionStore = new SessionStore<SelectionSession>(() => nvimePath("selection-sessions.json", null));

export function ensureSelectionSession(
  sel: { path: string; line1: number; line2: number; source?: string },
  provider: string,
  mode: "ask" | "edit"
): SelectionSession {
  const key = `${sel.path}|${sel.line1}|${sel.line2}`;
  const existing = selectionStore.all().find((s) => s.key === key);
  if (existing) {
    existing.provider = provider;
    existing.mode = mode;
    selectionStore.touch(existing);
    return existing;
  }
  const id = selectionStore.nextId();
  const session: SelectionSession = {
    id,
    key,
    title: `${sel.path}:${sel.line1}-${sel.line2}`,
    selection: { path: sel.path, line1: sel.line1, line2: sel.line2, source: sel.source },
    provider,
    mode,
    history: [],
    provider_sessions: {},
    created_at: unixSeconds(),
    updated_at: unixSeconds(),
  };
  return selectionStore.add(session);
}

export function recordSelectionTurn(session: SelectionSession, userText: string, assistantText: string, mode: "ask" | "edit"): void {
  session.history.push({ role: "user", content: userText });
  session.history.push({ role: "assistant", content: assistantText.slice(0, 4000) });
  session.last_run_mode = mode;
  if (mode === "ask") session.last_ask = { question: userText, answer: assistantText };
  if (session.history.length > 48) session.history = session.history.slice(-48);
  selectionStore.touch(session);
  setLast("selection", session.id);
}

let lastSession: { kind: "chat" | "selection"; id: number } | null = null;

export function setLast(kind: "chat" | "selection", id: number): void {
  lastSession = { kind, id };
}

export function resolveLast(): { kind: "chat" | "selection"; id: number } | null {
  if (lastSession) {
    const store = lastSession.kind === "chat" ? chatStore : selectionStore;
    if (store.get(lastSession.id)) return lastSession;
  }
  const chats = chatStore.all();
  const sels = selectionStore.all();
  const newestChat = chats[0];
  const newestSel = sels[0];
  if (!newestChat && !newestSel) return null;
  if (!newestSel || (newestChat && newestChat.updated_at >= newestSel.updated_at)) {
    return newestChat ? { kind: "chat", id: newestChat.id } : { kind: "selection", id: newestSel!.id };
  }
  return { kind: "selection", id: newestSel.id };
}

export function flushAll(): void {
  chatStore.flush();
  selectionStore.flush();
}
