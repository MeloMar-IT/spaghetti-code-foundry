import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { writeAudit } from "../auth/audit.js";
import type { ServiceConfig } from "../config.js";
import { combineRedactors, liveRedactor, makeRedactor, redactStream } from "../credentials/redact.js";
import { sleepSync } from "../home-migrate.js";
import { recordRepair, serviceNotStarted, serviceStarted } from "../monitor/repair-log.js";
import { holdLiveGroup, stopGroup } from "../steps/process.js";
import { ServiceLog, MAX_LOG_BYTES } from "./log.js";
import { ServiceProblem, accountProblem, actsForState, programProblem, reconcileServiceTokens, revokeServiceTokenSafe, serviceToken, signatureProblem } from "./setup.js";

export type ServiceState = "starting" | "running" | "waiting" | "refused" | "stopped";

/** What Health and `scf services` show. Fixed sentences only: no path, no secret. */
export interface ServiceView {
  name: string;
  state: ServiceState;
  since: string;
  pid?: number;
  restarts: number;
  lastExit?: { code: number | null; signal: string | null; at: string };
  problem?: string;
  nextStart?: string;
}

export interface Backoff {
  firstMs: number;
  maxMs: number;
  /** A run this long starts the backoff again at the first delay. */
  stableMs: number;
}
export const DEFAULT_BACKOFF: Backoff = { firstMs: 1000, maxMs: 5 * 60_000, stableMs: 5 * 60_000 };

/** The wait before the next start after `failures` failures in a row: 1 s, doubling, at most 5 minutes. */
export const nextDelay = (failures: number, b: Backoff = DEFAULT_BACKOFF): number => Math.min(b.firstMs * 2 ** Math.min(failures, 30), b.maxMs);

export interface SupervisorOptions {
  services: readonly ServiceConfig[];
  home: string;
  runsDir: string;
  /** The server's local address, handed to the program as SCF_URL. */
  url: string;
  log: (line: string) => void;
  /** A problem sentence when the scope names a route that cannot be granted; undefined when it is fine. */
  checkScope: (scope: string[]) => string | undefined;
  backoff?: Backoff;
  graceMs?: number;
  maxLogBytes?: number;
  /** Whether a process still runs (a zombie does not count). */
  alive?: (pid: number) => boolean;
  /** Writes an audit line for a start, stop or refusal caused by a change in config.yaml (#941). Default: the audit log, as `cli`. */
  audit?: (e: ServiceAuditEvent) => void;
  /** Test hook: called after a change passed its checks and before the running program is stopped. */
  afterCheck?: (name: string) => void;
}

export interface ServiceAuditEvent {
  action: "service-start" | "service-stop" | "service-refuse";
  result: "ok" | "failed";
  target: string;
  detail: string;
}

/** The part of the supervisor the server and the CLI use. */
export interface ServicesHandle {
  view(): ServiceView[];
  stop(): Promise<void>;
  stopNow(): void;
}

const BASE_ENV = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL", "TZ"];

/** Default `alive`: `ps` shows a zombie as `Z`; kill(pid, 0) cannot tell while the event loop is blocked. */
function psAlive(pid: number): boolean {
  try {
    const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 });
    const out = (r.stdout ?? "").trim();
    return out !== "" && !out.startsWith("Z");
  } catch {
    return false;
  }
}

interface Run {
  child: ChildProcess;
  pid?: number;
  startedAt: number;
  release?: () => void;
  exited: boolean;
  open: number;
  settle: () => void;
  settled: Promise<void>;
  /** Stopped on purpose (a change or a removal): no restart follows. */
  halted?: boolean;
}

interface Slot {
  cfg: ServiceConfig;
  log: ServiceLog;
  state: ServiceState;
  since: string;
  restarts: number;
  failures: number;
  lastExit?: ServiceView["lastExit"];
  problem?: string;
  nextStart?: string;
  timer?: NodeJS.Timeout;
  run?: Run;
  accountId?: string;
  /** A change from config.yaml that is not applied yet, and why (#941). */
  pending?: ServiceConfig;
  changeProblem?: string;
  pendingTimer?: NodeJS.Timeout;
  pendingFailures: number;
  /** The program exited by itself and does not run again yet: its next start is a repair. */
  afterExit?: boolean;
  /** The slot was started or changed by a config.yaml change: its start and refusals are audited. */
  fromChange?: boolean;
  lastAudited?: string;
}

const now = () => new Date().toISOString();

function actsForStateSafe(accountId: string): string | undefined {
  try {
    return actsForState(accountId);
  } catch {
    return undefined;
  }
}

