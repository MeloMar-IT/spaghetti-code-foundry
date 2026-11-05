import { REASON_KINDS, type UsageEvent } from "./schema.js";
import type { Config } from "../config.js";
import type { RunSummary, StepRecord } from "../engine/state.js";
import { DEFAULT_WORKSPACE, validWorkspaceId } from "../workspaces/list.js";
import { isStoryRun } from "../engine/auto-retry.js";
import { repositoryOf } from "../evidence/record.js";
import { classifyFailure } from "../failure.js";
import { scrub } from "../help/guard.js";
import { specOf } from "../agents/targets.js";

/**
 * Usage events: what a run did, as ids, numbers and fixed words. Never task or issue text, step output, error text,
 * secrets, paths or file content. This file is pure (no I/O); src/usage/hub.ts stores and delivers the events.
 */

export { REASON_KINDS, UsageEventSchema } from "./schema.js";
export type { UsageEvent, UsageHandler } from "./schema.js";

/** The word that stands for a value that looked like a secret or a path. */
export const REDACTED_ID = "redacted";
const ABSOLUTE = /^(?:[/~\\]|[A-Za-z]:[\\/])/;

/**
 * A step id, provider or model name for an event: a secret-shaped value or an absolute path becomes "redacted",
 * other characters than letters, digits and `_ . / : -` become `_`, and the result is cut at 200. Never throws.
 */
export function cleanId(s: string, patterns: readonly string[] = []): string {
  try {
    const t = String(s).trim();
    if (ABSOLUTE.test(t) || scrub(t, { patterns }).text !== t) return REDACTED_ID;
    return t.replace(/[^\w./:-]/g, "_").slice(0, 200) || "unknown";
  } catch {
    return REDACTED_ID;
  }
}

/** Agent, provider and model of an agent label such as `codex:openai:gpt-5` (built-in providers included). */
export function agentParts(label: string | undefined, config: Config): { agent?: string; provider?: string; model?: string } {
  if (!label) return {};
  try {
    const s = specOf(label, config);
    const patterns = config.help?.sensitive_patterns ?? [];
    return {
      ...(s.agent ? { agent: cleanId(s.agent, patterns) } : {}),
      ...(s.provider ? { provider: cleanId(s.provider, patterns) } : {}),
      ...(s.model ? { model: cleanId(s.model, patterns) } : {}),
    };
  } catch {
    return {};
  }
}

export interface Price {
  input_per_mtok: number;
  cached_input_per_mtok: number;
  output_per_mtok: number;
}

const P5: Price = { input_per_mtok: 1.25, cached_input_per_mtok: 0.125, output_per_mtok: 10 };
const PMINI: Price = { input_per_mtok: 0.25, cached_input_per_mtok: 0.025, output_per_mtok: 2 };
/** List prices (USD per million tokens) of the Codex models. They go stale: `usage.prices` in config.yaml wins. */
export const DEFAULT_PRICES: Readonly<Record<string, Price>> = Object.freeze({
  "gpt-5": P5,
  "gpt-5-codex": P5,
  "gpt-5.1": P5,
  "gpt-5.1-codex": P5,
  "gpt-5-mini": PMINI,
  "gpt-5.1-codex-mini": PMINI,
});

/** The price of a model: `usage.prices`, then the provider's own `price` (no cached rate: it is the input rate), then the built-in table. */
export function priceFor(model: string | undefined, config: Pick<Config, "usage">, provider?: { price?: { input_per_mtok: number; output_per_mtok: number } }): Price | undefined {
  const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
  if (model && config.usage && own(config.usage.prices, model)) return config.usage.prices[model];
  if (provider?.price) return { input_per_mtok: provider.price.input_per_mtok, cached_input_per_mtok: provider.price.input_per_mtok, output_per_mtok: provider.price.output_per_mtok };
  if (model && own(DEFAULT_PRICES, model)) return DEFAULT_PRICES[model];
  return undefined;
}

/** USD for the tokens; `input` includes the cached ones. Undefined without a price. */
export function costOf(tokens: { input: number; cached?: number; output: number }, price?: Price): number | undefined {
  if (!price) return undefined;
  const input = Math.max(0, tokens.input);
  const cached = Math.min(input, Math.max(0, tokens.cached ?? 0));
  return ((input - cached) * price.input_per_mtok + cached * price.cached_input_per_mtok + Math.max(0, tokens.output) * price.output_per_mtok) / 1e6;
}

