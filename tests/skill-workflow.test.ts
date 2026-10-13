import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/skills/catalogue.js";
import { evaluateSkillRun, SkillExpectSchema, type SkillEvalRun } from "../src/skills/eval.js";
import { parseFlow } from "../src/flow/load.js";
import { renderSkillPayload } from "../src/skills/payload.js";
import { resolveSkills, skillContextTokens } from "../src/skills/resolve.js";
import { RESOLVE_DEFAULTS } from "../src/skills/resolve-rules.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { flowSkillSteps } from "../src/skills/tool-policy.js";
import {
  assessWorkflows, connectorProfile, declaredPackage, workflowBlockers, workflowProvenance, type WorkflowAssessment, type WorkflowFlow,
} from "../src/skills/workflow.js";
import { CONNECTOR_PROFILES, WORKFLOW_CODES, WORKFLOW_EFFECT, WORKFLOW_LIMITS } from "../src/skills/workflow-rules.js";
import { CLEAN, FLOWS, KEY, ORIGIN, VARIANTS, clean, flow, skillMd, skillOf, step, withLine } from "./fixtures/skill-workflow.js";

const profile = connectorProfile(KEY)!;
const assess = (skills: ReturnType<typeof clean>[], flows: readonly WorkflowFlow[] = FLOWS) => assessWorkflows({ profile, skills, flows, skillMd });
const one = (skill: ReturnType<typeof clean>, flows: readonly WorkflowFlow[] = FLOWS): WorkflowAssessment => assess([skill], flows).skills[0]!;
const codes = (a: WorkflowAssessment) => a.findings.map((f) => f.code);
const CODER_ROWS = Object.keys(CLEAN).filter((n) => n !== "writing-plans");

describe("the profile", () => {
  it("is found by repository key only", () => {
    expect(connectorProfile(KEY)?.id).toBe("superpowers");
    expect(connectorProfile("github.com/example/other")).toBeUndefined();
  });
  it("keeps every budget under the resolve limit, with distinct slug capabilities", () => {
    const rows = Object.values(profile.skills);
    expect(rows.length).toBe(6);
    for (const r of rows) expect(r.maxTokens).toBeLessThanOrEqual(RESOLVE_DEFAULTS.maxSkillTokens);
    const caps = rows.map((r) => r.capability);
    expect(new Set(caps).size).toBe(caps.length);
    for (const c of caps) expect(c).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const own = readdirSync("skills", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => readFileSync(join("skills", e.name, "skill.yaml"), "utf8"));
    for (const c of caps) for (const text of own) expect(text).not.toContain(c);
  });
  it("has an effect for every code", () => {
    expect(Object.keys(WORKFLOW_EFFECT).sort()).toEqual([...WORKFLOW_CODES].sort());
    expect(CONNECTOR_PROFILES.length).toBe(1);
  });
});

describe("flowSkillSteps", () => {
  it("gives the id, role, mode and tools of each Claude step", () => {
    const steps = flowSkillSteps({
      defaults: { permission_mode: "acceptEdits" },
      steps: [
        { id: "a", type: "claude" },
        { id: "b", type: "claude", skills: "catalog", permission_mode: "plan" },
        { id: "c", type: "claude", skills: "off" },
        { id: "d", type: "claude", skill_role: "reviewer", permission_mode: "plan" },
        { id: "e", type: "claude", agent: "codex" },
        { id: "f", type: "shell" },
      ],
    });
    expect(steps.map((s) => [s.id, s.role, s.mode])).toEqual([["a", "coder", "selected"], ["b", "coder", "catalog"], ["c", "coder", "off"], ["d", "reviewer", "selected"]]);
    expect(steps[0]!.capabilities.filesystem).toBe("write");
    expect(steps[1]!.capabilities.filesystem).toBe("read");
  });
});

