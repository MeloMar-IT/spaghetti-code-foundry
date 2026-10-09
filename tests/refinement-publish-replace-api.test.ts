import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
import { labelNames } from "../src/queue/watcher.js";
import { replaceMarker } from "../src/refinement/dependants.js";
import { refinementsPath } from "../src/refinement/store.js";
import { addRepoWatcher } from "../src/repos/watchers.js";
import { auditLines, newLedger } from "../src/server/api-refinement-replace.js";
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
  tmp = mkdtempSync(join(tmpdir(), "refinement-replace-"));
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
  delete process.env.FAKE_GH_FAIL;
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
const publish = (id: string, body: unknown = {}) => call(ann, "POST", url(id, "publish"), body);
const view = async (id: string) => (await call(ann, "GET", `/api/refinement/${id}`)).json();
const watch = () => {
  addRepoWatcher(annRepo().id, { id: "app-w", label: "Factory_go" });
  started!.ctx.watchers.sync();
};
const stored = (id: string) => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions.find((s: any) => s.id === id);
const editFile = (fn: (f: any) => void) => {
  const f = JSON.parse(readFileSync(refinementsPath(), "utf8"));
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
/** The parts of a session are on GitHub as these issues (in the file, as an old session or an earlier publish left them). */
const markPublished = (id: string, numbers: number[]) =>
  editFile((f) => {
    const s = f.sessions.find((x: any) => x.id === id);
    const parts = s.drafts.filter((d: any) => d.part);
    numbers.forEach((n, i) => (parts[i].published = { issue: n, url: `https://github.com/acme/app/issues/${n}`, at: "2026-01-02T00:00:00.000Z" }));
    if (numbers.length === parts.length) s.state = "published";
  });

/** What the fake gh was asked to read, change or comment, in order: "read 20", "patch 20", "comment 20", "edit 12". */
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
const of = (n: number) => calls().filter((c) => c.endsWith(` ${n}`));
const commentsOf = (n: number) => gh.comments().filter((c) => c.issue === n);
const nothingWritten = () => expect(gh.ghLog()).not.toMatch(/-X (POST|PATCH|PUT|DELETE)|issue (edit|close|comment)|--method/);

const STORY = ["As an admin, I want to export a report, so that I can share it.", "", "### Acceptance criteria", "- [ ] It exports a file", "- [ ] The file has a header"].join("\n");
const STORY3 = `${STORY}\n- [ ] It keeps SENT_LEFT_CRITERION`;
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
const withDeps = (n: number, text: string) => issue(n, { title: `Dependant ${n}`, body: `Some story\n\n### Depends on\n${text}\n` });
const change = (n: number, over: Partial<FakeIssue> & { labels?: string[] }) => {
  const { labels, ...rest } = over;
  gh.setBugIssues(gh.bugIssues().map((i) => (i.number === n ? { ...i, ...rest, ...(labels ? { labels: labels.map((name) => ({ name })) } : {}) } : i)));
};
const PART = { who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing" };
const readyPart = async (id: string, p: string) => {
  expect((await call(ann, "PUT", url(id, `drafts/${p}`), PART)).status).toBe(200);
  expect((await call(ann, "POST", url(id, `drafts/${p}/ready-check`))).status).toBe(200);
};

/** Imports issue 12 with the other issues on GitHub, splits it into "First" and "Second", and makes the parts ready (not those that are false in `ready`). */
async function splitSession(others: FakeIssue[] = [], o: { ready?: boolean[]; story?: string; unplaced?: boolean; original?: Partial<FakeIssue> & { labels?: string[] } } = {}) {
  setRepoReady(annRepo().id, { items: LIST2 });
  gh.setBugIssues([issue(12, { title: "Export", ...(o.story ? { body: o.story } : {}), ...o.original }), ...others]);
  const made = await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 12 });
  expect(made.status).toBe(201);
  const id = made.json().id as string;
  const did = made.json().drafts[0].id as string;
  const c = made.json().drafts[0].criteria.map((k: any) => k.id);
  const body = { parts: [{ title: "First", criteria: [c[0]], dependsOn: [] }, { title: "Second", criteria: [c[1]], dependsOn: [] }], unplaced: o.unplaced ? [c[2]] : [] };
  const r = await call(ann, "POST", url(id, `drafts/${did}/split/confirm`), body);
  expect(r.status).toBe(201);
  const parts = r.json().drafts.filter((d: any) => d.part).map((d: any) => d.id) as string[];
  for (const [i, p] of parts.entries()) if (o.ready?.[i] !== false) await readyPart(id, p);
  return { id, did, parts };
}

