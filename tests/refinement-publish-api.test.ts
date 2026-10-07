import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos, removeRepo, setRepoReady } from "../src/auth/repos.js";
import { refinementsPath } from "../src/refinement/store.js";
import { addRepoWatcher } from "../src/repos/watchers.js";
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

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-publish-api-"));
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
const plan = (id: string, who = ann) => call(who, "GET", url(id, "publish"));

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
const dependOn = (id: string, did: string, on: string) => call(ann, "PUT", url(id, `drafts/${did}`), { dependsOn: [{ draft: on }] });
const edit = (fn: (f: any) => void) => {
  const f = JSON.parse(file());
  fn(f);
  writeFileSync(refinementsPath(), JSON.stringify(f));
};
const watch = (over: Record<string, unknown> = {}) => {
  addRepoWatcher(annRepo().id, { id: "app-w", label: "Factory_go", ...over });
  started!.ctx.watchers.sync();
};

describe("the plan", () => {
  it("orders the drafts by their dependencies and shows a draft dependency as a new issue", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const id = await session();
    const a = await addDraft(id, { ...FULL, title: "First" }, false);
    const b = await addDraft(id, { ...FULL, title: "Second" }, false);
    expect((await dependOn(id, a, b)).status).toBe(200);
    for (const d of [a, b]) await call(ann, "POST", url(id, `drafts/${d}/ready-check`));
    const before = file();
    const r = await plan(id);
    expect(r.status).toBe(200);
    const p = r.json();
    expect(p.repo).toBe("acme/app");
    expect(p.items.map((i: any) => [i.n, i.draft, i.state])).toEqual([[1, b, "ready"], [2, a, "ready"]]);
    expect(p.willCreate).toEqual([b, a]);
    expect(p.items[1].body).toContain("- new issue 1: Second");
    expect(p.items[1].body).not.toContain("(draft)");
    expect(p.items[1].dependsOn).toEqual([{ item: 1, title: "Second" }]);
    expect(p.items[0].body).toContain("### Acceptance criteria\n- [ ] It exports a file");
    // reading the plan changes nothing
    expect(file()).toBe(before);
  });

  it("does not offer a draft that is not ready, with the reason", async () => {
    const { id } = await withDraft();
    const x = await addDraft(id, { title: "Half done" }, false);
    const p = (await plan(id)).json();
    const item = p.items.find((i: any) => i.draft === x);
    expect(item).toMatchObject({ state: "not-ready", reason: expect.stringMatching(/no readiness check/) });
    expect(p.willCreate).not.toContain(x);
    expect(p.willCreate).toHaveLength(1);
  });

  it("does not offer a ready draft that depends on a draft that is not ready, and names it", async () => {
    const { id, did } = await withDraft({ ...FULL, title: "Needs the other" });
    const blocker = await addDraft(id, { title: "The blocker" }, false);
    expect((await dependOn(id, did, blocker)).status).toBe(200);
    await call(ann, "POST", url(id, `drafts/${did}/ready-check`));
    const p = (await plan(id)).json();
    const item = p.items.find((i: any) => i.draft === did);
    expect(item.state).toBe("not-ready");
    expect(item.reason).toContain("The blocker");
    expect(p.willCreate).toEqual([]);
  });

  it("does not trust the stored state, and follows a change of the Definition of Ready", async () => {
    const { id, did } = await withDraft({ title: "Plain" }, false);
    edit((f) => (f.sessions[0].state = "ready"));
    let p = (await plan(id)).json();
    expect(p.items[0].state).toBe("not-ready");
    const good = await addDraft(id);
    p = (await plan(id)).json();
    expect(p.willCreate).toEqual([good]);
    setRepoReady(annRepo().id, { items: [{ id: "out-of-scope", text: "it says what is not in scope" }, LIST2[1]!] });
    p = (await plan(id)).json();
    expect(p.willCreate).toEqual([]);
    expect(p.items.find((i: any) => i.draft === good).reason).toMatch(/changed since the check/);
    expect(did).toBeTruthy();
  });

  it("shows a draft that is on GitHub, and does not block its dependants", async () => {
    setRepoReady(annRepo().id, { items: LIST2 });
    const id = await session();
    const a = await addDraft(id, { ...FULL, title: "Later" }, false);
    const b = await addDraft(id, { ...FULL, title: "Done already" }, false);
    await dependOn(id, a, b);
    await call(ann, "POST", url(id, `drafts/${a}/ready-check`));
    edit((f) => (f.sessions[0].drafts.find((d: any) => d.id === b).published = { issue: 12, url: "https://github.com/acme/app/issues/12", at: new Date().toISOString() }));
    const p = (await plan(id)).json();
    expect(p.items[0]).toMatchObject({ draft: b, state: "on-github", issue: 12, labels: [] });
    expect(p.items[1]).toMatchObject({ draft: a, state: "ready", dependsOn: [{ issue: 12 }] });
    expect(p.items[1].body).toContain("- #12");
    expect(p.willCreate).toEqual([a]);
  });

  it("has the story format with the note by the display name and the date, and no e-mail", async () => {
    const { id } = await withDraft();
    const r = await plan(id);
    const today = new Date().toISOString().slice(0, 10);
    expect(r.json().items[0].body.endsWith(`\n\n---\nRefined in Spaghetti Code Foundry by Ann on ${today}.`)).toBe(true);
    expect(r.text).not.toContain("ann@example.com");
    expect(r.text).not.toContain(TOKEN);
  });

  it("keeps the Accepted anyway lines and holds no waiting suggestion", async () => {
    const { id, did } = await withDraft({ ...FULL, outOfScope: undefined }, false);
    await call(ann, "POST", url(id, `drafts/${did}/ready-check`));
    expect((await call(ann, "POST", url(id, `drafts/${did}/ready/out-of-scope/accept`), { reason: "Nothing is out of scope" })).status).toBe(200);
    edit((f) => (f.sessions[0].drafts[0].suggestions = [{ id: "00000000-0000-4000-8000-000000000999", field: "what", text: "WAITING-SUGGESTION-TEXT" }]));
    const r = await plan(id);
    expect(r.json().items[0].state).toBe("ready");
    expect(r.json().items[0].body).toContain("### Accepted anyway\n- it says what is out of scope: Nothing is out of scope");
    expect(r.text).not.toContain("WAITING-SUGGESTION-TEXT");
  });
});

