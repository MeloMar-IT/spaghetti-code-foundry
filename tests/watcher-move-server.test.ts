import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAllRepos } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { STATUS_MARKER } from "../src/github.js";
import { listRepoWatchers } from "../src/repos/watchers.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, TEST_PASSWORD, type TestSession } from "./helpers/session.js";

let gh: ReturnType<typeof fakeGithub>;
let auth: ReturnType<ReturnType<typeof fakeGithub>["authLog"]>;
let home: string;
let saved: string | undefined;
let kc: ReturnType<typeof fakeKeychain>;
let close: (() => void) | undefined;
let ctx: Awaited<ReturnType<typeof startTestServer>>["ctx"];
let logs: string[];
let base: string;

beforeEach(() => {
  gh = fakeGithub();
  auth = gh.authLog();
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "watcher-move-server-"));
  process.env.FACTORY_HOME = home;
  Object.assign(process.env, { GH_TOKEN: "host-token", GITHUB_TOKEN: "host-github", GH_ENTERPRISE_TOKEN: "host-enterprise" });
  kc = fakeKeychain();
  logs = [];
});
afterEach(async () => {
  close?.();
  close = undefined;
  await new Promise((r) => setTimeout(r, 300));
  kc.remove();
  gh.restore();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const start = async () => {
  ({ close, ctx, base } = await startTestServer({ repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, watcherRetryMs: 50, log: (m) => void logs.push(m) }));
  ctx.scheduler.drain();
};
const makeAdmin = () => createUser({ name: "Test Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
const config = (yaml: string) => writeFileSync(join(home, "config.yaml"), yaml);
const FILE = "watchers:\n  - id: file-w\n    github_repo: Acme/App\n    every: 5m\n";
const issues = () => {
  const l = [{ name: "claude-factory" }];
  process.env.FAKE_GH_ISSUES_BY_REPO = JSON.stringify({ "Acme/App": [{ number: 7, title: "seven", labels: l, body: "" }] });
};
const tracked = (id: string) => ctx.watchers.tracked().find((t) => t.watcher.id === id)!;
const firstChecks = async () => {
  for (let i = 0; i < 100 && !ctx.watchers.tracked().every((t) => t.status.lastTick); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
};
const call = async (who: TestSession, method: string, path: string, body?: unknown) => {
  const r = await fetch(base + path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...who.headers(method) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: () => r.text(), json: () => r.json() as Promise<any> };
};

describe("watchers move at server start", () => {
  it("without an admin account the watcher keeps running from config.yaml", async () => {
    issues();
    config(FILE);
    await start();
    expect(ctx.fileConfig().watchers.map((w) => w.id)).toEqual(["file-w"]);
    expect(logs.some((l) => l.includes("stay in config.yaml until there is an admin account"))).toBe(true);
    await firstChecks();
    expect(tracked("file-w").status.lastError).toBeUndefined();
    expect(tracked("file-w").issues.map((i) => i.issue)).toEqual([7]);
    expect(listRepoWatchers()).toEqual([]);
  });

  it("moves it, shows it on the Watchers page and still uses the host login", async () => {
    issues();
    await makeAdmin();
    config(FILE + "  - id: mon\n    source: monitor\n");
    await start();
    expect(ctx.fileConfig().watchers.map((w) => w.id)).toEqual(["mon"]);
    expect(listAllRepos().map((r) => [r.url, r.method])).toEqual([["https://github.com/Acme/App", "none"]]);
    const admin = await signInAs(base);
    const rows = (await (await call(admin, "GET", "/api/watchers")).json()) as { id: string; repoId?: string; github_repo: string }[];
    expect(rows.find((r) => r.id === "file-w")).toMatchObject({ repoId: listAllRepos()[0]!.id, github_repo: "Acme/App" });
    await firstChecks();
    auth.clear();
    expect((await call(admin, "POST", "/api/watchers/file-w/tick", {})).status).toBe(200);
    expect(auth.rows().length).toBeGreaterThan(0);
    expect(auth.rows().every((r) => r.token === "host-token" && r.githubToken === "host-github" && r.configDir === "host")).toBe(true);
  });

  it("an existing status comment is edited after the move, not posted again", async () => {
    issues();
    process.env.FAKE_GH_COMMENTS_BY_ISSUE = JSON.stringify({
      "Acme/App#7": { comments: [{ author: { login: "bot" }, body: `old text\n\n${STATUS_MARKER}`, createdAt: "2026-01-01T00:00:00Z", url: "https://github.com/Acme/App/issues/7#issuecomment-42", viewerDidAuthor: true }] },
    });
    await makeAdmin();
    config(FILE);
    await start();
    await firstChecks();
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["file-w"]);
    expect(gh.statusEdits().map((e) => e.id)).toEqual(["42"]);
    expect(gh.statusComments()).toEqual([]);
  });

  it("a run of the old name still belongs to the watcher after the move; its status label fits, so no new run starts", async () => {
    issues();
    process.env.FAKE_GH_ISSUES_BY_REPO = JSON.stringify({ "Acme/App": [{ number: 7, title: "seven", labels: [{ name: "claude-factory" }, { name: "factory:failed" }], body: "" }] });
    const runs = join(gh.tmp, "runs");
    const dir = join(runs, "20260101-000000-aaaa");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({
        runId: "20260101-000000-aaaa", flow: "issue-gitflow", flowDef: { name: "issue-gitflow", steps: [] }, task: "t", vars: { github_repo: "Acme/App", issue: "7" }, repo: gh.tmp,
        status: "failed", runDir: dir, startedAt: "2026-01-01T00:00:00Z", totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} },
      }),
    );
    await makeAdmin();
    config(FILE);
    await start();
    await firstChecks();
    expect(listRepoWatchers().map((w) => w.id)).toEqual(["file-w"]);
    expect(tracked("file-w").issues.find((i) => i.issue === 7)?.runId).toBe("20260101-000000-aaaa");
    expect(ctx.scheduler.queue().pending).toEqual([]);
  });
});

describe("PUT /api/config after the move", () => {
  it("refuses a new or changed watcher with a sentence about the Watchers page; the monitor and an unchanged leftover still save", async () => {
    config(FILE);
    await start(); // no admin yet: the watcher stays in the file
    const admin = await signInAs(base);
    const current = (await (await call(admin, "GET", "/api/config")).json()) as { watchers: Record<string, unknown>[] };
    const leftover = current.watchers.find((w) => w.id === "file-w")!;
    const put = (c: object) => call(admin, "PUT", "/api/config", c);

    const added = await put({ ...current, watchers: [leftover, { id: "new-w", github_repo: "acme/new" }] });
    expect(added.status).toBe(400);
    expect(await added.text()).toContain("Watchers page");
    const changed = await put({ ...current, watchers: [{ ...leftover, every: "1h" }] });
    expect(changed.status).toBe(400);
    expect(await changed.text()).toContain("Watchers page");
    expect((await put({ ...current, concurrency: 3, watchers: [leftover] })).status).toBe(200);
    expect((await put({ ...current, concurrency: 3, watchers: [leftover, { id: "mon", source: "monitor" }] })).status).toBe(200);
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toContain("mon");
  });

  it("versions the file: header on the three reads, 409 for a stale save, hand edits kept", async () => {
    const path = join(home, "config.yaml");
    const MON = "# my notes\nconcurrency: 2 # mine\nmonitor:\n  restart_loop:\n    resumes: 7\nwatchers:\n  - id: mon\n    source: monitor\n    every: 2h\n";
    config(MON);
    await start();
    const admin = await signInAs(base);
    const get = (p: string) => fetch(base + p, { headers: admin.headers("GET") });
    const put = (c: object, version?: string) =>
      fetch(base + "/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json", ...admin.headers("PUT"), ...(version ? { "x-config-version": version } : {}) },
        body: JSON.stringify(c),
      });
    const [a, b, m] = await Promise.all([get("/api/config"), get("/api/watchers"), get("/api/monitor")]);
    const v1 = a.headers.get("x-config-version")!;
    expect(v1).toBeTruthy();
    expect(b.headers.get("x-config-version")).toBe(v1);
    expect(m.headers.get("x-config-version")).toBe(v1);
    const current = (await a.json()) as Record<string, any>;

    const ok = await put({ ...current, concurrency: 3 }, v1);
    expect(ok.status).toBe(200);
    const v2 = ok.headers.get("x-config-version")!;
    expect(v2).not.toBe(v1);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("# my notes");
    expect(after).toContain("concurrency: 3 # mine");

    // another admin's save came first: the old version is refused and nothing is written
    const stale = await put({ ...current, concurrency: 4 }, v1);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toContain("reload first");
    expect(readFileSync(path, "utf8")).toBe(after);

    expect((await put({ ...current, concurrency: 5 })).status).toBe(200);

    // a hand edit
    const hand = readFileSync(path, "utf8").replace("resumes: 7", "resumes: 9").replace("every: 2h", "every: 3h");
    writeFileSync(path, hand);
    const edited = (await (await get("/api/config")).json()) as Record<string, any>;
    expect(edited.monitor.restart_loop.resumes).toBe(9);
    const w = await get("/api/watchers");
    const v3 = w.headers.get("x-config-version")!;
    expect(v3).not.toBe(v2);
    const mon = ((await w.json()) as any[]).find((x) => x.id === "mon");
    expect(mon.file.every).toBe("3h");
    expect(mon.every).not.toBe("3h");
    const det = (await (await get("/api/monitor")).json()) as { detectors: { key: string; thresholds?: Record<string, number> }[] };
    expect(det.detectors.find((d) => d.key === "restart_loop")?.thresholds?.resumes).toBe(9);
    expect((await put({ ...edited, concurrency: 6 }, v2)).status).toBe(409);
    expect((await put({ ...edited, concurrency: 6 }, v3)).status).toBe(200);
    const final = readFileSync(path, "utf8");
    expect(final).toContain("resumes: 9");
    expect(final).toContain("every: 3h");

    const before = readFileSync(path, "utf8");
    const bad = await put({ ...edited, audit: { retention_days: 0 } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain("retention_days");
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
