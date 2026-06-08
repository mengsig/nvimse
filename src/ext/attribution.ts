import { config, isDisabled } from "./runtime";
import { nvimePath, readJson, writeJson, isoTimestamp, unixSeconds } from "./paths";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX = 500;
const ANCHOR_HEAD = 3;
const ANCHOR_TAIL = 1;

export interface AttrAnchor {
  head: string[];
  tail: string[];
  line_count: number;
}

export interface AttrEntry {
  id: string;
  file: string;
  line1: number;
  line2: number;
  anchor: AttrAnchor;
  rationale?: string;
  user_rationale?: string;
  verdict?: { decision: string; justification?: string };
  provider?: string;
  plan_id?: string;
  step_id?: number | string;
  forced: boolean;
  diff_session_id?: string;
  ts: number;
  iso_ts: string;
  match_line1?: number;
  match_line2?: number;
}

interface Ledger {
  version: number;
  entries: AttrEntry[];
}

function attrPath(): string {
  return nvimePath("attribution.json", config().attribution.path);
}

function readLedger(): Ledger {
  const l = readJson<Ledger>(attrPath(), { version: SCHEMA_VERSION, entries: [] });
  if (!Array.isArray(l.entries)) l.entries = [];
  return l;
}

function writeLedger(l: Ledger): void {
  const max = config().attribution.max || DEFAULT_MAX;
  if (l.entries.length > max) l.entries = l.entries.slice(l.entries.length - max);
  writeJson(attrPath(), l);
}

export function buildAnchor(lines: string[]): AttrAnchor {
  const head = lines.slice(0, ANCHOR_HEAD);
  const tail = lines.length > ANCHOR_HEAD ? lines.slice(lines.length - ANCHOR_TAIL) : [];
  return { head, tail, line_count: lines.length };
}

export function locateAnchor(bufLines: string[], entry: AttrEntry): { line1: number; line2: number } | null {
  const head = entry.anchor.head;
  if (!head || head.length === 0) return null;
  for (let start = 0; start <= bufLines.length - head.length; start++) {
    let ok = true;
    for (let i = 0; i < head.length; i++) {
      if (bufLines[start + i] !== head[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const tail = entry.anchor.tail;
    if (tail && tail.length) {
      const tailStart = start + entry.anchor.line_count - tail.length;
      if (tailStart < 0 || tailStart + tail.length > bufLines.length) continue;
      let tok = true;
      for (let i = 0; i < tail.length; i++) {
        if (bufLines[tailStart + i] !== tail[i]) {
          tok = false;
          break;
        }
      }
      if (!tok) continue;
    }
    return { line1: start + 1, line2: start + Math.max(entry.anchor.line_count, head.length) };
  }
  return null;
}

export function record(entry: Partial<AttrEntry> & { file: string; line1: number; line2: number; lines: string[] }): void {
  if (isDisabled() || config().attribution.enabled === false) return;
  if (!entry.file || !entry.line1 || !entry.line2 || !entry.lines || entry.lines.length === 0) return;
  const stored: AttrEntry = {
    id: `${unixSeconds()}-${Math.floor(Math.random() * 0xffffff)}`,
    file: entry.file,
    line1: entry.line1,
    line2: entry.line2,
    anchor: buildAnchor(entry.lines),
    rationale: entry.rationale,
    user_rationale: entry.user_rationale,
    verdict: entry.verdict,
    provider: entry.provider,
    plan_id: entry.plan_id,
    step_id: entry.step_id,
    forced: entry.forced === true,
    diff_session_id: entry.diff_session_id,
    ts: unixSeconds(),
    iso_ts: isoTimestamp(),
  };
  const l = readLedger();
  l.entries.push(stored);
  writeLedger(l);
}

export function forLine(file: string, lineno: number, bufLines: string[]): AttrEntry[] {
  const l = readLedger();
  const out: AttrEntry[] = [];
  for (const e of l.entries) {
    if (e.file !== file) continue;
    const loc = locateAnchor(bufLines, e);
    if (loc && lineno >= loc.line1 && lineno <= loc.line2) {
      out.push({ ...e, match_line1: loc.line1, match_line2: loc.line2 });
    }
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export function forFile(file: string): AttrEntry[] {
  const l = readLedger();
  return l.entries.filter((e) => e.file === file).sort((a, b) => b.ts - a.ts);
}
