import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findOwnedProject, getRepo, listAllRepos } from "../auth/repos.js";
import type { User } from "../auth/users.js";
import { FACTORY_HOME } from "../flow/load.js";
import {
  diffFeed, emptyFeed, feedAnswer, FeedQueryError, parseFeed, parseFeedQuery, pruneFeed,
  type FeedAnswer, type FeedEntry, type FeedKind, type FeedReader, type FeedState,
} from "../feed.js";
import { architectView } from "../refinement/architect.js";
import { changeView, isChange } from "../refinement/change-request.js";
import { listSessions } from "../refinement/store.js";
import { architectDeps } from "./api-refinement.js";
import { sessionUser } from "./api-auth.js";
import { HttpError, send } from "./http.js";
import { authorize, findRule, serviceAllows } from "./permissions.js";
import type { ApiContext, Route } from "./server.js";
import { mayActOn, opaqueKey } from "./turn-actions.js";
import { callerWorkspaces } from "./workspace-scope.js";
import { turnFor, wasActed } from "./your-turn.js";
import { DEFAULT_WORKSPACE } from "../workspaces/index.js";
import { validWorkspaceId } from "../workspaces/list.js";

export const FEED_TICK_MS = 5000;
/** A snapshot older than this is taken again before an answer. */
const FRESH_MS = 1000;
/** After a restart the Your-turn source waits for the watchers' first check, at most this long. */
const SETTLE_MS = 120_000;

/** The read route of each kind: a service account sees a kind only when its scope holds this route. */
const KIND_ROUTE: Record<FeedKind, string[]> = {
  turn: ["your-turn", "mine"],
  run: ["runs", ":id"],
  repo: ["repos"],
  change: ["changes", ":id"],
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
const ws = (v: unknown): string => (validWorkspaceId(v) ? v : DEFAULT_WORKSPACE);

/** The snapshot of every kind that could be read. A source that throws is left out of `kinds`: its old entries stay. */
export function feedSnapshot(ctx: ApiContext, now: Date, opts: { turn?: boolean } = {}): { map: Map<string, FeedEntry>; kinds: Set<FeedKind> } {
  const map = new Map<string, FeedEntry>();
  const kinds = new Set<FeedKind>();
  const part = (k: FeedKind, fn: () => void) => {
    const before = new Map(map);
    try {
      fn();
      kinds.add(k);
    } catch {
      map.clear();
      for (const [a, b] of before) map.set(a, b);
    }
  };

  part("run", () => {
    const queued = new Set(ctx.scheduler.queue().pending.map((p) => p.runId));
    for (const b of ctx.scheduler.briefs()) {
      if (queued.has(b.runId)) continue;
      const w = ws(b.workspace);
      map.set(`run:${b.runId}`, { f: `${b.status}|${b.archived ? 1 : 0}|${b.owner ?? ""}|${w}`, o: b.owner, w });
    }
    for (const id of queued) {
      const o = ctx.scheduler.ownerOf(id);
      const w = ctx.scheduler.workspaceOf(id);
      map.set(`run:${id}`, { f: `queued|0|${o ?? ""}|${w}`, o, w });
    }
  });

  part("repo", () => {
    for (const r of listAllRepos()) map.set(`repo:${r.id}`, { f: sha(JSON.stringify(r)), o: r.owner, w: ws(r.workspace) });
  });

  part("change", () => {
    const deps = architectDeps(ctx);
    for (const s of listSessions()) {
      if (!isChange(s) || s.state === "dropped") continue;
      const view = changeView(s, architectView(deps, s));
      const rec = findOwnedProject(s.owner, s.repo);
      const w = rec ? ws(rec.workspace) : undefined;
      const a = s.architect?.runId ? ctx.scheduler.workspaceOf(s.architect.runId) : w;
      // The sides are in the fingerprint too: a move with unchanged content is a change.
      const f = sha(`${s.updated}|${s.state}|${JSON.stringify(view)}|${s.owner}|${w ?? ""}|${a ?? ""}`);
      map.set(`change:${s.id}`, { f, o: s.owner, w, a });
    }
  });

  if (opts.turn !== false) {
    part("turn", () => {
      const tracked = ctx.watchers.tracked();
      for (const item of turnFor(ctx, now).all) {
        const cfg = tracked.find((t) => t.watcher.id === item.watcher)?.watcher;
        const owner = cfg?.ownerId;
        const mine = item.acts.length > 0 && !wasActed(ctx, item.key, item.stamp, now) && owner !== undefined && mayActOn(ctx, item, { id: owner }, false);
        const repo = cfg?.repoId ? getRepo(cfg.repoId) : undefined;
        // An item that stops being actionable (acted on, or its owner changed) changes the fingerprint; its record stays visible to the owner it left.
        const o = mine ? owner : undefined;
        const w = ws(repo?.workspace);
        map.set(`turn:${opaqueKey(item.key)}`, { f: `${item.stamp}|${o ?? ""}|${w}`, o, w });
      }
    });
  }
  return { map, kinds };
}

/** The caller as the feed sees them, from the current role, workspaces and scope. */
export function readerOf(user: User): FeedReader {
  const reader: FeedReader = { id: user.id, admin: user.role === "admin" && user.kind !== "service", workspaces: callerWorkspaces(user) };
  if (user.kind === "service") {
    reader.kinds = new Set((Object.keys(KIND_ROUTE) as FeedKind[]).filter((k) => {
      const rule = findRule("GET", KIND_ROUTE[k]!.map((p) => (p.startsWith(":") ? "x" : p)));
      return rule !== undefined && serviceAllows(user, rule);
    }));
  }
  return reader;
}

const feedFile = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "feed.json");

