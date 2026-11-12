import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRepoName } from "../src/auth/local-name.js";
import { addRepo, allowRemotePush, findOwnedRepo, getRepo, listAllRepos, removeRepo, setRepoSettings } from "../src/auth/repos.js";
import { createUser, getUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import {
  CONNECT_GITHUB_FIRST, moveProjectToGithub, parseMoveBody, parsePorcelain, pickSignIn, type ProjectMoveOptions,
} from "../src/repos/move-to-github.js";
import { addRepoWatcher, effectiveRepoWatchers, listRepoWatchers } from "../src/repos/watchers.js";
import { MAX_COMMENT_CHARS, moveLockFile } from "../src/stories/move-to-github.js";
import { type FileStory, formatStoryFile, storyFileName } from "../src/stories/story-file.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const story = (n: number, o: Partial<FileStory> = {}): FileStory => ({
  number: n, title: `Story ${n}`, state: "open", kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: `Body ${n}.`, comments: [], ...o,
});
const config = () => ConfigSchema.parse({ protected_branches: [] });
const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let gh: ReturnType<typeof fakeGithub>;
let base: string;
let dir: string;
let empty: string;
let admin: { id: string };
let local: { id: string; url: string };
let src: { id: string };
const folder = () => join(dir, ".scf", "stories");
const put = (s: FileStory) => {
  mkdirSync(folder(), { recursive: true });
  writeFileSync(join(folder(), storyFileName(s.number, s.title)), formatStoryFile(s));
};
const remoteRefs = (remote = empty) => run(remote, "for-each-ref", "--format=%(refname) %(objectname)");
const createdCalls = () => (gh.ghLog().match(/^--- created issue/gm) ?? []).length;
const repoCreates = () => (gh.ghLog().match(/^--- repo create /gm) ?? []).length;
const mv = (o: Partial<ProjectMoveOptions> = {}) =>
  moveProjectToGithub({ localId: local.id, owner: admin.id, config, target: { create: { name: "acme/app", private: true } }, includeClosed: false, dryRun: false, ...o });

const setup = async () => {
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  fakeGit(gh, "https://github.com/acme/app");
  empty = join(gh.tmp, "empty.git");
  run(gh.tmp, "init", "-q", "--bare", "-b", "main", empty);
  process.env.FAKE_GH_REMOTE = empty;
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  base = realpathSync(mkdtempSync(join(tmpdir(), "move-project-")));
  dir = join(base, "my-app");
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  run(dir, "add", "-A");
  // Not the message of the fake remote's own first commit: with the same tree, message, author and second, both would be one commit.
  run(dir, "commit", "-q", "-m", "init of the local project");
  run(dir, "branch", "feature");
  run(dir, "tag", "v1");
  local = addRepo(admin.id, { url: dir, method: "local" }, { ownerOk: () => true });
  src = addRepo(admin.id, { url: "acme/tools", method: "github-token", token: TOKEN });
  addRepoWatcher(local.id, { id: "w1", label: "build-me" }, { local: true });
  addRepoWatcher(local.id, { id: "w2", label: "build-me" }, { local: true });
  setRepoSettings(local.id, { testCommand: "npm test", questions: { decide_technical: false } });
  allowRemotePush(local.id, admin.id);
  put(story(1, { state: "go", body: "Do A." }));
  put(story(2, { body: "Do B." }));
};
const teardown = () => {
  gh.restore();
  rmSync(base, { recursive: true, force: true });
};

describe("parseMoveBody", () => {
  it("takes a name to create (private by default) or the id of a record", () => {
    expect(parseMoveBody({ target: { create: { name: "app" } } })).toEqual({ target: { create: { name: "app", private: true } }, includeClosed: false, dryRun: false });
    expect(parseMoveBody({ target: { create: { name: "acme/app", private: false } }, includeClosed: true, dryRun: true }))
      .toEqual({ target: { create: { name: "acme/app", private: false } }, includeClosed: true, dryRun: true });
    expect(parseMoveBody({ target: { repoId: "abc" } }).target).toEqual({ repoId: "abc" });
  });
  it("refuses everything else with bad-input", () => {
    const bads: unknown[] = [
      null, [], {}, { target: {} }, { target: { create: { name: "a" }, repoId: "x" } }, { target: { repoId: "" } }, { target: { repoId: 5 } },
      { target: { create: { name: "" } } }, { target: { create: { name: "../x" } } }, { target: { create: { name: "a/b/c" } } }, { target: { create: { name: "a/.." } } },
      { target: { create: { name: "x.git" } } }, { target: { create: { name: "a b" } } }, { target: { create: { name: 5 } } }, { target: { create: { name: "a", private: "yes" } } },
      { target: { create: { name: "a", extra: 1 } } }, { target: { create: { name: "a" } }, dryRun: "true" }, { target: { create: { name: "a" } }, includeClosed: 1 },
      { target: { create: { name: "a" } }, force: true }, { target: { create: { name: "a" }, other: 1 } },
    ];
    for (const b of bads) expect(() => parseMoveBody(b), JSON.stringify(b)).toThrow(expect.objectContaining({ code: "bad-input" }));
  });
});

