import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { RunSummary } from "../engine/state.js";
import { MIN_VISITS, type Advice } from "./advise.js";
import { collect, type StepStats } from "./collect.js";
import { Override, type Overrides } from "./overrides.js";
import { EMPTY, modelOf, type Reference } from "./reference.js";

/** What a step did, as fractions: the numbers a trial is judged on. */
const Rates = z.object({ visits: z.number(), ok: z.number(), timeouts: z.number(), repaired: z.number(), changed: z.number() });
export type Rates = z.infer<typeof Rates>;

const When = z.string().refine((s) => !Number.isNaN(Date.parse(s)));

/** One change the analyst made by itself, and what came of it. */
const Trial = z.object({
  flow: z.string().min(1),
  step: z.string().min(1),
  direction: z.enum(["lower", "raise"]),
  reviewer: z.boolean(),
  /** The model and effort the step ran on before the change. */
  from: z.object({ model: z.string(), effort: z.string() }),
  to: Override,
  /** The override of this step before the trial, put back when the trial is reverted. */
  previous: Override.optional(),
  startedAt: When,
  baseline: Rates,
  status: z.enum(["running", "kept", "reverted"]),
  endedAt: When.optional(),
  result: Rates.optional(),
  why: z.string().optional(),
});
export type Trial = z.infer<typeof Trial>;

export interface Tuning {
  /** Whether the analyst may change models and efforts by itself. */
  auto: boolean;
  trials: Trial[];
}

export const EMPTY_TUNING: Tuning = { auto: false, trials: [] };
/** A trial without enough visits after this many days is reverted. */
export const TRIAL_MAX_DAYS = 7;
/** A reverted change is not tried again for this many days; a step is left alone this long after any trial. */
export const RETRY_DAYS = 30;
export const REST_DAYS = 3;
/** After this many visits a trial that is far worse is stopped at once. */
export const EARLY_VISITS = 8;
const DAY = 86_400_000;

/** The stored record. An entry that is cut off or edited into something else is dropped, so one bad entry never stops a check. */
export function loadTuning(path: string): Tuning {
  if (!existsSync(path)) return EMPTY_TUNING;
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as { auto?: unknown; trials?: unknown };
    const trials = (Array.isArray(t.trials) ? t.trials : []).flatMap((x) => {
      const r = Trial.safeParse(x);
      return r.success ? [r.data] : [];
    });
    return { auto: t.auto === true, trials };
  } catch {
    return EMPTY_TUNING;
  }
}

export function saveTuning(path: string, t: Tuning) {
  mkdirSync(dirname(path), { recursive: true });
  // the newest 200 ended trials are enough to explain what happened; a running or kept one owns an override and always stays
  const old = t.trials.filter((x) => x.status === "reverted");
  const cut = new Set(old.slice(0, Math.max(0, old.length - 200)));
  writeFileSync(path + ".tmp", JSON.stringify({ ...t, trials: t.trials.filter((x) => !cut.has(x)) }, null, 2));
  renameSync(path + ".tmp", path);
}

export function ratesOf(s: StepStats): Rates {
  const judged = Math.max(1, s.visits - s.limited);
  const ok = Math.max(1, s.ok);
  return { visits: s.visits - s.limited, ok: s.ok / judged, timeouts: s.timeouts / judged, repaired: s.fixed / ok, changed: s.changed / ok };
}

/** "effort medium" or a Claude model id: the only advice the analyst acts on by itself. */
export function parseTo(to: string): Override | undefined {
  const effort = /^effort (low|medium|high|xhigh|max)$/.exec(to)?.[1];
  if (effort) return { effort: effort as Override["effort"] };
  return /^claude-[a-z0-9.-]+$/.test(to) ? { model: to } : undefined;
}

const label = (o: Override) => [o.model, o.effort && `effort ${o.effort}`].filter(Boolean).join(", ");
const pc = (n: number) => `${Math.round(n * 100)}%`;

/** Why a finished trial is worse than before, or "" when it is not. */
function worse(t: Trial, r: Rates): string {
  const b = t.baseline;
  if (r.ok < b.ok - 0.05) return `it worked ${pc(r.ok)} of the time, before ${pc(b.ok)}`;
  if (r.repaired > b.repaired + 0.1) return `its work was repaired ${pc(r.repaired)} of the time, before ${pc(b.repaired)}`;
  if (r.timeouts > b.timeouts + 0.05) return `it ran into the time limit ${pc(r.timeouts)} of the time, before ${pc(b.timeouts)}`;
  // a review is only lowered when few of its reviews lead to a change, so the test is relative: half as many is worse
  if (t.reviewer && b.changed > 0 && r.changed < b.changed * 0.5) return `its reviews led to a change ${pc(r.changed)} of the time, before ${pc(b.changed)}`;
  if (!t.reviewer && r.changed > b.changed + 0.15) return `reviews sent its work back ${pc(r.changed)} of the time, before ${pc(b.changed)}`;
  return "";
}

