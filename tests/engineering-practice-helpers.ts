import { execFile, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cleanGitEnv } from "../src/skill-eval/fixture.js";
import { readEvaluationSuite } from "../src/skills/evaluation-suite.js";

// Helpers of the tests of evals/skill-gate/engineering-practice: a git work folder per case, and the checks run as the flow runs them.

export const ROOT = resolve("evals/skill-gate/engineering-practice");

const read = readEvaluationSuite(join(ROOT, "suite.yaml"));
if (read.state !== "ok") throw new Error(JSON.stringify(read));
export const suiteRead = read;
export const instructions = read.suite.instructions!;

const env = () => ({ ...cleanGitEnv(process.env), PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` });
const GIT = ["-c", "user.name=test", "-c", "user.email=test@invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];

const made: string[] = [];
export function removeWorkFolders(): void {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A copy of a fixture with one commit, like the clone the fixture step of a run makes. */
export function workFolder(fixture: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "engprac-")));
  made.push(dir);
  cpSync(join(ROOT, "fixtures", fixture), dir, { recursive: true });
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "fixture"]]) {
    const r = spawnSync("git", [...GIT, ...args], { cwd: dir, env: env(), encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
  }
  return dir;
}

/** Writes files (relative path to content) into a work folder. */
export function put(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** The exit status of the check of a scenario in `cwd`. */
export function checkStatus(id: string, cwd: string): Promise<number | null> {
  const scenario = instructions.scenarios.find((s) => s.id === id);
  if (!scenario) throw new Error(`no scenario ${id}`);
  return new Promise((done) => {
    execFile("sh", ["-c", scenario.check], { cwd, env: env(), timeout: 60000 }, (err) => {
      done(err === null ? 0 : typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : null);
    });
  });
}
