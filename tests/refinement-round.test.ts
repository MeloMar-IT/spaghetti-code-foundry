import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
import { END_BAD_FORM, refinementsPath } from "../src/refinement/store.js";
import { TALK_FIRST_LINE } from "../src/refinement/talk-text.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const FOUND = "The README is found (README.md).";
const MARKER = "MARKERWORD";

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND"];

async function boot() {
  const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
}

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-round-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  delete process.env.FAKE_GH_SLEEP;
  delete process.env.FAKE_BRIEF;
  delete process.env.FAKE_ROUND;
  kc = fakeKeychain();
  await boot();
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  addRepo(bob.user.id, { url: "other/thing", method: "github-token", token: TOKEN });
});
afterEach(async () => {
  if (!started?.ctx.scheduler.draining) await started?.ctx.scheduler.idle();
  started?.close();
  started = undefined;
  kc.remove();
  gh.restore();
  for (const k of ENV) if (saved[k] === undefined) delete process.env[k];
  rmSync(tmp, { recursive: true, force: true });
});

async function call(who: TestSession, method: string, path: string, body?: unknown) {
  const send = () =>
    fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // After a restart the first call may find the old connection closed.
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const make = async (who = ann, repo = "acme/app", idea = "Export a report as CSV") => (await call(who, "POST", "/api/refinement", { repo, idea })).json().id as string;
const brief = (id: string, who = ann) => call(who, "POST", `/api/refinement/${id}/architect`);
const round = (id: string, who = ann) => call(who, "POST", `/api/refinement/${id}/round`);
const ask = (id: string, question?: unknown, who = ann) => call(who, "POST", `/api/refinement/${id}/ask`, question === undefined ? {} : { question });
const get = async (id: string, who = ann) => (await call(who, "GET", `/api/refinement/${id}`)).json();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(id: string, test: (s: any) => boolean, who = ann) {
  for (let i = 0; i < 300; i++) {
    const s = await get(id, who);
    if (test(s)) return s;
    await wait(100);
  }
  throw new Error(`timed out: ${JSON.stringify((await get(id, who)).architect)}`);
}
const idle = (id: string, who = ann) => until(id, (s) => s.architect.state === "idle", who);
const failed = (id: string) => until(id, (s) => s.architect.state === "failed");
const paused = (id: string) => until(id, (s) => s.architect.state === "paused");
const running = (id: string) => until(id, (s) => s.architect.state === "running");
const runDir = (runId: string) => join(tmp, "runs", runId);
const runJson = (runId: string) => JSON.parse(readFileSync(join(runDir(runId), "run.json"), "utf8"));
const runIds = () => (existsSync(join(tmp, "runs")) ? readdirSync(join(tmp, "runs")) : []);
const dropRepo = () => removeRepo(ann.user.id, listRepos(ann.user.id).find((r) => r.url.includes("acme/app"))!.id);
const stored = () => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions as any[];
const whats = (s: any) => s.log.map((l: any) => l.what);
const q = (i: number) => ({ view: "need", text: `Question ${i}?`, why: "It matters.", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1 });

/** A session with a context brief. */
async function withBrief(idea?: string, who = ann) {
  const id = await make(who, "acme/app", idea);
  await brief(id, who);
  await idle(id, who);
  return id;
}
/** A session with a brief and one round of 3 questions (not answered). */
async function withRound(idea?: string) {
  const id = await withBrief(idea);
  expect((await round(id)).status).toBe(202);
  return idle(id).then(() => id);
}
const answerAll = async (id: string) => {
  const questions = (await get(id)).talk.rounds.at(-1).questions;
  const forms = [{ option: 1 }, { text: "My own answer" }, { unknown: true }];
  for (const [i, qq] of questions.entries()) expect((await call(ann, "POST", `/api/refinement/${id}/questions/${qq.id}/answer`, forms[i % 3])).status).toBe(200);
};
/** The view without ids and times: what a restart must give back. */
const norm = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (k === "id" || k === "at" ? undefined : x)));
const logOf = (s: any) => s.log.map((l: any) => ({ what: l.what, detail: l.detail, list: l.list }));
const talkAndLog = (s: any) => ({ talk: norm(s.talk), log: logOf(s) });

