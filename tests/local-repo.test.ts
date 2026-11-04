import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_NAME_RE, checkLocalPath, isLocalRepoName, localHasRemote, localPathProblem, localRepoName } from "../src/auth/local-repo.js";
import { RepoError, REPO_METHODS, addRepo, listAllRepos, reposPath, setRepoAuth, setRepoConnection, setRepoSettings, transferRepo } from "../src/auth/repos.js";
import { StoreError } from "../src/auth/store.js";
import { tryParseRepoUrl, validGithubName } from "../src/auth/repo-url.js";
import { listCredentials } from "../src/credentials/store.js";
import { testConnection, messageFor, CODES } from "../src/repos/connect.js";
import { checkRepoMethod } from "../src/server/permissions.js";
import { GitHubStore } from "../src/stories/github-store.js";
import { LocalStore } from "../src/stories/local-store.js";
import { storeFor } from "../src/stories/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OK = { ownerOk: () => true };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

let base: string;
let repo: string;
let home: string;
let saved: string | undefined;

const makeRepo = (name: string) => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  return realpathSync(dir);
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof RepoError) return e.code;
    throw e;
  }
  return "none";
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "local-repo-")));
  repo = makeRepo("my-app");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "local-repo-home-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("checkLocalPath", () => {
  it("accepts the top folder, also with a trailing slash, and returns the real path", () => {
    expect(checkLocalPath(repo)).toBe(repo);
    expect(checkLocalPath(repo + "/")).toBe(repo);
  });

  it("refuses what is not the top folder of a git work tree", () => {
    const plain = join(base, "plain");
    mkdirSync(plain);
    const sub = join(repo, "sub");
    mkdirSync(sub, { recursive: true });
    const file = join(base, "a-file");
    writeFileSync(file, "x");
    const tooLong = join(base, "x".repeat(1000));
    const inputs: unknown[] = [join(base, "missing"), file, plain, sub, "rel/path", "~/x", "", "  ", 42, "/a\u0007b", tooLong];
    for (const input of inputs) {
      let err: unknown;
      try {
        checkLocalPath(input);
      } catch (e) {
        err = e;
      }
      expect(err, String(input)).toBeInstanceOf(RepoError);
      expect((err as RepoError).code).toBe("bad-url");
      expect((err as RepoError).message).toMatch(/path|git|folder/);
    }
  });

  it("refuses a symlink whose real path is too long", () => {
    let deep = base;
    // longer than 1000 characters, but under the 1024 an operating system allows
    while (deep.length < 900) deep = join(deep, "d".repeat(100));
    deep = join(deep, "e".repeat(1005 - deep.length));
    mkdirSync(deep, { recursive: true });
    git(deep, "init", "-q", "--separate-git-dir", join(base, "long-gitdir"));
    const link = join(base, "link-long");
    symlinkSync(deep, link);
    expect(() => checkLocalPath(link)).toThrow(/path/);
  });

  it("refuses the data folder and a folder inside it", () => {
    const inside = join(home, "work");
    mkdirSync(inside);
    git(inside, "init", "-q");
    expect(() => checkLocalPath(inside)).toThrow(/data folder/);
    expect(() => checkLocalPath(home)).toThrow(/data folder/);
  });

  it("refuses when git is missing", () => {
    expect(() => checkLocalPath(repo, { git: "/nonexistent/git" })).toThrow(/git was not found/);
  });
});

describe("names", () => {
  it("builds local:<slug>-<id8>", () => {
    const id = "abcdef12-0000-4000-8000-000000000000";
    expect(localRepoName({ id, url: "/x/My Project!" })).toBe("local:my-project--abcdef12");
    expect(localRepoName({ id, url: "/x/!!!" })).toBe("local:repo-abcdef12");
    for (const url of ["/x/app", "/x/My Project!", "/x/!!!", "/x/" + "a".repeat(80)]) expect(localRepoName({ id, url })).toMatch(LOCAL_NAME_RE);
  });

  it("never looks like a GitHub name", () => {
    const name = localRepoName({ id: "abcdef12-0000-4000-8000-000000000000", url: "/x/app" });
    expect(validGithubName(name)).toBe(false);
    expect(tryParseRepoUrl(name)).toBeUndefined();
    expect(isLocalRepoName(name)).toBe(true);
    expect(isLocalRepoName("local/app")).toBe(false);
    expect(isLocalRepoName("o/r")).toBe(false);
  });

  it("checks the pure rules of a stored path", () => {
    for (const p of ["rel", "/a/../b", "/a/", "/a/" + "b".repeat(1000), "/a\u0001b"]) expect(localPathProblem(p), p).toBeTruthy();
    expect(localPathProblem("/a/b")).toBeUndefined();
  });
});

