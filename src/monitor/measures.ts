import { join } from "node:path";
import { parseEvidenceEventLine } from "../evidence/parse.js";
import { repositoryOf } from "../evidence/record.js";
import { FlowIdentitySchema, TERMINAL_RUN_STATUSES, type EvidenceEvent } from "../evidence/schema.js";
import { readPlainBytes } from "../evidence/stream.js";
import { EVIDENCE_EVENTS_FILE } from "../evidence/version.js";
import type { RunStatus, RunSummary, StepRecord } from "../engine/state.js";
import { TELEMETRY_VERSION, tmId, TelemetryMeasuresSchema, type TelemetryEvent, type TelemetryMeasures } from "../telemetry/envelope.js";
import { emitTelemetry, telemetryEnabled } from "../telemetry/telemetry.js";

/**
 * The decision measures of a run: what is measured about a finished run, who acts on it, and what it informs.
 * Every number is tied to an owner (a role, never an account) and to a detector or a setting.
 */

export const MEASURE_NAMES = [
  "duration", "queue time", "retries", "tokens", "cost", "denials", "policy outcomes", "context size", "tool latency", "interruptions", "approval latency", "pull-request result",
] as const;
export type MeasureName = (typeof MEASURE_NAMES)[number];
export type MeasureOwner = "admin" | "repository owner";

export interface Measure {
  name: MeasureName;
  unit: "ms" | "count" | "tokens" | "usd" | "outcome";
  owner: MeasureOwner;
  /** The detector (name in the monitor) or the setting this measure informs. */
  decision: { detector: string } | { setting: string };
}

export const MEASURES: readonly Measure[] = [
  { name: "duration", unit: "ms", owner: "admin", decision: { detector: "slow-step" } },
  { name: "queue time", unit: "ms", owner: "admin", decision: { detector: "queue-stalled" } },
  { name: "retries", unit: "count", owner: "admin", decision: { setting: "router.fallback_on" } },
  { name: "tokens", unit: "tokens", owner: "repository owner", decision: { setting: "router.rules" } },
  { name: "cost", unit: "usd", owner: "admin", decision: { setting: "daily_budget_usd" } },
  { name: "denials", unit: "count", owner: "repository owner", decision: { setting: "allowed_tools" } },
  { name: "policy outcomes", unit: "count", owner: "admin", decision: { setting: "policy.packs" } },
  { name: "context size", unit: "tokens", owner: "repository owner", decision: { setting: "skills" } },
  { name: "tool latency", unit: "ms", owner: "repository owner", decision: { setting: "timeout_sec" } },
  { name: "interruptions", unit: "count", owner: "admin", decision: { detector: "restart-loop" } },
  { name: "approval latency", unit: "ms", owner: "repository owner", decision: { setting: "approval steps of the flow" } },
  { name: "pull-request result", unit: "outcome", owner: "repository owner", decision: { detector: "unexplained-failure" } },
];

export interface ToolTimes {
  calls: number;
  totalMs: number;
  maxMs: number;
}

export interface StepMeasures {
  step: string;
  visit: number;
  type: StepRecord["type"];
  durationMs?: number;
  retries?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  denials?: number;
  contextTokens?: number;
  tools?: ToolTimes;
}

export interface RunMeasures {
  runId: string;
  outcome?: RunStatus;
  durationMs?: number;
  /** The total cost the run recorded (retries and the failure note included), not only the sum of its steps. */
  costUsd?: number;
  queueMs?: number;
  steps: StepMeasures[];
  stops?: number;
  resumes?: number;
  approvals?: { decided: number; totalMs: number; maxMs: number; cancelled: number };
  policy?: { allow: number; warn: number; require_approval: number; deny: number; unavailable: number };
  pullRequest?: { delivered: boolean };
}

/** A finite number ≥ 0, else undefined. */
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const whole = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
};
const ms = (a: string | undefined, b: string | undefined): number | undefined => {
  const x = typeof a === "string" ? Date.parse(a) : NaN;
  const y = typeof b === "string" ? Date.parse(b) : NaN;
  return Number.isFinite(x) && Number.isFinite(y) && y >= x ? Math.round(y - x) : undefined;
};
const put = <T extends object>(o: T, k: keyof T, v: unknown): void => {
  if (v !== undefined) (o as Record<string, unknown>)[k as string] = v;
};

type StepRef = { id: string; visit: number; parent?: string };
const keyOf = (s: StepRef): string => `${s.parent ? `${s.parent}/` : ""}${s.id}#${s.visit}`;

/** The `step.denied` events of every visit, in the order the visits started: key → one count per `step.started`. */
function deniedBySegment(events: readonly EvidenceEvent[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const e of events) {
    if (e.type === "step.started") {
      const k = keyOf(e.step);
      out.set(k, [...(out.get(k) ?? []), 0]);
    } else if (e.type === "step.denied" && e.step) {
      const segs = out.get(keyOf(e.step));
      if (segs?.length) segs[segs.length - 1]!++;
    }
  }
  return out;
}

