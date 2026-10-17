import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setStatus, updateUser } from "../src/auth/users.js";
import { saveAnswer } from "../src/engine/runner.js";
import { loadRun, saveRun } from "../src/engine/state.js";
import { HelpError, deleteConversation } from "../src/help/store.js";
import { HttpError } from "../src/server/http.js";
import { CLOSED_MESSAGE } from "../src/run-gate.js";
import { ActionRefused, confirmAction, prepareAction, cancelAction, stateVersion, WHO, type ActionDeps } from "../src/server/help-actions.js";
import { makeEnv, makeUsers, plantConversation, plantRun, runFileOf, waitFor, type Env, type Users } from "./helpers/help-actions.js";

// getConversation can be made to fail for one test (the store refusal during the re-check)
const hooks = vi.hoisted(() => ({ failGet: undefined as undefined | (() => never) }));
vi.mock("../src/help/store.js", async (orig) => {
  const m = await orig<typeof import("../src/help/store.js")>();
  return { ...m, getConversation: (...a: Parameters<typeof m.getConversation>) => (hooks.failGet ? hooks.failGet() : m.getConversation(...a)) };
});

let saved: string | undefined;
let home: string;
let users: Users;
let env: Env;

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "help-actions-home-"));
  process.env.FACTORY_HOME = home;
  users = await makeUsers();
});
afterAll(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  env = makeEnv(users, {}, { concurrency: 0 });
});
afterEach(async () => {
  hooks.failGet = undefined;
  vi.restoreAllMocks();
  env.close();
  await setStatus(users.ann.id, "active").catch(() => undefined);
  await updateUser(users.admin2.id, { role: "admin" }).catch(() => undefined);
});

let n = 0;
const rid = () => `r-${++n}`;

/** A stopped run of Ann with a reply that proposes `action` for it. */
function setup(action: "resume-run" | "cancel-run" = "resume-run", owner = users.ann.id) {
  const runId = rid();
  plantRun(env, runId, { status: "stopped", owner });
  const conv = plantConversation(owner, runId, action);
  return { runId, ...conv };
}
const asUser = (id: string) => [users.admin, users.admin2, users.ann, users.bob].find((u) => u.id === id)!;
const prep = (s: { conversation: string; message: string }, who = users.ann, index = 0, deps: ActionDeps = env.deps()) => prepareAction(env.ctx, who, s.conversation, { message: s.message, index }, deps);
const confirm = (token: string, s: { conversation: string; message: string }, who = users.ann, over: Record<string, unknown> = {}, deps: ActionDeps = env.deps()) => {
  const { conversation, ...body } = over;
  return confirmAction(env.ctx, who, (conversation as string | undefined) ?? s.conversation, async () => ({ token, message: s.message, index: 0, ...body }), deps);
};
const refusal = async <T,>(p: T | Promise<T>): Promise<ActionRefused> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ActionRefused) return e;
    throw e;
  }
  throw new Error("was not refused");
};
const lines = () => env.audit.map((a) => a.e);

