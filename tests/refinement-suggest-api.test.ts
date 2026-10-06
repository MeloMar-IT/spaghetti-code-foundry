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
  tmp = mkdtempSync(join(tmpdir(), "refinement-suggest-"));
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
const stored = () => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions as any[];
const whats = (s: any) => s.log.map((l: any) => l.what);
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;

/** A session with a brief and one draft. */
async function withDraft() {
  const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report as CSV" })).json().id as string;
  await call(ann, "POST", url(id, "architect"));
  await idle(id);
  const s = (await call(ann, "POST", url(id, "drafts"))).json();
  return { id, did: s.drafts[0].id as string };
}
/** A session with a rule in the map (one accepted proposal), a brief and one draft. */
async function withRule() {
  const { id, did } = await withDraft();
  process.env.FAKE_ROUND = JSON.stringify({ questions: [{ view: "need", text: "Who?", why: "w", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1 }], proposals: [{ list: "rule", text: RULE }], done: "" });
  await call(ann, "POST", url(id, "round"));
  const s = await idle(id);
  await call(ann, "POST", url(id, `proposals/${s.talk.proposals[0].id}/accept`));
  delete process.env.FAKE_ROUND;
  return { id, did, rule: (await get(id)).talk.map.rules[0].id as string };
}
const suggest = (id: string, did: string, field: unknown, who = ann) => call(who, "POST", url(id, `drafts/${did}/suggest`), { field });
const draftOf = async (id: string) => (await get(id)).drafts[0];