describe("labels", () => {
  it("lists the labels of the repository, read from GitHub with the repository's own sign-in", async () => {
    gh.setLabels(["bug", "Factory_go"]);
    const { id } = await withDraft();
    const log = gh.authLog();
    const p = (await plan(id)).json();
    expect(p.repoLabels).toEqual(["bug", "Factory_go"]);
    expect(gh.ghLog()).toContain("labels?per_page=100");
    expect(log.rows().length).toBeGreaterThan(0);
    expect(log.rows().every((x) => x.token === TOKEN && x.configDir !== "host")).toBe(true);
  });

  it("says there is no build label without a watcher, and names it with one", async () => {
    const { id } = await withDraft();
    let p = (await plan(id)).json();
    expect(p.buildLabel).toBeUndefined();
    expect(p.noBuildLabel).toMatch(/no enabled watcher for issues/);
    expect(p.items[0].labels).toEqual([]);
    watch();
    p = (await plan(id)).json();
    expect(p.buildLabel).toBe("Factory_go");
    expect(p.noBuildLabel).toBeUndefined();
    expect(p.items[0].labels).toEqual(["Factory_go"]);
  });

  it("names the review label for a draft that has it set", async () => {
    watch();
    const { id, did } = await withDraft();
    const other = await addDraft(id, { ...FULL, title: "Plain" });
    expect((await call(ann, "PUT", url(id, `drafts/${did}/review-label`), { add: true })).status).toBe(200);
    const p = (await plan(id)).json();
    expect(p.reviewLabel).toBe("Factory_review_plan");
    expect(p.items.find((i: any) => i.draft === did).labels).toEqual(["Factory_go", "Factory_review_plan"]);
    expect(p.items.find((i: any) => i.draft === other).labels).toEqual(["Factory_go"]);
  });
});

