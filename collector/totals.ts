import { DURATION_EDGES_MS, PARTS_EDGES, type ShareReport } from "../src/metrics-share/report.js";

// The public totals of the receiver (#890): pure, plain reports in, metrics.json out. One generic walk sums every
// section of the reports, so a new optional field of a later report version is totalled without new code.
// A number is published once at least MIN_INSTALLS installs gave it (1: every shared number is shown, also of a
// single install; the owner chose this on 2026-11-22); a sum that would overflow is left out.

export const MIN_INSTALLS = 1;
export const DAYS_SHOWN = 35;
const SHARING_DAYS = 7;
const DAY_MS = 86_400_000;
const SECTIONS = ["changes", "speed", "splits", "rework", "quality", "cost", "use"] as const;
type Section = (typeof SECTIONS)[number];
const RATIOS: Record<string, string> = { firstPassTests: "passed", mergeRate: "delivered", evidence: "complete" };

export interface PublicHistogram { counts: number[]; sum: number; count: number; median?: number }
export type PeriodTotals = { installs: number; accounts?: number } & Record<Section, Record<string, unknown>>;
export interface PublicMetrics {
  version: 1;
  generatedAt: string;
  minInstalls: number;
  edges: { durationMs: number[]; partsPerSplit: number[] };
  sharing?: { since: string; installs: number; accounts: number };
  days: ({ day: string } & PeriodTotals)[];
  weeks: ({ week: string } & PeriodTotals)[];
}

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);
const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The Monday (UTC) of the week of a day, as YYYY-MM-DD. */
export function weekOf(day: string): string {
  const ms = dayMs(day);
  const back = (new Date(ms).getUTCDay() + 6) % 7;
  return dayText(ms - back * DAY_MS);
}

/**
 * The median of a histogram over fixed edges. A time histogram is interpolated inside its bucket; a discrete one (parts)
 * gives the lower edge of its bucket, as does the open last bucket. undefined when the histogram is empty.
 */
export function medianOf(counts: readonly number[], edges: readonly number[], discrete: boolean): number | undefined {
  const total = counts.reduce((a, n) => a + n, 0);
  if (!(total > 0)) return undefined;
  const half = total / 2;
  let before = 0;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i]!;
    if (n > 0 && before + n >= half) {
      const lower = i === 0 ? 0 : edges[i - 1]!;
      if (discrete || i >= edges.length) return lower;
      return Math.round(lower + ((half - before) / n) * (edges[i]! - lower));
    }
    before += n;
  }
  return undefined;
}

// the walk
type Leaf = { kind: "num"; usd: boolean; sum: number; installs: Set<string>; bad: boolean };
type Hist = { kind: "hist"; counts: number[]; sum: number; installs: Set<string>; bad: boolean };
type Obj = { kind: "obj"; children: Map<string, Node> };
type Node = Leaf | Hist | Obj;

const newObj = (): Obj => ({ kind: "obj", children: new Map() });
const isHistogram = (v: unknown): v is { counts: number[]; sum: number } =>
  !!v && typeof v === "object" && Array.isArray((v as { counts?: unknown }).counts) && typeof (v as { sum?: unknown }).sum === "number" && Object.keys(v).length === 2;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function mergeInto(node: Obj, value: Record<string, unknown>, install: string): void {
  for (const [k, v] of Object.entries(value)) {
    const have = node.children.get(k);
    if (typeof v === "number") {
      const leaf = have ?? { kind: "num", usd: k === "costUsd", sum: 0, installs: new Set<string>(), bad: false };
      if (leaf.kind !== "num") continue;
      node.children.set(k, leaf);
      leaf.installs.add(install);
      leaf.sum += v;
      if (leaf.usd ? !Number.isFinite(leaf.sum) : !Number.isSafeInteger(leaf.sum)) leaf.bad = true;
    } else if (isHistogram(v)) {
      const h = have ?? { kind: "hist", counts: v.counts.map(() => 0), sum: 0, installs: new Set<string>(), bad: false };
      if (h.kind !== "hist") continue;
      node.children.set(k, h);
      h.installs.add(install);
      if (h.counts.length !== v.counts.length) h.bad = true;
      for (let i = 0; i < h.counts.length; i++) {
        h.counts[i]! += v.counts[i] ?? 0;
        if (!Number.isSafeInteger(h.counts[i])) h.bad = true;
      }
      h.sum += v.sum;
      if (!Number.isFinite(h.sum)) h.bad = true;
    } else if (isPlainObject(v)) {
      const o = have ?? newObj();
      if (o.kind !== "obj") continue;
      node.children.set(k, o);
      mergeInto(o, v, install);
    }
  }
}

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  const r = Math.round(n * f) / f;
  return Number.isFinite(r) ? r : n;
};

