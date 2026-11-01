import { execFile, spawn } from "node:child_process";
import { accessSync, constants, createWriteStream, statSync } from "node:fs";
import { getPriority } from "node:os";
import { resolve as resolvePath } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { anyPidAlive, ProcessTracker, processTableAsync, signalRows, type ProcRow } from "./proc-tree.js";
import { readSlotWaits, slotClock, waitedLine, type SlotWaitWatch } from "./slot-waits.js";
import { combineRedactors, liveRedactor, makeRedactor, redactStream, requireRedaction, type Redactor } from "../credentials/redact.js";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** The time the process waited for a test slot (see slot-waits.ts). Set only when it waited. */
  slotWait?: { waitedMs: number; countedMs: number; capped: boolean };
}

/** Filled by runProcess whenever it settles, also when it rejects: how long the process ran and how many bytes it printed. */
export interface ProcessMeter {
  ms?: number;
  printedBytes?: number;
  /** The time that did not count against the time limit (waits for a test slot, at most the bound). */
  slotWaitMs?: number;
}

export interface ProcessOptions {
  /** Filled when the process settles (see ProcessMeter). */
  meter?: ProcessMeter;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  logFile: string;
  /** Called with each complete stdout line. */
  onLine?: (line: string) => void;
  /** Secrets to hide from the output. Without it the stored credentials are used (and must be readable). */
  redactor?: Redactor;
  /** Secrets of this process, hidden for its whole life even when the stored credentials change meanwhile. Used with the stored ones. */
  pinnedSecrets?: string[];
  /** Run in a process group of its own and kill the whole group when the process ends (steps that hold a credential). */
  ownGroup?: boolean;
  /** Run in a process group of its own and signal the whole group on cancel and timeout (not when the process ends). A kill waits until the group is gone. */
  groupKill?: boolean;
  /** With groupKill: how often the step's descendants are noted, so ones that left the group are stopped on cancel and time-out too (default 10 s). */
  trackEveryMs?: number;
  /** Start from nothing instead of the server's environment: only `env` is passed (a user's run, see short-env.ts). */
  cleanEnv?: boolean;
  /** Start the command inside `/usr/bin/sandbox-exec` with this profile (a shell step of a user's run, see os-sandbox.ts). */
  sandboxProfile?: string;
  /** Where test-slot records its waits: the time limit does not count them (at most `maxExtraMs`). */
  slotWaits?: SlotWaitWatch;
  /** Start the command (and so its children) at this priority, behind `nice` and `taskpolicy` outside any sandbox. Unset or "normal": as it is. */
  priority?: RunPriority;
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
export const NICE = "/usr/bin/nice";
export const TASKPOLICY = "/usr/sbin/taskpolicy";

/** How much of the machine a run process may take (setting `governor.priority`). */
export type RunPriority = "normal" | "low" | "background";

/** What the priority wrapper needs to know of this machine; tests pass their own. */
export interface PriorityMachine {
  nice: boolean;
  taskpolicy: boolean;
  /** Nice value of this process. */
  current: number;
}

const PRIORITIES = {
  low: { nice: 5, qos: "utility" },
  background: { nice: 15, qos: "background" },
} as const;

const toolTrials = new Map<string, Promise<boolean>>();

/** Whether a tool works here: a trial run, once per process. A tool that is missing, or refuses its flag, counts as not working. */
function toolWorks(tool: string, args: string[]): Promise<boolean> {
  let trial = toolTrials.get(tool);
  if (!trial) {
    trial = new Promise<boolean>((done) => {
      try {
        execFile(tool, args, { timeout: 10_000 }, (err) => done(!err)).on("error", () => done(false));
      } catch {
        done(false);
      }
    });
    toolTrials.set(tool, trial);
  }
  return trial;
}

function niceValue(): number {
  try {
    return getPriority(0);
  } catch {
    return 0;
  }
}

/** Which wrapper tools work here (trial runs without blocking the event loop, cached) and the nice value of this process. */
export async function priorityMachine(): Promise<PriorityMachine> {
  const [nice, taskpolicy] = await Promise.all([toolWorks(NICE, ["-n", "1", "/usr/bin/true"]), toolWorks(TASKPOLICY, ["-c", "utility", "/usr/bin/true"])]);
  return { nice, taskpolicy, current: niceValue() };
}

/** The command words in front of the real command for this priority; none for normal or when no tool works. */
export function priorityPrefix(priority: RunPriority | undefined, machine: PriorityMachine): string[] {
  if (!priority || priority === "normal") return [];
  const want = PRIORITIES[priority];
  const prefix: string[] = [];
  // nice adds to the current value; the target is absolute and a priority is never raised
  const delta = want.nice - machine.current;
  if (machine.nice && delta > 0) prefix.push(NICE, "-n", String(delta));
  if (machine.taskpolicy) prefix.push(TASKPOLICY, "-c", want.qos);
  return prefix;
}

/**
 * What is really started: the command itself, or the command inside the given sandbox profile,
 * and with a priority behind the priority wrappers (outside the sandbox: `nice … taskpolicy … sandbox-exec … cmd`).
 */
export function spawnTarget(cmd: string, args: string[], profile?: string, priority?: RunPriority, machine?: PriorityMachine): { cmd: string; args: string[] } {
  const inner = profile === undefined ? [cmd, ...args] : [SANDBOX_EXEC, "-p", profile, cmd, ...args];
  const words = [...(machine ? priorityPrefix(priority, machine) : []), ...inner];
  return { cmd: words[0]!, args: words.slice(1) };
}

/** Whether `cmd` can be found and executed the way spawn looks it up (a path with `/` from the cwd, else the PATH folders; no PATH means /usr/bin:/bin). */
function canStart(cmd: string, pathVar: string | undefined, cwd: string): boolean {
  const ok = (f: string) => {
    try {
      accessSync(f, constants.X_OK);
      return statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) return ok(resolvePath(cwd, cmd));
  return (pathVar ?? "/usr/bin:/bin").split(":").some((dir) => ok(resolvePath(cwd, dir || ".", cmd)));
}

/**
 * Variables a Claude host session (the desktop app, an IDE, another Claude Code) puts in its
 * children's environment. A Claude Code started with them believes that host manages its login
 * ("host auth refresh") and can lose its own stored login. Steps must never inherit them.
 */
const HOST_SESSION_VAR = /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_PREVIEW_|ANTHROPIC_BASE_URL$)/;
const KEEP_VAR = /^(CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_[A-Z]+)$/; // set on purpose by the owner

export function inheritedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!base.CLAUDECODE && !base.CLAUDE_CODE_HOST_SESSION_ID && !base.CLAUDE_CODE_ENTRYPOINT) return { ...base };
  return Object.fromEntries(Object.entries(base).filter(([k]) => !HOST_SESSION_VAR.test(k) || KEEP_VAR.test(k)));
}

