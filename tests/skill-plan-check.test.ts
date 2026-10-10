import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { carryRunSkills } from "../src/engine/plan-carry.js";
import type { RunSummary } from "../src/engine/state.js";
import { prunePlanRecords } from "../src/skills/plan-record.js";
import { planHashOf, sha256Of } from "../src/skills/run-lock.js";

// carryRunSkills at plan_check: the plan record read back and carried into the coding run.

const HASH = "sha256:" + "c".repeat(64);
const LINK = "https://github.com/acme/app/issues/5#issuecomment-7";
const COMMIT = "a".repeat(40);
const TECH = "sha256:" + "b".repeat(64);
const OTHER_TECH = "sha256:" + "e".repeat(64);
const REQUEST = { version: 1, skills: [{ id: "my-skill", reason: "because", evidence: ["issue:asks for it", "path:src/a.ts"] }] };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plan-check-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const cfg = (include: string[] = []): Config => ConfigSchema.parse({ protected_branches: [], skills: { selection: { include } } });
const deps = () => ({ home, commitOf: () => COMMIT, technologyOf: () => TECH, pathsChanged: () => false });
const logger = () => {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
};
const postPlanOutput = (request: unknown) => [LINK, `PLAN_COMMENT_SHA256: ${HASH}`, `SKILL_REQUEST: ${JSON.stringify(request)}`].join("\n") + "\n";

function plan(request: unknown = REQUEST, repo = "acme/app"): string {
  const out = postPlanOutput(request);
  const run = {
    flowDef: { steps: [{ id: "post_plan", type: "shell", run: "x $FACTORY_TOOLS/skill-request $FACTORY_TOOLS/plan-comment" }] },
    vars: { github_repo: repo, issue: "5" },
    runId: "run-1",
    workdir: home,
    history: [{ id: "post_plan", type: "shell", ok: true, visit: 1, output: out }],
  } as unknown as RunSummary;
  expect(carryRunSkills(run, cfg(), "post_plan", () => {}, deps())).toBeUndefined();
  return out;
}

type Fact = { id: string; sha256?: string; mine?: boolean; later?: number };
function check(comments: Fact[] | "none", over: Record<string, unknown> = {}): RunSummary {
  const output =
    comments === "none"
      ? "no facts\n"
      : `PLAN_COMMENTS: ${JSON.stringify({ version: 1, comments: comments.map((c) => ({ id: c.id, sha256: c.sha256 ?? HASH, mine: c.mine ?? true, later: c.later ?? 0 })) })}\n`;
  return {
    flowDef: { steps: [{ id: "plan_check", type: "shell", run: 'gh issue view | node "$FACTORY_TOOLS/plan-comment"' }] },
    vars: { github_repo: "acme/app", issue: "5" },
    runId: "run-2",
    workdir: home,
    history: [{ id: "plan_check", type: "shell", ok: true, visit: 1, output }],
    ...over,
  } as unknown as RunSummary;
}
const run = (r: RunSummary, d: object = deps(), include: string[] = [], log: (m: string) => void = () => {}) => carryRunSkills(r, cfg(include), "plan_check", log, d);

