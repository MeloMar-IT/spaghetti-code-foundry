import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos } from "../src/auth/repos.js";
import { parseFlow } from "../src/flow/load.js";
import { createSessionFromIssue, refinementsPath } from "../src/refinement/store.js";
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
let bob: TestSession;

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-import-"));
  runsDir = join(tmp, "runs");
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
  await signInAs(base);
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
const annRepo = () => listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;
const stored = (id: string) => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions.find((s: any) => s.id === id);
const importIssue = (n: unknown, who = ann, repo = "acme/app") => call(who, "POST", "/api/refinement", { repo, issue: n });

const STORY = [
  "**Epic:** #73",
  "",
  "As an admin, I want to export a report, so that I can share it.",
  "",
  "### Acceptance criteria",
  "- [ ] It exports a file",
  "- [ ] The file has a header",
  "",
  "### Out of scope",
  "Printing",
  "",
  "### Notes for the builder",
  "Use the exporter.",
  "",
  "### Depends on",
  "- #5",
  "",
  "---",
  "Refined in Spaghetti Code Foundry by Ann on 2026-01-01.",
  "",
  "<!-- claude-factory refined=0123 -->",
].join("\n");

const issue = (n: number, o: Partial<FakeIssue> & { labels?: string[] } = {}): FakeIssue => {
  const { labels, ...rest } = o;
  return {
    number: n,
    state: "open",
    state_reason: null,
    title: `Issue ${n}`,
    body: "Please fix the thing.",
    labels: (labels ?? []).map((name) => ({ name })),
    html_url: `https://github.com/acme/app/issues/${n}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-03T04:05:06Z",
    closed_at: null,
    ...rest,
  } as FakeIssue;
};
const setIssues = (...list: FakeIssue[]) => gh.setBugIssues(list);

let runCount = 0;
/** A run.json of a run of acme/app#n. */
function writeRun(n: number, status: string, vars: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const id = `20260101-00000${runCount++}-aaaa`;
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({ runId: id, flow: "x", status, startedAt: "2026-01-01T00:00:00Z", runDir: dir, vars: { github_repo: "acme/app", issue: String(n), ...vars }, ...extra }),
  );
  return id;
}
const PLAIN = parseFlow(`name: plain\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: "true"}\n`);
const nothingWritten = () => expect(gh.ghLog()).not.toMatch(/-X (POST|PATCH|PUT|DELETE)|issue (edit|close|comment)|--method/);

describe("start a session from an issue", () => {
  it("makes one draft from an issue in the story format", async () => {
    setIssues(issue(12, { title: "Export a report", body: STORY, labels: ["bug"] }));
    const r = await importIssue(12);
    expect(r.status).toBe(201);
    const s = r.json();
    expect(s.title).toBe("Export a report");
    expect(s.state).toBe("drafting");
    expect(s.epic).toBe(73);
    expect(s.drafts).toHaveLength(1);
    const d = s.drafts[0];
    expect(d.title).toEqual({ text: "Export a report", from: "typed" });
    expect(d.who).toEqual({ text: "an admin", from: "typed" });
    expect(d.what).toEqual({ text: "to export a report", from: "typed" });
    expect(d.why).toEqual({ text: "I can share it", from: "typed" });
    expect(d.criteria.map((c: any) => [c.text, c.from])).toEqual([["It exports a file", "typed"], ["The file has a header", "typed"]]);
    expect(d.outOfScope).toEqual({ text: "Printing", from: "typed" });
    expect(d.notes).toEqual({ text: "Use the exporter.", from: "typed" });
    expect(d.dependsOn.map((x: any) => [x.issue, x.from])).toEqual([[5, "typed"]]);
    expect(s.idea).not.toMatch(/claude-factory|Refined in Spaghetti/);
    expect(JSON.stringify(s.drafts)).not.toMatch(/claude-factory|Refined in Spaghetti/);
    expect(s.source).toEqual({
      issue: 12,
      url: "https://github.com/acme/app/issues/12",
      title: "Export a report",
      body: STORY,
      updatedAt: "2026-02-03T04:05:06.000Z",
      draft: s.drafts[0].id,
    });
    expect(s.source.body).toContain("<!-- claude-factory refined=0123 -->");
    expect((await call(ann, "GET", `/api/refinement/${s.id}`)).json().source).toEqual(s.source);
    expect(s.log.at(-1)).toMatchObject({ what: "imported", detail: "#12" });
    nothingWritten();
  });

  it("makes an idea only from an issue without the story format", async () => {
    setIssues(issue(13, { title: "Slow page", body: "It takes ages.\n<!-- spaghetti-code-foundry status -->" }));
    const s = (await importIssue(13)).json();
    expect(s.drafts).toEqual([]);
    expect(s.state).toBe("exploring");
    expect(s.idea).toBe("Slow page\n\nIt takes ages.");
    expect(s.source.body).toContain("status -->");
  });

  it("refuses a text over the idea limit and stores nothing", async () => {
    setIssues(issue(14, { body: "x".repeat(10_001) }));
    const r = await importIssue(14);
    expect(r.status).toBe(400);
    expect(r.error()).toMatch(/too long.*10[, ]?000/);
    expect((await call(ann, "GET", "/api/refinement")).json().sessions).toEqual([]);
  });

  it("keeps a long issue title as the session title", async () => {
    setIssues(issue(15, { title: "T".repeat(200) }));
    expect((await importIssue(15)).json().title).toBe("T".repeat(200));
  });

  it("refuses what cannot be refined", async () => {
    setIssues(issue(20, { state: "closed", closed_at: "2026-01-02T00:00:00Z" }), issue(21, { pull_request: { url: "x" } }));
    expect((await importIssue(20)).status).toBe(409);
    expect((await importIssue(20)).error()).toMatch(/closed/);
    expect((await importIssue(99)).status).toBe(404);
    expect((await importIssue(99)).error()).toMatch(/does not exist/);
    const pr = await importIssue(21);
    expect(pr.status).toBe(400);
    expect(pr.error()).toMatch(/pull request/);
    expect((await importIssue(12, ann, "other/thing")).status).toBe(403);
    expect((await importIssue("x")).status).toBe(400);
    expect((await importIssue(0)).status).toBe(400);
    expect((await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 20, idea: "x" })).status).toBe(400);
    process.env.FAKE_GH_FAIL_API = "read";
    expect((await importIssue(22)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL_API;
  });

  it("refuses a repository that uses the server's own login", async () => {
    addRepo(ann.user.id, { url: "acme/host", method: "none" });
    expect((await importIssue(1, ann, "acme/host")).status).toBe(409);
  });
});

describe("an issue the Foundry is building or has built", () => {
  it("refuses a waiting run", async () => {
    setIssues(issue(30));
    writeRun(30, "waiting");
    const r = await importIssue(30);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/cannot be refined.*waiting for an answer/);
  });

  it("refuses a new run job in the queue", async () => {
    setIssues(issue(31));
    started!.ctx.scheduler.drain();
    started!.ctx.scheduler.submit({ kind: "run", flow: PLAIN, task: "t", repo: tmp, vars: { github_repo: "acme/app", issue: "31" } });
    const r = await importIssue(31);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/queue/);
  });

  it("refuses a queued resume of a run of the issue", async () => {
    setIssues(issue(32));
    const id = writeRun(32, "stopped");
    started!.ctx.scheduler.drain();
    started!.ctx.scheduler.submit({ kind: "resume", runId: id }, { lockKey: "acme/app#watcher:w" });
    const r = await importIssue(32);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/queue/);
  });

  it("refuses a job that was queued while GitHub was read", async () => {
    setIssues(issue(33));
    started!.ctx.scheduler.drain();
    const release = gh.hold("issues/33");
    const pending = importIssue(33);
    await new Promise((r) => setTimeout(r, 400));
    started!.ctx.scheduler.submit({ kind: "run", flow: PLAIN, task: "t", repo: tmp, vars: { github_repo: "acme/app", issue: "33" } });
    release();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/queue/);
    expect((await call(ann, "GET", "/api/refinement")).json().sessions).toEqual([]);
  });

  it.each([["working"], ["waiting-approval"], ["needs-info"], ["done"]])("refuses the label factory:%s", async (name) => {
    setIssues(issue(34, { labels: [`factory:${name}`] }));
    const r = await importIssue(34);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/label/);
  });

  it("refuses a watcher's own label name", async () => {
    setIssues(issue(35, { labels: ["Bot_done"] }));
    addRepoWatcher(annRepo().id, { id: "app-w", label: "Factory_go", status_labels: { done: "Bot_done" } });
    started!.ctx.watchers.sync();
    const r = await importIssue(35);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/Bot_done/);
  });

  it("does not use the default names when a watcher has its own", async () => {
    setIssues(issue(39, { labels: ["factory:done"] }));
    addRepoWatcher(annRepo().id, { id: "app-w", label: "Factory_go", status_labels: { done: "Bot_done" } });
    started!.ctx.watchers.sync();
    expect((await importIssue(39)).status).toBe(201);
  });

  it("refuses a failed run whose pull request is open or merged", async () => {
    setIssues(issue(36), issue(37));
    writeRun(36, "failed", { pr: "17" });
    writeRun(37, "failed", { pr: "18" });
    gh.setPulls([{ number: 17, state: "open" }, { number: 18, state: "closed", merged: true }]);
    const open = await importIssue(36);
    expect(open.status).toBe(409);
    expect(open.error()).toMatch(/pull request #17/);
    const merged = await importIssue(37);
    expect(merged.status).toBe(409);
    expect(merged.error()).toMatch(/pull request #18/);
  });

  it("refuses when the pull request cannot be found", async () => {
    setIssues(issue(38));
    writeRun(38, "failed", { pr: "19" });
    gh.setPulls([]);
    expect((await importIssue(38)).status).toBe(409);
  });

  it("accepts a failed run without a pull request", async () => {
    setIssues(issue(40));
    writeRun(40, "failed");
    expect((await importIssue(40)).status).toBe(201);
  });

  it("accepts the failed label alone", async () => {
    setIssues(issue(41, { labels: ["factory:failed"] }));
    expect((await importIssue(41)).status).toBe(201);
  });

  it("accepts a failed run whose pull request was closed without a merge", async () => {
    setIssues(issue(42));
    writeRun(42, "failed", { pr: "20" });
    gh.setPulls([{ number: 20, state: "closed", merged: false }]);
    expect((await importIssue(42)).status).toBe(201);
  });

  it("reads every pull request, however many", async () => {
    setIssues(issue(43));
    const list: { number: number; state: "closed"; merged: boolean }[] = [];
    for (let i = 1; i <= 7; i++) {
      writeRun(43, "failed", { pr: String(100 + i) });
      list.push({ number: 100 + i, state: "closed", merged: false });
    }
    gh.setPulls(list);
    expect((await importIssue(43)).status).toBe(201);
  });

  it("does not mix up issues of other repositories or numbers", async () => {
    setIssues(issue(44));
    writeRun(45, "waiting");
    writeRun(44, "waiting", { github_repo: "other/thing" });
    expect((await importIssue(44)).status).toBe(201);
  });
});

describe("an issue that has a session already", () => {
  it("is refused with the id of the session, until the session is dropped", async () => {
    setIssues(issue(50));
    const first = (await importIssue(50)).json();
    const again = await importIssue(50);
    expect(again.status).toBe(409);
    expect(again.json().session).toBe(first.id);
    expect(again.error()).toMatch(/already has an open refinement session/);
    expect((await call(ann, "POST", `/api/refinement/${first.id}/drop`)).status).toBe(200);
    expect((await importIssue(50)).status).toBe(201);
  });

  it("does not restore a dropped session while another is open for the issue", async () => {
    setIssues(issue(52));
    const first = (await importIssue(52)).json();
    await call(ann, "POST", `/api/refinement/${first.id}/drop`);
    const second = (await importIssue(52)).json();
    const r = await call(ann, "POST", `/api/refinement/${first.id}/restore`);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/another open refinement session/);
    await call(ann, "POST", `/api/refinement/${second.id}/drop`);
    expect((await call(ann, "POST", `/api/refinement/${first.id}/restore`)).status).toBe(200);
  });

  it("does not block another account", async () => {
    setIssues(issue(51));
    const first = (await importIssue(51)).json();
    const made = createSessionFromIssue(
      bob.user.id,
      { repo: "acme/app", title: "T", idea: "T", source: { issue: 51, url: "https://github.com/acme/app/issues/51", title: "T", body: "", updatedAt: "2026-01-01T00:00:00.000Z" } },
      { ownerOk: () => true, repoName: (_o, n) => n },
    );
    expect(made.id).not.toBe(first.id);
  });
});

describe("the build label and old data", () => {
  it("says so when the issue has the build label", async () => {
    setIssues(issue(60, { labels: ["factory_go"] }), issue(61));
    addRepoWatcher(annRepo().id, { id: "app-w", label: "Factory_go" });
    started!.ctx.watchers.sync();
    expect((await importIssue(60)).json().source.buildLabel).toBe("Factory_go");
    expect("buildLabel" in (await importIssue(61)).json().source).toBe(false);
    nothingWritten();
  });

  it("still loads sessions without a source, and still starts a session from an idea", async () => {
    const made = await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report" });
    expect(made.status).toBe(201);
    expect("source" in made.json()).toBe(false);
    const id = made.json().id;
    expect(stored(id).source).toBeUndefined();
    const got = await call(ann, "GET", `/api/refinement/${id}`);
    expect("source" in got.json()).toBe(false);
    expect(got.json().log[0].what).toBe("created");
  });

});

describe("the draft that stands for the issue", () => {
  const draftsOf = (id: string) => `/api/refinement/${id}/drafts`;
  /** Writes the stored session back without the mark, as the 9a build stored it. */
  const unmark = (id: string) => {
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    delete f.sessions.find((s: any) => s.id === id).source.draft;
    writeFileSync(refinementsPath(), JSON.stringify(f));
  };
  const planOf = async (id: string) => (await call(ann, "GET", `/api/refinement/${id}/publish`)).json();

  it("marks the one draft of a story import", async () => {
    setIssues(issue(80, { title: "Export", body: STORY }));
    const s = (await importIssue(80)).json();
    expect(stored(s.id).source.draft).toBe(s.drafts[0].id);
  });

  it("marks the first draft made in a plain-text import, and no other", async () => {
    setIssues(issue(81));
    const s = (await importIssue(81)).json();
    expect("draft" in stored(s.id).source).toBe(false);
    const first = (await call(ann, "POST", draftsOf(s.id))).json().drafts.at(-1).id;
    expect(stored(s.id).source.draft).toBe(first);
    await call(ann, "POST", draftsOf(s.id));
    expect(stored(s.id).source.draft).toBe(first);
    expect((await call(ann, "GET", `/api/refinement/${s.id}`)).json().source.draft).toBe(first);
    expect(JSON.stringify((await call(ann, "GET", `/api/refinement/${s.id}`)).json())).not.toContain("pending");
  });

  it("does not move the mark when the marked draft is dropped and a new one is made", async () => {
    setIssues(issue(82, { title: "Export", body: STORY }));
    const s = (await importIssue(82)).json();
    const marked = s.drafts[0].id;
    await call(ann, "DELETE", `${draftsOf(s.id)}/${marked}`);
    await call(ann, "POST", draftsOf(s.id));
    expect(stored(s.id).source.draft).toBe(marked);
    expect((await planOf(s.id)).notChanged).toBe(82);
  });

  it("works out the mark for sessions stored before it existed", async () => {
    // Untouched, edited: the one draft of a story import is the one.
    setIssues(issue(83, { title: "Export", body: STORY }), issue(84, { title: "Export", body: STORY }));
    const a = (await importIssue(83)).json();
    const b = (await importIssue(84)).json();
    await call(ann, "PUT", `${draftsOf(b.id)}/${b.drafts[0].id}`, { title: "Export more" });
    unmark(a.id);
    unmark(b.id);
    expect((await call(ann, "GET", `/api/refinement/${a.id}`)).json().source.draft).toBe(a.drafts[0].id);
    expect((await planOf(a.id)).items[0].updates).toBe(83);
    expect((await planOf(b.id)).items[0].updates).toBe(84);
    // Added to: the imported draft is still the first.
    await call(ann, "POST", draftsOf(a.id));
    unmark(a.id);
    expect((await planOf(a.id)).items.filter((x: any) => x.updates !== undefined).map((x: any) => x.draft)).toEqual([a.drafts[0].id]);
    // Dropped: nothing stands for the issue, and a new draft does not take the mark.
    await call(ann, "DELETE", `${draftsOf(b.id)}/${b.drafts[0].id}`);
    await call(ann, "POST", draftsOf(b.id));
    unmark(b.id);
    const plan = await planOf(b.id);
    expect(plan.notChanged).toBe(84);
    expect(plan.items.some((x: any) => x.updates !== undefined)).toBe(false);
  });

  it("does not say which draft is meant in a legacy session when the first one is a part", async () => {
    setIssues(issue(85, { title: "Export", body: STORY }));
    const s = (await importIssue(85)).json();
    unmark(s.id);
    const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
    f.sessions.find((x: any) => x.id === s.id).drafts[0].part = { of: s.drafts[0].id, n: 1 };
    // The stored shape of a part is not needed in full: the mark is only worked out from the first draft, which is a part here.
    const { markOf } = await import("../src/refinement/store.js");
    expect(markOf(f.sessions.find((x: any) => x.id === s.id))).toBeUndefined();
  });
});
