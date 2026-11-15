import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { latestAudit } from "../src/auth/audit.js";
import {
  ACTS_FOR_BLOCKED, ACTS_FOR_GONE, ACTS_FOR_NO_SIGN_IN, actsForProblem, createServiceAccount, findPersonId, getServiceAccount, recordServiceUse, updateServiceAccount,
} from "../src/auth/service-accounts.js";
import { withAuthLock } from "../src/auth/store.js";
import { accountProblem, createUser, deleteUser, readUsersFile, resetPassword, setStatus, usersPath, writeUsersFileLocked, type User } from "../src/auth/users.js";
import { sessionAlive, sessionUser } from "../src/server/api-auth.js";
import { HttpError } from "../src/server/http.js";
import { findRule } from "../src/server/permissions.js";
import { auditRefused, newServiceCall, resolveActing, serviceCaller, serviceOk, serviceStillAllowed } from "../src/server/service-requests.js";

// A service account that acts for one person (#876): the store, the acting user, open streams and the audit lines. Unit level.
// The HTTP side is in service-acts-for-api.test.ts.

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "svc-acts-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const PASSWORD = "test-password-12345";
const person = (name: string, email: string, role: "admin" | "user" = "user") => createUser({ name, email, password: PASSWORD, role });
const ctx = { config: () => ({ server: { listen: "127.0.0.1", allowed_hosts: [], allow_insecure_http: false } }), opts: { port: 4321 }, diagLog: () => undefined } as never;
const local = (url = "/api/runs/x/events") => ({ method: "GET", url, socket: { remoteAddress: "127.0.0.1" }, headers: { host: "127.0.0.1:4321" } }) as never;
const audit = async () => (await latestAudit({ action: "service-request" }, 20)).records;

describe("the stored link", () => {
  it("is written only when set, and refused on a person", async () => {
    const ann = await person("Ann", "ann@example.com");
    const plain = createServiceAccount({ name: "Plain", scope: ["GET runs"] });
    expect(readFileSync(usersPath(), "utf8")).not.toContain("actsFor");
    const r = createServiceAccount({ name: "Robot", scope: ["GET runs"], actsFor: ann.id });
    expect(r.account.actsFor).toBe(ann.id);
    expect(getServiceAccount(plain.account.id)!.actsFor).toBeUndefined();
    expect(accountProblem({ ...ann, actsFor: ann.id } as User)).toBe("person with service fields");
  });

  it("must name a person: an unknown id or a service account is refused", async () => {
    const other = createServiceAccount({ name: "Other", scope: [] });
    expect(() => createServiceAccount({ name: "Robot", scope: [], actsFor: "00000000-0000-4000-8000-000000000000" })).toThrowError(expect.objectContaining({ code: "bad-role" }));
    expect(() => createServiceAccount({ name: "Robot", scope: [], actsFor: other.account.id })).toThrowError(expect.objectContaining({ code: "bad-role" }));
    expect(() => updateServiceAccount(other.account.id, { actsFor: other.account.id })).toThrowError(expect.objectContaining({ code: "bad-role" }));
  });

  it("is changed and cleared by an update; null removes the key", async () => {
    const ann = await person("Ann", "ann@example.com");
    const bob = await person("Bob", "bob@example.com");
    const { account } = createServiceAccount({ name: "Robot", scope: ["GET runs"], actsFor: ann.id });
    expect(updateServiceAccount(account.id, { actsFor: bob.id }).actsFor).toBe(bob.id);
    const cleared = updateServiceAccount(account.id, { actsFor: null });
    expect("actsFor" in cleared).toBe(false);
    expect(readFileSync(usersPath(), "utf8")).not.toContain("actsFor");
    // nothing changes: the same object comes back
    expect(updateServiceAccount(account.id, { actsFor: null })).toEqual(cleared);
  });

  it("finds one person by e-mail first, then by exact name", async () => {
    const ann = await person("Ann", "ann@example.com");
    await person("Sam", "sam1@example.com");
    await person("Sam", "sam2@example.com");
    createServiceAccount({ name: "Ann", scope: [] }); // a service with the same name does not count
    expect(findPersonId("ANN@example.com")).toEqual({ id: ann.id });
    expect(findPersonId("Ann")).toEqual({ id: ann.id });
    expect(findPersonId("Sam")).toEqual({ problem: "several" });
    expect(findPersonId("nobody-here")).toEqual({ problem: "none" });
  });
});

describe("actsForProblem", () => {
  it("names each reason with a fixed sentence", async () => {
    const ann = await person("Ann", "ann@example.com");
    expect(actsForProblem(ann)).toBeUndefined();
    expect(actsForProblem(undefined)).toBe(ACTS_FOR_GONE);
    expect(actsForProblem({ ...ann, kind: "service" })).toBe(ACTS_FOR_GONE);
    expect(actsForProblem({ ...ann, status: "blocked" })).toBe(ACTS_FOR_BLOCKED);
    const { passwordHash: _h, ...noPassword } = ann;
    expect(actsForProblem(noPassword)).toBe(ACTS_FOR_NO_SIGN_IN);
    expect(actsForProblem({ ...noPassword, source: "provider" })).toBe(ACTS_FOR_NO_SIGN_IN); // no identity provider is set up
  });
});

