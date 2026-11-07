/**
 * The spending limit per issue (#786). The family of an issue is its root issue, all its split parts (nested parts too) and
 * every run of each of them. The spend comes from the run files, the source of truth; a retry is a run or adds to the
 * run's total, so retries count by themselves. Parts are linked by the `create_split` record of a run and by the
 * `replacedBy` of a refinement session. Everything here fails closed: when the spend cannot be established, `issueLimitStop`
 * returns ISSUE_LIMIT_UNCHECKED and the run stops.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { listSessions } from "../refinement/store.js";
import { splitOf } from "../usage/events.js";
import { accountingRunIds, accountingRunsDirs, ISSUE_LIMIT_UNCHECKED, issueLimitReason, projectOfVars, runFile, type ProjectRef, type RunSummary } from "./state.js";
import { readSplitLinks } from "./split-links.js";
import { readPolicyFile } from "./policy-hooks.js";
import { writeAtomic } from "./policy-store.js";

export interface IssueRef {
  project: ProjectRef;
  issue: number;
}
export const ISSUE_LIMITS_FILE = "issue-limits.json";
export const ISSUE_LIMIT_MAX_USD = 1_000_000;
const MAX_UP = 20;
const MAX_ISSUES = 500;
const MAX_OVERRIDES = 5000;
const FILE_MAX_BYTES = 1024 * 1024;
const ISSUE_RE = /^[1-9]\d{0,9}$/;

/** The issue a run works on, with its project. Undefined: no valid issue number or no project. */
export function issueOfRun(s: Pick<RunSummary, "vars">): IssueRef | undefined {
  const n = s.vars?.issue;
  const project = projectOfVars(s.vars);
  if (typeof n !== "string" || !ISSUE_RE.test(n) || !project) return undefined;
  return { project, issue: Number(n) };
}

export function issueKey(ref: IssueRef): string {
  return ref.project.githubRepo ? `github:${ref.project.githubRepo.toLowerCase()}#${ref.issue}` : `local:${ref.project.repoId}#${ref.issue}`;
}

const projectKey = (p: ProjectRef | undefined): string | undefined => (p?.githubRepo ? `github:${p.githubRepo.toLowerCase()}` : p?.repoId ? `local:${p.repoId}` : undefined);

interface Slim {
  mtimeMs: number;
  size: number;
  runId: string;
  project?: string;
  issue?: number;
  cost: number;
  parts: { parent: number; parts: number[] }[];
}
const cache = new Map<string, Slim>();

function slimOf(file: string): Slim {
  const st = statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const s = JSON.parse(readFileSync(file, "utf8")) as RunSummary;
  const ref = issueOfRun(s);
  const parts: Slim["parts"] = [];
  if (ref && Array.isArray(s.history)) {
    for (const rec of s.history) {
      const sp = splitOf(rec);
      if (sp) parts.push({ parent: sp.parent ?? ref.issue, parts: sp.parts });
    }
  }
  const e: Slim = { mtimeMs: st.mtimeMs, size: st.size, runId: String(s.runId), project: ref ? projectKey(ref.project) : undefined, issue: ref?.issue, cost: Number.isFinite(s.totalCostUsd) ? s.totalCostUsd : 0, parts };
  cache.set(file, e);
  return e;
}

export interface IssueFamily {
  root: number;
  issues: number[];
  spentUsd: number;
}

/**
 * The family of an issue and what the runs on disk cost (without `exceptRunId`). THROWS when a folder or a run file cannot be
 * read, when the walk up is longer than 20 steps or the family has more than 500 issues: incomplete accounting is refused.
 */
export function issueFamily(runsDir: string, ref: IssueRef, exceptRunId?: string): IssueFamily {
  const want = projectKey(ref.project)!;
  const cost = new Map<number, number>();
  const children = new Map<number, Set<number>>();
  const link = (parent: number, part: number): void => {
    if (parent === part) return;
    let set = children.get(parent);
    if (!set) children.set(parent, (set = new Set()));
    set.add(part);
  };
  for (const dir of accountingRunsDirs(runsDir)) {
    for (const id of accountingRunIds(dir)) {
      const e = slimOf(runFile(join(dir, id)));
      if (e.project !== want || e.issue === undefined) continue;
      if (e.runId !== exceptRunId) cost.set(e.issue, (cost.get(e.issue) ?? 0) + e.cost);
      for (const p of e.parts) for (const n of p.parts) link(p.parent, n);
    }
  }
  // parts made by the refinement architect: the links kept apart from the sessions (they outlive a dropped session), and the
  // replacedBy of sessions that still exist (for those made before the links were kept)
  if (ref.project.githubRepo) {
    const repo = ref.project.githubRepo.toLowerCase();
    for (const [key, parts] of Object.entries(readSplitLinks(dirname(runsDir)))) {
      const m = /^github:(.+)#(\d+)$/.exec(key);
      if (m && m[1] === repo) for (const n of parts) link(Number(m[2]), n);
    }
    for (const s of listSessions()) {
      const src = s.source;
      if (src?.replacedBy && s.repo.toLowerCase() === repo) for (const n of src.replacedBy) link(src.issue, n);
    }
  }
  const parentOf = new Map<number, number>();
  for (const [p, set] of children) for (const n of set) if (!parentOf.has(n)) parentOf.set(n, p);
  let root = ref.issue;
  const up = new Set([root]);
  for (let i = 0; parentOf.has(root); i++) {
    if (i >= MAX_UP) throw new Error("the issue family is nested too deep");
    root = parentOf.get(root)!;
    if (up.has(root)) break; // a cycle ends the walk
    up.add(root);
  }
  const seen = new Set([root]);
  const todo = [root];
  while (todo.length) {
    for (const n of children.get(todo.pop()!) ?? []) {
      if (seen.has(n)) continue;
      if (seen.size >= MAX_ISSUES) throw new Error("the issue family has too many issues");
      seen.add(n);
      todo.push(n);
    }
  }
  seen.add(ref.issue);
  let spentUsd = 0;
  for (const n of seen) spentUsd += cost.get(n) ?? 0;
  return { root, issues: [...seen].sort((a, b) => a - b), spentUsd };
}

