import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { spentThisMonth, spentThisMonthByWorkspace } from "../src/engine/state.js";
import { Scheduler, type Job, type SchedulerOptions } from "../src/queue/scheduler.js";
import { disposeWorkspaces, supplyWorkspaces } from "../src/workspaces/list.js";
import { nextStep } from "../src/next-step.js";
import { statusHelp, statusName } from "../src/words.js";
import { lockRoot } from "../src/engine/running.js";

// A team's step is held by the OS sandbox (#785): it cannot see the test's temp folder, but it can read its own workspace's lock folder.
// So a step waits for `<dir>/<run id>` (a default run) or `$SCF_LOCK_DIR/gates/<run id>` (a team's run); the test opens both.
const basic = process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
const TEAMS = ["team-a", "team-b"];
const waitForFile = (dir: string, file: string): string =>
  `i=0; while [ ! -e "${dir}/${file}" ] && [ ! -e "$SCF_LOCK_DIR/gates/${file}" ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done`;

/** A flow that works until the test creates the file `<dir>/<run id>`. */
const gateFlow = (dir: string) => parseFlow(`name: slow
workspace: empty
steps:
  - {id: a, type: shell, run: '${waitForFile(dir, "$FACTORY_RUN_ID")}'}
`);

type Lim = { max_concurrent?: number; test_slots?: number; monthly_budget_usd?: number };

