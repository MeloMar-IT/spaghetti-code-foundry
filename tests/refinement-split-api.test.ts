import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
import { END_NO_SPLIT_DRAFT, SPLIT_READ_ONLY } from "../src/refinement/draft-split.js";
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

describe("confirming a split", () => {
  const confirm = (id: string, did: string, body?: unknown, who = ann) => call(who, "POST", url(id, `drafts/${did}/split/confirm`), body);
  const plan = async (id: string) => {
    const c = (await draftOf(id)).criteria.map((x: any) => x.id);
    return { parts: [{ title: "First", sentence: "Do first.", criteria: [c[0]], dependsOn: [] }, { title: "Second", criteria: [c[1]], dependsOn: [1] }], unplaced: [] };
  };
  const publish = async (id: string, index: number) => {
    started!.close();
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    f.sessions.find((s: any) => s.id === id).drafts[index].published = { issue: 42, url: "https://github.com/acme/app/issues/42", at: "2026-01-01T00:00:00.000Z" };
    writeFileSync(refinementsPath(), JSON.stringify(f));
    started = await startServer(opts());
    await get(id);
  };

  it("answers 201, adds the parts, marks the original as split and starts no run", async () => {
    const { id, did } = await withDraft();
    const before = (await get(id)).architect;
    const r = await confirm(id, did, await plan(id));
    expect(r.status).toBe(201);
    const s = r.json();
    expect(s.drafts).toHaveLength(3);
    expect(s.drafts[0]).toMatchObject({ id: did, state: "split", splitInto: [s.drafts[1].id, s.drafts[2].id] });
    expect(s.drafts[1]).toMatchObject({ state: "drafting", part: { of: did, hint: "Do first." } });
    expect(s.drafts[2].dependsOn[0].draft).toBe(s.drafts[1].id);
    expect(s.architect).toEqual(before);
    expect(whats(s).at(-1)).toBe("draft-split");
  });

  it("answers 400 for a bad plan", async () => {
    const { id, did } = await withDraft();
    const ok = await plan(id);
    const msg = async (body: unknown) => {
      const r = await confirm(id, did, body);
      expect(r.status).toBe(400);
      return r.error();
    };
    expect(await msg({ ...ok, parts: [ok.parts[0]] })).toBe("a split has 2 to 6 parts");
    expect(await msg({ ...ok, parts: [{ ...ok.parts[0], title: "" }, ok.parts[1]] })).toBe("each part needs a title");
    expect(await msg({ parts: ok.parts })).toMatch(/unplaced/);
    expect(await msg({ ...ok, way: 0 })).toBe("no such way; ask for ways to split again");
    expect(await msg({ ...ok, parts: [ok.parts[0], { ...ok.parts[1], dependsOn: [5] }] })).toBe("no such part");
    expect(await msg({ ...ok, unplaced: [ok.parts[0].criteria[0]] })).toBe('a criterion is in the plan twice: "It exports a file"');
    expect((await call(ann, "POST", url(id, `drafts/${did}/split/confirm`), "x", { "content-type": "text/plain" })).status).toBe(415);
    expect((await get(id)).drafts).toHaveLength(1);
  });

  it("answers 409 for a split draft, a part and a published draft, also when asking for ways", async () => {
    const { id, did } = await withDraft();
    const s = (await confirm(id, did, await plan(id))).json();
    for (const [target, why] of [
      [did, "this draft is split; its parts are worked on instead"],
      [s.drafts[1].id, "a part of a split cannot be split again"],
    ] as const) {
      const c = await confirm(id, target, {});
      expect(c.status).toBe(409);
      expect(c.error()).toBe(why);
      const a = await split(id, target);
      expect(a.status).toBe(409);
      expect(a.error()).toBe(why);
    }
    const p = await withDraft();
    await publish(p.id, 0);
    const c = await confirm(p.id, p.did, {});
    expect(c.status).toBe(409);
    expect(c.error()).toMatch(/on GitHub as issue #42/);
    expect((await split(p.id, p.did)).status).toBe(409);
  });

  it("is for the owner only, and needs an existing draft and session", async () => {
    const { id, did } = await withDraft();
    const body = await plan(id);
    expect((await confirm(id, did, body, bob)).status).toBe(404);
    expect((await confirm(id, did, body, admin)).status).toBe(403);
    expect((await confirm(id, "00000000-0000-4000-8000-000000000000", body)).status).toBe(404);
  });

  it("does not remove a published part or its original, and strips part from the parts of a removed original", async () => {
    const { id, did } = await withDraft();
    const s = (await confirm(id, did, await plan(id))).json();
    await publish(id, 2);
    expect((await call(ann, "DELETE", url(id, `drafts/${s.drafts[2].id}`))).status).toBe(409);
    expect((await call(ann, "DELETE", url(id, `drafts/${did}`))).status).toBe(409);
    const other = await withDraft();
    await confirm(other.id, other.did, await plan(other.id));
    const r = await call(ann, "DELETE", url(other.id, `drafts/${other.did}`));
    expect(r.status).toBe(200);
    expect(r.json().drafts.every((d: any) => d.part === undefined)).toBe(true);
  });

  it("refuses a link from a part to a later part", async () => {
    const { id, did } = await withDraft();
    const s = (await confirm(id, did, await plan(id))).json();
    const r = await call(ann, "PUT", url(id, `drafts/${s.drafts[1].id}`), { dependsOn: [{ draft: s.drafts[2].id }] });
    expect(r.status).toBe(400);
    expect(r.error()).toBe("a part cannot depend on a later part");
  });

  it("answers 409 for every change of the original and writes nothing", async () => {
    const { id, did } = await withDraft();
    await confirm(id, did, await plan(id));
    const before = readFileSync(refinementsPath(), "utf8");
    const sid = "22222222-2222-4222-8222-222222222222";
    const calls: [string, string, unknown?][] = [
      ["PUT", `drafts/${did}`, { title: "X" }],
      ["POST", `drafts/${did}/suggestions/${sid}/accept`, {}],
      ["POST", `drafts/${did}/suggestions/${sid}/reject`, {}],
      ["POST", `drafts/${did}/move-to-notes`, { field: "what" }],
      ["PUT", `drafts/${did}/review-label`, {}],
      ["POST", `drafts/${did}/ready-check`],
      ["POST", `drafts/${did}/ready/value/accept`, { reason: "r" }],
      ["DELETE", `drafts/${did}/ready/value/accept`],
      ["POST", `drafts/${did}/suggest`, { field: "who" }],
      ["POST", `drafts/${did}/review`],
      ["POST", `drafts/${did}/impact`],
    ];
    for (const [method, path, body] of calls) {
      const r = await call(ann, method, url(id, path), body);
      expect([method, path, r.status, r.error()]).toEqual([method, path, 409, SPLIT_READ_ONLY]);
    }
    expect(readFileSync(refinementsPath(), "utf8")).toBe(before);
    expect((await get(id)).architect.state).toBe("idle");
  });

  for (const [name, path, body] of [
    ["review", "review", undefined],
    ["impact", "impact", undefined],
    ["suggest", "suggest", { field: "who" }],
  ] as const) {
    it(`ends a paused ${name} run whose draft was split, and does not block the next ask`, async () => {
      const { id, did } = await withDraft({ title: "CLAUDE_LIMIT please", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: TWO });
      const first = await call(ann, "POST", url(id, `drafts/${did}/${path}`), body);
      expect(first.status).toBe(202);
      const runId = first.json().architect.runId;
      await until(id, (s) => s.architect.state === "paused");
      expect((await confirm(id, did, await plan(id))).status).toBe(201);
      const again = await call(ann, "POST", url(id, `drafts/${did}/${path}`), body);
      expect(again.status).toBe(409);
      expect(again.error()).toBe(SPLIT_READ_ONLY);
      expect((await get(id)).architect).toMatchObject({ state: "failed", reason: "The draft was split while the run was paused" });
      expect(runJson(runId).status).toBe("cancelled");
      expect(runJson(runId).resumes ?? 0).toBe(0);
      expect((await call(ann, "POST", url(id, "architect"))).status).toBe(202);
      await idle(id);
    });
  }

  it("lets a part take a suggestion, a review and a readiness check", async () => {
    const { id, did } = await withDraft();
    const s = (await confirm(id, did, await plan(id))).json();
    const part = s.drafts[1].id;
    expect((await call(ann, "POST", url(id, `drafts/${part}/suggest`), { field: "who" })).status).toBe(202);
    await idle(id);
    expect((await call(ann, "POST", url(id, `drafts/${part}/review`))).status).toBe(202);
    await idle(id);
    const r = await call(ann, "POST", url(id, `drafts/${part}/ready-check`));
    expect([200, 202]).toContain(r.status);
    await until(id, (x) => x.architect.state === "idle" || x.architect.state === "failed");
    expect((await draftOf(id, 1)).readiness).toBeDefined();
  });

  it("fails a split run that is still running when the plan is confirmed", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await split(id, did);
    expect((await confirm(id, did, await plan(id))).status).toBe(201);
    delete process.env.FAKE_GH_SLEEP;
    expect((await failed(id)).architect.reason).toBe(END_NO_SPLIT_DRAFT);
    expect((await call(ann, "GET", `/api/refinement/${id}`)).status).toBe(200);
  });
});