describe("a round from a session", () => {
  it("starts refine-round with ask=round, stores the questions and proposals, and logs them", async () => {
    const id = await withBrief();
    const r = await round(id);
    expect(r.status).toBe(202);
    const s = r.json();
    expect(s.architect.kind).toBe("round");
    expect(runJson(s.architect.runId)).toMatchObject({ flow: "refine-round", source: `refinement ${id}`, owner: ann.user.id, vars: { github_repo: "acme/app", ask: "round" } });
    const done = await idle(id);
    expect(done.talk.rounds).toHaveLength(1);
    expect(done.talk.rounds[0].questions).toHaveLength(3);
    expect(done.talk.proposals).toHaveLength(1);
    expect(whats(done).slice(3)).toEqual(["round-started", "question", "question", "question", "architect-round"]);
    expect(stored()[0].architect).toBeUndefined();
  });

  it("a second round carries the answers and gets proposals", async () => {
    const id = await withRound();
    await answerAll(id);
    const r = await round(id);
    expect(r.status).toBe(202);
    const done = await idle(id);
    const task: string = runJson(r.json().architect.runId).task;
    expect(task.startsWith(TALK_FIRST_LINE.round)).toBe(true);
    expect(task).toContain("## The context brief\n## What already exists");
    expect(task.match(/^New answer: /gm)).toHaveLength(3);
    expect(task).toContain("New answer: option 1: Everyone");
    expect(task).toContain("New answer: my own answer: My own answer");
    expect(task).toContain("New answer: I don't know yet");
    expect(done.talk.rounds).toHaveLength(2);
    expect(done.talk.proposals).toHaveLength(2);
  });

  it("stores at most 5 questions when the architect asks 6", async () => {
    const id = await withBrief();
    process.env.FAKE_ROUND = JSON.stringify({ questions: [1, 2, 3, 4, 5, 6].map(q), proposals: [], done: "" });
    await round(id);
    const done = await idle(id);
    expect(done.talk.rounds[0].questions).toHaveLength(5);
    expect(whats(done).filter((w: string) => w === "question")).toHaveLength(5);
  });

  it("stores the done sentence when nothing important is left, and accepts a further round", async () => {
    const id = await withBrief();
    process.env.FAKE_ROUND = JSON.stringify({ questions: [], proposals: [], done: "Nothing important is left." });
    await round(id);
    const done = await idle(id);
    expect(done.talk.rounds[0]).toMatchObject({ questions: [], done: "Nothing important is left." });
    expect(done.log.find((l: any) => l.what === "round-done").detail).toBe("Nothing important is left.");
    delete process.env.FAKE_ROUND;
    expect((await round(id)).status).toBe(202);
    await idle(id);
  });

  it("can be asked again and again", async () => {
    const id = await withRound();
    for (let i = 0; i < 2; i++) {
      await answerAll(id);
      expect((await round(id)).status).toBe(202);
      await idle(id);
    }
    expect((await get(id)).talk.rounds).toHaveLength(3);
  });
});

describe("an own question", () => {
  it("logs the question when the run starts and stores the answer when it succeeds", async () => {
    const id = await withBrief();
    const r = await ask(id, "Where is the README?");
    expect(r.status).toBe(202);
    expect(r.json().architect.kind).toBe("question");
    expect(r.json().log.at(-1)).toMatchObject({ what: "asked", detail: "Where is the README?" });
    expect(runJson(r.json().architect.runId).vars.ask).toBe("question");
    const done = await idle(id);
    expect(done.talk.asked).toMatchObject([{ question: "Where is the README?", answer: FOUND }]);
    expect(whats(done).slice(-2)).toEqual(["asked", "architect-answered"]);
    expect(done.log.at(-1).detail).toBe(FOUND);
  });

  it("works on a new session with no brief and no talk", async () => {
    const id = await make();
    expect((await ask(id, "What is this?")).status).toBe(202);
    const done = await idle(id);
    expect(done.talk.asked[0]).toMatchObject({ question: "What is this?", answer: FOUND });
    expect(done.brief).toBeUndefined();
  });
});

