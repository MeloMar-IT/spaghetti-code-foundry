import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createSessionFromIssue } from "../src/refinement/store.js";
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
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-backlog-"));
  runsDir = join(tmp, "runs");
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  addRepo(bob.user.id, { url: "other/thing", method: "github-token", token: TOKEN });
});
afterEach(async () => {
  delete process.env.FAKE_GH_FAIL_API;
  delete process.env.FAKE_GH_BUG_ISSUES;
  if (!started?.ctx.scheduler.draining) await started?.ctx.scheduler.idle();
  started?.close();
  started = undefined;
  kc.remove();
  gh.restore();
  rmSync(tmp, { recursive: true, force: true });
});

async function get(who: TestSession | undefined, path: string) {
  const send = () => fetch(base + path, { headers: who ? who.headers("GET") : {} });
  const r = await send().catch(() => send());
  const text = await r.text();
  return { status: r.status, json: () => JSON.parse(text), error: () => JSON.parse(text).error as string };
}
const list = (who: TestSession | undefined = ann, repo = "acme/app") => get(who, `/api/refinement/backlog?repo=${encodeURIComponent(repo)}`);

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
/** The fake gh lists the file newest first (it reverses it), so the issues are given oldest first. */
const setIssues = (...l: FakeIssue[]) => gh.setBugIssues(l);

let runCount = 0;
function writeRun(n: number, status: string, vars: Record<string, string> = {}) {
  const id = `20260101-00000${runCount++}-aaaa`;
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({ runId: id, flow: "x", status, startedAt: "2026-01-01T00:00:00Z", runDir: dir, vars: { github_repo: "acme/app", issue: String(n), ...vars } }),
  );
  return id;
}

const STORY = "As an admin, I want to export a report, so that I can share it.\n\n### Acceptance criteria\n- [ ] It exports a file\n\n### Depends on\n- #2";

describe("the list", () => {
  it("lists open issues newest first with number, title, link and checks", async () => {
    setIssues(issue(1, { state: "closed" }), issue(2, { title: "Second" }), issue(3, { title: "Third", body: STORY }), issue(4, { pull_request: {} } as never));
    const r = await list();
    expect(r.status).toBe(200);
    const body = r.json();
    expect(body.repo).toBe("acme/app");
    expect(body.cut).toBe(false);
    expect(body.issues.map((i: any) => i.number)).toEqual([3, 2]);
    expect(body.issues[0]).toEqual({
      number: 3,
      title: "Third",
      url: "https://github.com/acme/app/issues/3",
      checks: { criteria: true, value: true, dependencies: true, questions: true },
    });
    expect(body.issues[1].checks).toEqual({ criteria: false, value: false, dependencies: true, questions: true });
  });

  it("checks the \"Depends on\" numbers and titles against GitHub", async () => {
    // The page holds only #6; #2 (closed issue), #4 (pull request) and #9 (nothing) are outside it and asked for one by one.
    const six = issue(6, { body: "Depends on: #2, #4, #9" });
    gh.setBugIssues([issue(2, { state: "closed" }), issue(4, { pull_request: {} } as never), six]);
    process.env.FAKE_GH_BUG_ISSUES = JSON.stringify([six]);
    const outside = (await list()).json().issues[0];
    delete process.env.FAKE_GH_BUG_ISSUES;
    expect(outside).toMatchObject({ number: 6, checks: { dependencies: false }, missing: [4, 9] });
    // A title that matches an issue is found; one that matches none is flagged.
    setIssues(issue(2, { title: "Login page" }), issue(3, { body: "Depends on:\n- Login page\n- Billing page" }));
    expect((await list()).json().issues.find((i: any) => i.number === 3)).toMatchObject({ checks: { dependencies: false }, unmatched: ["Billing page"] });
  });

  it("says when the page was full", async () => {
    gh.setBugIssues(Array.from({ length: 100 }, (_v, k) => issue(k + 1)));
    const r = (await list()).json();
    expect(r.cut).toBe(true);
    expect(r.issues).toHaveLength(100);
  });
});

describe("what is left out", () => {
  it("leaves out issues that are built or have been built", async () => {
    const labelled = ["working", "waiting-approval", "needs-info", "done"].map((name, k) => issue(10 + k, { labels: [`factory:${name}`] }));
    setIssues(issue(1), issue(2), issue(3), issue(4), ...labelled);
    writeRun(2, "failed", { pr: "17" });
    writeRun(3, "failed", { pr: "18" });
    writeRun(4, "waiting");
    gh.setPulls([{ number: 17, state: "open" }, { number: 18, state: "closed", merged: false }]);
    // An open pull request, a waiting run and the status labels keep an issue out; a closed unmerged pull request does not.
    expect((await list()).json().issues.map((i: any) => i.number)).toEqual([3, 1]);
  });
});

describe("open sessions", () => {
  it("shows the session of the caller, not that of another account", async () => {
    setIssues(issue(1), issue(2));
    const source = (n: number) => ({ issue: n, url: `https://github.com/acme/app/issues/${n}`, title: "T", body: "", updatedAt: "2026-01-01T00:00:00.000Z" });
    const own = { ownerOk: () => true, repoName: (_o: string, n: string) => n };
    const mine = createSessionFromIssue(ann.user.id, { repo: "acme/app", title: "T", idea: "T", source: source(2) }, own);
    createSessionFromIssue(bob.user.id, { repo: "acme/app", title: "T", idea: "T", source: source(1) }, own);
    const r = (await list()).json().issues;
    expect(r.find((i: any) => i.number === 2).session).toBe(mine.id);
    expect(r.find((i: any) => i.number === 1).session).toBeUndefined();
  });
});

describe("no AI calls and no writes", () => {
  it("starts no run, queues nothing, and changes nothing on GitHub", async () => {
    setIssues(issue(1, { labels: ["bug"], body: STORY }), issue(2, { body: "Depends on: #7" }));
    const before = JSON.stringify(gh.bugIssues());
    const submit = vi.spyOn(started!.ctx.scheduler, "submit");
    expect((await list()).status).toBe(200);
    expect(submit).not.toHaveBeenCalled();
    expect(started!.ctx.scheduler.queue().pending).toEqual([]);
    expect(existsSync(runsDir) ? readdirSync(runsDir) : []).toEqual([]);
    expect(gh.ghLog()).not.toMatch(/-X (POST|PATCH|PUT|DELETE)|issue (edit|close|comment)|--method|label/);
    expect(JSON.stringify(gh.bugIssues())).toBe(before);
  });
});

describe("who may read it, and when GitHub fails", () => {
  it("refuses another account, also an admin; asks for a repository and a sign-in", async () => {
    setIssues(issue(1));
    expect((await list(bob, "acme/app")).status).toBe(403);
    expect((await list(admin, "acme/app")).status).toBe(403);
    expect((await get(ann, "/api/refinement/backlog")).status).toBe(400);
    expect((await get(ann, "/api/refinement/backlog?repo=nope")).status).toBe(400);
    expect((await get(undefined, "/api/refinement/backlog?repo=acme%2Fapp")).status).toBe(401);
  });
  it("answers 502 with the sign-in hint; refuses a repository on the server's own login", async () => {
    process.env.FAKE_GH_FAIL_API = "list";
    const r = await list();
    expect(r.status).toBe(502);
    expect(r.error()).toMatch(/check the repository's sign-in/);
    delete process.env.FAKE_GH_FAIL_API;
    addRepo(ann.user.id, { url: "acme/host", method: "none" });
    expect((await list(ann, "acme/host")).status).toBe(409);
  });
});
