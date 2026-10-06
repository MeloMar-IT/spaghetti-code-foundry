import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo, reposPath } from "../src/auth/repos.js";
import { createUser, deleteUser, setStatus } from "../src/auth/users.js";
import { ConfigSchema, WatcherSchema } from "../src/config.js";
import { Scheduler } from "../src/queue/scheduler.js";
import { Watcher } from "../src/queue/watcher.js";
import { addRepoWatcher, removeWatchersOfRepos, repoWatchersPath } from "../src/repos/watchers.js";
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
    // the owner also counts as the one that queued it, so blocking the owner drops the job instead of letting it start
    expect(mine.scheduler.cancelAccount(ann.id)).toEqual({ queued: 1, running: 0, waiting: 0 });
    expect(mine.scheduler.queue().pending).toEqual([]);
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
  const begin = async () => {
    ({ close, ctx } = await startServer({ repo: gh.tmp, runsDir: join(gh.tmp, "runs"), port, claudeBin, watcherRetryMs: 50, accountSweepMs: 50, log: (m) => void logs.push(m) }));
  };
  /** Stops the server and starts it again on the same data folder. */
  const restart = async () => {
    close();
    await new Promise((r) => setTimeout(r, 150));
    await begin();
    ctx.scheduler.drain();
  };
  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
    return fn();
  };
  const trackedIds = () => ctx.watchers.tracked().map((t) => t.watcher.id);

  beforeEach(async () => {
    logs = [];
    kc = fakeKeychain();
    await begin();
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

  it("sends the runs of a transferred repository to the new owner", async () => {
    const second = await signInAs(base, { name: "Second", email: "second@example.com", role: "admin" });
    const repo = addRepo(admin.user.id, { url: "acme/web" });
    process.env.FAKE_GH_ISSUES = "[]";
    await addWatcher(repo.id, "web-w");
    expect((await call(admin, "POST", `/api/admin/repos/${repo.id}/transfer`, { email: second.user.email })).status).toBe(200);
    // the watcher that runs after the transfer has finished its first check; only then does the issue appear
    expect(await until(() => ctx.watchers.tracked()[0]?.status.lastOk !== undefined, 8000)).toBe(true);
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "four", labels: [{ name: "claude-factory" }] }]);
    const queued = () => ctx.scheduler.queue().pending.filter((p) => p.lockKey === "acme/web#4");
    for (let i = 0; i < 40 && !queued().length; i++) {
      await ctx.watchers.runNow("web-w");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(queued()).toHaveLength(1);
    expect(ctx.scheduler.ownerOf(queued()[0]!.runId)).toBe(second.user.id);
  });

  it("follows a block, an unblock and a delete made from the command line", async () => {
    const repo = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    addRepoWatcher(repo.id, { id: "app-w" });
    ctx.watchers.sync();
    expect(trackedIds()).toEqual(["app-w"]);
    await setStatus(ann.user.id, "blocked", { by: "cli" });
    expect(await until(() => trackedIds().length === 0)).toBe(true);
    const row = ((await (await call(admin, "GET", "/api/watchers")).json()) as { id: string; state: { name: string } }[]).find((w) => w.id === "app-w");
    expect(row?.state.name).toBe("paused");
    await setStatus(ann.user.id, "active", { by: "cli" });
    expect(await until(() => trackedIds().length === 1)).toBe(true);
    deleteUser(ann.user.id, { by: "cli" });
    expect(await until(() => trackedIds().length === 0)).toBe(true);
    const rows = (await (await call(admin, "GET", "/api/watchers")).json()) as { id: string }[];
    expect(rows.map((w) => w.id)).not.toContain("app-w");
  });

  it("drops a pending job of the owner's watcher when the owner is blocked, and never starts it", async () => {
    const repo = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    process.env.FAKE_GH_ISSUES = JSON.stringify([{ number: 4, title: "four", labels: [{ name: "claude-factory" }] }]);
    await call(admin, "POST", `/api/admin/repos/${repo.id}/watchers`, { id: "app-w" });
    expect(await until(() => ctx.scheduler.queue().pending.some((p) => p.lockKey === "acme/app#4"), 8000)).toBe(true);
    expect((await call(admin, "POST", `/api/users/${ann.user.id}/block`, {})).status).toBe(200);
    expect(ctx.scheduler.queue().pending.some((p) => p.lockKey === "acme/app#4")).toBe(false);
  });

  it("notices a change of the watcher file made outside the server", async () => {
    const repo = addRepo(admin.user.id, { url: "acme/web" });
    addRepoWatcher(repo.id, { id: "web-w" });
    ctx.watchers.sync();
    expect(trackedIds()).toEqual(["web-w"]);
    await new Promise((r) => setTimeout(r, 20));
    removeWatchersOfRepos([repo.id]);
    expect(await until(() => trackedIds().length === 0)).toBe(true);
  });

  describe("at start", () => {
    const setUp = () => {
      const repo = addRepo(admin.user.id, { url: "acme/web" });
      addRepoWatcher(repo.id, { id: "web-w" });
      addRepoWatcher(randomUUID(), { id: "orphan-w" });
    };

    it("removes a watcher without a repository, and logs it", async () => {
      setUp();
      await restart();
      expect(readFileSync(repoWatchersPath(), "utf8")).not.toContain("orphan-w");
      expect(logs).toContain('repo-watchers: removed leftover watcher "orphan-w" (its repository is gone)');
      expect(trackedIds()).toEqual(["web-w"]);
    });

    it("removes nothing when repos.json cannot be read", async () => {
      setUp();
      const before = readFileSync(repoWatchersPath(), "utf8");
      writeFileSync(reposPath(), "not json");
      await restart();
      expect(readFileSync(repoWatchersPath(), "utf8")).toBe(before);
      expect(logs.some((l) => l.startsWith("! repo-watchers: leftover watchers could not be removed: repos.json"))).toBe(true);
    });

    it("logs a leftover that cannot be removed, and keeps the other watchers running", async () => {
      setUp();
      const before = readFileSync(repoWatchersPath(), "utf8");
      mkdirSync(repoWatchersPath() + ".tmp");
      await restart();
      expect(readFileSync(repoWatchersPath(), "utf8")).toBe(before);
      expect(logs).toContain("! repo-watchers: leftover watchers could not be removed: repo-watchers.json cannot-write");
      expect(trackedIds()).toEqual(["web-w"]);
      expect(ctx.blockedWatchers().find((b) => b.id === "orphan-w")?.problem).toMatch(/not connected any more/);
    });
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
