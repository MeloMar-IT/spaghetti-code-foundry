import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema, type Config } from "../src/config.js";
import { liveLogFile } from "../src/engine/state.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { discoverSkills, pinSkill } from "../src/skills/registry.js";
import { RUN_SKILL_LOCK_FILE } from "../src/skills/run-lock.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

// The shipped planners (issue-gitflow, issue-plan) get the skill catalogue; what they pick is checked, locked and loaded.
const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const VARS = { test_cmd: "! grep -q BUG feature.txt 2>/dev/null", docs_required: "docs/CHANGELOG.md", union_merge_files: "docs/CHANGELOG.md" };
const FAKES = ["FAKE_IMPL_BUG", "FAKE_FIX_NOOP", "FAKE_SIZE", "FAKE_AREAS", "FAKE_RISK", "FAKE_ISSUE_PLAN", "FAKE_SKILL_REQUEST", "FAKE_GH_ISSUE_BODIES", "FAKE_GH_COMMENTS"];

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  process.env.AREA_LOCK_POLL_MS = "100";
});

let n = 0;
/** A unique id per call: the pin lock lives in the shared test home. */
const uid = (base = "skill") => `${base}-${++n}-x${process.pid}`.toLowerCase().replace(/[^a-z0-9-]/g, "");

