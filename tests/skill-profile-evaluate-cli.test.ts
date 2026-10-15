import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { skillsCommand, SKILLS_USAGE } from "../src/skills/cli.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport, readStagedImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { normalizeImport, sourceQualifiedId } from "../src/skills/normalize.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const TODAY = "2026-10-13";
const NOW = "2026-10-01T10:00:00Z";
const KEY = "github.com/example/skills";
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
// built from pieces: tools/secret-scan reads this file too
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
const BENIGN: Record<string, string> = { LICENSE: MIT, "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") };

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}
const SOURCES = [
  "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", "    status: enabled",
  `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: verified",
  "    licence: {allow: [MIT]}", "    update: {cadence: weekly}", "    owner: '@octocat'",
  `    review: {by: '@octocat', on: '2026-01-01', commit: '${COMMIT}', licence: MIT}`, "",
].join("\n");

const made: string[] = [];
let home: string;
let cwd: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "profeval-cli-")));
  made.push(d);
  return d;
};
beforeEach(() => {
  home = fresh();
  cwd = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), SOURCES);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function source(): SkillLibrarySource {
  const r = readSources(join(cwd, "skill-sources.yaml"));
  if (r.state !== "ok") throw new Error("bad sources");
  return r.manifest.sources[0]!;
}
const stage = (files: Record<string, string>) => {
  const t = tree(files);
  const prep = prepareImport(source(), t);
  const licence = prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t));
  return publishImport(addLicenceEvidence(prep, licence, NOW), { home });
};
function digestOf(name: string): string {
  const s = readStagedImport("lib", COMMIT, { home });
  if (s.state !== "ok") throw new Error("not staged");
  return normalizeImport({ record: { ...s.record, rejected: [] }, files: s.files }).skills.find((k) => k.provenance.name === name)!.package.digest;
}
const idOf = (name: string) => sourceQualifiedId({ source: "lib", repositoryKey: KEY }, name);

interface Prof { name: string; extra?: string }
function profiles(list: Prof[], name = "skill-source-profiles.yaml") {
  const lines = ["schema: 1", "sources:", "  - id: lib", "    skills:"];
  for (const p of list) lines.push(`      - name: ${p.name}`, "        class: portable", `        capabilities: [cap-${p.name}]`, ...(p.extra ? p.extra.split("\n").map((l) => `        ${l}`) : []));
  writeFileSync(join(cwd, name), lines.join("\n") + "\n");
}
function records(list: { name: string; kind?: string; over?: Record<string, string> }[]) {
  const lines = ["schema: 1", "evaluations:"];
  for (const r of list) {
    const e = { skill: idOf(r.name), digest: digestOf(r.name), kind: r.kind ?? "correctness", verdict: "passed", owner: "@octocat", reviewed: "2026-10-01", expires: "2027-01-01", ...r.over };
    Object.entries(e).forEach(([k, v], i) => lines.push(`${i === 0 ? "  - " : "    "}${k}: '${v}'`));
  }
  writeFileSync(join(cwd, "skill-profile-evaluations.yaml"), lines.join("\n") + "\n");
}
async function evaluate(operands: string[] = ["lib"]) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: ["profiles", "evaluate", ...operands], values: {} }, (l) => void lines.push(l), { cwd, home, today: TODAY });
  return { code, lines, text: lines.join("\n") };
}
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const st = statSync(p);
    return e.isDirectory() ? [`${p} ${st.mode} ${st.mtimeMs}`, ...snapshot(p)] : [`${p} ${st.mode} ${st.mtimeMs} ${readFileSync(p).toString("hex")}`];
  });

describe("scf skills profiles evaluate", () => {
  it("prints PASS with class, capabilities, high-risk capabilities and digest, then NEEDS (names only) and a summary", async () => {
    stage(BENIGN);
    profiles([
      { name: "a", extra: "high_risk: [cap-a]\nrequires:\n  config: [DATABASE_URL]\n  live_services: [postgres]" },
      { name: "b" },
    ]);
    const r = await evaluate();
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`PASS ${idOf("a")} (a) portable capabilities=cap-a high_risk=cap-a ${digestOf("a")}`);
    expect(r.lines).toContain(`PASS ${idOf("b")} (b) portable capabilities=cap-b high_risk=- ${digestOf("b")}`);
    expect(r.lines).toContain(`NEEDS ${idOf("a")} config=DATABASE_URL live_services=postgres`);
    expect(r.lines.some((l) => l.startsWith(`NEEDS ${idOf("b")}`))).toBe(false);
    expect(r.lines.at(-1)).toMatch(/^EVALUATED 2 skills from github\.com\/example\/skills@aaaaaaaaaaaa sha256:[0-9a-f]{64}: 2 pass, 0 blocked, 0 missing$/);
  });

  it("a blocked skill exits 1 and shows its digest, which a record can then use to pass", async () => {
    stage(BENIGN);
    profiles([{ name: "a", extra: "evaluations: [correctness]" }, { name: "b" }]);
    const first = await evaluate();
    expect(first.code).toBe(1);
    const line = first.lines.find((l) => l.startsWith("BLOCKED "))!;
    expect(line).toContain(`BLOCKED ${idOf("a")} (a) portable capabilities=cap-a high_risk=- ${digestOf("a")}: evaluation: correctness not recorded`);
    const [, id, digest] = /^BLOCKED (\S+) \(a\) \S+ capabilities=\S+ high_risk=\S+ (sha256:[0-9a-f]{64}): /.exec(line)!;
    writeFileSync(
      join(cwd, "skill-profile-evaluations.yaml"),
      `schema: 1\nevaluations:\n  - skill: ${id}\n    digest: '${digest}'\n    kind: correctness\n    verdict: passed\n    owner: '@octocat'\n    reviewed: 2026-10-01\n    expires: 2027-01-01\n`,
    );
    const second = await evaluate();
    expect(second.text).not.toContain("PROBLEM");
    expect(second.code).toBe(0);
    expect(second.lines.some((l) => l.startsWith(`PASS ${idOf("a")}`))).toBe(true);
  });

  it("blocks a staged skill with no profile entry, and reports a profile entry with no staged skill without failing", async () => {
    stage(BENIGN);
    profiles([{ name: "a" }, { name: "gone" }]);
    const r = await evaluate();
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith(`BLOCKED ${idOf("b")} (b) - capabilities=- high_risk=- ${digestOf("b")}: `) && l.endsWith("declared: not in skill-source-profiles.yaml"))).toBe(true);
    expect(r.lines).toContain("MISSING lib/gone: in skill-source-profiles.yaml, not staged");
    expect(r.lines.at(-1)).toContain("1 pass, 1 blocked, 1 missing");
  });

  it("MISSING alone exits 0", async () => {
    stage({ LICENSE: MIT, "skills/a/SKILL.md": md("a") });
    profiles([{ name: "a" }, { name: "gone" }]);
    const r = await evaluate();
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.startsWith("MISSING lib/gone"))).toBe(true);
  });

  it("an invalid records file prints PROBLEM lines, no verdicts, and exits 1", async () => {
    stage(BENIGN);
    profiles([{ name: "a" }, { name: "b" }]);
    writeFileSync(join(cwd, "skill-profile-evaluations.yaml"), "schema: 1\nevaluations:\n  - skill: lib-a\n");
    const r = await evaluate();
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("PROBLEM skill-profile-evaluations.yaml evaluations[0] (")) || r.lines.some((l) => l.startsWith("PROBLEM skill-profile-evaluations.yaml evaluations[0]"))).toBe(true);
    expect(r.text).not.toMatch(/^(PASS|BLOCKED|EVALUATED)/m);
  });

  it("an invalid or missing profiles file prints PROBLEM and nothing is evaluated", async () => {
    stage(BENIGN);
    let r = await evaluate();
    expect(r.lines).toEqual(["PROBLEM the source profile file does not exist"]);
    expect(r.code).toBe(1);
    writeFileSync(join(cwd, "skill-source-profiles.yaml"), "schema: 2\nsources: []\n");
    r = await evaluate();
    expect(r.code).toBe(1);
    expect(r.lines.every((l) => l.startsWith("PROBLEM skill-source-profiles.yaml "))).toBe(true);
    expect(r.text).not.toMatch(/^(PASS|BLOCKED)/m);
  });

  it("a source without a profile entry blocks every skill as not declared", async () => {
    stage(BENIGN);
    writeFileSync(join(cwd, "skill-source-profiles.yaml"), "schema: 1\nsources:\n  - id: other\n    skills:\n      - name: a\n        class: portable\n        capabilities: [cap-a]\n");
    const r = await evaluate();
    expect(r.code).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("BLOCKED ") && l.includes("declared: not in skill-source-profiles.yaml"))).toHaveLength(2);
  });

  it("prints the names of required configuration, never a value from the environment", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://user:" + TOKEN + "@db.example.io/app");
    stage(BENIGN);
    profiles([{ name: "a", extra: "requires:\n  config: [DATABASE_URL]" }, { name: "b" }]);
    const r = await evaluate();
    expect(r.text).toContain("config=DATABASE_URL");
    expect(r.text).not.toContain(TOKEN);
    expect(r.text).not.toContain("db.example.io");
  });

  it("prints no credential from a YAML file and no warning", async () => {
    stage(BENIGN);
    profiles([{ name: "a" }, { name: "b" }]);
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    writeFileSync(join(cwd, "skill-profile-evaluations.yaml"), `schema: 1\nevaluations:\n  - skill: !secret ${TOKEN}\n`);
    const r = await evaluate();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(r.text).not.toContain(TOKEN);
  });

  it("reads only: the data folder and the working folder are unchanged", async () => {
    stage(BENIGN);
    profiles([{ name: "a" }, { name: "b" }]);
    records([{ name: "a" }]);
    const before = [...snapshot(home), ...snapshot(cwd)];
    await evaluate();
    expect([...snapshot(home), ...snapshot(cwd)]).toEqual(before);
  });

  it("refuses bad syntax before reading anything", async () => {
    await expect(evaluate([])).rejects.toThrow(SKILLS_USAGE);
    await expect(evaluate(["Not A Source"])).rejects.toThrow(SKILLS_USAGE);
    await expect(evaluate(["lib", "extra"])).rejects.toThrow(SKILLS_USAGE);
  });

  it("the usage lists the command", () => {
    expect(SKILLS_USAGE).toContain("scf skills profiles evaluate <source-id>");
  });
});