const better = (t: Trial, r: Rates) => r.ok >= t.baseline.ok + 0.05 || r.repaired <= t.baseline.repaired - 0.1;

function setOverride(all: Overrides, flow: string, step: string, o: Override | undefined): Overrides {
  const steps = { ...(all[flow] ?? {}) };
  if (o && (o.model || o.effort)) steps[step] = o;
  else delete steps[step];
  const next = { ...all, [flow]: steps };
  if (!Object.keys(steps).length) delete next[flow];
  return next;
}

/** The override a trial sets: on top of the one before it, with what the flow itself said when there was none. */
const applied = (previous: Override | undefined, to: Override, own: { model: string; effort: string }): Override => ({ ...previous, ...to, ...(previous ? {} : { from: own }) });
/** The model and effort a trial ran on. */
const pairOf = (t: Trial) => ({ model: t.to.model ?? t.from.model, effort: t.to.effort ?? t.from.effort });

/**
 * The overrides as the tuning record says they should be. An override that no running or kept trial
 * owns is dropped: nothing would ever judge it or put it back. A running trial whose override is
 * missing (a check that stopped between the two files) gets it again.
 */
export function reconcile(overrides: Overrides, t: Tuning): Overrides {
  let out: Overrides = {};
  for (const [flow, steps] of Object.entries(overrides))
    for (const [step, o] of Object.entries(steps))
      if (t.trials.some((x) => x.flow === flow && x.step === step && x.status !== "reverted")) out = setOverride(out, flow, step, o);
  for (const x of t.trials) {
    if (x.status !== "running") continue;
    const now = out[x.flow]?.[x.step];
    const set = (!x.to.model || now?.model === x.to.model) && (!x.to.effort || now?.effort === x.to.effort);
    if (!set) out = setOverride(out, x.flow, x.step, applied(now ?? x.previous, x.to, x.from));
  }
  return out;
}

/** `events`: what changed at this check. `notes`: advice that was not tried, and why. */
export interface Tuned { tuning: Tuning; overrides: Overrides; events: string[]; notes: string[] }

/**
 * One round of self-tuning. First every running trial is judged on the visits since it started: kept,
 * reverted, or left to run. Then, for each flow without a running trial, the advice with the largest
 * token share is tried. One trial per flow at a time, so that the effect of a change can be told apart.
 */
