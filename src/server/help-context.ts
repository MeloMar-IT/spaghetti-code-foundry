import { listAllRepos, listRepos } from "../auth/repos.js";
import { getUser, type User } from "../auth/users.js";
import { CONTEXT_KINDS, type Asker, type EntityResolver } from "../help/context.js";
import { guardExcerpt, type GuardOptions } from "../help/guard.js";
import { readFindings } from "../monitor/findings.js";
import { markerHash } from "../monitor/story.js";
import { sessionFor } from "./api-refinement.js";
import { checkedRun } from "./api-runs.js";
import { boardFor } from "./board.js";
import { health } from "./health.js";
import type { RunSummary } from "../engine/state.js";
import type { NextStep } from "../next-step.js";
import { allNext, nextFor, ownQueue, ownRecord, queueWithNext } from "./next.js";
import { authorize, findRule } from "./permissions.js";
import type { ApiContext } from "./server.js";
import { userRecord, userRun } from "./user-view.js";

/**
 * The help context service of Ask SCF: what the server itself knows about a thing, for one account, as a small
 * snapshot. It has no rules of its own. Every adapter first asks the permission table for the API call that reads
 * the same thing (`findRule`, `authorize`), then reads through the reader that call uses, with the owner check that
 * call uses, and keeps a short list of plain fields. So a snapshot holds the same as the call or less.
 *
 * A thing that does not exist, a thing the account may not see, a kind nobody knows and a reader that fails give
 * the same answer: undefined. The account is read now, never taken from the question.
 */

/** The kinds a snapshot exists for: the things a page can name, and two that have no id ("next" and "health"). */
export const SNAPSHOT_KINDS = [...CONTEXT_KINDS, "next", "health"] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number];

/** The most fields of one snapshot, characters of one text field, and characters of all fields as JSON. */
export const SNAPSHOT_FIELDS = 24;
export const SNAPSHOT_VALUE_MAX = 300;
export const SNAPSHOT_MAX = 2000;

export type FieldValue = string | number | boolean;

export interface Snapshot {
  kind: SnapshotKind;
  id: string;
  /** The server's own short name for the thing. */
  label: string;
  /** When the server read it. */
  observedAt: string;
  /** What was included, by field name. */
  fields: Record<string, FieldValue>;
  /** Fields the record has that are left out on purpose (admin-only, too large, or a text that reads like an order). */
  omitted: string[];
  /** Included fields from which a secret was taken out. */
  redacted: string[];
  /** Fields the record does not have now. */
  unavailable: string[];
  /** Included fields that are known to be old. */
  stale: string[];
}

/** The account as it is now: undefined for a removed or blocked one; a role that changed counts as the lower of the two. */
export function currentAccount(asker: Asker): User | undefined {
  const now = getUser(asker.id);
  if (!now || now.status !== "active") return undefined;
  return asker.role === "admin" && now.role === "admin" ? now : { ...now, role: "user" };
}

/** Whether the permission table lets the account make the GET call with these segments. */
function allowed(ctx: ApiContext, user: User, seg: string[]): boolean {
  const rule = findRule("GET", seg);
  if (!rule) return false;
  try {
    authorize(ctx, user, rule, seg);
    return true;
  } catch {
    return false;
  }
}

type Values = Record<string, FieldValue | null | undefined>;

/** Builds the bounded snapshot: every text passes the guard, is cut, and is counted against the size. */
function make(kind: SnapshotKind, id: string, label: string, values: Values, omit: readonly string[], guard: GuardOptions, stale: readonly string[] = []): Snapshot {
  const fields: Record<string, FieldValue> = {};
  const omitted = new Set(omit);
  const redacted: string[] = [];
  const unavailable: string[] = [];
  let size = 2;
  for (const [name, raw] of Object.entries(values)) {
    if (raw === undefined || raw === null || raw === "") {
      unavailable.push(name);
      continue;
    }
    let value: FieldValue = raw;
    if (typeof raw === "string") {
      const g = guardExcerpt(raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim(), guard);
      if (g.withheld || !g.text) {
        omitted.add(name);
        continue;
      }
      if (g.removed.length) redacted.push(name);
      value = g.text.length > SNAPSHOT_VALUE_MAX ? `${g.text.slice(0, SNAPSHOT_VALUE_MAX)} …` : g.text;
    } else if (typeof raw === "number" && !Number.isFinite(raw)) {
      unavailable.push(name);
      continue;
    }
    const cost = JSON.stringify(name).length + JSON.stringify(value).length + 2;
    if (Object.keys(fields).length >= SNAPSHOT_FIELDS || size + cost > SNAPSHOT_MAX) {
      omitted.add(name);
      continue;
    }
    size += cost;
    fields[name] = value;
  }
  const has = (n: string) => Object.hasOwn(fields, n);
  return { kind, id, label, observedAt: new Date().toISOString(), fields, omitted: [...omitted].filter((n) => !has(n)), redacted, unavailable, stale: stale.filter(has) };
}

