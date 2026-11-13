import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditPath, latestAudit } from "../src/auth/audit.js";
import { SERVICE_IDLE_MS } from "../src/auth/service-accounts.js";
import { withAuthLock, writeJsonFile } from "../src/auth/store.js";
import { usersPath } from "../src/auth/users.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// Service accounts over HTTP (#866): bearer sign-in on this computer only, the scope, the audit line of every request, rotate and revoke.

const SCOPE = ["GET runs", "DELETE onboarding/progress", "GET health", "GET help/usage", "POST busy", "GET busy"];
let tmp: string;
let base: string;
let close: () => void;
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let id: string;
let token: string;
const logs: string[] = [];

const JSON_HEADERS = { "content-type": "application/json" };
const asAdmin = (method: string, path: string, body?: unknown, who: TestSession = admin) =>
  fetch(base + path, { method, headers: who.headers(method, JSON_HEADERS), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const withToken = (t: string, method = "GET", path = "/api/runs", extra: Record<string, string> = {}, body?: unknown, cookie?: TestSession) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${t}`, ...(body === undefined ? {} : JSON_HEADERS), ...(cookie ? { cookie: cookie.cookie } : {}), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;
const audit = async () => (await latestAudit({ action: "service-request" }, 100)).records;
const readUsers = () => JSON.parse(readFileSync(usersPath(), "utf8")) as { version: 1; users: any[] };
const writeUsers = (file: unknown) => withAuthLock(() => writeJsonFile(usersPath(), file));
const FORWARDED = { "x-forwarded-for": "203.0.113.9", "x-forwarded-proto": "https" };

/** A service account made through the API. */
async function makeAccount(name: string, scope: string[] = SCOPE) {
  const r = await asAdmin("POST", "/api/service-accounts", { name, scope });
  expect(r.status).toBe(201);
  const body = await json(r);
  return { id: body.account.id as string, token: body.token as string, body };
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "svc-api-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  mkdirSync(join(tmp, "repo"));
  const started = await startTestServer({ repo: join(tmp, "repo"), runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => logs.push(m), accountSweepMs: 3_600_000 });
  base = started.base;
  close = started.close;
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  ({ id, token } = await makeAccount("Robot"));
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("a live token", () => {
  it("shows the token once and stores only its hash", async () => {
    expect(token).toMatch(/^scf_svc_[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(usersPath(), "utf8")).not.toContain(token);
    const list = await json(await asAdmin("GET", "/api/service-accounts"));
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.accounts.find((a: any) => a.id === id)).toMatchObject({ name: "Robot", status: "active", scope: SCOPE, token: "live" });
    expect(list.grantable.some((g: any) => g.key === "GET users")).toBe(false);
  });

  it("answers an in-scope read with no cookie, and an in-scope write with no CSRF header", async () => {
    const r = await withToken(token);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual([]);
    expect((await withToken(token, "DELETE", "/api/onboarding/progress")).status).toBe(200);
  });

  it("answers an admin-only rule that is in the scope, also one that checks the role in its handler", async () => {
    expect((await withToken(token, "GET", "/api/health")).status).toBe(200);
    expect((await withToken(token, "GET", "/api/help/usage")).status).toBe(200);
  });

  it("keeps the CSRF check for a cookie session", async () => {
    const r = await fetch(`${base}/api/onboarding/progress`, { method: "DELETE", headers: { cookie: admin.cookie } });
    expect(r.status).toBe(403);
    expect((await json(r)).error).toBe("bad CSRF token");
  });

  it("writes one ok line per request, with the account as actor, and shows its name in the audit API", async () => {
    const before = (await audit()).length;
    await withToken(token);
    const lines = await audit();
    expect(lines.length).toBe(before + 1);
    expect(lines[0]).toMatchObject({ by: id, action: "service-request", result: "ok", target: "GET runs" });
    const shown = await json(await asAdmin("GET", "/api/audit?action=service-request"));
    expect(shown.entries[0].actor).toEqual({ type: "account", id, name: "Robot" });
    const csv = await (await asAdmin("GET", "/api/audit/export?action=service-request")).text();
    expect(csv).toContain(",Robot,service-request,");
  });

  it("lists the last use and keeps services out of GET /api/users", async () => {
    const list = await json(await asAdmin("GET", "/api/service-accounts"));
    expect(list.accounts.find((a: any) => a.id === id).lastUse).toBeTruthy();
    const people = (await (await asAdmin("GET", "/api/users")).json()) as { id: string }[];
    expect(people.some((p) => p.id === id)).toBe(false);
  });
});

describe("refusals", () => {
  it("answers 403 outside the scope and audits it", async () => {
    const r = await withToken(token, "GET", "/api/repos");
    expect(r.status).toBe(403);
    expect(await audit()).toContainEqual(expect.objectContaining({ by: id, result: "failed", target: "GET repos" }));
    const shown = await json(await asAdmin("GET", "/api/audit?action=service-request"));
    expect(shown.entries.find((e: any) => e.result === "failed" && e.target.text === "GET repos").actor.name).toBe("Robot");
  });

  it("refuses a route that has no rule with 404 and audits it", async () => {
    expect((await withToken(token, "GET", "/api/nope")).status).toBe(404);
    expect((await audit())[0]).toMatchObject({ result: "failed", target: "GET unknown route" });
  });

  it("refuses a connection that is not on this computer, before it says anything about the token", async () => {
    for (const t of [token, "scf_svc_" + "A".repeat(43)]) {
      const r = await withToken(t, "GET", "/api/runs", FORWARDED);
      expect(r.status).toBe(403);
      expect((await json(r)).error).toBe("a service token works only on this computer");
    }
    const lines = await audit();
    expect(lines[0]).toMatchObject({ by: "anonymous", result: "failed", target: "GET runs" });
    expect(lines[1]).toMatchObject({ by: id, result: "failed", target: "GET runs" });
  });

  it("audits a service request that the network guard refuses (plain http from another address), and keeps the guard's 403", async () => {
    // forwarded without https: the guard refuses it before any token is read
    const r = await withToken(token, "GET", "/api/runs", { "x-forwarded-for": "203.0.113.9" });
    expect(r.status).toBe(403);
    expect(await r.text()).toContain("HTTPS required");
    expect(await audit()).toContainEqual(expect.objectContaining({ by: id, result: "failed", target: "GET runs" }));
    const bad = await withToken("scf_svc_" + "C".repeat(43), "GET", "/api/runs", { "x-forwarded-for": "203.0.113.9" });
    expect(bad.status).toBe(403);
    expect((await audit())[0]).toMatchObject({ by: "anonymous", result: "failed", target: "GET runs" });
  });

  it("does not give a bearer the session answer of a cookie account", async () => {
    for (const [method, path, body] of [["GET", "/api/session"], ["POST", "/api/session", { email: "admin@example.com", password: "x" }], ["POST", "/api/setup", { name: "x", email: "x@example.com", password: "x" }], ["POST", "/api/set-password", { token: "x", password: "x" }]] as const) {
      const r = await withToken(token, method, path, {}, body, admin);
      expect(r.status, `${method} ${path}`).toBe(403);
      const text = await r.text();
      expect(text).not.toContain("admin@example.com");
      expect(r.headers.get("set-cookie")).toBeNull();
    }
    const off = await withToken(token, "GET", "/api/session", FORWARDED, undefined, admin);
    expect(off.status).toBe(403);
    expect((await audit())[0]).toMatchObject({ by: id, result: "failed" });
  });

  it("uses the bearer, not a valid cookie that comes with it", async () => {
    // the cookie belongs to an admin who may read users; the service may not
    const r = await withToken(token, "GET", "/api/users", {}, undefined, admin);
    expect(r.status).toBe(403);
    expect(await withToken(token, "GET", "/api/runs", {}, undefined, admin).then((x) => x.status)).toBe(200);
  });

  it("refuses a service token on a plugin file path, audited", async () => {
    const r = await withToken(token, "GET", "/plugins/x/y.js");
    expect(r.status).toBe(401);
    expect((await audit())[0]).toMatchObject({ by: id, result: "failed", target: "GET plugin file" });
  });

  it("ignores an Authorization header that is not a service bearer", async () => {
    const r = await fetch(`${base}/api/runs`, { headers: { authorization: "Basic dXNlcjpwYXNz" } });
    expect(r.status).toBe(401);
    const before = (await audit()).length;
    await fetch(`${base}/api/runs`, { headers: { authorization: "Basic dXNlcjpwYXNz" } });
    expect((await audit()).length).toBe(before);
  });

  it("answers 401 to an unknown token and audits it with no actor", async () => {
    const r = await withToken("scf_svc_" + "B".repeat(43));
    expect(r.status).toBe(401);
    expect((await audit())[0]).toMatchObject({ by: "anonymous", result: "failed", target: "GET runs" });
    expect((await withToken("scf_svc_short")).status).toBe(401);
  });

  it("answers 401 to an expired token, to the millisecond of the last request, and audits it with the account", async () => {
    const made = await makeAccount("Idle");
    expect((await withToken(made.token)).status).toBe(200); // first request: now is the last use
    const file = readUsers();
    const rec = file.users.find((u: any) => u.id === made.id);
    rec.token.created = new Date(Date.now() - SERVICE_IDLE_MS - 5 * 86_400_000).toISOString();
    rec.token.used = new Date(Date.now() - SERVICE_IDLE_MS - 1000).toISOString();
    writeUsers(file);
    expect((await withToken(made.token)).status).toBe(401);
    expect((await audit())[0]).toMatchObject({ by: made.id, result: "failed" });
    const list = await json(await asAdmin("GET", "/api/service-accounts"));
    expect(list.accounts.find((a: any) => a.id === made.id).token).toBe("expired");
    // a refused request does not bring it back
    expect((await withToken(made.token)).status).toBe(401);
  });

  it("answers 503 with Retry-After when the ok line cannot be written, and the handler does nothing", async () => {
    const made = await makeAccount("Writer", ["POST busy", "GET busy"]);
    const busyBefore = await (await asAdmin("GET", "/api/busy")).text();
    // a folder in place of the audit file: the line cannot be written
    rmSync(auditPath(), { force: true });
    mkdirSync(auditPath());
    try {
      const r = await withToken(made.token, "POST", "/api/busy", {}, { hours: 1 });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBe("1");
    } finally {
      rmSync(auditPath(), { recursive: true, force: true });
    }
    expect(await (await asAdmin("GET", "/api/busy")).text()).toBe(busyBefore);
    // the line works again: the same call now goes through
    expect((await withToken(made.token, "POST", "/api/busy", {}, { hours: 1 })).status).toBe(200);
    await withToken(made.token, "GET", "/api/busy");
    await asAdmin("DELETE", "/api/busy");
  });
});

describe("management", () => {
  it("is for admins only", async () => {
    expect((await asAdmin("GET", "/api/service-accounts", undefined, ann)).status).toBe(403);
    expect((await asAdmin("POST", "/api/service-accounts", { name: "x", scope: [] }, ann)).status).toBe(403);
    expect((await withToken(token, "GET", "/api/service-accounts")).status).toBe(403);
  });

  it("refuses a scope with a route that can never be granted, on create and on change, and names it", async () => {
    for (const key of ["GET users", "POST repos/:id/publish-remote", "GET audit/export", "GET credentials", "PUT config", "POST autonomy/promote", "GET plugins", "POST service-accounts"]) {
      const r = await asAdmin("POST", "/api/service-accounts", { name: `bad ${key}`, scope: ["GET runs", key] });
      expect(r.status, key).toBe(400);
      expect((await json(r)).error).toContain(`"${key}" can never be granted`);
      const put = await asAdmin("PUT", `/api/service-accounts/${id}`, { scope: [key] });
      expect(put.status, key).toBe(400);
    }
    expect((await asAdmin("POST", "/api/service-accounts", { name: "w", scope: ["GET *"] })).status).toBe(400);
    expect((await json(await asAdmin("GET", "/api/service-accounts"))).accounts.find((a: any) => a.id === id).scope).toEqual(SCOPE);
  });

  it("still refuses a never-grantable route that was written into users.json by hand", async () => {
    const made = await makeAccount("Hand", ["GET runs"]);
    const file = readUsers();
    file.users.find((u: any) => u.id === made.id).scope = ["GET users", "POST repos/:id/publish-remote"];
    writeUsers(file);
    expect((await withToken(made.token, "GET", "/api/users")).status).toBe(403);
    expect((await withToken(made.token, "POST", "/api/repos/x/publish-remote", {}, {})).status).toBe(403);
  });

  it("never makes an admin, a password or a link for a service", async () => {
    for (const [method, path, body] of [["PUT", `/api/users/${id}`, { role: "admin" }], ["POST", `/api/users/${id}/link`, {}], ["POST", `/api/users/${id}/reset`, {}]] as const) {
      expect((await asAdmin(method, path, body)).status, `${method} ${path}`).toBe(409);
    }
    const me = await withToken(token, "GET", "/api/me/view");
    expect(me.status).toBe(403); // not in the scope
    const list = await json(await asAdmin("GET", "/api/service-accounts"));
    expect(JSON.stringify(list)).not.toContain('"role":"admin"');
  });

  it("refuses a duplicate name with 409", async () => {
    expect((await asAdmin("POST", "/api/service-accounts", { name: "Robot", scope: [] })).status).toBe(409);
  });

  it("rotates: the old token is dead at once, the new one works; revoke kills it", async () => {
    const made = await makeAccount("Rot");
    const rotated = await json(await asAdmin("POST", `/api/service-accounts/${made.id}/rotate`, {}));
    expect(rotated.token).toMatch(/^scf_svc_/);
    expect((await withToken(made.token)).status).toBe(401);
    expect((await withToken(rotated.token)).status).toBe(200);
    const revoked = await json(await asAdmin("POST", `/api/service-accounts/${made.id}/revoke`, {}));
    expect(revoked.account.token).toBe("revoked");
    expect((await withToken(rotated.token)).status).toBe(401);
    expect((await audit())[0]).toMatchObject({ by: made.id, result: "failed" });
    const lines = (await latestAudit({}, 100)).records.map((r) => r.action);
    expect(lines).toContain("service-token-rotate");
    expect(lines).toContain("service-token-revoke");
  });

  it("changes the scope: a route that was dropped answers 403 at once", async () => {
    const made = await makeAccount("Scoped", ["GET runs", "GET health"]);
    expect((await withToken(made.token, "GET", "/api/health")).status).toBe(200);
    expect((await asAdmin("PUT", `/api/service-accounts/${made.id}`, { scope: ["GET runs"] })).status).toBe(200);
    expect((await withToken(made.token, "GET", "/api/health")).status).toBe(403);
  });

  it("stops at once when the account is blocked, and is gone when it is deleted", async () => {
    const made = await makeAccount("Gone");
    expect((await asAdmin("POST", `/api/users/${made.id}/block`, {})).status).toBe(200);
    expect((await withToken(made.token)).status).toBe(401);
    expect((await asAdmin("POST", `/api/users/${made.id}/unblock`, {})).status).toBe(200);
    expect((await withToken(made.token)).status).toBe(200);
    expect((await asAdmin("DELETE", `/api/users/${made.id}`)).status).toBe(200);
    expect((await withToken(made.token)).status).toBe(401);
    expect((await json(await asAdmin("GET", "/api/service-accounts"))).accounts.some((a: any) => a.id === made.id)).toBe(false);
  });

  it("never shows a token in a log line", () => {
    expect(logs.join("\n")).not.toContain("scf_svc_");
  });
});
