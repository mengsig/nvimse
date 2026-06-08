import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { gitRoot } from "./git";

let stateDir = path.join(os.homedir(), ".local", "state", "nvime");

export function setStateDir(dir: string): void {
  stateDir = dir;
}

export function getStateDir(): string {
  return stateDir;
}

/** Resolve the workspace root: git root of the first workspace folder, else folder. */
export function workspaceRoot(): string {
  // resolved lazily to avoid importing vscode here
  const wsFolders = (global as any).__nvimseWorkspaceFolders as string[] | undefined;
  const base = wsFolders && wsFolders.length ? wsFolders[0] : process.cwd();
  return gitRoot(base) || base;
}

/** Path of a file inside the repo .nvime dir, or the state dir if no repo. */
export function nvimePath(rel: string, configured?: string | null): string {
  if (configured) return path.resolve(configured);
  const root = workspaceRoot();
  if (gitRoot(root)) return path.join(root, ".nvime", rel);
  return path.join(stateDir, rel);
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function isoTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Filesystem-safe kebab slug, capped at 40 chars. */
export function slugify(text: string, fallback = "item"): string {
  return (text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonLine(file: string, obj: any): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}

export function writeJson(file: string, obj: any, trailingNewline = true): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj) + (trailingNewline ? "\n" : ""));
}
