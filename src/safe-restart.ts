import type { WatcherConfig } from "./config.js";
import { stepIs } from "./next-step.js";
import type { Scheduler } from "./queue/scheduler.js";
import type { RestartState } from "./server/next.js";
import type { ApiContext } from "./server/server.js";
import { RESTART_CODE } from "./supervise.js";

/** Steps of the built-in flows that must not be cut: cutting one can leave a branch or a release half-done. */
export const UNCUTTABLE_STEPS: readonly string[] = ["push", "push_feature", "merge_develop", "push_develop", "merge_main", "push_main", "merge_back", "push_back", "release_pr", "publish"];

/** True for a step that must not be cut (also with a `group/` prefix). */
export function mustNotCut(stepId: string | null | undefined): boolean {
  return !!stepId && stepIs(stepId, UNCUTTABLE_STEPS);
}

export type StepScheduler = Pick<Scheduler, "queue" | "currentStep" | "interrupt" | "retryResumes">;

/** Active runs in a step that must not be cut, with the step. */
export function uncuttableRuns(s: Pick<Scheduler, "queue" | "currentStep">): { runId: string; step: string }[] {
  return s.queue().active.flatMap(({ runId }) => {
    const step = s.currentStep(runId);
    return step && mustNotCut(step) ? [{ runId, step }] : [];
  });
}

/** True when a restart may exit or install: no run is active, nothing queued would be lost, and every resume is saved. */
export function restartIdle(s: Pick<Scheduler, "queue" | "draining" | "retryResumes">): boolean {
  const q = s.queue();
  // retryResumes() comes last: it tries to save only when the rest is already true
  return q.active.length === 0 && (s.draining || q.pending.length === 0) && s.retryResumes();
}

/** True when an enabled watcher resumes this interrupted run by itself: only the issue runs of a watcher are. */
export function watcherResumes(source: string | undefined, watchers: readonly Pick<WatcherConfig, "id" | "enabled">[]): boolean {
  const id = /^watcher (\S+) issue #\d+$/.exec(source ?? "")?.[1];
  return id !== undefined && watchers.some((w) => w.id === id && w.enabled);
}

export interface SafeRestartOptions {
  scheduler: StepScheduler;
  /** Sets the restart state and stops new work from starting. */
  drain: () => void;
  /** Something else must not be cut (the self-updater builds or installs): wait. */
  busy?: () => boolean;
  /** Another restart exits by itself once no run is active (a self-update installs first). */
  handOff?: () => boolean;
  /** How many checks the other restart gets before this one exits itself (default 60). */
  handOffChecks?: number;
  /** True for the source of a run that a watcher resumes. All other interrupted runs get a saved resume job. */
  watcherResumes?: (source: string | undefined) => boolean;
  beforeExit: () => void;
  log: (m: string) => void;
  supervised?: () => boolean;
  exit?: (code: number) => void;
  everyMs?: number;
}

/**
 * A restart at a safe moment: no new work starts, and it waits only while a run is in a step that must not be cut. Then the
 * other runs are interrupted (they are resumed after the restart) and the server exits for its supervisor.
 */
export class SafeRestart {
  private state?: { since: string; reason: string };
  private timer?: NodeJS.Timeout;
  private checking = false;
  /** Checks the other restart has had so far. Busy checks do not count, and a busy period does not reset it. */
  private handedOff = 0;
  /** What was logged last, so a line comes only when something changes. */
  private told = "";

  constructor(private o: SafeRestartOptions) {}

  /** True when the server runs under the supervisor, which starts it again on exit code 75. */
  available(): boolean {
    return (this.o.supervised ?? (() => process.env.FACTORY_SUPERVISED === "1"))();
  }

  waiting(): { since: string; reason: string } | undefined {
    return this.state ? { ...this.state } : undefined;
  }

  request(reason: string): "started" | "waiting" | "unsupervised" {
    if (!this.available()) return "unsupervised";
    if (this.state) return "waiting";
    this.state = { since: new Date().toISOString(), reason };
    this.o.drain();
    this.o.log(`health: restart asked for (${reason}) — no new runs start; restarting once no push, merge or release step runs`);
    // the first check is one tick away
    this.timer = setInterval(() => void this.tick(), this.o.everyMs ?? 5_000);
    this.timer.unref();
    return "started";
  }

  /** One check. Never throws; one at a time. */
  async tick(): Promise<void> {
    if (this.checking || !this.state) return;
    this.checking = true;
    try {
      await this.check();
    } catch (e) {
      const message = (e as Error).message;
      this.say(`error|${message}`, `health: the check failed (${message}); trying again`);
    } finally {
      this.checking = false;
    }
  }

  /** Clears the timer (before the exit, in tests). */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.state = undefined;
    this.told = "";
    this.handedOff = 0;
  }

  private async check(): Promise<void> {
    const s = this.o.scheduler;
    if (this.o.busy?.()) return;
    const held = uncuttableRuns(s);
    if (held.length) {
      const shown = held.slice(0, 5).map((r) => `${r.runId} (${r.step})`).join(", ") + (held.length > 5 ? `, and ${held.length - 5} more` : "");
      return this.say(`held|${held.map((r) => `${r.runId}:${r.step}`).join("|")}`, `health: waits for ${shown}`);
    }
    // nothing is awaited between the step check and the abort, so no run can reach such a step in between
    const ids = s.queue().active.map((a) => a.runId);
    if (ids.length) {
      let ok = false;
      try {
        ok = await s.interrupt(ids, undefined, { resume: (q) => !this.o.watcherResumes?.(q.source) });
      } catch {
        ok = false;
      }
      if (!ok) return this.say("not-stopped", "health: the runs did not stop in time; trying again");
    }
    // a resume that could not be saved would be lost with the process: wait until it is saved
    if (!s.retryResumes()) return this.say("resume-unsaved", "health: a resume could not be saved; trying again");
    // looked at again after the wait, with nothing awaited from here to the exit
    if (!this.state || this.o.busy?.() || s.queue().active.length > 0) return;
    if (this.o.handOff?.()) {
      // bounded: the other restart may never get to its exit (its journal cannot be written, its check keeps failing)
      if (++this.handedOff <= (this.o.handOffChecks ?? 60)) return this.say("hand-off", "health: the runs are stopped; the self-update installs its version and restarts");
      this.o.log("health: the self-update did not restart the server; restarting without waiting for it");
    }
    this.stop();
    this.o.log("health: restarting");
    this.o.beforeExit();
    (this.o.exit ?? process.exit)(RESTART_CODE);
  }

  private say(key: string, line: string): void {
    if (key === this.told) return;
    this.told = key;
    this.o.log(line);
  }
}

/** The safe restart of a server: it shows as "health" and takes over a restart that already waits. */
export function safeRestartFor(
  ctx: Pick<ApiContext, "scheduler" | "config"> & { restart?: RestartState; opts?: { watchers?: boolean } },
  o: Omit<SafeRestartOptions, "scheduler" | "drain">,
): SafeRestart {
  return new SafeRestart({
    watcherResumes: (source) => ctx.opts?.watchers !== false && watcherResumes(source, ctx.config().watchers),
    ...o,
    scheduler: ctx.scheduler,
    drain: () => {
      ctx.restart = { why: "health", since: new Date().toISOString() };
      ctx.scheduler.drain(); // the watchers keep running; nothing they queue starts before the restart
    },
  });
}
