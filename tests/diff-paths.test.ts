import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedPaths, checkoutRoot, ensurePathsBase, runChangedPaths } from "../src/engine/diff.js";
import type { RunSummary } from "../src/engine/state.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "diff-paths-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.x", GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] });
const head = (dir: string) => git(dir, "rev-parse", "HEAD").trim();

function repoWithCommit(name = "repo"): string {
  const dir = join(tmp, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}
const commitAll = (dir: string, msg = "more") => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};

function trap(name: string, marker: string, cat = false): string {
  const p = join(tmp, name);
  writeFileSync(p, `#!/bin/sh\ntouch '${marker}'\n${cat ? "cat\n" : ""}`);
  chmodSync(p, 0o755);
  return p;
}

/** A git program that logs each call (args and the settings that matter) and can be slow. */
function fakeGit(name: string, o: { log?: string; sleep?: boolean; started?: string; lag?: boolean } = {}): string {
  const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const p = join(tmp, name);
  const lines = ["#!/bin/sh"];
  if (o.log) lines.push(`echo "$GIT_NO_LAZY_FETCH|$GIT_ALLOW_PROTOCOL|\${GIT_ALLOW_PROTOCOL+set}|$GIT_OPTIONAL_LOCKS|$*" >> '${o.log}'`);
  if (o.started && !o.lag) lines.push(`touch '${o.started}'`);
  if (o.sleep) lines.push("sleep 30");
  // `lag`: the real git runs at once, "started" is made after it has read, and the call ends a second later
  lines.push(o.lag ? `'${real}' "$@"\nrc=$?\ntouch '${o.started}'\nsleep 1\nexit $rc` : `exec '${real}' "$@"`);
  writeFileSync(p, lines.join("\n") + "\n");
  chmodSync(p, 0o755);
  return p;
}

const summary = (workdir: string, extra: Partial<RunSummary> = {}) => ({ workdir, ...extra }) as RunSummary;
const empty = (workdir: string, extra: Partial<RunSummary> = {}) => summary(workdir, { flowDef: { workspace: "empty" } as RunSummary["flowDef"], pathsTracked: true, ...extra });
const inplace = (workdir: string, extra: Partial<RunSummary> = {}) => summary(workdir, { flowDef: { workspace: "inplace" } as RunSummary["flowDef"], pathsTracked: true, ...extra });

