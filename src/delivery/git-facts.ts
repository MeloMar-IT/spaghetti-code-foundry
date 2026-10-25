import { execFileSync } from "node:child_process";
import { cleanEnv, SAFE_OPTIONS } from "../engine/diff.js";
import { CommitSchema, GitIdentitySchema, isSafeRelativePath, sha256Hex } from "../evidence/identity.js";
import { BlobIdSchema, WORKFLOWS_DIR } from "./schema.js";

/** The git facts of a delivery contract, read from the commit the workspace is on. Synchronous, bounded, and never shows git's own messages. */

/** File names whose content is a dependency lock (at any depth). */
export const DEPENDENCY_LOCK_NAMES: readonly string[] = Object.freeze([
  "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb",
  "go.sum", "Cargo.lock", "Pipfile.lock", "poetry.lock", "uv.lock", "Gemfile.lock", "composer.lock",
  "mix.lock", "pubspec.lock", "deno.lock", "Package.resolved", "packages.lock.json", "gradle.lockfile", "flake.lock",
]);

export interface CommitFacts {
  commit: { sha: string; branch: string };
  dependencyLocks: { path: string; sha256: string }[];
  ciWorkflows: { path: string; blob: string }[];
}

export interface CommitFactsOptions {
  /** The git program; tests put a script here. */
  gitBin?: string;
  /** One time limit for all git calls (default 10 s). */
  budgetMs?: number;
  /** At most this many lock files (default 1000). */
  maxLockFiles?: number;
  /** At most this many bytes of git output and of blobs (default 64 MiB). */
  maxBytes?: number;
  /** Facts of an earlier call: when the commit is the same, its lock and workflow facts are returned without reading the tree. */
  reuse?: CommitFacts;
}

export const COMMIT_FACTS_FAULTS = {
  detached: "the workspace is not on a branch",
  tooMany: "the commit has too many lock or workflow files",
  tooLarge: "the data of the commit is too large",
  timeout: "reading the commit took too long",
  missing: "an object of the commit is missing",
  badName: "a file name of the commit cannot be recorded",
  git: "git could not read the commit",
} as const;
type Fault = keyof typeof COMMIT_FACTS_FAULTS;

/** The message is always one of COMMIT_FACTS_FAULTS: no path, no output of git. */
export class CommitFactsError extends Error {
  constructor(readonly fault: Fault) {
    super(COMMIT_FACTS_FAULTS[fault]);
    this.name = "CommitFactsError";
  }
}

const MAX_WORKFLOWS = 1000;

export function readCommitFacts(workdir: string, o: CommitFactsOptions = {}): CommitFacts {
  const bin = o.gitBin ?? "git";
  const maxLockFiles = o.maxLockFiles ?? 1000;
  const maxBytes = o.maxBytes ?? 64 * 1024 * 1024;
  const deadline = Date.now() + (o.budgetMs ?? 10_000);
  const run = (args: string[], failure: Fault, input?: string): Buffer => {
    const left = deadline - Date.now();
    if (left <= 0) throw new CommitFactsError("timeout");
    try {
      return execFileSync(bin, [...SAFE_OPTIONS, ...args], {
        cwd: workdir,
        env: cleanEnv({ GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" }),
        stdio: ["pipe", "pipe", "ignore"],
        timeout: left,
        killSignal: "SIGKILL",
        maxBuffer: maxBytes,
        ...(input === undefined ? {} : { input }),
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException & { signal?: string };
      if (err.code === "ETIMEDOUT" || err.signal === "SIGKILL") throw new CommitFactsError("timeout");
      if (err.code === "ENOBUFS") throw new CommitFactsError("tooLarge");
      throw new CommitFactsError(failure);
    }
  };

  const sha = run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], "git").toString("utf8").trim();
  if (!CommitSchema.safeParse(sha).success) throw new CommitFactsError("git");
  const branch = run(["symbolic-ref", "-q", "--short", "HEAD"], "detached").toString("utf8").trim();
  if (!GitIdentitySchema.shape.branch.safeParse(branch).success) throw new CommitFactsError("detached");
  if (o.reuse?.commit.sha === sha) return { commit: { sha, branch }, dependencyLocks: o.reuse.dependencyLocks, ciWorkflows: o.reuse.ciWorkflows };

  // the tree of the captured commit; the commit was just checked, so a failure here is a missing or broken tree
  const tree = run(["ls-tree", "-r", "-z", "--full-tree", sha], "missing").toString("utf8");
  const locks: { path: string; oid: string }[] = [];
  const workflows: { path: string; oid: string }[] = [];
  for (const entry of tree.split("\0")) {
    if (entry === "") continue;
    const m = /^([0-7]{6}) (\w+) ([0-9a-f]{40}|[0-9a-f]{64})\t([\s\S]+)$/.exec(entry);
    if (!m) throw new CommitFactsError("git");
    const [, , type, oid, path] = m as unknown as [string, string, string, string, string];
    if (type !== "blob") continue;
    const isLock = DEPENDENCY_LOCK_NAMES.includes(path.slice(path.lastIndexOf("/") + 1));
    const isWorkflow = path.startsWith(WORKFLOWS_DIR) && path.length > WORKFLOWS_DIR.length;
    if (!isLock && !isWorkflow) continue;
    if (!isSafeRelativePath(path)) throw new CommitFactsError("badName");
    if (isLock) locks.push({ path, oid });
    if (isWorkflow) workflows.push({ path, oid });
    if (locks.length > maxLockFiles || workflows.length > MAX_WORKFLOWS) throw new CommitFactsError("tooMany");
  }
  for (const w of workflows) if (!BlobIdSchema.safeParse(w.oid).success) throw new CommitFactsError("git");

  const wanted = [...locks, ...workflows];
  const sums = new Map<string, string>();
  if (wanted.length > 0) {
    const out = run(["cat-file", "--batch"], "missing", wanted.map((w) => w.oid).join("\n") + "\n");
    let pos = 0;
    let total = 0;
    for (const w of wanted) {
      const nl = out.indexOf(0x0a, pos);
      if (nl < 0) throw new CommitFactsError("missing");
      const header = out.subarray(pos, nl).toString("utf8").split(" ");
      pos = nl + 1;
      if (header[0] !== w.oid || header[1] !== "blob" || !/^[0-9]+$/.test(header[2] ?? "")) throw new CommitFactsError("missing");
      const size = Number(header[2]);
      total += size;
      if (total > maxBytes) throw new CommitFactsError("tooLarge");
      if (pos + size + 1 > out.length || out[pos + size] !== 0x0a) throw new CommitFactsError("missing");
      sums.set(w.path, sha256Hex(out.subarray(pos, pos + size)));
      pos += size + 1;
    }
  }
  return {
    commit: { sha, branch },
    dependencyLocks: locks.map((l) => ({ path: l.path, sha256: sums.get(l.path) as string })),
    ciWorkflows: workflows.map((w) => ({ path: w.path, blob: w.oid })),
  };
}
