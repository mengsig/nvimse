import { config } from "./runtime";
import { pathMatchesAny } from "./glob";
import { forFile } from "./attribution";
import { audit } from "./audit";
import { DiffSession } from "../core/protocol";

const DEFAULT_SENSITIVE = [
  "migrations/**", "**/migrations/**", "*.lock", "**/*.lock", "package-lock.json",
  "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "secrets/**", "**/secrets/**",
  "**/.env", "**/.env.*", "**/*.pem", "**/*.key",
];
const DEFAULT_GENERATED = ["**/*.pb.go", "**/*_pb2.py", "**/*_generated.*", "**/generated/**"];
const THRESHOLDS = { lines: { medium: 40, high: 120 }, ai_share: { high: 0.5 } };

export type RiskLevel = "low" | "medium" | "high";

export interface RiskInfo {
  level: RiskLevel;
  linesAdded: number;
  linesRemoved: number;
  aiShare: number;
  sensitiveTags: string[];
  breaches: string[];
}

function sensitiveTags(path: string): string[] {
  const tags: string[] = [];
  if (pathMatchesAny(path, config().risk.sensitivePaths || DEFAULT_SENSITIVE)) tags.push("sensitive");
  if (pathMatchesAny(path, config().risk.generatedGlobs || DEFAULT_GENERATED)) tags.push("generated");
  return tags;
}

export function assess(session: DiffSession): RiskInfo {
  let added = 0;
  let removed = 0;
  for (const h of session.hunks) {
    for (let i = 1; i < h.lines.length; i++) {
      const p = h.lines[i][0];
      if (p === "+") added++;
      else if (p === "-") removed++;
    }
  }
  const aiLines = forFile(session.file).reduce((acc, e) => acc + (e.anchor.line_count || 1), 0);
  const total = Math.max(1, session.originalLines.length);
  const aiShare = Math.min(1, aiLines / total);
  const tags = sensitiveTags(session.file);
  const breaches: string[] = [];

  let level: RiskLevel = "low";
  const totalChanged = added + removed;
  if (totalChanged >= THRESHOLDS.lines.high) {
    level = "high";
    breaches.push("lines");
  } else if (totalChanged >= THRESHOLDS.lines.medium) {
    level = "medium";
  }
  if (aiShare >= THRESHOLDS.ai_share.high) {
    level = "high";
    breaches.push("ai_share");
  }
  if (tags.length) {
    if (level === "low") level = "medium";
    if (tags[0] === "sensitive") {
      level = "high";
      breaches.push("sensitive");
    }
  }
  return { level, linesAdded: added, linesRemoved: removed, aiShare, sensitiveTags: tags, breaches };
}

export function bannerText(info: RiskInfo): string {
  const pct = Math.floor(info.aiShare * 100 + 0.5);
  let s = `risk ${info.level} · +${info.linesAdded} −${info.linesRemoved} · ai ${pct}%`;
  if (info.sensitiveTags.length) s += " · " + info.sensitiveTags.join(" · ");
  return s;
}

/** Returns true to proceed with a forced accept (after optional confirmation). */
export async function confirmForceAccept(
  session: DiffSession,
  confirm: (msg: string) => Promise<boolean>
): Promise<boolean> {
  if (config().risk.enabled === false) return true;
  const info = assess(session);
  if (info.level !== "high" || config().risk.confirmOnForceHigh === false) return true;
  const ok = await confirm(`High-risk force-accept (${bannerText(info)}). Proceed?`);
  if (ok) {
    audit({
      event: "risk_force",
      file: session.file,
      level: info.level,
      lines_added: info.linesAdded,
      lines_removed: info.linesRemoved,
      ai_share: info.aiShare,
      sensitive_tags: info.sensitiveTags,
    });
  }
  return ok;
}
