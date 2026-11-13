import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactText } from "../credentials/redact.js";
import { FACTORY_HOME } from "../flow/load.js";
import { FeedQueryError, parseFeedQuery } from "../feed.js";
import {
  appendNotices, emptyNotices, noticesAnswer, parseNotices, pruneNotices,
  type NoticeState, type NoticesAnswer, type RaisedNotice,
} from "../notices.js";
import { sessionUser } from "./api-auth.js";
import { HttpError, send } from "./http.js";
import { authorize, findRule } from "./permissions.js";
import type { ApiContext, Route } from "./server.js";
import { checkServiceRepos } from "./service-requests.js";

/** A failed save is tried again after this long. */
export const NOTICE_RETRY_MS = 5000;

const noticesFile = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "notices.json");

interface Waiter {
  wake: () => void;
}

/** The notices for programs (#871), saved in notices.json. Built like the change feed's recorder. */
export class NoticeLog {
  private state: NoticeState;
  private waiters = new Set<Waiter>();
  private dirty = false;
  private readOnly = false;
  private stopped = false;
  private retry?: NodeJS.Timeout;

  constructor(private o: { log?: (m: string) => void; now?: () => number; retryMs?: number } = {}) {
    this.state = emptyNotices(this.now());
  }

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  start(): void {
    let raw: string | undefined;
    try {
      raw = readFileSync(noticesFile(), "utf8");
    } catch {
      raw = undefined;
    }
    const parsed = raw === undefined ? undefined : parseNotices(raw);
    if (parsed === "newer") {
      this.readOnly = true;
      this.o.log?.("notices: notices.json comes from a newer version; notices are kept in memory only");
    } else if (parsed) {
      this.state = parsed;
      if (pruneNotices(this.state, this.now())) this.dirty = true;
    } else {
      this.state = emptyNotices(this.now());
      this.dirty = true;
    }
    if (this.dirty) this.save();
  }

  /** Flushes, releases every waiter and refuses new waits. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    if (this.dirty) this.save(false);
    this.wakeAll();
  }

  /** Stores the notices (redacted). True when they are on disk (or already were); false when the save failed. */
  record(raised: readonly RaisedNotice[]): boolean {
    const at = this.now();
    const cut = pruneNotices(this.state, at);
    const n = appendNotices(this.state, raised, at, redactText);
    if (n > 0 || cut) this.dirty = true;
    const ok = this.dirty ? this.save() : true;
    if (n > 0) this.wakeAll();
    return ok;
  }

  private save(retry = true): boolean {
    if (this.readOnly) {
      this.dirty = false;
      return true;
    }
    try {
      const file = noticesFile();
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
      renameSync(tmp, file);
      chmodSync(file, 0o600);
      this.dirty = false;
      return true;
    } catch (e) {
      this.o.log?.(`notices: could not write notices.json: ${(e as Error).message}`);
      if (retry && !this.stopped && !this.retry) {
        this.retry = setTimeout(() => {
          this.retry = undefined;
          if (this.dirty) this.save();
        }, this.o.retryMs ?? NOTICE_RETRY_MS);
        this.retry.unref();
      }
      return false;
    }
  }

  /** Prunes first, so an idle server never answers a notice older than 7 days; a pruned state (and its floor) is saved. */
  answer(since: number | undefined): NoticesAnswer {
    if (pruneNotices(this.state, this.now())) {
      this.dirty = true;
      this.save();
    }
    return noticesAnswer(this.state, since);
  }

  /** Resolves when a notice is recorded, the time is up, or `signal` ends. Always removes its waiter. A wait after stop() ends at once. */
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
      if (this.stopped || signal.aborted) return done();
      this.waiters.add(w);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  waiting(): number {
    return this.waiters.size;
  }

  private wakeAll(): void {
    for (const w of [...this.waiters]) w.wake();
  }
}

export const noticesRoutes: Route = async (ctx: ApiContext, req, res, seg, method) => {
  if (seg[0] !== "notices" || seg[1] || method !== "GET") return false;
  const log = ctx.notices;
  if (!log) throw new HttpError(503, "notices are not running");
  const url = new URL(req.url ?? "/", "http://x");
  let q;
  try {
    q = parseFeedQuery(url.searchParams);
  } catch (e) {
    if (e instanceof FeedQueryError) throw new HttpError(400, e.message);
    throw e;
  }
  let a = log.answer(q.since);
  // A view as another account holds nothing: it answers at once.
  if (q.wait > 0 && url.searchParams.get("as") === null && !a.reset && !a.notices.length) {
    const gone = new AbortController();
    const onClose = () => gone.abort();
    res.on("close", onClose);
    const rule = findRule("GET", ["notices"])!;
    const deadline = Date.now() + q.wait * 1000;
    try {
      while (!gone.signal.aborted) {
        const left = deadline - Date.now();
        if (left > 0) await log.wait(left, gone.signal);
        if (gone.signal.aborted) return true;
        // The caller is looked up again: a revoked token, a removed scope, a demoted admin or a closed repository never leaks a notice.
        const who = sessionUser(ctx, req);
        authorize(ctx, who, rule, ["notices"]);
        checkServiceRepos(ctx, who, rule, ["notices"], url.searchParams);
        a = log.answer(q.since);
        if (a.reset || a.notices.length || log.isStopped || Date.now() >= deadline) break;
      }
    } finally {
      res.off("close", onClose);
    }
    if (gone.signal.aborted) return true;
  }
  return send(res, 200, a), true;
};
