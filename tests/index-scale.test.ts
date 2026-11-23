import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { runReadCount } from "../src/engine/state.js";
import { saveIssueList, type IssueRecord } from "../src/queue/issue-list.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, TEST_PASSWORD, type TestSession } from "./helpers/session.js";

// #934: 5,000 planted runs, 20 of them about 2 MB. Every list endpoint of #930-#932 answers fast from the run
// index, parses at most one run.json per request, and the heap stays small. The runs are written before the
// server starts, so the real background build of the index reads them.

const TOTAL = 5000;
const LARGE_EVERY = 250; // 20 large runs
const BIG = 1_000_000;
const LIMIT_MS = 200;
const HEAP_MAX = 500 * 1024 * 1024;
const DAY = 86_400_000;

let base: string;
let tmp: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startTestServer>>["ctx"];
let kc: FakeKeychain;
let saved: Record<string, string | undefined>;
let admin: TestSession;
let ann: TestSession;
let annRepo: string;
let maxHeap = 0;
let sampler: NodeJS.Timeout | undefined;

/** Remembers the highest heap seen. Called by a timer during the build and after every response. */
function sampleHeap(): number {
  const used = process.memoryUsage().heapUsed;
  if (used > maxHeap) maxHeap = used;
  return used;
}

const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const pad = (n: number) => String(n).padStart(5, "0");
/** Run ids sort descending in the index, so the newest run (age index 0) gets the highest id. */
const idOf = (i: number) => `r${pad(TOTAL - 1 - i)}`;
const step = (id: string, output: string, startedAt: string) => ({ id, type: "shell", visit: 1, ok: true, output, startedAt, durationMs: 1000, logFile: "x" });

/**
 * Plants the runs straight on disk (not through saveRun, which would fill the in-memory store).
 * Age index i: 0 is the newest. Waiting runs, a failed run and a large run are all among the newest 200.
 */
function plantAll(runs: string, adminId: string, annId: string): void {
  for (let i = 0; i < TOTAL; i++) {
    const id = idOf(i);
    const runDir = join(runs, id);
    mkdirSync(runDir, { recursive: true });
    const large = i % LARGE_EVERY === 10;
    const waiting = i < 5;
    const failed = i % 50 === 3;
    const at = ago((i * 60) / TOTAL);
    const history: unknown[] = [step("pull_ticket", `# #${i + 1}: Title ${id}`, at), step("push_develop", `COMMIT: ${((i % 15) + 1).toString(16).repeat(40)}`, at)];
    const steps: Record<string, unknown> = {};
    if (large) {
      history.push(step("build", "x".repeat(BIG), at));
      steps.build = { output: "x".repeat(BIG) };
    }
    const run: Record<string, unknown> = {
      runId: id, flow: "issue-gitflow", task: large ? "t".repeat(90_000) : "t",
      vars: { github_repo: "acme/app", develop_branch: "develop", issue: String(i + 1) }, repo: "/x",
      status: waiting ? "waiting" : failed ? "failed" : "succeeded", ...(failed ? { reason: "boom" } : {}),
      owner: i % 2 === 0 ? annId : adminId, source: "ui", runDir, startedAt: ago((i * 60) / TOTAL + 0.01),
      ...(waiting ? {} : { finishedAt: at }), totalCostUsd: 0.5, flowDef: { name: "issue-gitflow", steps: [] },
      state: { next: null, steps, visits: {} }, history,
    };
    writeFileSync(join(runDir, "run.json"), JSON.stringify(run));
  }
}

