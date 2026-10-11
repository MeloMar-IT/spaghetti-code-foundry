import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
import { labelNames } from "../src/queue/watcher.js";
import { CLOSES_LINE, originalComment, replaceMarker } from "../src/refinement/dependants.js";
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
let releases: (() => void)[] = [];
let goodFile: string | undefined;

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-close-"));
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
  for (const r of releases) r();
  releases = [];
  if (goodFile !== undefined) writeFileSync(refinementsPath(), goodFile);
  goodFile = undefined;
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
const publish = (id: string, body: unknown = {}) => call(ann, "POST", url(id, "publish"), body);
const view = async (id: string) => (await call(ann, "GET", `/api/refinement/${id}`)).json();
const hold = (on: string) => {
  const release = gh.hold(on);
  releases.push(release);
  return release;
};
const until = async (fn: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting for a line of the gh log");
    await new Promise((r) => setTimeout(r, 20));
  }
};
/** The details of the audit lines of the publish. */
const audited = (): string[] => readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === "refinement-publish").map((e) => e.detail as string);
const seen = (text: string) => gh.ghLog().split(text).length - 1;
const editFile = (fn: (f: any) => void) => {
  const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const markPublished = (id: string, numbers: number[]) =>
  editFile((f) => {
    const s = f.sessions.find((x: any) => x.id === id);
    const parts = s.drafts.filter((d: any) => d.part);
    numbers.forEach((n, i) => (parts[i].published = { issue: n, url: `https://github.com/acme/app/issues/${n}`, at: "2026-01-02T00:00:00.000Z" }));
    if (numbers.length === parts.length) s.state = "published";
  });
const seedComments = (m: Record<number, { body: string; own?: boolean }[]>) => {
  process.env.FAKE_GH_COMMENTS_BY_ISSUE = JSON.stringify(
    Object.fromEntries(Object.entries(m).map(([n, cs]) => [`acme/app#${n}`, { comments: cs.map((c) => ({ author: { login: "ann-gh" }, body: c.body, createdAt: "2026-01-01T00:00:00Z", viewerDidAuthor: c.own ?? true })) }])),
  );
};
const calls = (): string[] =>
  gh
    .ghLog()
    .split("\n")
    .flatMap((l) => {
      let m;
      if ((m = /^gh api repos\/acme\/app\/issues\/(\d+) -X PATCH/.exec(l))) return [`patch ${m[1]}`];
      if ((m = /^gh api repos\/acme\/app\/issues\/(\d+)$/.exec(l))) return [`read ${m[1]}`];
      if ((m = /^gh issue comment (\d+) /.exec(l))) return [`comment ${m[1]}`];
      if ((m = /^gh issue edit (\d+) /.exec(l))) return [`edit ${m[1]}`];
      return [];
    });
const writes = () => calls().filter((c) => !c.startsWith("read "));
const commentsOf = (n: number) => gh.comments().filter((c) => c.issue === n);
const STORY = ["As an admin, I want to export a report, so that I can share it.", "", "### Acceptance criteria", "- [ ] It exports a file", "- [ ] The file has a header"].join("\n");
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];
const issue = (n: number, o: Partial<FakeIssue> = {}): FakeIssue =>
  ({ number: n, state: "open", state_reason: null, title: "Old title", body: STORY, labels: [], html_url: `https://github.com/acme/app/issues/${n}`, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-02-03T04:05:06Z", closed_at: null, ...o }) as FakeIssue;
const withDeps = (n: number, text: string) => issue(n, { title: `Dependant ${n}`, body: `Some story\n\n### Depends on\n${text}\n` });
const change = (n: number, over: Partial<FakeIssue>) => gh.setBugIssues(gh.bugIssues().map((i) => (i.number === n ? { ...i, ...over } : i)));
const PART = { who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing" };

async function splitSession(others: FakeIssue[] = [], original: Partial<FakeIssue> = {}) {
  setRepoReady(annRepo().id, { items: LIST2 });
  gh.setBugIssues([issue(12, { title: "Export", ...original }), ...others]);
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
    expect((await call(ann, "PUT", url(id, `drafts/${p}`), PART)).status).toBe(200);
    expect((await call(ann, "POST", url(id, `drafts/${p}/ready-check`))).status).toBe(200);
  }
  return { id, did, parts };
}
async function dueSession(others: FakeIssue[] = [], original: Partial<FakeIssue> = {}) {
  const s = await splitSession(others, original);
  markPublished(s.id, [101, 102]);
  return s;
}
const comment = (id: string, ending: "closes" | "staysOpen", extra: { leftBehind?: string[] } = {}) =>
  originalComment({ ending, parts: [101, 102], by: "ann", marker: replaceMarker(id, 12), ...extra });

describe("the original is closed as not planned", () => {
  it("closes it after the comment, and the answer and the view say so", async () => {
    const { id } = await dueSession([withDeps(20, "#12")]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(writes()).toEqual(["patch 20", "comment 20", "comment 12", "patch 12"]);
    expect(commentsOf(12)).toHaveLength(1);
    expect(commentsOf(12)[0]!.body).toContain(CLOSES_LINE);
    expect(gh.closedIssues()).toEqual([{ issue: 12, state: "closed", state_reason: "not_planned" }]);
    expect(r.json().replaced.closed).toBe("not_planned");
    expect(typeof r.json().replaced.closedAt).toBe("string");
    expect((await view(id)).source).toMatchObject({ replace: "done", closed: "not_planned", closedAt: r.json().replaced.closedAt });
    expect(audited().some((l) => l.includes("#12"))).toBe(true);
  });

  it("writes in the order: creates, PATCH and comment per dependant, comment on the original, close", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    expect((await publish(id)).status).toBe(200);
    const log = gh.ghLog();
    expect(log.lastIndexOf("--- created issue")).toBeLessThan(log.indexOf("--- updated issue 20"));
    expect(writes().slice(-4)).toEqual(["patch 20", "comment 20", "comment 12", "patch 12"]);
    expect(gh.closedIssues()).toHaveLength(1);
  });

  it("does not close an original that was built meanwhile: 409 and it stays due", async () => {
    const { id } = await dueSession();
    const release = hold("issue comment 12");
    const pending = publish(id);
    await until(() => seen("gh issue comment 12 ") >= 1);
    change(12, { labels: [labelNames({}).working] } as any);
    release();
    const r = await pending;
    expect(r.status).toBe(409);
    expect(gh.closedIssues()).toEqual([]);
    expect((await view(id)).source.replace).toBe("due");
  });

  it("reports an original that was closed in another way meanwhile, without a close call", async () => {
    const { id } = await dueSession();
    const release = hold("issue comment 12");
    const pending = publish(id);
    await until(() => seen("gh issue comment 12 ") >= 1);
    change(12, { state: "closed", state_reason: "completed", closed_at: "2026-03-01T00:00:00Z" });
    release();
    const r = await pending;
    expect(r.status).toBe(200);
    expect(gh.closedIssues()).toEqual([]);
    expect(r.json().replaced.closed).toBe("other");
    expect(r.json().replaced).not.toHaveProperty("closedAt");
  });

  it("writes the 'stays open' comment for an original that was reopened while the dependants were handled", async () => {
    const { id } = await dueSession([withDeps(20, "#12")]);
    // The original is open now, so the comment must not say "closed already".
    expect((await publish(id)).status).toBe(200);
    expect(commentsOf(12)[0]!.body).not.toContain("closed already");
  });
});

describe("the original stays open", () => {
  it("when the open issues were cut: comment says so, no close", async () => {
    const fillers = Array.from({ length: 100 }, (_, i) => issue(200 + i, { title: `Filler ${i}`, body: "x" }));
    const { id } = await dueSession([...fillers]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    const body = commentsOf(12)[0]!.body;
    expect(body).toContain("stays open");
    expect(body).toContain("1,000");
    expect(body).not.toContain(CLOSES_LINE);
    expect(gh.closedIssues()).toEqual([]);
    expect(r.json().replaced.closed).toBe("open");
    expect(r.json().replaced).not.toHaveProperty("closedAt");
  });

  it("a cut repository with a closed original: other, or not_planned with the Foundry's comment", async () => {
    const fillers = Array.from({ length: 100 }, (_, i) => issue(200 + i, { title: `Filler ${i}`, body: "x" }));
    const { id } = await dueSession([...fillers]);
    change(12, { state: "closed", state_reason: "completed", closed_at: "2026-03-01T00:00:00Z" });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced.closed).toBe("other");
    expect(gh.closedIssues()).toEqual([]);
  });

  it("a cut repository with an original closed as not planned and the Foundry's comment there", async () => {
    const fillers = Array.from({ length: 100 }, (_, i) => issue(200 + i, { title: `Filler ${i}`, body: "x" }));
    const { id } = await dueSession([...fillers]);
    seedComments({ 12: [{ body: comment(id, "staysOpen") }] });
    change(12, { state: "closed", state_reason: "not_planned", closed_at: "2026-03-01T00:00:00Z" });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced).toMatchObject({ closed: "not_planned", closedAt: "2026-03-01T00:00:00.000Z" });
    expect(writes()).toEqual([]);
  });

  it("when a dependant must be changed by hand", async () => {
    const { id } = await dueSession([withDeps(21, "Export")]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(commentsOf(12)[0]!.body).toContain("stays open");
    expect(gh.closedIssues()).toEqual([]);
    expect(r.json().replaced.closed).toBe("open");
  });

  it("when a dependant the journal has as rewritten names the original again", async () => {
    const { id } = await dueSession([withDeps(20, "#12")]);
    editFile((f) => {
      f.sessions.find((x: any) => x.id === id).source.replacing = { parts: [101, 102], dependants: [{ issue: 20, title: "Dependant 20", done: true, outcome: "rewritten" }] };
    });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(commentsOf(12)[0]!.body).toContain("stays open");
    expect(gh.closedIssues()).toEqual([]);
    expect(r.json().replaced.closed).toBe("open");
  });

  it("when a dependant was only checked (journal)", async () => {
    const { id } = await dueSession([withDeps(21, "Export")]);
    editFile((f) => {
      f.sessions.find((x: any) => x.id === id).source.replacing = { parts: [101, 102], dependants: [{ issue: 22, title: "Dependant 22", done: true, outcome: "check" }] };
    });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced.closed).toBe("open");
    expect(gh.closedIssues()).toEqual([]);
  });

  it("when the original is a monitor story (marker in the text)", async () => {
    const { id } = await dueSession([], { body: `${STORY}\n\n<!-- claude-factory monitor=0123456789abcdef -->` });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(commentsOf(12)[0]!.body).toContain("stays open");
    expect(gh.closedIssues()).toEqual([]);
    expect(r.json().replaced.closed).toBe("open");
  });

  it("when a finding of the monitor remembers it, also without the marker", async () => {
    const { saveFindings } = await import("../src/monitor/findings.js");
    const { id } = await dueSession();
    const at = new Date().toISOString();
    saveFindings([{ detector: "d", fingerprint: "f", severity: "minor", about: "foundry", summary: "s", firstSeen: at, lastSeen: at, count: 1, gone: false, evidence: {}, report: { repo: "acme/app", issue: 12, url: "u", at, seen: 1 } } as any]);
    const plan = (await call(ann, "GET", url(id, "publish"))).json();
    expect(plan.replaces.staysOpen).toBe(true);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(gh.closedIssues()).toEqual([]);
    expect(r.json().replaced.closed).toBe("open");
  });

  it("a 'stays open' comment of an older version is not closed, also when a criterion repeats the closing sentence", async () => {
    const { id } = await dueSession();
    seedComments({ 12: [{ body: comment(id, "staysOpen", { leftBehind: [CLOSES_LINE] }) }] });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced.closed).toBe("open");
    expect(writes()).toEqual([]);
  });
});

