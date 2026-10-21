import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureChain } from "./fixtures/evidence-runs.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let tmp: string;
let runsDir: string;
let close: () => void;
let ctx: Awaited<ReturnType<typeof startTestServer>>["ctx"];
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const opus = { agent: "claude", provider: "anthropic", model: "opus" };
const decision = { policy: { id: "baseline", version: "1" }, boundary: "push", mode: "enforce", outcome: "allow", reasonCode: "policy.no-rule-matched", version: 1, packSha256: "a".repeat(64), inputSha256: "b".repeat(64), evaluatedAt: ago(3) };
const step = { id: "code", visit: 1, type: "claude" };

/** A run folder with a run.json, and the evidence of a run that routed a model and passed a policy when `evidence` is set. */
function writeRun(id: string, o: { owner?: string; repo: string; evidence?: boolean; finishedDaysAgo?: number; status?: string }) {
  const dir = join(runsDir, id);
  mkdirSync(dir, { recursive: true });
  const finished = ago(o.finishedDaysAgo ?? 3);
  writeFileSync(join(dir, "run.json"), JSON.stringify({
    runId: id, flow: "build", task: "t", vars: { github_repo: o.repo }, repo: "", status: o.status ?? "succeeded", runDir: dir,
    startedAt: ago((o.finishedDaysAgo ?? 3) + 0.01), finishedAt: finished, totalCostUsd: 1.5, history: [], state: { next: null, steps: {}, visits: {} },
    ...(o.owner ? { owner: o.owner } : {}),
  }));
  if (o.evidence) {
    const { lines } = fixtureChain([
      { type: "run.created", time: ago(3.01), flow: { name: "build" }, by: { kind: "cli" } },
      { type: "step.routed", time: ago(3.005), step, model: opus },
      { type: "policy.decided", time: ago(3.004), decision, step },
    ], id);
    writeFileSync(join(dir, "evidence.jsonl"), lines.map((l) => `${l}\n`).join(""));
  }
}

async function get(who: TestSession, query = "", as?: string) {
  const q = [query, as ? `as=${as}` : ""].filter(Boolean).join("&");
  const r = await fetch(`${base}/api/outcomes${q ? `?${q}` : ""}`, { headers: who.headers("GET") });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) as any };
}

async function post(who: TestSession, path: string, body: unknown) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...who.headers("POST") }, body: JSON.stringify(body) });
}

