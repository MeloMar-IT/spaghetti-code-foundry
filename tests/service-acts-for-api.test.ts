import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestAudit } from "../src/auth/audit.js";
import { addRepo } from "../src/auth/repos.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// A service account that acts for one person, over HTTP with its bearer token (#876): it sees that person's runs and
// repositories and nobody else's, its scope still limits it, it is never an admin, and a person who cannot sign in ends it.

const SCOPE = ["GET runs", "GET repos", "GET health", "GET queue"];
let tmp: string;
let runs: string;
let base: string;
let close: () => void;
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;

const JSON_HEADERS = { "content-type": "application/json" };
const asAdmin = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: admin.headers(method, JSON_HEADERS), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const withToken = (t: string, path = "/api/runs") => fetch(base + path, { headers: { authorization: `Bearer ${t}` } });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const audit = async () => (await latestAudit({ action: "service-request" }, 50)).records;

function plant(id: string, owner: string) {
  const runDir = join(runs, id);
  mkdirSync(runDir, { recursive: true });
  const at = "2026-10-01T10:00:00.000Z";
  saveRun({
    runId: id, flow: "issue-gitflow", task: "t", vars: { github_repo: "acme/app", issue: "5" }, repo: "/x", status: "succeeded", owner, source: "ui",
    runDir, startedAt: at, finishedAt: at, totalCostUsd: 0, flowDef: { name: "issue-gitflow", steps: [] }, state: { next: null, steps: {}, visits: {} }, history: [],
  } as unknown as RunSummary);
}