beforeAll(async () => {
  saved = { FACTORY_HOME: process.env.FACTORY_HOME, FACTORY_RUN_INDEX_SYNC: process.env.FACTORY_RUN_INDEX_SYNC, FACTORY_GH_BIN: process.env.FACTORY_GH_BIN };
  tmp = mkdtempSync(join(tmpdir(), "index-scale-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  const runs = join(tmp, "runs");
  mkdirSync(runs, { recursive: true });
  kc = fakeKeychain();
  process.env.FACTORY_RUN_INDEX_SYNC = "0"; // the production index, built in the background
  process.env.FACTORY_GH_BIN = join(tmp, "no-gh"); // /api/since fails to read GitHub at once; GitHub is never reached
  const adminUser = await createUser({ name: "Test Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  const annUser = await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "user" });
  annRepo = addRepo(annUser.id, { url: "acme/app" }).id;
  plantAll(runs, adminUser.id, annUser.id);
  sampler = setInterval(sampleHeap, 20);
  sampler.unref();
  ({ close, ctx, base } = await startTestServer({ repo: tmp, runsDir: runs, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false }));
  await ctx.scheduler.whenIndexReady();
  sampleHeap();
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  saveConfig({ ...loadConfig(), watchers: [{ id: "app-w", github_repo: "acme/app", enabled: true }] } as never);
  ctx.reloadConfig();
  const d = (n: number) => new Date(Date.now() - n * DAY).toISOString();
  saveIssueList("acme/app", [
    { number: 1, title: "Epic", state: "open", labels: ["claude-factory"], createdAt: d(10), dependsOn: [], stories: [2], updatedAt: d(1) } as IssueRecord,
    { number: 2, title: "Story", state: "closed", closedAt: d(1), epic: 1, labels: ["claude-factory"], createdAt: d(10), dependsOn: [], updatedAt: d(1) } as IssueRecord,
  ], new Date(), false);
}, 120_000);

afterAll(async () => {
  if (sampler) clearInterval(sampler);
  close?.();
  await new Promise((r) => setTimeout(r, 300));
  kc?.remove();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const sinceIso = () => encodeURIComponent(new Date(Date.now() - 6 * 3_600_000).toISOString());


function endpoints(): { path: string; who: "admin" | "ann" }[] {
  return [
    { path: "/api/runs", who: "admin" },
    { path: "/api/search?q=acme", who: "admin" },
    { path: "/api/your-turn", who: "admin" },
    { path: "/api/board", who: "admin" },
    { path: "/api/next", who: "admin" },
    { path: `/api/since?since=${sinceIso()}`, who: "admin" },
    { path: "/api/clarity", who: "admin" },
    { path: "/api/health", who: "admin" },
    { path: "/api/outcomes", who: "admin" },
    { path: "/api/autonomy", who: "admin" },
    { path: "/api/stats", who: "admin" },
    { path: `/api/repos/${annRepo}/epics`, who: "admin" },
    { path: "/api/runs", who: "ann" },
    { path: "/api/search?q=acme", who: "ann" },
    { path: "/api/your-turn/mine", who: "ann" },
    { path: "/api/outcomes", who: "ann" },
    { path: `/api/repos/${annRepo}/safe-points`, who: "ann" },
    { path: `/api/repos/${annRepo}/epics`, who: "ann" },
  ];
}

/** One request: status, time, run.json parses, and the body text. The heap is sampled after the response. */
async function call(who: "admin" | "ann", path: string) {
  const session = who === "admin" ? admin : ann;
  const before = runReadCount();
  const t0 = performance.now();
  const r = await fetch(base + path, { headers: session.headers("GET") });
  const text = await r.text();
  const wallMs = performance.now() - t0;
  const parses = runReadCount() - before;
  sampleHeap();
  return { status: r.status, wallMs, parses, text };
}

describe("the run index at 5,000 runs", () => {
  it("the index holds all runs, and the heap stayed under 500 MB while it was built", () => {
    expect(ctx.scheduler.briefs().length).toBe(TOTAL);
    expect(maxHeap).toBeLessThan(HEAP_MAX);
  });

  it("every list endpoint answers 200 with content, parsing at most one run.json per request", async () => {
    for (const { path, who } of endpoints()) {
      const r = await call(who, path);
      expect(r.status, `${who} ${path}`).toBe(200);
      expect(r.parses, `${who} ${path} parsed run files`).toBeLessThanOrEqual(1);
      if (path === "/api/runs") {
        const rows = JSON.parse(r.text) as { runId: string; status: string }[];
        expect(rows.length, `${who} ${path} rows`).toBe(200);
        expect(rows[0].runId).toBe(idOf(0));
        expect(rows.some((x) => x.status === "waiting")).toBe(true);
        expect(rows.some((x) => x.runId === idOf(10))).toBe(true); // a large run is in the capped list
      }
      if (path.startsWith("/api/search")) {
        const group = (JSON.parse(r.text).groups as { type: string; hits: unknown[] }[]).find((g) => g.type === "run");
        expect(group?.hits.length, `${who} ${path} hits`).toBeGreaterThan(0);
      }
      // The admin's list shows the waiting runs. "/mine" is only what the user must answer, which can be empty.
      if (path === "/api/your-turn") expect(r.text, `${who} ${path}`).toContain(idOf(0));
      // The admin stats read the newest 2000 runs (list(2000) in api-admin), so the count is capped there.
      if (path === "/api/stats") expect(JSON.parse(r.text).totals.runs).toBeGreaterThanOrEqual(2000);
      if (path === "/api/outcomes") expect(JSON.parse(r.text).measures.find((m: any) => m.id === "resume_count").counted).toBeGreaterThan(0);
    }
  });

  it("every list endpoint answers in under 200 ms (wall time) on every call after one warm-up call", async () => {
    for (const { path, who } of endpoints()) {
      await call(who, path); // warm-up: code compiled, the per-run facts of outcomes and autonomy filled
      for (let n = 0; n < 3; n++) {
        const r = await call(who, path);
        expect(r.status, `${who} ${path}`).toBe(200);
        expect(r.wallMs, `${who} ${path} call ${n + 1}: ${Math.round(r.wallMs)} ms`).toBeLessThan(LIMIT_MS);
      }
    }
  });

  it("the heap never went over 500 MB, in the build or after any response", () => {
    // Sampled every 20 ms during the build and after every response; a peak between two samples is not seen.
    expect(sampleHeap()).toBeLessThan(HEAP_MAX);
    expect(maxHeap).toBeLessThan(HEAP_MAX);
  });
});
