import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRepoName } from "../src/auth/local-name.js";
import { addRepo, setRepoReady, transferRepo } from "../src/auth/repos.js";
import { stillOwnsProject } from "../src/server/repo-sign-in.js";
import type { ServerOptions } from "../src/server/server.js";
import { LocalStore } from "../src/stories/local-store.js";
import { parseStoryFile } from "../src/stories/story-file.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let dir: string;
let name: string;
let repoId: string;
let started: Awaited<ReturnType<typeof startTestServer>> | undefined;
let ann: TestSession;
let bob: TestSession;
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
const stories = () => join(dir, ".scf", "stories");

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app");
  tmp = mkdtempSync(join(tmpdir(), "refinement-publish-local-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  const opts: Omit<ServerOptions, "port"> = { repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startTestServer(opts);
  base = started.base;
  await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  dir = join(tmp, "my-app");
  mkdirSync(dir);
  git("init", "-q", "-b", "main");
  git("config", "user.name", "T");
  git("config", "user.email", "t@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const rec = addRepo(ann.user.id, { url: dir, method: "local" });
  repoId = rec.id;
  name = localRepoName(rec);
  setRepoReady(repoId, { items: LIST2 });
});
afterEach(async () => {
  if (!started?.ctx.scheduler.draining) await started?.ctx.scheduler.idle();
  started?.close();
  started = undefined;
  gh.restore();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const send = () =>
    fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;
const ghCalls = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));
const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It exports a file" }] };
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];

async function addDraft(id: string, fields: Record<string, unknown>) {
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts.at(-1).id as string;
  expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  return did;
}
/** Session with A (depends on B) and B, both ready. */
async function twoDrafts() {
  const id = (await call(ann, "POST", "/api/refinement", { repo: name, idea: "Export a report as CSV" })).json().id as string;
  const a = await addDraft(id, { ...FULL, title: "First A" });
  const b = await addDraft(id, { ...FULL, title: "Second B" });
  expect((await call(ann, "PUT", url(id, `drafts/${a}`), { dependsOn: [{ draft: b }] })).status).toBe(200);
  for (const d of [a, b]) expect((await call(ann, "POST", url(id, `drafts/${d}/ready-check`))).status).toBe(200);
  return { id, a, b };
}
const storyFiles = () => readdirSync(stories()).filter((f) => f.endsWith(".md")).sort();
const parsed = (n: number) => {
  const f = storyFiles().find((x) => x.startsWith(`${n}-`))!;
  const r = parseStoryFile(readFileSync(join(stories(), f), "utf8"), f) as any;
  return r.story ?? r;
};

describe("publishing on a local project", { timeout: 30_000 }, () => {
  it("answers the plan with the build label go and no gh call", async () => {
    const { id } = await twoDrafts();
    const r = await call(ann, "GET", url(id, "publish"));
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ repo: name, buildLabel: "go" });
    expect(r.json().repoLabels).toContain("go");
    expect(ghCalls()).toEqual([]);
  });

  it("creates the stories with Depends on, commits them on scf/stories, and leaves the checkout alone", async () => {
    const { id, a, b } = await twoDrafts();
    writeFileSync(join(dir, "README.md"), "dirty\n");
    const head = git("rev-parse", "HEAD");
    const index = git("diff", "--cached", "--name-only");
    const r = await call(ann, "POST", url(id, "publish"), {});
    expect(r.status, r.text).toBe(200);
    const created = r.json().created as { draft: string; issue: number; url: string }[];
    expect(created.map((c) => [c.draft, c.issue])).toEqual([[b, 1], [a, 2]]);
    for (const c of created) expect(c.url.startsWith(".scf/stories/")).toBe(true);
    expect(parsed(2).body).toMatch(/Depends on[\s\S]*#1/);
    expect(parsed(2).state).toBe("open");
    expect(git("log", "--format=%s", "scf/stories")).toContain("scf: story #2 created");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("diff", "--cached", "--name-only")).toBe(index);
    expect(ghCalls()).toEqual([]);
    // publishing again makes nothing new
    expect((await call(ann, "POST", url(id, "publish"), {})).status).toBe(200);
    expect(storyFiles()).toHaveLength(2);
  });

  it("sets state go when startBuilding is chosen", async () => {
    const { id, a, b } = await twoDrafts();
    const r = await call(ann, "POST", url(id, "publish"), { drafts: [{ draft: a, startBuilding: true }, { draft: b, startBuilding: false }] });
    expect(r.status).toBe(200);
    expect(parsed(2).state).toBe("go");
    expect(parsed(1).state).toBe("open");
  });

  it("answers 403 not-yours after the project moved, and writes nothing", async () => {
    const { id } = await twoDrafts();
    transferRepo(repoId, "bob@example.com");
    expect((await call(ann, "GET", url(id, "publish"))).status).toBe(403);
    const r = await call(ann, "POST", url(id, "publish"), {});
    expect(r.status).toBe(403);
    expect(existsSync(stories())).toBe(false);
    expect(bob.user.id).toBeDefined();
  });

  it("finishes a story whose commit failed: publishing again commits it and makes no second story", async () => {
    const { id } = await twoDrafts();
    mkdirSync(join(dir, ".git", "refs", "heads", "scf"), { recursive: true });
    const lock = join(dir, ".git", "refs", "heads", "scf", "stories.lock");
    writeFileSync(lock, "");
    expect((await call(ann, "POST", url(id, "publish"), {})).status).toBe(502);
    expect(storyFiles()).toHaveLength(1);
    rmSync(lock);
    const r = await call(ann, "POST", url(id, "publish"), {});
    expect(r.status).toBe(200);
    expect(storyFiles()).toHaveLength(2);
    expect(git("ls-tree", "-r", "--name-only", "scf/stories")).toContain(".scf/stories/next-number");
    expect(git("ls-tree", "-r", "--name-only", "scf/stories").split("\n").filter((f) => f.endsWith(".md"))).toHaveLength(2);
    expect(git("show", "scf/stories:.scf/stories/next-number")).toBe(readFileSync(join(stories(), "next-number"), "utf8").trim());
  });
});

describe("ownership inside the story lock", () => {
  const moved = () => {
    transferRepo(repoId, "bob@example.com");
    stillOwnsProject(ann.user.id, name);
  };

  it("create writes and commits nothing when the guard fails after the lock was taken", async () => {
    mkdirSync(stories(), { recursive: true });
    const s = new LocalStore(dir, name, { lockPollMs: 5, branch: "scf/stories" });
    await expect(s.create({ title: "X", body: "", labels: [] }, undefined, moved)).rejects.toMatchObject({ code: "not-yours" });
    expect(readdirSync(stories())).toEqual([]);
    expect(git("branch", "--list", "scf/stories")).toBe("");
  });

  it("commitCreated commits nothing when the guard fails", async () => {
    await new LocalStore(dir, name, { lockPollMs: 5, commit: false }).create({ title: "X", body: "", labels: [] });
    const s = new LocalStore(dir, name, { lockPollMs: 5, branch: "scf/stories" });
    await expect(s.commitCreated(1, undefined, moved)).rejects.toMatchObject({ code: "not-yours" });
    expect(git("branch", "--list", "scf/stories")).toBe("");
  });
});