describe("access and failures", () => {
  it("gives the owner the plan; another user 404, an admin 403, an unknown id 404, a dropped session 409", async () => {
    const { id } = await withDraft();
    expect((await plan(id, bob)).status).toBe(404);
    const a = await plan(id, admin);
    expect(a.status).toBe(403);
    expect(a.error()).toMatch(/only the owner/);
    expect((await plan("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await call(ann, "POST", url(id, "drop"))).status).toBe(200);
    expect((await plan(id)).status).toBe(409);
  });

  it("gives an admin who views as the owner a 403, not the plan", async () => {
    const { id } = await withDraft();
    expect((await call(admin, "POST", "/api/admin/view-as", { userId: ann.user.id })).status).toBe(200);
    const log = gh.authLog();
    const r = await call(admin, "GET", `/api/refinement/${id}/publish?as=${ann.user.id}`);
    expect(r.status).toBe(403);
    expect(r.error()).toMatch(/only the owner/);
    expect(log.rows()).toEqual([]);
  });

  it("refuses when the repository is not in My repositories any more", async () => {
    const { id } = await withDraft();
    removeRepo(ann.user.id, annRepo().id);
    const r = await plan(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/not in My repositories/);
  });

  it("says what happened when GitHub fails, and changes nothing", async () => {
    const { id } = await withDraft();
    const before = file();
    process.env.FAKE_GH_FAIL = "api repos/acme/app/labels?per_page=100";
    process.env.FAKE_GH_FAIL_TEXT = "HTTP 502: Bad gateway";
    const r = await plan(id);
    expect(r.status).toBe(502);
    expect(r.error()).toContain("HTTP 502: Bad gateway");
    expect(r.error()).toContain("try again");
    delete process.env.FAKE_GH_FAIL;
    process.env.FAKE_GH_EXPECT_TOKEN = "another";
    const r2 = await plan(id);
    expect(r2.status).toBe(502);
    expect(r2.error()).toContain("Bad credentials");
    expect(r2.text).not.toContain(TOKEN);
    expect(file()).toBe(before);
  });

  it("says GitHub did not answer in time", async () => {
    const { id } = await withDraft();
    started!.ctx.opts.ghTimeoutMs = 300;
    process.env.FAKE_GH_SLEEP = "3";
    const r = await plan(id);
    expect(r.status).toBe(502);
    expect(r.error()).toContain("did not answer in time");
  });

  it("refuses when the stored sign-in does not work", async () => {
    const { id } = await withDraft();
    writeFileSync(kc.file, "{}");
    const r = await plan(id);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/^the GitHub sign-in of this repository does not work/);
  });

  it("never falls back to the server's own login", async () => {
    addRepo(admin.user.id, { url: "acme/own", method: "none" });
    const id = (await call(admin, "POST", "/api/refinement", { repo: "acme/own", idea: "Something to refine" })).json().id as string;
    const log = gh.authLog();
    const r = await plan(id, admin);
    expect(r.status).toBe(409);
    expect(r.error()).toMatch(/server's own GitHub login/);
    expect(log.rows()).toEqual([]);
  });

  it("refuses a display name with a Foundry marker", async () => {
    const marker = await signInAs(base, { name: "<!-- claude-factory x -->", email: "m@example.com", role: "user" });
    addRepo(marker.user.id, { url: "acme/mark", method: "github-token", token: TOKEN });
    const id = (await call(marker, "POST", "/api/refinement", { repo: "acme/mark", idea: "Something to refine" })).json().id as string;
    const r = await plan(id, marker);
    expect(r.status).toBe(400);
    expect(r.error()).toMatch(/Foundry marker/);
  });
});
