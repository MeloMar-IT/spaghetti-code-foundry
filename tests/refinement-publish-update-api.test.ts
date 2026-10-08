import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
import { labelNames } from "../src/queue/watcher.js";
import { refinedHashIn, refinedHash, refinedMarker, updateMarker } from "../src/refinement/publish.js";
import { refinementsPath } from "../src/refinement/store.js";
import { addRepoWatcher } from "../src/repos/watchers.js";
import { startServer, type ServerOptions } from "../src/server/server.js";
import { fakeGit, fakeGithub, type FakeIssue } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);

let gh: ReturnType<typeof fakeGithub>;
let tmp: string;
let runsDir: string;
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let ann: TestSession;

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-publish-update-"));
  runsDir = join(tmp, "runs");
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
  await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  gh.setLabels(["bug", "Factory_go", "Factory_review_plan", "Area:API"]);
});
afterEach(async () => {
  delete process.env.FAKE_GH_FAIL;
  delete process.env.FAKE_GH_FAIL_API;
  delete process.env.FAKE_GH_COMMENTS_BY_ISSUE;
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

let runCount = 0;
function writeRun(n: number, status: string) {
  const id = `20260101-00000${runCount++}-aaaa`;
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: id, flow: "x", status, startedAt: "2026-01-01T00:00:00Z", runDir: dir, vars: { github_repo: "acme/app", issue: String(n) } }));
}

async function addDraft(id: string, fields: Record<string, unknown> = FULL, ready = true) {
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts.at(-1).id as string;
  expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  if (ready) expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(200);
  return did;
}
/** Imports issue n (a story by default), edits its draft and makes it ready. */
async function imported(n = 12, o: Partial<FakeIssue> & { labels?: string[] } = {}) {
  setRepoReady(annRepo().id, { items: LIST2 });
  gh.setBugIssues([issue(n, o)]);
  const made = await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: n });
  expect(made.status).toBe(201);
  const id = made.json().id as string;
  const did = made.json().drafts[0]?.id as string | undefined;
  if (did) {
    expect((await call(ann, "PUT", url(id, `drafts/${did}`), FULL)).status).toBe(200);
    expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(200);
  }
  return { id, did: did! };
}
/** The issue changed on GitHub: the first publish asks, the second keeps the Foundry's version, as the person confirmed what was shown. */
const keepMine = async (id: string, body: Record<string, unknown> = {}) => {
  const asked = await publish(id, body);
  expect(asked.status).toBe(409);
  return publish(id, { ...body, source: { keep: "mine", seen: asked.json().changedOnGithub.seen } });
};
const watch = () => {
  addRepoWatcher(annRepo().id, { id: "app-w", label: "Factory_go" });
  started!.ctx.watchers.sync();
};
const commentsOf = (n: number) => gh.comments().filter((c) => c.issue === n);

