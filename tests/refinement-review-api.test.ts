import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { END_BAD_FORM, refinementsPath } from "../src/refinement/store.js";
import { TALK_FIRST_LINE } from "../src/refinement/talk-text.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const RULE = "Only admins export.";

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND"];

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-review-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  delete process.env.FAKE_GH_SLEEP;
  delete process.env.FAKE_BRIEF;
  delete process.env.FAKE_ROUND;
  kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
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
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (id: string, who = ann) => (await call(who, "GET", `/api/refinement/${id}`)).json();
async function until(id: string, test: (s: any) => boolean) {
  for (let i = 0; i < 300; i++) {
    const s = await get(id);
    if (test(s)) return s;
    await wait(100);
  }
  throw new Error(`timed out: ${JSON.stringify((await get(id)).architect)}`);
}
const idle = (id: string) => until(id, (s) => s.architect.state === "idle");
const failed = (id: string) => until(id, (s) => s.architect.state === "failed");
const runJson = (runId: string) => JSON.parse(readFileSync(join(tmp, "runs", runId, "run.json"), "utf8"));
const runsFolder = () => readdirSync(join(tmp, "runs")).sort();
const stored = () => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions as any[];
const whats = (s: any) => s.log.map((l: any) => l.what);
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;

/** A session with a brief and one draft; `fields` are saved into it. */
async function withDraft(fields: Record<string, unknown> = { title: "Export", what: "to export a report", why: "to share it", criteria: [{ text: "It exports a file" }, { text: "It opens fast" }] }) {
  const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report as CSV" })).json().id as string;
  await call(ann, "POST", url(id, "architect"));
  await idle(id);
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts[0].id as string;
  if (fields) expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  return { id, did };
}
const review = (id: string, did: string, who = ann) => call(who, "POST", url(id, `drafts/${did}/review`));
const move = (id: string, did: string, body: unknown, who = ann) => call(who, "POST", url(id, `drafts/${did}/move-to-notes`), body);
const draftOf = async (id: string) => (await get(id)).drafts[0];

describe("the remarks of the code checks", () => {
  it("come with GET and PUT, and a draft with only notes has none", async () => {
    const { id, did } = await withDraft(null as never);
    const put = await call(ann, "PUT", url(id, `drafts/${did}`), { what: "a fast export", criteria: [{ text: "It calls src/a.ts" }] });
    const d = put.json().drafts[0];
    expect(d.remarks).toEqual([
      { field: "what", kind: "vague", word: "fast", text: expect.any(String) },
      { field: "criteria", item: d.criteria[0].id, kind: "plan", word: "src/a.ts", text: expect.stringContaining("belongs in the build step") },
    ]);
    expect((await draftOf(id)).remarks).toEqual(d.remarks);
    const notes = (await call(ann, "PUT", url(id, `drafts/${did}`), { what: null, criteria: [], notes: "fast, easy, src/a.ts" })).json().drafts[0];
    expect(notes.remarks).toEqual([]);
  });

  it("are not stored, and a save starts no run", async () => {
    const { id, did } = await withDraft();
    const before = runsFolder();
    const s = (await call(ann, "PUT", url(id, `drafts/${did}`), { why: "to share it fast" })).json();
    expect(s.architect.state).toBe("idle");
    expect(runsFolder()).toEqual(before);
    expect(stored()[0].drafts[0].remarks).toBeUndefined();
  });
});

