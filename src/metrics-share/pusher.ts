import type { ShareReport } from "./report.js";
import { sendDelete, sendReport, type PushResult, type PushTarget } from "./push.js";
import {
  MAX_DELETES, loadShareState, newInstallId, saveShareState, shareLockFile, shareStateFile, withShareLock, type LastAnswer, type ShareState,
} from "./state.js";

// The server's push of the daily report (#889). Once a minute: while sharing is active (the admin setting is on and at least
// one account said yes), each finished UTC day since sharing started that was not accepted yet goes out with one POST. A
// failed day waits longer each time and is tried while it is at most 7 days old. When sharing stops (or the endpoint
// changes after a POST), the stop and a new install id are saved first, then one DELETE goes out for the old id.
// A state that cannot be saved is kept in memory and nothing more is sent until it is saved.
// Nothing here ever throws out of the timer, and a failure is logged once in fixed words without values.

export const METRICS_TICK_MS = 60_000;
export const RETRY_BASE_MS = 15 * 60_000;
export const RETRY_MAX_MS = 86_400_000;
export const MAX_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

export const METRICS_PUSH_WORDS = {
  failing: "metrics-share: the daily report or a delete could not be sent; it is tried again later",
  broken: "metrics-share: the push state file cannot be read; nothing is sent until it is fixed",
  unsaved: "metrics-share: the push state could not be saved; nothing more is sent until it is",
} as const;

export interface SharingConfig {
  allowed: boolean;
  endpoint: string;
  timeout_ms: number;
}

export const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number): string => dayOf(new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS));
/** Whole days from `day` to `today`. */
export const ageDays = (day: string, today: string): number => Math.round((Date.parse(`${today}T00:00:00.000Z`) - Date.parse(`${day}T00:00:00.000Z`)) / DAY_MS);

/** The wait after the `tries`-th failure: 15 min, doubling, at most 24 h; a longer `retry_after` wins. */
export function retryWaitMs(tries: number, retryAfterS?: number): number {
  const base = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, Math.min(tries, 30) - 1), RETRY_MAX_MS);
  return Math.max(base, (retryAfterS ?? 0) * 1000);
}

const due = (nextAt: string | undefined, now: Date): boolean => !nextAt || !(Date.parse(nextAt) > now.getTime());

/**
 * The days to send now, oldest first: the days from today − 7 to yesterday that are not accepted and are due, and that are
 * either from the start of sharing on or have a stored try (a failed day from before, for example a manual send, is retried).
 */
export function dueDays(state: ShareState, now: Date): string[] {
  if (!state.activeSince) return [];
  const today = dayOf(now);
  const out: string[] = [];
  for (let d = addDays(today, -MAX_AGE_DAYS); d < today; d = addDays(d, 1)) {
    const e = state.days[d];
    const inWindow = d >= state.activeSince || e !== undefined;
    if (inWindow && !e?.accepted && due(e?.nextAt, now)) out.push(d);
  }
  return out;
}

/** Drops the day entries and the deletes older than 7 days. True when something was dropped. */
export function pruneDays(state: ShareState, now: Date): boolean {
  const today = dayOf(now);
  let changed = false;
  for (const d of Object.keys(state.days)) {
    if (ageDays(d, today) > MAX_AGE_DAYS) {
      delete state.days[d];
      changed = true;
    }
  }
  const kept = state.deletes.filter((d) => ageDays(d.since, today) <= MAX_AGE_DAYS);
  if (kept.length !== state.deletes.length) {
    state.deletes = kept;
    changed = true;
  }
  return changed;
}

const fresh = (today: string): ShareState => ({ version: 1, install: newInstallId(), activeSince: today, posted: false, days: {}, deletes: [] });

/**
 * Brings the state in line with whether sharing is active and the endpoint. Pure apart from new ids.
 * A stop (or an endpoint change) after a POST adds a delete for the old id and gives a new one; `deferred` when the
 * delete list is full and the stop has to wait.
 */
