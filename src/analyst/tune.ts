import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RunSummary } from "../engine/state.js";
import { MIN_VISITS, type Advice } from "./advise.js";
import { collect, type StepStats } from "./collect.js";
import type { Override, Overrides } from "./overrides.js";
import { modelOf } from "./reference.js";

/** What a step did, as fractions: the numbers a trial is judged on. */
export interface Rates { visits: number; ok: number; timeouts: number; repaired: number; changed: number }

/** One change the analyst made by itself, and what came of it. */
export interface Trial {
  flow: string;
  step: string;
  direction: "lower" | "raise";
  reviewer: boolean;
  /** The model and effort before the change. */
  from: { model: string; effort: string };
  to: Override;
  /** The override of this step before the trial, put back when the trial is reverted. */
  previous?: Override;
  startedAt: string;
  baseline: Rates;
  status: "running" | "kept" | "reverted";
  endedAt?: string;
  result?: Rates;
  why?: string;
}

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

export function loadTuning(path: string): Tuning {
  if (!existsSync(path)) return EMPTY_TUNING;
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as Tuning;
    return { auto: t.auto === true, trials: Array.isArray(t.trials) ? t.trials : [] };
  } catch {
    return EMPTY_TUNING;
  }
}

export function saveTuning(path: string, t: Tuning) {
  mkdirSync(dirname(path), { recursive: true });
  // the newest 200 trials are enough to explain what happened
  writeFileSync(path + ".tmp", JSON.stringify({ ...t, trials: t.trials.slice(-200) }, null, 2));
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
  if (t.reviewer && r.changed < b.changed - 0.15) return `its reviews led to a change ${pc(r.changed)} of the time, before ${pc(b.changed)}`;
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

export interface Tuned { tuning: Tuning; overrides: Overrides; events: string[] }

/**
 * One round of self-tuning. First every running trial is judged on the visits since it started: kept,
 * reverted, or left to run. Then, for each flow without a running trial, the advice with the largest
 * token share is tried. One trial per flow at a time, so that the effect of a change can be told apart.
 */
export function tune(o: { tuning: Tuning; overrides: Overrides; advice: Advice[]; runs: RunSummary[]; now: Date }): Tuned {
  const events: string[] = [];
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
      const previous = overrides[a.flow]?.[a.step];
      overrides = setOverride(overrides, a.flow, a.step, { ...previous, ...to });
      trials.push({
        flow: a.flow, step: a.step, direction: a.verdict as "lower" | "raise", reviewer: a.stats.reviewer,
        from: { model: modelOf(a.agent), effort: a.effort }, to, ...(previous ? { previous } : {}),
        startedAt: nowIso, baseline: ratesOf(a.stats), status: "running",
      });
      busy.add(a.flow);
      events.push(`Trying: ${a.flow} / ${a.step} on ${label(to)} (was ${modelOf(a.agent)}${a.effort ? `, effort ${a.effort}` : ""}). ${a.why}`);
    }
  }
  return { tuning: { auto: o.tuning.auto, trials }, overrides, events };
}

/** Stop everything the analyst changed: no overrides, running trials marked as put back. */
export function resetTuning(t: Tuning, now: Date): Tuning {
  return { auto: t.auto, trials: t.trials.map((x) => (x.status === "running" ? { ...x, status: "reverted" as const, endedAt: now.toISOString(), why: "reset by hand" } : x)) };
}

/** The part of the report about the analyst's own changes. */
export function tuningSection(t: Tuning, overrides: Overrides, events: string[]): string[] {
  const out = ["## What the analyst changed", ""];
  out.push(t.auto ? "Self-tuning is on: the analyst tries one change per flow at a time and puts it back when the step does worse." : "Self-tuning is off (`scf analyst auto on`). The analyst only advises.", "");
  if (events.length) out.push("This check:", ...events.map((e) => `- ${e}`), "");
  const set = Object.entries(overrides).flatMap(([flow, steps]) => Object.entries(steps).map(([step, o]) => `- ${flow} / ${step}: ${label(o)}${t.trials.some((x) => x.status === "running" && x.flow === flow && x.step === step) ? " (on trial)" : ""}`));
  if (set.length) out.push("Set now:", ...set, "");
  const ended = t.trials.filter((x) => x.endedAt).slice(-10).reverse();
  if (ended.length) out.push("Earlier trials:", ...ended.map((x) => `- ${x.endedAt!.slice(0, 10)} ${x.flow} / ${x.step} on ${label(x.to)}: ${x.status === "kept" ? "kept" : "put back"} — ${x.why}.`), "");
  return out;
}
