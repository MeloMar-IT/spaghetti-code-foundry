import { busyCaps, loadBusy, MAX_BUSY_HOURS, setBusy } from "../ops/busy.js";
import { HttpError, readOptionalJson, send } from "./http.js";
import type { Route } from "./server.js";

export interface BusyView {
  /** Busy mode holds now (by hand or because a listed program runs). */
  on: boolean;
  /** The switch set by hand. */
  hand: { since: string; until?: string } | null;
  /** A program of `governor.busy_apps` runs: what it says, and when the cap ends unless renewed. */
  apps: { why: string; until: string } | null;
}

export function busyView(now = new Date()): BusyView {
  const hand = loadBusy(now);
  const caps = busyCaps(now);
  const apps = caps.apps ? { why: caps.apps.why, until: caps.apps.until } : null;
  return { on: !!(hand || caps.hand || apps), hand: hand ?? null, apps };
}

/** `hours` of a switch-on call: missing or null means until switched off; else a number above 0 and at most 24. */
export function parseHours(body: Record<string, unknown>): number | undefined {
  const h = body.hours;
  if (h === undefined || h === null) return undefined;
  if (typeof h !== "number" || !Number.isFinite(h) || h <= 0 || h > MAX_BUSY_HOURS) throw new HttpError(400, `"hours" must be a number above 0 and at most ${MAX_BUSY_HOURS}`);
  return h;
}

/** `GET|POST|DELETE /api/busy`: busy mode, the switch set by hand. The caps are written at once; the server renews them (see server.ts). */
export const busyRoutes: Route = async (ctx, req, res, seg, method) => {
  if (seg[0] !== "busy" || seg.length !== 1) return false;
  if (method === "GET") return send(res, 200, busyView()), true;
  if (method !== "POST" && method !== "DELETE") throw new HttpError(405, "method not allowed");
  const now = new Date();
  const runs = ctx.config().governor.busy_runs;
  if (method === "DELETE") setBusy(undefined, runs, now);
  else {
    const hours = parseHours(await readOptionalJson(req));
    setBusy({ since: now.toISOString(), ...(hours ? { until: new Date(now.getTime() + hours * 3_600_000).toISOString() } : {}) }, runs, now);
  }
  return send(res, 200, busyView(now)), true;
};