export function reconcile(state: ShareState | undefined, active: boolean, endpoint: string, now: Date): { state?: ShareState; changed: boolean; deferred: boolean } {
  const today = dayOf(now);
  if (!state) return active ? { state: fresh(today), changed: true, deferred: false } : { changed: false, deferred: false };
  const s: ShareState = structuredClone(state);
  if (s.posted && (!active || s.endpoint !== endpoint)) {
    if (s.deletes.length >= MAX_DELETES) return { state: s, changed: false, deferred: true };
    if (s.endpoint) s.deletes.push({ install: s.install, endpoint: s.endpoint, since: today, tries: 0 });
    const next: ShareState = { version: 1, install: newInstallId(), posted: false, days: {}, deletes: s.deletes, ...(s.last ? { last: s.last } : {}), ...(active ? { activeSince: today } : {}) };
    return { state: next, changed: true, deferred: false };
  }
  if (!active && s.activeSince) {
    const next: ShareState = { version: 1, install: newInstallId(), posted: false, days: {}, deletes: s.deletes, ...(s.last ? { last: s.last } : {}) };
    return { state: next, changed: true, deferred: false };
  }
  if (active && !s.activeSince) {
    s.activeSince = today;
    return { state: s, changed: true, deferred: false };
  }
  return { state: s, changed: false, deferred: false };
}

const lastOf = (r: PushResult, request: LastAnswer["request"], now: Date, day?: string): LastAnswer => ({
  at: now.toISOString(), request, ...(day ? { day } : {}), result: r.result, ...(r.status !== undefined ? { status: r.status } : {}),
});

export interface SendContext {
  target: PushTarget;
  /** Builds the report of the day with the install id. */
  build(day: string, install: string): Promise<ShareReport>;
  /** Whether sharing is still active for the report just built (checked right before it is sent). */
  stillActive(): boolean;
  /** Saves the state; false when it could not be saved. */
  save(state: ShareState): boolean;
  now(): Date;
  signal?: AbortSignal;
  /** For tests. */
  send?: (t: PushTarget, report: ShareReport, signal?: AbortSignal) => Promise<PushResult>;
}

export type OneResult =
  | { kind: "accepted" | "failed"; result: PushResult; saved: boolean }
  | { kind: "skipped"; why: "accepted" | "not-active" | "not-saved" };

/**
 * Builds and sends the report of one day, and records the answer in `state` (changed in place and saved).
 * A report that cannot be built is a failed try ("error"): it waits and is logged like any other failure.
 */
export async function pushOne(day: string, state: ShareState, c: SendContext): Promise<OneResult> {
  if (state.days[day]?.accepted) return { kind: "skipped", why: "accepted" };
  if (!state.posted || state.endpoint !== c.target.endpoint) {
    state.posted = true;
    state.endpoint = c.target.endpoint;
    if (!c.save(state)) return { kind: "skipped", why: "not-saved" };
  }
  const built = await Promise.resolve()
    .then(() => c.build(day, state.install))
    .then((r) => r, () => undefined);
  if (!c.stillActive() || c.signal?.aborted) return { kind: "skipped", why: "not-active" };
  const r: PushResult = built ? await (c.send ?? sendReport)(c.target, built, c.signal) : { result: "error" };
  const now = c.now();
  const tries = (state.days[day]?.tries ?? 0) + 1;
  state.last = lastOf(r, "send", now, day);
  state.days[day] = r.result === "accepted"
    ? { accepted: now.toISOString(), tries }
    : { tries, nextAt: new Date(now.getTime() + retryWaitMs(tries, r.retryAfterS)).toISOString() };
  const saved = c.save(state);
  return { kind: r.result === "accepted" ? "accepted" : "failed", result: r, saved };
}

export interface PusherDeps {
  /** The metrics_sharing settings; throws when they cannot be read (the tick is then skipped). */
  config(): SharingConfig;
  /** The accounts that said yes; throws when users.json cannot be read (the tick is then skipped). */
  accounts(): string[];
  build(day: string, accounts: readonly string[], install: string): Promise<ShareReport>;
  version: string;
  log(line: string): void;
  now?: () => Date;
  file?: string;
  lockFile?: string;
  /** For tests: replace the save. */
  save?: (state: ShareState, file: string) => boolean;
}

export interface MetricsPusher {
  tick(): Promise<void>;
  start(everyMs?: number): void;
  stop(): void;
}

