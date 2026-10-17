import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { helpTurnsOf } from "../src/server/api-help.js";
import { stateId } from "../src/server/help-evidence.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { freePort } from "./helpers/remote.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let tmp: string;
let saved: Record<string, string | undefined>;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const settings = (text: string) => writeFileSync(join(process.env.FACTORY_HOME!, "config.yaml"), text);
const ON = "default_model: sonnet\nhelp:\n  enabled: true\n  actions: true\n";

beforeAll(async () => {
  saved = { home: process.env.FACTORY_HOME, help: process.env.FAKE_HELP };
  tmp = mkdtempSync(join(tmpdir(), "help-actions-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  settings(ON);
  kc = fakeKeychain();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  started = await startServer({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => undefined });
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
});
afterEach(() => {
  delete process.env.FAKE_HELP;
  settings(ON);
  started!.ctx.reloadConfig();
});
afterAll(() => {
  started?.close();
  kc.remove();
  for (const [k, env] of [["home", "FACTORY_HOME"], ["help", "FAKE_HELP"]] as const) {
    if (saved[k] === undefined) delete process.env[env];
    else process.env[env] = saved[k];
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function call(who: TestSession, method: string, path: string, body?: unknown, type = "application/json") {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": type } : {}), ...who.headers(method) }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}

let n = 0;
/** A stopped run of Ann, and a finished answer of Ask SCF that proposes to cancel it. */
async function proposed() {
  const runId = `r-api-${++n}`;
  const runDir = join(tmp, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  saveRun({
    runId, flow: "quick", task: "t", vars: {}, repo: "/x", status: "stopped", reason: "interrupted", runDir, owner: ann.user.id,
    startedAt: "2026-03-01T09:00:00.000Z", finishedAt: "2026-03-01T09:30:00.000Z", totalCostUsd: 0, history: [],
    flowDef: { name: "quick", steps: [] }, state: { next: "a", steps: {}, visits: {} },
  } as unknown as RunSummary);
  const id = stateId("run", runId);
  process.env.FAKE_HELP = JSON.stringify({ type: "status", summary: "It is stopped.", certainty: "confirmed", evidence: [id], actions: [{ id: "cancel-run", title: "x", impact: "x", source: id }] });
  const r = await call(ann, "POST", "/api/help/conversations", { question: "Can you cancel it?", context: { page: `#/runs/${runId}`, kind: "run", id: runId } });
  expect(r.status, r.text).toBe(202);
  await helpTurnsOf(started!.ctx).idle();
  const c = (await call(ann, "GET", `/api/help/conversations/${r.json().id}`)).json();
  const reply = c.messages[1];
  expect(reply.reply.actions, JSON.stringify(reply.reply)).toHaveLength(1);
  return { runId, conversation: c.id as string, message: reply.id as string };
}
const auditLines = async () => (await call(admin, "GET", "/api/audit?action=help-action")).json().entries as { result: string; detail?: string; target: unknown }[];

describe("approved actions over HTTP", () => {
  it("previews, confirms and reads the result back; the conversation and the audit log hold it", async () => {
    const p = await proposed();
    const before = (await auditLines()).length;
    const prev = await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions`, { message: p.message, index: 0 });
    expect(prev.status, prev.text).toBe(200);
    const { token, expiresAt, preview } = prev.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
    expect(preview).toMatchObject({ action: "cancel-run", about: { kind: "run", id: p.runId }, impactLevel: "high", undoable: false, who: "Only the owner of the run. An administrator too can do this only for their own runs." });

    // another account cannot use Ann's token, and it is not burned by that: it does not fit, so it is burned
    const other = await call(bob, "POST", `/api/help/conversations/${p.conversation}/actions/confirm`, { token, message: p.message, index: 0 });
    expect(other.status).toBe(409);
    const burned = await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions/confirm`, { token, message: p.message, index: 0 });
    expect(burned.status).toBe(409);

    const again = (await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions`, { message: p.message, index: 0 })).json();
    const done = await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions/confirm`, { token: again.token, message: p.message, index: 0 });
    expect(done.status, done.text).toBe(200);
    expect(done.json()).toMatchObject({ stored: true, outcome: { action: "cancel-run", result: "done", seen: "cancelled" } });

    const c = (await call(ann, "GET", `/api/help/conversations/${p.conversation}`)).json();
    expect(c.messages[1].outcomes).toHaveLength(1);
    expect(c.messages[1].outcomes[0].result).toBe("done");
    const lines = await auditLines();
    // two refused confirms (Bob's, and Ann's with the burned token) and the one that ran
    expect(lines.length).toBe(before + 3);
    expect(lines[0]).toMatchObject({ result: "ok", detail: `cancel-run; run ${p.runId}; done` });
    expect(JSON.stringify(lines)).not.toContain(again.token);
  });

  it("drops a token on request", async () => {
    const p = await proposed();
    const { token } = (await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions`, { message: p.message, index: 0 })).json();
    expect((await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions/cancel`, { token })).json()).toEqual({ cancelled: true });
    expect((await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions/confirm`, { token, message: p.message, index: 0 })).status).toBe(409);
  });

  it("a body that cannot be read is refused with its status and audited once, without its text", async () => {
    const p = await proposed();
    const url = `/api/help/conversations/${p.conversation}/actions/confirm`;
    const cases: [string, () => Promise<{ status: number }>][] = [
      ["malformed", () => call(ann, "POST", url, "{ SECRET-BODY-TEXT", "application/json")],
      ["text", () => call(ann, "POST", url, "SECRET-BODY-TEXT", "text/plain")],
      ["large", () => call(ann, "POST", url, JSON.stringify({ own: "x".repeat(1_100_000) }))],
    ];
    const want = { malformed: 400, text: 415, large: 413 } as Record<string, number>;
    for (const [name, send] of cases) {
      const before = (await auditLines()).length;
      expect((await send()).status, name).toBe(want[name]);
      const lines = await auditLines();
      expect(lines.length, name).toBe(before + 1);
      expect(lines[0], name).toMatchObject({ result: "failed", detail: "refused: bad-request" });
    }
    expect(JSON.stringify(await auditLines())).not.toContain("SECRET-BODY-TEXT");
  });

  it("is refused with 503 while help.actions is off, and with 404 for another account's conversation", async () => {
    const p = await proposed();
    expect((await call(bob, "POST", `/api/help/conversations/${p.conversation}/actions`, { message: p.message, index: 0 })).status).toBe(404);
    expect((await call(ann, "POST", `/api/help/conversations/${UNKNOWN}/actions`, { message: UNKNOWN, index: 0 })).status).toBe(404);
    settings("default_model: sonnet\nhelp:\n  enabled: true\n  actions: false\n");
    started!.ctx.reloadConfig();
    expect((await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions`, { message: p.message, index: 0 })).status).toBe(503);
    expect((await call(ann, "POST", `/api/help/conversations/${p.conversation}/actions/confirm`, { token: "A".repeat(43), message: p.message, index: 0 })).status).toBe(503);
  });
});
