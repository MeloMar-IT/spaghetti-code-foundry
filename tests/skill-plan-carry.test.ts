import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { carryRunSkills } from "../src/engine/plan-carry.js";
import type { RunSummary } from "../src/engine/state.js";
import { readPlanRecords, storableRequest } from "../src/skills/plan-record.js";
import { planHashOf } from "../src/skills/run-lock.js";

const HASH = "sha256:" + "c".repeat(64);
const LINK = "https://github.com/acme/app/issues/5#issuecomment-7";
const COMMIT = "a".repeat(40);
const TECH = "sha256:" + "b".repeat(64);
const REQUEST = { version: 1, skills: [{ id: "my-skill", reason: "because", evidence: ["issue:asks for it", "path:src/a.ts"] }] };
const line = (r: unknown) => `SKILL_REQUEST: ${JSON.stringify(r)}`;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plan-carry-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const cfg = (include: string[] = []): Config => ConfigSchema.parse({ protected_branches: [], skills: { selection: { include } } });
const deps = () => ({ home, commitOf: () => COMMIT, technologyOf: () => TECH });
const outputOf = (over: { link?: string[]; hash?: string[]; request?: unknown } = {}) =>
  [...(over.link ?? [LINK]), ...(over.hash ?? [`PLAN_COMMENT_SHA256: ${HASH}`]), line(over.request ?? REQUEST)].join("\n") + "\n";
const mk = (output: string, over: Record<string, unknown> = {}, run = "x $FACTORY_TOOLS/skill-request $FACTORY_TOOLS/plan-comment"): RunSummary =>
  ({
    flowDef: { steps: [{ id: "post_plan", type: "shell", run }] },
    vars: { github_repo: "acme/app", issue: "5" },
    runId: "run-1",
    workdir: home,
    history: [{ id: "post_plan", type: "shell", ok: true, visit: 1, output }],
    ...over,
  }) as unknown as RunSummary;
const logger = () => {
  const lines: string[] = [];
  return { lines, log: (m: string) => lines.push(m) };
};
const records = () => readPlanRecords("acme/app", "5", { home });

describe("carryRunSkills", () => {
  it("writes the plan record and leaves the run alone", () => {
    const out = outputOf();
    const run = mk(out);
    const l = logger();
    expect(carryRunSkills(run, cfg(), "post_plan", l.log, deps())).toBeUndefined();
    expect(run.skillPlan).toBeUndefined();
    const r = records();
    if (r === "invalid") throw new Error("invalid");
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({
      repo: "acme/app", issue: "5", runId: "run-1", commentId: "7", commentSha256: HASH, commit: COMMIT, technology: TECH, planHash: planHashOf(out),
    });
    expect(r.records[0]!.request).toEqual(storableRequest(REQUEST as never));
    expect(r.records[0]!.request.skills[0]!.evidence).toEqual(["issue:omitted", "path:src/a.ts"]);
    expect(l.lines).toEqual(["    · plan record: comment 7"]);
  });

  it("writes the record for an empty request without include", () => {
    const run = mk(outputOf({ request: { version: 1, skills: [] } }));
    expect(carryRunSkills(run, cfg(), "post_plan", () => {}, deps())).toBeUndefined();
    const r = records();
    expect(r !== "invalid" && r.records).toHaveLength(1);
  });

  it("leaves out the commit and the technology when they are not known", () => {
    const run = mk(outputOf());
    expect(carryRunSkills(run, cfg(), "post_plan", () => {}, { home, commitOf: () => undefined, technologyOf: () => undefined })).toBeUndefined();
    const r = records();
    if (r === "invalid") throw new Error("invalid");
    expect(r.records[0]).not.toHaveProperty("commit");
    expect(r.records[0]).not.toHaveProperty("technology");
  });

  const FAILURES: [string, (run: RunSummary) => RunSummary | void, Record<string, unknown>][] = [
    ["no hash line", () => {}, { hash: [] }],
    ["a malformed hash line", () => {}, { hash: ["PLAN_COMMENT_SHA256: sha256:xyz"] }],
    ["two links", () => {}, { link: [LINK, LINK.replace("-7", "-8")] }],
    ["no link", () => {}, { link: [] }],
    ["a bad repo name", (run) => void (run.vars!.github_repo = "owner/repo/x"), {}],
    ["a bad issue", (run) => void (run.vars!.issue = "abc"), {}],
    ["a write error", () => writeFileSync(join(home, "skill-plans"), "not a folder"), {}],
  ];
  const STOP = "skills not resolved: the plan record could not be written (";

  describe.each([
    ["a requested skill", cfg(), REQUEST],
    ["include set and an empty request", cfg(["x"]), { version: 1, skills: [] }],
  ])("with skills in play (%s)", (_n, config, request) => {
    it.each(FAILURES)("stops: %s", (_name, prepare, over) => {
      const run = mk(outputOf({ ...over, request }));
      prepare(run);
      const l = logger();
      const reason = carryRunSkills(run, config, "post_plan", l.log, deps());
      expect(reason?.startsWith(STOP)).toBe(true);
      expect(run.skillPlan).toMatchObject({ action: "stop", gate: "post_plan", reason });
      expect(l.lines).toEqual([`■ ${reason}`]);
    });
  });

  describe("with no skills in play", () => {
    it.each(FAILURES)("only warns: %s", (_name, prepare, over) => {
      const run = mk(outputOf({ ...over, request: { version: 1, skills: [] } }));
      prepare(run);
      const l = logger();
      expect(carryRunSkills(run, cfg(), "post_plan", l.log, deps())).toBeUndefined();
      expect(run.skillPlan).toBeUndefined();
      expect(l.lines).toHaveLength(1);
      expect(l.lines[0]).toMatch(/^⚠ plan record not written: /);
    });
  });

  it("keeps the number of checks on a stop", () => {
    const run = mk(outputOf({ hash: [] }), { skillPlan: { version: 1, role: "coder", action: "stop", selected: [], unresolved: [], warnings: [], reason: "r", gate: "post_plan", at: "x", checks: 2 } });
    carryRunSkills(run, cfg(), "post_plan", () => {}, deps());
    expect(run.skillPlan?.checks).toBe(2);
    expect(run.skillPlan?.action).toBe("stop");
  });

  it.each([
    ["a step without the tool", mk(outputOf(), {}, "x $FACTORY_TOOLS/skill-request"), "post_plan"],
    ["another step", mk(outputOf()), "risk_gate"],
    ["a run without a flow", mk(outputOf(), { flowDef: undefined }), "post_plan"],
  ] as [string, RunSummary, string][])("does nothing for %s", (_n, run, step) => {
    const l = logger();
    expect(carryRunSkills(run, cfg(["x"]), step, l.log, deps())).toBeUndefined();
    expect(l.lines).toEqual([]);
    expect(run.skillPlan).toBeUndefined();
    const r = records();
    expect(r !== "invalid" && r.records).toHaveLength(0);
  });

  it.each([cfg(), cfg(["x"])])("fails closed when a dependency throws", (config) => {
    const run = mk(outputOf());
    const reason = carryRunSkills(run, config, "post_plan", () => {}, {
      home,
      commitOf: () => {
        throw new Error("boom");
      },
    });
    expect(reason).toBe("skills not resolved: the plan record could not be checked");
    expect(run.skillPlan?.action).toBe("stop");
  });
});
