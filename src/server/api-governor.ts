import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capsPath, loadCaps, runLimit } from "../ops/caps.js";
import { FACTORY_HOME } from "../flow/load.js";
import { HOLD_MS, loadState } from "../ops/governor.js";
import { capHistory, heldCap, logSince } from "../ops/governor-history.js";
import { TOP_KEPT } from "../ops/usage.js";
import { HttpError, send } from "./http.js";
import type { Route } from "./server.js";

const DAY_MS = 86_400_000;

export interface GovernorView {
  /** ok: a fresh result. old: the last check is older than the hold time (no measurements are shown). none: there is no result. */
  status: "ok" | "old" | "none";
  /** When the last check ran. */
  at?: string;
  configured: number;
  /** The runs at once now: the configured number lowered by the caps that hold. */
  limit: number;
  /** The caps that hold, lowest first. */
  caps: { who: string; runs: number; why: string; until: string }[];
  /** The governor's own cap that holds now, with the reason of its last step down (kept through steps up). */
  cap?: { runs: number; why?: string };
  tests?: 1;
  workers?: number;
  paused?: string;
  /** Free cores; absent when not measured. `fit`: the runs that fit, absent until a run's usage is learned. */
  capacity?: { cores: number; free: number; reserve: number; fit?: number };
  foundry?: { cores: number; tests: number; server: number };
  other?: { cores: number; top: { program: string; cores: number }[] };
  history: { since: string; now: string; start: number; steps: { at: string; runs: number; why?: string }[]; belowMs: number; lowest?: number; reasons: { why: string; ms: number }[] };
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function readLatest(dir: string): Record<string, unknown> | undefined {
  try {
    const l = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")) as unknown;
    return l && typeof l === "object" && !Array.isArray(l) ? (l as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The measurements of a fresh result; each part only when it has the right shape. */
function measurements(l: Record<string, unknown>, reserve: number): Pick<GovernorView, "capacity" | "foundry" | "other"> {
  const out: Pick<GovernorView, "capacity" | "foundry" | "other"> = {};
  if (num(l.cores) && l.cores > 0 && num(l.free) && l.free >= 0) out.capacity = { cores: l.cores, free: l.free, reserve, ...(Number.isInteger(l.fit) && (l.fit as number) >= 0 ? { fit: l.fit as number } : {}) };
  const u = l.usage as { foundry?: Record<string, unknown>; other?: { cores?: unknown; top?: unknown } } | undefined;
  if (u && typeof u === "object") {
    const f = u.foundry;
    if (f && num(f.cores) && num(f.tests) && num(f.server)) out.foundry = { cores: f.cores, tests: f.tests, server: f.server };
    if (u.other && num(u.other.cores) && Array.isArray(u.other.top)) {
      const top = u.other.top.filter((p): p is { program: string; cores: number } => typeof p?.program === "string" && num(p.cores)).slice(0, TOP_KEPT).map((p) => ({ program: p.program, cores: p.cores }));
      out.other = { cores: u.other.cores, top };
    }
  }
  return out;
}

/** The answer of GET /api/governor. Reads files only; it never asks the system whether the helper is installed. */
export function governorView(o: { dir: string; capsFile: string; configured: number; reserve: number; now: Date }): GovernorView {
  const t = o.now.getTime();
  const latest = readLatest(o.dir);
  const at = typeof latest?.at === "string" ? Date.parse(latest.at) : NaN;
  const status = !latest ? "none" : t - at <= HOLD_MS ? "ok" : "old";
  const state = loadState(o.dir, o.now);
  const held = heldCap(o.dir, o.now);
  const since = t - DAY_MS;
  const h = capHistory(logSince(o.dir, since), { since, now: t, configured: o.configured, held });
  const caps = Object.entries(loadCaps(o.capsFile))
    .filter(([, c]) => Date.parse(c.until) > t)
    .map(([who, c]) => ({ who, runs: c.runs, why: String(c.why ?? ""), until: c.until }))
    .sort((a, b) => a.runs - b.runs || a.who.localeCompare(b.who));
  return {
    status,
    ...(Number.isFinite(at) ? { at: new Date(at).toISOString() } : {}),
    configured: o.configured,
    limit: runLimit(o.configured, o.now, o.capsFile),
    caps,
    ...(state.runs !== undefined ? { cap: { runs: state.runs, ...(state.runsWhy ? { why: state.runsWhy } : {}) } } : {}),
    ...(state.tests ? { tests: 1 as const } : {}),
    ...(state.workers ? { workers: state.workers } : {}),
    ...(state.paused ? { paused: state.paused } : {}),
    ...(status === "ok" ? measurements(latest!, o.reserve) : {}),
    history: {
      since: new Date(since).toISOString(),
      now: o.now.toISOString(),
      start: h.start,
      steps: h.steps.map((s) => ({ at: new Date(s.at).toISOString(), runs: s.runs, ...(s.why ? { why: s.why } : {}) })),
      belowMs: h.belowMs,
      ...(h.lowest !== undefined ? { lowest: h.lowest } : {}),
      reasons: h.reasons,
    },
  };
}

/** `GET /api/governor`: the load governor for the Overview page. Admins only: it names programs. */
export const governorRoutes: Route = async (ctx, _req, res, seg, method) => {
  if (seg[0] !== "governor" || seg.length !== 1) return false;
  if (method !== "GET") throw new HttpError(405, "method not allowed");
  const cfg = ctx.config();
  const home = process.env.FACTORY_HOME ?? FACTORY_HOME;
  return send(res, 200, governorView({ dir: join(home, "governor"), capsFile: capsPath(home), configured: cfg.concurrency, reserve: cfg.governor.reserve_cores, now: new Date() })), true;
};
