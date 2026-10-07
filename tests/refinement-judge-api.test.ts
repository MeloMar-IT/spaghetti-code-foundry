import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
import { DraftsSchema } from "../src/refinement/draft.js";
import { END_BAD_FORM, END_READY_CHANGED, endArchitectRun, getSession, refinementsPath } from "../src/refinement/store.js";
import { TALK_FIRST_LINE, readyOf } from "../src/refinement/talk-text.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeGit, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND"];

const serverOptions = (): ServerOptions => ({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 });

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-judge-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  delete process.env.FAKE_GH_SLEEP;
  delete process.env.FAKE_BRIEF;
  delete process.env.FAKE_ROUND;
  kc = fakeKeychain();
  started = await startServer(serverOptions());
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
const runsFolder = () => {
  try {
    return readdirSync(join(tmp, "runs")).sort();
  } catch {
    return [];
  }
};
const stored = () => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions as any[];
const whats = (s: any) => s.log.map((l: any) => l.what);
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;
const annRepo = () => listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;
const UNKNOWN = "00000000-0000-4000-8000-000000000000";

const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It exports a file" }] };
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];
/** What code leaves unsure for FULL with the default list, in the order of the list. */
const UNSURE = ["value", "standalone", "checkable", "small", "no-plan"];

/** A session with a draft; with a brief (one read of the code) unless `brief` is false. */
async function withDraft(fields: Record<string, unknown> = FULL, brief = true) {
  const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report as CSV" })).json().id as string;
  if (brief) {
    await call(ann, "POST", url(id, "architect"));
    await idle(id);
  }
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts[0].id as string;
  expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  return { id, did };
}
const check = (id: string, did: string, who = ann) => call(who, "POST", url(id, `drafts/${did}/ready-check`));
const review = (id: string, did: string) => call(ann, "POST", url(id, `drafts/${did}/review`));
const draftOf = async (id: string) => (await get(id)).drafts[0];
const itemsOf = (d: any) => Object.fromEntries(d.readiness.items.map((i: any) => [i.id, i]));
const storedItems = () => Object.fromEntries(stored()[0].drafts[0].readiness.items.map((i: any) => [i.id, i]));
const answer = (over: Record<string, any> = {}, ids = UNSURE) => ({ items: ids.map((id) => ({ id, result: "met", reason: "The draft makes this clear.", field: "what", ...(over[id] ?? {}) })) });

