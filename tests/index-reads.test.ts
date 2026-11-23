import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { runReadCount, saveRun, type RunSummary } from "../src/engine/state.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { saveIssueList, type IssueRecord } from "../src/queue/issue-list.js";
import { statusTargets, type StatusView } from "../src/queue/status-comment.js";
import { forgetHistory, historyFor } from "../src/server/next.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

// #932: outcomes, autonomy, safe points, stats and the epics history take their runs from the run index.
// One request over many runs parses at most one run.json (the index builds them once, when it is made).

let base: string;
let tmp: string;
let runs: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startTestServer>>["ctx"];
let kc: FakeKeychain;
let saved: string | undefined;
let savedSync: string | undefined;
let admin: TestSession;
let ann: TestSession;
let annRepo: string;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const sha = (c: string) => c.repeat(40);
const step = (id: string, output: string, startedAt: string) => ({ id, type: "shell", visit: 1, ok: true, output, startedAt, durationMs: 1000, logFile: "x" });
const COUNT = 7;

function plant(id: string, i: number, over: Partial<RunSummary> = {}) {
  const runDir = join(runs, id);
  mkdirSync(runDir, { recursive: true });
  const at = ago(2 + i / 100);
  saveRun({
    runId: id, flow: "issue-gitflow", task: "t", vars: { github_repo: "acme/app", develop_branch: "develop", issue: String(i + 1) }, repo: "/x", status: "succeeded",
    owner: ann.user.id, source: "ui", runDir, startedAt: ago(2 + i / 100 + 0.01), finishedAt: at, totalCostUsd: 0.5, flowDef: { name: "issue-gitflow", steps: [] },
    state: { next: null, steps: {}, visits: {} },
    history: [step("pull_ticket", `# #${i + 1}: Title ${id}`, at), step("push_develop", `COMMIT: ${sha((i + 10).toString(16).slice(-1))}`, at)], ...over,
  } as unknown as RunSummary);
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "index-reads-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  runs = join(tmp, "runs");
  mkdirSync(runs, { recursive: true });
  kc = fakeKeychain();
  // The production index: built in the background, not read on every call. Restored in afterAll.
  savedSync = process.env.FACTORY_RUN_INDEX_SYNC;
  process.env.FACTORY_RUN_INDEX_SYNC = "0";
  ({ close, ctx, base } = await startTestServer({ repo: tmp, runsDir: runs, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  annRepo = addRepo(ann.user.id, { url: "acme/app" }).id;
  for (let i = 0; i < COUNT; i++) plant(`r${i}`, i);
  // the folder name and the runId inside differ: the run is left out of outcomes and of the gate
  plant("odd", COUNT, { runId: "not-odd" } as Partial<RunSummary>);
});
afterAll(async () => {
  close();
  await new Promise((r) => setTimeout(r, 300));
  kc.remove();
  if (savedSync === undefined) delete process.env.FACTORY_RUN_INDEX_SYNC;
  else process.env.FACTORY_RUN_INDEX_SYNC = savedSync;
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

/** One request, with the number of run.json parses it caused. */
async function counted(who: TestSession, path: string) {
  await ctx.scheduler.whenIndexReady();
  const before = runReadCount();
  const r = await fetch(base + path, { headers: who.headers("GET") });
  const text = await r.text();
  return { status: r.status, parses: runReadCount() - before, json: () => JSON.parse(text) as any };
}

describe("readers take their runs from the run index", () => {
  it("outcomes: counts the runs without parsing them again", async () => {
    const r = await counted(admin, "/api/outcomes");
    expect(r.status).toBe(200);
    expect(r.parses).toBeLessThanOrEqual(1);
    const total = r.json().measures.find((m: any) => m.id === "resume_count").counted;
    expect(total).toBe(COUNT); // "odd" is left out: its runId differs from its folder
    const mine = await counted(ann, "/api/outcomes");
    expect(mine.parses).toBeLessThanOrEqual(1);
    expect(mine.json().measures.find((m: any) => m.id === "resume_count").counted).toBe(COUNT);
  });

  it("autonomy: the gate reads its runs from the index", async () => {
    const r = await counted(admin, "/api/autonomy");
    expect(r.status).toBe(200);
    expect(r.parses).toBeLessThanOrEqual(1);
    expect(JSON.stringify(r.json())).not.toContain("not-odd");
  });

  it("safe points: one point per planted push", async () => {
    const r = await counted(ann, `/api/repos/${annRepo}/safe-points`);
    expect(r.status).toBe(200);
    expect(r.parses).toBeLessThanOrEqual(1);
    expect(r.json().points.length).toBeGreaterThanOrEqual(COUNT);
    expect(r.json().points.flatMap((p: any) => p.changes.map((c: any) => c.title))).toContain("Title r0");
  });

  it("stats: counts every run", async () => {
    const r = await counted(admin, "/api/stats");
    expect(r.status).toBe(200);
    expect(r.parses).toBeLessThanOrEqual(1);
    expect(r.json().totals.runs).toBeGreaterThanOrEqual(COUNT);
  });

  // The board reads inside an epics request (boardSources → knownRuns) still parse run files; that is another part of #924.
  // This test checks the real request works with the index and a watcher; the history parse count is checked below.
  it("epics: a real request, as admin and as the user, answers 200", async () => {
    saveConfig({ ...loadConfig(), watchers: [{ id: "app-w", github_repo: "acme/app", enabled: true }] } as never);
    ctx.reloadConfig();
    const d = (n: number) => new Date(Date.now() - n * DAY).toISOString();
    saveIssueList("acme/app", [
      { number: 1, title: "Epic", state: "open", labels: ["claude-factory"], createdAt: d(10), dependsOn: [], stories: [2], updatedAt: d(1) } as IssueRecord,
      { number: 2, title: "Story", state: "closed", closedAt: d(1), epic: 1, labels: ["claude-factory"], createdAt: d(10), dependsOn: [], updatedAt: d(1) } as IssueRecord,
    ], new Date(), false);
    forgetHistory(ctx);
    for (const who of [admin, ann]) {
      const r = await counted(who, `/api/repos/${annRepo}/epics`);
      expect(r.status).toBe(200);
    }
  });

  it("status comments: one statusTargets pass over the live index parses at most one run.json", async () => {
    await ctx.scheduler.whenIndexReady();
    const tracked = Array.from({ length: COUNT }, (_, i) => ({ issue: i + 1, title: `Story ${i + 1}`, runId: `r${i}` }));
    const view: StatusView = {
      id: "w", label: "claude-factory", failedLabel: "factory:failed", tracked, holds: [], closed: [], complete: true,
      scheduler: ctx.scheduler, lastRunId: (n) => `r${n - 1}`,
    };
    const before = runReadCount();
    const targets = statusTargets("acme/app", [view], new Map(), false);
    expect(targets).toHaveLength(COUNT);
    expect(runReadCount() - before).toBeLessThanOrEqual(1);
  });

  it("epics: the duration history comes from the index, not from list()", async () => {
    await ctx.scheduler.whenIndexReady();
    const real = ctx.scheduler.list.bind(ctx.scheduler);
    const limits: number[] = [];
    ctx.scheduler.list = ((n?: number) => (limits.push(n ?? -1), [])) as typeof ctx.scheduler.list;
    try {
      forgetHistory(ctx);
      const before = runReadCount();
      historyFor(ctx);
      expect(limits).toEqual([]);
      expect(runReadCount() - before).toBeLessThanOrEqual(1);
    } finally {
      ctx.scheduler.list = real;
      forgetHistory(ctx);
    }
  });
});
