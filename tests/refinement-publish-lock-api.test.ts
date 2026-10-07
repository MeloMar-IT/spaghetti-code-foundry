import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
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
let ann: TestSession;
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_GH_FAIL_CREATE_AT", "FAKE_GH_FAIL_TEXT"];

const serverOptions = (): ServerOptions => ({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 });

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-publish-lock-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  delete process.env.FAKE_GH_SLEEP;
  delete process.env.FAKE_BRIEF;
  delete process.env.FAKE_GH_FAIL_CREATE_AT;
  kc = fakeKeychain();
  started = await startServer(serverOptions());
  await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  gh.setLabels(["bug"]);
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (id: string) => (await call(ann, "GET", `/api/refinement/${id}`)).json();
async function until(id: string, test: (s: any) => boolean) {
  for (let i = 0; i < 300; i++) {
    const s = await get(id);
    if (test(s)) return s;
    await wait(100);
  }
  throw new Error(`timed out: ${JSON.stringify((await get(id)).architect)}`);
}
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;
const annRepo = () => listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;
const file = () => readFileSync(refinementsPath(), "utf8");
const stored = (id: string) => JSON.parse(file()).sessions.find((s: any) => s.id === id);
const publish = (id: string, body: unknown = {}) => call(ann, "POST", url(id, "publish"), body);
const waitFor = async (test: () => boolean) => {
  for (let i = 0; i < 200 && !test(); i++) await wait(50);
};
const creating = () => gh.ghLog().includes("issues -X POST");

const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It exports a file" }] };
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

async function session(idea = "Export a report as CSV") {
  setRepoReady(annRepo().id, { items: LIST2 });
  return (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea })).json().id as string;
}
async function addDraft(id: string, fields: Record<string, unknown> = FULL) {
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts.at(-1).id as string;
  expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(200);
  return did;
}
async function withDraft(idea?: string) {
  const id = await session(idea);
  return { id, did: await addDraft(id) };
}
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};

describe("while a publish runs", () => {
  it("refuses a second publish of the same session, and the first one finishes", async () => {
    const { id } = await withDraft();
    const release = gh.hold("issues -X POST");
    const first = publish(id);
    await waitFor(creating);
    expect((await publish(id)).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(gh.bugIssues()).toHaveLength(1);
  });

  it("refuses every change of the session, and the issue has the text from before", async () => {
    const { id, did } = await withDraft("CLAUDE_LIMIT please");
    // a paused read of the session
    expect((await call(ann, "POST", url(id, "architect"))).status).toBe(202);
    await until(id, (s) => s.architect.state === "paused");
    const before = file();
    const release = gh.hold("issues -X POST");
    const pending = publish(id);
    await waitFor(creating);
    const tries: [string, string, unknown?][] = [
      ["PUT", `drafts/${did}`, { title: "Changed" }],
      ["DELETE", `drafts/${did}`],
      ["POST", "drafts"],
      ["PUT", "epic", { issue: 5 }],
      ["POST", `questions/${UNKNOWN}/answer`, { answer: "yes" }],
      ["PUT", `map/${UNKNOWN}`, { text: "x" }],
      ["DELETE", `map/${UNKNOWN}`],
      ["PUT", "", { title: "Renamed" }],
      ["POST", "drop"],
      ["POST", "architect"],
      ["POST", `drafts/${did}/suggest`, { field: "what" }],
    ];
    for (const [method, path, body] of tries) {
      const r = await call(ann, method, path ? url(id, path) : `/api/refinement/${id}`, body);
      expect([method, path, r.status]).toEqual([method, path, 409]);
    }
    expect(file()).toBe(before);
    // the paused read stays paused: a refused drop does not cancel it
    expect((await get(id)).architect.state).toBe("paused");
    release();
    expect((await pending).status).toBe(200);
    const made = gh.createdBodies();
    expect(made).toHaveLength(1);
    expect(made[0]!.title).toBe("Export");
    expect(made[0]!.body).toContain("to export a report");
  });

  it("lets the session be renamed again once it is over", async () => {
    const { id } = await withDraft();
    expect((await publish(id)).status).toBe(200);
    expect((await call(ann, "PUT", `/api/refinement/${id}`, { title: "Renamed" })).status).toBe(200);
  });
});

describe("the architect", () => {
  it("makes a publish wait while a run is queued or running", async () => {
    const { id } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    expect((await call(ann, "POST", url(id, "architect"))).status).toBe(202);
    const r = await publish(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/architect/);
    expect(gh.createdBodies()).toEqual([]);
    started!.ctx.scheduler.cancel((await get(id)).architect.runId);
    await until(id, (s) => s.architect.state === "failed");
  });

  it("does not make a publish wait while a run is paused", async () => {
    const { id } = await withDraft("CLAUDE_LIMIT please");
    expect((await call(ann, "POST", url(id, "architect"))).status).toBe(202);
    await until(id, (s) => s.architect.state === "paused");
    expect((await publish(id)).status).toBe(200);
    expect(stored(id).state).toBe("published");
  });

  it("takes in the end of a run that finished but was not stored, and publishes what it made ready", async () => {
    // the default list: the draft is ready only by the architect's judgement
    const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report as CSV" })).json().id as string;
    await call(ann, "POST", url(id, "architect"));
    await until(id, (s) => s.architect.state === "idle");
    const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts[0].id as string;
    expect((await call(ann, "PUT", url(id, `drafts/${did}`), FULL)).status).toBe(200);
    expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(202);
    await until(id, (s) => s.architect.state === "idle");
    started!.close();
    edit((f) => {
      const s = f.sessions[0];
      s.drafts[0].readiness.items = s.drafts[0].readiness.items.map((i: any) => (i.by === "architect" ? { id: i.id, text: i.text, result: "unsure", reason: "The architect has to judge this.", by: "code" } : i));
      s.state = "drafting";
      s.log = s.log.filter((l: any) => !["ready-asked", "architect-judged"].includes(l.what));
      s.updated = "2020-01-01T00:00:00.000Z";
    });
    started = await startServer(serverOptions());
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().created).toHaveLength(1);
    expect((await get(id)).architect.state).toBe("idle");
  });
});

