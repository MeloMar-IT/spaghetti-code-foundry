// Safe points (#863): the recent commits of a branch that a successful run or a release left green. Pure parsing and merging
// of what the run records already hold; no call to GitHub, no git command. The route is in server/api-safe-points.ts.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { DELETED_OWNER } from "./auth/run-owner.js";
import { redactText } from "./credentials/redact.js";
import { taskLineOf, type RunSummary } from "./engine/state.js";
import { safeSentence } from "./failure.js";
import { RELEASE_BUILD_FLOW } from "./release/auto-build.js";
import { greenOf } from "./red-base.js";
import { storyTitle } from "./since.js";
import { runOrigin } from "./your-turn.js";

export const MAX_SAFE_POINTS = 10;
export const MAX_SAFE_CHANGES = 20;
const MAX_TITLE = 200;
const MAX_PLAN = 64 * 1024;
const COMMIT = /^[0-9a-f]{40}$/i;

export interface SafeChange { issue?: number; title: string }
export interface SafeSource {
  runId: string; commit: string; branch: string; at: string; release: boolean; tag?: string;
  /** "develop": a story push or a release check on the develop branch. Used to tell a gitflow project. */
  role: "develop" | "main";
  changes: SafeChange[]; owner?: string; source?: string;
}
export type StartedBy = { kind: "you" } | { kind: "foundry" } | { kind: "person"; name?: string };
export interface SafePoint { commit: string; short: string; branch: string; at: string; release: boolean; tag?: string; changes: SafeChange[]; moreChanges?: number; by: StartedBy }
export interface Viewer { id: string; admin: boolean }

const clean = (t: string): string => safeSentence(redactText(t), MAX_TITLE);
const lastId = (id: string): string => id.split("/").at(-1) ?? id;

function stepOf(run: RunSummary, name: string) {
  return [...(run.history ?? [])].reverse().find((s) => lastId(s.id) === name && s.ok);
}
function stepTime(s: { startedAt: string; durationMs: number }): string | undefined {
  const t = Date.parse(s.startedAt) + (Number.isFinite(s.durationMs) ? s.durationMs : 0);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** "Merge #n: title (branch)" and "Resolve #n: …" lines → changes, one per number. */
export function mergedChanges(output: string): SafeChange[] {
  const seen = new Set<number>();
  const out: SafeChange[] = [];
  for (const line of String(output ?? "").split("\n")) {
    const m = /^(?:Merge|Resolve) #(\d+): (.+?)(?: \([^()\s]+\))?\s*$/.exec(line.trim());
    if (!m) continue;
    const issue = Number(m[1]);
    const title = clean(m[2]!);
    if (seen.has(issue) || title === "") continue;
    seen.add(issue);
    out.push({ issue, title });
  }
  return out;
}

/** The `sha` and `changes` of <runDir>/release/plan.json (at most 64 KB); undefined when it is missing, broken or has no full commit. */
export function releasePlan(runDir: string): { sha: string; changes: string[] } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(runDir, "release", "plan.json"), "r");
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_PLAN) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    const j = JSON.parse(buf.toString("utf8")) as { sha?: unknown; changes?: unknown };
    if (typeof j.sha !== "string" || !COMMIT.test(j.sha)) return undefined;
    const changes = Array.isArray(j.changes) ? j.changes.filter((c): c is string => typeof c === "string").slice(0, MAX_SAFE_CHANGES * 2) : [];
    return { sha: j.sha.toLowerCase(), changes };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The safe-point sources of one run (none, one or two). Never throws. Only a succeeded run counts:
 *  - a story run that pushed develop (`COMMIT:` of push_develop; it only pushes after test_develop passed),
 *  - a release check (`TESTED:` and `CHECKS: yes` of verify),
 *  - a release build of the main branch (the commit of release/plan.json; a tag was made),
 *  - a clean base check (`BASE_GREEN:`) of a story run.
 */
