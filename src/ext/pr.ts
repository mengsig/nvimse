// PR reviewer sidecar (.nvime/pr.md) — port of pr.lua.
import * as fs from "fs";
import { config } from "./runtime";
import { nvimePath } from "./paths";
import { workspaceRoot } from "./paths";
import { git, gitLines, repoRoot } from "./git";
import { forFile } from "./attribution";
import { readEvents } from "./audit";
import { audit } from "./audit";

const RISKY = new Set(["verify_force", "verify_block", "risk_force", "block_force_applied", "policy_block", "intent_override"]);

function resolveBase(root: string): string {
  const cfg = config().pr.baseBranch;
  if (cfg) return cfg;
  for (const ref of ["origin/main", "main", "origin/master", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", ref], root).trim()) return ref;
  }
  return "HEAD~1";
}

export function render(opts: { dryRun?: boolean; base?: string } = {}): { body: string; path: string } {
  const root = repoRoot(workspaceRoot());
  const base = opts.base || resolveBase(root);
  const head = "HEAD";

  const changedFiles = gitLines(["diff", "--name-only", `${base}...${head}`], root);
  const commits = gitLines(["log", "--reverse", "--format=%H%x00%ct%x00%s", `${base}..${head}`], root)
    .map((l) => {
      const [sha, ts, subject] = l.split("\0");
      return { sha, ts: parseInt(ts, 10), subject };
    });

  const attributed: { file: string; entries: ReturnType<typeof forFile> }[] = [];
  for (const f of changedFiles) {
    const e = forFile(f);
    if (e.length) attributed.push({ file: f, entries: e });
  }

  const oldestTs = commits.length ? commits[0].ts : 0;
  const risky = readEvents().filter((e) => RISKY.has(e.event || "") && (!oldestTs || true));

  const lines: string[] = [
    "# nvime PR sidecar",
    "",
    `Base: \`${base}\` · Head: \`${head}\` · ${commits.length} commits · ${changedFiles.length} files changed`,
    "",
  ];

  if (risky.length) {
    lines.push("## Review-first events", "", "These bypassed a nvime gate or recorded a forced action — read these first.", "");
    for (const e of risky.slice(-50)) lines.push(`- \`${e.event}\` — ${formatRisky(e)}`);
    lines.push("");
  }

  lines.push("## AI-attributed changes", "");
  if (attributed.length === 0) {
    lines.push("_No attribution entries overlap this branch's changed files._", "");
  } else {
    for (const { file, entries } of attributed) {
      lines.push(`### \`${file}\``);
      for (const e of entries) {
        const id = e.plan_id ? `plan ${e.plan_id} · step ${e.step_id}` : "edit";
        let head2 = `- ${id} · \`${e.provider || "?"}\``;
        if (e.forced) head2 += " · **FORCED**";
        lines.push(head2);
        if (e.rationale) lines.push(`  - rationale: ${e.rationale}`);
        if (e.verdict) lines.push(`  - critic ${e.verdict.decision}: ${e.verdict.justification || ""}`);
        lines.push(`  - ${e.iso_ts}`);
      }
      lines.push("");
    }
  }

  if (config().pr.includeUnattributed !== false) {
    const unattr = changedFiles.filter((f) => !attributed.some((a) => a.file === f));
    if (unattr.length) {
      lines.push(
        "## Changed files without nvime attribution",
        "",
        "Reviewer note: these files were modified on this branch but have no",
        "nvime attribution. They are either human-written or were edited outside",
        "the nvime lanes.",
        ""
      );
      for (const f of unattr) lines.push(`- \`${f}\``);
    }
  }

  const body = lines.join("\n");
  const outPath = nvimePath("pr.md", config().pr.path);
  if (!opts.dryRun) {
    require("fs").mkdirSync(require("path").dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, body);
  }
  audit({ event: "pr_sidecar", path: outPath, base, head, files: changedFiles.length, commits: commits.length, attributed: attributed.length, risky_events: risky.length });
  return { body, path: outPath };
}

function formatRisky(e: any): string {
  switch (e.event) {
    case "verify_force":
    case "verify_block":
      return `${e.file || "?"} · ${e.reason || ""}`;
    case "risk_force":
      return `${e.file} · ${e.level} · +${e.lines_added} −${e.lines_removed} ai ${Math.round((e.ai_share || 0) * 100)}%`;
    case "block_force_applied":
      return `${e.file}:${e.start || "?"}`;
    case "policy_block":
      return `${e.file} · lane ${e.lane} · ${e.reason}`;
    case "intent_override":
      return `lane ${e.lane} · ${e.reason}`;
    default:
      return JSON.stringify(e).slice(0, 120);
  }
}