// ---- overrides ---------------------------------------------------------------------------------------

type Overrides = Record<string, { usd: number; by: string; at: string }>;
const fileOf = (home: string): string => join(home, ISSUE_LIMITS_FILE);

/** The raised limits per family root. `{}` when the file is missing, invalid, a link or too big. */
export function readIssueLimits(home: string): Overrides {
  const r = readPolicyFile(fileOf(home), FILE_MAX_BYTES);
  if (!("text" in r)) return {};
  try {
    const doc = JSON.parse(r.text) as unknown;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
    const out: Overrides = {};
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      const o = v as { usd?: unknown; by?: unknown; at?: unknown } | null;
      if (o && typeof o.usd === "number" && Number.isFinite(o.usd) && o.usd > 0 && o.usd <= ISSUE_LIMIT_MAX_USD) out[k] = { usd: o.usd, by: String(o.by ?? ""), at: String(o.at ?? "") };
    }
    return out;
  } catch {
    return {};
  }
}

/** Sets or (null) clears the override of one family root. Keeps the newest 5000 entries. */
export function setIssueLimit(key: string, usd: number | null, by: string, home: string): { changed: boolean } {
  const all = readIssueLimits(home);
  if (usd === null ? !(key in all) : all[key]?.usd === usd) return { changed: false };
  if (usd === null) delete all[key];
  else all[key] = { usd, by, at: new Date().toISOString() };
  const keep = Object.entries(all).sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, MAX_OVERRIDES);
  writeAtomic(fileOf(home), JSON.stringify(Object.fromEntries(keep), null, 2));
  return { changed: true };
}

/** `{ limitUsd }` with a number above 0 (at most 1 000 000), or null. Anything else throws. */
export function checkIssueLimitBody(body: unknown): number | null {
  const bad = new Error("limitUsd must be a number above 0, or null");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "limitUsd") throw bad;
  const v = (body as { limitUsd: unknown }).limitUsd;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > ISSUE_LIMIT_MAX_USD) throw bad;
  return v;
}

// ---- the check ---------------------------------------------------------------------------------------

type LimitConfig = Pick<Config, "cost_limits" | "limits">;
export interface IssueLimitState {
  issue: number;
  root: number;
  issues: number[];
  spentUsd: number;
  defaultUsd: number | null;
  overrideUsd: number | null;
  limitUsd: number | null;
  enforced: boolean;
}

/** What the issue of this run has cost and which limit counts. Undefined: the run has no issue. THROWS like issueFamily. */
export function issueLimitState(runsDir: string, run: RunSummary, config: LimitConfig, home = dirname(runsDir)): IssueLimitState | undefined {
  const ref = issueOfRun(run);
  if (!ref) return undefined;
  const fam = issueFamily(runsDir, ref, run.runId);
  const spentUsd = fam.spentUsd + (Number.isFinite(run.totalCostUsd) ? run.totalCostUsd : 0);
  const defaultUsd = config.limits?.issue_cost_usd ?? null;
  const overrideUsd = readIssueLimits(home)[issueKey({ project: ref.project, issue: fam.root })]?.usd ?? null;
  // an override counts only while the setting is on: the default stays off
  const limitUsd = defaultUsd === null ? null : (overrideUsd ?? defaultUsd);
  return { issue: ref.issue, root: fam.root, issues: fam.issues, spentUsd, defaultUsd, overrideUsd, limitUsd, enforced: config.cost_limits && limitUsd !== null };
}

/** The reason that stops the run before an agent step, or undefined. Never throws: a failure stops the run (fail closed). */
export function issueLimitStop(runsDir: string, summary: RunSummary, config: LimitConfig, home = dirname(runsDir)): string | undefined {
  if (!config.cost_limits || config.limits?.issue_cost_usd === undefined || !issueOfRun(summary)) return undefined;
  try {
    const st = issueLimitState(runsDir, summary, config, home);
    if (!st || st.limitUsd === null || st.spentUsd < st.limitUsd) return undefined;
    return issueLimitReason(st.spentUsd, st.limitUsd);
  } catch {
    return ISSUE_LIMIT_UNCHECKED;
  }
}
