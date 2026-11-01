import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { Scheduler, type Job, type SchedulerOptions } from "../src/queue/scheduler.js";
import { setCap } from "../src/ops/caps.js";
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

  it("an architect run takes no slot: it starts past the configured number and a helper's cap, one per account at a time", async () => {
    setCap("load", { runs: 1, until: new Date(Date.now() + 60_000).toISOString(), why: "test" });
    try {
      concurrency = 1;
      mk();
      s.submit(job(), { source: "story-1", owner: A });
      const story2 = s.submit(job(), { source: "story-2", owner: A });
      expect(active()).toEqual(["story-1"]);
      // every place is taken and the cap is reached: an architect run starts anyway
      s.submit(job(), { source: `${REFINE}1`, owner: A, lockKey: `architect ${A}` });
      expect(active()).toEqual(["story-1", `${REFINE}1`]);
      // a second one of the same account waits for the account's lock, and is not marked as held back by the cap
      const second = s.submit(job(), { source: `${REFINE}2`, owner: A, lockKey: `architect ${A}` });
      expect(pending().find((p) => p.runId === second)).toMatchObject({ waitingFor: expect.any(String) });
      expect(pending().find((p) => p.runId === second)).not.toHaveProperty("capped");
      // another account's architect run has its own lock and starts at once
      s.submit(job(), { source: `${REFINE}3`, owner: B, lockKey: `architect ${B}` });
      expect(active()).toContain(`${REFINE}3`);
      // the architect runs do not take the story's place: when story-1 ends, story-2 starts although they still run
      await finish("story-1");
      setCap("load", undefined);
      await waitFor(() => active().includes("story-2"));
      expect(s.isQueued(story2)).toBe(false);
      // when the first architect run ends, the account's next one starts
      await finish(`${REFINE}1`);
      await waitFor(() => active().includes(`${REFINE}2`));
    } finally {
      setCap("load", undefined);
    }
  });

  it("a schedule chore has its own lane: no story slot, before stories, one chore at a time", async () => {
    setCap("load", { runs: 1, until: new Date(Date.now() + 60_000).toISOString(), why: "test" });
    try {
      concurrency = 1;
      mk();
      s.submit(job(), { source: "story-1", owner: A });
      const story2 = s.submit(job(), { source: "story-2", owner: A });
      expect(active()).toEqual(["story-1"]);
      // every story slot is taken and the cap is reached: the release starts anyway, ahead of the queued story
      s.submit(job(), { source: "watcher rel-a schedule", owner: A, lockKey: "acme/a#chore:rel-a" });
      expect(active()).toEqual(["story-1", "watcher rel-a schedule"]);
      expect(pending().map((p) => p.runId)).toEqual([story2]);
      // a second chore waits for the first one (one at a time on the whole machine) and is not marked as capped
      const rel2 = s.submit(job(), { source: "watcher rel-b schedule", owner: B, lockKey: "acme/b#chore:rel-b" });
      expect(pending().find((p) => p.runId === rel2)).not.toHaveProperty("capped");
      expect(active()).not.toContain("watcher rel-b schedule");
      // the chore does not take the story's place: when story-1 ends, story-2 starts although the chore still runs
      await finish("story-1");
      setCap("load", undefined);
      await waitFor(() => active().includes("story-2"));
      // when the first chore ends, the next one starts
      await finish("watcher rel-a schedule");
      await waitFor(() => active().includes("watcher rel-b schedule"));
    } finally {
      setCap("load", undefined);
    }
  });

  it("a chore is not counted for runs per day and is held only by the daily budget of its account", () => {
    mk({ startedToday: () => 9, spentTodayBy: (id) => (id === B ? 5 : 0) });
    limits[A] = { maxRunsPerDay: 1, maxConcurrent: 1 };
    limits[B] = { dailyBudgetUsd: 1 };
    concurrency = 3;
    // B's budget is spent: its chore waits, and does not hold back A's chore behind it
    const held = s.submit(job(), { source: "watcher rel-b schedule", owner: B });
    // A is over its runs of the day, but a chore is not counted
    s.submit(job(), { source: "watcher rel-a schedule", owner: A });
    expect(active()).toEqual(["watcher rel-a schedule"]);
    expect(s.isQueued(held)).toBe(true);
  });

  it("starts no chore with a concurrency of 0", () => {
    mk();
    concurrency = 0;
    const id = s.submit(job(), { source: "watcher rel-a schedule", owner: A });
    expect(s.isQueued(id)).toBe(true);
  });

  it("a helper's cap holds back new runs only: a run that already started is resumed past it", async () => {
    // a stopped run on disk, as after a restart; it may hold the turn to merge that the others wait for
    const runDir = join(tmp, "runs", "stopped-1");
    mkdirSync(join(runDir, "workspace"), { recursive: true });
    mkdirSync(join(runDir, "logs"));
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "stopped-1", flow: "plain", flowDef: PLAIN, task: "t", vars: {}, repo: tmp, status: "stopped", reason: "interrupted", runDir, workdir: join(runDir, "workspace"), startedAt: new Date().toISOString(), totalCostUsd: 0, history: [], state: { next: "a", steps: {} } }));
    setCap("load", { runs: 1, until: new Date(Date.now() + 60_000).toISOString(), why: "test" });
    try {
      concurrency = 3;
      mk();
      s.submit(job(), { source: "a" });
      const waiting = s.submit(job(), { source: "b" });
      expect(active()).toEqual(["a"]);
      expect(pending().map((p) => p.runId)).toEqual([waiting]);
      // the queue says why it waits, so the monitor does not take it for a queue that stands still
      expect(pending()[0]).toMatchObject({ capped: true });
      expect(s.queue()).toMatchObject({ concurrency: 3, cap: 1 });
      s.submit({ kind: "resume", runId: "stopped-1" }, { source: "c" });
      // the resume took a slot at once although the cap is full; the new run still waits
      expect(pending().map((p) => p.runId)).toEqual([waiting]);
      await waitFor(() => JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status === "succeeded");
      expect(pending().map((p) => p.runId)).toEqual([waiting]);
      // never above the configured number, cap or not
      concurrency = 1;
      writeFileSync(join(runDir, "run.json"), readFileSync(join(runDir, "run.json"), "utf8").replace('"succeeded"', '"stopped"'));
      s.submit({ kind: "resume", runId: "stopped-1" }, { source: "d" });
      expect(pending().map((p) => p.source)).toEqual(["b", "d"]);
    } finally {
      setCap("load", undefined);
    }
    // without a cap nothing is marked
    expect(pending().some((p) => "capped" in p)).toBe(false);
    expect("cap" in s.queue()).toBe(false);
  });

  it("a cap of 0 holds every new run, also an architect run and a chore, lets a resume go on, and ends by itself", async () => {
    const runDir = join(tmp, "runs", "stopped-1");
    mkdirSync(join(runDir, "workspace"), { recursive: true });
    mkdirSync(join(runDir, "logs"));
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "stopped-1", flow: "plain", flowDef: PLAIN, task: "t", vars: {}, repo: tmp, status: "stopped", reason: "interrupted", runDir, workdir: join(runDir, "workspace"), startedAt: new Date().toISOString(), totalCostUsd: 0, history: [], state: { next: "a", steps: {} } }));
    setCap("load", { runs: 0, until: new Date(Date.now() + 60_000).toISOString(), why: "test" });
    try {
      concurrency = 3;
      mk({ capRecheckMs: 10 });
      const story = s.submit(job(), { source: "story-1", owner: A });
      const chore = s.submit(job(), { source: "watcher rel-a schedule", owner: A, lockKey: "acme/a#chore:rel-a" });
      const architect = s.submit(job(), { source: `${REFINE}1`, owner: A, lockKey: `architect ${A}` });
      expect(active()).toEqual([]);
      // the queue says why it waits, so the monitor does not take it for a queue that stands still
      expect(pending().map((p) => [p.runId, p.capped])).toEqual([[story, true], [chore, true], [architect, true]]);
      expect(s.queue()).toMatchObject({ concurrency: 3, cap: 0 });
      // a run that already started goes on
      s.submit({ kind: "resume", runId: "stopped-1" }, { source: "c" });
      await waitFor(() => JSON.parse(readFileSync(join(runDir, "run.json"), "utf8")).status === "succeeded");
      expect(pending().map((p) => p.runId)).toEqual([story, chore, architect]);
      // the cap ends: no other call, the queue looks again by itself
      setCap("load", undefined);
      await waitFor(() => ["story-1", "watcher rel-a schedule", `${REFINE}1`].every((x) => active().includes(x)));
      expect(pending()).toEqual([]);
    } finally {
      setCap("load", undefined);
    }
  });

  describe("a retry after a time limit (asNewRun)", () => {
    const plant = (id: string) => {
      const runDir = join(tmp, "runs", id);
      mkdirSync(join(runDir, "workspace"), { recursive: true });
      mkdirSync(join(runDir, "logs"));
      const run = { runId: id, flow: "plain", flowDef: PLAIN, task: "t", vars: {}, repo: tmp, status: "stopped", reason: "ran out of time in `a`; trying again (1 of 2)", runDir, workdir: join(runDir, "workspace"), startedAt: new Date().toISOString(), totalCostUsd: 0, history: [], state: { next: "a", steps: {} }, timeLimits: [{ at: "t", step: "a", attempt: 1, of: 2 }] };
      writeFileSync(join(runDir, "run.json"), JSON.stringify(run));
      return runDir;
    };
    const saved = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
    const capOf = (runs: number) => setCap("load", { runs, until: new Date(Date.now() + 60_000).toISOString(), why: "test" });

    it("waits for a helper's cap like a new run, while a plain resume goes on", async () => {
      const dir1 = plant("retry-1");
      const dir2 = plant("plain-1");
      capOf(0);
      try {
        concurrency = 2;
        mk({ capRecheckMs: 10 });
        s.submit({ kind: "resume", runId: "retry-1" }, { source: "r", asNewRun: true });
        s.submit({ kind: "resume", runId: "plain-1" }, { source: "p" });
        await waitFor(() => saved(dir2).status === "succeeded");
        expect(pending().map((p) => [p.runId, p.capped])).toEqual([["retry-1", true]]);
        expect(saved(dir1).status).toBe("stopped");
        setCap("load", undefined);
        await waitFor(() => saved(dir1).status === "succeeded");
        expect(saved(dir1).timeLimits[0].startedAt).toEqual(expect.any(String));
      } finally {
        setCap("load", undefined);
      }
    });

    it("is not a run of the day and survives a restart of the scheduler", () => {
      plant("retry-2");
      const queueFile = join(tmp, "queue.json");
      capOf(0);
      try {
        concurrency = 1;
        limits = { [A]: { maxRunsPerDay: 1 } };
        mk({ queueFile });
        s.submit({ kind: "resume", runId: "retry-2" }, { source: "r", owner: A, asNewRun: true });
        expect(pending()[0]).toMatchObject({ runId: "retry-2", capped: true });
        expect(pending()[0]).not.toHaveProperty("limit");
        expect(JSON.parse(readFileSync(queueFile, "utf8")).jobs?.[0] ?? JSON.parse(readFileSync(queueFile, "utf8"))[0]).toMatchObject({ asNewRun: true });
        mk({ queueFile });
        expect(pending()[0]).toMatchObject({ runId: "retry-2", capped: true });
      } finally {
        setCap("load", undefined);
      }
    });

    it("ends the run for good when it is cancelled while queued, and a restart does not queue it again", () => {
      const dir = plant("retry-3");
      const queueFile = join(tmp, "queue.json");
      capOf(0);
      try {
        concurrency = 2;
        mk({ queueFile });
        s.submit({ kind: "resume", runId: "retry-3" }, { source: "r", asNewRun: true });
        expect(s.cancel("retry-3")).toBe(true);
        expect(saved(dir)).toMatchObject({ status: "cancelled", reason: "cancelled by user while stopped" });
        expect(saved(dir).timeLimits[0].startedAt).toBeUndefined();
        mk({ queueFile });
        expect(pending()).toEqual([]);
      } finally {
        setCap("load", undefined);
      }
    });
  });

  it("a closed scheduler holds no timer and starts nothing when a cap ends", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      concurrency = 3;
      mk({ capRecheckMs: 1000 });
      const before = vi.getTimerCount();
      setCap("load", { runs: 0, until: new Date(Date.now() + 60_000).toISOString(), why: "test" });
      s.submit(job(), { source: "story-1", owner: A });
      expect(vi.getTimerCount()).toBe(before + 1);
      // the cap ends while jobs wait: the timer is not needed any more
      setCap("load", undefined);
      s.recheck();
      expect(vi.getTimerCount()).toBe(before);
      expect(active()).toEqual(["story-1"]);
      s.cancel(s.queue().active[0]!.runId);

      setCap("load", { runs: 0, until: new Date(Date.now() + 60_000).toISOString(), why: "test" });
      const held = s.submit(job(), { source: "story-2", owner: A });
      expect(vi.getTimerCount()).toBe(before + 1);
      s.close();
      expect(vi.getTimerCount()).toBe(before);
      setCap("load", undefined);
      vi.advanceTimersByTime(5000);
      s.recheck();
      expect(pending().map((p) => p.runId)).toEqual([held]);
      expect(active().includes("story-2")).toBe(false);
    } finally {
      setCap("load", undefined);
      vi.useRealTimers();
    }
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