describe("carryRunSkills at plan_check", () => {
  it("carries the stored request when the comment matches", () => {
    const out = plan();
    const r = check([{ id: "7" }]);
    const l = logger();
    expect(run(r, deps(), [], l.log)).toBeUndefined();
    expect(r.skillCarry).toMatchObject({ planHash: planHashOf(out), lockHash: planHashOf(out), commentId: "7", changes: [] });
    expect(r.skillCarry!.request.skills.map((s) => s.id)).toEqual(["my-skill"]);
    expect(l.lines).toEqual(["    · plan record: comment 7"]);
  });

  const cases: [string, Fact[] | "none", string][] = [
    ["comment-missing", [{ id: "7", mine: false }], "the plan comment is gone"],
    ["comment-changed", [{ id: "7", sha256: "sha256:" + "d".repeat(64) }], "the plan comment was edited"],
    ["newer-plan", [{ id: "9" }], "a newer plan has no record here"],
    ["unreadable", "none", "the plan comments could not be read"],
  ];
  it.each(cases)("%s: stops with skills in play", (_k, comments, text) => {
    plan();
    const r = check(comments, { skillCarry: { stale: true } });
    expect(run(r)).toBe(`skills not resolved: ${text} — plan the issue again`);
    expect(r.skillCarry).toBeUndefined();
    expect(r.skillPlan).toMatchObject({ action: "stop", gate: "plan_check" });
  });
  it.each(cases)("%s: warns and goes on without skills in play", (_k, comments, text) => {
    plan({ version: 1, skills: [] });
    const r = check(comments, { skillCarry: { stale: true } });
    const l = logger();
    expect(run(r, deps(), [], l.log)).toBeUndefined();
    expect(r.skillCarry).toBeUndefined();
    expect(r.skillPlan).toBeUndefined();
    expect(l.lines).toEqual([`⚠ plan check: ${text}; the run goes on without the plan's skills`]);
  });
  it("stops for an empty request when include is set", () => {
    plan({ version: 1, skills: [] });
    expect(run(check([{ id: "9" }]), deps(), ["x"])).toMatch(/plan the issue again$/);
  });

  it("stops after a clean-up when skills were in play, warns when they were not", () => {
    plan();
    prunePlanRecords({ olderThanMs: -1, home });
    const r = check([{ id: "7" }]);
    expect(run(r)).toBe("skills not resolved: the plan record was cleaned up — plan the issue again");
    expect(r.skillCarry).toBeUndefined();
    expect(r.skillPlan).toMatchObject({ action: "stop", gate: "plan_check" });
  });
  it("goes on with a warning after a clean-up of a plan without skills", () => {
    plan({ version: 1, skills: [] });
    prunePlanRecords({ olderThanMs: -1, home });
    const r = check([{ id: "7" }]);
    const l = logger();
    expect(run(r, deps(), [], l.log)).toBeUndefined();
    expect(l.lines).toEqual(["⚠ plan check: the plan record was cleaned up; the run goes on without the plan's skills"]);
    expect(r.skillPlan).toBeUndefined();
  });

  it("does nothing when nothing is stored, even with include set", () => {
    const r = check([{ id: "7" }], { skillCarry: { stale: true } });
    const l = logger();
    expect(run(r, deps(), ["x"], l.log)).toBeUndefined();
    expect(r.skillCarry).toBeUndefined();
    expect(r.skillPlan).toBeUndefined();
    expect(l.lines).toEqual([]);
  });

  it("never uses a record of another repository", () => {
    plan(REQUEST, "other/app");
    const r = check([{ id: "7" }]);
    expect(run(r)).toBeUndefined();
    expect(r.skillCarry).toBeUndefined();
    expect(r.skillPlan).toBeUndefined();
  });

  it("always stops on an invalid store", () => {
    plan({ version: 1, skills: [] });
    writeFileSync(join(home, "skill-plans", "acme", "app", "5", "junk.json"), "{");
    const r = check([{ id: "7" }]);
    expect(run(r)).toMatch(/^skills not resolved: the plan records of this issue are not valid$/);
    expect(r.skillCarry).toBeUndefined();
  });

  it("carries with changes, one warning each, and the lockHash formula", () => {
    const out = plan();
    const r = check([{ id: "7", later: 2 }]);
    const l = logger();
    expect(run(r, { ...deps(), pathsChanged: () => true, technologyOf: () => OTHER_TECH }, [], l.log)).toBeUndefined();
    expect(r.skillCarry!.changes).toEqual(["comments", "code", "technology"]);
    expect(r.skillCarry!.lockHash).toBe(sha256Of(planHashOf(out) + "\ncomments,code,technology\n" + COMMIT));
    expect(l.lines.filter((m) => m.startsWith("⚠ plan check:"))).toHaveLength(3);
  });

  it("reports each change alone", () => {
    plan();
    const a = check([{ id: "7", later: 1 }]);
    run(a);
    expect(a.skillCarry!.changes).toEqual(["comments"]);
    const b = check([{ id: "7" }]);
    run(b, { ...deps(), pathsChanged: () => true });
    expect(b.skillCarry!.changes).toEqual(["code"]);
    const c = check([{ id: "7" }]);
    run(c, { ...deps(), technologyOf: () => OTHER_TECH });
    expect(c.skillCarry!.changes).toEqual(["technology"]);
    expect(c.skillCarry!.lockHash).not.toBe(c.skillCarry!.planHash);
  });

  it("asks about paths only for path evidence, and still reports technology", () => {
    plan({ version: 1, skills: [{ id: "my-skill", reason: "because", evidence: ["catalogue:x"] }] });
    const r = check([{ id: "7" }]);
    let asked = 0;
    run(r, { ...deps(), pathsChanged: () => (asked++, true), technologyOf: () => OTHER_TECH });
    expect(asked).toBe(0);
    expect(r.skillCarry!.changes).toEqual(["technology"]);
  });

  it("counts an unknown commit as changed with the default check", () => {
    plan();
    const r = check([{ id: "7" }]);
    const { pathsChanged: _unused, ...rest } = deps();
    run(r, rest);
    expect(r.skillCarry!.changes).toEqual(["code"]);
  });

  it("leaves a run with a plan gate alone", () => {
    plan();
    const r = check([{ id: "7" }]);
    r.flowDef!.steps.push({ id: "post_plan", type: "shell", run: "x $FACTORY_TOOLS/skill-request" } as never);
    r.history.push({ id: "post_plan", type: "shell", ok: true, visit: 1, output: postPlanOutput(REQUEST) } as never);
    expect(run(r)).toBeUndefined();
    expect(r.skillCarry).toBeUndefined();
    expect(r.skillPlan).toBeUndefined();
  });

  it("does nothing for other steps, a step without plan-comment, or no flow", () => {
    plan();
    const r = check([{ id: "7" }]);
    expect(carryRunSkills(r, cfg(), "implement", () => {}, deps())).toBeUndefined();
    expect(r.skillCarry).toBeUndefined();
    const plain = check([{ id: "7" }], { flowDef: { steps: [{ id: "plan_check", type: "shell", run: "true" }] } });
    expect(run(plain)).toBeUndefined();
    expect(plain.skillCarry).toBeUndefined();
    const none = check([{ id: "7" }], { flowDef: undefined });
    expect(run(none)).toBeUndefined();
    expect(none.skillCarry).toBeUndefined();
  });

  it("stops with 'could not be checked' when a dependency throws", () => {
    plan();
    const r = check([{ id: "7" }]);
    const d = { ...deps(), technologyOf: () => { throw new Error("x"); } };
    expect(run(r, d)).toBe("skills not resolved: the plan record could not be checked");
    expect(r.skillCarry).toBeUndefined();
  });
});