describe("publishing a split issue replaces it", () => {
  it("rewrites the dependants, comments, and comments on the original last", async () => {
    const { id } = await splitSession([withDeps(20, "#12"), withDeps(21, "Export")]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    const j = r.json();
    expect(j.created.map((m: any) => m.issue)).toEqual([101, 102]);
    expect(j.replaced).toEqual({
      issue: 12,
      parts: [101, 102],
      dependants: [{ issue: 20, outcome: "rewritten" }, { issue: 21, outcome: "by-hand" }],
    });
    expect(j).not.toHaveProperty("notChanged");

    // One PATCH, of #20 only, with the body and no title; the original is neither changed nor closed.
    const patches = gh.updatedBodies();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.issue).toBe(20);
    expect(patches[0]).not.toHaveProperty("title");
    expect(patches[0]!.body).toContain("#101, #102");
    expect(patches[0]!.body).toContain("Some story");
    expect(patches[0]!.body).not.toContain("#12");
    expect(gh.closedIssues()).toEqual([]);
    expect(calls()).not.toContain("patch 12");

    // The comments, each with its marker as the last line.
    const c20 = commentsOf(20);
    expect(c20).toHaveLength(1);
    expect(c20[0]!.body).toMatch(/\*\*Before\*\*[\s\S]*#12[\s\S]*\*\*After\*\*[\s\S]*#101, #102/);
    expect(c20[0]!.body.split("\n").at(-1)).toBe(replaceMarker(id, 20));
    const c21 = commentsOf(21);
    expect(c21).toHaveLength(1);
    expect(c21[0]!.body).toContain("by hand");
    expect(c21[0]!.body).not.toContain("**Before**");
    const c12 = commentsOf(12);
    expect(c12).toHaveLength(1);
    expect(c12[0]!.body).toContain("#101, #102");
    expect(c12[0]!.body).toContain("close it by hand");
    expect(c12[0]!.body.split("\n").at(-1)).toBe(replaceMarker(id, 12));

    // The order: each dependant read, read again, changed, commented, in issue-number order; the original last.
    expect(of(20)).toEqual(["read 20", "read 20", "patch 20", "comment 20"]);
    expect(of(21)).toEqual(["read 21", "comment 21"]);
    const writes = calls().filter((c) => /^(patch|comment|edit) /.test(c));
    expect(writes).toEqual(["patch 20", "comment 20", "comment 21", "comment 12"]);
    expect(calls().indexOf("comment 20")).toBeLessThan(calls().indexOf("read 21"));

    // The session.
    const v = await view(id);
    expect(v.source).toMatchObject({ replace: "done", closed: "open", replacedBy: [101, 102] });
    expect(v.source).not.toHaveProperty("replacing");
    expect(stored(id).source).not.toHaveProperty("replacing");
    const after = (await plan(id)).json();
    expect(after).not.toHaveProperty("replaces");
    expect(after).not.toHaveProperty("notChanged");
  });

  it("makes only the ready parts while a part is not ready, and finishes with a later publish", async () => {
    const { id, parts } = await splitSession([withDeps(20, "#12")], { ready: [true, false] });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().created).toHaveLength(1);
    expect(r.json()).not.toHaveProperty("replaced");
    expect(calls().filter((c) => /^(patch|comment|edit) /.test(c))).toEqual([]);
    expect(of(20)).toEqual([]);
    expect((await view(id)).source.replace).toBe("waiting");
    expect(stored(id).source).not.toHaveProperty("replacing");

    await readyPart(id, parts[1]!);
    const done = await publish(id);
    expect(done.status).toBe(200);
    expect(done.json().replaced).toMatchObject({ issue: 12, parts: [101, 102], dependants: [{ issue: 20, outcome: "rewritten" }] });
    expect((await view(id)).source.replace).toBe("done");
  });

  it("publishes `{}` for a published session that is due, also an old one", async () => {
    const { id } = await splitSession([withDeps(20, "#101, #102")]);
    markPublished(id, [101, 102]);
    expect((await view(id)).source.replace).toBe("due");
    const r = await publish(id, {});
    expect(r.status).toBe(200);
    expect(r.json().created).toEqual([]);
    expect(r.json().replaced).toMatchObject({ issue: 12, parts: [101, 102] });
    expect((await view(id)).source).toMatchObject({ replace: "done", closed: "open" });
  });

  it("adds the 1,000 issue warning when the open issues were cut", async () => {
    const fillers = Array.from({ length: 99 }, (_, i) => issue(200 + i, { title: `Filler ${i}`, body: "x" }));
    const { id } = await splitSession([withDeps(20, "#12"), ...fillers]);
    expect((await publish(id)).status).toBe(200);
    expect(commentsOf(12)[0]!.body).toContain("1,000");
  });

  it("lists the acceptance criteria left behind on the original", async () => {
    const { id } = await splitSession([], { story: STORY3, unplaced: true });
    expect((await publish(id)).status).toBe(200);
    const body = commentsOf(12)[0]!.body;
    expect(body).toContain("- It keeps SENT_LEFT_CRITERION");
    expect(body.split("\n").at(-1)).toBe(replaceMarker(id, 12));
  });

  it("takes the trigger label off the original before it comments, and not when there is none", async () => {
    watch();
    const { id } = await splitSession([], { original: { labels: ["bug", "Factory_go"] } });
    expect(stored(id).source.buildLabel).toBe("Factory_go");
    expect((await publish(id)).status).toBe(200);
    expect(gh.ghLog()).toMatch(/gh issue edit 12 --repo acme\/app --remove-label Factory_go\n/);
    expect(calls().filter((c) => c.endsWith(" 12")).slice(-2)).toEqual(["edit 12", "comment 12"]);
    expect(commentsOf(12)[0]!.body).toContain("`Factory_go`");
    expect(gh.bugIssues().find((i) => i.number === 12)!.labels.map((l) => l.name)).toEqual(["bug"]);
    expect(stored(id).source).not.toHaveProperty("buildLabel");
    expect(stored(id).source).not.toHaveProperty("replacing");
  });

  it("takes the trigger label off a closed original too, so that reopening it starts no build", async () => {
    watch();
    const { id } = await splitSession([], { original: { labels: ["Factory_go"] } });
    markPublished(id, [50]);
    change(12, { state: "closed", state_reason: "completed", closed_at: "2026-03-01T00:00:00Z" });
    expect((await publish(id)).status).toBe(200);
    expect(calls()).toContain("edit 12");
    expect(gh.bugIssues().find((i) => i.number === 12)!.labels).toEqual([]);
    expect(commentsOf(12)[0]!.body).toContain("closed already");
    expect(commentsOf(12)[0]!.body).toContain("`Factory_go`");
  });

  it("forgets the build label also when it was taken off by hand before the publish", async () => {
    watch();
    const { id } = await splitSession([], { original: { labels: ["Factory_go"] } });
    expect(stored(id).source.buildLabel).toBe("Factory_go");
    change(12, { labels: [] });
    expect((await publish(id)).status).toBe(200);
    expect(calls()).not.toContain("edit 12");
    expect(stored(id).source).not.toHaveProperty("buildLabel");
    expect(commentsOf(12)[0]!.body).not.toContain("taken off");
  });

  it("does not take the label off a second time when the comment on the original failed", async () => {
    watch();
    const { id } = await splitSession([], { original: { labels: ["Factory_go"] } });
    process.env.FAKE_GH_FAIL = "issue comment";
    const failed = await publish(id);
    expect(failed.status).toBe(502);
    expect(failed.error()).toMatch(/#12 lost a label/);
    expect(failed.error()).not.toMatch(/nothing was written/);
    delete process.env.FAKE_GH_FAIL;
    const again = await publish(id);
    expect(again.status).toBe(200);
    expect(calls().filter((c) => c === "edit 12")).toHaveLength(1);
    expect(commentsOf(12)[0]!.body).toContain("`Factory_go`");
  });
});

describe("the checks before the first write", () => {
  it("refuses a closed original that was not started, with nothing written", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    change(12, { state: "closed", state_reason: "completed", closed_at: "2026-03-01T00:00:00Z" });
    const r = await publish(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/closed/);
    expect(r.error()).toMatch(/nothing was written/);
    nothingWritten();
  });

  it("refuses an original that is built, and says nothing was written only when that is true", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    change(12, { labels: [labelNames({}).working] });
    const r = await publish(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/nothing was written/);
    nothingWritten();

    // The replacement has started (a part is on GitHub): the answer does not say that, and the original gets no comment.
    markPublished(id, [50]);
    const s = await publish(id);
    expect(s.status).toBe(409);
    expect(s.error()).not.toMatch(/nothing was written/);
    expect(commentsOf(12)).toEqual([]);
    nothingWritten();
  });

  it("goes on with a closed original once the replacement has started, and says it was closed already", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    markPublished(id, [50]);
    change(12, { state: "closed", state_reason: "completed", closed_at: "2026-03-01T00:00:00Z" });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced).toMatchObject({ issue: 12, parts: [50, 101] });
    const v = await view(id);
    expect(v.source).toMatchObject({ replace: "done", closed: "other", closedAt: "2026-03-01T00:00:00.000Z" });
    expect(commentsOf(12)[0]!.body).toContain("closed already");
    expect(calls()).not.toContain("patch 12");
  });

  it("does not read the original in a publish that makes no part and is not due", async () => {
    const { id } = await splitSession([], { ready: [false, false] });
    // a story that is not a part
    const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts.at(-1).id as string;
    expect((await call(ann, "PUT", url(id, `drafts/${did}`), { title: "Extra", ...PART })).status).toBe(200);
    expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(200);
    const logBefore = gh.ghLog().length;
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().created).toHaveLength(1);
    // (the import read the original before; the publish does not)
    expect(gh.ghLog().slice(logBefore)).not.toMatch(/issues\/12\b/);
  });
});

