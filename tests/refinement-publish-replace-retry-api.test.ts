import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, setRepoReady } from "../src/auth/repos.js";
import { APP_NO_AUTHOR, withGhEnv } from "../src/github.js";
import { replaceMarker } from "../src/refinement/dependants.js";
import { LOG_LIMIT, refinementsPath } from "../src/refinement/store.js";
import { hasOwnComment } from "../src/server/api-refinement-replace.js";
import { HttpError } from "../src/server/http.js";
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
/** Every hold of a test is released in afterEach, and the session file is put back there too. */
let releases: (() => void)[] = [];
let goodFile: string | undefined;

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-replace-retry-"));
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
const hold = (on: string, name = "hold") => {
  const release = gh.hold(on, name);
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
/** How often the gh log has this text. */
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
const seedJournal = (id: string, dependants: unknown[]) =>
  editFile((f) => {
    f.sessions.find((x: any) => x.id === id).source.replacing = { parts: [101, 102], dependants };
  });
/** The own comments the fake issues have (what GitHub would show after a comment landed). */
const seedComments = (m: Record<number, { body: string; own?: boolean; login?: string }[]>) => {
  process.env.FAKE_GH_COMMENTS_BY_ISSUE = JSON.stringify(
    Object.fromEntries(
      Object.entries(m).map(([n, cs]) => [
        `acme/app#${n}`,
        { comments: cs.map((c) => ({ author: { login: c.login ?? "ann-gh" }, body: c.body, createdAt: "2026-01-01T00:00:00Z", ...(c.own !== undefined ? { viewerDidAuthor: c.own } : {}) })) },
      ]),
    ),
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
const commentsOf = (n: number) => gh.comments().filter((c) => c.issue === n);
const patchesOf = (n: number) => gh.updatedBodies().filter((p) => p.issue === n);

const STORY = ["As an admin, I want to export a report, so that I can share it.", "", "### Acceptance criteria", "- [ ] It exports a file", "- [ ] The file has a header"].join("\n");
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
const PART = { who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing" };
const readyPart = async (id: string, p: string) => {
  expect((await call(ann, "PUT", url(id, `drafts/${p}`), PART)).status).toBe(200);
  expect((await call(ann, "POST", url(id, `drafts/${p}/ready-check`))).status).toBe(200);
};

async function splitSession(others: FakeIssue[] = [], o: { ready?: boolean[] } = {}) {
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
  for (const [i, p] of parts.entries()) if (o.ready?.[i] !== false) await readyPart(id, p);
  return { id, did, parts };
}
/** A session whose parts are on GitHub already (#101 and #102): the replacement is due. */
async function dueSession(others: FakeIssue[] = []) {
  const s = await splitSession(others);
  markPublished(s.id, [101, 102]);
  return s;
}

describe("an edit by a person between the two reads of a dependant", () => {
  /** Publishes, holds read A and read B of #20 in turn, and changes #20 on GitHub while B is held. */
  async function editBetween(id: string, body: string) {
    const first = hold("issues/20");
    const pending = publish(id);
    await until(() => seen("gh api repos/acme/app/issues/20\n") >= 1);
    const second = hold("issues/20", "hold2");
    first();
    await until(() => seen("gh api repos/acme/app/issues/20\n") >= 2);
    change(20, { body });
    second();
    return pending;
  }

  it("keeps an edit outside the Depends on text", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    const r = await editBetween(id, "Some story EDITED BY A PERSON\n\n### Depends on\n#12\n");
    expect(r.status).toBe(200);
    const patches = patchesOf(20);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.body).toContain("EDITED BY A PERSON");
    expect(patches[0]!.body).toContain("#101, #102");
  });

  it("refuses an edit inside it without a PATCH of that issue, and a second publish rewrites it with new evidence", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    const r = await editBetween(id, "Some story\n\n### Depends on\n#12, #13\n");
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/issue #20 changed on GitHub/);
    expect(patchesOf(20)).toEqual([]);
    expect(commentsOf(20)).toEqual([]);

    const again = await publish(id);
    expect(again.status).toBe(200);
    expect(patchesOf(20)).toHaveLength(1);
    expect(patchesOf(20)[0]!.body).toContain("#101, #102, #13");
    const c = commentsOf(20);
    expect(c).toHaveLength(1);
    expect(c[0]!.body).toContain("#12, #13");
    expect(c[0]!.body).toContain("#101, #102, #13");
  });
});

describe("a failed comment and a retry", () => {
  it("sends no second PATCH after a comment failed, and the comment has the stored Before and After", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    process.env.FAKE_GH_FAIL = "issue comment";
    const failed = await publish(id);
    expect(failed.status).toBe(502);
    expect(failed.error()).toMatch(/#20 was changed/);
    expect(failed.error()).not.toMatch(/nothing was written/);
    expect(patchesOf(20)).toHaveLength(1);
    delete process.env.FAKE_GH_FAIL;

    const again = await publish(id);
    expect(again.status).toBe(200);
    expect(patchesOf(20)).toHaveLength(1);
    const c = commentsOf(20);
    expect(c).toHaveLength(1);
    expect(c[0]!.body).toMatch(/\*\*Before\*\*[\s\S]*#12[\s\S]*\*\*After\*\*[\s\S]*#101, #102/);
    expect(again.json().replaced.dependants).toEqual([{ issue: 20, outcome: "rewritten" }]);
  });

  it("does not add a comment again when an own comment with the marker is there, and does when another login wrote it", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    const marker = replaceMarker(id, 20);

    // Somebody else wrote a comment with the marker: it does not count.
    seedComments({ 20: [{ body: `Look\n\n${marker}`, own: false, login: "somebody" }] });
    const other = await publish(id);
    expect(other.status).toBe(200);
    expect(commentsOf(20)).toHaveLength(1);
  });

  it("does not add a comment again when the own comment is there", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    seedComments({ 20: [{ body: `Done\n\n${replaceMarker(id, 20)}`, own: true }] });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(commentsOf(20)).toEqual([]);
    expect(commentsOf(12)).toHaveLength(1);
    expect(patchesOf(20)).toHaveLength(1);
  });

  it("handles a dependant that appeared between two tries", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    gh.setBugIssues([...gh.bugIssues(), withDeps(19, "#12")]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced.dependants).toEqual([{ issue: 19, outcome: "rewritten" }, { issue: 20, outcome: "rewritten" }]);
    expect(patchesOf(19)).toHaveLength(1);
    expect(patchesOf(20)).toHaveLength(1);
    expect(calls().filter((c) => c === "patch 20")).toHaveLength(1);
  });
});

