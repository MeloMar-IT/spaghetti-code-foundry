import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditPath, prepareAuditLocked, scanAudit } from "../src/auth/audit.js";
import { startProviderSession } from "../src/auth/provider-users.js";
import { readSessions } from "../src/auth/sessions.js";
import { withAuthLock } from "../src/auth/store.js";
import {
  UserError, changePassword, createUser, createUserWithLink, getUser, isBreakGlass, newPasswordLink, readUsersFile, resetPassword, setBreakGlass, setPassword, setStatus, startSession, updateUser,
  usersPath, writeUsersFileLocked, type User,
} from "../src/auth/users.js";

// The break-glass account (#834): the store rules. The audit module passes everything through; one test makes an append fail.
vi.mock("../src/auth/audit.js", async (orig) => {
  const m = await orig<typeof import("../src/auth/audit.js")>();
  return { ...m, prepareAuditLocked: vi.fn(m.prepareAuditLocked) };
});

const PW = "test-password-12345";
const PROV_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const dirs: string[] = [];
const saved = process.env.FACTORY_HOME;
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "factory-bg-"));
  dirs.push(d);
  process.env.FACTORY_HOME = d;
  return d;
};
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const admin = (name: string) => createUser({ name, email: `${name}@example.com`, password: PW, role: "admin" });
const audit = async () => {
  const out = [];
  for await (const r of scanAudit()) out.push(r);
  return out;
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as UserError).code;
  }
  return "none";
};

