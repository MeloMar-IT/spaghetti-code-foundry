import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_REPOS_MAX, AppReposError, allAppRepos, appRepoAllowed, appReposPath, checkAppRepos, getAppRepos, onAppList, removeAppReposLocked, setAppRepos } from "../src/auth/app-repos.js";
import { auditPath } from "../src/auth/audit.js";
import { addRepo, listRepos, reposPath } from "../src/auth/repos.js";
import { StoreError, withAuthLock } from "../src/auth/store.js";
import { jsonFiles } from "../src/home-migrate.js";
import { createSession, listSessions, refinementsPath } from "../src/refinement/store.js";
import { readSessions } from "../src/auth/sessions.js";
import { createUser, deleteUser, hashPassword, listUsers, startSession, usersPath, type User } from "../src/auth/users.js";
import { addCredential, listCredentials } from "../src/credentials/store.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";

const PW = "test-password-12345";
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let ann: User;
let bob: User;

beforeAll(async () => void (await hashPassword(PW)));
beforeEach(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "app-repos-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  await createUser({ name: "Root", email: "root@example.com", password: PW, role: "admin" });
  ann = await createUser({ name: "Ann", email: "ann@example.com", password: PW });
  bob = await createUser({ name: "Bob", email: "bob@example.com", password: PW });
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe("checkAppRepos", () => {
  it("accepts names and wildcards, normalises them and drops duplicates", () => {
    expect(checkAppRepos(["acme/app", "Acme/App.git", "acme/*", " ACME/* ", "other/x"])).toEqual(["acme/app", "acme/*", "other/x"]);
    expect(checkAppRepos([])).toEqual([]);
  });

  it("refuses what is not a list of entries, naming the position and never the value", () => {
    const bad: unknown[] = ["acme", "*/*", "acme/a/b", "acme/*x", "acme/*.git", "acme/*/", "acme/a*b", "owner/repo", "ac\u0000me/app", "acme/app\u0007", "", 5, null, ["acme/app"]];
    for (const entry of bad) {
      const e = code(() => checkAppRepos(["acme/ok", entry])) as AppReposError;
      expect(e, JSON.stringify(entry)).toBeInstanceOf(AppReposError);
      expect(e.code).toBe("bad-list");
      expect(e.message).toBe('entry 2 is not valid: write "owner/name" or "owner/*"');
    }
    for (const input of ["acme/app", undefined, {}, null]) expect(code(() => checkAppRepos(input))).toMatchObject({ code: "bad-list", message: 'give "repos": a list of entries' });
    expect(code(() => checkAppRepos(Array.from({ length: APP_REPOS_MAX + 1 }, (_, i) => `acme/a${i}`)))).toMatchObject({ code: "bad-list", message: "at most 200 entries" });
    expect(checkAppRepos(Array.from({ length: APP_REPOS_MAX }, (_, i) => `acme/a${i}`))).toHaveLength(APP_REPOS_MAX);
  });
});

describe("onAppList", () => {
  it("matches an exact name in any case, with or without .git", () => {
    expect(onAppList(["acme/app"], "Acme/APP")).toBe(true);
    expect(onAppList(["acme/app"], "acme/app.git")).toBe(true);
    expect(onAppList(["acme/app"], "acme/app2")).toBe(false);
  });

  it("matches owner/* for that owner only", () => {
    expect(onAppList(["acme/*"], "acme/x")).toBe(true);
    expect(onAppList(["acme/*"], "ACME/x.git")).toBe(true);
    expect(onAppList(["acme/*"], "acme2/x")).toBe(false);
    expect(onAppList(["acme/*"], "other/acme")).toBe(false);
  });

  it("matches nothing for an empty list", () => {
    expect(onAppList([], "acme/x")).toBe(false);
  });
});

describe("setAppRepos", () => {
  const lines = () => (statExists(auditPath()) ? readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, string>) : []);
  const statExists = (p: string) => {
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  };

  it("refuses an unknown account", () => {
    expect(code(() => setAppRepos("00000000-0000-4000-8000-000000000000", ["acme/*"]))).toMatchObject({ code: "not-found" });
    expect(statExists(appReposPath())).toBe(false);
  });

  it("writes the file with mode 0600 and reads it back", () => {
    expect(setAppRepos(ann.id, ["Acme/*"])).toEqual({ repos: ["acme/*"], changed: true });
    expect(statSync(appReposPath()).mode & 0o777).toBe(0o600);
    expect(getAppRepos(ann.id)).toEqual(["acme/*"]);
    expect(getAppRepos(bob.id)).toEqual([]);
    expect(appRepoAllowed(ann.id, "acme/x")).toBe(true);
    expect(appRepoAllowed(bob.id, "acme/x")).toBe(false);
    expect([...allAppRepos()]).toEqual([[ann.id, ["acme/*"]]]);
  });

  it("removes the key for an empty list, and says unchanged for the same list", () => {
    setAppRepos(ann.id, ["acme/*"]);
    expect(setAppRepos(ann.id, ["acme/*"]).changed).toBe(false);
    expect(setAppRepos(ann.id, []).changed).toBe(true);
    expect(JSON.parse(readFileSync(appReposPath(), "utf8"))).toEqual({ version: 1, lists: {} });
    expect(setAppRepos(ann.id, []).changed).toBe(false);
  });

  it("writes an audit line with the account and no detail, only when changed and `by` is given", () => {
    const before = lines().filter((l) => l.action === "app-repos-change").length;
    setAppRepos(ann.id, ["acme/*"]);
    setAppRepos(ann.id, ["acme/one"], { by: bob.id });
    setAppRepos(ann.id, ["acme/one"], { by: bob.id });
    const added = lines().filter((l) => l.action === "app-repos-change").slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ by: bob.id, userId: ann.id, result: "ok" });
    expect(added[0]).not.toHaveProperty("detail");
    expect(added[0]).not.toHaveProperty("target");
  });

  it("reads a missing file as empty and throws a StoreError for a broken one", () => {
    expect(getAppRepos(ann.id)).toEqual([]);
    writeFileSync(appReposPath(), "not json");
    expect(code(() => getAppRepos(ann.id))).toBeInstanceOf(StoreError);
    writeFileSync(appReposPath(), JSON.stringify({ version: 1, lists: { [ann.id]: ["Acme/*"] } }));
    expect(code(() => getAppRepos(ann.id))).toBeInstanceOf(StoreError);
    writeFileSync(appReposPath(), JSON.stringify({ version: 1, lists: { [ann.id]: ["acme/*.git"] } }));
    expect(code(() => getAppRepos(ann.id))).toBeInstanceOf(StoreError);
  });

  it("removeAppReposLocked needs the lock and writes nothing when there is no list", () => {
    expect(code(() => removeAppReposLocked(ann.id))).toBeInstanceOf(Error);
    withAuthLock(() => removeAppReposLocked(ann.id));
    expect(statExists(appReposPath())).toBe(false);
  });
});