describe("the preview", () => {
  it("describes the action in fixed words and changes nothing", () => {
    const s = setup("resume-run");
    const before = readFileSync(runFileOf(env, s.runId), "utf8");
    const version = stateVersion(env.scheduler, s.runId);
    const p = prep(s);
    expect(p.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.expiresAt).toBe(new Date(env.clock.t + 300_000).toISOString());
    expect(p.preview).toEqual({
      action: "resume-run",
      title: "Resume the run",
      about: { kind: "run", id: s.runId },
      now: `The run ${s.runId} stopped and waits for you. It would go on at step "a".`,
      changes: 'The run is put in the queue and goes on from step "a" when a slot is free.',
      impact: "The run goes on from the step where it stopped. It can be stopped again later.",
      impactLevel: "reversible",
      undo: "You can cancel the run on its page.",
      undoable: true,
      who: "Only the owner of the run. An administrator too can do this only for their own runs.",
    });
    expect(p.preview.who).toBe(WHO);
    expect(readFileSync(runFileOf(env, s.runId), "utf8")).toBe(before);
    expect(env.scheduler.queue().pending).toEqual([]);
    expect(stateVersion(env.scheduler, s.runId)).toBe(version);
    expect(env.grants.size).toBe(1);
  });

  it("says what a cancel does, for a run in the queue and for one that waits", () => {
    const s = setup("cancel-run");
    expect(prep(s).preview).toMatchObject({ changes: "The run is marked as cancelled.", impactLevel: "high", undoable: false, undo: "Ask SCF cannot undo this. A cancelled run can be resumed on its page later." });
    env.scheduler.submit({ kind: "resume", runId: s.runId }, { source: "x", queuedBy: users.ann.id });
    const q = prep(s).preview;
    expect(q.changes).toBe("The job that waits in the queue is taken out.");
    expect(q.now).toContain("It is in the queue.");
  });

  it("is refused: switches, other accounts, bad input, runs that do not fit; a run without a flow still gets one", async () => {
    const s = setup("resume-run");
    for (const [help, status] of [[{ enabled: false }, 503], [{ paused: true }, 503], [{ actions: false }, 503]] as const) {
      env.setConfig(help, { concurrency: 0 });
      let r: ActionRefused | undefined;
      try {
        prep(s);
      } catch (e) {
        r = e as ActionRefused;
      }
      expect(r?.status, JSON.stringify(help)).toBe(status);
    }
    env.setConfig({}, { concurrency: 0 });
    const code = (fn: () => unknown): [number, string] | undefined => {
      try {
        fn();
      } catch (e) {
        return [(e as ActionRefused).status, (e as ActionRefused).code];
      }
    };
    expect(code(() => prep(s, users.bob))).toEqual([404, "not-found"]);
    expect(code(() => prep(s, users.ann, 1))).toEqual([404, "not-found"]);
    expect(code(() => prepareAction(env.ctx, users.ann, s.conversation, { message: s.message, index: 0, extra: 1 }, env.deps()))).toEqual([400, "bad-request"]);
    expect(code(() => prepareAction(env.ctx, users.ann, s.conversation, { message: "x", index: 0 }, env.deps()))).toEqual([400, "bad-request"]);
    // a run of another account: also for an admin
    const foreign = setup("cancel-run", users.admin.id);
    plantRun(env, "foreign-run", { status: "stopped", owner: users.bob.id });
    const mine = plantConversation(users.admin.id, "foreign-run", "cancel-run");
    expect(code(() => prep(mine, users.admin))).toEqual([404, "not-owner"]);
    expect(code(() => prep(foreign, users.admin))).toBeUndefined();
    // a run that does not fit
    const done = rid();
    plantRun(env, done, { status: "succeeded", owner: users.ann.id });
    expect(code(() => prep({ ...plantConversation(users.ann.id, done, "resume-run") }))).toEqual([409, "not-applies"]);
    const dead = rid();
    plantRun(env, dead, { status: "stopped", owner: users.ann.id });
    const c = plantConversation(users.ann.id, dead, "resume-run");
    deleteConversation(users.ann.id, c.conversation);
    expect(code(() => prep(c))).toEqual([410, "deleted"]);
    // an older run without its flow does get a preview: the runner refuses it later
    const old = rid();
    plantRun(env, old, { status: "failed", owner: users.ann.id, flowDef: null });
    expect(prep(plantConversation(users.ann.id, old, "resume-run")).preview.action).toBe("resume-run");
  });
});

describe("cancelling a preview", () => {
  it("drops the token; a later confirm gets 409", async () => {
    const s = setup("cancel-run");
    const { token } = prep(s);
    expect(cancelAction(env.ctx, users.bob, s.conversation, { token }, env.deps())).toEqual({ cancelled: false });
    expect(cancelAction(env.ctx, users.ann, s.conversation, { token }, env.deps())).toEqual({ cancelled: true });
    expect(cancelAction(env.ctx, users.ann, s.conversation, { token }, env.deps())).toEqual({ cancelled: false });
    expect((await refusal(confirm(token, s))).status).toBe(409);
    expect(() => cancelAction(env.ctx, users.ann, s.conversation, {}, env.deps())).toThrow(ActionRefused);
  });
});

