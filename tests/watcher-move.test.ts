import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REPO_LIMIT, addRepo, listAllRepos, reposPath } from "../src/auth/repos.js";
import { createUser, type User } from "../src/auth/users.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { moveConfigWatchers } from "../src/repos/migrate-watchers.js";
import { addRepoWatcher, effectiveRepoWatchers, listRepoWatchers, repoWatchersPath } from "../src/repos/watchers.js";
import { getRepo } from "../src/auth/repos.js";
import { getUser } from "../src/auth/users.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let kg: FakeKeygen;
let logs: string[];
let admin: User;
const NOW = () => new Date("2026-03-04T05:06:07.000Z");
const cfgPath = () => join(home, "config.yaml");
const text = (p: string) => readFileSync(p, "utf8");
const run = (o: { path?: string; now?: () => Date } = {}) => moveConfigWatchers({ log: (m) => void logs.push(m), now: NOW, ...o });
const backups = () => readdirSync(home).filter((f) => f.startsWith("config.yaml.before-watcher-move-")).sort();
const TWO = "# my comment\nconcurrency: 3\nwatchers:\n  - id: a\n    github_repo: acme/app\n    every: 10m\n  - id: b\n    github_repo: acme/web\n    enabled: false\n  - id: mon\n    source: monitor\n";
const write = (yaml: string) => writeFileSync(cfgPath(), yaml);
const addByHand = (id: string) => {
  const cfg = loadConfig(cfgPath());
  saveConfig({ ...cfg, watchers: [...cfg.watchers, { id, github_repo: `acme/${id}` }] });
};
const user = (email: string, role: "admin" | "user" = "user") => createUser({ name: email.split("@")[0]!, email, password: "test-password-12345", role });

