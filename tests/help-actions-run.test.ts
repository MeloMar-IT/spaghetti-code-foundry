import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRun } from "../src/engine/state.js";
import { getConversation, deleteConversation } from "../src/help/store.js";
import type { ActionDeps } from "../src/server/help-actions.js";
import { confirmAction, prepareAction } from "../src/server/help-actions.js";
import { SLOW, STOPS, makeEnv, makeUsers, plantConversation, plantRun, waitFor, type Env, type Users } from "./helpers/help-actions.js";

// The notification of a finished run can be held back for one test: the run stays active in its finish window.
const hold = vi.hoisted(() => ({ promise: undefined as Promise<void> | undefined, release: undefined as undefined | (() => void) }));
vi.mock("../src/notify.js", async (orig) => {
  const m = await orig<typeof import("../src/notify.js")>();
  return { ...m, notifyRun: (...a: Parameters<typeof m.notifyRun>) => hold.promise ?? m.notifyRun(...a) };
});

let saved: string | undefined;
let home: string;
let users: Users;
let env: Env;

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "help-actions-run-home-"));
  process.env.FACTORY_HOME = home;
  users = await makeUsers();
});
afterAll(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});
afterEach(async () => {
  hold.release?.();
  hold.promise = undefined;
  vi.restoreAllMocks();
  // jobs that wait in a full queue would never end; runs that work are cancelled
  for (const p of env.scheduler.queue().pending) env.scheduler.cancel(p.runId);
  for (const a of env.scheduler.queue().active) env.scheduler.cancel(a.runId);
  await env.scheduler.idle();
  env.close();
});

let n = 0;
const MS = 4321;

/** Counts subscriptions and read-back timers, so a test can show that every one was released. */
function watch(ms = MS) {
  const subs = { made: 0, released: 0 };
  const real = env.scheduler.subscribe.bind(env.scheduler);
  vi.spyOn(env.scheduler, "subscribe").mockImplementation((id, fn) => {
    subs.made++;
    const off = real(id, fn);
    return () => {
      subs.released++;
      off();
    };
  });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const cleared = new Set<unknown>();
  const st = globalThis.setTimeout;
  const ct = globalThis.clearTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay?: number, ...a: unknown[]) => {
    const t = st(fn, delay, ...a);
    if (delay === ms) timers.push(t);
    return t;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((t: ReturnType<typeof setTimeout>) => {
    cleared.add(t);
    return ct(t);
  }) as typeof clearTimeout);
  return {
    check(runId: string) {
      expect(subs).toEqual({ made: 1, released: 1 });
      expect(timers.every((t) => cleared.has(t))).toBe(true);
      expect(timers.every((t) => !t.hasRef())).toBe(true);
      expect((env.scheduler as unknown as { pendingListeners: Map<string, unknown> }).pendingListeners.has(runId)).toBe(false);
    },
    timers,
  };
}

const owner = () => env.admin;
/** A run of the admin on disk, with a reply that proposes `action` for it. */
function setup(action: "resume-run" | "cancel-run", o: Parameters<typeof plantRun>[2], runId = `run-${++n}`) {
  plantRun(env, runId, { owner: owner().id, ...o });
  return { runId, ...plantConversation(owner().id, runId, action) };
}
const go = async (s: { conversation: string; message: string }, deps: ActionDeps = env.deps({ readBackMs: MS })) => {
  const { token } = prepareAction(env.ctx, owner(), s.conversation, { message: s.message, index: 0 }, deps);
  return confirmAction(env.ctx, owner(), s.conversation, async () => ({ token, message: s.message, index: 0 }), deps);
};
/** A run that is working: resumed through the scheduler. */
async function working(flow: typeof SLOW, status: "stopped" | "failed" = "stopped") {
  const runId = `run-${++n}`;
  plantRun(env, runId, { owner: owner().id, status, flowDef: flow });
  env.scheduler.submit({ kind: "resume", runId }, { source: "test", queuedBy: owner().id });
  await waitFor(() => env.scheduler.isActive(runId));
  return { runId, ...plantConversation(owner().id, runId, "cancel-run") };
}

