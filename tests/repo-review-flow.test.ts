import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadFlow } from "../src/flow/load.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

const STEPS = ["clone", "checks", "list_issues", "review", "verify", "check_verify", "plan_stories", "file_stories"];
const TOKEN = `ghp_${"a1B2".repeat(9)}`;

let gh: ReturnType<typeof fakeGithub>;
beforeEach(() => {
  gh = fakeGithub();
});
afterEach(() => gh.restore());

const common = () => ({ runsDir: join(gh.tmp, "runs"), claudeBin });
const run = (vars: Record<string, string> = {}) =>
  runFlow(loadFlow("repo-review", gh.tmp).flow, {
    ...common(), task: "", repo: gh.tmp,
    vars: { github_repo: "acme/app", test_cmd: "true", build_cmd: "", ...vars },
  });
const ids = (s: { history: { id: string }[] }) => s.history.map((h) => h.id);
const out = (s: { history: { id: string; output: string }[] }, id: string) => s.history.find((h) => h.id === id)?.output ?? "";
const ghLines = () => gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));

/** A commit on the fake remote's main branch. */
function addFile(name: string, text: string) {
  const work = mkdtempSync(join(gh.tmp, "w-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: work, stdio: "pipe" });
  git("clone", "-q", gh.remote, ".");
  writeFileSync(join(work, name), text);
  git("add", ".");
  git("commit", "-qm", `add ${name}`);
  git("push", "-q", "origin", "main");
}

const finding = (id: string, o: Record<string, unknown> = {}) => ({ id, category: "correctness", severity: "high", title: `Finding ${id}`, detail: "d", refs: ["README.md:1"], ...o });
const story = (title: string, findings: string[], o: Record<string, unknown> = {}) => ({
  title, kind: "bug", severity: "medium", who: "a user", what: "a fix", why: "it works", problem: "p", where: "w", refs: ["README.md:1"], fix: "f", criteria: ["c"], findings, ...o,
});
const answer = (findings: unknown[], stories: unknown[], dropped: unknown[] = []) => {
  process.env.FAKE_REPO_REVIEW = JSON.stringify({ findings });
  process.env.FAKE_REPO_VERIFY = JSON.stringify({ stories, dropped });
};
const openIssue = (number: number, title: string) => ({ number, title, body: "", labels: [], comments: [] });
const planOpen = (issues: { number: number; title: string }[]) => {
  process.env.FAKE_GH_ISSUES = JSON.stringify(issues.map((i) => openIssue(i.number, i.title)));
  gh.setBugIssues(issues.map((i) => ({ number: i.number, state: "open", state_reason: null, title: i.title, body: "", labels: [], html_url: `https://github.com/acme/app/issues/${i.number}`, created_at: "2026-01-01T00:00:00Z", closed_at: null })));
};

describe("repo-review flow", { timeout: 60_000 }, () => {
  it("files a verified finding of a green repository, and writes only issues and labels", async () => {
    answer([finding("F1", { detail: `key ${TOKEN}` }), finding("F2")], [story("Fix the thing", ["F1"], { problem: `the key is ${TOKEN}` })], [{ finding: "F2", reason: "not reachable" }]);
    const before = gh.remoteGit("for-each-ref");
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(ids(s)).toEqual(STEPS);
    expect(out(s, "checks")).toContain("BASE: green");
    const made = gh.createdBodies();
    expect(made).toHaveLength(1);
    expect(made[0]!.labels).toEqual(["Factory_go", "bug"]);
    expect(made[0]!.body).toContain(`<!-- claude-factory run=${s.runId} repo-review story=1 -->`);
    expect(made[0]!.body).toContain("## Code\n\n- `README.md:1`");
    expect(JSON.stringify(made)).not.toContain(TOKEN);
    // the engine may already have removed the token from the agent's output; either way it is gone
    expect(made[0]!.body).toMatch(/\[(?:redacted|removed: a token)\]/);
    expect(gh.labels()).toEqual(expect.arrayContaining(["Factory_go", "bug"]));
    expect(gh.remoteGit("for-each-ref")).toBe(before);
    for (const l of ghLines()) expect(l, l).toMatch(/^gh (repo clone|issue list|label create|api repos\/acme\/app\/issues)/);
    expect(gh.ghLog().indexOf("label create")).toBeLessThan(gh.ghLog().indexOf("--- created issue"));
    const summary = out(s, "file_stories");
    expect(summary).toMatch(/Filed 1 of 1 stories:\n- #101 Fix the thing/);
    expect(summary).toMatch(/Dropped findings:\n- F2 .*not reachable/);
    expect(summary).not.toContain(TOKEN);
  });

  it("makes story 1 for a build that fails and writes no reports, and the others depend on it", async () => {
    addFile("package.json", "{}\n");
    answer([finding("F1")], [story("Other problem", ["F1"])]);
    const s = await run({ test_cmd: "exit 1" });
    expect(s.status).toBe("succeeded");
    expect(out(s, "checks")).toContain("BASE: red");
    const made = gh.createdBodies();
    expect(made.map((m) => m.title)).toEqual(["Make it build and test", "Other problem"]);
    expect(made[0]!.body).toContain("## Build to fix");
    expect(made[0]!.body).toContain("- `package.json:1`");
    expect(made[1]!.body).toContain("### Depends on\n\n- #101");
  });

  it("names the failing tests of the JUnit reports under ## Failing tests to fix", async () => {
    addFile("package.json", "{}\n");
    answer([], []);
    const xml = '<testsuite tests="1"><testcase classname="a.B" name="c"><failure message="x">b</failure></testcase></testsuite>';
    const s = await run({ test_cmd: `printf '%s' '${xml}' > TEST-a.xml; exit 1` });
    expect(s.status).toBe("succeeded");
    expect(out(s, "checks")).toContain("| a.B.c");
    const made = gh.createdBodies();
    expect(made).toHaveLength(1);
    expect(made[0]!.body).toContain("## Failing tests to fix\n\n- a.B.c");
    expect(made[0]!.body).not.toContain("## Build to fix");
  });

  it("does not file a story an open issue covers, nor story 1 again", async () => {
    addFile("package.json", "{}\n");
    answer([finding("F1")], [story("Covered", ["F1"], { covered_by: 7 })]);
    planOpen([{ number: 7, title: "Already there" }, { number: 9, title: "Make it build and test" }]);
    const s = await run({ test_cmd: "exit 1" });
    expect(s.status).toBe("succeeded");
    expect(gh.createdBodies()).toEqual([]);
    expect(out(s, "file_stories")).toMatch(/Covered — covered by #7/);
    expect(out(s, "file_stories")).toMatch(/Make it build and test — covered by #9/);
  });

  it("files no more than max_stories", async () => {
    answer([1, 2, 3, 4].map((n) => finding(`F${n}`)), [1, 2, 3, 4].map((n) => story(`Story ${n}`, [`F${n}`])));
    const s = await run({ max_stories: "2" });
    expect(s.status).toBe("succeeded");
    expect(gh.createdBodies()).toHaveLength(2);
    expect(out(s, "file_stories")).toContain("not filed: over the limit of 2 stories");
  });

  it("fails in checks for a max_stories out of range, before any agent runs", async () => {
    for (const bad of ["0", "51"]) {
      const s = await run({ max_stories: bad });
      expect(s.status).toBe("failed");
      expect(ids(s)).toEqual(["clone", "checks"]);
      expect(s.history[1]!.output).toContain("max_stories must be a whole number from 1 to 50");
    }
  });

  it("fails when ref names a branch that does not exist", async () => {
    const s = await run({ ref: "nope" });
    expect(s.status).toBe("failed");
    expect(out(s, "clone")).toContain("does not exist");
  });

  it("waits at approve_stories on a scheduled run, then files after approval and checks for duplicates again", async () => {
    answer([finding("F1"), finding("F2")], [story("First", ["F1"]), story("Second", ["F2"])]);
    const s = await run({ chore_watcher: "w1" });
    expect(s.status).toBe("waiting");
    expect(ids(s)).toEqual(STEPS.slice(0, 7));
    expect(s.reason).toMatch(/scheduled review of acme\/app/);
    expect(gh.createdBodies()).toEqual([]);
    // Someone files "First" while the run waits.
    planOpen([{ number: 50, title: "first" }]);
    const r = await resumeRun({ ...common(), runId: s.runId, decision: { approved: true, by: "owner" } });
    expect(r.status).toBe("succeeded");
    expect(gh.createdBodies().map((m) => m.title)).toEqual(["Second"]);
    expect(out(r, "file_stories")).toMatch(/First — covered by #50/);
    // A resume of the filing step does not create it twice.
    rmSync(join(r.runDir, "filed.json"), { force: true });
    const again = await resumeRun({ ...common(), runId: s.runId, from: "file_stories" });
    expect(again.status).toBe("succeeded");
    expect(gh.createdBodies()).toHaveLength(1);
    expect(existsSync(join(r.runDir, "filed.json"))).toBe(true);
  });

  it("nothing is filed when the approval is rejected", async () => {
    answer([finding("F1")], [story("First", ["F1"])]);
    const s = await run({ chore_watcher: "w1" });
    expect(s.status).toBe("waiting");
    await resumeRun({ ...common(), runId: s.runId, decision: { approved: false, by: "owner" } });
    expect(gh.createdBodies()).toEqual([]);
  });

  it("sends a bad verify answer back once, then files", async () => {
    process.env.FAKE_REPO_REVIEW = JSON.stringify({ findings: [finding("F1")] });
    process.env.FAKE_REPO_VERIFY = "this is not json";
    process.env.FAKE_REPO_VERIFY_FIX = JSON.stringify({ stories: [story("Fixed form", ["F1"])], dropped: [] });
    const s = await run();
    expect(s.status).toBe("succeeded");
    expect(ids(s)).toEqual(["clone", "checks", "list_issues", "review", "verify", "check_verify", "fix_verify", "check_verify", "plan_stories", "file_stories"]);
    expect(gh.createdBodies().map((m) => m.title)).toEqual(["Fixed form"]);
  });

  it("fails after two fixes when the verify answer stays bad, with nothing filed", async () => {
    process.env.FAKE_REPO_REVIEW = JSON.stringify({ findings: [finding("F1")] });
    process.env.FAKE_REPO_VERIFY = "this is not json";
    const s = await run();
    expect(s.status).toBe("failed");
    expect(ids(s).filter((i) => i === "fix_verify")).toHaveLength(2);
    expect(gh.createdBodies()).toEqual([]);
    expect(readFileSync(join(s.runDir, "review.json"), "utf8")).toContain("F1");
  });

  it("a scheduled run with no stories and summary_issue=yes waits for approval before the summary is filed", async () => {
    answer([], []);
    const s = await run({ chore_watcher: "w1", summary_issue: "yes" });
    expect(s.status).toBe("waiting");
    expect(s.reason).toMatch(/scheduled review of acme\/app/);
    expect(gh.createdBodies()).toEqual([]);
    const r = await resumeRun({ ...common(), runId: s.runId, decision: { approved: true, by: "owner" } });
    expect(r.status).toBe("succeeded");
    expect(gh.createdBodies()).toHaveLength(1);
    expect(gh.createdBodies()[0]!.labels).toEqual([]);
  });

  it("the fix of a bad verify answer runs with the same read-only tools and permissions as verify", () => {
    const flow = loadFlow("repo-review", gh.tmp).flow;
    const verify = flow.steps.find((s) => s.id === "verify") as Record<string, unknown>;
    const fix = flow.steps.find((s) => s.id === "fix_verify") as Record<string, unknown>;
    expect(fix.permission_mode).toBe("dontAsk");
    expect(fix.permission_mode).toBe(verify.permission_mode);
    expect(fix.allowed_tools).toEqual(["Read", "Glob", "Grep"]);
    expect(fix.allowed_tools).toEqual(verify.allowed_tools);
    expect(fix.resume).toBe("verify");
  });

  it("files the summary as one issue without the build label when summary_issue=yes", async () => {
    answer([finding("F1")], [story("First", ["F1"])]);
    const s = await run({ summary_issue: "yes" });
    expect(s.status).toBe("succeeded");
    const made = gh.createdBodies();
    expect(made.map((m) => m.labels)).toEqual([["Factory_go", "bug"], []]);
    expect(made[1]!.title).toMatch(/^Repository review of acme\/app \(\d{4}-\d{2}-\d{2}\)$/);
    expect(made[1]!.body).toContain("#101 First");
  });
});