describe("adding", () => {
  it("saves the real path with no credential", () => {
    const link = join(base, "link-app");
    try {
      symlinkSync(repo, link);
    } catch {
      /* exists */
    }
    const r = addRepo(ANN, { url: link, method: "local" }, OK);
    expect(r).toMatchObject({ method: "local", url: repo, owner: ANN });
    expect(r.credentialId).toBeUndefined();
    expect(listCredentials(ANN)).toEqual([]);
  });

  it("refuses the same folder twice", () => {
    addRepo(ANN, { url: repo, method: "local" }, OK);
    expect(code(() => addRepo(ANN, { url: repo, method: "local" }, OK))).toBe("duplicate");
    expect(code(() => addRepo(BOB, { url: repo, method: "local" }, OK))).toBe("taken");
  });

  it("refuses a user name and a token", () => {
    expect(code(() => addRepo(ANN, { url: repo, method: "local", token: "x" }, OK))).toBe("bad-auth");
    expect(code(() => addRepo(ANN, { url: repo, method: "local", username: "u" }, OK))).toBe("bad-auth");
  });

  it("writes nothing when the path is refused", () => {
    addRepo(ANN, { url: repo, method: "local" }, OK);
    const before = readFileSync(reposPath(), "utf8");
    expect(code(() => addRepo(ANN, { url: join(base, "missing"), method: "local" }, OK))).toBe("bad-url");
    expect(readFileSync(reposPath(), "utf8")).toBe(before);
    expect(listAllRepos()).toHaveLength(1);
  });

  it("makes every other method refuse a path and a file: address", () => {
    for (const method of REPO_METHODS.filter((m) => m !== "local")) {
      expect(code(() => addRepo(ANN, { url: "/abs/path", method, username: "u", token: "t" }, OK)), method).toBe("bad-url");
      expect(code(() => addRepo(ANN, { url: "file:///x", method }, OK)), method).toBe("bad-url");
    }
  });
});

describe("changing", () => {
  it("refuses a change to local, and a change of a local record", () => {
    const a = addRepo(ANN, { url: "https://github.com/o/r" }, OK);
    expect(code(() => setRepoAuth(ANN, a.id, { method: "local" }, OK))).toBe("bad-auth");
    const l = addRepo(ANN, { url: repo, method: "local" }, OK);
    const before = readFileSync(reposPath(), "utf8");
    expect(code(() => setRepoAuth(ANN, l.id, { method: "none" }, OK))).toBe("bad-auth");
    expect(readFileSync(reposPath(), "utf8")).toBe(before);
  });

  it("saves a connection status without a credential", () => {
    const l = addRepo(ANN, { url: repo, method: "local" }, OK);
    const checks = [{ check: "clone" as const, ok: true, code: "ok", message: "m" }];
    expect(setRepoConnection(listAllRepos()[0]!, { at: new Date().toISOString(), ok: true, checks })).toBe("saved");
    expect(l.id).toBeTruthy();
  });

  it("transfers with the method and the path kept", () => {
    const l = addRepo(ANN, { url: repo, method: "local" }, OK);
    const r = transferRepo(l.id, "bob@example.com", { findOwner: () => ({ id: BOB, status: "active" }) });
    expect(r.repo).toMatchObject({ owner: BOB, method: "local", url: repo });
    expect(r.repo.credentialId).toBeUndefined();
  });
});

describe("reading repos.json", () => {
  const rec = (over: object) => ({ id: "33333333-3333-4333-8333-333333333333", owner: ANN, url: "/a/b", method: "local", added: "2026-01-01T00:00:00.000Z", ...over });
  const put = (r: object) => writeFileSync(reposPath(), JSON.stringify({ version: 2, repos: [r] }));

  it("reads a valid local record and refuses an invalid one", () => {
    put(rec({}));
    expect(listAllRepos()).toHaveLength(1);
    for (const bad of [{ url: "rel" }, { url: "/a/../b" }, { url: "/a\u0001b" }, { credentialId: "44444444-4444-4444-8444-444444444444" }, { username: "u" }]) {
      put(rec(bad));
      expect(() => listAllRepos(), JSON.stringify(bad)).toThrow(StoreError);
    }
  });

  it("still reads an old record", () => {
    put(rec({ url: "https://github.com/o/r", method: "none" }));
    expect(listAllRepos()[0]).toMatchObject({ method: "none", url: "https://github.com/o/r" });
  });
});

describe("storeFor", () => {
  it("routes a local name to a LocalStore on the folder, one instance per name", () => {
    const l = addRepo(ANN, { url: repo, method: "local" }, OK);
    const name = localRepoName(l);
    const s = storeFor(name);
    expect(s).toBeInstanceOf(LocalStore);
    expect((s as LocalStore).repo).toBe(name);
    expect(storeFor(name)).toBe(s);
  });

  it("does not read repos.json for a GitHub name", () => {
    writeFileSync(reposPath(), "garbage");
    expect(storeFor("o/r-local-test")).toBeInstanceOf(GitHubStore);
  });

  it("throws for an unknown local name and caches nothing", () => {
    const name = "local:none-00000000";
    expect(() => storeFor(name)).toThrow(/no local repository/);
    expect(() => storeFor(name)).toThrow(/no local repository/);
  });
});

