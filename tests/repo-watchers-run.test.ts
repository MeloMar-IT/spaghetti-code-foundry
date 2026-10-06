import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { repoWatchersPath } from "../src/repos/watchers.js";
import { startServer } from "../src/server/server.js";
import { claudeBin, fakeGithub, oldFlowFor } from "./helpers/fake-github.js";
import { fakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
let gh: ReturnType<typeof fakeGithub>;
let home: string;
let saved: string | undefined;

beforeEach(() => {
  gh = fakeGithub();
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "repo-watchers-run-"));
  process.env.FACTORY_HOME = home;
});
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 300)); // a fake gh call may still be writing
  gh.restore();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

describe("a Watcher of a repository", () => {
  const start = (over: Record<string, unknown>) => {
    const scheduler = new Scheduler({ runsDir: join(gh.tmp, "runs"), config: () => ({ ...ConfigSchema.parse({ protected_branches: [] }), concurrency: 0 }), claudeBin });
    const { repoId, ownerId, ...opts } = over as { repoId?: string; ownerId?: string };
    const w = new Watcher({ ...WatcherSchema.parse({ id: "w", github_repo: "acme/app", vars: { test_cmd: "true" }, ...opts, flow: oldFlowFor(opts) }), repoId, ownerId }, { scheduler, runsDir: join(gh.tmp, "runs"), repo: gh.tmp, log: () => {} });
    return { scheduler, w };
  };
  const issue = () => (process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "four", labels: [{ name: "claude-factory" }] }]));

  it("queues the run for the owner it is given, and for nobody else", async () => {
    await createUser({ name: "Admin", email: "admin@example.com", password: "test-password-12345", role: "admin" });
    const ann = await createUser({ name: "Ann", email: "ann@example.com", password: "test-password-12345", role: "user" });
    issue();
    const mine = start({ repoId: "r1", ownerId: ann.id });
    await mine.w.tick();
    expect(mine.scheduler.queue().pending.map((p) => mine.scheduler.ownerOf(p.runId))).toEqual([ann.id]);
    // no owner: nothing is queued, and the first admin gets nothing
    const none = start({ repoId: "r1" });
    await none.w.tick();
    expect(none.scheduler.queue().pending).toEqual([]);
    expect(none.w.status.lastError).toMatch(/no owner/);
  });

  it("starts nothing more after stop(true), also in the middle of a check", async () => {
    issue();
    const release = gh.hold("issue list");
    const retired = start({});
    const tick = retired.w.tick();
    await new Promise((r) => setTimeout(r, 300));
    retired.w.stop(true);
    release();
    await tick;
    expect(retired.scheduler.queue().pending).toEqual([]);
    expect(readFileSync(process.env.FAKE_GH_LOG!, "utf8")).not.toContain("issue edit");

    const release2 = gh.hold("issue list");
    const plain = start({});
    const tick2 = plain.w.tick();
    await new Promise((r) => setTimeout(r, 300));
    plain.w.stop();
    release2();
    await tick2;
    expect(plain.scheduler.queue().pending).toHaveLength(1);
  });
});