describe("changedPaths", () => {
  it("lists every kind of change once, sorted", async () => {
    const dir = repoWithCommit();
    writeFileSync(join(dir, "b.txt"), "b\n");
    writeFileSync(join(dir, "c.txt"), "c\n");
    writeFileSync(join(dir, "d.txt"), "d\n");
    writeFileSync(join(dir, "e.txt"), "e\n");
    commitAll(dir);
    const base = head(dir);
    writeFileSync(join(dir, "a.txt"), "two\n");
    commitAll(dir);
    writeFileSync(join(dir, "b.txt"), "staged\n");
    git(dir, "add", "b.txt");
    writeFileSync(join(dir, "c.txt"), "unstaged\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    rmSync(join(dir, "d.txt"));
    git(dir, "mv", "e.txt", "f.txt");
    expect(await changedPaths(dir, base)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt", "f.txt", "new.txt"]);
  });

  it("lists a force-added ignored file, not an ignored file that was never staged", async () => {
    const dir = repoWithCommit();
    writeFileSync(join(dir, ".gitignore"), "secret.txt\nother.txt\n");
    commitAll(dir);
    const base = head(dir);
    writeFileSync(join(dir, "secret.txt"), "s\n");
    writeFileSync(join(dir, "other.txt"), "o\n");
    git(dir, "add", "-f", "secret.txt");
    expect(await changedPaths(dir, base)).toEqual(["secret.txt"]);
  });

  it("runs no filter or monitor of the workspace, and leaves the index and objects alone", async () => {
    const dir = repoWithCommit();
    const base = head(dir);
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, ".gitattributes"), "* filter=leak\n");
    const m1 = join(tmp, "m-fsmonitor");
    const m2 = join(tmp, "m-filter");
    git(dir, "config", "core.fsmonitor", trap("fs.sh", m1));
    git(dir, "config", "filter.leak.clean", trap("clean.sh", m2, true));
    const index = join(dir, ".git", "index");
    const before = { bytes: existsSync(index) ? readFileSync(index) : undefined, mtime: existsSync(index) ? statSync(index).mtimeMs : 0, objects: git(dir, "count-objects", "-v") };
    expect(await changedPaths(dir, base)).toEqual([".gitattributes", "a.txt"]);
    expect(existsSync(m1) || existsSync(m2)).toBe(false);
    expect(readFileSync(index).equals(before.bytes!)).toBe(true);
    expect(statSync(index).mtimeMs).toBe(before.mtime);
    expect(git(dir, "count-objects", "-v")).toBe(before.objects);
  });

  it("gives undefined for too many files, an unsafe name and a bad base", async () => {
    const dir = repoWithCommit();
    const base = head(dir);
    for (const n of ["x", "y", "z"]) writeFileSync(join(dir, n), n);
    expect(await changedPaths(dir, base, { maxPaths: 2 })).toBeUndefined();
    rmSync(join(dir, "x"));
    rmSync(join(dir, "y"));
    rmSync(join(dir, "z"));
    writeFileSync(join(dir, "bad\nname"), "x");
    expect(await changedPaths(dir, base)).toBeUndefined();
    rmSync(join(dir, "bad\nname"));
    for (const b of ["--output=x", "HEAD", "0".repeat(40)]) expect(await changedPaths(dir, b)).toBeUndefined();
    expect(existsSync(join(dir, "x"))).toBe(false);
  });

  it("sets the no-fetch settings on every git call", async () => {
    const dir = repoWithCommit();
    const base = head(dir);
    const log = join(tmp, "calls.log");
    writeFileSync(join(dir, "n.txt"), "n");
    expect(await changedPaths(dir, base, { gitBin: fakeGit("counting", { log }) })).toEqual(["n.txt"]);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) {
      expect(l.startsWith("1||set|0|")).toBe(true);
      expect(l).toContain("protocol.allow=never");
    }
  });

  it("gives undefined and leaves no folder when git is too slow", async () => {
    const dir = repoWithCommit();
    const base = head(dir);
    const before = readdirSync(tmpdir()).filter((f) => f.startsWith("factory-paths-")).length;
    expect(await changedPaths(dir, base, { gitBin: fakeGit("slow", { sleep: true }), budgetMs: 300 })).toBeUndefined();
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith("factory-paths-")).length).toBe(before);
  });

  it("follows the cancel signal", async () => {
    const dir = repoWithCommit();
    const base = head(dir);
    const log = join(tmp, "none.log");
    const done = new AbortController();
    done.abort();
    expect(await changedPaths(dir, base, { signal: done.signal, gitBin: fakeGit("never", { log }) })).toBeUndefined();
    expect(existsSync(log)).toBe(false);
    const started = join(tmp, "started");
    const ac = new AbortController();
    const run = changedPaths(dir, base, { signal: ac.signal, gitBin: fakeGit("slow2", { sleep: true, started }) });
    while (!existsSync(started)) await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    expect(await run).toBeUndefined();
  });
});

/** A repository that points at a promisor remote whose "url" would run a command, with one loose object removed. */
function hostile(dir: string, trapFile: string, remove: "commit" | "tree" | "blob") {
  const sh = join(tmp, "evil.sh");
  writeFileSync(sh, `#!/bin/sh\ntouch '${trapFile}'\n`);
  chmodSync(sh, 0o755);
  git(dir, "config", "core.repositoryformatversion", "1");
  git(dir, "config", "extensions.partialClone", "evil");
  git(dir, "config", "remote.evil.promisor", "true");
  git(dir, "config", "remote.evil.url", `ext::${sh}`);
  git(dir, "config", "protocol.ext.allow", "always");
  const oid = remove === "commit" ? head(dir) : remove === "tree" ? git(dir, "rev-parse", "HEAD^{tree}").trim() : git(dir, "rev-parse", "HEAD:a.txt").trim();
  rmSync(join(dir, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  return oid;
}

describe("a hostile promisor repository", () => {
  for (const remove of ["commit", "tree", "blob"] as const) {
    it(`never fetches when the ${remove} is missing, with or without GIT_NO_LAZY_FETCH`, async () => {
      const dir = repoWithCommit();
      const base = head(dir);
      const trapFile = join(tmp, "fetched");
      const oid = hostile(dir, trapFile, remove);
      // control: plain git does try to fetch
      try {
        execFileSync("git", ["cat-file", "-t", oid], { cwd: dir, env: { ...GIT_ENV, GIT_ALLOW_PROTOCOL: "ext" }, stdio: "ignore" });
      } catch {
        // the fetch fails; only the trap file counts
      }
      expect(existsSync(trapFile)).toBe(true);
      rmSync(trapFile);
      const objects = git(dir, "count-objects", "-v");
      const noLazy = join(tmp, "no-lazy");
      writeFileSync(noLazy, `#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nexec git "$@"\n`);
      chmodSync(noLazy, 0o755);
      for (const gitBin of [undefined, noLazy]) {
        if (remove === "commit") {
          const s = empty(dir);
          await ensurePathsBase(s, { gitBin });
          expect(s.pathsBaseSha).toBeUndefined();
          expect(s.pathsBaseLost).toBe(true);
        } else {
          expect(await changedPaths(dir, base, { gitBin })).toBeUndefined();
        }
        expect(existsSync(trapFile)).toBe(false);
        expect(git(dir, "count-objects", "-v")).toBe(objects);
      }
    });
  }
});

describe("checkoutRoot", () => {
  it("finds the root from a subfolder, and lists changes outside the subfolder", async () => {
    const dir = repoWithCommit();
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, "other"));
    const base = head(dir);
    const s = inplace(join(dir, "sub"), { baseSha: base });
    expect((await checkoutRoot(s))?.endsWith("repo")).toBe(true);
    writeFileSync(join(dir, "other", "x.txt"), "x");
    expect(await runChangedPaths(s)).toEqual(["other/x.txt"]);
  });

  it("gives undefined for an empty workspace inside a parent repository", async () => {
    const dir = repoWithCommit();
    mkdirSync(join(dir, "ws"));
    expect(await checkoutRoot(empty(join(dir, "ws")))).toBeUndefined();
  });

  it("gives undefined when core.worktree points at a sibling folder", async () => {
    const dir = repoWithCommit();
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(tmp, "elsewhere"));
    git(dir, "config", "core.worktree", join(tmp, "elsewhere"));
    expect(await checkoutRoot(inplace(join(dir, "sub"), { baseSha: head(dir) }))).toBeUndefined();
  });
});

