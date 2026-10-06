import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withAuthLock } from "../src/auth/store.js";
import {
  OWNER_BLOCKED, addRepoWatcher, configIdProblem, effectiveRepoWatchers, listRepoWatchers, removeOrphanWatchers, removeRepoWatcher, removeWatchersOfRepos, removeWatchersOfReposLocked, repoWatchersPath, updateRepoWatcher, watcherRepoProblem,
} from "../src/repos/watchers.js";

let home: string;
let saved: string | undefined;
const repo = randomUUID();
const other = randomUUID();
const file = () => JSON.parse(readFileSync(repoWatchersPath(), "utf8"));
const refused = (fn: () => unknown, code: string) => expect(fn).toThrow(expect.objectContaining({ name: "RepoWatcherError", code }));

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repo-watchers-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("the store", () => {
  it("adds a watcher with the defaults filled, in a file only the owner can read", () => {
    const w = addRepoWatcher(repo, { id: "w1" });
    expect(w).toMatchObject({ repoId: repo, id: "w1", enabled: true, source: "issues", label: "claude-factory", every: "5m" });
    expect(listRepoWatchers()).toEqual([w]);
    expect(file()).toMatchObject({ version: 1, watchers: [{ repoId: repo, id: "w1" }] });
    expect(statSync(repoWatchersPath()).mode & 0o777).toBe(0o600);
  });

  it("refuses bad options with a sentence", () => {
    for (const bad of [{ id: "w", source: "monitor" }, { id: "w", github_repo: "a/b" }, { id: "w", owner: "a@b.io" }, { id: "w", nope: 1 }, { id: "bad id" }, { id: "w", source: "schedule" }, { id: "w", timezone: "Mars/Base" }]) {
      refused(() => addRepoWatcher(repo, bad), "bad-watcher");
    }
    expect(() => addRepoWatcher(repo, "x")).toThrow(/object/);
  });

  it("keeps ids unique on the install", () => {
    addRepoWatcher(repo, { id: "w1" });
    refused(() => addRepoWatcher(repo, { id: "w1" }), "duplicate");
    refused(() => addRepoWatcher(other, { id: "w1" }), "duplicate");
    refused(() => addRepoWatcher(other, { id: "in-config" }, { taken: ["in-config"] }), "duplicate");
  });

  it("updates: keeps the rest, removes with null, refuses a new id and a wrong repository", () => {
    addRepoWatcher(repo, { id: "w1", task: "x", every: "10m" });
    expect(updateRepoWatcher(repo, "w1", { enabled: false })).toMatchObject({ changed: ["enabled"], watcher: { enabled: false, every: "10m", task: "x" } });
    expect(updateRepoWatcher(repo, "w1", { task: null }).watcher).not.toHaveProperty("task");
    expect(updateRepoWatcher(repo, "w1", { every: "10m" }).changed).toEqual([]);
    refused(() => updateRepoWatcher(repo, "w1", { id: "w2" }), "bad-watcher");
    refused(() => updateRepoWatcher(repo, "nope", {}), "not-found");
    refused(() => updateRepoWatcher(other, "w1", {}), "not-found");
    refused(() => updateRepoWatcher(repo, "w1", { source: "schedule", task: null }), "bad-watcher");
  });

  it("removes one watcher, and the watchers of repositories", () => {
    addRepoWatcher(repo, { id: "a" });
    addRepoWatcher(repo, { id: "b" });
    addRepoWatcher(other, { id: "c" });
    removeRepoWatcher(repo, "a");
    refused(() => removeRepoWatcher(repo, "a"), "not-found");
    const before = statSync(repoWatchersPath()).mtimeMs;
    expect(removeWatchersOfRepos([randomUUID()])).toEqual([]);
    expect(statSync(repoWatchersPath()).mtimeMs).toBe(before);
    expect(removeWatchersOfRepos([repo]).map((w) => w.id)).toEqual(["b"]);
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["c"]);
  });

  it("throws a StoreError for a broken file and for a file that cannot be written", () => {
    writeFileSync(repoWatchersPath(), "not json");
    expect(() => listRepoWatchers()).toThrow(expect.objectContaining({ kind: "not-json" }));
    writeFileSync(repoWatchersPath(), JSON.stringify({ version: 1, watchers: [{ repoId: repo, id: "w", source: "monitor" }] }));
    expect(() => listRepoWatchers()).toThrow(expect.objectContaining({ kind: "wrong-format" }));
    rmSync(repoWatchersPath());
    mkdirSync(`${repoWatchersPath()}.tmp`);
    expect(() => addRepoWatcher(repo, { id: "w" })).toThrow(expect.objectContaining({ kind: "cannot-write" }));
  });
});