export function tune(o: { tuning: Tuning; overrides: Overrides; advice: Advice[]; runs: RunSummary[]; now: Date; ref?: Reference }): Tuned {
  const events: string[] = [];
  const notes: string[] = [];
  const ref = o.ref ?? EMPTY;
  let overrides = o.overrides;
  const nowIso = o.now.toISOString();
  const trials = o.tuning.trials.map((t) => ({ ...t }));

  for (const t of trials.filter((t) => t.status === "running")) {
    const model = t.to.model ?? t.from.model;
    const effort = t.to.effort ?? t.from.effort;
    const since = collect(o.runs, o.now, { from: t.startedAt }).steps.find((s) => s.flow === t.flow && s.step === t.step && modelOf(s.agent) === model && s.effort === effort);
    const r = since ? ratesOf(since) : undefined;
    const name = `${t.flow} / ${t.step} on ${label(t.to)}`;
    let end: { status: "kept" | "reverted"; why: string } | undefined;
    if (r && r.visits >= EARLY_VISITS && r.ok <= t.baseline.ok - 0.25) end = { status: "reverted", why: `stopped early after ${r.visits} visits: it worked ${pc(r.ok)} of the time, before ${pc(t.baseline.ok)}` };
    else if (r && r.visits >= MIN_VISITS) {
      const bad = worse(t, r);
      if (bad) end = { status: "reverted", why: `after ${r.visits} visits ${bad}` };
      else if (t.direction === "raise" && !better(t, r)) end = { status: "reverted", why: `after ${r.visits} visits the higher level did not work better, so it is not worth its tokens` };
      else end = { status: "kept", why: `after ${r.visits} visits it ${t.direction === "raise" ? "works better" : "works as well as before"} (worked ${pc(r.ok)}, repaired ${pc(r.repaired)})` };
    } else if (o.now.getTime() - Date.parse(t.startedAt) > TRIAL_MAX_DAYS * DAY) end = { status: "reverted", why: `only ${r?.visits ?? 0} visits in ${TRIAL_MAX_DAYS} days: too few to judge` };
    if (!end) continue;
    Object.assign(t, { status: end.status, why: end.why, endedAt: nowIso, ...(r ? { result: r } : {}) });
    if (end.status === "reverted") overrides = setOverride(overrides, t.flow, t.step, t.previous);
    events.push(`${end.status === "kept" ? "Kept" : "Put back"}: ${name} — ${end.why}.`);
  }

  if (o.tuning.auto) {
    // advice is per step, model and effort; only the pair a step runs on now may be changed
    const current = new Map<string, Advice>();
    for (const a of o.advice) {
      // a pair the step only ran on as a router fallback is not what it is set to
      if (!a.stats.lastAt) continue;
      const k = `${a.flow}\u0000${a.step}`;
      if (!current.has(k) || a.stats.lastAt > current.get(k)!.stats.lastAt) current.set(k, a);
    }
    const busy = new Set(trials.filter((t) => t.status === "running").map((t) => t.flow));
    const candidates = [...current.values()].filter((a) => a.verdict === "lower" || a.verdict === "raise").sort((x, y) => y.share - x.share);
    for (const a of candidates) {
      if (busy.has(a.flow)) continue;
      const to = parseTo(a.to);
      if (!to) continue;
      const past = trials.filter((t) => t.flow === a.flow && t.step === a.step && t.endedAt);
      const age = (t: Trial) => (o.now.getTime() - Date.parse(t.endedAt!)) / DAY;
      if (past.some((t) => age(t) < REST_DAYS)) continue;
      if (past.some((t) => t.status === "reverted" && label(t.to) === label(to) && age(t) < RETRY_DAYS)) continue;
      const own = { model: modelOf(a.agent), effort: a.effort };
      // a trial that was put back and no visit since: the newest numbers are the trial's, not what the step runs on now
      if (past.some((t) => t.status === "reverted" && pairOf(t).model === own.model && pairOf(t).effort === own.effort && a.stats.lastAt <= t.endedAt!)) continue;
      const skip = (why: string) => void notes.push(`${a.flow} / ${a.step} on ${label(to)}: ${why}`);
      // the engine looks an override up by the sub-flow's own name, the runs are recorded under the parent flow
      if (a.stats.parent) { skip("the step is inside a sub-flow, where the analyst only advises"); continue; }
      // a review that never led to a change cannot do worse on that, so nothing could put the trial back
      if (a.stats.reviewer && a.stats.changed === 0) { skip("none of these reviews led to a change, so a trial could not be judged"); continue; }
      // the model id is made from the name of the current one: without a published figure for it, it may not exist
      if (to.model && !ref.figures.some((f) => f.model.toLowerCase() === to.model)) { skip("no published figure names this model, so it is not known to exist"); continue; }
      const previous = overrides[a.flow]?.[a.step];
      const next = applied(previous, to, own);
      if (next.from && (next.model ?? next.from.model) === next.from.model && (next.effort ?? next.from.effort) === next.from.effort) { skip("that is what the flow itself says; `scf analyst reset` puts the step back to it"); continue; }
      overrides = setOverride(overrides, a.flow, a.step, next);
      trials.push({
        flow: a.flow, step: a.step, direction: a.verdict as "lower" | "raise", reviewer: a.stats.reviewer,
        from: own, to, ...(previous ? { previous } : {}),
        startedAt: nowIso, baseline: ratesOf(a.stats), status: "running",
      });
      busy.add(a.flow);
      events.push(`Trying: ${a.flow} / ${a.step} on ${label(to)} (was ${modelOf(a.agent)}${a.effort ? `, effort ${a.effort}` : ""}). ${a.why}`);
    }
  }
  return { tuning: { auto: o.tuning.auto, trials }, overrides, events, notes };
}

/**
 * Stop everything the analyst changed: no overrides, running and kept trials marked as put back.
 * Kept ones too, so that the same change is not started again at the next check.
 */
export function resetTuning(t: Tuning, now: Date): Tuning {
  return { auto: t.auto, trials: t.trials.map((x) => (x.status !== "reverted" ? { ...x, status: "reverted" as const, endedAt: now.toISOString(), why: "reset by hand" } : x)) };
}

/** The part of the report about the analyst's own changes. */
export function tuningSection(t: Tuning, overrides: Overrides, events: string[], notes: string[] = []): string[] {
  const out = ["## What the analyst changed", ""];
  out.push(t.auto ? "Self-tuning is on: the analyst tries one change per flow at a time and puts it back when the step does worse." : "Self-tuning is off (`scf analyst auto on`). The analyst only advises.", "");
  if (events.length) out.push("This check:", ...events.map((e) => `- ${e}`), "");
  const set = Object.entries(overrides).flatMap(([flow, steps]) => Object.entries(steps).map(([step, o]) => `- ${flow} / ${step}: ${label(o)}${t.trials.some((x) => x.status === "running" && x.flow === flow && x.step === step) ? " (on trial)" : ""}`));
  if (set.length) out.push("Set now:", ...set, "");
  if (notes.length) out.push("Advice not tried by itself:", ...notes.map((n) => `- ${n}.`), "");
  const ended = t.trials.filter((x) => x.endedAt).slice(-10).reverse();
  if (ended.length) out.push("Earlier trials:", ...ended.map((x) => `- ${x.endedAt!.slice(0, 10)} ${x.flow} / ${x.step} on ${label(x.to)}: ${x.status === "kept" ? "kept" : "put back"} — ${x.why}.`), "");
  return out;
}