describe("refusals", () => {
  it("a round needs a brief, and an answer to every question of the last round", async () => {
    const id = await make();
    const r = await round(id);
    expect([r.status, r.error()]).toEqual([409, "ask the architect to look at the code first"]);
    await brief(id);
    await idle(id);
    await round(id);
    await idle(id);
    const open = await round(id);
    expect(open.status).toBe(409);
    expect(open.error()).toBe('answer every question of the last round first; "I don\'t know yet" is an answer');
    expect(runIds()).toHaveLength(2);
  });

  it("is refused while a brief read runs, and from another session of the account", async () => {
    const a = await make();
    const b = await make();
    process.env.FAKE_GH_SLEEP = "1";
    await brief(a);
    await running(a);
    for (const id of [a, b]) {
      expect((await round(id)).status).toBe(409);
      expect((await ask(id, "Why?")).status).toBe(409);
    }
    expect(runIds()).toHaveLength(1);
    await idle(a);
  });

  it("is refused for another user (404), an admin (403) and an unknown session (404)", async () => {
    const id = await withBrief();
    const before = runIds();
    expect((await round(id, bob)).status).toBe(404);
    expect((await ask(id, "Why?", bob)).status).toBe(404);
    expect((await round(id, admin)).status).toBe(403);
    expect((await ask(id, "Why?", admin)).status).toBe(403);
    const none = "00000000-0000-4000-8000-000000000000";
    expect((await round(none, admin)).status).toBe(404);
    expect((await ask(none, "Why?", admin)).status).toBe(404);
    expect(runIds()).toEqual(before);
  });

  it("is refused for a dropped session and a removed repository (409)", async () => {
    const id = await withBrief();
    const before = runIds();
    dropRepo();
    expect((await round(id)).status).toBe(409);
    expect((await ask(id, "Why?")).status).toBe(409);
    addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    await call(ann, "POST", `/api/refinement/${id}/drop`);
    expect((await round(id)).status).toBe(409);
    expect((await ask(id, "Why?")).status).toBe(409);
    expect(runIds()).toEqual(before);
  });

  it("refuses a bad question (400)", async () => {
    const id = await make();
    for (const bad of [undefined, "", "   ", "x".repeat(2001), 5]) expect((await ask(id, bad)).status).toBe(400);
    expect(runIds()).toEqual([]);
  });
});

describe("a run that does not end well", () => {
  it("a failed run keeps the talk, says why, and a new round works after", async () => {
    const id = await withRound();
    await answerAll(id);
    const before = (await get(id)).talk;
    process.env.FAKE_ROUND = "Just some words";
    await round(id);
    const s = await failed(id);
    expect(s.architect).toMatchObject({ kind: "round", reason: END_BAD_FORM });
    expect(s.talk).toEqual(before);
    delete process.env.FAKE_ROUND;
    expect((await round(id)).status).toBe(202);
    expect((await idle(id)).talk.rounds).toHaveLength(2);
  });

  it("a cancelled run says so and changes nothing in the talk", async () => {
    const id = await withRound();
    await answerAll(id);
    const before = (await get(id)).talk;
    process.env.FAKE_GH_SLEEP = "2";
    const { architect } = (await round(id)).json();
    await running(id);
    expect((await call(ann, "POST", `/api/runs/${architect.runId}/cancel`)).json()).toEqual({ cancelled: true });
    const s = await failed(id);
    expect(s.architect.reason).toBe("It was cancelled");
    expect(s.talk).toEqual(before);
  });

  it("a paused round is resumed by the same call, in the same run; the other calls are refused", async () => {
    const id = await withRound();
    const questions = (await get(id)).talk.rounds[0].questions;
    const forms = [{ option: 1 }, { text: "CLAUDE_LIMIT please" }, { option: 2 }];
    for (const [i, qq] of questions.entries()) await call(ann, "POST", `/api/refinement/${id}/questions/${qq.id}/answer`, forms[i]);
    const first = (await round(id)).json().architect.runId;
    const s = await paused(id);
    expect(s.architect).toMatchObject({ kind: "round", runId: first, reason: "The usage limit was reached; ask again later" });
    expect((await ask(id, "Why?")).status).toBe(409);
    expect((await brief(id)).status).toBe(409);
    const r = await round(id);
    expect(r.status).toBe(202);
    expect(r.json().architect.runId).toBe(first);
    await paused(id);
    expect(runJson(first).resumes).toBe(1);
  });

  it("a paused question is resumed by /ask with no body", async () => {
    const id = await withBrief();
    const first = (await ask(id, "CLAUDE_LIMIT please")).json().architect.runId;
    expect((await paused(id)).architect).toMatchObject({ kind: "question", runId: first });
    const r = await ask(id);
    expect(r.status).toBe(202);
    expect(r.json().architect.runId).toBe(first);
    await paused(id);
    expect(runJson(first).resumes).toBe(1);
  });
});

