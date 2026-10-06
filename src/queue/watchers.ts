import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, WatcherConfig } from "../config.js";
import { selfBuild, selfContains } from "../engine/guards.js";
import { flowDir, parseFlow } from "../flow/load.js";
import { readRateLimit, type RateReading } from "../github.js";
import { collectNames } from "../monitor/clean.js";
import type { DetectorInput, LogLine } from "../monitor/detectors.js";
import { describeEntry, loadGuard, storiesVerdict, writeLog } from "../monitor/guard.js";
import { activeMutes } from "../monitor/mutes.js";
import { Monitor, type MonitorStoryResult } from "../monitor/monitor.js";
import { buildLabelFor, Reporter } from "../monitor/report.js";
import type { BuiltinSteps } from "../monitor/story.js";
import type { RunSummary } from "../engine/state.js";
import { type RepoGhIdentity, repoGhIdentity } from "./gh-identity.js";
import type { Scheduler } from "./scheduler.js";
import { StatusComments, statusFile } from "./status-comment.js";
import { Watcher, type WatcherStatus } from "./watcher.js";

export interface WatcherManagerOptions {
  scheduler: Scheduler;
  runsDir: string;
  repo: string;
  config: () => Config;
  areaWait?: (run: RunSummary) => { runId: string; areas: string } | undefined;
  log: (msg: string) => void;
  /** The newest server log lines, for the monitor. */
  serverLog?: () => LogLine[];
  /** Set while the server waits to restart, for the monitor. */
  restart?: () => DetectorInput["restart"];
  /** When the server started (the monitor's quiet time counts from here; the Monitor object is made again when its config changes). */
  startedAt?: Date;
  /** Called at the start of every sync(): the server reads the stored watchers again here. */
  beforeSync?: () => void;
  /** The GitHub sign-in of a stored repository (tests replace it). */
  ghIdentity?: (repoId: string) => RepoGhIdentity;
}

/** What a watcher tracks right now, for the next-step records. */
export interface TrackedWatcher {
  watcher: WatcherConfig;
  status: WatcherStatus;
  issues: Watcher["tracked"];
}

/** Keeps running watchers in line with config.watchers (start, stop, restart on change). */
export class WatcherManager {
  private running = new Map<string, { watcher: Watcher; key: string; board: string }>();
  /** The GitHub sign-in of each stored repository that has a running watcher. */
  private identities = new Map<string, RepoGhIdentity>();
  /** Watchers stopped by stopAll() (a drain); read live so a tick still in flight shows up. */
  private drained: Watcher[] = [];

  /** One writer of status comments per repository, shared by its watchers. */
  private boards = new Map<string, StatusComments>();

  /** The monitor (source "monitor"), when one is enabled; it has no repository and no Watcher. */
  private monitor?: { monitor: Monitor; key: string };
  /** Monitors that were stopped or replaced; a check of theirs may still run and write the findings. */
  private retired = new Set<Monitor>();
  /** The monitor that was stopped or replaced last: its last check is still the last one while no other has run. */
  private lastMonitor?: Monitor;
  /** The last reading of GitHub's request limit, and when one was last tried (a try counts, so a failing call is not repeated). */
  private rate?: RateReading;
  private rateTried = 0;

  /** The running build, read when the manager is built (the commit the process started with). */
  private self = selfBuild();

  constructor(private o: WatcherManagerOptions) {}

  /** The sign-in of a stored watcher's repository (made once, kept while a watcher uses it); undefined for a watcher of config.yaml. */
  identityOf(cfg: Pick<WatcherConfig, "repoId">): RepoGhIdentity | undefined {
    if (!cfg.repoId) return undefined;
    let id = this.identities.get(cfg.repoId);
    if (!id) {
      id = this.o.ghIdentity ? this.o.ghIdentity(cfg.repoId) : repoGhIdentity(cfg.repoId, { config: this.o.config, log: this.o.log });
      this.identities.set(cfg.repoId, id);
    }
    return id;
  }

  /** Watchers with the host login share one board per repository; the others (own token or app) have a board of their own. */
  private boardKey(cfg: Pick<WatcherConfig, "github_repo" | "repoId">): string {
    const id = this.identityOf(cfg);
    return !id || id.usesHostLogin() ? cfg.github_repo : `${cfg.github_repo}#${cfg.repoId}`;
  }

  private board(cfg: Pick<WatcherConfig, "github_repo" | "repoId">, key = this.boardKey(cfg)): StatusComments {
    const repo = cfg.github_repo;
    let b = this.boards.get(key);
    if (!b) {
      b = new StatusComments(repo, (m) => this.o.log(`[${repo}] ${m}`), key === repo ? { file: statusFile() } : { file: statusFile(), key, gh: this.identityOf(cfg) });
      this.boards.set(key, b);
    }
    return b;
  }

