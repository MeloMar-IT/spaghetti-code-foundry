import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { get as httpGet } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { loadConfig, type Config } from "../config.js";
import { liveRedactor, redactStream, requireRedaction, type Redactor } from "../credentials/redact.js";
import { busyHolds } from "../ops/busy.js";
import { busyPriority, holdLiveGroup, priorityMachine, priorityPrefix, spawnTarget, stopGroup, type PriorityMachine } from "../steps/process.js";
import { checkPreview, parsePreview, PreviewConfigError, type PreviewConfig } from "./config.js";
import { freePort, HOST, MAX_OUTPUT, OutputBuffer, portFree, previewEnv } from "./support.js";

export { freePort, MAX_OUTPUT, portFree, previewEnv };

export const IDLE_MS = 30 * 60_000;
export const READY_TIMEOUT_MS = 120_000;

export type PreviewState = "starting" | "ready" | "stopped" | "failed";
export type PreviewReason = "exited" | "not-ready" | "bad-config" | "port-busy" | "idle" | "stopped" | "replaced";

export interface PreviewInfo {
  projectId: string;
  state: PreviewState;
  reason?: PreviewReason;
  detail?: string;
  url?: string;
  appPort?: number;
  pid?: number;
  exitCode?: number | null;
  startedAt: number;
  readyAt?: number;
  endedAt?: number;
  lastUseAt?: number;
}

export interface PreviewRunnerOptions {
  now?: () => number;
  idleMs?: number;
  readyTimeoutMs?: number;
  probeEveryMs?: number;
  probeTimeoutMs?: number;
  idleCheckEveryMs?: number;
  redactor?: () => Redactor;
  machine?: () => Promise<PriorityMachine>;
  providers?: () => Pick<Config, "providers">;
}

interface Entry {
  info: PreviewInfo;
  child?: ChildProcess;
  server?: Server;
  sockets: Set<Socket>;
  lastUse: number;
  out: OutputBuffer;
  ended: boolean;
  abort: AbortController;
  cleanup?: Promise<void>;
  /** Resolves when the child's output is complete (set when the child is attached). */
  closed: Promise<void>;
  closeOutput: () => void;
  release?: () => void;
  ready?: string;
  redact: () => Redactor;
  done: Promise<void>;
  finish: () => void;
}

/** The newest request for a project: a start (its own object, compared by identity) or a stop. */
type Ask = { kind: "start" } | { kind: "stop" };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

export class PreviewRunner extends EventEmitter {
  private entries = new Map<string, Entry>();
  private locks = new Map<string, Promise<void>>();
  /** The newest start or stop asked for each project; a start that is no longer the newest does not launch. */
  private asks = new Map<string, Ask>();
  private timer: NodeJS.Timeout | undefined;
  private now: () => number;
  private idleMs: number;
  private readyTimeoutMs: number;
  private probeEveryMs: number;
  private probeTimeoutMs: number;
  private idleCheckEveryMs: number;

  constructor(private opts: PreviewRunnerOptions = {}) {
    super();
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.probeEveryMs = opts.probeEveryMs ?? 250;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 2000;
    this.idleCheckEveryMs = opts.idleCheckEveryMs ?? 60_000;
  }

  get(projectId: string): PreviewInfo | undefined {
    const e = this.entries.get(projectId);
    return e && this.snapshot(e);
  }

  list(): PreviewInfo[] {
    return [...this.entries.values()].map((e) => this.snapshot(e));
  }

  output(projectId: string): string {
    return this.entries.get(projectId)?.out.text() ?? "";
  }

  /** Start the preview of a project; an earlier one of the same project is stopped first (`replaced`). Resolves when it is ready or has ended. */
  async start(projectId: string, dir: string, config: PreviewConfig | string): Promise<PreviewInfo> {
    const redactor = this.opts.redactor ?? (() => liveRedactor());
    if (!this.opts.redactor) requireRedaction(); // before anything is touched
    const ask: Ask = { kind: "start" };
    this.asks.set(projectId, ask);
    const superseded = () => this.asks.get(projectId) !== ask;
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let unlock!: () => void;
    const mine = new Promise<void>((r) => (unlock = r));
    const chain = previous.then(() => mine);
    this.locks.set(projectId, chain);
    await previous;
    let entry: Entry;
    try {
      if (superseded()) return this.cancelled(projectId, this.asks.get(projectId)!);
      const old = this.entries.get(projectId);
      if (old) await this.endEntry(old, "stopped", "replaced");
      // a stop or a newer start may have come while the old one was ending
      if (superseded()) return this.cancelled(projectId, this.asks.get(projectId)!);
      entry = this.create(projectId, redactor);
      await this.launch(entry, dir, config);
    } finally {
      unlock();
      if (this.locks.get(projectId) === chain) this.locks.delete(projectId);
    }
    this.probeLater(entry);
    await entry.done;
    return this.snapshot(entry);
  }

