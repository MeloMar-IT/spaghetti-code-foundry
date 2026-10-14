// Epics: the expected finish as an honest range. Pure: numbers (or the model) in, a forecast out.
// No files, no clock (`now` is a parameter), no server. All times are instants; the time zone is the UI's job.
import { MIN_SAMPLES } from "../estimate.js";
import type { IssueRecord } from "../queue/issue-list.js";
import { buildChains } from "./chains.js";
import type { EpicStory, EpicsModel, StoryGroup } from "./model.js";

export const PACE_DAYS = 14;
export const BASE_WIDTH = 0.1, SPREAD_WEIGHT = 0.5, BUILT_WEIGHT = 0.5, MAX_WIDTH = 2;
export const CHAIN_DRIVER_SHARE = 0.5, SPLIT_DRIVER_FACTOR = 1.25;
const DAY = 86_400_000;

export type LeftOut = "usage-limits" | "answers";
export const LEAVES_OUT: readonly LeftOut[] = ["usage-limits", "answers"];
export const LEAVES_OUT_WORDS: Record<LeftOut, string> = { "usage-limits": "stops for usage limits", answers: "waiting for a person's answer" };

/** One 24-hour window ending at `to`; oldest first, the last ends at `now`. */
export interface PaceDay { from: string; to: string; done: number }
export type ForecastDriver =
  | { kind: "pace"; left: number; perDay: number }
  | { kind: "chain"; stories: number; storyMs: number }
  | { kind: "splits"; partsPerStory: number };
export type Forecast =
  | { kind: "finished" }
  | { kind: "too-early"; reason: "little-history" | "no-stories"; leavesOut: LeftOut[] }
  | {
      kind: "range"; earliest: string; expected: string; latest: string; drivers: ForecastDriver[]; leavesOut: LeftOut[];
      left: number; perDay: number; chain: number; partsPerStory: number;
    };

export interface ForecastInput {
  now: Date;
  /** Epic stories without split and dropped (Epic.total). */
  total: number;
  /** Epic.counts.done. */
  done: number;
  /** Not-done stories that are parts of a split story. */
  leftParts: number;
  /** Stories left in every other epic and in "No epic". */
  otherLeft: number;
  pace: readonly PaceDay[];
  /** EpicChains.criticalPath.remaining. */
  chain: number;
  /** From `medianRunMs` (story-building runs only). */
  medianStoryMs?: number;
  /** The split growth factor, at least 1. */
  partsPerStory: number;
}

const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** Done stories counted per 24-hour window: from < closedAt ≤ to. Bad or future times are ignored. */
export function paceDays(doneAt: readonly string[], now: Date, days = PACE_DAYS): PaceDay[] {
  const end = now.getTime();
  const out: PaceDay[] = [];
  for (let i = 0; i < days; i++) {
    const to = end - (days - 1 - i) * DAY;
    out.push({ from: new Date(to - DAY).toISOString(), to: new Date(to).toISOString(), done: 0 });
  }
  for (const at of doneAt) {
    const t = Date.parse(at);
    if (!Number.isFinite(t) || t > end || t <= end - days * DAY) continue;
    const back = Math.floor((end - t) / DAY) + 1; // t is in (end - back·DAY, end - (back-1)·DAY]
    out[days - back]!.done++;
  }
  return out;
}

/**
 * The split growth factor: stories of the epic per original story. A part is a story whose `partOf` names another
 * story of the same epic; a `partOf` that names the epic issue (or a story outside it) is plain membership.
 * Dropped stories are ignored.
 */
export function splitGrowth(stories: readonly EpicStory[]): { partsPerStory: number; leftParts: number } {
  const inEpic = new Set(stories.map((s) => s.issue));
  let originals = 0, parts = 0, split = 0, leftParts = 0;
  for (const s of stories) {
    if (s.state === "dropped") continue;
    if (s.partOf !== undefined && inEpic.has(s.partOf)) {
      parts++;
      if (s.state !== "done" && s.state !== "split") leftParts++;
    } else originals++;
    if (s.state === "split") split++;
  }
  const factor = originals > 0 ? Math.max(1, (originals + parts - split) / originals) : 1;
  return { partsPerStory: factor, leftParts };
}