describe("becoming ready through the architect", () => {
  it("starts refine-round with ask=ready and the unsure items, stores the results by the architect, and the draft and the session are ready", async () => {
    const { id, did } = await withDraft();
    const r = await check(id, did);
    expect(r.status).toBe(202);
    const s = r.json();
    expect(s.architect).toMatchObject({ kind: "ready", draft: did });
    const run = runJson(s.architect.runId);
    expect(run).toMatchObject({ flow: "refine-round", vars: { github_repo: "acme/app", ask: "ready", items: UNSURE.join(",") } });
    expect(run.flowDef.limits.max_cost_usd).toBe(1);
    // the task names only the items code left unsure
    expect(run.task.split("\n")[0]).toBe(TALK_FIRST_LINE.ready);
    const asked = run.task.split("## The items to judge")[1];
    for (const item of UNSURE) expect(asked).toContain(`- ${item}: `);
    for (const item of ["out-of-scope", "no-open-questions"]) expect(asked).not.toContain(`- ${item}: `);
    const done = await idle(id);
    const items = itemsOf(done.drafts[0]);
    for (const item of UNSURE) expect(items[item]).toMatchObject({ by: "architect", result: "met", field: "what", reason: "The draft makes this clear." });
    expect(items["out-of-scope"]).toMatchObject({ by: "code", result: "met" });
    expect(items["no-open-questions"]).toMatchObject({ by: "code", result: "met" });
    expect(JSON.stringify(done.drafts[0].readiness)).not.toContain("about");
    expect(done.drafts[0].state).toBe("ready");
    expect(done.state).toBe("ready");
    expect(whats(done).slice(-3)).toEqual(["ready-checked", "ready-asked", "architect-judged"]);
    expect(done.log.at(-1).detail).toBe("5 met, 0 not met, 0 unsure");
  });

  it("stores each kind of result, and the draft stays drafting; no field and no accepted-anyway mark changes", async () => {
    const { id, did } = await withDraft();
    await check(id, did);
    await idle(id);
    // a second check replaces the first one with the results of code
    await call(ann, "PUT", url(id, `drafts/${did}`), { notes: "Keep it small" });
    await call(ann, "POST", url(id, `drafts/${did}/ready/value/accept`), { reason: "The epic says it" });
    const before = stored()[0].drafts[0];
    const crit = before.criteria[0].id;
    process.env.FAKE_ROUND = JSON.stringify(
      answer({
        value: { result: "met", field: "who" },
        standalone: { result: "unsure", reason: "Nothing says what it needs.", field: "dependsOn" },
        checkable: { result: "not-met", reason: "Nobody can tell when this is done.", field: "criteria", item: "C1" },
        small: { result: "met", field: "criteria" },
        "no-plan": { result: "not-met", reason: "The text says how to build it.", field: "what" },
      }),
    );
    const r = await check(id, did);
    expect(r.status).toBe(202);
    const done = await idle(id);
    const items = itemsOf(done.drafts[0]);
    expect(items.value).toMatchObject({ by: "architect", result: "met", field: "who" });
    expect(items.standalone).toMatchObject({ by: "architect", result: "unsure", field: "dependsOn", reason: "Nothing says what it needs." });
    expect(items.checkable).toMatchObject({ by: "architect", result: "not-met", field: "criteria", item: crit });
    expect(items["no-plan"]).toMatchObject({ by: "architect", result: "not-met" });
    expect(done.drafts[0].state).toBe("drafting");
    expect(done.state).toBe("drafting");
    expect(done.log.at(-1).detail).toBe("2 met, 2 not met, 1 unsure");
    // every result keeps the text it was about
    const kept = storedItems();
    expect(kept.value.about).toBe("an admin");
    expect(kept.standalone.about).toBe("(empty)");
    expect(kept.checkable.about).toBe("It exports a file");
    expect(kept.small.about).toBe("It exports a file");
    // only readiness changed
    const after = stored()[0].drafts[0];
    const { readiness: _a, ...fieldsAfter } = after;
    const { readiness: _b, ...fieldsBefore } = before;
    expect(fieldsAfter).toEqual(fieldsBefore);
    expect(after.acceptedAnyway).toEqual(before.acceptedAnyway);
    expect(after.acceptedAnyway).toHaveLength(1);
  });

  it("gives the architect only the items code left unsure, and keeps the result of code for the others", async () => {
    const { id, did } = await withDraft({ ...FULL, who: undefined });
    const r = await check(id, did);
    expect(r.status).toBe(202);
    const run = runJson(r.json().architect.runId);
    expect(run.vars.items).toBe("standalone,checkable,small,no-plan");
    const done = await idle(id);
    const items = itemsOf(done.drafts[0]);
    expect(items.value).toMatchObject({ by: "code", result: "not-met" });
    expect(items.value).not.toHaveProperty("field");
    expect(items.small).toMatchObject({ by: "architect", result: "met" });
    expect(done.drafts[0].state).toBe("drafting");
    expect(done.log.at(-1).detail).toBe("4 met, 0 not met, 0 unsure");
  });

  it("never overrules code, and checks the criterion, the reason and the form again", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    const r = await check(id, did);
    const runId = r.json().architect.runId as string;
    const refs = readyOf(runJson(runId).task)!.refs;
    const before = storedItems();
    const outText = before["out-of-scope"].text as string;
    const end = (judged: unknown, extra: [string, string][] = []) => endArchitectRun(id, runId, { judged, refs: { ...refs, items: [...refs.items, ...extra] } });
    const refused = (judged: unknown, extra: [string, string][] = []) => {
      end(judged, extra);
      expect(getSession(id)!.architect?.failed).toBe(END_BAD_FORM);
      expect(storedItems()).toEqual(before);
    };
    // an item code found met
    refused({ items: [...answer().items, { id: "out-of-scope", result: "unsure", reason: "Maybe.", field: "outOfScope" }] }, [["out-of-scope", outText]]);
    // a criterion that does not exist, an item on another field, other keys
    refused(answer({ checkable: { field: "criteria", item: "C999" } }));
    refused(answer({ checkable: { field: "what", item: "C1" } }));
    refused(answer({ checkable: { newText: "Do it differently." } }));
    refused({ ...answer(), implementationPlan: "Write src/a.ts." });
    // a sentence boundary behind a closing quote, as the check tool counts it, and a reason that is too long
    refused(answer({ checkable: { reason: "It is “fine.” It is not." } }));
    refused(answer({ checkable: { reason: `${"a".repeat(300)}b` } }));
    // a missing result, an unknown item, a result twice
    refused({ items: answer().items.slice(1) });
    refused(answer({}, [...UNSURE.slice(1), "nope"]));
    refused(answer({}, [...UNSURE.slice(1), "small"]));
    // a good answer is stored
    end(answer({ checkable: { field: "criteria", item: "C1", result: "not-met" } }));
    const done = getSession(id)!;
    expect(done.architect).toBeUndefined();
    expect(done.drafts[0]!.readiness!.items.find((i) => i.id === "checkable")).toMatchObject({ by: "architect", result: "not-met", item: done.drafts[0]!.criteria[0]!.id });
    expect(done.drafts[0]!.readiness!.items.find((i) => i.id === "out-of-scope")).toMatchObject({ by: "code", result: "met" });
    started!.ctx.scheduler.cancel(runId);
  });
});