describe("after publishing", () => {
  it("refuses every change of the draft, naming the issue", async () => {
    const { id, did } = await withDraft();
    expect((await publish(id)).status).toBe(200);
    const before = file();
    const tries: [string, string, unknown?][] = [
      ["PUT", `drafts/${did}`, { title: "Changed" }],
      ["DELETE", `drafts/${did}`],
      ["POST", `drafts/${did}/ready-check`],
      ["PUT", `drafts/${did}/review-label`, { add: true }],
      ["POST", `drafts/${did}/move-to-notes`, {}],
      ["POST", `drafts/${did}/ready/value/accept`, { reason: "fine" }],
      ["DELETE", `drafts/${did}/ready/value/accept`],
      ["POST", `drafts/${did}/suggestions/${UNKNOWN}/accept`, {}],
      ["POST", `drafts/${did}/suggestions/${UNKNOWN}/reject`, {}],
      ["POST", `drafts/${did}/suggest`, { field: "what" }],
      ["POST", `drafts/${did}/review`],
      ["POST", `drafts/${did}/impact`],
      ["POST", `drafts/${did}/split`, {}],
    ];
    for (const [method, path, body] of tries) {
      const r = await call(ann, method, url(id, path), body);
      expect([method, path, r.status]).toEqual([method, path, 409]);
      expect(r.error()).toContain("#101");
    }
    expect((await call(ann, "POST", url(id, "drafts"))).status).toBe(409);
    expect(file()).toBe(before);
  });
});

describe("partly published", () => {
  async function partly() {
    const id = await session();
    const a = await addDraft(id, { ...FULL, title: "One" });
    const b = await addDraft(id, { ...FULL, title: "Two" });
    const rule = { id: randomUUID(), text: "Reports are CSV", at: new Date().toISOString() };
    const free = { id: randomUUID(), text: "Reports are small", at: new Date().toISOString() };
    edit((f) => {
      const s = f.sessions[0];
      s.talk = { rounds: [], proposals: [], map: { rules: [rule, free], examples: [], open: [] }, asked: [] };
      s.drafts[0].criteria[0].tie = rule.id;
    });
    process.env.FAKE_GH_FAIL_CREATE_AT = "2";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL_CREATE_AT;
    expect(stored(id).drafts[0].published.issue).toBe(101);
    return { id, a, b, rule, free };
  }

  it("still changes the draft that has no issue", async () => {
    const { id, b } = await partly();
    expect((await call(ann, "PUT", url(id, `drafts/${b}`), { what: "to export another report" })).status).toBe(200);
    expect((await call(ann, "PUT", url(id, `drafts/${b}/review-label`), { add: true })).status).toBe(200);
    expect((await call(ann, "POST", url(id, `drafts/${b}/ready-check`))).status).toBe(200);
    expect((await call(ann, "POST", url(id, "drafts"))).status).toBe(201);
  });

  it("refuses the Epic", async () => {
    const { id } = await partly();
    const r = await call(ann, "PUT", url(id, "epic"), { issue: 5 });
    expect(r.status).toBe(409);
    expect(r.error()).toContain("#101");
  });

  it("refuses to remove a map entry the published draft is tied to, and removes another", async () => {
    const { id, rule, free } = await partly();
    const r = await call(ann, "DELETE", url(id, `map/${rule.id}`));
    expect(r.status).toBe(409);
    expect(r.error()).toContain("#101");
    expect((await call(ann, "DELETE", url(id, `map/${free.id}`))).status).toBe(200);
  });

  it("still changes the text of a tied entry, and the published draft stays as it was", async () => {
    const { id, rule } = await partly();
    const draft = JSON.stringify(stored(id).drafts[0]);
    expect((await call(ann, "PUT", url(id, `map/${rule.id}`), { text: "Reports are CSV files" })).status).toBe(200);
    expect(JSON.stringify(stored(id).drafts[0])).toBe(draft);
  });

  it("is published when the draft without an issue is removed", async () => {
    const { id, b } = await partly();
    expect(stored(id).state).not.toBe("published");
    expect((await call(ann, "DELETE", url(id, `drafts/${b}`))).status).toBe(200);
    expect(stored(id).state).toBe("published");
  });
});
