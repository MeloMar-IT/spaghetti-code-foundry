import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { runFile, saveRun, type RunSummary } from "../src/engine/state.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { startTestServer } from "./helpers/port.js";
import { signInAs, type TestSession } from "./helpers/session.js";

let base: string;
let tmp: string;
let runs: string;
let close: () => void;
let kc: FakeKeychain;
let saved: string | undefined;
let admin: TestSession;
let ann: TestSession;
let bob: TestSession;
let annRepo: string;

const sha = (c: string) => c.repeat(40);
const step = (id: string, output: string, startedAt: string) => ({ id, type: "shell", visit: 1, ok: true, output, startedAt, durationMs: 1000, logFile: "x" });
function plant(id: string, owner: string, commit: string, at: string, over: Partial<RunSummary> = {}) {
  const runDir = join(runs, id);
  mkdirSync(runDir, { recursive: true });
  saveRun({
    runId: id, flow: "issue-gitflow", task: "t", vars: { github_repo: "acme/app", develop_branch: "develop", issue: "5" }, repo: "/x", status: "succeeded", owner, source: "ui",
    runDir, startedAt: at, finishedAt: at, totalCostUsd: 0, flowDef: { name: "issue-gitflow", steps: [] }, state: { next: null, steps: {}, visits: {} },
    history: [step("pull_ticket", `# #5: Title ${id}`, at), step("push_develop", `COMMIT: ${commit}`, at)], ...over,
  } as unknown as RunSummary);
}

beforeAll(async () => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "api-safe-"));
  process.env.FACTORY_HOME = join(tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  runs = join(tmp, "runs");
  mkdirSync(runs, { recursive: true });
  kc = fakeKeychain();
  ({ close, base } = await startTestServer({ repo: tmp, runsDir: runs, claudeBin: resolve("tests/fixtures/fake-claude.mjs"), watchers: false }));
  admin = await signInAs(base);
  ann = await signInAs(base, { name: "Ann", email: "ann@example.com", role: "user" });
  bob = await signInAs(base, { name: "Bob", email: "bob@example.com", role: "user" });
  annRepo = addRepo(ann.user.id, { url: "acme/app" }).id;
});
afterAll(async () => {
  close();
  await new Promise((r) => setTimeout(r, 300));
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

async function get(who: TestSession, path: string) {
  const r = await fetch(base + path, { headers: who.headers("GET") });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
}

describe("GET repos/:id/safe-points", () => {
  it("lists develop commits newest first, with who started them", async () => {
    plant("r-old", ann.user.id, sha("a"), "2026-11-01T10:00:00.000Z");
    plant("r-new", bob.user.id, sha("b"), "2026-11-02T10:00:00.000Z");
    const r = await get(ann, `/api/repos/${annRepo}/safe-points`);
    expect(r.status).toBe(200);
    const a = r.json();
    expect(a).toMatchObject({ branch: "develop", gitflow: true, complete: true });
    expect(a.points.map((p: { commit: string }) => p.commit)).toEqual([sha("b"), sha("a")]);
    expect(a.points[0].by).toEqual({ kind: "person" });
  });
  it("sees a new run on the next request", async () => {
    plant("r-newer", ann.user.id, sha("c"), "2026-11-03T10:00:00.000Z");
    const a = (await get(ann, `/api/repos/${annRepo}/safe-points`)).json();
    expect(a.points[0]).toMatchObject({ commit: sha("c"), short: "ccccccc", by: { kind: "you" }, changes: [{ issue: 5, title: "Title r-newer" }] });
    expect(a.points.map((p: { commit: string }) => p.commit)).toEqual([sha("c"), sha("b"), sha("a")]);
  });
  it("refuses another account and an unknown id, and lets an admin read", async () => {
    expect((await get(bob, `/api/repos/${annRepo}/safe-points`)).status).toBe(404);
    expect((await get(ann, "/api/repos/00000000-0000-4000-8000-000000000000/safe-points")).status).toBe(404);
    const r = await get(admin, `/api/repos/${annRepo}/safe-points`);
    expect(r.status).toBe(200);
    expect(r.json().points).toHaveLength(3);
  });
  it("shows a user no account id and no name", async () => {
    const r = await get(ann, `/api/repos/${annRepo}/safe-points`);
    expect(r.text).not.toContain(ann.user.id);
    expect(r.text).not.toContain(bob.user.id);
    expect(r.text).not.toContain("Bob");
  });
});

describe("a project without gitflow", () => {
  it("lists release builds and clean base checks of the main branch, and nothing of another branch", async () => {
    const id = addRepo(ann.user.id, { url: "acme/rel" }).id;
    const at = "2026-11-04T10:00:00.000Z";
    const vars = { github_repo: "acme/rel" };
    plant("rb-1", ann.user.id, "", at, { flow: "release-build", vars: { ...vars, ref: "main" }, outputs: { release_tag: "v1.2" }, history: [] });
    mkdirSync(join(runs, "rb-1", "release"), { recursive: true });
    writeFileSync(join(runs, "rb-1", "release", "plan.json"), JSON.stringify({ sha: sha("d"), changes: ["Merge #9: Nine (feature/9)"] }));
    plant("rb-2", ann.user.id, "", at, { flow: "release-build", vars: { ...vars, ref: "other" }, outputs: { release_tag: "v9" }, history: [] });
    plant("bg-1", ann.user.id, "", "2026-11-05T10:00:00.000Z", { vars: { ...vars, issue: "3" }, history: [step("baseline_tests", `BASE_GREEN: main ${sha("e")} 2026-11-05T09:00:00Z`, at)] } as Partial<RunSummary>);
    const a = (await get(ann, `/api/repos/${id}/safe-points`)).json();
    expect(a).toMatchObject({ branch: "main", gitflow: false, complete: true });
    expect(a.points.map((p: { commit: string }) => p.commit)).toEqual([sha("e"), sha("d")]);
    expect(a.points[1]).toMatchObject({ release: true, tag: "v1.2", changes: [{ issue: 9, title: "Nine" }] });
  });
});

describe("the newest push is found whatever the run's name", () => {
  it("finds a point pushed today by a run whose name sorts last, behind 60 runs with no points", async () => {
    const id = addRepo(ann.user.id, { url: "acme/late" }).id;
    const day = 86_400_000;
    const now = Date.now();
    const write = (runId: string, commit: string | undefined, ageMs: number) => {
      const runDir = join(runs, runId);
      mkdirSync(runDir, { recursive: true });
      const at = new Date(now - ageMs).toISOString();
      saveRun({
        runId, flow: "issue-gitflow", task: "t", vars: { github_repo: "acme/late", develop_branch: "develop", issue: "8" }, repo: "/x", status: "succeeded", owner: ann.user.id,
        source: "ui", runDir, startedAt: at, finishedAt: at, totalCostUsd: 0, flowDef: { name: "issue-gitflow", steps: [] }, state: { next: null, steps: {}, visits: {} },
        history: commit ? [step("push_develop", `COMMIT: ${commit}`, at)] : [],
      } as unknown as RunSummary);
      const t = new Date(now - ageMs);
      utimesSync(runFile(runDir), t, t);
    };
    // the fillers are written a while ago; the run that sorts last by name pushed most recently
    for (let i = 0; i < 60; i++) write(`a-filler-${String(i).padStart(2, "0")}`, undefined, 3 * day + i * 1000);
    write("z-late", sha("9"), 0);
    const a = (await get(ann, `/api/repos/${id}/safe-points`)).json();
    expect(a.points[0]).toMatchObject({ commit: sha("9"), by: { kind: "you" } });
    expect(a.complete).toBe(true);
  });
});