describe("runChangedPaths and ensurePathsBase", () => {
  it("uses baseSha for tracked in-place runs, never for older runs", async () => {
    const dir = repoWithCommit();
    const base = head(dir);
    writeFileSync(join(dir, "n.txt"), "n");
    expect(await runChangedPaths(inplace(dir, { baseSha: base }))).toEqual(["n.txt"]);
    const log = join(tmp, "old.log");
    expect(await runChangedPaths(inplace(dir, { baseSha: base, pathsTracked: undefined }), { gitBin: fakeGit("old", { log }) })).toBeUndefined();
    expect(existsSync(log)).toBe(false);
  });

  it("reads the empty-workspace base once and never moves it forward", async () => {
    const dir = repoWithCommit();
    const first = head(dir);
    const s = empty(dir, { baseSha: "1".repeat(40) });
    expect(await runChangedPaths(s)).toBeUndefined();
    expect(s.pathsBaseSha).toBe(first);
    writeFileSync(join(dir, "secret.txt"), "s");
    commitAll(dir);
    expect(await runChangedPaths(s)).toEqual(["secret.txt"]);
    expect(s.pathsBaseSha).toBe(first);
  });

  it("loses the base on an unborn HEAD for good", async () => {
    const dir = join(tmp, "unborn");
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    const s = empty(dir);
    await ensurePathsBase(s);
    expect(s.pathsBaseLost).toBe(true);
    writeFileSync(join(dir, "secret.txt"), "s");
    commitAll(dir);
    expect(await runChangedPaths(s)).toBeUndefined();
    expect(s.pathsBaseSha).toBeUndefined();
  });

  it("loses the base when the read times out or is cancelled", async () => {
    const dir = repoWithCommit();
    const slow = empty(dir);
    await ensurePathsBase(slow, { gitBin: fakeGit("slow", { sleep: true }), budgetMs: 300 });
    expect(slow.pathsBaseLost).toBe(true);
    writeFileSync(join(dir, "secret.txt"), "s");
    commitAll(dir);
    expect(await runChangedPaths(slow)).toBeUndefined();
    expect(slow.pathsBaseSha).toBeUndefined();
    const ac = new AbortController();
    ac.abort();
    const gone = empty(dir);
    await ensurePathsBase(gone, { signal: ac.signal });
    expect(gone.pathsBaseLost).toBe(true);
  });

  it("reads no base without pathsTracked", async () => {
    const dir = repoWithCommit();
    const s = empty(dir, { pathsTracked: undefined });
    await ensurePathsBase(s);
    expect(s.pathsBaseSha).toBeUndefined();
    expect(s.pathsBaseLost).toBeUndefined();
  });

  it("two calls together read the base once, to the first HEAD", async () => {
    const dir = repoWithCommit();
    const first = head(dir);
    const s = empty(dir);
    const log = join(tmp, "base.log");
    const started = join(tmp, "base-started");
    const bin = fakeGit("counting", { log, started, lag: true });
    const a = runChangedPaths(s, { gitBin: bin });
    const b = runChangedPaths(s, { gitBin: bin });
    // the first read has run (and is slow to end): the commit comes after it
    while (!existsSync(started)) await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(dir, "x.txt"), "x");
    commitAll(dir);
    expect(await Promise.all([a, b])).toEqual([undefined, undefined]);
    expect(s.pathsBaseSha).toBe(first);
    expect(readFileSync(log, "utf8").trim().split("\n").length).toBe(1);
  });
});
