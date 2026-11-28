import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { saveRun, type RunSummary } from "../src/engine/state.js";
import { recordRepair, repairFile, repairsSince, resetRepairMemory } from "../src/monitor/repair-log.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

const REPO = "acme/app";
const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const FAKES = ["FAKE_GH_CLOSED_ISSUES", "FAKE_QUESTIONS_FOR", "FAKE_GH_COMMENTS", "FAKE_GH_FAIL"];

describe("needs-info label follows the record", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  const runsDir = () => join(gh.tmp, "runs");
  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
  });
  afterEach(() => gh.restore());

  const watcher = (extra: Record<string, unknown> = {}) => new Watcher(WatcherSchema.parse({
    id: "go", github_repo: REPO, label: "Factory_go", flow: "issue-deliver", exclude_labels: ["other"],
    status_labels: LABELS, remove_on_done: ["Factory_go"], dependency_done_labels: ["Factory_done"], ...extra,
  }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  const issues = (dep: "OPEN" | "CLOSED", six: string[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([
      { number: 4, title: "issue 4", state: dep, labels: [{ name: "Factory_go" }, { name: "other" }], body: "" },
      { number: 6, title: "issue 6", state: "OPEN", labels: six.map((name) => ({ name })), body: "Depends on #4" },
    ]);
  };
  const ask = { author: { login: "bot" }, body: "questions <!-- claude-factory run=x questions -->", createdAt: "2026-01-01T00:00:00Z" };
  const answered = () => {
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [ask, { author: { login: "marcel" }, body: "/defaults", createdAt: "2026-01-01T01:00:00Z" }] });
  };
  const edits = (from = 0) => gh.ghLog().split("\n").slice(from).filter((l) => l.includes("issue edit 6 "));
  const settle = async () => { await scheduler.idle(); await new Promise((r) => setTimeout(r, 300)); };

  it("answered, waiting for a dependency: the label goes once, then the story starts", async () => {
    const w = watcher();
    issues("OPEN", ["Factory_go", "Factory_needs_info"]);
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [ask] });
    await w.tick();
    expect(w.status.holds![0]!.next.kind).toBe("questions");
    expect(edits()).toHaveLength(0);

    answered();
    await w.tick();
    expect(w.status.holds![0]!.next.kind).toBe("dependency");
    const e = edits();
    expect(e).toHaveLength(1);
    expect(e[0]).toContain("--remove-label Factory_needs_info");
    expect(e[0]).not.toContain("--add-label");

    const at = gh.ghLog().split("\n").length;
    issues("OPEN", ["Factory_go"]);
    await w.tick();
    expect(edits(at)).toHaveLength(0);

    issues("CLOSED", ["Factory_go"]);
    await w.tick();
    await settle();
    expect(scheduler.list().some((s) => s.vars.issue === "6")).toBe(true);
    expect(edits(at).join("\n")).toContain("--add-label Factory_working");
  });

  it("a failing edit is the check's error and the hold stays", async () => {
    const w = watcher();
    issues("OPEN", ["Factory_go", "Factory_needs_info"]);
    answered();
    process.env.FAKE_GH_FAIL = "issue edit";
    await w.tick().catch(() => {});
    expect(w.status.lastError).toMatch(/correcting labels/);
    expect(w.status.holds![0]!.next.kind).toBe("dependency");
    delete process.env.FAKE_GH_FAIL;
    await w.tick();
    expect(edits()).toHaveLength(2);
  });
});

