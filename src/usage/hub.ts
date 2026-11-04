import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../auth/store.js";
import { ownedByUs } from "../telemetry/local.js";
import { UsageEventSchema, type UsageEvent, type UsageHandler } from "./schema.js";

/**
 * The usage hub: every event is checked, dropped when its id was seen, appended to `<data folder>/usage/usage-YYYY-MM.jsonl`
 * (the UTC month of the event), and queued for each subscribed plugin handler. Delivery is at most once. Nothing here throws
 * into the engine or waits for a handler: a handler runs from `setImmediate`, one event at a time, under a time limit.
 */

export const USAGE_DIR = "usage";
export const usageDir = (): string => join(dataHome(), USAGE_DIR);
export const usageFile = (month: string): string => join(usageDir(), `usage-${month}.jsonl`);

export const HANDLER_TIMEOUT_MS = 5000;
export const QUEUE_MAX = 1000;
export const STUCK_MAX = 3;
const SEEN_MAX = 2000;
const SAFE = (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const UID = (): number | undefined => process.getuid?.();

export const REASON_THREW = "a usage handler threw an error";
export const REASON_TIMEOUT = "a usage handler did not finish in time";
export const REASON_FULL = "the queue of a usage handler was full: events were dropped";
export const REASON_SKIPPED = "a usage handler was skipped after calls that did not finish: events were dropped";

export interface UsageSubscription {
  /** Who owns the subscription (one per `loadPlugins` call), so `disposeUsage(owner)` removes it. */
  owner: string;
  /** The plugin's label, for the problem list. */
  plugin: string;
  handler: UsageHandler;
  /** Called once per plugin and reason with a fixed text. */
  report: (reason: string) => void;
  timeoutMs?: number;
}

interface Sub extends UsageSubscription {
  queue: UsageEvent[];
  scheduled: boolean;
  busy: boolean;
  stuck: number;
  active: boolean;
}

let subs: Sub[] = [];
let seen = new Set<string>();
let order: string[] = [];
let reported = new Set<string>();
let waiters: (() => void)[] = [];
/** Handler calls still running, also after their subscription is gone: a shutdown waits for them, not for the queues. */
const running = new Set<Promise<unknown>>();
let warnedWrite = false;

function problem(s: Sub, reason: string): void {
  const key = `${s.owner}\0${s.plugin}\0${reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  try {
    s.report(reason);
  } catch {
    /* a failing report must not reach the engine */
  }
}

function freeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
}

/** Adds a handler. Returns the function that removes it. */
export function subscribeUsage(sub: UsageSubscription): () => void {
  const s: Sub = { ...sub, queue: [], scheduled: false, busy: false, stuck: 0, active: true };
  subs.push(s);
  return () => remove(s);
}

function remove(s: Sub): void {
  s.active = false;
  s.queue = [];
  subs = subs.filter((x) => x !== s);
  settle();
}

/** Removes every handler of `owner`; queued events are dropped. */
export function disposeUsage(owner: string): void {
  for (const s of subs.filter((x) => x.owner === owner)) remove(s);
  for (const k of [...reported]) if (k.startsWith(`${owner}\0`)) reported.delete(k);
}

const idle = (): boolean => running.size === 0 && subs.every((s) => !s.busy && !s.scheduled && s.queue.length === 0);
function settle(): void {
  if (!idle()) return;
  const w = waiters;
  waiters = [];
  for (const f of w) f();
}

/** Resolves when every queue is empty (or after `maxMs`). Handlers that never finish do not hold it. */
export function usageIdle(maxMs = 2000): Promise<void> {
  if (idle()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, maxMs);
    timer.unref();
    function done(): void {
      clearTimeout(timer);
      waiters = waiters.filter((f) => f !== done);
      resolve();
    }
    waiters.push(done);
  });
}

/** Forgets everything. For tests. */
export function resetUsage(): void {
  subs.forEach((s) => (s.active = false));
  subs = [];
  seen = new Set();
  order = [];
  reported = new Set();
  warnedWrite = false;
  settle();
  const w = waiters;
  waiters = [];
  for (const f of w) f();
}

function schedule(s: Sub): void {
  if (s.scheduled || s.busy || !s.active) return;
  s.scheduled = true;
  setImmediate(() => void drain(s));
}

/** Calls the handler once; false when it threw or did not finish in time. */
async function call(s: Sub, e: UsageEvent): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let late = false;
  const work = (async () => s.handler(e))();
  running.add(work);
  const done = () => {
    running.delete(work);
    settle();
  };
  work.then(done, done);
  const finished = work.then(
    () => {
      if (late) s.stuck--;
    },
    (err: unknown) => {
      if (late) {
        s.stuck--;
        return;
      }
      throw err;
    },
  );
  const limit = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), s.timeoutMs ?? HANDLER_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const r = await Promise.race([finished.then(() => "done" as const), limit]);
    if (r === "timeout") {
      late = true;
      s.stuck++;
      problem(s, REASON_TIMEOUT);
    }
  } catch {
    problem(s, REASON_THREW);
  } finally {
    clearTimeout(timer);
  }
}

async function drain(s: Sub): Promise<void> {
  s.scheduled = false;
  if (s.busy) return;
  s.busy = true;
  try {
    while (s.active && s.queue.length) {
      const e = s.queue.shift()!;
      if (s.stuck >= STUCK_MAX) {
        problem(s, REASON_SKIPPED);
        continue;
      }
      await call(s, e);
    }
  } finally {
    s.busy = false;
    settle();
  }
}

/** Checks, stores and queues the events. Never throws, never waits for a handler. */
export function emitUsage(events: UsageEvent | UsageEvent[]): void {
  for (const raw of Array.isArray(events) ? events : [events]) {
    try {
      const parsed = UsageEventSchema.safeParse(raw);
      if (!parsed.success) continue;
      const e = parsed.data;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      order.push(e.id);
      if (order.length > SEEN_MAX) seen.delete(order.shift()!);
      try {
        appendUsage(JSON.stringify(e), e.time.slice(0, 7));
      } catch (err) {
        if (!warnedWrite) {
          warnedWrite = true;
          process.stderr.write(`usage: cannot write the usage file (${(err as Error).message.split("\n")[0]})\n`);
        }
      }
      for (const s of subs) {
        if (s.queue.length >= QUEUE_MAX) {
          problem(s, REASON_FULL);
          continue;
        }
        s.queue.push(freeze(structuredClone(e)));
        schedule(s);
      }
    } catch {
      /* usage never breaks a run */
    }
  }
}

/** Appends one line to the month file. Throws on any problem; the caller drops the line. */
export function appendUsage(line: string, month: string): void {
  const home = dataHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const h = lstatSync(home);
  if (!h.isDirectory() || !ownedByUs(h, UID()) || (h.mode & 0o022) !== 0) throw new Error("the data folder is not private to this user");
  const dir = usageDir();
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const before = lstatSync(dir);
  if (!before.isDirectory() || !ownedByUs(before, UID())) throw new Error("the usage folder is not a folder of this user");
  if (before.mode & 0o077) chmodSync(dir, 0o700);
  const fd = openSync(usageFile(month), constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | SAFE, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || !ownedByUs(st, UID()) || st.dev !== before.dev) throw new Error("the usage file is not a plain file of this user");
    if (st.mode & 0o077) fchmodSync(fd, 0o600);
    const after = lstatSync(dir);
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) throw new Error("the usage folder was replaced");
    let torn = false;
    if (st.size > 0) {
      const last = Buffer.alloc(1);
      torn = readSync(fd, last, 0, 1, st.size - 1) !== 1 || last[0] !== 0x0a;
    }
    const buf = Buffer.from(`${torn ? "\n" : ""}${line}\n`);
    if (writeSync(fd, buf) !== buf.length) throw new Error("a short write");
  } finally {
    closeSync(fd);
  }
}