describe("skill catalogue in the shipped planners", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  let root: string;
  let config: Config;
  const runsDir = () => join(gh.tmp, "runs");

  beforeEach(() => {
    gh = fakeGithub();
    root = mkdtempSync(join(tmpdir(), "flow-skills-"));
    config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 3, skills: { builtin: false, roots: [root] } });
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "locks");
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
  });
  afterEach(() => {
    gh.restore();
    rmSync(root, { recursive: true, force: true });
  });

  const install = (id: string) => {
    const d = join(root, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
    writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n`);
  };
  const pin = (id: string) => {
    const reg = discoverSkills(config.skills);
    pinSkill(reg, `${id}@1.0.0`, reg.byKey.get(`${id}@1.0.0`)!.digest);
  };
  const bodies = (b: Record<number, string>) => {
    process.env.FAKE_GH_ISSUE_BODIES = JSON.stringify(b);
  };
  const issues = (flowLabel: string, ...nums: number[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(nums.map((number) => ({ number, title: `issue ${number}`, labels: [{ name: flowLabel }] })));
  };
  const settle = async () => {
    await scheduler.idle();
    await new Promise((r) => setTimeout(r, 300));
  };
  const gitflow = () => new Watcher(WatcherSchema.parse({
    id: "go", github_repo: REPO, label: "Factory_go", flow: "issue-gitflow", max_per_tick: 2,
    status_labels: LABELS, remove_on_done: ["Factory_go"], dependency_done_labels: ["Factory_done"], vars: VARS,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const planner = () => new Watcher(WatcherSchema.parse({
    id: "plan", github_repo: REPO, label: "Factory_ready", flow: "issue-plan",
    status_labels: { ...LABELS, working: "Factory_planning", done: "Factory_planned" }, remove_on_done: ["Factory_ready"], vars: VARS,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const runOf = (flow: string, issue: string) => scheduler.list().find((s) => s.flow === flow && s.vars.issue === issue)!;
  const logOf = (run: { runDir: string }) => readFileSync(liveLogFile(run.runDir), "utf8");
  const catalogueLines = (run: { runDir: string }) => logOf(run).split("\n").filter((l) => l.includes("skill catalogue:"));
  const lockOf = (run: { runDir: string }) => JSON.parse(readFileSync(join(run.runDir, RUN_SKILL_LOCK_FILE), "utf8")) as { skills: { id: string; version: string }[] };

  it("no match gives an empty request and lock; a catalogue pick is locked and loaded in implement", async () => {
    const id = uid();
    install(id);
    pin(id);
    bodies({ 6: "Please add feature.txt\nREQUEST_CATALOGUE_SKILLS" });
    issues("Factory_go", 5, 6);
    await gitflow().tick();
    await settle();
    const [none, picked] = [runOf("issue-gitflow", "5"), runOf("issue-gitflow", "6")];
    expect([none.status, picked.status, none.reason, picked.reason]).toEqual(["succeeded", "succeeded", undefined, undefined]);

    // issue 5: the catalogue was offered, the planner asked for nothing
    expect(none.history.find((h) => h.id === "plan")!.skillCatalogue).toMatchObject({ entries: 1 });
    expect(none.skillLock!.skills).toEqual([]);
    expect(none.history.find((h) => h.id === "implement")!.skills?.loaded).toEqual([]);
    expect(none.history.find((h) => h.id === "pull_ticket")!.output).toContain("Please add feature.txt");

    // issue 6: the pick came from the catalogue in the plan prompt
    expect(picked.history.find((h) => h.id === "pull_ticket")!.output).toContain("REQUEST_CATALOGUE_SKILLS");
    expect(lockOf(picked).skills).toEqual([expect.objectContaining({ id, version: "1.0.0" })]);
    const impl = picked.history.find((h) => h.id === "implement")!;
    expect(impl.skills).toMatchObject({ loaded: [`${id}@1.0.0`], state: "loaded" });
    const planSteps = picked.history.filter((h) => h.id === "plan" || h.id === "revise_plan").length;
    expect(catalogueLines(picked)).toHaveLength(planSteps);
  });

  it("an unknown skill in the plan stops the run after the gate; the catalogue says nothing is available", async () => {
    bodies({ 5: `REQUEST_SKILLS no-such-skill-${uid()}` });
    issues("Factory_go", 5);
    await gitflow().tick();
    await settle();
    const run = runOf("issue-gitflow", "5");
    expect(run.status).toBe("stopped");
    expect(run.reason).toMatch(/unknown/);
    expect(run.history.some((h) => h.id === "implement")).toBe(false);
    expect(catalogueLines(run)[0]).toContain("skill catalogue: no skills are available");
  });

  it("a skill that is not pinned is hidden from the catalogue and stops the run when requested", async () => {
    const id = uid();
    install(id);
    bodies({ 5: `REQUEST_SKILLS ${id}` });
    issues("Factory_go", 5);
    await gitflow().tick();
    await settle();
    const run = runOf("issue-gitflow", "5");
    expect(catalogueLines(run)[0]).toMatch(/no skills are available; 1 hidden \(not pinned\)$/);
    expect(run.history.find((h) => h.id === "plan")!.skillCatalogue).toMatchObject({ entries: 0, hidden: 1 });
    expect(run.status).toBe("stopped");
    expect(run.reason).toMatch(/unpinned/);
    expect(run.history.some((h) => h.id === "implement")).toBe(false);
  });

  it("after pinning, a resume waits for approval; /approve then locks and loads the skill", async () => {
    const id = uid();
    install(id);
    process.env.FAKE_RISK = "85";
    bodies({ 5: `REQUEST_SKILLS ${id}` });
    issues("Factory_go", 5);
    const w = gitflow();
    await w.tick();
    await settle();
    const stopped = runOf("issue-gitflow", "5");
    expect(stopped.status).toBe("stopped");
    expect(stopped.reason).toMatch(/unpinned/);

    pin(id);
    scheduler.submit({ kind: "resume", runId: stopped.runId });
    await settle();
    const waiting = runOf("issue-gitflow", "5");
    expect(waiting.status).toBe("waiting");
    expect(waiting.history.some((h) => h.id === "implement")).toBe(false);

    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 5, title: "issue 5", labels: [{ name: "Factory_go" }, { name: "Factory_waiting" }] }]);
    const request = { author: { login: "bot" }, body: `plan <!-- claude-factory run=${waiting.runId} approval -->`, createdAt: "2026-01-01T00:00:00Z" };
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [request, { author: { login: "marcel" }, body: "/approve", createdAt: "2026-01-01T01:00:00Z" }] });
    await w.tick();
    await settle();
    const done = runOf("issue-gitflow", "5");
    expect(done.reason).toBeUndefined();
    expect(done.status).toBe("succeeded");
    expect(done.skillLock!.skills).toEqual([expect.objectContaining({ id })]);
    expect(done.history.find((h) => h.id === "implement")!.skills).toMatchObject({ loaded: [`${id}@1.0.0`] });
  });

  it("a resume after the lock was made leaves skill-lock.json byte-identical and verifies it", async () => {
    const id = uid();
    install(id);
    pin(id);
    process.env.FAKE_IMPL_BUG = "1";
    process.env.FAKE_FIX_NOOP = "1";
    bodies({ 5: "REQUEST_CATALOGUE_SKILLS" });
    issues("Factory_go", 5);
    await gitflow().tick();
    await settle();
    const failed = runOf("issue-gitflow", "5");
    expect(failed.status).not.toBe("succeeded");
    expect(failed.history.some((h) => h.id === "implement")).toBe(true);
    const before = readFileSync(join(failed.runDir, RUN_SKILL_LOCK_FILE), "utf8");

    delete process.env.FAKE_IMPL_BUG;
    delete process.env.FAKE_FIX_NOOP;
    const marker = logOf(failed).length;
    scheduler.submit({ kind: "resume", runId: failed.runId });
    await settle();
    const again = runOf("issue-gitflow", "5");
    expect(readFileSync(join(again.runDir, RUN_SKILL_LOCK_FILE), "utf8")).toBe(before);
    expect(logOf(again).slice(marker)).toContain("skill lock: verified 1 skill");
    expect(logOf(again).slice(marker)).not.toContain("skill lock: " + id);
  });

  it("issue-plan posts the plan with the required skills from the catalogue", async () => {
    const id = uid();
    install(id);
    pin(id);
    bodies({ 5: "Please add feature.txt\nREQUEST_CATALOGUE_SKILLS" });
    issues("Factory_ready", 5);
    await planner().tick();
    await settle();
    const run = runOf("issue-plan", "5");
    expect(run.status).toBe("succeeded");
    expect(run.history.find((h) => h.id === "plan")!.skillCatalogue).toMatchObject({ entries: 1 });
    expect(gh.ghLog()).toContain("Required skills");
    expect(gh.ghLog()).toContain(id);
  });
});
