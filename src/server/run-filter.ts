import { TASK_LINE_MAX, type RunBrief, type RunStatus } from "../engine/state.js";
import { HttpError, NAME_RE } from "./http.js";
import { userTask } from "./user-view.js";

export const Q_MAX = 200;

export interface RunFilter {
  /** True: only archived runs; false: only runs that are not archived. */
  archived: boolean;
  /** Only runs of this account. parseRunFilter sets it for an admin only; the route sets it to the caller for a user. */
  owner?: string;
  /** Trimmed and lower-cased; absent when empty. */
  q?: string;
  repo?: string;
  flow?: string;
  status?: RunStatus;
  /** Milliseconds; runs started at or after it match. */
  since?: number;
  /** False: the task line is matched as a user sees it. */
  admin: boolean;
}

const STATUSES: Record<RunStatus, true> = { running: true, succeeded: true, failed: true, cancelled: true, stopped: true, waiting: true };

const SINCE_RE = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;
const SINCE_TEXT = "since must be an ISO date, like 2026-10-01 or 2026-10-01T08:00:00Z";

function parseSince(v: string): number {
  const m = SINCE_RE.exec(v);
  if (!m) throw new HttpError(400, SINCE_TEXT);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  // 2026-02-30 would be moved to March; refuse it.
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) throw new HttpError(400, SINCE_TEXT);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new HttpError(400, SINCE_TEXT);
  return ms;
}

/** Reads the filter of GET /api/runs. Throws HttpError 400 for a wrong value. Unknown parameters are ignored. */
export function parseRunFilter(params: URLSearchParams, admin: boolean): RunFilter {
  const f: RunFilter = { archived: false, admin };
  const archived = params.get("archived");
  if (archived !== null && archived !== "1") throw new HttpError(400, "invalid archived");
  f.archived = archived === "1";
  if (admin) {
    const o = params.get("owner");
    if (o !== null) {
      if (!NAME_RE.test(o) || o.length > 64) throw new HttpError(400, "invalid owner");
      f.owner = o;
    }
  }
  const q = params.get("q");
  if (q !== null) {
    if ([...q].length > Q_MAX) throw new HttpError(400, `q can have at most ${Q_MAX} characters`);
    const t = q.trim().toLowerCase();
    if (t !== "") f.q = t;
  }
  for (const key of ["repo", "flow"] as const) {
    const v = params.get(key);
    if (v === null) continue;
    if (v === "") throw new HttpError(400, `invalid ${key}`);
    f[key] = v;
  }
  const status = params.get("status");
  if (status !== null) {
    if (!Object.hasOwn(STATUSES, status)) throw new HttpError(400, `status must be one of: ${Object.keys(STATUSES).join(", ")}`);
    f.status = status as RunStatus;
  }
  const since = params.get("since");
  if (since !== null) f.since = parseSince(since);
  return f;
}

/** Whether a brief passes every part of the filter. */
export function matchesRun(b: RunBrief, f: RunFilter): boolean {
  if (!!b.archived !== f.archived) return false;
  if (f.owner && b.owner !== f.owner) return false;
  if (f.status && b.status !== f.status) return false;
  if (f.flow !== undefined && b.flow !== f.flow) return false;
  if (f.repo !== undefined && b.githubRepo !== f.repo) return false;
  if (f.since !== undefined && !(Date.parse(b.startedAt) >= f.since)) return false;
  if (f.q) {
    const hay: unknown[] = [b.runId, b.flow, b.githubRepo];
    for (const n of [b.issue, b.pr]) {
      if (typeof n !== "string") continue;
      hay.push(`#${n}`);
      if (typeof b.githubRepo === "string") hay.push(`${b.githubRepo}#${n}`);
    }
    if (typeof b.taskLine === "string") hay.push(f.admin ? b.taskLine : [...userTask(b.flow, b.source, b.taskLine)].slice(0, TASK_LINE_MAX).join(""));
    const q = f.q;
    if (!hay.some((h) => typeof h === "string" && h.toLowerCase().includes(q))) return false;
  }
  return true;
}

/** The repositories and flows of the given briefs, each unique and sorted. */
export function runFilterValues(briefs: RunBrief[]): { repos: string[]; flows: string[] } {
  const repos = new Set<string>();
  const flows = new Set<string>();
  for (const b of briefs) {
    if (typeof b.githubRepo === "string" && b.githubRepo) repos.add(b.githubRepo);
    if (typeof b.flow === "string" && b.flow) flows.add(b.flow);
  }
  return { repos: [...repos].sort((a, b) => a.localeCompare(b)), flows: [...flows].sort((a, b) => a.localeCompare(b)) };
}
