import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRepoReady } from "../src/auth/repos.js";
import { addRepoWatcher } from "../src/repos/watchers.js";
import { STUCK_FAILED } from "../src/refinement/change-request.js";
import { GitHubStore } from "../src/stories/github-store.js";
import { openWorld, type World } from "./helpers/refinement-world.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let w: World;
const ENV = ["FAKE_SIMPLE_ROUND", "FAKE_UNDERSTAND", "FAKE_GH_FAIL_ON"];

beforeEach(async () => {
  for (const k of ENV) delete process.env[k];
  w = await openWorld("changes-api");
  setRepoReady(w.annRepo().id, { items: [{ id: "out-of-scope", text: "it says what is out of scope" }] });
});
afterEach(async () => {
  for (const k of ENV) delete process.env[k];
  await w.close();
});

const watch = () => {
  addRepoWatcher(w.annRepo().id, { id: "app-w", label: "Factory_go" });
  w.started.ctx.watchers.sync();
  w.gh.setLabels(["Factory_go"]);
};
const card = (title: string, dependsOn: number[] = []) => ({ title, who: "A lead", what: `Do ${title}`, why: "Because.", criteria: ["It works."], outOfScope: "", dependsOn, summary: `This is what I understood: ${title}` });
const NO_QUESTIONS = JSON.stringify({ questions: [], proposals: [], done: "All clear." });
const post = (path: string, body: unknown = {}, who = w.ann) => w.call(who, "POST", `/api/changes${path}`, body);
const read = async (id: string, who = w.ann) => (await w.call(who, "GET", `/api/changes/${id}`)).json();
async function until(id: string, state: string): Promise<any> {
  for (let i = 0; i < 300; i++) {
    const v = await read(id);
    if (v.state === state) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`never ${state}: ${JSON.stringify(await read(id))}`);
}
async function start(text = "Let me export a report as CSV") {
  const r = await post("", { repo: "acme/app", text });
  expect(r.status).toBe(202);
  expect(r.json().state).toBe("thinking");
  return r.json().id as string;
}
const plain = (v: unknown) => {
  const t = JSON.stringify(v);
  for (const bad of ["runId", "cost", "model", "labels", "Factory_go"]) expect(t).not.toContain(bad);
};
const edits = (n: number) => w.gh.ghLog().split("\n").filter((l) => l.startsWith(`gh issue edit ${n} `) && l.includes("--add-label"));

