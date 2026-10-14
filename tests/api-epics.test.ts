import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { dropForecasts, epicForecastsDir, forecastHistory } from "../src/epics/forecast-store.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { saveIssueList, type IssueRecord } from "../src/queue/issue-list.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let tmp: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startTestServer>>["ctx"];
let kc: FakeKeychain;
let gh: ReturnType<typeof fakeGithub>;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let annRepo: string;
let bareRepo: string;
const logs: string[] = [];

const rec = (number: number, over: Partial<IssueRecord> = {}): IssueRecord => ({
  number, title: `Story ${number}`, state: "open", labels: ["claude-factory"], createdAt: "2026-10-01T12:00:00Z", dependsOn: [], ...over,
});
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  gh = fakeGithub();
  tmp = mkdtempSync(join(tmpdir(), "api-epics-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  ({ close, ctx, base } = await startTestServer({ repo: tmp, runsDir: join(tmp, "runs"), claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, log: (m) => void logs.push(m) }));
  ctx.scheduler.drain();
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  annRepo = addRepo(ann.user.id, { url: "acme/app", method: "github-token", token: TOKEN }).id;
  bareRepo = addRepo(ann.user.id, { url: "acme/bare" }).id;
  // A watcher of the test home's config.yaml; reloading the settings does not start it, so nothing polls GitHub.
  saveConfig({ ...loadConfig(), watchers: [{ id: "app-w", github_repo: "acme/app", enabled: true }] });
  ctx.reloadConfig();
  expect(ctx.config().watchers.map((w) => w.github_repo)).toEqual(["acme/app"]);
  const now = Date.now(), d = (n: number) => new Date(now - n * 86_400_000).toISOString();
  saveIssueList("acme/app", [
    rec(1, { title: "Epic", stories: [2, 3, 4], createdAt: d(10) }),
    rec(2, { epic: 1, state: "closed", closedAt: d(1), createdAt: d(10) }),
    rec(3, { epic: 1, createdAt: d(10) }), rec(4, { epic: 1, createdAt: d(10), dependsOn: [3] }),
    rec(5, { epicLabel: { name: "Area 51/50%" }, createdAt: d(10) }),
    ...[6, 7, 8, 9].map((n) => rec(n, { state: "closed", closedAt: d(n - 5), createdAt: d(10) })),
  ], new Date(now - 3_600_000), false);
});
afterAll(async () => {
  close();
  await new Promise((r) => setTimeout(r, 300));
  kc.remove();
  gh.restore();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function get(who: TestSession, path: string) {
  const r = await fetch(base + path, { headers: who.headers("GET") });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}

describe("GET repos/:id/epics", () => {
  it("lists the epics of the owner, and an admin sees them too", async () => {
    const r = await get(ann, `/api/repos/${annRepo}/epics`);
    expect(r.status).toBe(200);
    const a = r.json();
    expect(a.data).toMatchObject({ state: "fresh", cut: false });
    expect(a.epics.map((e: { key: string }) => e.key).sort()).toEqual(["#1", "label:area 51/50%"]);
    expect(a.noEpic).toBeDefined();
    expect((await get(admin, `/api/repos/${annRepo}/epics`)).status).toBe(200);
  });

  it("refuses another account and an unknown repository", async () => {
    expect((await get(bob, `/api/repos/${annRepo}/epics`)).status).toBe(404);
    expect((await get(bob, `/api/repos/${annRepo}/epics/1`)).status).toBe(404);
    expect((await get(ann, "/api/repos/00000000-0000-4000-8000-000000000000/epics")).status).toBe(404);
  });

  it("says no data for a repository without a watcher", async () => {
    const a = (await get(ann, `/api/repos/${bareRepo}/epics`)).json();
    expect(a.data).toMatchObject({ state: "no-data", why: "no-watcher" });
    expect(a.epics).toEqual([]);
  });

  it("saves the day's forecast once", async () => {
    await get(ann, `/api/repos/${annRepo}/epics`);
    const first = forecastHistory("acme/app", "#1");
    expect(first).toHaveLength(1);
    await get(ann, `/api/repos/${annRepo}/epics`);
    await get(ann, `/api/repos/${annRepo}/epics/1`);
    expect(forecastHistory("acme/app", "#1")).toEqual(first);
    expect((await get(ann, `/api/repos/${annRepo}/epics/1`)).json().history).toEqual(first);
  });

  it("shows the history that is stored when two requests race", async () => {
    dropForecasts("acme/app");
    const [a, b] = await Promise.all([get(ann, `/api/repos/${annRepo}/epics/1`), get(ann, `/api/repos/${annRepo}/epics/1`)]);
    const stored = forecastHistory("acme/app", "#1");
    expect(stored).toHaveLength(1);
    expect(a.json().history).toEqual(stored);
    expect(b.json().history).toEqual(stored);
  });

  it("answers without today's day when the save fails", async () => {
    dropForecasts("acme/app");
    mkdirSync(epicForecastsDir(), { recursive: true });
    const lock = join(epicForecastsDir(), `${encodeURIComponent("acme/app")}.json.lock`);
    writeFileSync(lock, "");
    try {
      const r = await get(ann, `/api/repos/${annRepo}/epics/1`);
      expect(r.status).toBe(200);
      expect(r.json().history).toEqual([]);
    } finally {
      rmSync(lock, { force: true });
    }
    expect(forecastHistory("acme/app", "#1")).toEqual([]);
    expect((await get(ann, `/api/repos/${annRepo}/epics/1`)).json().history).toHaveLength(1);
  });
});

describe("GET repos/:id/epics/:issue", () => {
  it("gives one epic with its stories, chains and history", async () => {
    const r = await get(ann, `/api/repos/${annRepo}/epics/1`);
    expect(r.status).toBe(200);
    const a = r.json();
    expect(a.epic.key).toBe("#1");
    expect(a.stories.map((s: { issue: number }) => s.issue)).toEqual(a.chains.order);
    expect(a.pace.days).toHaveLength(14);
    expect(a.history.length).toBeGreaterThan(0);
  });

  it("finds a label epic by the id of the list, even with a slash in its name", async () => {
    const list = (await get(ann, `/api/repos/${annRepo}/epics`)).json();
    const label = list.epics.find((e: { key: string }) => e.key.startsWith("label:"));
    const r = await get(ann, `/api/repos/${annRepo}/epics/${encodeURIComponent(label.id)}`);
    expect(r.status).toBe(200);
    expect(r.json().stories.map((s: { issue: number }) => s.issue)).toEqual([5]);
  });

  it("answers 404 for an unknown epic and 400 for a bad id", async () => {
    expect((await get(ann, `/api/repos/${annRepo}/epics/999`)).status).toBe(404);
    expect((await get(ann, `/api/repos/${annRepo}/epics/abc`)).status).toBe(400);
  });
});

describe("no call to GitHub", () => {
  it("leaves the fake gh log empty", () => {
    expect(gh.ghLog()).toBe("");
  });
});
