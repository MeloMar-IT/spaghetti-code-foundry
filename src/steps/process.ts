import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { combineRedactors, liveRedactor, makeRedactor, redactStream, requireRedaction, type Redactor } from "../credentials/redact.js";

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface ProcessOptions {
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
  /** Start from nothing instead of the server's environment: only `env` is passed (a user's run, see short-env.ts). */
  cleanEnv?: boolean;
  /** Start the command inside `/usr/bin/sandbox-exec` with this profile (a shell step of a user's run, see os-sandbox.ts). */
  sandboxProfile?: string;
}

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** What is really started: the command itself, or the command inside the given sandbox profile. */
export function spawnTarget(cmd: string, args: string[], profile?: string): { cmd: string; args: string[] } {
  return profile === undefined ? { cmd, args } : { cmd: SANDBOX_EXEC, args: ["-p", profile, cmd, ...args] };
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

/** Spawn a process, tee stdout/stderr into a log file, and collect output. */
export function runProcess(cmd: string, args: string[], opts: ProcessOptions): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
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
    const target = spawnTarget(cmd, args, opts.sandboxProfile);
    const child = spawn(target.cmd, target.args, {
      cwd: opts.cwd,
      env: mergeEnv(opts.env, opts.cleanEnv),
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.ownGroup ? { detached: true } : {}),
    });
    // a signal to the child, or to its whole group when it has one
    const signalTree = (sig: NodeJS.Signals) => {
      try {
        if (opts.ownGroup && child.pid) process.kill(-child.pid, sig);
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

    const kill = () => {
      signalTree("SIGTERM");
      setTimeout(() => signalTree("SIGKILL"), 5000).unref();
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

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          kill();
        }, opts.timeoutMs)
      : undefined;

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
    child.stdout.on("data", (buf: Buffer) => feed(outFilter, outDecoder.write(buf)));
    child.stderr.on("data", (buf: Buffer) => feed(errFilter, errDecoder.write(buf)));

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (err) => {
      cleanup();
      log.end();
      reject(new Error(`failed to start "${cmd}": ${err.message}`));
    });
    child.on("close", (code) => {
      cleanup();
      feed(outFilter, outDecoder.end());
      feed(errFilter, errDecoder.end());
      outFilter.end();
      errFilter.end();
      logFilter.end();
      if (opts.onLine && pending.trim()) opts.onLine(pending);
      if (logError) {
        log.end();
        return reject(new Error(`could not write the log file (${logError.code ?? "error"})`));
      }
      log.end((err?: Error | null) => {
        if (err || logError) return reject(new Error(`could not write the log file (${(err as NodeJS.ErrnoException | null | undefined)?.code ?? logError?.code ?? "error"})`));
        resolve({ exitCode: code, stdout, stderr, timedOut, aborted });
      });
    });

    child.stdin.on("error", () => {}); // process may exit before reading stdin
    child.stdin.end(opts.stdin ?? "");
  });
}
