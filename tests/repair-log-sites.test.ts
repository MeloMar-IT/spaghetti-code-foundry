import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { recordStep, type Engine } from "../src/engine/execute.js";
import { parseFlow } from "../src/flow/load.js";
import { runAutoDemotions } from "../src/governance/auto-demote.js";
import type { Finding } from "../src/monitor/findings.js";
import { repairFile, repairsSince, resetRepairMemory } from "../src/monitor/repair-log.js";
import { ServiceSupervisor } from "../src/services/supervisor.js";

// Where repairs happen, with their surroundings faked: no child process, no server, no git.

const mocked = vi.hoisted(() => ({ children: [] as unknown[], refusal: undefined as string | undefined, demoteRefused: false }));

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: () => {
    const child = Object.assign(new EventEmitter(), { pid: 4000 + mocked.children.length, stdout: null, stderr: null });
    mocked.children.push(child);
    return child;
  },
}));
vi.mock("../src/steps/process.js", async (original) => ({
  ...(await original<typeof import("../src/steps/process.js")>()),
  holdLiveGroup: () => () => {},
  stopGroup: async () => {},
}));
vi.mock("../src/services/setup.js", async (original) => ({
  ...(await original<typeof import("../src/services/setup.js")>()),
  programProblem: () => (mocked.refusal ? { problem: mocked.refusal } : { realPath: "/bin/bot" }),
  serviceToken: () => ({ accountId: "a", token: "t" }),
  revokeServiceTokenSafe: () => {},
  reconcileServiceTokens: () => true,
  accountProblem: () => undefined,
  actsForState: () => undefined,
}));
vi.mock("../src/governance/autonomy-change.js", async (original) => {
  const real = await original<typeof import("../src/governance/autonomy-change.js")>();
  const { AutonomyError } = await import("../src/governance/autonomy-store.js");
  return {
    ...real,
    demoteLevel: (o: Parameters<typeof real.demoteLevel>[0]) => {
      if (mocked.demoteRefused) throw new AutonomyError("the reason is not valid");
      return real.demoteLevel(o);
    },
  };
});

let home: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repair-sites-"));
  process.env.FACTORY_HOME = home;
  Object.assign(mocked, { children: [], refusal: undefined, demoteRefused: false });
  resetRepairMemory();
});
afterEach(() => {
  vi.useRealTimers();
  process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const logged = () => repairsSince(0).map((e) => `${e.repair} ${e.result}: ${e.what}`);
/** A folder where the log file should be: nothing can be written. */
const breakLog = () => mkdirSync(repairFile());

describe("a managed service", () => {
  const make = () => new ServiceSupervisor({
    services: [{ name: "bot", command: "/bin/bot", args: [], env: {}, scope: [] }], home, runsDir: join(home, "runs"), url: "http://127.0.0.1:1",
    log: () => {}, checkScope: () => undefined, audit: () => {}, backoff: { firstMs: 100, maxMs: 100, stableMs: 10_000 }, graceMs: 0,
  });
  const exit = async (i: number) => {
    (mocked.children[i] as EventEmitter).emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(0);
  };

  it("logs a start after the program exited, not the first start", async () => {
    vi.useFakeTimers();
    const s = make();
    s.start();
    expect(logged()).toEqual([]);
    await exit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(logged()).toEqual(["start-service done: managed service bot started again after it stopped"]);
    await exit(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(logged()).toHaveLength(2);
  });

  it("logs each refused restart as failed, and the start that works later as done", async () => {
    vi.useFakeTimers();
    const s = make();
    s.start();
    await exit(0);
    mocked.refusal = "the program is gone";
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    mocked.refusal = undefined;
    await vi.advanceTimersByTimeAsync(100);
    expect(logged().map((l) => l.split(":")[0])).toEqual(["start-service failed", "start-service failed", "start-service done"]);
  });

  it("logs nothing for a first start that is refused, or a start because config.yaml changed", async () => {
    vi.useFakeTimers();
    mocked.refusal = "the program is gone";
    const s = make();
    s.start();
    expect(logged()).toEqual([]);
    mocked.refusal = undefined;
    await vi.advanceTimersByTimeAsync(100);
    await exit(0);
    const done = s.update([{ name: "bot", command: "/bin/bot", args: ["new"], env: {}, scope: [] }]);
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(mocked.children).toHaveLength(2);
    expect(logged()).toEqual([]);
  });

  it("starts again also when the log cannot be written", async () => {
    vi.useFakeTimers();
    breakLog();
    const s = make();
    s.start();
    await exit(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.view()[0]).toMatchObject({ state: "running", restarts: 1 });
  });
});

describe("a hotfix merge", () => {
  const record = (stepId: string, ok: boolean, output: string, hotfix: "on" | "off" = "on") => {
    const flow = parseFlow(`name: issue-gitflow\nsteps:\n  - { id: ${stepId}, type: shell, run: "echo" }\n`, "t.yaml");
    const summary = { runDir: home, history: [], totalCostUsd: 0, outputs: {}, flow: "issue-gitflow", runId: "r" } as never;
    const engine = { summary, config: ConfigSchema.parse({}), hotfix, log() {}, save() {} } as unknown as Engine;
    const scope = { flow, ctx: { vars: { github_repo: "acme/app", main_branch: "main", issue: "9" }, steps: {}, run: {} }, visits: {}, prefix: "", depth: 0 } as never;
    return recordStep(flow.steps[0]!, scope, engine, { ok, output }, new Date(), join(home, "l.log"), 1);
  };

  it("is logged when main was pushed, or when the merge could not land", () => {
    record("push_main", true, "MOVED");
    record("push_main", true, "PUSHED: main abc1234", "off");
    expect(logged()).toEqual([]);
    record("push_main", true, "PUSHED: main abc1234");
    record("red_main", false, "the tests fail");
    expect(logged()).toEqual(["hotfix-merge done: hotfix of #9 merged into main", "hotfix-merge failed: hotfix of #9 could not be merged into main (step red_main)"]);
  });

  it("keeps the step's result when the log cannot be written", () => {
    breakLog();
    expect(record("push_main", true, "PUSHED: main abc1234").ok).toBe(true);
  });
});

describe("a lowered autonomy level", () => {
  const marked = () => ({
    detector: "restart-loop", fingerprint: "fp|1", severity: "critical", summary: "s", evidence: { flows: ["f1"] }, about: "foundry",
    firstSeen: "2026-10-01T00:00:00Z", lastSeen: "2026-10-01T00:00:00Z", count: 1, gone: false, autoDemote: { at: "2026-10-01T00:00:00Z", left: ["flows:f1"] },
  }) as Finding;

  it("is logged as done", () => {
    expect(runAutoDemotions([marked()], () => {}).demoted).toHaveLength(1);
    expect(logged()).toEqual(["lower-autonomy done: autonomy of the flow f1 lowered from delivery-handoff to guarded-write (finding: restart-loop)"]);
  });

  it("is logged as failed when the demotion is refused", () => {
    mocked.demoteRefused = true;
    expect(runAutoDemotions([marked()], () => {}).problems).toEqual(["auto-demote: f1 not lowered (refused)"]);
    expect(logged()).toEqual(["lower-autonomy failed: autonomy of the flow f1 could not be lowered (finding: restart-loop)"]);
  });

  it("happens also when the log cannot be written", () => {
    breakLog();
    const r = runAutoDemotions([marked()], () => {});
    expect(r.demoted).toHaveLength(1);
    expect(r.problems).toEqual([]);
  });
});
