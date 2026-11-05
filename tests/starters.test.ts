import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectArtifacts } from "../src/release/build.js";
import { parseRecipe } from "../src/release/recipe.js";
import { parsePreview } from "../src/preview/config.js";
import { freePort } from "../src/preview/support.js";
import { starterView } from "../src/server/api-starters.js";
import { BUILTIN_STARTERS, MAX_STARTER_BYTES, MAX_STARTER_FILES, checkStarter, createProject, listStarters, type Starter } from "../src/starters/starters.js";

// Every built-in starter, and a copy of one as an own starter, must really work: its files pass the checks, a project made from it
// passes its own test, its release recipe makes the artifacts and its preview answers on the ready path. No network.

const home = process.env.FACTORY_HOME!;
const OWN = "my-site";
const tmp = mkdtempSync(join(tmpdir(), "starters-"));
const ids = [...readdirSync(BUILTIN_STARTERS).filter((n) => existsSync(join(BUILTIN_STARTERS, n, "starter.yaml"))), OWN];

const platform = process.platform === "darwin" ? "macos" : "linux";
const fresh = (name: string): string => {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  return d;
};
const write = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
/** An own starter made from the built-in Website starter, which `edit` may spoil. */
function ownStarter(id: string, edit?: (dir: string) => void): string {
  const dir = join(home, "starters", id);
  cpSync(join(BUILTIN_STARTERS, "website"), dir, { recursive: true });
  edit?.(dir);
  return dir;
}
const problemOf = (id: string): string | undefined => listStarters().broken.find((b) => b.id === id)?.problem;