describe("a stored write whose text was edited meanwhile", () => {
  it("gets the check comment when the range holds neither the reference nor what was written", async () => {
    const { id } = await splitSession([withDeps(20, "#12")]);
    process.env.FAKE_GH_FAIL = "issue comment";
    expect((await publish(id)).status).toBe(502);
    delete process.env.FAKE_GH_FAIL;
    change(20, { body: "Some story\n\n### Depends on\n#13\n" });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced.dependants).toEqual([{ issue: 20, outcome: "check" }]);
    expect(patchesOf(20)).toHaveLength(1);
    expect(commentsOf(20)[0]!.body).toContain("changed in the meantime");
  });
});

describe("entries of the journal that are no longer found", () => {
  it("finishes each from its marker and its stored evidence, and writes nothing it does not need to", async () => {
    const { id } = await dueSession([
      issue(21, { title: "Dependant 21", body: "Story\n\n### Depends on\nNothing now\n" }),
      issue(22, { title: "Dependant 22", body: "Story\n\n### Depends on\nNothing now\n" }),
      issue(23, { title: "Dependant 23", body: "Story\n\n### Depends on\n#101, #102\n" }),
    ]);
    seedJournal(id, [
      { issue: 21, title: "Dependant 21", byHand: true },
      { issue: 22, title: "Dependant 22", byHand: true },
      { issue: 23, title: "Dependant 23", before: "#12", after: "#101, #102", rangeBefore: "#12", rangeAfter: "#101, #102" },
    ]);
    // The comment on #21 landed in an earlier try (then the dependency was removed); so did the one on #23.
    seedComments({ 21: [{ body: `x\n\n${replaceMarker(id, 21)}`, own: true }], 23: [{ body: `x\n\n${replaceMarker(id, 23)}`, own: true }] });
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced.dependants).toEqual([
      { issue: 21, outcome: "by-hand" },
      { issue: 22, outcome: "no-longer-depends" },
      { issue: 23, outcome: "rewritten" },
    ]);
    for (const n of [21, 22, 23]) {
      expect(calls()).not.toContain(`patch ${n}`);
      expect(calls()).not.toContain(`comment ${n}`);
    }
  });

  it("gives closed and missing dependants their outcome and writes nothing to them", async () => {
    const { id } = await dueSession([issue(24, { title: "Dependant 24", state: "closed", closed_at: "2026-03-01T00:00:00Z" })]);
    seedJournal(id, [
      { issue: 24, title: "Dependant 24", before: "#12", after: "#101, #102" },
      { issue: 25, title: "Dependant 25", byHand: true },
    ]);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().replaced.dependants).toEqual([{ issue: 24, outcome: "closed" }, { issue: 25, outcome: "gone" }]);
    for (const n of [24, 25]) {
      expect(calls()).not.toContain(`patch ${n}`);
      expect(calls()).not.toContain(`comment ${n}`);
    }
  });
});