describe("deleteUser", () => {
  it("removes the list of the account and keeps the other one", () => {
    setAppRepos(ann.id, ["acme/*"]);
    setAppRepos(bob.id, ["other/*"]);
    deleteUser(ann.id);
    expect([...allAppRepos()]).toEqual([[bob.id, ["other/*"]]]);
  });

  it("stops with nothing changed when app-repos.json cannot be read, and works once it is fixed", () => {
    const ok = { ownerOk: () => true, repoName: (_o: string, n: string) => n };
    createSession(ann.id, { repo: "acme/app", idea: "one" }, ok);
    startSession(ann.id, ann.passwordHash);
    addCredential({ userId: ann.id, type: "token", name: "a", secret: fakeToken("Aa1") });
    addRepo(ann.id, "acme/app");
    writeFileSync(appReposPath(), "not json");
    const users = readFileSync(usersPath());
    const repos = readFileSync(reposPath());
    const sessions = readFileSync(refinementsPath());
    expect(code(() => deleteUser(ann.id))).toBeInstanceOf(StoreError);
    expect(readFileSync(usersPath())).toEqual(users);
    expect(readFileSync(reposPath())).toEqual(repos);
    expect(readFileSync(refinementsPath())).toEqual(sessions);
    expect(listRepos(ann.id)).toHaveLength(1);
    expect(listSessions().filter((s) => s.owner === ann.id)).toHaveLength(1);
    expect(readSessions().filter((s) => s.userId === ann.id)).toHaveLength(1);
    expect(listCredentials(ann.id)).toHaveLength(1);
    expect(listUsers().map((u) => u.id)).toContain(ann.id);
    writeFileSync(appReposPath(), JSON.stringify({ version: 1, lists: {} }));
    expect(deleteUser(ann.id).credentials).toBe(1);
  });
});

describe("the data-folder move", () => {
  it("does not list a top-level app-repos.json, but lists one inside a run", () => {
    mkdirSync(join(home, "runs", "x"), { recursive: true });
    writeFileSync(join(home, "app-repos.json"), "{}");
    writeFileSync(join(home, "runs", "x", "app-repos.json"), "{}");
    expect(jsonFiles(home)).toEqual([join(home, "runs", "x", "app-repos.json")]);
  });
});
