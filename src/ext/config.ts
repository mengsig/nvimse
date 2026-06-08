import * as vscode from "vscode";
import { ToolPolicy } from "../core/agent";

export interface NvimseConfig {
  provider: string;
  providers: {
    claude: { cmd: string; models: string[] };
    codex: { cmd: string; models: string[]; reasoningEffort: string | null };
  };
  audit: { enabled: boolean; path: string | null; logPrompts: boolean };
  attribution: { enabled: boolean; path: string | null; max: number };
  recap: { autoOpen: boolean };
  review: { allowShell: boolean; allowWeb: boolean; allowMarkdownWrites: boolean };
  selection: { allowShell: boolean; allowWeb: boolean };
  edit: {
    contextLines: number;
    injectContext: boolean;
    contextMaxChars: number;
    relatedTestLimit: number;
    symbolLimit: number;
    recentDiffLimit: number;
    maxTurns: number | null;
  };
  diff: { maxVisualBlockLines: number; devilsAdvocate: boolean };
  verify: { enabled: boolean; blockOnParseError: boolean; timeoutMs: number; externalChecks: boolean; checks: Record<string, any> };
  risk: { enabled: boolean; sensitivePaths: string[] | null; generatedGlobs: string[] | null; confirmOnForceHigh: boolean };
  policyRules: { enabled: boolean; path: string | null };
  intent: { enabled: boolean; minWords: number; classifier: string };
  pr: { enabled: boolean; path: string | null; baseBranch: string | null; includeUnattributed: boolean };
  chat: { maxHistoryMessages: number };
  bigchange: { trivial: { enabled: boolean; docGlobs: string[] } };
  plan: {
    enabled: boolean;
    dir: string | null;
    autoOpen: boolean;
    devilsAdvocate: boolean;
    testRunner: string | null;
    testFile: string | null;
    sessionContinuity: string;
  };
  sessions: { enabled: boolean; max: number };
  usage: { enabled: boolean; maxDays: number; statusline: boolean; rates: Record<string, any> };
  testLoop: { enabled: boolean; runner: string | null; autoFix: boolean; maxRetries: number; captureLines: number };
  mcp: { enabled: boolean; configPath: string | null; servers: Record<string, any>; exposeSelf: boolean; codexBypassForMcp: boolean };
}

export function readConfig(): NvimseConfig {
  const c = vscode.workspace.getConfiguration("nvimse");
  return {
    provider: c.get("provider", "claude"),
    providers: {
      claude: { cmd: c.get("providers.claude.cmd", "claude"), models: c.get("providers.claude.models", ["opus", "sonnet", "haiku"]) },
      codex: {
        cmd: c.get("providers.codex.cmd", "codex"),
        models: c.get("providers.codex.models", ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"]),
        reasoningEffort: c.get("providers.codex.reasoningEffort", null),
      },
    },
    audit: { enabled: c.get("audit.enabled", true), path: c.get("audit.path", null), logPrompts: c.get("audit.logPrompts", false) },
    attribution: { enabled: c.get("attribution.enabled", true), path: c.get("attribution.path", null), max: c.get("attribution.max", 500) },
    recap: { autoOpen: c.get("recap.autoOpen", true) },
    review: { allowShell: c.get("review.allowShell", true), allowWeb: c.get("review.allowWeb", true), allowMarkdownWrites: c.get("review.allowMarkdownWrites", true) },
    selection: { allowShell: c.get("selection.allowShell", true), allowWeb: c.get("selection.allowWeb", true) },
    edit: {
      contextLines: c.get("edit.contextLines", 0),
      injectContext: c.get("edit.injectContext", true),
      contextMaxChars: c.get("edit.contextMaxChars", 6000),
      relatedTestLimit: c.get("edit.relatedTestLimit", 4),
      symbolLimit: c.get("edit.symbolLimit", 24),
      recentDiffLimit: c.get("edit.recentDiffLimit", 5),
      maxTurns: c.get("edit.maxTurns", null),
    },
    diff: { maxVisualBlockLines: c.get("diff.maxVisualBlockLines", 12), devilsAdvocate: c.get("diff.devilsAdvocate", false) },
    verify: {
      enabled: c.get("verify.enabled", true),
      blockOnParseError: c.get("verify.blockOnParseError", true),
      timeoutMs: c.get("verify.timeoutMs", 8000),
      externalChecks: c.get("verify.externalChecks", false),
      checks: c.get("verify.checks", {}),
    },
    risk: {
      enabled: c.get("risk.enabled", true),
      sensitivePaths: c.get("risk.sensitivePaths", null),
      generatedGlobs: c.get("risk.generatedGlobs", null),
      confirmOnForceHigh: c.get("risk.confirmOnForceHigh", true),
    },
    policyRules: { enabled: c.get("policyRules.enabled", true), path: c.get("policyRules.path", null) },
    intent: { enabled: c.get("intent.enabled", true), minWords: c.get("intent.minWords", 4), classifier: c.get("intent.classifier", "heuristic") },
    pr: { enabled: c.get("pr.enabled", true), path: c.get("pr.path", null), baseBranch: c.get("pr.baseBranch", null), includeUnattributed: c.get("pr.includeUnattributed", true) },
    chat: { maxHistoryMessages: c.get("chat.maxHistoryMessages", 24) },
    bigchange: {
      trivial: {
        enabled: c.get("bigchange.trivial.enabled", true),
        docGlobs: c.get("bigchange.trivial.docGlobs", ["*.md", "*.markdown", "*.rst", "*.txt", "**/*.md", "**/*.markdown", "**/*.rst", "**/*.txt", "docs/**", "doc/**"]),
      },
    },
    plan: {
      enabled: c.get("plan.enabled", true),
      dir: c.get("plan.dir", null),
      autoOpen: c.get("plan.autoOpen", true),
      devilsAdvocate: c.get("plan.devilsAdvocate", true),
      testRunner: c.get("plan.testRunner", null),
      testFile: c.get("plan.testFile", null),
      sessionContinuity: c.get("plan.sessionContinuity", "plan"),
    },
    sessions: { enabled: c.get("sessions.enabled", true), max: c.get("sessions.max", 100) },
    usage: { enabled: c.get("usage.enabled", true), maxDays: c.get("usage.maxDays", 90), statusline: c.get("usage.statusline", true), rates: c.get("usage.rates", {}) },
    testLoop: {
      enabled: c.get("testLoop.enabled", false),
      runner: c.get("testLoop.runner", null),
      autoFix: c.get("testLoop.autoFix", false),
      maxRetries: c.get("testLoop.maxRetries", 2),
      captureLines: c.get("testLoop.captureLines", 200),
    },
    mcp: {
      enabled: c.get("mcp.enabled", true),
      configPath: c.get("mcp.configPath", null),
      servers: c.get("mcp.servers", {}),
      exposeSelf: c.get("mcp.exposeSelf", true),
      codexBypassForMcp: c.get("mcp.codexBypassForMcp", false),
    },
  };
}

export function toolPolicy(cfg: NvimseConfig): ToolPolicy {
  return {
    reviewAllowShell: cfg.review.allowShell,
    reviewAllowWeb: cfg.review.allowWeb,
    reviewAllowMarkdownWrites: cfg.review.allowMarkdownWrites,
    selectionAllowShell: cfg.selection.allowShell,
    selectionAllowWeb: cfg.selection.allowWeb,
  };
}