  async stop(projectId: string): Promise<PreviewInfo | undefined> {
    this.asks.set(projectId, { kind: "stop" }); // a start still waiting for the lock is cancelled too
    const e = this.entries.get(projectId);
    if (!e) return undefined;
    await this.endEntry(e, "stopped", "stopped");
    return this.snapshot(e);
  }

  async stopAll(): Promise<void> {
    const ids = new Set([...this.entries.keys(), ...this.locks.keys()]);
    await Promise.all([...ids].map((id) => this.stop(id)));
  }

  /** Stop every ready preview that was not used for the idle time. */
  async checkIdle(): Promise<void> {
    const now = this.now();
    const idle = [...this.entries.values()].filter((e) => e.info.state === "ready" && !e.ended && now - e.lastUse >= this.idleMs);
    await Promise.all(idle.map((e) => this.endEntry(e, "stopped", "idle")));
  }

  private snapshot(e: Entry): PreviewInfo {
    const info = { ...e.info };
    if (info.readyAt !== undefined) info.lastUseAt = e.lastUse;
    return info;
  }

  /** The result of a start that was superseded before it launched: nothing was started. */
  private cancelled(projectId: string, latest: Ask): PreviewInfo {
    const at = this.now();
    return { projectId, state: "stopped", reason: latest.kind === "stop" ? "stopped" : "replaced", startedAt: at, endedAt: at };
  }

  private create(projectId: string, redactor: () => Redactor): Entry {
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    const startedAt = this.now();
    const entry: Entry = {
      info: { projectId, state: "starting", startedAt },
      sockets: new Set(),
      lastUse: startedAt,
      out: new OutputBuffer(),
      ended: false,
      abort: new AbortController(),
      closed: Promise.resolve(),
      closeOutput: () => {},
      done,
      finish,
      redact: redactor,
    };
    this.entries.set(projectId, entry);
    this.emit("state", this.snapshot(entry));
    return entry;
  }

  /** Check the config and the port, then start the command. Leaves the entry ended (failed) when that is not possible. */
  private async launch(e: Entry, dir: string, given: PreviewConfig | string): Promise<void> {
    let config: PreviewConfig;
    try {
      config = typeof given === "string" ? parsePreview(given) : checkPreview(given);
    } catch (err) {
      void this.endEntry(e, "failed", "bad-config", err instanceof PreviewConfigError ? err.message : String(err));
      return;
    }
    try {
      const port = config.port === "auto" ? await freePort() : config.port;
      if (e.ended) return;
      if (config.port !== "auto" && !(await portFree(port))) {
        void this.endEntry(e, "failed", "port-busy", `port ${port} is already in use`);
        return;
      }
      const providers = (this.opts.providers ?? loadConfig)();
      const env = previewEnv(config, port, providers);
      const priority = busyPriority("low", busyHolds());
      const machine = await (this.opts.machine ?? priorityMachine)();
      if (e.ended) return;
      // from here on the child is registered at once, so a stop during the spawn finds it
      const child = await this.spawnChild(e, dir, config.command, env, priority, machine);
      if (!child) return;
      e.info.appPort = port;
      e.ready = config.ready;
    } catch (err) {
      void this.endEntry(e, "failed", "exited", `could not start: ${(err as Error).message}`);
    }
  }

