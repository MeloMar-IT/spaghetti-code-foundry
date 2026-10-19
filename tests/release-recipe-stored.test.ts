import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_RECIPE_TEXT, RepoSettingsSchema, checkRepoSettings } from "../src/auth/repo-settings.js";
import { RepoError, addRepo, listRepos, reposPath, setRepoSettings } from "../src/auth/repos.js";
import { MAX_RECIPE_BYTES, findReleaseRecipe, hasReleaseRecipe, loadReleaseRecipe, parseRecipe, storedReleaseRecipes } from "../src/release/recipe.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const OK = { ownerOk: () => true };
const FILE = "builds:\n  - {name: filed, run: make, artifacts: [out]}\n";
const STORED = "builds:\n  - {name: stored, run: make, artifacts: [out]}\n";

const message = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
};

describe("releaseRecipe setting", () => {
  const code = (v: unknown) => {
    try {
      checkRepoSettings({ releaseRecipe: v });
    } catch (e) {
      return e instanceof RepoError ? e.code : e;
    }
    return undefined;
  };

  it("turns CRLF into LF and trims the end", () => {
    expect(checkRepoSettings({ releaseRecipe: "a: 1\r\nb: 2\r\n\r\n  " })).toEqual({ releaseRecipe: "a: 1\nb: 2" });
    expect(checkRepoSettings({ releaseRecipe: "a:\n\t- x" })).toEqual({ releaseRecipe: "a:\n\t- x" });
  });

  it("clears with empty text, blanks, null or a missing key", () => {
    for (const v of ["", "  \n", null, undefined]) expect(checkRepoSettings({ releaseRecipe: v })).toEqual({});
    expect(checkRepoSettings({})).toEqual({});
  });

  it("refuses non-text, control characters and long text", () => {
    expect(code(5)).toBe("bad-settings");
    expect(code("a\u0007b")).toBe("bad-settings");
    expect(code("x".repeat(MAX_RECIPE_TEXT + 1))).toBe("bad-settings");
    expect(code("x".repeat(MAX_RECIPE_TEXT))).toBeUndefined();
  });

  it("loads old stored settings without the key", () => {
    expect(RepoSettingsSchema.safeParse({ testCommand: "npm test" }).success).toBe(true);
    expect(RepoSettingsSchema.safeParse({ releaseRecipe: STORED }).success).toBe(true);
  });
});