/** process.env (without a Claude host session's variables) + overrides; an override of `undefined` removes the variable. */
function mergeEnv(overrides: NodeJS.ProcessEnv = {}, clean = false): NodeJS.ProcessEnv {
  const env = { ...(clean ? {} : inheritedEnv()), ...overrides };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

/** Process groups of running steps that must not outlive this process (see runProcess, `groupKill`). */
const liveGroups = new Set<number>();
let exitHook = false;

/** SIGKILL to every live process group of a step; returns how many. Runs when this process exits (a Ctrl+C no longer reaches a detached group). */
export function killLiveGroups(): number {
  let n = 0;
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL");
      n++;
    } catch {
      // already gone
    }
  }
  liveGroups.clear();
  return n;
}

const groupAlive = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The priority wrapper could not be started at all (the real command never ran), so the command may be started without it. */
class WrapperStartError extends Error {}

/** Spawn a process, tee stdout/stderr into a log file, and collect output. */
export async function runProcess(cmd: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  let machine: PriorityMachine | undefined;
  // A program that cannot be found starts unwrapped, so it fails as it always did (the wrapper would exit 127 instead).
  if (opts.priority && opts.priority !== "normal" && canStart(cmd, mergeEnv(opts.env, opts.cleanEnv).PATH, opts.cwd)) machine = await priorityMachine();
  try {
    return await startProcess(cmd, args, opts, machine);
  } catch (e) {
    if (e instanceof WrapperStartError) return startProcess(cmd, args, opts, undefined); // the sandbox stays; nothing of the command ran yet
    throw e;
  }
}

