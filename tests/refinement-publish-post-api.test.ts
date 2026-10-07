import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { addRepo, listRepos, removeRepo, setRepoReady } from "../src/auth/repos.js";
import { refinedMarker } from "../src/refinement/publish.js";
import { LOG_LIMIT, refinementsPath } from "../src/refinement/store.js";
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
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-publish-post-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  process.env.FAKE_GH_EXPECT_TOKEN = TOKEN;
  kc = fakeKeychain();
  const opts: ServerOptions = { repo: tmp, runsDir: join(tmp, "runs"), port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, refinementSweepMs: 3_600_000 };
  started = await startServer(opts);
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
  addRepo(bob.user.id, { url: "other/thing", method: "github-token", token: TOKEN });
  gh.setLabels(["bug", "Factory_go", "Factory_review_plan", "Area:API"]);
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
const url = (id: string, rest: string) => `/api/refinement/${id}/${rest}`;
const annRepo = () => listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!;
const file = () => readFileSync(refinementsPath(), "utf8");
const stored = (id: string) => JSON.parse(file()).sessions.find((s: any) => s.id === id);
const audit = () => (readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as any[]).filter((e) => e.action === "refinement-publish");
const publish = (id: string, body: unknown = {}, who = ann) => call(who, "POST", url(id, "publish"), body);

const FULL = { title: "Export", who: "an admin", what: "to export a report", why: "to share it", outOfScope: "Printing", criteria: [{ text: "It exports a file" }] };
const LIST2 = [{ id: "out-of-scope", text: "it says what is out of scope" }, { id: "no-open-questions", text: "there are no open questions" }];

