import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { latestAudit } from "../src/auth/audit.js";
import {
  SERVICE_IDLE_MS, createServiceAccount, findServiceByToken, listServiceAccounts, lookupServiceToken, recordServiceUse, revokeServiceToken, rotateServiceToken,
  tokenState, updateServiceAccount,
} from "../src/auth/service-accounts.js";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import {
  UserError, checkEmail, createUser, deleteUser, getUser, listUsers, newPasswordLink, publicUser, resetPassword, setBreakGlass, setPassword, setStatus, setView, updateUser, usersPath,
} from "../src/auth/users.js";
import { HttpError } from "../src/server/http.js";
import { RULES, authorize, grantableRules, neverGranted, ruleKey, serviceAllows, findRule, adminOrGranted } from "../src/server/permissions.js";
import { checkServiceScope } from "../src/server/api-service-accounts.js";
import { serviceBearer, serviceStillAllowed } from "../src/server/service-requests.js";

// Service accounts (#866): the store, the scope rules and `authorize()`. The HTTP side is in service-accounts-api.test.ts.

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "svc-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const make = (scope: string[] = ["GET runs"], name = "Robot") => createServiceAccount({ name, scope });
const DAY = 24 * 60 * 60 * 1000;

describe("create", () => {
  it("makes a token of the right form and stores only its SHA-256", () => {
    const { account, token } = make();
    expect(token).toMatch(/^scf_svc_[A-Za-z0-9_-]{43}$/);
    expect(account.role).toBe("user");
    expect(account.kind).toBe("service");
    expect(account.email).toBe(`${account.id}@service.invalid`);
    const text = readFileSync(usersPath(), "utf8");
    expect(text).not.toContain(token!);
    expect(text).toContain(sha(token!));
    expect(text).not.toContain("passwordHash");
  });

  it("keeps names unique among service accounts", () => {
    make(["GET runs"], "Robot");
    expect(() => make(["GET runs"], "Robot")).toThrowError(expect.objectContaining({ code: "name-taken" }));
  });

  it("refuses a scope of the wrong shape", () => {
    for (const scope of ["GET runs", ["GET  runs"], ["GET runs", "GET runs"], [1], Array.from({ length: 201 }, (_, i) => `GET a${i}`)]) {
      expect(() => createServiceAccount({ name: "x", scope })).toThrow(UserError);
    }
  });

  it("is listed with the people file untouched for a person", async () => {
    await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345" });
    make();
    expect(listServiceAccounts()).toHaveLength(1);
    expect(listUsers()).toHaveLength(2);
    expect(publicUser(listServiceAccounts()[0]!)).not.toHaveProperty("token");
  });

  it("writes an audit line for the creator", async () => {
    const admin = await createUser({ name: "Root", email: "root@example.com", password: "test-password-12345", role: "admin" });
    const { account } = createServiceAccount({ name: "Robot", scope: [] }, { by: admin.id });
    const { records } = await latestAudit({}, 10);
    expect(records.map((r) => [r.action, r.by, r.userId])).toContainEqual(["create", admin.id, account.id]);
  });
});

