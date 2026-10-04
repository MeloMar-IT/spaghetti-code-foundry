import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
import { refinementsPath } from "../src/refinement/store.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const HEADINGS = ["What already exists", "Code the idea would touch", "Open issues that overlap", "Rules that apply", "Could not find out"];

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF"];

async function boot() {
  const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
}

beforeEach(async () => {
  gh = fakeGithub();
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-architect-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  delete process.env.FAKE_GH_SLEEP;
  delete process.env.FAKE_BRIEF;
  kc = fakeKeychain();
  await boot();
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
  // After a restart the first call may find the old connection closed.
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const make = async (who = ann, repo = "acme/app", idea = "Export a report as CSV") => (await call(who, "POST", "/api/refinement", { repo, idea })).json().id as string;
const ask = (id: string, who = ann) => call(who, "POST", `/api/refinement/${id}/architect`);
const get = async (id: string, who = ann) => (await call(who, "GET", `/api/refinement/${id}`)).json();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(id: string, test: (s: any) => boolean, who = ann) {
  for (let i = 0; i < 300; i++) {
    const s = await get(id, who);
    if (test(s)) return s;
    await wait(100);
  }
  throw new Error(`timed out: ${JSON.stringify((await get(id, who)).architect)}`);
}
const idle = (id: string, who = ann) => until(id, (s) => s.architect.state === "idle", who);
const failed = (id: string, who = ann) => until(id, (s) => s.architect.state === "failed", who);
const paused = (id: string) => until(id, (s) => s.architect.state === "paused");
const runDir = (runId: string) => join(tmp, "runs", runId);
const runJson = (runId: string) => JSON.parse(readFileSync(join(runDir(runId), "run.json"), "utf8"));
const runIds = () => (existsSync(join(tmp, "runs")) ? readdirSync(join(tmp, "runs")) : []);
const dropRepo = () => removeRepo(ann.user.id, listRepos(ann.user.id).find((r) => r.url.includes("acme/app"))!.id);
const stored = () => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions as any[];

describe("start", () => {
  it("queues a run of refine-brief for the session, with no published flow", async () => {
    const id = await make();
    const r = await ask(id);
    expect(r.status).toBe(202);
    const s = r.json();
    expect(["queued", "running"]).toContain(s.architect.state);
    if (s.architect.state === "running") expect(s.architect.doing).toBeTruthy();
    const run = runJson(s.architect.runId);
    expect(run).toMatchObject({ flow: "refine-brief", source: `refinement ${id}`, owner: ann.user.id, task: "Export a report as CSV", vars: { github_repo: "acme/app" } });
    expect((await call(ann, "GET", "/api/flows")).json().filter((f: any) => f.name === "refine-brief")).toEqual([]);
    await idle(id);
  });

  it("stores the brief with the session and leaves the architect idle", async () => {
    const id = await make();
    const { architect } = (await ask(id)).json();
    const s = await idle(id);
    expect(s.brief).toMatchObject({ runId: architect.runId, branch: "main", at: expect.any(String) });
    for (const h of HEADINGS) expect(s.brief.text).toContain(`## ${h}`);
    expect(s.log.map((l: any) => l.what)).toEqual(["created", "architect-started", "architect-brief"]);
    expect(stored()[0].architect).toBeUndefined();
  });

  it("is refused for another user (404), an admin (403) and a dropped session or removed repository (409), and starts nothing", async () => {
    const id = await make();
    expect((await ask(id, bob)).status).toBe(404);
    expect((await ask(id, admin)).status).toBe(403);
    expect((await ask("00000000-0000-4000-8000-000000000000", admin)).status).toBe(404);
    expect(runIds()).toEqual([]);
    dropRepo();
    expect((await ask(id)).status).toBe(409);
    addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    await call(ann, "POST", `/api/refinement/${id}/drop`);
    expect((await ask(id)).status).toBe(409);
    expect(runIds()).toEqual([]);
  });
});

describe("one at a time", () => {
  it("refuses a second start while it runs, and in another session of the account; another account can start", async () => {
    process.env.FAKE_GH_SLEEP = "1";
    const a = await make();
    const b = await make();
    const c = await make(bob, "other/thing");
    await ask(a);
    const s = await until(a, (x) => x.architect.state === "running");
    expect(s.architect.doing).toBe("Clone the repository into repo/ and check out develop (or the default branch)");
    expect((await ask(a)).status).toBe(409);
    expect((await ask(b)).status).toBe(409);
    expect((await ask(c, bob)).status).toBe(202);
    await idle(a);
    await idle(c, bob);
    expect((await ask(b)).status).toBe(202);
    await idle(b);
  });

  it("refuses a second start while queued, and tells the queue which session it is for", async () => {
    const id = await make();
    started!.ctx.scheduler.drain();
    const { architect } = (await ask(id)).json();
    expect(architect.state).toBe("queued");
    expect((await ask(id)).status).toBe(409);
    const own = (await call(ann, "GET", "/api/queue")).json().pending;
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ runId: architect.runId, refinement: id });
    expect(own[0]).not.toHaveProperty("source");
    const all = (await call(admin, "GET", "/api/queue")).json().pending;
    expect(all[0]).toMatchObject({ refinement: id, source: `refinement ${id}` });
  });

  it("refuses generic resume, approve and reject for architect runs and queues nothing", async () => {
    process.env.FAKE_GH_SLEEP = "1";
    const a = await make();
    const b = await make();
    const { architect } = (await ask(a)).json();
    await until(a, (x) => x.architect.state === "running");
    for (const who of [ann, admin]) {
      for (const action of ["resume", "approve", "reject"]) expect((await call(who, "POST", `/api/runs/${architect.runId}/${action}`, {})).status).toBe(409);
    }
    expect((await ask(b)).status).toBe(409);
    await idle(a);
    expect(readdirSync(join(tmp, "runs"))).toEqual([architect.runId]);
  });
});

