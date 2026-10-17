import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialProblem } from "../src/skills/credential-scan.js";
import type { CollisionCandidate } from "../src/skills/collisions.js";
import { EVALUATION_THRESHOLDS } from "../src/skills/evaluation-rules.js";
import { instructionFixtureHash } from "../src/skills/evaluation-instructions.js";
import { scoreSelection } from "../src/skills/evaluation-score.js";
import { readEvaluationSuite } from "../src/skills/evaluation-suite.js";
import { buildSkillIdentity } from "../src/skills/identity.js";
import type { NormalizedSkill } from "../src/skills/normalize.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { BUILTIN_SKILLS, clearSkillRegistryCache } from "../src/skills/registry.js";

const ROOT = resolve("evals/skill-gate/typescript-node");
const FIXTURES = ["ts-service", "js-package", "java-library"];

const read = readEvaluationSuite(join(ROOT, "suite.yaml"));
if (read.state !== "ok") throw new Error(JSON.stringify(read));

/** A built-in skill as an import candidate, built as in the "shipped example suite" test. */
function builtin(name: string): CollisionCandidate {
  const dir = join(BUILTIN_SKILLS, name);
  const files = ["REVIEW.md", "SKILL.md", "skill.yaml"].map((p) => ({ path: p, content: new Uint8Array(readFileSync(join(dir, p))) }));
  const pkg = loadSkillPackage(dir);
  const identity = buildSkillIdentity({
    id: pkg.id, source: "scf", repositoryKey: "github.com/example/skills", name, version: pkg.version, versionDeclared: true, digest: pkg.digest, files,
  });
  const provenance = {
    schema: 1 as const, source: "scf", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40),
    root: `skills/${name}`, name, layout: "skill-md" as never, versionDeclared: true, dependencies: [], technologies: [], requiredTools: [],
    entryPoints: { instructions: "SKILL.md" as const, scripts: [], documents: [] }, context: { instructions: 0, text: 0 }, upstream: {},
  };
  const skill: NormalizedSkill = { package: pkg, provenance, extraFiles: [], identity };
  return { skill, approved: true, trust: "community", licencesAllowed: ["MIT"] };
}

const made: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillsuite-tsnode-")));
  made.push(d);
  return d;
};
const copy = (name: string) => {
  const d = temp();
  cpSync(join(ROOT, "fixtures", name), d, { recursive: true });
  return d;
};
const run = (cwd: string, cmd: string, env: Record<string, string> = {}) =>
  spawnSync("sh", ["-c", cmd], {
    cwd, timeout: 30000, encoding: "utf8",
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, ...env },
  });
const why = (r: ReturnType<typeof run>) => `status ${r.status}\n${r.stdout}\n${r.stderr}`;
const scripts = (dir: string) => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

