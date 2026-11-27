import type { SafeRestart } from "./safe-restart.js";
import type { RestartState } from "./server/next.js";

/** What each drain waits for, in words. A health restart is the safe restart itself. */
export const DRAIN_WHAT: Record<Exclude<RestartState["why"], "health">, string> = {
  new_version: "a new version",
  data_folder: "a moved data folder",
  settings: "a changed setting",
};

/** The reason for the safe restart when this drain waited longer than the limit; undefined otherwise (also for limit 0, `health`, or a `since` that cannot be read). */
export function drainOverLimit(restart: RestartState | undefined, limitMinutes: number, nowMs: number): string | undefined {
  if (!restart || restart.why === "health" || limitMinutes <= 0) return undefined;
  const since = Date.parse(restart.since);
  if (Number.isNaN(since) || nowMs - since <= limitMinutes * 60_000) return undefined;
  return `the restart for ${DRAIN_WHAT[restart.why]} waited longer than ${limitMinutes} ${limitMinutes === 1 ? "minute" : "minutes"}`;
}

export interface DrainLimitOptions {
  restart: () => RestartState | undefined;
  limitMinutes: () => number;
  safeRestart: Pick<SafeRestart, "request">;
  log: (m: string) => void;
  now?: () => number;
  everyMs?: number;
}

/** Watches a waiting restart: when it waits too long for the runs, it asks for the restart at a safe moment (#963). */
export class DrainLimit {
  private timer?: NodeJS.Timeout;
  /** The `since` of the drain an unsupervised server already told about. */
  private toldUnsupervised?: string;
  private toldErrors = new Set<string>();

  constructor(private o: DrainLimitOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.o.everyMs ?? 30_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One check. Never throws. */
  check(): "none" | "started" | "waiting" | "unsupervised" {
    try {
      const restart = this.o.restart();
      const reason = drainOverLimit(restart, this.o.limitMinutes(), (this.o.now ?? Date.now)());
      if (!restart || !reason) return "none";
      const result = this.o.safeRestart.request(reason);
      if (result === "unsupervised" && this.toldUnsupervised !== restart.since) {
        this.toldUnsupervised = restart.since;
        this.o.log(`restart: ${reason}, but this server cannot restart itself (no supervisor); it keeps waiting for the runs`);
      }
      return result;
    } catch (e) {
      this.fail((e as Error).message);
      return "none";
    }
  }

  /** Logs each error once. */
  private fail(message: string): void {
    if (this.toldErrors.has(message)) return;
    this.toldErrors.add(message);
    try {
      this.o.log(`restart: the check of the drain limit failed (${message})`);
    } catch {
      // a log that fails must not end the server
    }
  }
}
