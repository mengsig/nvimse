import { execFileSync } from "child_process";
import * as path from "path";

const rootCache = new Map<string, string | false>();

export function gitRoot(cwd: string): string | null {
  if (rootCache.has(cwd)) {
    const v = rootCache.get(cwd)!;
    return v === false ? null : v;
  }
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    rootCache.set(cwd, out);
    return out;
  } catch {
    rootCache.set(cwd, false);
    return null;
  }
}

export function repoRoot(cwd: string): string {
  return gitRoot(cwd) || cwd;
}

export function clearRootCache(): void {
  rootCache.clear();
}

export function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
  } catch {
    return "";
  }
}

export function gitLines(args: string[], cwd: string): string[] {
  const out = git(args, cwd);
  return out ? out.split("\n").filter((l) => l !== "") : [];
}

export function shortRef(cwd: string): string {
  return git(["rev-parse", "--short", "HEAD"], cwd).trim();
}

export function branch(cwd: string): string {
  return git(["branch", "--show-current"], cwd).trim();
}

export function repoRelative(absPath: string): string {
  const root = gitRoot(path.dirname(absPath));
  if (!root) return absPath;
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join("/");
}
