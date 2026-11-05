import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listAllRepos, setRepoSettings } from "../src/auth/repos.js";
import { createUser, findUserByEmail, type User } from "../src/auth/users.js";
import { readAutonomy } from "../src/governance/autonomy-store.js";
import { startProject } from "../src/server/api-starters.js";
import { HttpError } from "../src/server/http.js";
import type { ApiContext } from "../src/server/server.js";
import { BUILTIN_STARTERS } from "../src/starters/starters.js";
import { TEST_PASSWORD } from "./helpers/session.js";

// Creating a project from a starter, without a server: every case of the issue, and what a failure leaves behind (nothing).

const home = process.env.FACTORY_HOME!;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "starter-create-")));
const logs: string[] = [];
let simple: { hidden_starters: string[]; projects_folder?: string } = { hidden_starters: [] };
const ctx = { config: () => ({ simple }), diagLog: (m: string) => logs.push(m), opts: {} } as unknown as ApiContext;
let admin: User;
let n = 0;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const fresh = (): string => {
  const d = join(tmp, `p${n++}`);
  mkdirSync(d);
  return d;
};
const status = async (p: Promise<unknown>): Promise<number | string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof HttpError ? e.status : String(e);
  }
};
/** What a failed request must not leave in the stores. */
const stores = () => ({ repos: listAllRepos().length, autonomy: Object.keys(readAutonomy().repos).length });
const ownStarter = (id: string, edit?: (dir: string) => void): string => {
  const dir = join(home, "starters", id);
  cpSync(join(BUILTIN_STARTERS, "website"), dir, { recursive: true });
  edit?.(dir);
  return dir;
};

beforeAll(async () => {
  admin = findUserByEmail("admin@example.com") ?? (await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" }));
});
beforeEach(() => {
  simple = { hidden_starters: [] };
  logs.length = 0;
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(home, "starters"), { recursive: true, force: true });
});

