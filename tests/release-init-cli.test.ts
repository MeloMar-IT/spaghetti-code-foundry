import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { INIT_USAGE, RECIPE_BRANCH, releaseBuildCommand, type InitOptions } from "../src/release/init-cli.js";
import { parseRecipe } from "../src/release/recipe.js";
import { fakeGithub } from "./helpers/fake-github.js";

let gh: ReturnType<typeof fakeGithub>;
let tmpRoot: string;
const URL99 = "https://github.com/owner/repo/pull/99";
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" }).trim();

/** Adds a commit to main of the bare remote with these files (a null value removes the file; a "->x" value is a symlink to x). */
function seed(files: Record<string, string>, remove: string[] = []): void {
  const work = mkdtempSync(join(gh.tmp, "work-"));
  sh(gh.tmp, "clone", "-q", gh.remote, work);
  for (const f of remove) sh(work, "rm", "-q", f);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(work, p, ".."), { recursive: true });
    if (c.startsWith("->")) symlinkSync(c.slice(2), join(work, p));
    else writeFileSync(join(work, p), c);
  }
  sh(work, "add", "-A");
  sh(work, "commit", "-qm", "seed");
  sh(work, "push", "-q", "origin", "main");
}

let baseSha = "";
// One fake GitHub for the file (its setup is slow); every test starts from the same remote and an empty gh log.
beforeAll(() => {
  gh = fakeGithub();
  seed({ "package.json": '{"scripts":{"build":"tsc"}}', "package-lock.json": "{}" });
  baseSha = sh(gh.remote, "rev-parse", "main");
});
beforeEach(() => {
  sh(gh.remote, "update-ref", "refs/heads/main", baseSha);
  sh(gh.remote, "update-ref", "-d", `refs/heads/${RECIPE_BRANCH}`);
  tmpRoot = mkdtempSync(join(gh.tmp, "tmproot-"));
  delete process.env.FAKE_GH_FAIL;
  delete process.env.FAKE_GH_CREATE_THEN_FAIL;
  writeFileSync(join(gh.tmp, "gh.log"), "");
  for (const f of ["prs.json", "pr", "bodies.json", "lastbody"]) rmSync(join(gh.tmp, `gh.log.${f}`), { force: true });
});
afterAll(() => gh.restore());

async function run(write: boolean, opts: InitOptions = {}, repo = "owner/repo") {
  const out: string[] = [];
  const err: string[] = [];
  const rc = await releaseBuildCommand(["init"], { repo, write }, (l) => out.push(l), (l) => err.push(l), { tmpRoot, ...opts });
  return { rc, out: out.join("\n"), err: err.join("\n") };
}
const created = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh pr create"));
const branches = () => sh(gh.remote, "branch", "--list", RECIPE_BRANCH);
const mainSha = () => sh(gh.remote, "rev-parse", "main");
const left = () => readdirSync(tmpRoot);