async function session() {
  return (await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report as CSV" })).json().id as string;
}
async function addDraft(id: string, fields: Record<string, unknown> = FULL, ready = true) {
  const did = (await call(ann, "POST", url(id, "drafts"))).json().drafts.at(-1).id as string;
  expect((await call(ann, "PUT", url(id, `drafts/${did}`), fields)).status).toBe(200);
  if (ready) expect((await call(ann, "POST", url(id, `drafts/${did}/ready-check`))).status).toBe(200);
  return did;
}
async function withDraft(fields: Record<string, unknown> = FULL, ready = true) {
  setRepoReady(annRepo().id, { items: LIST2 });
  const id = await session();
  return { id, did: await addDraft(id, fields, ready) };
}
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const watch = () => {
  addRepoWatcher(annRepo().id, { id: "app-w", label: "Factory_go" });
  started!.ctx.watchers.sync();
};
const issue = (n: number, body: string, over: Record<string, unknown> = {}): FakeIssue =>
  ({ number: n, state: "open", state_reason: null, title: "Old", body, labels: [], html_url: `https://github.com/acme/app/issues/${n}`, created_at: "2026-10-01T00:00:00Z", closed_at: null, ...over }) as FakeIssue;
const waitFor = async (test: () => boolean) => {
  for (let i = 0; i < 200 && !test(); i++) await new Promise((r) => setTimeout(r, 50));
};

describe("publishing", () => {
  it("creates the issue of one ready draft, remembers it, and writes the audit line", async () => {
    const { id, did } = await withDraft();
    const r = await publish(id, { drafts: [{ draft: did }] });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ repo: "acme/app", state: "published", created: [{ draft: did, issue: 101, url: "https://github.com/acme/app/issues/101", found: false }] });
    const made = gh.createdBodies();
    expect(made).toHaveLength(1);
    expect(made[0]!.title).toBe("Export");
    expect(made[0]!.body.trimEnd().split("\n").at(-1)).toBe(refinedMarker(id, did));
    expect(made[0]!.labels).toEqual([]);
    const s = stored(id);
    expect(s.drafts[0].published).toMatchObject({ issue: 101, url: "https://github.com/acme/app/issues/101" });
    expect(s.state).toBe("published");
    const view = (await call(ann, "GET", `/api/refinement/${id}`)).json();
    expect(view.state).toBe("published");
    expect(view.drafts[0].published.issue).toBe(101);
    expect(view.log.at(-1)).toMatchObject({ what: "draft-published", detail: "#101 Export" });
    expect(audit()).toMatchObject([{ target: id, detail: "acme/app #101", by: ann.user.id }]);
  });

  it("takes an empty body as no choices: every ready draft is created with no labels", async () => {
    const { id } = await withDraft();
    await addDraft(id, { ...FULL, title: "Second" });
    expect((await publish(id)).status).toBe(200);
    expect(gh.createdBodies().map((b) => [b.title, b.labels])).toEqual([["Export", []], ["Second", []]]);
  });

  it("creates in the order of the dependencies and writes the number of an earlier draft", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const id = await session();
    const a = await addDraft(id, { ...FULL, title: "First" }, false);
    const b = await addDraft(id, { ...FULL, title: "Second" }, false);
    expect((await call(ann, "PUT", url(id, `drafts/${a}`), { dependsOn: [{ draft: b }] })).status).toBe(200);
    for (const d of [a, b]) await call(ann, "POST", url(id, `drafts/${d}/ready-check`));
    expect((await publish(id)).status).toBe(200);
    const made = gh.createdBodies();
    expect(made.map((m) => m.title)).toEqual(["Second", "First"]);
    expect(made[1]!.body).toContain("- #101");
    expect(made[1]!.body).not.toContain("new issue");
  });

  it("sends the build label only with startBuilding, and only where a watcher gives one", async () => {
    watch();
    const { id, did } = await withDraft();
    expect((await publish(id, { drafts: [{ draft: did, startBuilding: true }] })).status).toBe(200);
    expect(gh.createdBodies()[0]!.labels).toEqual(["Factory_go"]);
    const other = await withDraft();
    expect((await publish(other.id, { drafts: [{ draft: other.did }] })).status).toBe(200);
    expect(gh.createdBodies()[1]!.labels).toEqual([]);
  });

  it("refuses startBuilding without a watcher, also on the entry of a draft that is not created", async () => {
    const { id, did } = await withDraft();
    const half = await addDraft(id, { title: "Half done" }, false);
    const before = file();
    expect((await publish(id, { drafts: [{ draft: did, startBuilding: true }] })).status).toBe(400);
    expect((await publish(id, { drafts: [{ draft: half, startBuilding: true }] })).status).toBe(400);
    expect(gh.createdBodies()).toEqual([]);
    expect(file()).toBe(before);
    edit((f) => (f.sessions[0].drafts.find((d: any) => d.id === did).published = { issue: 12, url: "https://github.com/acme/app/issues/12", at: new Date().toISOString() }));
    const again = file();
    expect((await publish(id, { drafts: [{ draft: did, startBuilding: true }] })).status).toBe(400);
    expect(gh.createdBodies()).toEqual([]);
    expect(file()).toBe(again);
  });

  it("adds the review label only for the draft that asks for it", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const id = await session();
    watch();
    const a = await addDraft(id, { ...FULL, title: "Asks" });
    await addDraft(id, { ...FULL, title: "Does not" });
    expect((await call(ann, "PUT", url(id, `drafts/${a}/review-label`), { add: true })).status).toBe(200);
    expect((await publish(id)).status).toBe(200);
    expect(gh.createdBodies().map((b) => [b.title, b.labels])).toEqual([["Asks", ["Factory_review_plan"]], ["Does not", []]]);
  });

  it("refuses the review label when the repository does not have it", async () => {
    watch();
    gh.setLabels(["bug"]);
    const { id, did } = await withDraft();
    expect((await call(ann, "PUT", url(id, `drafts/${did}/review-label`), { add: true })).status).toBe(200);
    expect((await publish(id)).status).toBe(400);
    expect(gh.createdBodies()).toEqual([]);
  });

  it("needs startBuilding when the review label is the build label, and then sends the label once", async () => {
    addRepoWatcher(annRepo().id, { id: "app-w", label: "Factory_go", vars: { review_plan_label: "Factory_go" } });
    started!.ctx.watchers.sync();
    const { id, did } = await withDraft();
    expect((await call(ann, "PUT", url(id, `drafts/${did}/review-label`), { add: true })).status).toBe(200);
    expect((await publish(id)).status).toBe(400);
    expect(gh.createdBodies()).toEqual([]);
    expect((await publish(id, { drafts: [{ draft: did, startBuilding: true }] })).status).toBe(200);
    expect(gh.createdBodies()[0]!.labels).toEqual(["Factory_go"]);
  });

  it("refuses a label the repository does not have, naming it, and changes nothing", async () => {
    const { id, did } = await withDraft();
    const half = await addDraft(id, { title: "Half done" }, false);
    const before = file();
    for (const entry of [did, half]) {
      const r = await publish(id, { drafts: [{ draft: entry, labels: ["nope"] }] });
      expect(r.status).toBe(400);
      expect(r.error()).toContain("nope");
    }
    expect(gh.createdBodies()).toEqual([]);
    expect(file()).toBe(before);
    edit((f) => (f.sessions[0].drafts.find((d: any) => d.id === half).published = { issue: 12, url: "https://github.com/acme/app/issues/12", at: new Date().toISOString() }));
    expect((await publish(id, { drafts: [{ draft: half, labels: ["nope"] }] })).status).toBe(400);
    expect(gh.createdBodies()).toEqual([]);
  });

  it("refuses the build label and the review label as a chosen label", async () => {
    watch();
    const { id, did } = await withDraft();
    expect((await publish(id, { drafts: [{ draft: did, labels: ["Factory_go"] }] })).status).toBe(400);
    expect((await publish(id, { drafts: [{ draft: did, labels: ["factory_review_plan"] }] })).status).toBe(400);
    expect(gh.createdBodies()).toEqual([]);
  });

  it("sends a chosen label in the spelling of the repository", async () => {
    const { id, did } = await withDraft();
    expect((await publish(id, { drafts: [{ draft: did, labels: ["area:api", "AREA:API", " bug "] }] })).status).toBe(200);
    expect(gh.createdBodies()[0]!.labels).toEqual(["Area:API", "bug"]);
  });

  it("refuses the whole call when a ready draft has no title, and creates nothing", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const id = await session();
    const { title: _title, ...noTitle } = FULL;
    const bad = await addDraft(id, noTitle);
    await addDraft(id, { ...FULL, title: "Fine" });
    const before = file();
    const r = await publish(id);
    expect(r.status).toBe(409);
    expect(r.error()).toContain(bad);
    expect(gh.createdBodies()).toEqual([]);
    expect(file()).toBe(before);
  });

  it("can be repeated after a failure halfway: the made issues are kept, the rest is made", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const id = await session();
    for (const t of ["One", "Two", "Three"]) await addDraft(id, { ...FULL, title: t });
    process.env.FAKE_GH_FAIL_CREATE_AT = "2";
    process.env.FAKE_GH_FAIL_TEXT = "HTTP 502: Bad gateway";
    const r = await publish(id);
    expect(r.status).toBe(502);
    expect(r.error()).toContain("#101");
    expect(r.error()).toMatch(/publish again/);
    expect(r.error()).toContain("Bad gateway");
    const s = stored(id);
    expect(s.drafts[0].published.issue).toBe(101);
    expect(s.drafts[1].published).toBeUndefined();
    expect(s.state).not.toBe("published");
    expect(audit()).toMatchObject([{ detail: "acme/app #101" }]);
    delete process.env.FAKE_GH_FAIL_CREATE_AT;
    const again = await publish(id);
    expect(again.status).toBe(200);
    expect(again.json().created.map((c: any) => c.issue)).toEqual([102, 103]);
    expect(gh.bugIssues()).toHaveLength(3);
    const titles = gh.bugIssues().map((i) => i.title);
    expect(new Set(titles).size).toBe(3);
    expect(stored(id).state).toBe("published");
  });

  describe("an issue that was made already", () => {
    it("is found by its marker and not made again", async () => {
      const { id, did } = await withDraft();
      gh.setBugIssues([issue(7, `Old text\n\n${refinedMarker(id, did)}\n`)]);
      const r = await publish(id);
      expect(r.status).toBe(200);
      expect(r.json().created).toEqual([{ draft: did, issue: 7, url: "https://github.com/acme/app/issues/7", found: true }]);
      expect(gh.createdBodies()).toEqual([]);
      expect(stored(id).drafts[0].published.issue).toBe(7);
    });

    it("is not taken over when the marker is only quoted in the middle of the text", async () => {
      const { id, did } = await withDraft();
      gh.setBugIssues([issue(7, `As someone said:\n${refinedMarker(id, did)}\nand more text`)]);
      const r = await publish(id);
      expect(r.json().created[0]).toMatchObject({ found: false, issue: 101 });
      expect(gh.createdBodies()).toHaveLength(1);
    });

    it("is not a pull request", async () => {
      const { id, did } = await withDraft();
      gh.setBugIssues([issue(7, refinedMarker(id, did), { pull_request: { url: "x" } })]);
      expect((await publish(id)).json().created[0]).toMatchObject({ found: false });
      expect(gh.createdBodies()).toHaveLength(1);
      // with a real issue next to the pull request, the issue is taken over
      const other = await withDraft();
      gh.setBugIssues([issue(20, refinedMarker(other.id, other.did), { pull_request: { url: "x" } }), issue(21, refinedMarker(other.id, other.did))]);
      expect((await publish(other.id)).json().created[0]).toMatchObject({ found: true, issue: 21 });
    });

    it("takes the lower number when two carry the marker", async () => {
      const { id, did } = await withDraft();
      gh.setBugIssues([issue(30, refinedMarker(id, did)), issue(9, refinedMarker(id, did))]);
      expect((await publish(id)).json().created[0]).toMatchObject({ found: true, issue: 9 });
    });

    it("is stored with the link of this repository and number, whatever GitHub reported", async () => {
      for (const reported of ["https://github.com/other/thing/issues/7", "https://github.com/acme/app/issues/8", "javascript:alert(1)"]) {
        const { id, did } = await withDraft();
        gh.setBugIssues([issue(7, refinedMarker(id, did), { html_url: reported })]);
        expect((await publish(id)).status).toBe(200);
        expect(stored(id).drafts[0].published.url).toBe("https://github.com/acme/app/issues/7");
      }
    });
  });

  it("answers 200 with nothing created when every draft is on GitHub, without a call to create or list", async () => {
    const { id } = await withDraft();
    expect((await publish(id)).status).toBe(200);
    const calls = gh.ghLog().length;
    const r = await publish(id);
    expect(r.status).toBe(200);
    expect(r.json().created).toEqual([]);
    expect(gh.ghLog().slice(calls)).not.toMatch(/issues -X POST|issues\?/);
    expect(gh.createdBodies()).toHaveLength(1);
  });

  describe("access", () => {
    it("gives another user 404, an admin 403, an unknown id 404, a dropped session 409", async () => {
      const { id } = await withDraft();
      expect((await publish(id, {}, bob)).status).toBe(404);
      const a = await publish(id, {}, admin);
      expect(a.status).toBe(403);
      expect(a.error()).toMatch(/only the owner/);
      expect((await publish("00000000-0000-4000-8000-000000000000")).status).toBe(404);
      expect((await call(ann, "POST", url(id, "drop"))).status).toBe(200);
      expect((await publish(id)).status).toBe(409);
      expect(gh.createdBodies()).toEqual([]);
    });

    it("gives an admin who views as the owner a 403", async () => {
      const { id } = await withDraft();
      expect((await call(admin, "POST", "/api/admin/view-as", { userId: ann.user.id })).status).toBe(200);
      const r = await call(admin, "POST", `/api/refinement/${id}/publish?as=${ann.user.id}`, {});
      expect(r.status).toBe(403);
      expect(gh.createdBodies()).toEqual([]);
    });

    it("refuses when the repository is not in My repositories any more", async () => {
      const { id } = await withDraft();
      removeRepo(ann.user.id, annRepo().id);
      expect((await publish(id)).status).toBe(409);
      expect(gh.createdBodies()).toEqual([]);
    });
  });

  describe("when something fails", () => {
    it("says what GitHub said when the first create fails, and changes nothing", async () => {
      const { id } = await withDraft();
      const before = file();
      process.env.FAKE_GH_FAIL_API = "create";
      process.env.FAKE_GH_FAIL_TEXT = "HTTP 502: Bad gateway";
      const r = await publish(id);
      expect(r.status).toBe(502);
      expect(r.error()).toContain("Bad gateway");
      expect(r.error()).toMatch(/publish again/);
      expect(r.text).not.toContain(TOKEN);
      expect(file()).toBe(before);
      expect(audit()).toEqual([]);
    });

    it("makes nothing when the list of issues cannot be read", async () => {
      const { id } = await withDraft();
      const before = file();
      process.env.FAKE_GH_FAIL_API = "list";
      const r = await publish(id);
      expect(r.status).toBe(502);
      expect(gh.createdBodies()).toEqual([]);
      expect(file()).toBe(before);
      expect(audit()).toEqual([]);
    });

    it("answers 500 with the link when the session cannot be stored, and takes the issue over on the next try", async () => {
      const { id } = await withDraft();
      const before = file();
      const release = gh.hold("issues -X POST");
      const pending = publish(id);
      await waitFor(() => gh.ghLog().includes("issues -X POST"));
      writeFileSync(refinementsPath(), "not json");
      release();
      const r = await pending;
      expect(r.status).toBe(500);
      expect(r.error()).toContain("https://github.com/acme/app/issues/101");
      expect(r.error()).toMatch(/publish again/i);
      expect(audit()).toMatchObject([{ detail: "acme/app #101" }]);
      writeFileSync(refinementsPath(), before);
      const again = await publish(id);
      expect(again.status).toBe(200);
      expect(again.json().created[0]).toMatchObject({ found: true, issue: 101 });
      expect(gh.bugIssues()).toHaveLength(1);
    });

    it("makes nothing when the log of the session is full", async () => {
      const { id } = await withDraft();
      edit((f) => {
        const s = f.sessions[0];
        while (s.log.length < LOG_LIMIT - 1) s.log.push({ at: new Date().toISOString(), by: s.owner, what: "renamed", detail: "x" });
      });
      const r = await publish(id);
      expect(r.status).toBe(400);
      expect(gh.createdBodies()).toEqual([]);
    });
  });

  it("puts no draft text in a command line", async () => {
    const { id } = await withDraft();
    expect((await publish(id)).status).toBe(200);
    for (const line of gh.ghLog().split("\n").filter((l) => l.startsWith("gh "))) {
      expect(line).not.toContain("Export");
      expect(line).not.toContain("It exports a file");
    }
  });

  it("refuses a bad body", async () => {
    const { id, did } = await withDraft();
    for (const body of [{ drafts: "x" }, { drafts: [{ draft: "00000000-0000-4000-8000-000000000000" }] }, { drafts: [{ draft: did, labels: [1] }] }, { drafts: [{ draft: did, startBuilding: "yes" }] }, { drafts: [{ draft: did }, { draft: did }] }]) {
      expect((await publish(id, body)).status).toBe(400);
    }
    expect(gh.createdBodies()).toEqual([]);
  });
});
