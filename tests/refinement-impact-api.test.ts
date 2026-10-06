import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
import { addRepoWatcher, updateRepoWatcher } from "../src/repos/watchers.js";
import { END_NO_IMPACT_DRAFT } from "../src/refinement/draft-impact.js";
import { END_BAD_FORM, refinementsPath } from "../src/refinement/store.js";
import { TALK_FIRST_LINE } from "../src/refinement/talk-text.js";
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
let annRepoId: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND"];
const opts = (): ServerOptions => ({ repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 });

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  for (const k of ENV) saved[k] = process.env[k];
  tmp = mkdtempSync(join(tmpdir(), "refinement-impact-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  delete process.env.FAKE_GH_SLEEP;
  delete process.env.FAKE_BRIEF;
  delete process.env.FAKE_ROUND;
  kc = fakeKeychain();
  started = await startServer(opts());
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  annRepoId = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN }).id;
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
const impact = (id: string, did: string, who = ann) => call(who, "POST", url(id, `drafts/${did}/impact`));
const draftOf = async (id: string, i = 0) => (await get(id)).drafts[i];
const answer = (over: Record<string, unknown> = {}) => ({
  areas: [{ area: "README.md", files: ["README.md"], basis: "found", why: "It is documented here." }],
  dependsOn: [],
  dependents: [],
  risks: [{ kind: "users", basis: "estimate", text: "People see a new button." }],
  size: { size: "small", files: 2, lines: 40, why: "One page and its test." },
  overlaps: [],
  sensitive: [],
  ...over,
});

