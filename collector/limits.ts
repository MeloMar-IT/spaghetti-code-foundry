// The rate limits of the receiver (#890): a sliding one-hour window per install id and one over all requests.
// Held in memory only; a restart starts them again.

export interface LimitOptions { perInstallPerHour: number; totalPerHour: number }
export const DEFAULT_LIMITS: LimitOptions = { perInstallPerHour: 20, totalPerHour: 1000 };
export type Take = { ok: true } | { ok: false; retryAfter: number };

const HOUR_MS = 3_600_000;
const SWEEP_EVERY = 100;

/** Takes a slot in a window of timestamps (oldest first), or says how many whole seconds to wait. */
function takeIn(times: number[], limit: number, now: number): Take {
  while (times.length && times[0]! <= now - HOUR_MS) times.shift();
  if (times.length >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((times[0]! + HOUR_MS - now) / 1000)) };
  times.push(now);
  return { ok: true };
}

export class RateLimiter {
  private readonly total: number[] = [];
  private readonly installs = new Map<string, number[]>();
  private calls = 0;
  private readonly opts: LimitOptions;
  private readonly now: () => number;

  constructor(opts: LimitOptions = DEFAULT_LIMITS, now: () => number = Date.now) {
    this.opts = opts;
    this.now = now;
  }

  takeTotal(): Take {
    return takeIn(this.total, this.opts.totalPerHour, this.now());
  }

  /** Gives back the newest total slot: used when the per-install limit refuses the request after all. */
  giveBackTotal(): void {
    this.total.pop();
  }

  takeInstall(install: string): Take {
    const now = this.now();
    if (++this.calls % SWEEP_EVERY === 0) this.sweep(now);
    let times = this.installs.get(install);
    if (!times) this.installs.set(install, (times = []));
    return takeIn(times, this.opts.perInstallPerHour, now);
  }

  /** The number of install ids held (for tests). */
  get size(): number {
    return this.installs.size;
  }

  private sweep(now: number): void {
    for (const [id, times] of this.installs) if (!times.length || times[times.length - 1]! <= now - HOUR_MS) this.installs.delete(id);
  }
}
