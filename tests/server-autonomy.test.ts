import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAuthLock } from "../src/auth/store.js";
import { randomUUID } from "node:crypto";
import { AUTONOMY_FILE, readAutonomy, setLevelLocked } from "../src/governance/autonomy-store.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let tmp: string;
let home: string;
let runsDir: string;
let close: () => void;
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let appId: string;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function writeRun(id: string, o: { repo: string; flow: string; status?: string; startedDaysAgo?: number; finishedDaysAgo?: number | null; runId?: string }) {
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify({
    runId: o.runId ?? id, flow: o.flow, task: "t", vars: { github_repo: o.repo }, repo: "", status: o.status ?? "succeeded", runDir: dir,
    startedAt: ago(o.startedDaysAgo ?? 3.01), ...(o.finishedDaysAgo === null ? {} : { finishedAt: ago(o.finishedDaysAgo ?? 3) }), totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} },
  }));
}

async function get(who: TestSession) {
  const r = await fetch(`${base}/api/autonomy`, { headers: who.headers("GET") });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) as any };
}
const component = (j: any, kind: string, name: string) => j.components.find((c: any) => c.kind === kind && c.name === name);

/** The names, sizes and times of the files under a folder. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort().map((f) => {
    const s = statSync(join(dir, f));
    return `${f}:${s.isFile() ? s.size : "dir"}:${s.mtimeMs}`;
  });
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "autonomy-api-"));
  home = join(tmp, "home");
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  const repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  // a flow whose file name differs from its declared name
  mkdirSync(join(repo, ".claude-factory", "flows"), { recursive: true });
  writeFileSync(join(repo, ".claude-factory", "flows", "build.yaml"), "name: delivery\nsteps:\n  - id: s\n    type: shell\n    run: echo hi\n");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  ({ close, base } = await startTestServer({ repo, runsDir, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  const r = await fetch(`${base}/api/repos`, { method: "POST", headers: { "content-type": "application/json", ...ann.headers("POST") }, body: JSON.stringify({ name: "acme/app" }) });
  expect(r.status).toBe(201);
  appId = ((await r.json()) as { id: string }).id;
  withAuthLock(() => {
    setLevelLocked("repos", appId, "guarded-write", "system:test");
    setLevelLocked("flows", "delivery", "plan-only", "system:test");
  });
  writeRun("a1", { repo: "acme/app", flow: "delivery" });
  // still running, started before the window: its policy decisions are not known
  writeRun("a2", { repo: "acme/app", flow: "delivery", status: "running", startedDaysAgo: 40, finishedDaysAgo: null });
  // a run.json that is not the run its folder names: it cannot be loaded
  writeRun("a3", { repo: "acme/app", flow: "delivery", runId: "not-a3" });
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/autonomy", () => {
  it("is for an admin only", async () => {
    expect((await get(ann)).status).toBe(403);
    expect((await get(admin)).status).toBe(200);
  });

  it("gives the levels, a gate for every repository and flow, and the next level", async () => {
    const j = (await get(admin)).json();
    expect(j.levels).toEqual(["observe", "plan-only", "guarded-write", "delivery-handoff"]);
    expect(j.window.days).toBe(30);
    expect(j.settings).toEqual({ min_runs: 10, evidence_completeness: 0.95, eval_pass_rate: 0.9, within_days: 30 });
    expect(j.problem).toBeUndefined();
    const app = component(j, "repos", "acme/app");
    expect(app).toMatchObject({ id: appId, level: "guarded-write", next: "delivery-handoff" });
    expect(app.gate.checks.map((c: any) => c.id)).toEqual(["evidence_completeness", "eval_pass_rate", "policy_conformance", "operational_slos", "approval"]);
    expect(app.gate.passed).toBe(false);
    // a flow without an entry is at the top level: no next level, and a gate for its own level
    const top = component(j, "flows", "issue-plan");
    expect(top).toMatchObject({ level: "delivery-handoff", next: null });
    expect(top.gate.checks).toHaveLength(5);
  });

  it("gives the level of the newest run of a repository, and none for a flow without runs", async () => {
    const j = (await get(admin)).json();
    // the test runs have no `autonomy` field: they read as delivery-handoff
    expect(component(j, "repos", "acme/app").newestRun).toMatchObject({ level: "delivery-handoff", runId: expect.any(String), startedAt: expect.any(String) });
    expect(component(j, "flows", "issue-plan").newestRun).toBeUndefined();
    expect(j.runsProblem).toBeUndefined();
  });

  it("names a flow by its declared name, not by its file name, and keeps a stored level", async () => {
    const j = (await get(admin)).json();
    expect(component(j, "flows", "delivery")).toMatchObject({ level: "plan-only", next: "guarded-write" });
    expect(component(j, "flows", "build")).toBeUndefined();
    expect(j.components.filter((c: any) => c.kind === "flows" && c.name === "delivery")).toHaveLength(1);
  });

  it("fails the checks for a run that is still open and for a run that cannot be loaded", async () => {
    const app = component((await get(admin)).json(), "repos", "acme/app");
    const by = (id: string) => app.gate.checks.find((c: any) => c.id === id);
    expect(by("policy_conformance")).toMatchObject({ passed: false });
    expect(by("policy_conformance").detail).toMatch(/could not be read/);
    expect(by("operational_slos")).toMatchObject({ passed: false });
    expect(by("operational_slos").detail).toContain("has not finished a check");
  });

  it("shows every level as observe, with a problem text, when autonomy.json cannot be read", async () => {
    writeFileSync(join(home, AUTONOMY_FILE), "{broken");
    try {
      const r = await get(admin);
      expect(r.status).toBe(200);
      const j = r.json();
      expect(j.problem).toContain("autonomy file could not be read");
      expect(new Set(j.components.map((c: any) => c.level))).toEqual(new Set(["observe"]));
      expect(component(j, "repos", "acme/app").next).toBe("plan-only");
    } finally {
      rmSync(join(home, AUTONOMY_FILE), { force: true });
      withAuthLock(() => {
        setLevelLocked("repos", appId, "guarded-write", "system:test");
        setLevelLocked("flows", "delivery", "plan-only", "system:test");
      });
    }
  });

  it("holds no path of this machine and changes no file", async () => {
    const before = [...snapshot(home), ...snapshot(runsDir)];
    const r = await get(admin);
    expect(r.text).not.toContain(tmp);
    expect(r.text).not.toContain(home);
    expect(r.text).not.toMatch(/\/Users\/|\/home\/|\/tmp\//);
    expect([...snapshot(home), ...snapshot(runsDir)]).toEqual(before);
    expect(readFileSync(join(home, AUTONOMY_FILE), "utf8")).toContain("guarded-write");
  });
});

// The success paths of promote and approve are unit tests (autonomy-change.test.ts, with a fake gate): the real gate cannot pass here.
describe("POST /api/autonomy/promote|approve|demote", () => {
  const post = async (who: TestSession, act: string, body: unknown) => {
    const r = await fetch(`${base}/api/autonomy/${act}`, { method: "POST", headers: { "content-type": "application/json", ...who.headers("POST") }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) as any };
  };
  const flow = { kind: "flows", id: "delivery", reason: "ready" };

  it("refuses a user on all three routes", async () => {
    for (const act of ["promote", "approve", "demote"]) expect((await post(ann, act, { ...flow, to: "observe", token: randomUUID() })).status).toBe(403);
  });

  it("refuses a promotion whose real gate fails, and stores nothing", async () => {
    const r = await post(admin, "promote", { ...flow, to: "guarded-write" });
    expect(r.status).toBe(409);
    expect(r.json().gate.passed).toBe(false);
    expect(readAutonomy().requests).toBeUndefined();
    expect((await post(admin, "promote", { ...flow, id: "nope", to: "guarded-write" })).status).toBe(404);
    expect((await post(admin, "approve", { ...flow, to: "guarded-write", token: randomUUID() })).status).toBe(409);
  });

  it("shows the owner and the request in the status, and holds no path", async () => {
    const stored = readAutonomy();
    const token = randomUUID();
    withAuthLock(() => writeFileSync(join(home, AUTONOMY_FILE), JSON.stringify({ ...stored, requests: { repos: {}, flows: { delivery: { token, from: "plan-only", to: "guarded-write", reason: "ready", by: admin.user.id, at: new Date().toISOString(), state: "pending" } } } })));
    try {
      const r = await get(admin);
      const j = r.json();
      expect(j.owner).toEqual({ id: admin.user.id, source: "first-admin" });
      expect(component(j, "flows", "delivery").request).toMatchObject({ token, state: "pending" });
      // the requester is the owner and the only admin: the owner approves, marked as self-approved
      expect(j.ownerName).toBe(admin.user.name);
      expect(component(j, "flows", "delivery").approval).toEqual({
        requester: { id: admin.user.id, name: admin.user.name },
        approvers: [{ id: admin.user.id, name: admin.user.name, selfApproved: true }],
        mayApprove: true,
      });
      expect(component(j, "repos", "acme/app").approval).toBeUndefined();
      expect(component(j, "flows", "delivery").gate.checks.find((c: any) => c.id === "approval")).toMatchObject({ value: "pending", detail: expect.stringContaining("waits") });
      expect(r.text).not.toContain(home);
    } finally {
      withAuthLock(() => writeFileSync(join(home, AUTONOMY_FILE), JSON.stringify(stored)));
    }
  });

  it("demotes at once for an admin, and the status shows the new level", async () => {
    const r = await post(admin, "demote", { ...flow, to: "observe" });
    expect(r.status).toBe(200);
    expect(r.json()).toMatchObject({ from: "plan-only", to: "observe", level: "observe" });
    expect(r.text).not.toContain(home);
    expect(component((await get(admin)).json(), "flows", "delivery")).toMatchObject({ level: "observe", next: "plan-only" });
    expect((await post(admin, "demote", { ...flow, to: "observe" })).status).toBe(409);
    expect((await post(admin, "demote", { ...flow, to: "observe", reason: "" })).status).toBe(400);
  });
});

describe("newestRunOf", () => {
  const brief = (over: Record<string, unknown>): any => ({ runId: "r", flow: "delivery", status: "succeeded", startedAt: "2026-10-01T00:00:00.000Z", runDir: "", dirName: "r", updatedAt: "", ...over });
  let newestRunOf: (b: any[], s: { repo?: string; flow?: string }) => any;
  beforeAll(async () => {
    ({ newestRunOf } = await import("../src/server/api-autonomy.js"));
  });

  it("matches a repository name in any case, and a flow", () => {
    const b = [
      brief({ runId: "old", githubRepo: "Acme/App", startedAt: "2026-10-01T00:00:00.000Z", autonomy: { level: "observe", flow: "observe" } }),
      brief({ runId: "new", githubRepo: "acme/app", startedAt: "2026-10-02T00:00:00.000Z", autonomy: { level: "plan-only", flow: "plan-only" } }),
      brief({ runId: "other", flow: "feature", startedAt: "2026-10-03T00:00:00.000Z" }),
    ];
    expect(newestRunOf(b, { repo: "ACME/app" })).toEqual({ runId: "new", level: "plan-only", startedAt: "2026-10-02T00:00:00.000Z" });
    expect(newestRunOf(b, { flow: "feature" })).toMatchObject({ runId: "other" });
    expect(newestRunOf(b, { repo: "acme/none" })).toBeUndefined();
    expect(newestRunOf(b, {})).toBeUndefined();
  });

  it("reads a run with no field as delivery-handoff and a bad field as observe", () => {
    expect(newestRunOf([brief({ githubRepo: "a/b" })], { repo: "a/b" })?.level).toBe("delivery-handoff");
    expect(newestRunOf([brief({ githubRepo: "a/b", autonomy: { level: "root" } })], { repo: "a/b" })?.level).toBe("observe");
  });

  it("skips refinement and local-test runs", () => {
    const b = [
      brief({ runId: "real", githubRepo: "a/b", startedAt: "2026-10-01T00:00:00.000Z" }),
      brief({ runId: "local", githubRepo: "a/b", startedAt: "2026-10-05T00:00:00.000Z", localTest: true }),
      brief({ runId: "refine", githubRepo: "a/b", startedAt: "2026-10-06T00:00:00.000Z", source: "refinement session" }),
    ];
    expect(newestRunOf(b, { repo: "a/b" })?.runId).toBe("real");
  });
});

describe("GET /api/autonomy/history", () => {
  const history = async (who: TestSession, query = "") => {
    const r = await fetch(`${base}/api/autonomy/history${query}`, { headers: who.headers("GET") });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) as any };
  };

  it("is for an admin only, and gives only autonomy lines without a path", async () => {
    const { writeAudit } = await import("../src/auth/audit.js");
    writeAudit(admin.user.id, { action: "autonomy-demote", result: "ok", target: "flows:history-a", detail: "plan-only→observe reason: x" });
    writeAudit(admin.user.id, { action: "settings-change", result: "ok", target: "settings", detail: "x" });
    writeAudit(admin.user.id, { action: "autonomy-promote", result: "ok", target: "flows:history-a", detail: "observe→plan-only" });
    expect((await history(ann)).status).toBe(403);
    const r = await history(admin);
    expect(r.status).toBe(200);
    const j = r.json();
    expect(j.more).toBe(false);
    expect(j.entries.length).toBeGreaterThan(0);
    expect(j.entries.every((e: any) => e.action.startsWith("autonomy-"))).toBe(true);
    expect(j.entries.filter((e: any) => e.target?.text === "flows:history-a").map((e: any) => e.action)).toEqual(["autonomy-promote", "autonomy-demote"]);
    expect(r.text).not.toContain(home);
  });

  it("reads a quiet component in full when more than 500 lines exist, and says that it cut", async () => {
    const { appendAuditLocked } = await import("../src/auth/audit.js");
    withAuthLock(() => {
      appendAuditLocked(admin.user.id, { action: "autonomy-demote", result: "ok", target: "flows:quiet", detail: "first" });
      for (let i = 0; i < 502; i++) appendAuditLocked(admin.user.id, { action: "autonomy-demote", result: "ok", target: "flows:noisy", detail: `n${i}` });
    });
    const all = (await history(admin)).json();
    expect(all.more).toBe(true);
    expect(all.entries).toHaveLength(500);
    expect(all.entries.some((e: any) => e.target?.text === "flows:quiet")).toBe(false);
    const one = (await history(admin, "?target=flows%3Aquiet")).json();
    expect(one.more).toBe(false);
    expect(one.entries.map((e: any) => e.detail)).toEqual(["first"]);
    expect((await history(admin, "?target=anything")).status).toBe(400);
  });

  it("reads a flow whose name has a space or a colon, the way the store allows it", async () => {
    const { writeAudit } = await import("../src/auth/audit.js");
    writeAudit(admin.user.id, { action: "autonomy-promote", result: "ok", target: "flows:Release delivery", detail: "observe→plan-only" });
    writeAudit(admin.user.id, { action: "autonomy-demote", result: "ok", target: "flows:a:b", detail: "plan-only→observe" });
    const spaced = (await history(admin, `?target=${encodeURIComponent("flows:Release delivery")}`)).json();
    expect(spaced.entries.map((e: any) => e.target.text)).toEqual(["flows:Release delivery"]);
    const colon = (await history(admin, `?target=${encodeURIComponent("flows:a:b")}`)).json();
    expect(colon.entries.map((e: any) => e.target.text)).toEqual(["flows:a:b"]);
    expect((await history(admin, `?target=${encodeURIComponent("flows: lead")}`)).status).toBe(400);
    expect((await history(admin, `?target=${encodeURIComponent("repos:not-a-uuid")}`)).status).toBe(400);
  });
});
