import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { disposeIdentity, supplyIdentity, type IdentityRequest } from "../src/auth/identity.js";
import { createUser, deleteUser, getUser, setStatus, usersPath } from "../src/auth/users.js";
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