describe("the token", () => {
  it("finds the account for the right token only", () => {
    const { account, token } = make();
    expect(findServiceByToken(token!)?.id).toBe(account.id);
    for (const bad of ["", "scf_svc_", `${token}x`, token!.replace("scf_svc_", "scf_xxx_"), token!.slice(0, -1) + (token!.endsWith("A") ? "B" : "A")]) {
      expect(findServiceByToken(bad), bad).toBeUndefined();
    }
  });

  it("does not find a blocked account", async () => {
    const { account, token } = make();
    await setStatus(account.id, "blocked");
    expect(findServiceByToken(token!)).toBeUndefined();
    expect(lookupServiceToken(token!)?.account.id).toBe(account.id);
  });

  it("rotate kills the old token at once and gives a new one", () => {
    const { account, token } = make();
    const next = rotateServiceToken(account.id);
    expect(next.token).not.toBe(token);
    expect(findServiceByToken(token!)).toBeUndefined();
    expect(lookupServiceToken(token!)).toBeUndefined();
    expect(findServiceByToken(next.token!)?.id).toBe(account.id);
  });

  it("revoke kills the token, keeps the account and is named in the state", () => {
    const { account, token } = make();
    revokeServiceToken(account.id);
    expect(findServiceByToken(token!)).toBeUndefined();
    expect(lookupServiceToken(token!)?.state).toBe("revoked");
    expect(tokenState(getUser(account.id) as never)).toBe("revoked");
    expect(findServiceByToken(rotateServiceToken(account.id).token!)).toBeDefined();
  });

  it("expires 30 days after creation, to the millisecond, and rotate brings it back", () => {
    const { account, token } = make();
    const created = Date.parse(account.created);
    expect(findServiceByToken(token!, created + SERVICE_IDLE_MS)).toBeDefined();
    expect(findServiceByToken(token!, created + SERVICE_IDLE_MS + 1)).toBeUndefined();
    expect(lookupServiceToken(token!, created + SERVICE_IDLE_MS + 1)?.state).toBe("expired");
    expect(findServiceByToken(rotateServiceToken(account.id).token!)).toBeDefined();
  });

  it("counts the 30 days from the last request, exactly, also after a restart", () => {
    const { account, token } = make();
    const t0 = Date.parse(account.created);
    recordServiceUse(account.id, { result: "ok", target: "GET runs" }, { touch: true, now: t0 + 1000 });
    const second = t0 + 20 * DAY;
    recordServiceUse(account.id, { result: "ok", target: "GET runs" }, { touch: true, now: second });
    // the time is in the file: a new process reads the same
    const stored = JSON.parse(readFileSync(usersPath(), "utf8")).users[0].token;
    expect(Date.parse(stored.used)).toBe(second);
    expect(findServiceByToken(token!, second + SERVICE_IDLE_MS)).toBeDefined();
    expect(findServiceByToken(token!, second + SERVICE_IDLE_MS + 1)).toBeUndefined();
  });
});

describe("recordServiceUse", () => {
  it("writes one service-request line with the account as actor and sets the time of use", async () => {
    const { account } = make();
    expect(recordServiceUse(account.id, { result: "ok", target: "GET runs" }, { touch: true })).toBe(true);
    const { records } = await latestAudit({}, 10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ by: account.id, action: "service-request", result: "ok", target: "GET runs" });
    expect(getUser(account.id)?.token?.used).toBeDefined();
  });

  it("takes an unknown account: the actor is anonymous", async () => {
    expect(recordServiceUse(undefined, { result: "failed", target: "GET runs", detail: "401 unknown token" })).toBe(false);
    expect((await latestAudit({}, 10)).records[0]).toMatchObject({ by: "anonymous", result: "failed", detail: "401 unknown token" });
  });

  it("writes an ok line for a token that is no longer live as failed, and does not touch it", async () => {
    const { account } = make();
    revokeServiceToken(account.id);
    expect(recordServiceUse(account.id, { result: "ok", target: "GET runs" }, { touch: true })).toBe(false);
    expect((await latestAudit({}, 10)).records[0]).toMatchObject({ result: "failed" });
    expect(getUser(account.id)?.token?.used).toBeUndefined();
  });

  it("does not wait for a held lock: it throws a StoreError", () => {
    const { account } = make();
    // the lock is not re-entrant: a second holder is another process; the live lock folder of this one answers the same way
    let error: unknown;
    withAuthLock(() => {
      try {
        recordServiceUse(account.id, { result: "ok", target: "GET runs" });
      } catch (e) {
        error = e;
      }
    });
    expect(String(error)).toMatch(/re-entrant|locked/);
    expect(error instanceof Error || error instanceof StoreError).toBe(true);
  });
});

