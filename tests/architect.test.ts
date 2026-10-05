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
import { END_BAD_FORM, createSession, endArchitectRun, getSession, refinementsPath, setArchitectRun } from "../src/refinement/store.js";
import { emptyTalk } from "../src/refinement/talk.js";
import { TALK_FIRST_LINE, talkText } from "../src/refinement/talk-text.js";

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
  /** The flow and the task of a queued job, when a test sets them. */
  const jobs = new Map<string, { flow?: string; task?: string }>();
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
    queue: () => ({ pending: queued.map((runId) => ({ runId, source: sources.get(runId), ...jobs.get(runId) })), active: active.map((runId) => ({ runId, source: sources.get(runId) })) }),
  };
  const logs: string[] = [];
  const deps: ArchitectDeps = { scheduler: scheduler as any, repo: home, log: (m) => void logs.push(m) };
  return { deps, calls, byId, logs, queued, active, sources, jobs, breakReads: () => (broken = true) };
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
    [failedStep("check_round", "the architect's answer is not a JSON object"), END_BAD_FORM],
    [failedStep("round", "boom in /Users/x/runs/r1"), "The architect could not finish its answer"],
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
    expect(architectView(s.deps, { architect: { runId: "q", at: "" } })).toEqual({ state: "queued", kind: "brief", runId: "q" });
    expect(architectView(s.deps, { architect: { runId: "r1", at: "" } })).toEqual({ state: "running", kind: "brief", runId: "r1", doing: "Write it" });
    s.byId.set("r1", runOf({ status: "running", state: { next: null, steps: {}, visits: {} } } as any));
    expect(architectView(s.deps, { architect: { runId: "r1", at: "" } }).doing).toBe(GETTING_READY);
    s.byId.set("r1", runOf({ status: "running", state: { next: "check_brief", steps: {}, visits: {} } } as any));
    expect(architectView(s.deps, { architect: { runId: "r1", at: "" } }).doing).toBe(GETTING_READY);
    const none = stub([], [], ["r1"]);
    expect(architectView(none.deps, { architect: { runId: "r1", at: "" } })).toEqual({ state: "running", kind: "brief", runId: "r1", doing: GETTING_READY });
  });

  it("failed with the stored reason, paused with a reason, and an unsettled end computed but not stored", () => {
    const s = stub([runOf({ runId: "p", status: "stopped", reason: "usage limit reached" }), runOf({ runId: "c", status: "cancelled", reason: "cancelled by user" })]);
    expect(architectView(s.deps, { architect: { runId: "x", at: "", failed: "It was cancelled" } })).toEqual({ state: "failed", kind: "brief", runId: "x", reason: "It was cancelled" });
    expect(architectView(s.deps, { architect: { runId: "p", at: "" } })).toEqual({ state: "paused", kind: "brief", runId: "p", reason: "The usage limit was reached; ask again later" });
    expect(architectView(s.deps, { architect: { runId: "c", at: "" } })).toEqual({ state: "failed", kind: "brief", runId: "c", reason: "It was cancelled" });
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

describe("rounds and own questions", () => {
  beforeEach(() => void addRepo(ANN, "acme/app", { ownerOk: () => true }));

  const QS = (n: number) => Array.from({ length: n }, (_, i) => ({ view: "need", text: `Q${i}?`, why: "w", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1 }));
  const roundJson = (o: object = {}) => JSON.stringify({ questions: QS(3), proposals: [{ list: "rule", text: "R" }], done: "", ...o });
  const ROUND_STEPS = [
    { id: "clone", type: "shell", description: "Clone it" },
    { id: "round", type: "claude", description: "Ask" },
    { id: "check_round", type: "shell" },
  ];
  const roundRun = (over: Partial<RunSummary> = {}, out = roundJson(), ask = "round"): RunSummary =>
    runOf({
      flow: "refine-round", flowDef: { name: "refine-round", steps: ROUND_STEPS }, vars: { github_repo: "acme/app", ask },
      history: [rec("clone", "branch: main"), rec("round", "x"), rec("check_round", out)], ...over,
    } as any);
  const withBrief = () => {
    const s = session();
    setArchitectRun(owner, s.id, "b0");
    endArchitectRun(s.id, "b0", { brief: { text: "The brief", at: "2026-01-01T00:00:00.000Z" } });
    return s;
  };
  const edit = (fn: (f: any) => void) => {
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    fn(f);
    writeFileSync(refinementsPath(), JSON.stringify(f));
  };
  const whats = (id: string) => getSession(id)!.log.map((l) => l.what);

  describe("settleSession", () => {
    it("stores the round of a succeeded refine-round run", () => {
      const s0 = withBrief();
      setArchitectRun(owner, s0.id, "r1", { kind: "round" });
      const got = settleSession(stub([roundRun()]).deps, s0.id)!;
      expect(got.architect).toBeUndefined();
      expect(got.talk!.rounds).toHaveLength(1);
      expect(got.talk!.rounds[0]!.questions).toHaveLength(3);
      expect(got.talk!.proposals).toHaveLength(1);
    });

    it("stores an answer for ask=question", () => {
      const s0 = session();
      setArchitectRun(owner, s0.id, "r1", { kind: "question", question: "Why?" });
      const got = settleSession(stub([roundRun({}, JSON.stringify({ answer: "Because (a.ts)." }), "question")]).deps, s0.id)!;
      expect(got.talk!.asked).toMatchObject([{ question: "Why?", answer: "Because (a.ts)." }]);
      expect(whats(s0.id)).toEqual(["created", "asked", "architect-answered"]);
    });

    it.each([
      ["not JSON", "nope"],
      ["an extra field", roundJson({ extra: 1 })],
      ["6 questions", roundJson({ questions: QS(6) })],
      ["no output", ""],
    ])("fails with the agreed-form sentence for %s", (_n, out) => {
      const s0 = withBrief();
      setArchitectRun(owner, s0.id, "r1", { kind: "round" });
      const got = settleSession(stub([roundRun({}, out)]).deps, s0.id)!;
      expect(got.architect).toMatchObject({ failed: END_BAD_FORM, kind: "round" });
      expect(got.talk).toBeUndefined();
    });

    it("fails for an answer with an extra field", () => {
      const s0 = session();
      setArchitectRun(owner, s0.id, "r1", { kind: "question", question: "Why?" });
      const got = settleSession(stub([roundRun({}, JSON.stringify({ answer: "x", questions: [] }), "question")]).deps, s0.id)!;
      expect(got.architect?.failed).toBe(END_BAD_FORM);
    });
  });

  describe("askArchitect for a round", () => {
    it("needs a brief and an answer to every question of the last round", () => {
      const none = session();
      const s = stub();
      expect(() => askArchitect(s.deps, owner, none.id, { kind: "round" })).toThrow(/ask the architect to look at the code first/);
      const sess = withBrief();
      setArchitectRun(owner, sess.id, "r0", { kind: "round" });
      endArchitectRun(sess.id, "r0", { round: JSON.parse(roundJson()) });
      expect(() => askArchitect(s.deps, owner, sess.id, { kind: "round" })).toThrow(/answer every question of the last round first; "I don't know yet" is an answer/);
      expect(s.calls.submitted).toEqual([]);
    });

    it("submits the flow refine-round with ask=round and the talk as the task", () => {
      const sess = withBrief();
      const s = stub();
      expect(askArchitect(s.deps, owner, sess.id, { kind: "round" })).toEqual({ runId: "new-1", resumed: false });
      const job = s.calls.submitted[0] as any;
      expect(job.flow.name).toBe("refine-round");
      expect(job.vars).toMatchObject({ github_repo: "acme/app", ask: "round" });
      expect(job.task.startsWith(TALK_FIRST_LINE.round)).toBe(true);
      expect(job.frozenVars).toBe(true);
      expect(getSession(sess.id)!.architect).toMatchObject({ runId: "new-1", kind: "round" });
      expect(whats(sess.id).at(-1)).toBe("round-started");
    });
  });

  describe("askArchitect for a question", () => {
    it("works on a new session with no talk and no brief; the task ends with the question", () => {
      const sess = session();
      const s = stub();
      askArchitect(s.deps, owner, sess.id, { kind: "question", question: "  How does it work?  " });
      const job = s.calls.submitted[0] as any;
      expect(job.vars.ask).toBe("question");
      expect(job.task.startsWith(TALK_FIRST_LINE.question)).toBe(true);
      expect(job.task.endsWith("How does it work?")).toBe(true);
      expect(getSession(sess.id)!.architect).toMatchObject({ kind: "question", question: "How does it work?" });
    });

    it.each([[undefined], [""], ["x".repeat(2001)], [42]])("refuses the question %j as bad-text", (q) => {
      const sess = session();
      const s = stub();
      expect(() => askArchitect(s.deps, owner, sess.id, { kind: "question", question: q })).toThrow(expect.objectContaining({ code: "bad-text" }));
      expect(s.calls.submitted).toEqual([]);
    });

    it("keeps at most 50 own questions", () => {
      const sess = session();
      setArchitectRun(owner, sess.id, "r0", { kind: "question", question: "q" });
      endArchitectRun(sess.id, "r0", { answer: "a" });
      edit((f) => {
        f.sessions[0].talk.asked = Array.from({ length: 50 }, (_, i) => ({ runId: `o-${i}`, at: "2026-01-01T00:00:00.000Z", question: "q", answer: "a" }));
      });
      const s = stub();
      expect(() => askArchitect(s.deps, owner, sess.id, { kind: "question", question: "One more?" })).toThrow(/at most 50 own questions are kept/);
    });
  });

  describe("a paused run", () => {
    const pausedRound = () => {
      const sess = withBrief();
      setArchitectRun(owner, sess.id, "r1", { kind: "round" });
      return sess;
    };
    it("of the same kind is resumed", () => {
      const sess = pausedRound();
      const s = stub([roundRun({ status: "stopped", reason: "usage limit reached", workdir: home } as any)]);
      expect(askArchitect(s.deps, owner, sess.id, { kind: "round" })).toEqual({ runId: "r1", resumed: true });
      expect(s.calls.submitted).toEqual([{ kind: "resume", runId: "r1" }]);
      expect(getSession(sess.id)!.architect).toMatchObject({ runId: "r1", kind: "round" });
    });
    it("of another kind answers busy and says which", () => {
      const sess = pausedRound();
      const s = stub([roundRun({ status: "stopped", reason: "usage limit reached", workdir: home } as any)]);
      expect(() => askArchitect(s.deps, owner, sess.id, { kind: "question", question: "Why?" })).toThrow(/paused while asking its questions for this session; ask that again first/);
      expect(() => askArchitect(s.deps, owner, sess.id)).toThrow(expect.objectContaining({ code: "busy" }));
      expect(s.calls.submitted).toEqual([]);
    });
  });

  describe("an orphan run", () => {
    const ask = "Why is it so? 😀";
    const questionTask = () => talkText({ kind: "question", idea: "An idea", talk: emptyTalk(), question: ask });
    it("queued: recorded as a question with its text", () => {
      const sess = session();
      const s = stub([], ["lost"]);
      s.sources.set("lost", `refinement ${sess.id}`);
      s.jobs.set("lost", { flow: "refine-round", task: questionTask() });
      const got = settleSession(s.deps, sess.id)!;
      expect(got.architect).toMatchObject({ runId: "lost", kind: "question", question: ask });
      expect(whats(sess.id)).toEqual(["created", "asked"]);
    });

    it("active with a readable run: recorded as a question, and resumed as one when it pauses", () => {
      const sess = session();
      const run = roundRun({ runId: "r9", status: "running", source: `refinement ${sess.id}`, task: questionTask() }, "", "question");
      const s = stub([run], [], ["r9"]);
      s.sources.set("r9", `refinement ${sess.id}`);
      expect(settleSession(s.deps, sess.id)!.architect).toMatchObject({ runId: "r9", kind: "question", question: ask });
      s.active.length = 0;
      s.byId.set("r9", { ...run, status: "stopped", reason: "usage limit reached", workdir: home } as any);
      expect(askArchitect(s.deps, owner, sess.id, { kind: "question", question: "ignored on resume" })).toEqual({ runId: "r9", resumed: true });
    });

    it("ended and succeeded: the question is read back and the answer stored", () => {
      const sess = session();
      const run = roundRun(
        { runId: "r8", source: `refinement ${sess.id}`, task: questionTask(), startedAt: new Date(Date.now() + 60_000).toISOString() },
        JSON.stringify({ answer: "Because (a.ts)." }),
        "question",
      );
      const got = settleSession(stub([run]).deps, sess.id)!;
      expect(got.architect).toBeUndefined();
      expect(got.talk!.asked).toMatchObject([{ runId: "r8", question: ask, answer: "Because (a.ts)." }]);
      expect(whats(sess.id)).toEqual(["created", "asked", "architect-answered"]);
    });

    it("an ended run that could not be recorded is looked for again on the next read", () => {
      const sess = session();
      const run = roundRun(
        { runId: "r7", source: `refinement ${sess.id}`, task: questionTask(), startedAt: new Date(Date.now() + 60_000).toISOString() },
        JSON.stringify({ answer: "Because (a.ts)." }),
        "question",
      );
      const s = stub([run]);
      const created = getSession(sess.id)!.log[0]!;
      edit((f) => (f.sessions[0].log = Array.from({ length: 998 }, () => ({ ...created, what: "renamed", detail: "x" }))));
      expect(settleSession(s.deps, sess.id)!.architect).toBeUndefined();
      edit((f) => (f.sessions[0].log = f.sessions[0].log.slice(0, 5)));
      const got = settleSession(s.deps, sess.id)!;
      expect(got.talk!.asked).toMatchObject([{ runId: "r7", answer: "Because (a.ts)." }]);
    });

    it("queued: a question that looks like the heading is recorded whole", () => {
      const tricky = "Why?\n\n## The question of the person\nand more\n\n## The question of the person (3 characters)\nxyz";
      const sess = session();
      const s = stub([], ["lost"]);
      s.sources.set("lost", `refinement ${sess.id}`);
      s.jobs.set("lost", { flow: "refine-round", task: talkText({ kind: "question", idea: "An idea", talk: emptyTalk(), question: tricky }) });
      expect(settleSession(s.deps, sess.id)!.architect).toMatchObject({ kind: "question", question: tricky });
    });

    it("a queued round is recorded as a round", () => {
      const sess = withBrief();
      const s = stub([], ["lost"]);
      s.sources.set("lost", `refinement ${sess.id}`);
      s.jobs.set("lost", { flow: "refine-round", task: talkText({ kind: "round", idea: "An idea", talk: emptyTalk() }) });
      expect(settleSession(s.deps, sess.id)!.architect).toMatchObject({ runId: "lost", kind: "round" });
      expect(whats(sess.id).at(-1)).toBe("round-started");
    });

    it("active with no readable run is recorded as a brief", () => {
      const sess = session();
      const s = stub([], [], ["x"]);
      s.sources.set("x", `refinement ${sess.id}`);
      const got = settleSession(s.deps, sess.id)!;
      expect(got.architect).toEqual({ runId: "x", at: expect.any(String) });
      expect(whats(sess.id).at(-1)).toBe("architect-started");
    });
  });

  it("architectView has the kind in queued, running, paused and failed", () => {
    const s = stub([roundRun({ runId: "p", status: "stopped", reason: "usage limit reached" })], ["q"], ["a"]);
    const kind = "question" as const;
    expect(architectView(s.deps, { architect: { runId: "q", at: "", kind } }).kind).toBe(kind);
    expect(architectView(s.deps, { architect: { runId: "a", at: "", kind } }).kind).toBe(kind);
    expect(architectView(s.deps, { architect: { runId: "p", at: "", kind } })).toMatchObject({ state: "paused", kind });
    expect(architectView(s.deps, { architect: { runId: "x", at: "", kind, failed: "x" } })).toMatchObject({ state: "failed", kind });
  });
});
