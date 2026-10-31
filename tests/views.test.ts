import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { StoreError } from "../src/auth/store.js";
import { createUser, getUser, setView, updateUser, usersPath, type UserError } from "../src/auth/users.js";
import { defaultView, isView, viewOf, viewsFor } from "../src/auth/views.js";
import { TEST_PASSWORD } from "./helpers/session.js";

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "views-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const code = async (p: Promise<unknown>) => await p.then(() => undefined, (e: UserError) => e.code);
const make = (role: "admin" | "user", view?: "simple" | "advanced" | "admin") =>
  createUser({ name: role, email: `${role}@example.com`, password: TEST_PASSWORD, role, view });

describe("the rules", () => {
  it("lists the views of a role and the default", () => {
    expect(viewsFor("user")).toEqual(["simple", "advanced"]);
    expect(viewsFor("admin")).toEqual(["simple", "advanced", "admin"]);
    expect(defaultView("user")).toBe("advanced");
    expect(defaultView("admin")).toBe("admin");
    expect(isView("simple")).toBe(true);
    expect(isView("expert")).toBe(false);
    expect(isView(3)).toBe(false);
  });

  it("uses the stored view when the role may use it, else the default", () => {
    expect(viewOf({ role: "user" })).toBe("advanced");
    expect(viewOf({ role: "admin" })).toBe("admin");
    expect(viewOf({ role: "admin", view: "simple" })).toBe("simple");
    expect(viewOf({ role: "user", view: "admin" })).toBe("advanced");
  });
});

describe("setView and createUser", () => {
  it("writes the view and reads it back, with no audit line", async () => {
    const u = await make("user");
    expect(getUser(u.id)).not.toHaveProperty("view");
    setView(u.id, "simple");
    expect(getUser(u.id)?.view).toBe("simple");
    expect(existsSync(auditPath())).toBe(false);
  });

  it("leaves the file alone for the same view", async () => {
    const u = await make("user");
    setView(u.id, "simple");
    const before = readFileSync(usersPath());
    setView(u.id, "simple");
    expect(readFileSync(usersPath()).equals(before)).toBe(true);
  });

  it("refuses a view the role may not use and changes nothing", async () => {
    const u = await make("user");
    const before = readFileSync(usersPath());
    expect(() => setView(u.id, "admin")).toThrowError(expect.objectContaining({ code: "bad-role" }));
    expect(readFileSync(usersPath()).equals(before)).toBe(true);
  });

  it("refuses an unknown account", () => {
    expect(() => setView("00000000-0000-4000-8000-000000000000", "simple")).toThrowError(expect.objectContaining({ code: "not-found" }));
  });

  it("stores the view given to createUser, and has no key without one", async () => {
    expect((await make("user", "simple")).view).toBe("simple");
    const other = await createUser({ name: "B", email: "b@example.com", password: TEST_PASSWORD });
    expect(Object.keys(other)).not.toContain("view");
    expect(await code(createUser({ name: "C", email: "c@example.com", password: TEST_PASSWORD, view: "admin" }))).toBe("bad-role");
  });

  it("keeps the stored view when the role changes, and uses the default of the new role", async () => {
    const root = await make("admin");
    const other = await createUser({ name: "Z", email: "z@example.com", password: TEST_PASSWORD, role: "admin" });
    setView(other.id, "admin");
    const demoted = await updateUser(other.id, { role: "user" });
    expect(demoted.view).toBe("admin");
    expect(viewOf(demoted)).toBe("advanced");
    expect(getUser(root.id)).toBeDefined();
  });
});

describe("the file", () => {
  it("loads a file with and without a view, and refuses an unknown view", async () => {
    const u = await make("user");
    expect(getUser(u.id)?.id).toBe(u.id);
    const file = JSON.parse(readFileSync(usersPath(), "utf8")) as { users: Record<string, unknown>[] };
    file.users[0]!.view = "other";
    writeFileSync(usersPath(), JSON.stringify(file));
    expect(() => getUser(u.id)).toThrow(StoreError);
  });
});