describe("resuming", () => {
  beforeEach(() => {
    env = makeEnv(users, {}, { concurrency: 1 });
  });

  it("reads the resume back from the run: done", async () => {
    const s = setup("resume-run", { status: "failed" });
    const w = watch();
    const r = await go(s);
    expect(r.stored).toBe(true);
    expect(r.outcome).toMatchObject({ action: "resume-run", result: "done", about: { kind: "run", id: s.runId }, words: "The run was resumed. The server read it back: it goes on from where it stopped." });
    expect(loadRun(env.runsDir, s.runId)!.resumes).toBe(1);
    expect(getConversation(owner().id, s.conversation).messages[1]!.outcomes).toEqual([r.outcome]);
    expect(env.audit.map((a) => a.e)).toEqual([{ action: "help-action", result: "ok", target: `conversation ${s.conversation}`, detail: `resume-run; run ${s.runId}; done` }]);
    w.check(s.runId);
  });

  it("an older run that cannot resume is start-failed, and its resumes did not grow", async () => {
    const s = setup("resume-run", { status: "failed", flowDef: null });
    const w = watch();
    const r = await go(s);
    expect(r.outcome).toMatchObject({ result: "start-failed", seen: "failed", words: "The run could not be started again. It is still as it was." });
    expect(loadRun(env.runsDir, s.runId)!.resumes).toBeUndefined();
    w.check(s.runId);
  });

  it("a rejected wait is a 200 with the conservative outcome", async () => {
    const s = setup("resume-run", { status: "failed", flowDef: null });
    vi.spyOn(env.scheduler, "wait").mockRejectedValue(new Error("boom"));
    const w = watch();
    const r = await go(s);
    expect(r.outcome.result).toBe("unconfirmed");
    expect(r.stored).toBe(true);
    w.check(s.runId);
  });

  it("a run that is deleted after the action is missing", async () => {
    const s = setup("resume-run", { status: "failed", flowDef: null });
    const real = env.scheduler.wait.bind(env.scheduler);
    vi.spyOn(env.scheduler, "wait").mockImplementation(async (id) => {
      const out = await real(id);
      rmSync(join(env.runsDir, id), { recursive: true, force: true });
      return out;
    });
    const w = watch();
    const r = await go(s);
    expect(r.outcome).toMatchObject({ result: "missing", seen: "missing", words: "The run is gone. Ask SCF cannot confirm what the action did." });
    w.check(s.runId);
  });

  it("a conversation deleted after the token was taken: the outcome is right, stored is false", async () => {
    env.setConfig({}, { concurrency: 0 });
    const s = setup("resume-run", { status: "failed" });
    const real = env.scheduler.submit.bind(env.scheduler);
    vi.spyOn(env.scheduler, "submit").mockImplementation((...a) => {
      deleteConversation(owner().id, s.conversation);
      return real(...a);
    });
    const r = await go(s);
    expect(r).toMatchObject({ stored: false, outcome: { result: "queued" } });
    expect(env.audit).toHaveLength(1);
  });

  it("an audit write that fails: stored is false", async () => {
    const s = setup("resume-run", { status: "failed" });
    const r = await go(s, env.deps({ readBackMs: MS, audit: () => { throw new Error("disk"); } }));
    expect(r).toMatchObject({ stored: false, outcome: { result: "done" } });
    expect(env.logs.join("\n")).toContain("audit.jsonl not written");
  });
});

