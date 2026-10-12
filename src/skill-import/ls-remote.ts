import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitEnv, OPTIONS } from "./git-tree.js";

// Reads the commit that HEAD of a remote repository points at now: one `git ls-remote`, with the same hardening as the
// import (own empty HOME, no credentials, no redirects, https only). Git runs in its own process group, which is killed on
// a timeout, on too much output and on an abort. Errors carry a fixed code, never git's text.

export type LsRemoteErrorCode = "no-git" | "unreachable" | "timeout" | "interrupted" | "bad-answer";
export const LS_REMOTE_LIMITS = { timeoutMs: 20_000, outBytes: 4096 } as const;

export class LsRemoteError extends Error {
  readonly code: LsRemoteErrorCode;
  constructor(code: LsRemoteErrorCode) {
    super(code);
    this.name = "LsRemoteError";
    this.code = code;
  }
}

export interface LsRemoteOptions {
  /** Tests: a local path, read as file://. */
  remote?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const ANSWER_RE = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD\n$/;

/** The commit HEAD of the repository points at now. The process group and the temporary folder are gone when it settles. */
export async function resolveHead(repository: string, opts: LsRemoteOptions = {}): Promise<string> {
  if (opts.signal?.aborted) throw new LsRemoteError("interrupted");
  let tmp: string;
  try {
    tmp = mkdtempSync(join(tmpdir(), "scf-skill-resolve-"));
  } catch {
    throw new LsRemoteError("unreachable");
  }
  try {
    mkdirSync(join(tmp, "home"), { mode: 0o700 });
    const env = gitEnv(opts.env ?? process.env, tmp, opts.remote !== undefined);
    delete env.GIT_DIR;
    env.GIT_CEILING_DIRECTORIES = tmp;
    const url = opts.remote !== undefined ? "file://" + resolve(opts.remote) : repository;
    return await run(url, tmp, env, opts.timeoutMs ?? LS_REMOTE_LIMITS.timeoutMs, opts.signal);
  } catch (e) {
    throw e instanceof LsRemoteError ? e : new LsRemoteError("unreachable");
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // nothing more to do
    }
  }
}

function run(url: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((done, fail) => {
    let child: ChildProcess | undefined;
    let hit: LsRemoteErrorCode | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    let size = 0;
    const killGroup = () => {
      const pid = child?.pid;
      if (typeof pid !== "number" || pid <= 1) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // the group is already gone
      }
    };
    const trip = (code: LsRemoteErrorCode) => {
      if (hit) return;
      hit = code;
      killGroup();
    };
    const timer = setTimeout(() => trip("timeout"), timeoutMs);
    const onAbort = () => trip("interrupted");
    const settle = (answer?: string, code?: LsRemoteErrorCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      killGroup();
      if (answer !== undefined) done(answer);
      else fail(new LsRemoteError(code ?? "unreachable"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child = spawn("git", [...OPTIONS, "ls-remote", "--quiet", "--", url, "HEAD"], { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      settle(undefined, "unreachable");
      return;
    }
    child.stdout?.on("data", (b: Buffer) => {
      size += b.length;
      if (size > LS_REMOTE_LIMITS.outBytes) trip("bad-answer");
      else chunks.push(b);
    });
    child.on("error", (e) => settle(undefined, hit ?? ((e as NodeJS.ErrnoException).code === "ENOENT" ? "no-git" : "unreachable")));
    child.on("exit", () => {
      // a helper must not keep the pipe open
      killGroup();
      if (hit) settle(undefined, hit);
    });
    child.on("close", (status) => {
      if (hit) return settle(undefined, hit);
      if (status !== 0) return settle(undefined, "unreachable");
      const text = Buffer.concat(chunks).toString("latin1");
      const m = ANSWER_RE.exec(text);
      if (!m) return settle(undefined, "bad-answer");
      settle(m[1]);
    });
    if (signal?.aborted) trip("interrupted");
  });
}
