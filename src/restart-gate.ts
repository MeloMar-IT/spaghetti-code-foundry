// The restart guard (#961): a small file handshake that keeps the watchdog from cutting a step that must not be cut.
// Each side writes its own file first and then reads the other's, so at least one side always sees the other.
//   server:   write restart-guard.json (protected work)  → read restart-intent.json, wait while a restart is announced
//   watchdog: write restart-intent.json (the restart)    → read restart-guard.json, withdraw when work is protected
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GUARD_FILE = "restart-guard.json";
export const INTENT_FILE = "restart-intent.json";
export const INTENT_TTL_MS = 60_000;
const POLL_MS = 200;
const MAX_ITEMS = 20;

export interface Guard {
  version: 1;
  /** The server that wrote it; a guard of another process says nothing. */
  pid: number;
  /** All runs in a protected step; `items` holds the first 20. */
  count: number;
  items: { runId: string; step: string }[];
  /** The self-updater builds or installs. */
  updating: boolean;
}

export interface RestartGateOptions {
  dir: string;
  pid?: number;
  uncuttable: () => { runId: string; step: string }[];
  updating: () => boolean;
  now?: () => number;
  /** Blocks the thread: nothing of the server may go on while a restart is announced. */
  pause?: (ms: number) => void;
  log?: (m: string) => void;
}

const sleepSync = (ms: number) => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** A name that is not plain is shown as `unknown`; it still counts. */
const safeName = (x: unknown): string => (typeof x === "string" && /^[\w./-]{1,200}$/.test(x) ? x : "unknown");

/** Replaces the whole file: a reader sees the old text or the new one. */
export function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // the first error is the one to report
    }
    throw e;
  }
}

/** Is a restart of the process `target` announced right now? A missing or broken file announces nothing. */
function announced(dir: string, target: number, now: number): boolean {
  try {
    const i = JSON.parse(readFileSync(join(dir, INTENT_FILE), "utf8")) as { target?: unknown; at?: unknown };
    return i.target === target && typeof i.at === "string" && Math.abs(now - Date.parse(i.at)) < INTENT_TTL_MS;
  } catch {
    return false;
  }
}

/** The server's side. `publish` never throws; it returns a reason when protected work must not start. */
export function createRestartGate(o: RestartGateOptions): { publish(): string | undefined } {
  const pid = o.pid ?? process.pid;
  const file = join(o.dir, GUARD_FILE);
  const now = o.now ?? Date.now;
  let failing = false;
  const say = (m: string) => {
    try {
      o.log?.(m);
    } catch {
      // a log that fails must not stop a run
    }
  };
  const wait = () => {
    // bounded twice: by the age of the announcement, and by the number of looks should the clock stand still or go back
    for (let i = 0; i <= (2 * INTENT_TTL_MS) / POLL_MS && announced(o.dir, pid, now()); i++) (o.pause ?? sleepSync)(POLL_MS);
  };
  return {
    publish() {
      try {
        let protectedWork = true;
        try {
          const held = o.uncuttable();
          const guard: Guard = {
            version: 1, pid, count: held.length,
            items: held.slice(0, MAX_ITEMS).map((r) => ({ runId: safeName(r.runId), step: safeName(r.step) })),
            updating: o.updating(),
          };
          mkdirSync(o.dir, { recursive: true });
          writeAtomic(file, JSON.stringify(guard));
          protectedWork = guard.count > 0 || guard.updating;
          failing = false;
        } catch (e) {
          // without a guard file the watchdog does not restart
          rmSync(file, { force: true });
          if (!failing) say(`! restart guard: could not be written (${(e as Error).message}); the watchdog does not restart meanwhile`);
          failing = true;
        }
        if (protectedWork) wait();
        return undefined;
      } catch (e) {
        say(`! restart guard: could not be written or removed (${(e as Error).message})`);
        return "the restart guard could not be written or removed, so a restart could cut this step";
      }
    },
  };
}

/** The guard file, or undefined when it cannot be trusted (missing, broken or newer). */
export function readGuard(dir: string): Guard | undefined {
  try {
    const g = JSON.parse(readFileSync(join(dir, GUARD_FILE), "utf8")) as Partial<Guard>;
    const whole = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
    if (g.version !== 1 || !whole(g.pid) || !whole(g.count) || typeof g.updating !== "boolean" || !Array.isArray(g.items)) return undefined;
    const items = g.items.slice(0, MAX_ITEMS).map((r) => ({ runId: safeName(r?.runId), step: safeName(r?.step) }));
    return { version: 1, pid: g.pid!, count: Math.max(g.count!, g.items.length), items, updating: g.updating };
  } catch {
    return undefined;
  }
}

/** The watchdog's side: says that the process `target` is about to be restarted. Throws when it cannot be said. */
export function announceRestart(dir: string, target: number, now: Date): void {
  writeAtomic(join(dir, INTENT_FILE), JSON.stringify({ target, at: now.toISOString() }));
}

/** Never throws: an announcement that stays ends by itself after its lifetime. */
export function withdrawRestart(dir: string): void {
  try {
    rmSync(join(dir, INTENT_FILE), { force: true });
  } catch {
    // it expires
  }
}