beforeEach(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "watcher-move-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  kg = fakeKeygen();
  logs = [];
  admin = await user("admin@example.com", "admin");
});
afterEach(() => {
  kc.remove();
  kg.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("moving the watchers of config.yaml", () => {
  it("does nothing without an admin account", async () => {
    rmSync(join(home, "users.json"));
    write(TWO);
    const r = run();
    expect(r).toMatchObject({ moved: [], dropped: [], changed: false });
    expect(text(cfgPath())).toBe(TWO);
    expect(backups()).toEqual([]);
    expect(logs).toEqual(["2 watchers stay in config.yaml until there is an admin account"]);
  });

  it("does nothing without a file or without watchers; the monitor stays", () => {
    expect(run().changed).toBe(false);
    write("watchers:\n  - id: mon\n    source: monitor\n");
    expect(run().changed).toBe(false);
    expect(logs).toEqual([]);
  });

  it("moves watchers to repositories of the first admin, keeps the rest of the file and a backup", () => {
    write(TWO);
    const r = run();
    expect(r).toMatchObject({ moved: ["a", "b"], dropped: [], left: [], changed: true, backup: "config.yaml.before-watcher-move-20260304-050607" });
    const stored = listRepoWatchers();
    expect(stored.map((w) => [w.id, w.enabled, w.every])).toEqual([["a", true, "10m"], ["b", false, "5m"]]);
    const repos = listAllRepos();
    expect(repos.map((x) => [x.url, x.method, x.owner])).toEqual([
      ["https://github.com/acme/app", "none", admin.id],
      ["https://github.com/acme/web", "none", admin.id],
    ]);
    expect(stored.every((w) => !("owner" in w) && !("github_repo" in w))).toBe(true);
    const cfg = loadConfig(cfgPath());
    expect(cfg.watchers.map((w) => w.id)).toEqual(["mon"]);
    expect(cfg.concurrency).toBe(3);
    expect(text(join(home, r.backup!))).toBe(TWO);
    for (const id of ["a", "b"]) expect(logs.some((l) => l.includes(`watcher "${id}" moved to acme/`))).toBe(true);
    expect(logs.some((l) => l.includes(r.backup!))).toBe(true);
    expect(readdirSync(home).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("a second start changes nothing", () => {
    write(TWO);
    run();
    const [store, repos] = [text(repoWatchersPath()), text(reposPath())];
    logs = [];
    const r = run();
    expect(r).toMatchObject({ moved: [], dropped: [], changed: false });
    expect([text(repoWatchersPath()), text(reposPath())]).toEqual([store, repos]);
    expect(backups()).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("keeps the owner and the method of a repository a user connected, and attaches the watcher", async () => {
    const ann = await user("ann@example.com");
    const rec = addRepo(ann.id, { url: "acme/app", method: "github-token", token: "github_pat_" + fakeToken("Ab1").slice(4) });
    write(TWO);
    run();
    expect(listAllRepos().filter((x) => x.url.endsWith("acme/app"))).toHaveLength(1);
    expect(getRepo(rec.id)).toMatchObject({ owner: ann.id, method: "github-token" });
    const { runnable } = effectiveRepoWatchers(listRepoWatchers(), getRepo, getUser);
    expect(runnable.find((w) => w.id === "a")).toMatchObject({ repoId: rec.id, ownerId: ann.id });
  });

  it("finds a repository connected in ssh form or in another case", async () => {
    addRepo(admin.id, { url: "git@github.com:Acme/App.git", method: "none" });
    write("watchers:\n  - id: a\n    github_repo: acme/app\n");
    run();
    expect(listAllRepos()).toHaveLength(1);
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["a"]);
  });

  it("moves a watcher of a deploy-key repository disabled, and says why", async () => {
    addRepo(admin.id, { url: "git@github.com:acme/app.git", method: "ssh-deploy-key" });
    write(TWO);
    run();
    const w = listRepoWatchers().find((x) => x.id === "a")!;
    expect(w.enabled).toBe(false);
    expect(logs.some((l) => l.startsWith('watcher "a" moved to acme/app and disabled: ') && l.includes("cannot call the GitHub API"))).toBe(true);
    const { blocked } = effectiveRepoWatchers(listRepoWatchers(), getRepo, getUser);
    expect(blocked.find((b) => b.id === "a")?.problem).toMatch(/cannot call the GitHub API/);
  });

  it("disables a watcher on a none repository owned by a non-admin", async () => {
    const ann = await user("ann@example.com");
    addRepo(ann.id, { url: "acme/app" });
    write(TWO);
    run();
    expect(listRepoWatchers().find((x) => x.id === "a")?.enabled).toBe(false);
    expect(logs.some((l) => l.includes('watcher "a" moved to acme/app and disabled: ') && l.includes("admin"))).toBe(true);
  });

  it("finishes a half-done move without duplicates", () => {
    const rec = addRepo(admin.id, { url: "https://github.com/acme/app" });
    addRepoWatcher(rec.id, { id: "a", every: "10m" });
    write(TWO);
    const r = run();
    expect(r.dropped).toEqual(["a"]);
    expect(r.moved).toEqual(["b"]);
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["a", "b"]);
    expect(listAllRepos()).toHaveLength(2);
    expect(loadConfig(cfgPath()).watchers.map((w) => w.id)).toEqual(["mon"]);
    expect(logs.some((l) => l.includes('watcher "a": already moved'))).toBe(true);
  });

  it("a crash window: the half-done move still says why a watcher is disabled and that its owner differed", async () => {
    await user("ann@example.com");
    write("watchers:\n  - id: a\n    github_repo: acme/app\n    owner: ann@example.com\n");
    const rec = addRepo(admin.id, { url: "git@github.com:acme/app.git", method: "ssh-deploy-key" });
    addRepoWatcher(rec.id, { id: "a", enabled: false });
    const r = run();
    expect(r.dropped).toEqual(["a"]);
    expect(logs.some((l) => l.startsWith('watcher "a": already moved') && l.includes("cannot call the GitHub API"))).toBe(true);
    expect(logs.some((l) => l.includes('watcher "a": its owner option named another account'))).toBe(true);
  });

  it("does not take a stored watcher with other options for the file's watcher", () => {
    const rec = addRepo(admin.id, { url: "https://github.com/acme/app" });
    addRepoWatcher(rec.id, { id: "a", every: "1h" }); // a hand-made watcher with the same id
    write(TWO);
    const r = run();
    expect(r.dropped).toEqual([]);
    expect(r.left.map((l) => l.id)).toEqual(["a"]);
    expect(loadConfig(cfgPath()).watchers.map((w) => w.id)).toEqual(["a", "mon"]);
    expect(listRepoWatchers().find((w) => w.id === "a")?.every).toBe("1h");
    // and the next start decides the same
    expect(run().left.map((l) => l.id)).toEqual(["a"]);
  });

  it("a connection made without a watcher stored does not make a second record", () => {
    addRepo(admin.id, { url: "https://github.com/acme/app" });
    write(TWO);
    run();
    expect(listAllRepos().filter((x) => x.url.endsWith("acme/app"))).toHaveLength(1);
  });

  it("moves a watcher added by hand later, with a second backup", () => {
    write(TWO);
    run();
    addByHand("c");
    const r = run();
    expect(r.moved).toEqual(["c"]);
    expect(backups()).toHaveLength(2);
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  it("a second backup in the same second gets another name", () => {
    write(TWO);
    const first = run();
    addByHand("c");
    const second = run();
    expect(second.backup).toBe(`${first.backup}-2`);
  });

  it("drops the owner option; says so only when it named another account", async () => {
    await user("ann@example.com");
    write(
      "watchers:\n  - id: a\n    github_repo: acme/a\n    owner: admin@example.com\n  - id: b\n    github_repo: acme/b\n    owner: ann@example.com\n  - id: c\n    github_repo: acme/c\n    owner: gone@example.com\n",
    );
    run();
    const said = (id: string) => logs.some((l) => l.includes(`watcher "${id}": its owner option named another account`));
    expect([said("a"), said("b"), said("c")]).toEqual([false, true, true]);
    expect(logs.join("\n")).not.toContain("@example.com");
    expect(text(repoWatchersPath())).not.toContain('"owner"');
  });

  it("leaves a watcher on a new repository when the first admin has the limit, but moves one on a connected repository", () => {
    for (let i = 0; i < REPO_LIMIT - 1; i++) addRepo(admin.id, { url: `acme/r${i}` });
    addRepo(admin.id, { url: "acme/app" });
    write(TWO);
    const r = run();
    expect(r.moved).toEqual(["a"]);
    expect(r.left).toEqual([{ id: "b", reason: `the first admin has ${REPO_LIMIT} repositories already` }]);
    expect(logs).toContain(`! watcher "b" stays in config.yaml: the first admin has ${REPO_LIMIT} repositories already`);
    expect(loadConfig(cfgPath()).watchers.map((w) => w.id)).toEqual(["b", "mon"]);
  });

  it("leaves a watcher whose id is used by another repository in the store", () => {
    const rec = addRepo(admin.id, { url: "https://github.com/acme/other" });
    addRepoWatcher(rec.id, { id: "a" });
    write(TWO);
    const r = run();
    expect(r.left.map((l) => l.id)).toEqual(["a"]);
    expect(r.moved).toEqual(["b"]);
    expect(listAllRepos().map((x) => x.url)).not.toContain("https://github.com/acme/app");
  });

  it("leaves every watcher of an id the file uses twice", () => {
    write("watchers:\n  - id: a\n    github_repo: acme/a\n  - id: a\n    github_repo: acme/b\n  - id: c\n    github_repo: acme/c\n");
    const r = run();
    expect(r.moved).toEqual(["c"]);
    expect(r.left.map((l) => l.id)).toEqual(["a", "a"]);
    expect(loadConfig(cfgPath()).watchers.map((w) => w.github_repo)).toEqual(["acme/a", "acme/b"]);
    // the same on the next start: nothing is dropped by mistake
    expect(run().changed).toBe(false);
    expect(loadConfig(cfgPath()).watchers).toHaveLength(2);
  });

  it("keeps the spelling of a mixed-case name, and stores nothing for a lower-case one", () => {
    write("watchers:\n  - id: a\n    github_repo: Acme/App\n  - id: b\n    github_repo: acme/web\n");
    run();
    const stored = listRepoWatchers();
    expect(stored.find((w) => w.id === "a")?.repoName).toBe("Acme/App");
    expect(stored.find((w) => w.id === "b")).not.toHaveProperty("repoName");
    const { runnable } = effectiveRepoWatchers(stored, getRepo, getUser);
    expect(runnable.find((w) => w.id === "a")?.github_repo).toBe("Acme/App");
    expect(runnable.find((w) => w.id === "b")?.github_repo).toBe("acme/web");
    expect(runnable.every((w) => !("repoName" in w))).toBe(true);
    // the second start sees the same watcher as moved
    expect(run().changed).toBe(false);
  });

  it("changes nothing when the store cannot be read", () => {
    writeFileSync(repoWatchersPath(), "not json");
    write(TWO);
    const r = run();
    expect(r).toMatchObject({ moved: [], changed: false });
    expect(text(cfgPath())).toBe(TWO);
    expect(logs).toEqual(["! watchers stay in config.yaml: repo-watchers.json not-json"]);
  });

  it("leaves the file as it was when it cannot be replaced, and the next start finishes", () => {
    const dir = join(home, "cfg");
    mkdirSync(dir);
    const path = join(dir, "config.yaml");
    writeFileSync(path, TWO);
    chmodSync(dir, 0o500); // no backup and no temporary file can be written
    try {
      const r = run({ path });
      expect(r.changed).toBe(false);
      expect(r.backup).toBeUndefined();
      expect(text(path)).toBe(TWO);
      expect(logs).toContain("! config.yaml was not changed: the backup could not be written");
    } finally {
      chmodSync(dir, 0o700);
    }
    // the store has the watchers: the next start only removes the copies in the file
    const again = run({ path });
    expect(again).toMatchObject({ moved: [], dropped: ["a", "b"], changed: true });
    expect(loadConfig(path).watchers.map((w) => w.id)).toEqual(["mon"]);
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("keeps a file that does not load, without throwing", () => {
    write("watchers: [");
    expect(run().changed).toBe(false);
    expect(text(cfgPath())).toBe("watchers: [");
  });
});
