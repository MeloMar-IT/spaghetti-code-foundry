import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDiff } from "../src/engine/diff.js";
import { prepareWorkspace, repoRoot } from "../src/engine/workspace.js";
import type { RunSummary } from "../src/engine/state.js";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ["HOME", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1", "GIT_EXTERNAL_DIFF", "GIT_DIR"];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "diff-test-"));
  for (const k of KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });

function repoWithCommit(): string {
  const dir = join(tmp, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

/** A script that makes `marker`; with `cat` it also copies stdin, so it can be a clean filter. */
function trap(name: string, marker: string, cat = false): string {
  const p = join(tmp, name);
  writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\n${cat ? "cat\n" : ""}`);
  chmodSync(p, 0o755);
  return p;
}

const summary = (workdir: string, extra: Partial<RunSummary> = {}) => ({ workdir, ...extra }) as RunSummary;

describe("runDiff does not run anything from the workspace or the machine", () => {
  it("core.fsmonitor and a clean filter of the workspace", () => {
    const dir = repoWithCommit();
    const base = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, ".gitattributes"), "* filter=leak\n");
    const m1 = join(tmp, "m-fsmonitor");
    const m2 = join(tmp, "m-filter");
    git(dir, "config", "core.fsmonitor", trap("fs.sh", m1));
    git(dir, "config", "filter.leak.clean", trap("clean.sh", m2, true));
    expect(existsSync(m1) || existsSync(m2)).toBe(false);
    const d = runDiff(summary(dir, { baseSha: base }));
    expect(d.patch).toContain("+two");
    expect(existsSync(m1)).toBe(false);
    expect(existsSync(m2)).toBe(false);
    // control: the traps do fire for a plain add in the same folder
    execFileSync("git", ["add", "-A"], { cwd: dir, env: { ...GIT_ENV, GIT_INDEX_FILE: join(tmp, "control-index") }, stdio: "ignore" });
    expect(existsSync(m2)).toBe(true);
  });

  it("settings in the server's environment", () => {
    const dir = repoWithCommit();
    const base = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, ".gitattributes"), "* filter=leak\n");
    const m1 = join(tmp, "m-env-fs");
    const m2 = join(tmp, "m-env-filter");
    const m3 = join(tmp, "m-env-ext");
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: trap("efs.sh", m1),
      GIT_CONFIG_KEY_1: "filter.leak.clean",
      GIT_CONFIG_VALUE_1: trap("ecl.sh", m2, true),
      GIT_EXTERNAL_DIFF: trap("ext.sh", m3),
    });
    const d = runDiff(summary(dir, { baseSha: base }));
    expect(d.patch).toContain("+two");
    for (const m of [m1, m2, m3]) expect(existsSync(m)).toBe(false);
  });

  it("settings in the machine's git files; its ignore files do not hide anything", () => {
    const dir = repoWithCommit();
    const base = git(dir, "rev-parse", "HEAD").trim();
    const home = join(tmp, "home");
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    const m1 = join(tmp, "m-home-fs");
    const m2 = join(tmp, "m-home-filter");
    writeFileSync(join(home, "attr"), "* filter=leak\n");
    writeFileSync(join(home, "excl"), "hidden.txt\n");
    writeFileSync(
      join(home, ".gitconfig"),
      `[core]\n\tfsmonitor = ${trap("hfs.sh", m1)}\n\tattributesFile = ${join(home, "attr")}\n\texcludesFile = ${join(home, "excl")}\n[filter "leak"]\n\tclean = ${trap("hcl.sh", m2, true)}\n`,
    );
    writeFileSync(join(home, ".config", "git", "attributes"), "* filter=leak\n");
    writeFileSync(join(home, ".config", "git", "ignore"), "hidden2.txt\n");
    writeFileSync(join(dir, "hidden.txt"), "x\n");
    writeFileSync(join(dir, "hidden2.txt"), "y\n");
    process.env.HOME = home;
    const d = runDiff(summary(dir, { baseSha: base }));
    expect(existsSync(m1)).toBe(false);
    expect(existsSync(m2)).toBe(false);
    expect(d.patch).toContain("hidden.txt");
    expect(d.patch).toContain("hidden2.txt");
  });

  it("follows .gitignore only", () => {
    const dir = repoWithCommit();
    const base = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "ignored.txt"), "i\n");
    writeFileSync(join(dir, "excluded.txt"), "e\n");
    writeFileSync(join(dir, "configured.txt"), "c\n");
    writeFileSync(join(dir, ".git", "info", "exclude"), "excluded.txt\n");
    writeFileSync(join(tmp, "own-excl"), "configured.txt\n");
    git(dir, "config", "core.excludesFile", join(tmp, "own-excl"));
    const d = runDiff(summary(dir, { baseSha: base }));
    expect(d.patch).not.toContain("diff --git a/ignored.txt");
    expect(d.patch).toContain("diff --git a/excluded.txt");
    expect(d.patch).toContain("diff --git a/configured.txt");
  });
});

describe("runDiff keeps the run's repository as it was", () => {
  it("shows a new file and leaves the index and the objects alone", () => {
    const dir = repoWithCommit();
    const base = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "new.txt"), "brand new\n");
    const index = () => readFileSync(join(dir, ".git", "index"));
    const before = { index: index(), count: git(dir, "count-objects", "-v") };
    const d = runDiff(summary(dir, { baseSha: base }));
    expect(d.patch).toContain("new.txt");
    expect(index().equals(before.index)).toBe(true);
    expect(git(dir, "count-objects", "-v")).toBe(before.count);
  });
});

describe("runDiff in a linked worktree", () => {
  it("shows committed, changed and new files; the worktree is untouched", () => {
    const repo = repoWithCommit();
    const runDir = join(tmp, "run");
    mkdirSync(runDir);
    const ws = prepareWorkspace("worktree", repo, runDir, "run-1");
    const wd = ws.workdir;
    expect(readFileSync(join(wd, ".git"), "utf8")).toContain("gitdir:");
    const base = git(wd, "rev-parse", "HEAD").trim();
    writeFileSync(join(wd, "committed.txt"), "c\n");
    git(wd, "add", "-A");
    git(wd, "commit", "-q", "-m", "c");
    writeFileSync(join(wd, "a.txt"), "changed\n");
    writeFileSync(join(wd, "untracked.txt"), "u\n");
    const status = git(wd, "status", "--porcelain");
    const d = runDiff(summary(wd, { baseSha: base }));
    expect(d.base).toBe(base);
    for (const f of ["committed.txt", "a.txt", "untracked.txt"]) {
      expect(d.patch).toContain(f);
      expect(d.stat).toContain(f);
    }
    expect(git(wd, "status", "--porcelain")).toBe(status);
  });
});

describe("runDiff in a SHA-256 repository", () => {
  it("shows the changes", () => {
    const dir = join(tmp, "sha256");
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main", "--object-format=sha256");
    writeFileSync(join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "first");
    const base = git(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    const d = runDiff(summary(dir, { baseSha: base }));
    expect(d.patch).toContain("+two");
    expect(d.patch).toContain("new.txt");
  });
});

describe("runDiff without a recorded base", () => {
  it("uses the merge-base with origin/HEAD", () => {
    const bare = join(tmp, "bare.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: GIT_ENV });
    const seed = repoWithCommit();
    git(seed, "push", "-q", bare, "main");
    const clone = join(tmp, "clone");
    execFileSync("git", ["clone", "-q", bare, clone], { env: GIT_ENV });
    writeFileSync(join(clone, "local.txt"), "l\n");
    const d = runDiff(summary(clone));
    expect(d.base).toBe(git(clone, "rev-parse", "HEAD").trim());
    expect(d.patch).toContain("local.txt");
  });
});

describe("the time limit", () => {
  const slowGit = () => {
    const count = join(tmp, "count");
    const bin = join(tmp, "slow-git");
    writeFileSync(bin, `#!/bin/sh\necho x >> '${count}'\nexec sleep 30\n`);
    chmodSync(bin, 0o755);
    return { bin, lines: () => (existsSync(count) ? readFileSync(count, "utf8").trim().split("\n").filter(Boolean).length : 0) };
  };

  it("ends a git call that hangs", () => {
    const dir = repoWithCommit();
    const slow = slowGit();
    const t0 = Date.now();
    expect(() => runDiff(summary(dir, { baseSha: "abc" }), { gitBin: slow.bin, budgetMs: 300 })).toThrow(/too long/);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("does not turn a timeout into an empty diff when there is no base", () => {
    const dir = repoWithCommit();
    const slow = slowGit();
    expect(() => runDiff(summary(dir), { gitBin: slow.bin, budgetMs: 300 })).toThrow(/too long/);
    expect(slow.lines()).toBe(1);
  });

  it("starts nothing with no time left", () => {
    const dir = repoWithCommit();
    const slow = slowGit();
    expect(() => runDiff(summary(dir, { baseSha: "abc" }), { gitBin: slow.bin, budgetMs: 0 })).toThrow(/too long/);
    expect(slow.lines()).toBe(0);
  });
});

describe("prepareWorkspace does not run anything from the repository's hooks or the machine", () => {
  it("a post-checkout hook and core.fsmonitor of the repository", () => {
    const dir = repoWithCommit();
    const m1 = join(tmp, "m-hook");
    const m2 = join(tmp, "m-fsmonitor");
    const hook = join(dir, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\ntouch '${m1}'\n`);
    chmodSync(hook, 0o755);
    git(dir, "config", "core.fsmonitor", trap("fs.sh", m2));
    const ws = prepareWorkspace("worktree", dir, join(tmp, "run"), "run-1");
    expect(existsSync(m1)).toBe(false);
    expect(existsSync(m2)).toBe(false);
    expect(ws.branch).toBe("factory/run-1");
    expect(existsSync(join(ws.workdir, "a.txt"))).toBe(true);
    // control: a plain worktree add does run the hook
    git(dir, "worktree", "add", "-b", "other", join(tmp, "plain"), "HEAD");
    expect(existsSync(m1)).toBe(true);
  });

  it("the machine's settings and the server's environment", () => {
    const dir = repoWithCommit();
    writeFileSync(join(dir, ".gitattributes"), "*.txt filter=leak\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "attrs");
    const other = join(tmp, "other");
    mkdirSync(other);
    git(other, "init", "-q", "-b", "main");
    const m3 = join(tmp, "m-home");
    const m4 = join(tmp, "m-env");
    const home = join(tmp, "home");
    mkdirSync(home);
    writeFileSync(join(home, ".gitconfig"), `[filter "leak"]\n\tsmudge = ${trap("home.sh", m3, true)}\n`);
    process.env.HOME = home;
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "filter.leak.smudge";
    process.env.GIT_CONFIG_VALUE_0 = trap("env.sh", m4, true);
    process.env.GIT_DIR = join(other, ".git");
    const ws = prepareWorkspace("worktree", dir, join(tmp, "run"), "run-1");
    expect(existsSync(m3)).toBe(false);
    expect(existsSync(m4)).toBe(false);
    expect(readFileSync(join(ws.workdir, "a.txt"), "utf8")).toBe("one\n");
    const { GIT_DIR: _drop, ...plain } = process.env;
    expect(execFileSync("git", ["-C", dir, "branch", "--list", "factory/run-1"], { encoding: "utf8", env: plain }).trim()).toContain("factory/run-1");
    expect(execFileSync("git", ["-C", other, "branch", "--list", "factory/run-1"], { encoding: "utf8", env: plain }).trim()).toBe("");
    // control: without the clean environment the environment's filter does run
    execFileSync("git", ["worktree", "add", "-b", "ctl", join(tmp, "ctl"), "HEAD"], { cwd: dir, env: plain, stdio: "ignore" });
    expect(existsSync(m4)).toBe(true);
  });

  it("repoRoot finds the repository in a hostile environment", () => {
    const dir = repoWithCommit();
    mkdirSync(join(dir, "sub"));
    process.env.GIT_DIR = join(tmp, "nowhere");
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.bare";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    expect(repoRoot(join(dir, "sub"))).toBe(realpathSync(dir));
    const outside = join(tmp, "outside");
    mkdirSync(outside);
    expect(repoRoot(outside)).toBeUndefined();
  });
});