describe("watchers of two repositories", () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  let close: () => void;
  let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
  let admin: TestSession;
  let ann: TestSession;
  let logs: string[];
  let kc: ReturnType<typeof fakeKeychain>;

  beforeEach(async () => {
    logs = [];
    kc = fakeKeychain();
    ({ close, ctx } = await startServer({ repo: gh.tmp, runsDir: join(gh.tmp, "runs"), port, claudeBin, watcherRetryMs: 50, log: (m) => void logs.push(m) }));
    ctx.scheduler.drain();
    admin = await signInAs(base);
    ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  });
  afterEach(() => {
    close();
    kc.remove();
  });

  const call = async (who: TestSession, method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: () => r.json() as Promise<any> };
  };
  const addWatcher = (repo: string, id: string) => call(admin, "POST", `/api/admin/repos/${repo}/watchers`, { id, max_per_tick: 5, exclude_labels: ["other-flow"] });

  it("does not mix issues, holds, locks and owners", async () => {
    const annRepo = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    const adminRepo = addRepo(admin.user.id, { url: "acme/web" });
    const label = [{ name: "claude-factory" }];
    process.env.FAKE_GH_ISSUES_BY_REPO = JSON.stringify({
      "acme/app": [
        { number: 5, title: "five", labels: label, body: "### Depends on\n#9\n" },
        { number: 7, title: "seven", labels: label, body: "" },
        { number: 9, title: "nine", state: "OPEN", labels: [{ name: "other-flow" }], body: "" },
      ],
      "acme/web": [{ number: 4, title: "four", labels: label, body: "" }, { number: 7, title: "seven", labels: label, body: "" }],
    });
    expect((await addWatcher(annRepo.id, "app-w")).status).toBe(201);
    expect((await addWatcher(adminRepo.id, "web-w")).status).toBe(201);
    for (const id of ["app-w", "web-w"]) {
      expect((await call(admin, "POST", `/api/watchers/${id}/tick`, {})).status).toBe(200);
    }
    // the first check of each watcher started on its own; wait until both have finished one
    for (let i = 0; i < 100 && !ctx.watchers.tracked().every((t) => t.status.lastOk); i++) await new Promise((r) => setTimeout(r, 100));

    const tracked = ctx.watchers.tracked();
    const of = (id: string) => tracked.find((t) => t.watcher.id === id)!;
    expect(of("app-w").issues.map((i) => i.issue).sort()).toEqual([5, 7]);
    expect(of("web-w").issues.map((i) => i.issue).sort()).toEqual([4, 7]);
    expect(of("app-w").status.holds?.map((h) => h.next.kind)).toEqual(["dependency"]);
    expect(of("web-w").status.holds ?? []).toEqual([]);

    const pending = ctx.scheduler.queue().pending;
    const owners = (lock: string) => pending.filter((p) => p.lockKey === lock).map((p) => ctx.scheduler.ownerOf(p.runId));
    expect(owners("acme/app#7")).toEqual([ann.user.id]);
    expect(owners("acme/web#4")).toEqual([admin.user.id]);
    expect(owners("acme/web#7")).toEqual([admin.user.id]);
    expect(pending.some((p) => p.lockKey === "acme/app#5")).toBe(false);

    const rows = (await (await call(admin, "GET", "/api/watchers")).json()) as { id: string; repoId: string }[];
    expect(rows.map((r) => [r.id, r.repoId]).sort()).toEqual([["app-w", annRepo.id], ["web-w", adminRepo.id]]);
    // Ann sees only her job
    const queue = await (await call(ann, "GET", "/api/queue")).json();
    expect(queue.pending.map((p: { githubRepo: string; issue: string }) => `${p.githubRepo}#${p.issue}`)).toEqual(["acme/app#7"]);
    expect(readFileSync(process.env.FAKE_GH_LOG!, "utf8").split("\n").filter((l) => /issue (view|edit|comment) 5\b/.test(l) && !l.includes("acme/app"))).toEqual([]);
  });

  it("starts the new owner's runs after a transfer, and stops with the repository", async () => {
    const second = await signInAs(base, { name: "Second", email: "second@example.com", role: "admin" });
    const repo = addRepo(admin.user.id, { url: "acme/web" });
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "four", labels: [{ name: "claude-factory" }] }]);
    await addWatcher(repo.id, "web-w");
    expect(ctx.watchers.tracked()[0]!.watcher.ownerId).toBe(admin.user.id);
    expect((await call(admin, "POST", `/api/admin/repos/${repo.id}/transfer`, { email: second.user.email })).status).toBe(200);
    const w = ctx.watchers.tracked()[0]!.watcher;
    expect([w.ownerId, w.owner]).toEqual([second.user.id, second.user.email]);
    expect((await call(admin, "DELETE", `/api/repos/${repo.id}`)).status).toBe(404); // not the admin's own any more
    expect((await call(second, "DELETE", `/api/repos/${repo.id}`)).status).toBe(200);
    expect(ctx.watchers.tracked()).toEqual([]);
    expect(readFileSync(repoWatchersPath(), "utf8")).not.toContain("web-w");
  });

  it("fails closed when the store cannot be read, and runs again when it can", async () => {
    const repo = addRepo(admin.user.id, { url: "acme/web" });
    await addWatcher(repo.id, "web-w");
    await call(admin, "PUT", "/api/config", { ...(await (await call(admin, "GET", "/api/config")).json()), watchers: [{ id: "file-w", github_repo: "acme/file" }] });
    expect(ctx.watchers.tracked().map((t) => t.watcher.id).sort()).toEqual(["file-w", "web-w"]);
    const good = readFileSync(repoWatchersPath(), "utf8");
    writeFileSync(repoWatchersPath(), "not json");
    await call(admin, "PUT", "/api/config", await (await call(admin, "GET", "/api/config")).json());
    expect(ctx.watchers.tracked().map((t) => t.watcher.id)).toEqual(["file-w"]);
    expect(((await (await call(admin, "GET", "/api/watchers")).json()) as { id: string }[]).map((w) => w.id)).toEqual(["file-w"]);
    expect(logs.filter((l) => l === "repo-watchers: repo-watchers.json not-json")).toHaveLength(1);
    writeFileSync(repoWatchersPath(), good);
    await new Promise((r) => setTimeout(r, 400));
    expect(ctx.watchers.tracked().map((t) => t.watcher.id).sort()).toEqual(["file-w", "web-w"]);
  });
});
