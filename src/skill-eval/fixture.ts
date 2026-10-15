import { spawn } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { EVALUATION_SUITE_LIMITS } from "../skills/evaluation-rules.js";
import { instructionFixtureHash, type InstructionsSuite } from "../skills/evaluation-instructions.js";
import { shownValue } from "../skills/sources.js";
import { EvaluationInterrupted } from "./run.js";

// The fixture snapshots of one evaluation: each fixture folder is copied under the temporary root, committed with a clean git
// (no machine, repository or hook configuration), and checked against the suite's hash again after the commit. The fixture step of a
// run clones the snapshot, so the tree the hash was made for is the tree the agent works on.

export const FIXTURE_GIT_TIMEOUT_MS = 30_000;

/** The environment git runs with here: no inherited `GIT_*` variable, no global or system configuration, no prompts. */
export function cleanGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("GIT_")) out[k] = v;
  return { ...out, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.autocrlf=false", "-c", "core.excludesFile=/dev/null", "-c", "commit.gpgsign=false"];
const IDENTITY = ["-c", "user.name=scf skill evaluation", "-c", "user.email=skill-evaluation@invalid"];

/** True when the folder holds an entry called `.git` (any case) at any depth. Bounded by the fixture limits. */
function holdsGit(dir: string): boolean {
  const queue = [dir];
  let nodes = 0;
  for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
    for (const name of readdirSync(d)) {
      if (++nodes > EVALUATION_SUITE_LIMITS.fixtureEntries * 4) return true;
      if (name.toLowerCase() === ".git") return true;
      const full = join(d, name);
      if (lstatSync(full).isDirectory()) queue.push(full);
    }
  }
  return false;
}

/**
 * Copies, commits and verifies every fixture of the instructions scenarios under `root` (which the caller removes).
 * Returns the snapshot folder of each `repo` of the suite, or the first problem. Throws EvaluationInterrupted when `signal` aborts.
 */
export async function snapshotFixtures(
  suiteDir: string,
  suite: InstructionsSuite,
  expected: ReadonlyMap<string, string>,
  root: string,
  signal: AbortSignal,
): Promise<{ repos: Map<string, string> } | { problem: string }> {
  const repos = new Map<string, string>();
  const env = cleanGitEnv(process.env);
  const git = async (cwd: string, args: string[]) => {
    if (signal.aborted) throw new EvaluationInterrupted();
    // The child handle is kept: an abort or a timeout kills it, and nothing returns before its `close` event, so no git
    // process is still running when the caller removes the temporary root.
    const code = await new Promise<number | null>((resolveClose, reject) => {
      const child = spawn("git", [...SAFE, ...args], { cwd, env, stdio: "ignore" });
      const stop = () => child.kill("SIGKILL");
      const timer = setTimeout(stop, FIXTURE_GIT_TIMEOUT_MS);
      signal.addEventListener("abort", stop, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
      };
      child.once("error", (e) => {
        done();
        reject(e);
      });
      child.once("close", (c) => {
        done();
        resolveClose(c);
      });
    });
    if (signal.aborted) throw new EvaluationInterrupted();
    if (code !== 0) throw new Error("git failed");
  };
  let n = 0;
  for (const repo of [...new Set(suite.scenarios.map((s) => s.repo))].sort()) {
    if (signal.aborted) throw new EvaluationInterrupted();
    const label = `instructions fixture ${shownValue(repo)}`;
    const want = expected.get(repo);
    if (want === undefined) return { problem: `${label} has no hash in the suite` };
    const base = join(root, "fixtures", String(n++));
    const snap = join(base, "src");
    const verify = join(base, "verify");
    try {
      const source = resolve(suiteDir, repo);
      if (holdsGit(source)) return { problem: `${label} holds a .git entry` };
      mkdirSync(base, { recursive: true });
      cpSync(source, snap, { recursive: true, verbatimSymlinks: true });
      const got = instructionFixtureHash(snap);
      if (!("hash" in got)) return { problem: `${label} ${got.problem}` };
      if (got.hash !== want) return { problem: `${label} does not match its hash` };
      await git(snap, ["init", "--template=", "-q"]);
      await git(snap, ["add", "-A", "--force"]);
      await git(snap, [...IDENTITY, "commit", "-q", "--allow-empty", "--no-verify", "-m", "fixture"]);
      await git(base, ["clone", "-q", "--no-hardlinks", "--template=", snap, verify]);
      rmSync(join(verify, ".git"), { recursive: true, force: true });
      const again = instructionFixtureHash(verify);
      if (!("hash" in again) || again.hash !== want) return { problem: `${label} does not match its hash after commit` };
      rmSync(verify, { recursive: true, force: true });
    } catch (e) {
      if (e instanceof EvaluationInterrupted) throw e;
      return { problem: `${label} cannot be prepared` };
    }
    repos.set(repo, snap);
  }
  return { repos };
}