describe("retries", () => {
  it("after the comment failed: one comment, then the close", async () => {
    const { id } = await dueSession();
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    const again = await publish(id);
    expect(again.status).toBe(200);
    expect(commentsOf(12)).toHaveLength(1);
    expect(gh.closedIssues()).toHaveLength(1);
  });

  it("after the close failed: no second comment, one close, and the audit names the original", async () => {
    const { id } = await dueSession();
    process.env.FAKE_GH_FAIL_API = "update";
    const failed = await publish(id);
    expect(failed.status).toBe(502);
    expect(failed.error()).toContain("did not close issue #12");
    expect((await view(id)).source.replace).toBe("due");
    delete process.env.FAKE_GH_FAIL_API;
    seedComments({ 12: commentsOf(12).map((c) => ({ body: c.body })) });
    const again = await publish(id);
    expect(again.status).toBe(200);
    expect(commentsOf(12)).toHaveLength(1);
    expect(gh.closedIssues()).toHaveLength(1);
    expect(again.json().replaced.closed).toBe("not_planned");
    // The close is the only write of the retry: its audit line still names the original.
    expect(audited().at(-1)).toContain("#12");
  });

  it("the close landed but was not recorded: no comment, no close call, closedAt set", async () => {
    const { id } = await dueSession();
    seedComments({ 12: [{ body: comment(id, "closes") }] });
    change(12, { state: "closed", state_reason: "not_planned", closed_at: "2026-03-01T00:00:00Z" });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(writes()).toEqual([]);
    expect(r.json().replaced).toMatchObject({ closed: "not_planned", closedAt: "2026-03-01T00:00:00.000Z" });
  });

  it("a session write that fails after the close: 500 that says it was closed, and the retry writes nothing twice", async () => {
    const { id } = await dueSession();
    const on = "issues/12 -X PATCH";
    const release = hold(on);
    const before = seen(on);
    const pending = publish(id, {});
    await until(() => seen(on) > before);
    goodFile = readFileSync(refinementsPath(), "utf8");
    writeFileSync(refinementsPath(), "not json");
    release();
    const r = await pending;
    writeFileSync(refinementsPath(), goodFile);
    goodFile = undefined;
    expect(r.status).toBe(500);
    expect(r.error()).toMatch(/#12 was closed/);
    expect(r.error()).toMatch(/publish again/i);
    seedComments({ 12: commentsOf(12).map((c) => ({ body: c.body })) });
    const again = await publish(id, {});
    expect(again.status).toBe(200);
    expect(commentsOf(12)).toHaveLength(1);
    expect(seen("--- closed issue 12")).toBe(1);
    expect((await view(id)).source).toMatchObject({ replace: "done", closed: "not_planned" });
    expect(typeof (await view(id)).source.closedAt).toBe("string");
  });
});

describe("sessions finished under 9e-3", () => {
  it("stay done and are not closed afterwards", async () => {
    const { id } = await dueSession();
    editFile((f) => {
      const s = f.sessions.find((x: any) => x.id === id);
      s.source.replacedBy = [101, 102];
      s.source.closed = "open";
      delete s.source.replacing;
    });
    const r = await publish(id, {});
    expect(r.status).toBe(200);
    expect(r.json()).not.toHaveProperty("replaced");
    expect(writes()).toEqual([]);
    expect((await view(id)).source).toMatchObject({ replace: "done", closed: "open" });
  });
});
