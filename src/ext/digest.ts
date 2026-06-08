// Audit digest — port of `:NvimeAudit summary [days]` and `:NvimeAudit forces`.
// Groups events by lane/provider, ranks touched files, reports the diff-block
// acceptance rate, and surfaces risky (force/conflict/rollback) events.
import { readEvents, AuditEvent } from "./audit";

const RISKY = new Set(["verify_force", "verify_block", "risk_force", "block_force_applied", "policy_block", "intent_override", "block_undo"]);

function withinDays(e: AuditEvent, days: number): boolean {
  if (!e.ts) return true;
  const t = Date.parse(e.ts);
  if (isNaN(t)) return true;
  return Date.now() - t <= days * 86400000;
}

export function summary(days = 7): string {
  const events = readEvents().filter((e) => withinDays(e, days));
  const byLane: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const fileTouch: Record<string, number> = {};
  let accepted = 0;
  let total = 0;
  const acceptByProvider: Record<string, { a: number; t: number }> = {};
  let forces = 0;

  for (const e of events) {
    if (e.lane) byLane[e.lane] = (byLane[e.lane] || 0) + 1;
    if (e.provider) byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    if (e.event === "diff_resolved") {
      accepted += e.accepted || 0;
      total += e.total || 0;
      const p = e.provider || "?";
      acceptByProvider[p] = acceptByProvider[p] || { a: 0, t: 0 };
      acceptByProvider[p].a += e.accepted || 0;
      acceptByProvider[p].t += e.total || 0;
      if (e.path) fileTouch[e.path] = (fileTouch[e.path] || 0) + 1;
    }
    if (e.event === "block_force_applied" || e.event === "verify_force" || e.event === "risk_force") forces++;
  }

  const topFiles = Object.entries(fileTouch).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const risky = events.filter((e) => RISKY.has(e.event || ""));

  const rate = total ? Math.round((accepted / total) * 100) : 0;
  const lines: string[] = [
    `# nvimse audit digest · last ${days} days`,
    "",
    `Events: ${events.length} · diff blocks ${accepted}/${total} accepted (${rate}%) · force-accepts: ${forces}`,
    "",
    "## By lane",
    ...Object.entries(byLane).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## By provider",
    ...Object.entries(byProvider).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
    "",
    "## Acceptance rate by provider",
    ...Object.entries(acceptByProvider).map(([p, x]) => `- ${p}: ${x.a}/${x.t} (${x.t ? Math.round((x.a / x.t) * 100) : 0}%)`),
    "",
    "## Most-touched files",
    ...(topFiles.length ? topFiles.map(([f, n]) => `- ${f} · ${n} diffs`) : ["(none)"]),
    "",
    "## Risky events (force-accepts, conflicts, blocks, rollbacks)",
    ...(risky.length ? risky.slice(-30).map((e) => `- \`${e.event}\` ${e.file || e.path || ""} ${e.reason || ""} (${e.ts})`) : ["(none)"]),
  ];
  return lines.join("\n");
}

export function forcesReview(): string {
  const events = readEvents().filter((e) => e.event === "block_force_applied" || e.event === "verify_force");
  const lines = [
    "# nvimse force-accept review",
    "",
    "Every diff block that bypassed nvimse's live-content / verify guard:",
    "",
    ...(events.length
      ? events.map((e) => `- ${e.ts} · \`${e.file}\`${e.start ? ":" + e.start : ""}${e.reason ? " · " + e.reason : ""}`)
      : ["(no force-accepts recorded)"]),
  ];
  return lines.join("\n");
}