describe("pickSignIn", () => {
  beforeEach(setup);
  afterEach(teardown);
  it("prefers the owner part, skips every method but github-token, and is undefined without one", () => {
    addRepo(admin.id, { url: "acme/plain", method: "none" });
    addRepo(admin.id, { url: "https://github.com/acme/https", method: "https-token", username: "u", token: TOKEN });
    const beta = addRepo(admin.id, { url: "beta/b", method: "github-token", token: TOKEN });
    expect(pickSignIn(admin.id, "BETA")?.id).toBe(beta.id);
    expect(pickSignIn(admin.id, "acme")?.id).toBe(src.id);
    expect(pickSignIn(admin.id, "zzz")?.id).toBe(src.id);
    expect(pickSignIn(admin.id)?.id).toBe(src.id);
    removeRepo(admin.id, src.id);
    removeRepo(admin.id, beta.id);
    expect(pickSignIn(admin.id, "acme")).toBeUndefined();
  });
});

describe("parsePorcelain", () => {
  it("reads new, up to date, fast-forward and rejected lines", () => {
    const out = "To https://github.com/acme/app\n*\trefs/heads/a:refs/heads/a\t[new branch]\n=\trefs/heads/b:refs/heads/b\t[up to date]\n \trefs/heads/c:refs/heads/c\t1..2\n!\trefs/heads/d:refs/heads/d\t[rejected] (fetch first)\nDone\n";
    expect(parsePorcelain(out)).toEqual([
      { flag: "*", ref: "refs/heads/a", summary: "[new branch]" }, { flag: "=", ref: "refs/heads/b", summary: "[up to date]" },
      { flag: " ", ref: "refs/heads/c", summary: "1..2" }, { flag: "!", ref: "refs/heads/d", summary: "[rejected] (fetch first)" },
    ]);
  });
});