describe("finding the release recipe", () => {
  let home: string;
  let saved: string | undefined;
  let repo: string;
  let withFile: string;
  let withoutFile: string;
  let asDir: string;
  let asLink: string;
  let big: string;

  const git = (dir: string, ...a: string[]) =>
    execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e.io", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e.io" } }).trim();
  const commit = (setup: () => void): string => {
    rmSync(join(repo, ".factory"), { recursive: true, force: true });
    setup();
    writeFileSync(join(repo, "marker.txt"), String(Math.random()));
    git(repo, "add", "-A", "-f");
    git(repo, "commit", "-q", "-m", "c");
    return git(repo, "rev-parse", "HEAD");
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "recipe-git-"));
    git(repo, "init", "-q");
    withFile = commit(() => {
      mkdirSync(join(repo, ".factory"));
      writeFileSync(join(repo, ".factory", "release-build.yaml"), FILE);
    });
    withoutFile = commit(() => undefined);
    asDir = commit(() => {
      mkdirSync(join(repo, ".factory", "release-build.yaml"), { recursive: true });
      writeFileSync(join(repo, ".factory", "release-build.yaml", "x"), "x");
    });
    asLink = commit(() => {
      mkdirSync(join(repo, ".factory"));
      symlinkSync("elsewhere", join(repo, ".factory", "release-build.yaml"));
    });
    big = commit(() => {
      mkdirSync(join(repo, ".factory"));
      writeFileSync(join(repo, ".factory", "release-build.yaml"), `# ${"x".repeat(MAX_RECIPE_BYTES)}\n${FILE}`);
    });
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    home = mkdtempSync(join(tmpdir(), "recipe-home-"));
    process.env.FACTORY_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const store = (url = "https://github.com/Acme/App", text = STORED) => {
    const rec = addRepo(ANN, url, OK);
    setRepoSettings(rec.id, { releaseRecipe: text });
  };

  it("finds the stored recipe for any spelling of the name", () => {
    store();
    for (const name of ["Acme/App", "acme/app.git", "ACME/app"]) expect(storedReleaseRecipes(name)).toEqual({ registered: true, texts: [STORED.trimEnd()] });
    expect(storedReleaseRecipes("acme/other")).toEqual({ registered: false, texts: [] });
    expect(storedReleaseRecipes("not a name")).toEqual({ registered: false, texts: [] });
  });

  it("uses the stored recipe when the commit has no file", () => {
    store();
    expect(findReleaseRecipe("acme/app.git", repo, withoutFile)).toEqual({ source: "stored", text: STORED.trimEnd() });
    expect(hasReleaseRecipe("acme/app", repo, withoutFile)).toBe(true);
    expect(loadReleaseRecipe("acme/app", repo, withoutFile).source).toBe("stored");
  });

  it("lets the file win, even when the store cannot be read", () => {
    store();
    expect(findReleaseRecipe("acme/app", repo, withFile)).toEqual({ source: "file", text: FILE });
    writeFileSync(reposPath(), "{ not json");
    expect(findReleaseRecipe("acme/app", repo, withFile)?.source).toBe("file");
    expect(message(() => findReleaseRecipe("acme/app", repo, withoutFile))).toMatch(/stored in the Foundry settings cannot be read/);
  });

  it("gives null and the two no-recipe messages when there is none", () => {
    expect(findReleaseRecipe("acme/app", repo, withoutFile)).toBeNull();
    expect(hasReleaseRecipe("acme/app", repo, withoutFile)).toBe(false);
    expect(message(() => loadReleaseRecipe("acme/app", repo, withoutFile))).toMatch(/no release-build recipe .*is not a repository in the Foundry/);
    addRepo(ANN, "acme/app", OK);
    expect(message(() => loadReleaseRecipe("acme/app", repo, withoutFile))).toMatch(/no release-build recipe .*none stored in the Foundry settings for acme\/app/);
  });

  it("never falls back to the stored recipe when git cannot show the file", () => {
    store();
    expect(message(() => findReleaseRecipe("acme/app", repo, "0".repeat(40)))).toMatch(/cannot find commit/);
    expect(message(() => findReleaseRecipe("acme/app", repo, "--all"))).toMatch(/not a usable commit/);
    expect(message(() => findReleaseRecipe("acme/app", home, withoutFile))).toMatch(/cannot find commit/);
    expect(message(() => findReleaseRecipe("acme/app", repo, asDir))).toMatch(/is not a file/);
    expect(message(() => findReleaseRecipe("acme/app", repo, asLink))).toMatch(/is not a file/);
    expect(message(() => findReleaseRecipe("acme/app", repo, big))).toMatch(/too big/);
  });

  it("merges identical texts of a legacy duplicate and refuses different ones", () => {
    writeFileSync(reposPath(), JSON.stringify({ version: 1, repos: { [ANN]: ["acme/app"], [BOB]: ["acme/app"] } }));
    const [a] = listRepos(ANN);
    const [b] = listRepos(BOB);
    setRepoSettings(a!.id, { releaseRecipe: STORED });
    setRepoSettings(b!.id, { releaseRecipe: STORED });
    expect(findReleaseRecipe("acme/app", repo, withoutFile)?.source).toBe("stored");
    setRepoSettings(b!.id, { releaseRecipe: FILE });
    expect(message(() => findReleaseRecipe("acme/app", repo, withoutFile))).toMatch(/different release-build recipes/);
  });

  it("names the stored recipe when it is no longer valid", () => {
    store("https://github.com/Acme/App", "builds: []");
    expect(message(() => loadReleaseRecipe("acme/app", repo, withoutFile))).toMatch(/the release-build recipe stored in the Foundry settings is not valid/);
  });
});

describe("parseRecipe(text, what)", () => {
  it("uses what in its messages", () => {
    expect(message(() => parseRecipe("a: [unclosed", "my recipe"))).toMatch(/^my recipe is not valid YAML/);
    expect(message(() => parseRecipe("", "my recipe"))).toBe("my recipe is empty");
    expect(message(() => parseRecipe("builds: []", "my recipe"))).toMatch(/^my recipe is not valid\n/);
  });
});
