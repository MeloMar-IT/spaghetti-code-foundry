import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addRepo, getRepo, listRepos } from "../src/auth/repos.js";
import { addCredential } from "../src/credentials/store.js";
import { createSession, refinementsPath } from "../src/refinement/store.js";
import { forgetHistory } from "../src/server/next.js";
import { forgetBoard, searchFor, type SearchAnswer, type SearchType } from "../src/server/search.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, fakeToken, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const WALK = `name: walk
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
  - {id: gate, type: approval, message: "Go?"}
`;
const SLOW = `name: slow
workspace: empty
one_per_repo: true
publish:
  enabled: true
steps:
  - {id: a, type: shell, run: "sleep 30"}
`;
const INPLACE = `name: inplaceflow
workspace: inplace
publish:
  enabled: true
steps:
  - {id: a, type: shell, run: "echo hi"}
`;
const PRIVATE = `name: privateflow
workspace: empty
steps:
  - {id: a, type: shell, run: "echo hi"}
`;
const OK = { ownerOk: () => true, repoName: (_o: string, n: string) => n };

let kc: FakeKeychain;
let tmp: string;
let home: string;
let repo: string;
let runsDir: string;
let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
let base: string;
let close: () => void;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
const savedHome = process.env.FACTORY_HOME;
const diag: string[] = [];

beforeAll(async () => {
  kc = fakeKeychain();
  tmp = mkdtempSync(join(tmpdir(), "search-api-"));
  home = join(tmp, "home");
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  process.env.FACTORY_HOME = home;
  for (let i = 0; ; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    try {
      const started = await startServer({ repo, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
      ctx = started.ctx;
      ctx.diagLog = (m: string) => void diag.push(m);
      base = `http://127.0.0.1:${port}`;
      close = started.close;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
    }
  }
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  for (const [name, yaml] of [["walk", WALK], ["slow", SLOW], ["inplaceflow", INPLACE], ["privateflow", PRIVATE]] as const) {
    const r = await call(admin, "PUT", `/api/flows/${name}`, { yaml, scope: "repo" });
    expect(r.status).toBe(200);
  }
});
afterAll(() => {
  close();
  kc.remove();
  rmSync(tmp, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

const call = async (who: TestSession | undefined, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(who ? who.headers(method) : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
};
const find = async (who: TestSession, qs: string) => {
  const r = await call(who, "GET", `/api/search?${qs}`);
  expect(r.status, r.text).toBe(200);
  return { ...(r.json() as SearchAnswer), text: r.text };
};
const q = (who: TestSession, text: string) => find(who, `q=${encodeURIComponent(text)}`);
const hitsOf = (a: SearchAnswer, type: SearchType) => a.groups.find((g) => g.type === type)?.hits ?? [];
const writeRun = (id: string, extra: Record<string, unknown> = {}, dir = id) => {
  mkdirSync(join(runsDir, dir), { recursive: true });
  writeFileSync(join(runsDir, dir, "run.json"), JSON.stringify({
    runId: id, flow: "old", task: "", vars: {}, repo, status: "succeeded", runDir: join(runsDir, dir),
    startedAt: "2026-01-01T00:00:00.000Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...extra,
  }));
};

describe("the route", () => {
  it("needs a session, answers GET only and limits the text", async () => {
    expect((await call(undefined, "GET", "/api/search?q=x")).status).toBe(401);
    expect((await call(ann, "POST", "/api/search", {})).status).toBe(404);
    expect((await call(ann, "GET", "/api/search/x")).status).toBe(404);
    expect((await call(ann, "GET", `/api/search?q=${encodeURIComponent("😀".repeat(100))}`)).status).toBe(200);
    expect((await call(ann, "GET", `/api/search?q=${encodeURIComponent("😀".repeat(101))}`)).status).toBe(400);
  });
  it("answers a blank text with no groups, and a bad id with 400", async () => {
    expect(await q(ann, "")).toMatchObject({ q: "", groups: [] });
    expect(await q(ann, "   ")).toMatchObject({ q: "", groups: [] });
    expect((await call(ann, "GET", "/api/search")).status).toBe(200);
    expect((await call(ann, "GET", "/api/search?id=x:1")).status).toBe(400);
  });
});

describe("what a user finds", () => {
  it("finds own runs, repository, session and published flows, and nothing of the server", async () => {
    writeRun("r-ann-1", { owner: ann.user.id, task: "Repair the quokka cage\nsecond line", flow: "walk", vars: { github_repo: "acme/app", issue: "254" } });
    addRepo(ann.user.id, "acme/zebrafarm", OK);
    createSession(ann.user.id, { repo: "acme/app", idea: "idea", title: "Rethink gizmo" }, OK);

    const run = await q(ann, "quokka");
    expect(hitsOf(run, "run")).toEqual([{ type: "run", id: "r-ann-1", title: "Repair the quokka cage", href: "#/runs/r-ann-1", status: expect.any(String), repo: "acme/app", detail: "walk · #254", at: "2026-01-01T00:00:00.000Z" }]);
    expect(hitsOf(await q(ann, "ann-1"), "run").map((h) => h.id)).toEqual(["r-ann-1"]);
    expect(hitsOf(await q(ann, "#254"), "run").map((h) => h.id)).toEqual(["r-ann-1"]);
    expect(hitsOf(await q(ann, "zebra"), "repo")).toMatchObject([{ title: "acme/zebrafarm", href: "#/repos" }]);
    expect(hitsOf(await q(ann, "gizmo"), "refinement")).toMatchObject([{ title: "Rethink gizmo", repo: "acme/app", status: "exploring" }]);
    const flows = await q(ann, "walk");
    expect(hitsOf(flows, "flow")).toMatchObject([{ id: "walk", href: "#/start" }]);
  });
  it("has no issue group, no owner, no unpublished or in-place flow and no server paths", async () => {
    const all = [await q(ann, "walk"), await q(ann, "flow"), await q(ann, "inplaceflow"), await q(ann, "privateflow"), await q(ann, "quokka"), await q(ann, "acme")];
    for (const a of all) {
      expect(a.groups.some((g) => g.type === "issue")).toBe(false);
      for (const g of a.groups) for (const h of g.hits) expect(h.owner).toBeUndefined();
      expect(a.text).not.toMatch(/runDir|workdir|"path"|totalCostUsd/);
    }
    expect(hitsOf(await q(ann, "inplaceflow"), "flow")).toEqual([]);
    expect(hitsOf(await q(ann, "privateflow"), "flow")).toEqual([]);
  });
});

describe("isolation", () => {
  it("shows nothing of another account and does not change when it adds things", async () => {
    const words = ["walk", "quokka", "acme", "gizmo", "r-ann", "254"];
    const before = await Promise.all(words.map((w) => q(ann, w)));
    writeRun("r-bob-1", { owner: bob.user.id, task: "Bob wombat quokka", flow: "walk", vars: { github_repo: "acme/app", issue: "254" } });
    addRepo(bob.user.id, "acme/wombatpark", OK);
    createSession(bob.user.id, { repo: "acme/app", idea: "idea", title: "Wombat gizmo" }, OK);
    expect(await q(ann, "wombat")).toMatchObject({ groups: [] });
    expect((await call(ann, "GET", "/api/search?id=run:r-bob-1")).json().groups).toEqual([]);
    const after = await Promise.all(words.map((w) => q(ann, w)));
    expect(after.map((a) => a.groups)).toEqual(before.map((a) => a.groups));
  });
  it("leaves out a run.json that does not agree with its folder or another owner", async () => {
    writeRun("r-liar", { owner: ann.user.id, task: "Liar badfolder" }, "r-folder-liar");
    writeRun("r-other", { owner: bob.user.id, task: "Other badfolder" });
    writeRun("r-nosuch", { task: "Old badfolder" });
    expect(hitsOf(await q(ann, "badfolder"), "run")).toEqual([]);
    expect(hitsOf(await q(admin, "badfolder"), "run").map((h) => h.id).sort()).toEqual(["r-nosuch", "r-other"]);
    expect(hitsOf(await q(admin, "liar"), "run")).toEqual([]);
  });
  it("finds an old run.json with only a few fields", async () => {
    mkdirSync(join(runsDir, "r-oldie"), { recursive: true });
    writeFileSync(join(runsDir, "r-oldie", "run.json"), JSON.stringify({ runId: "r-oldie", status: "failed", flow: "f", startedAt: "2026-01-01T00:00:00.000Z", owner: ann.user.id }));
    for (const who of [ann, admin]) expect(hitsOf(await q(who, "oldie"), "run")).toMatchObject([{ id: "r-oldie", title: "Run r-oldie" }]);
  });
  it("hides the server's folders in a title and does not match them", async () => {
    const workdir = join(tmp, "work", "dir-secretfolder");
    writeRun("r-path", { owner: ann.user.id, task: `Build in ${workdir} please`, workdir });
    writeRun("r-late", { owner: ann.user.id, task: `${"x".repeat(185)} ${workdir}`, workdir });
    const a = await q(ann, "build");
    expect(hitsOf(a, "run")[0]!.title).toBe("Build in (folder) please");
    expect(hitsOf(await q(ann, "secretfolder"), "run")).toEqual([]);
    expect(hitsOf(await q(ann, "xxxxxxxx"), "run")[0]!.title).not.toContain("secretfolder");
    expect(hitsOf(await q(ann, workdir), "run")).toEqual([]);
  });
  it("ranks a visible title above a raw path match", async () => {
    const workdir = join(tmp, "work", "pathword");
    writeRun("r-rawpath", { owner: ann.user.id, task: `Something in ${workdir}`, workdir });
    writeRun("r-visible", { owner: ann.user.id, task: "pathword is visible here" });
    expect(hitsOf(await q(ann, "pathword"), "run").map((h) => h.id)).toEqual(["r-visible"]);
  });
  it("hides a stored secret", async () => {
    const secret = fakeToken("Aa1");
    addCredential({ userId: ann.user.id, type: "token", name: "key", secret });
    writeRun("r-secret", { owner: ann.user.id, task: `Deploy sekritword with ${secret} now` });
    for (const who of [ann, admin]) {
      const a = await q(who, "sekritword");
      expect(hitsOf(a, "run")[0]!.title).toContain("[redacted]");
      expect(a.text).not.toContain(secret);
      expect(hitsOf(await q(who, secret), "run")).toEqual([]);
      expect(hitsOf(await q(who, secret.slice(0, 8)), "run")).toEqual([]);
    }
  });
  it("reads no run file for a query that matches no run", async () => {
    const get = vi.spyOn(ctx.scheduler, "get");
    await q(ann, "nomatchatallwhatsoever");
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });
});

describe("reach and limits", () => {
  it("finds a title match beyond run 200", async () => {
    // These folder names sort before every generated run id, so the later tests still see their runs among the newest 200.
    writeRun("0-oldest", { owner: ann.user.id, task: "Beyondword task" });
    for (let i = 0; i < 201; i++) writeRun(`1-${String(i).padStart(3, "0")}`, { owner: ann.user.id, task: `filler ${i}` });
    writeRun("0-liar", { owner: ann.user.id, task: "Beyondword liar" }, "0-liar-folder");
    expect(hitsOf(await q(ann, "beyondword"), "run").map((h) => h.id)).toEqual(["0-oldest"]);
  });
  it("gives 8 hits and more for 9 sessions, and no more for 8", async () => {
    const eve = await signInAs(base, { name: "Eve", email: "eve@example.com", role: "user" });
    for (let i = 0; i < 8; i++) createSession(eve.user.id, { repo: "acme/app", idea: "idea", title: `Capybara ${i}` }, OK);
    expect(await q(eve, "capybara")).toMatchObject({ groups: [{ type: "refinement", more: false }] });
    createSession(eve.user.id, { repo: "acme/app", idea: "idea", title: "Capybara 9" }, OK);
    const a = await q(eve, "capybara");
    expect(a.groups[0]).toMatchObject({ more: true });
    expect(a.groups[0]!.hits).toHaveLength(8);
  });
});

describe("status and queued jobs", () => {
  it("uses the record of GET /api/runs for a waiting and a succeeded run", async () => {
    writeRun("zz-done", { owner: ann.user.id, task: "Statusword done", status: "succeeded" });
    const started = await call(ann, "POST", "/api/runs", { flow: "walk", task: "Statusword waits" });
    expect(started.status).toBe(201);
    expect((await ctx.scheduler.wait(started.json().runId))?.status).toBe("waiting");
    for (const who of [ann, admin]) {
      const list = (await call(who, "GET", "/api/runs")).json() as { runId: string; status: string; next: { status: string } }[];
      const hits = hitsOf(await q(who, "statusword"), "run");
      expect(hits).toHaveLength(2);
      for (const h of hits) {
        const r = list.find((x) => x.runId === h.id)!;
        expect(h.status).toBe(r.next.status);
        expect(h.status).not.toBe(r.status);
      }
    }
  });
  it("finds a queued job that has no run yet, with the record of GET /api/queue", async () => {
    const one = await call(ann, "POST", "/api/runs", { flow: "slow", task: "Slowword one" });
    const two = await call(ann, "POST", "/api/runs", { flow: "slow", task: `Slowword two ${repo}` });
    expect([one.status, two.status]).toEqual([201, 201]);
    const id = two.json().runId as string;
    expect(two.json().queued).toBe(true);
    const queue = (who: TestSession) => call(who, "GET", "/api/queue").then((r) => (r.json().pending as { runId: string; next: { status: string } }[]).find((p) => p.runId === id)!);
    for (const who of [ann, admin]) {
      const hit = hitsOf(await q(who, "slowword"), "run").find((h) => h.id === id)!;
      expect(hit).toMatchObject({ href: "#/runs", status: (await queue(who)).next.status });
      expect(hitsOf(await q(who, id), "run").map((h) => h.id)).toContain(id);
      expect(hitsOf(await q(who, "slow"), "run").map((h) => h.id)).toContain(id);
    }
    const hit = hitsOf(await q(ann, "slowword"), "run").find((h) => h.id === id)!;
    expect(hit.title).toBe("Slowword two (folder)");
    expect(hitsOf(await q(ann, repo), "run")).toEqual([]);
    expect(hitsOf(await q(bob, "slowword"), "run")).toEqual([]);
    expect(hitsOf(await q(admin, "slowword"), "run").find((h) => h.id === id)).toMatchObject({ owner: "Ann" });
    // Two searches for the running one read the shared history at most once.
    forgetHistory(ctx);
    const list = vi.spyOn(ctx.scheduler, "list");
    await q(ann, "slowword");
    await q(ann, "slowword");
    expect(list.mock.calls.length).toBeLessThanOrEqual(1);
    list.mockRestore();
    for (const p of [...ctx.scheduler.queue().pending, ...ctx.scheduler.queue().active]) ctx.scheduler.cancel(p.runId);
  });
  it("copes with a pending resume whose run.json is broken", async () => {
    writeRun("r-brokenresume", { owner: ann.user.id, task: "Resumeword" });
    const real = ctx.scheduler.queue.bind(ctx.scheduler);
    const spy = vi.spyOn(ctx.scheduler, "queue").mockImplementation(() => {
      const q0 = real();
      return { ...q0, pending: [{ ...q0.pending[0], runId: "r-broken", kind: "resume" } as never, ...q0.pending] };
    });
    mkdirSync(join(runsDir, "r-broken"), { recursive: true });
    writeFileSync(join(runsDir, "r-broken", "run.json"), "{");
    for (const who of [ann, admin]) expect(await q(who, "resumeword")).toMatchObject({ groups: [{ type: "run" }] });
    spy.mockRestore();
  });
});

describe("what an admin finds", () => {
  it("finds all accounts with owner names, the board's issues, repositories and flows", async () => {
    const runs = hitsOf(await q(admin, "quokka"), "run");
    expect(runs.map((h) => [h.id, h.owner]).sort()).toEqual([["r-ann-1", "Ann"], ["r-bob-1", "Bob"]]);
    expect(hitsOf(await q(admin, "wombat"), "repo")).toMatchObject([{ title: "acme/wombatpark", href: "#/all-repos", owner: "Bob" }]);
    expect(hitsOf(await q(admin, "wombat"), "refinement")).toMatchObject([{ owner: "Bob" }]);
    expect(hitsOf(await q(admin, "inplaceflow"), "flow")).toMatchObject([{ id: "inplaceflow", href: "#/flows/inplaceflow" }]);
    expect(hitsOf(await q(admin, "privateflow"), "flow")).toHaveLength(1);
  });
  it("finds a watcher-style run by its pull_ticket title, and shows a deleted account", async () => {
    writeRun("r-ticket", { owner: ann.user.id, task: "", state: { next: null, visits: {}, steps: { pull_ticket: { output: "# #9: Tickettitleword here" } } } });
    expect(hitsOf(await q(admin, "tickettitleword"), "run")).toMatchObject([{ id: "r-ticket", title: "Tickettitleword here" }]);
    writeRun("r-ghost", { owner: "11111111-1111-4111-8111-111111111111", task: "Ghostword" });
    expect(hitsOf(await q(admin, "ghostword"), "run")).toMatchObject([{ owner: "deleted account" }]);
  });
  it("finds the board's issues and gives their routes; group order is fixed", async () => {
    const tracked = vi.spyOn(ctx.watchers, "tracked").mockReturnValue([
      { watcher: { id: "w1", github_repo: "acme/app", enabled: false }, status: { id: "w1", lastActions: [], holds: [] }, issues: [{ issue: 254, title: "Quokka fixes", createdAt: "2026-01-01T00:00:00.000Z" }] },
    ] as never);
    forgetBoard(ctx);
    for (const w of ["254", "#254", "25"]) {
      expect(hitsOf(await q(admin, w), "issue"), w).toMatchObject([{ id: "acme/app#254", title: "Quokka fixes", href: "#/board/acme%2Fapp" }]);
    }
    const a = await q(admin, "quokka");
    expect(a.groups.map((g) => g.type)).toEqual(["run", "issue", "refinement", "repo", "flow"].filter((t) => a.groups.some((g) => g.type === t)));
    expect(a.groups.map((g) => g.type).slice(0, 2)).toEqual(["run", "issue"]);
    expect((await call(admin, "GET", "/api/search?id=issue:acme/app%23254")).json().groups[0].hits[0].id).toBe("acme/app#254");
    expect((await call(ann, "GET", "/api/search?id=issue:acme/app%23254")).json().groups).toEqual([]);
    tracked.mockRestore();
    forgetBoard(ctx);
  });
});

describe("view as", () => {
  it("gives the answer of the viewed user, and 403 without a running view", async () => {
    const own = await q(ann, "quokka");
    expect((await call(admin, "GET", `/api/search?q=quokka&as=${ann.user.id}`)).status).toBe(403);
    expect((await call(admin, "POST", "/api/admin/view-as", { userId: ann.user.id })).status).toBeLessThan(300);
    const viewed = await call(admin, "GET", `/api/search?q=quokka&as=${ann.user.id}`);
    expect(viewed.status, viewed.text).toBe(200);
    expect(viewed.json()).toEqual({ q: own.q, groups: own.groups });
  });
});

describe("the id form", () => {
  it("picks by exact id, ignores q and keeps the request order", async () => {
    const repoId = listRepos(ann.user.id)[0]!.id;
    const sessionId = (await q(ann, "gizmo")).groups[0]!.hits[0]!.id;
    const a = await find(ann, `q=nothing&id=repo:${repoId}&id=run:r-ann-1&id=refinement:${sessionId}&id=flow:walk`);
    expect(a.q).toBe("");
    expect(a.groups.map((g) => g.type)).toEqual(["run", "refinement", "repo", "flow"]);
    expect(a.groups.every((g) => !g.more)).toBe(true);
    expect(hitsOf(await find(ann, "id=run:r-ann-1&id=run:zz-done"), "run").map((h) => h.id)).toEqual(["r-ann-1", "zz-done"]);
    // not visible
    expect((await find(ann, "id=run:r-bob-1")).groups).toEqual([]);
    expect((await find(ann, "id=flow:inplaceflow&id=flow:privateflow")).groups).toEqual([]);
    const bobSession = (await q(bob, "wombat")).groups.find((g) => g.type === "refinement")!.hits[0]!.id;
    expect((await find(ann, `id=refinement:${bobSession}`)).groups).toEqual([]);
  });
  it("stops returning a repository after it is transferred, and a flow after it is unpublished", async () => {
    const id = getRepo(listRepos(ann.user.id)[0]!.id)!.id;
    expect(hitsOf(await find(ann, `id=repo:${id}`), "repo")).toHaveLength(1);
    const moved = await call(admin, "POST", `/api/admin/repos/${id}/transfer`, { email: "bob@example.com" });
    expect(moved.status, moved.text).toBeLessThan(300);
    expect((await find(ann, `id=repo:${id}`)).groups).toEqual([]);
    expect(hitsOf(await find(bob, `id=repo:${id}`), "repo")).toHaveLength(1);
    expect(hitsOf(await find(ann, "id=flow:walk"), "flow")).toHaveLength(1);
    expect((await call(admin, "PUT", "/api/flows/walk", { yaml: WALK.replace("publish:\n  enabled: true\n", ""), scope: "repo" })).status).toBe(200);
    expect((await find(ann, "id=flow:walk")).groups).toEqual([]);
  });
});

describe("a source that fails", () => {
  it("is named in incomplete and the rest is answered", async () => {
    const briefs = vi.spyOn(ctx.scheduler, "briefs").mockImplementation(() => {
      throw new Error("/secret/path boom");
    });
    try {
      createSession(ann.user.id, { repo: "acme/app", idea: "idea", title: "Failword session" }, OK);
      const a = await q(ann, "failword");
      expect(a.incomplete).toEqual(["run"]);
      expect(a.groups.map((g) => g.type)).toEqual(["refinement"]);
      expect(diag).toContain("search: run source failed");
      expect(diag.join("\n")).not.toContain("boom");
      const repoId = listRepos(ann.user.id)[0]?.id ?? "00000000-0000-4000-8000-000000000000";
      expect((await find(ann, `id=repo:${repoId}`)).incomplete).toBeUndefined();
    } finally {
      briefs.mockRestore();
    }
  });
  it("names the board for an admin", () => {
    const tracked = vi.spyOn(ctx.watchers, "tracked").mockImplementation(() => {
      throw new Error("boom");
    });
    forgetBoard(ctx);
    const admins = { id: admin.user.id, role: "admin" } as never;
    expect(searchFor(ctx, admins, { q: "anything" }).incomplete).toContain("issue");
    tracked.mockRestore();
    forgetBoard(ctx);
  });
  it("names a corrupt refinements.json only for the reads that need it", async () => {
    const sid = (await q(ann, "gizmo")).groups[0]!.hits[0]!.id;
    writeFileSync(refinementsPath(), "{ not json");
    const a = await q(ann, "gizmo");
    expect(a.incomplete).toEqual(["refinement"]);
    expect(diag).toContain("search: refinement source failed");
    expect((await q(ann, "")).incomplete).toBeUndefined();
    expect((await find(ann, "id=flow:walk")).incomplete).toBeUndefined();
    expect((await find(ann, `id=refinement:${sid}`)).incomplete).toEqual(["refinement"]);
    expect(diag.join("\n")).not.toContain(tmp);
  });
});
