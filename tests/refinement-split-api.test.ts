import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
import { END_NO_SPLIT_DRAFT } from "../src/refinement/draft-split.js";
import { END_BAD_FORM, refinementsPath } from "../src/refinement/store.js";
import { OWN_WAY_HEADING } from "../src/refinement/split-text.js";
import { TALK_FIRST_LINE } from "../src/refinement/talk-text.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND", "FAKE_GH_ISSUES"];
const opts = (): ServerOptions => ({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 });

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-split-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  delete process.env.FAKE_GH_SLEEP;
  delete process.env.FAKE_BRIEF;
  delete process.env.FAKE_ROUND;
  delete process.env.FAKE_GH_ISSUES;
  kc = fakeKeychain();
  started = await startServer(opts());
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  addRepo(bob.user.id, { url: "other/thing", method: "github-token", token: TOKEN });
});
afterEach(async () => {
  if (!started?.ctx.scheduler.draining) await started?.ctx.scheduler.idle();
  started?.close();
  started = undefined;
  kc.remove();
  gh.restore();
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown, headers: Record<string, string> = body !== undefined ? { "content-type": "application/json" } : {}) {
  const send = () =>
    fetch(base + path, {
      method,
      headers: { ...headers, ...who.headers(method) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (id: string, who = ann) => (await call(who, "GET", `/api/refinement/${id}`)).json();
async function until(id: string, test: (s: any) => boolean) {
  for (let i = 0; i < 300; i++) {
    const s = await get(id);
    if (test(s)) return s;
    await wait(100);
  }
  throw new Error(`timed out: ${JSON.stringify((await get(id)).architect)}`);
}
const idle = (id: string) => until(id, (s) => s.architect.state === "idle");
const failed = (id: string) => until(id, (s) => s.architect.state === "failed");
const runJson = (runId: string) => JSON.parse(readFileSync(join(tmp, "runs", runId, "run.json"), "utf8"));
const whats = (s: any) => s.log.map((l: any) => l.what);
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;

const TWO = [{ text: "It exports a file" }, { text: "It opens fast" }];
/** A session with a brief and one draft; `fields` are saved into it. */
async function withDraft(fields: Record<string, unknown> | null = { title: "Export", what: "to export a report", why: "to share it", criteria: TWO }, brief = true) {
  const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report as CSV" })).json().id as string;
  if (brief) {
    await call(ann, "POST", url(id, "architect"));
    await idle(id);
  }
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts[0].id as string;
  if (fields) expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  return { id, did };
}
const split = (id: string, did: string, body?: unknown, who = ann) => call(who, "POST", url(id, `drafts/${did}/split`), body);
const draftOf = async (id: string, i = 0) => (await get(id)).drafts[i];

describe("split", () => {
  it("starts refine-round with ask=split and a limit of $1, stores the ways without changing a field, and logs it", async () => {
    const { id, did } = await withDraft();
    const fields = await draftOf(id);
    const r = await split(id, did);
    expect(r.status).toBe(202);
    const s = r.json();
    expect(s.architect).toMatchObject({ kind: "split", draft: did });
    const run = runJson(s.architect.runId);
    expect(run).toMatchObject({ flow: "refine-round", vars: { github_repo: "acme/app", ask: "split" } });
    expect(run.flowDef.limits.max_cost_usd).toBe(1);
    expect(run.task.split("\n")[0]).toBe(TALK_FIRST_LINE.split);
    expect(run.task).not.toContain(OWN_WAY_HEADING);
    const done = await idle(id);
    const d = done.drafts[0];
    expect(d.split.ways).toHaveLength(2);
    expect(d.split.mark).toBeUndefined();
    expect(d.split.outOfDate).toBeUndefined();
    expect(d.split.ways[0].stories[0].criteria[0]).toMatch(/^[0-9a-f-]{36}$/);
    const { split: _s, ...rest } = d;
    expect(rest).toEqual(fields);
    expect(done.state).toBe("drafting");
    expect(whats(done).slice(-2)).toEqual(["split-asked", "architect-split"]);
    expect(done.log.at(-1).detail).toBe("2");
  });

  it("puts the own way at the end of the task, never in the variables, and checks it", async () => {
    const { id, did } = await withDraft();
    const own = "First the page, then the export";
    const r = await split(id, did, { own });
    expect(r.status).toBe(202);
    const run = runJson(r.json().architect.runId);
    expect(run.task.endsWith(`${OWN_WAY_HEADING} (${own.length} characters)\n${own}`)).toBe(true);
    expect(run.vars).not.toHaveProperty("own");
    await idle(id);
    expect((await split(id, did, { own: 5 })).status).toBe(400);
    expect((await split(id, did, { own: null })).status).toBe(400);
    expect((await split(id, did, { own: "x".repeat(501) })).status).toBe(400);
    expect((await split(id, did, {})).status).toBe(202);
    await idle(id);
    expect((await split(id, did)).status).toBe(202);
    await idle(id);
  });

  it("reads an optional body strictly", async () => {
    const { id, did } = await withDraft();
    const path = url(id, `drafts/${did}/split`);
    expect((await call(ann, "POST", path, "{nope", { "content-type": "application/json" })).status).toBe(400);
    expect((await call(ann, "POST", path, "hello", { "content-type": "text/plain" })).status).toBe(415);
    expect((await call(ann, "POST", path, JSON.stringify({ own: "x".repeat(1_100_000) }), { "content-type": "application/json" })).status).toBe(413);
    expect((await get(id)).architect.state).toBe("idle");
  });

  it("goes out of date after an edit, also one made while the run was active", async () => {
    const { id, did } = await withDraft();
    await split(id, did);
    await idle(id);
    await call(ann, "PUT", url(id, `drafts/${did}`), { notes: "Keep it small" });
    expect((await draftOf(id)).split.outOfDate).toBe(true);
    await split(id, did);
    await idle(id);
    expect((await draftOf(id)).split.outOfDate).toBeUndefined();
    const fresh = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await split(fresh.id, fresh.did);
    await call(ann, "PUT", url(fresh.id, `drafts/${fresh.did}`), { what: "to export it all" });
    delete process.env.FAKE_GH_SLEEP;
    expect((await idle(fresh.id)).drafts[0].split.outOfDate).toBe(true);
  });

  it("fails with the agreed sentence for a wrong form and keeps the old ways", async () => {
    const { id, did } = await withDraft();
    await split(id, did);
    const before = (await idle(id)).drafts[0].split;
    const st = (criteria: string[]) => ({ title: "Part", sentence: "Do the part.", criteria, dependsOn: [] });
    process.env.FAKE_ROUND = JSON.stringify({ ways: [{ cut: "step", stories: [st(["C1", "C2"]), st(["C2"])], first: "Start here.", unplaced: [], warnings: [] }] });
    await split(id, did);
    const s = await failed(id);
    expect(s.architect.reason).toBe(END_BAD_FORM);
    expect(s.drafts[0].split).toEqual(before);
  });

  it("fails when the draft is removed while the run is active", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await split(id, did);
    expect((await call(ann, "DELETE", url(id, `drafts/${did}`))).status).toBe(200);
    delete process.env.FAKE_GH_SLEEP;
    expect((await failed(id)).architect.reason).toBe(END_NO_SPLIT_DRAFT);
  });

  it("is refused for another user, an admin, a missing brief, one criterion and an unknown draft", async () => {
    const { id, did } = await withDraft();
    expect((await split(id, did, undefined, bob)).status).toBe(404);
    expect((await split(id, did, undefined, admin)).status).toBe(403);
    expect((await split(id, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const one = await withDraft({ title: "T", criteria: [{ text: "Only one" }] });
    const r = await split(one.id, one.did);
    expect(r.status).toBe(409);
    expect(r.error()).toBe("a draft needs at least 2 acceptance criteria to be split");
    const bare = await withDraft({ title: "T", criteria: TWO }, false);
    expect((await split(bare.id, bare.did)).status).toBe(409);
    expect((await get(id)).architect.state).toBe("idle");
  });

  it("refuses a second run while one is live, also from another session", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    expect((await split(id, did)).status).toBe(202);
    expect((await split(id, did)).status).toBe(409);
    const other = await withDraft();
    expect((await split(other.id, other.did)).status).toBe(409);
    started!.ctx.scheduler.cancel((await get(id)).architect.runId);
    await failed(id);
  });

  it("resumes a paused run with the same call, and refuses another draft, a review and an impact", async () => {
    const { id, did } = await withDraft({ title: "CLAUDE_LIMIT please", criteria: TWO });
    const first = (await split(id, did)).json().architect.runId;
    await until(id, (s) => s.architect.state === "paused");
    const d2 = (await call(ann, "POST", url(id, "drafts"))).json().drafts[1].id;
    await call(ann, "PUT", url(id, `drafts/${d2}`), { title: "Other", criteria: TWO });
    expect((await split(id, d2)).status).toBe(409);
    expect((await call(ann, "POST", url(id, `drafts/${did}/review`))).status).toBe(409);
    expect((await call(ann, "POST", url(id, `drafts/${did}/impact`))).status).toBe(409);
    const r = await split(id, did);
    expect(r.status).toBe(202);
    expect(r.json().architect).toMatchObject({ runId: first, kind: "split", draft: did });
    await until(id, (s) => s.architect.state === "paused");
    expect(runJson(first).resumes).toBe(1);
  });

  it("does not resume a paused run when the draft can not be split any more", async () => {
    const { id, did } = await withDraft({ title: "CLAUDE_LIMIT please", criteria: TWO });
    const first = (await split(id, did)).json().architect.runId;
    await until(id, (s) => s.architect.state === "paused");
    const c = (await draftOf(id)).criteria;
    await call(ann, "PUT", url(id, `drafts/${did}`), { criteria: [{ id: c[0].id, text: c[0].text }] });
    const r = await split(id, did);
    expect(r.status).toBe(409);
    expect(r.error()).toBe("a draft needs at least 2 acceptance criteria to be split");
    expect(runJson(first).resumes ?? 0).toBe(0);
    // The obsolete run is failed, so it no longer blocks the account.
    expect((await get(id)).architect.state).toBe("failed");
    expect(runJson(first).status).toBe("cancelled");
    await call(ann, "PUT", url(id, `drafts/${did}`), { title: "Export", criteria: TWO.map((x) => ({ text: x.text })) });
    expect((await call(ann, "POST", url(id, "architect"))).status).toBe(202);
  });

  it("refuses a draft whose task would be larger than the talk limit", async () => {
    const { id, did } = await withDraft();
    const big = Array.from({ length: 50 }, (_, i) => ({ text: `${i}` + "€".repeat(498) }));
    expect((await call(ann, "PUT", url(id, `drafts/${did}`), { criteria: big, notes: "€".repeat(5000) })).status).toBe(200);
    const r = await split(id, did);
    expect(r.status).toBe(409);
    expect((await get(id)).architect.state).toBe("idle");
  });

  it("takes in a split run the session never recorded, through the head lines of its task", async () => {
    const { id, did } = await withDraft();
    await split(id, did);
    await idle(id);
    started!.close();
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete f.sessions[0].drafts[0].split;
    f.sessions[0].log = f.sessions[0].log.filter((l: any) => !["split-asked", "architect-split"].includes(l.what));
    f.sessions[0].updated = "2020-01-01T00:00:00.000Z";
    writeFileSync(refinementsPath(), JSON.stringify(f));
    started = await startServer(opts());
    const s = await get(id);
    expect(s.architect.state).toBe("idle");
    expect(s.drafts[0].split.ways).toHaveLength(2);
  });

  it("is not shown while the repository is not in My repositories", async () => {
    const { id, did } = await withDraft();
    await split(id, did);
    await idle(id);
    removeRepo(ann.user.id, listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!.id);
    const s = await get(id);
    expect(s.draftsHidden).toBe(true);
    expect(s.drafts).toBeUndefined();
    expect(s.log.find((l: any) => l.what === "architect-split").detail).toBeUndefined();
  });
});
