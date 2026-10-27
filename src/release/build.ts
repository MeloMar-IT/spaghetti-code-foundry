import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { addValidator } from "./validator.js";
import { buildEnv, deniedNames, findCommand, groupAlive, killTree, matchBuild, type Host } from "./host.js";
import type { Build, CommitInfo, Recipe } from "./recipe.js";

export interface BuildPlan {
  run: Build[];
  skipped: { name: string; why: string }[];
  missing: { name: string; commands: string[] }[];
}

/** Which builds run on this machine, which are skipped (and why), and which lack a required command. */
export function planBuilds(recipe: Recipe, host: Host, pathVar: string, platform: string = process.platform): BuildPlan {
  const plan: BuildPlan = { run: [], skipped: [], missing: [] };
  for (const b of recipe.builds) {
    const m = matchBuild(b, host);
    if (!m.ok) {
      plan.skipped.push({ name: b.name, why: m.why });
      continue;
    }
    plan.run.push(b);
    const commands = b.requires.filter((c) => !findCommand(c, pathVar, platform));
    if (commands.length) plan.missing.push({ name: b.name, commands });
  }
  return plan;
}

/** A glob (`**`, `*`, `?`) as a regular expression over POSIX relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Every regular file below `root` (no symlinks, no .git) as a sorted relative POSIX path. */
function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out.sort();
}

/** The files below `root` that match one of the globs, as sorted relative POSIX paths. */
export function collectArtifacts(root: string, globs: string[]): string[] {
  const res = globs.map((g) => globToRegExp(g.replace(/^\.\//, "")));
  return walk(root).filter((f) => res.some((r) => r.test(f)));
}

/** Copy the collected files (`<inDir>/<build>/<path>`) into `outDir` with their folders. */
export function copyTree(inDir: string, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(inDir)) return;
  for (const f of walk(inDir)) {
    mkdirSync(dirname(join(outDir, f)), { recursive: true });
    copyFileSync(join(inDir, f), join(outDir, f));
  }
}

const sha256 = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
};

/** Write SHA256SUMS for every file below `dir` (relative paths) unless there is one. Files are hashed as streams. Returns whether it was written. */
export async function writeSha256Sums(dir: string): Promise<boolean> {
  const file = join(dir, "SHA256SUMS");
  if (existsSync(file)) return false;
  const lines: string[] = [];
  for (const f of walk(dir)) lines.push(`${await sha256(join(dir, f))}  ${f}`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return true;
}

const git = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Resolve a branch, tag or commit to one commit (git only, never a shell). */
export function resolveCommit(repoDir: string, ref: string): CommitInfo {
  // eslint-disable-next-line no-control-regex
  if (!ref || ref.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(ref)) throw new Error(`"${ref}" is not a usable ref`);
  for (const c of [`refs/remotes/origin/${ref}^{commit}`, `refs/tags/${ref}^{commit}`, `${ref}^{commit}`]) {
    let sha: string;
    try {
      sha = git(repoDir, ["rev-parse", "-q", "--verify", c]);
    } catch {
      continue;
    }
    if (!/^[0-9a-f]{40,64}$/.test(sha)) continue;
    const t = Number(git(repoDir, ["show", "-s", "--format=%ct", sha]));
    if (!Number.isInteger(t)) throw new Error(`cannot read the commit time of ${sha}`);
    return { sha, committerTime: t };
  }
  throw new Error(`cannot find "${ref}" in this repository`);
}

export interface CommandOpts {
  cmd: string;
  cwd: string;
  env: Record<string, string>;
  testSlot: string;
  slotsDir: string;
  timeoutMs: number;
  logFile: string;
  signal?: AbortSignal;
}

export interface CommandResult {
  code: number | null;
  timedOut: boolean;
  aborted: boolean;
}

const KILL_AFTER_TIMEOUT_MS = 10_000;
const KILL_AFTER_ABORT_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `cmd` with sh through tools/test-slot, in its own process group, output to a log file. A timeout or an abort stops the
 * whole tree (TERM, then KILL) and resolves only when the group is gone (or one second after the KILL).
 */
export function runCommand(o: CommandOpts): Promise<CommandResult> {
  mkdirSync(dirname(o.logFile), { recursive: true });
  const fd = openSync(o.logFile, "a");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [o.testSlot, o.slotsDir, "sh", "-c", o.cmd], {
      cwd: o.cwd,
      env: o.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    let timedOut = false;
    let aborted = false;
    let killAt = 0;
    let killTimer: NodeJS.Timeout | undefined;
    const stop = (graceMs: number) => {
      if (killTimer) return;
      killAt = Date.now() + graceMs;
      killTree(child.pid!, "SIGTERM");
      killTimer = setTimeout(() => killTree(child.pid!, "SIGKILL"), graceMs);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop(KILL_AFTER_TIMEOUT_MS);
    }, o.timeoutMs);
    const onAbort = () => {
      aborted = true;
      stop(KILL_AFTER_ABORT_MS);
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = async (code: number | null) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (killTimer && process.platform !== "win32") {
        while (groupAlive(child.pid!) && Date.now() < killAt + 1000) await sleep(50);
      }
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, timedOut, aborted });
    };
    child.on("error", (e) => {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code) => void finish(code));
    if (o.signal?.aborted) onAbort();
  });
}

export interface ReleasePlan {
  sha: string;
  version: string;
  tag: string;
  prerelease: boolean;
  keep: number;
  recipe: Recipe;
}

export interface ReleaseRun {
  repoDir: string;
  runDir: string;
  slotsDir: string;
  testSlot: string;
  plan: ReleasePlan;
  host: Host;
  env: NodeJS.ProcessEnv;
  denied?: Set<string>;
  signal?: AbortSignal;
  /** The delivery validator added to each release (default: this install's script). */
  validator?: string;
  log: (line: string) => void;
}

