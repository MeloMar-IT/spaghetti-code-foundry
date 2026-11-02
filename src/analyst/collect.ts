import { isTimedOut } from "../errors.js";
import type { RunSummary, StepRecord } from "../engine/state.js";

/** What the analyst knows about one agent step on one model, over the window. */
export interface StepStats {
  flow: string;
  step: string;
  /** The target as the run recorded it, e.g. "claude:anthropic:claude-sonnet-5-5" or "codex:openai". */
  agent: string;
  /** The effort the flow set for the step; "" when the tool's own default applied. */
  effort: string;
  reviewer: boolean;
  /** Seconds the flow allows for the step; 0 when unknown. */
  limitSec: number;
  visits: number;
  ok: number;
  timeouts: number;
  /** Stopped by a usage limit or an unreachable service: says nothing about the model. */
  limited: number;
  minutes: number;
  inputTokens: number;
  outputTokens: number;
  /** Visits where the next agent step repaired this step's work (`fix_*`). */
  fixed: number;
  /** Visits where a review led to changes (`address_*` or `revise_*` came next). */
  changed: number;
  /** The same numbers for the last `recentDays` only, to see a model getting better or worse. */
  recent: { visits: number; ok: number };
  /**
   * When the step last ran on this model and effort as its own choice: the newest pair of a step is
   * what it runs on now. Visits that ran on a router fallback after a limit do not count; "" when
   * there are no others.
   */
  lastAt: string;
  /** Set for a step inside a sub-flow, e.g. "build": its id carries that prefix ("build/implement"). */
  parent?: string;
}

export interface Collected {
  from: string;
  to: string;
  runs: number;
  steps: StepStats[];
  totalTokens: number;
}

/** A step inside a sub-flow is recorded as "build/fix_tests": what it does is told by the last part. */
const bare = (id: string) => id.slice(id.lastIndexOf("/") + 1);
export const isReview = (id: string) => /review/.test(bare(id)) && !/^(address|revise|fix)_/.test(bare(id));
const isFix = (id: string) => /^fix_/.test(bare(id));
const isChange = (id: string) => /^(address|revise)_/.test(bare(id));
const isAgent = (h: StepRecord) => h.agent !== undefined && h.type !== "shell" && h.type !== "approval";

interface FlowStep { id: string; effort?: string; timeout_sec?: number; skill_role?: string }

/** Per step and model: how often it worked, what it used, and how often its work had to be repaired. */
export function collect(runs: RunSummary[], now: Date, o: { days?: number; recentDays?: number; from?: string } = {}): Collected {
  const days = o.days ?? 14;
  const from = o.from ?? new Date(now.getTime() - days * 86_400_000).toISOString();
  const recentFrom = new Date(now.getTime() - (o.recentDays ?? 2) * 86_400_000).toISOString();
  const byKey = new Map<string, StepStats>();
  let counted = 0;
  for (const run of runs) {
    const history = (run.history ?? []).filter(isAgent);
    if (!history.some((h) => h.startedAt >= from)) continue;
    counted++;
    const def = run.flowDef as unknown as { defaults?: { effort?: string; timeout_sec?: number }; steps?: FlowStep[] } | undefined;
    const flowSteps = new Map((def?.steps ?? []).map((s) => [s.id, s]));
    history.forEach((h, i) => {
      if (h.startedAt < from) return;
      // the stored flow is the parent's: it does not hold the steps of a sub-flow
      const fs = h.parent ? undefined : flowSteps.get(h.id);
      const effort = h.effort ?? fs?.effort ?? def?.defaults?.effort ?? "";
      const key = [run.flow, h.id, h.agent, effort].join("\u0000");
      let s = byKey.get(key);
      if (!s) {
        s = {
          flow: run.flow, step: h.id, agent: h.agent!, effort, reviewer: fs?.skill_role === "reviewer" || isReview(h.id),
          limitSec: fs?.timeout_sec ?? def?.defaults?.timeout_sec ?? 0,
          visits: 0, ok: 0, timeouts: 0, limited: 0, minutes: 0, inputTokens: 0, outputTokens: 0, fixed: 0, changed: 0, recent: { visits: 0, ok: 0 }, lastAt: "",
          ...(h.parent ? { parent: h.parent } : {}),
        };
        byKey.set(key, s);
      }
      s.visits++;
      // a visit that ended on a router fallback says what the step fell back to, not what it is set to
      if (!h.retried?.models && h.startedAt > s.lastAt) s.lastAt = h.startedAt;
      if (h.ok) s.ok++;
      if (isTimedOut(h.error)) s.timeouts++;
      if (h.limited || h.unreachable) s.limited++;
      s.minutes += h.durationMs / 60_000;
      s.inputTokens += h.tokens?.input ?? 0;
      s.outputTokens += h.tokens?.output ?? 0;
      // a visit stopped by a usage limit says nothing about the model, so it is not in the recent rate
      if (h.startedAt >= recentFrom && !(h.limited || h.unreachable)) {
        s.recent.visits++;
        if (h.ok) s.recent.ok++;
      }
      if (!h.ok) return;
      // What came after tells how good the work was. A worker's result is judged past the review of it.
      let next = history[i + 1];
      if (next && isFix(next.id)) return void s.fixed++;
      if (!s.reviewer && next && isReview(next.id)) next = history[i + 2];
      if (next && isChange(next.id)) s.changed++;
    });
  }
  const steps = [...byKey.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  return { from, to: now.toISOString(), runs: counted, steps, totalTokens: steps.reduce((n, s) => n + s.inputTokens + s.outputTokens, 0) };
}
