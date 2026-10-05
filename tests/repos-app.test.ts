import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type NewRepo, REPO_LIMIT, RepoError, addRepo, checkNewRepo, checkRepoAuth, listRepos, repoAccess, reposPath, setRepoAuth, setRepoConnection, getRepo, transferRepo } from "../src/auth/repos.js";
import { StoreError } from "../src/auth/store.js";
import { createUser } from "../src/auth/users.js";
import { TEST_PASSWORD } from "./helpers/session.js";
import { credentialsPath, listCredentials, readSecret } from "../src/credentials/store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { fakeKeygen, type FakeKeygen } from "./helpers/ssh-keygen.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OK = { ownerOk: () => true };
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const TOKEN2 = ["github", "pat", ""].join("_") + "Qq7".repeat(12);
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let kg: FakeKeygen;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repos-app-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  kg = fakeKeygen();
});
afterEach(() => {
  kg.remove();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof RepoError ? e.code : e;
  }
  return undefined;
};
const app = (user: string, url: string, extra: object = {}) => addRepo(user, { url, method: "github-app" }, { ...OK, installationId: "77", ...extra });
const tokenRepo = (user: string, url: string) => addRepo(user, { url, method: "github-token", token: TOKEN }, OK);
const files = () => [reposPath(), credentialsPath()].map((p) => (existsSync(p) ? readFileSync(p, "utf8") : ""));
const tmpAsFolder = () => mkdirSync(`${reposPath()}.tmp`);
const clearTmp = () => rmSync(`${reposPath()}.tmp`, { recursive: true, force: true });
const orphans = (user: string) => {
  const named = new Set(listRepos(user).map((r) => r.credentialId));
  return listCredentials(user).filter((c) => !named.has(c.id));
};

describe("adding with the GitHub App", () => {
  it("stores the installation id, no credential and no Keychain call", () => {
    const r = app(ANN, "acme/app");
    expect(r).toMatchObject({ method: "github-app", installationId: "77", url: "https://github.com/acme/app" });
    expect(r.credentialId).toBeUndefined();
    expect(listCredentials(ANN)).toEqual([]);
    expect(kc.calls()).toEqual([]);
  });

  it("refuses a missing or bad id, an SSH address, another host, a token and a user name", () => {
    const bad = (input: NewRepo, opts: { installationId?: string } = { installationId: "77" }) => code(() => addRepo(ANN, { method: "github-app", ...input }, { ...OK, ...opts }));
    expect(bad({ url: "acme/app" }, {})).toBe("bad-auth");
    expect(bad({ url: "acme/app" }, { installationId: "" })).toBe("bad-auth");
    expect(bad({ url: "acme/app" }, { installationId: "../1" })).toBe("bad-auth");
    expect(bad({ url: "git@github.com:acme/app.git" })).toBe("bad-auth");
    expect(bad({ url: "https://gitlab.com/acme/app" })).toBe("bad-auth");
    expect(bad({ url: "acme/app", token: TOKEN })).toBe("bad-auth");
    expect(bad({ url: "acme/app", username: "ann" })).toBe("bad-auth");
    expect(listRepos(ANN)).toEqual([]);
  });

  it("answers duplicate and taken before a missing id", () => {
    app(ANN, "acme/app");
    expect(code(() => addRepo(ANN, { url: "acme/app", method: "github-app" }, OK))).toBe("duplicate");
    expect(code(() => addRepo(BOB, { url: "acme/app", method: "github-app" }, OK))).toBe("taken");
  });

  it("checkNewRepo throws what the write throws and writes nothing", () => {
    app(ANN, "acme/taken");
    for (let i = 0; i < REPO_LIMIT - 1; i++) addRepo(ANN, { url: `acme/r${i}` }, OK);
    const before = files();
    const cases: [string, NewRepo][] = [
      ["bad-url", { url: "file:///x" }],
      ["bad-auth", { url: "git@github.com:acme/x.git", method: "github-app" }],
      ["bad-auth", { url: "acme/x", method: "github-app", token: TOKEN }],
      ["bad-auth", { url: "acme/x", method: "github-app", username: "ann" }],
      ["bad-auth", { url: "acme/x", method: "nope" }],
      ["duplicate", { url: "acme/taken", method: "github-app" }],
      ["limit", { url: "acme/new", method: "github-app" }],
    ];
    for (const [expected, input] of cases) {
      expect(code(() => checkNewRepo(ANN, input, OK)), JSON.stringify(input)).toBe(expected);
      expect(code(() => addRepo(ANN, input, { ...OK, installationId: "77" })), JSON.stringify(input)).toBe(expected);
    }
    expect(code(() => checkNewRepo(BOB, { url: "acme/taken", method: "github-app" }, OK))).toBe("taken");
    expect(code(() => checkNewRepo(ANN, { url: "acme/fresh", method: "github-app" }, { ownerOk: () => false }))).toBe("no-owner");
    expect(checkNewRepo(BOB, { url: "acme/fresh", method: "github-app" }, OK)).toBeUndefined();
    expect(files()).toEqual(before);
  });
});