describe("the own comment check", () => {
  const marker = "<!-- claude-factory replaced=abc -->";
  it("fails with APP_NO_AUTHOR (502) for an app sign-in without viewerDidAuthor, and does not ask for a login", async () => {
    seedComments({ 20: [{ body: `x\n\n${marker}` }] });
    const err = await withGhEnv({ app: true, stamp: "t", env: { GH_TOKEN: TOKEN } }, () => hasOwnComment("acme/app", 20, marker, 10_000)).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(502);
    expect(err.message).toContain(APP_NO_AUTHOR);
    expect(gh.ghLog()).not.toContain("api user");
  });

  it("counts a comment gh says the account wrote, and not one from another account", async () => {
    const ask = () => withGhEnv({ stamp: "t", env: { GH_TOKEN: TOKEN } }, () => hasOwnComment("acme/app", 20, marker, 10_000));
    seedComments({ 20: [{ body: `x\n\n${marker}`, own: true }] });
    expect(await ask()).toBe(true);
    seedComments({ 20: [{ body: `x\n\n${marker}`, own: false }] });
    expect(await ask()).toBe(false);
    // the marker has to be the last line
    seedComments({ 20: [{ body: `${marker}\n\nmore`, own: true }] });
    expect(await ask()).toBe(false);
  });
});

describe("a session file that cannot be saved", () => {
  /** Publishes with the call that contains `on` held; while it is held the session file is spoilt, then the call is released. */
  async function faultAt(id: string, on: string) {
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
    return r;
  }
  /** The comments the fake logged are on GitHub for the retry. */
  const seedFromLog = () => {
    const by = new Map<number, { body: string; own: boolean }[]>();
    for (const c of gh.comments()) by.set(c.issue, [...(by.get(c.issue) ?? []), { body: c.body, own: true }]);
    seedComments(Object.fromEntries(by));
  };

  it("before the first write: 500 that says nothing was written, and the retry finishes", async () => {
    const { id } = await dueSession([withDeps(20, "#12")]);
    const r = await faultAt(id, "issues?state=open");
    expect(r.status).toBe(500);
    expect(r.error()).toMatch(/nothing was written/);
    expect(r.error()).toMatch(/publish again/i);
    expect(patchesOf(20)).toEqual([]);
    const again = await publish(id, {});
    expect(again.status).toBe(200);
    expect(patchesOf(20)).toHaveLength(1);
    expect(commentsOf(20)).toHaveLength(1);
    expect(commentsOf(12)).toHaveLength(1);
  });

  it("after the PATCH and the comment of a dependant: 500 that names the comment, and the retry writes nothing twice", async () => {
    const { id } = await dueSession([withDeps(20, "#12")]);
    const r = await faultAt(id, "issue comment 20");
    expect(r.status).toBe(500);
    expect(r.error()).toMatch(/#20 got a comment/);
    expect(r.error()).toMatch(/publish again/i);
    seedFromLog();
    const again = await publish(id, {});
    expect(again.status).toBe(200);
    expect(patchesOf(20)).toHaveLength(1);
    expect(commentsOf(20)).toHaveLength(1);
    expect(commentsOf(12)).toHaveLength(1);
    expect(again.json().replaced.dependants).toEqual([{ issue: 20, outcome: "rewritten" }]);
  });

  it("after the comment on the original: 500 that names it, and the retry only ends the replacement", async () => {
    const { id } = await dueSession([withDeps(20, "#12")]);
    const r = await faultAt(id, "issue comment 12");
    expect(r.status).toBe(500);
    expect(r.error()).toMatch(/#12 got a comment/);
    expect(r.error()).toMatch(/publish again/i);
    seedFromLog();
    const again = await publish(id, {});
    expect(again.status).toBe(200);
    expect(patchesOf(20)).toHaveLength(1);
    expect(commentsOf(20)).toHaveLength(1);
    expect(commentsOf(12)).toHaveLength(1);
    expect((await view(id)).source).toMatchObject({ replace: "done", closed: "open" });
  });
});

describe("the log of the session", () => {
  /** Fills the log so that exactly one more line fits before the slot kept for dropping. */
  const pad = (id: string) =>
    editFile((f) => {
      const s = f.sessions.find((x: any) => x.id === id);
      while (s.log.length < LOG_LIMIT - 2) s.log.push({ at: new Date().toISOString(), by: ann.user.id, what: "renamed", detail: "x" });
    });

  it("does not keep back a ready part for the line the end of the replacement needs while another part is not ready", async () => {
    const { id } = await splitSession([], { ready: [true, false] });
    pad(id);
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().created).toHaveLength(1);
    expect((await view(id)).source.replace).toBe("waiting");
  });

  it("refuses a publish that would put the last part on GitHub when the end of the replacement has no line left", async () => {
    const { id } = await splitSession();
    markPublished(id, [50]);
    pad(id);
    const full = await publish(id);
    expect(full.status).toBeGreaterThanOrEqual(400);
    expect(full.error()).toMatch(/log of this session is full/);
    expect(gh.ghLog()).not.toMatch(/-X POST/);
  });
});
