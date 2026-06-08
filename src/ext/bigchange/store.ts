import * as path from "path";
import { nvimePath, readJson, writeJson, unixSeconds } from "../paths";

export type BcStatus = "draft" | "intake" | "building" | "review" | "merged";

export interface BcBlock {
  id: number;
  title: string;
  file: string;
  hunk_ids: string[];
  signature: string;
  state: "pending" | "explaining" | "critiquing" | "cleared" | "needs_explanation" | "critique_rejected";
  action: "approve" | "request_changes" | "auto_trivial" | null;
  comment: string | null;
  grade: number | null;
  hint: string | null;
  agent_response: string | null;
  agent_trivial: boolean;
  trivial: boolean;
  trivial_category: string | null;
}

export interface BcSession {
  id: number;
  title: string;
  status: BcStatus;
  difficulty: "vibe" | "easy" | "medium" | "extreme";
  provider: string;
  goal: string;
  draft: string;
  spec: string | null;
  spec_approved: boolean;
  worktree_sessions: Record<string, string>;
  provider_sessions: Record<string, string>;
  worktree: string | null;
  base_commit: string | null;
  base_branch: string | null;
  blocks: BcBlock[];
  diff_hunks: any[];
  intake_history: { role: "user" | "assistant"; content: string }[];
  review_round: number;
  merged_branch: string | null;
  created_at: number;
  updated_at: number;
}

export const DIFFICULTY: Record<string, { threshold: number | null; detail: string }> = {
  vibe: { threshold: null, detail: "no explanation required" },
  easy: { threshold: 40, detail: "general architecture" },
  medium: { threshold: 70, detail: "per-block intent + why" },
  extreme: { threshold: 90, detail: "near line-by-line" },
};
export const DIFFICULTY_ORDER = ["vibe", "easy", "medium", "extreme"];

interface Envelope {
  version: number;
  next_session_id: number;
  active_session_id: number | null;
  sessions: BcSession[];
}

function storePath(): string {
  return nvimePath("bigchange-sessions.json", null);
}

function read(): Envelope {
  const e = readJson<Envelope>(storePath(), { version: 1, next_session_id: 1, active_session_id: null, sessions: [] });
  if (!Array.isArray(e.sessions)) e.sessions = [];
  e.next_session_id = Math.max(e.next_session_id || 1, ...e.sessions.map((s) => s.id + 1), 1);
  return e;
}

function write(e: Envelope): void {
  e.sessions.sort((a, b) => b.updated_at - a.updated_at);
  writeJson(storePath(), e);
}

export function all(): BcSession[] {
  return read().sessions;
}

export function get(id: number): BcSession | undefined {
  return read().sessions.find((s) => s.id === id);
}

export function create(difficulty: BcSession["difficulty"], provider: string): BcSession {
  const e = read();
  const id = e.next_session_id;
  const s: BcSession = {
    id,
    title: "Untitled draft",
    status: "draft",
    difficulty,
    provider,
    goal: "",
    draft: "",
    spec: null,
    spec_approved: false,
    worktree_sessions: {},
    provider_sessions: {},
    worktree: null,
    base_commit: null,
    base_branch: null,
    blocks: [],
    diff_hunks: [],
    intake_history: [],
    review_round: 0,
    merged_branch: null,
    created_at: unixSeconds(),
    updated_at: unixSeconds(),
  };
  e.next_session_id = id + 1;
  e.active_session_id = id;
  e.sessions.push(s);
  write(e);
  return s;
}

export function save(session: BcSession): void {
  const e = read();
  const idx = e.sessions.findIndex((s) => s.id === session.id);
  session.updated_at = unixSeconds();
  if (idx >= 0) e.sessions[idx] = session;
  else e.sessions.push(session);
  write(e);
}

export function remove(id: number): void {
  const e = read();
  e.sessions = e.sessions.filter((s) => s.id !== id);
  write(e);
}

export function worktreeRoot(globalStorage: string, repoRoot: string): string {
  const slug = path.basename(repoRoot).replace(/[^\w-]/g, "_");
  return path.join(globalStorage, "bigchange", slug);
}