describe("the TypeScript and Node.js suite file", () => {
  it("is valid and has the four offline sections", () => {
    expect(read.suite.instructions).toBeUndefined();
    // the parser gives `modules: []` when a case names none
    expect(read.suite.selection.map((s) => ({ id: s.id, repo: s.repo, task: s.task, modules: s.modules, expect: s.expect })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "java-build-release", repo: "fixtures/java-library", task: "Raise the Java release in the build to 21 and fix the compiler warnings.", modules: [], expect: "not-offered" },
      { id: "java-null-check", repo: "fixtures/java-library", task: "Make insert reject null values and describe the exception in the Javadoc.", modules: [], expect: "not-offered" },
      { id: "java-remove-node", repo: "fixtures/java-library", task: "Add a method that removes a node from the tree and keep the types of the public methods.", modules: [], expect: "not-offered" },
      { id: "js-package-to-typescript", repo: "fixtures/js-package", task: "Convert src/notify.js to TypeScript.", modules: [], expect: "offered" },
      { id: "ts-service-config", repo: "fixtures/ts-service", task: "Read the port from the environment and refuse a value that is not a port number.", modules: [], expect: "offered" },
      { id: "ts-service-endpoint", repo: "fixtures/ts-service", task: "Add an endpoint that lists every item that is out of stock.", modules: [], expect: "offered" },
      { id: "ts-service-module", repo: "fixtures/ts-service", task: "Split the report writer into a formatter and a writer.", modules: ["src"], expect: "offered" },
      { id: "ts-service-types", repo: "fixtures/ts-service", task: "Replace the type assertion in the stock event parser with a check that runs.", modules: [], expect: "offered" },
    ]);
    expect(read.suite.conflicts).toEqual([{ id: "against-approved", with: "all" }]);
    expect(read.suite.tools).toEqual([{ id: "read-only", policy: { shell: false, network: false, filesystem: "read" } }]);
    expect([...read.profiles.keys()].sort()).toEqual(["fixtures/java-library", "fixtures/js-package", "fixtures/ts-service"]);
  });

  it("has the same context limits as the example suite", () => {
    const example = readEvaluationSuite(resolve("evals/skill-gate/suite.yaml"));
    if (example.state !== "ok") throw new Error(JSON.stringify(example));
    expect(read.suite.context).toEqual(example.suite.context);
  });
});

describe("selection", () => {
  for (const name of ["typescript", "nodejs"]) {
    it(`scores 1 for the built-in ${name} skill`, () => {
      expect(scoreSelection(builtin(name), read.suite.selection, read.profiles, [])).toEqual({ sample: 1, findings: [] });
    });
  }

  it("fails a skill outside the area", () => {
    const r = scoreSelection(builtin("kafka"), read.suite.selection, read.profiles, []);
    expect(r.sample).toBeLessThan(EVALUATION_THRESHOLDS.selection);
    expect(r.findings.length).toBeGreaterThan(0);
  });
});

describe("the fixtures", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  for (const name of FIXTURES) {
    it(`${name} has no links, executables, endpoints or credentials`, () => {
      const dir = join(ROOT, "fixtures", name);
      expect(instructionFixtureHash(dir)).toHaveProperty("hash");
      for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
        expect(e.isFile() || e.isDirectory(), `${e.name} is a file or folder`).toBe(true);
      }
      for (const file of walk(dir)) {
        expect(statSync(file).mode & 0o111, `${file} is not executable`).toBe(0);
        const text = readFileSync(file, "utf8");
        expect(credentialProblem(text), file).toBeUndefined();
        expect(text, file).not.toMatch(/https?:\/\//);
      }
    });
  }
});

describe("the fixtures' own tests", () => {
  it.skipIf(!process.features.typescript)("pass for ts-service", () => {
    const dir = copy("ts-service");
    expect(scripts(dir).test).toBe('node --test "test/*.test.ts"');
    const r = run(dir, scripts(dir).test!);
    expect(r.status, why(r)).toBe(0);
  });

  it("pass for js-package", () => {
    const dir = copy("js-package");
    expect(scripts(dir).test).toBe("node --test");
    const r = run(dir, scripts(dir).test!);
    expect(r.status, why(r)).toBe(0);
  });

  it("fail for js-package when send is not called", () => {
    const dir = copy("js-package");
    const file = join(dir, "src/notify.js");
    writeFileSync(file, readFileSync(file, "utf8").replace("await send(id);", "void id;"));
    expect(run(dir, "node --test").status).not.toBe(0);
  });

  const hasJavac = spawnSync("sh", ["-c", "javac -version"], { stdio: "ignore" }).status === 0;
  it.skipIf(!hasJavac)("pass for java-library", () => {
    const dir = copy("java-library");
    const out = temp();
    const r = run(
      dir,
      'javac -d "$OUT" src/main/java/org/example/tree/Tree.java src/test/java/org/example/tree/TreeCheck.java && java -cp "$OUT" org.example.tree.TreeCheck',
      { OUT: out },
    );
    expect(r.status, why(r)).toBe(0);
  });
});
