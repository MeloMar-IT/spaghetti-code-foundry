import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY_MISSING, KEY_UNREADABLE, NEEDS_TOKEN, NO_RUN_OWNER, TOKEN_MISSING, TOKEN_UNREADABLE, addRepo } from "../src/auth/repos.js";
import { SIGN_IN_SENTENCES, TOKEN_REFUSED_REASON } from "../src/engine/guards.js";
import type { RunSummary } from "../src/engine/state.js";
import {
  GETTING_READY,
  architectReason,
  architectView,
  askArchitect,
  pausedReason,
  settleFinished,
  settleSession,
  stopArchitect,
  type ArchitectDeps,
} from "../src/refinement/architect.js";
import { createSession, endArchitectRun, getSession, refinementsPath, setArchitectRun } from "../src/refinement/store.js";

const ANN = "11111111-1111-4111-8111-111111111111";
const OK = { ownerOk: () => true, repoName: (_o: string, name: string) => name };
const owner = { id: ANN, admin: false };
let home: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "architect-"));
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const STEPS = [
  { id: "clone", type: "shell", description: "Clone it" },
  { id: "brief", type: "claude", description: "Write it" },
  { id: "check_brief", type: "shell" },
];
const BRIEF = "## What already exists\n- x\n## Code the idea would touch\n- x";
const rec = (id: string, output: string, ok = true) => ({ id, type: "shell" as const, visit: 1, ok, output, startedAt: "", durationMs: 1, logFile: "" });

function runOf(over: Partial<RunSummary> = {}): RunSummary {
  const dir = join(home, "runs", over.runId ?? "r1");
  mkdirSync(dir, { recursive: true });
  return {
    runId: "r1", flow: "refine-brief", flowDef: { name: "refine-brief", steps: STEPS }, task: "t", vars: {}, repo: home, status: "succeeded", runDir: dir,
    startedAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z", totalCostUsd: 0.5, state: { next: null, steps: {}, visits: {} },
    history: [rec("clone", "branch: develop"), rec("brief", BRIEF), rec("check_brief", BRIEF)],
    ...over,
  } as unknown as RunSummary;
}

/** A scheduler that holds hand-written runs. */
function stub(runs: RunSummary[] = [], queued: string[] = [], active: string[] = []) {
  const calls: { submitted: unknown[]; cancelled: string[] } = { submitted: [], cancelled: [] };
  const byId = new Map(runs.map((r) => [r.runId, r]));
  let broken = false;
  const sources = new Map<string, string>();
  const scheduler = {
    submit: (job: any) => {
      calls.submitted.push(job);
      return job.kind === "run" ? `new-${calls.submitted.length}` : job.runId;
    },
    cancel: (id: string) => {
      calls.cancelled.push(id);
      const i = queued.indexOf(id);
      if (i >= 0) queued.splice(i, 1);
      return i >= 0 || active.includes(id);
    },
    get: (id: string) => {
      if (broken) throw new Error("cannot read /secret/path");
      return byId.get(id);
    },
    isActive: (id: string) => active.includes(id),
    isQueued: (id: string) => queued.includes(id),
    briefs: () => runs.filter((r) => r.source).map((r) => ({ runId: r.runId, source: r.source, startedAt: r.startedAt })),
    queue: () => ({ pending: queued.map((runId) => ({ runId, source: sources.get(runId) })), active: active.map((runId) => ({ runId, source: sources.get(runId) })) }),
  };
  const logs: string[] = [];
  const deps: ArchitectDeps = { scheduler: scheduler as any, repo: home, log: (m) => void logs.push(m) };
  return { deps, calls, byId, logs, queued, active, sources, breakReads: () => (broken = true) };
}

const session = (idea = "An idea") => createSession(ANN, { repo: "acme/app", idea }, OK);
const started = (runId = "r1", s = session()) => (setArchitectRun(owner, s.id, runId), s.id);

