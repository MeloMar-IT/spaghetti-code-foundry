import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { AnswerRefused, resumeRun, runFlow, saveAnswer } from "../src/engine/runner.js";
import { ANSWERS_HEADING, TASK_MAX_BYTES, answerRoom, taskWithAnswers } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { dropIssueStates, markIssueCheckFailed, saveIssueStates } from "../src/issue-states.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const config = (): Config => ConfigSchema.parse({ protected_branches: [] });

const ASK = (slow = "") => `name: ask
workspace: empty
publish:
  enabled: true
steps:
  - {id: pull_ticket, type: shell, run: "${slow}echo pulled"}
  - id: plan
    type: shell
    run: |
      case "$FACTORY_TASK" in *"use B"*) ;; *) echo "Q1. A or B?"; exit 0;; esac
      case "$FACTORY_TASK" in *blue*) echo "ROUTE: BUILD";; *) echo "Q2. Which colour?";; esac
    routes: [{if: "^ROUTE: BUILD", goto: build}]
    on_success: ask_for_info
  - {id: ask_for_info, type: shell, jump_only: true, run: 'echo "$FACTORY_OUT_PLAN"', on_success: stop, resume_from: pull_ticket}
  - {id: build, type: shell, run: "printf '%s' \\"$SCF_TASK\\""}
`;
const ASK_TPL = ASK().replace("name: ask", "name: ask-tpl") + `  - {id: gate, type: approval, message: "{{task}}"}\n`;
const NO_TASK = `name: notask
workspace: empty
steps:
  - {id: ask_for_info, type: shell, run: "echo Q?", on_success: stop}
`;
const SLOW = `name: slow
workspace: empty
publish:
  enabled: true
steps:
  - {id: a, type: shell, run: "sleep 2"}
`;

