import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos } from "../src/auth/repos.js";
import { checkLimitsPatch, effectiveLimits, getLimits, limitsPath, removeLimitsLocked, resolveLimits, setDefaultLimits, setUserLimits } from "../src/auth/limits.js";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import { createUser, deleteUser, hashPassword, startSession, UserError, type User } from "../src/auth/users.js";
import { readSessions } from "../src/auth/sessions.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const PW = "test-password-12345";
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let admin: User;
let ann: User;
let bob: User;
const by = () => admin.id;
const bytes = () => readFileSync(limitsPath(), "utf8");
const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

beforeAll(async () => void (await hashPassword(PW)));
beforeEach(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "limits-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  admin = await createUser({ name: "Root", email: "root@example.com", password: PW, role: "admin" });
  ann = await createUser({ name: "Ann", email: "ann@example.com", password: PW });
  bob = await createUser({ name: "Bob", email: "bob@example.com", password: PW });
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("limits store", () => {
  it("has no limits without a file and creates none", () => {
    expect(getLimits()).toEqual({ defaults: {}, users: {} });
    expect(effectiveLimits(ann.id)).toEqual({});
    expect(setDefaultLimits({}, { by: by() }).changed).toEqual([]);
    expect(existsSync(limitsPath())).toBe(false);
  });

  it("stores defaults (mode 0600) that apply to every account, admins too", () => {
    const r = setDefaultLimits({ maxConcurrent: 2, dailyBudgetUsd: 5.5 }, { by: by() });
    expect(r.changed).toEqual(["maxConcurrent", "dailyBudgetUsd"]);
    expect(JSON.parse(bytes())).toEqual({ version: 1, defaults: { maxConcurrent: 2, dailyBudgetUsd: 5.5 }, users: {} });
    expect(statSync(limitsPath()).mode & 0o777).toBe(0o600);
    for (const u of [admin, ann, bob]) expect(effectiveLimits(u.id)).toEqual({ maxConcurrent: 2, dailyBudgetUsd: 5.5 });
  });

  it("lets an override win and keeps the other fields (patch, not replace)", () => {
    setDefaultLimits({ maxConcurrent: 2, maxRunsPerDay: 10, dailyBudgetUsd: 5.5 }, { by: by() });
    setUserLimits(ann.id, { maxConcurrent: 9, maxRunsPerDay: 20 }, { by: by() });
    expect(effectiveLimits(ann.id)).toEqual({ maxConcurrent: 9, maxRunsPerDay: 20, dailyBudgetUsd: 5.5 });
    expect(effectiveLimits(bob.id)).toEqual({ maxConcurrent: 2, maxRunsPerDay: 10, dailyBudgetUsd: 5.5 });
    expect(resolveLimits(ann.id).overridden).toEqual(["maxConcurrent", "maxRunsPerDay"]);
    // omitted fields stay; one cleared field follows the default again, the entry stays while one override is left
    setUserLimits(ann.id, { maxConcurrent: null }, { by: by() });
    expect(getLimits().users[ann.id]).toEqual({ maxRunsPerDay: 20 });
    expect(effectiveLimits(ann.id)).toEqual({ maxConcurrent: 2, maxRunsPerDay: 20, dailyBudgetUsd: 5.5 });
    // changing a default field leaves the other defaults
    setDefaultLimits({ maxConcurrent: null }, { by: by() });
    expect(getLimits().defaults).toEqual({ maxRunsPerDay: 10, dailyBudgetUsd: 5.5 });
    expect(effectiveLimits(bob.id)).toEqual({ maxRunsPerDay: 10, dailyBudgetUsd: 5.5 });
  });

  it("drops the entry when the last override is cleared; null clears all", () => {
    setUserLimits(ann.id, { maxConcurrent: 3, dailyBudgetUsd: 1 }, { by: by() });
    setUserLimits(ann.id, null, { by: by() });
    expect(getLimits().users).toEqual({});
    setUserLimits(ann.id, { maxConcurrent: 3 }, { by: by() });
    setUserLimits(ann.id, { maxConcurrent: null }, { by: by() });
    expect(getLimits().users).toEqual({});
  });

  it("an admin can override their own limits", () => {
    setUserLimits(admin.id, { maxConcurrent: 50 }, { by: by() });
    expect(effectiveLimits(admin.id)).toEqual({ maxConcurrent: 50 });
  });

  it("writes nothing when nothing changes", () => {
    setDefaultLimits({ maxConcurrent: 2 }, { by: by() });
    const before = bytes();
    expect(setDefaultLimits({ maxConcurrent: 2 }, { by: by() }).changed).toEqual([]);
    expect(setDefaultLimits({}, { by: by() }).changed).toEqual([]);
    expect(setUserLimits(ann.id, { maxRunsPerDay: null }, { by: by() }).changed).toEqual([]);
    expect(bytes()).toBe(before);
  });

  it("checks values", () => {
    for (const bad of [{ maxConcurrent: 0 }, { maxRunsPerDay: -1 }, { maxConcurrent: 1.5 }, { dailyBudgetUsd: 0 }, { dailyBudgetUsd: -2 }, { dailyBudgetUsd: "3" }, { maxConcurrent: true }, { dailyBudgetUsd: NaN }, { maxConcurrent: [] }, { x: 1 }, [], null, "x", 5]) {
      expect(thrown(() => checkLimitsPatch(bad)), JSON.stringify(bad)).toMatchObject({ code: "bad-limits" });
    }
    expect(checkLimitsPatch({ maxConcurrent: null, maxRunsPerDay: 3, dailyBudgetUsd: 0.5 })).toEqual({ maxConcurrent: null, maxRunsPerDay: 3, dailyBudgetUsd: 0.5 });
    expect(checkLimitsPatch({ dailyBudgetUsd: 1e100 })).toEqual({ dailyBudgetUsd: 1e100 });
  });

  it("the setters refuse bad values themselves and write nothing", () => {
    for (const bad of [{ maxConcurrent: NaN }, { dailyBudgetUsd: 0 }, { maxRunsPerDay: 1.5 }, { x: 1 }, { dailyBudgetUsd: Infinity }] as never[]) {
      expect(thrown(() => setDefaultLimits(bad, { by: by() })), JSON.stringify(bad)).toMatchObject({ code: "bad-limits" });
      expect(thrown(() => setUserLimits(ann.id, bad, { by: by() }))).toMatchObject({ code: "bad-limits" });
    }
    expect(existsSync(limitsPath())).toBe(false);
    expect(getLimits()).toEqual({ defaults: {}, users: {} });
  });

  it("refuses an unknown account", () => {
    expect(thrown(() => setUserLimits(randomUUID(), {}, { by: by() }))).toMatchObject({ code: "not-found" });
    expect(thrown(() => setUserLimits("nope", {}, { by: by() }))).toBeInstanceOf(UserError);
  });

  it("a broken file means no limits, logged once per failure", () => {
    const logs: string[] = [];
    const log = (m: string) => void logs.push(m);
    writeFileSync(limitsPath(), "not-json");
    expect(thrown(() => getLimits())).toBeInstanceOf(StoreError);
    expect(effectiveLimits(ann.id, log)).toEqual({});
    expect(effectiveLimits(ann.id, log)).toEqual({});
    expect(logs).toEqual(["limits: limits.json not-json"]);
    // a different kind of failure logs again
    writeFileSync(limitsPath(), JSON.stringify({ version: 1, defaults: { maxConcurrent: 0 }, users: {} }));
    expect(effectiveLimits(ann.id, log)).toEqual({});
    expect(logs).toHaveLength(2);
    expect(logs[1]).toBe("limits: limits.json wrong-format");
    writeFileSync(limitsPath(), JSON.stringify({ version: 1, defaults: {}, users: {}, repos: {} }));
    expect(thrown(() => getLimits())).toBeInstanceOf(StoreError);
    // fixed, then broken again: it logs again
    writeFileSync(limitsPath(), JSON.stringify({ version: 1, defaults: {}, users: {} }));
    expect(effectiveLimits(ann.id, log)).toEqual({});
    writeFileSync(limitsPath(), "not-json");
    effectiveLimits(ann.id, log);
    expect(logs).toHaveLength(3);
    // a log that throws does not make it throw
    writeFileSync(limitsPath(), "{");
    effectiveLimits(ann.id, log);
    expect(effectiveLimits(ann.id, () => { throw new Error("x"); })).toEqual({});
    expect(thrown(() => setDefaultLimits({ maxConcurrent: 1 }, { by: by() }))).toBeInstanceOf(StoreError);
  });
});

describe("limits and deleteUser", () => {
  it("removes the override of the deleted account only", () => {
    setDefaultLimits({ maxConcurrent: 2 }, { by: by() });
    setUserLimits(ann.id, { maxConcurrent: 9 }, { by: by() });
    setUserLimits(bob.id, { maxRunsPerDay: 4 }, { by: by() });
    deleteUser(ann.id);
    expect(getLimits()).toEqual({ defaults: { maxConcurrent: 2 }, users: { [bob.id]: { maxRunsPerDay: 4 } } });
  });

  it("writes nothing when the account has no override", () => {
    deleteUser(ann.id);
    expect(existsSync(limitsPath())).toBe(false);
    setUserLimits(admin.id, { maxRunsPerDay: 4 }, { by: by() });
    const before = bytes();
    deleteUser(bob.id);
    expect(bytes()).toBe(before);
  });

  it("a broken limits.json stops the delete before anything changes", () => {
    startSession(ann.id, ann.passwordHash);
    addRepo(ann.id, "acme/app");
    writeFileSync(limitsPath(), "not-json");
    expect(thrown(() => deleteUser(ann.id))).toBeInstanceOf(StoreError);
    expect(readSessions().map((s) => s.userId)).toEqual([ann.id]);
    expect(listRepos(ann.id)).toHaveLength(1);
  });

  it("removeLimitsLocked needs the lock", () => {
    expect(thrown(() => removeLimitsLocked(ann.id))).toBeInstanceOf(Error);
    expect(withAuthLock(() => removeLimitsLocked(ann.id))).toBe(false);
  });
});