beforeAll(() => {
  ownStarter(OWN, (dir) => write(dir, "starter.yaml", "title: My site\ndescription: Mine.\ntest: node --test\nneeds: [node]\n"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(home, "starters"), { recursive: true, force: true });
});

describe("every starter", () => {
  it.each(ids)("%s works", async (id) => {
    const cat = listStarters();
    const starter = cat.starters.find((s) => s.id === id) as Starter;
    expect(starter, JSON.stringify(cat.broken)).toBeDefined();
    expect(starter.source).toBe(id === OWN ? "own" : "built-in");
    expect(checkStarter(starter.dir, id, starter.source)).toHaveProperty("meta");

    const { dir } = await createProject({ starter, name: "Check " + id, parent: fresh(id), connect: async (d) => d });

    // the project's own test command
    execFileSync("sh", ["-c", starter.test], { cwd: dir, stdio: "pipe", timeout: 60_000 });

    // the release recipe: every build for this system, then its artifacts
    const recipe = parseRecipe(readFileSync(join(dir, ".factory/release-build.yaml"), "utf8"));
    const builds = recipe.builds.filter((b) => (b.on as string[]).includes(platform));
    expect(builds.length).toBeGreaterThan(0);
    for (const b of builds) {
      execFileSync("sh", ["-c", b.run], { cwd: dir, stdio: "pipe", timeout: 60_000 });
      expect(collectArtifacts(dir, b.artifacts).length).toBeGreaterThan(0);
    }

    // the preview: started on a free port, the ready path answers
    const preview = parsePreview(readFileSync(join(dir, ".factory/preview.yaml"), "utf8"));
    const port = await freePort();
    const child = spawn("/bin/sh", ["-c", preview.command], {
      cwd: dir,
      env: { PATH: process.env.PATH, ...preview.env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    try {
      await new Promise<void>((done, fail) => {
        let seen = "";
        child.stdout.on("data", (b: Buffer) => {
          seen += b.toString();
          if (/Listening/.test(seen)) done();
        });
        child.on("error", fail);
        child.on("close", () => fail(new Error("the preview ended: " + seen)));
      });
      const res = await fetch(`http://127.0.0.1:${port}${preview.ready}`);
      expect(res.status).toBe(200);
    } finally {
      try {
        process.kill(-(child.pid as number), "SIGKILL");
      } catch {
        // already gone
      }
    }
  }, 120_000);
});

describe("the built-in starters", () => {
  it("website, web-app and tool are there", () => {
    const { starters, broken } = listStarters();
    const builtIn = starters.filter((s) => s.source === "built-in").map((s) => s.id);
    expect(builtIn).toEqual(expect.arrayContaining(["website", "web-app", "tool"]));
    expect(broken.filter((b) => b.source === "built-in")).toEqual([]);
  });
});

describe("the checks", () => {
  it("a built-in starter passes and the view holds no path", () => {
    const view = JSON.stringify({ starters: listStarters().starters.map(starterView) });
    expect(view).not.toContain(tmp);
    expect(view).not.toContain(home);
    expect(view).not.toContain(BUILTIN_STARTERS);
  });

  it.each([
    ["no-readme", (d: string) => rmSync(join(d, "README.md")), "README.md is missing"],
    ["no-yaml", (d: string) => rmSync(join(d, "starter.yaml")), "starter.yaml is missing"],
    ["bad-yaml", (d: string) => write(d, "starter.yaml", "title: x\n"), "starter.yaml is not valid"],
    ["needs-python", (d: string) => write(d, "starter.yaml", "title: x\ndescription: y\ntest: z\nneeds: [python]\n"), "starter.yaml is not valid"],
    ["unknown-key", (d: string) => write(d, "starter.yaml", "title: x\ndescription: y\ntest: z\nneeds: []\nextra: 1\n"), "starter.yaml is not valid"],
    ["bad-preview", (d: string) => write(d, ".factory/preview.yaml", "ready: nope\n"), "preview.yaml"],
    ["bad-recipe", (d: string) => write(d, ".factory/release-build.yaml", "builds: []\n"), "release-build"],
    ["a-link", (d: string) => symlinkSync("/etc/hosts", join(d, "link")), "contains a link"],
    ["git-folder", (d: string) => { mkdirSync(join(d, ".git")); write(d, ".git/HEAD", "ref: refs/heads/main\n"); }, "contains git data"],
    ["git-file", (d: string) => write(d, "site/.git", "gitdir: /somewhere/else\n"), "contains git data"],
    ["many-files", (d: string) => { for (let i = 0; i < MAX_STARTER_FILES; i++) write(d, `many/f${i}.txt`, "x"); }, "more than 200 files"],
    ["big-files", (d: string) => write(d, "big.bin", "x".repeat(MAX_STARTER_BYTES + 1)), "larger than 2 MB"],
  ])("%s is broken with a plain problem", (id, spoil, problem) => {
    ownStarter(id, spoil);
    expect(problemOf(id)).toContain(problem);
    expect(listStarters().starters.some((s) => s.id === id)).toBe(false);
  });

  it("a folder that is not a valid id is broken, shown cut and without control characters", () => {
    ownStarter("Bad_Id");
    expect(problemOf("Bad_Id")).toContain("not a starter id");
    ownStarter("x\ny".padEnd(60, "z"));
    expect(listStarters().broken.some((b) => b.id.length === 40 && b.id.includes("?"))).toBe(true);
  });

  it("an own starter replaces the built-in and a hidden id hides only the built-in", () => {
    ownStarter("website");
    const own = listStarters().starters.find((s) => s.id === "website");
    expect(own?.source).toBe("own");
    expect(listStarters({ hidden: ["website"] }).starters.some((s) => s.id === "website")).toBe(true);
    rmSync(join(home, "starters", "website"), { recursive: true });
    expect(listStarters().starters.find((s) => s.id === "website")?.source).toBe("built-in");
    expect(listStarters({ hidden: ["website"] }).starters.some((s) => s.id === "website")).toBe(false);
  });

  it("there is no cut-off: more than 50 own entries are all listed and a last one still replaces the built-in", () => {
    const dirs = join(home, "starters");
    for (let i = 0; i < 60; i++) mkdirSync(join(dirs, `a${String(i).padStart(2, "0")}`), { recursive: true });
    ownStarter("website");
    const cat = listStarters();
    expect(cat.starters.length + cat.broken.length).toBeGreaterThan(60);
    expect(cat.starters.find((s) => s.id === "website")?.source).toBe("own");
    expect(cat.broken.filter((b) => /^a\d\d$/.test(b.id)).length).toBe(60);
    for (let i = 0; i < 60; i++) rmSync(join(dirs, `a${String(i).padStart(2, "0")}`), { recursive: true });
    rmSync(join(dirs, "website"), { recursive: true });
  });
});
