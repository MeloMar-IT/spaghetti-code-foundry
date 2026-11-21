import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestAudit } from "../src/auth/audit.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// A service account writes its own audit line over HTTP (#884).

let tmp: string;
let base: string;
let close: () => void;
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
type Account = { id: string; token: string };
let robot: Account;
let reader: Account;
let classy: Account;
let flood: Account;

const JSON_HEADERS = { "content-type": "application/json" };
const asAdmin = (method: string, path: string, body?: unknown) =>
  fetch(base + path, { method, headers: admin.headers(method, JSON_HEADERS), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const line = (a: Account, body: unknown, client?: string) =>
  fetch(base + "/api/audit/service-line", {
    method: "POST",
    headers: { authorization: `Bearer ${a.token}`, ...JSON_HEADERS, ...(client !== undefined ? { "x-scf-client": client } : {}) },
    body: JSON.stringify(body),
  });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const count = async (filter: { action: string; user?: string }) => (await latestAudit(filter, 500)).records.length;

async function account(name: string, scope: string[], actsFor?: string): Promise<Account> {
  const r = await asAdmin("POST", "/api/service-accounts", { name, scope, ...(actsFor ? { actsFor } : {}) });
  expect(r.status).toBe(201);
  const body = await json(r);
  return { id: body.account.id, token: body.token };
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "svc-line-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  const runs = join(tmp, "runs");
  mkdirSync(runs, { recursive: true });
  kc = fakeKeychain();
  ({ close, base } = await startTestServer({ repo: tmp, runsDir: runs, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, accountSweepMs: 3_600_000 }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  robot = await account("Robot", ["POST audit/service-line"], ann.user.id);
  reader = await account("Reader", ["GET runs"]);
  classy = await account("Classy", ["class:admin"]);
  flood = await account("Flood", ["POST audit/service-line"]);
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("POST /api/audit/service-line", () => {
  it("writes one line with the label and the person", async () => {
    const r = await line(robot, { event: "sign-check", result: "refused", code: "bad_signature", detail: "signature did not match" }, "Kitchen tablet");
    expect(r.status).toBe(201);
    expect(await json(r)).toEqual({ written: true });
    const [rec] = (await latestAudit({ action: "service-line" }, 1)).records;
    expect(rec).toMatchObject({
      by: robot.id,
      result: "failed",
      target: "sign-check",
      detail: `refused; code bad_signature; text "signature did not match"; acts for ${ann.user.id}; client Kitchen tablet`,
    });
  });

  it("refuses a person, also an admin, with 403", async () => {
    const body = JSON.stringify({ event: "x", result: "ok" });
    const a = await fetch(base + "/api/audit/service-line", { method: "POST", headers: admin.headers("POST", JSON_HEADERS), body });
    expect(a.status).toBe(403);
    expect((await json(a)).error).toBe("only a service account writes its own audit lines");
    const u = await fetch(base + "/api/audit/service-line", { method: "POST", headers: ann.headers("POST", JSON_HEADERS), body });
    expect(u.status).toBe(403);
  });

  it("refuses an account without the key, also one with class:admin", async () => {
    expect((await line(reader, { event: "x", result: "ok" })).status).toBe(403);
    expect((await line(classy, { event: "x", result: "ok" })).status).toBe(403);
  });

  it("answers 400 for bad fields and writes no line", async () => {
    const before = await count({ action: "service-line" });
    for (const bad of [{ event: "x", result: "ok", more: 1 }, { event: "X", result: "ok" }, { event: "x", result: "maybe" }, { event: "x", result: "ok", code: null }, { event: "x", result: "ok", detail: "a\nb" }]) {
      expect((await line(robot, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(await count({ action: "service-line" })).toBe(before);
  });

  it("answers 429 from the 121st line in a minute, with one dropped line", async () => {
    for (let i = 0; i < 120; i++) expect((await line(flood, { event: "tick", result: "ok" }, "phone")).status).toBe(201);
    const r = await line(flood, { event: "tick", result: "ok" }, "phone");
    expect(r.status).toBe(429);
    const after = Number(r.headers.get("retry-after"));
    expect(after).toBeGreaterThanOrEqual(1);
    expect(after).toBeLessThanOrEqual(60);
    expect((await line(flood, { event: "tick", result: "ok" })).status).toBe(429);
    expect((await line(flood, { event: "tick", result: "ok" })).status).toBe(429);
    expect(await count({ action: "service-line-dropped", user: flood.id })).toBe(1);
    expect(await count({ action: "service-line", user: flood.id })).toBe(120);
  });

  it("shows the lines in GET /api/audit, filtered by action, user and client", async () => {
    const r = await asAdmin("GET", `/api/audit?action=service-line&user=${robot.id}&client=kitchen`);
    expect(r.status).toBe(200);
    const { entries: records } = await json(r);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]).toMatchObject({ action: "service-line", client: "Kitchen tablet", target: { type: "text", text: "sign-check" } });
    const d = await asAdmin("GET", `/api/audit?action=service-line-dropped&client=phone`);
    expect(d.status).toBe(200);
    expect((await json(d)).entries).toHaveLength(1);
  });
});
