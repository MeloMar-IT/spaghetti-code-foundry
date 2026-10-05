import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
import { refinementsPath } from "../src/refinement/store.js";
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
  tmp = mkdtempSync(join(tmpdir(), "refinement-draft-api-"));
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

const make = async () => (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "An idea" })).json().id as string;
const get = async (id: string, who = ann) => (await call(who, "GET", `/api/refinement/${id}`)).json();
const addD = async (id: string) => (await call(ann, "POST", `/api/refinement/${id}/drafts`)).json().drafts.at(-1).id as string;
const put = (id: string, did: string, body: unknown) => call(ann, "PUT", `/api/refinement/${id}/drafts/${did}`, body);
const U = "99999999-9999-4999-8999-999999999999";
const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "I can share it", criteria: [{ text: "It downloads" }], outOfScope: "PDF", notes: "Old API" };

describe("story drafts over the API", () => {
  it("adds, saves and removes, with a preview", async () => {
    const id = await make();
    const fresh = await get(id);
    expect(fresh.drafts).toEqual([]);
    expect("epic" in fresh).toBe(false);
    const r = await call(ann, "POST", `/api/refinement/${id}/drafts`);
    expect(r.status).toBe(201);
    const d = r.json().drafts.at(-1);
    expect(d.preview.body).toBe("As …, I want …, so that ….\n\n### Acceptance criteria\n\n### Depends on\nNone (can be built on its own).");
    const s = await put(id, d.id, FULL);
    expect(s.status).toBe(200);
    expect(s.json().drafts[0].preview.body).toBe(
      "As an admin, I want to export a report, so that I can share it.\n\n### Acceptance criteria\n- [ ] It downloads\n\n### Out of scope\nPDF\n\n### Notes for the builder\nOld API\n\n### Depends on\nNone (can be built on its own).",
    );
    expect(s.json().drafts[0].preview.title).toBe("Export");
    const e = await call(ann, "PUT", `/api/refinement/${id}/epic`, { issue: 73 });
    expect(e.status).toBe(200);
    expect(e.json().epic).toBe(73);
    expect(e.json().drafts[0].preview.body.startsWith("**Epic:** #73\n\nAs an admin")).toBe(true);
    const del = await call(ann, "DELETE", `/api/refinement/${id}/drafts/${d.id}`);
    expect(del.status).toBe(200);
    expect(del.json().drafts).toEqual([]);
    const log = (await get(id)).log.slice(1);
    expect(log).toEqual([
      { at: expect.any(String), what: "draft-added", who: "Ann" },
      { at: expect.any(String), what: "epic-set", who: "Ann", detail: "#73" },
      { at: expect.any(String), what: "draft-removed", who: "Ann", detail: "Export" },
    ]);
  });

  it("moves the state to drafting and back", async () => {
    const id = await make();
    expect((await get(id)).state).toBe("exploring");
    const d = await addD(id);
    expect((await get(id)).state).toBe("drafting");
    await call(ann, "DELETE", `/api/refinement/${id}/drafts/${d}`);
    expect((await get(id)).state).toBe("exploring");
  });

  it("refuses other users and admins, before looking at the fields", async () => {
    const id = await make();
    const d = await addD(id);
    const all = (who: TestSession, did = d) => [
      call(who, "POST", `/api/refinement/${id}/drafts`),
      call(who, "PUT", `/api/refinement/${id}/drafts/${did}`, { title: "x".repeat(121) }),
      call(who, "DELETE", `/api/refinement/${id}/drafts/${did}`),
      call(who, "PUT", `/api/refinement/${id}/epic`, { issue: "x" }),
    ];
    for (const did of [d, U]) {
      for (const r of await Promise.all(all(bob, did))) expect([r.status, r.error()]).toEqual([404, "no such refinement session"]);
      for (const r of await Promise.all(all(admin, did))) expect([r.status, r.error()]).toEqual([403, "only the owner can change this session"]);
    }
    const read = await call(admin, "GET", `/api/refinement/${id}`);
    expect(read.status).toBe(200);
    expect(read.json().drafts).toHaveLength(1);
  });

  it("refuses everything for a dropped session, and works after a restore", async () => {
    const id = await make();
    const d = await addD(id);
    await call(ann, "POST", `/api/refinement/${id}/drop`, {});
    const all = () => [
      () => call(ann, "POST", `/api/refinement/${id}/drafts`),
      () => call(ann, "PUT", `/api/refinement/${id}/drafts/${d}`, { title: "x" }),
      () => call(ann, "DELETE", `/api/refinement/${id}/drafts/${d}`),
      () => call(ann, "PUT", `/api/refinement/${id}/epic`, { issue: 1 }),
    ];
    for (const r of all()) expect((await r()).status).toBe(409);
    await call(ann, "POST", `/api/refinement/${id}/restore`, {});
    for (const r of all()) expect((await r()).status).toBeLessThan(300);
  });

  it("hides the drafts while the repository is not in My repositories", async () => {
    const id = await make();
    const empty = await make();
    const d = await addD(id);
    await put(id, d, { title: "Secret" });
    await call(ann, "PUT", `/api/refinement/${id}/epic`, { issue: 5 });
    await call(ann, "DELETE", `/api/refinement/${id}/drafts/${await addD(id)}`);
    removeRepo(ann.user.id, listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!.id);
    const got = await get(id);
    expect(got.draftsHidden).toBe(true);
    expect(got.drafts).toBeUndefined();
    expect(got.epic).toBe(5);
    expect(got.log.find((l: any) => l.what === "draft-removed").detail).toBeUndefined();
    for (const r of [
      await call(ann, "POST", `/api/refinement/${id}/drafts`),
      await call(ann, "PUT", `/api/refinement/${id}/drafts/${d}`, { title: "x" }),
      await call(ann, "DELETE", `/api/refinement/${id}/drafts/${d}`),
      await call(ann, "PUT", `/api/refinement/${id}/epic`, { issue: 1 }),
    ]) expect([r.status, r.error()]).toEqual([409, "the repository is not in My repositories any more"]);
    const none = await get(empty);
    expect(none.drafts).toEqual([]);
    expect(none.draftsHidden).toBeUndefined();
    addRepo(ann.user.id, "acme/app");
    const back = await get(id);
    expect(back.drafts[0].preview.title).toBe("Secret");
    expect(back.draftsHidden).toBeUndefined();
  });

  it("answers the owner with plain sentences", async () => {
    const id = await make();
    for (let i = 0; i < 20; i++) await addD(id);
    const full = await call(ann, "POST", `/api/refinement/${id}/drafts`);
    expect([full.status, full.error()]).toEqual([400, "at most 20 story drafts"]);
    const d = (await get(id)).drafts[0].id;
    expect((await put(id, d, { title: "x".repeat(121) })).status).toBe(400);
    const nl = await put(id, d, { title: "a b" });
    expect([nl.status, nl.error()]).toEqual([400, "the title must be on one line"]);
    expect((await put(id, U, { title: "x" })).status).toBe(404);
    const bad = await call(ann, "PUT", `/api/refinement/${id}/drafts/${d}`, undefined, "{nope");
    expect([bad.status, bad.error()]).toEqual([400, "invalid JSON body"]);
    expect((await call(ann, "PUT", `/api/refinement/${id}/epic`, { issue: 0 })).status).toBe(400);
  });

  it("keeps drafts and the Epic over a restart", async () => {
    const id = await make();
    const d = await addD(id);
    await put(id, d, { ...FULL, dependsOn: [{ issue: 3 }] });
    await call(ann, "PUT", `/api/refinement/${id}/epic`, { issue: 73 });
    const before = await get(id);
    started!.close();
    await new Promise((r) => setTimeout(r, 50));
    await boot();
    const again = await signInAs(base, { email: "ann@example.com", name: "Ann", role: "user" });
    const after = await get(id, again);
    expect(after.drafts).toEqual(before.drafts);
    expect(after.epic).toBe(73);
    expect(after.log).toEqual(before.log);
    expect(existsSync(join(tmp, "runs"))).toBe(false);
    expect(JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions[0].epic).toBe(73);
  });
});