describe("suggest", () => {
  it("starts refine-round with ask=suggest and a limit of $1, stores the suggestion and logs it", async () => {
    const { id, did } = await withDraft();
    const r = await suggest(id, did, "title");
    expect(r.status).toBe(202);
    const s = r.json();
    expect(s.architect).toMatchObject({ kind: "suggest", draft: did, field: "title" });
    const run = runJson(s.architect.runId);
    expect(run).toMatchObject({ flow: "refine-round", vars: { github_repo: "acme/app", ask: "suggest", field: "title" } });
    expect(run.flowDef.limits.max_cost_usd).toBe(1);
    expect(run.task.split("\n")[0]).toBe(TALK_FIRST_LINE.suggest);
    const done = await idle(id);
    expect(done.drafts[0].suggestions).toMatchObject([{ field: "title", text: "A suggested title" }]);
    expect(done.drafts[0].title).toBeUndefined();
    expect(done.drafts[0].preview.title).toBe("");
    expect(whats(done).slice(-2)).toEqual(["suggestion-asked", "architect-suggested"]);
    expect(done.log.at(-2).detail).toBe("title");
  });

  it("stores suggestions beside the draft, never in a field, and a new run replaces the waiting ones", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "who");
    await idle(id);
    await suggest(id, did, "what");
    const s = await idle(id);
    expect(s.drafts[0].suggestions.map((x: any) => x.field)).toEqual(["who", "what"]);
    await suggest(id, did, "who");
    const again = await idle(id);
    expect(again.drafts[0].suggestions.map((x: any) => x.field).sort()).toEqual(["what", "who"]);
    expect(again.drafts[0].who).toBeUndefined();
  });

  it("answers 409 for criteria when the map has no rule and no example", async () => {
    const { id, did } = await withDraft();
    const r = await suggest(id, did, "criteria");
    expect(r.status).toBe(409);
    expect(r.error()).toBe("there is no rule and no example in the map yet; ask for a round of questions and accept some entries first");
    expect((await get(id)).architect.state).toBe("idle");
  });

  it("ties a criterion to its rule and leaves out the one whose example is not in the map", async () => {
    const { id, did, rule } = await withRule();
    expect((await suggest(id, did, "criteria")).status).toBe(202);
    const s = await idle(id);
    expect(s.drafts[0].suggestions).toMatchObject([{ field: "criteria", text: "The export downloads a CSV file.", tie: rule }]);
  }, 30_000);

  it("suggests depends on: an issue, and no other draft when there is none", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "dependsOn");
    const s = await idle(id);
    expect(s.drafts[0].suggestions).toMatchObject([{ field: "dependsOn", issue: 12 }]);
  });

  it("accepts a suggestion: the text goes into the field as accepted, and the suggestion is gone", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "title");
    const sid = (await idle(id)).drafts[0].suggestions[0].id;
    const r = await call(ann, "POST", url(id, `drafts/${did}/suggestions/${sid}/accept`), {});
    expect(r.status).toBe(200);
    const d = r.json().drafts[0];
    expect(d.title).toEqual({ text: "A suggested title", from: "accepted" });
    expect(d.suggestions).toBeUndefined();
    expect(d.preview.title).toBe("A suggested title");
    expect(whats(r.json()).at(-1)).toBe("suggestion-accepted");
    expect(r.json().log.at(-1).detail).toBe("title");
  });

  it("edits and accepts: the text is the person's, recorded as accepted-edited", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "what");
    const sid = (await idle(id)).drafts[0].suggestions[0].id;
    const r = await call(ann, "POST", url(id, `drafts/${did}/suggestions/${sid}/accept`), { text: "my own words" });
    expect(r.json().drafts[0].what).toEqual({ text: "my own words", from: "accepted-edited" });
  });

  it("rejects with a reason, keeps it with the draft, and the next task holds it", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "why");
    const sid = (await idle(id)).drafts[0].suggestions[0].id;
    const r = await call(ann, "POST", url(id, `drafts/${did}/suggestions/${sid}/reject`), { reason: "too vague" });
    expect(r.status).toBe(200);
    expect(r.json().drafts[0].suggestions).toBeUndefined();
    expect(r.json().drafts[0].why).toBeUndefined();
    expect(stored()[0].drafts[0].rejected).toEqual([{ field: "why", text: "A suggested why", reason: "too vague" }]);
    expect(whats(r.json()).at(-1)).toBe("suggestion-rejected");
    const next = await suggest(id, did, "why");
    const task = runJson(next.json().architect.runId).task as string;
    expect(task).toContain("why: A suggested why — reason: too vague");
    await idle(id);
  });

  it("rejects without a reason, and refuses a reason that is too long", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "notes");
    const sid = (await idle(id)).drafts[0].suggestions[0].id;
    expect((await call(ann, "POST", url(id, `drafts/${did}/suggestions/${sid}/reject`), { reason: "x".repeat(301) })).status).toBe(400);
    expect((await call(ann, "POST", url(id, `drafts/${did}/suggestions/${sid}/reject`), {})).status).toBe(200);
    expect(stored()[0].drafts[0].rejected).toEqual([{ field: "notes", text: "A suggested notes" }]);
  });

  it("leaves everything as it was when the run fails", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_ROUND = "this is not JSON";
    await suggest(id, did, "title");
    const s = await failed(id);
    expect(s.architect.reason).toBe(END_BAD_FORM);
    expect(s.drafts[0].suggestions).toBeUndefined();
    expect(s.drafts[0].title).toBeUndefined();
  });

  it("leaves everything as it was when the run is cancelled", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    const r = await suggest(id, did, "title");
    started!.ctx.scheduler.cancel(r.json().architect.runId);
    const s = await failed(id);
    expect(s.architect.reason).toBe("It was cancelled");
    expect(s.drafts[0].suggestions).toBeUndefined();
  });

  it("is refused for another user, an admin, a missing brief, a bad field, and an unknown draft", async () => {
    const { id, did } = await withDraft();
    expect((await suggest(id, did, "title", bob)).status).toBe(404);
    expect((await suggest(id, did, "title", admin)).status).toBe(403);
    expect((await suggest(id, did, "colour")).status).toBe(400);
    expect((await suggest(id, did, undefined)).status).toBe(400);
    expect((await suggest(id, "00000000-0000-4000-8000-000000000000", "title")).status).toBe(404);
    const bare = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Another" })).json().id as string;
    const d2 = (await call(ann, "POST", url(bare, "drafts"))).json().drafts[0].id;
    const r = await suggest(bare, d2, "title");
    expect(r.status).toBe(409);
  });

  it("refuses a second run while one is live, also from another session", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    expect((await suggest(id, did, "title")).status).toBe(202);
    expect((await suggest(id, did, "who")).status).toBe(409);
    const other = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Other" })).json().id as string;
    const d2 = (await call(ann, "POST", url(other, "drafts"))).json().drafts[0].id;
    expect((await suggest(other, d2, "title")).status).toBe(409);
    started!.ctx.scheduler.cancel((await get(id)).architect.runId);
    await failed(id);
  });

  it("refuses accept and reject for others, unknown suggestions, and a text for depends on", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "dependsOn");
    const sid = (await idle(id)).drafts[0].suggestions[0].id;
    const p = (who: TestSession, what: string, s = sid, body: unknown = {}) => call(who, "POST", url(id, `drafts/${did}/suggestions/${s}/${what}`), body);
    expect((await p(bob, "accept")).status).toBe(404);
    expect((await p(admin, "accept")).status).toBe(403);
    expect((await p(ann, "reject", "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await p(ann, "accept", sid, { text: "#12" })).status).toBe(400);
    const ok = await p(ann, "accept");
    expect(ok.status).toBe(200);
    expect(ok.json().drafts[0].dependsOn).toMatchObject([{ issue: 12, from: "accepted" }]);
  });

  it("resumes a paused suggestion with the same call, and refuses another field", async () => {
    const { id, did } = await withDraft();
    await call(ann, "PUT", url(id, `drafts/${did}`), { title: "CLAUDE_LIMIT please" });
    const first = (await suggest(id, did, "who")).json().architect.runId;
    await until(id, (s) => s.architect.state === "paused");
    expect((await suggest(id, did, "what")).status).toBe(409);
    expect((await call(ann, "POST", url(id, "round"))).status).toBe(409);
    const r = await suggest(id, did, "who");
    expect(r.status).toBe(202);
    expect(r.json().architect).toMatchObject({ runId: first, kind: "suggest", field: "who" });
    await until(id, (s) => s.architect.state === "paused");
    expect(runJson(first).resumes).toBe(1);
  });

  it("marks a paused suggestion failed when its draft is removed, and starts a new round", async () => {
    const { id, did } = await withDraft();
    await call(ann, "PUT", url(id, `drafts/${did}`), { title: "CLAUDE_LIMIT please" });
    const first = (await suggest(id, did, "who")).json().architect.runId;
    await until(id, (s) => s.architect.state === "paused");
    expect((await call(ann, "DELETE", url(id, `drafts/${did}`))).status).toBe(200);
    expect((await suggest(id, did, "who")).status).toBe(404);
    const r = await call(ann, "POST", url(id, "round"));
    expect(r.status).toBe(202);
    expect(r.json().architect.runId).not.toBe(first);
    expect(r.json().log.map((l: any) => l.what)).toContain("architect-failed");
    expect(runJson(first).status).toBe("cancelled");
  });

  it("takes in a suggestion run the session never recorded, with the ties read through the ids line", async () => {
    const { id, did, rule } = await withRule();
    await suggest(id, did, "criteria");
    await idle(id);
    started!.close();
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete f.sessions[0].drafts[0].suggestions;
    f.sessions[0].log = f.sessions[0].log.filter((l: any) => !["suggestion-asked", "architect-suggested"].includes(l.what));
    f.sessions[0].updated = "2020-01-01T00:00:00.000Z";
    writeFileSync(refinementsPath(), JSON.stringify(f));
    const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
    started = await startServer(opts);
    const s = await get(id);
    expect(s.architect.state).toBe("idle");
    expect(s.drafts[0].suggestions).toMatchObject([{ field: "criteria", tie: rule }]);
  });

  it("hides the suggestions while the repository is not the user's", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "title");
    await idle(id);
    removeRepo(ann.user.id, listRepos(ann.user.id).find((r) => r.url.includes("acme/app"))!.id);
    const s = await get(id);
    expect(s.draftsHidden).toBe(true);
    expect(s.drafts).toBeUndefined();
    expect(existsSync(join(tmp, "runs")) ? readdirSync(join(tmp, "runs")).length : 0).toBeGreaterThan(0);
  });

  it("shows a user one line of the task in the Runs list", async () => {
    const { id, did } = await withDraft();
    await suggest(id, did, "title");
    await idle(id);
    const mine = ((await call(ann, "GET", "/api/runs")).json() as any[]).filter((r) => r.flow === "refine-round");
    expect(mine).toHaveLength(1);
    expect(mine[0].task).toBe(TALK_FIRST_LINE.suggest);
  });
});