describe("impact", () => {
  it("starts refine-round with ask=impact and a limit of $3, stores the view without changing a field, and logs it", async () => {
    const { id, did } = await withDraft();
    const fields = await draftOf(id);
    const r = await impact(id, did);
    expect(r.status).toBe(202);
    const s = r.json();
    expect(s.architect).toMatchObject({ kind: "impact", draft: did });
    const run = runJson(s.architect.runId);
    expect(run).toMatchObject({ flow: "refine-round", vars: { github_repo: "acme/app", ask: "impact" } });
    expect(run.flowDef.limits.max_cost_usd).toBe(3);
    expect(run.task.split("\n")[0]).toBe(TALK_FIRST_LINE.impact);
    expect(run.task).toContain(`Draft: ${did}`);
    const done = await idle(id);
    const d = done.drafts[0];
    expect(d.impact.areas[0].basis).toBe("found");
    expect(d.impact.risks[0].basis).toBe("estimate");
    expect(d.impact.size).toMatchObject({ size: "small", basis: "estimate" });
    expect(d.impact.mark).toBeUndefined();
    expect(d.impact.outOfDate).toBeUndefined();
    const { impact: _i, ...rest } = d;
    expect(rest).toEqual(fields);
    expect(done.state).toBe("drafting");
    expect(whats(done).slice(-2)).toEqual(["impact-asked", "architect-impact"]);
    expect(done.log.at(-1).detail).toBe("small");
  });

  it("stores a link to D2 as the id of the second draft", async () => {
    const { id, did } = await withDraft();
    const d2 = (await call(ann, "POST", url(id, "drafts"))).json().drafts[1].id;
    process.env.FAKE_ROUND = JSON.stringify(answer({ dependents: [{ draft: "D2", basis: "estimate", why: "It builds on this." }, { draft: "D7", basis: "estimate", why: "Not there." }] }));
    await impact(id, did);
    const d = (await idle(id)).drafts[0];
    expect(d.impact.dependents).toEqual([{ draft: d2, basis: "estimate", why: "It builds on this." }]);
  });

  it("goes out of date after an edit, also one made while the run was active", async () => {
    const { id, did } = await withDraft();
    await impact(id, did);
    await idle(id);
    await call(ann, "PUT", url(id, `drafts/${did}`), { notes: "Keep it small" });
    expect((await draftOf(id)).impact.outOfDate).toBeUndefined();
    await call(ann, "PUT", url(id, `drafts/${did}`), { why: "to know" });
    expect((await draftOf(id)).impact.outOfDate).toBe(true);
    const fresh = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await impact(fresh.id, fresh.did);
    await call(ann, "PUT", url(fresh.id, `drafts/${fresh.did}`), { what: "to export it all" });
    delete process.env.FAKE_GH_SLEEP;
    expect((await idle(fresh.id)).drafts[0].impact.outOfDate).toBe(true);
  });

  it("fails with the agreed sentence for a bad form and keeps the old view", async () => {
    const { id, did } = await withDraft();
    await impact(id, did);
    await idle(id);
    const { size: _s, ...noSize } = answer();
    process.env.FAKE_ROUND = JSON.stringify(noSize);
    await impact(id, did);
    const s = await failed(id);
    expect(s.architect.reason).toBe(END_BAD_FORM);
    expect(s.drafts[0].impact.size.size).toBe("small");
  });

  it("fails when the draft is removed while the run is active", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "2";
    await impact(id, did);
    expect((await call(ann, "DELETE", url(id, `drafts/${did}`))).status).toBe(200);
    delete process.env.FAKE_GH_SLEEP;
    expect((await failed(id)).architect.reason).toBe(END_NO_IMPACT_DRAFT);
  });

  it("is refused for another user, an admin, a missing brief, an empty draft, and an unknown draft", async () => {
    const { id, did } = await withDraft();
    expect((await impact(id, did, bob)).status).toBe(404);
    expect((await impact(id, did, admin)).status).toBe(403);
    expect((await impact(id, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const empty = await withDraft(null as never);
    const r = await impact(empty.id, empty.did);
    expect(r.status).toBe(409);
    expect(r.error()).toBe("write something in the draft first");
    const bare = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Another" })).json().id as string;
    const d2 = (await call(ann, "POST", url(bare, "drafts"))).json().drafts[0].id;
    await call(ann, "PUT", url(bare, `drafts/${d2}`), { title: "T" });
    expect((await impact(bare, d2)).status).toBe(409);
    expect((await get(id)).architect.state).toBe("idle");
  });

  it("refuses a second run while one is live, also from another session", async () => {
    const { id, did } = await withDraft();
    process.env.FAKE_GH_SLEEP = "20";
    expect((await impact(id, did)).status).toBe(202);
    expect((await impact(id, did)).status).toBe(409);
    const other = await withDraft();
    expect((await impact(other.id, other.did)).status).toBe(409);
    started!.ctx.scheduler.cancel((await get(id)).architect.runId);
    await failed(id);
  });

  it("resumes a paused run with the same call, and refuses another draft, a review and a suggestion", async () => {
    const { id, did } = await withDraft({ title: "CLAUDE_LIMIT please", what: "to export" });
    const first = (await impact(id, did)).json().architect.runId;
    await until(id, (s) => s.architect.state === "paused");
    const d2 = (await call(ann, "POST", url(id, "drafts"))).json().drafts[1].id;
    await call(ann, "PUT", url(id, `drafts/${d2}`), { title: "Other" });
    expect((await impact(id, d2)).status).toBe(409);
    expect((await call(ann, "POST", url(id, `drafts/${did}/review`))).status).toBe(409);
    expect((await call(ann, "POST", url(id, `drafts/${did}/suggest`), { field: "who" })).status).toBe(409);
    const r = await impact(id, did);
    expect(r.status).toBe(202);
    expect(r.json().architect).toMatchObject({ runId: first, kind: "impact", draft: did });
    await until(id, (s) => s.architect.state === "paused");
    expect(runJson(first).resumes).toBe(1);
  });

  it("takes in an impact run the session never recorded, through the head lines of its task", async () => {
    const { id, did } = await withDraft();
    await impact(id, did);
    await idle(id);
    started!.close();
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete f.sessions[0].drafts[0].impact;
    f.sessions[0].log = f.sessions[0].log.filter((l: any) => !["impact-asked", "architect-impact"].includes(l.what));
    f.sessions[0].updated = "2020-01-01T00:00:00.000Z";
    writeFileSync(refinementsPath(), JSON.stringify(f));
    started = await startServer(opts());
    const s = await get(id);
    expect(s.architect.state).toBe("idle");
    expect(s.drafts[0].impact.size.size).toBe("small");
  });

  it("is not shown while the repository is not in My repositories", async () => {
    const { id, did } = await withDraft();
    await impact(id, did);
    await idle(id);
    removeRepo(ann.user.id, listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!.id);
    const s = await get(id);
    expect(s.draftsHidden).toBe(true);
    expect(s.drafts).toBeUndefined();
    expect(s.log.find((l: any) => l.what === "architect-impact").detail).toBeUndefined();
  });
});

describe("fit, plan review and the review label", () => {
  const watch = (vars: Record<string, string> = {}, over: Record<string, unknown> = {}) => {
    addRepoWatcher(annRepoId, { id: "app-w", vars, ...over });
    started!.ctx.watchers.sync();
  };
  const viewOf = async (id: string, did: string, round?: unknown) => {
    if (round !== undefined) process.env.FAKE_ROUND = JSON.stringify(round);
    await impact(id, did);
    await idle(id);
    return (await draftOf(id)).impact;
  };
  const big = (files: number, lines: number) => answer({ size: { size: "large", files, lines, why: "Much work." } });
  const sens = answer({ sensitive: [{ topic: "permissions", basis: "estimate", why: "It adds a route." }] });

  it("gives no verdict when the repository has no watcher", async () => {
    const { id, did } = await withDraft();
    const v = await viewOf(id, did);
    expect(v.fit).toEqual({ verdict: "unknown", text: "the build limits are not known" });
    expect(v.planReview).toBeUndefined();
  });

  it("says a small draft fits and names the limits", async () => {
    watch();
    const { id, did } = await withDraft();
    const v = await viewOf(id, did);
    expect(v.fit).toMatchObject({ verdict: "fits", maxFiles: 15, maxCodeLines: 800 });
    expect(v.fit.text).toContain("likely fits in one story");
    expect(v.fit.text).toContain("15 files");
    expect(v.fit.text).toContain("800 lines");
    expect(JSON.stringify(await get(id))).not.toMatch(/app-w|issue-gitflow/);
  });

  it("says too big by files and by lines", async () => {
    watch();
    const { id, did } = await withDraft();
    expect((await viewOf(id, did, big(16, 100))).fit).toMatchObject({ verdict: "too-big", over: ["files"] });
    expect((await viewOf(id, did, big(3, 801))).fit).toMatchObject({ verdict: "too-big", over: ["lines"] });
    expect((await draftOf(id)).impact.fit.text).toContain("likely too big — consider splitting");
  });

  it("lets the watcher override a limit", async () => {
    watch({ max_files: "1" });
    const { id, did } = await withDraft();
    expect((await viewOf(id, did)).fit).toMatchObject({ verdict: "too-big", maxFiles: 1, over: ["files"] });
  });

  it("shows a changed limit on the next read without a new run", async () => {
    watch();
    const { id, did } = await withDraft();
    expect((await viewOf(id, did)).fit.verdict).toBe("fits");
    updateRepoWatcher(annRepoId, "app-w", { vars: { max_files: "1" } });
    started!.ctx.watchers.sync();
    expect((await draftOf(id)).impact.fit).toMatchObject({ verdict: "too-big", maxFiles: 1 });
  });

  it("gives no verdict for a flow without limits, but the label from the watcher", async () => {
    watch({ review_plan_label: "Needs_review" }, { flow: "release-daily", source: "schedule", task: "Do the chore" });
    const { id, did } = await withDraft();
    const v = await viewOf(id, did, sens);
    expect(v.fit.verdict).toBe("unknown");
    expect(v.planReview).toMatchObject({ topics: ["permissions"], label: "Needs_review" });
  });

  it("recommends a plan review with the label, and without a label says so", async () => {
    const { id, did } = await withDraft();
    const none = await viewOf(id, did, sens);
    expect(none.planReview.label).toBeUndefined();
    expect(none.planReview.text).toContain("There is no review label");
    watch();
    const v = (await draftOf(id)).impact;
    expect(v.planReview).toMatchObject({ topics: ["permissions"], label: "Factory_review_plan" });
    expect(v.planReview.text).toContain("Factory_review_plan");
  });

  it("recommends nothing without a sensitive topic", async () => {
    watch();
    const { id, did } = await withDraft();
    expect((await viewOf(id, did)).planReview).toBeUndefined();
  });

  describe("the choice", () => {
    const label = (id: string, did: string, body: unknown, who = ann) => call(who, "PUT", url(id, `drafts/${did}/review-label`), body);

    it("is stored with no view, kept after a new view and an edit, and cleared; no run and no GitHub call", async () => {
      const { id, did } = await withDraft();
      const log = gh.authLog();
      log.clear();
      const before = whats(await get(id));
      const r = await label(id, did, { add: true });
      expect(r.status).toBe(200);
      expect(r.json().drafts[0].addReviewLabel).toBe(true);
      expect(r.json().drafts[0].impact).toBeUndefined();
      expect(log.rows()).toEqual([]);
      expect(whats(await get(id))).toEqual(before);
      await viewOf(id, did);
      expect((await draftOf(id)).addReviewLabel).toBe(true);
      await call(ann, "PUT", url(id, `drafts/${did}`), { why: "to share it widely" });
      expect((await draftOf(id)).addReviewLabel).toBe(true);
      const off = await label(id, did, { add: false });
      expect(off.json().drafts[0]).not.toHaveProperty("addReviewLabel");
    });

    it("cannot be set through the draft", async () => {
      const { id, did } = await withDraft();
      await call(ann, "PUT", url(id, `drafts/${did}`), { addReviewLabel: true });
      expect(await draftOf(id)).not.toHaveProperty("addReviewLabel");
    });

    it("is refused for others, bad bodies, unknown drafts and dropped sessions", async () => {
      const { id, did } = await withDraft();
      expect((await label(id, did, { add: true }, bob)).status).toBe(404);
      expect((await label(id, did, { add: true }, admin)).status).toBe(403);
      expect((await label(id, did, {})).status).toBe(400);
      expect((await label(id, "00000000-0000-4000-8000-000000000000", { add: true })).status).toBe(404);
      await call(ann, "POST", `/api/refinement/${id}/drop`, {});
      expect((await label(id, did, { add: true })).status).toBe(409);
    });

    it("never blocks a change of the draft", async () => {
      watch({ max_files: "1" });
      const { id, did } = await withDraft();
      await viewOf(id, did, { ...sens, size: { size: "large", files: 20, lines: 900, why: "Much work." } });
      await label(id, did, { add: true });
      expect((await call(ann, "PUT", url(id, `drafts/${did}`), { why: "to share it" })).status).toBe(200);
    });
  });
});