describe("changing to and from the GitHub App", () => {
  it("token → app wipes the token and the status; app → token drops the id; an address change keeps the id", () => {
    const r = tokenRepo(ANN, "acme/app");
    setRepoConnection(getRepo(r.id)!, { at: new Date().toISOString(), ok: true, checks: [{ check: "clone", ok: true, code: "ok", message: "The repository can be read." }] });
    expect(listRepos(ANN)[0]!.connection).toBeDefined();
    const toApp = setRepoAuth(ANN, r.id, { method: "github-app" }, { ...OK, installationId: "77" });
    expect(toApp.repo).toMatchObject({ method: "github-app", installationId: "77" });
    expect(toApp.repo.credentialId).toBeUndefined();
    expect(toApp.repo.connection).toBeUndefined();
    expect(listCredentials(ANN)).toEqual([]);

    // the app needs an https address: the SSH form of the same repository is refused
    expect(code(() => setRepoAuth(ANN, r.id, { url: "git@github.com:acme/app.git" }, OK))).toBe("bad-auth");
    const https = setRepoAuth(ANN, r.id, { url: "https://github.com/Acme/App" }, OK);
    expect(https.repo).toMatchObject({ method: "github-app", installationId: "77", url: "https://github.com/Acme/App" });

    const back = setRepoAuth(ANN, r.id, { method: "github-token", token: TOKEN2 }, OK).repo;
    expect(back.installationId).toBeUndefined();
    expect(readSecret(ANN, back.credentialId!)).toBe(TOKEN2);
  });

  it("refuses a token, a user name and a missing id when changing to the app", () => {
    const r = tokenRepo(ANN, "acme/app");
    expect(code(() => setRepoAuth(ANN, r.id, { method: "github-app", token: TOKEN2 }, { ...OK, installationId: "77" }))).toBe("bad-auth");
    expect(code(() => setRepoAuth(ANN, r.id, { method: "github-app", username: "x" }, { ...OK, installationId: "77" }))).toBe("bad-auth");
    expect(code(() => setRepoAuth(ANN, r.id, { method: "github-app" }, OK))).toBe("bad-auth");
    expect(listRepos(ANN)[0]!.method).toBe("github-token");
  });

  it("checkRepoAuth throws what the write throws and writes nothing", () => {
    const mine = tokenRepo(ANN, "acme/app");
    const other = tokenRepo(BOB, "acme/other");
    const before = files();
    const cases: [string, string, object][] = [
      ["not-found", "00000000-0000-4000-8000-000000000000", { method: "github-app" }],
      ["not-found", other.id, { method: "github-app" }],
      ["bad-url", mine.id, { method: "github-app", url: "acme/else" }],
      ["bad-auth", mine.id, { method: "github-app", token: TOKEN2 }],
      ["bad-auth", mine.id, { method: "github-app", username: "ann" }],
      ["bad-auth", mine.id, { method: "github-app", newKey: true }],
      ["bad-auth", mine.id, {}],
    ];
    for (const [expected, id, input] of cases) {
      expect(code(() => checkRepoAuth(ANN, id, input, OK)), JSON.stringify(input)).toBe(expected);
      expect(code(() => setRepoAuth(ANN, id, input, { ...OK, installationId: "77" })), JSON.stringify(input)).toBe(expected);
    }
    // the installation id is looked up afterwards: its absence is no error here
    expect(checkRepoAuth(ANN, mine.id, { method: "github-app" }, OK)).toBeUndefined();
    expect(files()).toEqual(before);
  });

  it("token → app: the record write fails after the wipe; the repeat finishes without an orphan", () => {
    const r = tokenRepo(ANN, "acme/app");
    tmpAsFolder();
    expect(code(() => setRepoAuth(ANN, r.id, { method: "github-app" }, { ...OK, installationId: "77" }))).toBeInstanceOf(StoreError);
    clearTmp();
    expect(listRepos(ANN)[0]!.method).toBe("github-token");
    expect(listCredentials(ANN)).toEqual([]);
    const again = setRepoAuth(ANN, r.id, { method: "github-app" }, { ...OK, installationId: "77" }).repo;
    expect(again).toMatchObject({ method: "github-app", installationId: "77" });
    expect(orphans(ANN)).toEqual([]);
  });

  it("token → app: the Keychain delete fails; the repeat cleans up and keeps the id", () => {
    const r = tokenRepo(ANN, "acme/app");
    kc.fail("delete");
    const first = setRepoAuth(ANN, r.id, { method: "github-app" }, { ...OK, installationId: "77" });
    expect(first.oldKeysLeft).toBe(1);
    expect(first.repo.method).toBe("github-app");
    kc.fail();
    const again = setRepoAuth(ANN, r.id, { method: "github-app" }, OK);
    expect(again.oldKeysLeft).toBe(0);
    expect(again.repo.installationId).toBe("77");
    expect(Object.keys(kc.items())).toEqual([]);
  });

  it("deploy key → app: the record write fails after the wipe; the repeat finishes and no key is left", () => {
    const r = addRepo(ANN, { url: "git@github.com:acme/app.git", method: "ssh-deploy-key" }, OK);
    tmpAsFolder();
    // the app needs https: change the address with it
    expect(code(() => setRepoAuth(ANN, r.id, { method: "github-app", url: "https://github.com/acme/app" }, { ...OK, installationId: "77" }))).toBeInstanceOf(StoreError);
    clearTmp();
    const again = setRepoAuth(ANN, r.id, { method: "github-app", url: "https://github.com/acme/app" }, { ...OK, installationId: "77" }).repo;
    expect(again).toMatchObject({ method: "github-app", installationId: "77" });
    expect(again.publicKey).toBeUndefined();
    expect(listCredentials(ANN)).toEqual([]);
    expect(Object.keys(kc.items())).toEqual([]);
  });
});