describe("refresh", () => {
  it("keeps the old brief until the new run has succeeded", async () => {
    const id = await make();
    await ask(id);
    const first = (await idle(id)).brief;
    process.env.FAKE_GH_SLEEP = "1";
    const { architect } = (await ask(id)).json();
    expect((await get(id)).brief).toEqual(first);
    const s = await idle(id);
    expect(s.brief.runId).toBe(architect.runId);
    expect(s.brief.runId).not.toBe(first.runId);
  });

  it("keeps the old brief when the new read fails, and says why in plain words", async () => {
    const id = await make();
    await ask(id);
    const first = (await idle(id)).brief;
    process.env.FAKE_BRIEF = "Just some words";
    await ask(id);
    const s = await failed(id);
    expect(s.brief).toEqual(first);
    expect(s.architect.reason).toBe("The brief did not have its five parts");
    expect(JSON.stringify(s.architect)).not.toMatch(/\$|\/|claude|opus/i);
    // a failed read can be asked again
    delete process.env.FAKE_BRIEF;
    await ask(id);
    expect((await idle(id)).brief.runId).not.toBe(first.runId);
  });

  it("says that the token was refused", async () => {
    process.env.FAKE_GH_EXPECT_TOKEN = "another";
    const id = await make();
    await ask(id);
    const s = await failed(id);
    expect(s.architect.reason).toMatch(/^GitHub refused the token of this repository/);
    expect(s.brief).toBeUndefined();
  });

  it("shows a read that is cancelled as failed", async () => {
    process.env.FAKE_GH_SLEEP = "2";
    const id = await make();
    const { architect } = (await ask(id)).json();
    await until(id, (x) => x.architect.state === "running");
    expect((await call(ann, "POST", `/api/runs/${architect.runId}/cancel`)).json()).toEqual({ cancelled: true });
    expect((await failed(id)).architect.reason).toBe("It was cancelled");
  });
});

