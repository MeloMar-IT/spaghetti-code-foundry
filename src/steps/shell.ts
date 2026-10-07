import { dockerCommand } from "../engine/guards.js";
import { runProcess } from "./process.js";

const MAX_OUTPUT = 20_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

/** Colour codes break output matching and are noise in Claude prompts. */
const NO_COLOR_ENV = { NO_COLOR: "1", FORCE_COLOR: undefined, CLICOLOR_FORCE: undefined };

export interface ShellRunResult {
  ok: boolean;
  output: string;
  /** What the command wrote on stderr (cleaned like `output`). */
  stderr: string;
  /** `scan` applied to the whole output and to the whole stderr, before they were cut to their tail. */
  scanned?: { output: boolean; stderr: boolean };
  exitCode: number | null;
  error?: string;
}

export async function runShell(o: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Run inside this Docker image with only the workspace mounted. */
  dockerImage?: string;
  /** Names of more variables to pass into the container (their values come from `env`). */
  dockerEnv?: string[];
  /** Secrets of this step, hidden for its whole life. */
  pinnedSecrets?: string[];
  /** A check made on the complete output (not only its tail). */
  scan?: (text: string) => boolean;
  /** Characters of output to keep (default 20,000). */
  maxOutput?: number;
  /** The step holds a credential: its whole process group is killed when it ends. */
  ownGroup?: boolean;
  /** Pass only `env`, nothing of the server's environment. */
  cleanEnv?: boolean;
  /** Hold the command in this `sandbox-exec` profile (not used with a Docker image: the container holds it). */
  sandboxProfile?: string;
}):Promise<ShellRunResult> {
  const env: NodeJS.ProcessEnv = { ...NO_COLOR_ENV, ...o.env };
  let cmd = "/bin/sh";
  let args = ["-c", o.command];
  if (o.dockerImage) {
    env.FACTORY_WORKDIR = "/work";
    env.SCF_WORKDIR = "/work";
    const extra = new Set(o.dockerEnv ?? []);
    const names = Object.keys(env).filter((k) => (/^(FACTORY_|SCF_|NO_COLOR$|CI$)/.test(k) || extra.has(k)) && env[k] !== undefined);
    ({ cmd, args } = dockerCommand(o.dockerImage, o.cwd, o.command, names));
  }
  const res = await runProcess(cmd, args, {
    cwd: o.cwd,
    env,
    timeoutMs: o.timeoutMs,
    signal: o.signal,
    logFile: o.logFile,
    pinnedSecrets: o.pinnedSecrets,
    ownGroup: o.ownGroup,
    cleanEnv: o.cleanEnv,
    sandboxProfile: o.dockerImage ? undefined : o.sandboxProfile,
  });
  // Keep the tail: that's where test failures and stack traces usually are.
  const keep = o.maxOutput ?? MAX_OUTPUT;
  const fullOut = (res.stdout + res.stderr).replace(ANSI, "");
  const fullErr = res.stderr.replace(ANSI, "");
  const output = fullOut.slice(-keep);
  const stderr = fullErr.slice(-keep);
  const scanned = o.scan ? { output: o.scan(fullOut), stderr: o.scan(fullErr) } : undefined;
  if (res.aborted) return { ok: false, output, stderr, scanned, exitCode: res.exitCode, error: "cancelled" };
  if (res.timedOut) return { ok: false, output, stderr, scanned, exitCode: res.exitCode, error: "timed out" };
  return {
    ok: res.exitCode === 0,
    output,
    stderr,
    scanned,
    exitCode: res.exitCode,
    error: res.exitCode === 0 ? undefined : `exit code ${res.exitCode}`,
  };
}
