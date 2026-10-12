import type { Collected, StepStats } from "./collect.js";
import { modelOf, trustedPair, type Reference } from "./reference.js";

export type Verdict = "lower" | "raise" | "time" | "watch" | "keep" | "few";

export interface Advice {
  flow: string;
  step: string;
  agent: string;
  effort: string;
  verdict: Verdict;
  /** What to try, e.g. "effort medium" or "claude-haiku-5-5"; "" for keep, watch and few. */
  to: string;
  why: string;
  /** Share of all tokens in the window this step used (0-1): where a change pays off most. */
  share: number;
  stats: StepStats;
}

/** A step needs this many visits before the analyst says anything about it. */
export const MIN_VISITS = 20;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const TIERS = ["haiku", "sonnet", "opus"];

const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 0);

/** The next model level of the same maker and version, or "" when the name tells no level. */
export function stepModel(model: string, dir: 1 | -1): string {
  const i = TIERS.findIndex((t) => model.includes(t));
  const to = TIERS[i + dir];
  return i < 0 || !to ? "" : model.replace(TIERS[i]!, to);
}

function stepEffort(effort: string, dir: 1 | -1): string {
  const i = EFFORTS.indexOf(effort);
  return i < 0 ? "" : (EFFORTS[i + dir] ?? "");
}

/** What the published figures say about swapping `from` for `to`: a sentence, and whether they speak against it. */
function published(ref: Reference, from: string, to: string, light: boolean): { text: string; against: boolean } {
  const pair = trustedPair(ref, from, to, "agentic-coding");
  if (!pair) return { text: "No published figure for both models on the same test was found, so this rests on your own runs only.", against: false };
  const [a, b] = pair;
  const ratio = b.value / a.value;
  const basis = a.basis === "independent" && b.basis === "independent" ? "independent runs" : "makers' figures, lowered by a tenth";
  const text = `Published scores on ${a.test || "agentic coding"} (${basis}): ${to} ${b.value.toFixed(0)}, ${from} ${a.value.toFixed(0)}.`;
  // light work (short, small output) does not need the top score; heavy work does
  return { text, against: ratio < (light ? 0.5 : 0.85) };
}

function adviseStep(s: StepStats, ref: Reference, share: number): Advice {
  const base = { flow: s.flow, step: s.step, agent: s.agent, effort: s.effort, share, stats: s };
  // a visit stopped by a usage limit says nothing about the model, so it does not count
  const judged = s.visits - s.limited;
  if (judged < MIN_VISITS) return { ...base, verdict: "few", to: "", why: `Only ${judged} visits in the window${s.limited ? ` (not counting ${s.limited} stopped by a usage limit)` : ""}; ${MIN_VISITS} are needed for advice.` };

  const failed = judged - s.ok - s.timeouts;
  const okRate = judged ? s.ok / judged : 1;
  const model = modelOf(s.agent);
  const avgMin = s.minutes / s.visits;
  const avgOut = s.outputTokens / s.visits;
  const light = avgMin <= 5 && avgOut <= 8000;
  const repaired = s.ok ? s.fixed / s.ok : 0;
  const changed = s.ok ? s.changed / s.ok : 0;

  if (s.timeouts / judged >= 0.05)
    return {
      ...base, verdict: "time", to: s.limitSec ? `a limit above ${Math.round(s.limitSec / 60)} minutes, or smaller work` : "a longer limit, or smaller work",
      why: `${pct(s.timeouts, judged)}% of the visits ran into the time limit (average ${avgMin.toFixed(0)} minutes). That is a limit or size problem before it is a model problem: a stronger model is usually slower.`,
    };

  if (s.recent.visits >= 10 && okRate - s.recent.ok / s.recent.visits >= 0.15)
    return { ...base, verdict: "watch", to: "", why: `Worked ${pct(s.ok, judged)}% of the time over the window but ${pct(s.recent.ok, s.recent.visits)}% in the last days. Look at what changed: the model, the flow or the work.` };

  // failure comes first, also for a review: a review that fails finds nothing, and that is not a reason to lower it
  if (failed / judged >= 0.15 || (!s.reviewer && repaired >= 0.4)) {
    const up = stepEffort(s.effort, 1) && s.effort !== "xhigh" ? `effort ${stepEffort(s.effort, 1)}` : stepModel(model, 1);
    const why = s.reviewer ? `Failed ${pct(failed, judged)}% of the time.` : `Failed ${pct(failed, judged)}% of the time and its work needed a repair step ${pct(s.fixed, s.ok)}% of the time.`;
    return up ? { ...base, verdict: "raise", to: up, why } : { ...base, verdict: "watch", to: "", why: `${why} ${EFFORTS.includes(s.effort) || TIERS.some((t) => model.includes(t)) ? "It already runs on the highest level" : "No higher level is known for it"}, so look at the prompt and the size of the work.` };
  }

  if (s.reviewer) {
    // a review that almost never leads to a change costs tokens and finds nothing; one that does not work reliably is not lowered
    if (changed <= 0.1 && okRate >= 0.97) {
      const to = stepEffort(s.effort, -1) ? `effort ${stepEffort(s.effort, -1)}` : stepModel(model, -1) || "a lower effort or a smaller model";
      return { ...base, verdict: "lower", to, why: `Only ${pct(s.changed, s.ok)}% of these reviews led to a change, at ${Math.round(s.inputTokens / s.visits / 1000)}k input tokens each.` };
    }
    if (changed <= 0.1) return { ...base, verdict: "keep", to: "", why: `Only ${pct(s.changed, s.ok)}% of these reviews led to a change, but the step works ${pct(s.ok, judged)}% of the time: a lower level is advised only from 97%.` };
    return { ...base, verdict: "keep", to: "", why: `${pct(s.changed, s.ok)}% of these reviews led to a change, so the review earns its tokens.` };
  }

  const steady = okRate >= 0.97 && repaired <= 0.1 && (light || changed <= 0.15);
  if (steady) {
    const lowerEffort = stepEffort(s.effort, -1);
    if (lowerEffort && EFFORTS.indexOf(s.effort) >= EFFORTS.indexOf("high"))
      return { ...base, verdict: "lower", to: `effort ${lowerEffort}`, why: `Works ${pct(s.ok, judged)}% of the time and its work is rarely repaired or sent back (${pct(s.fixed + s.changed, s.ok)}%).` };
    const down = stepModel(model, -1);
    if (down) {
      const p = published(ref, model, down, light);
      if (!p.against)
        return { ...base, verdict: "lower", to: down, why: `Works ${pct(s.ok, judged)}% of the time, ${light ? "the work is short and small, " : ""}and it is rarely repaired (${pct(s.fixed, s.ok)}%). ${p.text}` };
      return { ...base, verdict: "keep", to: "", why: `Works ${pct(s.ok, judged)}% of the time. A lower level is not advised: ${p.text}` };
    }
  }
  return { ...base, verdict: "keep", to: "", why: `Works ${pct(s.ok, judged)}% of the time; repaired ${pct(s.fixed, s.ok)}%, sent back by review ${pct(s.changed, s.ok)}%.` };
}

const ORDER: Verdict[] = ["raise", "time", "watch", "lower", "keep", "few"];

/** Advice per step, the ones that ask for a change first, and within those the biggest token users first. */
export function advise(c: Collected, ref: Reference): Advice[] {
  return c.steps
    .map((s) => adviseStep(s, ref, c.totalTokens ? (s.inputTokens + s.outputTokens) / c.totalTokens : 0))
    .sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || b.share - a.share);
}
