// Agent-response protocol parser + diff engine — a faithful TypeScript port of
// nvime's lua/nvime/diff/{parser,shared,ops}.lua. This is the single most
// performance-critical subsystem: it must parse NVIME_DIFF / NVIME_REPLACEMENT /
// NVIME_NO_CHANGE markers and apply them to a selected range exactly as nvime does.
//
// All line numbers in `Selection`, hunks and blocks are 1-based inclusive
// (matching the agent's view). Buffer slice math is computed against arrays of
// lines (0-based) internally.

export const RESPONSE_MODES = new Set([
  "NVIME_NO_CHANGE",
  "NVIME_REPLACEMENT",
  "NVIME_DIFF",
]);

export type ResponseMode = "NVIME_NO_CHANGE" | "NVIME_REPLACEMENT" | "NVIME_DIFF";

export interface Selection {
  path: string;
  /** Full original lines of the file at session start. */
  lines: string[];
  line1: number; // 1-based inclusive
  line2: number; // 1-based inclusive
  source?: string;
}

export type BlockStatus = "pending" | "accepted" | "rejected" | "conflict";

export interface DiffBlock {
  id: number;
  oldStart: number; // 1-based original line
  oldLines: string[]; // 0 or 1 entry
  newLines: string[]; // 0 or 1 entry
  oldCount: number;
  newCount: number;
  status: BlockStatus;
  hunkIndex: number;
  conflict?: { startLine: number; expected: string[]; actual: string[] };
  wasForced?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[]; // includes the @@ header at [0]
  status: BlockStatus | "mixed";
}

export interface StartSessionResult {
  status: "no_change" | "diff";
  message?: string;
  rationale?: string;
  verify?: string;
  session?: DiffSession;
}

// ----- low-level text helpers -----------------------------------------------

export function normalizeModeBoundaries(text: string | null | undefined): string {
  return (text ?? "").replace(/([`~]{3,})(NVIME_[A-Z_]+)/g, "$1\n$2");
}

export function splitLines(text: string | null | undefined): string[] {
  let t = (text ?? "").replace(/\r\n/g, "\n");
  const lines = t.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

export function codeFenceFor(text: string): string {
  let maxRun = 2;
  const re = /`+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) {
    if (m[0].length > maxRun) maxRun = m[0].length;
  }
  return "`".repeat(maxRun + 1);
}

// ----- response_mode ---------------------------------------------------------

export function responseMode(text: string): { mode: ResponseMode | null; body: string } {
  const normalized = normalizeModeBoundaries(text);
  const lines = splitLines(normalized);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(NVIME_[A-Z_]+)\s*(.*)$/);
    if (m && RESPONSE_MODES.has(m[1])) {
      const body: string[] = [];
      const rest = (m[2] ?? "").trim();
      if (rest !== "") body.push(rest);
      for (let j = i + 1; j < lines.length; j++) body.push(lines[j]);
      return { mode: m[1] as ResponseMode, body: body.join("\n") };
    }
  }
  return { mode: null, body: normalized };
}

// ----- fenced body extraction ------------------------------------------------

function fenceMarker(line: string): string | null {
  const m = (line ?? "").match(/^\s*([`~]+)(.*)$/);
  if (!m) return null;
  const marker = m[1];
  if (marker.length < 3) return null;
  const ch = marker[0];
  if (marker !== ch.repeat(marker.length)) return null;
  const rest = m[2];
  if (rest !== "" && !/^\s*[\w-]*\s*$/.test(rest)) return null;
  return marker;
}

function closingFenceMarker(line: string, opening: string): boolean {
  const m = (line ?? "").match(/^\s*([`~]+)(.*)$/);
  if (!m) return false;
  if (/\S/.test(m[2])) return false;
  const ch = opening[0];
  const marker = m[1];
  return marker === ch.repeat(marker.length) && marker.length >= opening.length;
}