describe("a service is not a person", () => {
  it("refuses password, link, reset, profile, view and break-glass", async () => {
    const { account } = make();
    const code = (p: Promise<unknown> | (() => unknown)) =>
      (typeof p === "function" ? Promise.resolve().then(p) : p).then(() => "none", (e) => (e as UserError).code);
    expect(await code(setPassword(account.id, "test-password-12345"))).toBe("service-account");
    expect(await code(resetPassword(account.id))).toBe("service-account");
    expect(await code(newPasswordLink(account.id))).toBe("service-account");
    expect(await code(updateUser(account.id, { name: "Other" }))).toBe("service-account");
    expect(await code(updateUser(account.id, { role: "admin" }))).toBe("service-account");
    expect(await code(() => setView(account.id, "advanced"))).toBe("service-account");
    expect(await code(() => setBreakGlass(account.id, true))).toBe("service-account");
    expect(getUser(account.id)?.role).toBe("user");
  });

  it("may be blocked and deleted like an account", async () => {
    const { account } = make();
    expect((await setStatus(account.id, "blocked")).status).toBe("blocked");
    deleteUser(account.id);
    expect(getUser(account.id)).toBeUndefined();
  });

  it("keeps the e-mail domain for itself", () => {
    expect(() => checkEmail("x@service.invalid")).toThrow(UserError);
    expect(() => checkEmail("x@example.com")).not.toThrow();
  });

  it("is refused by the file schema when it has person fields, an admin role or a wrong e-mail", () => {
    const { account } = make();
    const good = JSON.parse(readFileSync(usersPath(), "utf8"));
    const bad = (patch: Record<string, unknown>) => {
      writeFileSync(usersPath(), JSON.stringify({ ...good, users: [{ ...good.users[0], ...patch }] }));
      return () => listUsers();
    };
    for (const patch of [{ role: "admin" }, { breakGlass: true }, { view: "simple" }, { email: "x@example.com" }, { scope: undefined }]) {
      expect(bad(patch), JSON.stringify(patch)).toThrow(StoreError);
    }
    // a person with a scope is refused too
    writeFileSync(usersPath(), JSON.stringify({ ...good, users: [{ ...good.users[0], kind: undefined, email: "p@example.com" }] }));
    expect(() => listUsers()).toThrow(StoreError);
    writeFileSync(usersPath(), JSON.stringify(good));
    expect(getUser(account.id)?.kind).toBe("service");
  });

  it("reads a users.json without services as before", async () => {
    await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345" });
    expect(listServiceAccounts()).toEqual([]);
    expect(listUsers()[0]?.kind).toBeUndefined();
  });

  it("changes the scope and name, and refuses a duplicate name", () => {
    const { account } = make(["GET runs"], "A");
    make(["GET runs"], "B");
    expect(updateServiceAccount(account.id, { scope: ["GET runs", "GET health"] }).scope).toEqual(["GET runs", "GET health"]);
    expect(() => updateServiceAccount(account.id, { name: "B" })).toThrowError(expect.objectContaining({ code: "name-taken" }));
    expect(() => updateServiceAccount("00000000-0000-4000-8000-000000000000", {})).toThrowError(expect.objectContaining({ code: "not-found" }));
  });
});

describe("the scope", () => {
  it("never grants credentials, users, settings, autonomy, self-update, plugins or the audit export", () => {
    for (const path of ["credentials", "credentials/:id", "admin/credentials", "users", "users/:id/link", "service-accounts", "service-accounts/:id/rotate", "admin/view-as", "password", "config", "settings", "settings/reset", "restart", "onboarding/agents", "admin/repos/:id/settings", "repos/:id/publish-remote", "autonomy", "autonomy/promote", "self-update", "self-update/apply", "plugins", "plugins/ui", "audit/export"]) {
      expect(neverGranted(path), path).toBe(true);
    }
    for (const path of ["audit", "runs", "runs/:id", "health", "help/usage", "repos", "users-x"]) expect(neverGranted(path), path).toBe(false);
  });

  it("offers no never-grantable rule and marks the admin-only ones", () => {
    const list = grantableRules();
    expect(list.some((g) => g.key === "GET runs" && !g.adminOnly)).toBe(true);
    expect(list.some((g) => g.key === "GET health" && g.adminOnly)).toBe(true);
    for (const g of list) expect(neverGranted(g.key.split(" ")[1]!), g.key).toBe(false);
    for (const rule of RULES) expect(list.some((g) => g.key === ruleKey(rule)), ruleKey(rule)).toBe(!neverGranted(rule.path));
  });

  it("checks the keys of a scope and names the one that can never be granted", () => {
    expect(checkServiceScope(["GET runs", "GET health"])).toEqual(["GET runs", "GET health"]);
    expect(() => checkServiceScope("GET runs")).toThrow(HttpError);
    expect(() => checkServiceScope(["GET runs", "GET runs"])).toThrow(/twice/);
    expect(() => checkServiceScope(["GET nope"])).toThrow(/not a route/);
    expect(() => checkServiceScope(["GET *"])).toThrow(/not a route/);
    expect(() => checkServiceScope(["GET runs", "GET users"])).toThrow(/"GET users" can never be granted/);
    expect(() => checkServiceScope(["POST repos/:id/publish-remote"])).toThrow(/"POST repos\/:id\/publish-remote" can never be granted/);
    expect(() => checkServiceScope(Array.from({ length: 201 }, () => "GET runs"))).toThrow(/at most/);
  });
});