describe("moveProjectToGithub", () => {
  beforeEach(setup);
  afterEach(teardown);
  it("a dry run lists what would happen and writes nothing", async () => {
    const files = readdirSync(folder()).sort();
    const records = listAllRepos().length;
    const r = await mv({ dryRun: true });
    expect(r).toMatchObject({ dryRun: true, repository: "create", github: "acme/app" });
    expect(r.refs.map((x) => x.ref).sort()).toEqual(["refs/heads/feature", "refs/heads/main", "refs/tags/v1"]);
    expect(r.stories.plan.map((p) => p.number)).toEqual([1, 2]);
    expect(gh.ghLog()).not.toContain("repo create");
    expect(listAllRepos()).toHaveLength(records);
    expect(remoteRefs()).toBe("");
    expect(readdirSync(folder()).sort()).toEqual(files);
    expect(createdCalls()).toBe(0);

    process.env.FAKE_GH_REPO_EXISTS = "1";
    expect(await mv({ dryRun: true })).toMatchObject({ repository: "exists" });
    expect(listAllRepos()).toHaveLength(records);
    delete process.env.FAKE_GH_REPO_EXISTS;

    process.env.FAKE_GH_VIEW_ERROR = "1";
    await expect(mv({ dryRun: true })).rejects.toMatchObject({ code: "github" });
  });

  it("moves everything: the repository, the refs, the stories, the watchers and the settings", async () => {
    const added: string[] = [];
    const r = await mv({ onAdded: (p) => added.push(p.id) });
    expect(gh.ghLog()).toContain("--- repo create acme/app --private");
    const rec = findOwnedRepo(admin.id, "acme/app")!;
    expect(rec).toMatchObject({ method: "github-token", url: "https://github.com/acme/app" });
    expect(added).toEqual([rec.id]);
    expect(r).toMatchObject({ repository: "created", github: "acme/app", repoId: rec.id });
    const refs = new Map(remoteRefs().split("\n").map((l) => l.split(" ") as [string, string]));
    for (const ref of ["refs/heads/main", "refs/heads/feature", "refs/tags/v1", "refs/heads/scf/stories"]) expect(refs.get(ref), ref).toBe(run(dir, "rev-parse", ref));
    expect(run(dir, "log", "--format=%s", "scf/stories")).toContain("moved");
    expect(createdCalls()).toBe(2);
    expect(gh.bugIssues()[0]!.labels.map((l) => l.name)).toContain("build-me");
    // the watchers run on the new record and find the moved stories by the same label
    const stored = listRepoWatchers();
    expect(stored.map((w) => [w.id, w.repoId, w.label])).toEqual([["w1", rec.id, "build-me"], ["w2", rec.id, "build-me"]]);
    const eff = effectiveRepoWatchers(stored, (id) => getRepo(id), (id) => getUser(id));
    expect(eff.blocked).toEqual([]);
    expect(eff.runnable.map((w) => [w.id, w.label, w.github_repo])).toEqual([["w1", "build-me", "acme/app"], ["w2", "build-me", "acme/app"]]);
    expect(getRepo(rec.id)!.settings).toEqual({ testCommand: "npm test", questions: { decide_technical: false } });
    expect(r.switched).toMatchObject({ watchers: ["w1", "w2"], settings: "merged", kept: [], removed: local.id });
    expect(getRepo(local.id)).toBeUndefined();
    expect(existsSync(folder())).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TOKEN);

    // a repeat after the full move is not found and calls neither gh nor git
    const log = gh.ghLog();
    const before = remoteRefs();
    await expect(mv()).rejects.toMatchObject({ code: "not-found", message: "no such local project" });
    expect(gh.ghLog()).toBe(log);
    expect(remoteRefs()).toBe(before);
  });

  it("a refused push stops before the stories and the switch; after the cause is fixed a second run finishes", async () => {
    process.env.FAKE_GH_REMOTE = gh.remote; // has its own main
    const err = await mv().catch((e: Error) => e);
    expect(err).toMatchObject({ code: "push-failed" });
    expect((err as Error).message).toContain("refs/heads/main");
    expect((err as Error).message).not.toContain(TOKEN);
    expect(createdCalls()).toBe(0);
    expect(listRepoWatchers().every((w) => w.repoId === local.id)).toBe(true);
    expect(getRepo(local.id)).toBeDefined();
    expect(repoCreates()).toBe(1);

    process.env.FAKE_GH_REMOTE = empty;
    const r = await mv();
    expect(r.repository).toBe("exists");
    expect(repoCreates()).toBe(1);
    expect(r.switched).toBeDefined();
    expect(getRepo(local.id)).toBeUndefined();
  });

  it("goes on after a stop in the stories step without a second repository or duplicate issues", async () => {
    process.env.FAKE_GH_FAIL_CREATE_AT = "2";
    await expect(mv()).rejects.toThrow();
    expect(getRepo(local.id)).toBeDefined();
    expect(listRepoWatchers().every((w) => w.repoId === local.id)).toBe(true);
    delete process.env.FAKE_GH_FAIL_CREATE_AT;
    const r = await mv();
    expect(r.refs.find((x) => x.ref === "refs/heads/main")?.status).toBe("up-to-date");
    expect(repoCreates()).toBe(1);
    expect(createdCalls()).toBe(2);
    expect(r.switched).toBeDefined();
  });

  it("picks an existing record: nothing is created, its watcher label and its settings win", async () => {
    const rec = addRepo(admin.id, { url: "acme/app", method: "github-token", token: TOKEN });
    addRepoWatcher(rec.id, { id: "t-w", label: "Factory_go" });
    setRepoSettings(rec.id, { testCommand: "make test" });
    const r = await mv({ target: { repoId: rec.id } });
    expect(r).toMatchObject({ repository: "picked", repoId: rec.id });
    expect(repoCreates()).toBe(0);
    expect(gh.bugIssues()[0]!.labels.map((l) => l.name)).toContain("Factory_go");
    expect(listRepoWatchers().filter((w) => w.repoId === rec.id).map((w) => [w.id, w.label]).sort()).toEqual([["t-w", "Factory_go"], ["w1", "Factory_go"], ["w2", "Factory_go"]]);
    expect(getRepo(rec.id)!.settings).toEqual({ testCommand: "make test", questions: { decide_technical: false } });
    expect(r.switched).toMatchObject({ settings: "merged", kept: ["testCommand"] });
  });

  it("refuses a pick that cannot work, before anything is pushed", async () => {
    const other = await createUser({ name: "Other", email: "other@example.com", password: TEST_PASSWORD, role: "admin" });
    const theirs = addRepo(other.id, { url: "acme/theirs", method: "github-token", token: TOKEN });
    const https = addRepo(admin.id, { url: "https://github.com/acme/https", method: "https-token", username: "u", token: TOKEN });
    const plain = addRepo(admin.id, { url: "acme/plain", method: "none" });
    for (const id of [local.id, theirs.id, https.id, plain.id, "no-such-id"]) {
      await expect(mv({ target: { repoId: id } }), id).rejects.toMatchObject({ code: "bad-input" });
    }
    expect(remoteRefs()).toBe("");
    expect(gh.ghLog()).toBe("");
  });

  it("without a GitHub token sign-in it says to connect GitHub first and changes nothing", async () => {
    removeRepo(admin.id, src.id);
    addRepo(admin.id, { url: "acme/host", method: "none" });
    addRepo(admin.id, { url: "https://github.com/acme/https", method: "https-token", username: "u", token: TOKEN });
    await expect(mv()).rejects.toMatchObject({ code: "no-sign-in", message: CONNECT_GITHUB_FIRST });
    expect(gh.ghLog()).toBe("");
    expect(getRepo(local.id)).toBeDefined();
    expect(findOwnedRepo(admin.id, "acme/app")).toBeUndefined();
  });

  it("gives a bare name the login of the sign-in as its owner", async () => {
    process.env.FAKE_GH_LOGIN = "foundry-owner";
    const r = await mv({ target: { create: { name: "app", private: false } }, dryRun: true });
    expect(r).toMatchObject({ github: "foundry-owner/app", repository: "create" });
    expect(gh.ghLog()).toContain("repo view foundry-owner/app");
    expect(gh.ghLog()).not.toContain("--- repo create");
  });

  it("refuses a project whose stories went to another repository, before anything is created", async () => {
    put(story(3, { githubIssue: 5, githubRepo: "other/x" }));
    await expect(mv()).rejects.toThrow(/already moved to other\/x/);
    expect(gh.ghLog()).not.toContain("repo create");
    expect(findOwnedRepo(admin.id, "acme/app")).toBeUndefined();
  });

  it("does not switch while a story is unreadable, and keeps the local record and its watchers", async () => {
    writeFileSync(join(folder(), "9-broken.md"), "no front matter\n");
    await expect(mv()).rejects.toMatchObject({ code: "stories-skipped" });
    expect((await mv().catch((e: Error) => e)).message).toContain("#9");
    expect(getRepo(local.id)).toBeDefined();
    expect(listRepoWatchers().every((w) => w.repoId === local.id)).toBe(true);
  });

  it("does not switch while a story is too large for one GitHub comment", async () => {
    put(story(7, { comments: [{ author: "a", createdAt: "2026-01-01T00:00:00Z", body: "x".repeat(MAX_COMMENT_CHARS) }] }));
    await expect(mv()).rejects.toMatchObject({ code: "stories-skipped" });
    expect(getRepo(local.id)).toBeDefined();
    expect(listRepoWatchers().every((w) => w.repoId === local.id)).toBe(true);
  });

  it("only one move per folder runs at a time", async () => {
    const lock = moveLockFile(dir, "project");
    writeFileSync(lock, `${process.pid}\n`);
    try {
      await expect(mv()).rejects.toThrow(/already running/);
      expect(gh.ghLog()).toBe("");
    } finally {
      rmSync(lock, { force: true });
    }
  });

  it("refuses a folder that rewrites addresses before any call with a credential", async () => {
    run(dir, "config", "url.https://evil.example/.insteadOf", "https://github.com/");
    await expect(mv()).rejects.toMatchObject({ code: "rewrites" });
    await expect(mv({ dryRun: true })).rejects.toMatchObject({ code: "rewrites" });
    expect(gh.ghLog()).toBe("");
    expect(remoteRefs()).toBe("");
    expect(getRepo(local.id)).toBeDefined();
  });

  it("finishes a project with no stories and no tags, and one with no commits, without an empty push", async () => {
    run(dir, "tag", "-d", "v1");
    run(dir, "branch", "-D", "feature");
    rmSync(join(dir, ".scf"), { recursive: true, force: true });
    const r = await mv();
    expect(r.refs.map((x) => x.ref)).toEqual(["refs/heads/main"]);
    expect(r.stories.created).toEqual([]);
    expect(r.switched).toBeDefined();
    expect(remoteRefs()).toMatch(/^refs\/heads\/main /);

    const bare = join(base, "unborn");
    mkdirSync(bare);
    run(bare, "init", "-q", "-b", "main");
    const rec = addRepo(admin.id, { url: bare, method: "local" }, { ownerOk: () => true });
    expect(localRepoName({ id: rec.id, url: rec.url })).toMatch(/^local:/);
    const u =await mv({ localId: rec.id, target: { create: { name: "acme/app", private: true } } });
    expect(u.refs).toEqual([]);
    expect(u.repository).toBe("exists");
    expect(u.switched).toBeDefined();
    expect(getRepo(rec.id)).toBeUndefined();
  });
});

