import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, type Job, type SchedulerOptions } from "../src/queue/scheduler.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const PLAIN = parseFlow(`name: plain
workspace: empty
steps:
  - {id: a, type: shell, run: "true"}
`);

/** A flow that works until the test creates the file `<dir>/<run id>`. */
const gateFlow = (dir: string) => parseFlow(`name: slow
workspace: empty
steps:
  - {id: a, type: shell, run: 'while [ ! -e "${dir}/$FACTORY_RUN_ID" ]; do sleep 0.05; done'}
`);

type Limits = { maxConcurrent?: number; maxRunsPerDay?: number; dailyBudgetUsd?: number };
const REFINE = "refinement 7d2b0c1e-0000-4000-8000-00000000000";

describe("scheduler fair use", () => {
  // Real accounts (admins, so their runs need no sign-in); A is the first admin, who gets runs nobody owns.
  let A = "", B = "", X = "";
  let tmp: string;
  let concurrency = 0;
  let limits: Record<string, Limits> = {};
  let today: number | undefined;
  let s: Scheduler;
  let GATE = PLAIN;
  const cfg = (): Config => ({ ...ConfigSchema.parse({}), concurrency });
  const mk = (extra: Partial<SchedulerOptions> = {}) =>
    (s = new Scheduler({ runsDir: join(tmp, "runs"), config: cfg, userLimits: (id) => limits[id] ?? {}, ...extra }));
  const job = (flow = GATE): Job => ({ kind: "run", flow, task: "t", repo: tmp, vars: {} });
  const active = () => s.queue().active.map((a) => a.source);
  const pending = () => s.queue().pending;
  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fn()).toBe(true);
  };
  const open = (runId: string) => writeFileSync(join(tmp, "gates", runId), "");
  /** Lets the active run of a source end, and waits until it is gone. */
  const finish = async (source: string) => {
    const a = s.queue().active.find((x) => x.source === source)!;
    open(a.runId);
    await waitFor(() => !s.isActive(a.runId));
  };

  beforeAll(async () => {
    A = (await createUser({ name: "Ann", email: "ann@example.com", password: TEST_PASSWORD, role: "admin" })).id;
    B = (await createUser({ name: "Bob", email: "bob@example.com", password: TEST_PASSWORD, role: "admin" })).id;
    X = (await createUser({ name: "Xia", email: "xia@example.com", password: TEST_PASSWORD, role: "admin" })).id;
  });
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-fair-"));
    mkdirSync(join(tmp, "runs"));
    mkdirSync(join(tmp, "gates"));
    GATE = gateFlow(join(tmp, "gates"));
    concurrency = 0;
    limits = {};
    today = undefined;
  });
  afterEach(async () => {
    for (const p of s.queue().pending) s.cancel(p.runId);
    for (const a of s.queue().active) open(a.runId);
    await waitFor(() => s.queue().active.length === 0);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("shares slots round-robin: a second user's job is the second start", async () => {
    mk();
    for (let i = 0; i < 5; i++) s.submit(job(), { source: `a${i}`, owner: A });
    s.submit(job(), { source: "b0", owner: B });
    concurrency = 1;
    s.recheck();
    expect(active()).toEqual(["a0"]);
    await finish("a0");
    expect(active()).toEqual(["b0"]);
  });

  it("gives the slot to the user with the fewest active runs", () => {
    mk();
    s.submit(job(), { source: "a0", owner: A });
    concurrency = 1;
    s.recheck();
    s.submit(job(), { source: "a1", owner: A });
    s.submit(job(), { source: "b0", owner: B });
    concurrency = 2;
    s.recheck();
    expect(active().sort()).toEqual(["a0", "b0"]);
  });

  it("keeps the queue order for one account without limits", async () => {
    mk();
    for (let i = 0; i < 3; i++) s.submit(job(), { source: `a${i}`, owner: A });
    concurrency = 1;
    s.recheck();
    expect(active()).toEqual(["a0"]);
    await finish("a0");
    expect(active()).toEqual(["a1"]);
  });

  it("never has more runs of a user active than maxConcurrent, and starts the next one by itself", async () => {
    mk();
    limits[A] = { maxConcurrent: 1 };
    for (let i = 0; i < 3; i++) s.submit(job(), { source: `a${i}`, owner: A });
    s.submit(job(), { source: "b0", owner: B });
    concurrency = 3;
    s.recheck();
    expect(active().sort()).toEqual(["a0", "b0"]);
    expect(pending().map((p) => [p.source, p.limit])).toEqual([["a1", "concurrent"], ["a2", "concurrent"]]);
    await finish("a0");
    expect(active().sort()).toEqual(["a1", "b0"]);
    expect(pending().map((p) => p.source)).toEqual(["a2"]);
  });

  it("holds new runs at maxRunsPerDay, counting runs started in the same pump", () => {
    mk();
    limits[A] = { maxRunsPerDay: 2 };
    for (let i = 0; i < 3; i++) s.submit(job(), { source: `a${i}`, owner: A });
    concurrency = 3;
    s.recheck();
    expect(active().sort()).toEqual(["a0", "a1"]);
    expect(pending().map((p) => [p.source, p.limit])).toEqual([["a2", "per_day"]]);
  });

  it("holds a new run at the per-day limit with an injected counter, still starts a resume, and releases after recheck", async () => {
    mk({ startedToday: () => today ?? 0 });
    concurrency = 1;
    s.submit(job(PLAIN), { source: "first", owner: A });
    await waitFor(() => s.queue().active.length === 0 && s.list().length === 1);
    const runId = s.list()[0]!.runId;
    limits[A] = { maxRunsPerDay: 2 };
    today = 2;
    concurrency = 3;
    s.submit(job(), { source: "new", owner: A });
    expect(pending().map((p) => [p.source, p.limit])).toEqual([["new", "per_day"]]);
    s.submit({ kind: "resume", runId }, { source: "resume" });
    expect(pending().map((p) => p.source)).toEqual(["new"]);
    today = 0;
    s.recheck();
    expect(active()).toContain("new");
    expect(pending()).toEqual([]);
  });

  it("does not count a run twice with a counter that reads the run files", () => {
    mk({ startedToday: (id) => s.briefs().filter((b) => b.owner === id).length });
    limits[A] = { maxRunsPerDay: 2 };
    for (let i = 0; i < 3; i++) s.submit(job(), { source: `a${i}`, owner: A });
    concurrency = 3;
    s.recheck();
    expect(active().sort()).toEqual(["a0", "a1"]);
    expect(pending().map((p) => p.limit)).toEqual(["per_day"]);
  });

  it("counts runs from the run files when no counter is given", async () => {
    mk();
    concurrency = 1;
    s.submit(job(PLAIN), { source: "p", owner: A });
    await waitFor(() => s.queue().active.length === 0 && s.list().length === 1);
    limits[A] = { maxRunsPerDay: 1 };
    s.submit(job(), { source: "next", owner: A });
    expect(pending().map((p) => [p.source, p.limit])).toEqual([["next", "per_day"]]);
    limits[A] = { maxRunsPerDay: 2 };
    s.recheck();
    expect(active()).toEqual(["next"]);
  });

  it("does not count architect runs for runs per day, but holds them by maxConcurrent", () => {
    mk({ startedToday: () => 9 });
    limits[A] = { maxRunsPerDay: 1, maxConcurrent: 1 };
    concurrency = 3;
    s.submit(job(), { source: `${REFINE}0`, owner: A });
    expect(active()).toEqual([`${REFINE}0`]);
    s.submit(job(), { source: `${REFINE}1`, owner: A });
    expect(pending().map((p) => p.limit)).toEqual(["concurrent"]);
  });

  it("holds a resume by the owner's maxConcurrent and starts it when a run ends", async () => {
    mk();
    concurrency = 1;
    s.submit(job(PLAIN), { source: "old", owner: A });
    await waitFor(() => s.queue().active.length === 0 && s.list().length === 1);
    const runId = s.list()[0]!.runId;
    concurrency = 3;
    limits[A] = { maxConcurrent: 1 };
    s.submit(job(), { source: "busy", owner: A });
    s.submit({ kind: "resume", runId }, { source: "resume" });
    expect(pending().map((p) => [p.runId, p.limit])).toEqual([[runId, "concurrent"]]);
    await finish("busy");
    await waitFor(() => s.queue().pending.length === 0);
  });

  it("still respects locks, and another account's job starts meanwhile", () => {
    mk();
    concurrency = 3;
    s.submit(job(), { source: "a0", owner: A, lockKey: "k" });
    s.submit(job(), { source: "a1", owner: A, lockKey: "k" });
    s.submit(job(), { source: "b0", owner: B });
    expect(active().sort()).toEqual(["a0", "b0"]);
    const p = pending()[0]!;
    expect(p.waitingFor).toBeDefined();
    expect(p.limit).toBeUndefined();
  });

  it("holds a priority job by its owner's limit without holding others back", () => {
    mk();
    limits[A] = { maxConcurrent: 1 };
    concurrency = 3;
    s.submit(job(), { source: "a0", owner: A });
    s.submit(job(), { source: "aP", owner: A, priority: true });
    s.submit(job(), { source: "b0", owner: B });
    expect(active().sort()).toEqual(["a0", "b0"]);
    const p = pending().find((x) => x.source === "aP")!;
    expect(p.limit).toBe("concurrent");
    expect(p.priority).toBe(true);
  });

  it("does not mark a job as behind a priority job that is held by a limit", () => {
    mk();
    limits[A] = { maxConcurrent: 1 };
    concurrency = 1;
    s.submit(job(), { source: "a0", owner: A });
    s.submit(job(), { source: "aP", owner: A, priority: true });
    s.submit(job(), { source: "b0", owner: B });
    const b = pending().find((x) => x.source === "b0")!;
    expect(b.behindPriority).toBeUndefined();
    expect(pending().find((x) => x.source === "aP")!.limit).toBe("concurrent");
  });

  it("still starts a priority job that is not held first", () => {
    mk();
    s.submit(job(), { source: "n", owner: B });
    s.submit(job(), { source: "P", owner: A, priority: true });
    concurrency = 1;
    s.recheck();
    expect(active()).toEqual(["P"]);
  });

  it("does not limit jobs without an owner, and rotates them with an owned account", async () => {
    mk();
    limits = new Proxy({}, { get: () => ({ maxConcurrent: 1, maxRunsPerDay: 1 }) }) as Record<string, Limits>;
    concurrency = 3;
    for (let i = 0; i < 3; i++) s.submit(job(), { source: `o${i}` });
    expect(active().sort()).toEqual(["o0", "o1", "o2"]);
    for (const a of s.queue().active) open(a.runId);
    await waitFor(() => s.queue().active.length === 0);

    mk();
    concurrency = 0;
    s.submit(job(), { source: "p0" });
    s.submit(job(), { source: "p1" });
    s.submit(job(), { source: "b0", owner: B });
    concurrency = 1;
    s.recheck();
    expect(active()).toEqual(["p0"]);
    await finish("p0");
    expect(active()).toEqual(["b0"]);
  });

  it("charges an ownerless start to the first admin but keeps it in the ownerless group", async () => {
    mk();
    limits[A] = { maxRunsPerDay: 1 };
    concurrency = 3;
    s.submit(job(), { source: "o0" });
    s.submit(job(), { source: "a0", owner: A });
    expect(active()).toEqual(["o0"]);
    expect(pending().map((p) => [p.source, p.limit])).toEqual([["a0", "per_day"]]);
    await finish("o0");
  });

  it("still holds jobs of a blocked account, and a failing userLimits means no limits", () => {
    mk({ accountActive: (id) => id !== X });
    concurrency = 3;
    s.submit(job(), { source: "x0", owner: X, queuedBy: X });
    expect(active()).toEqual([]);
    expect(pending()[0]!.limit).toBeUndefined();
    mk({
      userLimits: () => {
        throw new Error("boom");
      },
    });
    s.submit(job(), { source: "a0", owner: A });
    s.submit(job(), { source: "a1", owner: A });
    expect(active().sort()).toEqual(["a0", "a1"]);
  });

  it("keeps existing runs when a limit drops, and starts nothing until usage is below it", async () => {
    mk();
    concurrency = 5;
    s.submit(job(), { source: "a0", owner: A });
    s.submit(job(), { source: "a1", owner: A });
    limits[A] = { maxConcurrent: 1 };
    s.submit(job(), { source: "a2", owner: A });
    s.recheck();
    expect(active().sort()).toEqual(["a0", "a1"]);
    expect(pending()[0]!.limit).toBe("concurrent");
    await finish("a0");
    expect(active()).toEqual(["a1"]);
    expect(pending().map((p) => p.source)).toEqual(["a2"]);
    await finish("a1");
    expect(active()).toEqual(["a2"]);
  });

  describe("daily budget", () => {
    it("holds a job of an account whose budget is used up, starts the others, and starts it when the spend drops", () => {
      let spent = 5;
      mk({ spentTodayBy: () => spent });
      limits[A] = { dailyBudgetUsd: 1 };
      concurrency = 5;
      s.submit(job(), { source: "a0", owner: A });
      s.submit(job(), { source: "b0", owner: B });
      expect(active()).toEqual(["b0"]);
      expect(pending()[0]!.limit).toBe("budget");
      spent = 0;
      s.recheck();
      expect(active().sort()).toEqual(["a0", "b0"]);
    });

    it("holds a resume job of the account too", async () => {
      let spent = 0;
      mk({ spentTodayBy: () => spent });
      concurrency = 1;
      s.submit(job(PLAIN), { source: "old", owner: A });
      await waitFor(() => s.queue().active.length === 0 && s.list().length === 1);
      const runId = s.list()[0]!.runId;
      concurrency = 3;
      limits[A] = { dailyBudgetUsd: 1 };
      spent = 5;
      s.submit({ kind: "resume", runId }, { source: "resume" });
      expect(pending().map((p) => [p.runId, p.limit])).toEqual([[runId, "budget"]]);
    });

    it("is not held when cost limits are off, or without a cap", () => {
      limits[A] = { dailyBudgetUsd: 1 };
      concurrency = 5;
      s = new Scheduler({ runsDir: join(tmp, "runs"), config: () => ({ ...cfg(), cost_limits: false }), userLimits: (id) => limits[id] ?? {}, spentTodayBy: () => 5 });
      s.submit(job(), { source: "a0", owner: A });
      expect(active()).toEqual(["a0"]);
    });

    it("never holds a job without an owner, and the engine does not apply the first admin's cap to it", async () => {
      limits[A] = { dailyBudgetUsd: 0.001 };
      concurrency = 5;
      mk({ spentTodayBy: () => 5, claudeBin: join(process.cwd(), "tests/fixtures/fake-claude.mjs") });
      const two = parseFlow(`name: two
