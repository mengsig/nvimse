// prepare-commit-msg git hook install/uninstall/status — port of hooks.lua.
// Ships an inline commit-msg script that injects Co-authored-by trailers from
// the attribution ledger.
import * as fs from "fs";
import * as path from "path";
import { workspaceRoot } from "./paths";
import { gitRoot } from "./git";

const MARKER = "# nvime:prepare-commit-msg";

function hookPath(root: string): string {
  return path.join(root, ".git", "hooks", "prepare-commit-msg");
}

function scriptPath(root: string): string {
  return path.join(root, ".git", "hooks", "nvime-commit-msg.js");
}

const COMMIT_SCRIPT = `#!/usr/bin/env node
// nvime commit-msg helper: appends Co-authored-by trailers from the attribution ledger.
const fs = require("fs"), path = require("path");
try {
  const msgFile = process.argv[2];
  const root = require("child_process").execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  const ledger = path.join(root, ".nvime", "attribution.json");
  if (!fs.existsSync(ledger) || !msgFile) process.exit(0);
  const data = JSON.parse(fs.readFileSync(ledger, "utf8"));
  const providers = new Set();
  for (const e of data.entries || []) if (e.provider) providers.add(e.provider);
  if (!providers.size) process.exit(0);
  let msg = fs.readFileSync(msgFile, "utf8");
  for (const p of providers) {
    const trailer = "Co-authored-by: nvime-" + p + " <nvime@local>";
    if (!msg.includes(trailer)) msg += "\\n" + trailer;
  }
  fs.writeFileSync(msgFile, msg);
} catch (e) { /* never block a commit */ }
process.exit(0);
`;

export function install(): { ok: boolean; message: string } {
  const root = gitRoot(workspaceRoot());
  if (!root) return { ok: false, message: "no git root" };
  const hp = hookPath(root);
  const sp = scriptPath(root);
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  fs.writeFileSync(sp, COMMIT_SCRIPT, { mode: 0o755 });

  const existing = fs.existsSync(hp) ? fs.readFileSync(hp, "utf8") : "";
  const line2 = existing.split("\n")[1] || "";
  if (line2 === MARKER || existing.trim() === "") {
    fs.writeFileSync(hp, `#!/usr/bin/env sh\n${MARKER}\nexec node '${sp}' "$@"\n`, { mode: 0o755 });
    return { ok: true, message: "installed prepare-commit-msg hook" };
  }
  // chain a foreign hook
  const prev = hp + ".nvime-prev";
  fs.renameSync(hp, prev);
  fs.chmodSync(prev, 0o755);
  fs.writeFileSync(hp, `#!/usr/bin/env sh\n${MARKER}\nset -e\n'${prev}' "$@"\nexec node '${sp}' "$@"\n`, { mode: 0o755 });
  return { ok: true, message: "installed prepare-commit-msg hook (chained)" };
}

export function uninstall(): { ok: boolean; message: string } {
  const root = gitRoot(workspaceRoot());
  if (!root) return { ok: false, message: "no git root" };
  const hp = hookPath(root);
  if (!fs.existsSync(hp)) return { ok: true, message: "no hook present" };
  const line2 = fs.readFileSync(hp, "utf8").split("\n")[1] || "";
  if (line2 !== MARKER) return { ok: false, message: "hook is not nvime-owned; leaving it alone" };
  fs.unlinkSync(hp);
  const prev = hp + ".nvime-prev";
  if (fs.existsSync(prev)) fs.renameSync(prev, hp);
  return { ok: true, message: "uninstalled prepare-commit-msg hook" };
}

export function status(): { installed: boolean; chained?: boolean; hook_path?: string; reason?: string } {
  const root = gitRoot(workspaceRoot());
  if (!root) return { installed: false, reason: "no git root" };
  const hp = hookPath(root);
  if (!fs.existsSync(hp)) return { installed: false, reason: "no hook present" };
  const line2 = fs.readFileSync(hp, "utf8").split("\n")[1] || "";
  const installed = line2 === MARKER;
  return { installed, chained: installed && fs.existsSync(hp + ".nvime-prev"), hook_path: hp };
}