describe("engine: the task with the answers", () => {
  let tmp: string;
  let repo: string;
  let runsDir: string;
  const saved = process.env.FACTORY_HOME;
  afterAll(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
  });
  const setup = () => {
    tmp = mkdtempSync(join(tmpdir(), "run-answer-eng-"));
    process.env.FACTORY_HOME = join(tmp, "home");
    repo = join(tmp, "repo");
    runsDir = join(tmp, "runs");
    mkdirSync(repo);
  };
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const start = (yaml = ASK(), task = "t") => runFlow(parseFlow(yaml), { task, repo, runsDir, claudeBin, config: config() });
  const resume = (runId: string) => resumeRun({ runId, runsDir, claudeBin, config: config() });
  const bytes = (id: string) => readFileSync(join(runsDir, id, "run.json"));

  it("taskWithAnswers and answerRoom", () => {
    setup();
    for (const answers of [undefined, [], "x" as never]) expect(taskWithAnswers({ task: "t", answers })).toBe("t");
    const a = (text: string) => ({ at: "", text, by: "u" });
    expect(taskWithAnswers({ task: "t", answers: [a("one"), a("two")] })).toBe(`t\n\n${ANSWERS_HEADING}\n\nAnswer 1:\none\n\nAnswer 2:\ntwo`);
    expect(taskWithAnswers({ task: "", answers: [a("one")] })).toBe(`${ANSWERS_HEADING}\n\nAnswer 1:\none`);
    expect(answerRoom({ task: "t" })).toBe(TASK_MAX_BYTES - Buffer.byteLength(taskWithAnswers({ task: "t", answers: [a("")] })));
    expect(answerRoom({ task: "x".repeat(TASK_MAX_BYTES) })).toBeLessThanOrEqual(0);
  });

  it("continues with every answer in order, keeps the task as typed", async () => {
    setup();
    const s = await start();
    expect(s.status).toBe("stopped");
    saveAnswer(runsDir, s.runId, "  use B\n", "u1");
    const s2 = await resume(s.runId);
    expect(s2.status).toBe("stopped");
    expect(s2.history.at(-1)!.output).toContain("Q2");
    saveAnswer(runsDir, s.runId, "blue", "u1");
    const s3 = await resume(s.runId);
    expect(s3.status).toBe("succeeded");
    const file = JSON.parse(bytes(s.runId).toString());
    expect(file.task).toBe("t");
    expect(file.answers.map((x: { text: string; by: string }) => [x.text, x.by])).toEqual([["  use B\n", "u1"], ["blue", "u1"]]);
    expect(file.answers[0].at).toMatch(/^\d{4}-/);
    expect(s3.history.at(-1)!.output).toBe(taskWithAnswers(file));
    expect(s3.history.at(-1)!.output.indexOf("use B")).toBeLessThan(s3.history.at(-1)!.output.indexOf("blue"));
  });

  it("puts the answers into {{task}}", async () => {
    setup();
    const s = await start(ASK_TPL);
    saveAnswer(runsDir, s.runId, "use B", "u1");
    saveAnswer(runsDir, s.runId, "blue", "u1");
    const s2 = await resume(s.runId);
    expect(s2.waiting?.message).toContain(ANSWERS_HEADING);
    expect(s2.waiting?.message).toContain("blue");
  });

  it("refuses a run that did not stop, and an unknown run, and changes nothing", async () => {
    setup();
    const ok = await start(NO_TASK.replace("on_success: stop", "on_success: stop").replace('"echo Q?"', '"echo Q?"'));
    const done = await start(`name: d\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: "echo $FACTORY_TASK"}\n`);
    expect(done.status).toBe("succeeded");
    const before = bytes(done.runId);
    for (const id of [done.runId, "unknown"]) {
      expect(() => saveAnswer(runsDir, id, "x", "u")).toThrow(AnswerRefused);
      try {
        saveAnswer(runsDir, id, "x", "u");
      } catch (e) {
        expect((e as AnswerRefused).kind).toBe("state");
      }
    }
    expect(bytes(done.runId).equals(before)).toBe(true);
    expect(ok.status).toBe("stopped");
  });

  it("accepts exactly 100000 bytes and refuses one more, or too many bytes in few characters", async () => {
    setup();
    const s = await start();
    const room = answerRoom(JSON.parse(bytes(s.runId).toString()));
    const before = bytes(s.runId);
    const emoji = "😀".repeat(Math.ceil((room + 1) / 4));
    try {
      saveAnswer(runsDir, s.runId, emoji, "u");
      expect.unreachable();
    } catch (e) {
      expect((e as AnswerRefused).kind).toBe("size");
      expect((e as Error).message).toContain("100000");
    }
    expect(() => saveAnswer(runsDir, s.runId, "x".repeat(room + 1), "u")).toThrow(/100000/);
    expect(bytes(s.runId).equals(before)).toBe(true);
    const { run, undo } = saveAnswer(runsDir, s.runId, "x".repeat(room), "u");
    expect(Buffer.byteLength(taskWithAnswers(run))).toBe(TASK_MAX_BYTES);
    undo();
    expect(bytes(s.runId).equals(before)).toBe(true);
  });

  it("a run.json without answers resumes with the plain task", async () => {
    setup();
    const s = await start(`name: x\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: "echo $FACTORY_TASK", on_success: stop, resume_from: a}\n`, "plain");
    expect(s.status).toBe("stopped");
    expect(JSON.parse(bytes(s.runId).toString()).answers).toBeUndefined();
    const r = await resume(s.runId);
    expect(r.history.at(-1)!.output.trim()).toBe("plain");
  });
});