  sync() {
    this.o.beforeSync?.();
    this.drained = [];
    const wanted = new Map(this.o.config().watchers.filter((w) => w.enabled && w.source !== "monitor").map((w) => [w.id, w]));
    for (const [id, r] of this.running) {
      const cfg = wanted.get(id);
      if (!cfg || JSON.stringify(cfg) !== r.key || this.boardKey(cfg) !== r.board) {
        r.watcher.stop(true);
        this.board(r.watcher.cfg, r.board).forget(id);
        this.running.delete(id);
        this.o.log(`[${id}] watcher stopped`);
      }
    }
    for (const [id, cfg] of wanted) {
      if (this.running.has(id)) continue;
      const board = this.boardKey(cfg);
      const watcher = new Watcher(cfg, {
        scheduler: this.o.scheduler,
        runsDir: this.o.runsDir,
        repo: this.o.repo,
        dailyBudget: () => (this.o.config().cost_limits ? this.o.config().daily_budget_usd : undefined),
        areaWait: this.o.areaWait,
        log: this.o.log,
        statusComments: this.board(cfg, board),
        watchers: () => this.o.config().watchers,
        peers: () => this.tracked(),
        afterCheck: () => this.noteRateLimit(),
        gh: this.identityOf(cfg),
      });
      this.running.set(id, { watcher, key: JSON.stringify(cfg), board });
      watcher.start();
      this.o.log(`[${id}] watching ${cfg.github_repo} (${cfg.source}) every ${cfg.every}`);
    }
    // The sign-in of a repository without a running watcher goes (its settings folder too).
    const used = new Set([...this.running.values()].map((r) => r.watcher.cfg.repoId));
    for (const [repoId, identity] of this.identities) {
      if (used.has(repoId)) continue;
      identity.dispose();
      this.identities.delete(repoId);
    }
    this.syncMonitor(this.o.config().watchers.find((w) => w.source === "monitor" && w.enabled));
  }

  /** Starts, stops or restarts the one monitor (same comparison as the watchers). */
  private syncMonitor(cfg?: WatcherConfig) {
    const key = cfg ? JSON.stringify(cfg) : undefined;
    if (this.monitor && this.monitor.key !== key) {
      this.monitor.monitor.stop();
      this.retire(this.monitor.monitor);
      this.o.log(`[${this.monitor.monitor.cfg.id}] monitor stopped`);
      this.monitor = undefined;
    }
    if (!cfg || this.monitor) return;
    const monitor = new Monitor(cfg, {
      scheduler: this.o.scheduler,
      watchers: () => this.tracked().map(({ watcher, status, issues }) => ({ cfg: watcher, status, issues })),
      restart: this.o.restart,
      thresholds: () => this.o.config().monitor,
      serverLog: this.o.serverLog,
      rateLimit: () => this.rate,
      beforeCheck: () => this.noteRateLimit(),
      log: this.o.log,
      guard: { startedAt: this.o.startedAt, onLogError: (m) => this.o.log(`[${cfg.id}] ${m}`) },
      self: this.self ? { repo: this.self.repo, contains: (c) => selfContains(c) } : undefined,
      reporter: new Reporter({
        config: () => this.o.config().monitor,
        buildLabel: (r) => buildLabelFor(this.o.config().watchers, r),
        names: (t) => collectNames(t, this.o.config()),
        builtinSteps: () => this.builtinSteps(),
        rateLimit: () => this.rate,
        guard: () => storiesVerdict({ startedAt: this.o.startedAt, cooldownMinutes: this.o.config().monitor.cooldown_minutes }),
        mutes: (now) => activeMutes(loadGuard(), now),
        record: (e) => {
          writeLog(e, { onError: (m) => this.o.log(`[${cfg.id}] ${m}`) });
          // A made story reaches the activity through the check's actions; only the log gets this line.
          if (e.event !== "story-made") monitor.act(describeEntry(e));
        },
        log: this.o.log,
      }),
    });
    this.monitor = { monitor, key: key! };
    monitor.start();
    this.o.log(`[${cfg.id}] monitoring the Foundry every ${cfg.every}`);
  }

  /** When the server started, if it told us. */
  get startedAt(): Date | undefined {
    return this.o.startedAt;
  }

  /**
   * Runs `fn` when no check of the monitor is in flight: the running monitor's, and the checks of monitors that were stopped or
   * replaced meanwhile. `fn` runs at once after the last wait, so it may read, change and save a file with no await in it.
   */
  async monitorIdle<T>(fn: () => T): Promise<T> {
    for (;;) {
      const busy: Promise<void>[] = [];
      for (const m of [...(this.monitor ? [this.monitor.monitor] : []), ...this.retired]) {
        const b = m.busy();
        if (b) busy.push(b);
        else this.retired.delete(m);
      }
      if (!busy.length) return fn();
      await Promise.allSettled(busy);
    }
  }

  /** Is a monitor running (enabled in the watchers)? */
  monitorRunning(): boolean {
    return !!this.monitor;
  }

