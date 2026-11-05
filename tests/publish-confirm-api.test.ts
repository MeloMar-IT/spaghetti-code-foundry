import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { addRepo, allowRemotePush, findOwnedRepo, getRepo, removeRepo } from "../src/auth/repos.js";
import { PUBLISH_TTL_MS } from "../src/repos/publish-grants.js";
import { MAX_COMMENT_CHARS } from "../src/stories/move-to-github.js";
import { type FileStory, formatStoryFile, storyFileName } from "../src/stories/story-file.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// "Yes, publish" (#796): the server refuses a real move or a turned-on push without the owner's own check.

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const story = (n: number, o: Partial<FileStory> = {}): FileStory => ({
  number: n, title: `Story ${n}`, state: "open", kind: "story", labels: [], dependsOn: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", body: `Body ${n}.`, comments: [], ...o,
});
const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let gh: ReturnType<typeof fakeGithub>;
let base: string;
let close: () => void;
let admin: TestSession;
let other: TestSession;
let work: string;
let dir: string;
let empty: string;
let local: { id: string; url: string };
let n = 0;
let saved: string | undefined;

const folder = () => join(dir, ".scf", "stories");
const put = (s: FileStory) => {
  mkdirSync(folder(), { recursive: true });
  writeFileSync(join(folder(), storyFileName(s.number, s.title)), formatStoryFile(s));
};
const remoteRefs = (remote = empty) => run(remote, "for-each-ref", "--format=%(refname) %(objectname)");
const allCreates = () => (gh.ghLog().match(/^--- repo create /gm) ?? []).length;
let createsBefore = 0;
const repoCreates = () => allCreates() - createsBefore;