/** Starts the configured programs, restarts them with a backoff, and stops them (#867). */
export class ServiceSupervisor implements ServicesHandle {
  private readonly slots: Slot[];
  private readonly leaving = new Set<Slot>();
  private readonly retries = new Set<Slot>();
  private queued?: readonly ServiceConfig[];
  private running?: Promise<void>;
  private stopping = false;
  private readonly backoff: Backoff;
  private readonly graceMs: number;
  private readonly alive: (pid: number) => boolean;
  private logFailed = false;

  constructor(private readonly o: SupervisorOptions) {
    this.backoff = o.backoff ?? DEFAULT_BACKOFF;
    this.graceMs = o.graceMs ?? 5000;
    this.alive = o.alive ?? psAlive;
    this.slots = o.services.map((cfg) => this.newSlot(cfg));
  }

  private newSlot(cfg: ServiceConfig): Slot {
    return {
      cfg, state: "starting", since: now(), restarts: 0, failures: 0, pendingFailures: 0,
      log: new ServiceLog(join(this.o.home, "services", `${cfg.name}.log`), this.o.maxLogBytes ?? MAX_LOG_BYTES),
    };
  }

  private audit(e: ServiceAuditEvent): void {
    try {
      (this.o.audit ?? ((x) => writeAudit("cli", x, 0)))(e);
    } catch {
      this.o.log("services: an audit line could not be written");
    }
  }

  /** Revokes the tokens an earlier run left, then starts every service. */
  start(): void {
    try {
      if (!reconcileServiceTokens()) this.o.log("services: some tokens of earlier runs could not be revoked");
    } catch {
      this.o.log("services: the tokens of earlier runs could not be checked");
    }
    for (const s of this.slots) this.launch(s);
  }

  view(): ServiceView[] {
    return this.slots.map((s) => {
      // a running service whose person can no longer sign in gets every request refused (#876): Health shows why
      const problem = s.problem
        ?? (s.changeProblem ? `the change in config.yaml is not applied: ${s.changeProblem}` : undefined)
        ?? (s.state === "running" && s.accountId ? actsForStateSafe(s.accountId) : undefined);
      return {
        name: s.cfg.name, state: s.state, since: s.since,
        ...(s.run?.pid !== undefined && !s.run.exited ? { pid: s.run.pid } : {}),
        restarts: s.restarts,
        ...(s.lastExit ? { lastExit: s.lastExit } : {}),
        ...(problem ? { problem } : {}),
        ...(s.nextStart ? { nextStart: s.nextStart } : {}),
      };
    });
  }

  private setState(s: Slot, state: ServiceState): void {
    s.state = state;
    s.since = now();
  }

  private schedule(s: Slot, state: "waiting" | "refused"): void {
    if (this.stopping) return;
    const ran = s.run ? Date.now() - s.run.startedAt : 0;
    if (ran >= this.backoff.stableMs) s.failures = 0;
    const delay = nextDelay(s.failures++, this.backoff);
    this.setState(s, state);
    s.nextStart = new Date(Date.now() + delay).toISOString();
    s.timer = setTimeout(() => {
      s.timer = undefined;
      this.launch(s);
    }, delay);
    s.timer.unref();
  }

  private refuse(s: Slot, problem: string): void {
    s.problem = problem;
    this.o.log(`services: ${s.cfg.name} is not started: ${problem}`);
    this.record(s, `not started: ${problem}`);
    if (s.fromChange && s.lastAudited !== problem) {
      s.lastAudited = problem;
      this.audit({ action: "service-refuse", result: "failed", target: s.cfg.name, detail: problem });
    }
    if (s.afterExit) recordRepair(serviceNotStarted({ name: s.cfg.name, restarts: s.restarts, at: now() }));
    this.schedule(s, "refused");
  }

  private launch(s: Slot): void {
    if (this.stopping) return;
    try {
      this.launchChecked(s);
    } catch (e) {
      this.refuse(s, e instanceof ServiceProblem ? e.message : "the program could not be started");
    }
  }