  /** When the monitor last finished a check, as far as this process knows (also after the monitor was stopped). Undefined: none since the start. */
  monitorLastCheck(): string | undefined {
    return this.monitor?.monitor.status.lastTick ?? this.lastMonitor?.status.lastTick;
  }

  /** "Make a story now" through the running monitor; "not_running" when none runs. A monitor replaced meanwhile still finishes the call. */
  async storyNow(hash: string, by: string): Promise<MonitorStoryResult | { ok: false; code: "not_running" }> {
    const m = this.monitor?.monitor;
    return m ? m.storyNow(hash, by) : { ok: false, code: "not_running" };
  }

  /** Puts a line in the monitor's recent activity; does nothing when no monitor runs. */
  monitorAct(msg: string) {
    this.monitor?.monitor.act(msg);
  }

  private steps?: BuiltinSteps;

  /** The step ids of every built-in flow by flow name (read once): bug stories name only these. */
  private builtinSteps(): BuiltinSteps {
    if (this.steps) return this.steps;
    const dir = flowDir("builtin", this.o.repo);
    const steps: BuiltinSteps = {};
    try {
      for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
        try {
          const flow = parseFlow(readFileSync(join(dir, file), "utf8"), file);
          steps[flow.name] = flow.steps.map((s) => s.id);
        } catch {
          // a file that does not parse is skipped
        }
      }
    } catch {
      // no built-in flows folder: no step is named
    }
    return (this.steps = steps);
  }

  /** After a watcher's check, with a monitor on: read GitHub's request limit, at most once a minute. Never throws. */
  private async noteRateLimit() {
    if (!this.monitor || Date.now() - this.rateTried < 60_000) return;
    this.rateTried = Date.now();
    const own = await readRateLimit();
    // Runs may act as the bot (a token in an env var): its limit is its own, listed as "bot:core" and so on.
    const name = this.o.config().bot.gh_token_env;
    const token = name ? process.env[name] : undefined;
    const bot = token ? await readRateLimit(4_000, { GH_TOKEN: token }, "bot:") : undefined;
    if (!own && !bot) return;
    this.rate = { at: (own ?? bot)!.at, resources: { ...(own?.resources ?? {}), ...(bot?.resources ?? {}) } };
  }

  statuses(): (WatcherConfig & { status?: WatcherStatus })[] {
    return this.o.config().watchers.map((cfg) => ({
      ...cfg,
      status: cfg.source === "monitor" ? this.monitor?.monitor.status : this.running.get(cfg.id)?.watcher.status,
    }));
  }

  /** Every watcher that runs, or (after stopAll) the ones that were stopped; status and issues are read live. */
  tracked(): TrackedWatcher[] {
    const list = this.running.size ? [...this.running.values()].map((r) => r.watcher) : this.drained;
    return list.map((w) => ({ watcher: w.cfg, status: w.status, issues: w.tracked }));
  }

  private kickTimers = new Map<string, NodeJS.Timeout>();

  /**
   * A run on this repository finished: its watchers check right away (after a moment, so the
   * finished run's labels are updated first) — the next story, a resume or a retry needs no wait.
   */
  kickRepo(githubRepo: string, delayMs = 3000) {
    clearTimeout(this.kickTimers.get(githubRepo));
    const t = setTimeout(() => {
      this.kickTimers.delete(githubRepo);
      for (const r of this.running.values()) if (r.watcher.cfg.github_repo === githubRepo) r.watcher.kick();
    }, delayMs);
    t.unref?.();
    this.kickTimers.set(githubRepo, t);
  }

  async runNow(id: string) {
    if (this.monitor?.monitor.cfg.id === id) {
      await this.monitor.monitor.tick(true);
      return this.monitor.monitor.status;
    }
    const r = this.running.get(id);
    if (!r) throw new Error(`watcher "${id}" is not running`);
    await r.watcher.tick();
    return r.watcher.status;
  }

  /** Stops the watchers; the monitor too, unless `keepMonitor` (it watches the drain of a new version). */
  stopAll(keepMonitor = false) {
    this.drained = [...this.running.values()].map((r) => r.watcher);
    for (const r of this.running.values()) r.watcher.stop();
    this.running.clear();
    for (const identity of this.identities.values()) identity.dispose();
    this.identities.clear();
    if (keepMonitor) return;
    if (this.monitor) {
      this.monitor.monitor.stop();
      this.retire(this.monitor.monitor);
    }
    this.monitor = undefined;
  }

  /** Keeps a stopped monitor only while its check still runs. */
  private retire(m: Monitor) {
    this.lastMonitor = m;
    const b = m.busy();
    if (!b) return;
    this.retired.add(m);
    void b.then(() => this.retired.delete(m));
  }

  /** Stops the watchers and keeps the monitor running, so a restart that takes too long is seen. */
  drain() {
    this.stopAll(true);
  }
}