describe("watcherRepoProblem", () => {
  const rec = (method: string, url = "https://github.com/acme/app") => ({ url, method, owner: "o" });
  const admin = { email: "a@b.io", role: "admin", status: "active" };
  const user = { email: "u@b.io", role: "user", status: "active" };
  it("allows none (admin owner), github-token and github-app", () => {
    expect(watcherRepoProblem(rec("none"), admin)).toBeUndefined();
    expect(watcherRepoProblem(rec("github-token"), user)).toBeUndefined();
    expect(watcherRepoProblem(rec("github-app"), user)).toBeUndefined();
  });
  it("refuses the others with a sentence", () => {
    expect(watcherRepoProblem(rec("none"), user)).toMatch(/admin/);
    expect(watcherRepoProblem(rec("ssh-deploy-key"), admin)).toMatch(/cannot call the GitHub API/);
    expect(watcherRepoProblem(rec("https-token"), admin)).toMatch(/cannot call the GitHub API/);
    expect(watcherRepoProblem(rec("github-token", "https://gitlab.com/acme/app"), admin)).toMatch(/GitHub repository/);
    expect(watcherRepoProblem(rec("github-token"), undefined)).toMatch(/owner/);
  });
});

describe("effectiveRepoWatchers", () => {
  it("makes runnable watchers with the owner and blocks the rest, each in one list", () => {
    const third = randomUUID();
    const ann = { id: randomUUID(), email: "ann@example.com", role: "user", status: "active" };
    const blocked = { id: randomUUID(), email: "bob@example.com", role: "user", status: "blocked" };
    const repos = new Map<string, { id: string; url: string; method: string; owner: string }>([
      [repo, { id: repo, url: "https://github.com/Acme/App", method: "github-token", owner: ann.id }],
      [other, { id: other, url: "https://github.com/acme/web", method: "https-token", owner: ann.id }],
      [third, { id: third, url: "https://github.com/acme/b", method: "github-token", owner: blocked.id }],
    ]);
    const users = new Map<string, typeof ann>([ann, blocked].map((u) => [u.id, u]));
    const stored = [
      addRepoWatcher(repo, { id: "ok", enabled: false }),
      addRepoWatcher(other, { id: "https" }),
      addRepoWatcher(third, { id: "blocked-owner" }),
      addRepoWatcher(randomUUID(), { id: "orphan" }),
    ];
    const r = effectiveRepoWatchers(stored, (id) => repos.get(id), (id) => users.get(id));
    expect(r.runnable).toHaveLength(1);
    expect(r.runnable[0]).toMatchObject({ id: "ok", github_repo: "acme/app", owner: "ann@example.com", ownerId: ann.id, repoId: repo, enabled: false });
    expect(r.blocked.map((b) => b.id)).toEqual(["https", "blocked-owner", "orphan"]);
    expect(r.blocked.every((b) => b.problem.length > 0)).toBe(true);
    expect(r.blocked[2]!.problem).toMatch(/not connected any more/);
  });
});

describe("duplicate ids", () => {
  it("blocks a stored watcher whose id config.yaml uses, and refuses a store file with a repeated id", () => {
    const ann = { id: randomUUID(), email: "ann@example.com", role: "user", status: "active" };
    const rec = { id: repo, url: "https://github.com/acme/app", method: "github-token", owner: ann.id };
    const w = addRepoWatcher(repo, { id: "solo" });
    expect(effectiveRepoWatchers([w], () => rec, () => ann).runnable.map((x) => x.id)).toEqual(["solo"]);
    const r = effectiveRepoWatchers([w], () => rec, () => ann, ["solo"]);
    expect(r.runnable).toEqual([]);
    expect(r.blocked[0]!.problem).toMatch(/used by another watcher in config.yaml/);
    writeFileSync(repoWatchersPath(), JSON.stringify({ version: 1, watchers: [{ repoId: repo, id: "d" }, { repoId: other, id: "d" }] }));
    expect(() => listRepoWatchers()).toThrow(expect.objectContaining({ kind: "wrong-format" }));
  });
});

describe("removeWatchersOfReposLocked", () => {
  it("throws outside the lock, removes and returns the watchers inside it, and undo puts them back", () => {
    addRepoWatcher(repo, { id: "a" });
    addRepoWatcher(repo, { id: "b" });
    addRepoWatcher(other, { id: "c" });
    expect(() => removeWatchersOfReposLocked([repo])).toThrow(/inside withAuthLock/);
    const before = listRepoWatchers();
    const r = withAuthLock(() => removeWatchersOfReposLocked([repo]));
    expect(r.gone.map((w) => w.id)).toEqual(["a", "b"]);
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["c"]);
    withAuthLock(() => r.undo());
    expect(listRepoWatchers()).toEqual(before);
  });

  it("writes nothing when nothing matches, and its undo writes nothing either", () => {
    addRepoWatcher(other, { id: "c" });
    const r = withAuthLock(() => removeWatchersOfReposLocked([repo]));
    expect(r.gone).toEqual([]);
    const bytes = readFileSync(repoWatchersPath(), "utf8") + " ";
    writeFileSync(repoWatchersPath(), bytes);
    withAuthLock(() => r.undo());
    expect(readFileSync(repoWatchersPath(), "utf8")).toBe(bytes);
    expect(withAuthLock(() => removeWatchersOfReposLocked([])).gone).toEqual([]);
  });
});

