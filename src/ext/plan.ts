// Plan lane — port of plan.lua. Author drafts a structured plan under
// .nvime/plans/<id>/; the executor opens each step's file/range and runs the
// edit lane with a plan-context prefix; session continuity resumes the provider
// across steps. Verbatim author prompt preserved.
import * as fs from "fs";
import * as path from "path";
import { runAgent } from "./agentRunner";
import { config } from "./runtime";
import { workspaceRoot, unixSeconds, readJson, writeJson } from "./paths";
import { repoRoot } from "./git";
import { audit } from "./audit";
import { currentProvider } from "./services";
import { preparePlanWorkspace, syncPlans, cleanup } from "./workspace";

export type StepStatus = "pending" | "in_progress" | "done" | "blocked" | "abandoned";

export interface PlanStep {
  id: number;
  intent: string;
  file: string;
  range: { line1: number; line2: number } | "new";
  range_anchor?: string;
  depends_on: number[];
  tests: string[];
  status: StepStatus;
  notes?: string;
}

export interface Plan {
  version: number;
  id: string;
  title: string;
  why: string;
  created_at: number;
  updated_at?: number;
  files_estimated: string[];
  acceptance: { id: number; text: string; status: string }[];
  steps: PlanStep[];
  provider_sessions?: Record<string, string>;
  author_provider_sessions?: Record<string, string>;
  recap?: boolean;
}

export function plansDir(): string {
  if (config().plan.dir) return config().plan.dir!;
  const root = repoRoot(workspaceRoot());
  return path.join(root, ".nvime", "plans");
}

export function listPlans(): Plan[] {
  const dir = plansDir();
  if (!fs.existsSync(dir)) return [];
  const out: Plan[] = [];
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, "plan.json");
    if (!fs.existsSync(file)) continue;
    const raw = readJson<any>(file, null);
    if (raw) out.push(migrate(raw));
  }
  return out.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0));
}

export function getPlan(id: string): Plan | null {
  const raw = readJson<any>(path.join(plansDir(), id, "plan.json"), null);
  return raw ? migrate(raw) : null;
}

export function savePlan(plan: Plan): void {
  plan.updated_at = unixSeconds();
  writeJson(path.join(plansDir(), plan.id, "plan.json"), plan);
}

export function deletePlan(id: string): void {
  const dir = path.join(plansDir(), id);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    audit({ event: "plan_deleted", plan_id: id });
  } catch {
    /* ignore */
  }
}

function migrate(p: any): Plan {
  p.steps = Array.isArray(p.steps) ? p.steps : [];
  p.acceptance = Array.isArray(p.acceptance) ? p.acceptance : [];
  p.files_estimated = Array.isArray(p.files_estimated) ? p.files_estimated : [];
  p.steps.forEach((s: any, i: number) => {
    s.id = s.id ?? i + 1;
    s.depends_on = Array.isArray(s.depends_on) ? s.depends_on : [];
    s.tests = Array.isArray(s.tests) ? s.tests : [];
    if (!["pending", "in_progress", "done", "blocked", "abandoned"].includes(s.status)) s.status = "pending";
  });
  return p as Plan;
}

export function overallStatus(plan: Plan): string {
  if (plan.steps.length === 0) return "draft";
  const done = plan.steps.filter((s) => s.status === "done" || s.status === "abandoned").length;
  if (done === plan.steps.length) return "done";
  if (plan.steps.some((s) => s.status === "blocked")) return "blocked";
  if (plan.steps.some((s) => s.status === "in_progress")) return "in_progress";
  return "pending";
}