describe("when code decides everything", () => {
  it("answers 200, needs no brief, starts no run", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const { id, did } = await withDraft(FULL, false);
    const before = runsFolder();
    const r = await check(id, did);
    expect(r.status).toBe(200);
    const d = r.json().drafts[0];
    expect(d.readiness.items.map((i: any) => [i.id, i.result, i.by])).toEqual([["out-of-scope", "met", "code"], ["no-open-questions", "met", "code"]]);
    expect(d.state).toBe("ready");
    expect(r.json().architect.state).toBe("idle");
    expect(runsFolder()).toEqual(before);
  });
});

describe("the rules of the other architect runs", () => {
  it("is refused for another user, an admin and an unknown draft; without a brief it answers 409 with the code results stored", async () => {
    const { id, did } = await withDraft();
    expect((await check(id, did, bob)).status).toBe(404);
    expect((await check(id, did, admin)).status).toBe(403);
    expect((await check(id, UNKNOWN)).status).toBe(404);
    const bare = await withDraft(FULL, false);
    const r = await check(bare.id, bare.did);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/look at the code first/);
    const d = (await get(bare.id)).drafts[0];
    expect(d.readiness.items).toHaveLength(7);
    expect(d.readiness.items.every((i: any) => i.by === "code")).toBe(true);
    expect((await get(bare.id)).architect.state).toBe("idle");
  });

  it("refuses a second run while one is live, also from another session", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    expect((await check(id, did)).status).toBe(202);
    expect((await check(id, did)).status).toBe(409);
    const other = await withDraft();
    expect((await check(other.id, other.did)).status).toBe(409);
    started!.ctx.scheduler.cancel((await get(id)).architect.runId);
    await failed(id);
  });

  it("resumes a paused check with the same call, and refuses another kind of ask meanwhile", async () => {
    const { id, did } = await withDraft({ ...FULL, title: "CLAUDE_LIMIT please" });
    const first = (await check(id, did)).json().architect.runId;
    await until(id, (s) => s.architect.state === "paused");
    const r = await review(id, did);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/paused while judging the readiness of a draft/);
    const again = await check(id, did);
    expect(again.status).toBe(202);
    expect(again.json().architect).toMatchObject({ runId: first, kind: "ready", draft: did });
    await until(id, (s) => s.architect.state === "paused");
    expect(runJson(first).resumes).toBe(1);
    expect(whats(await get(id))).toContain("architect-resumed");
  });

  it("does not resume a paused check when the draft changed meanwhile: the same call starts a new run", async () => {
    const { id, did } = await withDraft({ ...FULL, title: "CLAUDE_LIMIT please" });
    const first = (await check(id, did)).json().architect.runId;
    await until(id, (s) => s.architect.state === "paused");
    await call(ann, "PUT", url(id, `drafts/${did}`), { why: "to share it widely" });
    const again = await check(id, did);
    expect(again.status).toBe(202);
    expect(again.json().architect.runId).not.toBe(first);
    expect(runJson(first).status).toBe("cancelled");
    await until(id, (s) => s.architect.state === "paused");
  });

  it("cancels a paused check that code makes needless", async () => {
    const { id, did } = await withDraft({ ...FULL, title: "CLAUDE_LIMIT please" });
    await check(id, did);
    await until(id, (s) => s.architect.state === "paused");
    setRepoReady(annRepo().id, { items: LIST2 });
    const r = await check(id, did);
    expect(r.status).toBe(200);
    expect(r.json().architect).toMatchObject({ state: "failed", kind: "ready", reason: "It was cancelled" });
    expect(r.json().drafts[0].state).toBe("ready");
  });
});

