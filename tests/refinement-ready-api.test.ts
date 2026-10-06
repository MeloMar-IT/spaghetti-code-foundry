import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo, setRepoReady } from "../src/auth/repos.js";
import { refinementsPath } from "../src/refinement/store.js";
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
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN"];

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-ready-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
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

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const send = () =>
    fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const get = async (id: string, who = ann) => (await call(who, "GET", `/api/refinement/${id}`)).json();
const stored = () => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions as any[];
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;
const annRepo = () => listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;

const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It exports a file" }] };
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];

async function withDraft(fields: Record<string, unknown> = FULL) {
  const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report as CSV" })).json().id as string;
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts[0].id as string;
  expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  return { id, did };
}
const check = (id: string, did: string, who = ann) => call(who, "POST", url(id, `drafts/${did}/ready-check`));
const accept = (id: string, did: string, item: string, body: unknown = { reason: "Not needed here" }, who = ann) => call(who, "POST", url(id, `drafts/${did}/ready/${item}/accept`), body);
const unaccept = (id: string, did: string, item: string, who = ann) => call(who, "DELETE", url(id, `drafts/${did}/ready/${item}/accept`));

describe("the ready check", () => {
  it("answers 200 with readiness, state and preview, with the default list in order", async () => {
    const { id, did } = await withDraft();
    const r = await check(id, did);
    expect(r.status).toBe(200);
    const d = r.json().drafts[0];
    expect(d.state).toBe("drafting");
    expect(d.readiness.items.map((i: any) => i.id)).toEqual(["value", "standalone", "checkable", "small", "no-open-questions", "out-of-scope", "no-plan"]);
    expect(d.readiness.items.every((i: any) => i.by === "code" && typeof i.reason === "string")).toBe(true);
    expect(d.preview.body).toContain("### Out of scope");
    expect(stored()[0].drafts[0].readiness.items).toHaveLength(7);
  });

  it("follows the rules of the other draft calls", async () => {
    const { id, did } = await withDraft();
    expect((await check(id, did, bob)).status).toBe(404);
    expect((await check(id, did, admin)).status).toBe(403);
    expect((await check(id, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await call(ann, "POST", url(id, "drop"))).status).toBe(200);
    expect((await check(id, did)).status).toBe(409);
    await call(ann, "POST", url(id, "restore"));
    removeRepo(ann.user.id, annRepo().id);
    expect((await check(id, did)).status).toBe(409);
  });
});

describe("accepted anyway", () => {
  it("round trip, with the preview section and views without `at`", async () => {
    const { id, did } = await withDraft({ title: "Export" });
    await check(id, did);
    const a = await accept(id, did, "value", { reason: "The value is in the epic" });
    expect(a.status).toBe(200);
    const d = a.json().drafts[0];
    expect(d.acceptedAnyway).toEqual([{ id: "value", text: expect.any(String), reason: "The value is in the epic" }]);
    expect(d.preview.body).toMatch(/### Accepted anyway\n- the value is clear \(who and why\): The value is in the epic$/);
    expect(stored()[0].drafts[0].acceptedAnyway[0].at).toEqual(expect.any(String));
    expect(d.readiness).not.toHaveProperty("by");
    const r = await unaccept(id, did, "value");
    expect(r.status).toBe(200);
    expect(r.json().drafts[0].acceptedAnyway).toBeUndefined();
    expect(r.json().drafts[0].preview.body).not.toContain("Accepted anyway");
    expect(whats(r.json())).toEqual(expect.arrayContaining(["ready-checked", "ready-accepted", "ready-unaccepted"]));
  });

  it("refuses the plan item, an unknown item and a missing reason", async () => {
    const { id, did } = await withDraft();
    const plan = await accept(id, did, "no-plan");
    expect(plan.status).toBe(409);
    expect(plan.error()).toMatch(/implementation plan cannot be accepted anyway/);
    expect((await accept(id, did, "nope")).status).toBe(404);
    expect((await accept(id, did, "value", {})).status).toBe(400);
    expect((await unaccept(id, did, "nope")).status).toBe(404);
  });

  it("follows the owner rules", async () => {
    const { id, did } = await withDraft();
    expect((await accept(id, did, "value", { reason: "x" }, bob)).status).toBe(404);
    expect((await accept(id, did, "value", { reason: "x" }, admin)).status).toBe(403);
    expect((await unaccept(id, did, "value", bob)).status).toBe(404);
    expect((await unaccept(id, did, "value", admin)).status).toBe(403);
  });
});

describe("the ready state", () => {
  it("a ready draft makes the session ready, and a save makes it drafting again", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const { id, did } = await withDraft();
    const r = (await check(id, did)).json();
    expect(r.drafts[0].state).toBe("ready");
    expect(r.state).toBe("ready");
    const put = (await call(ann, "PUT", url(id, `drafts/${did}`), { title: "Other" })).json();
    expect(put.drafts[0].readiness).toBeUndefined();
    expect(put.drafts[0].state).toBe("drafting");
    expect(put.state).toBe("drafting");
  });

  it("a list the admin changed is seen on the next read, and the stored state is corrected", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const { id, did } = await withDraft();
    expect((await check(id, did)).json().state).toBe("ready");
    expect(stored()[0].state).toBe("ready");
    setRepoReady(annRepo().id, { items: [...LIST2, { text: "legal agreed" }] });
    const s = await get(id);
    expect(s.state).toBe("drafting");
    expect(s.drafts[0].state).toBe("drafting");
    expect(s.drafts[0].readiness.stale).toBe(true);
    expect(stored()[0].state).toBe("drafting");
  });
});

const whats = (s: any) => s.log.map((l: any) => l.what);