describe("authorize for a service", () => {
  const ctx = { scheduler: { ownerOf: () => "someone-else", workspaceOf: () => undefined } } as never;
  const service = (scope: string[]) => ({ id: "00000000-0000-4000-8000-000000000001", role: "user", kind: "service", scope }) as never;
  const rule = (m: string, p: string) => findRule(m, p.split("/"))!;
  const code = (fn: () => void) => {
    try {
      fn();
      return 200;
    } catch (e) {
      return (e as HttpError).status;
    }
  };

  it("passes a rule in the scope and refuses every other", () => {
    const u = service(["GET runs"]);
    expect(code(() => authorize(ctx, u, rule("GET", "runs"), ["runs"]))).toBe(200);
    expect(code(() => authorize(ctx, u, rule("GET", "repos"), ["repos"]))).toBe(403);
    expect(code(() => authorize(ctx, u, rule("POST", "runs"), ["runs"]))).toBe(403);
  });

  it("passes an admin-only rule that is listed, and refuses it when it is not", () => {
    expect(code(() => authorize(ctx, service(["GET health"]), rule("GET", "health"), ["health"]))).toBe(200);
    expect(code(() => authorize(ctx, service(["GET runs"]), rule("GET", "health"), ["health"]))).toBe(403);
    expect(adminOrGranted(service([]))).toBe(true);
  });

  it("keeps the ownership check of an own rule: another account's run is 404", () => {
    expect(code(() => authorize(ctx, service(["GET runs/:id"]), rule("GET", "runs/abc"), ["runs", "abc"]))).toBe(404);
  });

  it("refuses a never-grantable rule that was written into the file by hand", () => {
    expect(code(() => authorize(ctx, service(["GET users"]), rule("GET", "users"), ["users"]))).toBe(403);
    expect(code(() => authorize(ctx, service(["POST repos/:id/publish-remote"]), rule("POST", "repos/x/publish-remote"), ["repos", "x", "publish-remote"]))).toBe(403);
    expect(serviceAllows({ scope: ["GET users"] }, rule("GET", "users"))).toBe(false);
    expect(serviceAllows({ scope: ["GET *"] }, rule("GET", "runs"))).toBe(false);
  });
});

describe("an open event stream of a service", () => {
  // the same checks as a new request, run again on each recheck: a removed route, a revoke or a computer that no longer fits ends it
  const ctx = { config: () => ({ server: { listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false } }), opts: { port: 4321 } } as never;
  const local = () => ({ method: "GET", url: "/api/runs/x/events", socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:4321" } }) as never;
  const rule = findRule("GET", ["runs", "x", "events"])!;
  const call = (token: string) => ({ token, method: "GET", seg: ["runs", "x", "events"], rule, written: false }) as never;

  it("ends when the route leaves the scope, and when the token is revoked", () => {
    const { account, token } = make(["GET runs/:id/events"]);
    expect(serviceStillAllowed(ctx, local(), call(token!))).toBe(true);
    updateServiceAccount(account.id, { scope: ["GET runs"] });
    expect(serviceStillAllowed(ctx, local(), call(token!))).toBe(false);
    updateServiceAccount(account.id, { scope: ["GET runs/:id/events"] });
    expect(serviceStillAllowed(ctx, local(), call(token!))).toBe(true);
    revokeServiceToken(account.id);
    expect(serviceStillAllowed(ctx, local(), call(token!))).toBe(false);
  });

  it("ends when the connection is not on this computer, or the account is blocked", async () => {
    const { account, token } = make(["GET runs/:id/events"]);
    const remote = { ...(local() as object), headers: { host: "127.0.0.1:4321", "x-forwarded-for": "203.0.113.9" } } as never;
    expect(serviceStillAllowed(ctx, remote, call(token!))).toBe(false);
    await setStatus(account.id, "blocked");
    expect(serviceStillAllowed(ctx, local(), call(token!))).toBe(false);
  });
});

describe("the bearer header", () => {
  const req = (authorization?: string) => ({ headers: authorization === undefined ? {} : { authorization } }) as never;
  it("recognises only Bearer scf_svc_ tokens", () => {
    expect(serviceBearer(req("Bearer scf_svc_abc"))).toBe("scf_svc_abc");
    expect(serviceBearer(req("bearer scf_svc_abc"))).toBe("scf_svc_abc");
    expect(serviceBearer(req("Basic dXNlcjpwYXNz"))).toBeUndefined();
    expect(serviceBearer(req("Bearer other"))).toBeUndefined();
    expect(serviceBearer(req())).toBeUndefined();
  });
});
