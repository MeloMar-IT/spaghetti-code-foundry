import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disposeIdentity, supplyIdentity, type IdentityRequest } from "../src/auth/identity.js";
import { createUser, deleteUser, getUser, setBreakGlass, setStatus, usersPath, type User } from "../src/auth/users.js";
import { userWorkspaces } from "../src/server/workspace-scope.js";
import { startTestServer } from "./helpers/port.js";
import { TEST_PASSWORD, signInAs } from "./helpers/session.js";

// The identity provider through a real server (#833). The provider is a fake: the header x-test-identity picks an answer.

type Answer = { id: string; name: string; roles: ("admin" | "user")[]; workspace?: string } | null | "throw";
let tmp: string;
let home: string;
let srv: Awaited<ReturnType<typeof startTestServer>>;
let logs: string[];
const answers = new Map<string, Answer>();
let seen: IdentityRequest[] = [];
let gate: Promise<void> | undefined;

const ADMIN = { id: randomUUID(), name: "Ada", roles: ["admin" as const] };
const USER = { id: randomUUID(), name: "Uli", roles: ["user" as const] };

async function boot(config = "", withProvider = true) {
  tmp = mkdtempSync(join(tmpdir(), "factory-identity-"));
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  process.env.FACTORY_HOME = home;
  writeFileSync(join(home, "config.yaml"), config);
  logs = [];
  answers.clear();
  seen = [];
  gate = undefined;
  if (withProvider) supply();
  srv = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), watchers: false, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), log: (m) => logs.push(m) });
}
function supply() {
  const r = supplyIdentity({
    owner: "test",
    plugin: "test",
    report: (reason) => logs.push(`problem: ${reason}`),
    provider: {
      async resolve(req) {
        seen.push(req);
        const a = answers.get(req.headers["x-test-identity"] ?? "");
        if (gate) await gate;
        if (a === "throw") throw new Error("SECRET-TEXT");
        return a ?? null;
      },
    },
  });
  expect(r).toBe("ok");
}
afterEach(() => {
  srv?.close();
  disposeIdentity("test");
  rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: string, path: string, who: string, cookie?: string, csrf?: string, body?: unknown) => {
  const res = await fetch(srv.base + path, {
    method,
    headers: { "x-test-identity": who, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as any) : undefined, res };
};
/** Signs in through GET /api/session as `who`. */
async function enter(who: string, extra = "") {
  const r = await call("GET", "/api/session", who, extra || undefined);
  expect(r.status).toBe(200);
  const cookie = r.res.headers.getSetCookie()[0]!.split(";")[0]!;
  return { cookie, csrf: r.json.csrfToken as string, body: r.json };
}
const sessionsFile = () => JSON.parse(readFileSync(join(home, "sessions.json"), "utf8")).sessions as { id: string }[];

describe("sign-in and rechecks", () => {
  beforeEach(async () => {
    await boot();
    answers.set("ada", ADMIN);
    answers.set("uli", USER);
  });

  it("signs in through GET /api/session, mirrors the account and audits it", async () => {
    const s = await enter("ada", "other=1");
    expect(s.body).toMatchObject({ user: { id: ADMIN.id, name: "Ada", role: "admin" }, identityProvider: true });
    expect(s.cookie).toMatch(/^scf_session_\d+=/);
    expect(getUser(ADMIN.id)).toMatchObject({ source: "provider", workspace: "default", email: `${ADMIN.id}@identity-provider.invalid` });
    expect(seen[0]!.headers.cookie).toBe("other=1");
    expect(JSON.stringify(seen)).not.toContain(s.cookie.split("=")[1]!);
    const audit = readFileSync(join(home, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.find((l) => l.action === "sign-in")).toMatchObject({ by: ADMIN.id, result: "ok", target: "identity-provider" });
  });

  it("answers nobody for null, and an identity error for a failing provider, without its text", async () => {
    expect((await call("GET", "/api/session", "nobody")).json).toEqual({ user: null, identityProvider: true, setupNeeded: false });
    answers.set("bad", "throw");
    const r = await call("GET", "/api/session", "bad");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ user: null, identityError: true });
    expect(r.text + logs.join("\n")).not.toContain("SECRET-TEXT");
    expect(logs.filter((l) => l.startsWith("problem:"))).toHaveLength(1);
  });

  it("answers 503 for a live session while the provider fails, and keeps the session", async () => {
    const s = await enter("ada");
    answers.set("ada", "throw");
    const r = await call("GET", "/api/runs", "ada", s.cookie);
    expect(r.status).toBe(503);
    expect(r.text).not.toContain("SECRET-TEXT");
    expect((await call("GET", "/api/session", "ada", s.cookie)).json).toMatchObject({ user: null, identityError: true });
    answers.set("ada", ADMIN);
    expect((await call("GET", "/api/runs", "ada", s.cookie)).status).toBe(200);
  });

  it("a recheck with nothing changed writes nothing", async () => {
    const s = await enter("ada");
    const bytes = readFileSync(usersPath());
    const m = statSync(usersPath()).mtimeMs;
    await new Promise((x) => setTimeout(x, 15));
    expect((await call("GET", "/api/runs", "ada", s.cookie)).status).toBe(200);
    expect((await call("GET", "/api/session", "ada", s.cookie)).json.user.id).toBe(ADMIN.id);
    expect(readFileSync(usersPath()).equals(bytes)).toBe(true);
    expect(statSync(usersPath()).mtimeMs).toBe(m);
  });

  it("a different id or a null answer revokes the session (401)", async () => {
    for (const next of [USER, null] as const) {
      const s = await enter("ada");
      answers.set("ada", next);
      expect((await call("GET", "/api/runs", "ada", s.cookie)).status).toBe(401);
      expect(sessionsFile()).toHaveLength(0);
      answers.set("ada", ADMIN);
      expect((await call("GET", "/api/runs", "ada", s.cookie)).status).toBe(401); // the session is gone for good
    }
  });

  it("on GET /api/session a different id revokes without a replacement; the next call signs in the new id", async () => {
    const s = await enter("ada");
    answers.set("ada", USER);
    const r = await call("GET", "/api/session", "ada", s.cookie);
    expect(r.json).toEqual({ user: null, identityProvider: true, setupNeeded: false });
    expect(r.res.headers.getSetCookie()[0]).toContain("Max-Age=0");
    expect(sessionsFile()).toHaveLength(0);
    expect(getUser(USER.id)).toBeUndefined();
    expect((await call("GET", "/api/session", "ada")).json.user.id).toBe(USER.id);
    expect(getUser(USER.id)).toBeDefined();
  });

  it("a null answer on GET /api/session also revokes", async () => {
    const s = await enter("ada");
    answers.set("ada", null);
    expect((await call("GET", "/api/session", "ada", s.cookie)).json).toEqual({ user: null, identityProvider: true, setupNeeded: false });
    expect(sessionsFile()).toHaveLength(0);
  });

  it("role changes apply from the next call: a user gets 403 on /api/info, an admin 200", async () => {
    const a = await enter("ada");
    const u = await enter("uli");
    expect((await call("GET", "/api/info", "ada", a.cookie)).status).toBe(200);
    expect((await call("GET", "/api/info", "uli", u.cookie)).status).toBe(403);
    answers.set("ada", { ...ADMIN, roles: ["user"] });
    expect((await call("GET", "/api/info", "ada", a.cookie)).status).toBe(403);
    expect(getUser(ADMIN.id)!.role).toBe("user");
  });

  it("a blocked account gets 401, then nobody; a deleted one is not recreated by a recheck", async () => {
    const a = await enter("ada");
    const u = await enter("uli");
    await setStatus(USER.id, "blocked");
    expect((await call("GET", "/api/runs", "uli", u.cookie)).status).toBe(401);
    expect((await call("GET", "/api/session", "uli")).json).toEqual({ user: null, identityProvider: true, setupNeeded: false });
    expect(sessionsFile()).toHaveLength(1);
    deleteUser(ADMIN.id);
    expect((await call("GET", "/api/runs", "ada", a.cookie)).status).toBe(401);
    expect(getUser(ADMIN.id)).toBeUndefined();
  });

  it("races: a change while the provider is still answering wins", async () => {
    for (const how of ["revoke", "block", "delete"] as const) {
      for (const path of ["/api/runs", "/api/session"]) {
        const s = await enter("uli");
        let release!: () => void;
        gate = new Promise<void>((r) => (release = r));
        const pending = call("GET", path, "uli", s.cookie);
        while (seen.length < 1 || !gate) await new Promise((x) => setTimeout(x, 5));
        await new Promise((x) => setTimeout(x, 20));
        if (how === "revoke") (await import("../src/auth/sessions.js")).revokeUserSessions(USER.id);
        else if (how === "block") await setStatus(USER.id, "blocked");
        else deleteUser(USER.id);
        release();
        gate = undefined;
        const r = await pending;
        if (path === "/api/runs") expect(r.status).toBe(401);
        else expect(r.json.user).toBeNull();
        expect(sessionsFile()).toHaveLength(0);
        // nothing was created again: a deleted account stays deleted, a blocked one stays blocked
        const after = getUser(USER.id);
        if (how === "delete") expect(after).toBeUndefined();
        else expect(after?.status).toBe(how === "block" ? "blocked" : "active");
        seen = [];
        if (how !== "delete") deleteUser(USER.id);
      }
    }
  });

  it("refuses password actions on a provider account with 409; block and delete work", async () => {
    const a = await enter("ada");
    const u = await enter("uli");
    const as = (method: string, path: string, body?: unknown) => call(method, path, "ada", a.cookie, method === "GET" ? undefined : a.csrf, body);
    expect((await as("PUT", `/api/users/${USER.id}`, { name: "New" })).status).toBe(409);
    expect((await as("POST", `/api/users/${USER.id}/reset`)).status).toBe(409);
    expect((await as("POST", `/api/users/${USER.id}/link`)).status).toBe(409);
    expect((await call("POST", "/api/password", "uli", u.cookie, u.csrf, { current: "x".repeat(12), password: TEST_PASSWORD })).status).toBe(409);
    expect((await as("POST", `/api/users/${USER.id}/block`, {})).status).toBe(200);
    expect((await as("DELETE", `/api/users/${USER.id}`)).status).toBe(200);
  });

  it("switches local sign-in and setup off, and local sessions stop counting", async () => {
    const local = await createUser({ name: "Loc", email: "loc@example.com", password: TEST_PASSWORD, role: "admin" });
    expect(local.id).toBeDefined();
    const r = await fetch(`${srv.base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "loc@example.com", password: TEST_PASSWORD }) });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe("wrong e-mail or password");
    const setup = await fetch(`${srv.base}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "X", email: "x@example.com", password: TEST_PASSWORD }) });
    expect(setup.status).toBe(409);
    // a local session made before the provider existed
    disposeIdentity("test");
    const old = await signInAs(srv.base, { email: "loc@example.com", create: false });
    expect((await call("GET", "/api/runs", "", old.cookie)).status).toBe(200);
    supply();
    expect((await call("GET", "/api/runs", "", old.cookie)).status).toBe(401);
  });

  it("after the provider is gone: provider sessions stop, and the first local admin can be set up", async () => {
    const a = await enter("ada");
    disposeIdentity("test");
    expect((await call("GET", "/api/runs", "ada", a.cookie)).status).toBe(401);
    const s = (await call("GET", "/api/session", "ada", a.cookie)).json;
    expect(s).toMatchObject({ user: null, setupNeeded: true });
    const setup = await fetch(`${srv.base}/api/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "First", email: "first@example.com", password: TEST_PASSWORD }) });
    expect(setup.status).toBe(201);
  });
});

describe("workspaces", () => {
  beforeEach(async () => {
    await boot("workspaces:\n  - id: team-a\n    name: Team A\n");
  });
  it("a known workspace is kept, an unknown one becomes default; member lists do not widen it", async () => {
    answers.set("a", { ...USER, workspace: "team-a" });
    await enter("a");
    expect(getUser(USER.id)!.workspace).toBe("team-a");
    expect([...userWorkspaces(USER.id)]).toEqual(["team-a"]);
    answers.set("b", { id: randomUUID(), name: "Bea", roles: ["user"], workspace: "team-zz" });
    const b = await enter("b");
    expect(getUser(b.body.user.id)!.workspace).toBe("default");
    expect([...userWorkspaces(b.body.user.id)]).toEqual(["default"]);
  });
  it("fails closed when the account cannot be read", async () => {
    answers.set("a", USER);
    await enter("a");
    writeFileSync(usersPath(), "not json");
    expect([...userWorkspaces(USER.id)]).toEqual([]);
  });
});

describe("break-glass", () => {
  const EMAIL_A = "glass@example.com";
  const EMAIL_B = "plain@example.com";
  let a: User;
  let b: User;
  beforeEach(async () => {
    await boot();
    answers.set("ada", ADMIN);
    answers.set("uli", USER);
    a = await createUser({ name: "Glass", email: EMAIL_A, password: TEST_PASSWORD, role: "admin" });
    b = await createUser({ name: "Plain", email: EMAIL_B, password: TEST_PASSWORD, role: "admin" });
    setBreakGlass(a.id, true, { by: "cli" });
  });
  const login = (email: string, password = TEST_PASSWORD, cookie?: string) =>
    fetch(`${srv.base}/api/session`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ email, password }) });
  const auditLines = () => readFileSync(join(home, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const cookieOf = (r: Response) => r.headers.getSetCookie()[0]!.split(";")[0]!;
  const setPw = (token: string, password: string) =>
    fetch(`${srv.base}/api/set-password`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }) });

  it("the marked admin signs in with a password; each sign-in is audited and logged without the e-mail", async () => {
    const r = await login(EMAIL_A);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { user: { id: string } }).user.id).toBe(a.id);
    expect(auditLines().filter((l) => l.action === "sign-in")).toEqual([expect.objectContaining({ by: a.id, result: "ok", target: "break-glass" })]);
    expect(logs.filter((l) => l.includes("break-glass"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(EMAIL_A);
    expect((await login(EMAIL_A)).status).toBe(200);
    expect(auditLines().filter((l) => l.target === "break-glass")).toHaveLength(2);
  });

  it("an unmarked local admin with the right password gets the plain 401 and a failed audit line", async () => {
    const r = await login(EMAIL_B);
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toBe("wrong e-mail or password");
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(auditLines().filter((l) => l.action === "sign-in")).toEqual([expect.objectContaining({ by: "anonymous", result: "failed", userId: b.id })]);
    expect((await login(EMAIL_B, "test-wrong-password-1")).status).toBe(401);
  });

  it("a break-glass session works while the provider fails", async () => {
    const cookie = cookieOf(await login(EMAIL_A));
    answers.set("x", "throw");
    const s = await call("GET", "/api/session", "x", cookie);
    expect(s.status).toBe(200);
    expect(s.json.user.id).toBe(a.id);
    expect(s.json.identityError).toBeUndefined();
    expect((await call("GET", "/api/runs", "x", cookie)).status).toBe(200);
    // a sign-in that carries a cookie while the provider fails still works
    expect((await login(EMAIL_A, TEST_PASSWORD, cookie)).status).toBe(200);
  });

  it("changes nothing when the audit log cannot be written", async () => {
    const first = cookieOf(await login(EMAIL_A));
    const before = readFileSync(join(home, "sessions.json"), "utf8");
    rmSync(join(home, "audit.jsonl"), { force: true });
    mkdirSync(join(home, "audit.jsonl"));
    const r = await login(EMAIL_A, TEST_PASSWORD, first);
    expect(r.status).toBe(500);
    expect(r.headers.getSetCookie()).toEqual([]);
    expect(readFileSync(join(home, "sessions.json"), "utf8")).toBe(before);
    expect((await call("GET", "/api/runs", "", first)).status).toBe(200);
  });

  it("stops at once when the mark is switched off", async () => {
    const cookie = cookieOf(await login(EMAIL_A));
    expect((await call("GET", "/api/runs", "", cookie)).status).toBe(200);
    setBreakGlass(a.id, false);
    expect((await call("GET", "/api/runs", "", cookie)).status).toBe(401);
    expect((await login(EMAIL_A)).status).toBe(401);
  });

  it("a local session that is not marked does not count", async () => {
    disposeIdentity("test");
    const old = await signInAs(srv.base, { email: EMAIL_B, create: false });
    supply();
    expect((await call("GET", "/api/runs", "", old.cookie)).status).toBe(401);
  });

  it("attack path: a provider admin cannot get a password sign-in or the mark", async () => {
    const ada = await enter("ada");
    const old = cookieOf(await login(EMAIL_A));
    const as = (method: string, path: string, body?: unknown) => call(method, path, "ada", ada.cookie, method === "GET" ? undefined : ada.csrf, body);
    const reset = await as("POST", `/api/users/${a.id}/reset`);
    expect(reset.status).toBe(200);
    expect((await setPw(reset.json.token, "test-new-password-2")).status).toBe(200);
    expect((await login(EMAIL_A, "test-new-password-2")).status).toBe(401);
    expect((await call("GET", "/api/runs", "", old)).status).toBe(401);
    expect(getUser(a.id)?.breakGlass).toBeUndefined();
    // a new local admin made through the API cannot sign in with a password
    const made = await as("POST", "/api/users", { name: "New", email: "new@example.com", role: "admin" });
    expect(made.status).toBe(201);
    expect((await setPw(made.json.token, "test-new-password-3")).status).toBe(200);
    expect((await login("new@example.com", "test-new-password-3")).status).toBe(401);
    // the mark is never taken from a request body
    const put = await as("PUT", `/api/users/${b.id}`, { name: "Plain 2", breakGlass: true });
    expect(put.status).toBeLessThan(500);
    expect(getUser(b.id)?.breakGlass).toBeUndefined();
    expect(put.text).not.toContain("breakGlass");
  });

  it("gives provider: true for provider accounts only", async () => {
    const ada = await enter("ada");
    expect(ada.body.user.provider).toBe(true);
    const list = await call("GET", "/api/users", "ada", ada.cookie);
    const byId = new Map((list.json as { id: string; provider?: boolean }[]).map((u) => [u.id, u]));
    expect(byId.get(ADMIN.id)?.provider).toBe(true);
    expect(byId.get(a.id)).not.toHaveProperty("provider");
    expect(list.text).not.toContain("breakGlass");
  });
});