describe("the real flows", () => {
  const real = new Map<string, WorkflowFlow>();
  for (const f of readdirSync("flows").filter((x) => x.endsWith(".yaml"))) {
    const parsed = parseFlow(readFileSync(join("flows", f), "utf8"), f);
    real.set(f.slice(0, -5), { name: f.slice(0, -5), skills: parsed.skills?.mode ?? "planned", steps: flowSkillSteps(parsed) });
  }
  const flows = [...real.values()];

  it("has every flow the profile names", () => {
    for (const r of Object.values(profile.skills)) for (const name of r.flows) expect(real.has(name), name).toBe(true);
  });
  it("gives every coder row a compatible flow", () => {
    for (const name of CODER_ROWS) {
      const a = one(clean(name), flows);
      expect(a.declaration?.flows.length, `${name}: ${JSON.stringify(a.findings)}`).toBeGreaterThan(0);
      expect(a.status, name).toBe("candidate");
    }
  });
  it("gives writing-plans no receiving step today", () => {
    const a = one(clean("writing-plans"), flows);
    expect(a.status).toBe("excluded");
    expect(a.blockers).toEqual(["no-compatible-flow"]);
  });
});

describe("assessment", () => {
  it("makes a candidate of each clean coder skill, with its row as the declaration", () => {
    for (const name of CODER_ROWS) {
      const row = profile.skills[name]!;
      const a = one(clean(name));
      expect(a.status, name).toBe("candidate");
      expect(a.blockers).toEqual([]);
      expect(a.declaration).toMatchObject({
        schema: 1, profile: "superpowers", tools: row.tools, roles: row.roles, capability: row.capability, flows: [...row.flows].sort(),
        context: { max: row.maxTokens, payloadMax: row.maxTokens + WORKFLOW_LIMITS.wrapperTokens },
      });
    }
  });
  it("excludes the clean planner skill only by the flow check", () => {
    const a = one(clean("writing-plans"));
    expect(a.blockers).toEqual(["no-compatible-flow"]);
    expect(codes(a)).toContain("flow-incompatible");
    expect(a.findings.find((f) => f.code === "flow-incompatible")?.evidence).toBe("no step loads skills for role planner");
  });
  it("excludes a skill that is not in the profile", () => {
    const a = one(skillOf("other-skill", "Do things."));
    expect(a).toMatchObject({ status: "excluded", blockers: ["not-selected"] });
    expect(a.declaration).toBeUndefined();
  });
  it("throws for a skill of another repository", () => {
    const other = skillOf("test-driven-development", "x");
    other.provenance.repositoryKey = "github.com/example/other";
    expect(() => assess([other])).toThrow(TypeError);
  });

  for (const [label, v] of Object.entries(VARIANTS)) {
    it(`${label}: the code, path and line are right`, () => {
      const body = withLine(v.skill, v.line);
      const skill = skillOf(v.skill, body);
      const a = one(skill);
      const f = a.findings.find((x) => x.code === v.code)!;
      // The line is a line of the SKILL.md file, frontmatter included.
      const doc = Buffer.from(skillMd(skill)!).toString("utf8").split("\n");
      expect(f.line).toBe(doc.indexOf(v.line) + 1);
      expect(f.line).toBeGreaterThan(body.split("\n").length);
      expect(f, JSON.stringify(a.findings)).toBeDefined();
      expect(f.effect).toBe(WORKFLOW_EFFECT[v.code as keyof typeof WORKFLOW_EFFECT]);
      expect(f.path).toBe("SKILL.md");
      if (WORKFLOW_EFFECT[v.code as keyof typeof WORKFLOW_EFFECT] === "exclude") {
        expect(a.status).toBe("excluded");
        expect(a.blockers).toContain(v.code);
      } else {
        expect(a.status).toBe("candidate");
      }
    });
  }

  it("keeps the line of a match in a reference file", () => {
    const a = one(skillOf("test-driven-development", CLEAN["test-driven-development"]!, { files: { "references/notes.md": "one\ntwo\nCreate a git worktree.\n" } }));
    expect(a.findings).toContainEqual(expect.objectContaining({ code: "assumes-worktrees", path: "references/notes.md", line: 3 }));
  });

  describe("undeclared-tool", () => {
    it("a shell block excludes a skill without shell and not one with it", () => {
      const block = "```bash\nls\n```";
      expect(codes(one(skillOf("writing-plans", withLine("writing-plans", block))))).toContain("undeclared-tool");
      expect(one(skillOf("test-driven-development", withLine("test-driven-development", block))).status).toBe("candidate");
    });
    it("write wording excludes a read-only declaration and not a write one", () => {
      const line = "Implement the fix when it fails.";
      expect(one(skillOf("verification-before-completion", withLine("verification-before-completion", line))).blockers).toContain("undeclared-tool");
      expect(one(skillOf("systematic-debugging", withLine("systematic-debugging", line))).status).toBe("candidate");
    });
    it("a network call excludes every row", () => {
      const a = one(skillOf("receiving-code-review", withLine("receiving-code-review", "Reply with gh api on the thread.")));
      expect(a.blockers).toContain("undeclared-tool");
    });
  });

  describe("grants-tools", () => {
    const tdd = CLEAN["test-driven-development"]!;
    const cases: [string, ReturnType<typeof skillOf>][] = [
      ["allowed-tools", skillOf("test-driven-development", tdd, { frontmatter: "allowed-tools: Bash\n" })],
      ["tools in the metadata", skillOf("test-driven-development", tdd, { frontmatter: "tools: Bash, Edit\n" })],
      ["an MCP tool", skillOf("test-driven-development", tdd, { frontmatter: "allowed-tools: mcp__x__y\n" })],
      ["a scripts file without shell", skillOf("writing-plans", CLEAN["writing-plans"]!, { files: { "scripts/run.sh": "echo hi\n" } })],
      ["a manifest with tool_profile", skillOf("test-driven-development", tdd, { files: { "skill.yaml": "tool_profile:\n  network: true\n" } })],
    ];
    for (const [label, skill] of cases) {
      it(`${label} excludes the skill and declaredPackage throws`, () => {
        const a = one(skill);
        expect(a.blockers, JSON.stringify(a.findings)).toContain("grants-tools");
        expect(a.status).toBe("excluded");
        expect(() => declaredPackage(skill, a)).toThrow(TypeError);
      });
    }
  });

  describe("dependencies", () => {
    const tdd = CLEAN["test-driven-development"]!;
    const cases: [string, ReturnType<typeof skillOf>][] = [
      ["frontmatter", skillOf("test-driven-development", tdd, { frontmatter: "dependencies: [using-superpowers]\n" })],
      ["a manifest", skillOf("test-driven-development", tdd, { files: { "skill.yaml": "dependencies:\n  - other-skill\n" } })],
    ];
    for (const [label, skill] of cases) {
      it(`a dependency in ${label} excludes the skill with requires-skill`, () => {
        const a = one(skill);
        expect(skill.package.dependencies.length).toBeGreaterThan(0);
        expect(a.blockers).toContain("requires-skill");
        expect(() => declaredPackage(skill, a)).toThrow(TypeError);
      });
    }
  });

  describe("requires-skill", () => {
    it("a marker excludes, also when the target is a clean candidate in the same import", () => {
      const needy = skillOf("systematic-debugging", withLine("systematic-debugging", "REQUIRED SUB-SKILL: Use superpowers:test-driven-development"));
      const target = clean("test-driven-development");
      const report = assess([needy, target]);
      const by = (name: string) => report.skills.find((s) => s.name === name)!;
      expect(by("systematic-debugging").blockers).toEqual(["requires-skill"]);
      expect(by("test-driven-development")).toEqual(one(target));
      expect(by("test-driven-development").status).toBe("candidate");
    });
    it("an imperative reference without a marker excludes", () => {
      expect(one(skillOf("test-driven-development", withLine("test-driven-development", "Then use superpowers:other-skill."))).blockers).toContain("requires-skill");
      expect(one(skillOf("test-driven-development", withLine("test-driven-development", "Then follow the other-skill skill."))).blockers).toContain("requires-skill");
      expect(one(skillOf("test-driven-development", withLine("test-driven-development", "You must use a review skill."))).blockers).toContain("requires-skill");
    });
    it("a plain mention is only reported, and once", () => {
      const a = one(skillOf("test-driven-development", withLine("test-driven-development", "Compare superpowers:other-skill.")));
      expect(a.status).toBe("candidate");
      expect(codes(a)).toEqual(["mentions-skill"]);
      const req = one(skillOf("test-driven-development", withLine("test-driven-development", "Use superpowers:other-skill.")));
      expect(codes(req)).toEqual(["requires-skill"]);
    });
  });

  it("assesses a skill the same alone, in a mixed import and shuffled, and does not change its input", () => {
    const names = Object.keys(CLEAN);
    const skills = names.map((n) => clean(n));
    skills.push(skillOf("test-driven-development", withLine("test-driven-development", "Dispatch a subagent."), { folder: "tdd-two" }));
    const copy = JSON.stringify(skills);
    const report = assess(skills);
    expect(JSON.stringify(skills)).toBe(copy);
    expect(JSON.stringify(assess([...skills].reverse()))).toBe(JSON.stringify(report));
    for (const s of skills) {
      const alone = one(s);
      expect(report.skills.find((x) => x.root === s.provenance.root)).toEqual(alone);
    }
    expect(report.skills.map((s) => s.id)).toEqual(report.skills.map((s) => s.id).sort());
  });

  describe("budget", () => {
    const row = profile.skills["verification-before-completion"]!;
    const padded = (extra: number) => {
      let n = 0;
      const tokens = (k: number) => estimateTokens(`Workflow skill verification-before-completion.\n${CLEAN["verification-before-completion"]}\n${"a".repeat(k)}`);
      while (tokens(n) < row.maxTokens) n++;
      return skillOf("verification-before-completion", `${CLEAN["verification-before-completion"]}\n${"a".repeat(n + extra)}`);
    };
    it("passes at the limit and is excluded one token over", () => {
      const at = padded(0);
      expect(at.provenance.context.instructions).toBe(row.maxTokens);
      expect(one(at).status).toBe("candidate");
      const over = padded(4);
      expect(over.provenance.context.instructions).toBe(row.maxTokens + 1);
      expect(one(over).blockers).toEqual(["context-over-budget"]);
    });
    it("renders and evaluates within payloadMax at the limit", () => {
      const skill = padded(0);
      const a = one(skill);
      const pkg = declaredPackage(skill, a);
      const rendered = renderSkillPayload(
        [{ id: pkg.id, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
        { maxTokens: a.declaration!.context.payloadMax },
      );
      expect(rendered.loaded).toEqual([`${pkg.id}@${pkg.version}`]);
      expect(rendered.estimatedTokens).toBeLessThanOrEqual(a.declaration!.context.payloadMax);
      const runOf = (id: string): SkillEvalRun => ({
        status: "succeeded",
        skillLock: { version: 1, lockDigest: pkg.digest, planHash: pkg.digest, createdAt: "2026-10-01T00:00:00.000Z", estimatedTokens: rendered.estimatedTokens, skills: [{ id, version: pkg.version, digest: pkg.digest, selection: "requested" }] },
        history: [{ id: "impl", type: "claude", ok: true, output: "", skills: { loaded: rendered.loaded, bytes: rendered.bytes, estimatedTokens: rendered.estimatedTokens, state: "loaded" } }] as unknown as SkillEvalRun["history"],
      });
      const ok = evaluateSkillRun(runOf(pkg.id), SkillExpectSchema.parse({ selected: [pkg.id], max_tokens: a.declaration!.context.payloadMax }));
      expect(ok.ok).toBe(true);
      expect(evaluateSkillRun(runOf(pkg.id), SkillExpectSchema.parse({ selected: [pkg.id], max_tokens: rendered.estimatedTokens - 1 })).context.ok).toBe(false);
      // An excluded skill is not selected in the run.
      expect(evaluateSkillRun({ status: "succeeded", history: [] }, SkillExpectSchema.parse({ absent: [pkg.id] })).ok).toBe(true);
    });
  });

  describe("flows", () => {
    const tdd = () => clean("test-driven-development");
    it("an unknown flow is reported, and a known one still counts", () => {
      const a = one(tdd(), FLOWS.filter((f) => f.name !== "issue-gitflow"));
      expect(codes(a)).toContain("flow-unknown");
      expect(a.status).toBe("candidate");
      expect(a.declaration!.flows).toEqual(["issue-code-daily"]);
    });
    it("a flow with skills off is incompatible", () => {
      const a = one(tdd(), [flow("issue-code-daily", [step("impl")], "off"), flow("issue-gitflow", [step("impl")], "off")]);
      expect(a.blockers).toEqual(["no-compatible-flow"]);
      expect(a.findings.find((f) => f.code === "flow-incompatible")?.evidence).toBe("the flow has skills off");
    });
    it("a shell step with skills: catalog does not receive the skill", () => {
      const only = flow("issue-code-daily", [step("impl", { mode: "catalog" })]);
      const a = one(tdd(), [only, flow("issue-gitflow", [step("impl", { mode: "off" })])]);
      expect(a.blockers).toEqual(["no-compatible-flow"]);
    });
    const capsOf = (shell: boolean, write: boolean) => ({ shell, network: false, filesystem: write ? ("write" as const) : ("read" as const), sources: { shell: "", network: "", filesystem: "" } });
    it("a receiving step without a shell does not count, with the reason", () => {
      const noShell = (name: string) => flow(name, [step("impl", { capabilities: capsOf(false, true) })]);
      const a = one(tdd(), [noShell("issue-code-daily"), noShell("issue-gitflow")]);
      expect(a.blockers).toEqual(["no-compatible-flow"]);
      expect(a.findings.find((f) => f.code === "flow-incompatible")?.evidence).toBe("no receiving step gives a shell and write access");
      const review = one(clean("verification-before-completion"), [noShell("issue-code-daily"), noShell("issue-gitflow")]);
      expect(review.findings.find((f) => f.code === "flow-incompatible")?.evidence).toBe("no receiving step gives a shell");
    });
    it("capabilities of different steps are not combined", () => {
      const split = (name: string) => flow(name, [step("run", { capabilities: capsOf(true, false) }), step("edit", { capabilities: capsOf(false, true) })]);
      const a = one(tdd(), [split("issue-code-daily"), split("issue-gitflow")]);
      expect(a.blockers).toEqual(["no-compatible-flow"]);
      const whole = (name: string) => flow(name, [step("run", { capabilities: capsOf(true, false) }), step("both", { capabilities: capsOf(true, true) })]);
      expect(one(tdd(), [whole("issue-code-daily"), whole("issue-gitflow")]).status).toBe("candidate");
    });
    it("a reviewer step does not receive a coder skill", () => {
      const a = one(tdd(), [flow("issue-code-daily", [step("r", { role: "reviewer" })]), flow("issue-gitflow", [step("r", { role: "reviewer" })])]);
      expect(a.blockers).toEqual(["no-compatible-flow"]);
    });
    it("a planner-only declaration has no receiving step even in a coder flow", () => {
      const a = one(clean("writing-plans"), [flow("issue-plan", [step("impl")])]);
      expect(a.blockers).toEqual(["no-compatible-flow"]);
    });
  });

  describe("limits", () => {
    it("cuts the findings at the limit and counts the rest", () => {
      const lines = Array.from({ length: 60 }, (_, i) => `Compare superpowers:skill-${i}.`).join("\n");
      const a = one(skillOf("test-driven-development", `${CLEAN["test-driven-development"]}\n${lines}`));
      expect(a.findings).toHaveLength(WORKFLOW_LIMITS.findings);
      expect(a.omitted).toBe(10);
      expect(a.status).toBe("candidate");
    });
    it("a hidden exclusion still excludes and is shown first", () => {
      const lines = Array.from({ length: 55 }, (_, i) => `Compare superpowers:skill-${i}.`).join("\n");
      const a = one(skillOf("test-driven-development", `${CLEAN["test-driven-development"]}\n${lines}`, { files: { "references/z.md": "Create a git worktree.\n" } }));
      expect(a.status).toBe("excluded");
      expect(a.blockers).toEqual(["assumes-worktrees"]);
      expect(workflowBlockers(a)).toEqual(["assumes-worktrees"]);
      expect(a.findings).toHaveLength(WORKFLOW_LIMITS.findings);
      expect(a.findings[0]!.code).toBe("assumes-worktrees");
      expect(a.omitted).toBe(6);
    });
  });

  describe("identity", () => {
    it("declaredPackage and workflowProvenance refuse an excluded skill", () => {
      const skill = skillOf("test-driven-development", withLine("test-driven-development", "Dispatch a subagent."));
      const a = one(skill);
      expect(() => declaredPackage(skill, a)).toThrow(TypeError);
      expect(() => workflowProvenance(skill, a)).toThrow(TypeError);
    });
    it("refuse an assessment of another skill", () => {
      const skill = clean("test-driven-development");
      const a = one(skill);
      const otherRoot = skillOf("test-driven-development", CLEAN["test-driven-development"]!, { folder: "elsewhere" });
      const otherId = clean("systematic-debugging");
      const changed = skillOf("test-driven-development", CLEAN["test-driven-development"]! + "\nMore.");
      for (const wrong of [otherRoot, otherId, changed]) {
        expect(() => declaredPackage(wrong, a)).toThrow(TypeError);
        expect(() => workflowProvenance(wrong, a)).toThrow(TypeError);
      }
      expect(changed.package.id).toBe(skill.package.id);
      expect(changed.package.digest).not.toBe(skill.package.digest);
    });
    it("builds a package with exactly the declared profile", () => {
      const skill = skillOf("test-driven-development", CLEAN["test-driven-development"]!, { frontmatter: "license: MIT\n" });
      const a = one(skill);
      const pkg = declaredPackage(skill, a);
      expect(pkg.tool_profile).toEqual({ shell: true, network: false, filesystem: "write" });
      expect(pkg.connectors).toEqual([]);
      expect(pkg.roles).toEqual(["coder"]);
      expect(pkg.capabilities).toContain("tdd-workflow");
      expect(pkg.risk).toBe("medium");
      expect(pkg.allowedTools).toBeUndefined();
      expect([pkg.id, pkg.version, pkg.digest, pkg.instructions]).toEqual([skill.package.id, skill.package.version, skill.package.digest, skill.package.instructions]);
      expect(workflowProvenance(skill, a)).toEqual(a.declaration);
      expect(workflowProvenance(skill, a)).not.toBe(a.declaration);
    });
  });

  it("escapes a control character in the evidence", () => {
    const b = one(skillOf("test-driven-development", withLine("test-driven-development", "Dispatch the\u0007 agent now.")));
    const f = b.findings.find((x) => x.code === "assumes-subagents")!;
    expect(f.evidence).not.toContain("\u0007");
    expect(f.evidence.startsWith("Assumes subagents: Dispatch the")).toBe(true);
  });

  it("assesses a crafted 60 kB text within the time bound", () => {
    const text = ("run " + "a ".repeat(10) + "dispatch ").repeat(1500);
    const t = performance.now();
    one(skillOf("test-driven-development", text, { files: { "references/big.md": text } }));
    expect(performance.now() - t).toBeLessThan(2000);
  });
});

describe("activation and regression", () => {
  const registered = (pkg: ReturnType<typeof declaredPackage>) =>
    ({ key: `${pkg.id}@${pkg.version}`, id: pkg.id, version: pkg.version, source: "admin", label: "x", dir: "/d", active: true, trust: "approved", pin: "pinned", digest: pkg.digest, pkg }) as unknown as RegisteredSkill;
  const reg = (s: RegisteredSkill) => ({ skills: [s], byKey: new Map([[s.key, s]]), problems: [] });

  it("a candidate resolves for the coder, renders within payloadMax and is refused for another role", () => {
    const skill = clean("test-driven-development");
    const a = one(skill);
    const pkg = declaredPackage(skill, a);
    expect(skillContextTokens(pkg)).toBe(skill.provenance.context.instructions);
    const r = resolveSkills(reg(registered(pkg)), [pkg.id], { role: "coder" });
    expect(r.selected.map((s) => s.id)).toEqual([pkg.id]);
    const p = renderSkillPayload(
      [{ id: pkg.id, version: pkg.version, digest: pkg.digest, selection: "requested", requiredBy: [], description: pkg.description, instructions: pkg.instructions }],
      { maxTokens: RESOLVE_DEFAULTS.maxTokens },
    );
    expect(p.estimatedTokens).toBeLessThanOrEqual(a.declaration!.context.payloadMax);
    const other = resolveSkills(reg(registered(pkg)), [pkg.id], { role: "tester" });
    expect(other.decisions.find((d) => d.id === pkg.id)?.code).toBe("role");
    void ORIGIN;
  });
  it("a package with roles [planner] is refused by the coder resolve", () => {
    const pkg = { ...declaredPackage(clean("test-driven-development"), one(clean("test-driven-development"))), roles: ["planner" as const] };
    const r = resolveSkills(reg(registered(pkg)), [pkg.id], { role: "coder" });
    expect(r.decisions.find((d) => d.id === pkg.id)?.code).toBe("role");
  });
});