export function metricsPusher(deps: PusherDeps): MetricsPusher {
  const now = deps.now ?? (() => new Date());
  const file = deps.file ?? shareStateFile();
  const lockFile = deps.lockFile ?? shareLockFile();
  const save = (s: ShareState) => (deps.save ?? saveShareState)(s, file);
  let inFlight: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let controller = new AbortController();
  let failing = false;
  let brokenLogged = false;
  let unsavedLogged = false;
  /** A state that could not be saved: it is saved first, and nothing else is sent until it is. */
  let pending: ShareState | undefined;

  const log = (line: string) => {
    try {
      deps.log(line);
    } catch {
      // a failing log must not stop the pusher
    }
  };
  const failed = () => {
    if (!failing) log(METRICS_PUSH_WORDS.failing);
    failing = true;
  };
  /** Saves; a failure is logged once per run of failures. */
  const persist = (s: ShareState): boolean => {
    if (save(s)) {
      unsavedLogged = false;
      return true;
    }
    if (!unsavedLogged) log(METRICS_PUSH_WORDS.unsaved);
    unsavedLogged = true;
    return false;
  };
  /** Saves a state the tick goes on with; when that fails, the state is kept as pending and the tick ends. */
  const keep = (s: ShareState): boolean => {
    if (persist(s)) return true;
    pending = s;
    return false;
  };

  async function body(): Promise<void> {
    let cfg: SharingConfig;
    let accounts: string[];
    try {
      cfg = deps.config();
      accounts = cfg.allowed ? deps.accounts() : [];
    } catch {
      return; // an unreadable config or users.json is never a yes or a no
    }
    if (pending) {
      if (!persist(pending)) return;
      pending = undefined;
    }
    const active = cfg.allowed && accounts.length > 0;
    const loaded = loadShareState(file);
    if (loaded.broken) {
      if (!brokenLogged) log(METRICS_PUSH_WORDS.broken);
      brokenLogged = true;
      return;
    }
    brokenLogged = false;
    const r = reconcile(loaded.state, active, cfg.endpoint, now());
    if (!r.state) return;
    const state = r.state;
    if (r.changed && !keep(state)) return; // the stop must be on disk before anything is sent
    if (pruneDays(state, now()) && !keep(state)) return;
    const signal = controller.signal;
    const target = (endpoint: string): PushTarget => ({ endpoint, timeoutMs: cfg.timeout_ms, version: deps.version });
    for (const d of [...state.deletes]) {
      if (stopped || !due(d.nextAt, now())) continue;
      const res = await sendDelete(target(d.endpoint), d.install, signal);
      if (stopped) return;
      const at = now();
      state.last = lastOf(res, "delete", at);
      if (res.result === "accepted") {
        failing = false;
        state.deletes.splice(state.deletes.indexOf(d), 1);
      } else {
        failed();
        d.tries += 1;
        d.nextAt = new Date(at.getTime() + retryWaitMs(d.tries, res.retryAfterS)).toISOString();
      }
      if (!keep(state)) return;
    }
    if (!active || r.deferred) return;
    const stillActive = () => {
      try {
        const c = deps.config();
        if (!c.allowed || c.endpoint !== cfg.endpoint) return false;
        const yes = new Set(deps.accounts());
        return accounts.every((a) => yes.has(a));
      } catch {
        return false;
      }
    };
    for (const day of dueDays(state, now())) {
      if (stopped) return;
      const one = await pushOne(day, state, { target: target(cfg.endpoint), build: (dd, install) => deps.build(dd, accounts, install), stillActive, save: keep, now, signal });
      if (one.kind === "skipped" || !one.saved) return; // a state that is not saved is pending
      if (one.kind === "accepted") {
        failing = false;
        continue;
      }
      if (!stopped) failed();
      return; // the next days wait for the next tick
    }
  }

  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const staleMs = (() => {
      try {
        return deps.config().timeout_ms + 60_000;
      } catch {
        return 120_000;
      }
    })();
    inFlight = withShareLock(body, { file: lockFile, staleMs })
      .then(() => undefined, () => failed())
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  return {
    tick,
    start(everyMs = METRICS_TICK_MS) {
      if (timer || stopped) return;
      timer = setInterval(() => void tick(), everyMs);
      timer.unref();
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      controller.abort();
      controller = new AbortController();
    },
  };
}