describe("session rules", () => {
  it("refuses a new import of the original while the replacement is due, and lets it pass once the session is dropped", async () => {
    const { id } = await splitSession();
    markPublished(id, [101, 102]);
    const dup = await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 12 });
    expect(dup.status).toBe(409);
    expect(dup.json().session).toBe(id);
    expect((await call(ann, "POST", url(id, "drop"))).status).toBe(200);
    expect((await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 12 })).status).toBe(201);
  });

  it("refuses to remove the split draft once a part is on GitHub, and allows it before", async () => {
    const first = await splitSession();
    expect((await call(ann, "DELETE", url(first.id, `drafts/${first.did}`))).status).toBe(200);
    await call(ann, "POST", url(first.id, "drop"));
    gh.setBugIssues([]);
    const second = await splitSession();
    markPublished(second.id, [50]);
    const r = await call(ann, "DELETE", url(second.id, `drafts/${second.did}`));
    expect(r.status).toBe(409);
    expect(stored(second.id).drafts.some((d: any) => d.id === second.did)).toBe(true);
  });
});

describe("the audit", () => {
  it("writes one line with every number written, once", async () => {
    const { id } = await splitSession([withDeps(20, "#12"), withDeps(21, "Export")]);
    expect((await publish(id)).status).toBe(200);
    const lines = readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.action === "refinement-publish");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ target: id });
    const nums = (lines[0].detail as string).match(/#\d+/g)!;
    expect([...nums].sort()).toEqual(["#101", "#102", "#12", "#20", "#21"]);
  });
});

