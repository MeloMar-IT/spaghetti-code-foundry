import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { listEvalReports, loadSuite, runEval } from "../src/evals.js";
import { addSkillPins } from "../src/skills/lock.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { claudeBin } from "./helpers/fake-github.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-eval-test-"));
  mkdirSync(join(tmp, "fixture"));
  writeFileSync(join(tmp, "fixture", "README.md"), "fixture\n");
  mkdirSync(join(tmp, ".claude-factory", "flows"), { recursive: true });
  writeFileSync(join(tmp, ".claude-factory", "flows", "one.yaml"), `
name: one
workspace: worktree
steps:
  - {id: do, type: claude, prompt: "{{task}}"}
`);
  writeFileSync(join(tmp, "suite.yaml"), `
name: t
flows: [one]
models: [haiku, opus]
cases:
  - {name: writes, repo: fixture, task: "WRITE ok.txt yes", check: "test -f ok.txt"}
  - {name: forgets, repo: fixture, task: "SAY nothing", check: "test -f ok.txt"}
  - {name: no-check, repo: fixture, task: "SAY done"}
`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("evals", () => {
  it("validates suites", () => {
    writeFileSync(join(tmp, "bad.yaml"), "name: t\nflows: []\ncases: []\n");
    expect(() => loadSuite(join(tmp, "bad.yaml"))).toThrow(/invalid suite/);
  });

  it("runs every flow × model × case, checks results and saves a report", { timeout: 120_000 }, async () => {
    const lines: string[] = [];
    const { report, file } = await runEval({
      suitePath: join(tmp, "suite.yaml"),
      runsDir: join(tmp, "runs"),
      config: ConfigSchema.parse({ protected_branches: [], concurrency: 3 }),
      claudeBin,
      log: (l) => lines.push(l),
    });
    expect(report.results).toHaveLength(6);
    expect(report.summary.map((s) => s.variant).sort()).toEqual(["one@haiku", "one@opus"]);
    for (const s of report.summary) {
      expect(s.runs).toBe(3);
      expect(s.passRate).toBeCloseTo(2 / 3, 2); // "forgets" fails its check
      expect(s.avgCostUsd).toBeCloseTo(0.01);
    }
    const forgets = report.results.find((r) => r.case === "forgets")!;
    expect(forgets.status).toBe("succeeded");
    expect(forgets.passed).toBe(false);
    expect(file).toMatch(/evals\/t-.*\.json$/);
    expect(listEvalReports()[0]!.suite).toBe("t");
    expect(lines[0]).toContain("2 variant(s) × 3 case(s) × 1 = 6 runs");
    for (const s of report.summary) {
      expect(s.skills).toBeUndefined();
      expect(s.qualityRate).toBe(s.passRate);
    }
    expect(report.results.every((r) => r.skills === undefined)).toBe(true);
  });

  it("refuses a case whose skill is both selected and absent", () => {
    writeFileSync(join(tmp, "bad2.yaml"), "name: t\nflows: [one]\ncases:\n  - {name: a, repo: fixture, skills: {selected: [a], absent: [a]}}\n");
    expect(() => loadSuite(join(tmp, "bad2.yaml"))).toThrow(/invalid suite/);
  });

  it("fails on wrong selection and on budget although the run succeeds, and reports the rates apart", { timeout: 120_000 }, async () => {
    const root = join(tmp, "skills");
    const pkg = join(root, "eval-demo");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "SKILL.md"), "---\nname: eval-demo\ndescription: A test skill.\n---\n\nDo it.\n");
    writeFileSync(join(pkg, "skill.yaml"), "id: eval-demo\nversion: 1.0.0\n");
    addSkillPins([{ key: "eval-demo@1.0.0", digest: loadSkillPackage(pkg).digest }]);
    const request = 'SKILL_REQUEST: {"version":1,"skills":[{"id":"eval-demo","reason":"Needed for the change","evidence":["catalogue:eval-demo"]}]}';
    writeFileSync(join(tmp, ".claude-factory", "flows", "skilled.yaml"), `
name: skilled
workspace: worktree
steps:
  - id: risk_gate
    type: shell
    run: |
      # /skill-request
      echo READY
      echo '${request}'
  - {id: do, type: claude, prompt: "{{task}}"}
`);
    writeFileSync(join(tmp, "skill-suite.yaml"), `
name: sk
flows: [skilled]
cases:
  - {name: right, repo: fixture, task: "WRITE ok.txt yes", check: "test -f ok.txt", skills: {selected: [eval-demo], max_tokens: 2000}}
  - {name: wrong, repo: fixture, task: "WRITE ok.txt yes", check: "test -f ok.txt", skills: {absent: [eval-demo]}}
  - {name: fat, repo: fixture, task: "WRITE ok.txt yes", check: "test -f ok.txt", skills: {selected: [eval-demo], max_tokens: 1}}
`);
    const { report } = await runEval({
      suitePath: join(tmp, "skill-suite.yaml"),
      runsDir: join(tmp, "runs"),
      config: ConfigSchema.parse({ protected_branches: [], concurrency: 3, skills: { roots: [root] } }),
      claudeBin,
      log: () => {},
    });
    const by = (n: string) => report.results.find((r) => r.case === n)!;
    expect(by("right").passed).toBe(true);
    expect(by("wrong")).toMatchObject({ status: "succeeded", quality: true, passed: false });
    expect(by("wrong").skills!.selection.ok).toBe(false);
    expect(by("wrong").skills!.activation.ok).toBe(false);
    expect(by("fat")).toMatchObject({ quality: true, passed: false });
    expect(by("fat").skills!.context.ok).toBe(false);
    expect(by("fat").skills!.selection.ok && by("fat").skills!.activation.ok).toBe(true);
    const s = report.summary[0]!;
    expect(s.passRate).toBeCloseTo(1 / 3, 2);
    expect(s.qualityRate).toBe(1);
    expect(s.skills).toMatchObject({ runs: 3 });
    expect(s.skills!.selectionRate).toBeCloseTo(2 / 3, 2);
    expect(s.skills!.contextRate).toBeCloseTo(2 / 3, 2);
    expect(s.skills!.activationRate).toBeCloseTo(2 / 3, 2);

    // A Codex variant (fake Codex): Codex coding sessions get the locked skills like Claude ones, so it passes too.
    const codex = await runEval({
      suitePath: join(tmp, "skill-suite.yaml"),
      runsDir: join(tmp, "runs-codex"),
      config: ConfigSchema.parse({ protected_branches: [], concurrency: 3, skills: { roots: [root] } }),
      modelsOverride: ["codex"],
      claudeBin,
      codexBin: resolve("tests/fixtures/fake-codex.mjs"),
      log: () => {},
    });
    const cr = codex.report.results.find((r) => r.case === "right")!;
    expect(cr.variant).toContain("@codex");
    expect(cr).toMatchObject({ quality: true, passed: true });
    expect(cr.skills!.selection.ok).toBe(true);
    expect(cr.skills!.activation.ok).toBe(true);
  });
});