const counted = (j: any, id = "resume_count"): number => j.measures.find((m: any) => m.id === id).counted;

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "outcomes-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  kc = fakeKeychain();
  const repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "init");
  ({ close, ctx, base } = await startTestServer({ repo, runsDir, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false, viewAsClock: () => Date.now() }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  expect((await post(ann, "/api/repos", { name: "acme/app" })).status).toBe(201);
  const old = await post(ann, "/api/repos", { name: "acme/old" });
  expect(old.status).toBe(201);
  const oldId = ((await old.json()) as { id: string }).id;
  expect((await fetch(`${base}/api/repos/${oldId}`, { method: "DELETE", headers: ann.headers("DELETE") })).status).toBeLessThan(300);
  expect((await post(bob, "/api/repos", { name: "bob/tool" })).status).toBe(201);
  writeRun("a1", { owner: ann.user.id, repo: "acme/app", evidence: true });
  writeRun("a2", { owner: ann.user.id, repo: "acme/old" });
  writeRun("b1", { owner: bob.user.id, repo: "bob/tool" });
  writeRun("b2", { owner: bob.user.id, repo: "acme/app" });
  writeRun("x1", { repo: "other/thing" });
});
afterAll(() => {
  close();
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

describe("GET /api/outcomes", () => {
  it("shows an admin every run, with all values, measures and definitions", async () => {
    const r = await get(admin);
    expect(r.status).toBe(200);
    const j = r.json();
    expect(j.window.days).toBe(30);
    expect(Date.parse(j.window.to) - Date.parse(j.window.from)).toBe(30 * DAY);
    expect(j.filters).toEqual({ days: 30 });
    expect(j.values.repos).toEqual(["acme/app", "acme/old", "bob/tool", "other/thing"]);
    expect(j.values.flows).toEqual(["build"]);
    expect(j.values.models).toEqual(["claude:anthropic:opus"]);
    expect(j.values.policies).toEqual(["baseline@1"]);
    expect(j.measures).toHaveLength(10);
    expect(j.definitions).toHaveLength(10);
    expect(counted(j)).toBe(5);
  });

  it("narrows an admin's view by model and by policy", async () => {
    expect(counted((await get(admin, "model=claude:anthropic:opus")).json())).toBe(1);
    expect(counted((await get(admin, "model=claude:anthropic:haiku")).json())).toBe(0);
    expect(counted((await get(admin, "policy=baseline@1")).json())).toBe(1);
    expect(counted((await get(admin, "policy=baseline@9")).json())).toBe(0);
    expect((await get(admin, "model=claude:anthropic:opus")).json().filters).toEqual({ days: 30, model: "claude:anthropic:opus" });
  });

  it("narrows by repository, flow and days", async () => {
    expect(counted((await get(admin, "repo=ACME/app")).json())).toBe(2);
    expect(counted((await get(admin, "flow=nothing")).json())).toBe(0);
    expect(counted((await get(admin, "days=1")).json())).toBe(0);
  });

  it("shows a user only their own runs on their repositories, without cost, returning users, models or policies", async () => {
    const r = await get(ann);
    expect(r.status).toBe(200);
    const j = r.json();
    expect(counted(j)).toBe(1);
    expect(j.values).toEqual({ repos: ["acme/app"], flows: ["build"] });
    expect(j.measures.map((m: any) => m.id)).not.toContain("cost_per_successful_run");
    expect(j.measures.map((m: any) => m.id)).not.toContain("returning_users");
    expect(j.definitions).toHaveLength(8);
    expect(r.text).not.toContain("costUsd");
  });

  it("does not show Bob the run of his that is on a repository he does not have", async () => {
    const j = (await get(bob)).json();
    expect(counted(j)).toBe(1);
    expect(j.values.repos).toEqual(["bob/tool"]);
  });

  it("answers 400 before 403 for a user, and 403 for a good model or policy", async () => {
    expect((await get(ann, "model=claude:anthropic:opus")).status).toBe(403);
    expect((await get(ann, "policy=baseline@1")).status).toBe(403);
    expect((await get(ann, "model=bad")).status).toBe(400);
    expect((await get(ann, "model=bad&policy=baseline@1")).status).toBe(400);
    expect((await get(ann, "days=0")).status).toBe(400);
    expect((await get(admin, "days=91")).status).toBe(400);
    expect((await get(admin, "policy=nope")).status).toBe(400);
    expect((await get(admin, "repo=")).json().error).toBe("invalid repo");
  });

  it("answers an admin in view-as like the user, and 403 for a model", async () => {
    expect((await post(admin, "/api/admin/view-as", { userId: ann.user.id })).status).toBeLessThan(300);
    const own = (await get(ann)).json();
    const viewed = await get(admin, "", ann.user.id);
    expect(viewed.status).toBe(200);
    const strip = (j: any) => ({ ...j, window: undefined });
    expect(strip(viewed.json())).toEqual(strip(own));
    expect((await get(admin, "model=claude:anthropic:opus", ann.user.id)).status).toBe(403);
  });

  it("keeps answering other requests while it works", async () => {
    const [a, h] = await Promise.all([get(admin), fetch(`${base}/api/health`, { headers: admin.headers("GET") })]);
    expect(a.status).toBe(200);
    expect(h.status).toBe(200);
  });

  it("Scheduler.getAsync marks a running run.json with no process as interrupted, like get", async () => {
    const dir = join(runsDir, "stale1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.json"), JSON.stringify({ runId: "stale1", flow: "build", status: "running", runDir: dir, startedAt: ago(1), vars: {}, history: [], state: { next: null, steps: {}, visits: {} } }));
    const a = await ctx.scheduler.getAsync("stale1");
    const s = ctx.scheduler.get("stale1");
    expect(a?.status).toBe("failed");
    expect(a?.finishedAt).toBeTruthy();
    expect(a).toEqual(s);
    expect(await ctx.scheduler.getAsync("nope")).toBeUndefined();
  });
});