const issueNumber = (vars: Record<string, string> | undefined): number | undefined => (/^[1-9]\d{0,9}$/.test(vars?.issue ?? "") ? Number(vars!.issue) : undefined);

function common(run: Pick<RunSummary, "runId" | "vars" | "workspace">, id: string) {
  const repository = repositoryOf(run.vars);
  const issue = issueNumber(run.vars);
  return { id, time: new Date().toISOString(), runId: run.runId, ...(repository ? { repository } : {}), ...(issue ? { issue } : {}), workspace: validWorkspaceId(run.workspace) ? run.workspace : DEFAULT_WORKSPACE };
}

export function runStartedEvent(run: Pick<RunSummary, "runId" | "vars" | "workspace">): UsageEvent {
  return { ...common(run, `${run.runId}:started`), name: "run.started" };
}

export function stepFinishedEvent(run: Pick<RunSummary, "runId" | "vars" | "workspace">, rec: StepRecord, index: number, config: Config): UsageEvent {
  const patterns = config.help?.sensitive_patterns ?? [];
  const t = rec.tokens;
  return {
    ...common(run, `${run.runId}:step:${index}`),
    name: "step.finished",
    step: cleanId(rec.id, patterns),
    stepType: cleanId(rec.type, patterns),
    ok: rec.ok === true,
    ...agentParts(rec.agent, config),
    ...(t ? { tokensIn: t.input, tokensCached: t.cached ?? 0, tokensOut: t.output } : {}),
    costUsd: typeof rec.costUsd === "number" ? rec.costUsd : null,
    durationMs: Math.max(0, Math.round(rec.durationMs ?? 0)),
    earlierCostUsd: rec.earlierCostUsd ?? 0,
  };
}

const SPLIT_LINE = /^SPLIT: ((?:#\d+\s*)+) — #(\d+) closed\s*$/m;
const ALREADY_SPLIT = /^already split: ((?:#\d+\s*)+)$/m;
const numbers = (list: string): number[] => [...list.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));

/** The parts of a split, when `rec` is a top-level, successful `create_split` step. Only numbers are taken from its output. */
export function splitOf(rec: Pick<StepRecord, "id" | "ok" | "output" | "parent"> | undefined): { parent?: number; parts: number[] } | undefined {
  if (!rec || rec.id !== "create_split" || rec.parent || !rec.ok || typeof rec.output !== "string") return undefined;
  const a = SPLIT_LINE.exec(rec.output);
  if (a) return { parent: Number(a[2]), parts: numbers(a[1]!) };
  const b = ALREADY_SPLIT.exec(rec.output);
  return b ? { parts: numbers(b[1]!) } : undefined;
}

/** The events of a run that ended: `run.finished`, and for a story run that succeeded or failed one issue event. */
export function runEndEvents(run: RunSummary): UsageEvent[] {
  if (run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled") return [];
  const n = run.resumes ?? 0;
  let reason: (typeof REASON_KINDS)[number] = "none";
  if (run.status !== "succeeded") {
    try {
      reason = classifyFailure(run).cause;
    } catch {
      reason = "factory";
    }
  }
  const start = Date.parse(run.startedAt);
  const end = Date.parse(run.finishedAt ?? "");
  const out: UsageEvent[] = [
    { ...common(run, `${run.runId}:finished:${n}`), name: "run.finished", status: run.status, reason, durationMs: Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0, costUsd: Math.max(0, run.totalCostUsd || 0) },
  ];
  if (run.status === "cancelled" || !isStoryRun(run)) return out;
  const id = `${run.runId}:issue:${n}`;
  if (run.status === "failed") return [...out, { ...common(run, id), name: "issue.failed" }];
  const split = splitOf(run.history?.at(-1));
  if (split) return [...out, { ...common(run, id), name: "issue.split", ...(split.parent ?? issueNumber(run.vars) ? { parent: split.parent ?? issueNumber(run.vars) } : {}), parts: split.parts }];
  return [...out, { ...common(run, id), name: "issue.done" }];
}
