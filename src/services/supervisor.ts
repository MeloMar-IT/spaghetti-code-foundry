import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ServiceConfig } from "../config.js";
import { combineRedactors, liveRedactor, makeRedactor, redactStream } from "../credentials/redact.js";
import { sleepSync } from "../home-migrate.js";
import { holdLiveGroup, stopGroup } from "../steps/process.js";
import { ServiceLog, MAX_LOG_BYTES } from "./log.js";
import { ServiceProblem, programProblem, reconcileServiceTokens, revokeServiceTokenSafe, serviceToken, signatureProblem } from "./setup.js";

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
}

const now = () => new Date().toISOString();

/** Starts the configured programs, restarts them with a backoff, and stops them (#867). */
export class ServiceSupervisor implements ServicesHandle {
  private readonly slots: Slot[];
  private stopping = false;
  private readonly backoff: Backoff;
  private readonly graceMs: number;
  private readonly alive: (pid: number) => boolean;
  private logFailed = false;

  constructor(private readonly o: SupervisorOptions) {
    this.backoff = o.backoff ?? DEFAULT_BACKOFF;
    this.graceMs = o.graceMs ?? 5000;
    this.alive = o.alive ?? psAlive;
    this.slots = o.services.map((cfg) => ({
      cfg, state: "starting", since: now(), restarts: 0, failures: 0,
      log: new ServiceLog(join(o.home, "services", `${cfg.name}.log`), o.maxLogBytes ?? MAX_LOG_BYTES),
    }));
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
    return this.slots.map((s) => ({
      name: s.cfg.name, state: s.state, since: s.since,
      ...(s.run?.pid !== undefined && !s.run.exited ? { pid: s.run.pid } : {}),
      restarts: s.restarts,
      ...(s.lastExit ? { lastExit: s.lastExit } : {}),
      ...(s.problem ? { problem: s.problem } : {}),
      ...(s.nextStart ? { nextStart: s.nextStart } : {}),
    }));
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
    const { accountId, token } = serviceToken(cfg.name, cfg.scope);
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
      this.refuse(s, "the program could not be started");
    });
    if (child.pid === undefined) return; // the error event follows
    run.release = holdLiveGroup(child.pid);
    this.record(s, `started (pid ${child.pid})`);
    this.o.log(`services: ${cfg.name} started (pid ${child.pid})`);
    this.setState(s, "running");

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
    if (this.stopping) return;
    s.restarts++;
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

  /** Stops every program (SIGTERM, SIGKILL after the grace time), lets the output drain, revokes the tokens. Never throws. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.slots.map(async (s) => {
      try {
        if (s.timer) clearTimeout(s.timer);
        s.timer = undefined;
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
    for (const s of this.slots) {
      try {
        if (s.timer) clearTimeout(s.timer);
        s.timer = undefined;
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
    for (const s of this.slots) this.finish(s);
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
