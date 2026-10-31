import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

// The pull request and issue commands of tools/story, with the fake gh. tests/story-tool.test.ts holds the first ones.

const TOOL = resolve("tools/story");
const STORE = resolve("dist/stories/store.js");
const FAKE_GH = resolve("tests/fixtures/fake-gh.sh");
let tmp: string;
let log: string;

beforeEach(() => {
  if (!existsSync(STORE)) throw new Error("dist/stories/store.js is missing — run `npm run build` first");
  tmp = mkdtempSync(join(tmpdir(), "story-tool-pr-"));
  log = join(tmp, "gh.log");
  writeFileSync(log, "");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[], o: { input?: string; env?: Record<string, string | undefined>; stdout?: number } = {}) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    input: o.input ?? "", cwd: tmp, encoding: "utf8",
    ...(o.stdout !== undefined ? { stdio: ["pipe", o.stdout, "pipe"] as const } : {}),
    env: { PATH: process.env.PATH, FACTORY_GH_BIN: FAKE_GH, FAKE_GH_LOG: log, FACTORY_VAR_GITHUB_REPO: "o/r", FACTORY_VAR_ISSUE: "7", ...o.env } as NodeJS.ProcessEnv,
  });
}
const ghLines = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("gh "));
const stub = (name: string, body: string): string => {
  const p = join(tmp, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};

describe("tools/story sends the gh call of the old shell line", () => {
  it.each<[string[], string]>([
    [["title"], "gh issue view 7 --repo o/r --json title -q .title"],
    [["labels"], "gh issue view 7 --repo o/r --json labels --jq .labels[].name"],
    [["comments-labels"], "gh issue view 7 --repo o/r --json comments,labels"],
    [["close", "--reason", "completed"], "gh issue close 7 --repo o/r --reason completed"],
    [["close", "--reason", "not planned"], "gh issue close 7 --repo o/r --reason not planned"],
    [["pr-find", "feat"], "gh pr view feat --repo o/r --json url -q .url"],
    [["pr-find", ""], "gh pr view  --repo o/r --json url -q .url"],
    [["pr-review-decision", "feat"], "gh pr view feat --repo o/r --json reviewDecision -q .reviewDecision"],
    [["pr-list", "--head", "dev", "--base", "main"], "gh pr list --repo o/r --head dev --base main --state open --json number,headRefName,state"],
    [["pr-ready", "5"], "gh pr ready 5 --repo o/r"],
    [["pr-ready", "5", "--undo"], "gh pr ready 5 --repo o/r --undo"],
    [["pr-comment", "5"], "gh pr comment 5 --repo o/r --body-file -"],
    [["pr-edit", "5", "--title", "T"], "gh pr edit 5 --repo o/r --title T --body-file -"],
    [["pr-text", "5"], "gh pr view 5 --repo o/r --json number,title,body -q"],
    [["pr-reviews", "5"], "gh pr view 5 --repo o/r --json reviews,comments --jq"],
    [["pr-review-comments", "5"], "gh api repos/o/r/pulls/5/comments --jq"],
    [["open-stories", "--limit", "50"], "gh issue list --repo o/r --state open --limit 50 --json number,title,body,labels"],
    [["open-stories", "--limit", "201", "--comments"], "gh issue list --repo o/r --state open --limit 201 --json number,title,body,labels,comments"],
    [["pr-open", "--base", "main", "--head", "dev", "--title", "T", "--draft"], "gh pr create --repo o/r --base main --head dev --title T --body-file - --draft"],
    [["pr-merge", "feat"], "gh pr merge feat --repo o/r --squash --delete-branch"],
    [["pr-checks", "feat"], "gh pr checks feat --repo o/r --watch --fail-fast --interval 20"],
    [["pr-checkout", "5"], "gh pr checkout 5 --repo o/r --force"],
  ])("%j", (args, line) => {
    run(args, { input: "x" });
    expect(ghLines().some((l) => l.startsWith(line)), `${line}\n${ghLines().join("\n")}`).toBe(true);
  });

  it("authors sends the query", () => {
    run(["authors"]);
    expect(ghLines()[0]).toContain("gh api graphql -F n=7 -f o=o -f r=r -f query=query($o:String!,$r:String!,$n:Int!)");
  });

  it("label changes the labels through the store", () => {
    const r = run(["label", "--add", "a", "--remove", "b", "--remove", "c"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });
});

describe("pr-open", () => {
  it("passes hostile text unchanged, needs no issue and prints gh's stdout", () => {
    const title = "#7: a $(x) `y` \"q\" 'r' --draft";
    const body = "Body $(y)\n`z`\n";
    const r = run(["pr-open", "--head", "feat", "--title", title], { input: body, env: { FACTORY_VAR_ISSUE: undefined } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("https://github.com/owner/repo/pull/99\n");
    const text = readFileSync(log, "utf8");
    expect(text).toContain(`gh pr create --repo o/r --head feat --title ${title} --body-file -\n--- pr body:\n${body}`);
  });

  it("accepts an empty title and an empty head", () => {
    expect(run(["pr-open", "--head", "", "--title", ""], { input: "b" }).status).toBe(0);
    expect(ghLines()[0]).toBe("gh pr create --repo o/r --head  --title  --body-file -");
  });

  it("shows gh's stdout and exit status when gh fails after creating the pull request", () => {
    const r = run(["pr-open", "--head", "feat", "--title", "T"], { input: "b", env: { FAKE_GH_CREATE_THEN_FAIL: "1", FAKE_GH_FAIL_TEXT: "gh died" } });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("https://github.com/owner/repo/pull/99\n");
    expect(r.stderr).toContain("gh died");
  });
});

describe("pr-checks", () => {
  const checks = (env: Record<string, string>) => run(["pr-checks", "feat"], { env });
  it("passes gh's exit status and output on", () => {
    const failed = checks({ FAKE_GH_CI_FAILS: "1" });
    expect(failed.status).toBe(1);
    expect(failed.stdout).toContain("test  fail  1m");
    expect(checks({ FAKE_GH_CI_FAILS: "5", FAKE_GH_CI_EXIT: "8" }).status).toBe(8);
    const ok = checks({});
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("test  pass  1m");
  });
  it("exits 143 when gh dies from SIGTERM", () => {
    expect(checks({ FAKE_GH_CI_SIGNAL: "TERM" }).status).toBe(143);
  });
  it("shows gh's stderr", () => {
    const r = checks({ FAKE_GH_FAIL: "pr checks", FAKE_GH_FAIL_TEXT: "no checks reported on the 'x' branch" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no checks reported on the 'x' branch");
  });
});

describe("open-stories", () => {
  it("passes an answer above 20 MB through", () => {
    const big = stub("big-gh", "head -c 21000000 /dev/zero | tr '\\0' x");
    const file = join(tmp, "issues.json");
    const fd = openSync(file, "w");
    let r;
    try { r = run(["open-stories", "--limit", "5"], { env: { FACTORY_GH_BIN: big }, stdout: fd }); } finally { closeSync(fd); }
    expect(r.status).toBe(0);
    expect(statSync(file).size).toBe(21_000_000);
  });
});

describe("a failed call keeps what gh printed", () => {
  it("prints stdout, then stderr, and exits 1", () => {
    const partial = stub("partial-gh", "echo partial; echo boom >&2; exit 1");
    const r = run(["pr-text", "5"], { env: { FACTORY_GH_BIN: partial } });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("partial\n");
    expect(r.stderr).toContain("boom");
  });
});

describe("bad input is refused before gh runs", () => {
  it.each<[string[], Record<string, string>]>([
    [["pr-merge"], {}],
    [["pr-merge", "--admin"], {}],
    [["pr-merge", "a b"], {}],
    [["pr-checks"], {}],
    [["pr-checks", "--"], {}],
    [["pr-find"], {}],
    [["pr-find", "-x"], {}],
    [["pr-review-decision", "a", "b"], {}],
    [["pr-comment", "abc"], {}],
    [["pr-comment", "012"], {}],
    [["pr-ready", "0"], {}],
    [["pr-checkout", "--force"], {}],
    [["pr-text"], {}],
    [["close"], {}],
    [["close", "--reason", "nope"], {}],
    [["close", "--reason", "completed"], { FACTORY_VAR_ISSUE: "" }],
    [["label"], {}],
    [["label", "--add", "a", "--add", "b"], {}],
    [["label", "--add", ""], {}],
    [["open-stories"], {}],
    [["open-stories", "--limit", "0"], {}],
    [["open-stories", "--limit", "1001"], {}],
    [["open-stories", "--limit", "x"], {}],
    [["pr-list", "--head", "dev"], {}],
    [["pr-list", "--head", "dev", "--base", "-x"], {}],
    [["pr-open", "--head", "-x", "--title", "T"], {}],
    [["pr-open", "--head", "a b", "--title", "T"], {}],
    [["pr-open", "--head", "a"], {}],
    [["pr-edit", "5"], {}],
    [["title"], { FACTORY_VAR_ISSUE: "x" }],
    [["title", "extra"], {}],
    [["constructor"], {}],
  ])("%j %j", (args, env) => {
    const r = run(args, { input: "x", env });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^story: /);
    expect(r.stdout).toBe("");
    expect(ghLines()).toEqual([]);
  });
});

describe("steps of the blocks and flows", () => {
  const stepRun = (file: string, id: string): string => {
    const def = parseYaml(readFileSync(file, "utf8")) as { steps: { id: string; run?: string }[] };
    return def.steps.find((s) => s.id === id)!.run!;
  };
  function sh(script: string, env: Record<string, string>) {
    const bin = join(tmp, "bin");
    if (!existsSync(bin)) mkdirSync(bin);
    copyFileSync(FAKE_GH, join(bin, "gh"));
    chmodSync(join(bin, "gh"), 0o755);
    return spawnSync("/bin/sh", ["-c", script], {
      cwd: tmp, encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`, FACTORY_TOOLS: resolve("tools"), FACTORY_GH_BIN: "", FAKE_GH_LOG: log,
        FACTORY_VAR_GITHUB_REPO: "o/r", GIT_CEILING_DIRECTORIES: tmp, FACTORY_RUN_ID: "r1", ...env,
      } as NodeJS.ProcessEnv,
    });
  }

  it("wait_ci treats \"no checks reported\" as success", () => {
    spawnSync("git", ["init", "-q", "-b", "x"], { cwd: tmp });
    const r = sh(stepRun("blocks/ci.yaml", "wait_ci"), { FACTORY_VAR_CI_SETTLE_SEC: "0", FAKE_GH_FAIL: "pr checks", FAKE_GH_FAIL_TEXT: "no checks reported on the 'x' branch" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no CI checks configured");
  });

  it("wait_ci passes a signal status on", () => {
    spawnSync("git", ["init", "-q", "-b", "x"], { cwd: tmp });
    const r = sh(stepRun("blocks/ci.yaml", "wait_ci"), { FACTORY_VAR_CI_SETTLE_SEC: "0", FAKE_GH_CI_SIGNAL: "TERM" });
    expect(r.status).toBe(143);
  });

  it("release_pr keeps the pull request number when gh fails after creating it", () => {
    writeFileSync(join(tmp, "checks.md"), "checks\n");
    const script = stepRun("flows/release-daily.yaml", "release_pr").split("{{run.dir}}").join(tmp);
    const r = sh(script, {
      FAKE_GH_CREATE_THEN_FAIL: "1", FACTORY_VAR_DEVELOP_BRANCH: "develop", FACTORY_VAR_MAIN_BRANCH: "main",
      FACTORY_FIRST_MERGE_RELEASE: "first",
    });
    expect(r.stdout).toContain("PR: 99\n");
    expect(ghLines()).toContain("gh pr comment 99 --repo o/r --body-file -");
  });
});
