import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { MAX_SAFE_CHANGES, MAX_SAFE_POINTS, mergedChanges, releasePlan, safePoints, safeSourcesOf, startedBy, type SafeSource } from "../src/safe-points.js";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const step = (id: string, output: string, over: Record<string, unknown> = {}) => ({ id, type: "shell", visit: 1, ok: true, output, startedAt: "2026-11-01T10:00:00.000Z", durationMs: 60_000, logFile: "x", ...over });
const run = (over: Record<string, unknown> = {}): RunSummary => ({
  runId: "r1", flow: "issue-gitflow", task: "Do it\nmore", vars: { github_repo: "acme/app", develop_branch: "develop", issue: "7" }, repo: "/x", status: "succeeded",
  runDir: "/nope", startedAt: "2026-11-01T10:00:00.000Z", finishedAt: "2026-11-01T10:05:00.000Z", history: [], ...over,
}) as unknown as RunSummary;
const o = { mainBranch: "main" };
const viewer = { id: "u1", admin: false };
const names = () => new Map([["u2", "Bea"]]);

describe("safeSourcesOf", () => {
  it("reads a develop push, with the title and the issue number", () => {
    const r = run({ history: [step("pull_ticket", "# #7: Fix the thing"), step("push_develop", `ok\nCOMMIT: ${A}\n`)] });
    expect(safeSourcesOf(r, o)).toMatchObject([{ commit: A, branch: "develop", role: "develop", at: "2026-11-01T10:01:00.000Z", changes: [{ issue: 7, title: "Fix the thing" }] }]);
    // a sub-flow step counts too
    expect(safeSourcesOf(run({ history: [step("build/push_develop", `COMMIT: ${A}`)] }), o)[0]?.changes).toEqual([{ issue: 7, title: "Do it" }]);
  });
  it("ignores a failed step, a short commit and a run that did not succeed", () => {
    expect(safeSourcesOf(run({ history: [step("push_develop", `COMMIT: ${A}`, { ok: false })] }), o)).toEqual([]);
    expect(safeSourcesOf(run({ history: [step("push_develop", "COMMIT: abc1234")] }), o)).toEqual([]);
    expect(safeSourcesOf(run({ status: "failed", history: [step("push_develop", `COMMIT: ${A}`)] }), o)).toEqual([]);
  });
  it("reads a release check only with TESTED and CHECKS: yes", () => {
    const changes = step("changes", `Merge #3: First (feature/3)\nResolve #4: Second <b>x</b> (feature/4)\nMerge #3: First again (x)\n`);
    const ok = run({ flow: "release-daily", history: [changes, step("verify", `log\nTESTED: ${B}\nCHECKS: yes\n`)] });
    expect(safeSourcesOf(ok, o)).toMatchObject([{ commit: B, role: "develop", changes: [{ issue: 3, title: "First" }, { issue: 4, title: "Second x" }] }]);
    expect(safeSourcesOf(run({ history: [step("verify", `TESTED: ${B}\nCHECKS: no\n`)] }), o)).toEqual([]);
    expect(safeSourcesOf(run({ history: [step("verify", "CHECKS: yes\n")] }), o)).toEqual([]);
  });
  it("reads a clean base check of a run", () => {
    const r = run({ vars: { github_repo: "acme/app" }, history: [step("baseline_tests", `x\nBASE_GREEN: main ${C} 2026-11-02T08:00:00Z`)] });
    expect(safeSourcesOf(r, o)).toMatchObject([{ commit: C, branch: "main", role: "main", at: "2026-11-02T08:00:00.000Z", changes: [] }]);
  });
  it("does not name the run's own change as part of its baseline commit", () => {
    // run B is started on top of A: the baseline is A, so the point of A must not list B (regression, review of #863)
    const base = run({ runId: "base", task: "Change B", vars: { github_repo: "acme/app", develop_branch: "develop" }, history: [step("baseline_tests", `BASE_GREEN: develop ${A} 2026-11-02T08:00:00Z`)] });
    const pushA = run({ runId: "pushA", task: "Change A", history: [step("push_develop", `COMMIT: ${A}`)] });
    const pushA2 = run({ runId: "pushA2", task: "Change A", history: [step("pull_ticket", "# #6: Change A"), step("push_develop", `COMMIT: ${A}`)] });
    expect(safeSourcesOf(base, o).map((s) => s.changes)).toEqual([[]]);
    const titles = safePoints([...safeSourcesOf(base, o), ...safeSourcesOf(pushA, o), ...safeSourcesOf(pushA2, o)], { branch: "develop", viewer, names }).flatMap((p) => p.changes.map((c) => c.title));
    expect(titles).not.toContain("Change B");
    expect(titles).toEqual(expect.arrayContaining(["Change A"]));
  });
  it("reads a release build of the main branch only, with its changes", () => {
    const rb = (vars: Record<string, string>, outputs?: Record<string, string>) => run({ flow: "release-build", vars: { github_repo: "acme/app", ...vars }, ...(outputs ? { outputs } : {}) });
    const plan = () => ({ sha: A, changes: ["Merge #1: One (f)", "Merge #2: Two (g)"] });
    expect(safeSourcesOf(rb({ ref: "main" }, { release_tag: "v1" }), { ...o, plan })).toMatchObject([{ commit: A, branch: "main", role: "main", release: true, tag: "v1", changes: [{ issue: 1, title: "One" }, { issue: 2, title: "Two" }] }]);
    expect(safeSourcesOf(rb({ ref: "dev" }, { release_tag: "v1" }), { ...o, plan })).toEqual([]);
    expect(safeSourcesOf(rb({ ref: "main" }), { ...o, plan })).toEqual([]);
    expect(safeSourcesOf(rb({ ref: "main" }, { release_url: "https://x/y" }), { ...o, plan: () => undefined })).toEqual([]);
  });
});

