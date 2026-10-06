import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listAllRepos } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { STATUS_MARKER } from "../src/github.js";
import { listRepoWatchers } from "../src/repos/watchers.js";
import { startServer } from "../src/server/server.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain } from "./helpers/keychain.js";
import { signInAs, TEST_PASSWORD, type TestSession } from "./helpers/session.js";

let gh: ReturnType<typeof fakeGithub>;
let auth: ReturnType<ReturnType<typeof fakeGithub>["authLog"]>;
let home: string;
let saved: string | undefined;
let kc: ReturnType<typeof fakeKeychain>;
let close: (() => void) | undefined;
let ctx: Awaited<ReturnType<typeof startServer>>["ctx"];
let logs: string[];
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;

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
  ({ close, ctx } = await startServer({ repo: gh.tmp, runsDir: join(gh.tmp, "runs"), port, claudeBin, watcherRetryMs: 50, log: (m) => void logs.push(m) }));
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
});
