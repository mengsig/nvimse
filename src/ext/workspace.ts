// Temp-workspace copy + selective sync-back — port of the plan/review workspace
// handling in agents.lua. Plan/recap agents run in an isolated copy so they
// cannot touch source; only .nvime/plans/** is synced back.
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execFileSync } from "child_process";

const EXCLUDED = new Set([".git", "node_modules", ".direnv", ".venv", "__pycache__"]);

export interface Workspace {
  root: string;
  cwd: string;
  tmp: string;
}

function copyTree(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (EXCLUDED.has(e.name)) continue;
      copyTree(path.join(src, e.name), path.join(dst, e.name));
    } else if (e.isFile()) {
      try {
        fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
      } catch {
        /* ignore */
      }
    }
  }
}

export function preparePlanWorkspace(root: string): Workspace {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nvimse-plan-"));
  const cwd = path.join(tmp, "workspace");
  copyTree(root, cwd);
  try {
    execFileSync("git", ["-C", cwd, "init", "-q"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  return { root, cwd, tmp };
}

function collect(root: string, base: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) collect(path.join(root, e.name), rel, out);
    else if (e.isFile()) out.push(rel);
  }
}

export function syncPlans(ws: Workspace): string[] {
  const planDir = path.join(ws.cwd, ".nvime", "plans");
  if (!fs.existsSync(planDir)) return [];
  const rels: string[] = [];
  collect(planDir, ".nvime/plans", rels);
  const synced: string[] = [];
  for (const rel of rels.sort()) {
    const source = path.join(ws.cwd, rel);
    const target = path.join(ws.root, rel);
    try {
      const a = fs.readFileSync(source);
      let b: Buffer | null = null;
      try {
        b = fs.readFileSync(target);
      } catch {
        /* new file */
      }
      if (!b || !a.equals(b)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, a);
        synced.push(rel);
      }
    } catch {
      /* ignore */
    }
  }
  return synced;
}

export function cleanup(ws: Workspace): void {
  try {
    fs.rmSync(ws.tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