describe("mergedChanges", () => {
  it("cuts long titles and hides secrets", () => {
    const t = mergedChanges(`Merge #1: ${"x".repeat(300)}`)[0]!.title;
    expect(t.length).toBeLessThanOrEqual(200);
  });
});

describe("releasePlan", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const planIn = (text?: string) => {
    const d = mkdtempSync(join(tmpdir(), "sp-"));
    dirs.push(d);
    if (text !== undefined) { mkdirSync(join(d, "release")); writeFileSync(join(d, "release", "plan.json"), text); }
    return d;
  };
  it("reads the commit and the changes", () => {
    expect(releasePlan(planIn(JSON.stringify({ sha: A, changes: ["Merge #1: a", 5] })))).toEqual({ sha: A, changes: ["Merge #1: a"] });
    expect(releasePlan(planIn(JSON.stringify({ sha: A })))).toEqual({ sha: A, changes: [] });
  });
  it("gives nothing for a missing, broken, big or bad file", () => {
    expect(releasePlan(planIn())).toBeUndefined();
    expect(releasePlan(planIn("{nope"))).toBeUndefined();
    expect(releasePlan(planIn(JSON.stringify({ sha: A, pad: "x".repeat(70_000) })))).toBeUndefined();
    expect(releasePlan(planIn(JSON.stringify({ sha: "abc1234" })))).toBeUndefined();
  });
});

const src = (commit: string, at: string, over: Partial<SafeSource> = {}): SafeSource => ({ runId: `r${commit.slice(0, 3)}${at}`, commit, branch: "develop", role: "develop", at, release: false, changes: [], ...over });

describe("safePoints", () => {
  it("keeps one branch only, exactly", () => {
    const list = [src(A, "2026-11-01T10:00:00.000Z"), src(B, "2026-11-02T10:00:00.000Z", { branch: "old-develop" }), src(C, "2026-11-03T10:00:00.000Z", { branch: "main", role: "main" })];
    expect(safePoints(list, { branch: "develop", viewer, names }).map((p) => p.commit)).toEqual([A]);
    expect(safePoints(list, { branch: "main", viewer, names }).map((p) => p.commit)).toEqual([C]);
  });
  it("merges one commit, sorts newest first and cuts at ten", () => {
    const one = src(A, "2026-11-02T10:00:00.000Z", { changes: [{ issue: 1, title: "a" }], release: true, tag: "v1" });
    const two = src(A, "2026-11-01T10:00:00.000Z", { changes: [{ issue: 1, title: "a" }, { issue: 2, title: "b" }], owner: "u1" });
    const p = safePoints([one, two], { branch: "develop", viewer, names });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ at: "2026-11-01T10:00:00.000Z", release: true, tag: "v1", short: "aaaaaaa", by: { kind: "you" }, changes: [{ issue: 1 }, { issue: 2 }] });
    const many = Array.from({ length: 14 }, (_, i) => src(i.toString(16).padStart(40, "0"), `2026-11-${String(i + 1).padStart(2, "0")}T10:00:00.000Z`));
    const cut = safePoints(many, { branch: "develop", viewer, names });
    expect(cut).toHaveLength(MAX_SAFE_POINTS);
    expect(cut[0]!.at).toBe("2026-11-14T10:00:00.000Z");
  });
  it("cuts the changes at 20 and says how many more", () => {
    const changes = Array.from({ length: 25 }, (_, i) => ({ issue: i + 1, title: `t${i}` }));
    const p = safePoints([src(A, "2026-11-01T10:00:00.000Z", { changes })], { branch: "develop", viewer, names })[0]!;
    expect(p.changes).toHaveLength(MAX_SAFE_CHANGES);
    expect(p.moreChanges).toBe(5);
  });
});

describe("startedBy", () => {
  it("tells the Foundry, you and a person apart, and hides names from a user", () => {
    expect(startedBy({ owner: "u2", source: "watcher w1" }, viewer, names)).toEqual({ kind: "foundry" });
    expect(startedBy({ owner: "u1", source: "ui" }, viewer, names)).toEqual({ kind: "you" });
    expect(startedBy({ owner: "u2", source: "ui" }, viewer, names)).toEqual({ kind: "person" });
    expect(startedBy({ owner: "u2", source: "ui" }, { id: "a", admin: true }, names)).toEqual({ kind: "person", name: "Bea" });
    expect(startedBy({ owner: "gone", source: "ui" }, { id: "a", admin: true }, names)).toEqual({ kind: "person", name: "deleted account" });
  });
});
