import { config } from "./runtime";
import { nvimePath, readJson } from "./paths";
import { audit } from "./audit";
import { pathMatchesAny } from "./glob";

const SCHEMA_VERSION = 1;

export interface PolicyRule {
  match: string;
  require_human?: boolean;
  reason?: string;
  allow_lanes?: string[];
  max_changed_lines?: number;
  require_rationale_typed_by_user?: boolean;
}

const DEFAULT_RULES: PolicyRule[] = [
  { match: "migrations/**", require_human: true, reason: "default: migrations require human edits" },
  { match: "**/migrations/**", require_human: true, reason: "default: migrations require human edits" },
  { match: "*.lock", require_human: true, reason: "default: lockfiles require human edits" },
  { match: "**/*.lock", require_human: true, reason: "default: lockfiles require human edits" },
  { match: "package-lock.json", require_human: true, reason: "default: lockfile" },
  { match: "yarn.lock", require_human: true, reason: "default: lockfile" },
  { match: "pnpm-lock.yaml", require_human: true, reason: "default: lockfile" },
  { match: "Cargo.lock", require_human: true, reason: "default: lockfile" },
  { match: "secrets/**", require_human: true, reason: "default: secrets are human-only", allow_lanes: [] },
  { match: "**/secrets/**", require_human: true, reason: "default: secrets are human-only", allow_lanes: [] },
  { match: "**/.env", require_human: true, reason: "default: env file is human-only", allow_lanes: [] },
  { match: "**/.env.*", require_human: true, reason: "default: env file is human-only", allow_lanes: [] },
  { match: "**/*.pem", require_human: true, reason: "default: private key", allow_lanes: [] },
  { match: "**/*.key", require_human: true, reason: "default: private key", allow_lanes: [] },
];

export function policyPath(): string {
  return nvimePath("policy.json", config().policyRules.path);
}

function rules(): PolicyRule[] {
  const data = readJson<{ version: number; rules: PolicyRule[] }>(policyPath(), { version: SCHEMA_VERSION, rules: DEFAULT_RULES });
  if (!Array.isArray(data.rules) || data.rules.length === 0) return DEFAULT_RULES;
  return data.rules;
}

export interface PolicyResult {
  allowed: boolean;
  reason: string;
  rule?: PolicyRule;
  require_human?: boolean;
  require_rationale_typed_by_user?: boolean;
  max_changed_lines?: number;
  allow_lanes?: string[];
}

export function evaluate(file: string | null, lane: string, ctx?: { changed_lines?: number }): PolicyResult {
  if (config().policyRules.enabled === false) return { allowed: true, reason: "policy disabled" };
  if (!file) return { allowed: true, reason: "no path" };
  const all = rules();
  let best: PolicyRule | null = null;
  let bestIndex = -1;
  all.forEach((r, idx) => {
    if (pathMatchesAny(file, [r.match])) {
      if (!best || r.match.length > best.match.length || (r.match.length === best.match.length && idx > bestIndex)) {
        best = r;
        bestIndex = idx;
      }
    }
  });
  if (!best) return { allowed: true, reason: "no matching rule" };
  const rule = best as PolicyRule;
  if (rule.require_human) return { allowed: false, reason: rule.reason || "rule requires human edits", rule };
  if (Array.isArray(rule.allow_lanes) && !rule.allow_lanes.includes(lane)) {
    return { allowed: false, reason: `lane ${lane} not in allow_lanes for ${rule.match}`, rule };
  }
  if (rule.max_changed_lines != null && ctx?.changed_lines != null && ctx.changed_lines > rule.max_changed_lines) {
    return { allowed: false, reason: `diff changes ${ctx.changed_lines} lines, exceeds rule limit ${rule.max_changed_lines}`, rule };
  }
  return {
    allowed: true,
    reason: "ok",
    rule,
    require_rationale_typed_by_user: rule.require_rationale_typed_by_user,
    max_changed_lines: rule.max_changed_lines,
    allow_lanes: rule.allow_lanes,
  };
}

export function guard(file: string | null, lane: string, ctx?: { changed_lines?: number }): { allowed: boolean; result: PolicyResult } {
  const result = evaluate(file, lane, ctx);
  if (!result.allowed) {
    audit({ event: "policy_block", file, lane, reason: result.reason, rule: result.rule?.match });
  }
  return { allowed: result.allowed, result };
}

export function listRules(): PolicyRule[] {
  return rules();
}

export function defaultRulesJson(): string {
  return JSON.stringify({ version: SCHEMA_VERSION, rules: DEFAULT_RULES }, null, 2);
}