describe.skipIf(!basic)("scheduler workspace limits (#819)", () => {
  let tmp: string;
  let concurrency = 0;
  let costLimits = true;
  let limits: Record<string, Lim> = {};
  let spend: Record<string, number> = {};
  let s: Scheduler | undefined;
  let GATE = gateFlow("");
  let installCap: number | undefined;
  const cfg = (): Config => ({ ...ConfigSchema.parse({ bot: { name: "Bot", email: "bot@example.com" }, limits: installCap === undefined ? {} : { monthly_budget_usd: installCap } }), concurrency, cost_limits: costLimits });
  const mk = (extra: Partial<SchedulerOptions> = {}) =>
    (s = new Scheduler({ runsDir: join(tmp, "runs"), config: cfg, workspaceLimits: (w) => limits[w] ?? {}, spentThisMonthByWorkspace: (w) => spend[w] ?? 0, ...extra }));
  const job = (flow = GATE): Job => ({ kind: "run", flow, task: "t", repo: tmp, vars: {} });
  const submit = (source: string, workspace: string, extra: Record<string, unknown> = {}) => s!.submit(job(), { source, workspace, ...extra });
  const active = () => s!.queue().active.map((a) => a.source);
  const pending = () => s!.queue().pending;
  const limitOfPending = (source: string) => pending().find((p) => p.source === source)?.limit;
  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(fn()).toBe(true);
  };
  const open = (runId: string) => {
    writeFileSync(join(tmp, "gates", runId), "");
    for (const w of TEAMS) {
      mkdirSync(join(lockRoot(w), "gates"), { recursive: true });
      writeFileSync(join(lockRoot(w), "gates", runId), "");
    }
  };
  const finish = async (source: string) => {
    const a = s!.queue().active.find((x) => x.source === source)!;
    open(a.runId);
    await waitFor(() => !s!.isActive(a.runId));
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-ws-"));
    mkdirSync(join(tmp, "runs"));
    mkdirSync(join(tmp, "gates"));
    GATE = gateFlow(join(tmp, "gates"));
    concurrency = 0;
    costLimits = true;
    limits = {};
    spend = {};
    installCap = undefined;
    // the workspaces the tests use are in the list; a workspace that is not in the list is read-only (#824)
    supplyWorkspaces({
      owner: "base", plugin: "base", report: () => undefined,
      store: { list: () => ["team-a", "team-b"].map((id) => ({ id, name: id, limits: {} })) },
    });
  });
  afterEach(async () => {
    disposeWorkspaces("base");
    if (s) {
      for (const p of s.queue().pending) s.cancel(p.runId);
      for (const a of s.queue().active) open(a.runId);
      await waitFor(() => s!.queue().active.length === 0);
      s.close();
    }
    s = undefined;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("max_concurrent holds a workspace's second job while another workspace starts; it starts when the first ends", async () => {
    concurrency = 3;
    limits = { "team-a": { max_concurrent: 1 } };
    mk();
    submit("a1", "team-a");
    submit("a2", "team-a");
    submit("b1", "team-b");
    expect(active()).toEqual(["a1", "b1"]);
    expect(limitOfPending("a2")).toBe("workspace");
    await finish("a1");
    await waitFor(() => active().includes("a2"));
  });

  it("an account limit inside a roomy workspace still holds first", () => {
    concurrency = 3;
    limits = { "team-a": { max_concurrent: 3 } };
    mk({ userLimits: () => ({ maxConcurrent: 1 }) });
    submit("a1", "team-a", { owner: "u1" });
    submit("a2", "team-a", { owner: "u1" });
    expect(active()).toEqual(["a1"]);
    expect(limitOfPending("a2")).toBe("concurrent");
  });

  it("monthly budget: held at the limit, free below it, free with cost_limits off, other workspaces unaffected", () => {
    concurrency = 6;
    limits = { "team-a": { monthly_budget_usd: 10 } };
    spend = { "team-a": 10 };
    mk();
    submit("a1", "team-a");
    submit("b1", "team-b");
    expect(active()).toEqual(["b1"]);
    expect(limitOfPending("a1")).toBe("workspace_budget");
    spend = { "team-a": 9.99 };
    s!.recheck();
    expect(active()).toContain("a1");
    submit("a2", "team-a");
    expect(active()).toContain("a2");

    costLimits = false;
    spend = { "team-a": 50 };
    submit("a3", "team-a");
    expect(active()).toContain("a3");
  });

  it("a resume of a run of the workspace is held by the budget", () => {
    concurrency = 3;
    limits = { "team-a": { monthly_budget_usd: 5 } };
    spend = { "team-a": 6 };
    const runDir = join(tmp, "runs", "old-run");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: "old-run", workspace: "team-a" }));
    mk();
    const id = s!.submit({ kind: "resume", runId: "old-run" }, { source: "res" });
    expect(s!.isQueued(id)).toBe(true);
    expect(limitOfPending("res")).toBe("workspace_budget");
  });

  it("a chore of the workspace waits for the budget and for max_concurrent (it counts as an active job of the workspace)", async () => {
    concurrency = 3;
    limits = { "team-a": { max_concurrent: 1, monthly_budget_usd: 5 } };
    spend = { "team-a": 6 };
    mk();
    submit("watcher rel schedule", "team-a", { lockKey: "x/y#chore:rel" });
    expect(active()).toEqual([]);
    expect(limitOfPending("watcher rel schedule")).toBe("workspace_budget");
    spend = {};
    s!.recheck();
    await waitFor(() => active().includes("watcher rel schedule"));
    await finish("watcher rel schedule");
    // a story fills the workspace's one place: a chore waits until it ends
    submit("a1", "team-a");
    submit("watcher rel schedule", "team-a", { lockKey: "x/y#chore:rel" });
    expect(active()).toEqual(["a1"]);
    // the story fills the workspace's one place: the chore waits until it ends
    expect(limitOfPending("watcher rel schedule")).toBe("workspace");
    await finish("a1");
    await waitFor(() => active().includes("watcher rel schedule"));
  });

  it("the monthly hold is looked at again without any event, so a new month lets the job start", async () => {
    concurrency = 3;
    limits = { "team-a": { monthly_budget_usd: 5 } };
    spend = { "team-a": 6 };
    mk({ monthRecheckMs: 20 });
    submit("a1", "team-a");
    expect(active()).toEqual([]);
    spend = {}; // the new month
    await waitFor(() => active().includes("a1"));
  });

  describe("the monthly budget of the whole install (#786)", () => {
    it("holds every pending job when the month's spend reaches the cap, and lets it start under the cap", async () => {
      concurrency = 3;
      installCap = 5;
      mk({ spentThisMonth: () => 5 });
      submit("a1", "default");
      expect(active()).toEqual([]);
      expect(limitOfPending("a1")).toBe("install_budget");
      s!.close();
      mk({ spentThisMonth: () => 4.99 });
      submit("a2", "default");
      await waitFor(() => active().includes("a2"));
    });

    it("does not hold with cost_limits false, without a cap, or in a local test", async () => {
      concurrency = 3;
      installCap = 5;
      costLimits = false;
      mk({ spentThisMonth: () => 99 });
      submit("a1", "default");
      await waitFor(() => active().includes("a1"));
      s!.close();
      costLimits = true;
      installCap = undefined;
      mk({ spentThisMonth: () => 99 });
      submit("a2", "default");
      await waitFor(() => active().includes("a2"));
      s!.close();
      installCap = 5;
      mk({ spentThisMonth: () => 99, localTest: true });
      submit("a3", "default");
      await waitFor(() => active().includes("a3"));
    });

    it("holds when the spend cannot be read (fail closed)", () => {
      concurrency = 3;
      installCap = 5;
      mk({ spentThisMonth: () => { throw new Error("unreadable"); } });
      submit("a1", "default");
      expect(active()).toEqual([]);
      expect(limitOfPending("a1")).toBe("install_budget");
    });

    it("holds a workspace job too, and looks again without any event", async () => {
      concurrency = 3;
      installCap = 5;
      let over = true;
      mk({ monthRecheckMs: 20, spentThisMonth: () => (over ? 6 : 0) });
      submit("a1", "team-a");
      expect(active()).toEqual([]);
      over = false; // the new month
      await waitFor(() => active().includes("a1"));
    });

    it("a workspace spend that cannot be read holds the job (fail closed)", () => {
      concurrency = 3;
      limits = { "team-a": { monthly_budget_usd: 5 } };
      mk({ spentThisMonthByWorkspace: () => { throw new Error("unreadable"); } });
      submit("a1", "team-a");
      expect(active()).toEqual([]);
      expect(limitOfPending("a1")).toBe("workspace_budget");
    });

    it("words: no amount, and different for admins and users", () => {
      expect(statusName("user_limit", { month: true, budget: true })).toBe("waiting — this month's budget");
      expect(statusName("user_limit", { month: true, budget: true, user: true })).toBe("waiting — the limit for this month is reached");
      for (const forUser of [true, false]) {
        const n = nextStep("user_limit", {}, { userLimit: "install_budget", forUser });
        expect(n.until).toBe("next month");
        expect(`${n.why} ${n.say} ${statusHelp("user_limit", { month: true, user: forUser })}`).not.toMatch(/[$\d]/);
      }
    });
  });

  it("close() stops the monthly timer", () => {
    concurrency = 3;
    limits = { "team-a": { monthly_budget_usd: 5 } };
    spend = { "team-a": 6 };
    vi.useFakeTimers();
    try {
      mk({ monthRecheckMs: 20 });
      submit("a1", "team-a");
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      s!.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("round robin between workspaces: a1 b1 a2 b2 a3", async () => {
    concurrency = 1;
    mk();
    for (const [n, w] of [["a1", "team-a"], ["a2", "team-a"], ["a3", "team-a"], ["b1", "team-b"], ["b2", "team-b"]] as const) submit(n, w);
    const order = [active()[0]!];
    for (const n of ["a1", "b1", "a2", "b2"]) {
      await finish(n);
      await waitFor(() => active().length === 1 && active()[0] !== n);
      order.push(active()[0]!);
    }
    expect(order).toEqual(["a1", "b1", "a2", "b2", "a3"]);
  });

  it("inside a workspace a priority job goes first, and only counts for its own workspace", () => {
    concurrency = 1;
    mk();
    submit("a1", "team-a");
    submit("a2", "team-a", { priority: true });
    submit("b1", "team-b");
    const q = pending();
    expect(q.find((p) => p.source === "b1")).not.toHaveProperty("behindPriority");
    expect(q.find((p) => p.source === "a2")).not.toHaveProperty("behindPriority");
  });

  it("the priority job of a workspace starts before the workspace's earlier job", async () => {
    concurrency = 1;
    mk();
    submit("x", "team-b"); // takes the slot
    submit("a1", "team-a");
    submit("a2", "team-a", { priority: true });
    await finish("x");
    await waitFor(() => active().length === 1 && active()[0] !== "x");
    expect(active()).toEqual(["a2"]);
  });

  it("with only the default workspace the hooks are never called and nothing is marked", () => {
    concurrency = 1;
    const wl = vi.fn(() => ({}));
    const sp = vi.fn(() => 0);
    mk({ workspaceLimits: wl, spentThisMonthByWorkspace: sp });
    submit("d1", "default");
    submit("d2", "default");
    expect(active()).toEqual(["d1"]);
    expect(pending().every((p) => !("limit" in p))).toBe(true);
    expect(wl).not.toHaveBeenCalled();
    expect(sp).not.toHaveBeenCalled();
  });

  it("evals (localTest) are never held by workspace limits", () => {
    concurrency = 3;
    limits = { "team-a": { max_concurrent: 1, monthly_budget_usd: 1 } };
    spend = { "team-a": 5 };
    mk({ localTest: true });
    submit("a1", "team-a");
    submit("a2", "team-a");
    expect(active()).toEqual(["a1", "a2"]);
  });

  it("reads the limits from the workspace list and gives a shell step the workspace and its test slots", async () => {
    concurrency = 3;
    mkdirSync(lockRoot("team-a"), { recursive: true });
    const out = join(lockRoot("team-a"), "env.txt");
    disposeWorkspaces("base");
    supplyWorkspaces({
      owner: "t", plugin: "t", report: () => undefined,
      store: { list: () => [{ id: "team-a", name: "A", limits: { max_concurrent: 1, test_slots: 2 } }] },
    });
    try {
      s = new Scheduler({ runsDir: join(tmp, "runs"), config: cfg });
      // (the env.txt is written in the workspace's lock folder, which the held step can write)
      const envFlow = parseFlow(`name: env
workspace: empty
steps:
  - {id: a, type: shell, run: 'echo "$FACTORY_WORKSPACE $FACTORY_WORKSPACE_TEST_SLOTS" > "$SCF_LOCK_DIR/env.txt";${waitForFile(join(tmp, "gates"), "$FACTORY_RUN_ID")}'}
`);
      s.submit(job(envFlow), { source: "a1", workspace: "team-a" });
      s.submit(job(), { source: "a2", workspace: "team-a" });
      expect(pending().find((p) => p.source === "a2")?.limit).toBe("workspace");
      await waitFor(() => {
        try {
          return readFileSync(out, "utf8").trim() === "team-a 2";
        } catch {
          return false;
        }
      });
    } finally {
      disposeWorkspaces("t");
    }
  });
});

describe("spentThisMonthByWorkspace", () => {
  let base: string;
  let runs: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "factory-month-"));
    runs = join(base, "runs");
    mkdirSync(runs);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const put = (id: string, o: Record<string, unknown>) => {
    mkdirSync(join(runs, id), { recursive: true });
    writeFileSync(join(runs, id, "run.json"), JSON.stringify({ runId: id, ...o }));
  };
  const now = new Date("2026-11-15T12:00:00Z");

  it("sums this UTC month of one workspace; no field means default; skips bad costs and files", () => {
    put("20261101-000000-aaaa", { workspace: "team-a", startedAt: "2026-11-01T00:00:00Z", totalCostUsd: 1.5 });
    put("20261031-235900-bbbb", { workspace: "team-a", startedAt: "2026-10-31T23:59:00Z", totalCostUsd: 100 });
    put("20261110-000000-cccc", { workspace: "team-a", startedAt: "2026-11-10T00:00:00Z", totalCostUsd: Number.NaN });
    put("20261111-000000-dddd", { startedAt: "2026-11-11T00:00:00Z", totalCostUsd: 2 });
    put("20261112-000000-eeee", { workspace: "team-b", startedAt: "2026-11-12T00:00:00Z", totalCostUsd: 4 });
    expect(spentThisMonthByWorkspace(runs, "team-a", now)).toBe(1.5);
    expect(spentThisMonthByWorkspace(runs, "default", now)).toBe(2);
    expect(spentThisMonthByWorkspace(runs, "team-b", now)).toBe(4);
    expect(spentThisMonth(runs, now)).toBe(7.5);
  });

  it("throws when a run file cannot be read (the callers hold work)", () => {
    mkdirSync(join(runs, "20261113-000000-ffff"));
    writeFileSync(join(runs, "20261113-000000-ffff", "run.json"), "{ not json");
    expect(() => spentThisMonthByWorkspace(runs, "team-a", now)).toThrow();
    expect(() => spentThisMonth(runs, now)).toThrow();
  });

  it("counts runs kept in a workspace folder", () => {
    const wsRuns = join(base, "workspaces", "team-a", "runs");
    mkdirSync(join(wsRuns, "20261105-000000-wsrun"), { recursive: true });
    writeFileSync(join(wsRuns, "20261105-000000-wsrun", "run.json"), JSON.stringify({ runId: "20261105-000000-wsrun", workspace: "team-a", startedAt: "2026-11-05T00:00:00Z", totalCostUsd: 3 }));
    put("20261101-000000-aaaa", { workspace: "team-a", startedAt: "2026-11-01T00:00:00Z", totalCostUsd: 1 });
    expect(spentThisMonthByWorkspace(runs, "team-a", now)).toBe(4);
    expect(spentThisMonth(runs, now)).toBe(4);
  });

  it("throws when the workspace folders cannot be listed, and not for an absent folder", () => {
    expect(spentThisMonth(runs, now)).toBe(0); // no workspaces folder: nothing to count
    const container = join(base, "workspaces");
    mkdirSync(join(container, "team-a"), { recursive: true });
    expect(spentThisMonth(runs, now)).toBe(0); // a workspace without runs is unused
    if (process.getuid?.() === 0) return; // root can read everything
    chmodSync(container, 0o000);
    try {
      expect(() => spentThisMonth(runs, now)).toThrow();
    } finally {
      chmodSync(container, 0o755);
    }
  });

  it("throws when a workspace's runs folder cannot be listed", () => {
    if (process.getuid?.() === 0) return;
    const wsRuns = join(base, "workspaces", "team-a", "runs");
    mkdirSync(wsRuns, { recursive: true });
    chmodSync(wsRuns, 0o000);
    try {
      expect(() => spentThisMonthByWorkspace(runs, "default", now)).toThrow();
    } finally {
      chmodSync(wsRuns, 0o755);
    }
  });

  it("counts a run with an old id that started this month (ids are made at queue time)", () => {
    put("20261001-000000-old0", { workspace: "team-a", startedAt: "2026-11-05T00:00:00Z", totalCostUsd: 3 });
    put("20261020-000000-new0", { workspace: "team-a", startedAt: "2026-10-20T00:00:00Z", totalCostUsd: 9 });
    put("20261112-000000-new1", { workspace: "team-a", startedAt: "2026-11-12T00:00:00Z", totalCostUsd: 1 });
    expect(spentThisMonthByWorkspace(runs, "team-a", now)).toBe(4);
  });

  it("reads a changed file again", () => {
    put("20261101-000000-aaaa", { workspace: "team-a", startedAt: "2026-11-01T00:00:00Z", totalCostUsd: 1 });
    expect(spentThisMonthByWorkspace(runs, "team-a", now)).toBe(1);
    put("20261101-000000-aaaa", { workspace: "team-a", startedAt: "2026-11-01T00:00:00Z", totalCostUsd: 12.5 });
    expect(spentThisMonthByWorkspace(runs, "team-a", now)).toBe(12.5);
  });
});