describe("the acting user", () => {
  it("is the account itself without actsFor, and the person's id with it; kind, role and scope stay", async () => {
    const ann = await person("Ann", "ann@example.com", "admin");
    const plain = createServiceAccount({ name: "Plain", scope: ["GET runs"] }).account;
    expect(resolveActing(plain)).toBe(plain);
    const robot = createServiceAccount({ name: "Robot", scope: ["GET runs"], actsFor: ann.id }).account;
    const acting = resolveActing(robot);
    expect(acting).toMatchObject({ id: ann.id, kind: "service", role: "user", scope: ["GET runs"], name: "Robot" });
  });

  it("answers 403 with the reason when the person is blocked, reset or gone", async () => {
    const ann = await person("Ann", "ann@example.com");
    const robot = createServiceAccount({ name: "Robot", scope: ["GET runs"], actsFor: ann.id }).account;
    const why = () => {
      try {
        resolveActing(robot);
        return "ok";
      } catch (e) {
        return `${(e as HttpError).status} ${(e as Error).message}`;
      }
    };
    await setStatus(ann.id, "blocked");
    expect(why()).toBe(`403 ${ACTS_FOR_BLOCKED}`);
    await setStatus(ann.id, "active");
    expect(why()).toBe("ok");
    await resetPassword(ann.id);
    expect(why()).toBe(`403 ${ACTS_FOR_NO_SIGN_IN}`);
    deleteUser(ann.id);
    expect(why()).toBe(`403 ${ACTS_FOR_GONE}`);
    // deleting the person does not clear the link
    expect(getServiceAccount(robot.id)!.actsFor).toBe(ann.id);
  });

  it("is what serviceCaller gives the request, and the audit lines name the person by id", async () => {
    const ann = await person("Ann", "ann@example.com");
    const { account, token } = createServiceAccount({ name: "Robot", scope: ["GET runs"], actsFor: ann.id });
    const call = newServiceCall(token!, "GET", ["runs"], "tablet");
    const user = serviceCaller(ctx, local("/api/runs"), call, undefined);
    expect(user.id).toBe(ann.id);
    expect(call.account!.id).toBe(account.id);
    expect(call.actingId).toBe(ann.id);
    serviceOk(ctx, call);
    expect((await audit())[0]).toMatchObject({ by: account.id, result: "ok", detail: `acts for ${ann.id}; client tablet` });

    await setStatus(ann.id, "blocked");
    const refused = newServiceCall(token!, "GET", ["runs"]);
    let err: unknown;
    try {
      serviceCaller(ctx, local("/api/runs"), refused, undefined);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(403);
    auditRefused(ctx, refused, err);
    expect((await audit())[0]).toMatchObject({ by: account.id, result: "failed", detail: `403 ${ACTS_FOR_BLOCKED}; acts for ${ann.id}` });
  });

  it("is also what a handler gets when it reads the caller again (feed polling, notices)", async () => {
    const ann = await person("Ann", "ann@example.com");
    const { token } = createServiceAccount({ name: "Robot", scope: ["GET feed"], actsFor: ann.id });
    const req = { headers: { authorization: `Bearer ${token}` } } as never;
    expect(sessionUser(ctx, req)).toMatchObject({ id: ann.id, kind: "service", role: "user" });
    expect(sessionAlive(ctx, req)).toBe(true);
    await setStatus(ann.id, "blocked");
    expect(() => sessionUser(ctx, req)).toThrowError(ACTS_FOR_BLOCKED);
    expect(sessionAlive(ctx, req)).toBe(false);
  });

  it("an ok line that turns failed keeps the person", async () => {
    const ann = await person("Ann", "ann@example.com");
    const { account } = createServiceAccount({ name: "Robot", scope: [], actsFor: ann.id });
    withAuthLock(() => {
      const f = readUsersFile();
      writeUsersFileLocked({ ...f, users: f.users.map((u) => (u.id === account.id ? { ...u, status: "blocked" as const } : u)) });
    });
    expect(recordServiceUse(account.id, { result: "ok", target: "GET runs", detail: `acts for ${ann.id}` })).toBe(false);
    expect((await audit())[0]).toMatchObject({ result: "failed", detail: `the token ended; acts for ${ann.id}` });
  });
});

describe("an open stream of an acting account", () => {
  const rule = findRule("GET", ["runs", "x", "events"])!;
  const streamCall = (token: string, actingId: string) => ({ token, method: "GET", seg: ["runs", "x", "events"], rule, written: false, actingId }) as never;

  it("ends when the person is blocked, or the link is changed or cleared", async () => {
    const ann = await person("Ann", "ann@example.com");
    const bob = await person("Bob", "bob@example.com");
    const { account, token } = createServiceAccount({ name: "Robot", scope: ["GET runs/:id/events"], actsFor: ann.id });
    const call = streamCall(token!, ann.id);
    expect(serviceStillAllowed(ctx, local(), call)).toBe(true);
    await setStatus(ann.id, "blocked");
    expect(serviceStillAllowed(ctx, local(), call)).toBe(false);
    await setStatus(ann.id, "active");
    expect(serviceStillAllowed(ctx, local(), call)).toBe(true);
    updateServiceAccount(account.id, { actsFor: bob.id });
    expect(serviceStillAllowed(ctx, local(), call)).toBe(false);
    updateServiceAccount(account.id, { actsFor: null });
    expect(serviceStillAllowed(ctx, local(), call)).toBe(false);
    // a stream that began without a link keeps going while there is none
    expect(serviceStillAllowed(ctx, local(), streamCall(token!, account.id))).toBe(true);
  });
});
