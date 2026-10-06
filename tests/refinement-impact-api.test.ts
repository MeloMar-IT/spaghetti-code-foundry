import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo } from "../src/auth/repos.js";
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
const saved: Record<string, string | undefined> = {};
const ENV = ["FACTORY_HOME", "FAKE_GH_EXPECT_TOKEN", "FAKE_GH_SLEEP", "FAKE_BRIEF", "FAKE_ROUND", "FAKE_GH_ISSUES"];
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
  delete process.env.FAKE_GH_ISSUES;
  kc = fakeKeychain();
  started = await startServer(opts());
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

  it("tells the architect the areas of the Foundry's runs and marks an overlap found only when they support it", async () => {
    mkdirSync(join(tmp, "runs", "seed-1"), { recursive: true });
    const seeded = { runId: "seed-1", flow: "gitflow", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z", runDir: join(tmp, "runs", "seed-1"), vars: { github_repo: "acme/app", issue: "31" }, history: [{ id: "plan", type: "agent", visit: 1, ok: true, output: "Plan\nAREAS: src/server, README.md" }] };
    writeFileSync(join(tmp, "runs", "seed-1", "run.json"), JSON.stringify(seeded));
    const open = (n: number) => ({ number: n, title: `Issue ${n}`, body: `Body ${n}`, labels: [{ name: "enhancement" }], comments: [] });
    process.env.FAKE_GH_ISSUES = JSON.stringify([open(31), open(32)]);
    const claim = (issue: number) => ({ issue, areas: ["src/server"], basis: "found", why: "Same files." });
    process.env.FAKE_ROUND = JSON.stringify(answer({ areas: [{ area: "src/server", files: ["src/server/a.ts"], basis: "found", why: "It is read." }], overlaps: [claim(31), claim(32), claim(99)] }));
    const { id, did } = await withDraft();
    const r = await impact(id, did);
    expect(runJson(r.json().architect.runId).task).toContain("## Areas the Foundry knows\n- #31: [\"src/server\"]\n");
    const d = (await idle(id)).drafts[0];
    expect(d.impact.overlaps.map((o: any) => [o.issue, o.basis])).toEqual([[31, "found"], [32, "estimate"]]);
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
