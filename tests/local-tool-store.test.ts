import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localRepoEnv } from "../src/engine/repo-access.js";
import { canWrite, repoPermission } from "../src/github.js";
import { openDependencies } from "../src/queue/deps.js";
import { recordWaitsFor } from "../src/queue/waits-for.js";
import { isStoryRepoName, storeFor, storeForTool } from "../src/stories/store.js";
import { STORIES_BRANCH } from "../src/stories/story-commit.js";
import { LocalStore } from "../src/stories/local-store.js";

const NAME = "local:shop-0123abcd";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repoDir(): string {
  const d = mkdtempSync(join(tmpdir(), "scf-tool-store-"));
  dirs.push(d);
  const git = (...a: string[]) => spawnSync("git", a, { cwd: d, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "main");
  writeFileSync(join(d, "a.txt"), "a");
  git("add", ".");
  git("commit", "-q", "-m", "init");
  return d;
}
const throwingGh = () => {
  throw new Error("gh must not be called");
};

describe("isStoryRepoName", () => {
  it("accepts owner/repo and a valid local name only", () => {
    expect(isStoryRepoName("o/r")).toBe(true);
    expect(isStoryRepoName(NAME)).toBe(true);
    expect(isStoryRepoName("local:x")).toBe(false);
    expect(isStoryRepoName("local:Shop-0123abcd")).toBe(false);
    expect(isStoryRepoName("")).toBe(false);
  });
});

describe("storeForTool", () => {
  it("binds a local name to the folder of the environment, and rebinds for another folder", () => {
    const a = repoDir();
    const b = repoDir();
    const s = storeForTool(NAME, { FACTORY_LOCAL_REPO_DIR: a });
    expect(s.repo).toBe(NAME);
    expect(storeForTool(NAME, { FACTORY_LOCAL_REPO_DIR: a })).toBe(s);
    expect(storeFor(NAME)).toBe(s);
    const t = storeForTool(NAME, { FACTORY_LOCAL_REPO_DIR: b });
    expect(t).not.toBe(s);
    expect(storeFor(NAME)).toBe(t);
  });

  it("names the variable when it is missing, relative, not normalised or not a folder", () => {
    expect(() => storeForTool(NAME, {})).toThrow(/FACTORY_LOCAL_REPO_DIR is not set/);
    expect(() => storeForTool(NAME, { FACTORY_LOCAL_REPO_DIR: "rel/path" })).toThrow(/FACTORY_LOCAL_REPO_DIR is not absolute/);
    expect(() => storeForTool(NAME, { FACTORY_LOCAL_REPO_DIR: "/tmp/a/../b" })).toThrow(/FACTORY_LOCAL_REPO_DIR is not normalised/);
    expect(() => storeForTool(NAME, { FACTORY_LOCAL_REPO_DIR: join(tmpdir(), "scf-missing-folder-xyz") })).toThrow(/FACTORY_LOCAL_REPO_DIR is not a folder/);
  });

  it("gives the same store as storeFor for a GitHub name, whatever the environment says", () => {
    expect(storeForTool("o/r", { FACTORY_LOCAL_REPO_DIR: "/nope" })).toBe(storeFor("o/r"));
  });
});

/** Stories #1 to #7, each with an empty Depends on section. */
async function seed(local: LocalStore): Promise<void> {
  for (let n = 1; n <= 7; n++) await local.create({ title: `Story number ${n}`, body: "Text\n\n### Depends on\n", labels: [] });
}

describe("recordWaitsFor on a local store", () => {
  it("records a wait without gh, lists it as open, and releases it when the story is closed", async () => {
    const dir = repoDir();
    const local = new LocalStore(dir, NAME, { branch: STORIES_BRANCH });
    await seed(local);
    storeForTool(NAME, { FACTORY_LOCAL_REPO_DIR: dir });
    const r = recordWaitsFor(throwingGh, NAME, 7, { issues: [6], reason: "" }, []);
    expect(r.problems).toEqual([]);
    const seven = await local.get(7);
    expect(seven?.body).toContain("#6");
    const list = () => local.sync(throwingGh).list(100);
    expect(openDependencies([6], list(), { doneLabels: [] })).toEqual([6]);
    await local.close(6, "completed");
    expect(openDependencies([6], list(), { doneLabels: [] })).toEqual([]);
  });

  it("refuses a cycle and leaves the story as it was", async () => {
    const dir = repoDir();
    const local = new LocalStore(dir, NAME, { branch: STORIES_BRANCH });
    await seed(local);
    storeForTool(NAME, { FACTORY_LOCAL_REPO_DIR: dir });
    expect(recordWaitsFor(throwingGh, NAME, 7, { issues: [6], reason: "" }, []).outcome).not.toBe("problem");
    const r = recordWaitsFor(throwingGh, NAME, 6, { issues: [7], reason: "" }, []);
    expect(r.outcome).toBe("problem");
    expect((await local.get(6))?.body).not.toContain("#7");
  });
});

describe("localRepoEnv", () => {
  const find = (n: string) => (n === NAME ? { url: "/work/shop" } : undefined);
  it("gives the folder of a known local repository only", () => {
    expect(localRepoEnv(NAME, find)).toEqual({ FACTORY_LOCAL_REPO_DIR: "/work/shop" });
    expect(localRepoEnv("o/r", find)).toEqual({});
    expect(localRepoEnv("local:other-0123abcd", find)).toEqual({});
    expect(localRepoEnv(undefined, find)).toEqual({});
    expect(localRepoEnv(NAME, () => { throw new Error("registry"); })).toEqual({});
  });

  it("adds FACTORY_LOCAL_PUSH only when the repository has pushRemote on", () => {
    const on = () => ({ url: "/work/shop", settings: { pushRemote: true } });
    expect(localRepoEnv(NAME, on)).toEqual({ FACTORY_LOCAL_REPO_DIR: "/work/shop", FACTORY_LOCAL_PUSH: "yes" });
    expect(localRepoEnv(NAME, () => ({ url: "/work/shop", settings: {} }))).toEqual({ FACTORY_LOCAL_REPO_DIR: "/work/shop" });
  });
});

describe("repoPermission for a local repository", () => {
  it("is admin and runs no gh", async () => {
    const was = process.env.FACTORY_GH_BIN;
    process.env.FACTORY_GH_BIN = "/nonexistent/gh";
    try {
      expect(await repoPermission(NAME, "anyone")).toBe("admin");
      expect(await canWrite(NAME, "anyone")).toBe(true);
    } finally {
      if (was === undefined) delete process.env.FACTORY_GH_BIN;
      else process.env.FACTORY_GH_BIN = was;
    }
  });
});
