import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
import { refinedHash, refinedHashIn } from "../src/refinement/publish.js";
import { refinementsPath } from "../src/refinement/store.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeGit, fakeGithub, type FakeIssue } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let ann: TestSession;

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-publish-changed-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
  await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  gh.setLabels(["bug", "Factory_go", "Factory_review_plan", "Area:API"]);
});
afterEach(async () => {
  delete process.env.FAKE_GH_FAIL;
  delete process.env.FAKE_GH_FAIL_API;
  if (!started?.ctx.scheduler.draining) await started?.ctx.scheduler.idle();
  started?.close();
  started = undefined;
  kc.remove();
  gh.restore();
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
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;
const annRepo = () => listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;
const stored = (id: string) => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions.find((s: any) => s.id === id);
const publish = (id: string, body: unknown = {}) => call(ann, "POST", url(id, "publish"), body);
const planOf = async (id: string) => (await call(ann, "GET", url(id, "publish"))).json();

const STORY = [
  "As an admin, I want to export a report, so that I can share it.",
  "",
  "### Acceptance criteria",
  "- [ ] It exports a file",
  "- [ ] The file has a header",
  "",
  "### Notes for the builder",
  "Use the exporter.",
].join("\n");
const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It exports a file" }] };
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];

const issue = (n: number, o: Partial<FakeIssue> & { labels?: string[] } = {}): FakeIssue => {
  const { labels, ...rest } = o;
  return {
    number: n,
    state: "open",
    state_reason: null,
    title: "Old title",
    body: STORY,
    labels: (labels ?? []).map((name) => ({ name })),
    html_url: `https://github.com/acme/app/issues/${n}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-03T04:05:06Z",
    closed_at: null,
    ...rest,
  } as FakeIssue;
};
/** Changes issue n on the fake GitHub, as a person would on GitHub. */
const change = (n: number, over: Partial<FakeIssue> & { labels?: string[] }) => {
  const { labels, ...rest } = over;
  gh.setBugIssues(gh.bugIssues().map((i) => (i.number === n ? { ...i, ...rest, ...(labels ? { labels: labels.map((name) => ({ name })) } : {}) } : i)));
};
const nothingWritten = () => expect(gh.ghLog()).not.toMatch(/-X (POST|PATCH|PUT|DELETE)|issue (edit|close|comment)|--method/);
const writes = () => gh.ghLog().split("\n").filter((l) => /^gh (api .*-X (POST|PATCH)|issue (edit|comment|create))/.test(l)).length;
const commentsOf = (n: number) => gh.comments().filter((c) => c.issue === n);

async function addDraft(id: string, fields: Record<string, unknown> = FULL, ready = true) {
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts.at(-1).id as string;
  expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  if (ready) expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(200);
  return did;
}
/** Imports issue n (a story by default), edits its draft and makes it ready. */
async function imported(n = 12) {
  setRepoReady(annRepo().id, { items: LIST2 });
  gh.setBugIssues([issue(n)]);
  const made = await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: n });
  expect(made.status).toBe(201);
  const id = made.json().id as string;
  const did = made.json().drafts[0].id as string;
  expect((await call(ann, "PUT", url(id, `drafts/${did}`), FULL)).status).toBe(200);
  expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(200);
  return { id, did };
}
const EDITED = { title: "Edited on GitHub", body: "Edited on GitHub after the import." };
const mine = (seen: string) => ({ source: { keep: "mine", seen } });
const github = (seen: string) => ({ source: { keep: "github", seen } });

describe("the issue changed on GitHub", () => {
  it("answers 409 with both versions and writes nothing", async () => {
    const { id } = await imported();
    change(12, EDITED);
    const r = await publish(id);
    expect(r.status).toBe(409);
    const c = r.json().changedOnGithub;
    expect(c).toMatchObject({ issue: 12, github: EDITED, mine: { title: "Export" } });
    expect(c.mine.body).toContain("export a report");
    expect(c.seen).toMatch(/^[0-9a-f]{64}$/);
    expect(r.error()).toMatch(/changed on GitHub/);
    nothingWritten();
    expect(stored(id).drafts[0].published).toBeUndefined();
  });

  it("reports the same state in the plan, and nothing when the issue is unchanged", async () => {
    const { id } = await imported();
    expect("changedOnGithub" in (await planOf(id))).toBe(false);
    change(12, EDITED);
    const p = await planOf(id);
    const r = await publish(id);
    expect(p.changedOnGithub).toEqual(r.json().changedOnGithub);
    nothingWritten();
  });

  it("keep mine: replaces the issue and folds the GitHub version, not the imported one", async () => {
    const { id, did } = await imported();
    change(12, EDITED);
    const seen = (await publish(id)).json().changedOnGithub.seen;
    const r = await publish(id, mine(seen));
    expect(r.status).toBe(200);
    expect(r.json().updated).toMatchObject([{ draft: did, issue: 12 }]);
    expect(gh.updatedBodies()).toHaveLength(1);
    expect(gh.updatedBodies()[0]!.title).toBe("Export");
    expect(refinedHashIn(gh.bugIssues()[0]!.body)).toBe(refinedHash(id, did));
    const c = commentsOf(12);
    expect(c).toHaveLength(1);
    expect(c[0]!.body).toContain(EDITED.body);
    expect(c[0]!.body).not.toContain("Use the exporter.");
  });

  it("keep mine: asks again when GitHub changed again since the question", async () => {
    const { id } = await imported();
    change(12, EDITED);
    const first = (await publish(id)).json().changedOnGithub.seen;
    change(12, { body: "A second edit." });
    const again = await publish(id, mine(first));
    expect(again.status).toBe(409);
    expect(again.json().changedOnGithub.github.body).toBe("A second edit.");
    expect(again.json().changedOnGithub.seen).not.toBe(first);
    nothingWritten();
    const done = await publish(id, mine(again.json().changedOnGithub.seen));
    expect(done.status).toBe(200);
    expect(commentsOf(12)[0]!.body).toContain("A second edit.");
  });

  it("keep mine: a line-end difference after the question does not ask again", async () => {
    const { id } = await imported();
    change(12, EDITED);
    const seen = (await publish(id)).json().changedOnGithub.seen;
    change(12, { body: `${EDITED.body}\r\n` });
    expect((await publish(id, mine(seen))).status).toBe(200);
  });

  it("keep GitHub's: writes nothing, remembers GitHub's version, and keeps the draft unpublished", async () => {
    const { id, did } = await imported();
    change(12, EDITED);
    const seen = (await publish(id)).json().changedOnGithub.seen;
    const r = await publish(id, github(seen));
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ created: [], kept: { issue: 12 } });
    nothingWritten();
    const s = stored(id);
    expect(s.source).toMatchObject({ title: EDITED.title, body: EDITED.body });
    expect(s.drafts[0].published).toBeUndefined();
    expect(s.log.some((l: any) => l.what === "source-refreshed")).toBe(true);
    expect("changedOnGithub" in (await planOf(id))).toBe(false);
    const done = await publish(id);
    expect(done.status).toBe(200);
    expect(done.json().updated).toMatchObject([{ draft: did, issue: 12 }]);
    expect(commentsOf(12)[0]!.body).toContain(EDITED.body);
  });

  it("keep GitHub's: asks again with the newer versions when GitHub changed again", async () => {
    const { id } = await imported();
    change(12, EDITED);
    const first = (await publish(id)).json().changedOnGithub.seen;
    change(12, { body: "A second edit." });
    const r = await publish(id, github(first));
    expect(r.status).toBe(409);
    expect(r.json().changedOnGithub.github.body).toBe("A second edit.");
    expect(stored(id).source.body).toBe(STORY);
    nothingWritten();
  });

  it("keep GitHub's: creates no other issue", async () => {
    const { id } = await imported();
    const other = await addDraft(id, { ...FULL, title: "Second" });
    change(12, EDITED);
    const seen = (await publish(id)).json().changedOnGithub.seen;
    const r = await publish(id, github(seen));
    expect(r.status).toBe(200);
    expect(gh.createdBodies()).toEqual([]);
    nothingWritten();
    expect(stored(id).drafts.find((d: any) => d.id === other).published).toBeUndefined();
  });

  it("keep GitHub's: refused while an update is pending, and nothing changes", async () => {
    const { id } = await imported();
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    const pending = stored(id).source.pending;
    expect(pending).toBeDefined();
    change(12, { ...EDITED });
    const asked = await publish(id);
    expect(asked.status).toBe(409);
    const before = writes();
    const r = await publish(id, github(asked.json().changedOnGithub.seen));
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/not finished/);
    expect(stored(id).source.pending).toEqual(pending);
    expect(stored(id).source.body).toBe(STORY);
    expect(writes()).toBe(before);
  });

  it("reports a pending update in the plan also when its draft is no longer ready", async () => {
    const { id } = await imported();
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete f.sessions.find((x: any) => x.id === id).drafts[0].readiness;
    writeFileSync(refinementsPath(), JSON.stringify(f));
    change(12, EDITED);
    const p = await planOf(id);
    expect(p.willUpdate).toEqual([]);
    expect(p.changedOnGithub).toMatchObject({ issue: 12, github: EDITED, mine: { title: "Export" } });
    expect((await publish(id)).status).toBe(409);
  });

  it("does not ask for a change of the labels alone", async () => {
    const { id } = await imported();
    change(12, { labels: ["bug"], updated_at: "2026-03-01T00:00:00Z" });
    expect("changedOnGithub" in (await planOf(id))).toBe(false);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(commentsOf(12)[0]!.body).toContain("Use the exporter.");
  });

  it("does not ask when GitHub only has other line ends", async () => {
    const { id } = await imported();
    change(12, { body: STORY.replace(/\n/g, "\r\n") });
    expect("changedOnGithub" in (await planOf(id))).toBe(false);
    expect((await publish(id)).status).toBe(200);
  });

  it("refuses a choice when no draft updates an issue, and writes nothing", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "An idea" })).json().id as string;
    await addDraft(id);
    const r = await publish(id, github("a".repeat(64)));
    expect(r.status).toBe(400);
    nothingWritten();
    expect(stored(id).drafts[0].published).toBeUndefined();
  });

  it("refuses a malformed choice", async () => {
    const { id } = await imported();
    const r = await publish(id, { source: { keep: "both", seen: "a".repeat(64) } });
    expect(r.status).toBe(400);
    nothingWritten();
  });

  it("refuses a closed issue before asking", async () => {
    const { id } = await imported();
    change(12, { ...EDITED, state: "closed", state_reason: "completed", closed_at: "2026-02-01T00:00:00Z" });
    const r = await publish(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/closed/);
    expect("changedOnGithub" in r.json()).toBe(false);
    nothingWritten();
  });

  it("asks when a person edited the replaced issue (marker kept) before the retry, and rewrites on keep mine", async () => {
    const { id, did } = await imported();
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    change(12, { title: "Edited after the update" });
    const p = await planOf(id);
    expect(p.changedOnGithub).toMatchObject({ issue: 12, github: { title: "Edited after the update" }, mine: { title: "Export" } });
    const asked = await publish(id);
    expect(asked.status).toBe(409);
    expect(asked.json().changedOnGithub.seen).toBe(p.changedOnGithub.seen);
    expect(gh.updatedBodies()).toHaveLength(1);
    expect(stored(id).drafts[0].published).toBeUndefined();
    const r = await publish(id, mine(asked.json().changedOnGithub.seen));
    expect(r.status).toBe(200);
    expect(gh.updatedBodies()).toHaveLength(2);
    expect(gh.bugIssues()[0]!.title).toBe("Export");
    expect(refinedHashIn(gh.bugIssues()[0]!.body)).toBe(refinedHash(id, did));
    expect(commentsOf(12)).toHaveLength(1);
    expect(stored(id).drafts[0].published.issue).toBe(12);
  });

  it("takes the retry after a failed comment without a question", async () => {
    const { id } = await imported();
    change(12, EDITED);
    const seen = (await publish(id)).json().changedOnGithub.seen;
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id, mine(seen))).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(commentsOf(12)).toHaveLength(1);
    expect(commentsOf(12)[0]!.body).toContain(EDITED.body);
  });
});
