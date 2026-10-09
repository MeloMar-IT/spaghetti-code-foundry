import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { limitsPath } from "../src/auth/limits.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const INTERNAL = "the account list is not working; see the server log";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const savedHome = process.env.FACTORY_HOME;
let kc: FakeKeychain;
let tmp: string;
let base: string;
let close: () => void;
let admin: TestSession;
let ann: TestSession;
const logs: string[] = [];

beforeAll(async () => {
  kc = fakeKeychain();
  tmp = mkdtempSync(join(tmpdir(), "limits-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  for (let i = 0; ; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    try {
      const started = await startServer({ repo, runsDir: join(tmp, "runs"), port, claudeBin, watchers: false, log: (m) => logs.push(m), accountSweepMs: 3_600_000 });
      base = `http://127.0.0.1:${port}`;
      close = started.close;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
    }
  }
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
});
afterAll(() => {
  close();
  kc.remove();
  rmSync(tmp, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

const call = async (who: TestSession, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
};
const limitLines = () =>
  existsSync(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.action === "limits-change") : [];
const file = () => (existsSync(limitsPath()) ? readFileSync(limitsPath(), "utf8") : "");

describe("limits API", () => {
  it("starts with no limits and does not create the file", async () => {
    const r = await call(admin, "GET", "/api/users/limits");
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ defaults: {}, users: {} });
    expect(file()).toBe("");
  });

  it("sets and clears defaults and overrides, keeping fields that are not named", async () => {
    let r = await call(admin, "PUT", "/api/users/limits", { maxConcurrent: 2, maxRunsPerDay: 10 });
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ defaults: { maxConcurrent: 2, maxRunsPerDay: 10 }, users: {} });
    r = await call(admin, "PUT", `/api/users/${ann.user.id}/limits`, { maxConcurrent: 5, dailyBudgetUsd: 7.5 });
    expect(r.status).toBe(200);
    expect(r.json().users).toEqual({ [ann.user.id]: { maxConcurrent: 5, dailyBudgetUsd: 7.5 } });
    r = await call(admin, "PUT", `/api/users/${ann.user.id}/limits`, { maxConcurrent: null });
    expect(r.json().users).toEqual({ [ann.user.id]: { dailyBudgetUsd: 7.5 } });
    expect((await call(admin, "GET", "/api/users/limits")).json()).toEqual({ defaults: { maxConcurrent: 2, maxRunsPerDay: 10 }, users: { [ann.user.id]: { dailyBudgetUsd: 7.5 } } });
    r = await call(admin, "PUT", `/api/users/${ann.user.id}/limits`, { dailyBudgetUsd: null });
    expect(r.json().users).toEqual({});
    r = await call(admin, "PUT", "/api/users/limits", { maxRunsPerDay: null });
    expect(r.json().defaults).toEqual({ maxConcurrent: 2 });
  });

  it("an admin can raise their own limit", async () => {
    const r = await call(admin, "PUT", `/api/users/${admin.user.id}/limits`, { maxConcurrent: 50 });
    expect(r.status).toBe(200);
    expect(r.json().users[admin.user.id]).toEqual({ maxConcurrent: 50 });
    await call(admin, "PUT", `/api/users/${admin.user.id}/limits`, { maxConcurrent: null });
  });

  it("refuses bad input without a change or an audit line", async () => {
    const before = file();
    const lines = limitLines().length;
    for (const body of [{ maxConcurrent: 0 }, { x: 1 }, { dailyBudgetUsd: "5" }, []]) {
      expect((await call(admin, "PUT", "/api/users/limits", body)).status).toBe(400);
      expect((await call(admin, "PUT", `/api/users/${ann.user.id}/limits`, body)).status).toBe(400);
    }
    expect(file()).toBe(before);
    expect(limitLines()).toHaveLength(lines);
    for (const id of [UNKNOWN, "nope"]) {
      const r = await call(admin, "PUT", `/api/users/${id}/limits`, {});
      expect([r.status, r.json().error]).toEqual([404, "no such account"]);
    }
    const plain = await fetch(`${base}/api/users/limits`, { method: "PUT", headers: { ...admin.headers("PUT"), "content-type": "text/plain" }, body: "{}" });
    expect(plain.status).toBe(415);
    const { "x-csrf-token": _drop, ...noCsrf } = admin.headers("PUT") as Record<string, string>;
    const bare = await fetch(`${base}/api/users/limits`, { method: "PUT", headers: { ...noCsrf, "content-type": "application/json" }, body: "{}" });
    expect(bare.status).toBe(403);
  });

  it("a user cannot read or change limits, and no user answer holds them", async () => {
    const before = file();
    for (const [m, p, b] of [["GET", "/api/users/limits"], ["PUT", "/api/users/limits", {}], ["PUT", `/api/users/${ann.user.id}/limits`, {}]] as [string, string, unknown?][]) {
      const r = await call(ann, m, p, b);
      expect([m, p, r.status, r.json()]).toEqual([m, p, 403, { error: "not allowed for your role" }]);
    }
    expect(file()).toBe(before);
    await call(admin, "PUT", "/api/users/limits", { maxConcurrent: 3, maxRunsPerDay: 4, dailyBudgetUsd: 5 });
    for (const p of ["/api/session", "/api/runs", "/api/queue", "/api/repos", "/api/credentials"]) {
      const r = await call(ann, "GET", p);
      expect(r.text, p).not.toMatch(/maxConcurrent|maxRunsPerDay|dailyBudgetUsd/);
    }
    await call(admin, "PUT", "/api/users/limits", { maxConcurrent: null, maxRunsPerDay: null, dailyBudgetUsd: null });
  });

  it("writes one audit line per change, with field names and no amounts", async () => {
    const start = limitLines().length;
    await call(admin, "PUT", "/api/users/limits", { maxConcurrent: 2, dailyBudgetUsd: 5.5 });
    await call(admin, "PUT", "/api/users/limits", { maxConcurrent: 2 }); // no change: no line
    await call(admin, "PUT", `/api/users/${ann.user.id}/limits`, { maxRunsPerDay: 8 });
    const lines = limitLines().slice(start);
    expect(lines).toEqual([
      expect.objectContaining({ by: admin.user.id, result: "ok", target: "defaults", detail: "maxConcurrent, dailyBudgetUsd" }),
      expect.objectContaining({ by: admin.user.id, result: "ok", target: ann.user.id, detail: "maxRunsPerDay" }),
    ]);
    // The amount must not appear in a line; the time stamp is left out, as "…:55.5…" holds "5.5" by chance.
    expect(JSON.stringify(lines.map(({ time: _time, ...rest }) => rest))).not.toMatch(/5\.5/);
    const r = await call(admin, "GET", "/api/audit?action=limits-change");
    expect(r.status).toBe(200);
    expect(r.text).toContain("limits-change");
  });

  it("keeps the account view at ten keys", async () => {
    const r = await call(admin, "GET", "/api/users");
    for (const u of r.json()) expect(Object.keys(u)).toHaveLength(10);
  });

  it("a broken limits.json gives a plain 500 and the account list still works", async () => {
    const good = file();
    writeFileSync(limitsPath(), "not-json");
    for (const [m, p, b] of [["GET", "/api/users/limits"], ["PUT", "/api/users/limits", { maxConcurrent: 1 }]] as [string, string, unknown?][]) {
      const r = await call(admin, m, p, b);
      expect([r.status, r.json().error]).toEqual([500, INTERNAL]);
    }
    expect(logs).toContain("users: limits.json not-json");
    expect((await call(admin, "GET", "/api/users")).status).toBe(200);
    writeFileSync(limitsPath(), good);
  });

  it("deleting an account removes its override", async () => {
    const cy = await signInAs(base, { name: "Cy", email: "cy@example.com", role: "user" });
    await call(admin, "PUT", `/api/users/${cy.user.id}/limits`, { maxConcurrent: 4 });
    expect((await call(admin, "GET", "/api/users/limits")).json().users[cy.user.id]).toEqual({ maxConcurrent: 4 });
    expect((await call(admin, "DELETE", `/api/users/${cy.user.id}`)).status).toBe(200);
    expect((await call(admin, "GET", "/api/users/limits")).json().users[cy.user.id]).toBeUndefined();
  });
});