describe("architectReason", () => {
  const failedStep = (id: string, text: string) => ({ status: "failed" as const, reason: `step "${id}" failed: ${text}` });
  it.each<[Pick<RunSummary, "status" | "reason">, string]>([
    [{ status: "cancelled" as const, reason: 'cancelled during step "brief"' }, "It was cancelled"],
    [{ status: "failed" as const, reason: "interrupted — resume it to continue" }, "The server stopped while the architect was reading"],
    [failedStep("clone", NEEDS_TOKEN), "Set a token for this repository under My repositories"],
    [failedStep("clone", TOKEN_MISSING), "The token of this repository is missing; set it again under My repositories"],
    [failedStep("list_issues", TOKEN_UNREADABLE), "The stored token of this repository cannot be read; set it again under My repositories, or ask an admin"],
    [failedStep("clone", KEY_MISSING), `${KEY_MISSING[0]!.toUpperCase()}${KEY_MISSING.slice(1)}`],
    [failedStep("clone", KEY_UNREADABLE), `${KEY_UNREADABLE[0]!.toUpperCase()}${KEY_UNREADABLE.slice(1)}`],
    ...SIGN_IN_SENTENCES.map((s): [Pick<RunSummary, "status" | "reason">, string] => [failedStep("clone", s), `${s[0]!.toUpperCase()}${s.slice(1)}`]),
    [failedStep("clone", NO_RUN_OWNER),"This run has no owner, so the token of the repository cannot be looked up"],
    [failedStep("clone", TOKEN_REFUSED_REASON), "GitHub refused the token of this repository; check its access to Contents and Issues, or set a new token under My repositories"],
    [failedStep("clone", '"acme/app" is not one of your repositories'), "The repository is not in My repositories any more"],
    [failedStep("brief", "output did not match pass_if"), "The brief did not have its five parts"],
    [failedStep("check_brief", "exit 1"), "The brief did not say that the backlog is larger than what was read"],
    [failedStep("clone", "boom in /Users/x/runs/r1"), "The repository could not be cloned"],
    [failedStep("list_issues", "boom"), "The open issues could not be read"],
    [{ status: "failed" as const, reason: "run budget of $3 reached" }, "The read used up the limit for one read"],
  ])("%j", (run, sentence) => {
    expect(architectReason(run)).toBe(sentence);
    expect(sentence).not.toMatch(/\$|\/Users|opus|sonnet/);
  });

  it("falls back to the safe sentence of userError", () => {
    const text = architectReason({ status: "failed", reason: 'step "brief" failed: usage limit reached' });
    expect(text).not.toMatch(/\/|\$/);
    expect(text.length).toBeGreaterThan(5);
  });
});

describe("pausedReason", () => {
  it.each([
    [{ reason: "daily budget of $5 reached — resume tomorrow", history: [] }, "The administrator's limit for today was reached; ask again tomorrow"],
    [{ reason: "signed out — run claude login", history: [] }, "The Foundry is signed out of its AI account; ask the administrator, then ask again"],
    [{ reason: "usage limit reached", history: [{ ...rec("brief", ""), unreachable: true }] }, "The AI service could not be reached; ask again later"],
    [{ reason: "usage limit reached — continues automatically", history: [] }, "The usage limit was reached; ask again later"],
  ])("%j", (run, sentence) => expect(pausedReason(run as any)).toBe(sentence));
});

