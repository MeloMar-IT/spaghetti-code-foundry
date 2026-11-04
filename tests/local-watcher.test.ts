import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The local watcher makes no GitHub call: every helper that would reach `gh` is a spy that fails the test when it is called.
const calls = vi.hoisted(() => ({ gh: [] as string[] }));
vi.mock("../src/github.js", async (orig) => {
  const real = await orig<typeof import("../src/github.js")>();
  const never = (name: string) => vi.fn(async () => { calls.gh.push(name); throw new Error(`${name} must not be called`); });
  return { ...real, gh: never("gh"), ghJson: never("ghJson"), canWrite: never("canWrite"), repoPermission: never("repoPermission"), readRateLimit: never("readRateLimit") };
});

import { addRepo } from "../src/auth/repos.js";
import { localRepoName } from "../src/auth/local-name.js";
import { ConfigSchema, type WatcherConfig } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { watcherRepoAccess } from "../src/queue/watcher-local.js";
import { WatcherManager } from "../src/queue/watchers.js";
import { formatStoryFile, parseStoryFile, type FileStory } from "../src/stories/story-file.js";
import { claudeBin } from "./helpers/fake-github.js";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const story = (n: number, title: string, state: FileStory["state"]): FileStory => ({
  number: n, title, state, kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: "Do it.", comments: [],
});

let base: string;
let dir: string;
let name: string;
let repoId: string;
let savedPath: string | undefined;
let manager: WatcherManager | undefined;
let scheduler: Scheduler | undefined;