describe("scf release-build init", () => {
  it("prints the suggestion and leaves nothing behind", async () => {
    const r = await run(false);
    expect(r.rc).toBe(0);
    expect(parseRecipe(r.out).builds[0]!.run).toBe("npm ci && npm run build && npm pack");
    expect(left()).toEqual([]);
    expect(branches()).toBe("");
    expect(created()).toEqual([]);
    expect(gh.ghLog()).toContain("repo clone owner/repo");
    expect(gh.ghLog()).toContain("--depth 1");
  });

  it("--write pushes the branch and opens a pull request", async () => {
    const before = mainSha();
    const r = await run(true);
    expect(r.err).toBe("");
    expect(r.rc).toBe(0);
    expect(r.out.split("\n").at(-1)).toBe(`pull request: ${URL99}`);
    expect(parseRecipe(sh(gh.remote, "show", `${RECIPE_BRANCH}:.factory/release-build.yaml`)).builds).toHaveLength(1);
    expect(mainSha()).toBe(before);
    expect(created()).toHaveLength(1);
    expect(created()[0]).toContain("--base main --head release-build-recipe");
    expect(left()).toEqual([]);
  });

  it("--write keeps the other files of an existing .factory folder", async () => {
    seed({ ".factory/other.yaml": "a: 1\n" });
    const r = await run(true);
    expect(r.rc).toBe(0);
    expect(sh(gh.remote, "show", `${RECIPE_BRANCH}:.factory/other.yaml`)).toBe("a: 1");
    expect(sh(gh.remote, "show", `${RECIPE_BRANCH}:.factory/release-build.yaml`)).toContain("version:");
  });

  it("--write refuses a .factory that is a symlink", async () => {
    seed({ ".factory": "->../outside" });
    const r = await run(true);
    expect(r.rc).toBe(1);
    expect(r.err).toContain(".factory is not a folder");
    expect(branches()).toBe("");
    expect(created()).toEqual([]);
    expect(existsSync(join(gh.tmp, "outside"))).toBe(false);
    expect(left()).toEqual([]);
  });

  it("--write refuses when the branch exists on the remote", async () => {
    sh(gh.remote, "branch", RECIPE_BRANCH, "main");
    const r = await run(true);
    expect(r.rc).toBe(1);
    expect(r.err).toContain(RECIPE_BRANCH);
    expect(r.err).toContain("already exists");
    expect(created()).toEqual([]);
  });

  it("never changes a branch that appears just before the push", async () => {
    let other = "";
    const r = await run(true, {
      beforePush: () => {
        sh(gh.remote, "branch", RECIPE_BRANCH, "main");
        other = sh(gh.remote, "rev-parse", RECIPE_BRANCH);
      },
    });
    expect(r.rc).toBe(1);
    expect(r.err).toContain("already exists");
    expect(sh(gh.remote, "rev-parse", RECIPE_BRANCH)).toBe(other);
    expect(created()).toEqual([]);
    expect(left()).toEqual([]);
  });

  it("an interrupt before the pull request removes the branch", async () => {
    const r = await run(true, { beforePush: () => void (process as NodeJS.EventEmitter).emit("SIGINT") });
    expect(r.rc).toBe(1);
    expect(r.err).toContain("interrupted");
    expect(branches()).toBe("");
    expect(created()).toEqual([]);
    expect(left()).toEqual([]);
  });

  it("removes its branch when the pull request cannot be opened", async () => {
    process.env.FAKE_GH_FAIL = "pr create";
    const r = await run(true);
    expect(r.rc).toBe(1);
    expect(r.err).toContain("could not open the pull request; nothing was left behind");
    expect(branches()).toBe("");
    expect(left()).toEqual([]);
  });

  it("finds the pull request when gh fails after creating it", async () => {
    process.env.FAKE_GH_CREATE_THEN_FAIL = "1";
    const r = await run(true);
    expect(r.rc).toBe(0);
    expect(r.out).toContain(`pull request: ${URL99}`);
    expect(branches()).toContain(RECIPE_BRANCH);
  });

  it("reports a failed clone", async () => {
    process.env.FAKE_GH_FAIL = "repo clone";
    const r = await run(false);
    expect(r.rc).toBe(1);
    expect(r.err).toBe("could not clone owner/repo: boom");
    expect(left()).toEqual([]);
  });

  it("--write refuses when the recipe file exists, print mode warns", async () => {
    seed({ ".factory/release-build.yaml": "builds: []\n" });
    const w = await run(true);
    expect(w.rc).toBe(1);
    expect(w.err).toContain("already has .factory/release-build.yaml");
    expect(branches()).toBe("");
    expect(created()).toEqual([]);
    const p = await run(false);
    expect(p.rc).toBe(0);
    expect(p.err).toContain("already has");
  });

  it("with nothing detected: a template in print mode, a refusal with --write", async () => {
    seed({ "README.md": "x\n" }, ["package.json", "package-lock.json"]);
    const p = await run(false);
    expect(p.rc).toBe(0);
    expect(p.out.split("\n")[0]).toMatch(/^# Nothing was detected/);
    expect(p.err).toContain("template");
    const w = await run(true);
    expect(w.rc).toBe(1);
    expect(branches()).toBe("");
    expect(created()).toEqual([]);
  });

  it("gives a usage error before anything runs", async () => {
    for (const repo of ["../x", "a b", ""]) {
      await expect(releaseBuildCommand(["init"], { repo }, () => {})).rejects.toThrow(INIT_USAGE);
    }
    await expect(releaseBuildCommand(["init"], {}, () => {})).rejects.toThrow(INIT_USAGE);
    await expect(releaseBuildCommand(["other"], { repo: "o/n" }, () => {})).rejects.toThrow(INIT_USAGE);
    await expect(releaseBuildCommand(["init", "extra"], { repo: "o/n" }, () => {})).rejects.toThrow(INIT_USAGE);
    expect(gh.ghLog()).toBe("");
  });
});
