// Reverse "explain my changes" — port of recap.lua. Spawns the plan-lane agent
// over a git diff, writes a plan.md narrative under .nvime/plans/recap-<hash>/.
import * as fs from "fs";
import * as path from "path";
import { runAgent } from "./agentRunner";
import { config } from "./runtime";
import { workspaceRoot } from "./paths";
import { git, repoRoot } from "./git";
import { audit } from "./audit";
import { currentProvider } from "./services";
import { preparePlanWorkspace, syncPlans, cleanup } from "./workspace";

function shortHash(body: string): string {
  let h = 5381;
  for (let i = 0; i < body.length; i++) h = ((h * 33 + body.charCodeAt(i)) >>> 0) % 0xffffffff;
  return ("00000000" + h.toString(16)).slice(-8);
}

function recapPrompt(rid: string, label: string, diff: string): string {
  return `NVIME RECAP MODE.

You are summarizing an EXISTING code change, not authoring a new plan.
You MUST NOT modify any source code.
You MAY ONLY write to \`.nvime/plans/${rid}/plan.md\` and
\`.nvime/plans/${rid}/plan.json\`. nvime's sync filter drops
anything else you write outside \`.nvime/plans/\`.

Tools available:
  - Read, Grep, LS, Glob — to study the surrounding code.
  - Bash — to inspect git history (git log, git blame), to confirm
    line numbers, to run cheap checks.
  - Web — only if explicitly relevant.
  - Write/Edit/MultiEdit — ONLY under \`.nvime/plans/${rid}/\`.

Workflow:
  1. Read the unified diff at the bottom of this prompt CAREFULLY.
  2. For each logically distinct hunk, work out:
     - WHAT changed (concretely; cite the file and line range)
     - WHY it likely changed (read surrounding code if needed)
     - What invariants the change preserves or breaks
     - What is NOT covered by tests in the current diff
  3. Group multiple hunks that serve one intent under a single
     'change unit' in the narrative.
  4. Write \`.nvime/plans/${rid}/plan.md\` — a Markdown
     narrative a future engineer can read cold. Required sections:
       # Recap · ${label}
       ## Summary (one paragraph)
       ## Files touched (list with one-line rationale each)
       ## Change units (numbered: WHAT, WHY, RISKS)
       ## Untested behavior (concrete test cases worth adding)
       ## Suggested follow-up plan (1-3 next steps if relevant)
  5. Write \`.nvime/plans/${rid}/plan.json\`. Schema:
     {
       "version": 1,
       "id": "${rid}",
       "title": "Recap · ${label}",
       "why": "<one paragraph mirroring plan.md Summary>",
       "created_at": <unix ts>,
       "files_estimated": [<files touched in this diff>],
       "acceptance": [],
       "steps": [],
       "recap": true
     }
  6. Emit ONE final marker as your last line of output (no other prose
     after it):

NVIME_PLAN
\`\`\`json
{ "id": "${rid}", "summary": "...", "step_count": 0, "files_estimated": [...] }
\`\`\`

Quality bar:
  - Cite real files and line ranges.
  - Do not invent intent: when 'why' is uncertain, say so explicitly.
  - Be honest about what is untested. The user reads this BEFORE
    committing — anything you mark covered they will trust.

Diff label: ${label}

Unified diff:
\`\`\`diff
${diff}
\`\`\``;
}

export async function recap(args: string[]): Promise<void> {
  const root = repoRoot(workspaceRoot());
  let provider = currentProvider();
  let cached = false;
  let range: string | null = null;
  for (const a of args) {
    if (a === "claude" || a === "codex") provider = a;
    else if (a === "--cached" || a === "--staged") cached = true;
    else if (a.includes("..")) range = a;
  }
  const diffArgs = ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--find-copies", "--unified=10"];
  if (cached) diffArgs.push("--cached");
  if (range) diffArgs.push(range);
  const diff = git(diffArgs, root);
  if (!diff.trim()) {
    throw new Error("nvimse recap: no diff to summarize");
  }
  const rid = "recap-" + shortHash(diff);
  const label = range || (cached ? "staged changes" : "working tree");
  audit({ event: "recap_start", id: rid, label, provider });
  const ws = preparePlanWorkspace(root);
  try {
    const result = await runAgent({ provider, lane: "plan", prompt: recapPrompt(rid, label, diff), cwd: ws.cwd });
    syncPlans(ws);
    audit({ event: "recap_exit", id: rid, code: result.code });
  } finally {
    cleanup(ws);
  }
  const planMd = path.join(root, ".nvime", "plans", rid, "plan.md");
  return autoOpen(planMd);
}

async function autoOpen(planMd: string): Promise<void> {
  if (config().recap.autoOpen === false) return;
  const vscode = require("vscode") as typeof import("vscode");
  if (fs.existsSync(planMd)) {
    const doc = await vscode.workspace.openTextDocument(planMd);
    await vscode.window.showTextDocument(doc);
  } else {
    vscode.window.showInformationMessage("nvimse recap: agent did not write a plan.md");
  }
}