function stepMeasures(run: RunSummary, events: readonly EvidenceEvent[]): StepMeasures[] {
  const history: unknown[] = Array.isArray(run.history) ? run.history : [];
  const denied = events.length ? deniedBySegment(events) : undefined;
  const used = new Map<string, number>();
  const out: StepMeasures[] = [];
  for (const raw of history) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Partial<StepRecord>;
    if (typeof rec.id !== "string") continue;
    const visit = whole(rec.visit) ?? 1;
    const m: StepMeasures = { step: rec.id, visit, type: rec.type as StepRecord["type"] };
    put(m, "durationMs", whole(rec.durationMs));
    if (rec.retried && typeof rec.retried === "object") {
      const r = (whole(rec.retried.blips) ?? 0) + (whole(rec.retried.models) ?? 0);
      put(m, "retries", r);
    }
    put(m, "tokensIn", whole(rec.tokens?.input));
    put(m, "tokensOut", whole(rec.tokens?.output));
    put(m, "costUsd", num(rec.costUsd));
    put(m, "contextTokens", whole(rec.contextTokens));
    if (rec.tools && typeof rec.tools === "object") {
      const calls = whole(rec.tools.calls);
      if (calls !== undefined) m.tools = { calls, totalMs: whole(rec.tools.totalMs) ?? 0, maxMs: whole(rec.tools.maxMs) ?? 0 };
    }
    const key = `${rec.id}#${visit}`;
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    // The record keeps at most 5 refusals and the evidence may be cut short: take the larger of the two, never their sum.
    const fromRecord = Array.isArray(rec.denied) ? rec.denied.length : undefined;
    const fromEvents = denied?.get(key)?.[n];
    put(m, "denials", fromRecord !== undefined && fromEvents !== undefined ? Math.max(fromRecord, fromEvents) : (fromEvents ?? fromRecord));
    out.push(m);
  }
  return out;
}

/** Ids of the approval steps (top level) of the flow of the run. */
function approvalSteps(run: RunSummary): Set<string> {
  const steps: unknown[] = Array.isArray(run.flowDef?.steps) ? run.flowDef.steps : [];
  return new Set(steps.flatMap((s) => (s && typeof s === "object" && (s as { type?: unknown }).type === "approval" && typeof (s as { id?: unknown }).id === "string" ? [(s as { id: string }).id] : [])));
}

function approvalMeasures(run: RunSummary, events: readonly EvidenceEvent[]): NonNullable<RunMeasures["approvals"]> {
  const started = new Map<string, string>();
  // The engine writes the approval's `step.started` only when it consumes the decision, so the real wait begins
  // where the run stopped at that step (`run.stopped` with `at`). Without such a stop, `step.started` is the start.
  const waitingSince = new Map<string, string>();
  const a = { decided: 0, totalMs: 0, maxMs: 0, cancelled: 0 };
  const waits = approvalSteps(run);
  events.forEach((e, i) => {
    if (e.type === "step.started" && e.step.type === "approval") started.set(keyOf(e.step), e.time);
    if (e.type === "run.stopped" && e.at && waits.has(e.at)) waitingSince.set(e.at, e.time);
    const decidedStep = e.type === "step.approved" || (e.type === "step.denied" && e.denial.kind === "approval") ? e.step : undefined;
    if (decidedStep) {
      const t = ms(waitingSince.get(decidedStep.id) ?? started.get(keyOf(decidedStep)), e.time);
      waitingSince.delete(decidedStep.id);
      started.delete(keyOf(decidedStep));
      if (t !== undefined) {
        a.decided++;
        a.totalMs += t;
        a.maxMs = Math.max(a.maxMs, t);
      }
    }
    // Stopped at an approval step and then cancelled, with no resume in between.
    if (e.type === "run.stopped" && e.at && waits.has(e.at)) {
      const next = events.slice(i + 1).find((x) => x.type === "run.resumed" || x.type === "run.cancelled");
      if (next?.type === "run.cancelled") a.cancelled++;
    }
  });
  return a;
}

/**
 * The measures of one run, from its `run.json` and its evidence events. Pure: reads no files, calls no AI, never throws.
 * A source that is missing leaves its measures out.
 */
