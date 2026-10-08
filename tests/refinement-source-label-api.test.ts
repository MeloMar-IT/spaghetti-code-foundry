import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, listRepos } from "../src/auth/repos.js";
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
let kc: FakeKeychain;
let started: Awaited<ReturnType<typeof startServer>> | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;

beforeEach(async () => {
  gh = fakeGithub();
  fakeGit(gh, "https://github.com/acme/app https://github.com/other/thing");
  tmp = mkdtempSync(join(tmpdir(), "refinement-source-label-"));
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
  addRepoWatcher(listRepos(ann.user.id).find((r) => r.url.endsWith("acme/app"))!.id, { id: "app-w", label: "Factory_go" });
  started.ctx.watchers.sync();
});
afterEach(async () => {
  delete process.env.FAKE_GH_FAIL;
  delete process.env.FAKE_GH_FAIL_API;
  delete process.env.FAKE_GH_HOLD;
  delete process.env.FAKE_GH_HOLD_ON;
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
const stored = (id: string) => JSON.parse(readFileSync(refinementsPath(), "utf8")).sessions.find((s: any) => s.id === id);
const issue = (n: number, labels: string[] = []): FakeIssue =>
  ({
    number: n,
    state: "open",
    state_reason: null,
    title: `Issue ${n}`,
    body: "Please fix the thing.",
    labels: labels.map((name) => ({ name })),
    html_url: `https://github.com/acme/app/issues/${n}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-02-03T04:05:06Z",
    closed_at: null,
  }) as FakeIssue;
const setIssues = (...list: FakeIssue[]) => gh.setBugIssues(list);
const remove = (id: string, who = ann) => call(who, "POST", `/api/refinement/${id}/source/remove-build-label`, {});
const edits = () => gh.ghLog().split("\n").filter((l) => /issue edit/.test(l));

/** A session of issue 60, which has the build label. */
async function labelled(): Promise<string> {
  setIssues(issue(60, ["factory_go"]));
  const r = await call(ann, "POST", "/api/refinement", { repo: "acme/app", issue: 60 });
  expect(r.status).toBe(201);
  expect(r.json().source.buildLabel).toBe("Factory_go");
  return r.json().id;
}

describe("remove the build label of the source issue", () => {
  it("removes the label and forgets it in the session", async () => {
    const id = await labelled();
    const r = await remove(id);
    expect(r.status).toBe(200);
    expect("buildLabel" in r.json().source).toBe(false);
    expect(r.json().source.issue).toBe(60);
    expect(gh.ghLog()).toMatch(/issue edit 60 --repo acme\/app --remove-label factory_go/);
    expect(r.json().log.at(-1)).toMatchObject({ what: "source-label-removed", detail: "Factory_go" });
    expect(stored(id).source.buildLabel).toBeUndefined();
  });

  it("sends nothing before the press", async () => {
    const id = await labelled();
    await call(ann, "GET", `/api/refinement/${id}`);
    expect(edits()).toEqual([]);
    expect(stored(id).source.buildLabel).toBe("Factory_go");
  });

  it("only clears the flag when the label is gone on GitHub already", async () => {
    const id = await labelled();
    setIssues(issue(60));
    const r = await remove(id);
    expect(r.status).toBe(200);
    expect("buildLabel" in r.json().source).toBe(false);
    expect(edits()).toEqual([]);
  });

  it("keeps the warning when GitHub cannot find the issue (it may be hidden from the sign-in)", async () => {
    const id = await labelled();
    setIssues();
    const r = await remove(id);
    expect(r.status).toBe(502);
    expect(r.error()).toMatch(/could not find issue #60/);
    expect(edits()).toEqual([]);
    expect(stored(id).source.buildLabel).toBe("Factory_go");
  });

  it("refuses a second call", async () => {
    const id = await labelled();
    expect((await remove(id)).status).toBe(200);
    const again = await remove(id);
    expect(again.status).toBe(409);
    expect(again.error()).toBe("there is no build label to remove");
  });

  it("refuses a session that came from an idea", async () => {
    const made = await call(ann, "POST", "/api/refinement", { repo: "acme/app", idea: "Export a report" });
    expect((await remove(made.json().id)).status).toBe(409);
    expect(edits()).toEqual([]);
  });

  it("refuses a dropped session", async () => {
    const id = await labelled();
    await call(ann, "POST", `/api/refinement/${id}/drop`, {});
    expect((await remove(id)).status).toBe(409);
    expect(edits()).toEqual([]);
  });

  it("does not show the session to another user", async () => {
    const id = await labelled();
    expect((await remove(id, bob)).status).toBe(404);
    expect(edits()).toEqual([]);
  });

  it("gives an admin who is not the owner a 403", async () => {
    const id = await labelled();
    const r = await remove(id, admin);
    expect(r.status).toBe(403);
    expect(r.error()).toMatch(/only the owner can remove the build label/);
    expect(edits()).toEqual([]);
    expect(stored(id).source.buildLabel).toBe("Factory_go");
  });

  it("answers 404 for an unknown session", async () => {
    expect((await remove("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("keeps the flag when GitHub fails on the edit", async () => {
    const id = await labelled();
    process.env.FAKE_GH_FAIL = "issue edit";
    const r = await remove(id);
    expect(r.status).toBe(502);
    expect(r.error()).toMatch(/GitHub did not remove the label/);
    expect(stored(id).source.buildLabel).toBe("Factory_go");
  });

  it("keeps the flag when GitHub fails on the read", async () => {
    const id = await labelled();
    process.env.FAKE_GH_FAIL_API = "read";
    expect((await remove(id)).status).toBe(502);
    expect(stored(id).source.buildLabel).toBe("Factory_go");
  });

  it("refuses a repository that uses the server's own login", async () => {
    addRepo(ann.user.id, { url: "acme/host", method: "none" });
    const made = createSessionFromIssue(
      ann.user.id,
      { repo: "acme/host", title: "T", idea: "T", source: { issue: 5, url: "https://github.com/acme/host/issues/5", title: "T", body: "", updatedAt: "2026-01-01T00:00:00.000Z", buildLabel: "Factory_go" } },
      { ownerOk: () => true, repoName: (_o, n) => n },
    );
    const r = await remove(made.id);
    expect(r.status).toBe(409);
    expect(edits()).toEqual([]);
  });

  it("forgets the label also when the session is dropped while GitHub is called", async () => {
    const id = await labelled();
    const hold = join(tmp, "hold");
    writeFileSync(hold, "");
    process.env.FAKE_GH_HOLD = hold;
    process.env.FAKE_GH_HOLD_ON = "issue edit";
    const pending = remove(id);
    for (let i = 0; i < 100 && !existsSync(`${hold}.seen`) && !edits().length; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await call(ann, "POST", `/api/refinement/${id}/drop`, {})).status).toBe(200);
    rmSync(hold);
    const r = await pending;
    expect(r.status).toBe(200);
    expect(edits()).toHaveLength(1);
    expect(stored(id).state).toBe("dropped");
    expect(stored(id).source.buildLabel).toBeUndefined();
  });
});