describe("a failed or cancelled check", () => {
  it("changes nothing but the failure mark, and a new call starts a new run", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    const r = await check(id, did);
    const first = r.json().architect.runId;
    started!.ctx.scheduler.cancel(first);
    const s = await failed(id);
    expect(s.architect.reason).toBe("It was cancelled");
    expect(s.drafts[0].readiness.items.every((i: any) => i.by === "code")).toBe(true);
    expect(s.drafts[0].state).toBe("drafting");
    delete process.env.FAKE_GH_SLEEP;
    const again = await check(id, did);
    expect(again.status).toBe(202);
    expect(again.json().architect.runId).not.toBe(first);
    expect((await idle(id)).drafts[0].state).toBe("ready");
  });

  it("fails an answer that misses an item or breaks a limit with one plain sentence and stores nothing", async () => {
    const { id, did } = await withDraft();
    const code = storedItems;
    process.env.FAKE_ROUND = JSON.stringify(answer({ small: { reason: "SECRET one. Two." } }));
    await check(id, did);
    const s = await failed(id);
    expect(s.architect.reason).toBe(END_BAD_FORM);
    expect(JSON.stringify(s)).not.toContain("SECRET");
    expect(Object.values(code()).every((i: any) => i.by === "code")).toBe(true);
    process.env.FAKE_ROUND = JSON.stringify(answer({}, UNSURE.slice(1)));
    await check(id, did);
    expect((await failed(id)).architect.reason).toBe(END_BAD_FORM);
    expect(Object.values(code()).every((i: any) => i.by === "code")).toBe(true);
    expect(stored()[0].state).toBe("drafting");
  });
});

describe("a draft that changed while the architect judged", () => {
  it("drops the results: the run fails, the draft stays drafting, and the check has to be asked again", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await check(id, did);
    await call(ann, "PUT", url(id, `drafts/${did}`), { what: "to export it all" });
    delete process.env.FAKE_GH_SLEEP;
    const s = await failed(id);
    expect(s.architect.reason).toBe(END_READY_CHANGED);
    expect(s.drafts[0].readiness).toBeUndefined();
    expect(s.drafts[0].state).toBe("drafting");
    expect(stored()[0].drafts[0].readiness).toBeUndefined();
  });

  it("an old run does not judge the new code results: a check asked meanwhile answers 409 and the old run ends as failed", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await check(id, did);
    await call(ann, "PUT", url(id, `drafts/${did}`), { why: "to share it widely" });
    const again = await check(id, did);
    expect(again.status).toBe(409);
    expect((await draftOf(id)).readiness.items.every((i: any) => i.by === "code")).toBe(true);
    delete process.env.FAKE_GH_SLEEP;
    const s = await failed(id);
    expect(s.architect.reason).toBe(END_READY_CHANGED);
    expect(s.drafts[0].readiness.items.every((i: any) => i.by === "code")).toBe(true);
  });

  it("a criterion replaced by another with the same text is a change", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await check(id, did);
    await call(ann, "PUT", url(id, `drafts/${did}`), { criteria: [{ text: "It exports a file" }] });
    delete process.env.FAKE_GH_SLEEP;
    const s = await failed(id);
    expect(s.architect.reason).toBe(END_READY_CHANGED);
    expect(Object.values(storedItems()).every((i: any) => i.by === "code")).toBe(true);
  });

  it("a change of the map is a change", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_ROUND = JSON.stringify({ questions: [{ view: "need", text: "Who?", why: "w", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1 }], proposals: [{ list: "rule", text: "Only admins export." }], done: "" });
    await call(ann, "POST", url(id, "round"));
    const s = await idle(id);
    await call(ann, "POST", url(id, `proposals/${s.talk.proposals[0].id}/accept`));
    delete process.env.FAKE_ROUND;
    const entry = (await get(id)).talk.map.rules[0].id as string;
    process.env.FAKE_GH_SLEEP = "2";
    await check(id, did);
    expect((await call(ann, "PUT", url(id, `map/${entry}`), { text: "Only owners export." })).status).toBe(200);
    delete process.env.FAKE_GH_SLEEP;
    expect((await failed(id)).architect.reason).toBe(END_READY_CHANGED);
    expect(Object.values(storedItems()).every((i: any) => i.by === "code")).toBe(true);
  });

  it("an item the administrator reworded meanwhile gets no result: nothing is stored for it, nothing is counted, and the view says stale", async () => {
    const list = (small: string) => [{ id: "value", text: "the value is clear" }, { id: "small", text: small }];
    setRepoReady(annRepo().id, { items: list("it is small") });
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await check(id, did);
    setRepoReady(annRepo().id, { items: list("it is small enough to build in one go") });
    delete process.env.FAKE_GH_SLEEP;
    const done = await idle(id);
    const items = storedItems();
    expect(items.value).toMatchObject({ by: "architect", result: "met" });
    expect(items.small).toMatchObject({ by: "code", result: "unsure", text: "it is small" });
    expect(done.log.at(-1).detail).toBe("1 met, 0 not met, 0 unsure");
    expect(done.drafts[0].readiness.stale).toBe(true);
    expect(done.drafts[0].readiness.items.map((i: any) => i.id)).toEqual(["value"]);
    expect(done.drafts[0].state).toBe("drafting");
  });
});