export function measureRun(run: RunSummary, events: readonly EvidenceEvent[]): RunMeasures {
  const out: RunMeasures = { runId: String(run?.runId ?? ""), steps: [] };
  try {
    const evs: readonly EvidenceEvent[] = Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
    put(out, "outcome", run.status);
    put(out, "durationMs", ms(run.startedAt, run.finishedAt));
    put(out, "costUsd", num(run.totalCostUsd));
    out.steps = stepMeasures(run, evs);
    if (evs.length) {
      const started = evs.findIndex((e) => e.type === "run.started");
      const queued = evs.findIndex((e) => e.type === "run.queued");
      if (started >= 0 && queued >= 0 && queued < started) put(out, "queueMs", ms(evs[queued]!.time, evs[started]!.time));
      out.stops = evs.filter((e) => e.type === "run.stopped").length;
      out.resumes = evs.filter((e) => e.type === "run.resumed").length;
      if (evs.some((e) => e.type === "step.started" && e.step.type === "approval") || evs.some((e) => e.type === "run.stopped" && e.at && approvalSteps(run).has(e.at))) {
        out.approvals = approvalMeasures(run, evs);
      }
      const p = { allow: 0, warn: 0, require_approval: 0, deny: 0, unavailable: 0 };
      for (const e of evs) {
        if (e.type !== "policy.decided") continue;
        if (e.decision.outcome in p) p[e.decision.outcome]++;
        if (e.decision.reasonCode === "policy.unavailable" || e.decision.reasonCode === "policy.invalid") p.unavailable++;
      }
      out.policy = p;
      out.pullRequest = { delivered: evs.some((e) => (e.type === "run.completed" || e.type === "step.completed") && e.pullRequest !== undefined) };
    } else {
      put(out, "resumes", whole(run.resumes));
    }
  } catch {
    // never throws: what was measured so far stays
  }
  return out;
}

/** The events of a run from `evidence.jsonl`. Lines that cannot be read or belong to another run are skipped. Never throws. */
export function readRunEvents(runDir: string, runId: string): EvidenceEvent[] {
  try {
    const bytes = readPlainBytes(join(runDir, EVIDENCE_EVENTS_FILE));
    if (!bytes) return [];
    const out: EvidenceEvent[] = [];
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = parseEvidenceEventLine(line);
        if (e.runId === runId) out.push(e);
      } catch {
        // a line that cannot be read is skipped
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The numbers of the run: sums and maxima of the steps, and the run's own measures. An absent source stays absent. */
export function runMeasuresTelemetry(m: RunMeasures): TelemetryMeasures {
  const out: Record<string, number> = {};
  const sum = (pick: (s: StepMeasures) => number | undefined): number | undefined => {
    const v = m.steps.map(pick).filter((n): n is number => n !== undefined);
    return v.length ? v.reduce((a, b) => a + b, 0) : undefined;
  };
  const max = (pick: (s: StepMeasures) => number | undefined): number | undefined => {
    const v = m.steps.map(pick).filter((n): n is number => n !== undefined);
    return v.length ? Math.max(...v) : undefined;
  };
  const set = (k: string, v: number | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("steps", m.steps.length);
  set("stepMs", sum((s) => s.durationMs));
  set("queueMs", m.queueMs);
  set("retries", sum((s) => s.retries));
  set("tokensIn", sum((s) => s.tokensIn));
  set("tokensOut", sum((s) => s.tokensOut));
  set("costUsd", m.costUsd ?? sum((s) => s.costUsd));
  set("denials", sum((s) => s.denials));
  set("contextTokensMax", max((s) => s.contextTokens));
  set("toolCalls", sum((s) => s.tools?.calls));
  set("toolMs", sum((s) => s.tools?.totalMs));
  set("toolMaxMs", max((s) => s.tools?.maxMs));
  set("stops", m.stops);
  set("resumes", m.resumes);
  if (m.approvals) {
    set("approvals", m.approvals.decided);
    set("approvalMs", m.approvals.totalMs);
    set("approvalMaxMs", m.approvals.maxMs);
    set("approvalsCancelled", m.approvals.cancelled);
  }
  if (m.policy) {
    set("policyAllow", m.policy.allow);
    set("policyWarn", m.policy.warn);
    set("policyRequireApproval", m.policy.require_approval);
    set("policyDeny", m.policy.deny);
    set("policyUnavailable", m.policy.unavailable);
  }
  if (m.pullRequest) set("pullRequestDelivered", m.pullRequest.delivered ? 1 : 0);
  return TelemetryMeasuresSchema.parse(out);
}

const OUTCOME: Record<string, TelemetryEvent["outcome"]> = { succeeded: "ok", failed: "failed", cancelled: "cancelled" };

/**
 * Writes the one `run.measured` event of a run that ended (succeeded, failed or cancelled). Best effort: it never
 * throws and never changes the run. Call it after the evidence is final and the last cost is added.
 */
export function emitRunMeasured(run: RunSummary): void {
  try {
    if (!telemetryEnabled() || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return;
    const m = measureRun(run, readRunEvents(run.runDir, run.runId));
    const measures = runMeasuresTelemetry(m);
    const flow = FlowIdentitySchema.safeParse({ name: run.flow });
    const repository = repositoryOf(run.vars);
    emitTelemetry({
      version: TELEMETRY_VERSION,
      id: tmId(),
      time: new Date().toISOString(),
      kind: "run",
      name: "run.measured",
      runId: run.runId,
      ...(repository ? { repository } : {}),
      ...(flow.success ? { flow: flow.data } : {}),
      outcome: OUTCOME[run.status],
      ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
      measures,
    } as TelemetryEvent);
  } catch {
    // best effort
  }
}
