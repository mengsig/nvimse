import { config, isDisabled } from "./runtime";
import { nvimePath, readJson, writeJson, isoTimestamp, unixSeconds } from "./paths";
import { UsageSample } from "../core/agent";

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_DAYS = 90;

interface Rate {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

const DEFAULT_RATES: Record<string, Rate> = {
  "claude-opus-4-8": { input: 15.0, output: 75.0, cache_read: 1.5, cache_creation: 18.75 },
  "claude-opus-4-8[1m]": { input: 15.0, output: 75.0, cache_read: 1.5, cache_creation: 18.75 },
  "claude-sonnet-4-6": { input: 3.0, output: 15.0, cache_read: 0.3, cache_creation: 3.75 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0, cache_read: 0.1, cache_creation: 1.25 },
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0, cache_read: 0.1, cache_creation: 1.25 },
  "gpt-5.5": { input: 5.0, output: 30.0, cache_read: 0.5, cache_creation: 5.0 },
  "gpt-5.4": { input: 2.0, output: 8.0, cache_read: 0.2, cache_creation: 2.0 },
  "gpt-5.4-mini": { input: 0.4, output: 1.6, cache_read: 0.04, cache_creation: 0.4 },
  "codex-default": { input: 5.0, output: 30.0, cache_read: 0.5, cache_creation: 5.0 },
};

interface Bucket {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  reasoning: number;
  cost_usd: number;
  runs: number;
}

interface UsageStore {
  version: number;
  totals: Bucket;
  by_lane: Record<string, Bucket>;
  by_day: Record<string, Bucket>;
  last_run?: any;
}

function newBucket(): Bucket {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0, reasoning: 0, cost_usd: 0, runs: 0 };
}

function usagePath(): string {
  return nvimePath("usage.json", null);
}

function read(): UsageStore {
  const s = readJson<UsageStore>(usagePath(), { version: SCHEMA_VERSION, totals: newBucket(), by_lane: {}, by_day: {} });
  if (!s.totals) s.totals = newBucket();
  if (!s.by_lane) s.by_lane = {};
  if (!s.by_day) s.by_day = {};
  return s;
}

function rateFor(model: string): Rate {
  const rates: Record<string, Rate> = { ...DEFAULT_RATES, ...(config().usage.rates as any) };
  if (rates[model]) return rates[model];
  const keys = Object.keys(rates).sort((a, b) => b.length - a.length);
  for (const k of keys) if (model.startsWith(k)) return rates[k];
  return rates["codex-default"];
}

export function computeCost(sample: UsageSample): number {
  if (sample.costUsd > 0) return sample.costUsd;
  const r = rateFor(sample.model);
  return (
    (sample.input * r.input +
      sample.output * r.output +
      sample.cacheRead * r.cache_read +
      sample.cacheCreation * r.cache_creation +
      sample.reasoning * r.output) /
    1_000_000
  );
}

function bucketAdd(b: Bucket, s: UsageSample, cost: number): void {
  b.input += s.input;
  b.output += s.output;
  b.cache_read += s.cacheRead;
  b.cache_creation += s.cacheCreation;
  b.reasoning += s.reasoning;
  b.cost_usd += cost;
  b.runs += 1;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function record(opts: { sample: UsageSample; lane: string; provider: string }): { cost: number } | null {
  if (isDisabled() || config().usage.enabled === false) return null;
  const cost = computeCost(opts.sample);
  const s = read();
  bucketAdd(s.totals, opts.sample, cost);
  const lane = opts.lane || "unknown";
  if (!s.by_lane[lane]) s.by_lane[lane] = newBucket();
  bucketAdd(s.by_lane[lane], opts.sample, cost);
  const day = today();
  if (!s.by_day[day]) s.by_day[day] = newBucket();
  bucketAdd(s.by_day[day], opts.sample, cost);
  s.last_run = { ts: unixSeconds(), iso_ts: isoTimestamp(), provider: opts.provider, lane, model: opts.sample.model, sample: opts.sample };
  // trim days
  const maxDays = config().usage.maxDays || DEFAULT_MAX_DAYS;
  const days = Object.keys(s.by_day).sort();
  while (days.length > maxDays) {
    const drop = days.shift()!;
    delete s.by_day[drop];
  }
  writeJson(usagePath(), s);
  return { cost };
}

function fmtUsd(v: number): string {
  return "$" + v.toFixed(4);
}

export function statuslineLabel(): string {
  const s = read();
  const t = s.by_day[today()];
  const todayCost = t ? t.cost_usd : 0;
  return `${fmtUsd(todayCost)} today / ${fmtUsd(s.totals.cost_usd)} total`;
}

export function summaryText(): string {
  const s = read();
  const lanes = Object.entries(s.by_lane)
    .map(([k, b]) => `  ${k}: ${b.runs} runs · ${fmtUsd(b.cost_usd)}`)
    .join("\n");
  return [
    `nvimse usage`,
    `total: ${s.totals.runs} runs · ${fmtUsd(s.totals.cost_usd)}`,
    `today: ${fmtUsd((s.by_day[today()] || newBucket()).cost_usd)}`,
    `by lane:`,
    lanes || "  (none)",
  ].join("\n");
}

export function runSummary(sample: UsageSample): string {
  const cost = computeCost(sample);
  const out = sample.output + sample.reasoning;
  const cached = sample.cacheRead + sample.cacheCreation;
  if (cached > 0) return `↑${out} out · ↓${sample.input} new · ↓${cached} cached · ${fmtUsd(cost)}`;
  return `↑${out} out · ↓${sample.input} ctx · ${fmtUsd(cost)}`;
}

export function reset(): void {
  writeJson(usagePath(), { version: SCHEMA_VERSION, totals: newBucket(), by_lane: {}, by_day: {} });
}
