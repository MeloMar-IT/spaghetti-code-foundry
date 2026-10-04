import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { remoteTools, runsTestsOrBuild, scanRepoAccess, scanSteps, usesRepo } from "./helpers/repo-access-scan.js";

const TOOLS = ["create-split", "daily-branch", "post-questions"];

describe("repo-access scan helpers", () => {
  it("usesRepo sees gh, the remote and the remote tools", () => {
    for (const run of [
      "gh issue view 1",
      "x=$(gh pr list)",
      "echo hi | gh \\\nissue comment 1",
      "git push -q origin HEAD",
      "git -C repo fetch -q",
      "if git ls-remote --heads origin x; then :; fi",
      "git pull -q --rebase origin x",
      'git clone -q -- "$FACTORY_REPO_URL" .',
      '"$FACTORY_TOOLS/daily-branch" latest',
    ]) expect(usesRepo(run, TOOLS), run).toBe(true);
    for (const run of [
      "git checkout -q -B x origin/x",
      "git log origin/main..origin/dev",
      'echo "nothing was pushed"',
      '"$FACTORY_TOOLS/area-lock" release x',
      'node "$FACTORY_TOOLS/issue-digest" out.md',
    ]) expect(usesRepo(run, TOOLS), run).toBe(false);
  });

  it("runsTestsOrBuild sees variables, detect-commands and the project commands", () => {
    for (const run of [
      'sh -c "$FACTORY_VAR_TEST_CMD"',
      "{{vars.test_cmd}}",
      "$FACTORY_VAR_BUILD_CMD",
      '"$FACTORY_TOOLS/detect-commands" test',
      "npm test",
      "pnpm run build",
      "go test ./...",
      "cargo build",
      "./gradlew build -x test",
      "mvn -q package -DskipTests",
      "python3 -m pytest -q",
      "make test",
    ]) expect(runsTestsOrBuild(run), run).toBe(true);
    for (const run of ["gh pr comment 1", "git push -q origin HEAD", 'echo "tested"']) expect(runsTestsOrBuild(run), run).toBe(false);
  });

  it("remoteTools lists the tools that call gh or the remote", () => {
    expect(remoteTools()).toEqual(TOOLS);
  });
});

describe("the scan catches", () => {
  const scan = (steps: { id: string; type?: string; run?: unknown; repo_access?: unknown }[]) => scanSteps("f", steps, TOOLS);
  it("a remote call without the flag", () => {
    for (const run of ["gh issue view 1", "git push -q origin HEAD", '"$FACTORY_TOOLS/create-split" x']) {
      expect(scan([{ id: "a", type: "shell", run }]), run).toEqual([{ where: "f/a", problem: "calls gh or the remote without repo_access" }]);
    }
  });
  it("a flagged step that runs tests, or calls nothing", () => {
    expect(scan([{ id: "a", type: "shell", run: 'gh pr list; sh -c "$FACTORY_VAR_TEST_CMD"', repo_access: true }])).toEqual([
      { where: "f/a", problem: "has repo_access and runs the test or build command" },
    ]);
    expect(scan([{ id: "a", type: "shell", run: "echo hi", repo_access: true }])).toEqual([
      { where: "f/a", problem: "has repo_access but does not call gh or the remote" },
    ]);
  });
  it("nothing in a correct pair", () => {
    expect(scan([
      { id: "a", type: "shell", run: "git push -q origin HEAD", repo_access: true },
      { id: "b", type: "shell", run: "$FACTORY_VAR_TEST_CMD" },
    ])).toEqual([]);
  });
});

describe("the shipped flows", () => {
  it("mark exactly the steps that call gh or the remote", () => {
    expect(scanRepoAccess()).toEqual([]);
  });

  it("issue-gitflow fetches main in its own step", () => {
    const flow = parseYaml(readFileSync("flows/issue-gitflow.yaml", "utf8")) as {
      steps: { id: string; repo_access?: boolean; run?: string; routes?: { goto: string }[] }[];
    };
    const step = (id: string) => flow.steps.find((s) => s.id === id)!;
    expect(step("fetch_main").repo_access).toBe(true);
    expect(step("baseline_main").repo_access).toBeUndefined();
    expect(step("baseline_main").run).not.toContain("git fetch");
    expect(step("feature_branch").routes!.map((r) => r.goto)).toContain("fetch_main");
  });
});

describe("clone steps", { timeout: 60_000 }, () => {
  const ROWS = [
    ["issue-plan", "clone", "."],
    ["issue-code-daily", "daily_branch", "."],
    ["issue-gitflow", "feature_branch", "."],
    ["daily-pr", "clone", "."],
    ["release-daily", "clone", "."],
    ["epic-questions", "clone", "."],
    ["refine-brief", "clone", "repo"],
  ] as const;
  let gh: ReturnType<typeof fakeGithub>;
  const saved = process.env.FACTORY_REPO_URL;
  const config = ConfigSchema.parse({ protected_branches: ["main"] });
  beforeEach(() => {
    gh = fakeGithub();
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
    delete process.env.FACTORY_REPO_URL;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_REPO_URL;
    else process.env.FACTORY_REPO_URL = saved;
    gh.restore();
  });

  it("only the clone steps clone, with plain git first and gh as the fallback", () => {
    for (const [name, id] of ROWS) {
      const flow = loadFlow(name, gh.tmp).flow;
      const step = flow.steps.find((s) => s.id === id)!;
      const run = step.type === "shell" ? step.run : "";
      expect(run, `${name}/${id}`).toContain('git clone -q -- "$FACTORY_REPO_URL"');
      expect(run, `${name}/${id}`).toContain("gh repo clone");
      for (const s of flow.steps) {
        if (s.id === id || s.type !== "shell") continue;
        expect(s.run, `${name}/${s.id}`).not.toMatch(/repo clone|git clone/);
      }
    }
  });

  for (const [name, id, dir] of ROWS) {
    it(`${name}/${id} clones with gh, or with git when FACTORY_REPO_URL is set`, async () => {
      const flow = loadFlow(name, gh.tmp).flow;
      const step = { ...flow.steps.find((s) => s.id === id)! } as Record<string, unknown>;
      for (const k of ["routes", "on_success", "on_failure"]) delete step[k];
      const one = { ...flow, steps: [step] } as typeof flow;
      const go = () =>
        runFlow(one, { task: "", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, config, vars: { github_repo: "acme/app", issue: "5" } });

      const a = await go();
      expect(a.status, a.reason).toBe("succeeded");
      expect(gh.ghLog()).toContain("gh repo clone");

      process.env.FACTORY_REPO_URL = gh.remote;
      const before = gh.ghLog().split("gh repo clone").length;
      const b = await go();
      expect(b.status, b.reason).toBe("succeeded");
      expect(gh.ghLog().split("gh repo clone").length).toBe(before);
      const url = execFileSync("git", ["-C", join(b.workdir!, dir), "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
      expect(url).toBe(gh.remote);
    });
  }
});
