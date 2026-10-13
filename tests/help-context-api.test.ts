import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserByEmail, setStatus } from "../src/auth/users.js";
import { BAD_CONTEXT, CONTEXT_MAX, SELECTION_MAX } from "../src/help/context.js";
import { HelpTurns } from "../src/help/turn.js";
import { helpResolver } from "../src/server/api-help.js";
import { startServer } from "../src/server/server.js";
import type { ClaudeRunOptions } from "../src/steps/claude.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { freePort } from "./helpers/remote.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let tmp: string;
let runsDir: string;
let saved: string | undefined;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>>;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;

const writeRun = (id: string, owner: string, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify({ runId: id, flow: "deliver", task: "", vars: {}, repo: tmp, source: "ui", status: "failed", runDir: join(runsDir, id), owner, startedAt: "2026-01-01T00:00:00.000Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...extra }));
};
async function call(who: TestSession, body: unknown, path = "/api/help/context") {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...who.headers("POST") }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "help-context-api-"));
  runsDir = join(tmp, "runs");
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  writeFileSync(join(process.env.FACTORY_HOME, "config.yaml"), "default_model: sonnet\nhelp:\n  enabled: true\n");
  kc = fakeKeychain();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  started = await startServer({ repo: tmp, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  writeRun("run-ann-1", ann.user.id);
  writeRun("run-bob-1", bob.user.id);
});
afterAll(() => {
  started?.close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("POST /api/help/context", () => {
  it("shows what would be taken: the envelope, its size, the page and the things found for the account", async () => {
    const r = await call(ann, { page: "#/runs/run-ann-1", filters: { status: "failed" }, selection: "x".repeat(SELECTION_MAX + 100) });
    expect(r.status, r.text).toBe(200);
    const j = r.json();
    expect(j.context).toMatchObject({ page: "#/runs/run-ann-1", filters: { status: "failed" }, truncated: ["selection"] });
    expect(j.size).toBeLessThanOrEqual(CONTEXT_MAX);
    expect(j.limits).toMatchObject({ size: CONTEXT_MAX, selectionChars: SELECTION_MAX, keptFirst: ["page", "entities", "filters", "selection"] });
    expect(j.page).toEqual({ type: "run", title: "Run" });
    expect(j.things).toEqual([{ kind: "run", id: "run-ann-1", label: "a run of the flow deliver" }]);
    expect(j.notFound).toBe(0);
  });

  it("answers the same for another account's run and for a run that does not exist", async () => {
    const forged = (await call(ann, { page: "#/runs/run-bob-1", kind: "run", id: "run-bob-1" })).json();
    const missing = (await call(ann, { page: "#/runs/run-non-1", kind: "run", id: "run-non-1" })).json();
    expect(forged.things).toEqual([]);
    expect(forged.notFound).toBe(1);
    expect({ ...forged, context: null }).toEqual({ ...missing, context: null });
    // the owner and an administrator find it
    expect((await call(bob, { page: "#/runs/run-bob-1" })).json().things).toHaveLength(1);
    expect((await call(admin, { page: "#/runs/run-bob-1" })).json().things).toHaveLength(1);
    // a page of the other role is no page
    expect((await call(ann, { page: "#/users" })).json().page).toBeNull();
    expect((await call(admin, { page: "#/users" })).json().page).toEqual({ type: "users", title: "Users" });
    expect((await call(ann, { page: "#/inbox" })).json().page).toBeNull();
  });

  it("refuses what an envelope cannot hold, and is not answered in a preview", async () => {
    for (const bad of [{ page: "#/runs", owner: bob.user.id }, { page: "#/runs", role: "admin" }, { page: "#/runs", html: "<main/>" }, { page: "#/runs", kind: "run", id: "/etc/passwd" }, { page: "#/runs", selection: "<b>x</b>" }, { page: "https://example.test" }, {}]) {
      const r = await call(ann, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(r.json().error).toBe(BAD_CONTEXT);
    }
    expect((await call(admin, { page: "#/runs" }, `/api/help/context?as=${ann.user.id}`)).status).toBe(403);
  });
});

describe("the lookup of the server", () => {
  it("uses the rule of the run's own call, reads the account now, and feeds a turn only what it found", async () => {
    const lookup = helpResolver(started.ctx);
    const A = { id: ann.user.id, role: "user" as const };
    expect(lookup(A, { kind: "run", id: "run-ann-1" })).toEqual({ label: "a run of the flow deliver" });
    for (const id of ["run-bob-1", "run-none-1", "../run-bob-1", "run-bob-1/../run-ann-1", ""]) expect(lookup(A, { kind: "run", id }), id).toBeUndefined();
    // a run whose file names another owner than its folder's queue entry is not hers either
    writeRun("run-copy-1", bob.user.id, { runId: "run-ann-1" });
    expect(lookup(A, { kind: "run", id: "run-copy-1" })).toBeUndefined();
    for (const kind of ["issue", "repository", "queue", "refinement", "problem"] as const) expect(lookup({ id: admin.user.id, role: "admin" }, { kind, id: "x" }), kind).toBeUndefined();
    // a role claimed in the question does not count: the account is read now
    expect(lookup({ id: ann.user.id, role: "admin" }, { kind: "run", id: "run-bob-1" })).toBeUndefined();
    expect(lookup({ id: "99999999-9999-4999-8999-999999999999", role: "admin" }, { kind: "run", id: "run-bob-1" })).toBeUndefined();

    const calls: ClaudeRunOptions[] = [];
    const turns = new HelpTurns({ config: started.ctx.config, resolve: lookup, run: async (o) => (calls.push(o), { ok: true, output: JSON.stringify({ summary: "It failed." }), costUsd: 0 }) });
    turns.ask(A, { question: "What is happening here?", context: { page: "#/runs/run-bob-1", kind: "run", id: "run-bob-1", entities: [{ kind: "run", id: "run-ann-1" }] } });
    await turns.idle();
    expect(calls[0]!.prompt).not.toContain("run-bob-1");
    expect(calls[0]!.prompt).toContain('"things":[{"kind":"run","id":"run-ann-1","label":"a run of the flow deliver"}],"notFound":1');

    // a blocked account finds nothing, whatever it owned
    await setStatus(findUserByEmail("ann@example.com")!.id, "blocked");
    expect(lookup(A, { kind: "run", id: "run-ann-1" })).toBeUndefined();
  });
});