describe("scheduler: answer()", () => {
  let tmp: string;
  let repo: string;
  const saved = process.env.FACTORY_HOME;
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
  });
  type Over = { concurrency?: number; accountActive?: (id: string) => boolean };
  const setup = async (over: Over = {}) => {
    tmp = mkdtempSync(join(tmpdir(), "run-answer-sch-"));
    process.env.FACTORY_HOME = join(tmp, "home");
    repo = join(tmp, "repo");
    mkdirSync(repo);
    const runsDir = join(tmp, "runs");
    const queueFile = join(tmp, "queue.json");
    const first = await runFlow(parseFlow(ASK()), { task: "t", repo, runsDir, claudeBin, config: config() });
    const mk = (extra: Over = {}) => {
      const o = { ...over, ...extra };
      return new Scheduler({ runsDir, queueFile, config: () => ({ ...config(), ...(o.concurrency === undefined ? {} : { concurrency: o.concurrency }) }), claudeBin, ...(o.accountActive ? { accountActive: o.accountActive } : {}) });
    };
    const file = () => readFileSync(join(runsDir, first.runId, "run.json"));
    return { id: first.runId, runsDir, queueFile, mk, file };
  };

  it("saves the answer at once, resumes, and the step reads it", async () => {
    const { id, mk, file } = await setup();
    const s = mk();
    s.answer(id, "use B", "u1", { queuedBy: "u1" });
    expect(JSON.parse(file().toString()).answers).toHaveLength(1);
    const done = await s.wait(id);
    await s.idle();
    expect(done?.status).toBe("stopped");
    s.answer(id, "blue", "u1");
    await s.idle();
    const final = s.get(id)!;
    expect(final.status).toBe("succeeded");
    expect(final.history.at(-1)!.output).toBe(taskWithAnswers(final));
  });

  it("keeps the text out of queue.json, refuses a second call, and keeps the answer when the job is dropped or held", async () => {
    const { id, queueFile, mk, file } = await setup({ concurrency: 0 });
    const s = mk();
    s.answer(id, "SECRET-MARKER", "u1", { queuedBy: "u1" });
    expect(readFileSync(queueFile, "utf8")).toContain(id);
    expect(readFileSync(queueFile, "utf8")).not.toContain("SECRET-MARKER");
    expect(() => s.answer(id, "again", "u1")).toThrow(/already queued or running/);
    expect(JSON.parse(file().toString()).answers).toHaveLength(1);
    expect(s.cancel(id)).toBe(true);
    expect(JSON.parse(file().toString()).answers).toHaveLength(1);
    s.answer(id, "two", "u1", { queuedBy: "u1" });
    expect(s.cancelAccount("u1").queued).toBe(1);
    expect(JSON.parse(file().toString()).answers).toHaveLength(2);
    // a restart reads the saved job
    s.answer(id, "three", "u1");
    const again = mk({ concurrency: 1 });
    await again.idle();
    expect(again.get(id)!.history.some((h) => h.output.includes("SECRET-MARKER"))).toBe(false);
    expect(JSON.parse(file().toString()).answers).toHaveLength(3);
  });

  it("holds the job of a blocked account, and the answer stays", async () => {
    const { id, mk, file } = await setup({ accountActive: () => false });
    const s = mk();
    s.answer(id, "use B", "u1", { queuedBy: "u1" });
    await new Promise((r) => setTimeout(r, 100));
    expect(s.isQueued(id)).toBe(true);
    expect(JSON.parse(file().toString()).answers).toHaveLength(1);
  });

  it("refuses a run that is not stopped and queues nothing", async () => {
    const { mk } = await setup({ concurrency: 0 });
    const s = mk();
    expect(() => s.answer("unknown", "x", "u1")).toThrow(AnswerRefused);
    expect(s.queue().pending).toHaveLength(0);
  });

  it("undoes the answer when the queue cannot be written", async () => {
    const { id, queueFile, mk, file } = await setup({ concurrency: 0 });
    const s = mk();
    await new Promise((r) => setTimeout(r, 20));
    const before = file();
    rmSync(queueFile, { force: true });
    mkdirSync(queueFile);
    let err: unknown;
    try {
      s.answer(id, "x", "u1");
    } catch (e) {
      err = e;
    }
    rmSync(queueFile, { recursive: true });
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AnswerRefused);
    expect(s.isQueued(id)).toBe(false);
    expect(file().equals(before)).toBe(true);
    s.answer(id, "x", "u1");
    expect(JSON.parse(file().toString()).answers).toHaveLength(1);
  });

  // pump() asks accountActive between the first and the second write of the queue file
  for (const started of [false, true]) {
    it(`keeps the answer and does not throw when the second queue write fails (job ${started ? "started" : "pending"})`, async () => {
      let breakQueue: (() => void) | undefined;
      let savedQueue = "";
      const { id, queueFile, mk, file } = await setup({
        accountActive: () => {
          breakQueue?.();
          return started;
        },
      });
      const s = mk();
      await new Promise((r) => setTimeout(r, 20));
      breakQueue = () => {
        breakQueue = undefined;
        savedQueue = readFileSync(queueFile, "utf8");
        mkdirSync(`${queueFile}.tmp`); // the second write cannot be made; queue.json stays as the first write left it
      };
      expect(() => s.answer(id, "use B", "u1", { queuedBy: "u1" })).not.toThrow();
      rmSync(`${queueFile}.tmp`, { recursive: true, force: true });
      expect(savedQueue).toContain(id);
      expect(readFileSync(queueFile, "utf8")).toBe(savedQueue);
      expect(JSON.parse(file().toString()).answers).toHaveLength(1);
      if (started) {
        await s.wait(id);
        await s.idle();
        const run = s.get(id)!;
        expect(run.status).toBe("stopped");
        expect(run.history.at(-1)!.output).toContain("Q2");
        return;
      }
      expect(s.isQueued(id)).toBe(true);
      const again = mk({ accountActive: () => true });
      await again.idle();
      const run = again.get(id)!;
      expect(run.status).toBe("stopped");
      expect(run.history.at(-1)!.output).toContain("Q2");
      expect(JSON.parse(file().toString()).answers).toHaveLength(1);
    });
  }
});

