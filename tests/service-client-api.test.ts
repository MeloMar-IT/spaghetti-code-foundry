import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditPath, latestAudit, type AuditRecord } from "../src/auth/audit.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// The audit line of a service account's change, with its status and the X-SCF-Client label, over HTTP (#877).

const SCOPE = ["GET runs", "POST runs/:id/cancel", "POST your-turn/act"];
let tmp: string;
let runs: string;
let base: string;
let close: () => void;
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let robot: { id: string; token: string };

const JSON_HEADERS = { "content-type": "application/json" };
const asAdmin = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: admin.headers(method, JSON_HEADERS), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const withToken = (method: string, path: string, client?: string, body?: unknown) =>
  fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${robot.token}`, ...(client !== undefined ? { "x-scf-client": client } : {}), ...(body === undefined ? {} : JSON_HEADERS) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const audit = async () => (await latestAudit({ action: "service-request" }, 200)).records;

/** Waits for exactly one more line than `before`, and gives it. */
async function nextLine(before: number): Promise<AuditRecord> {
  let lines: AuditRecord[] = [];
  await vi.waitFor(async () => {
    lines = await audit();
    expect(lines.length).toBe(before + 1);
  });
  return lines[0]!;
}

function plant(id: string, owner: string, status: string) {
  const runDir = join(runs, id);
  mkdirSync(runDir, { recursive: true });
  const at = "2026-10-01T10:00:00.000Z";
  saveRun({
    runId: id, flow: "issue-gitflow", task: "t", vars: { github_repo: "acme/app", issue: "5" }, repo: "/x", status, owner, source: "ui",
    runDir, startedAt: at, finishedAt: at, totalCostUsd: 0, flowDef: { name: "issue-gitflow", steps: [] }, state: { next: null, steps: {}, visits: {} }, history: [],
  } as unknown as RunSummary);
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "svc-client-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  runs = join(tmp, "runs");
  mkdirSync(runs, { recursive: true });
  kc = fakeKeychain();
  ({ close, base } = await startTestServer({ repo: tmp, runsDir: runs, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, accountSweepMs: 3_600_000 }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  plant("r-ann", ann.user.id, "succeeded");
  const r = await asAdmin("POST", "/api/service-accounts", { name: "Robot", scope: SCOPE, actsFor: ann.user.id });
  expect(r.status).toBe(201);
  const body = await json(r);
  robot = { id: body.account.id, token: body.token };
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("a change by a service account", () => {
  it("writes one ok line for an accepted cancel, with the status, the person and the label", async () => {
    const before = (await audit()).length;
    const r = await withToken("POST", "/api/runs/r-ann/cancel", "Kitchen tablet");
    expect(r.status).toBe(200);
    expect(await json(r)).toHaveProperty("cancelled");
    const line = await nextLine(before);
    expect(line).toMatchObject({ by: robot.id, result: "ok", target: "POST runs/:id/cancel", detail: `200; acts for ${ann.user.id}; client Kitchen tablet` });
  });

  it("writes one failed line with the status when the handler refuses an act, and no body text", async () => {
    const before = (await audit()).length;
    const r = await withToken("POST", "/api/your-turn/act", "phone", { key: "nope", action: "explode", text: "secret answer text" });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const line = await nextLine(before);
    expect(line).toMatchObject({ result: "failed", target: "POST your-turn/act", detail: `${r.status}; acts for ${ann.user.id}; client phone` });
    const file = readFileSync(auditPath(), "utf8");
    expect(file).not.toContain("explode");
    expect(file).not.toContain("secret answer text");
    expect(file).not.toContain(robot.token);
  });

  it("still writes the failed line of a refusal, with the label", async () => {
    const before = (await audit()).length;
    const r = await withToken("POST", "/api/runs/r-ann/resume", "phone");
    expect(r.status).toBe(403);
    const line = await nextLine(before);
    expect(line.result).toBe("failed");
    expect(line.detail).toMatch(/^403 .*; client phone$/);
  });

  it("cleans the label: control characters go, a long one is cut to 64, and the request is not refused", async () => {
    const before = (await audit()).length;
    const r = await withToken("POST", "/api/runs/r-ann/cancel", "ab\tcd" + "x".repeat(100));
    expect(r.status).toBe(200);
    const label = (await nextLine(before)).detail!.split("; client ")[1]!;
    expect(label).toBe("abcd" + "x".repeat(60));
  });

  it("keeps the ok line of a read before the handler, with the label only when sent", async () => {
    let before = (await audit()).length;
    expect((await withToken("GET", "/api/runs", "phone")).status).toBe(200);
    expect(await nextLine(before)).toMatchObject({ result: "ok", target: "GET runs", detail: `acts for ${ann.user.id}; client phone` });
    before = before + 1;
    expect((await withToken("GET", "/api/runs", "   ")).status).toBe(200);
    expect((await nextLine(before)).detail).toBe(`acts for ${ann.user.id}`);
  });
});

describe("the client filter of the audit API", () => {
  it("keeps only the lines whose label holds the text, in any case, and shows the label", async () => {
    const shown = await json(await asAdmin("GET", "/api/audit?client=KITCHEN"));
    expect(shown.entries.length).toBeGreaterThan(0);
    for (const e of shown.entries) expect(e.client).toBe("Kitchen tablet");
    const csv = await (await asAdmin("GET", "/api/audit/export?client=kitchen")).text();
    expect(csv).toContain("client Kitchen tablet");
    expect(csv).not.toContain("client phone");
  });

  it("answers 400 for a blank or repeated client filter", async () => {
    expect((await asAdmin("GET", "/api/audit?client=%20")).status).toBe(400);
    expect((await asAdmin("GET", "/api/audit?client=a&client=b")).status).toBe(400);
  });
});