describe("architectView", () => {
  it("idle without a run", () => {
    expect(architectView(stub().deps, session())).toEqual({ state: "idle" });
  });

  it("queued, running with the step description, and 'Getting ready' without a step or a run file", () => {
    const run = runOf({ status: "running", state: { next: "brief", steps: {}, visits: {} } } as any);
    const s = stub([run], ["q"], ["r1"]);
    expect(architectView(s.deps, { architect: { runId: "q", at: "" } })).toEqual({ state: "queued", runId: "q" });
    expect(architectView(s.deps, { architect: { runId: "r1", at: "" } })).toEqual({ state: "running", runId: "r1", doing: "Write it" });
    s.byId.set("r1", runOf({ status: "running", state: { next: null, steps: {}, visits: {} } } as any));
    expect(architectView(s.deps, { architect: { runId: "r1", at: "" } }).doing).toBe(GETTING_READY);
    s.byId.set("r1", runOf({ status: "running", state: { next: "check_brief", steps: {}, visits: {} } } as any));
    expect(architectView(s.deps, { architect: { runId: "r1", at: "" } }).doing).toBe(GETTING_READY);
    const none = stub([], [], ["r1"]);
    expect(architectView(none.deps, { architect: { runId: "r1", at: "" } })).toEqual({ state: "running", runId: "r1", doing: GETTING_READY });
  });

  it("failed with the stored reason, paused with a reason, and an unsettled end computed but not stored", () => {
    const s = stub([runOf({ runId: "p", status: "stopped", reason: "usage limit reached" }), runOf({ runId: "c", status: "cancelled", reason: "cancelled by user" })]);
    expect(architectView(s.deps, { architect: { runId: "x", at: "", failed: "It was cancelled" } })).toEqual({ state: "failed", runId: "x", reason: "It was cancelled" });
    expect(architectView(s.deps, { architect: { runId: "p", at: "" } })).toEqual({ state: "paused", runId: "p", reason: "The usage limit was reached; ask again later" });
    expect(architectView(s.deps, { architect: { runId: "c", at: "" } })).toEqual({ state: "failed", runId: "c", reason: "It was cancelled" });
  });
});

describe("settleSession", () => {
  it("stores the brief of a succeeded run", () => {
    const id = started();
    const got = settleSession(stub([runOf()]).deps, id)!;
    expect(got.architect).toBeUndefined();
    expect(got.brief).toMatchObject({ text: BRIEF, branch: "develop", runId: "r1", at: "2026-01-01T00:01:00.000Z" });
  });

  it("marks a failed run, a missing run and an unreadable run", () => {
    const failed = stub([runOf({ status: "failed", reason: 'step "clone" failed: boom' })]);
    expect(settleSession(failed.deps, started())!.architect?.failed).toBe("The repository could not be cloned");
    expect(settleSession(stub().deps, started("gone"))!.architect?.failed).toBe("It did not start; it was cancelled or taken out of the queue");
    const broken = stub([runOf()]);
    broken.breakReads();
    const got = settleSession(broken.deps, started())!;
    expect(got.architect?.failed).toBe("The run of the architect cannot be read");
  });

  it("marks an empty brief as failed", () => {
    const id = started();
    expect(settleSession(stub([runOf({ history: [rec("clone", "branch: x"), rec("brief", "  ")] })]).deps, id)!.architect?.failed).toBe("The brief was empty");
  });

  it("writes nothing for a paused run, and does not read a run that is marked failed", () => {
    const id = started();
    const s = stub([runOf({ status: "stopped", reason: "usage limit reached" })]);
    const bytes = readFileSync(refinementsPath(), "utf8");
    expect(settleSession(s.deps, id)!.architect?.runId).toBe("r1");
    expect(readFileSync(refinementsPath(), "utf8")).toBe(bytes);
    endArchitectRun(id, "r1", { failed: "It was cancelled" });
    const broken = stub();
    broken.breakReads();
    expect(settleSession(broken.deps, id)!.architect?.failed).toBe("It was cancelled");
  });

  it("leaves a queued or active run alone", () => {
    const id = started();
    const s = stub([runOf()], ["r1"]);
    expect(settleSession(s.deps, id)!.architect?.runId).toBe("r1");
    s.queued.length = 0;
    s.active.push("r1");
    expect(settleSession(s.deps, id)!.brief).toBeUndefined();
  });
});

