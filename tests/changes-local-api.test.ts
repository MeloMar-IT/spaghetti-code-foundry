import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localRepoName } from "../src/auth/local-name.js";
import { addRepo, setRepoReady, transferRepo } from "../src/auth/repos.js";
import type { ServerOptions } from "../src/server/server.js";
import { parseStoryFile } from "../src/stories/story-file.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let base: string;
let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let dir: string;
let name: string;
let started: Awaited<ReturnType<typeof startTestServer>> | undefined;
let ann: TestSession;
const ENV = ["FAKE_SIMPLE_ROUND", "FAKE_UNDERSTAND"];
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
const stories = () => join(dir, ".scf", "stories");

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app");
  tmp = mkdtempSync(join(tmpdir(), "changes-local-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  const opts: Omit<ServerOptions, "port"> = { repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startTestServer(opts);
  base = started.base;
  await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
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
  name = localRepoName(rec);
  setRepoReady(rec.id, { items: [{ id: "out-of-scope", text: "it says what is out of scope" }] });
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  if (!started?.ctx.scheduler.draining) await started?.ctx.scheduler.idle();
  started?.close();
  started = undefined;
  gh.restore();
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const send = () => fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}
const post = (path: string, body: unknown = {}) => call(ann, "POST", `/api/changes${path}`, body);
const read = async (id: string) => (await call(ann, "GET", `/api/changes/${id}`)).json();
async function until(id: string, state: string): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const v = await read(id);
    if (v.state === state) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never ${state}: ${JSON.stringify(await read(id))}`);
}
const card = (title: string, dependsOn: number[] = []) => ({ title, who: "A lead", what: `Do ${title}`, why: "Because.", criteria: ["It works."], outOfScope: "", dependsOn, summary: `This is what I understood: ${title}` });
const ghCalls = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));
const storyFiles = () => readdirSync(stories()).filter((f) => f.endsWith(".md")).sort();
const parsed = (n: number) => {
  const f = storyFiles().find((x) => x.startsWith(`${n}-`))!;
  const r = parseStoryFile(readFileSync(join(stories(), f), "utf8"), f) as any;
  return r.story ?? r;
};
const start = async () => {
  const r = await post("", { repo: name, text: "Let me export a report as CSV" });
  expect(r.status, r.text).toBe(202);
  return r.json().id as string;
};

describe("a change request on a local project", { timeout: 60_000 }, () => {
  it("goes from the words to stories in state go, with no gh call", async () => {
    const id = await start();
    const q = await until(id, "questions");
    expect((await post(`/${id}/answers`, { answers: [{ question: q.questions[0].id, text: "Our team leads" }] })).status).toBe(202);
    const cards = await until(id, "cards");
    expect(cards.cards).toHaveLength(1);
    const b = await post(`/${id}/build`);
    expect(b.status, b.text).toBe(200);
    expect(b.json()).toMatchObject({ state: "planned", building: true });
    expect(storyFiles()).toHaveLength(1);
    expect(parsed(1).state).toBe("go");
    expect(ghCalls()).toEqual([]);
    expect((await post(`/${id}/build`)).json().building).toBe(true);
    expect(storyFiles()).toHaveLength(1);
  });

  it("keeps several cards for later, then builds them", async () => {
    process.env.FAKE_SIMPLE_ROUND = JSON.stringify({ questions: [], proposals: [], done: "All clear." });
    process.env.FAKE_UNDERSTAND = JSON.stringify({ drafts: [card("First"), card("Second", [1]), card("Third", [1, 2])] });
    const id = await start();
    await until(id, "cards");
    const later = await post(`/${id}/later`);
    expect(later.json()).toMatchObject({ state: "planned", building: false });
    expect(storyFiles()).toHaveLength(3);
    for (const n of [1, 2, 3]) expect(parsed(n).state).toBe("open");
    expect(parsed(3).body).toMatch(/#1/);
    expect(parsed(3).body).toMatch(/#2/);
    const b = await post(`/${id}/build`);
    expect(b.json()).toMatchObject({ state: "planned", building: true });
    for (const n of [1, 2, 3]) expect(parsed(n).state).toBe("go");
    const head = git("rev-parse", "scf/stories");
    expect((await post(`/${id}/build`)).status).toBe(200);
    expect(git("rev-parse", "scf/stories")).toBe(head);
    expect(ghCalls()).toEqual([]);
  });

  it("commits the go state on a retry when the first build saved the story but failed to commit it", async () => {
    process.env.FAKE_SIMPLE_ROUND = JSON.stringify({ questions: [], proposals: [], done: "All clear." });
    const id = await start();
    await until(id, "cards");
    expect((await post(`/${id}/later`)).status).toBe(200);
    // A stale lock of the stories branch: the label is saved to the file, but its commit fails.
    mkdirSync(join(dir, ".git", "refs", "heads", "scf"), { recursive: true });
    const lock = join(dir, ".git", "refs", "heads", "scf", "stories.lock");
    writeFileSync(lock, "");
    const failed = await post(`/${id}/build`);
    expect(failed.status).toBe(502);
    rmSync(lock);
    expect(parsed(1).state).toBe("go");
    // The retry must commit it: the file already shows go, so only a write commits it.
    const ok = await post(`/${id}/build`);
    expect(ok.json()).toMatchObject({ state: "planned", building: true });
    const committed = git("show", `scf/stories:${git("ls-tree", "-r", "--name-only", "scf/stories").split("\n").find((f) => /\.scf\/stories\/1-.*\.md$/.test(f))}`);
    expect(committed).toMatch(/state: go/);
  });

  it("refuses to label after the project was moved to someone else, and leaves the stories alone", async () => {
    process.env.FAKE_SIMPLE_ROUND = JSON.stringify({ questions: [], proposals: [], done: "All clear." });
    const id = await start();
    await until(id, "cards");
    expect((await post(`/${id}/later`)).status).toBe(200);
    const rec = (await import("../src/auth/repos.js")).listRepos(ann.user.id).find((r) => r.method === "local")!;
    transferRepo(rec.id, "bob@example.com");
    const b = await post(`/${id}/build`);
    expect(b.status).toBe(403);
    expect(parsed(1).state).toBe("open");
  });
});
