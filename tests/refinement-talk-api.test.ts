import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
import { recordRound, refinementsPath } from "../src/refinement/store.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let tmp: string;
let saved: string | undefined;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;

const boot = async () => {
  started = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => undefined, refinementSweepMs: 3_600_000 });
};

beforeEach(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "refinement-talk-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  await boot();
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  addRepo(ann.user.id, "acme/app");
  addRepo(bob.user.id, "other/thing");
});
afterEach(() => {
  started?.close();
  started = undefined;
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown, raw?: string) {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}

const ROUND = {
  questions: [
    { view: "need", text: "Who uses it?", why: "It sets the value.", options: [{ text: "Everyone", tradeoff: "Broad" }, { text: "Admins", tradeoff: "Narrow" }], recommended: 1 },
    { view: "test", text: "What is an edge case?", why: "Tests need it.", options: [{ text: "Empty", tradeoff: "Simple" }, { text: "Huge", tradeoff: "Slow" }], recommended: 2 },
  ],
  proposals: [{ list: "rule", text: "Only admins export." }, { list: "example", text: "An empty report exports a header." }],
  done: "",
};
const make = async () => {
  const s = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "An idea" })).json();
  recordRound(s.id, "run-1", ROUND);
  return s.id as string;
};
const get = async (id: string, who = ann) => (await call(who, "GET", `/api/refinement/${id}`)).json();
const stored = () => JSON.parse(readFileSync(refinementsPath(), "utf8"));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const U = "99999999-9999-4999-8999-999999999999";