function startProcess(cmd: string, args: string[], opts: ProcessOptions, machine: PriorityMachine | undefined): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (opts.meter) {
      opts.meter.ms = undefined;
      opts.meter.printedBytes = undefined;
      opts.meter.slotWaitMs = undefined;
    }
    // fail before anything starts when the stored credentials cannot be read
    let current: () => Redactor;
    try {
      if (opts.redactor) {
        const fixed = opts.redactor;
        current = () => fixed;
      } else {
        requireRedaction();
        const pinned = opts.pinnedSecrets?.length ? makeRedactor(opts.pinnedSecrets) : undefined;
        current = pinned ? () => combineRedactors(liveRedactor(), pinned) : liveRedactor;
      }
    } catch (e) {
      return reject(e);
    }
    const log = createWriteStream(opts.logFile, { flags: "a" });
    let logError: NodeJS.ErrnoException | undefined;
    const grouped = Boolean(opts.ownGroup || opts.groupKill);
    const wrapped = Boolean(machine && priorityPrefix(opts.priority, machine).length);
    const target = spawnTarget(cmd, args, opts.sandboxProfile, opts.priority, machine);
    const child = spawn(target.cmd, target.args, {
      cwd: opts.cwd,
      env: mergeEnv(opts.env, opts.cleanEnv),
      stdio: ["pipe", "pipe", "pipe"],
      ...(grouped ? { detached: true } : {}),
    });
    if (grouped && child.pid) {
      liveGroups.add(child.pid);
      if (!exitHook) {
        exitHook = true;
        process.on("exit", killLiveGroups);
      }
    }
    const tracker = opts.groupKill && child.pid ? new ProcessTracker(child.pid, { everyMs: opts.trackEveryMs ?? 10_000 }) : undefined;
    tracker?.start();
    const began = Date.now();
    let printed = 0;
    const measure = () => {
      if (opts.meter) {
        opts.meter.ms = Date.now() - began;
        opts.meter.printedBytes = printed;
      }
    };
    // a signal to the child, or to its whole group when it has one
    const signalTree = (sig: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already gone
      }
    };
    if (opts.ownGroup) child.on("exit", () => signalTree("SIGKILL")); // background children must not outlive the step

    let stdout = "";
    let stderr = "";
    let pending = "";
    let timedOut = false;
    let aborted = false;

    let killedAt = 0;
    let killTimer: NodeJS.Timeout | undefined;
    // Processes of the step that left its group, read at the first kill (see proc-tree.ts).
    let extra: ProcRow[] = [];
    let extraDone = false; // the extra rows were validated and SIGKILLed
    let extraBusy = false; // a table read for them is running
    // SIGKILL to the extra rows, once a fresh table confirms them. A failed read is retried on the next call.
    const killExtra = () => {
      if (extraDone || extraBusy || !extra.length) return;
      extraBusy = true;
      const rows = extra;
      void processTableAsync(1000).then((t) => {
        extraBusy = false;
        if (!t) return;
        signalRows(rows, "SIGKILL", t);
        extraDone = true;
      });
    };
    const hardKill = () => {
      signalTree("SIGKILL");
      killExtra();
    };
    const kill = () => {
      const first = !killedAt;
      killedAt ||= Date.now();
      if (!killTimer) {
        killTimer = setTimeout(hardKill, 5000);
        if (!grouped) killTimer.unref(); // a group is waited for, so its timer must stay
      }
      // before the group goes: the children that left it still point to their parents
      if (first && tracker) extra = tracker.toStop();
      signalTree("SIGTERM");
      // validated against a fresh table; when that read fails, the SIGKILL path retries it
      if (first && extra.length) signalRows(extra, "SIGTERM");
    };
    // After a kill, the step is not over until nothing of its group runs: SIGKILL at 5 s, and at most 1 s more.
    const groupGone = async () => {
      const pid = child.pid;
      if (!pid) return;
      let hard = 0;
      while (groupAlive(pid) || anyPidAlive(extra)) {
        const now = Date.now();
        if (!hard && now - killedAt >= 5000) {
          signalTree("SIGKILL");
          hard = now + 1000;
        }
        if (hard) killExtra();
        if (hard && now > hard) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const onAbort = () => {
      aborted = true;
      kill();
    };
    // A log that cannot be written (a folder that is gone, a full disk) fails the step: the transcript would be missing or cut.
    // The child is stopped, and the promise is rejected once it has exited.
    log.on("error", (err: NodeJS.ErrnoException) => {
      if (logError) return;
      logError = err;
      kill();
    });
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });

    // The limit is looked at when it is reached: time spent waiting for a test slot moves it back (never past the bound).
    const clockNow = (limitMs: number) => {
      const watch = opts.slotWaits!;
      const now = Date.now();
      return slotClock(readSlotWaits(watch.dir, now), { began, limitMs, maxExtraMs: watch.maxExtraMs, now });
    };
    let timer: NodeJS.Timeout | undefined;
    const atDeadline = () => {
      if (killedAt) return;
      const next = opts.slotWaits ? clockNow(opts.timeoutMs!).nextCheckMs : 0;
      if (next > 0) {
        timer = setTimeout(atDeadline, next);
        return;
      }
      timedOut = true;
      kill();
    };
    if (opts.timeoutMs) timer = setTimeout(atDeadline, opts.timeoutMs);

    // One filter for the combined log: halves of a secret that arrive on stdout and stderr must not join unseen.
    const logFilter = redactStream((s) => void log.write(s), current);
    const outSink = (s: string) => {
      stdout += s;
      if (opts.onLine) {
        pending += s;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const l of lines) if (l.trim()) opts.onLine(l);
      }
    };
    const errSink = (s: string) => {
      stderr += s;
    };
    const outFilter = redactStream(outSink, current);
    const errFilter = redactStream(errSink, current);
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const feed = (filter: ReturnType<typeof redactStream>, text: string) => {
      if (!text) return;
      logFilter.write(text);
      filter.write(text);
    };
    child.stdout.on("data", (buf: Buffer) => {
      printed += buf.length;
      feed(outFilter, outDecoder.write(buf));
    });
    child.stderr.on("data", (buf: Buffer) => {
      printed += buf.length;
      feed(errFilter, errDecoder.write(buf));
    });

    const cleanup = () => {
      clearTimeout(timer);
      tracker?.stop();
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      if (child.pid) liveGroups.delete(child.pid);
      cleanup();
      measure();
      log.end();
      if (wrapped && !child.pid) return reject(new WrapperStartError(err.message));
      reject(new Error(`failed to start "${cmd}": ${err.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      if (grouped && child.pid && killedAt) void groupGone().then(() => settle(code));
      else settle(code);
    });
    const settle = (code: number | null) => {
      clearTimeout(killTimer);
      if (child.pid) liveGroups.delete(child.pid);
      feed(outFilter, outDecoder.end());
      feed(errFilter, errDecoder.end());
      outFilter.end();
      errFilter.end();
      logFilter.end();
      if (opts.onLine && pending.trim()) opts.onLine(pending);
      measure();
      let slotWait: ProcessResult["slotWait"];
      if (opts.slotWaits) {
        const c = clockNow(Infinity);
        if (c.waitedMs > 0) {
          slotWait = { waitedMs: c.waitedMs, countedMs: c.countedMs, capped: c.waitedMs > opts.slotWaits.maxExtraMs };
          if (opts.meter) opts.meter.slotWaitMs = c.countedMs;
          if (!logError) log.write(`${waitedLine(c.waitedMs)}\n`);
        }
      }
      if (logError) {
        log.end();
        return reject(new Error(`could not write the log file (${logError.code ?? "error"})`));
      }
      log.end((err?: Error | null) => {
        if (err || logError) return reject(new Error(`could not write the log file (${(err as NodeJS.ErrnoException | null | undefined)?.code ?? logError?.code ?? "error"})`));
        resolve({ exitCode: code, stdout, stderr, timedOut, aborted, ...(slotWait ? { slotWait } : {}) });
      });
    };

    child.stdin.on("error", () => {}); // process may exit before reading stdin
    child.stdin.end(opts.stdin ?? "");
  });
}
