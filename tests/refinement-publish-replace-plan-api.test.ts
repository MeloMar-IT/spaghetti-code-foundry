import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
import { beginPublishing, endPublishing, recordDependantDone, recordDependantWrite, recordReplacing, refinementsPath } from "../src/refinement/store.js";
import { saveFindings } from "../src/monitor/findings.js";
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
  tmp = mkdtempSync(join(tmpdir(), "refinement-replace-plan-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000, openIssuePages: 1 };
  started = await startServer(opts);
  await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  gh.setLabels(["bug", "Factory_go", "Factory_review_plan", "Area:API"]);
});
afterEach(async () => {
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
const plan = (id: string) => call(ann, "GET", url(id, "publish"));
const view = async (id: string) => (await call(ann, "GET", `/api/refinement/${id}`)).json();
const actor = () => ({ id: ann.user.id, admin: false });
const nothingWritten = () => expect(gh.ghLog()).not.toMatch(/-X (POST|PATCH|PUT|DELETE)|issue (edit|close|comment)|--method/);

const STORY = [
  "As an admin, I want to export a report, so that I can share it.",
  "",
  "### Acceptance criteria",
  "- [ ] It exports a file",
  "- [ ] The file has a header",
].join("\n");
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];

const issue = (n: number, o: Partial<FakeIssue> = {}): FakeIssue =>
  ({
    number: n,
    state: "open",
    state_reason: null,
    title: "Old title",
    body: STORY,
    labels: [],
    html_url: `https://github.com/acme/app/issues/${n}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-03T04:05:06Z",
    closed_at: null,
    ...o,
  }) as FakeIssue;
const withDeps = (n: number, text: string) => issue(n, { title: `Dependant ${n}`, body: `Some story\n\n### Depends on\n${text}\n` });
const change = (n: number, over: Partial<FakeIssue>) => gh.setBugIssues(gh.bugIssues().map((i) => (i.number === n ? { ...i, ...over } : i)));

/** Imports issue 12 ("Export") with the given other issues on GitHub, splits it into "First" and "Second", and makes both parts ready. */
async function splitSession(others: FakeIssue[] = []) {
  setRepoReady(annRepo().id, { items: LIST2 });
  gh.setBugIssues([issue(12, { title: "Export" }), ...others]);
  const made = await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 12 });
  expect(made.status).toBe(201);
  const id = made.json().id as string;
  const did = made.json().drafts[0].id as string;
  const c = made.json().drafts[0].criteria.map((k: any) => k.id);
  const body = { parts: [{ title: "First", criteria: [c[0]], dependsOn: [] }, { title: "Second", criteria: [c[1]], dependsOn: [] }], unplaced: [] };
  const r = await call(ann, "POST", url(id, `drafts/${did}/split/confirm`), body);
  expect(r.status).toBe(201);
  const parts = r.json().drafts.filter((d: any) => d.part).map((d: any) => d.id) as string[];
  for (const p of parts) {
    expect((await call(ann, "PUT", url(id, `drafts/${p}`), { who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing" })).status).toBe(200);
    expect((await call(ann, "POST", url(id, `drafts/${p}/ready-check`))).status).toBe(200);
  }
  return { id, parts };
}

describe("the publish plan of a split issue", () => {
  it("lists the parts and the dependants, and writes nothing", async () => {
    const { id } = await splitSession([withDeps(20, "#12"), withDeps(21, "Export")]);
    const before = readFileSync(refinementsPath(), "utf8");
    const r = await plan(id);
    expect(r.status).toBe(200);
    expect(r.json().replaces).toEqual({
      issue: 12,
      parts: [{ item: 1, title: "First" }, { item: 2, title: "Second" }],
      ready: true,
      staysOpen: true,
      dependants: [
        { issue: 20, title: "Dependant 20", before: "#12", after: "new issue 1, new issue 2" },
        { issue: 21, title: "Dependant 21", byHand: true },
      ],
    });
    expect(r.json()).not.toHaveProperty("notChanged");
    nothingWritten();
    expect(readFileSync(refinementsPath(), "utf8")).toBe(before);
    expect((await view(id)).source.replace).toBe("waiting");
  });

  it("says cut when there are more open issues than the pages read", async () => {
    const fillers = Array.from({ length: 99 }, (_, i) => issue(200 + i, { title: `Filler ${i}`, body: "x" }));
    const { id } = await splitSession([withDeps(20, "#12"), ...fillers]);
    const r = (await plan(id)).json().replaces;
    expect(r.cut).toBe(true);
    expect(r.staysOpen).toBe(true);
    expect(r.dependants.map((d: any) => d.issue)).toEqual([20]);
  });

  it("has no staysOpen in the plain case, and has it for a monitor story or one a finding remembers", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    expect((await plan(id)).json().replaces).not.toHaveProperty("staysOpen");
    change(12, { body: `${STORY}\n\n<!-- claude-factory monitor=0123456789abcdef -->` });
    expect((await plan(id)).json().replaces.staysOpen).toBe(true);
    // The marker was taken out, but a finding of the monitor still remembers the issue.
    change(12, { body: STORY });
    expect((await plan(id)).json().replaces).not.toHaveProperty("staysOpen");
    const at = new Date().toISOString();
    saveFindings([{ detector: "d", fingerprint: "f", severity: "minor", about: "foundry", summary: "s", firstSeen: at, lastSeen: at, count: 1, gone: false, evidence: { lines: [] }, report: { repo: "acme/app", issue: 12, url: "u", at, seen: 1 } } as any]);
    expect((await plan(id)).json().replaces.staysOpen).toBe(true);
  });

  it("finds title references with the live title of a closed original, and falls back to the stored one", async () => {
    const { id } = await splitSession([withDeps(21, "Renamed export")]);
    change(12, { state: "closed", state_reason: "completed", closed_at: "2026-03-01T00:00:00Z", title: "Renamed export" });
    expect((await plan(id)).json().replaces.dependants).toEqual([{ issue: 21, title: "Dependant 21", byHand: true }]);
    // A pull request is not the issue: the stored title is used.
    change(12, { pull_request: {} } as any);
    expect((await plan(id)).json().replaces.dependants).toEqual([]);
    gh.setBugIssues(gh.bugIssues().map((i) => (i.number === 21 ? withDeps(21, "Export") : i)).filter((i) => i.number !== 12));
    expect((await plan(id)).json().replaces.dependants).toEqual([{ issue: 21, title: "Dependant 21", byHand: true }]);
    nothingWritten();
  });

  it("lists a stored entry the scan no longer finds, leaves out done ones, and follows a replacement to its end", async () => {
    const { id, parts } = await splitSession([withDeps(20, "#101, #102"), withDeps(22, "Done one")]);
    expect(beginPublishing(id)).toBe(true);
    const found = [
      { issue: 20, title: "Dependant 20", before: "#12", after: "#101, #102" },
      { issue: 22, title: "Dependant 22", byHand: true as const },
    ];
    recordReplacing(actor(), id, { parts: [101, 102], found, cut: true });
    recordDependantWrite(actor(), id, 20, { before: "#12", after: "#101, #102", rangeBefore: "#12", rangeAfter: "#101, #102" });
    recordDependantDone(actor(), id, 22, "by-hand");
    endPublishing(id);

    let v = await view(id);
    expect(v.source.replace).toBe("waiting");
    expect(v.source).not.toHaveProperty("replacing");

    const r = (await plan(id)).json().replaces;
    expect(r.cut).toBe(true);
    expect(r.dependants).toEqual([{ issue: 20, title: "Dependant 20", before: "#12", after: "#101, #102" }]);
    expect(JSON.stringify(r)).not.toMatch(/rangeAfter|outcome/);

    // Both parts are made by this publish, which then finishes the replacement.
    const done = await call(ann, "POST", url(id, "publish"), {});
    expect(done.status).toBe(200);
    v = await view(id);
    expect(parts).toHaveLength(2);
    expect(done.json().replaced).toMatchObject({ issue: 12, parts: [101, 102] });
    expect(v.source).toMatchObject({ replace: "done", replacedBy: [101, 102], closed: "open" });
    expect(v.source).not.toHaveProperty("replacing");
    const after = (await plan(id)).json();
    expect(after).not.toHaveProperty("replaces");
    expect(after).not.toHaveProperty("notChanged");
  });

  it("answers 502 when GitHub cannot be read", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    process.env.FAKE_GH_FAIL_API = "list";
    const l = await plan(id);
    expect(l.status).toBe(502);
    expect(l.error()).toMatch(/could not read the open issues on GitHub/);
    process.env.FAKE_GH_FAIL_API = "read";
    const r = await plan(id);
    expect(r.status).toBe(502);
    expect(r.error()).toMatch(/could not read issue #12 on GitHub/);
    delete process.env.FAKE_GH_FAIL_API;
    // A session that was not split has no replace in its view and no replaces in its plan.
    gh.setBugIssues([...gh.bugIssues(), issue(13, { title: "Other" })]);
    const plain = (await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 13 })).json().id as string;
    const v = await view(plain);
    expect(v.source).not.toHaveProperty("replace");
    expect(v.source).not.toHaveProperty("replacing");
    expect((await plan(plain)).json()).not.toHaveProperty("replaces");
  });
});
