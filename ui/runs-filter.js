// The filter of the admin Runs list: one plain object, its address form and how a queued job is matched.
// Pure; relative imports only (ui/context.js imports this and is loaded on the user display too).
import { parseQuery, splitHash } from "./ia.js";

export const SEARCH_MAX = 200;
const FLOW_MAX = 100;
/** The statuses the server knows (GET /api/runs?status=…). */
export const STATUSES = ["running", "waiting", "succeeded", "failed", "cancelled", "stopped"];
export const TIMES = ["today", "7d", "30d"];
/** The ids of the sections of the list; "" is All. */
export const VIEWS = ["needs", "running", "queued", "failed", "completed"];
const DAYS = { today: 0, "7d": 7, "30d": 30 };
const KEYS = ["q", "repo", "flow", "status", "time", "owner", "needs", "view"];
const SERVER = ["q", "repo", "flow", "status", "time", "owner"];

export const emptyFilter = () => ({ q: "", repo: "", flow: "", status: "", time: "", owner: "", needs: false, view: "" });

/** A full filter from the `{ repo?, owner? }` of resolve(). */
export const filterOf = (query) => ({ ...emptyFilter(), repo: query?.repo ?? "", owner: query?.owner ?? "" });

const length = (s) => [...s].length;
const clean = {
  q: (v) => { const t = v.trim(); return t && length(t) <= SEARCH_MAX ? t : ""; },
  flow: (v) => (v && v.length <= FLOW_MAX && !/[\u0000-\u001f\u007f]/.test(v) ? v : ""),
  status: (v) => (STATUSES.includes(v) ? v : ""),
  time: (v) => (TIMES.includes(v) ? v : ""),
  view: (v) => (VIEWS.includes(v) ? v : ""),
};

/** The filter of an address like "#/runs?q=…&repo=…". Wrong or unknown values are dropped; the first of a repeated key wins. */
export function parseFilter(hash) {
  const f = emptyFilter();
  const raw = splitHash(hash).query;
  const seen = new Set();
  for (const part of raw.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i);
    if (!KEYS.includes(key) || seen.has(key)) continue;
    let value;
    try {
      value = decodeURIComponent(part.slice(i + 1));
    } catch {
      continue;
    }
    seen.add(key);
    if (key === "repo" || key === "owner") {
      const v = parseQuery(`${key}=${encodeURIComponent(value)}`)[key];
      f[key] = v && v !== "all" ? v : "";
    } else if (key === "needs") f.needs = value === "1";
    else f[key] = clean[key](value);
  }
  return f;
}

/** "#/runs" plus the set keys in a fixed order. `allRepos` writes `repo=all` when no repository is set. */
export function filterHash(filter, { allRepos = false } = {}) {
  const f = { ...emptyFilter(), ...filter };
  const parts = [];
  for (const key of KEYS) {
    if (key === "needs") { if (f.needs === true) parts.push("needs=1"); continue; }
    let value = typeof f[key] === "string" ? f[key] : "";
    if (value) {
      const probe = parseFilter(`#/runs?${key}=${encodeURIComponent(value)}`);
      if (probe[key] !== (key === "q" ? value.trim() : value)) value = "";
    }
    if (!value && key === "repo" && allRepos) value = "all";
    if (value) parts.push(`${key}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `#/runs?${parts.join("&")}` : "#/runs";
}

/** The start of the period as an ISO text: local midnight today, 7 or 30 days before. "" for no or an unknown time. */
export function sinceOf(time, now) {
  if (!Object.hasOwn(DAYS, time)) return "";
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - DAYS[time]).toISOString();
}

/** The parameters of GET /api/runs; only the set keys. */
export function filterQuery(filter, now) {
  const out = {};
  for (const key of ["q", "repo", "flow", "status"]) if (filter[key]) out[key] = filter[key];
  const since = sinceOf(filter.time, now);
  if (since) out.since = since;
  if (filter.owner) out.owner = filter.owner;
  return out;
}

/** What the server is asked: a change in it needs a new request. */
export const serverKey = (filter) => JSON.stringify(SERVER.map((k) => filter[k] ?? ""));

/** Every name in the list that is the repository, ignoring case (the server matches the exact spelling). */
export const canonRepos = (name, repos) => (typeof name === "string" && name && Array.isArray(repos)
  ? repos.filter((r) => typeof r === "string" && r.toLowerCase() === name.toLowerCase()) : []);

/** Whether a queued job with no run of its own passes the filter (as matchesRun in src/server/run-filter.ts). */
export function jobMatches(job, filter, { ownerName, now = Date.now() } = {}) {
  if (filter.status) return false;
  if (filter.repo && !(typeof job?.githubRepo === "string" && job.githubRepo.toLowerCase() === filter.repo.toLowerCase())) return false;
  if (filter.flow && job?.flow !== filter.flow) return false;
  if (filter.time && !(Date.parse(job?.enqueuedAt) >= Date.parse(sinceOf(filter.time, now)))) return false;
  if (filter.owner && !(ownerName !== undefined && job?.ownerName === ownerName)) return false;
  if (filter.q) {
    const hay = [job?.runId, job?.flow, job?.githubRepo];
    if (job?.issue !== undefined && job?.issue !== null) {
      hay.push(`#${job.issue}`);
      if (typeof job.githubRepo === "string") hay.push(`${job.githubRepo}#${job.issue}`);
    }
    if (typeof job?.task === "string") hay.push(job.task.split("\n")[0]);
    const q = filter.q.toLowerCase();
    if (!hay.some((t) => typeof t === "string" && t.toLowerCase().includes(q))) return false;
  }
  return true;
}

export const isActive = (filter) => KEYS.some((k) => Boolean(filter?.[k]));
export const isServerActive = (filter) => SERVER.some((k) => Boolean(filter?.[k]));
export const countText = (n) => (n === 1 ? "1 run matches." : `${n} runs match.`);