describe("askArchitect", () => {
  beforeEach(() => void addRepo(ANN, "acme/app", { ownerOk: () => true }));

  it("refuses to start while a read of another session is marked failed but its run is active", () => {
    const other = session();
    setArchitectRun(owner, other.id, "live");
    endArchitectRun(other.id, "live", { failed: "It was cancelled" });
    const s = stub([], [], ["live"]);
    expect(() => askArchitect(s.deps, owner, session().id)).toThrow(/reading for another of your sessions/);
    expect(s.calls.submitted).toEqual([]);
  });

  it("adopts a queued job the session does not know, and refuses a second one", () => {
    const sess = session();
    const s = stub([], ["lost"]);
    s.sources.set("lost", `refinement ${sess.id}`);
    expect(() => askArchitect(s.deps, owner, sess.id)).toThrow(/already/);
    expect(getSession(sess.id)!.architect?.runId).toBe("lost");
    expect(s.calls.submitted).toEqual([]);
  });

  it("starts a new run for the idea, with the session as the source", () => {
    const sess = session("My idea");
    const s = stub();
    const r = askArchitect(s.deps, owner, sess.id);
    expect(r).toEqual({ runId: "new-1", resumed: false });
    expect(s.calls.submitted[0]).toMatchObject({ kind: "run", task: "My idea", frozenVars: true, vars: { github_repo: "acme/app" } });
    expect(getSession(sess.id)!.architect?.runId).toBe("new-1");
  });
});

describe("stopArchitect", () => {
  it("saves a stopped run as cancelled and marks the session", () => {
    const id = started();
    const run = runOf({ status: "stopped", reason: "usage limit reached" });
    const s = stub([run]);
    expect(stopArchitect(s.deps, id)).toBe(true);
    expect(JSON.parse(readFileSync(join(run.runDir, "run.json"), "utf8"))).toMatchObject({ status: "cancelled", reason: "cancelled by user" });
    expect(getSession(id)!.architect?.failed).toBe("It was cancelled");
  });

  it("only marks the session when a queued job with no run file was dropped", () => {
    const id = started("q");
    const s = stub([], ["q"]);
    expect(stopArchitect(s.deps, id)).toBe(true);
    expect(s.queued).toEqual([]);
    expect(getSession(id)!.architect?.failed).toBe("It was cancelled");
  });

  it("leaves an active run to the hook", () => {
    const id = started();
    const s = stub([runOf({ status: "running" })], [], ["r1"]);
    expect(stopArchitect(s.deps, id)).toBe(true);
    expect(s.calls.cancelled).toEqual(["r1"]);
    expect(getSession(id)!.architect?.failed).toBeUndefined();
  });

  it("does nothing without a read or for a failed mark that is not live", () => {
    const s = stub();
    expect(stopArchitect(s.deps, session().id)).toBe(false);
    const id = started();
    endArchitectRun(id, "r1", { failed: "x" });
    expect(stopArchitect(s.deps, id)).toBe(false);
    expect(s.calls.cancelled).toEqual([]);
  });
});

describe("settleFinished", () => {
  it("stores the brief of a run for a session, and ignores any other run", () => {
    const id = started();
    const s = stub();
    settleFinished(s.deps, runOf({ source: "ui" }));
    expect(getSession(id)!.brief).toBeUndefined();
    settleFinished(s.deps, runOf({ source: `refinement ${id}` }));
    expect(getSession(id)!.brief?.runId).toBe("r1");
  });

  it("writes nothing for a paused run", () => {
    const id = started();
    settleFinished(stub().deps, runOf({ status: "stopped", source: `refinement ${id}` }));
    expect(getSession(id)!.architect?.runId).toBe("r1");
  });

  it("never throws on a broken file and logs fixed words only", () => {
    const id = started();
    writeFileSync(refinementsPath(), "{ not json");
    const s = stub();
    expect(() => settleFinished(s.deps, runOf({ source: `refinement ${id}` }))).not.toThrow();
    expect(s.logs).toEqual(["refinement: refinements.json not-json"]);
  });
});