describe("connection test of a local repository", () => {
  const run = (url: string) => testConnection({ url, method: "local" });
  const byCheck = (r: Awaited<ReturnType<typeof run>>, name: string) => r.checks.find((c) => c.check === name)!;

  it("gives Read ok, Write ok and GitHub API skipped", async () => {
    const r = await run(repo);
    expect(r.ok).toBe(true);
    expect(byCheck(r, "clone")).toMatchObject({ ok: true, code: "ok" });
    expect(byCheck(r, "push")).toMatchObject({ ok: true, code: "ok" });
    expect(byCheck(r, "github-api")).toMatchObject({ ok: true, skipped: true, code: "local" });
  });

  it("gives no-folder, not-git and detached", async () => {
    const gone = await run(join(base, "gone"));
    expect(byCheck(gone, "clone").code).toBe("no-folder");
    expect(byCheck(gone, "push")).toMatchObject({ code: "skipped", skipped: true });
    const plain = join(base, "plain-test");
    mkdirSync(plain);
    expect(byCheck(await run(plain), "clone").code).toBe("not-git");
    const d = makeRepo("detached");
    git(d, "checkout", "-q", "--detach");
    expect(byCheck(await run(d), "push").code).toBe("detached");
  });

  it.skipIf(process.getuid?.() === 0)("gives not-writable for a read-only folder, a read-only .scf and a .scf file", async () => {
    const ro = makeRepo("readonly");
    chmodSync(ro, 0o555);
    try {
      expect(byCheck(await run(ro), "push").code).toBe("not-writable");
    } finally {
      chmodSync(ro, 0o755);
    }
    const scf = makeRepo("ro-scf");
    mkdirSync(join(scf, ".scf"));
    chmodSync(join(scf, ".scf"), 0o555);
    try {
      expect(byCheck(await run(scf), "push").code).toBe("not-writable");
    } finally {
      chmodSync(join(scf, ".scf"), 0o755);
    }
    const file = makeRepo("scf-file");
    writeFileSync(join(file, ".scf"), "x");
    expect(byCheck(await run(file), "push").code).toBe("not-writable");
  });

  it("has a sentence for every new code", () => {
    for (const c of ["local", "no-folder", "not-git", "not-writable", "detached"] as const) {
      expect(CODES).toContain(c);
      expect(messageFor(c, "local").length).toBeGreaterThan(10);
    }
    expect(messageFor("ok", "local", "push")).toMatch(/branch/);
  });
});

describe("pushRemote and localHasRemote", () => {
  it("is stored for a local repository, cleared by false, and refused for a GitHub one or a non-boolean", () => {
    const r = addRepo(ANN, { url: repo, method: "local" }, OK);
    expect(setRepoSettings(r.id, { pushRemote: true }).repo.settings).toEqual({ pushRemote: true });
    expect(setRepoSettings(r.id, { pushRemote: false }).repo.settings).toBeUndefined();
    expect(() => setRepoSettings(r.id, { pushRemote: "yes" })).toThrow(/pushRemote must be true or false/);
    const gh = addRepo(ANN, { url: "acme/app", method: "github-token", token: ["github", "pat", ""].join("_") + "Zx9".repeat(12) }, OK);
    expect(code(() => setRepoSettings(gh.id, { pushRemote: true }))).toBe("bad-settings");
    expect(code(() => setRepoSettings(gh.id, { pushRemote: false }))).toBe("none");
  });

  it("localHasRemote is true with a remote, false without one, for a missing path and for a failing git", async () => {
    const dir = makeRepo("with-remote");
    const without = makeRepo("without-remote");
    git(dir, "remote", "add", "origin", join(base, "nowhere.git"));
    expect(await localHasRemote(without)).toBe(false);
    expect(await localHasRemote(dir)).toBe(true);
    expect(await localHasRemote(join(base, "missing"))).toBe(false);
    expect(await localHasRemote(dir, "/nonexistent/git")).toBe(false);
  });
});

describe("checkRepoMethod", () => {
  it("lets only an admin choose none and local", () => {
    expect(() => checkRepoMethod({ role: "user" }, "none")).toThrow(/only an admin may choose "none" \(the server's own access\)/);
    expect(() => checkRepoMethod({ role: "user" }, "local")).toThrow(/only an admin may choose "local"/);
    expect(() => checkRepoMethod({ role: "user" }, "github-token")).not.toThrow();
    expect(() => checkRepoMethod({ role: "admin" }, "local")).not.toThrow();
    expect(() => checkRepoMethod({ role: "admin" }, "none")).not.toThrow();
  });
});