  private spawnChild(e: Entry, dir: string, command: string, env: Record<string, string>, priority: ReturnType<typeof busyPriority>, machine: PriorityMachine): Promise<ChildProcess | undefined> {
    const attempt = (m: PriorityMachine | undefined) =>
      new Promise<ChildProcess>((resolve, reject) => {
        const t = spawnTarget("/bin/sh", ["-c", command], undefined, priority, m);
        const child = spawn(t.cmd, t.args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        // without a pid the start failed (the error event follows); with one, the child is ours from here on
        child.on("error", (err) => {
          if (child.pid === undefined) reject(err);
        });
        if (child.pid === undefined) return;
        e.child = child;
        e.info.pid = child.pid;
        e.release = holdLiveGroup(child.pid);
        this.attach(e, child);
        resolve(child);
      });
    const wrapped = priorityPrefix(priority, machine).length > 0;
    return attempt(machine)
      .catch((err) => (wrapped ? attempt(undefined) : Promise.reject(err)))
      .then(
        (child) => child,
        (err) => {
          void this.endEntry(e, "failed", "exited", `could not start: ${(err as Error).message}`);
          return undefined;
        },
      );
  }

  /** Output of the child (one redaction filter and decoders per stream, both into the same buffer) and its exit. */
  private attach(e: Entry, child: ChildProcess): void {
    const outFilter = redactStream((s) => e.out.push(s), e.redact);
    const errFilter = redactStream((s) => e.out.push(s), e.redact);
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    child.stdout!.on("data", (b: Buffer) => outFilter.write(outDecoder.write(b)));
    child.stderr!.on("data", (b: Buffer) => errFilter.write(errDecoder.write(b)));
    let flushed = false;
    let closeResolve!: () => void;
    e.closed = new Promise<void>((r) => (closeResolve = r));
    e.closeOutput = () => {
      if (flushed) return;
      flushed = true;
      outFilter.write(outDecoder.end());
      outFilter.end();
      errFilter.write(errDecoder.end());
      errFilter.end();
      closeResolve();
    };
    child.on("close", () => e.closeOutput());
    child.on("exit", (code, signal) => {
      if (e.ended) return;
      const detail = code === null ? `killed by ${signal}` : `exited with code ${code}`;
      void this.endEntry(e, "failed", "exited", detail, code);
    });
  }

  private probeLater(e: Entry): void {
    if (e.ended || e.info.state !== "starting") return;
    void this.probeLoop(e).catch((err) => this.endEntry(e, "failed", "not-ready", String(err)));
  }

  /** One GET of the ready path. The response body is not read: once the status is known, the connection is destroyed. */
  private probeOnce(e: Entry, port: number, path: string): Promise<{ status?: number; error?: string }> {
    return new Promise((resolve) => {
      const signal = e.abort.signal;
      let settled = false;
      const finish = (r: { status?: number; error?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const req = httpGet({ host: HOST, port, path, agent: false }, (res) => {
        finish({ status: res.statusCode });
        req.destroy(); // headers are enough; a body that never ends must not keep the socket open
      });
      const onAbort = () => {
        req.destroy();
        finish({ error: "aborted" });
      };
      const timer = setTimeout(() => {
        req.destroy();
        finish({ error: "no answer" });
      }, this.probeTimeoutMs);
      req.on("error", (err) => finish({ error: err.message }));
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async probeLoop(e: Entry): Promise<void> {
    const port = e.info.appPort!;
    const ready = e.ready!;
    const child = e.child!;
    while (!e.ended) {
      const r = await this.probeOnce(e, port, ready);
      if (e.ended) return;
      this.emit("probe", { projectId: e.info.projectId, ...r });
      const alive = child.exitCode === null && child.signalCode === null;
      if (r.status !== undefined && r.status < 500 && alive) return void (await this.becomeReady(e, port));
      if (this.now() - e.info.startedAt >= this.readyTimeoutMs) {
        await this.endEntry(e, "failed", "not-ready", `no answer below 500 within ${Math.round(this.readyTimeoutMs / 1000)} s`);
        return;
      }
      await sleep(this.probeEveryMs, e.abort.signal);
    }
  }

  /** Open the TCP pass-through; the preview is ready when it listens. */
  private async becomeReady(e: Entry, appPort: number): Promise<void> {
    const server = createServer({ allowHalfOpen: true }, (client) => {
      e.lastUse = this.now();
      const up = connect({ port: appPort, host: HOST, allowHalfOpen: true });
      for (const [s, other] of [[client, up], [up, client]] as const) {
        e.sockets.add(s);
        s.on("close", () => {
          e.sockets.delete(s);
          other.destroy();
        });
        s.on("error", () => other.destroy());
        s.on("data", () => (e.lastUse = this.now()));
      }
      client.pipe(up);
      up.pipe(client);
    });
    server.on("error", () => {});
    e.server = server;
    const port = await new Promise<number | undefined>((resolve) => {
      server.once("error", () => resolve(undefined));
      server.listen(0, HOST, () => resolve((server.address() as { port: number }).port));
    });
    if (e.ended) {
      server.close();
      return;
    }
    if (port === undefined) {
      await this.endEntry(e, "failed", "exited", "could not open the preview port");
      return;
    }
    e.lastUse = this.now();
    Object.assign(e.info, { state: "ready", url: `http://${HOST}:${port}/`, readyAt: e.lastUse });
    this.emit("state", this.snapshot(e));
    if (!this.timer) {
      this.timer = setInterval(() => void this.checkIdle(), this.idleCheckEveryMs);
      this.timer.unref();
    }
    e.finish();
  }

  /** End an entry once; everyone who needs it gone awaits the same promise. */
  private endEntry(e: Entry, state: "stopped" | "failed", reason: PreviewReason, detail?: string, exitCode?: number | null): Promise<void> {
    if (e.cleanup) return e.cleanup;
    e.ended = true;
    e.abort.abort();
    e.cleanup = (async () => {
      e.server?.close();
      for (const s of e.sockets) s.destroy();
      const pid = e.child?.pid;
      if (pid) {
        await stopGroup(pid);
        // a process that left the group may keep the pipes open: do not wait for it for ever
        const bound = setTimeout(() => e.closeOutput(), 2000);
        await e.closed;
        clearTimeout(bound);
      }
      e.release?.();
      Object.assign(e.info, { state, reason, endedAt: this.now() });
      if (detail) e.info.detail = detail;
      if (exitCode !== undefined) e.info.exitCode = exitCode;
      delete e.info.url;
      this.emit("state", this.snapshot(e));
      if (this.timer && ![...this.entries.values()].some((x) => x.info.state === "ready" && !x.ended)) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
      e.finish();
    })();
    return e.cleanup;
  }
}
