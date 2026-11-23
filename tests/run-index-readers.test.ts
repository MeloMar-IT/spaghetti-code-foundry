import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { RunIndex } from "../src/engine/run-index.js";
import { runReadCount, saveRun, slimRunOf, type RunSummary } from "../src/engine/state.js";
import { buildHistory } from "../src/estimate.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { storyTitle } from "../src/since.js";
import { boardFor } from "../src/server/board.js";
import { ClarityRecorder, candidatesFor, clarityFor } from "../src/server/clarity.js";
import { health } from "../src/server/health.js";
import { allNext, forgetHistory, historyFor, indexReady, knownRuns } from "../src/server/next.js";
import { SEARCH_Q_MAX, searchRoutes } from "../src/server/search.js";
import type { ApiContext } from "../src/server/server.js";
import { yourTurnRoutes } from "../src/server/your-turn.js";
import { sinceFor } from "../src/server/since.js";
import type { MergedRead } from "../src/since.js";

// The Board, the Overview, health, "since" and clarity read the run index: at most one run.json parse per answer (#931).

const NOW = new Date("2026-10-01T12:00:00Z");
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const none = (repo: string): Promise<MergedRead> => Promise.resolve({ repo, ok: true, full: false, prs: [] });

let data: string;
let runs: string;
let wsRuns: string;
let sched: Scheduler | undefined;
let idx: RunIndex | undefined;
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), "run-index-readers-"));
  runs = join(data, "runs");
  wsRuns = join(data, "workspaces", "team", "runs");
  mkdirSync(runs, { recursive: true });
  mkdirSync(wsRuns, { recursive: true });
});
afterEach(() => {
  sched?.close();
  idx?.stop();
  sched = idx = undefined;
  rmSync(data, { recursive: true, force: true });
});

const STEPS = [{ id: "plan", type: "claude" }, { id: "commit", type: "shell" }];
function save(dir: string, id: string, over: Partial<RunSummary> = {}): RunSummary {
  const runDir = join(dir, id);
  mkdirSync(runDir, { recursive: true });
  const s = {
    runId: id, flow: "github-issue", task: `task ${id}`, status: "succeeded", startedAt: ago(3 * 60 * MIN), finishedAt: ago(2 * 60 * MIN),
    vars: { github_repo: "acme/app", issue: "1" }, repo: "/r", runDir, totalCostUsd: 0, flowDef: { name: "github-issue", steps: STEPS },
    history: [{ id: "plan", type: "claude", visit: 1, ok: true, output: "", durationMs: 60_000 }, { id: "commit", type: "shell", visit: 1, ok: true, output: "", durationMs: 30_000 }],
    state: { next: null, steps: {}, visits: {} }, ...over,
  } as unknown as RunSummary;
  saveRun(s);
  return s;
}

const watcher = WatcherSchema.parse({ id: "a", github_repo: "acme/app", flow: "github-issue" });
interface Tracking { issue: number; title: string; runId?: string }

async function setup(tracking: Tracking[] = [], watched = true) {
  idx = new RunIndex(runs);
  await idx.build();
  const config = ConfigSchema.parse({ watchers: watched ? [watcher] : [] });
  sched = new Scheduler({ runsDir: runs, config: () => config, runIndex: idx });
  const list = vi.spyOn(sched, "list");
  const get = vi.spyOn(sched, "get");
  const ctx = {
    opts: { runsDir: runs },
    config: () => config,
    scheduler: sched,
    watchers: {
      tracked: () => (watched ? [{ watcher, status: { id: "a", lastActions: [] }, issues: tracking }] : []),
      statuses: () => (watched ? [{ ...watcher, status: { id: "a", lastActions: [] } }] : []),
    },
  } as unknown as ApiContext;
  return { ctx, list, get };
}

/** Counts the run.json parses and the scheduler's list/get calls of one answer. */
async function reads<T>(ctx: ApiContext, spies: { list: { mock: { calls: unknown[] } }; get: { mock: { calls: unknown[] } } }, f: () => T | Promise<T>): Promise<number> {
  forgetHistory(ctx); // the duration history is built again, inside the measured answer
  spies.list.mock.calls.length = 0;
  spies.get.mock.calls.length = 0;
  const before = runReadCount();
  await f();
  expect(spies.list.mock.calls).toHaveLength(0);
  expect(spies.get.mock.calls).toHaveLength(0);
  return runReadCount() - before;
}