describe("break-glass account", () => {
  it("marks an admin, moves the mark, clears it, and audits each change", async () => {
    fresh();
    const a = await admin("a");
    const b = await admin("b");
    expect(setBreakGlass(a.id, true, { by: "cli" })).toMatchObject({ changed: true, cleared: [] });
    expect(getUser(a.id)?.breakGlass).toBe(true);
    expect((await audit()).filter((r) => r.action === "edit")).toHaveLength(1);
    const moved = setBreakGlass(b.id, true, { by: "cli" });
    expect(moved.cleared.map((u) => u.id)).toEqual([a.id]);
    expect(getUser(a.id)?.breakGlass).toBeUndefined();
    expect(getUser(b.id)?.breakGlass).toBe(true);
    const edits = (await audit()).filter((r) => r.action === "edit");
    expect(edits).toHaveLength(3);
    expect(edits.every((r) => r.by === "cli")).toBe(true);
    expect(setBreakGlass(b.id, true, { by: "cli" }).changed).toBe(false);
    expect(setBreakGlass(b.id, false, { by: "cli" }).changed).toBe(true);
    expect(getUser(b.id)?.breakGlass).toBeUndefined();
    expect(setBreakGlass(b.id, false, { by: "cli" }).changed).toBe(false);
    expect((await audit()).filter((r) => r.action === "edit")).toHaveLength(4);
  });

  it("moves the mark without options (no audit line, no error)", async () => {
    fresh();
    const a = await admin("a");
    const b = await admin("b");
    setBreakGlass(a.id, true);
    expect(setBreakGlass(b.id, true)).toMatchObject({ changed: true, cleared: [expect.objectContaining({ id: a.id })] });
    expect(getUser(a.id)?.breakGlass).toBeUndefined();
    expect(getUser(b.id)?.breakGlass).toBe(true);
    expect((await audit()).filter((r) => r.action === "edit")).toHaveLength(0);
  });

  it("refuses a user, a provider record, an account without a password, a blocked admin and an unknown id", async () => {
    fresh();
    const u = await createUser({ name: "u", email: "u@example.com", password: PW, role: "user" });
    const link = await createUserWithLink({ name: "n", email: "n@example.com", role: "admin" });
    const blocked = await admin("blocked");
    await admin("other");
    await setStatus(blocked.id, "blocked");
    expect(startProviderSession({ id: PROV_ID, name: "P", role: "admin", workspace: "team-a" }).kind).toBe("ok");
    expect(code(() => setBreakGlass(u.id, true))).toBe("bad-role");
    expect(code(() => setBreakGlass(link.user.id, true))).toBe("no-password");
    expect(code(() => setBreakGlass(blocked.id, true))).toBe("bad-role");
    expect(code(() => setBreakGlass("3f2b8c1e-9a4d-4e6f-8b7a-000000000000", true))).toBe("not-found");
    expect(code(() => setBreakGlass(PROV_ID, true))).toBe("provider-account");
  });

  it("isBreakGlass is true only for a marked, active, local admin with a password", async () => {
    fresh();
    const a = await admin("a");
    const base = getUser(a.id)!;
    const marked: User = { ...base, breakGlass: true };
    expect(isBreakGlass(base)).toBe(false);
    expect(isBreakGlass(marked)).toBe(true);
    expect(isBreakGlass({ ...marked, role: "user" })).toBe(false);
    expect(isBreakGlass({ ...marked, status: "blocked" })).toBe(false);
    expect(isBreakGlass({ ...marked, passwordHash: undefined })).toBe(false);
    expect(isBreakGlass({ ...marked, source: "provider" })).toBe(false);
  });

  it("startSession with breakGlass needs the mark and writes the audit line", async () => {
    fresh();
    const a = await admin("a");
    const hash = getUser(a.id)!.passwordHash;
    expect(startSession(a.id, hash, undefined, { audit: true, breakGlass: true })).toBeUndefined();
    expect(readSessions()).toHaveLength(0);
    setBreakGlass(a.id, true);
    expect(startSession(a.id, hash, undefined, { audit: true, breakGlass: true })?.token).toBeTruthy();
    const lines = (await audit()).filter((r) => r.action === "sign-in");
    expect(lines).toEqual([expect.objectContaining({ by: a.id, result: "ok", target: "break-glass" })]);
    expect(lines[0]).not.toHaveProperty("userId");
  });

  it("changes nothing when the audit log cannot be opened or written", async () => {
    fresh();
    const a = await admin("a");
    setBreakGlass(a.id, true);
    const hash = getUser(a.id)!.passwordHash;
    expect(startSession(a.id, hash, undefined, { breakGlass: true })?.token).toBeTruthy();
    const before = JSON.stringify(readSessions());
    const last = getUser(a.id)!.lastSignIn;
    rmSync(auditPath(), { force: true });
    mkdirSync(auditPath()); // cannot be opened as a file
    expect(() => startSession(a.id, hash, undefined, { audit: true, breakGlass: true })).toThrow();
    expect(JSON.stringify(readSessions())).toBe(before);
    expect(getUser(a.id)!.lastSignIn).toBe(last);
    rmSync(auditPath(), { recursive: true });
    // the log opens, but the append fails
    const prepare = vi.mocked(prepareAuditLocked);
    const real = prepare.getMockImplementation()!;
    prepare.mockImplementationOnce((by, ev) => {
      const log = real(by, ev);
      return {
        write: () => {
          throw new Error("disk full");
        },
        close: () => log.close(),
      };
    });
    expect(() => startSession(a.id, hash, undefined, { audit: true, breakGlass: true })).toThrow("disk full");
    expect(JSON.stringify(readSessions())).toBe(before);
    expect(getUser(a.id)!.lastSignIn).toBe(last);
  });

  it("a reset clears the mark and the sessions; a link on a marked record clears it too", async () => {
    fresh();
    const a = await admin("a");
    await admin("b");
    setBreakGlass(a.id, true);
    startSession(a.id, getUser(a.id)!.passwordHash, undefined, { breakGlass: true });
    expect(readSessions()).toHaveLength(1);
    await resetPassword(a.id);
    expect(getUser(a.id)?.breakGlass).toBeUndefined();
    expect(readSessions()).toHaveLength(0);
    // a hand-made record: marked, no password
    withAuthLock(() => {
      const f = readUsersFile();
      writeUsersFileLocked({ ...f, users: f.users.map((u) => (u.id === a.id ? { ...u, breakGlass: true as const } : u)) });
    });
    await newPasswordLink(a.id);
    expect(getUser(a.id)?.breakGlass).toBeUndefined();
  });

  it("a role change to user drops the mark; a name edit and password changes keep it", async () => {
    fresh();
    const a = await admin("a");
    await admin("b");
    setBreakGlass(a.id, true);
    await updateUser(a.id, { name: "Anna" });
    expect(getUser(a.id)?.breakGlass).toBe(true);
    await setPassword(a.id, "test-new-password-2");
    expect(getUser(a.id)?.breakGlass).toBe(true);
    await changePassword(a.id, "test-new-password-2", "test-new-password-3");
    expect(getUser(a.id)?.breakGlass).toBe(true);
    await updateUser(a.id, { role: "user" });
    expect(getUser(a.id)?.breakGlass).toBeUndefined();
  });

  it("a users file with two marks, or a mark on a provider record, cannot be read", async () => {
    fresh();
    const a = await admin("a");
    await admin("b");
    const file = readUsersFile();
    writeFileSync(usersPath(), JSON.stringify({ ...file, users: file.users.map((u) => ({ ...u, breakGlass: true })) }));
    expect(() => getUser(a.id)).toThrow();
    const prov = { id: PROV_ID, name: "P", email: "p@example.com", role: "admin", status: "active", source: "provider", workspace: "team-a", created: new Date().toISOString(), lastSignIn: null, breakGlass: true };
    writeFileSync(usersPath(), JSON.stringify({ version: 1, users: [prov] }));
    expect(() => getUser(a.id)).toThrow();
  });
});