describe("removeOrphanWatchers", () => {
  it("removes only the watchers whose repository is not in the list", () => {
    addRepoWatcher(repo, { id: "keep" });
    addRepoWatcher(other, { id: "orphan" });
    expect(removeOrphanWatchers(() => [repo]).map((w) => w.id)).toEqual(["orphan"]);
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["keep"]);
  });

  it("writes nothing without a leftover, and does not ask for the repositories of an empty store", () => {
    let asked = 0;
    expect(removeOrphanWatchers(() => (asked++, []))).toEqual([]);
    expect(asked).toBe(0);
    addRepoWatcher(repo, { id: "keep" });
    const touched = readFileSync(repoWatchersPath(), "utf8") + "\n";
    writeFileSync(repoWatchersPath(), touched);
    expect(removeOrphanWatchers(() => [repo])).toEqual([]);
    expect(readFileSync(repoWatchersPath(), "utf8")).toBe(touched);
  });

  it("leaves the file as it is when the list throws, when the write fails and when the file is broken", () => {
    addRepoWatcher(other, { id: "orphan" });
    const bytes = readFileSync(repoWatchersPath(), "utf8");
    expect(() => removeOrphanWatchers(() => { throw new Error("no"); })).toThrow("no");
    expect(readFileSync(repoWatchersPath(), "utf8")).toBe(bytes);
    mkdirSync(repoWatchersPath() + ".tmp");
    expect(() => removeOrphanWatchers(() => [])).toThrow(expect.objectContaining({ kind: "cannot-write" }));
    expect(readFileSync(repoWatchersPath(), "utf8")).toBe(bytes);
    rmSync(repoWatchersPath() + ".tmp", { recursive: true });
    writeFileSync(repoWatchersPath(), "not json");
    expect(() => removeOrphanWatchers(() => [])).toThrow(expect.objectContaining({ name: "StoreError" }));
    expect(readFileSync(repoWatchersPath(), "utf8")).toBe("not json");
  });
});

describe("a blocked owner", () => {
  const owner = () => ({ id: randomUUID(), email: "ann@example.com", role: "user", status: "blocked" });
  const rec = (o: { id: string }, method = "github-token") => ({ id: repo, url: "https://github.com/acme/app", method, owner: o.id });

  it("pauses the watcher, whatever else is wrong with the repository", () => {
    for (const method of ["github-token", "https-token", "none"]) {
      const o = owner();
      const w = addRepoWatcher(repo, { id: `w-${method}` });
      const r = effectiveRepoWatchers([w], () => rec(o, method), () => o);
      expect(r.runnable).toEqual([]);
      expect(r.blocked[0]).toMatchObject({ paused: true, problem: OWNER_BLOCKED, owner: "ann@example.com" });
    }
  });

  it("does not hide a clash with config.yaml, a missing repository or a missing owner", () => {
    const o = owner();
    const w = addRepoWatcher(repo, { id: "w" });
    const clash = effectiveRepoWatchers([w], () => rec(o), () => o, ["w"]).blocked[0]!;
    expect(clash.problem).toMatch(/config.yaml/);
    expect(clash).not.toHaveProperty("paused");
    expect(effectiveRepoWatchers([w], () => undefined, () => o).blocked[0]).not.toHaveProperty("paused");
    expect(effectiveRepoWatchers([w], () => rec(o), () => undefined).blocked[0]).not.toHaveProperty("paused");
  });
});

describe("configIdProblem", () => {
  const ids = (...a: string[]) => a.map((id) => ({ id }));
  it("refuses new duplicates and new collisions, not old ones", () => {
    expect(configIdProblem(ids("x", "x"), ids("x"), [])).toMatch(/twice/);
    expect(configIdProblem(ids("x", "x"), ids("x", "x"), [])).toBeUndefined();
    expect(configIdProblem(ids("s"), ids(), ids("s"))).toMatch(/repository/);
    expect(configIdProblem(ids("y"), ids("x"), ids("y"))).toMatch(/repository/);
    expect(configIdProblem(ids("s"), ids("s"), ids("s"))).toBeUndefined();
  });
});