function emit(node: Node, path: readonly string[]): unknown {
  if (node.kind === "num") {
    if (node.bad || node.installs.size < MIN_INSTALLS) return undefined;
    return node.usd ? round(node.sum, 6) : node.sum;
  }
  if (node.kind === "hist") {
    if (node.bad || node.installs.size < MIN_INSTALLS) return undefined;
    const count = node.counts.reduce((a, n) => a + n, 0);
    if (!Number.isSafeInteger(count)) return undefined;
    const parts = path[0] === "splits";
    const out: PublicHistogram = { counts: [...node.counts], sum: parts ? node.sum : round(node.sum, 3), count };
    const median = medianOf(node.counts, parts ? PARTS_EDGES : DURATION_EDGES_MS, parts);
    if (median !== undefined) out.median = median;
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, child] of [...node.children].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const v = emit(child, [...path, k]);
    if (v !== undefined) out[k] = v;
  }
  const key = path[path.length - 1];
  if (path.length === 2 && path[0] === "quality" && key && RATIOS[key]) {
    const num = out[RATIOS[key]!];
    const counted = out.counted;
    if (typeof num === "number" && typeof counted === "number" && counted > 0) out.share = round(num / counted, 4);
  }
  if (path.length > 1 && !Object.keys(out).length) return undefined;
  return out;
}

/** The totals of a group of reports, or undefined when fewer than MIN_INSTALLS installs are in it. */
function periodOf(reports: readonly ShareReport[]): PeriodTotals | undefined {
  const installs = new Set(reports.map((r) => r.install));
  if (installs.size < MIN_INSTALLS) return undefined;
  // accounts: each install's highest number in the group (on a day there is one report per install)
  const most = new Map<string, number>();
  for (const r of reports) most.set(r.install, Math.max(most.get(r.install) ?? 0, r.accountsSharing));
  const accounts = [...most.values()].reduce((a, n) => a + n, 0);
  const sections = Object.fromEntries(
    SECTIONS.map((s) => {
      const node = newObj();
      for (const r of reports) if (isPlainObject(r[s])) mergeInto(node, r[s] as Record<string, unknown>, r.install);
      return [s, emit(node, [s]) as Record<string, unknown>];
    }),
  ) as Record<Section, Record<string, unknown>>;
  return { installs: installs.size, ...(Number.isSafeInteger(accounts) ? { accounts } : {}), ...sections };
}

function groupBy(reports: readonly ShareReport[], key: (r: ShareReport) => string): Map<string, ShareReport[]> {
  const m = new Map<string, ShareReport[]>();
  for (const r of reports) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return new Map([...m].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function computeTotals(input: readonly ShareReport[], now: Date): PublicMetrics {
  // one report per install and day: a later one replaces an earlier one
  const reports = [...new Map(input.map((r) => [`${r.install}/${r.day}`, r])).values()];
  const today = dayMs(now.toISOString().slice(0, 10));
  const firstShown = today - (DAYS_SHOWN - 1) * DAY_MS;
  const days: PublicMetrics["days"] = [];
  for (const [day, group] of groupBy(reports.filter((r) => dayMs(r.day) >= firstShown), (r) => r.day)) {
    const t = periodOf(group);
    if (t) days.push({ day, ...t });
  }
  const weeks: PublicMetrics["weeks"] = [];
  for (const [week, group] of groupBy(reports, (r) => weekOf(r.day))) {
    const t = periodOf(group);
    if (t) weeks.push({ week, ...t });
  }
  const out: PublicMetrics = {
    version: 1,
    generatedAt: now.toISOString(),
    minInstalls: MIN_INSTALLS,
    edges: { durationMs: [...DURATION_EDGES_MS], partsPerSplit: [...PARTS_EDGES] },
    days,
    weeks,
  };
  const since = today - SHARING_DAYS * DAY_MS;
  const latest = new Map<string, ShareReport>();
  for (const r of reports) {
    if (dayMs(r.day) < since) continue;
    const have = latest.get(r.install);
    if (!have || have.day < r.day) latest.set(r.install, r);
  }
  const accounts = [...latest.values()].reduce((a, r) => a + r.accountsSharing, 0);
  if (latest.size >= MIN_INSTALLS && Number.isSafeInteger(accounts)) out.sharing = { since: dayText(since), installs: latest.size, accounts };
  return out;
}