describe("moving a criterion of a split", () => {
  const confirm = (id: string, did: string, body?: unknown) => call(ann, "POST", url(id, `drafts/${did}/split/confirm`), body);
  const move = (id: string, did: string, cid: string, body?: unknown, who = ann) => call(who, "POST", url(id, `drafts/${did}/criteria/${cid}/move`), body);
  const UNKNOWN = "00000000-0000-4000-8000-000000000000";
  const plan = async (id: string, dependsOn: number[] = [1]) => {
    const c = (await draftOf(id)).criteria.map((x: any) => x.id);
    return { parts: [{ title: "First", criteria: [c[0]], dependsOn: [] }, { title: "Second", criteria: [c[1]], dependsOn }], unplaced: [] };
  };
  const split2 = async (dependsOn?: number[]) => {
    const { id, did } = await withDraft();
    const s = (await confirm(id, did, await plan(id, dependsOn))).json();
    return { id, did, p1: s.drafts[1], p2: s.drafts[2] };
  };
  /** Stops the server, changes the file and starts it again. */
  const rewrite = async (id: string, fn: (s: any) => void) => {
    started!.close();
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    fn(f.sessions.find((s: any) => s.id === id));
    writeFileSync(refinementsPath(), JSON.stringify(f));
    started = await startServer(opts());
    await get(id);
  };

  it("answers 200, moves the criterion to the end of the target and logs it", async () => {
    const { id, p1, p2 } = await split2();
    const c = p1.criteria[0];
    const r = await move(id, p1.id, c.id, { to: p2.id });
    expect(r.status).toBe(200);
    const s = r.json();
    expect(s.drafts[1].criteria).toEqual([]);
    expect(s.drafts[2].criteria.at(-1)).toEqual(c);
    expect(whats(s).at(-1)).toBe("criterion-moved");
    expect(s.log.at(-1).detail).toBe(c.text);
  });

  it("moves between the original and a part, and shows a layer warning only while a part is empty", async () => {
    const { id, did, p1, p2 } = await split2();
    expect((await draftOf(id)).partWarnings).toBeUndefined();
    const c = p1.criteria[0];
    const out = await move(id, p1.id, c.id, { to: did });
    expect(out.status).toBe(200);
    expect(out.json().drafts[0].criteria.map((x: any) => x.id)).toEqual([c.id]);
    expect(out.json().drafts[0].partWarnings).toEqual([{ kind: "layer", part: p1.id, why: "This part has no acceptance criterion." }]);
    expect(out.json().drafts[1].partWarnings).toBeUndefined();
    expect(out.json().drafts[2].partWarnings).toBeUndefined();
    const back = await move(id, did, c.id, { to: p1.id });
    expect(back.status).toBe(200);
    expect(back.json().drafts[0].partWarnings).toBeUndefined();
    expect(back.json().drafts[0].splitInto).toEqual([p1.id, p2.id]);
  });

  it("shows a same-code warning for unrelated parts that touch the same code", async () => {
    const { id, p1, p2 } = await split2([]);
    const impact = (area: string) => ({
      at: "2026-01-01T00:00:00.000Z",
      mark: "0".repeat(64),
      areas: [{ area, files: [], basis: "estimate", why: "It is touched." }],
      dependsOn: [],
      dependents: [],
      risks: [],
      size: { size: "small", files: 1, lines: 1, why: "It is small." },
      overlaps: [],
      sensitive: [],
    });
    await rewrite(id, (s) => {
      s.drafts[1].impact = impact("src/a");
      s.drafts[2].impact = impact("src/a/b");
    });
    expect((await draftOf(id)).partWarnings).toEqual([{ kind: "same-code", parts: [p1.id, p2.id], areas: ["src/a"], why: "Both parts touch the same code and neither depends on the other." }]);
  });

  it("answers 400 for a wrong body or a wrong target", async () => {
    const { id, p1 } = await split2();
    const c = p1.criteria[0].id;
    const plain = (await call(ann, "POST", url(id, "drafts"), {})).json().drafts.at(-1).id;
    for (const body of [{}, { to: 1 }]) {
      const r = await move(id, p1.id, c, body);
      expect(r.status).toBe(400);
      expect(r.error()).toBe("send to: the draft to move the criterion to");
    }
    for (const to of [UNKNOWN, p1.id, plain]) {
      const r = await move(id, p1.id, c, { to });
      expect(r.status).toBe(400);
      expect(r.error()).toBe("a criterion can only move between a split draft and its parts");
    }
  });

  it("answers 404 for an unknown draft, criterion or session", async () => {
    const { id, p1, p2 } = await split2();
    expect((await move(id, UNKNOWN, UNKNOWN, { to: p2.id })).status).toBe(404);
    expect((await move(id, p1.id, UNKNOWN, { to: p2.id })).status).toBe(404);
    expect((await move(UNKNOWN, p1.id, p1.criteria[0].id, { to: p2.id })).status).toBe(404);
  });

  it("answers 400 for a full target", async () => {
    const { id, p1, p2 } = await split2();
    const full = Array.from({ length: 50 }, (_, i) => ({ text: `Criterion ${i}` }));
    expect((await call(ann, "PUT", url(id, `drafts/${p2.id}`), { criteria: full })).status).toBe(200);
    const r = await move(id, p1.id, p1.criteria[0].id, { to: p2.id });
    expect(r.status).toBe(400);
    expect(r.error()).toBe("at most 50 acceptance criteria");
  });

  it("answers 409 when the source or the target is on GitHub", async () => {
    const { id, p1, p2 } = await split2();
    await rewrite(id, (s) => (s.drafts[2].published = { issue: 42, url: "https://github.com/acme/app/issues/42", at: "2026-01-01T00:00:00.000Z" }));
    for (const [from, to] of [[p1, p2], [p2, p1]]) {
      const r = await move(id, from!.id, from!.criteria[0].id, { to: to!.id });
      expect(r.status).toBe(409);
      expect(r.error()).toMatch(/on GitHub as issue #42/);
    }
  });

  it("is for the owner only", async () => {
    const { id, p1, p2 } = await split2();
    const c = p1.criteria[0].id;
    expect((await move(id, p1.id, c, { to: p2.id }, bob)).status).toBe(404);
    expect((await move(id, p1.id, c, { to: p2.id }, admin)).status).toBe(403);
    expect((await draftOf(id, 1)).criteria).toHaveLength(1);
  });
});

describe("merging two drafts", () => {
  const confirm = (id: string, did: string, body?: unknown) => call(ann, "POST", url(id, `drafts/${did}/split/confirm`), body);
  const merge = (id: string, did: string, body?: unknown, who = ann) => call(who, "POST", url(id, `drafts/${did}/merge`), body);
  const UNKNOWN = "00000000-0000-4000-8000-000000000000";
  const split2 = async () => {
    const { id, did } = await withDraft();
    const c = (await draftOf(id)).criteria.map((x: any) => x.id);
    const plan = { parts: [{ title: "First", criteria: [c[0]], dependsOn: [] }, { title: "Second", criteria: [c[1]], dependsOn: [1] }], unplaced: [] };
    const s = (await confirm(id, did, plan)).json();
    return { id, did, p1: s.drafts[1], p2: s.drafts[2] };
  };

  it("answers 200 for two parts, removes the second and starts no run", async () => {
    const { id, did, p1, p2 } = await split2();
    const r = await merge(id, p1.id, { with: p2.id });
    expect(r.status).toBe(200);
    const s = r.json();
    expect(s.drafts).toHaveLength(2);
    expect(s.drafts[1].id).toBe(p1.id);
    expect(s.drafts[1].criteria).toHaveLength(2);
    expect(s.drafts[1].dependsOn).toEqual([]);
    expect(s.drafts[0].splitInto).toEqual([p1.id]);
    expect(s.drafts[0].id).toBe(did);
    expect(whats(s).at(-1)).toBe("drafts-merged");
    expect(s.architect.state).toBe("idle");
  });

  it("answers 200 for two ordinary drafts", async () => {
    const { id, did } = await withDraft();
    const second = (await call(ann, "POST", url(id, "drafts"), {})).json().drafts.at(-1).id;
    const r = await merge(id, did, { with: second });
    expect(r.status).toBe(200);
    expect(r.json().drafts).toHaveLength(1);
    expect(r.json().drafts[0].title).toMatchObject({ text: "Export" });
    expect(whats(r.json()).at(-1)).toBe("drafts-merged");
  });

  it("answers 400 for a wrong body, itself and too many criteria", async () => {
    const { id, did } = await withDraft();
    const second = (await call(ann, "POST", url(id, "drafts"), {})).json().drafts.at(-1).id;
    expect((await merge(id, did, {})).status).toBe(400);
    expect((await merge(id, did, { with: did })).status).toBe(400);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `Criterion ${i}` }));
    expect((await call(ann, "PUT", url(id, `drafts/${did}`), { criteria: many(30) })).status).toBe(200);
    expect((await call(ann, "PUT", url(id, `drafts/${second}`), { criteria: many(21) })).status).toBe(200);
    expect((await merge(id, did, { with: second })).status).toBe(400);
    expect((await get(id)).drafts).toHaveLength(2);
  });

  it("answers 404 for an unknown session, draft and with", async () => {
    const { id, did } = await withDraft();
    expect((await merge(UNKNOWN, did, { with: did })).status).toBe(404);
    expect((await merge(id, UNKNOWN, { with: did })).status).toBe(404);
    expect((await merge(id, did, { with: UNKNOWN })).status).toBe(404);
  });

  it("answers 409 for the split original, as draft and as with", async () => {
    const { id, did, p1 } = await split2();
    for (const [target, other] of [[did, p1.id], [p1.id, did]] as const) {
      const r = await merge(id, target, { with: other });
      expect(r.status).toBe(409);
      expect(r.error()).toBe(SPLIT_READ_ONLY);
    }
  });

  it("is for the owner only", async () => {
    const { id, p1, p2 } = await split2();
    expect((await merge(id, p1.id, { with: p2.id }, bob)).status).toBe(404);
    expect((await merge(id, p1.id, { with: p2.id }, admin)).status).toBe(403);
    expect((await get(id)).drafts).toHaveLength(3);
  });
});
