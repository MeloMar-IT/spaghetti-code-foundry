// Epics: the answers of the two epic routes. Pure: the saved records, the state of each story and `now` in, rows out.
// No server, no GitHub, no files (the route reads and saves them).
import { columnOf } from "../board.js";
import { MIN_SAMPLES, span as durationText } from "../estimate.js";
import type { NextStep } from "../next-step.js";
import type { RepoIssueList } from "../queue/issue-list.js";
import { LABEL_WORDS, statusHelp } from "../words.js";
import { buildChains, type EpicChains } from "./chains.js";
import { forecastEpics, LEAVES_OUT_WORDS, PACE_DAYS, type Forecast, type ForecastDriver, type PaceDay } from "./forecast.js";
import { type RepoForecasts, type StoredForecast } from "./forecast-store.js";
import {
  buildEpics, growthText, NOT_HANDED, STATE_WORDS, type DayPoint, type Epic, type EpicStory, type Growth, type RunState, type StoryGroup, type StoryState,
} from "./model.js";

export interface EpicsViewInput {
  /** The watcher's spelling of the repository. */
  repo: string;
  /** Undefined: no data. */
  list?: RepoIssueList;
  watched: boolean;
  /** Labels that hand a story to the Foundry. */
  labels: string[];
  doneLabels: string[];
  /** The record of each open tracked story. */
  states: ReadonlyMap<number, NextStep>;
  medianStoryMs?: number;
  stored?: RepoForecasts;
  now: Date;
}

export type EpicsData =
  | { state: "fresh"; readAt: string; cut: boolean; ageMs: number }
  | { state: "no-data"; why: "no-watcher" | "not-read-yet"; text: string };
export const NO_DATA_WORDS: Record<"no-watcher" | "not-read-yet", string> = {
  "no-watcher": "No data: no watcher checks the issues of this repository",
  "not-read-yet": "No data yet: the watcher has not read the issues of this repository",
};

export type HoldUpKind = "person" | "failed" | "limit" | "no-slot" | "not-handed";
/** Stories that are held up for the same reason, in the app's words. */
export interface HoldUp { kind: HoldUpKind; issues: number[]; status: string; help: string; waiting?: number[] }

export type ForecastView =
  | { kind: "finished" }
  | { kind: "too-early"; reason: "little-history" | "no-stories"; text: string; leavesOut: string[] }
  | { kind: "range"; earliest: string; expected: string; latest: string; drivers: ForecastDriver[]; text: string; leavesOut: string[] };

export interface EpicRow {
  /** What the detail route takes: "12", or "l-…" for a label epic. */
  id: string;
  key: string; issue?: number; title: string;
  counts: Record<StoryState, number>; total: number; notHanded: number;
  growth: Growth; growthText: string; startedAt?: string;
  finished: boolean; finishedAt?: string; tookMs?: number;
  forecast: ForecastView; holdUps: HoldUp[];
}
export interface NoEpicRow { title: string; counts: Record<StoryState, number>; total: number; notHanded: number; holdUps: HoldUp[] }
export interface EpicsList { repo: string; data: EpicsData; epics: EpicRow[]; noEpic?: NoEpicRow }

export interface StoryView {
  issue: number; title: string; state: StoryState; words: string; createdAt: string; closedAt?: string;
  partOf?: number; notHanded?: true; status?: string; help?: string;
}
export interface EpicDetail {
  repo: string; data: EpicsData; epic: EpicRow | null;
  stories: StoryView[]; chains: EpicChains | null; series: DayPoint[];
  pace: { perDay: number; days: PaceDay[] }; medianStoryMs?: number; history: StoredForecast[];
}

