import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../../src/config.js";
import { readLiveLog, saveRun, type RunSummary } from "../../src/engine/state.js";
import { DECIDED_HEADING } from "../../src/next-step.js";
import { Scheduler } from "../../src/queue/scheduler.js";
import { Watcher } from "../../src/queue/watcher.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./fake-github.js";

export const TRIGGER = "claude-factory";
export const ASKS = "factory:needs-info";
export const WORKING = "factory:working";
export const FAILED = "factory:failed";
export const DONE = "factory:done";
export const WAITING = "factory:waiting-approval";

const url = (id: number) => `https://github.com/acme/app/issues/4#issuecomment-${id}`;
/** The comment the Foundry posted when it decided Q1 itself (id 900). */
export const decided = { author: { login: "bot" }, viewerDidAuthor: true, url: url(900), createdAt: "2026-01-01T00:00:00Z", body: `${DECIDED_HEADING}\n\n**Q1. Which database?**\n\n**Decision:** PostgreSQL\n\n<!-- claude-factory run=r1 decided=1 -->` };
/** A comment of a person (id 901 unless told otherwise). */
export const said = (body: string, login = "marcel", id = 901) => ({ author: { login }, body, url: url(id), createdAt: `2026-01-01T01:00:${String(id % 60).padStart(2, "0")}Z` });
export const FLOW_STEPS = [{ id: "pull_ticket" }, { id: "plan" }, { id: "report" }];

/** The fake GitHub, a scheduler whose submit is mocked, and the helpers the /overrule watcher tests share (follow tests/watch-park.test.ts). */
export function setupOverrule() {
  const t = {} as {
    gh: ReturnType<typeof fakeGithub>;
    scheduler: Scheduler;
    submit: ReturnType<typeof vi.spyOn>;
    logged: string[];
  };
  const config = ConfigSchema.parse({ protected_branches: ["main"], concurrency: 2 });
  beforeEach(() => {
    t.gh = fakeGithub();
    t.logged = [];
    process.env.FAKE_GH_PERMISSION = "write";
    process.env.FAKE_GH_LABEL_FILTER = "1";
    process.env.FAKE_GH_COMMENTS_PLUS_LOG = "1";
    t.scheduler = new Scheduler({ runsDir: join(t.gh.tmp, "runs"), config: () => config, claudeBin });
    t.submit = vi.spyOn(t.scheduler, "submit").mockReturnValue("queued-1");
    vi.spyOn(t.scheduler, "wait").mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const k of ["FAKE_GH_FAIL_ON", "FAKE_GH_COMMENTS", "FAKE_GH_PERMISSION", "FAKE_GH_READONLY", "FAKE_GH_LABEL_FILTER", "FAKE_GH_HOLD", "FAKE_GH_HOLD_ON", "FAKE_GH_COMMENTS_PLUS_LOG", "FAKE_GH_ISSUES", "FAKE_GH_FAIL_TEXT", "FAKE_GH_PRS"]) delete process.env[k];
    t.gh.restore();
  });

  const watcher = (over: Record<string, unknown> = {}, scheduler = t.scheduler) =>
    new Watcher(WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: {}, flow: oldFlowFor({}), status_comment: false, ...over }), {
      scheduler, runsDir: join(t.gh.tmp, "runs"), repo: t.gh.tmp, log: (m: string) => { t.logged.push(m); },
    });
  const issues = (labels: string[], updatedAt = "2026-01-02T00:00:00Z") => {
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "issue 4", state: "OPEN", updatedAt, labels: labels.map((name) => ({ name })) }]);
  };
  const comments = (...c: unknown[]) => { process.env.FAKE_GH_COMMENTS = JSON.stringify({ comments: c }); };
  const runDir = () => join(t.gh.tmp, "runs", "r1");
  const plant = (over: Record<string, unknown> = {}) => {
    mkdirSync(runDir(), { recursive: true });
    saveRun({
      runId: "r1", flow: oldFlowFor({}), flowDef: { name: oldFlowFor({}), steps: FLOW_STEPS }, task: "t", vars: { github_repo: "acme/app", issue: "4" }, repo: t.gh.tmp, status: "stopped", runDir: runDir(),
      reason: 'stopped at step "send_back"', startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0,
      history: [], state: { next: "report", steps: {}, visits: {} }, ...over,
    } as unknown as RunSummary);
  };
  const log = () => t.gh.ghLog();
  const acks = () => (log().match(/overrule=901 -->/g) ?? []).length;
  const notes = () => (log().match(/this overrule was not used/g) ?? []).length;
  const acts = (w: Watcher) => w.status.lastActions.join("\n");
  const runLog = () => readLiveLog(runDir());
  const untouched = () => {
    if (log().includes("comment on #4") || t.submit.mock.calls.length) throw new Error(`expected nothing to happen:\n${log()}`);
  };
  return { t, watcher, issues, comments, plant, runDir, log, acks, notes, acts, runLog, untouched };
}