describe("one change from start to build, on GitHub", () => {
  it("asks its question, writes the cards from the answers, and builds", async () => {
    watch();
    const id = await start();
    const q = await until(id, "questions");
    plain(q);
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0]).toMatchObject({ text: "Who will use this change?", options: ["Everyone", "Only admins"] });
    // The round was asked in plain words, by itself.
    const session = (await w.call(w.ann, "GET", `/api/refinement/${id}`)).json();
    expect(w.runJson(session.talk.rounds[0].runId).vars).toMatchObject({ ask: "round", words: "simple" });

    expect((await post(`/${id}/build`)).status).toBe(409); // not before the answers
    const a = await post(`/${id}/answers`, { answers: [{ question: q.questions[0].id, option: 1 }] });
    expect(a.status).toBe(202);
    const cards = await until(id, "cards");
    plain(cards);
    expect(cards.cards).toHaveLength(1);
    expect(cards.cards[0]).toMatchObject({ title: "Export a report", criteria: ["The export downloads a CSV file."] });
    expect(cards.cards[0].understood).toMatch(/^This is what I understood: /);
    expect((await post(`/${id}/answers`, { answers: [] })).status).toBe(409);

    const b = await post(`/${id}/build`);
    expect(b.status).toBe(200);
    expect(b.json()).toMatchObject({ state: "planned", building: true });
    plain(b.json());
    expect(w.gh.bugIssues()).toHaveLength(1);
    expect(w.gh.bugIssues()[0]!.labels.map((l) => l.name)).toEqual(["Factory_go"]);
    expect(w.gh.bugIssues()[0]!.body).not.toContain("### Pictures");
    // A second call writes nothing.
    const before = w.gh.ghLog();
    expect((await post(`/${id}/build`)).json().state).toBe("planned");
    expect(w.gh.ghLog()).toBe(before);
    expect((await post(`/${id}/later`)).json().building).toBe(true);
  });

  it("describes a picture in words and uploads nothing", async () => {
    watch();
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    const sentence = "The screen shows a report table with a red total.";
    process.env.FAKE_UNDERSTAND = JSON.stringify({ drafts: [card("First")], pictures: [sentence] });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("a picture body that is long enough")]);
    const r = await post("", { repo: "acme/app", text: "Let me export a report as CSV", pictures: [png.toString("base64")] });
    expect(r.status).toBe(202);
    const id = r.json().id as string;
    await until(id, "cards");
    expect((await post(`/${id}/build`)).status).toBe(200);
    const body = w.gh.bugIssues()[0]!.body as string;
    expect(body).toContain("### Pictures");
    expect(body).toContain("added 1 picture");
    expect(body).toContain(sentence);
    expect(body).not.toContain("pictures/");
    expect(body).not.toContain("](");
    expect(body).not.toContain(png.toString("base64"));
    const log = w.gh.ghLog();
    expect(log).not.toContain(png.toString("base64"));
    expect(log).not.toMatch(/gh (gist|release|upload)|upload/);
  });

  it("makes the GitHub store refuse files without calling gh", async () => {
    const before = w.gh.ghLog();
    await expect(new GitHubStore("acme/app").create({ title: "t", body: "b", labels: [], files: [{ name: "pictures/0123456789abcdef/1.png", from: "/x" }] })).rejects.toThrow("nothing was uploaded");
    expect(w.gh.ghLog()).toBe(before);
  });

  it("goes straight to the cards when the round has no questions", async () => {
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    const id = await start();
    const v = await until(id, "cards");
    const s = (await w.call(w.ann, "GET", `/api/refinement/${id}`)).json();
    expect(s.talk.rounds[0].questions).toEqual([]);
    expect(s.talk.log?.some?.((l: any) => l.what === "answered") ?? false).toBe(false);
    expect(v.cards).toHaveLength(1);
  });

  it("splits into cards, edits one, keeps them for later and builds them afterwards", async () => {
    watch();
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    process.env.FAKE_UNDERSTAND = JSON.stringify({ drafts: [card("First"), card("Second", [1]), card("Third", [1, 2])] });
    const id = await start();
    const v = await until(id, "cards");
    expect(v.cards.map((c: any) => c.title)).toEqual(["First", "Second", "Third"]);

    const put = await w.call(w.ann, "PUT", `/api/changes/${id}/cards/${v.cards[0].id}`, { title: "First, renamed", criteria: ["It works.", "It is fast."] });
    expect(put.status).toBe(200);
    expect(put.json().cards[0]).toMatchObject({ title: "First, renamed", criteria: ["It works.", "It is fast."] });
    expect((await w.call(w.ann, "PUT", `/api/changes/${id}/cards/${v.cards[0].id}`, { title: " " })).status).toBe(400);
    expect((await w.call(w.ann, "PUT", `/api/changes/${id}/cards/${v.cards[0].id}`, { other: 1 })).status).toBe(400);
    expect((await w.call(w.ann, "PUT", `/api/changes/${id}/cards/${id}`, { title: "x" })).status).toBe(404);

    const later = await post(`/${id}/later`);
    expect(later.status).toBe(200);
    expect(later.json()).toMatchObject({ state: "planned", building: false });
    const made = w.gh.bugIssues();
    expect(made.map((i) => i.title)).toEqual(["First, renamed", "Second", "Third"]);
    expect(made.every((i) => i.labels.length === 0)).toBe(true);
    expect(made[2]!.body).toMatch(/#101/);
    expect(made[2]!.body).toMatch(/#102/);
    expect((await w.call(w.ann, "PUT", `/api/changes/${id}/cards/${v.cards[1].id}`, { title: "again" })).status).toBe(409);
    expect(w.gh.ghLog()).not.toContain("--add-label");

    const b = await post(`/${id}/build`);
    expect(b.json()).toMatchObject({ state: "planned", building: true });
    for (const n of [101, 102, 103]) expect(edits(n)).toHaveLength(1);
    expect(w.gh.bugIssues().every((i) => i.labels.some((l) => l.name === "Factory_go"))).toBe(true);
  });

  it("labels each card once when a build stops halfway", async () => {
    watch();
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    process.env.FAKE_UNDERSTAND = JSON.stringify({ drafts: [card("First"), card("Second", [1]), card("Third", [1, 2])] });
    const id = await start();
    await until(id, "cards");
    expect((await post(`/${id}/later`)).status).toBe(200);
    process.env.FAKE_GH_FAIL_ON = "edit 102";
    const failed = await post(`/${id}/build`);
    expect(failed.status).toBe(502);
    expect(failed.error()).toContain("#101 got a label");
    delete process.env.FAKE_GH_FAIL_ON;
    // The state is still `planned` without a build: the person can try again.
    expect((await read(id)).building).toBe(false);
    const ok = await post(`/${id}/build`);
    expect(ok.json()).toMatchObject({ state: "planned", building: true });
    // #101 once; #102 twice (the first call failed); #103 once.
    expect([101, 102, 103].map((n) => edits(n).length)).toEqual([1, 2, 1]);
    expect(w.gh.bugIssues().every((i) => i.labels.filter((l) => l.name === "Factory_go").length === 1)).toBe(true);
  });

  it("does not label a story that is closed", async () => {
    watch();
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    process.env.FAKE_UNDERSTAND = JSON.stringify({ drafts: [card("First"), card("Second")] });
    const id = await start();
    await until(id, "cards");
    await post(`/${id}/later`);
    w.gh.setBugIssues(w.gh.bugIssues().map((i) => (i.number === 101 ? { ...i, state: "closed" as const } : i)));
    expect((await post(`/${id}/build`)).json().building).toBe(true);
    expect(edits(101)).toHaveLength(0);
    expect(edits(102)).toHaveLength(1);
  });

  it("publishes the titled cards and leaves an untitled draft out", async () => {
    watch();
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    const id = await start();
    await until(id, "cards");
    expect((await w.call(w.ann, "POST", `/api/refinement/${id}/drafts`)).status).toBe(201);
    const v = await read(id);
    expect(v.cards).toHaveLength(1);
    expect((await post(`/${id}/build`)).json().state).toBe("planned");
    expect(w.gh.bugIssues()).toHaveLength(1);
  });

  it("refuses a build without a watcher, and a build label the repository lacks, with nothing written", async () => {
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    const id = await start();
    await until(id, "cards");
    expect((await post(`/${id}/build`)).status).toBe(409);
    addRepoWatcher(w.annRepo().id, { id: "app-w", label: "Factory_go" });
    w.started.ctx.watchers.sync();
    w.gh.setLabels(["bug"]);
    expect((await post(`/${id}/build`)).status).toBe(409);
    expect(w.gh.bugIssues()).toHaveLength(0);
    expect((await read(id)).state).toBe("cards");
  });
});