describe("the file", () => {
  const base = { id: "33333333-3333-4333-8333-333333333333", owner: ANN, url: "https://github.com/acme/app", added: new Date().toISOString() };
  const write = (rec: object) => writeFileSync(reposPath(), JSON.stringify({ version: 2, repos: [{ ...base, ...rec }] }));

  it("reads a github-app record with an id", () => {
    write({ method: "github-app", installationId: "77" });
    expect(listRepos(ANN)[0]).toMatchObject({ method: "github-app", installationId: "77" });
  });
  it("refuses a github-app record without an id or with a credential, and an id on another method", () => {
    for (const rec of [
      { method: "github-app" },
      { method: "github-app", installationId: "x" },
      { method: "github-app", installationId: "77", credentialId: "44444444-4444-4444-8444-444444444444" },
      { method: "github-app", installationId: "77", username: "ann" },
      { method: "none", installationId: "77" },
    ]) {
      write(rec);
      expect(() => listRepos(ANN), JSON.stringify(rec)).toThrow(StoreError);
    }
  });
});

describe("using a github-app record", () => {
  it("setRepoConnection saves it and stores a new installation id", () => {
    const r = app(ANN, "acme/app");
    const result = { at: new Date().toISOString(), ok: true, checks: [{ check: "clone" as const, ok: true, code: "ok", message: "The repository can be read." }] };
    expect(setRepoConnection(getRepo(r.id)!, result)).toBe("saved");
    expect(listRepos(ANN)[0]).toMatchObject({ installationId: "77", connection: { ok: true } });
    expect(setRepoConnection(getRepo(r.id)!, result, "88")).toBe("saved");
    expect(listRepos(ANN)[0]!.installationId).toBe("88");
    expect(() => setRepoConnection(getRepo(r.id)!, result, "x/y")).toThrow(RepoError);
    expect(kc.calls()).toEqual([]);
  });

  it("gives the app sign-in to a user and an admin", async () => {
    const r = app(ANN, "acme/app");
    expect(repoAccess(ANN, "acme/app")).toEqual({ kind: "app", installationId: "77", url: r.url, github: "acme/app" });
    const admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
    const a = app(admin.id, "acme/web");
    expect(repoAccess(admin.id, "acme/web")).toEqual({ kind: "app", installationId: "77", url: a.url, github: "acme/web" });
    expect(kc.calls()).toEqual([]);
  });

  it("moves with the transfer, with its id, and loses its status, without a Keychain call", () => {
    const r = app(ANN, "acme/app");
    setRepoConnection(getRepo(r.id)!, { at: new Date().toISOString(), ok: true, checks: [{ check: "clone", ok: true, code: "ok", message: "The repository can be read." }] });
    kc.fail("find");
    const moved = transferRepo(r.id, "bob@example.com", { findOwner: () => ({ id: BOB, status: "active" }) });
    kc.fail();
    expect(moved.moved).toBe(true);
    expect(moved.repo).toMatchObject({ owner: BOB, method: "github-app", installationId: "77" });
    expect(moved.repo.connection).toBeUndefined();
    expect(kc.calls()).toEqual([]);
  });

  it("finishes a transfer repeated after a failed record write", () => {
    const r = app(ANN, "acme/app");
    const find = { findOwner: () => ({ id: BOB, status: "active" as const }) };
    tmpAsFolder();
    expect(code(() => transferRepo(r.id, "bob@example.com", find))).toBeInstanceOf(StoreError);
    clearTmp();
    expect(listRepos(ANN)).toHaveLength(1);
    expect(transferRepo(r.id, "bob@example.com", find).repo).toMatchObject({ owner: BOB, method: "github-app" });
  });
});