describe("review", () => {
  it("starts refine-round with ask=review and a limit of $1, stores the review without changing a field, and logs it", async () => {
    const { id, did } = await withDraft();
    await call(ann, "PUT", url(id, `drafts/${did}`), { notes: "Keep it small" });
    const fields = (await draftOf(id)) as any;
    const r = await review(id, did);
    expect(r.status).toBe(202);
    const s = r.json();
    expect(s.architect).toMatchObject({ kind: "review", draft: did });
    expect(s.architect.field).toBeUndefined();
    const run = runJson(s.architect.runId);
    expect(run).toMatchObject({ flow: "refine-round", vars: { github_repo: "acme/app", ask: "review" } });
    expect(run.vars.field).toBe("");
    expect(run.flowDef.limits.max_cost_usd).toBe(1);
    expect(run.task.split("\n")[0]).toBe(TALK_FIRST_LINE.review);
    for (const part of ["Export a report as CSV", "## The context brief", "## The map of the story so far", "## The draft to review", "to export a report", "C1: It exports a file"]) expect(run.task).toContain(part);
    const done = await idle(id);
    const d = done.drafts[0];
    expect(d.review.remarks).toEqual([
      { field: "criteria", item: fields.criteria[0].id, kind: "uncheckable", text: "Nobody can tell when this is met." },
      { field: "what", kind: "how", text: "This says how to build it." },
    ]);
    expect(JSON.stringify(d.review)).not.toContain("about");
    const { review: _r, ...rest } = d;
    const { review: _o, ...before } = fields;
    expect(rest).toEqual(before);
    expect(whats(done).slice(-2)).toEqual(["review-asked", "architect-reviewed"]);
    expect(done.log.at(-1).detail).toBe("2");
  });

  it("stores all five kinds, and a second review replaces the first", async () => {
    const { id, did } = await withDraft();
    const kinds = ["uncheckable", "vague", "contradiction", "how", "plan"];
    process.env.FAKE_ROUND = JSON.stringify({ remarks: kinds.map((kind) => ({ field: kind === "uncheckable" ? "criteria" : "why", ...(kind === "uncheckable" ? { item: "C1" } : {}), kind, text: `A ${kind} remark.` })) });
    await review(id, did);
    expect((await idle(id)).drafts[0].review.remarks.map((r: any) => r.kind)).toEqual(kinds);
    process.env.FAKE_ROUND = JSON.stringify({ remarks: [{ field: "title", kind: "vague", text: "Only one." }] });
    await review(id, did);
    expect((await idle(id)).drafts[0].review.remarks).toEqual([{ field: "title", kind: "vague", text: "Only one." }]);
  });

  it("marks a remark stale when its text changed, also while the review ran", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await review(id, did);
    await call(ann, "PUT", url(id, `drafts/${did}`), { what: "to export it all" });
    delete process.env.FAKE_GH_SLEEP;
    const done = await idle(id);
    const byField = Object.fromEntries(done.drafts[0].review.remarks.map((r: any) => [r.field, r]));
    expect(byField.what.stale).toBe(true);
    expect(byField.criteria.stale).toBeUndefined();
    await call(ann, "PUT", url(id, `drafts/${did}`), { criteria: [{ text: "Another" }] });
    const after = (await draftOf(id)).review.remarks;
    expect(after.find((r: any) => r.field === "criteria").stale).toBe(true);
    expect(after.every((r: any) => r.stale)).toBe(true);
  });

  it("leaves the draft as it was when the run fails or is cancelled", async () => {
    const { id, did } = await withDraft();
    await review(id, did);
    await idle(id);
    process.env.FAKE_ROUND = "this is not JSON";
    await review(id, did);
    const s = await failed(id);
    expect(s.architect.reason).toBe(END_BAD_FORM);
    expect(s.drafts[0].review.remarks).toHaveLength(2);
    process.env.FAKE_ROUND = JSON.stringify({ remarks: Array.from({ length: 3 }, () => ({ field: "why", kind: "vague", text: "One. Two. Three." })) });
    await review(id, did);
    expect((await failed(id)).architect.reason).toBe(END_BAD_FORM);
    delete process.env.FAKE_ROUND;
    process.env.FAKE_GH_SLEEP = "20";
    const r = await review(id, did);
    started!.ctx.scheduler.cancel(r.json().architect.runId);
    expect((await failed(id)).architect.reason).toBe("It was cancelled");
    expect((await draftOf(id)).review.remarks).toHaveLength(2);
  });

  it("is refused for another user, an admin, a missing brief, an empty draft, and an unknown draft", async () => {
    const { id, did } = await withDraft();
    expect((await review(id, did, bob)).status).toBe(404);
    expect((await review(id, did, admin)).status).toBe(403);
    expect((await review(id, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const empty = await withDraft(null as never);
    const r = await review(empty.id, empty.did);
    expect(r.status).toBe(409);
    expect(r.error()).toBe("write something in the draft first");
    const bare = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Another" })).json().id as string;
    const d2 = (await call(ann, "POST", url(bare, "drafts"))).json().drafts[0].id;
    await call(ann, "PUT", url(bare, `drafts/${d2}`), { title: "T" });
    expect((await review(bare, d2)).status).toBe(409);
    expect((await get(id)).architect.state).toBe("idle");
  });

  it("refuses a second run while one is live, also from another session", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    expect((await review(id, did)).status).toBe(202);
    expect((await review(id, did)).status).toBe(409);
    const other = await withDraft();
    expect((await review(other.id, other.did)).status).toBe(409);
    started!.ctx.scheduler.cancel((await get(id)).architect.runId);
    await failed(id);
  });

  it("resumes a paused review with the same call, and refuses another draft", async () => {
    const { id, did } = await withDraft({ title: "CLAUDE_LIMIT please", what: "to export" });
    const first = (await review(id, did)).json().architect.runId;
    await until(id, (s) => s.architect.state === "paused");
    const d2 = (await call(ann, "POST", url(id, "drafts"))).json().drafts[1].id;
    await call(ann, "PUT", url(id, `drafts/${d2}`), { title: "Other" });
    expect((await review(id, d2)).status).toBe(409);
    expect((await call(ann, "POST", url(id, `drafts/${did}/suggest`), { field: "who" })).status).toBe(409);
    const r = await review(id, did);
    expect(r.status).toBe(202);
    expect(r.json().architect).toMatchObject({ runId: first, kind: "review", draft: did });
    await until(id, (s) => s.architect.state === "paused");
    expect(runJson(first).resumes).toBe(1);
  });

  it("takes in a review run the session never recorded, through the head lines of its task", async () => {
    const { id, did } = await withDraft();
    await review(id, did);
    await idle(id);
    started!.close();
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete f.sessions[0].drafts[0].review;
    f.sessions[0].log = f.sessions[0].log.filter((l: any) => !["review-asked", "architect-reviewed"].includes(l.what));
    f.sessions[0].updated = "2020-01-01T00:00:00.000Z";
    writeFileSync(refinementsPath(), JSON.stringify(f));
    const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
    started = await startServer(opts);
    const s = await get(id);
    expect(s.architect.state).toBe("idle");
    expect(s.drafts[0].review.remarks).toHaveLength(2);
  });
});

describe("move to notes", () => {
  it("moves a text with a plan remark to the notes as a wish, with its record", async () => {
    const { id, did } = await withDraft({ what: "to edit src/a.ts", criteria: [{ text: "It calls saveDraft()" }, { text: "It exports" }] });
    const d = await draftOf(id);
    const r = await move(id, did, { field: "what" });
    expect(r.status).toBe(200);
    const after = r.json().drafts[0];
    expect(after.what).toBeUndefined();
    expect(after.notes).toEqual({ text: "Wish: to edit src/a.ts", from: "typed" });
    expect(after.remarks.map((x: any) => x.kind)).toEqual(["plan"]);
    expect(r.json().log.at(-1)).toMatchObject({ what: "moved-to-notes", detail: "what" });
    const c = await move(id, did, { field: "criteria", item: d.criteria[0].id });
    expect(c.json().drafts[0].criteria.map((x: any) => x.text)).toEqual(["It exports"]);
    expect(c.json().drafts[0].notes.text).toBe("Wish: to edit src/a.ts\nWish: It calls saveDraft()");
  });

  it("moves a text with a fresh how remark from the review, and the review shows it stale", async () => {
    const { id, did } = await withDraft();
    await review(id, did);
    await idle(id);
    const r = await move(id, did, { field: "what" });
    expect(r.status).toBe(200);
    expect(r.json().drafts[0].notes.text).toBe("Wish: to export a report");
    expect(r.json().drafts[0].review.remarks.find((x: any) => x.field === "what").stale).toBe(true);
  });

  it("is refused without a remark, and for others", async () => {
    const { id, did } = await withDraft();
    const r = await move(id, did, { field: "what" });
    expect(r.status).toBe(409);
    expect(r.error()).toBe("only a text with a remark that it says how to build can be moved to the notes");
    expect((await move(id, did, { field: "notes" })).status).toBe(400);
    expect((await move(id, did, { field: "who" })).status).toBe(404);
    expect((await move(id, did, { field: "what" }, bob)).status).toBe(404);
    expect((await move(id, did, { field: "what" }, admin)).status).toBe(403);
    expect((await draftOf(id)).notes).toBeUndefined();
  });
});

describe("the map", () => {
  it("is in the task of the review", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_ROUND = JSON.stringify({ questions: [{ view: "need", text: "Who?", why: "w", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1 }], proposals: [{ list: "rule", text: RULE }], done: "" });
    await call(ann, "POST", url(id, "round"));
    const s = await idle(id);
    await call(ann, "POST", url(id, `proposals/${s.talk.proposals[0].id}/accept`));
    delete process.env.FAKE_ROUND;
    const r = await review(id, did);
    expect(runJson(r.json().architect.runId).task).toContain(`- ${RULE}`);
    await idle(id);
  });
});