describe("paused", () => {
  it("resumes a read paused by a usage limit with the same call, in the same run", async () => {
    const id = await make(ann, "acme/app", "CLAUDE_LIMIT please");
    const first = (await ask(id)).json().architect.runId;
    const s = await paused(id);
    expect(s.architect).toMatchObject({ runId: first, reason: "The usage limit was reached; ask again later" });
    expect(JSON.stringify(s.architect)).not.toMatch(/\$|claude|opus|model/i);
    const other = await make();
    expect((await ask(other)).status).toBe(409); // a paused read holds the account
    expect((await call(ann, "POST", `/api/runs/${first}/resume`, {})).status).toBe(409);
    const r = await ask(id);
    expect(r.status).toBe(202);
    expect(r.json().architect.runId).toBe(first);
    await paused(id);
    expect(runJson(first).resumes).toBe(1);
    expect(runIds()).toEqual([first]);
  });

  it("resumes a read paused by a sign-out", async () => {
    const id = await make(ann, "acme/app", "CLAUDE_SIGNED_OUT please");
    const first = (await ask(id)).json().architect.runId;
    expect((await paused(id)).architect.reason).toBe("The Foundry is signed out of its AI account; ask the administrator, then ask again");
    expect((await ask(id)).json().architect.runId).toBe(first);
    await paused(id);
    expect(runJson(first).resumes).toBe(1);
  });

  it("resumes a read paused by the daily budget once the budget is raised", async () => {
    const config = (await call(admin, "GET", "/api/config")).json();
    // another account's read spends first; then the budget is lower than that
    await ask(await make(bob, "other/thing"), bob);
    await started!.ctx.scheduler.idle();
    expect((await call(admin, "PUT", "/api/config", { ...config, cost_limits: true, daily_budget_usd: 0.005, notify: { macos: false } })).status).toBe(200);
    const id = await make();
    const first = (await ask(id)).json().architect.runId;
    expect((await paused(id)).architect.reason).toBe("The administrator's limit for today was reached; ask again tomorrow");
    expect((await call(admin, "PUT", "/api/config", { ...config, cost_limits: true, daily_budget_usd: 50, notify: { macos: false } })).status).toBe(200);
    expect((await ask(id)).json().architect.runId).toBe(first);
    const s = await idle(id);
    expect(s.brief.runId).toBe(first);
  });

  it("drops a paused read with its session: the run is cancelled and cannot be resumed", async () => {
    const id = await make(ann, "acme/app", "CLAUDE_LIMIT please");
    const first = (await ask(id)).json().architect.runId;
    await paused(id);
    expect((await call(ann, "POST", `/api/refinement/${id}/drop`)).status).toBe(200);
    expect(runJson(first)).toMatchObject({ status: "cancelled", reason: "cancelled by user" });
    expect((await call(ann, "POST", `/api/runs/${first}/resume`, {})).status).toBe(409);
    const s = (await call(ann, "POST", `/api/refinement/${id}/restore`)).json();
    expect(s.architect).toMatchObject({ state: "failed", reason: "It was cancelled" });
    const again = (await ask(id)).json();
    expect(again.architect.runId).not.toBe(first);
  });
});

describe("restart", () => {
  it("takes in a run that ended while the server was down", async () => {
    const id = await make();
    const { architect } = (await ask(id)).json();
    const done = await idle(id);
    started!.close();
    const file = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete file.sessions[0].brief;
    file.sessions[0].architect = { runId: architect.runId, at: done.brief.at };
    writeFileSync(refinementsPath(), JSON.stringify(file));
    await boot();
    expect((await get(id)).brief).toMatchObject({ runId: architect.runId });
  });

  it("takes in a run the session never recorded (the server stopped after queueing it)", async () => {
    const id = await make();
    const { architect } = (await ask(id)).json();
    await idle(id);
    started!.close();
    const file = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete file.sessions[0].brief;
    file.sessions[0].updated = "2020-01-01T00:00:00.000Z";
    writeFileSync(refinementsPath(), JSON.stringify(file));
    await boot();
    const s = await get(id);
    expect(s.brief).toMatchObject({ runId: architect.runId });
    expect(s.architect.state).toBe("idle");
  });

  it("marks a run that was running when the server died as failed", async () => {
    const id = await make();
    const runId = "20260101-000000-dead";
    mkdirSync(join(tmp, "runs", runId), { recursive: true });
    writeFileSync(join(tmp, "runs", runId, "run.json"), JSON.stringify({
      runId, flow: "refine-brief", flowDef: { name: "refine-brief", steps: [] }, task: "t", vars: {}, repo: tmp, status: "running", runDir: join(tmp, "runs", runId),
      startedAt: new Date().toISOString(), totalCostUsd: 0, history: [], state: { next: "clone", steps: {}, visits: {} }, pid: 999999, source: `refinement ${id}`, owner: ann.user.id,
    }));
    started!.close();
    const file = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    file.sessions[0].architect = { runId, at: new Date().toISOString() };
    writeFileSync(refinementsPath(), JSON.stringify(file));
    await boot();
    expect((await get(id)).architect).toEqual({ state: "failed", runId, reason: "The server stopped while the architect was reading" });
  });
});

