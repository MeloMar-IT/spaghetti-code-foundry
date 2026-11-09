import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextStepEnv } from "../src/next-step.js";
import { LocalStore } from "../src/stories/local-store.js";
import { STORIES_BRANCH } from "../src/stories/story-commit.js";

// The flow tools on a local repository: a temporary git folder holds the stories, and there is no gh on PATH at all.
const NAME = "local:shop-0123abcd";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const DEPENDS = "Text\n\n### Depends on\n";

let tmp: string;
let dir: string;
let bin: string;
beforeEach(() => {
  if (!existsSync(resolve("dist/stories/store.js"))) throw new Error("dist/ is missing — run `npm run build` first");
  tmp = mkdtempSync(join(tmpdir(), "local-tools-"));
  dir = join(tmp, "shop");
  mkdirSync(dir);
  bin = join(tmp, "bin");
  mkdirSync(bin);
  const gitPath = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  symlinkSync(gitPath, join(bin, "git"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const store = () => new LocalStore(dir, NAME, { branch: STORIES_BRANCH });
async function seed(count: number, body = DEPENDS) {
  for (let n = 1; n <= count; n++) await store().create({ title: `Story number ${n}`, body, labels: [] });
}

function tool(name: string, o: { args?: string[]; input?: string; env?: Record<string, string>; cwd?: string; noDir?: boolean } = {}) {
  const env: Record<string, string> = {
    PATH: bin, FACTORY_HOME: process.env.FACTORY_HOME ?? tmp, GIT_CEILING_DIRECTORIES: tmp, ...GIT_ENV,
    FACTORY_VAR_GITHUB_REPO: NAME, FACTORY_VAR_ISSUE: "7", FACTORY_RUN_ID: "r-1", FACTORY_TOOLS: resolve("tools"), ...o.env,
  };
  if (!o.noDir) env.FACTORY_LOCAL_REPO_DIR = dir;
  const r = spawnSync(process.execPath, [resolve("tools", name), ...(o.args ?? [])], { input: o.input ?? "", cwd: o.cwd ?? dir, encoding: "utf8", env });
  return { status: r.status, out: r.stdout, err: r.stderr, lines: r.stdout.trim().split("\n") };
}

describe("story pr-* commands", () => {
  it("are refused for a local project before anything is called", () => {
    for (const args of [["pr-find", "x"], ["pr-merge", "x"], ["pr-open", "--head", "x", "--title", "t"], ["pr-checks", "x"]]) {
      const r = tool("story", { args });
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.err).toContain("Pull requests are not available for a local project");
      expect(r.out).toBe("");
    }
  });
});

describe("waits-for", () => {
  it("records the wait in a local story and parks", async () => {
    await seed(7);
    const r = tool("waits-for", { input: "WAITS_FOR: #6\nWAITS_FOR_REASON: needs it\n" });
    expect(r.err).toBe("");
    expect(r.lines.at(-1)).toBe("PARKED");
    expect((await store().get(7))?.body).toContain("#6");
  });

  it("asks a question for an unknown issue", async () => {
    await seed(7);
    const r = tool("waits-for", { input: "WAITS_FOR: #99\n" });
    expect(r.status).toBe(0);
    expect(r.lines.at(-1)).toBe("QUESTION");
  });
});

describe("environment", () => {
  it("stops with the variable named when the folder is not given, and makes no gh call", () => {
    for (const name of ["waits-for", "create-split"]) {
      const r = tool(name, { input: "WAITS_FOR: #6\n", noDir: true });
      expect(r.status, name).toBe(1);
      expect(r.err, name).toContain("FACTORY_LOCAL_REPO_DIR");
    }
  });

  it("refuses a name that only starts with local:", () => {
    const r = tool("waits-for", { input: "WAITS_FOR: #6\n", env: { FACTORY_VAR_GITHUB_REPO: "local:bad" } });
    expect(r.status).toBe(1);
    expect(r.err).toContain("set var github_repo to owner/repo");
  });
});

describe("split", () => {
  const SPLIT = [
    "Too big.", "## Split",
    "### ISSUE 1: Part A", "DEPENDS_ON: none", "Do A.",
    "### ISSUE 2: Part B", "DEPENDS_ON: 1", "Do B.",
    "SPLIT_RISK: 20", "PLAN_STATUS: TOO_BIG",
  ].join("\n");

  it("creates the parts with the epic line and dependency, closes the parent, and the family sees a part", async () => {
    await store().create({ title: "Parent", body: "**Epic:** Shop\n\nBig change", labels: [] });
    const r = tool("create-split", { input: SPLIT, env: { FACTORY_VAR_ISSUE: "1" } });
    expect(r.err).toBe("");
    expect(r.out).toContain("SPLIT: #2 #3 — #1 closed");
    // the line comes once every part exists, before the listing comment and the close
    expect(r.out).toContain("SPLIT_PARTS: #2 #3");
    expect(r.out.indexOf("#3 Part B")).toBeLessThan(r.out.indexOf("SPLIT_PARTS:"));
    const a = await store().get(2);
    const b = await store().get(3);
    expect(a?.body).toContain("**Epic:** Shop");
    expect(a?.body).toContain("Part 1 of 2 of #1");
    expect(b?.body).toContain("Part 2 of 2 of #1");
    expect(b?.body).toMatch(/### Depends on\n#2/);
    expect((await store().get(1))?.state).toBe("closed");
    expect((await store().comments(1)).some((c) => c.body.includes("split this issue into"))).toBe(true);

    const again = tool("create-split", { input: SPLIT, env: { FACTORY_VAR_ISSUE: "1" } });
    expect(again.out).toContain("already split");
    const fam = tool("split-family", { env: { FACTORY_VAR_ISSUE: "3" } });
    expect(fam.lines.at(-1)).toBe("FAMILY: part");
  });

  it("closes an open part of a reopened parent without asking for pull requests", async () => {
    await store().create({ title: "Parent", body: "x", labels: [] });
    await store().create({ title: "Part", body: "Part 1 of 1 of #1 (Parent), split by Spaghetti Code Foundry.\n\nDo it.", labels: [] });
    await store().close(1, "not_planned");
    await store().reopen(1);
    const r = tool("split-family", { args: ["close-parts"], env: { FACTORY_VAR_ISSUE: "1" } });
    expect(r.err).toBe("");
    expect(r.out).not.toContain("could not check its pull requests");
  });
});

describe("questions", () => {
  const TECH = "**Q1. Which hash?**\nSome text.\n**Kind:** technical\n**Recommendation:** Use sha256.\n";

  it("posts the questions and the label in ordinary mode", async () => {
    await seed(2, "text");
    const r = tool("post-questions", { input: "### #2\n" + TECH, env: { FACTORY_VAR_ISSUES: "2", FACTORY_VAR_NEEDS_INFO_LABEL: "needs", ...nextStepEnv() } });
    expect(r.err).toBe("");
    expect(r.out).toContain("#2: asked");
    expect(await store().comments(2)).toHaveLength(1);
    expect((await store().get(2))?.labels.map((l) => l.name)).toContain("needs");
  });

  it("decides technical questions once, also on a retry", async () => {
    await seed(2, "text");
    const runDir = join(tmp, "run");
    mkdirSync(runDir);
    const env = { FACTORY_VAR_ISSUES: "2", FACTORY_DECIDE_TECHNICAL: "1", ...nextStepEnv() };
    for (let i = 0; i < 2; i++) {
      const r = tool("post-questions", { args: [runDir], input: "### #2\n" + TECH, env });
      expect(r.err).toBe("");
    }
    const decided = (await store().comments(2)).filter((c) => c.body.includes("**Decided by the Foundry**"));
    expect(decided).toHaveLength(1);
  });

  it("post-plan posts one decided comment and exits 3; a /defaults comment shows in story comments", async () => {
    await seed(7, "text");
    const runDir = join(tmp, "run");
    mkdirSync(runDir);
    const env = { FACTORY_DECIDE_TECHNICAL: "1", ...nextStepEnv() };
    const first = tool("decide-questions.mjs", { args: ["post-plan", runDir], input: TECH, env });
    expect(first.status, first.err).toBe(3);
    const again = tool("decide-questions.mjs", { args: ["post-plan", runDir], input: TECH, env });
    expect(again.err).toBe("");
    expect((await store().comments(7)).filter((c) => c.body.includes("**Decided by the Foundry**"))).toHaveLength(1);
    await store().comment(7, "/defaults use pg");
    const shown = tool("story", { args: ["comments"] });
    expect(shown.out).toContain("/defaults use pg");
  });
});

describe("daily-branch", () => {
  let clone: string;
  const BRANCH = "factory/daily-2020-01-01";
  beforeEach(() => {
    const origin = join(tmp, "origin.git");
    git(tmp, "clone", "-q", "--bare", dir, origin);
    clone = join(tmp, "clone");
    git(tmp, "clone", "-q", origin, clone);
    git(clone, "checkout", "-q", "-b", BRANCH);
    writeFileSync(join(clone, "b.txt"), "b");
    git(clone, "add", ".");
    git(clone, "commit", "-q", "-m", "unfinished work");
    git(clone, "push", "-q", "origin", BRANCH);
    git(clone, "checkout", "-q", "main");
  });

  it("lists the older branch as pending and latest", () => {
    expect(tool("daily-branch", { args: ["pending"], cwd: clone }).out.trim()).toBe(BRANCH);
    expect(tool("daily-branch", { args: ["latest"], cwd: clone }).out.trim()).toBe(BRANCH);
  });

  it("continues the older branch, also with --wait-for-merge, and opens no pull request", () => {
    for (const args of [["prepare"], ["prepare", "--wait-for-merge"]]) {
      const r = tool("daily-branch", { args, cwd: clone });
      expect(r.err, args.join(" ")).toBe("");
      expect(r.out).toContain(`BRANCH: ${BRANCH} (continuing unfinished work)`);
      expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(BRANCH);
      git(clone, "checkout", "-q", "main");
    }
  });

  it("stops open-pr and ensure-pr", () => {
    for (const cmd of ["open-pr", "ensure-pr"]) {
      const r = tool("daily-branch", { args: [cmd, BRANCH], cwd: clone });
      expect(r.status, cmd).toBe(1);
      expect(r.err, cmd).toContain("Pull requests are not available for a local project");
    }
  });
});