export function fencedBody(text: string): string | null {
  const lines = splitLines(text);
  let openIndex = -1;
  let opening: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/\S/.test(lines[i])) {
      opening = fenceMarker(lines[i]);
      if (!opening) return null;
      openIndex = i;
      break;
    }
  }
  if (openIndex < 0 || !opening) return null;
  for (let i = openIndex + 1; i < lines.length; i++) {
    if (closingFenceMarker(lines[i], opening)) {
      return lines.slice(openIndex + 1, i).join("\n");
    }
  }
  return null;
}

export function stripFence(text: string): string {
  const b = fencedBody(text);
  return b === null ? text : b;
}

export function hasFence(text: string): boolean {
  return fencedBody(text) !== null;
}

// ----- unified diff extraction & parsing ------------------------------------

export function extractUnified(text: string): string[] | null {
  const normalized = normalizeModeBoundaries(text);
  const lines = splitLines(normalized);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^diff --git /.test(lines[i]) || /^@@ /.test(lines[i]) || /^--- /.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  const out: string[] = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && /^\s*NVIME_[A-Z_]+\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

export function hasRangedHunk(lines: string[]): boolean {
  return lines.some((l) => /^@@ -\d+,?\d* \+\d+,?\d* @@/.test(l));
}

function isFileHeader(line: string, oldDone: boolean, newDone: boolean): boolean {
  if (/^diff --git /.test(line)) return true;
  if (/^--- [ab]\//.test(line)) return true;
  if (/^\+\+\+ [ab]\//.test(line)) return true;
  if (/^--- \/dev\/null/.test(line)) return true;
  if (/^\+\+\+ \/dev\/null/.test(line)) return true;
  if (/^\s*NVIME_[A-Z_]+\s*$/.test(line)) return true;
  if (oldDone && newDone && fenceMarker(line)) return true;
  return false;
}

function recount(hunk: Hunk): void {
  let olds = 0;
  let news = 0;
  for (let i = 1; i < hunk.lines.length; i++) {
    const p = hunk.lines[i][0];
    if (p === " " || p === "-") olds++;
    if (p === " " || p === "+") news++;
  }
  if (olds > 0 || news > 0) {
    hunk.oldCount = olds;
    hunk.newCount = news;
  }
}

export function parseHunks(lines: string[]): { header: string[]; hunks: Hunk[] } {
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldSeen = 0;
  let newSeen = 0;

  for (const line of lines) {
    const hm = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (hm) {
      if (current) recount(current);
      current = {
        oldStart: parseInt(hm[1], 10),
        oldCount: hm[2] === "" ? 1 : parseInt(hm[2], 10),
        newStart: parseInt(hm[3], 10),
        newCount: hm[4] === "" ? 1 : parseInt(hm[4], 10),
        lines: [line],
        status: "pending",
      };
      hunks.push(current);
      oldSeen = 0;
      newSeen = 0;
      continue;
    }
    if (!current) {
      header.push(line);
      continue;
    }
    const oldDone = oldSeen >= current.oldCount;
    const newDone = newSeen >= current.newCount;
    if (isFileHeader(line, oldDone, newDone)) {
      recount(current);
      current = null;
      // header lines that are file markers are simply dropped
      continue;
    }
    const p = line.length > 0 ? line[0] : "";
    if (p === " " || p === "-" || p === "+" || p === "\\") {
      current.lines.push(line);
      if (p === " " || p === "-") oldSeen++;
      if (p === " " || p === "+") newSeen++;
    } else {
      // unprefixed content line — treat as context
      current.lines.push(" " + line);
      oldSeen++;
      newSeen++;
    }
  }
  if (current) recount(current);
  return { header, hunks };
}

export function dedupeHunks(hunks: Hunk[]): Hunk[] {
  const seen = new Set<string>();
  const out: Hunk[] = [];
  for (const h of hunks) {
    const key = [h.oldStart, h.oldCount, h.newStart, h.newCount].join(",") + "\0" + h.lines.join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function normalizeFileKey(path: string | null | undefined): string | null {
  if (path === null || path === undefined || path === "") return null;
  let p = String(path).replace(/\\/g, "/");
  p = p.replace(/^"/, "").replace(/"$/, "");
  p = p.replace(/^a\//, "").replace(/^b\//, "").replace(/^\.\//, "");
  return p;
}

export function validateCurrentFile(lines: string[], expected: string): { ok: boolean; reason?: string } {
  const exp = normalizeFileKey(expected);
  for (const line of lines) {
    const git = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (git) {
      if (normalizeFileKey(git[1]) !== exp || normalizeFileKey(git[2]) !== exp) {
        return { ok: false, reason: "agent proposed a diff outside the current file" };
      }
    }
    const old = line.match(/^--- (.+)$/);
    if (old && old[1] !== "/dev/null" && normalizeFileKey(old[1]) !== exp) {
      return { ok: false, reason: "agent proposed a diff outside the current file" };
    }
    const nw = line.match(/^\+\+\+ (.+)$/);
    if (nw && nw[1] !== "/dev/null" && normalizeFileKey(nw[1]) !== exp) {
      return { ok: false, reason: "agent proposed a diff outside the current file" };
    }
  }
  return { ok: true };
}

function hunkOldNewLines(hunk: Hunk): { oldLines: string[]; newLines: string[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (let i = 1; i < hunk.lines.length; i++) {
    const l = hunk.lines[i];
    const p = l[0];
    const rest = l.slice(1);
    if (p === " ") {
      oldLines.push(rest);
      newLines.push(rest);
    } else if (p === "-") {
      oldLines.push(rest);
    } else if (p === "+") {
      newLines.push(rest);
    }
  }
  return { oldLines, newLines };
}

function sequenceAt(lines: string[], start1: number, needle: string[]): boolean {
  if (needle.length === 0) return false;
  const start = start1 - 1;
  if (start < 0 || start + needle.length > lines.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (lines[start + i] !== needle[i]) return false;
  }
  return true;
}

function locateSequence(haystack: string[], needle: string[]): number | null {
  if (needle.length === 0) return 1;
  if (needle.length > haystack.length) return null;
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i + 1; // 1-based
  }
  return null;
}

function reanchorHunks(selection: Selection, hunks: Hunk[]): void {
  const allLines = selection.lines;
  const selected = allLines.slice(selection.line1 - 1, selection.line2);
  for (const hunk of hunks) {
    const { oldLines } = hunkOldNewLines(hunk);
    if (oldLines.length > 0 && !sequenceAt(allLines, hunk.oldStart, oldLines)) {
      const offset = locateSequence(selected, oldLines);
      let startLine: number | null;
      if (offset !== null) {
        startLine = selection.line1 + offset - 1;
      } else {
        startLine = locateSequence(allLines, oldLines);
      }
      if (startLine !== null) {
        hunk.oldStart = startLine;
        hunk.newStart = startLine;
      }
    }
  }
}

// ----- unranged hunk fallback ------------------------------------------------

function unrangedDiffLines(text: string): string[] {
  const lines = splitLines(stripFence(text));
  const out: string[] = [];
  let sawMarker = false;
  for (const line of lines) {
    if (/^@@\s*$/.test(line) || /^@@ .*$/.test(line)) {
      sawMarker = true;
    } else if (/^--- /.test(line) || /^\+\+\+ /.test(line) || /^diff --git /.test(line)) {
      // ignore incomplete file headers
    } else if (line[0] === " " || line[0] === "-" || line[0] === "+") {
      sawMarker = true;
      out.push(line);
    } else if (sawMarker && line.trim() === "") {
      out.push(" ");
    }
  }
  return out;
}

function buildUnrangedHunk(selection: Selection, text: string): { hunk?: string[]; error?: string } {
  const diffBody = unrangedDiffLines(text);
  if (diffBody.length === 0) return { error: "agent returned NVIME_DIFF without a unified diff" };
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let sawChange = false;
  for (const l of diffBody) {
    const p = l[0];
    const rest = l.slice(1);
    if (p === " ") {
      oldLines.push(rest);
      newLines.push(rest);
    } else if (p === "-") {
      oldLines.push(rest);
      sawChange = true;
    } else if (p === "+") {
      newLines.push(rest);
      sawChange = true;
    }
  }
  if (!sawChange) return { error: "agent returned a diff with no changed lines" };
  const selected = selection.lines.slice(selection.line1 - 1, selection.line2);
  const offset = locateSequence(selected, oldLines);
  if (offset === null) {
    return { error: "agent returned an unranged diff that could not be anchored in the selected range" };
  }
  const startLine = selection.line1 + offset - 1;
  const hunk = [
    `--- a/${selection.path}`,
    `+++ b/${selection.path}`,
    `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
    ...diffBody,
  ];
  return { hunk };
}

function sameLines(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function hunksHaveChanges(hunks: Hunk[]): boolean {
  for (const h of hunks) {
    const { oldLines, newLines } = hunkOldNewLines(h);
    if (!sameLines(oldLines, newLines)) return true;
  }
  return false;
}

// ----- replacement (verbatim, minimal-window) -------------------------------

function buildSingleHunk(selection: Selection, replacementText: string): { hunk?: string[]; error?: string } {
  const original = selection.lines.slice(selection.line1 - 1, selection.line2);
  const replacement = splitLines(stripFence(replacementText));
  if (sameLines(original, replacement)) {
    return { error: "agent returned the same code; no change needed" };
  }
  let prefix = 0;
  while (prefix < original.length && prefix < replacement.length && original[prefix] === replacement[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < original.length - prefix &&
    suffix < replacement.length - prefix &&
    original[original.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
  ) {
    suffix++;
  }
  const changedOriginal = original.slice(prefix, original.length - suffix);
  const changedReplacement = replacement.slice(prefix, replacement.length - suffix);
  const startLine = selection.line1 + prefix;
  const hunk = [
    `--- a/${selection.path}`,
    `+++ b/${selection.path}`,
    `@@ -${startLine},${changedOriginal.length} +${startLine},${changedReplacement.length} @@`,
    ...changedOriginal.map((l) => "-" + l),
    ...changedReplacement.map((l) => "+" + l),
  ];
  return { hunk };
}

// ----- block model -----------------------------------------------------------

function parseHunkBlocks(hunk: Hunk, hunkIndex: number, nextId: { v: number }): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  let oldLine = hunk.oldStart;
  let pending: { oldStart: number; oldLines: string[]; newLines: string[] } | null = null;

  const flush = () => {
    if (!pending) return;
    const count = Math.max(pending.oldLines.length, pending.newLines.length);
    for (let index = 0; index < count; index++) {
      const ol = pending.oldLines[index];
      const nl = pending.newLines[index];
      let blockOldStart: number;
      if (ol !== undefined) {
        blockOldStart = pending.oldStart + index;
      } else if (pending.oldLines.length === 0) {
        blockOldStart = pending.oldStart;
      } else {
        blockOldStart = pending.oldStart + pending.oldLines.length;
      }
      blocks.push({
        id: nextId.v++,
        oldStart: blockOldStart,
        oldLines: ol !== undefined ? [ol] : [],
        newLines: nl !== undefined ? [nl] : [],
        oldCount: ol !== undefined ? 1 : 0,
        newCount: nl !== undefined ? 1 : 0,
        status: "pending",
        hunkIndex,
      });
    }
    pending = null;
  };

  const ensure = () => {
    if (!pending) pending = { oldStart: oldLine, oldLines: [], newLines: [] };
  };

  for (let i = 1; i < hunk.lines.length; i++) {
    const l = hunk.lines[i];
    const p = l[0];
    const rest = l.slice(1);
    if (p === " ") {
      flush();
      oldLine++;
    } else if (p === "-") {
      ensure();
      pending!.oldLines.push(rest);
      oldLine++;
    } else if (p === "+") {
      ensure();
      pending!.newLines.push(rest);
    }
  }
  flush();
  return blocks;
}

// ----- diff session ----------------------------------------------------------

export class DiffSession {
  file: string;
  pathKey: string;
  selection: Selection;
  originalLines: string[];
  header: string[];
  hunks: Hunk[];
  blocks: DiffBlock[];
  provider: string;
  prompt: string;
  rationale?: string;
  verifyAttestation?: string;
  appliedHistory: Array<{ blockId: number; startIndex: number; oldLines: string[]; newLines: string[] }> = [];
  warnings: string[] = [];
  responseTruncated = false;
  verdict?: { decision: string; justification?: string };
  planId?: string;
  planStepId?: number | string;
  userRationale?: string;
  id: string;

  constructor(selection: Selection, hunks: Hunk[], header: string[], provider: string, prompt: string) {
    this.file = selection.path;
    this.pathKey = normalizeFileKey(selection.path) ?? selection.path;
    this.selection = selection;
    this.originalLines = [...selection.lines];
    this.header = header;
    this.hunks = hunks;
    this.provider = provider;
    this.prompt = prompt;
    this.id = `${Date.now()}-${Math.floor(Math.random() * 0xffffff)}`;
    const nextId = { v: 1 };
    this.blocks = [];
    hunks.forEach((h, idx) => {
      const blocks = parseHunkBlocks(h, idx, nextId);
      for (const b of blocks) this.blocks.push(b);
    });
  }

  /** Full proposed file: every non-rejected block applied to the original. */
  proposedLines(): string[] {
    return applyBlocksToLines(this.originalLines, this.blocks, (b) => b.status !== "rejected");
  }

  pendingBlocks(): DiffBlock[] {
    return this.blocks
      .filter((b) => b.status === "pending" || b.status === "conflict")
      .sort((a, b) => a.oldStart - b.oldStart || a.id - b.id);
  }

  isResolved(): boolean {
    return !this.blocks.some((b) => b.status === "pending" || b.status === "conflict");
  }

  acceptedCount(): number {
    return this.blocks.filter((b) => b.status === "accepted").length;
  }

  totalBlocks(): number {
    return this.blocks.length;
  }

  diffText(): string {
    const lines: string[] = [`--- a/${this.file}`, `+++ b/${this.file}`];
    for (const h of this.hunks) lines.push(...h.lines);
    return lines.join("\n");
  }
}

export function applyBlocksToLines(
  base: string[],
  blocks: DiffBlock[],
  include: (b: DiffBlock) => boolean
): string[] {
  const result = [...base];
  const selected = blocks.filter(include).sort((a, b) => a.oldStart - b.oldStart || a.id - b.id);
  let offset = 0;
  for (const block of selected) {
    const startIndex = Math.max(0, Math.min(block.oldStart - 1 + offset, result.length));
    const endIndex = Math.max(startIndex, Math.min(startIndex + block.oldCount, result.length));
    result.splice(startIndex, endIndex - startIndex, ...block.newLines);
    offset += block.newLines.length - block.oldCount;
  }
  return result;
}

// ----- rationale / verify ----------------------------------------------------

export function extractRationale(response: string): string | null {
  const lines = splitLines(response);
  const fragments: string[] = [];
  let started = false;
  for (const line of lines) {
    if (/^\s*NVIME_[A-Z_]+\s*$/.test(line) || /^\s*```/.test(line)) break;
    if (!started) {
      const m = line.match(/^\s*RATIONALE:\s*(.*)$/);
      if (m) {
        started = true;
        const rest = (m[1] ?? "").trim();
        if (rest !== "") fragments.push(rest);
      }
      continue;
    }
    if (/^\s*$/.test(line)) {
      if (fragments.length > 0) break;
      continue;
    }
    if (/^ {2}/.test(line)) {
      fragments.push(line.trim());
    } else {
      break;
    }
  }
  return fragments.length > 0 ? fragments.join(" ") : null;
}

export function extractVerifyLine(response: string): string | null {
  const lines = splitLines(response);
  for (const line of lines) {
    if (/^\s*NVIME_[A-Z_]+\s*$/.test(line) || /^\s*```/.test(line)) break;
    const m = line.match(/^\s*VERIFY:\s*(.*)$/);
    if (m) {
      const body = (m[1] ?? "").trim();
      if (body !== "") return body;
    }
  }
  return null;
}

// ----- truncation / bracket warnings ----------------------------------------

function responseLikelyTruncated(response: string): boolean {
  const idx = response.search(/NVIME_[A-Z_]+/);
  if (idx < 0) return false;
  const tail = response.slice(idx);
  const fenceCount = (tail.match(/```/g) || []).length;
  return fenceCount % 2 === 1;
}

// ----- start_session ---------------------------------------------------------

export function startSession(
  selection: Selection,
  response: string,
  provider: string,
  prompt: string
): StartSessionResult {
  const rationale = extractRationale(response) ?? undefined;
  const verify = extractVerifyLine(response) ?? undefined;
  const { mode, body } = responseMode(response);

  if (mode === "NVIME_NO_CHANGE") {
    return {
      status: "no_change",
      message: body.trim() || "agent reported no change needed",
      rationale,
      verify,
    };
  }

  let diffLines: string[] | null = null;

  if (mode === "NVIME_REPLACEMENT") {
    const r = buildSingleHunk(selection, body);
    if (r.error) return { status: "no_change", message: r.error, rationale, verify };
    diffLines = r.hunk!;
  } else {
    // NVIME_DIFF or no marker
    diffLines = extractUnified(body);
    if (mode === "NVIME_DIFF" && (diffLines === null || !hasRangedHunk(diffLines))) {
      const r = buildUnrangedHunk(selection, body);
      if (r.error) return { status: "no_change", message: r.error, rationale, verify };
      diffLines = r.hunk!;
    } else if (diffLines === null) {
      if (mode === "NVIME_DIFF") {
        return { status: "no_change", message: "agent returned NVIME_DIFF without a unified diff", rationale, verify };
      }
      if (mode === null && !hasFence(body)) {
        return { status: "no_change", message: "agent answered without returning a patch", rationale, verify };
      }
      // no marker but fenced → whole replacement
      const r = buildSingleHunk(selection, body);
      if (r.error) return { status: "no_change", message: r.error, rationale, verify };
      diffLines = r.hunk!;
    }
  }

  const validation = validateCurrentFile(diffLines, selection.path);
  if (!validation.ok) {
    throw new Error(validation.reason || "cross-file patch rejected");
  }

  const parsed = parseHunks(diffLines);
  let hunks = dedupeHunks(parsed.hunks);
  reanchorHunks(selection, hunks);
  if (hunks.length === 0 || !hunksHaveChanges(hunks)) {
    return { status: "no_change", message: "agent returned a diff with no changed lines", rationale, verify };
  }

  const session = new DiffSession(selection, hunks, parsed.header, provider, prompt);
  session.rationale = rationale;
  session.verifyAttestation = verify;
  if (responseLikelyTruncated(response)) {
    session.responseTruncated = true;
    session.warnings.push("response may be truncated (unclosed code fence)");
  }
  return { status: "diff", session };
}

// ----- accept / reject operations against a live buffer ----------------------
//
// These compute the new full-file content after an operation. The UI applies the
// returned lines to the live document. Conflict detection compares the live
// buffer slice with the block's recorded oldLines.

export function blockStartLine(session: DiffSession, block: DiffBlock): number {
  // Live anchor: original line plus the cumulative delta of every accepted block
  // positioned above this one.
  let offset = 0;
  for (const b of session.blocks) {
    if (b.status === "accepted" && b.oldStart < block.oldStart) {
      offset += b.newLines.length - b.oldCount;
    }
  }
  return block.oldStart + offset;
}

export interface ApplyResult {
  newLines: string[];
  conflict?: { blockId: number; startLine: number; expected: string[]; actual: string[] };
  delta: number;
  applied: boolean;
}

export function acceptBlock(
  session: DiffSession,
  liveLines: string[],
  block: DiffBlock,
  force: boolean
): ApplyResult {
  if (block.status !== "pending" && !(force && block.status === "conflict")) {
    return { newLines: liveLines, delta: 0, applied: false };
  }
  const startLine = blockStartLine(session, block);
  const startIndex = Math.max(0, Math.min(startLine - 1, liveLines.length));
  const endIndex = Math.max(startIndex, Math.min(startIndex + block.oldCount, liveLines.length));
  const replacement = block.newLines;

  // idempotent: replacement already present at the anchor
  if (replacement.length > 0 && linesMatchAt(liveLines, startIndex, replacement)) {
    block.status = "accepted";
    block.conflict = undefined;
    return { newLines: liveLines, delta: 0, applied: true };
  }
  // idempotent deletion: the old lines are already gone (the original following
  // context, or EOF, sits at the anchor) — mark accepted without re-deleting.
  if (
    block.newLines.length === 0 &&
    block.oldCount > 0 &&
    !linesMatchAt(liveLines, startIndex, block.oldLines) &&
    deletionAlreadyApplied(session, block, liveLines, startIndex)
  ) {
    block.status = "accepted";
    block.conflict = undefined;
    return { newLines: liveLines, delta: 0, applied: true };
  }

  if (!force) {
    const actual = liveLines.slice(startIndex, endIndex);
    if (!sameLines(actual, block.oldLines)) {
      block.status = "conflict";
      block.conflict = { startLine: startIndex + 1, expected: [...block.oldLines], actual: [...actual] };
      return {
        newLines: liveLines,
        conflict: { blockId: block.id, startLine: startIndex + 1, expected: [...block.oldLines], actual: [...actual] },
        delta: 0,
        applied: false,
      };
    }
  }

  const oldSnapshot = liveLines.slice(startIndex, endIndex);
  const newLines = [...liveLines];
  newLines.splice(startIndex, endIndex - startIndex, ...replacement);
  block.status = "accepted";
  block.wasForced = force;
  block.conflict = undefined;
  session.appliedHistory.push({
    blockId: block.id,
    startIndex,
    oldLines: [...oldSnapshot],
    newLines: [...replacement],
  });
  return { newLines, delta: replacement.length - block.oldCount, applied: true };
}

// A deletion block is already applied if the original content that followed the
// deleted lines (or EOF) now sits at the anchor — port of nvime's
// deletion_context_matches.
function deletionAlreadyApplied(session: DiffSession, block: DiffBlock, liveLines: string[], startIndex: number): boolean {
  const afterIdx = block.oldStart - 1 + block.oldCount;
  const following = session.originalLines.slice(afterIdx, afterIdx + 3);
  if (following.length === 0) return startIndex >= liveLines.length;
  return linesMatchAt(liveLines, startIndex, following);
}

function linesMatchAt(lines: string[], startIndex: number, expected: string[]): boolean {
  if (expected.length === 0) return true;
  if (startIndex < 0 || startIndex + expected.length > lines.length) return false;
  for (let i = 0; i < expected.length; i++) {
    if (lines[startIndex + i] !== expected[i]) return false;
  }
  return true;
}

export function rejectBlock(block: DiffBlock): void {
  if (block.status === "pending" || block.status === "conflict") {
    block.status = "rejected";
    block.conflict = undefined;
  }
}

/**
 * Undo the most recently accepted block if its accepted text is still present
 * verbatim in the live buffer (port of nvime's `gu`). Returns the restored full
 * file lines, or null if the accepted text has since changed (refuse to clobber).
 */
export function undoLastAccept(session: DiffSession, liveLines: string[]): { newLines: string[]; block: DiffBlock } | null {
  const entry = session.appliedHistory[session.appliedHistory.length - 1];
  if (!entry) return null;
  const block = session.blocks.find((b) => b.id === entry.blockId);
  if (!block || block.status !== "accepted") {
    session.appliedHistory.pop();
    return undoLastAccept(session, liveLines);
  }
  const startIndex = Math.max(0, Math.min(entry.startIndex, liveLines.length));
  const endIndex = Math.max(startIndex, Math.min(startIndex + entry.newLines.length, liveLines.length));
  const actual = liveLines.slice(startIndex, endIndex);
  if (!sameLines(actual, entry.newLines)) return null; // accepted text changed — refuse
  const newLines = [...liveLines];
  newLines.splice(startIndex, endIndex - startIndex, ...entry.oldLines);
  block.status = "pending";
  block.conflict = undefined;
  block.wasForced = false;
  session.appliedHistory.pop();
  return { newLines, block };
}
