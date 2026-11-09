import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { providerEmail, refreshProviderSession, startProviderSession, type ProviderIdentity } from "../src/auth/provider-users.js";
import { revokeSession, sessionId } from "../src/auth/sessions.js";
import { StoreError } from "../src/auth/store.js";
import {
  changePassword, createUser, deleteUser, getUser, hasAdmin, listUsers, newPasswordLink, resetPassword, setPassword, setStatus, updateUser, usersPath, UserError,
} from "../src/auth/users.js";

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "provider-users-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const who = (over: Partial<ProviderIdentity> = {}): ProviderIdentity => ({ id: randomUUID(), name: "Pia", role: "admin", workspace: "default", ...over });
const started = (i: ProviderIdentity) => {
  const r = startProviderSession(i);
  if (r.kind !== "ok") throw new Error(r.kind);
  return r;
};
const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as UserError).code;
  }
  return "no error";
};

describe("startProviderSession", () => {
  it("creates the record, a session and the audit line", () => {
    const i = who({ workspace: "team-a" });
    const r = started(i);
    expect(r.user).toMatchObject({ id: i.id, name: "Pia", email: providerEmail(i.id), role: "admin", status: "active", source: "provider", workspace: "team-a" });
    expect(r.user.lastSignIn).not.toBeNull();
    expect(getUser(i.id)).toEqual(r.user);
    expect(JSON.parse(readFileSync(join(home, "sessions.json"), "utf8")).sessions[0].id).toBe(sessionId(r.token));
    const lines = readFileSync(join(home, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const line = lines.find((e) => e.action === "sign-in");
    expect(line).toMatchObject({ by: i.id, result: "ok", target: "identity-provider" });
  });
  it("a second start updates name and role", () => {
    const i = who();
    started(i);
    const r = started({ ...i, name: "Pia B", role: "user" });
    expect(r.user).toMatchObject({ name: "Pia B", role: "user" });
    expect(listUsers()).toHaveLength(1);
  });
  it("never takes over a local account, and a blocked record gets no session", async () => {
    const local = await createUser({ name: "Loc", email: "loc@example.com", password: "test-password-12345", role: "admin" });
    expect(startProviderSession(who({ id: local.id }))).toEqual({ kind: "taken" });
    const i = who();
    started(i);
    await setStatus(i.id, "blocked");
    expect(startProviderSession(i)).toEqual({ kind: "blocked" });
    const sessions = JSON.parse(readFileSync(join(home, "sessions.json"), "utf8")).sessions.length;
    expect(sessions).toBe(0); // blocking ended the session; none was added
    // a taken synthetic e-mail
    const j = who();
    await createUser({ name: "X", email: providerEmail(j.id), password: "test-password-12345" });
    expect(startProviderSession(j)).toEqual({ kind: "taken" });
  });
});

describe("refreshProviderSession", () => {
  it("writes nothing when nothing changed", async () => {
    const i = who();
    const r = started(i);
    const before = readFileSync(usersPath());
    const m = statSync(usersPath()).mtimeMs;
    await new Promise((x) => setTimeout(x, 15));
    expect(refreshProviderSession(sessionId(r.token), i).kind).toBe("ok");
    expect(readFileSync(usersPath()).equals(before)).toBe(true);
    expect(statSync(usersPath()).mtimeMs).toBe(m);
  });
  it("writes a changed role", () => {
    const i = who();
    const r = started(i);
    const out = refreshProviderSession(sessionId(r.token), { ...i, role: "user" });
    expect(out).toMatchObject({ kind: "ok", user: { role: "user" } });
    expect(getUser(i.id)!.role).toBe("user");
  });
  it("refuses a gone session, a blocked or a deleted account, and never creates", async () => {
    const i = who({ role: "user" });
    const r = started(i);
    const key = sessionId(r.token);
    expect(refreshProviderSession("0".repeat(64), i).kind).toBe("refused");
    expect(refreshProviderSession(key, { ...i, id: randomUUID() }).kind).toBe("refused");
    revokeSession(key);
    expect(refreshProviderSession(key, i).kind).toBe("refused");
    const k = started(i);
    await setStatus(i.id, "blocked");
    expect(refreshProviderSession(sessionId(k.token), { ...i, name: "Z" }).kind).toBe("refused");
    const d = who({ role: "user" });
    const s = started(d);
    deleteUser(d.id);
    expect(refreshProviderSession(sessionId(s.token), d).kind).toBe("refused");
    expect(getUser(d.id)).toBeUndefined();
  });
});

describe("the account actions on a provider record", () => {
  it("refuses password, link, reset, edit; block and delete work, also for the only admin", async () => {
    const i = who();
    started(i);
    expect(await code(setPassword(i.id, "test-password-12345"))).toBe("provider-account");
    expect(await code(changePassword(i.id, "x", "test-password-12345"))).toBe("provider-account");
    expect(await code(newPasswordLink(i.id))).toBe("provider-account");
    expect(await code(resetPassword(i.id))).toBe("provider-account");
    expect(await code(updateUser(i.id, { name: "N" }))).toBe("provider-account");
    expect((await setStatus(i.id, "blocked")).status).toBe("blocked");
    expect((await setStatus(i.id, "active")).status).toBe("active");
    deleteUser(i.id);
    expect(getUser(i.id)).toBeUndefined();
  });
});

describe("local admins", () => {
  it("hasAdmin ignores provider admins, and setup still works", async () => {
    started(who());
    expect(hasAdmin()).toBe(false);
    const u = await createUser({ name: "Loc", email: "loc@example.com", password: "test-password-12345", role: "admin" }, { onlyIfNoAdmin: true });
    expect(u.role).toBe("admin");
    expect(hasAdmin()).toBe(true);
    expect(await code(createUser({ name: "L2", email: "l2@example.com", password: "test-password-12345", role: "admin" }, { onlyIfNoAdmin: true }))).toBe("admin-exists");
  });
  it("a users.json with a provider record that has a password is refused", () => {
    const i = who();
    started(i);
    const file = JSON.parse(readFileSync(usersPath(), "utf8"));
    file.users[0].passwordLink = { id: "a".repeat(64), expires: new Date().toISOString() };
    writeFileSync(usersPath(), JSON.stringify(file));
    try {
      listUsers();
      throw new Error("no error");
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).kind).toBe("wrong-format");
    }
  });
});