describe("a failed run", () => {
  it("is stuck, and a retry goes on", async () => {
    process.env.FAKE_SIMPLE_ROUND = NO_QUESTIONS;
    process.env.FAKE_UNDERSTAND = JSON.stringify({ drafts: [] });
    const id = await start();
    const v = await until(id, "stuck");
    expect(v.reason).toBe(STUCK_FAILED);
    plain(v);
    expect((await post(`/${id}/build`)).status).toBe(409);
    delete process.env.FAKE_UNDERSTAND;
    const r = await post(`/${id}/retry`);
    expect(r.status).toBe(202);
    expect((await until(id, "cards")).cards).toHaveLength(1);
    expect((await post(`/${id}/retry`)).status).toBe(409);
  });
});

describe("who may do what", () => {
  it("refuses bad bodies", async () => {
    expect((await post("", { repo: "acme/app" })).status).toBe(400);
    expect((await post("", { repo: "acme/app", text: "   " })).status).toBe(400);
    expect((await post("", { repo: "acme/app", text: "x".repeat(10_001) })).status).toBe(400);
    expect((await post("", { repo: "acme/app", text: "x", extra: 1 })).status).toBe(400);
    expect((await post("", { text: "x" })).status).toBe(400);
    expect((await post("", { repo: "acme/app", text: "x".repeat(10_000) })).status).toBe(202);
  });

  it("keeps a change request to its owner and its project to the owner", async () => {
    expect((await post("", { repo: "acme/app", text: "x" }, w.bob)).status).toBe(403);
    const id = await start();
    expect((await w.call(w.bob, "GET", `/api/changes/${id}`)).status).toBe(404);
    expect((await w.call(w.admin, "GET", `/api/changes/${id}`)).status).toBe(403);
    expect((await post(`/${id}/later`, {}, w.bob)).status).toBe(404);
    expect((await post(`/${id}/later`, {}, w.admin)).status).toBe(403);
    expect((await post(`/${id}/retry`, {}, w.bob)).status).toBe(404);
  });

  it("lists only your change requests on that repository", async () => {
    const id = await start();
    await w.call(w.ann, "POST", "/api/refinement", { repo: "acme/app", idea: "An ordinary session" });
    expect((await w.call(w.ann, "GET", "/api/changes")).status).toBe(400);
    const list = (await w.call(w.ann, "GET", "/api/changes?repo=acme/app")).json();
    expect(list.changes.map((c: any) => c.id)).toEqual([id]);
    plain(list);
    expect((await w.call(w.bob, "GET", "/api/changes?repo=acme/app")).json().changes).toEqual([]);
    // An ordinary session is not a change request.
    const other = (await w.call(w.ann, "GET", "/api/refinement")).json().sessions.find((s: any) => s.id !== id);
    expect((await w.call(w.ann, "GET", `/api/changes/${other.id}`)).status).toBe(404);
  });

  it("checks the answers before it writes any", async () => {
    const id = await start();
    const q = await until(id, "questions");
    const qid = q.questions[0].id;
    for (const answers of [[], [{ question: qid }], [{ question: qid, option: 9 }], [{ question: "nope", option: 1 }], [{ question: qid, option: 1 }, { question: qid, option: 2 }], [{ question: qid, option: 1, extra: 1 }]]) {
      expect((await post(`/${id}/answers`, { answers })).status, JSON.stringify(answers)).toBe(400);
    }
    expect((await post(`/${id}/answers`, { answers: [{ question: qid, option: 1 }], more: 1 })).status).toBe(400);
    expect((await read(id)).state).toBe("questions");
    expect((await post(`/${id}/answers`, { answers: [{ question: qid, unknown: true }] })).status).toBe(202);
    await until(id, "cards");
  });
});