/** PATH with every folder that has a `gh` left out, and a folder that keeps `git` reachable. */
function pathWithoutGh(): string {
  const bin = join(base, "bin");
  mkdirSync(bin);
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const gitAt = dirs.map((d) => join(d, "git")).find((p) => existsSync(p));
  if (gitAt) symlinkSync(realpathSync(gitAt), join(bin, "git"));
  return [bin, ...dirs.filter((d) => !existsSync(join(d, "gh")))].join(delimiter);
}
const parsed = (n: number) => {
  const folder = join(dir, ".scf", "stories");
  const name = readdirSync(folder).find((f) => f.startsWith(`${n}-`))!;
  const r = parseStoryFile(readFileSync(join(folder, name), "utf8"), name);
  if (!r.ok) throw new Error(r.reason);
  return r.story;
};
async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 20_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(() => {
  calls.gh.length = 0;
  base = realpathSync(mkdtempSync(join(tmpdir(), "local-watcher-")));
  dir = join(base, "my-app");
  mkdirSync(join(dir, ".scf", "stories"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  writeFileSync(join(dir, ".scf", "stories", "1-build-me.md"), formatStoryFile(story(1, "Build me", "go")));
  writeFileSync(join(dir, ".scf", "stories", "2-later.md"), formatStoryFile(story(2, "Later", "open")));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "stories");
  const rec = addRepo(ADMIN, { url: dir, method: "local" }, { ownerOk: () => true });
  repoId = rec.id;
  name = localRepoName({ id: rec.id, url: rec.url });
  savedPath = process.env.PATH;
  process.env.PATH = pathWithoutGh();
});
afterEach(() => {
  manager?.stopAll(); // the scheduler is drained: its queued runs never start
  manager = scheduler = undefined;
  process.env.PATH = savedPath;
  rmSync(base, { recursive: true, force: true });
});

function config(over: Record<string, unknown> = {}) {
  const cfg = ConfigSchema.parse({
    protected_branches: ["main"],
    watchers: [{ id: "local-w", github_repo: "acme/app", label: "claude-factory", flow: "issue-gitflow", every: "1h", ...over }],
  });
  // a stored watcher is not read through the file schema: it has the local name and the repository id
  cfg.watchers[0] = { ...cfg.watchers[0]!, github_repo: name, repoId, ownerId: ADMIN } as WatcherConfig;
  return cfg;
}
function start(over: Record<string, unknown> = {}) {
  const cfg = config(over);
  scheduler = new Scheduler({ runsDir: join(base, "runs"), config: () => cfg, claudeBin });
  scheduler.drain(); // runs stay queued
  const ghIdentity = vi.fn(() => { throw new Error("no GitHub sign-in for a local project"); });
  manager = new WatcherManager({ scheduler, runsDir: join(base, "runs"), repo: dir, config: () => cfg, log: () => {}, ghIdentity });
  return { cfg, ghIdentity };
}
const status = () => manager!.tracked().find((t) => t.watcher.id === "local-w")?.status;

describe("a watcher of a local repository", () => {
  it("has no gh on PATH in this test", () => {
    expect((spawnSync("gh", ["--version"]).error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
  });

  it("queues the go story, not the open one, and calls nothing on GitHub", async () => {
    const { ghIdentity } = start();
    manager!.sync();
    await until(() => scheduler!.queue().pending.length > 0 || !!status()?.lastError, "the run of #1");
    expect(status()?.lastError).toBeUndefined();
    expect(manager!.tracked()[0]!.watcher.label).toBe("go");
    const pending = scheduler!.queue().pending;
    expect(pending.map((p) => p.issue)).toEqual(["1"]);
    expect(pending[0]!.githubRepo).toBe(name);
    await until(() => parsed(1).labels.includes("factory:working"), "the working label");
    expect(parsed(1).state).toBe("go");
    expect(parsed(2)).toMatchObject({ state: "open", labels: [] });
    expect(ghIdentity).not.toHaveBeenCalled();
    expect(calls.gh).toEqual([]);
  }, 40_000);

  it("refuses a GitHub-only option in the stored config and checks nothing", async () => {
    start({ source: "ci-failures" });
    manager!.sync();
    await until(() => !!status()?.lastError, "the refusal");
    expect(status()!.lastError).toMatch(/no GitHub CI/);
    expect(scheduler!.queue().pending).toEqual([]);
    expect(calls.gh).toEqual([]);
  });

  it("gives no GitHub sign-in to a local watcher", () => {
    const { ghIdentity } = start();
    expect(manager!.identityOf({ repoId, github_repo: name })).toBeUndefined();
    expect(ghIdentity).not.toHaveBeenCalled();
    expect(() => manager!.identityOf({ repoId, github_repo: "acme/app" })).toThrow(/no GitHub sign-in/);
  });
});

describe("the local access of a watcher", () => {
  it("finds a file in the work tree, and not a folder, a missing file or a link out of the folder", async () => {
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "x.txt"), "x");
    symlinkSync("/etc/hosts", join(dir, "link"));
    symlinkSync(join(dir, "config", "x.txt"), join(dir, "inside"));
    const access = watcherRepoAccess(name);
    expect(access.local).toBe(true);
    await expect(access.check()).resolves.toBeUndefined();
    expect(await access.hasFile("config/x.txt", undefined, 1000)).toBe(true);
    expect(await access.hasFile("inside", "develop", 1000)).toBe(true);
    expect(await access.hasFile("config", undefined, 1000)).toBe(false);
    expect(await access.hasFile("config/none.txt", undefined, 1000)).toBe(false);
    expect(await access.hasFile("link", undefined, 1000)).toBe(false);
    expect(await access.hasFile("config/x.txt/deeper", undefined, 1000)).toBe(false);
  });

  it("counts every login as a writer, and says when the folder is gone", async () => {
    const access = watcherRepoAccess(name);
    expect(await access.writer("someone")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    await expect(access.check()).rejects.toThrow(/the folder of local:my-app-[0-9a-f]{8} is not there/);
    await expect(watcherRepoAccess("local:nope-00000000").check()).rejects.toThrow(/is not there/);
  });

  it("keeps the GitHub access for a GitHub name", () => {
    expect(watcherRepoAccess("acme/app").local).toBe(false);
    expect(resolve(".")).toBeTruthy();
  });
});