describe("resuming into a full queue", () => {
  beforeEach(() => {
    env = makeEnv(users, {}, { concurrency: 0 });
  });

  it("queued: the job waits", async () => {
    const s = setup("resume-run", { status: "stopped" });
    const w = watch();
    const r = await go(s);
    expect(r.outcome).toMatchObject({ result: "queued", seen: "stopped", words: "The resume waits in the queue. The run starts when a slot is free." });
    expect(env.scheduler.isQueued(s.runId)).toBe(true);
    w.check(s.runId);
  });

  it("a queue write that fails after the job was queued is still a 200 queued", async () => {
    const s = setup("resume-run", { status: "stopped" });
    const persist = vi.spyOn(env.scheduler as unknown as { persist(): void }, "persist").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    const w = watch();
    const r = await go(s);
    expect(persist).toHaveBeenCalled();
    expect(r.outcome.result).toBe("queued");
    expect(env.logs.join("\n")).toContain("did not end cleanly");
    w.check(s.runId);
  });

  it("cancel of a queued job: dequeued", async () => {
    const s = setup("cancel-run", { status: "stopped" });
    env.scheduler.submit({ kind: "resume", runId: s.runId }, { source: "x", queuedBy: owner().id });
    const w = watch();
    const r = await go(s);
    expect(r.outcome).toMatchObject({ result: "dequeued", seen: "stopped", words: "The job that waited in the queue was taken out. The run is now stopped." });
    expect(env.scheduler.isQueued(s.runId)).toBe(false);
    w.check(s.runId);
  });

  it("cancel of a run that waits or is stopped: done", async () => {
    const s = setup("cancel-run", { status: "stopped" });
    const r = await go(s);
    expect(r.outcome).toMatchObject({ result: "done", seen: "cancelled" });
  });
});

describe("cancelling a working run", () => {
  beforeEach(() => {
    env = makeEnv(users, {}, { concurrency: 1 });
  });

  it("stopped: the run ended as cancelled", async () => {
    const s = await working(SLOW);
    const w = watch();
    const r = await go(s);
    expect(r.outcome).toMatchObject({ result: "stopped", seen: "cancelled", words: "The run was stopped and is marked as cancelled." });
    w.check(s.runId);
  });

  it("stopping: it had not ended when the server looked", async () => {
    const s = await working(SLOW);
    // the stop is asked for but does not take effect in time
    const cancel = vi.spyOn(env.scheduler, "cancel").mockReturnValue(true);
    const w = watch(50);
    const r = await go(s, env.deps({ readBackMs: 50 }));
    expect(r.outcome).toMatchObject({ result: "stopping", seen: "running", words: "The run is being stopped. It had not ended yet when Ask SCF looked." });
    expect(w.timers.length).toBeGreaterThan(0);
    w.check(s.runId);
    cancel.mockRestore();
    env.scheduler.cancel(s.runId);
  });

  it("a run whose notification is held ends as not-done when it succeeded on its own", async () => {
    hold.promise = new Promise<void>((r) => (hold.release = r));
    const runId = `run-${++n}`;
    plantRun(env, runId, { owner: owner().id, status: "stopped" });
    env.scheduler.submit({ kind: "resume", runId }, { source: "test", queuedBy: owner().id });
    await waitFor(() => loadRun(env.runsDir, runId)?.status === "succeeded" && env.scheduler.isActive(runId));
    const s = { runId, ...plantConversation(owner().id, runId, "cancel-run") };
    const cancel = vi.spyOn(env.scheduler, "cancel");
    const w = watch();
    const p = go(s);
    await waitFor(() => cancel.mock.calls.length > 0);
    hold.release!();
    const r = await p;
    expect(r.outcome).toMatchObject({ result: "not-done", seen: "succeeded", words: "The run ended on its own as succeeded before the stop took effect." });
    w.check(runId);
  });

  it("a stopped run that is still finishing is cancelled, and reads back as stopped, not stopping", async () => {
    hold.promise = new Promise<void>((r) => (hold.release = r)); // released in afterEach
    const runId = `run-${++n}`;
    plantRun(env, runId, { owner: owner().id, status: "failed", flowDef: STOPS });
    env.scheduler.submit({ kind: "resume", runId }, { source: "test", queuedBy: owner().id });
    await waitFor(() => loadRun(env.runsDir, runId)?.status === "stopped" && env.scheduler.isActive(runId));
    const s = { runId, ...plantConversation(owner().id, runId, "cancel-run") };
    const w = watch(50);
    const r = await go(s, env.deps({ readBackMs: 50 }));
    expect(env.scheduler.isActive(runId)).toBe(true);
    expect(r.outcome).toMatchObject({ result: "stopped", seen: "cancelled" });
    w.check(runId);
  });
});