describe("publishing a session that came from an issue", () => {
  it("replaces the title and text of the issue, comments once, and creates nothing", async () => {
    const { id, did } = await imported();
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ repo: "acme/app", state: "published", created: [], updated: [{ draft: did, issue: 12, url: "https://github.com/acme/app/issues/12", found: false }] });
    const patches = gh.updatedBodies();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.issue).toBe(12);
    expect(patches[0]!.title).toBe("Export");
    expect(patches[0]!.body).toContain("Refined in Spaghetti Code Foundry by Ann on");
    expect(patches[0]!.body.trimEnd().split("\n").at(-1)).toBe(refinedMarker(id, did));
    expect(gh.createdBodies()).toEqual([]);
    const c = commentsOf(12);
    expect(c).toHaveLength(1);
    expect(c[0]!.body).toContain("- Title: changed");
    expect(c[0]!.body).toMatch(/- Sections changed: .*Acceptance criteria/);
    expect(c[0]!.body).toContain("<details>");
    expect(c[0]!.body).toContain("Old title");
    expect(c[0]!.body).toContain("Use the exporter.");
    expect(c[0]!.body.trimEnd().split("\n").at(-1)).toBe(updateMarker(id, did));
    const s = stored(id);
    expect(s.drafts[0].published).toMatchObject({ issue: 12, url: "https://github.com/acme/app/issues/12" });
    expect(s.state).toBe("published");
    expect(s.source.pending).toBeUndefined();
    expect(refinedHashIn(gh.bugIssues()[0]!.body)).toBe(refinedHash(id, did));
  });

  it("shows the plan with updates, willUpdate and an empty willCreate", async () => {
    const { id, did } = await imported();
    const p = await planOf(id);
    expect(p.willUpdate).toEqual([did]);
    expect(p.willCreate).toEqual([]);
    expect(p.items[0]).toMatchObject({ draft: did, state: "ready", updates: 12 });
    expect("notChanged" in p).toBe(false);
    nothingWritten();
  });

  it("creates a second draft that depends on the marked one as a new issue with its number", async () => {
    const { id, did } = await imported();
    const second = await addDraft(id, { ...FULL, title: "Second", dependsOn: [{ draft: did }] });
    const p = await planOf(id);
    expect(p.items.find((i: any) => i.draft === second).dependsOn).toEqual([{ issue: 12 }]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(gh.updatedBodies()).toHaveLength(1);
    expect(r.json().created).toMatchObject([{ draft: second, issue: 101 }]);
    expect(gh.createdBodies()).toHaveLength(1);
    expect(gh.createdBodies()[0]!.body).toContain("- #12");
    expect(stored(id).state).toBe("published");
  });

  it("publishes the dependency of the marked draft first, and updates the issue on a later publish", async () => {
    const { id, did } = await imported();
    const first = await addDraft(id, { ...FULL, title: "First" });
    expect((await call(ann, "PUT", url(id, `drafts/${did}`), { dependsOn: [{ draft: first }] })).status).toBe(200);
    expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(200);
    const p = await planOf(id);
    expect(p.willUpdate).toEqual([]);
    expect(p.willCreate).toEqual([first]);
    expect((await publish(id)).status).toBe(200);
    expect(gh.updatedBodies()).toEqual([]);
    expect(gh.createdBodies()).toHaveLength(1);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().updated).toMatchObject([{ issue: 12 }]);
    expect(gh.updatedBodies()[0]!.body).toContain("#101");
  });

  it("adds the chosen labels and the build label last, and removes none", async () => {
    watch();
    const { id, did } = await imported(12, { labels: ["Area:API"] });
    const r = await publish(id, { drafts: [{ draft: did, labels: ["bug"], startBuilding: true }] });
    expect(r.status).toBe(200);
    const log = gh.ghLog();
    expect(log).toMatch(/issue edit 12 .*--add-label bug/);
    expect(log).toMatch(/issue edit 12 .*--add-label Factory_go/);
    expect(log.indexOf("--add-label bug")).toBeLessThan(log.indexOf("--add-label Factory_go"));
    expect(log).not.toContain("--remove-label");
  });

  it("takes a retry after a failure between the update and the comment, with one update and one comment", async () => {
    const { id, did } = await imported();
    process.env.FAKE_GH_FAIL = "issue comment";
    const failed = await publish(id);
    expect(failed.status).toBe(502);
    expect(failed.error()).toMatch(/#12/);
    expect(failed.error()).toMatch(/comment/);
    expect(stored(id).drafts[0].published).toBeUndefined();
    expect(gh.updatedBodies()).toHaveLength(1);
    delete process.env.FAKE_GH_FAIL;
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().updated).toMatchObject([{ draft: did, issue: 12, found: true }]);
    expect(gh.updatedBodies()).toHaveLength(1);
    expect(commentsOf(12)).toHaveLength(1);
    expect(stored(id).drafts[0].published.issue).toBe(12);
  });

  it("keeps the draft as it was sent until the publish is finished, and finishes from what was sent", async () => {
    const { id, did } = await imported();
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    const sent = gh.updatedBodies()[0]!;
    // The draft cannot be edited, dropped or checked again meanwhile.
    expect((await call(ann, "PUT", url(id, `drafts/${did}`), { title: "Changed" })).status).toBeGreaterThanOrEqual(400);
    expect((await call(ann, "DELETE", url(id, `drafts/${did}`))).status).toBeGreaterThanOrEqual(400);
    // Even a draft the plan would not offer is finished from what was sent.
    const stale = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete stale.sessions.find((x: any) => x.id === id).drafts[0].readiness;
    writeFileSync(refinementsPath(), JSON.stringify(stale));
    expect((await planOf(id)).willUpdate).toEqual([]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().updated).toMatchObject([{ issue: 12, found: true }]);
    expect(gh.updatedBodies()).toHaveLength(1);
    expect(commentsOf(12)).toHaveLength(1);
    expect(sent.title).toBe("Export");
    expect(commentsOf(12)[0]!.body).toContain("Old title");
    expect(stored(id).drafts[0].published.issue).toBe(12);
    expect(stored(id).source.pending).toBeUndefined();
  });

  it("audits an update that GitHub confirmed even when the comment failed", async () => {
    const { id } = await imported();
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    const lines = readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === "refinement-publish");
    expect(lines).toMatchObject([{ target: id, detail: "acme/app #12" }]);
  });

  it("folds the text that was really overwritten when the issue changed after the import and the retry comes later", async () => {
    const { id } = await imported();
    change(12, { title: "Edited on GitHub", body: "Edited on GitHub after the import." });
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await keepMine(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    expect((await publish(id)).status).toBe(200);
    const c = commentsOf(12);
    expect(c).toHaveLength(1);
    expect(c[0]!.body).toContain("Edited on GitHub after the import.");
    expect(c[0]!.body).not.toContain("Use the exporter.");
  });

  it("names the label when adding it fails, after the update and the comment", async () => {
    const { id, did } = await imported();
    process.env.FAKE_GH_FAIL = "issue edit";
    const failed = await publish(id, { drafts: [{ draft: did, labels: ["bug"] }] });
    expect(failed.status).toBe(502);
    expect(failed.error()).toMatch(/label "bug"/);
    expect(gh.updatedBodies()).toHaveLength(1);
    expect(commentsOf(12)).toHaveLength(1);
    expect(stored(id).drafts[0].published).toBeUndefined();
  });

  it("ignores a forged or quoted marker and takes over its own comment", async () => {
    const { id, did } = await imported();
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    const marker = updateMarker(id, did);
    const comments = (list: object[]) => (process.env.FAKE_GH_COMMENTS_BY_ISSUE = JSON.stringify({ "acme/app#12": { comments: list } }));
    comments([
      { author: { login: "mallory" }, createdAt: "2026-01-01T00:00:00Z", body: `hello\n${marker}`, viewerDidAuthor: false },
      { author: { login: "foundry-owner" }, createdAt: "2026-01-01T00:00:00Z", body: `> ${marker}\nquoted`, viewerDidAuthor: true },
    ]);
    expect((await publish(id)).status).toBe(200);
    expect(commentsOf(12)).toHaveLength(1);
  });

  it("does not comment again when the comment is there", async () => {
    watch();
    const { id, did } = await imported();
    const body = { drafts: [{ draft: did, labels: ["bug"] }] };
    process.env.FAKE_GH_FAIL = "issue edit";
    expect((await publish(id, body)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    expect(commentsOf(12)).toHaveLength(1);
    process.env.FAKE_GH_COMMENTS_BY_ISSUE = JSON.stringify({ "acme/app#12": { comments: [{ author: { login: "foundry-owner" }, createdAt: "2026-01-01T00:00:00Z", body: commentsOf(12)[0]!.body, viewerDidAuthor: true }] } });
    const r = await publish(id, body);
    expect(r.status).toBe(200);
    expect(commentsOf(12)).toHaveLength(1);
    expect(gh.updatedBodies()).toHaveLength(1);
    expect(stored(id).drafts[0].published.issue).toBe(12);
  });

  it("writes nothing more when published again", async () => {
    const { id } = await imported();
    expect((await publish(id)).status).toBe(200);
    const before = writes();
    const again = await publish(id);
    expect(again.status).toBe(200);
    expect(again.json().created).toEqual([]);
    expect("updated" in again.json()).toBe(false);
    expect(writes()).toBe(before);
  });

  it("refuses a closed issue and writes nothing, not even for the other drafts", async () => {
    const { id } = await imported();
    await addDraft(id, { ...FULL, title: "Second" });
    change(12, { state: "closed", state_reason: "completed", closed_at: "2026-02-01T00:00:00Z" });
    const r = await publish(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/closed/);
    nothingWritten();
    expect(stored(id).drafts.every((d: any) => !d.published)).toBe(true);
  });

  it("refuses an issue the Foundry started to build, with the reason, and writes nothing", async () => {
    const { id } = await imported();
    change(12, { labels: [labelNames({}).working] });
    const r = await publish(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/cannot be updated: the Foundry is working on it/);
    nothingWritten();
    change(12, { labels: [] });
    // A "running" run.json without a live process counts as interrupted, so a run that waits for an answer stands for a live one.
    writeRun(12, "waiting");
    const r2 = await publish(id);
    expect(r2.status).toBe(409);
    expect(r2.error()).toMatch(/waiting for an answer/);
    nothingWritten();
    expect(stored(id).drafts[0].published).toBeUndefined();
  });

  it("writes nothing when the update fails, and updates once on the retry", async () => {
    const { id } = await imported();
    process.env.FAKE_GH_FAIL_API = "update";
    const r = await publish(id);
    expect(r.status).toBe(502);
    expect(r.error()).toMatch(/did not update issue #12/);
    expect(gh.ghLog()).not.toMatch(/issue comment/);
    delete process.env.FAKE_GH_FAIL_API;
    expect((await publish(id)).status).toBe(200);
    expect(gh.updatedBodies()).toHaveLength(1);
    expect(commentsOf(12)).toHaveLength(1);
  });

  it("does not change the issue when its draft was dropped, and creates the others", async () => {
    const { id, did } = await imported();
    const second = await addDraft(id, { ...FULL, title: "Second" });
    expect((await call(ann, "DELETE", url(id, `drafts/${did}`))).status).toBe(200);
    const p = await planOf(id);
    expect(p.notChanged).toBe(12);
    expect(p.willUpdate).toEqual([]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().created).toMatchObject([{ draft: second, issue: 101 }]);
    expect(r.json().notChanged).toBe(12);
    expect(gh.updatedBodies()).toEqual([]);
    expect(gh.bugIssues().find((i) => i.number === 12)!.body).toBe(STORY);
  });

  it("works on an issue that had no story format: the first draft stands for it", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    gh.setBugIssues([issue(15, { title: "Slow page", body: "It takes ages." })]);
    const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 15 })).json().id as string;
    const did = await addDraft(id);
    const second = await addDraft(id, { ...FULL, title: "Other" });
    const p = await planOf(id);
    expect(p.items.find((i: any) => i.draft === did).updates).toBe(15);
    expect(p.items.find((i: any) => i.draft === second).updates).toBeUndefined();
    expect((await publish(id)).status).toBe(200);
    expect(gh.updatedBodies().map((u) => u.issue)).toEqual([15]);
    expect(commentsOf(15)[0]!.body).toContain("Story");
  });

  it("copes with an issue whose text was removed after the import", async () => {
    const { id } = await imported();
    change(12, { body: null as unknown as string });
    const r = await keepMine(id);
    expect(r.status).toBe(200);
    expect(commentsOf(12)[0]!.body).toContain("```text\n\n```");
  });

  it("refuses before writing when the old text does not fit in the comment", async () => {
    const { id } = await imported();
    change(12, { body: "x".repeat(65_500) });
    const r = await keepMine(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/too long to keep in a comment/);
    nothingWritten();
  });

  it("never puts the old text on a command line", async () => {
    const token = "OLD-$(touch pwned)-TOKEN";
    setRepoReady(annRepo().id, { items: LIST2 });
    gh.setBugIssues([issue(16, { title: "Odd", body: token })]);
    const id = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 16 })).json().id as string;
    await addDraft(id);
    expect((await publish(id)).status).toBe(200);
    const lines = gh.ghLog().split("\n").filter((l) => l.startsWith("gh "));
    expect(lines.some((l) => l.includes(token) || l.includes("pwned"))).toBe(false);
    expect(commentsOf(16)[0]!.body).toContain(token);
  });
});
