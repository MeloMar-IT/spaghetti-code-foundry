import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, reposPath, setRepoSettings } from "../src/auth/repos.js";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// The skill-write flow end to end: fake claude, fake scf, fake gh and a bare repository as the remote.
const REPO = "acme/app";
const DEMO = resolve("tests/fixtures/skill-write/demo-skill");
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const FAKES = ["FAKE_SKILL_PLAN", "FAKE_SKILL_SRC", "FAKE_SKILL_NAME", "FAKE_SKILL_REVIEW", "FAKE_SKILL_BAD_ONCE", "FAKE_SCF_EFFECT", "FAKE_SCF_WITH", "FAKE_SCF_WITH_OLD", "FAKE_SCF_EFFECT_OLD", "FAKE_SCF_LIFECYCLE_FAIL", "FAKE_SCF_HISTORY", "FAKE_GH_ISSUE_BODIES", "FAKE_SCF_LOG", "FAKE_GH_COMMENTS", "FACTORY_CLI_BIN"];
const flowOf = () => parseFlow(readFileSync("flows/skill-write.yaml", "utf8"), "flows/skill-write.yaml");

describe("skill-write flow", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let rec: { id: string };
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 1 });
  const runsDir = () => join(gh.tmp, "runs");
  const scfLog = () => join(gh.tmp, "scf.log");

  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
    const bin = join(gh.tmp, "fake-scf.sh");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${resolve("tests/fixtures/fake-scf.mjs")}" "$@"\n`);
    chmodSync(bin, 0o755);
    Object.assign(process.env, { FACTORY_CLI_BIN: bin, FAKE_SCF_LOG: scfLog(), FAKE_SKILL_SRC: DEMO });
    rmSync(reposPath(), { force: true });
    rec = addRepo("11111111-1111-4111-8111-111111111111", `https://github.com/${REPO}`, { ownerOk: () => true });
    setRepoSettings(rec.id, { kind: "skill-library" });
  });
  afterEach(() => gh.restore());

  const watcher = () => new Watcher(WatcherSchema.parse({
    id: "sw", github_repo: REPO, label: "Skill_write", flow: "skill-write", one_at_a_time: true,
    status_labels: LABELS, remove_on_done: ["Skill_write"], vars: {},
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const issues = (n: number, labels: string[] = ["Skill_write"], body = "") => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: n, title: `Skill ${n}`, body, labels: labels.map((name) => ({ name })) }]);
    if (body) process.env.FAKE_GH_ISSUE_BODIES = JSON.stringify({ [String(n)]: body });
  };
  const CHANGE_PLAN = "SKILL_NAME: demo-skill\nSKILL_CHANGE: change\n## What it must teach\n- x\n## Sample tasks\n- y\nPLAN_STATUS: READY";
  const IMPROVE_BODY = "### What to do\n\n- Installed: `demo-id@1.0.0`\n\n<!-- scf skill-improve=demo-skill -->";
  const foundryComment = (body: string) => ({ author: { login: "foundry-owner" }, createdAt: "2026-01-01T00:00:00Z", viewerDidAuthor: true, body });
  const scfCalls = () => readFileSync(scfLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
  /** The deprecate calls (the history reads of a second failure are not counted). */
  const lifecycleCalls = () => scfCalls().filter((c) => c[1] === "lifecycle" && c[3] === "deprecated");
  const settle = async () => {
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
  };
  const runOf = (issue: string) => scheduler.list().find((s) => s.flow === "skill-write" && s.vars.issue === issue);
  const ids = (issue: string) => runOf(issue)!.history.map((h) => h.id);
  const mainLog = () => gh.remoteGit("log", "--format=%s", "main").trim().split("\n");
  const wc = () => {
    const dir = mkdtempSync(join(gh.tmp, "wc-"));
    execFileSync("git", ["clone", "-q", gh.remote, dir]);
    return dir;
  };
  /** A commit on the remote main made by someone else. */
  const pushToMain = (files: Record<string, string>, message: string) => {
    const dir = wc();
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", message], { cwd: dir });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: dir });
    rmSync(dir, { recursive: true, force: true });
  };
  /** The skill is on main at a lower version than the one the writer produces. */
  const seedOld = () => pushToMain({ "skills/demo-skill/SKILL.md": readFileSync(join(DEMO, "SKILL.md"), "utf8").replace("Keeps", "Old: keeps").replace("version: 1.0.0", "version: 0.9.0") }, "Add skill demo-skill");
  const rejectMainOnce = () => {
    const flag = join(gh.tmp, "rejected-once");
    writeFileSync(join(gh.remote, "hooks", "pre-receive"), [
      "#!/bin/sh",
      "while read old new ref; do",
      `  if [ "$ref" = refs/heads/main ] && [ ! -f "${flag}" ]; then touch "${flag}"; echo "Internal Server Error" >&2; exit 1; fi`,
      "done",
    ].join("\n"), { mode: 0o755 });
  };

  it("is shaped as planned: no issue text in shell commands, a bounded writer, a read-only reviewer, one stop step", () => {
    const flow = flowOf();
    expect(flow.one_per_repo).toBe(true);
    expect(flow.steps.map((s) => s.id)).toEqual(["clone", "read_issue", "plan", "pick", "write", "check", "measure", "review", "after_review", "publish", "report", "ask_for_info"]);
    for (const s of flow.steps) if (s.type === "shell") expect(s.run, s.id).not.toMatch(/\{\{\s*(task|steps\.)/);
    const write = flow.steps.find((s) => s.id === "write") as { max_visits: number; allowed_tools: string[] };
    expect(write.max_visits).toBe(8);
    expect((flow.steps.find((s) => s.id === "check") as { max_visits: number }).max_visits).toBe(9);
    expect(write.allowed_tools.join(" ")).not.toMatch(/node|git/);
    for (const id of ["plan", "review"]) expect((flow.steps.find((s) => s.id === id) as { allowed_tools: string[] }).allowed_tools).toEqual(["Read", "Glob", "Grep"]);
    expect(flow.steps.filter((s) => s.on_success === "stop").map((s) => s.id)).toEqual(["ask_for_info"]);
    expect(flow.steps.find((s) => s.id === "ask_for_info")).toMatchObject({ jump_only: true, resume_from: "clone" });
  });

  it("writes a new skill, publishes exactly that folder to main, comments the scores and closes the issue", async () => {
    issues(5);
    await watcher().tick();
    await settle();
    const run = runOf("5")!;
    expect(run.reason).toBeUndefined();
    expect(run.status).toBe("succeeded");
    expect(ids("5")).toEqual(["clone", "read_issue", "plan", "pick", "write", "check", "measure", "review", "publish", "report"]);
    expect(mainLog()[0]).toBe("Add skill demo-skill (#5)");
    const files = gh.remoteGit("show", "--name-only", "--format=", "main").trim().split("\n");
    expect(files.length).toBeGreaterThan(3);
    expect(files.every((f) => f.startsWith("skills/demo-skill/"))).toBe(true);
    expect(files).toContain("skills/demo-skill/evals/suite.yaml");
    expect(readFileSync(scfLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([["skills", "effect", "skills/demo-skill"]]);
    const comment = gh.comments().find((c) => c.body.includes("wrote the skill"))!;
    expect(comment.body).toMatch(/\nEFFECT demo@1\.0\.0 helps /);
    expect(comment.body).toContain(`<!-- claude-factory run=${run.runId} -->`);
    expect(gh.ghLog()).toMatch(/gh issue close 5 --repo acme\/app --reason completed/);
  }, 120_000);

  it("changes an existing skill", async () => {
    seedOld();
    process.env.FAKE_SKILL_PLAN = CHANGE_PLAN;
    issues(6);
    await watcher().tick();
    await settle();
    expect(runOf("6")!.status).toBe("succeeded");
    expect(mainLog()[0]).toBe("Change skill demo-skill (#6)");
    expect(gh.remoteGit("show", "main:skills/demo-skill/SKILL.md")).not.toContain("Old:");
    // a change is measured twice: the new folder and the old one, on the new suite
    const calls = scfCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(["skills", "effect", "skills/demo-skill"]);
    expect(calls[1]![2]).toMatch(/^\/.*\/skills\/demo-skill$/);
    expect(calls[1]![3]).toBe("skills/demo-skill/evals/suite.yaml");
    expect(gh.comments().find((c) => c.body.includes("wrote the skill"))!.body).toContain("COMPARE: better");
  }, 120_000);

  it("does not publish a change that scores lower than the old version, and stops with both scores", async () => {
    seedOld();
    const before = mainLog();
    process.env.FAKE_SKILL_PLAN = CHANGE_PLAN;
    process.env.FAKE_SCF_WITH = "10/12";
    process.env.FAKE_SCF_WITH_OLD = "11/12";
    issues(14);
    await watcher().tick();
    await settle();
    expect(runOf("14")!.status).toBe("stopped");
    expect(ids("14").at(-1)).toBe("ask_for_info");
    expect(ids("14")).not.toContain("publish");
    expect(mainLog()).toEqual(before);
    const c = gh.comments().find((x) => x.body.includes("does not score as well"))!;
    expect(c.body).toContain("COMPARE: not-better (not-better-than-old)");
    expect(c.body).toMatch(/\nOLD EFFECT demo@1\.0\.0 helps /);
    expect(lifecycleCalls()).toEqual([]);
  }, 120_000);

  it("does not publish a change whose runs cannot be compared with the old version", async () => {
    seedOld();
    process.env.FAKE_SKILL_PLAN = CHANGE_PLAN;
    process.env.FAKE_SCF_WITH_OLD = "5/6";
    issues(15);
    await watcher().tick();
    await settle();
    expect(runOf("15")!.status).toBe("stopped");
    expect(gh.comments().find((x) => x.body.includes("does not score as well"))!.body).toContain("(not-comparable)");
  }, 120_000);

  it("on an improve issue the first failure only counts, the second deprecates the skill and labels the issue", async () => {
    seedOld();
    process.env.FAKE_SKILL_PLAN = CHANGE_PLAN;
    process.env.FAKE_SCF_WITH = "10/12";
    process.env.FAKE_SCF_WITH_OLD = "11/12";
    issues(16, ["Skill_write"], IMPROVE_BODY);
    await watcher().tick();
    await settle();
    expect(runOf("16")!.status).toBe("stopped");
    expect(lifecycleCalls()).toEqual([]);
    const first = gh.comments().find((x) => x.body.includes("does not score as well"))!;
    expect(first.body).toContain("first try");
    // a reply resumes the same run, so the marker names the run and the time of the try
    expect(first.body).toContain(`<!-- scf skill-improve-failed run=${runOf("16")!.runId}-`);

    // a person replies; the second try fails too, and the first failure is read from the comments
    issues(16, ["Skill_write", "Factory_needs_info"], IMPROVE_BODY);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({
      comments: [foundryComment(first.body), { author: { login: "marcel" }, createdAt: "2026-01-01T01:00:00Z", body: "Try again." }],
      labels: [],
    });
    await watcher().tick();
    await settle();
    const calls = lifecycleCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 5)).toEqual(["skills", "lifecycle", "demo-id@1.0.0", "deprecated", "--reason"]);
    expect(calls[0]![5]).toBe("did not improve in 2 tries (issue #16)");
    const second = gh.comments().filter((x) => x.body.includes("does not score as well")).at(-1)!;
    expect(second.body).toContain("**deprecated**");
    expect(gh.ghLog()).toMatch(/--add-label Factory_needs_info/);
  }, 240_000);

  it("says so when the skill could not be set to deprecated, and still labels the issue", async () => {
    seedOld();
    process.env.FAKE_SKILL_PLAN = CHANGE_PLAN;
    process.env.FAKE_SCF_WITH = "10/12";
    process.env.FAKE_SCF_WITH_OLD = "11/12";
    process.env.FAKE_SCF_LIFECYCLE_FAIL = "1";
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [foundryComment("earlier\n<!-- scf skill-improve-failed run=20260101-000000-abcd -->\n<!-- claude-factory run=20260101-000000-abcd -->")], labels: [] });
    issues(17, ["Skill_write"], IMPROVE_BODY);
    await watcher().tick();
    await settle();
    expect(lifecycleCalls()).toHaveLength(1);
    const c = gh.comments().find((x) => x.body.includes("does not score as well"))!;
    expect(c.body).toContain("could **not** be set to deprecated");
    expect(c.body).not.toContain("is now **deprecated**");
    expect(gh.ghLog()).toMatch(/--add-label Factory_needs_info/);
  }, 120_000);

  it("does not deprecate a quarantined version after two failed tries: the quarantine stays and the issue is labelled", async () => {
    seedOld();
    process.env.FAKE_SKILL_PLAN = CHANGE_PLAN;
    process.env.FAKE_SCF_WITH = "10/12";
    process.env.FAKE_SCF_WITH_OLD = "11/12";
    process.env.FAKE_SCF_HISTORY = "#1 2026-01-01T00:00:00.000Z cli active → quarantined: unsafe";
    issues(19, ["Skill_write"], IMPROVE_BODY);
    await watcher().tick();
    await settle();
    const first = gh.comments().find((x) => x.body.includes("does not score as well"))!;
    issues(19, ["Skill_write", "Factory_needs_info"], IMPROVE_BODY);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({
      comments: [foundryComment(first.body), { author: { login: "marcel" }, createdAt: "2026-01-01T01:00:00Z", body: "Try again." }],
      labels: [],
    });
    await watcher().tick();
    await settle();
    expect(lifecycleCalls()).toEqual([]);
    expect(scfCalls().filter((c) => c[1] === "lifecycle").map((c) => c.length)).toEqual([3]);
    const second = gh.comments().filter((x) => x.body.includes("does not score as well")).at(-1)!;
    expect(second.body).toContain("its state is quarantined");
    expect(second.body).not.toContain("is now **deprecated**");
    expect(gh.ghLog()).toMatch(/--add-label Factory_needs_info/);
  }, 240_000);

  it("fails the run when an improve issue names another skill than the plan", async () => {
    seedOld();
    process.env.FAKE_SKILL_PLAN = CHANGE_PLAN;
    issues(18, ["Skill_write"], IMPROVE_BODY.replace("skill-improve=demo-skill", "skill-improve=other-skill"));
    await watcher().tick();
    await settle();
    expect(runOf("18")!.status).toBe("failed");
    expect(runOf("18")!.history.at(-1)!.output).toContain("a different skill");
  }, 120_000);

  it("sends a failed check back to the writer and publishes the second try without the stray file", async () => {
    process.env.FAKE_SKILL_BAD_ONCE = join(gh.tmp, "bad-once");
    issues(7);
    await watcher().tick();
    await settle();
    expect(runOf("7")!.status).toBe("succeeded");
    expect(ids("7").filter((i) => i === "write")).toHaveLength(2);
    const checks = runOf("7")!.history.filter((h) => h.id === "check").map((h) => h.output);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toContain("PROBLEM changed outside skills/demo-skill/: notes.txt");
    expect(checks[0]).toMatch(/^CHECK: failed$/m);
    expect(checks[1]).toMatch(/^CHECK: ok$/m);
    expect(gh.remoteGit("ls-tree", "--name-only", "main").split("\n")).not.toContain("notes.txt");
  }, 120_000);

  it("stops with the scores when the skill does not help, publishes nothing, and a reply starts again at clone", async () => {
    process.env.FAKE_SCF_EFFECT = "no-measurable-effect";
    issues(8);
    const before = mainLog();
    await watcher().tick();
    await settle();
    const run = runOf("8")!;
    expect(run.status).toBe("stopped");
    expect(run.reason).toContain('stopped at step "ask_for_info"');
    // the first measurement without effect sends the sample tasks back to the writer once; the second one asks
    expect(ids("8")).toEqual(["clone", "read_issue", "plan", "pick", "write", "check", "measure", "write", "check", "measure", "ask_for_info"]);
    const measures = run.history.filter((h) => h.id === "measure").map((h) => h.output);
    expect(measures[0]).toMatch(/^MEASURE: retask$/m);
    expect(measures[1]).toMatch(/^MEASURE: no-help$/m);
    expect(mainLog()).toEqual(before);
    const asked = gh.comments().find((c) => c.body.includes("does not measurably help"))!;
    expect(asked.body).toMatch(/\nEFFECT demo@1\.0\.0 no-measurable-effect /);
    expect(gh.ghLog()).not.toContain("gh issue close");
    expect(gh.ghLog()).toMatch(/--add-label Factory_needs_info/);

    // a person replies; the scores are better now
    process.env.FAKE_SCF_EFFECT = "helps";
    issues(8, ["Skill_write", "Factory_needs_info"]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({
      comments: [
        { author: { login: "foundry-owner" }, createdAt: "2026-01-01T00:00:00Z", body: asked.body },
        { author: { login: "marcel" }, createdAt: "2026-01-01T01:00:00Z", body: "Please try again, the tasks were too easy." },
      ],
      labels: [],
    });
    await watcher().tick();
    await settle();
    const again = runOf("8")!;
    expect(again.status).toBe("succeeded");
    expect(again.history.filter((h) => h.id === "clone").length).toBe(2);
    expect(mainLog()[0]).toBe("Add skill demo-skill (#8)");
  }, 180_000);

  it("sends the first review with changes back to the writer, and stops for the review notes of the second", async () => {
    process.env.FAKE_SKILL_REVIEW = "SKILL.md overlaps the java skill.\nVERDICT: CHANGES";
    issues(9);
    const before = mainLog();
    await watcher().tick();
    await settle();
    expect(runOf("9")!.status).toBe("stopped");
    expect(ids("9").slice(4)).toEqual(["write", "check", "measure", "review", "after_review", "write", "check", "measure", "review", "after_review", "ask_for_info"]);
    expect(runOf("9")!.history.filter((h) => h.id === "after_review").map((h) => h.output?.trim())).toEqual(["REVIEW: rewrite", "REVIEW: ask"]);
    expect(gh.comments().find((c) => c.body.includes("the review asks for changes"))!.body).toContain("overlaps the java skill");
    expect(mainLog()).toEqual(before);
  }, 120_000);

  it("cannot push main when the repository is not marked as a skill library", async () => {
    setRepoSettings(rec.id, { mainBranch: "main" });
    issues(10);
    const before = mainLog();
    await watcher().tick();
    await settle();
    const run = runOf("10")!;
    expect(run.status).not.toBe("succeeded");
    expect(run.history.find((h) => h.id === "publish")!.output).toContain("protected branch 'main' is blocked");
    expect(mainLog()).toEqual(before);
  }, 120_000);

  it("publishes once after a push that failed behind the commit, and the pushed folder is the measured tree", async () => {
    rejectMainOnce();
    issues(11);
    await watcher().tick();
    await settle();
    const failed = runOf("11")!;
    expect(failed.status).toBe("failed");
    expect(failed.history.at(-1)!.id).toBe("publish");
    expect(mainLog().filter((s) => s.includes("demo-skill"))).toEqual([]);
    const tree = /^SKILL_TREE: (\w+)$/m.exec(failed.history.find((h) => h.id === "measure")!.output)![1]!;
    scheduler.submit({ kind: "resume", runId: failed.runId, from: "publish" });
    await settle();
    expect(runOf("11")!.status).toBe("succeeded");
    expect(mainLog().filter((s) => s === "Add skill demo-skill (#11)")).toHaveLength(1);
    expect(gh.remoteGit("rev-parse", "main:skills/demo-skill").trim()).toBe(tree);
  }, 180_000);

  it("refuses to publish when the same skill changed on main during the run", async () => {
    rejectMainOnce();
    issues(12);
    await watcher().tick();
    await settle();
    expect(runOf("12")!.status).toBe("failed");
    pushToMain({ "skills/demo-skill/SKILL.md": "---\nname: demo-skill\n---\nsomeone else\n" }, "Someone else wrote it");
    const tip = gh.remoteGit("rev-parse", "main");
    scheduler.submit({ kind: "resume", runId: runOf("12")!.runId, from: "publish" });
    await settle();
    expect(runOf("12")!.status).toBe("failed");
    expect(runOf("12")!.history.at(-1)!.output).toContain("start a new run");
    expect(gh.remoteGit("rev-parse", "main")).toBe(tip);
  }, 180_000);

  it("rebases onto an unrelated change on main and still pushes the measured tree", async () => {
    rejectMainOnce();
    issues(13);
    await watcher().tick();
    await settle();
    const failed = runOf("13")!;
    expect(failed.status).toBe("failed");
    const tree = /^SKILL_TREE: (\w+)$/m.exec(failed.history.find((h) => h.id === "measure")!.output)![1]!;
    pushToMain({ "docs/other.md": "unrelated\n" }, "Unrelated change");
    scheduler.submit({ kind: "resume", runId: failed.runId, from: "publish" });
    await settle();
    expect(runOf("13")!.status).toBe("succeeded");
    expect(mainLog().slice(0, 2)).toEqual(["Add skill demo-skill (#13)", "Unrelated change"]);
    expect(gh.remoteGit("rev-parse", "main:skills/demo-skill").trim()).toBe(tree);
  }, 180_000);
});