const post = async (path: string, body: unknown, who = admin) => {
  const res = await fetch(`${base}/api/${path}`, { method: "POST", headers: who.headers("POST", { "content-type": "application/json" }), body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const put_ = async (path: string, body: unknown, who = admin) => {
  const res = await fetch(`${base}/api/${path}`, { method: "PUT", headers: who.headers("PUT", { "content-type": "application/json" }), body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const TARGET = { create: { name: "acme/app", private: true } };
const mv = (body: Record<string, unknown>, who = admin) => post(`repos/${local.id}/move-to-github`, { target: TARGET, ...body }, who);
const check = async (body: Record<string, unknown> = {}) => {
  const r = await mv({ dryRun: true, ...body });
  expect(r.status).toBe(200);
  return r.json.confirm.token as string;
};
const nothingSent = () => {
  expect(remoteRefs()).toBe("");
  expect(repoCreates()).toBe(0);
  expect(getRepo(local.id)).toBeDefined();
};

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  fakeGit(gh, "https://github.com/acme/app");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  work = realpathSync(mkdtempSync(join(tmpdir(), "publish-confirm-")));
  ({ close, base } = await startTestServer({ repo: work, runsDir: join(work, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} }));
  admin = await signInAs(base);
  other = await signInAs(base, { name: "Other", email: "other@example.com", role: "admin" });
  addRepo(admin.user.id, { url: "acme/tools", method: "github-token", token: TOKEN });
});
afterAll(() => {
  close();
  gh.restore();
  rmSync(work, { recursive: true, force: true });
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
});

beforeEach(() => {
  n += 1;
  createsBefore = allCreates();
  empty = join(gh.tmp, `empty-${n}.git`);
  run(gh.tmp, "init", "-q", "--bare", "-b", "main", empty);
  process.env.FAKE_GH_REMOTE = empty;
  dir = join(work, `my-app-${n}`);
  mkdirSync(dir);
  run(dir, "init", "-q", "-b", "main");
  run(dir, "config", "user.email", "t@example.com");
  run(dir, "config", "user.name", "T");
  writeFileSync(join(dir, "README.md"), "hi\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "init");
  run(dir, "branch", "feature");
  run(dir, "tag", "v1");
  local = addRepo(admin.user.id, { url: dir, method: "local" }, { ownerOk: () => true });
  put(story(1, { state: "go", body: "Do A." }));
  put(story(2, { body: "Do B." }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("move to GitHub needs the owner's check", () => {
  it("refuses a real move without confirm: 409, nothing created, pushed or switched", async () => {
    const r = await mv({});
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/^Nothing was published: /);
    nothingSent();
  });

  it("a check gives a token (and never the internal fingerprint); the real move with it publishes everything, a replay finds no project", async () => {
    const c = await mv({ dryRun: true });
    expect(c.status).toBe(200);
    expect(c.json.confirm).toMatchObject({ token: expect.stringMatching(/^[\w-]{43}$/), expiresAt: expect.any(Number) });
    expect(c.json).not.toHaveProperty("what");
    nothingSent();

    const token = c.json.confirm.token as string;
    const r = await mv({ confirm: token });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).not.toHaveProperty("what");
    const refs = remoteRefs();
    for (const ref of ["refs/heads/main", "refs/heads/feature", "refs/tags/v1"]) expect(refs).toContain(`${ref} ${run(dir, "rev-parse", ref)}`);
    expect(getRepo(local.id)).toBeUndefined();
    expect((await mv({ confirm: token })).status).toBe(404);
    removeRepo(admin.user.id, findOwnedRepo(admin.user.id, "acme/app")!.id);
  });

  it("a used token, an older check, another request and an expired token are each refused with 409 while the record exists", async () => {
    const first = await check();
    const second = await check(); // replaces the first
    expect((await mv({ confirm: first })).status).toBe(409);
    expect((await mv({ confirm: second, includeClosed: true })).status).toBe(409); // another request; the token is burned
    expect((await mv({ confirm: second })).json.error).toMatch(/^Nothing was published: /);

    const third = await check();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + PUBLISH_TTL_MS + 1000);
    const late = await mv({ confirm: third });
    vi.useRealTimers();
    expect(late.status).toBe(409);
    expect((await mv({ confirm: await check(), target: { create: { name: "acme/else", private: true } } })).status).toBe(409);
    nothingSent();
  });

  it("a token for another project or from another account does not work", async () => {
    const token = await check();
    expect((await post(`repos/${local.id}/move-to-github`, { target: TARGET, confirm: token }, other)).status).toBe(404);
    // the token was not burned by the stranger's call (404 comes before it), and still fits its owner
    const again = await mv({ confirm: token, includeClosed: true });
    expect(again.status).toBe(409);
    nothingSent();
  });

  it("stops with 409 'changed' when a branch, a commit, a tag or a story changed after the check, and sends nothing", async () => {
    const edits: [string, () => void][] = [
      ["branch", () => run(dir, "branch", "extra")],
      ["commit", () => run(dir, "commit", "-q", "--allow-empty", "-m", "more")],
      ["story", () => put(story(2, { body: "Do B differently." }))],
    ];
    for (const [name, edit] of edits) {
      const token = await check();
      edit();
      const r = await mv({ confirm: token });
      expect(r.status, name).toBe(409);
      expect(r.json.error, name).toMatch(/changed since the check/);
      nothingSent();
    }
    const token = await check();
    run(dir, "commit", "-q", "--allow-empty", "-m", "for the tag");
    run(dir, "tag", "-f", "v1");
    expect((await mv({ confirm: token })).json.error).toMatch(/changed since the check/);
    nothingSent();
  });

  it("a check with a story that cannot go along gets no token", async () => {
    put(story(7, { comments: [{ author: "a", createdAt: "2026-01-01T00:00:00Z", body: "x".repeat(MAX_COMMENT_CHARS) }] }));
    const r = await mv({ dryRun: true });
    expect(r.status).toBe(200);
    expect(r.json).not.toHaveProperty("confirm");
    nothingSent();
  });

  it("the token is in the answer of the check only, not in the audit log", async () => {
    const token = await check();
    await mv({ confirm: token });
    const audit = (() => {
      try {
        return readFileSync(auditPath(), "utf8");
      } catch {
        return "";
      }
    })();
    expect(audit).not.toContain(token);
  });
});

describe("the plain push to the remote needs Yes, publish", () => {
  const bare = (name: string) => {
    const p = join(gh.tmp, `${name}-${n}.git`);
    run(gh.tmp, "init", "-q", "--bare", "-b", "main", p);
    return p;
  };
  const dry = (body: Record<string, unknown> = {}, who = admin) => post(`repos/${local.id}/publish-remote`, { dryRun: true, ...body }, who);

  it("a project without a remote gets 409", async () => {
    const r = await dry();
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/^Nothing was published: /);
  });

  it("the settings route cannot turn it on (409, stays off), and keeps or turns it off when it is on", async () => {
    const r = await put_(`admin/repos/${local.id}/settings`, { pushRemote: true, testCommand: "npm test" });
    expect(r.status).toBe(409);
    expect(getRepo(local.id)!.settings).toBeUndefined();
    allowRemotePush(local.id, admin.user.id);
    expect((await put_(`admin/repos/${local.id}/settings`, { pushRemote: true, testCommand: "npm test" })).status).toBe(200);
    expect(getRepo(local.id)!.settings).toEqual({ testCommand: "npm test", pushRemote: true });
    expect((await put_(`admin/repos/${local.id}/settings`, { testCommand: "npm test" })).status).toBe(200);
    expect(getRepo(local.id)!.settings).toEqual({ testCommand: "npm test" });
  });

  it("shows both remotes (without sign-in), the branches and the tags; confirm turns the push on and writes an audit line without addresses", async () => {
    const dev = bare("dev");
    const main = bare("main");
    run(dir, "remote", "add", "origin", dev);
    run(dir, "remote", "add", "release", main);
    run(dir, "config", "branch.main.remote", "release");
    const r = await dry({ settings: { testCommand: "npm test" } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ develop: { branch: "develop", remote: "origin", addresses: [dev] }, main: { branch: "main", remote: "release", addresses: [main] }, tags: true, on: false });
    expect(getRepo(local.id)!.settings).toBeUndefined();
    const token = r.json.confirm.token as string;

    const ok = await post(`repos/${local.id}/publish-remote`, { confirm: token, settings: { testCommand: "npm test" } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(getRepo(local.id)!.settings).toEqual({ testCommand: "npm test", pushRemote: true });
    expect((await post(`repos/${local.id}/publish-remote`, { confirm: token })).status).toBe(409);

    const audit = readFileSync(auditPath(), "utf8");
    expect(audit).toContain("Yes, publish: push to remote");
    expect(audit).not.toContain(token);
    expect(audit).not.toContain(dev);
    expect(audit).not.toContain(main);
    expect((await dry()).json).toMatchObject({ on: true });
    expect((await dry()).json).not.toHaveProperty("confirm");
  });

  it("scrubs the sign-in of an address", async () => {
    run(dir, "remote", "add", "origin", "https://user:s3cret@example.com/a/b.git");
    const r = await dry();
    expect(r.json.develop.addresses).toEqual(["https://***@example.com/a/b.git"]);
    expect(JSON.stringify(r.json)).not.toContain("s3cret");
  });

  it("invalid settings in confirm leave it off, and a changed branch name or remote after the check gets 409", async () => {
    run(dir, "remote", "add", "origin", bare("a"));
    const t1 = (await dry()).json.confirm.token as string;
    const bad = await post(`repos/${local.id}/publish-remote`, { confirm: t1, settings: { mainBranch: "bad branch" } });
    expect(bad.status).toBe(400);
    expect(getRepo(local.id)!.settings).toBeUndefined();

    const t2 = (await dry({ settings: { developBranch: "dev" } })).json.confirm.token as string;
    expect((await post(`repos/${local.id}/publish-remote`, { confirm: t2, settings: { developBranch: "other" } })).status).toBe(409);
    expect(getRepo(local.id)!.settings).toBeUndefined();

    const t3 = (await dry()).json.confirm.token as string;
    run(dir, "remote", "set-url", "origin", bare("b"));
    const moved = await post(`repos/${local.id}/publish-remote`, { confirm: t3 });
    expect(moved.status).toBe(409);
    expect(moved.json.error).toMatch(/changed since the check/);
    expect(getRepo(local.id)!.settings).toBeUndefined();
  });

  it("a second push destination added after the check gets 409, and both show in the check", async () => {
    const a = bare("first");
    const b = bare("second");
    run(dir, "remote", "add", "origin", a);
    run(dir, "remote", "set-url", "--add", "--push", "origin", a);
    run(dir, "remote", "set-url", "--add", "--push", "origin", b);
    const first = await dry();
    expect(first.json.develop.addresses).toEqual([a, b]);
    const token = first.json.confirm.token as string;
    run(dir, "remote", "set-url", "--add", "--push", "origin", bare("third"));
    const r = await post(`repos/${local.id}/publish-remote`, { confirm: token });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/changed since the check/);
    expect(getRepo(local.id)!.settings).toBeUndefined();
  });

  it("is for the owner only (404), needs a dry run or a token (400/409) and no other keys", async () => {
    run(dir, "remote", "add", "origin", bare("c"));
    expect((await dry({}, other)).status).toBe(404);
    expect((await post(`repos/${local.id}/publish-remote`, {})).status).toBe(400);
    expect((await post(`repos/${local.id}/publish-remote`, { dryRun: true, confirm: "x".repeat(43) })).status).toBe(400);
    expect((await post(`repos/${local.id}/publish-remote`, { dryRun: true, pushRemote: true })).status).toBe(400);
    expect((await post(`repos/${local.id}/publish-remote`, { confirm: "x".repeat(43) })).status).toBe(409);
    expect((await post(`repos/${local.id}/publish-remote`, { confirm: 5 })).status).toBe(409);
    expect(getRepo(local.id)!.settings).toBeUndefined();
  });
});