describe("drop and delete", () => {
  it("cancels a running read when the session is dropped", async () => {
    process.env.FAKE_GH_SLEEP = "2";
    const id = await make();
    const { architect } = (await ask(id)).json();
    await until(id, (x) => x.architect.state === "running");
    expect((await call(ann, "POST", `/api/refinement/${id}/drop`)).status).toBe(200);
    for (let i = 0; i < 100 && runJson(architect.runId).status === "running"; i++) await wait(100);
    expect(runJson(architect.runId).status).toBe("cancelled");
    expect((await call(ann, "POST", `/api/refinement/${id}/restore`)).json().architect.reason).toBe("It was cancelled");
  });

  it("takes a queued read out of the queue when the session is dropped", async () => {
    const id = await make();
    started!.ctx.scheduler.drain();
    await ask(id);
    await call(ann, "POST", `/api/refinement/${id}/drop`);
    expect((await call(ann, "GET", "/api/queue")).json().pending).toEqual([]);
    expect((await call(ann, "POST", `/api/refinement/${id}/restore`)).json().architect).toMatchObject({ state: "failed", reason: "It was cancelled" });
  });

  it("cancels a running read when the account is deleted", async () => {
    process.env.FAKE_GH_SLEEP = "2";
    const id = await make();
    const { architect } = (await ask(id)).json();
    await until(id, (x) => x.architect.state === "running");
    expect((await call(admin, "DELETE", `/api/users/${ann.user.id}`)).status).toBe(200);
    for (let i = 0; i < 100 && runJson(architect.runId).status === "running"; i++) await wait(100);
    expect(runJson(architect.runId).status).toBe("cancelled");
  });

  it("cancels a paused read when the account is deleted", async () => {
    const id = await make(ann, "acme/app", "CLAUDE_LIMIT please");
    const first = (await ask(id)).json().architect.runId;
    await paused(id);
    expect((await call(admin, "DELETE", `/api/users/${ann.user.id}`)).status).toBe(200);
    expect(runJson(first)).toMatchObject({ status: "cancelled", reason: "cancelled by user" });
  });

  it("drops the queued read when the account is deleted", async () => {
    const id = await make();
    started!.ctx.scheduler.drain();
    await ask(id);
    expect((await call(admin, "DELETE", `/api/users/${ann.user.id}`)).status).toBe(200);
    expect(stored().filter((s) => s.id === id)).toEqual([]);
    expect((await call(admin, "GET", "/api/queue")).json().pending).toEqual([]);
  });
});

describe("where the read shows", () => {
  it("is in the Runs list, statistics, and nowhere else", async () => {
    const id = await make();
    const { architect } = (await ask(id)).json();
    await idle(id);
    const mine = (await call(ann, "GET", "/api/runs")).json();
    expect(mine.map((r: any) => r.runId)).toEqual([architect.runId]);
    expect(mine[0]).toMatchObject({ refinement: id, flow: "refine-brief" });
    expect(JSON.stringify(mine[0])).not.toContain("totalCostUsd");
    const all = (await call(admin, "GET", "/api/runs")).json();
    expect(all[0]).toMatchObject({ refinement: id, totalCostUsd: expect.any(Number) });
    expect((await call(admin, "GET", "/api/stats")).json().byFlow.map((f: any) => f.flow)).toContain("refine-brief");
    expect((await call(admin, "GET", "/api/board")).text).not.toContain(architect.runId);
    expect((await call(admin, "GET", "/api/your-turn")).text).not.toContain(architect.runId);
    expect((await call(admin, "GET", "/api/since?since=2000-01-01T00:00:00Z")).status).toBe(200);
    expect(gh.ghLog()).not.toContain("gh pr list");
  });

  it("hides the failure of a run that fails from Your turn", async () => {
    process.env.FAKE_BRIEF = "Just some words";
    const id = await make();
    const { architect } = (await ask(id)).json();
    await failed(id);
    expect((await call(admin, "GET", "/api/your-turn")).text).not.toContain(architect.runId);
  });
});

describe("the flow name", () => {
  const copyOf = (name: string) => `name: ${name}\nworkspace: empty\nvars: {github_repo: ""}\npublish:\n  enabled: true\n  vars:\n    github_repo: {mode: input}\nsteps:\n  - {id: a, type: shell, run: "true"}\n`;

  it.each(["refine-brief", "refine-round"])("%s cannot be started through POST /api/runs by a user, also when an admin published a copy", async (name) => {
    const body = { flow: name, vars: { github_repo: "acme/app" } };
    expect((await call(ann, "POST", "/api/runs", body)).status).toBe(404);
    const saved = await call(admin, "PUT", `/api/flows/${name}`, { yaml: copyOf(name), scope: "repo" });
    expect([saved.status, saved.text]).toEqual([200, expect.any(String)]);
    expect((await call(ann, "GET", "/api/flows")).json().filter((f: any) => f.name === name)).toEqual([]);
    expect((await call(ann, "POST", "/api/runs", body)).status).toBe(404);
    expect((await call(admin, "POST", "/api/runs", { flow: name, task: "x", vars: { github_repo: "acme/app" } })).status).toBe(201);
  });
});

describe("the repository leaves My repositories", () => {
  it("hides the brief while the repository is not there, and shows it again after", async () => {
    const id = await make();
    await ask(id);
    await idle(id);
    dropRepo();
    const s = await get(id);
    expect(s).not.toHaveProperty("brief");
    expect(s).toMatchObject({ briefHidden: true, repoAvailable: false });
    addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    expect((await get(id)).brief.text).toContain("## What already exists");
  });
});
