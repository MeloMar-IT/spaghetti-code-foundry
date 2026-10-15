import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { trackRefProblem } from "../skills/sources.js";
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
  const text = await ask(repository, ["HEAD"], opts);
  const m = ANSWER_RE.exec(text);
  if (!m) throw new LsRemoteError("bad-answer");
  return m[1]!;
}

const LINE_RE = /^([0-9a-f]{40}|[0-9a-f]{64})\t(\S+)\n/;
export type TrackResult = { commit: string } | { missing: "no-ref" | "ambiguous" };

/**
 * The commit a branch or a tag points at now, from one `git ls-remote`. An annotated tag gives the commit it points at (the
 * peeled line), not the tag object. A branch and a tag of the same name are ambiguous. Only the three exact ref names asked for
 * are read from the answer.
 */
export async function resolveTrack(repository: string, track: string, opts: LsRemoteOptions = {}): Promise<TrackResult> {
  if (trackRefProblem(track) !== undefined) throw new LsRemoteError("bad-answer");
  const branch = `refs/heads/${track}`;
  const tag = `refs/tags/${track}`;
  const peeled = `${tag}^{}`;
  const text = await ask(repository, [branch, tag, peeled], opts);
  const found = new Map<string, string>();
  let rest = text;
  while (rest.length > 0) {
    const m = LINE_RE.exec(rest);
    if (!m) throw new LsRemoteError("bad-answer");
    rest = rest.slice(m[0].length);
    if (m[2] === branch || m[2] === tag || m[2] === peeled) found.set(m[2], m[1]!);
  }
  const b = found.get(branch);
  const t = found.get(peeled) ?? found.get(tag);
  if (b !== undefined && t !== undefined) return { missing: "ambiguous" };
  const commit = b ?? t;
  return commit === undefined ? { missing: "no-ref" } : { commit };
}

async function ask(repository: string, patterns: readonly string[], opts: LsRemoteOptions): Promise<string> {
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
    return await run(url, patterns, tmp, env, opts.timeoutMs ?? LS_REMOTE_LIMITS.timeoutMs, opts.signal);
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

function run(url: string, patterns: readonly string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<string> {
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
      child = spawn("git", [...OPTIONS, "ls-remote", "--quiet", "--", url, ...patterns], { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
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
      settle(text);
    });
    if (signal?.aborted) trip("interrupted");
  });
}