describe("issue text on the command line", () => {
  it("never puts a title, text, range or criterion into the arguments of a gh call", async () => {
    const sentinels = ["SENT_TITLE_ORIGINAL", "SENT_TITLE_DEP", "SENT_BODY_DEP", "SENT_RANGE_DEP", "SENT_LEFT_CRITERION"];
    const dep20 = issue(20, { title: "SENT_TITLE_DEP", body: "Some story SENT_BODY_DEP\n\n### Depends on\n#12 SENT_RANGE_DEP\n" });
    const dep21 = issue(21, { title: "Other SENT_TITLE_DEP", body: "Story\n\n### Depends on\nExport SENT_TITLE_ORIGINAL\n" });
    const { id } = await splitSession([dep20, dep21], { story: STORY3, unplaced: true, original: { title: "Export SENT_TITLE_ORIGINAL" } });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced.dependants.map((d: any) => d.issue)).toEqual([20, 21]);
    const log = gh.ghLog();
    const commandLines = log.split("\n").filter((l) => l.startsWith("gh "));
    expect(commandLines.length).toBeGreaterThan(10);
    for (const s of sentinels) expect(commandLines.filter((l) => l.includes(s))).toEqual([]);
    // The text that is written did reach GitHub, through stdin.
    for (const s of ["SENT_BODY_DEP", "SENT_RANGE_DEP", "SENT_LEFT_CRITERION"]) expect(log).toContain(s);
  });
});