describe("a run the session never recorded", () => {
  it("is taken in through the head lines of its task", async () => {
    const { id, did } = await withDraft();
    await check(id, did);
    await idle(id);
    started!.close();
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    f.sessions[0].drafts[0].readiness.items = f.sessions[0].drafts[0].readiness.items.map((i: any) =>
      i.by === "architect" ? { id: i.id, text: i.text, result: "unsure", reason: "The architect has to judge this.", by: "code" } : i,
    );
    f.sessions[0].state = "drafting";
    f.sessions[0].log = f.sessions[0].log.filter((l: any) => !["ready-asked", "architect-judged"].includes(l.what));
    f.sessions[0].updated = "2020-01-01T00:00:00.000Z";
    writeFileSync(refinementsPath(), JSON.stringify(f));
    started = await startServer(serverOptions());
    const s = await get(id);
    expect(s.architect.state).toBe("idle");
    expect(itemsOf(s.drafts[0]).small).toMatchObject({ by: "architect", result: "met" });
    expect(s.state).toBe("ready");
  });
});

describe("the file", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const draftWith = (item: Record<string, unknown>) => [{ id: UNKNOWN, criteria: [], dependsOn: [], readiness: { at, items: [{ id: "small", text: "it is small", result: "met", reason: "It is.", ...item }] } }];

  it("refuses a result of the architect without a field, a result of code with a field, and an item on another field", () => {
    expect(DraftsSchema.safeParse(draftWith({ by: "architect" })).success).toBe(false);
    expect(DraftsSchema.safeParse(draftWith({ by: "code", field: "what" })).success).toBe(false);
    expect(DraftsSchema.safeParse(draftWith({ by: "architect", field: "what", item: UNKNOWN })).success).toBe(false);
    expect(DraftsSchema.safeParse(draftWith({ by: "architect", field: "nope" })).success).toBe(false);
  });

  it("loads a result of code as before, and a result of the architect with its field, criterion and text", () => {
    expect(DraftsSchema.safeParse(draftWith({ by: "code" })).success).toBe(true);
    expect(DraftsSchema.safeParse(draftWith({ by: "architect", field: "criteria", item: UNKNOWN, about: "It exports" })).success).toBe(true);
    expect(DraftsSchema.safeParse(draftWith({ by: "architect", field: "dependsOn", about: "#12" })).success).toBe(true);
  });

  it("refuses a result of the architect without the text it was about", () => {
    expect(DraftsSchema.safeParse(draftWith({ by: "architect", field: "dependsOn" })).success).toBe(false);
  });
});