describe("tampering", () => {
  it("another index, conversation, account or a made-up token is a 409 that burns the token", async () => {
    const s = setup("cancel-run");
    const other = plantConversation(users.ann.id, s.runId, "cancel-run");
    const cases: [string, (t: string) => Promise<unknown>][] = [
      ["index", (t) => confirm(t, s, users.ann, { index: 1 })],
      ["conversation", (t) => confirm(t, s, users.ann, { conversation: other.conversation })],
      ["message", (t) => confirm(t, s, users.ann, { message: other.message })],
      ["account", (t) => confirm(t, s, users.bob)],
    ];
    for (const [name, attempt] of cases) {
      const { token } = prep(s);
      const r = await refusal(attempt(token));
      expect(r.status, name).toBe(409);
      expect((await refusal(confirm(token, s))).status, `${name}: the right confirm after`).toBe(409);
    }
    expect((await refusal(confirm("A".repeat(43), s))).status).toBe(409);
    expect((await refusal(confirm("short", s))).status).toBe(400);
    expect(env.scheduler.isActive(s.runId)).toBe(false);
  });
});

describe("replay, concurrency and expiry", () => {
  it("a token works once", async () => {
    const s = setup("cancel-run");
    const { token } = prep(s);
    const ok = await confirm(token, s);
    expect(ok.outcome).toMatchObject({ action: "cancel-run", result: "done", seen: "cancelled" });
    expect((await refusal(confirm(token, s))).status).toBe(409);
  });

  it("two confirms at once submit exactly once", async () => {
    const s = setup("resume-run");
    const { token } = prep(s);
    const submit = vi.spyOn(env.scheduler, "submit");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const deps = env.deps({ gate: async () => (await held, { ok: true }) });
    const a = confirm(token, s, users.ann, {}, deps).then((v) => ({ v }), (e) => ({ e }));
    const b = confirm(token, s, users.ann, {}, deps).then((v) => ({ v }), (e) => ({ e }));
    release();
    const results = await Promise.all([a, b]);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => "v" in r)).toHaveLength(1);
    const refused = results.find((r) => "e" in r) as { e: ActionRefused };
    expect(refused.e.status).toBe(409);
  });

  it("an expired token is a 409", async () => {
    const s = setup("cancel-run");
    const { token } = prep(s);
    env.clock.t += 300_001;
    expect((await refusal(confirm(token, s))).status).toBe(409);
  });
});

