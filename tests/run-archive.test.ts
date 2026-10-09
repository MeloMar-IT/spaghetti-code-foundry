import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRunBriefs, setRunArchived } from "../src/engine/state.js";
import { startServer } from "../src/server/server.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { signInAs, type TestSession } from "./helpers/session.js";

const savedHome = process.env.FACTORY_HOME;
let kc: FakeKeychain;
beforeAll(() => void (kc = fakeKeychain()));
afterAll(() => {
  kc.remove();
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
});

const base = (id: string, extra: Record<string, unknown> = {}) => ({
  runId: id, flow: "old", task: "", vars: {}, repo: "/x", status: "failed", runDir: "",
  startedAt: "2026-01-01T00:00:00.000Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} }, ...extra,
});

describe("setRunArchived", () => {
  let dir: string;
  const file = () => join(dir, "run.json");
  const put = (extra: Record<string, unknown> = {}) => {
    writeFileSync(file(), JSON.stringify(base("r1", { runDir: dir, ...extra }), null, 2));
    const t = new Date("2026-02-02T02:02:02.000Z");
    utimesSync(file(), t, t);
    chmodSync(file(), 0o640);
  };
  beforeAll(() => void (dir = mkdtempSync(join(tmpdir(), "run-arch-unit-"))));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("sets and removes the mark and keeps the other fields, the mode and the file time", () => {
    put({ owner: "u1" });
    const before = statSync(file());
    expect(setRunArchived(dir, "2026-03-03T00:00:00.000Z", "adm")).toBe(true);
    const s = JSON.parse(readFileSync(file(), "utf8"));
    expect(s).toMatchObject({ runId: "r1", owner: "u1", status: "failed", archivedAt: "2026-03-03T00:00:00.000Z", archivedBy: "adm" });
    expect(Math.round(statSync(file()).mtimeMs)).toBe(Math.round(before.mtimeMs));
    expect(statSync(file()).mode & 0o777).toBe(0o640);
    expect(setRunArchived(dir, null)).toBe(true);
    const t = JSON.parse(readFileSync(file(), "utf8"));
    expect("archivedAt" in t || "archivedBy" in t).toBe(false);
    expect(Math.round(statSync(file()).mtimeMs)).toBe(Math.round(before.mtimeMs));
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("changes nothing when the file is already in the wanted state", () => {
    put();
    const text = readFileSync(file(), "utf8");
    expect(setRunArchived(dir, null)).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe(text);
    expect(setRunArchived(dir, "2026-03-03T00:00:00.000Z", "a")).toBe(true);
    const archived = readFileSync(file(), "utf8");
    expect(setRunArchived(dir, "2026-04-04T00:00:00.000Z", "b")).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe(archived);
  });

  it("refuses a missing file, broken JSON, an array and a live run; accepts a dead one", () => {
    rmSync(file(), { force: true });
    expect(setRunArchived(dir, "2026-03-03T00:00:00.000Z")).toBe(false);
    writeFileSync(file(), "{ not json");
    expect(setRunArchived(dir, "2026-03-03T00:00:00.000Z")).toBe(false);
    writeFileSync(file(), "[]");
    expect(setRunArchived(dir, "2026-03-03T00:00:00.000Z")).toBe(false);
    put({ status: "running", pid: process.pid });
    expect(setRunArchived(dir, "2026-03-03T00:00:00.000Z")).toBe(false);
    put({ status: "running", pid: 2 ** 22 + 12345 });
    expect(setRunArchived(dir, "2026-03-03T00:00:00.000Z")).toBe(true);
  });

  it("replaces nothing when run.json changes in between, and leaves no temp file", () => {
    put();
    const other = JSON.stringify(base("r1", { runDir: dir, reason: "other writer" }));
    expect(setRunArchived(dir, "2026-03-03T00:00:00.000Z", "a", { beforeSwap: () => writeFileSync(file(), other) })).toBe(false);
    expect(readFileSync(file(), "utf8")).toBe(other);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("shows in the briefs right away and keeps updatedAt", () => {
    const runs = mkdtempSync(join(tmpdir(), "run-arch-briefs-"));
    try {
      const d = join(runs, "r1");
      mkdirSync(d);
      writeFileSync(join(d, "run.json"), JSON.stringify(base("r1", { runDir: d })));
      const first = listRunBriefs(runs)[0]!;
      expect(first.archived).toBeUndefined();
      expect(setRunArchived(d, "2026-03-03T00:00:00.000Z", "a")).toBe(true);
      const b = listRunBriefs(runs)[0]!;
      expect(b.archived).toBe(true);
      expect(b.updatedAt).toBe(first.updatedAt);
      expect(setRunArchived(d, null)).toBe(true);
      expect(listRunBriefs(runs)[0]!.archived).toBeUndefined();
    } finally {
      rmSync(runs, { recursive: true, force: true });
    }
  });
});

const QUICK = `name: quick
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "echo hi"}
`;
const BOOM = `name: boom
workspace: empty
publish:
  enabled: true
steps:
  - {id: say, type: shell, run: "exit 1"}
`;
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
  - {id: a, type: shell, run: "sleep 2"}
`;

describe("archive routes", () => {
  let tmp: string;
  let runsDir: string;
  let baseUrl: string;
  let close: () => void;
  let scheduler: Awaited<ReturnType<typeof startServer>>["ctx"]["scheduler"];
  let admin: TestSession;
  let ann: TestSession;
  let bob: TestSession;

  const call = async (who: TestSession, method: string, path: string, body?: unknown) => {
    const r = await fetch(baseUrl + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  const file = (id: string) => join(runsDir, id, "run.json");
  const runJson = (id: string) => JSON.parse(readFileSync(file(id), "utf8"));
  const audit = (action: string) => {
    const p = join(process.env.FACTORY_HOME!, "audit.jsonl");
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.includes(`"${action}"`)).length : 0;
  };
  const writeRun = (id: string, extra: Record<string, unknown> = {}) => {
    mkdirSync(join(runsDir, id), { recursive: true });
    writeFileSync(file(id), JSON.stringify(base(id, { runDir: join(runsDir, id), repo: tmp, ...extra })));
  };
  const start = async (who: TestSession, flow: string) => {
    const r = await call(who, "POST", "/api/runs", { flow, task: flow });
    expect(r.status).toBe(201);
    return r.json().runId as string;
  };
  const ids = async (who: TestSession, q = "") => (await call(who, "GET", `/api/runs${q}`)).json().map((r: { runId: string }) => r.runId) as string[];

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "run-arch-"));
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: repo, stdio: "ignore" });
    process.env.FACTORY_HOME = join(tmp, "home");
    runsDir = join(tmp, "runs");
    for (let i = 0; ; i++) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      try {
        const started = await startServer({ repo, runsDir, port, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: () => {} });
        baseUrl = `http://127.0.0.1:${port}`;
        scheduler = started.ctx.scheduler;
        close = started.close;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE" || i >= 40) throw e;
      }
    }
    admin = await signInAs(baseUrl);
    ann = await signInAs(baseUrl, { name: "Ann", email: "ann@example.com", role: "user" });
    bob = await signInAs(baseUrl, { name: "Bob", email: "bob@example.com", role: "user" });
    for (const [name, yaml] of [["quick", QUICK], ["boom", BOOM], ["walk", WALK], ["slow", SLOW]] as const) {
      expect((await call(admin, "PUT", `/api/flows/${name}`, { yaml, scope: "repo" })).status).toBe(200);
    }
  });
  afterAll(() => {
    close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("archives and unarchives a finished run, once in the audit log per call", async () => {
    const id = await start(ann, "quick");
    expect((await scheduler.wait(id))?.status).toBe("succeeded");
    const t0 = scheduler.briefs().find((b) => b.runId === id)!.updatedAt;
    const r = await call(ann, "POST", `/api/runs/${id}/archive`, {});
    expect(r.status).toBe(200);
    expect(r.json()).toEqual({ runId: id, archived: true });
    expect(typeof runJson(id).archivedAt).toBe("string");
    expect(runJson(id).archivedBy).toBe(ann.user.id);
    expect(scheduler.briefs().find((b) => b.runId === id)!.updatedAt).toBe(t0);
    expect(audit("run-archive")).toBe(1);
    const bytes = readFileSync(file(id), "utf8");
    expect((await call(ann, "POST", `/api/runs/${id}/archive`, {})).status).toBe(200);
    expect(readFileSync(file(id), "utf8")).toBe(bytes);
    expect(audit("run-archive")).toBe(2);

    expect(await ids(ann)).not.toContain(id);
    expect(await ids(ann, "?archived=1")).toEqual([id]);
    expect(await ids(admin)).not.toContain(id);
    expect(await ids(admin, "?archived=1")).toContain(id);
    expect(await ids(admin, `?owner=${ann.user.id}&archived=1`)).toEqual([id]);
    expect(await ids(admin, `?owner=${bob.user.id}&archived=1`)).toEqual([]);
    for (const who of [ann, admin]) for (const bad of ["0", "", "true"]) expect((await call(who, "GET", `/api/runs?archived=${bad}`)).status).toBe(400);

    const view = (await call(ann, "GET", `/api/runs/${id}`)).json();
    expect(view.archivedAt).toBe(runJson(id).archivedAt);
    expect("archivedBy" in view).toBe(false);
    expect((await call(admin, "GET", `/api/runs/${id}`)).json().archivedBy).toBe(ann.user.id);
    expect((await call(ann, "GET", `/api/runs/${id}/diff`)).status).toBe(200);

    const u = await call(ann, "POST", `/api/runs/${id}/unarchive`, {});
    expect(u.status).toBe(200);
    expect(u.json()).toEqual({ runId: id, archived: false });
    expect("archivedAt" in runJson(id) || "archivedBy" in runJson(id)).toBe(false);
    expect(audit("run-unarchive")).toBe(1);
    expect(await ids(ann)).toContain(id);
  });

  it("archives failed, cancelled and stopped runs, and lets the admin archive any run", async () => {
    for (const status of ["failed", "cancelled", "stopped"]) {
      const id = `st-${status}`;
      writeRun(id, { status, owner: ann.user.id });
      expect((await call(ann, "POST", `/api/runs/${id}/archive`, {})).status, status).toBe(200);
    }
    writeRun("by-admin", { owner: ann.user.id });
    expect((await call(admin, "POST", "/api/runs/by-admin/archive", {})).status).toBe(200);
    expect(runJson("by-admin").archivedBy).toBe(admin.user.id);
    expect((await call(ann, "GET", "/api/runs/by-admin")).json().archivedAt).toEqual(expect.any(String));
    expect((await call(ann, "POST", "/api/runs/by-admin/unarchive", {})).status).toBe(200);
  });

  it("answers 404 for unknown runs and other accounts' runs, and changes nothing", async () => {
    writeRun("ann-run", { owner: ann.user.id });
    writeRun("no-owner");
    const before = readFileSync(file("ann-run"), "utf8");
    for (const route of ["archive", "unarchive"]) {
      expect((await call(admin, "POST", `/api/runs/nope/${route}`, {})).status).toBe(404);
      const b = await call(bob, "POST", `/api/runs/ann-run/${route}`, {});
      expect(b.status).toBe(404);
      expect(b.json()).toEqual({ error: "run not found" });
      expect((await call(ann, "POST", `/api/runs/no-owner/${route}`, {})).status).toBe(404);
    }
    expect(readFileSync(file("ann-run"), "utf8")).toBe(before);
  });

  it("answers 409 for a waiting, a running and a queued run", async () => {
    const waiting = await start(ann, "walk");
    expect((await scheduler.wait(waiting))?.status).toBe("waiting");
    const running = await start(ann, "slow");
    const queued = await start(ann, "slow");
    expect(scheduler.isQueued(queued)).toBe(true);
    for (const id of [waiting, running, queued]) {
      const read = () => (existsSync(file(id)) ? readFileSync(file(id), "utf8") : "");
      const before = read();
      for (const route of ["archive", "unarchive"]) expect((await call(ann, "POST", `/api/runs/${id}/${route}`, {})).status, `${id} ${route}`).toBe(409);
      expect(read()).toBe(before);
    }
    scheduler.cancel(queued);
    scheduler.cancel(running);
    await scheduler.idle();
  });

  it("applies the archive choice before the cap of 200", async () => {
    const owner = "cap-owner";
    for (let i = 0; i < 205; i++) {
      const id = `zz-cap-${String(i).padStart(3, "0")}`;
      writeRun(id, { owner, ...(i >= 2 ? { archivedAt: "2026-01-02T00:00:00.000Z" } : {}) });
    }
    const normal = (await call(admin, "GET", `/api/runs?owner=${owner}`)).json();
    expect(normal.map((r: { runId: string }) => r.runId).sort()).toEqual(["zz-cap-000", "zz-cap-001"]);
    expect(await ids(admin, `?owner=${owner}&archived=1`)).toHaveLength(200);
  });

  it("keeps the other views of an archived run the same", async () => {
    const id = await start(ann, "quick");
    await scheduler.wait(id);
    const get = async (p: string) => (await call(admin, "GET", p)).text;
    const paths = ["/api/stats", "/api/board", "/api/next"];
    const before = await Promise.all(paths.map(get));
    const t0 = scheduler.briefs().find((b) => b.runId === id)!.updatedAt;
    expect((await call(ann, "POST", `/api/runs/${id}/archive`, {})).status).toBe(200);
    const after = await Promise.all(paths.map(get));
    expect(after).toEqual(before);
    const b = scheduler.briefs().find((x) => x.runId === id)!;
    expect(b.updatedAt).toBe(t0);
    expect((await call(admin, "GET", `/api/runs/${id}/transcript/0`)).status).toBe(200);
    const ev = await fetch(`${baseUrl}/api/runs/${id}/events`, { headers: ann.headers(), signal: AbortSignal.timeout(300) }).catch(() => undefined);
    if (ev) {
      expect(ev.status).toBe(200);
      expect(ev.headers.get("content-type")).toContain("text/event-stream");
    }
  });

  it("removes the mark when the run is resumed", async () => {
    const id = await start(ann, "boom");
    expect((await scheduler.wait(id))?.status).toBe("failed");
    expect((await call(ann, "POST", `/api/runs/${id}/archive`, {})).status).toBe(200);
    expect(await ids(ann)).not.toContain(id);
    expect((await call(ann, "POST", `/api/runs/${id}/resume`, {})).status).toBe(202);
    await scheduler.wait(id);
    await scheduler.idle();
    expect("archivedAt" in runJson(id) || "archivedBy" in runJson(id)).toBe(false);
    expect(await ids(ann)).toContain(id);
  });

  it("removes the mark when a waiting run is approved", async () => {
    const id = await start(ann, "walk");
    expect((await scheduler.wait(id))?.status).toBe("waiting");
    writeFileSync(file(id), JSON.stringify({ ...runJson(id), archivedAt: "2026-01-02T00:00:00.000Z", archivedBy: ann.user.id }));
    expect((await call(ann, "POST", `/api/runs/${id}/approve`, {})).status).toBe(202);
    await scheduler.idle();
    expect("archivedAt" in runJson(id)).toBe(false);
  });

  describe("search and filters", () => {
    const GHOST = "22222222-2222-4222-8222-222222222222";

    it("finds a run beyond the 200 newest, with every filter applied before the cap", async () => {
      const seeded: string[] = [];
      const seed = (id: string, extra: Record<string, unknown>) => {
        writeRun(id, { owner: GHOST, status: "succeeded", startedAt: "2026-06-01T00:00:00.000Z", ...extra });
        seeded.push(id);
      };
      try {
        for (let i = 0; i <= 200; i++) seed(`20200102-000000-f${String(i).padStart(3, "0")}`, {});
        seed("20200101-000000-needle", { status: "failed", startedAt: "2020-01-01T10:00:00.000Z", task: "Find the Needle here\nsecond", flow: "oldflow", vars: { github_repo: "acme/old", issue: "7" } });
        seed("20200101-000000-late", { startedAt: "2030-01-01T00:00:00.000Z", task: "other", flow: "lateflow" });
        const needle = "20200101-000000-needle";
        const late = "20200101-000000-late";
        const o = `?owner=${GHOST}`;
        const all = await ids(admin, o);
        expect(all).toHaveLength(200);
        expect(all).not.toContain(needle);
        expect(all).not.toContain(late);
        for (const q of ["&q=NEEDLE", "&q=acme/old%237", "&q=%237", "&flow=oldflow", "&repo=acme/old", "&status=failed", "&since=2020-01-01&status=failed&q=needle"]) {
          expect(await ids(admin, o + q), q).toEqual([needle]);
        }
        expect(await ids(admin, `${o}&since=2029-01-01`)).toEqual([late]);
        expect(await ids(admin, `${o}&since=2020-01-01T12:00:00Z&flow=lateflow`)).toEqual([late]);
        expect(await ids(admin, `${o}&since=2020-01-01T09:00:00Z&flow=oldflow`)).toEqual([needle]);
        expect(await ids(admin, `${o}&since=2020-01-01T11:00:00Z&flow=oldflow`)).toEqual([]);
        // the row has the same shape as in the plain list
        const row = (await call(admin, "GET", `/api/runs${o}&q=needle`)).json()[0];
        const plain = (await call(admin, "GET", `/api/runs${o}`)).json()[0];
        expect(Object.keys(row).sort()).toEqual(Object.keys(plain).sort());
        // an unknown parameter changes nothing
        expect(await ids(admin, `${o}&foo=1`)).toEqual(all);
        // the filter menus
        const menus = (await call(admin, "GET", "/api/run-filters")).json();
        expect(menus.repos).toContain("acme/old");
        expect(menus.flows).toEqual(expect.arrayContaining(["oldflow", "lateflow"]));
        expect(menus.flows).toEqual([...menus.flows].sort((a: string, b: string) => a.localeCompare(b)));
        expect(menus.repos).toEqual([...menus.repos].sort((a: string, b: string) => a.localeCompare(b)));
      } finally {
        for (const id of seeded) rmSync(join(runsDir, id), { recursive: true, force: true });
      }
    });

    it("never shows a user another account's run, with any filter", async () => {
      const id = "20200103-000000-bobsecret";
      try {
        writeRun(id, { owner: bob.user.id, flow: "bobflow", task: "secret-bob", vars: { github_repo: "bob/secret", issue: "9" } });
        for (const q of ["?q=secret-bob", "?flow=bobflow", "?repo=bob/secret", "?q=%239", `?q=secret-bob&owner=${bob.user.id}`]) {
          expect(await ids(ann, q), q).toEqual([]);
        }
        expect(await ids(bob, "?q=secret-bob")).toContain(id);
        expect(await ids(admin, "?q=secret-bob")).toContain(id);
        const annMenus = (await call(ann, "GET", "/api/run-filters")).json();
        expect(JSON.stringify(annMenus)).not.toMatch(/bob\/secret|bobflow|oldflow/);
        expect(annMenus.flows).toContain("quick");
        const adminMenus = (await call(admin, "GET", "/api/run-filters")).json();
        expect(adminMenus.repos).toContain("bob/secret");
        expect(adminMenus.flows).toContain("bobflow");
        // archived mixes in
        writeFileSync(file(id), JSON.stringify({ ...runJson(id), archivedAt: "2026-01-02T00:00:00.000Z" }));
        expect(await ids(bob, "?q=secret-bob")).not.toContain(id);
        expect(await ids(bob, "?archived=1&q=secret-bob")).toContain(id);
      } finally {
        rmSync(join(runsDir, id), { recursive: true, force: true });
      }
    });

    it("answers 400 with a short sentence for a wrong value", async () => {
      for (const who of [admin, ann]) {
        for (const q of ["?status=nope", "?since=nope", `?q=${"a".repeat(201)}`, "?flow="]) {
          const r = await call(who, "GET", `/api/runs${q}`);
          expect(r.status, q).toBe(400);
          expect(r.json().error).toMatch(/^[^\n]{3,120}$/);
        }
      }
    });
  });
});