describe("auditLines", () => {
  it("gives one line for a few numbers", () => {
    expect(auditLines("acme/app", [3, 1, 3, 2])).toEqual(["acme/app #3,#1,#2"]);
    expect(auditLines("acme/app", [])).toEqual([]);
  });

  it("cuts a long list into lines of at most 500 characters that end in (i/n), every number once", () => {
    const numbers = Array.from({ length: 400 }, (_, i) => 100_000 + i);
    const lines = auditLines("acme/app", numbers);
    expect(lines.length).toBeGreaterThan(1);
    lines.forEach((l, i) => {
      expect(l.length).toBeLessThanOrEqual(500);
      expect(l.endsWith(` (${i + 1}/${lines.length})`)).toBe(true);
    });
    const seen = lines.flatMap((l) => l.replace(/^acme\/app /, "").replace(/ \(\d+\/\d+\)$/, "").split(","));
    expect(seen).toEqual(numbers.map((n) => `#${n}`));
  });
});

describe("the ledger", () => {
  it("says nothing was written only when it is empty, and names the writes", () => {
    const l = newLedger();
    expect(l.text()).toBe("nothing was written");
    expect(l.last()).toBeUndefined();
    l.add({ issue: 101, what: "found" });
    expect(l.text()).toBe("nothing was written");
    expect(l.numbers()).toEqual([101]);
    l.add({ issue: 20, what: "rewritten" });
    l.add({ issue: 20, what: "commented" });
    expect(l.text()).toBe("written so far: #20 was changed, #20 got a comment");
    expect(l.last()).toBe("#20 got a comment");
    expect(l.numbers()).toEqual([101, 20]);
  });

  it("names the last ten writes only", () => {
    const l = newLedger();
    for (let i = 1; i <= 12; i++) l.add({ issue: i, what: "created" });
    const t = l.text();
    expect(t.startsWith("written so far: … #3 was made")).toBe(true);
    expect(t.endsWith("#12 was made")).toBe(true);
    expect(t).not.toContain("#2 was made");
    expect(l.numbers()).toHaveLength(12);
  });
});
