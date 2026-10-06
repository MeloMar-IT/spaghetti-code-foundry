import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";

describe("answered questions of a stopped run, held by the per-check limit", () => {
  let gh: ReturnType<typeof fakeGithub>;
  let scheduler: Scheduler;
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  beforeEach(() => {
    gh = fakeGithub();
    scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => config, claudeBin });
  });
  afterEach(() => { gh.restore(); delete process.env.FAKE_PLAN; });
  const watcher = (over: Record<string, unknown> = {}) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "test -f feature.txt" }, ...over, flow: oldFlowFor(over) }), {
      scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {},
    });
  const issues = (...list: [number, string?][]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(list.map(([number, status]) => ({
      number, title: `issue ${number}`, labels: [{ name: "claude-factory" }, ...(status ? [{ name: status }] : [])],
    })));
  };
  const settle = async () => { await scheduler.idle(); await new Promise((r) => setTimeout(r, 300)); };
  const runFor = (issue: string) => scheduler.list().find((s) => s.vars.issue === issue)!;
  const edits = (from = 0) => gh.ghLog().split("\n").slice(from).filter((l) => l.includes("issue edit 4 "));

  it("the label goes to working (not left at needs-info), and the same run resumes later", async () => {
    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    issues([4]);
    const w = watcher({ max_per_tick: 1 });
    await w.tick();
    await settle();
    const first = runFor("4");
    expect(first.status).toBe("stopped");
    delete process.env.FAKE_PLAN;
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [
      { author: { login: "bot" }, body: "questions <!-- claude-factory run=x -->", createdAt: "2026-01-01T00:00:00Z" },
      { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" },
    ] });
    // A lower-numbered new issue uses the one slot of this check.
    issues([3], [4, "factory:needs-info"]);
    const at = gh.ghLog().split("\n").length;
    await w.tick();
    expect(w.status.holds!.find((h) => h.issue === 4)?.next.kind).toBe("starting");
    expect(edits(at).join("\n")).toContain("--add-label factory:working");
    expect(runFor("4").resumes ?? 0).toBe(0);
    await settle();

    // Next check, the label shows working: no flip back to needs-info, and the run resumes.
    issues([4, "factory:working"]);
    const at2 = gh.ghLog().split("\n").length;
    await w.tick();
    await settle();
    expect(runFor("4").runId).toBe(first.runId);
    expect(runFor("4").resumes).toBe(1);
    expect(edits(at2).join("\n")).not.toContain("--add-label factory:needs-info");
  });

  const SLOW = parseFlow(`name: slow
workspace: empty
steps:
  - {id: a, type: shell, run: "sleep 2"}
`);
  const busy = () => scheduler.submit({ kind: "run", flow: SLOW, task: "", repo: gh.tmp, vars: {} }, { source: "other story", lockKey: "acme/app#watcher:w" });

  it("one at a time: an answered stopped run behind a busy story shows working, then resumes", async () => {
    process.env.FAKE_PLAN = "Which DB?\nPLAN_STATUS: NEEDS_INFO";
    issues([4]);
    const w = watcher({ one_at_a_time: true });
    await w.tick();
    await settle();
    const first = runFor("4");
    expect(first.status).toBe("stopped");
    delete process.env.FAKE_PLAN;
    const ask = { author: { login: "bot" }, body: "questions <!-- claude-factory run=x -->", createdAt: "2026-01-01T00:00:00Z" };
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [ask] });
    busy();
    issues([4, "factory:needs-info"]);
    const at = gh.ghLog().split("\n").length;
    await w.tick();
    expect(edits(at)).toHaveLength(0); // not answered: the label fits

    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [ask, { author: { login: "marcel" }, body: "Use Postgres", createdAt: "2026-01-01T01:00:00Z" }] });
    await w.tick();
    expect(w.status.holds!.find((h) => h.issue === 4)?.next.kind).toBe("one_at_a_time");
    expect(edits(at).join("\n")).toContain("--add-label factory:working");
    expect(runFor("4").resumes ?? 0).toBe(0);

    issues([4, "factory:working"]);
    const at2 = gh.ghLog().split("\n").length;
    await w.tick();
    expect(edits(at2)).toHaveLength(0);
    await settle();
    await w.tick();
    await settle();
    expect(runFor("4").resumes).toBe(1);
    expect(edits(at2).join("\n")).not.toContain("--add-label factory:needs-info");
  });

  it("one at a time: an approved waiting run behind a busy story shows working, then resumes", async () => {
    issues([6]);
    const w = watcher({ one_at_a_time: true, flow: "github-pr", vars: { test_cmd: "test -f feature.txt", require_approval: "yes", ci_settle_sec: "0" } });
    await w.tick();
    await settle();
    const run = runFor("6");
    expect(run.status).toBe("waiting");
    const request = { author: { login: "bot" }, body: `ready <!-- claude-factory run=${run.runId} approval -->`, createdAt: "2026-01-01T00:00:00Z" };
    process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: [request, { author: { login: "marcel" }, body: "/approve ship it", createdAt: "2026-01-01T02:00:00Z" }] });
    process.env.FAKE_GH_PERMISSION = "write";
    busy();
    issues([6, "factory:waiting-approval"]);
    const at = gh.ghLog().split("\n").length;
    await w.tick();
    expect(w.status.holds!.find((h) => h.issue === 6)?.next.kind).toBe("one_at_a_time");
    expect(gh.ghLog().split("\n").slice(at).filter((l) => l.includes("issue edit 6 ")).join("\n")).toContain("--add-label factory:working");
    expect(runFor("6").resumes ?? 0).toBe(0);

    issues([6, "factory:working"]);
    await settle();
    await w.tick();
    await settle();
    expect(runFor("6").resumes).toBe(1);
    delete process.env.FAKE_GH_PERMISSION;
  });
});