const tailOf = (file: string, n = 20) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-n).join("\n");
  } catch {
    return "";
  }
};

/** Build everything in the plan, one build after the other, and put the release files in `<runDir>/release/out`. Returns whether it worked. */
export async function runRelease(o: ReleaseRun): Promise<boolean> {
  const { plan, log } = o;
  const base = join(o.runDir, "release");
  const dirs = { in: join(base, "in"), out: join(base, "out"), work: join(base, "work"), logs: join(base, "logs") };
  for (const d of Object.values(dirs)) rmSync(d, { recursive: true, force: true });
  for (const d of [dirs.in, dirs.out, dirs.work, dirs.logs]) mkdirSync(d, { recursive: true });

  const bp = planBuilds(plan.recipe, o.host, o.env.PATH ?? "");
  for (const s of bp.skipped) log(`${s.name}: skipped, ${s.why}`);
  if (bp.missing.length) {
    for (const m of bp.missing) log(`${m.name}: failed, ${m.commands.length === 1 ? "the command" : "the commands"} ${m.commands.join(", ")} ${m.commands.length === 1 ? "is" : "are"} not installed on this machine (requires)`);
    return false;
  }
  if (!bp.run.length) {
    log(`nothing to build on this machine (${o.host.platform}-${o.host.arch})`);
    return false;
  }

  const env = buildEnv(o.env, { version: plan.version, tag: plan.tag, sha: plan.sha, inDir: dirs.in, outDir: dirs.out }, o.denied ?? deniedNames());
  // A build holds a test slot like every test run: it waits for one (test-slot's own longest wait) and fails rather than run without.
  env.FACTORY_TEST_SLOT_STRICT = "1";
  const timeoutMs = plan.recipe.timeout_minutes * 60_000;

  const inTree = async (name: string, cmd: string): Promise<{ ok: boolean; why: string; logFile: string }> => {
    const dir = join(dirs.work, name);
    const logFile = join(dirs.logs, `${name}.log`);
    execFileSync("git", ["worktree", "add", "--detach", "-q", dir, plan.sha], { cwd: o.repoDir, stdio: "pipe" });
    try {
      const r = await runCommand({ cmd, cwd: dir, env, testSlot: o.testSlot, slotsDir: o.slotsDir, timeoutMs, logFile, signal: o.signal });
      if (r.aborted) return { ok: false, why: "cancelled", logFile };
      if (r.timedOut) return { ok: false, why: `timed out after ${plan.recipe.timeout_minutes} minutes`, logFile };
      if (r.code !== 0) return { ok: false, why: `exit code ${r.code}`, logFile };
      return { ok: true, why: "", logFile };
    } finally {
      cleanup(dir);
    }
  };
  const cleanup = (dir: string) => {
    try {
      execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: o.repoDir, stdio: "pipe" });
    } catch {
      rmSync(dir, { recursive: true, force: true });
    }
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: o.repoDir, stdio: "pipe" });
    } catch {
      /* nothing to prune */
    }
  };
  const fail = (name: string, why: string, logFile?: string): false => {
    log(`${name}: failed, ${why}`);
    const tail = logFile ? tailOf(logFile) : "";
    if (tail) log(`--- last lines of ${name}\n${tail}`);
    return false;
  };

  for (const b of bp.run) {
    if (o.signal?.aborted) return fail(b.name, "cancelled");
    const dir = join(dirs.work, b.name);
    const logFile = join(dirs.logs, `${b.name}.log`);
    execFileSync("git", ["worktree", "add", "--detach", "-q", dir, plan.sha], { cwd: o.repoDir, stdio: "pipe" });
    let files: string[];
    try {
      log(`${b.name}: building`);
      const r = await runCommand({ cmd: b.run, cwd: dir, env, testSlot: o.testSlot, slotsDir: o.slotsDir, timeoutMs, logFile, signal: o.signal });
      if (r.aborted) return fail(b.name, "cancelled", logFile);
      if (r.timedOut) return fail(b.name, `timed out after ${plan.recipe.timeout_minutes} minutes`, logFile);
      if (r.code !== 0) return fail(b.name, `exit code ${r.code}`, logFile);
      files = collectArtifacts(dir, b.artifacts);
      if (!files.length) return fail(b.name, `no files match (${b.artifacts.join(", ")})`, logFile);
      for (const f of files) {
        const to = join(dirs.in, b.name, f);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(dir, f), to);
      }
    } finally {
      cleanup(dir);
    }
    log(`${b.name}: ok, ${files.length} ${files.length === 1 ? "file" : "files"}`);
  }

  if (plan.recipe.assemble) {
    log("assemble: running");
    const r = await inTree("assemble", plan.recipe.assemble);
    if (!r.ok) return fail("assemble", r.why, r.logFile);
  } else {
    try {
      copyTree(dirs.in, dirs.out);
    } catch (e) {
      return fail("collect", (e as Error).message);
    }
  }
  const names = walk(dirs.out);
  if (!names.length) return fail("assemble", "no files in the output folder");
  try {
    const v = addValidator(dirs.out, o.validator);
    names.push(v.name, v.name + ".sha256");
    log("validator: " + v.name + ", sha256 " + v.sha256);
  } catch (e) {
    return fail("validator", (e as Error).message);
  }
  try {
    await writeSha256Sums(dirs.out);
  } catch (e) {
    return fail("checksums", (e as Error).message);
  }
  if (!names.includes("SHA256SUMS")) names.push("SHA256SUMS");
  names.sort();
  log(`RELEASE: ${plan.tag} (${plan.version})`);
  log(`FILES: ${names.join(" ")}`);
  return true;
}