workspace: empty
steps:
  - {id: a, type: claude, prompt: one}
  - {id: b, type: claude, prompt: two}
`);
      const runId = s.submit({ kind: "run", flow: two, task: "t", repo: tmp, vars: {} }, { source: "cli" });
      expect(pending()).toEqual([]);
      await waitFor(() => !s.isActive(runId) && s.get(runId)?.status === "succeeded");
      expect(s.get(runId)!.owner).toBe(A);
    });

    it("starts the next day (the day rule reads the run files)", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const day = new Date(2026, 9, 7, 12, 0, 0);
        vi.setSystemTime(day);
        const dir = join(tmp, "runs", "20261007-100000-aaaa");
        mkdirSync(dir);
        writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "20261007-100000-aaaa", startedAt: day.toISOString(), totalCostUsd: 3, owner: A }));
        mk();
        limits[A] = { dailyBudgetUsd: 1 };
        concurrency = 5;
        s.submit(job(), { source: "a0", owner: A });
        expect(active()).toEqual([]);
        expect(pending()[0]!.limit).toBe("budget");
        vi.setSystemTime(new Date(2026, 9, 8, 0, 5, 0));
        s.recheck();
        expect(active()).toEqual(["a0"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("userDailyBudget is undefined for 0, NaN, a throwing source and no source", () => {
      mk();
      limits[A] = { dailyBudgetUsd: 0 };
      expect(s.userDailyBudget(A)).toBeUndefined();
      limits[A] = { dailyBudgetUsd: Number.NaN };
      expect(s.userDailyBudget(A)).toBeUndefined();
      limits[A] = { dailyBudgetUsd: 2.5 };
      expect(s.userDailyBudget(A)).toBe(2.5);
      const throwing = new Scheduler({ runsDir: join(tmp, "runs"), config: cfg, userLimits: () => { throw new Error("x"); } });
      expect(throwing.userDailyBudget(A)).toBeUndefined();
      const none = new Scheduler({ runsDir: join(tmp, "runs"), config: cfg });
      expect(none.userDailyBudget(A)).toBeUndefined();
    });
  });

  it("has no limit field and no limits without the options", () => {
    s = new Scheduler({ runsDir: join(tmp, "runs"), config: cfg });
    for (let i = 0; i < 3; i++) s.submit(job(), { source: `a${i}`, owner: A });
    expect(pending().every((p) => !("limit" in p))).toBe(true);
    concurrency = 3;
    s.recheck();
    expect(active().sort()).toEqual(["a0", "a1", "a2"]);
  });
});