describe("the talk over the API", () => {
  it("is empty for a new session", async () => {
    const s = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "An idea" })).json();
    expect(s.talk).toEqual({ rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] });
    expect(s.talkHidden).toBeUndefined();
  });

  it("shows a round and changes it with the five calls", async () => {
    const id = await make();
    const s = await get(id);
    expect(s.talk.rounds[0].questions).toHaveLength(2);
    expect(s.talk.rounds[0].questions[0].answer).toBeUndefined();
    expect(s.talk.proposals).toHaveLength(2);
    const [q1, q2] = s.talk.rounds[0].questions;
    const [p1, p2] = s.talk.proposals;
    let r = await call(ann, "POST", `/api/refinement/${id}/questions/${q1.id}/answer`, { option: 2 });
    expect(r.status).toBe(200);
    expect(r.json().talk.rounds[0].questions[0].answer).toMatchObject({ option: 2 });
    r = await call(ann, "POST", `/api/refinement/${id}/questions/${q2.id}/answer`, { unknown: true });
    expect(r.json().talk.map.open[0].text).toBe("What is an edge case?");
    const open = r.json().talk.map.open[0];
    r = await call(ann, "POST", `/api/refinement/${id}/proposals/${p1.id}/accept`, {});
    expect(r.json().talk.map.rules[0]).toMatchObject({ id: p1.id, text: "Only admins export." });
    r = await call(ann, "POST", `/api/refinement/${id}/proposals/${p2.id}/reject`, {});
    expect(r.json().talk.proposals).toEqual([]);
    r = await call(ann, "PUT", `/api/refinement/${id}/map/${p1.id}`, { text: "Admins export." });
    expect(r.json().talk.map.rules[0].text).toBe("Admins export.");
    r = await call(ann, "DELETE", `/api/refinement/${id}/map/${open.id}`);
    expect(r.json().talk.map.open).toEqual([]);
    const lines = (await get(id)).log.slice(1);
    expect(lines).toEqual([
      { at: expect.any(String), what: "question", who: "Ann", detail: "Who uses it?" },
      { at: expect.any(String), what: "question", who: "Ann", detail: "What is an edge case?" },
      { at: expect.any(String), what: "answered", who: "Ann", detail: "Admins" },
      { at: expect.any(String), what: "answered", who: "Ann", detail: "I don't know yet" },
      { at: expect.any(String), what: "open-added", who: "Ann", detail: "What is an edge case?", list: "open" },
      { at: expect.any(String), what: "entry-accepted", who: "Ann", detail: "Only admins export.", list: "rule" },
      { at: expect.any(String), what: "entry-rejected", who: "Ann", detail: "An empty report exports a header.", list: "example" },
      { at: expect.any(String), what: "entry-changed", who: "Ann", detail: "Admins export.", list: "rule" },
      { at: expect.any(String), what: "entry-removed", who: "Ann", detail: "What is an edge case?", list: "open" },
    ]);
  });

  it("refuses bad calls", async () => {
    const id = await make();
    const s = await get(id);
    const q = s.talk.rounds[0].questions[0].id;
    const url = `/api/refinement/${id}/questions/${q}/answer`;
    expect((await call(ann, "POST", url, { option: 1 })).status).toBe(200);
    const again = await call(ann, "POST", url, { option: 1 });
    expect(again.status).toBe(409);
    expect(again.error()).toBe("that question is answered already");
    expect((await call(ann, "POST", `/api/refinement/${id}/questions/${s.talk.rounds[0].questions[1].id}/answer`, {})).status).toBe(400);
    expect((await call(ann, "POST", `/api/refinement/${id}/questions/${U}/answer`, { option: 1 })).status).toBe(404);
    expect((await call(ann, "POST", `/api/refinement/${id}/proposals/${U}/accept`, {})).status).toBe(404);
    expect((await call(ann, "POST", `/api/refinement/${id}/proposals/${U}/reject`, {})).status).toBe(404);
    expect((await call(ann, "PUT", `/api/refinement/${id}/map/${U}`, { text: "x" })).status).toBe(404);
    expect((await call(ann, "DELETE", `/api/refinement/${id}/map/${U}`)).status).toBe(404);
    expect((await call(ann, "POST", url, undefined, "{nope")).status).toBe(400);
    const p = s.talk.proposals[0].id;
    await call(ann, "POST", `/api/refinement/${id}/proposals/${p}/accept`, {});
    expect((await call(ann, "PUT", `/api/refinement/${id}/map/${p}`, { text: "" })).status).toBe(400);
  });

  it("lets only the owner change it", async () => {
    const id = await make();
    const s = await get(id);
    const q = s.talk.rounds[0].questions[0].id;
    const p = s.talk.proposals[0].id;
    const all = (who: TestSession) => [
      call(who, "POST", `/api/refinement/${id}/questions/${q}/answer`, { option: 1 }),
      call(who, "POST", `/api/refinement/${id}/proposals/${p}/accept`, {}),
      call(who, "POST", `/api/refinement/${id}/proposals/${p}/reject`, {}),
      call(who, "PUT", `/api/refinement/${id}/map/${p}`, { text: "x" }),
      call(who, "DELETE", `/api/refinement/${id}/map/${p}`),
    ];
    for (const r of await Promise.all(all(bob))) expect([r.status, r.error()]).toEqual([404, "no such refinement session"]);
    for (const r of await Promise.all(all(admin))) expect([r.status, r.error()]).toEqual([403, "only the owner can change this session"]);
    const read = await call(admin, "GET", `/api/refinement/${id}`);
    expect(read.status).toBe(200);
    expect(read.json().talk.proposals).toHaveLength(2);
  });

  it("refuses everything for a dropped session, and works again after a restore", async () => {
    const id = await make();
    const s = await get(id);
    const q = s.talk.rounds[0].questions[0].id;
    const p = s.talk.proposals[0].id;
    await call(ann, "POST", `/api/refinement/${id}/drop`, {});
    expect((await call(ann, "POST", `/api/refinement/${id}/questions/${q}/answer`, { option: 1 })).status).toBe(409);
    expect((await call(ann, "POST", `/api/refinement/${id}/proposals/${p}/accept`, {})).status).toBe(409);
    expect((await call(ann, "POST", `/api/refinement/${id}/proposals/${p}/reject`, {})).status).toBe(409);
    expect((await call(ann, "PUT", `/api/refinement/${id}/map/${p}`, { text: "x" })).status).toBe(409);
    expect((await call(ann, "DELETE", `/api/refinement/${id}/map/${p}`)).status).toBe(409);
    await call(ann, "POST", `/api/refinement/${id}/restore`, {});
    expect((await call(ann, "POST", `/api/refinement/${id}/questions/${q}/answer`, { option: 1 })).status).toBe(200);
  });

  it("hides the talk while the repository is not in My repositories", async () => {
    const id = await make();
    const s = await get(id);
    const q = s.talk.rounds[0].questions[0].id;
    const p = s.talk.proposals[0].id;
    await call(ann, "PUT", `/api/refinement/${id}`, { title: "Renamed" });
    const rec = listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;
    removeRepo(ann.user.id, rec.id);
    const got = await get(id);
    expect(got).toMatchObject({ talkHidden: true, repoAvailable: false });
    expect(got.talk).toBeUndefined();
    for (const l of got.log.filter((x: any) => x.what === "question")) expect(l.detail).toBeUndefined();
    expect(got.log.find((x: any) => x.what === "renamed").detail).toBe("Renamed");
    for (const r of [
      await call(ann, "POST", `/api/refinement/${id}/questions/${q}/answer`, { option: 1 }),
      await call(ann, "POST", `/api/refinement/${id}/proposals/${p}/accept`, {}),
      await call(ann, "POST", `/api/refinement/${id}/proposals/${p}/reject`, {}),
      await call(ann, "PUT", `/api/refinement/${id}/map/${p}`, { text: "x" }),
      await call(ann, "DELETE", `/api/refinement/${id}/map/${p}`),
    ]) expect([r.status, r.error()]).toEqual([409, "the repository is not in My repositories any more"]);
    addRepo(ann.user.id, "acme/app");
    const back = await get(id);
    expect(back.talk.proposals).toHaveLength(2);
    expect(back.talkHidden).toBeUndefined();
    expect(back.log.find((x: any) => x.what === "question").detail).toBe("Who uses it?");
  });

  it("shows the empty talk for a session without one whose repository is gone", async () => {
    const s = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "An idea" })).json();
    removeRepo(ann.user.id, listRepos(ann.user.id)[0]!.id);
    const got = await get(s.id);
    expect(got.talkHidden).toBeUndefined();
    expect(got.talk.proposals).toEqual([]);
  });

  it("answers a full list with a plain sentence", async () => {
    const id = await make();
    const s = await get(id);
    const p = s.talk.proposals[0].id;
    const f = stored();
    f.sessions[0].talk.map.rules = Array.from({ length: 100 }, (_, i) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, text: `r${i}`, at: new Date().toISOString() }));
    writeFileSync(refinementsPath(), JSON.stringify(f));
    const r = await call(ann, "POST", `/api/refinement/${id}/proposals/${p}/accept`, {});
    expect(r.status).toBe(400);
    expect(r.error()).toContain("full");
    expect((await get(id)).talk.proposals).toHaveLength(2);
  });

  it("keeps the talk after a restart and starts no work", async () => {
    const id = await make();
    const s = await get(id);
    await call(ann, "POST", `/api/refinement/${id}/questions/${s.talk.rounds[0].questions[0].id}/answer`, { text: "Mine" });
    await call(ann, "POST", `/api/refinement/${id}/proposals/${s.talk.proposals[0].id}/accept`, {});
    const before = await get(id);
    started!.close();
    await wait(50);
    await boot();
    const again = await signInAs(base, { email: "ann@example.com", name: "Ann", role: "user" });
    const after = await get(id, again);
    expect(after.talk).toEqual(before.talk);
    expect(after.log).toEqual(before.log);
    expect(existsSync(join(tmp, "runs"))).toBe(false);
  });
});