/** Writes the runs; gives the ones the duration history is built from (as saved, in full). */
function fixture(): RunSummary[] {
  const oks: RunSummary[] = [0, 1, 2, 3].map((i) => save(runs, `ok${i}`, { vars: { github_repo: "acme/app", issue: String(10 + i) } }));
  save(runs, "failed7", {
    status: "failed", reason: "boom", startedAt: ago(40 * MIN), finishedAt: ago(30 * MIN), vars: { github_repo: "acme/app", issue: "7" },
    history: [{ id: "pull_ticket", type: "shell", visit: 1, ok: true, output: "# #7: Seven\n\nbody text" }, { id: "plan", type: "claude", visit: 1, ok: false, output: "no" }],
    state: { next: "plan", steps: { pull_ticket: { output: "# #7: Seven\n\nbody text" } }, visits: {} },
  } as never);
  save(runs, "wait8", { status: "waiting", startedAt: ago(20 * MIN), finishedAt: undefined, vars: { github_repo: "acme/app", issue: "8" }, history: [] } as never);
  oks.push(save(wsRuns, "ws9", { vars: { github_repo: "acme/app", issue: "9" }, workspace: "team", owner: "u1" } as never));
  return oks;
}

describe("readers of the run index", () => {
  it("each answer parses at most one run.json and never calls list or get", async () => {
    fixture();
    const { ctx, list, get } = await setup([{ issue: 9, title: "Nine", runId: "ws9" }]);
    const spies = { list, get };
    expect(await reads(ctx, spies, () => boardFor(ctx, NOW))).toBeLessThanOrEqual(1);
    expect(await reads(ctx, spies, () => allNext(ctx))).toBeLessThanOrEqual(1);
    expect(await reads(ctx, spies, () => health(ctx, NOW))).toBeLessThanOrEqual(1);
    expect(await reads(ctx, spies, () => sinceFor(ctx, new Date(NOW.getTime() - 6 * 60 * MIN), NOW, { prs: none }))).toBeLessThanOrEqual(1);
    expect(await reads(ctx, spies, () => clarityFor(ctx, NOW))).toBeLessThanOrEqual(1);
    expect(await reads(ctx, spies, () => candidatesFor(ctx, NOW))).toBeLessThanOrEqual(1);
    expect(await reads(ctx, spies, () => historyFor(ctx))).toBeLessThanOrEqual(1);
  });

  it("historyFor gives the history of the full runs", async () => {
    const full = fixture();
    const { ctx } = await setup();
    forgetHistory(ctx);
    const got = historyFor(ctx);
    expect(got.size).toBe(1);
    expect(got).toEqual(buildHistory(full));
  });

  it("an untracked run keeps the title of its pull_ticket on the Board", async () => {
    fixture();
    const { ctx } = await setup([], false); // no watcher tracks it
    const cards = boardFor(ctx, NOW).repos.flatMap((r) => r.columns.flatMap((c) => c.cards));
    expect(cards.find((c) => c.runId === "failed7")?.title).toBe("Seven");
    expect(storyTitle(slimRunOf(JSON.parse(JSON.stringify(ctx.scheduler.slimOf("failed7")))))).toBe("Seven");
  });

  it("a tracked run in a workspace runs folder is found through the index", async () => {
    fixture();
    const { ctx } = await setup([{ issue: 9, title: "Nine", runId: "ws9" }]);
    expect(knownRuns(ctx, 1).map((r) => r.runId)).toContain("ws9");
    expect(JSON.stringify(boardFor(ctx, NOW))).toContain("Nine");
  });

  it("a tracked run outside the newest 200 is still found, with one read at most", async () => {
    fixture();
    for (let i = 0; i < 210; i++) save(runs, `z${String(i).padStart(3, "0")}`, { startedAt: ago(10 * MIN), finishedAt: ago(9 * MIN), vars: { github_repo: "acme/app", issue: String(500 + i) } });
    const { ctx, list, get } = await setup([{ issue: 7, title: "Seven", runId: "failed7" }]);
    const known = knownRuns(ctx);
    expect(known.map((r) => r.runId)).toContain("failed7");
    expect(await reads(ctx, { list, get }, () => boardFor(ctx, NOW))).toBeLessThanOrEqual(1);
  });

  it("the owner of a run comes from the index, for many runs", async () => {
    for (let i = 0; i < 5; i++) save(runs, `o${i}`, { owner: `u${i}` } as never);
    const { ctx, get } = await setup();
    const before = runReadCount();
    for (let i = 0; i < 5; i++) expect(ctx.scheduler.ownerOf(`o${i}`)).toBe(`u${i}`);
    expect(ctx.scheduler.workspaceOf("o0")).toBe("default");
    expect(runReadCount() - before).toBe(0);
    expect(get).toHaveBeenCalledTimes(0);
  });
});