describe("restart", () => {
  /** Closes the server, puts the session back as it was just after the call, and boots. */
  async function restartWith(session: any) {
    started!.close();
    const file = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    file.sessions[0] = session;
    writeFileSync(refinementsPath(), JSON.stringify(file));
    await boot();
  }

  it("takes in a round that ended while the server was down", async () => {
    const id = await withRound();
    await answerAll(id);
    const before = stored()[0];
    const r = await round(id);
    const after = await idle(id);
    const start = after.log[before.log.length];
    expect(start.what).toBe("round-started");
    await restartWith({ ...before, architect: { runId: r.json().architect.runId, at: start.at, kind: "round" }, updated: start.at, log: [...before.log, { at: start.at, by: ann.user.id, what: start.what, detail: start.detail }] });
    const again = await idle(id);
    expect(talkAndLog(again)).toEqual(talkAndLog(after));
    expect(again.talk.rounds).toHaveLength(2);
    expect(again.talk.proposals).toHaveLength(2);
  });

  it("takes in a question that ended while the server was down", async () => {
    const id = await withBrief();
    const before = stored()[0];
    const r = await ask(id, "Where is the README?");
    const after = await idle(id);
    const start = after.log[before.log.length];
    expect(start.what).toBe("asked");
    await restartWith({ ...before, architect: { runId: r.json().architect.runId, at: start.at, kind: "question", question: "Where is the README?" }, updated: start.at, log: [...before.log, { at: start.at, by: ann.user.id, what: start.what, detail: start.detail }] });
    expect(talkAndLog(await idle(id))).toEqual(talkAndLog(after));
  });

  it("takes in a round the session never recorded", async () => {
    const id = await withRound();
    await answerAll(id);
    const before = stored()[0];
    await round(id);
    const after = await idle(id);
    await restartWith({ ...before, updated: "2020-01-01T00:00:00.000Z" });
    expect(talkAndLog(await idle(id))).toEqual(talkAndLog(after));
  });

  it("takes in a question the session never recorded, with its text and answer", async () => {
    const id = await withBrief();
    const before = stored()[0];
    await ask(id, "Where is the README?\nAnd more 😀");
    const after = await idle(id);
    await restartWith({ ...before, updated: "2020-01-01T00:00:00.000Z" });
    const again = await idle(id);
    expect(talkAndLog(again)).toEqual(talkAndLog(after));
    expect(again.talk.asked[0].question).toBe("Where is the README?\nAnd more 😀");
  });
});

describe("drop and delete", () => {
  it("cancels a running round when the session is dropped", async () => {
    const id = await withBrief();
    process.env.FAKE_GH_SLEEP = "2";
    const { architect } = (await round(id)).json();
    await running(id);
    expect((await call(ann, "POST", `/api/refinement/${id}/drop`)).status).toBe(200);
    for (let i = 0; i < 100 && runJson(architect.runId).status === "running"; i++) await wait(100);
    expect(runJson(architect.runId).status).toBe("cancelled");
  });

  it("cancels a running question when the account is deleted", async () => {
    const id = await withBrief();
    process.env.FAKE_GH_SLEEP = "2";
    const { architect } = (await ask(id, "Why?")).json();
    await running(id);
    expect((await call(admin, "DELETE", `/api/users/${ann.user.id}`)).status).toBe(200);
    for (let i = 0; i < 100 && runJson(architect.runId).status === "running"; i++) await wait(100);
    expect(runJson(architect.runId).status).toBe("cancelled");
  });
});

describe("what a user sees of the task", () => {
  const eventsText = async (runId: string) => {
    const res = await fetch(`${base}/api/runs/${runId}/events`, { headers: ann.headers() });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes('"status":"succeeded"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    return text;
  };

  it("is one line in the queue while the job waits", async () => {
    const id = await withBrief(`Export ${MARKER} as CSV`);
    started!.ctx.scheduler.drain();
    const { architect } = (await round(id)).json();
    expect(architect.state).toBe("queued");
    const queue = await call(ann, "GET", "/api/queue");
    expect(queue.json().pending[0]).toMatchObject({ runId: architect.runId, task: TALK_FIRST_LINE.round });
    expect(queue.text).not.toContain(MARKER);
  });

  it("is one line in the Runs list, on the run page and on the event stream", async () => {
    const id = await withBrief(`Export ${MARKER} as CSV`);
    process.env.FAKE_GH_SLEEP = "1";
    const { architect } = (await round(id)).json();
    const events = await eventsText(architect.runId);
    await idle(id);
    const list = await call(ann, "GET", "/api/runs");
    const mine = list.json().find((r: any) => r.runId === architect.runId);
    expect(mine).toMatchObject({ refinement: id, flow: "refine-round", task: TALK_FIRST_LINE.round });
    const one = await call(ann, "GET", `/api/runs/${architect.runId}`);
    expect(one.json().task).toBe(TALK_FIRST_LINE.round);
    expect(events).toContain(`"task":"${TALK_FIRST_LINE.round}"`);
    // (the brief run of the same session keeps its task, the idea)
    for (const text of [JSON.stringify(mine), one.text, events]) expect(text).not.toContain(MARKER);
    expect((await call(admin, "GET", `/api/runs/${architect.runId}`)).json().task).toContain(MARKER);
  });

  it("the run is not on the board or in Your turn", async () => {
    const id = await withBrief();
    const { architect } = (await round(id)).json();
    await idle(id);
    expect((await call(admin, "GET", "/api/board")).text).not.toContain(architect.runId);
    expect((await call(admin, "GET", "/api/your-turn")).text).not.toContain(architect.runId);
  });
});
