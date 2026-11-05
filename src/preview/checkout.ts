import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validBranchName } from "../auth/repo-settings.js";
import { cleanEnv, SAFE_OPTIONS } from "../engine/diff.js";
import { gitAuth, localRemote, type ConnectInput } from "../repos/connect.js";
import { PREVIEW_PATH } from "./config.js";

export const PREVIEW_FILE_MAX = 64 * 1024;
export const CHECKOUT_TIMEOUT_MS = 120_000;

export type PreviewSource =
  | { kind: "remote"; url: string; auth: Pick<ConnectInput, "method" | "username" | "secret"> }
  | { kind: "path"; path: string };

export type CheckoutResult =
  | { ok: true; config?: string; configProblem?: string } // neither = no file
  | { ok: false; reason: "no-branch" | "no-source" | "checkout-failed"; detail: string };

export interface CheckoutOptions {
  source: PreviewSource;
  branch: string;
  dir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  gitBin?: string;
}

/** The git processes of running checkouts. Each is the leader of its own process group. */
const live = new Set<ChildProcess>();

function killGroup(c: ChildProcess): void {
  if (c.pid === undefined) return;
  try {
    process.kill(-c.pid, "SIGKILL");
  } catch {
    try {
      c.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}

/** Kills every running checkout git (with its children) at once. Synchronous: safe in an exit path. */
export function killCheckouts(): void {
  for (const c of live) killGroup(c);
}

interface Ran {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  stopped: boolean;
}

/** Runs git in its own process group. A timeout or an abort kills the whole group and waits until it has ended. */
function runGit(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: null, stdout: Buffer.alloc(0), stderr: "", stopped: true });
    let stopped = false;
    const out: Buffer[] = [];
    let size = 0;
    let err = "";
    const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    live.add(child);
    const stop = () => {
      stopped = true;
      killGroup(child);
    };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    let ended = false;
    const end = (code: number | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      live.delete(child);
      resolve({ code, stdout: Buffer.concat(out), stderr: err, stopped });
    };
    child.stdout!.on("data", (b: Buffer) => {
      size += b.length;
      if (size <= PREVIEW_FILE_MAX + 4096) out.push(b);
    });
    child.stderr!.on("data", (b: Buffer) => {
      if (err.length < 8192) err += b.toString("utf8");
    });
    child.on("error", () => end(null));
    child.on("close", (code) => end(code));
  });
}

const FAILED = "the project could not be checked out";
const failed = (detail = FAILED): CheckoutResult => ({ ok: false, reason: "checkout-failed", detail });

/** Clones one branch of one source (depth 1, no hooks) into `dir` and reads `.factory/preview.yaml` of that commit through git. */
export async function checkoutPreview(o: CheckoutOptions): Promise<CheckoutResult> {
  if (!validBranchName(o.branch)) return failed("the branch name is not valid");
  const bin = o.gitBin ?? "git";
  const timeoutMs = o.timeoutMs ?? CHECKOUT_TIMEOUT_MS;
  let tmp: string | undefined;
  try {
    let env: NodeJS.ProcessEnv;
    let authArgs: string[] = [];
    let address: string;
    const extra: string[] = [];
    if (o.source.kind === "path") {
      let isDir = false;
      try {
        isDir = statSync(o.source.path).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) return { ok: false, reason: "no-source", detail: "the folder to check out from is not there" };
      env = cleanEnv({ GIT_ALLOW_PROTOCOL: "file", LC_ALL: "C" });
      address = `file://${o.source.path}`;
      extra.push("--no-local");
    } else {
      tmp = mkdtempSync(join(tmpdir(), "scf-preview-"));
      const auth = gitAuth(tmp, o.source.auth);
      env = auth.env;
      authArgs = auth.args;
      const local = localRemote();
      address = local ? `file://${local}` : o.source.url;
    }
    mkdirSync(dirname(o.dir), { recursive: true, mode: 0o700 });
    const clone = await runGit(
      bin,
      [...SAFE_OPTIONS, ...authArgs, "clone", "--quiet", "--no-tags", "--single-branch", "--depth", "1", "--template=", ...extra, `--branch=${o.branch}`, "--", address, o.dir],
      env,
      dirname(o.dir),
      o.signal,
      timeoutMs,
    );
    if (clone.code !== 0) {
      rmSync(o.dir, { recursive: true, force: true });
      if (clone.stopped) return failed();
      if (/not found in upstream|Remote branch .* not found/.test(clone.stderr)) return { ok: false, reason: "no-branch", detail: "the branch is not in the project" };
      return failed();
    }
    return await readConfig(bin, o.dir, o.signal, timeoutMs);
  } catch {
    return failed();
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** Reads the file from the checked-out commit, not from the working tree, so a link in the tree points nowhere. */
async function readConfig(bin: string, dir: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<CheckoutResult> {
  const env = cleanEnv({ LC_ALL: "C" });
  const git = (...args: string[]) => runGit(bin, [...SAFE_OPTIONS, ...args], env, dir, signal, timeoutMs);
  const tree = await git("ls-tree", "-z", "HEAD", "--", PREVIEW_PATH);
  if (tree.code !== 0) return failed();
  const entry = tree.stdout.toString("utf8").split("\0")[0] ?? "";
  if (!entry) return { ok: true };
  const m = /^(\d+) (\w+) ([0-9a-f]{40,64})\t/.exec(entry);
  if (!m) return failed();
  const [, mode, type, sha] = m;
  if (type !== "blob" || (mode !== "100644" && mode !== "100755")) return { ok: true, configProblem: `${PREVIEW_PATH} is not a regular file` };
  const size = await git("cat-file", "-s", sha!);
  if (size.code !== 0) return failed();
  if (Number(size.stdout.toString("utf8").trim()) > PREVIEW_FILE_MAX) return { ok: true, configProblem: `${PREVIEW_PATH} is larger than 64 KiB` };
  const blob = await git("cat-file", "blob", sha!);
  if (blob.code !== 0) return failed();
  return { ok: true, config: blob.stdout.toString("utf8") };
}