/** What the Foundry is doing with a story, from its record; the same classification as the board. */
export function runStateOf(next: NextStep): RunState | undefined {
  switch (columnOf(next)) {
    case "failed": return "failed";
    case "your_turn": return "your_turn";
    case "planning": case "coding": case "reviewing": case "merging": return "working";
    default: return undefined;
  }
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const upper = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function driverText(d: ForecastDriver): string {
  switch (d.kind) {
    case "pace": return `${d.left} ${plural(d.left, "story", "stories")} left at about ${d.perDay} a day`;
    case "chain": return `a chain of ${d.stories} ${plural(d.stories, "story", "stories")} that are built one after another, about ${durationText(d.storyMs)} each`;
    case "splits": return `stories are split into about ${d.partsPerStory.toFixed(1)} parts each`;
  }
}

/** The reason of a forecast in words. A finished epic has none. */
export function forecastText(f: Forecast): string {
  switch (f.kind) {
    case "finished": return "";
    case "too-early": return f.reason === "no-stories"
      ? "Too early to say: the epic has no stories yet"
      : `Too early to say: fewer than ${MIN_SAMPLES} stories were finished in the last ${PACE_DAYS} days`;
    case "range": return upper(f.drivers.map(driverText).join("; "));
  }
}

function forecastView(f: Forecast): ForecastView {
  if (f.kind === "finished") return { kind: "finished" };
  const leavesOut = f.leavesOut.map((l) => LEAVES_OUT_WORDS[l]);
  if (f.kind === "too-early") return { kind: "too-early", reason: f.reason, text: forecastText(f), leavesOut };
  return { kind: "range", earliest: f.earliest, expected: f.expected, latest: f.latest, drivers: f.drivers, text: forecastText(f), leavesOut };
}

/** The id of an epic in a URL: the issue number, or "l-" and the base64url of the label key (a label can hold "/" or "%"). */
export const epicIdOf = (key: string): string => (key.startsWith("#") ? key.slice(1) : `l-${Buffer.from(key, "utf8").toString("base64url")}`);

/** The key of an id: "12" or "#12" → "#12"; "l-…" → "label:name"; anything else: undefined. */
export function epicKeyOf(param: string): string | undefined {
  const n = /^#?([1-9]\d{0,9})$/.exec(param);
  if (n) return `#${n[1]}`;
  const l = /^l-([A-Za-z0-9_-]{1,400})$/.exec(param);
  if (!l) return undefined;
  const key = Buffer.from(l[1]!, "base64url").toString("utf8");
  return /^label:.{1,200}$/.test(key) && epicIdOf(key) === param ? key : undefined;
}

const LIMIT_KINDS = new Set<NextStep["kind"]>(["usage_limit", "daily_budget", "user_limit"]);

/**
 * What holds the open stories up now. A story is in one hold-up only; stories with the same words are grouped.
 * Done, split and dropped stories hold nothing up. `chains` (the epic's) gives the stories that wait for a failed one.
 */
export function holdUps(stories: readonly EpicStory[], states: ReadonlyMap<number, NextStep>, chains?: EpicChains): HoldUp[] {
  const groups = new Map<string, HoldUp>();
  const add = (kind: HoldUpKind, issue: number, status: string, help: string) => {
    const k = `${kind}\n${status}\n${help}`;
    const g = groups.get(k) ?? groups.set(k, { kind, issues: [], status, help }).get(k)!;
    g.issues.push(issue);
  };
  for (const s of [...stories].sort((a, b) => a.issue - b.issue)) {
    if (s.state === "done" || s.state === "split" || s.state === "dropped") continue;
    const rec = states.get(s.issue);
    if (s.state === "your_turn") add("person", s.issue, rec?.status ?? STATE_WORDS.your_turn, rec?.help ?? "");
    else if (s.state === "failed") add("failed", s.issue, rec?.status ?? STATE_WORDS.failed, rec?.help ?? statusHelp("failed"));
    else if (s.notHanded) add("not-handed", s.issue, NOT_HANDED, LABEL_WORDS.trigger);
    else if (rec && LIMIT_KINDS.has(rec.kind)) add("limit", s.issue, rec.status, rec.help);
    else if (rec?.kind === "queued") add("no-slot", s.issue, rec.status, rec.help);
  }
  const out = [...groups.values()];
  if (chains) {
    const dependents = new Map<number, number[]>(); // story → the nodes that depend on it
    for (const n of chains.nodes) for (const d of n.dependsOn) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(n.issue);
    const open = new Set(chains.nodes.filter((n) => !n.done).map((n) => n.issue));
    for (const h of out) {
      if (h.kind !== "failed") continue;
      const seen = new Set<number>(), todo = [...h.issues];
      while (todo.length) for (const d of dependents.get(todo.pop()!) ?? []) if (!seen.has(d)) { seen.add(d); todo.push(d); }
      h.waiting = [...seen].filter((n) => open.has(n) && !h.issues.includes(n)).sort((a, b) => a - b);
    }
  }
  const order: HoldUpKind[] = ["person", "failed", "limit", "no-slot", "not-handed"];
  return out.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.issues[0]! - b.issues[0]!);
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

interface Prepared {
  data: EpicsData;
  epics: Epic[]; noEpic?: StoryGroup;
  forecasts: Map<string, Forecast>;
  pace: PaceDay[]; perDay: number;
  chains: Map<string, EpicChains>;
}

function dataOf(i: EpicsViewInput): EpicsData {
  if (!i.list) return { state: "no-data", why: i.watched ? "not-read-yet" : "no-watcher", text: NO_DATA_WORDS[i.watched ? "not-read-yet" : "no-watcher"] };
  return { state: "fresh", readAt: i.list.readAt, cut: i.list.cut, ageMs: Math.max(0, i.now.getTime() - Date.parse(i.list.readAt)) };
}

function prepare(i: EpicsViewInput): Prepared {
  const data = dataOf(i);
  if (!i.list) return { data, epics: [], forecasts: new Map(), pace: [], perDay: 0, chains: new Map() };
  const states = new Map<number, RunState>();
  for (const [n, rec] of i.states) {
    const s = runStateOf(rec);
    if (s) states.set(n, s);
  }
  const model = buildEpics(i.list.issues, { labels: i.labels, doneLabels: i.doneLabels, states, now: i.now });
  const f = forecastEpics(model, i.list.issues, { now: i.now, ...(i.medianStoryMs !== undefined ? { medianStoryMs: i.medianStoryMs } : {}) });
  const chains = new Map(model.epics.map((e) => [e.key, buildChains(e.stories, i.list!.issues)]));
  return { data, epics: model.epics, noEpic: model.noEpic, forecasts: f.forecasts, pace: f.pace, perDay: f.perDay, chains };
}

function rowOf(e: Epic, p: Prepared, states: ReadonlyMap<number, NextStep>): EpicRow {
  const row: EpicRow = {
    id: epicIdOf(e.key), key: e.key, title: e.title, counts: e.counts, total: e.total, notHanded: e.notHanded,
    growth: e.growth, growthText: growthText(e.growth), finished: e.finished,
    forecast: forecastView(p.forecasts.get(e.key) ?? { kind: "finished" }), holdUps: e.finished ? [] : holdUps(e.stories, states, p.chains.get(e.key)),
  };
  if (e.issue !== undefined) row.issue = e.issue;
  if (e.startedAt) row.startedAt = e.startedAt;
  if (e.finishedAt) row.finishedAt = e.finishedAt;
  if (e.tookMs !== undefined) row.tookMs = e.tookMs;
  return row;
}

/** Open epics by expected finish (too early ones after them), finished epics last, the newest finish first. */
function sorted(rows: EpicRow[]): EpicRow[] {
  const rank = (r: EpicRow) => (r.finished ? 2 : r.forecast.kind === "range" ? 0 : 1);
  const at = (r: EpicRow) => (r.forecast.kind === "range" ? Date.parse(r.forecast.expected) : r.finishedAt ? -Date.parse(r.finishedAt) : 0);
  return rows.map((r, n) => ({ r, n })).sort((a, b) => rank(a.r) - rank(b.r) || at(a.r) - at(b.r) || a.n - b.n).map((x) => x.r);
}

/** The forecasts that are not stored for today (finished epics have none to save). */
function dueOf(i: EpicsViewInput, p: Prepared): Map<string, Forecast> {
  const day = utcDay(i.now);
  const due = new Map<string, Forecast>();
  for (const [key, f] of p.forecasts) {
    if (f.kind === "finished") continue;
    if (!(i.stored?.epics[key] ?? []).some((e) => e.day === day)) due.set(key, f);
  }
  return due;
}

export function epicsView(i: EpicsViewInput): { answer: EpicsList; save: Map<string, Forecast> } {
  const p = prepare(i);
  const answer: EpicsList = { repo: i.repo, data: p.data, epics: sorted(p.epics.map((e) => rowOf(e, p, i.states))) };
  if (p.noEpic) {
    const g = p.noEpic;
    answer.noEpic = { title: g.title, counts: g.counts, total: g.total, notHanded: g.notHanded, holdUps: holdUps(g.stories, i.states) };
  }
  return { answer, save: dueOf(i, p) };
}

/** One epic; undefined when there is data but no such epic. */
export function epicView(i: EpicsViewInput, key: string): { answer: EpicDetail; save: Map<string, Forecast> } | undefined {
  const p = prepare(i);
  const empty: EpicDetail = { repo: i.repo, data: p.data, epic: null, stories: [], chains: null, series: [], pace: { perDay: 0, days: [] }, history: [] };
  if (!i.list) return { answer: empty, save: new Map() };
  const e = p.epics.find((x) => x.key === key);
  if (!e) return undefined;
  const chains = p.chains.get(key)!;
  const byIssue = new Map(e.stories.map((s) => [s.issue, s]));
  const ordered = [...chains.order, ...e.stories.filter((s) => !chains.order.includes(s.issue)).map((s) => s.issue)];
  const stories: StoryView[] = ordered.flatMap((n) => {
    const s = byIssue.get(n);
    if (!s) return [];
    const v: StoryView = { issue: s.issue, title: s.title, state: s.state, words: STATE_WORDS[s.state], createdAt: s.createdAt };
    if (s.closedAt) v.closedAt = s.closedAt;
    if (s.partOf !== undefined) v.partOf = s.partOf;
    if (s.notHanded) v.notHanded = true;
    const rec = s.state === "done" || s.state === "split" || s.state === "dropped" ? undefined : i.states.get(s.issue);
    if (s.notHanded) { v.status = NOT_HANDED; v.help = LABEL_WORDS.trigger; }
    else if (rec) { v.status = rec.status; v.help = rec.help; }
    return [v];
  });
  const save = dueOf(i, p);
  // Only what is stored: the route saves the missing day and then asks again, so the answer never shows a day that was not saved.
  const history = [...(i.stored?.epics[key] ?? [])];
  const answer: EpicDetail = {
    repo: i.repo, data: p.data, epic: rowOf(e, p, i.states), stories, chains, series: e.series,
    pace: { perDay: p.perDay, days: p.pace }, history,
  };
  if (i.medianStoryMs !== undefined) answer.medianStoryMs = i.medianStoryMs;
  return { answer, save };
}
