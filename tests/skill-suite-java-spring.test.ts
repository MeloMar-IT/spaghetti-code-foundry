import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { detectIntegrationCandidates } from "../src/skills/integration-candidates.js";
import { detectSkillCandidates } from "../src/skills/candidates.js";
import type { CollisionCandidate } from "../src/skills/collisions.js";
import { credentialProblem, riskyFileName } from "../src/skills/credential-scan.js";
import { instructionFixtureHash } from "../src/skills/evaluation-instructions.js";
import { scoreSelection } from "../src/skills/evaluation-score.js";
import { readEvaluationSuite } from "../src/skills/evaluation-suite.js";
import { normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";

const SUITE = fileURLToPath(new URL("../evals/skill-gate/java-spring/suite.yaml", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../evals/skill-gate/suite.yaml", import.meta.url));
const ORDERS = fileURLToPath(new URL("../evals/skill-gate/java-spring/fixtures/orders-service", import.meta.url));
const WEB = fileURLToPath(new URL("../evals/skill-gate/java-spring/fixtures/web-tool", import.meta.url));

const tmps: string[] = [];
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "javaspring-")));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

type F = { path: string; content: Uint8Array };
const A: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) };
const f = (path: string, text: string): F => ({ path, content: new Uint8Array(Buffer.from(text)) });
const doc = (name: string) => f("SKILL.md", `---\nname: ${name}\ndescription: About ${name}.\n---\n\nBody.\n`);
const yaml = (text: string) => f("skill.yaml", text);
const skill = (files: F[]): NormalizedSkill => {
  const r = normalizeSkill(A, { root: "skills/x", files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
};
const cand = (s: NormalizedSkill): CollisionCandidate => ({ skill: s, approved: false, trust: "community", licencesAllowed: ["MIT"] });

function suiteRead() {
  const read = readEvaluationSuite(SUITE);
  if (read.state !== "ok") throw new Error(JSON.stringify(read));
  return read;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe("the suite file", () => {
  it("is read as ok with the expected cases", () => {
    const { suite } = suiteRead();
    const offered = suite.selection.filter((s) => s.expect === "offered");
    const not = suite.selection.filter((s) => s.expect === "not-offered");
    expect(suite.selection).toHaveLength(9);
    expect(offered).toHaveLength(7);
    expect(offered.every((s) => s.repo === "fixtures/orders-service")).toBe(true);
    expect(not).toHaveLength(2);
    expect(not.every((s) => s.repo === "fixtures/web-tool")).toBe(true);
    expect(suite.instructions).toBeUndefined();
  });

  it("has the same conflicts, tools and context as the example suite", () => {
    const { suite } = suiteRead();
    const example = readEvaluationSuite(EXAMPLE);
    if (example.state !== "ok") throw new Error(JSON.stringify(example));
    expect(suite.context).toEqual(example.suite.context);
    expect(suite.context).toEqual([{ id: "coder-budget", max_instruction_tokens: 3000, max_description_chars: 160 }]);
    expect(suite.conflicts).toEqual([{ id: "against-approved", with: "all" }]);
    expect(suite.tools).toEqual([{ id: "read-only", policy: { shell: false, network: false, filesystem: "read" } }]);
  });

  it("keeps words that could match a capability out of the not-offered tasks", () => {
    const { suite } = suiteRead();
    for (const s of suite.selection.filter((x) => x.expect === "not-offered"))
      expect(s.task).not.toMatch(/\b(?:java|spring\s*boot|maven|gradle|jpa|log|test|review)\b/i);
  });

  it("shows java and spring-boot on the Spring Boot fixture and nothing else", () => {
    const { profiles } = suiteRead();
    const orders = profiles.get("fixtures/orders-service")!;
    const ids = detectSkillCandidates(orders).map((c) => c.skill);
    expect(ids).toContain("java");
    expect(ids).toContain("spring-boot");
    expect(detectIntegrationCandidates(orders)).toEqual([]);
    const web = detectSkillCandidates(profiles.get("fixtures/web-tool")!).map((c) => c.skill);
    expect(web).not.toContain("java");
    expect(web).not.toContain("spring-boot");
  });
});

describe("selection scores", () => {
  const score = (capabilities: string) => {
    const { suite, profiles } = suiteRead();
    return scoreSelection(cand(skill([doc("notes"), yaml(`capabilities: [${capabilities}]\n`)])), suite.selection, profiles, []);
  };

  it("passes a java skill", () => {
    expect(score("java")).toEqual({ sample: 1, findings: [] });
  });
  it("passes a spring-boot skill", () => {
    expect(score("spring-boot")).toEqual({ sample: 1, findings: [] });
  });
  it("fails a kafka skill on every offered case", () => {
    const { suite } = suiteRead();
    const r = score("kafka");
    expect(r.sample).toBeLessThan(0.9);
    expect(r.sample).toBeCloseTo(2 / 9);
    expect(r.findings).toHaveLength(7);
    expect(r.findings.every((x) => x.code === "not-offered" && x.dimension === "selection")).toBe(true);
    expect(r.findings.map((x) => x.scenario).sort()).toEqual(
      suite.selection.filter((s) => s.expect === "offered").map((s) => s.id).sort());
  });
});

describe("fixtures", () => {
  for (const [name, dir] of [["orders-service", ORDERS], ["web-tool", WEB]] as const) {
    it(`${name} has no link, agent config or credential`, () => {
      const h = instructionFixtureHash(dir);
      if (!("hash" in h)) throw new Error(h.problem);
      expect(h.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      for (const p of filesUnder(dir)) {
        const rel = relative(dir, p);
        expect(riskyFileName(rel), rel).toBe(false);
        expect(credentialProblem(readFileSync(p, "utf8")), rel).toBeUndefined();
        expect(rel.split(/[\\/]/).length - 1).toBeLessThanOrEqual(8);
      }
    });
  }

  it("web-tool passes its own tests in a clean copy", () => {
    const dir = tmp();
    cpSync(WEB, dir, { recursive: true });
    const r = spawnSync(process.execPath, ["--test"], {
      cwd: dir, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_OPTIONS: "" },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  const jdk = spawnSync("javac", ["-version"], { stdio: "ignore" }).status === 0;
  if (!jdk) console.warn("skill-suite-java-spring JDK test skipped: it needs javac");

  it.skipIf(!jdk)("orders-service compiles with the plain JDK and passes its own test", () => {
    const dir = tmp();
    const out = tmp();
    cpSync(ORDERS, dir, { recursive: true });
    const files = ["src/stubs/java", "src/main/java", "src/test/java"].flatMap((d) => filesUnder(join(dir, d))).filter((p) => p.endsWith(".java"));
    const c = spawnSync("javac", ["-d", out, ...files], { encoding: "utf8", timeout: 60_000 });
    expect(c.status, c.stdout + c.stderr).toBe(0);
    const r = spawnSync("java", ["-cp", out, "com.example.orders.OrderServiceTest"], { encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("OK");
  });
});