async function makeAccount(name: string, actsFor?: string, scope = SCOPE) {
  const r = await asAdmin("POST", "/api/service-accounts", { name, scope, ...(actsFor !== undefined ? { actsFor } : {}) });
  expect(r.status).toBe(201);
  const body = await json(r);
  return { id: body.account.id as string, token: body.token as string, body };
}
const runIds = async (token: string) => ((await json(await withToken(token))) as unknown as { runId: string }[]).map((r) => r.runId).sort();

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "svc-acts-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  runs = join(tmp, "runs");
  mkdirSync(runs, { recursive: true });
  kc = fakeKeychain();
  ({ close, base } = await startTestServer({ repo: tmp, runsDir: runs, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, accountSweepMs: 3_600_000 }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  plant("r-ann", ann.user.id);
  plant("r-bob", bob.user.id);
  plant("r-admin", admin.user.id);
  addRepo(ann.user.id, { url: "acme/ann-app" });
  addRepo(bob.user.id, { url: "acme/bob-app" });
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("an account acting for Ann", () => {
  it("sees Ann's runs and repositories, and none of Bob's", async () => {
    const robot = await makeAccount("Robot", ann.user.id);
    expect(await runIds(robot.token)).toEqual(["r-ann"]);
    const repos = (await json(await withToken(robot.token, "/api/repos"))) as unknown as { url: string }[];
    expect(repos.map((r) => r.url)).toEqual(["https://github.com/acme/ann-app"]);
    expect((await withToken(robot.token, "/api/queue")).status).toBe(200);
    // the ok line names the person by id
    expect((await audit())[0]).toMatchObject({ by: robot.id, result: "ok", detail: `acts for ${ann.user.id}` });
  });

  it("without actsFor nothing changes: it owns nothing", async () => {
    const plain = await makeAccount("Plain");
    expect(await runIds(plain.token)).toEqual([]);
    expect((await audit())[0]!.detail).toBeUndefined();
  });

  it("is still limited by its scope", async () => {
    const robot = await makeAccount("Scoped", ann.user.id);
    expect((await withToken(robot.token, "/api/users")).status).toBe(403);
    expect((await withToken(robot.token, "/api/board")).status).toBe(403);
  });

  it("is never an admin, even when the person is one", async () => {
    const robot = await makeAccount("ForAdmin", admin.user.id);
    expect(await runIds(robot.token)).toEqual(["r-admin"]);
    expect((await withToken(robot.token, "/api/notices")).status).toBe(403);
    expect((await withToken(robot.token, "/api/next")).status).toBe(403);
  });

  it("shows the person in the list, with the people an admin may pick", async () => {
    const robot = await makeAccount("Shown", ann.user.id);
    const list = await json(await asAdmin("GET", "/api/service-accounts"));
    expect(list.accounts.find((a: any) => a.id === robot.id)).toMatchObject({ actsFor: ann.user.id, actsForName: "Ann" });
    expect(list.accounts.find((a: any) => a.name === "Plain")).toMatchObject({ actsFor: null, actsForName: null });
    expect(list.people.map((p: any) => p.email).sort()).toEqual(["admin@example.com", "ann@example.com", "bob@example.com"]);
    expect(list.people.some((p: any) => p.id === robot.id)).toBe(false);
  });

  it("is set and cleared through the API; a bad id is 400", async () => {
    const other = await makeAccount("Other");
    expect((await asAdmin("POST", "/api/service-accounts", { name: "Bad1", scope: [], actsFor: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await asAdmin("POST", "/api/service-accounts", { name: "Bad2", scope: [], actsFor: other.id })).status).toBe(400);
    expect((await asAdmin("POST", "/api/service-accounts", { name: "Bad3", scope: [], actsFor: 7 })).status).toBe(400);
    const set = await json(await asAdmin("PUT", `/api/service-accounts/${other.id}`, { actsFor: bob.user.id }));
    expect(set.account).toMatchObject({ actsFor: bob.user.id, actsForName: "Bob" });
    expect(await runIds(other.token)).toEqual(["r-bob"]);
    const cleared = await json(await asAdmin("PUT", `/api/service-accounts/${other.id}`, { actsFor: "" }));
    expect(cleared.account.actsFor).toBeNull();
    expect(await runIds(other.token)).toEqual([]);
  });

  it("answers 403 with a reason while the person is blocked, and is audited as failed", async () => {
    const robot = await makeAccount("Blocked", bob.user.id);
    expect((await asAdmin("POST", `/api/users/${bob.user.id}/block`, {})).status).toBe(200);
    const r = await withToken(robot.token);
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("the person this service account acts for is blocked");
    expect((await audit())[0]).toMatchObject({ by: robot.id, result: "failed", detail: `403 the person this service account acts for is blocked; acts for ${bob.user.id}` });
    const list = await json(await asAdmin("GET", "/api/service-accounts"));
    expect(list.accounts.find((a: any) => a.id === robot.id).actsForProblem).toBe("the person this service account acts for is blocked");
    expect((await asAdmin("POST", `/api/users/${bob.user.id}/unblock`, {})).status).toBe(200);
    expect(await runIds(robot.token)).toEqual(["r-bob"]);
  });

  it("answers 403 after a password reset, and after the person is deleted", async () => {
    const carl = await signInAs(base, { name: "Carl", email: "carl@example.com", role: "user" });
    const robot = await makeAccount("Carlbot", carl.user.id);
    expect((await withToken(robot.token)).status).toBe(200);
    expect((await asAdmin("POST", `/api/users/${carl.user.id}/reset`, {})).status).toBe(200);
    const reset = await withToken(robot.token);
    expect([reset.status, await reset.text()]).toEqual([403, expect.stringContaining("cannot sign in")]);
    expect((await asAdmin("DELETE", `/api/users/${carl.user.id}`)).status).toBe(200);
    const gone = await withToken(robot.token);
    expect([gone.status, await gone.text()]).toEqual([403, expect.stringContaining("no longer exists")]);
  });

  it("a refused plugin-file request names the person too", async () => {
    const robot = await makeAccount("Plugger", ann.user.id);
    expect((await withToken(robot.token, "/plugins/x/y.js")).status).toBe(401);
    expect((await audit())[0]).toMatchObject({ by: robot.id, result: "failed", target: "GET plugin file", detail: `401 a service token does not work here; acts for ${ann.user.id}` });
  });
});

describe("GET /api/health", () => {
  it("has the package version", async () => {
    const robot = await makeAccount("Healthy", ann.user.id);
    const h = await json(await withToken(robot.token, "/api/health"));
    expect(h.package).toBe((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version);
  });
});