describe("the repair log of a watcher", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  const runsDir = () => join(gh.tmp, "runs");
  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: runsDir(), config: () => config, claudeBin });
    for (const k of FAKES) delete process.env[k];
    rmSync(repairFile(), { recursive: true, force: true });
    resetRepairMemory();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FAKE_GH_FAIL;
    rmSync(repairFile(), { recursive: true, force: true });
    gh.restore();
  });

  const watcher = () => new Watcher(WatcherSchema.parse({ id: "go", github_repo: REPO, label: "Factory_go", flow: "issue-deliver", status_labels: LABELS }), { scheduler, runsDir: runsDir(), repo: gh.tmp, log: () => {} });
  /** Issue 6 wears `label`, and its newest run failed. */
  const wrongLabel = (label: string, status: RunSummary["status"] = "failed") => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 6, title: "issue 6", state: "OPEN", labels: [{ name: "Factory_go" }, { name: label }], body: "" }]);
    const runDir = join(runsDir(), "r6");
    mkdirSync(runDir, { recursive: true });
    saveRun({
      runId: "r6", flow: "issue-deliver", flowDef: { name: "issue-deliver", steps: [] }, task: "t", vars: { github_repo: REPO, issue: "6" }, repo: gh.tmp, status, reason: status === "failed" ? "boom" : undefined, runDir,
      startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} },
    } as unknown as RunSummary);
  };
  const logged = () => repairsSince(0).map((e) => `${e.repair} ${e.result} ${e.where}: ${e.what}`);

  // the two places that correct a label without starting work: a working label that is wrong, and any other status label
  for (const label of [LABELS.working, LABELS.needs_info]) {
    it(`logs a corrected label (${label})`, async () => {
      wrongLabel(label);
      await watcher().tick();
      expect(logged()).toEqual([`correct-labels done ${REPO}: label of #6 set to Factory_ERROR to match its newest run`]);
    });

    it(`logs a correction that failed and keeps the error of the check (${label})`, async () => {
      wrongLabel(label);
      process.env.FAKE_GH_FAIL = "issue edit";
      const w = watcher();
      await w.tick().catch(() => {});
      expect(w.status.lastError).toBeTruthy();
      expect(logged()).toEqual([`correct-labels failed ${REPO}: label of #6 could not be set to Factory_ERROR to match its newest run`]);
    });
  }

  it("logs the label set to working when its run is active", async () => {
    wrongLabel(LABELS.needs_info, "running");
    vi.spyOn(scheduler, "isActive").mockReturnValue(true);
    await watcher().tick();
    expect(gh.ghLog()).toContain("--add-label Factory_working");
    expect(logged()).toEqual([`correct-labels done ${REPO}: label of #6 set to Factory_working to match its newest run`]);
  });

  it("writes a repeated occurrence once, also after a restart and when the cache of this process is full", async () => {
    const entry = { repair: "correct-labels" as const, what: "label of #6 set to Factory_ERROR to match its newest run", where: REPO, result: "done" as const, key: "same" };
    expect(recordRepair(entry)).toBe(true);
    resetRepairMemory(); // a restart: this process knows nothing of what was written
    expect(recordRepair(entry)).toBe(false);
    for (let i = 0; i < 600; i++) recordRepair({ ...entry, what: `filler ${i}`, key: `other-${i}` }); // the cache holds 500 keys: the first one is forgotten
    expect(recordRepair(entry)).toBe(false);
    expect(logged().filter((l) => l.endsWith(entry.what))).toHaveLength(1);
  });

  it("corrects the label also when the log cannot be written", async () => {
    mkdirSync(repairFile(), { recursive: true });
    wrongLabel(LABELS.needs_info);
    const w = watcher();
    await w.tick();
    expect(w.status.lastError).toBeUndefined();
    expect(gh.ghLog()).toContain("--add-label Factory_ERROR");
  });

  it("logs a closed dependency once when it lets a story through, and nothing while it holds", async () => {
    const issues = (state: "OPEN" | "CLOSED") => {
      process.env.FAKE_GH_ISSUES = JSON.stringify([
        { number: 4, title: "issue 4", state, labels: [], body: "" },
        { number: 6, title: "issue 6", state: "OPEN", labels: [{ name: "Factory_go" }], body: "Depends on #4" },
      ]);
    };
    const submit = vi.spyOn(scheduler, "submit").mockReturnValue("queued-1");
    vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
    const w = watcher();
    issues("OPEN");
    await w.tick();
    expect(logged()).toEqual([]);
    issues("CLOSED");
    await w.tick();
    await w.tick();
    expect(submit).toHaveBeenCalled();
    expect(logged()).toEqual([`completed-dependency done ${REPO}: dependency #4 of #6 is closed and counted as done`]);
  });
});