describe("workspace limit texts", () => {
  it("next-step names the month and the workspace", () => {
    const b = nextStep("user_limit", {}, { userLimit: "workspace_budget" });
    expect(b.until).toBe("next month");
    expect(b.why).toBe("The workspace's budget for this month is used up");
    expect(nextStep("user_limit", {}, { userLimit: "workspace_budget", forUser: true }).why).toBe("Your workspace's limit for this month is reached");
    expect(nextStep("user_limit", {}, { userLimit: "workspace" }).why).toBe("The workspace's limit of runs at the same time is reached");
    expect(nextStep("user_limit", {}, { userLimit: "workspace", forUser: true }).why).toBe("Your workspace's limit of runs at the same time is reached");
  });

  it("status words", () => {
    expect(statusName("user_limit", { workspace: true, budget: true, user: true })).toBe("waiting — your workspace's limit for this month is reached");
    expect(statusName("user_limit", { workspace: true, user: true })).toBe("waiting — your workspace's limit of runs at the same time is reached");
    expect(statusName("user_limit", { workspace: true, budget: true })).toBe("waiting — the workspace's monthly budget");
    expect(statusName("user_limit", { workspace: true })).toBe("waiting — the workspace's limit of runs at the same time");
    for (const f of [{ workspace: true }, { workspace: true, budget: true }, { workspace: true, user: true }, { workspace: true, budget: true, user: true }]) {
      expect(statusHelp("user_limit", f).split(/(?<=\.) /)).toHaveLength(2);
    }
  });
});