export function safeSourcesOf(run: RunSummary, o: { mainBranch: string; plan?: (runDir: string) => { sha: string; changes: string[] } | undefined }): SafeSource[] {
  try {
    if (run.status !== "succeeded") return [];
    const base = { runId: run.runId, ...(run.owner ? { owner: run.owner } : {}), ...(run.source ? { source: run.source } : {}) };
    const out: SafeSource[] = [];
    const develop = run.vars?.develop_branch?.trim() ?? "";
    if (run.flow === RELEASE_BUILD_FLOW) {
      const tag = run.outputs?.release_tag, url = run.outputs?.release_url;
      if (!tag && !url) return [];
      if (run.vars?.ref !== o.mainBranch || !run.finishedAt || Number.isNaN(Date.parse(run.finishedAt))) return [];
      const plan = (o.plan ?? releasePlan)(run.runDir);
      if (!plan) return [];
      const changes = mergedChanges(plan.changes.join("\n"));
      return [{ ...base, commit: plan.sha, branch: o.mainBranch, role: "main", at: new Date(run.finishedAt).toISOString(), release: true, ...(tag ? { tag: clean(tag) } : {}), changes }];
    }
    const push = stepOf(run, "push_develop");
    const pushed = /^COMMIT: ([0-9a-f]{40})\s*$/im.exec(push?.output ?? "")?.[1];
    const pushAt = push ? stepTime(push) : undefined;
    if (push && pushed && pushAt && develop) {
      const n = Number(run.vars?.issue);
      const title = storyTitle(run) || taskLineOf(run.task) || (Number.isInteger(n) ? `#${n}` : "");
      const change: SafeChange = { ...(Number.isInteger(n) && n > 0 ? { issue: n } : {}), title: clean(title) };
      out.push({ ...base, commit: pushed.toLowerCase(), branch: develop, role: "develop", at: pushAt, release: false, changes: change.title ? [change] : [] });
    }
    const verify = stepOf(run, "verify");
    const vout = verify?.output ?? "";
    const tested = /^TESTED: ([0-9a-f]{40})\s*$/im.exec(vout)?.[1];
    const vAt = verify ? stepTime(verify) : undefined;
    if (verify && tested && vAt && develop && /^CHECKS: yes\s*$/im.test(vout)) {
      const changes = stepOf(run, "changes");
      out.push({ ...base, commit: tested.toLowerCase(), branch: develop, role: "develop", at: vAt, release: false, changes: mergedChanges(changes?.output ?? "") });
    }
    const branches = [develop, o.mainBranch].filter(Boolean);
    for (const b of new Set(branches)) {
      const g = greenOf(run, b);
      if (g && COMMIT.test(g.commit)) {
        // The baseline ran before this run's change, so the run's title is not in the commit: it names no changes.
        out.push({ ...base, commit: g.commit.toLowerCase(), branch: b, role: b === develop ? "develop" : "main", at: new Date(g.at).toISOString(), release: false, changes: [] });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Who started the work behind a point. A user never learns another account's id or name. */
export function startedBy(s: Pick<SafeSource, "owner" | "source">, viewer: Viewer, names: () => Map<string, string>): StartedBy {
  if (runOrigin(s.source) === "watcher") return { kind: "foundry" };
  if (s.owner !== undefined && s.owner === viewer.id) return { kind: "you" };
  return viewer.admin ? { kind: "person", name: s.owner === undefined ? DELETED_OWNER : names().get(s.owner) ?? DELETED_OWNER } : { kind: "person" };
}

/** The sources of one branch, one point per commit (earliest time, all changes), newest first, at most MAX_SAFE_POINTS. */
export function safePoints(sources: SafeSource[], o: { branch: string; viewer: Viewer; names: () => Map<string, string> }): SafePoint[] {
  const byCommit = new Map<string, SafeSource[]>();
  for (const s of sources) {
    if (s.branch !== o.branch) continue;
    const list = byCommit.get(s.commit) ?? [];
    list.push(s);
    byCommit.set(s.commit, list);
  }
  const points: SafePoint[] = [];
  for (const [commit, list] of byCommit) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const first = list[0]!;
    const changes: SafeChange[] = [];
    const seen = new Set<string>();
    for (const c of list.flatMap((s) => s.changes)) {
      const key = c.issue !== undefined ? `#${c.issue}` : c.title;
      if (seen.has(key)) continue;
      seen.add(key);
      changes.push(c);
    }
    const tag = list.find((s) => s.tag)?.tag;
    points.push({
      commit, short: commit.slice(0, 7), branch: o.branch, at: first.at, release: list.some((s) => s.release), ...(tag ? { tag } : {}),
      changes: changes.slice(0, MAX_SAFE_CHANGES), ...(changes.length > MAX_SAFE_CHANGES ? { moreChanges: changes.length - MAX_SAFE_CHANGES } : {}),
      by: startedBy(first, o.viewer, o.names),
    });
  }
  return points.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, MAX_SAFE_POINTS);
}