describe("evidence that went stale", () => {
  it("a saved answer, a history record, a job queued by another click", async () => {
    const answer = setup("resume-run");
    const t1 = prep(answer).token;
    saveAnswer(env.runsDir, answer.runId, "hello", users.ann.id);
    const submit = vi.spyOn(env.scheduler, "submit");
    expect((await refusal(confirm(t1, answer))).code).toBe("stale");

    const hist = setup("resume-run");
    const t2 = prep(hist).token;
    const run = loadRun(env.runsDir, hist.runId)!;
    saveRun({ ...run, history: [{ id: "a", type: "shell", ok: true, visit: 1, logFile: join(run.runDir, "x.log") } as never] });
    expect((await refusal(confirm(t2, hist))).code).toBe("stale");

    const click = setup("resume-run");
    const t3 = prep(click).token;
    env.scheduler.submit({ kind: "resume", runId: click.runId }, { source: "ui resume", queuedBy: users.ann.id });
    submit.mockClear();
    expect((await refusal(confirm(t3, click))).code).toBe("stale");
    expect(submit).not.toHaveBeenCalled();
    expect(lines().filter((l) => l.result === "failed")).toHaveLength(3);
  });

  it("a job taken out and queued again counts as a change, also when concurrency stays full", async () => {
    const s = setup("cancel-run");
    env.scheduler.submit({ kind: "resume", runId: s.runId }, { source: "ui resume", queuedBy: users.ann.id });
    const first = env.scheduler.queuedJob(s.runId)!;
    const { token } = prep(s);
    expect(env.scheduler.cancel(s.runId)).toBe(true);
    // let the clock move past the time the first job was queued, then queue it again with every other field the same
    await waitFor(() => new Date().toISOString() > first.enqueuedAt);
    env.scheduler.submit({ kind: "resume", runId: s.runId }, { source: "ui resume", queuedBy: users.ann.id });
    const cancel = vi.spyOn(env.scheduler, "cancel");
    const r = await refusal(confirm(token, s));
    expect(r.code).toBe("stale");
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("changes while the gate waits", () => {
  /** Previews a resume, holds the gate, runs `change`, releases the gate and returns what the confirm ended as. */
  async function underGate(change: (s: ReturnType<typeof setup>) => Promise<void> | void, who = users.ann) {
    const s = setup("resume-run", who.id);
    const { token } = prep(s, who);
    const submit = vi.spyOn(env.scheduler, "submit");
    let release!: () => void;
    let called = false;
    const deps = env.deps({
      gate: () => {
        called = true;
        return new Promise((r) => (release = () => r({ ok: true })));
      },
    });
    const p = refusal(confirm(token, s, who, {}, deps));
    await waitFor(() => called);
    await change(s);
    release();
    const r = await p;
    expect(submit).not.toHaveBeenCalled();
    expect(env.grants.peek(token)).toBeUndefined();
    return { r, s };
  }

  it("the account is blocked", async () => {
    expect((await underGate(() => void setStatus(users.ann.id, "blocked"))).r.status).toBe(403);
  });
  it("the account is added to disabled_accounts", async () => {
    expect((await underGate(() => env.setConfig({ disabled_accounts: [users.ann.id] }, { concurrency: 0 }))).r.status).toBe(403);
  });
  it("the role is lowered while the audience is administrators", async () => {
    const r = await underGate(async () => {
      env.setConfig({ audience: "admins" }, { concurrency: 0 });
      await updateUser(users.admin2.id, { role: "user" });
    }, users.admin2);
    expect(r.r.status).toBe(403);
  });
  it("help.actions is turned off", async () => {
    expect((await underGate(() => env.setConfig({ actions: false }, { concurrency: 0 }))).r.status).toBe(503);
  });
  it("the conversation is deleted", async () => {
    const { r, s } = await underGate((x) => void deleteConversation(users.ann.id, x.conversation));
    expect([r.status, r.code]).toEqual([410, "deleted"]);
    expect(lines()).toEqual([{ action: "help-action", result: "failed", target: `conversation ${s.conversation}`, detail: `resume-run; run ${s.runId}; refused: deleted` }]);
  });
});

describe("refusals are audited once", () => {
  it("the gate refuses", async () => {
    const s = setup("resume-run");
    const { token } = prep(s);
    const r = await refusal(confirm(token, s, users.ann, {}, env.deps({ gate: async () => ({ ok: false, reason: "issue_closed", message: CLOSED_MESSAGE }) })));
    expect([r.status, r.message, r.code]).toEqual([409, CLOSED_MESSAGE, "gate"]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ result: "failed", detail: `resume-run; run ${s.runId}; refused: gate` });
  });

  it("the store refuses during the re-check", async () => {
    const s = setup("cancel-run");
    const { token } = prep(s);
    hooks.failGet = () => {
      throw new HelpError("bad-state", "not now");
    };
    const r = await refusal(confirm(token, s));
    expect([r.status, r.code]).toEqual([409, "bad-state"]);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.detail).toBe(`cancel-run; run ${s.runId}; refused: bad-state`);
  });

  it("a body that cannot be read", async () => {
    const s = setup("cancel-run");
    const r = await refusal(confirmAction(env.ctx, users.ann, s.conversation, async () => Promise.reject(new HttpError(413, "SECRET-BODY-TEXT")), env.deps()));
    expect(r.status).toBe(413);
    expect(lines()).toEqual([{ action: "help-action", result: "failed", target: `conversation ${s.conversation}`, detail: "refused: bad-request" }]);
  });

  it("holds no token, request text or model text", async () => {
    const s = setup("cancel-run");
    const { token } = prep(s);
    await refusal(confirm("B".repeat(43), s));
    await confirm(token, s);
    await refusal(confirm(token, s, users.ann, { message: "not-a-uuid" }));
    const all = JSON.stringify(env.audit);
    expect(env.audit.length).toBe(3);
    for (const bad of [token, "B".repeat(43), "SUMMARY-TEXT", "EXPLANATION-TEXT", "not-a-uuid", "What can I do"]) expect(all).not.toContain(bad);
    expect(lines().map((l) => l.result)).toEqual(["failed", "ok", "failed"]);
  });
});