interface Waiter {
  wake: () => void;
}

export class FeedRecorder {
  private state: FeedState = emptyFeed(Date.now());
  private timer?: NodeJS.Timeout;
  private kickTimer?: NodeJS.Timeout;
  private lastTick = 0;
  private waiters = new Set<Waiter>();
  private started = 0;
  private fresh_ = false;
  private readOnly = false;
  private turnHeld = false;

  constructor(private ctx: ApiContext, private o: { tickMs?: number; log?: (m: string) => void } = {}) {}

  start(): void {
    this.started = Date.now();
    let raw: string | undefined;
    try {
      raw = readFileSync(feedFile(), "utf8");
    } catch {
      raw = undefined;
    }
    const parsed = raw === undefined ? undefined : parseFeed(raw);
    if (parsed === "newer") {
      this.readOnly = true;
      this.o.log?.("feed: feed.json comes from a newer version; the feed runs in memory only");
    } else if (parsed) {
      this.state = parsed;
      // Your turn lives in memory: right after a start the watchers have not looked yet, and every item would seem gone.
      this.turnHeld = Object.keys(parsed.snapshot).some((k) => k.startsWith("turn:"));
    } else {
      this.fresh_ = true;
      this.dirty = true;
      this.state = emptyFeed(Date.now());
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), this.o.tickMs ?? FEED_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    clearTimeout(this.kickTimer);
    this.wakeAll();
  }

  /** Takes a snapshot soon (a run finished). */
  kick(): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = undefined;
      this.tick();
    }, 20);
    this.kickTimer.unref();
  }

  /** Takes a snapshot when the last one is older than a second. */
  fresh(): void {
    if (Date.now() - this.lastTick > FRESH_MS) this.tick();
  }

  tick(): void {
    const at = Date.now();
    this.lastTick = at;
    let n = 0;
    try {
      // Settled once every tracked watcher has finished a check (lastTick is set at the end of each check), or after the limit.
      const settled = this.ctx.watchers.tracked().every((t) => t.status.lastTick !== undefined);
      if (this.turnHeld && (settled || at - this.started > SETTLE_MS)) this.turnHeld = false;
      const { map, kinds } = feedSnapshot(this.ctx, new Date(at), { turn: !this.turnHeld });
      if (this.turnHeld) kinds.delete("turn");
      n = diffFeed(this.state, kinds, map, at, this.fresh_);
      this.fresh_ = false;
      const cut = pruneFeed(this.state, at);
      if (n > 0 || cut) this.dirty = true;
      // A failed save stays dirty and is tried again at the next tick, even when nothing else changes.
      if (this.dirty) this.save();
    } catch (e) {
      this.o.log?.(`feed: ${(e as Error).message}`);
    }
    if (n > 0) this.wakeAll();
  }

  /** True while the in-memory state is not in feed.json (a change was recorded, or the save failed). */
  private dirty = false;
  private save(): void {
    if (this.readOnly) return;
    try {
      const file = feedFile();
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
      this.dirty = false;
    } catch (e) {
      this.o.log?.(`feed: could not write feed.json: ${(e as Error).message}`);
    }
  }

  answer(reader: FeedReader, since: number | undefined): FeedAnswer {
    return feedAnswer(this.state, since, reader);
  }

  /** Resolves when a change is recorded, the time is up, or `signal` ends. Always removes its waiter. */
  wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.waiters.delete(w);
        resolve();
      };
      const w: Waiter = { wake: done };
      const timer = setTimeout(done, ms);
      this.waiters.add(w);
      if (signal.aborted) done();
      else signal.addEventListener("abort", done, { once: true });
    });
  }

  waiting(): number {
    return this.waiters.size;
  }

  private wakeAll(): void {
    for (const w of [...this.waiters]) w.wake();
  }
}

export const feedRoutes: Route = async (ctx, req, res, seg, method, user) => {
  if (seg[0] !== "feed" || seg[1] || method !== "GET") return false;
  const feed = ctx.feed;
  if (!feed) throw new HttpError(503, "the change feed is not running");
  const url = new URL(req.url ?? "/", "http://x");
  let q;
  try {
    q = parseFeedQuery(url.searchParams);
  } catch (e) {
    if (e instanceof FeedQueryError) throw new HttpError(400, e.message);
    throw e;
  }
  feed.fresh();
  let who = user;
  let a = feed.answer(readerOf(who), q.since);
  // A view as another account holds nothing: it answers at once.
  if (q.wait > 0 && url.searchParams.get("as") === null && !a.reset && !a.changes.length) {
    const gone = new AbortController();
    const onClose = () => gone.abort();
    res.on("close", onClose);
    const rule = findRule("GET", ["feed"])!;
    const deadline = Date.now() + q.wait * 1000;
    try {
      while (!gone.signal.aborted) {
        const left = deadline - Date.now();
        if (left > 0) await feed.wait(left, gone.signal);
        if (gone.signal.aborted) return true;
        // The caller is looked up again: a revoked scope, a removed workspace or a demoted admin never leaks a change.
        who = sessionUser(ctx, req);
        authorize(ctx, who, rule, ["feed"]);
        a = feed.answer(readerOf(who), q.since);
        if (a.reset || a.changes.length || Date.now() >= deadline) break;
      }
    } finally {
      res.off("close", onClose);
    }
    if (gone.signal.aborted) return true;
  }
  return send(res, 200, a), true;
};