describe("a project from the Website starter", () => {
  it("makes the folder, the branches, the record and a connection that is ok", async () => {
    const parent = fresh();
    const out = await startProject(ctx, admin, "website", { name: "My First Site!", parent });
    const dir = join(parent, "my-first-site");
    expect(readdirSync(dir).sort()).toEqual([".factory", ".git", ".gitignore", "README.md", "server.mjs", "site", "test"]);
    expect(existsSync(join(dir, "starter.yaml"))).toBe(false);
    expect(existsSync(join(dir, "gitignore"))).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(readFileSync(join(BUILTIN_STARTERS, "website/gitignore"), "utf8"));
    expect(git(dir, "branch", "--show-current")).toBe("develop");
    expect(git(dir, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual(["develop", "main"]);
    expect(git(dir, "rev-list", "--count", "--all")).toBe("1");
    expect(git(dir, "log", "-1", "--format=%an|%s", "main")).toBe("Spaghetti Code Foundry|Start from the Website starter");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(out.repo.method).toBe("local");
    expect(out.repo.url).toBe(dir);
    expect(out.repo.settings.testCommand).toBe("node --test");
    expect(out.connection.ok).toBe(true);
    expect(listAllRepos().find((r) => r.id === out.repo.id)?.settings?.testCommand).toBe("node --test");
    expect(readAutonomy().repos[out.repo.id]).toBeDefined();
    expect(readFileSync(join(home, "audit.jsonl"), "utf8")).toContain("repo-add");
  });

  it("a non-Latin name gives a folder with its letters", async () => {
    const parent = fresh();
    await startProject(ctx, admin, "website", { name: "東京 サイト", parent });
    expect(existsSync(join(parent, "東京-サイト", "server.mjs"))).toBe(true);
  });

  it("a global ignore rule of the account does not drop starter files from the first commit", async () => {
    const oldHome = process.env.HOME;
    const fakeHome = fresh();
    writeFileSync(join(fakeHome, "ignore"), "*.html\n");
    writeFileSync(join(fakeHome, ".gitconfig"), `[core]\n\texcludesFile = ${join(fakeHome, "ignore")}\n`);
    process.env.HOME = fakeHome;
    try {
      const parent = fresh();
      const out = await startProject(ctx, admin, "website", { name: "Global Rules", parent });
      expect(git(out.repo.url, "ls-files")).toContain("site/index.html");
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it("uses projects_folder, and ~/scf-projects of the given home when it is not set", async () => {
    const base = fresh();
    simple = { hidden_starters: [], projects_folder: join(base, "made", "here") };
    await startProject(ctx, admin, "website", { name: "one" });
    expect(existsSync(join(base, "made", "here", "one", "server.mjs"))).toBe(true);
    simple = { hidden_starters: [] };
    const userHome = fresh();
    await startProject(ctx, admin, "website", { name: "two" }, { userHome });
    expect(existsSync(join(userHome, "scf-projects", "two", "server.mjs"))).toBe(true);
  });
});

describe("what is refused", () => {
  it("an existing folder gives 409 and is left as it is", async () => {
    const parent = fresh();
    mkdirSync(join(parent, "taken"));
    writeFileSync(join(parent, "taken", "mine.txt"), "keep");
    const before = stores();
    expect(await status(startProject(ctx, admin, "website", { name: "Taken", parent }))).toBe(409);
    expect(readdirSync(join(parent, "taken"))).toEqual(["mine.txt"]);
    expect(stores()).toEqual(before);
  });

  it("a bad name gives 400 and makes no folder", async () => {
    const parent = fresh();
    for (const name of [undefined, 5, "", "   ", "x".repeat(61), "a\nb", "!!!"]) expect(await status(startProject(ctx, admin, "website", { name, parent })), String(name)).toBe(400);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("an unknown, a hidden and a bad starter id give 404", async () => {
    const parent = fresh();
    expect(await status(startProject(ctx, admin, "nothing", { name: "x", parent }))).toBe(404);
    expect(await status(startProject(ctx, admin, "Bad_Id", { name: "x", parent }))).toBe(404);
    simple = { hidden_starters: ["website"] };
    expect(await status(startProject(ctx, admin, "website", { name: "x", parent }))).toBe(404);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("a broken own starter gives 409 with its problem and makes no folder", async () => {
    ownStarter("broken-one", (d) => rmSync(join(d, "README.md")));
    const parent = fresh();
    await expect(startProject(ctx, admin, "broken-one", { name: "x", parent })).rejects.toThrow(/README\.md is missing/);
    expect(await status(startProject(ctx, admin, "broken-one", { name: "x", parent }))).toBe(409);
    expect(readdirSync(parent)).toEqual([]);
  });

  it("a parent inside the data folder, or one that does not exist, gives 400", async () => {
    mkdirSync(join(home, "inside"), { recursive: true });
    expect(await status(startProject(ctx, admin, "website", { name: "x", parent: join(home, "inside") }))).toBe(400);
    expect(await status(startProject(ctx, admin, "website", { name: "x", parent: join(tmp, "missing") }))).toBe(400);
    expect(await status(startProject(ctx, admin, "website", { name: "x", parent: "relative" }))).toBe(400);
    expect(readdirSync(join(home, "inside"))).toEqual([]);
    expect(existsSync(join(tmp, "missing"))).toBe(false);
  });

  it("a missing projects_folder under a link into the data folder gives 400 and creates nothing", async () => {
    const link = join(fresh(), "link");
    symlinkSync(home, link);
    const before = readdirSync(home).sort();
    simple = { hidden_starters: [], projects_folder: join(link, "deeper", "projects") };
    expect(await status(startProject(ctx, admin, "website", { name: "x" }))).toBe(400);
    simple = { hidden_starters: [] };
    expect(await status(startProject(ctx, admin, "website", { name: "x" }, { userHome: link }))).toBe(400);
    expect(readdirSync(home).sort()).toEqual(before);
  });
});

describe("a failure leaves nothing", () => {
  it("a git failure gives 500, with no folder, no record and no autonomy entry", async () => {
    const parent = fresh();
    const bin = join(fresh(), "git");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const before = stores();
    expect(await status(startProject(ctx, admin, "website", { name: "Fails", parent }, { git: bin }))).toBe(500);
    expect(readdirSync(parent)).toEqual([]);
    expect(stores()).toEqual(before);
    expect(logs.join("\n")).toContain("starters: git init failed");
    expect(logs.join("\n")).not.toContain(parent);
  });

  it("a negative connection result is not a 201 and leaves nothing", async () => {
    ownStarter("with-scf", (d) => writeFileSync(join(d, ".scf"), "not a folder\n"));
    const parent = fresh();
    const before = stores();
    expect(await status(startProject(ctx, admin, "with-scf", { name: "Neg", parent }))).toBe(500);
    expect(readdirSync(parent)).toEqual([]);
    expect(stores()).toEqual(before);
  });

  it("a thrown connection error removes folder, record and autonomy entry", async () => {
    const parent = fresh();
    const before = stores();
    const test = async () => {
      throw new HttpError(409, "a test of this repository is running already");
    };
    expect(await status(startProject(ctx, admin, "website", { name: "Throws", parent }, { test }))).toBe(409);
    expect(readdirSync(parent)).toEqual([]);
    expect(stores()).toEqual(before);
  });

  it("settings that fail after the record was saved remove the record", async () => {
    const parent = fresh();
    const before = stores();
    const settings = (() => {
      throw new Error("disk full");
    }) as unknown as typeof setRepoSettings;
    expect(await status(startProject(ctx, admin, "website", { name: "NoSettings", parent }, { settings }))).toBe(500);
    expect(readdirSync(parent)).toEqual([]);
    expect(stores()).toEqual(before);
  });

  it("a failure inside addRepo after the autonomy entry was written leaves no entry", async () => {
    // a second project in the same folder name cannot be added twice as a record: remove the folder after the first record exists
    const parent = fresh();
    const first = await startProject(ctx, admin, "website", { name: "Dup", parent });
    const before = stores();
    rmSync(join(parent, "dup"), { recursive: true });
    // the same path is a duplicate record now: addRepo refuses after its beforeSave ran
    expect(await status(startProject(ctx, admin, "website", { name: "Dup", parent }))).toBe(409);
    expect(existsSync(join(parent, "dup"))).toBe(false);
    expect(stores()).toEqual(before);
    expect(first.repo.id).toBeDefined();
  });
});