describe("parseMoveBody and confirm (#796)", () => {
  const token = "A".repeat(43);
  it("takes the token of the check for a real move only", () => {
    expect(parseMoveBody({ target: { repoId: "abc" }, confirm: token }).confirm).toBe(token);
    expect(parseMoveBody({ target: { repoId: "abc" } })).not.toHaveProperty("confirm");
    for (const b of [{ confirm: token, dryRun: true }, { confirm: "short" }, { confirm: 5 }]) {
      expect(() => parseMoveBody({ target: { repoId: "abc" }, ...b }), JSON.stringify(b)).toThrow(expect.objectContaining({ code: "bad-input" }));
    }
  });
});

describe("expectWhat: what the check approved is what goes (#796)", () => {
  beforeEach(setup);
  afterEach(teardown);
  const nothingSent = () => {
    expect(remoteRefs()).toBe("");
    expect(repoCreates()).toBe(0);
    expect(createdCalls()).toBe(0);
    expect(getRepo(local.id)).toBeDefined();
  };

  it("a dry run gives a stable fingerprint, and the real move with it pushes every ref", async () => {
    const a = await mv({ dryRun: true });
    const b = await mv({ dryRun: true });
    expect(a.what).toMatch(/^[0-9a-f]{64}$/);
    expect(b.what).toBe(a.what);
    const r = await mv({ expectWhat: a.what });
    expect(r.switched).toBeDefined();
    const refs = new Map(remoteRefs().split("\n").map((l) => l.split(" ") as [string, string]));
    for (const ref of ["refs/heads/main", "refs/heads/feature", "refs/tags/v1"]) expect(refs.get(ref), ref).toBe(run(dir, "rev-parse", ref));
  });

  it("stops with `changed` and sends nothing for a new branch, a new commit, a moved tag, new story text and another name", async () => {
    const change: [string, () => void][] = [
      ["a new branch", () => run(dir, "branch", "extra")],
      ["a new commit", () => run(dir, "commit", "-q", "--allow-empty", "-m", "more")],
      ["a moved tag", () => run(dir, "tag", "-f", "v1", "feature")],
      ["story text", () => put(story(2, { body: "Do B differently." }))],
    ];
    run(dir, "commit", "-q", "--allow-empty", "-m", "so that the tag can move");
    run(dir, "branch", "-f", "feature");
    for (const [name, edit] of change) {
      const check = await mv({ dryRun: true });
      edit();
      await expect(mv({ expectWhat: check.what }), name).rejects.toMatchObject({ code: "changed" });
      nothingSent();
    }
    const check = await mv({ dryRun: true });
    await expect(mv({ expectWhat: check.what, target: { create: { name: "acme/other", private: true } } })).rejects.toMatchObject({ code: "changed" });
    nothingSent();
  });

  it("pushes the approved object ids", async () => {
    const check = await mv({ dryRun: true });
    const r = await mv({ expectWhat: check.what });
    expect(r.refs.every((x) => x.status === "pushed")).toBe(true);
    expect(remoteRefs().split("\n").find((l) => l.startsWith("refs/heads/main "))).toBe(`refs/heads/main ${run(dir, "rev-parse", "main")}`);
  });
});