const RUN_ID = /^[\w-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const old = (iso: string | undefined, ms = DAY_MS) => iso !== undefined && Date.now() - Date.parse(iso) > ms;

/**
 * A run and its next-step record, as `GET /api/runs/:id` gives them to this account: every run for an admin, their
 * own for a user, and for a user the record without another account's run and without a folder. Undefined for a run
 * that does not exist or is not theirs. `user` is the account as it is now (`currentAccount`).
 */
export function runWithNext(ctx: ApiContext, user: User, id: string): { run: RunSummary; next?: NextStep } | undefined {
  if (!RUN_ID.test(id) || !allowed(ctx, user, ["runs", id])) return undefined;
  const s = checkedRun(ctx.scheduler, id, user.role === "admin" ? undefined : user.id);
  if (!s) return undefined;
  let next: NextStep | undefined;
  try {
    const rec = nextFor(ctx, undefined, user.role !== "admin")(s);
    next = user.role === "admin" ? rec : userRecord(ownRecord(rec, (rid) => ctx.scheduler.ownerOf(rid) === user.id));
  } catch {
    next = undefined;
  }
  return { run: s, next };
}

type Adapter = (ctx: ApiContext, user: User, id: string, guard: GuardOptions) => Snapshot | undefined;

/**
 * One adapter per kind. Each names the API call it follows.
 */
const ADAPTERS: Record<SnapshotKind, Adapter> = {
  // GET /api/runs/:id — every run for an admin, their own for a user. The user's view of the run is used for both
  // roles: no cost, no model, no setup, no folder.
  run: (ctx, user, id, guard) => {
    const found = runWithNext(ctx, user, id);
    if (!found) return undefined;
    const { next } = found;
    const v = userRun(found.run);
    const failed = [...v.history].reverse().find((h) => !h.ok);
    return make("run", id, `a run of the flow ${v.flow}`, {
      flow: v.flow, status: v.status, startedAt: v.startedAt, finishedAt: v.finishedAt, branch: v.branch, repository: v.vars.github_repo, issue: v.vars.issue,
      stepsDone: v.history.length, nextStep: v.state.next, waitingAt: v.waiting?.stepId, waitingFor: v.waiting?.message, waitingSince: v.waiting?.since,
      failedStep: failed?.id, failedWhy: failed?.error, archivedAt: v.archivedAt,
      nextStatus: next?.status, nextWho: next?.who, nextWhy: next?.why, nextAction: next?.action, nextUntil: next?.until,
    }, ["cost", "model", "setup", "owner", "log", "transcripts", "folders", "task"], guard);
  },

  // GET /api/queue — an admin sees the queue, a user their own queued runs and how many are ahead. The id is
  // "queue" for the whole of it, or the id of one queued run.
  queue: (ctx, user, id, guard) => {
    if (!allowed(ctx, user, ["queue"])) return undefined;
    const omit = ["source", "locks", "folders", "owner"];
    if (user.role === "admin") {
      const q = queueWithNext(ctx);
      if (id === "queue") return make("queue", id, "the queue", { waiting: q.pending.length, working: q.active.length, firstWaitsFor: q.pending[0]?.next.status }, omit, guard);
      const p = RUN_ID.test(id) ? q.pending.find((x) => x.runId === id) : undefined;
      return p ? make("queue", id, "a queued run", { position: q.pending.indexOf(p) + 1, kind: p.kind, enqueuedAt: p.enqueuedAt, status: p.next.status, why: p.next.why }, omit, guard) : undefined;
    }
    const q = ownQueue(ctx, user.id);
    if (id === "queue") return make("queue", id, "your part of the queue", { waiting: q.pending.length, working: q.active.length, aheadOfFirst: q.pending[0]?.ahead, firstWaitsFor: q.pending[0]?.next.status }, omit, guard);
    const p = RUN_ID.test(id) ? q.pending.find((x) => x.runId === id) : undefined;
    return p ? make("queue", id, "a queued run", { ahead: p.ahead, kind: p.kind, enqueuedAt: p.enqueuedAt, flow: p.flow, repository: p.githubRepo, issue: p.issue, status: p.next.status, why: p.next.why }, omit, guard) : undefined;
  },

  // GET /api/repos — a user's own repositories; GET /api/admin/repos — all of them, for an admin. The admin's
  // settings of a repository are left out for both roles.
  repository: (ctx, user, id, guard) => {
    if (!UUID.test(id)) return undefined;
    const rec = user.role === "admin" && allowed(ctx, user, ["admin", "repos"]) ? listAllRepos().find((r) => r.id === id) : allowed(ctx, user, ["repos"]) ? listRepos(user.id).find((r) => r.id === id) : undefined;
    if (!rec) return undefined;
    const name = rec.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    return make("repository", id, `the repository ${name}`, { name, signIn: rec.method, added: rec.added, connectionOk: rec.connection?.ok, connectionCheckedAt: rec.connection?.at },
      ["settings", "definitionOfReady", "owner", "credential", "publicKey", "username", "installation"], guard, old(rec.connection?.at) ? ["connectionOk", "connectionCheckedAt"] : []);
  },

  // GET /api/refinement/:id — the owner's session; any session for an admin. `sessionFor` is the check of that call.
  refinement: (ctx, user, id, guard) => {
    if (!UUID.test(id) || !allowed(ctx, user, ["refinement", id])) return undefined;
    const s = sessionFor(user, id);
    if (!s) return undefined;
    return make("refinement", id, "a refinement session", { title: s.title, state: s.state, repository: s.repo, drafts: s.drafts.length, created: s.created, updated: s.updated },
      ["owner", "idea", "brief", "talk", "map", "draft texts", "architect run", "source"], guard, old(s.updated, 30 * DAY_MS) ? ["state"] : []);
  },

  // GET /api/board — admin only. The id is the card's key, or "owner/name#number".
  issue: (ctx, user, id, guard) => {
    if (id.length > 200 || !allowed(ctx, user, ["board"])) return undefined;
    for (const r of boardFor(ctx).repos) {
      for (const col of r.columns) {
        const c = col.cards.find((x) => x.key === id || `${r.repo}#${x.issue}` === id);
        if (!c) continue;
        return make("issue", id, `issue #${c.issue} on the board`, { repository: r.repo, issue: c.issue, title: c.title, column: col.title, step: c.step, run: c.runId, since: c.since, who: c.next.who, status: c.next.status, why: c.next.why, waitsForIssues: c.after.join(", ") },
          ["owner", "ownerName", "watcher", "chain"], guard);
      }
    }
    return undefined;
  },

  // GET /api/monitor/findings/:id — admin only.
  problem: (ctx, user, id, guard) => {
    if (!/^[0-9a-f]{16}$/.test(id) || !allowed(ctx, user, ["monitor", "findings", id])) return undefined;
    const { findings, broken } = readFindings();
    const f = broken ? undefined : findings.find((x) => markerHash(x.fingerprint) === id);
    if (!f) return undefined;
    return make("problem", id, "a finding of the monitor", { detector: f.detector, severity: f.severity, summary: f.summary, about: f.about, repository: f.repo, firstSeen: f.firstSeen, lastSeen: f.lastSeen, timesSeen: f.count, gone: f.gone, bugStory: f.report?.issue },
      ["fingerprint", "evidence", "earlier stories", "skipped"], guard, f.gone ? ["lastSeen", "timesSeen"] : []);
  },

  // GET /api/next — admin only: what happens next, for all runs. Counts only.
  next: (ctx, user, id, guard) => {
    if (id !== "next" || !allowed(ctx, user, ["next"])) return undefined;
    const n = allNext(ctx);
    const all = [...n.server, ...n.watchers, ...n.issues, ...n.runs];
    const count = (who: string) => all.filter((x) => x.who === who).length;
    return make("next", id, "what happens next", { runs: n.runs.length, issues: n.issues.length, watchers: n.watchers.length, waitingForYou: count("You"), waitingForFoundry: count("Foundry"), waitingForAnotherStory: count("Another story"), waitingForATimeLimit: count("A time limit"), somethingIsWrong: count("Something is wrong") },
      ["the records themselves"], guard);
  },

  // GET /api/health — admin only.
  health: (ctx, user, id, guard) => {
    if (id !== "health" || !allowed(ctx, user, ["health"])) return undefined;
    const h = health(ctx);
    return make("health", id, "the health of the server", { ok: h.ok, summary: h.summary, problems: h.problems.length, firstProblem: h.problems[0]?.status, firstProblemWhy: h.problems[0]?.why, findingsOpen: h.monitorFindings?.open, findingsStored: h.monitorFindings?.total, skillProblems: h.skillProblems?.length },
      ["version", "update", "repos", "skill folders"], guard);
  },
};

/**
 * The snapshot of one thing for one account, or undefined. Never throws: a kind that is not known, an id of the
 * wrong shape, a record of another account and a reader that fails are all "not found".
 */
export function helpSnapshot(ctx: ApiContext, asker: Asker, ref: { kind: string; id: string }, guard: GuardOptions = {}): Snapshot | undefined {
  try {
    if (typeof ref?.kind !== "string" || typeof ref.id !== "string" || !Object.hasOwn(ADAPTERS, ref.kind)) return undefined;
    const user = currentAccount(asker);
    if (!user) return undefined;
    return ADAPTERS[ref.kind as SnapshotKind](ctx, user, ref.id, guard);
  } catch {
    return undefined;
  }
}

/** The lookup of `resolveContext`: a thing a page names is found exactly when it has a snapshot for the account. */
export function snapshotResolver(ctx: ApiContext, guard: () => GuardOptions = () => ({})): EntityResolver {
  return (asker, ref) => {
    const s = helpSnapshot(ctx, asker, ref, guard());
    return s ? { label: s.label } : undefined;
  };
}