  private launchChecked(s: Slot): void {
    const { cfg } = s;
    s.nextStart = undefined;
    s.problem = undefined;
    s.run = undefined;
    this.setState(s, "starting");
    const prog = programProblem(cfg.command, { home: this.o.home, runsDir: this.o.runsDir });
    if ("problem" in prog) return this.refuse(s, prog.problem);
    if (cfg.public_key) {
      const bad = signatureProblem(cfg.command, prog.realPath, cfg.public_key);
      if (bad) return this.refuse(s, bad);
    }
    const badScope = this.o.checkScope(cfg.scope);
    if (badScope) return this.refuse(s, badScope);
    // a bad acts_for is refused here, before anything is launched
    const { accountId, token } = serviceToken(cfg.name, cfg.scope, cfg.acts_for);
    s.accountId = accountId;
    const env: NodeJS.ProcessEnv = {};
    for (const k of BASE_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    Object.assign(env, cfg.env, { SCF_SERVICE_TOKEN: token, SCF_URL: this.o.url });
    let child: ChildProcess;
    try {
      child = spawn(prog.realPath, cfg.args, { detached: true, stdio: ["ignore", "pipe", "pipe"], env, cwd: dirname(prog.realPath) });
    } catch {
      revokeServiceTokenSafe(accountId);
      return this.refuse(s, "the program could not be started");
    }
    let settle!: () => void;
    const settled = new Promise<void>((r) => (settle = r));
    const run: Run = { child, pid: child.pid, startedAt: Date.now(), exited: false, open: 2, settle, settled };
    s.run = run;
    child.on("error", () => {
      if (run.exited) return;
      run.exited = true;
      run.release?.();
      revokeServiceTokenSafe(accountId);
      settle();
      if (run.halted) return;
      this.refuse(s, "the program could not be started");
    });
    if (child.pid === undefined) return; // the error event follows
    run.release = holdLiveGroup(child.pid);
    this.record(s, `started (pid ${child.pid})`);
    this.o.log(`services: ${cfg.name} started (pid ${child.pid})`);
    this.setState(s, "running");
    if (s.afterExit) {
      s.afterExit = false;
      recordRepair(serviceStarted({ name: s.cfg.name, restarts: s.restarts, at: now() }));
    }
    if (s.fromChange) {
      s.fromChange = false;
      s.lastAudited = undefined;
      this.audit({ action: "service-start", result: "ok", target: cfg.name, detail: "started" });
    }

    const secrets = [token, ...Object.values(cfg.env)].filter((v) => v !== "");
    const launchRedactor = makeRedactor(secrets);
    const current = () => combineRedactors(liveRedactor(), launchRedactor);
    // one line filter for both streams, so a secret split between stdout and stderr is still held back and redacted
    const filter = redactStream((text) => this.write(s, text), current);
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) {
        run.open--;
        continue;
      }
      const decoder = new StringDecoder("utf8");
      stream.on("data", (chunk: Buffer) => filter.write(decoder.write(chunk)));
      stream.on("error", () => undefined);
      stream.on("close", () => {
        filter.write(decoder.end());
        if (--run.open === 0) {
          filter.end();
          if (run.exited) settle();
        }
      });
    }
    child.on("exit", (code, signal) => {
      void this.exited(s, run, code, signal).catch(() => undefined);
    });
  }

  private async exited(s: Slot, run: Run, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    s.lastExit = { code, signal, at: now() };
    this.record(s, `exited (${code !== null ? `code ${code}` : `signal ${signal}`})`);
    this.o.log(`services: ${s.cfg.name} exited (${code !== null ? `code ${code}` : `signal ${signal}`})`);
    // whatever the program left in its group goes before a new instance starts
    if (run.pid !== undefined) await stopGroup(run.pid, this.graceMs).catch(() => undefined);
    run.release?.();
    run.exited = true;
    if (run.open <= 0) run.settle();
    if (this.stopping || run.halted) return;
    s.restarts++;
    s.afterExit = true;
    this.schedule(s, "waiting");
  }

  private write(s: Slot, text: string): void {
    try {
      s.log.write(text);
    } catch {
      if (!this.logFailed) this.o.log(`services: the log of ${s.cfg.name} cannot be written`);
      this.logFailed = true;
    }
  }

  private record(s: Slot, text: string): void {
    try {
      s.log.line(text);
    } catch {
      // the service goes on without its log
    }
  }

  private clearTimers(s: Slot): void {
    if (s.timer) clearTimeout(s.timer);
    s.timer = undefined;
    if (s.pendingTimer) clearTimeout(s.pendingTimer);
    s.pendingTimer = undefined;
    this.retries.delete(s);
  }

  /** Drops a pending change and its retry only; a crash-restart timer of the running settings is left alone. */
  private clearPending(s: Slot): void {
    if (s.pendingTimer) clearTimeout(s.pendingTimer);
    s.pendingTimer = undefined;
    this.retries.delete(s);
    s.pending = undefined;
    s.changeProblem = undefined;
    s.pendingFailures = 0;
  }

  /**
   * Applies a new `services:` list while the server runs (#941), matched by name: new entries start, removed ones stop, changed
   * ones restart, the others are left alone. Updates run one after another; while one runs only the newest list is kept. Never rejects.
   */
  update(services: readonly ServiceConfig[]): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.queued = services;
    return this.kick();
  }

  private kick(): Promise<void> {
    this.running ??= this.drain();
    return this.running;
  }

  private async drain(): Promise<void> {
    await Promise.resolve();
    try {
      while (!this.stopping && (this.queued || this.retries.size)) {
        try {
          const list = this.queued;
          this.queued = undefined;
          if (list) await this.apply(list);
          for (const s of [...this.retries]) {
            this.retries.delete(s);
            if (this.stopping) break;
            if (s.pending && this.slots.includes(s)) await this.change(s, s.pending, false);
          }
        } catch {
          this.o.log("services: a change in config.yaml could not be applied");
        }
      }
    } finally {
      this.running = undefined;
    }
  }

  private async apply(list: readonly ServiceConfig[]): Promise<void> {
    const wanted = new Map(list.map((c) => [c.name, c]));
    // new entries first, so a slow stop never holds them back
    for (const cfg of list) {
      if (this.slots.some((s) => s.cfg.name === cfg.name)) continue;
      const s = this.newSlot(cfg);
      s.fromChange = true;
      this.slots.push(s);
      this.launch(s);
    }
    const tasks: Promise<void>[] = [];
    for (const s of this.slots.filter((x) => !wanted.has(x.cfg.name))) {
      this.slots.splice(this.slots.indexOf(s), 1);
      this.leaving.add(s);
      tasks.push(this.remove(s));
    }
    for (const s of this.slots) {
      const cfg = wanted.get(s.cfg.name)!;
      if (isDeepStrictEqual(cfg, s.cfg)) {
        if (s.pending) this.clearPending(s);
        s.lastAudited = undefined;
        continue;
      }
      if (s.pending && isDeepStrictEqual(cfg, s.pending)) continue;
      tasks.push(this.change(s, cfg, true).catch(() => undefined));
    }
    await Promise.all(tasks);
    const order = [...wanted.keys()];
    this.slots.sort((a, b) => order.indexOf(a.cfg.name) - order.indexOf(b.cfg.name));
  }

  private async remove(s: Slot): Promise<void> {
    try {
      await this.halt(s);
      s.nextStart = undefined;
      this.setState(s, "stopped");
      this.record(s, "stopped (removed from config.yaml)");
      this.o.log(`services: ${s.cfg.name} stopped (removed from config.yaml)`);
      this.audit({ action: "service-stop", result: "ok", target: s.cfg.name, detail: "removed from config.yaml" });
    } catch {
      // the entry is gone from the list either way
    } finally {
      this.leaving.delete(s);
    }
  }

  /** The first reason this configuration cannot be started now, without changing anything. */
  private precheck(cfg: ServiceConfig): string | undefined {
    const prog = programProblem(cfg.command, { home: this.o.home, runsDir: this.o.runsDir });
    if ("problem" in prog) return prog.problem;
    if (cfg.public_key) {
      const bad = signatureProblem(cfg.command, prog.realPath, cfg.public_key);
      if (bad) return bad;
    }
    return this.o.checkScope(cfg.scope) ?? accountProblem(cfg.name, cfg.scope, cfg.acts_for);
  }

  private async change(s: Slot, cfg: ServiceConfig, fresh: boolean): Promise<void> {
    if (this.stopping || !this.slots.includes(s)) return;
    if (fresh) {
      if (s.pendingTimer) clearTimeout(s.pendingTimer);
      s.pendingTimer = undefined;
      s.pendingFailures = 0;
    }
    const problem = this.precheck(cfg);
    if (!s.run || s.run.exited) {
      // nothing runs (refused or waiting): the new settings start only when they pass the checks; otherwise the last accepted ones stay in force
      if (problem) return this.refuseChange(s, cfg, problem);
      this.clearPending(s);
      if (s.timer) clearTimeout(s.timer);
      s.timer = undefined;
      s.cfg = cfg;
      s.failures = 0;
      s.fromChange = true;
      s.afterExit = false; // a start because of config.yaml is not a repair
      s.lastAudited = undefined;
      this.launch(s);
      return;
    }
    if (problem) return this.refuseChange(s, cfg, problem);
    this.o.afterCheck?.(s.cfg.name);
    await this.halt(s);
    if (this.stopping || !this.slots.includes(s)) return;
    this.record(s, "restarting (changed in config.yaml)");
    this.o.log(`services: ${s.cfg.name} restarting (changed in config.yaml)`);
    this.audit({ action: "service-stop", result: "ok", target: s.cfg.name, detail: "changed in config.yaml" });
    this.clearPending(s);
    s.cfg = cfg;
    s.failures = 0;
    s.fromChange = true;
    s.afterExit = false;
    s.lastAudited = undefined;
    this.launch(s);
  }

  /** Keeps the running (or last accepted) settings, shows why the change is refused, and retries it with the backoff (#941). */
  private refuseChange(s: Slot, cfg: ServiceConfig, problem: string): void {
    s.pending = cfg;
    s.changeProblem = problem;
    this.o.log(`services: ${s.cfg.name} change refused: ${problem}`);
    this.record(s, `change refused: ${problem}`);
    if (s.lastAudited !== problem) {
      s.lastAudited = problem;
      this.audit({ action: "service-refuse", result: "failed", target: s.cfg.name, detail: problem });
    }
    if (s.pendingTimer) clearTimeout(s.pendingTimer);
    const delay = nextDelay(s.pendingFailures++, this.backoff);
    s.pendingTimer = setTimeout(() => {
      s.pendingTimer = undefined;
      if (this.stopping || !this.slots.includes(s)) return;
      this.retries.add(s);
      void this.kick();
    }, delay);
    s.pendingTimer.unref();
  }

  /** Stops the running program of a slot on purpose: no restart follows. Revokes its token. */
  private async halt(s: Slot): Promise<void> {
    this.clearTimers(s);
    const run = s.run;
    try {
      if (run) {
        run.halted = true;
        if (!run.exited && run.pid !== undefined) await stopGroup(run.pid, this.graceMs);
        await Promise.race([run.settled, new Promise((r) => setTimeout(r, 1000).unref())]);
      }
    } catch {
      // go on: the token is revoked below
    }
    if (s.accountId) revokeServiceTokenSafe(s.accountId);
  }

  /** Stops every program (SIGTERM, SIGKILL after the grace time), lets the output drain, revokes the tokens. Never throws. */
  async stop(): Promise<void> {
    this.stopping = true;
    try {
      await this.running;
    } catch {
      // go on with the stop
    }
    await Promise.all([...this.slots, ...this.leaving].map(async (s) => {
      try {
        this.clearTimers(s);
        const run = s.run;
        if (run && !run.exited && run.pid !== undefined) await stopGroup(run.pid, this.graceMs);
        if (run) await Promise.race([run.settled, new Promise((r) => setTimeout(r, 1000).unref())]);
      } catch {
        // go on with the next step
      }
      this.finish(s);
    }));
  }

  private finish(s: Slot): void {
    try {
      if (s.accountId) revokeServiceTokenSafe(s.accountId);
    } catch {
      // revoked at the next start
    }
    s.nextStart = undefined;
    this.setState(s, "stopped");
  }

  /**
   * The same, but synchronous: for the exit right before a restart (self-update), where nothing may wait for the event loop. It never
   * throws and polls for at most the grace time. Output that was not read yet may be lost.
   */
  stopNow(): void {
    this.stopping = true;
    const signalled: { s: Slot; pid: number }[] = [];
    for (const s of [...this.slots, ...this.leaving]) {
      try {
        this.clearTimers(s);
        const pid = s.run && !s.run.exited ? s.run.pid : undefined;
        if (pid === undefined) continue;
        for (const sig of ["SIGTERM", "SIGCONT"] as const) {
          try {
            process.kill(-pid, sig);
          } catch {
            // already gone
          }
        }
        signalled.push({ s, pid });
      } catch {
        // go on with the others
      }
    }
    const until = Date.now() + this.graceMs;
    const running = () => signalled.filter(({ pid }) => {
      try {
        return this.alive(pid);
      } catch {
        return false;
      }
    });
    while (running().length && Date.now() < until) sleepSync(50);
    for (const { s, pid } of signalled) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // nothing left
      }
      try {
        s.run?.release?.();
      } catch {
        // the exit hook kills the group anyway
      }
    }
    for (const s of [...this.slots, ...this.leaving]) this.finish(s);
  }
}

/** `beforeExit` with the services stopped first. A failing stop never keeps the exit from going on. */
export function withServicesStopped(beforeExit: () => void, services?: Pick<ServicesHandle, "stopNow">): () => void {
  return () => {
    try {
      services?.stopNow();
    } catch {
      // the restart goes on
    }
    beforeExit();
  };
}