export function forecastEpic(i: ForecastInput): Forecast {
  const total = num(i.total), done = num(i.done);
  const leavesOut = [...LEAVES_OUT];
  if (total > 0 && done >= total) return { kind: "finished" };
  if (total === 0) return { kind: "too-early", reason: "no-stories", leavesOut };
  const counts = i.pace.map((p) => num(p.done));
  const paceTotal = counts.reduce((a, b) => a + b, 0);
  if (counts.length === 0 || paceTotal < MIN_SAMPLES) return { kind: "too-early", reason: "little-history", leavesOut };

  const left = total - done;
  const leftParts = Math.min(left, num(i.leftParts));
  const otherLeft = num(i.otherLeft);
  const chain = num(i.chain);
  const factor = Number.isFinite(i.partsPerStory) && i.partsPerStory >= 1 ? i.partsPerStory : 1;
  const storyMs = num(i.medianStoryMs);

  const mean = paceTotal / counts.length;
  const epicPerDay = (mean * left) / (left + otherLeft);
  const grownLeft = leftParts + (left - leftParts) * factor;
  const paceMs = (grownLeft / epicPerDay) * DAY;
  const floorMs = chain * storyMs;
  // The uncertainty sits around the chain-adjusted duration, so a long chain does not erase it.
  const baseMs = Math.max(paceMs, floorMs);

  const sd = Math.sqrt(counts.reduce((a, c) => a + (c - mean) ** 2, 0) / counts.length);
  const doneShare = done / (done + grownLeft);
  const w = Math.min(MAX_WIDTH, BASE_WIDTH + SPREAD_WEIGHT * (sd / mean) + BUILT_WEIGHT * (1 - doneShare));

  const at = (ms: number) => new Date(i.now.getTime() + ms).toISOString();
  const pace: ForecastDriver = { kind: "pace", left, perDay: Math.round(epicPerDay * 10) / 10 };
  const chainDriver: ForecastDriver = { kind: "chain", stories: chain, storyMs };
  let drivers: ForecastDriver[];
  if (floorMs > 0 && floorMs >= paceMs) drivers = [chainDriver, pace];
  else {
    drivers = [pace];
    if (floorMs > 0 && floorMs >= CHAIN_DRIVER_SHARE * paceMs) drivers.push(chainDriver);
    else if (factor >= SPLIT_DRIVER_FACTOR) drivers.push({ kind: "splits", partsPerStory: factor });
  }
  return {
    kind: "range", earliest: at(Math.max(baseMs / (1 + w), floorMs)), expected: at(baseMs), latest: at(baseMs * (1 + w)),
    drivers, leavesOut, left, perDay: pace.perDay, chain, partsPerStory: factor,
  };
}

export interface EpicForecasts { pace: PaceDay[]; perDay: number; forecasts: Map<string, Forecast> }

/** The forecast of every epic of a model (keyed by Epic.key). `medianStoryMs` comes from `medianRunMs`. */
export function forecastEpics(model: EpicsModel, records: readonly IssueRecord[], o: { now: Date; medianStoryMs?: number }): EpicForecasts {
  const groups: StoryGroup[] = [...model.epics, model.noEpic];
  const doneAt = groups.flatMap((g) => g.stories.filter((s) => s.state === "done" && s.closedAt).map((s) => s.closedAt!));
  const pace = paceDays(doneAt, o.now);
  const perDay = pace.reduce((a, p) => a + p.done, 0) / (pace.length || 1);
  const leftOf = (g: StoryGroup) => g.total - g.counts.done;
  const allLeft = groups.reduce((a, g) => a + leftOf(g), 0);
  const forecasts = new Map<string, Forecast>();
  for (const e of model.epics) {
    const { partsPerStory, leftParts } = splitGrowth(e.stories);
    const finished = e.total > 0 && e.counts.done >= e.total;
    const input: ForecastInput = {
      now: o.now, total: e.total, done: e.counts.done, leftParts, otherLeft: allLeft - leftOf(e), pace, partsPerStory,
      chain: finished ? 0 : buildChains(e.stories, records).criticalPath.remaining,
    };
    if (o.medianStoryMs !== undefined) input.medianStoryMs = o.medianStoryMs;
    forecasts.set(e.key, forecastEpic(input));
  }
  return { pace, perDay, forecasts };
}