const AUTHOR_PROMPT_HEADER = `NVIME PLAN AUTHOR MODE.

You are an architect drafting a structured implementation plan for a code change in this repository.
Do not narrate tool use, investigation progress, or status updates. Your final stdout must start with NVIME_PLAN.

You MUST NOT modify any source code under the repository root EXCEPT under \`.nvime/plans/<plan-id>/\`.
nvime synchronizes ONLY files under \`.nvime/plans/\` back to the user's repository when you exit; anything else you write is silently dropped.

Tools available:
  - Read, Grep, LS, Glob — to study the codebase.
  - Bash — to run tests, lints, ./scripts/test, git log. Use it to ground claims in real evidence.
  - Web fetch/search — for external context if relevant.
  - Write, Edit, MultiEdit — ONLY for paths under \`.nvime/plans/<plan-id>/\`.

Workflow:
  1. Read the user's intent.
  2. Investigate the repo. Be specific: identify actual files, line numbers, dependencies.
  3. Decompose into ORDERED steps. Each step:
     - Targets exactly ONE file and ONE range (existing range, or "new" for a new file).
     - Is small enough to apply through a focused diff review (~5-100 lines).
     - Has CHECKABLE acceptance criteria — prefer shell commands and observable behavior.
     - Match the NUMBER of steps to the ACTUAL scope. Most requests are small: a localized, single-file change is ONE step. Only add steps when the work genuinely spans multiple files, ranges, or independently-reviewable units. NEVER pad a small change with artificial steps or split one coherent edit just to raise the step count.
  4. Write \`.nvime/plans/<plan-id>/plan.json\` with the schema below.
  5. Write \`.nvime/plans/<plan-id>/plan.md\` — a human-readable narrative a future engineer can read cold.
  6. Emit ONE machine-readable marker as the FINAL output (no other prose):

NVIME_PLAN
\`\`\`json
{ "id": "<plan-id>", "summary": "<one-sentence what+why>", "step_count": <N>, "files_estimated": ["..."] }
\`\`\`

Plan id format: \`NNNN-<kebab-slug>\`. Pick the next free 4-digit number by listing \`.nvime/plans/\`.

plan.json schema (version 1):
{
  "version": 1,
  "id": "NNNN-slug",
  "title": "...",
  "why": "...",
  "created_at": <unix timestamp>,
  "files_estimated": ["path1", "path2"],
  "acceptance": [ { "id": 1, "text": "...", "status": "pending" } ],
  "steps": [
    {
      "id": 1,
      "intent": "Concrete instruction to a future patch worker. Include WHAT, not WHY.",
      "file": "path/relative/to/repo",
      "range": { "line1": 12, "line2": 45 },   // or "new"
      "range_anchor": "first verbatim line of original content at line 12",
      "depends_on": [],
      "tests": ["<project-native test runner>"],
      "status": "pending",
      "notes": "optional context"
    }
  ]
}

Quality bar:
  - Read enough of the actual code to ground every line/range you cite.
  - If the work has uncertainty, encode the choice in \`notes\`. Don't punt.
  - Right-size the plan to the work. A trivial change is 1 step; a small feature 2-4; only genuinely large, multi-file work needs more.
  - For runtime behavior changes, ensure a regression test exists — but for a small change put it in the implementation step's \`tests\` field rather than spawning a separate test step.

Range anchors (resilience to file drift):
  When earlier steps modify the same file as a later step, line numbers shift.
  For every step whose \`range\` is a line block (NOT "new"), include an additional
  \`range_anchor\` field: the FIRST 1-3 lines of the original content at that range,
  copied verbatim including leading whitespace. nvime searches the file for this
  anchor at execute time and re-anchors the range to wherever the content has
  drifted to. Pick an anchor that is UNIQUE in the file.
`;


export async function createPlan(intent: string, provider?: string): Promise<Plan | null> {
  const root = repoRoot(workspaceRoot());
  const prov = provider || currentProvider();
  const prompt = AUTHOR_PROMPT_HEADER + "\n\nUser intent:\n" + intent;
  audit({ event: "plan_author_start", provider: prov });
  const ws = preparePlanWorkspace(root);
  let plan: Plan | null = null;
  try {
    const result = await runAgent({ provider: prov, lane: "plan", prompt, cwd: ws.cwd, persistSession: false });
    const synced = syncPlans(ws);
    audit({ event: "plan_author_exit", provider: prov, code: result.code, synced });
    // determine plan id from marker or synced path
    const marker = result.text.match(/NVIME_PLAN[\s\S]*?\{[\s\S]*?"id"\s*:\s*"([^"]+)"/);
    let id = marker ? marker[1] : null;
    if (!id) {
      const m = synced.find((s) => /^\.nvime\/plans\/[^/]+\/plan\.json$/.test(s));
      if (m) id = m.split("/")[2];
    }
    if (id) plan = getPlan(id);
  } finally {
    cleanup(ws);
  }
  return plan;
}

export function planContextBlock(plan: Plan, step: PlanStep): string {
  const lines: string[] = [
    "Plan context (informational; the actual change is bounded by the selected range):",
    `- Plan: ${plan.id} — ${plan.title}`,
    `- step ${step.id}/${plan.steps.length} (full instruction):`,
    `    ${step.intent}`,
  ];
  if (plan.why) lines.push("- Why:", "    " + plan.why);
  if (step.notes) lines.push("- Step notes:", "    " + step.notes);
  if (step.depends_on.length) {
    lines.push("- Dependency-step intents (the contract this step must agree with):");
    for (const dep of step.depends_on) {
      const d = plan.steps.find((s) => s.id === dep);
      if (d) lines.push(`    [step ${d.id}] ${d.intent}`);
    }
  }
  if (plan.acceptance.length) {
    lines.push("- Plan-level acceptance:");
    for (const a of plan.acceptance) lines.push(`    - ${a.text}`);
  }
  return lines.join("\n");
}

export function setStepStatus(planId: string, stepId: number, status: StepStatus): void {
  const plan = getPlan(planId);
  if (!plan) return;
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) return;
  step.status = status;
  savePlan(plan);
  audit({ event: "plan_step_status", plan_id: planId, step_id: stepId, status });
}

export function resetSession(planId: string, provider?: string): void {
  const plan = getPlan(planId);
  if (!plan) return;
  if (provider) {
    if (plan.provider_sessions) delete plan.provider_sessions[provider];
  } else {
    plan.provider_sessions = {};
  }
  savePlan(plan);
  audit({ event: "plan_session_reset", plan_id: planId, provider });
}
