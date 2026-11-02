import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAuthLock } from "../src/auth/store.js";
import { AUTONOMY_FILE, setLevelLocked } from "../src/governance/autonomy-store.js";
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