describe("waiting for the index", () => {
  const res = () => {
    const r = { statusCode: 0, body: "", writeHead(c: number) { r.statusCode = c; return r; }, setHeader() {}, end(b: string) { r.body = b; } };
    return r as never as import("node:http").ServerResponse & { statusCode: number };
  };

  it("indexReady waits for the build and answers true", async () => {
    fixture();
    const idx2 = new RunIndex(runs);
    idx = idx2;
    const config = ConfigSchema.parse({});
    sched = new Scheduler({ runsDir: runs, config: () => config, runIndex: idx2 });
    const ctx = { scheduler: sched } as unknown as ApiContext;
    expect(sched.runIndexReady()).toBe(false);
    expect(await indexReady(ctx, res())).toBe(true);
    expect(sched.runIndexReady()).toBe(true);
  });

  it("indexReady answers 503 when the index cannot be built", async () => {
    rmSync(runs, { recursive: true });
    writeFileSync(runs, "not a folder");
    const idx2 = new RunIndex(runs);
    idx = idx2;
    const config = ConfigSchema.parse({});
    sched = new Scheduler({ runsDir: runs, config: () => config, runIndex: idx2 });
    const ctx = { scheduler: sched } as unknown as ApiContext;
    const r = res();
    expect(await indexReady(ctx, r)).toBe(false);
    expect(r.statusCode).toBe(503);
  });

  it("Your turn and search answer 503 when the index cannot be built, and read no run file", async () => {
    rmSync(runs, { recursive: true });
    writeFileSync(runs, "not a folder");
    const idx2 = new RunIndex(runs);
    idx = idx2;
    const config = ConfigSchema.parse({});
    sched = new Scheduler({ runsDir: runs, config: () => config, runIndex: idx2 });
    const ctx = { scheduler: sched } as unknown as ApiContext;
    const user = { id: "u", role: "admin" } as never;
    const before = runReadCount();
    const a = res();
    expect(await yourTurnRoutes(ctx, { url: "/api/your-turn" } as never, a, ["your-turn"], "GET", user)).toBe(true);
    expect(a.statusCode).toBe(503);
    const b = res();
    expect(await searchRoutes(ctx, { url: "/api/search?q=x" } as never, b, ["search"], "GET", user)).toBe(true);
    expect(b.statusCode).toBe(503);
    await expect(searchRoutes(ctx, { url: `/api/search?q=${"x".repeat(SEARCH_Q_MAX + 1)}` } as never, res(), ["search"], "GET", user)).rejects.toThrow();
    expect(await yourTurnRoutes(ctx, { url: "/api/your-turn/mine" } as never, res(), ["your-turn", "mine"], "GET", user)).toBe(false);
    expect(runReadCount() - before).toBe(0);
  });
});

describe("ClarityRecorder", () => {
  it("takes no sample while the run index is not ready", async () => {
    const { ctx } = await setup();
    vi.spyOn(ctx.scheduler, "runIndexReady").mockReturnValue(false);
    new ClarityRecorder(ctx, { log: () => {} } as never).check(NOW);
    expect(existsSync(join(process.env.FACTORY_HOME!, "clarity.json"))).toBe(false);
  });
});