/* ---- the server ---- */

interface Srv {
  base: string;
  tmp: string;
  runsDir: string;
  repo: string;
  ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
  close: () => void;
}
const savedHome = process.env.FACTORY_HOME;
let kc: FakeKeychain;
const open: Srv[] = [];
beforeAll(() => void (kc = fakeKeychain()));
afterAll(() => {
  for (const s of open) s.close();
  kc.remove();
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

async function boot(extra: Partial<ServerOptions> = {}): Promise<Srv> {
  const tmp = mkdtempSync(join(tmpdir(), "run-answer-srv-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  process.env.FACTORY_HOME = join(tmp, "home");
  const runsDir = join(tmp, "runs");
  for (let i = 0; ; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    try {
      const started = await startServer({ repo, runsDir, port, claudeBin, watchers: false, log: (m: string) => logs.push(m), ...extra });
      const s: Srv = { base: `http://127.0.0.1:${port}`, tmp, runsDir, repo, ctx: started.ctx, close: () => { started.close(); rmSync(tmp, { recursive: true, force: true }); } };
      open.push(s);
      return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
    }
  }
}
const logs: string[] = [];

const call = async (s: Srv, who: TestSession, method: string, path: string, body?: unknown) => {
  const r = await fetch(s.base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
};

describe("POST /api/runs/:id/answer", () => {
  let s: Srv;
  let admin: TestSession;
  let ann: TestSession;
  let bob: TestSession;
  const saveFlow = async (name: string, yaml: string) => expect((await call(s, admin, "PUT", `/api/flows/${name}`, { yaml, scope: "repo" })).status).toBe(200);
  const runFile = (id: string) => join(s.runsDir, id, "run.json");
  const runJson = (id: string) => JSON.parse(readFileSync(runFile(id), "utf8"));
  const audit = () => (existsSync(join(s.tmp, "home", "audit.jsonl")) ? readFileSync(join(s.tmp, "home", "audit.jsonl"), "utf8") : "");
  const startAsk = async (who: TestSession, flow = "ask") => {
    const r = await call(s, who, "POST", "/api/runs", { flow, task: "t" });
    expect(r.status).toBe(201);
    const id = r.json().runId as string;
    await s.ctx.scheduler.wait(id);
    await s.ctx.scheduler.idle();
    return id;
  };
  const answer = (who: TestSession, id: string, text: unknown) => call(s, who, "POST", `/api/runs/${id}/answer`, { text });
  /** Runs `fn` and checks that nothing changed: same run.json bytes, same jobs, same audit lines. */
  const unchanged = async (id: string, fn: () => Promise<void>) => {
    const bytes = existsSync(runFile(id)) ? readFileSync(runFile(id)) : undefined;
    const jobs = s.ctx.scheduler.queue().pending.length;
    const lines = audit().split("\n").length;
    await fn();
    if (bytes) expect(readFileSync(runFile(id)).equals(bytes)).toBe(true);
    expect(s.ctx.scheduler.queue().pending.length).toBe(jobs);
    expect(audit().split("\n").length).toBe(lines);
  };
  const handRun = (id: string, extra: Record<string, unknown> = {}) => {
    const flowDef = parseFlow(ASK());
    mkdirSync(join(s.runsDir, id), { recursive: true });
    writeFileSync(runFile(id), JSON.stringify({
      runId: id, flow: "ask", flowDef, task: "t", vars: {}, repo: s.repo, status: "stopped", reason: 'stopped at step "ask_for_info"', runDir: join(s.runsDir, id),
      startedAt: "2026-01-01T00:00:00.000Z", totalCostUsd: 0, owner: ann.user.id, source: "ui",
      history: [{ id: "ask_for_info", type: "shell", visit: 1, ok: true, output: "Q1?", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1, logFile: "x" }],
      state: { next: "pull_ticket", steps: {}, visits: {} }, ...extra,
    }));
  };

  beforeAll(async () => {
    s = await boot();
    admin = await signInAs(s.base);
    ann = await signInAs(s.base, { name: "Ann", email: "ann@example.com", role: "user" });
    bob = await signInAs(s.base, { name: "Bob", email: "bob@example.com", role: "user" });
    await saveFlow("ask", ASK());
    await saveFlow("ask-tpl", ASK_TPL);
    await saveFlow("slow", SLOW);
  });
  afterEach(async () => {
    for (const q of [...s.ctx.scheduler.queue().pending, ...s.ctx.scheduler.queue().active]) s.ctx.scheduler.cancel(q.runId);
    await s.ctx.scheduler.idle();
  });

  it("takes answers over several rounds and the steps read them in order", async () => {
    const id = await startAsk(ann);
    const view = (await call(s, ann, "GET", `/api/runs/${id}`)).json();
    expect(view.canAnswer).toBe(true);
    expect(view.task).toBe("t");
    const r = await answer(ann, id, "use B");
    expect(r.status).toBe(202);
    expect(r.json()).toEqual({ runId: id });
    expect(runJson(id).answers[0]).toMatchObject({ text: "use B", by: ann.user.id });
    expect(audit().split("\n").filter((l) => l.includes("run-answer"))).toHaveLength(1);
    await s.ctx.scheduler.wait(id);
    await s.ctx.scheduler.idle();
    expect(runJson(id).status).toBe("stopped");
    expect((await answer(admin, id, "blue")).status).toBe(202);
    await s.ctx.scheduler.wait(id);
    await s.ctx.scheduler.idle();
    const done = runJson(id);
    expect(done.status).toBe("succeeded");
    expect(done.task).toBe("t");
    expect(done.answers.map((a: { by: string }) => a.by)).toEqual([ann.user.id, admin.user.id]);
    expect(done.history.at(-1).output).toBe(taskWithAnswers(done));
    const adminView = (await call(s, admin, "GET", `/api/runs/${id}`)).json();
    expect(adminView.task).toBe("t");
    expect(adminView.answers[0].by).toBe(ann.user.id);
    const userView = (await call(s, ann, "GET", `/api/runs/${id}`)).json();
    expect(userView.answers).toHaveLength(2);
    expect(userView.answers[0]).toEqual({ at: expect.any(String), text: "use B" });
    expect(userView.canAnswer).toBeUndefined();
  });

  it("answers 404 with the same body for an unknown run and another account's run", async () => {
    const id = await startAsk(ann);
    await unchanged(id, async () => {
      const a = await answer(bob, "unknown-run", "x");
      const b = await answer(bob, id, "x");
      expect(a.status).toBe(404);
      expect(b.status).toBe(404);
      expect(b.text).toBe(a.text);
    });
  });

  it("refuses bad texts with 400", async () => {
    const id = await startAsk(ann);
    await unchanged(id, async () => {
      for (const body of [{}, { text: 5 }, { text: "" }, { text: "  " }]) expect((await call(s, ann, "POST", `/api/runs/${id}/answer`, body)).status).toBe(400);
      const long = await answer(ann, id, "x".repeat(4001));
      expect(long.status).toBe(400);
      expect(long.text).toContain("4000");
      expect((await answer(ann, id, "x" + " ".repeat(4000))).status).toBe(400);
      expect((await answer(ann, id, "a\u0000b")).status).toBe(400);
    });
    const emoji = await answer(ann, id, "😀".repeat(4000));
    expect(emoji.status).toBe(202);
  });

  it("refuses a task and answers over 100000 bytes, and has no canAnswer for it", async () => {
    const id = "big-run";
    handRun(id, { task: "x".repeat(TASK_MAX_BYTES - 5) });
    await unchanged(id, async () => {
      const r = await answer(ann, id, "y".repeat(100));
      expect(r.status).toBe(400);
      expect(r.text).toContain("100000");
    });
    expect((await call(s, ann, "GET", `/api/runs/${id}`)).json().canAnswer).toBeUndefined();
  });

  it("refuses with 400 while the resume is queued or the run works", async () => {
    const id = "queued-run";
    handRun(id);
    // the default concurrency is 2: two slow runs hold both slots
    for (const task of ["t1", "t2"]) expect((await call(s, ann, "POST", "/api/runs", { flow: "slow", task })).status).toBe(201);
    expect((await answer(ann, id, "use B")).status).toBe(202);
    await unchanged(id, async () => {
      const r = await answer(ann, id, "again");
      expect(r.status).toBe(400);
      expect(r.text).toContain(`run ${id} is already queued or running`);
    });
  });

  it("refuses with 409 what cannot take an answer", async () => {
    const cases: Record<string, Record<string, unknown>> = {
      waiting: { status: "waiting" },
      other: { reason: 'stopped at step "build"' },
      empty: { history: [{ id: "ask_for_info", type: "shell", visit: 1, ok: true, output: "", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1, logFile: "x" }] },
      watcher: { source: "watcher w issue #7", vars: { github_repo: "acme/app", issue: "7" } },
      notask: { flowDef: parseFlow(NO_TASK) },
      architect: { source: "refinement 11111111-1111-4111-8111-111111111111" },
      failed: { status: "failed" },
    };
    (s.ctx.config() as { watchers: unknown[] }).watchers.push({ id: "w", enabled: true, source: "issues", github_repo: "acme/app", flow: "ask", label: "ready" });
    try {
      for (const [name, extra] of Object.entries(cases)) {
        const id = `case-${name}`;
        handRun(id, extra);
        await unchanged(id, async () => expect((await answer(ann, id, "use B")).status, name).toBe(409));
        expect((await call(s, ann, "GET", `/api/runs/${id}`)).json().canAnswer, name).toBeUndefined();
      }
      // a run a person started on the watched repository and flow can be answered here
      handRun("hand-run", { vars: { github_repo: "acme/app", issue: "7" } });
      expect((await call(s, ann, "GET", "/api/runs/hand-run")).json().canAnswer).toBe(true);
      expect((await answer(ann, "hand-run", "use B")).status).toBe(202);
    } finally {
      (s.ctx.config() as { watchers: unknown[] }).watchers.length = 0;
    }
  });

  it("says where to answer", async () => {
    (s.ctx.config() as { watchers: unknown[] }).watchers.push({ id: "w", enabled: true, source: "issues", github_repo: "acme/app", flow: "ask", label: "ready" });
    try {
      handRun("here-run");
      const ann1 = (await call(s, ann, "GET", "/api/runs/here-run")).json();
      expect(ann1.next.text).toBe("The planner has questions — answer the questions on the run page and it continues.");
      expect(ann1.next.where.url).toBe("#/runs/here-run");
      const listed = (await call(s, ann, "GET", "/api/runs")).json().find((r: { runId: string }) => r.runId === "here-run");
      expect(listed.next.text).toBe(ann1.next.text);
      expect(listed.next.who).toBe("You");
      expect((await call(s, admin, "GET", "/api/runs/here-run")).json().next.text).toContain("on the issue");
      handRun("w-run", { source: "watcher w issue #7", vars: { github_repo: "acme/app", issue: "7" } });
      expect((await call(s, ann, "GET", "/api/runs/w-run")).json().next.text).toContain("on the issue");
      handRun("hand-w", { vars: { github_repo: "acme/app", issue: "7" } });
      expect((await call(s, ann, "GET", "/api/runs/hand-w")).json().next.text).toContain("on the run page");
      handRun("nt-run", { flowDef: parseFlow(NO_TASK) });
      expect((await call(s, ann, "GET", "/api/runs/nt-run")).json().next.text).toContain("on the issue");
    } finally {
      (s.ctx.config() as { watchers: unknown[] }).watchers.length = 0;
    }
  });

  it("keeps the text out of queue.json, the audit log and the server log, and redacts stored secrets", async () => {
    const id = await startAsk(ann);
    const marker = "MARKER-7f3a9c";
    const r = await answer(ann, id, `use B ${marker}`);
    expect(r.status).toBe(202);
    await s.ctx.scheduler.idle();
    expect(audit()).not.toContain(marker);
    expect(logs.join("\n")).not.toContain(marker);
    const q = join(s.tmp, "home", "queue.json");
    if (existsSync(q)) expect(readFileSync(q, "utf8")).not.toContain(marker);
    expect(readFileSync(runFile(id), "utf8")).toContain(marker);
  });

  it("on one stream: canAnswer, then none while the resume is queued, then again when the run stops a second time", async () => {
    const id = await startAsk(ann);
    const ctl = new AbortController();
    const res = await fetch(`${s.base}/api/runs/${id}/events`, { headers: ann.headers(), signal: ctl.signal });
    const reader = res.body!.getReader();
    const updates: { status: string; canAnswer?: boolean; answers?: unknown[] }[] = [];
    let buf = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += new TextDecoder().decode(value);
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
            const m = /^event: update\ndata: (.*)$/m.exec(buf.slice(0, i));
            buf = buf.slice(i + 2);
            if (m) updates.push(JSON.parse(m[1]!).summary);
          }
        }
      } catch {
        // closed
      }
    })();
    const waitFor = async (fn: () => boolean) => {
      const end = Date.now() + 8000;
      while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      return fn();
    };
    try {
      expect(await waitFor(() => updates.length > 0)).toBe(true);
      expect(updates.at(-1)!.canAnswer).toBe(true);
      // two slow runs hold both slots, so the resume stays queued
      for (const task of ["t1", "t2"]) expect((await call(s, ann, "POST", "/api/runs", { flow: "slow", task })).status).toBe(201);
      expect((await answer(ann, id, "use B")).status).toBe(202);
      expect(s.ctx.scheduler.isQueued(id)).toBe(true);
      const n = updates.length;
      expect(await waitFor(() => updates.length > n)).toBe(true);
      expect(updates.at(-1)!.canAnswer).toBeUndefined();
      // the slots free up, the run resumes and stops with its second question
      expect(await waitFor(() => updates.at(-1)!.status === "stopped" && updates.at(-1)!.answers?.length === 1 && updates.at(-1)!.canAnswer === true)).toBe(true);
    } finally {
      ctl.abort();
      await pump;
    }
  });

  it("a stopped run's stream sends a new record when its issue turns out to be closed, and again when unknown", async () => {
    const id = await startAsk(ann);
    const file = runFile(id);
    const stored = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...stored, vars: { ...stored.vars, github_repo: "acme/app", issue: "7" } }));
    const ctl = new AbortController();
    const res = await fetch(`${s.base}/api/runs/${id}/events`, { headers: ann.headers(), signal: ctl.signal });
    const reader = res.body!.getReader();
    let text = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          text += new TextDecoder().decode(value);
        }
      } catch {
        // closed
      }
    })();
    const waitFor = async (fn: () => boolean) => {
      const end = Date.now() + 8000;
      while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      return fn();
    };
    try {
      saveIssueStates("acme/app", new Map([[7, "closed"]]));
      expect(await waitFor(() => text.includes('"kind":"issue_closed"'))).toBe(true);
      text = "";
      saveIssueStates("acme/app", new Map());
      markIssueCheckFailed("acme/app");
      expect(await waitFor(() => text.includes('"issueUnchecked":true'))).toBe(true);
    } finally {
      ctl.abort();
      await pump;
      dropIssueStates("acme/app");
    }
  });

  it("sends canAnswer in the list and on the stream", async () => {
    const id = await startAsk(ann);
    const list = (await call(s, ann, "GET", "/api/runs")).json() as { runId: string; canAnswer?: boolean }[];
    expect(list.find((x) => x.runId === id)?.canAnswer).toBe(true);
    const ctl = new AbortController();
    const res = await fetch(`${s.base}/api/runs/${id}/events`, { headers: ann.headers(), signal: ctl.signal });
    const reader = res.body!.getReader();
    let text = "";
    const end = Date.now() + 1500;
    try {
      while (Date.now() < end && !text.includes("canAnswer")) text += new TextDecoder().decode((await reader.read()).value);
    } catch {
      // closed
    }
    ctl.abort();
    expect(text).toContain('"canAnswer":true');
  });
});
