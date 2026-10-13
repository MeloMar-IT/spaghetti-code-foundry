import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillsCommand, SKILLS_USAGE } from "../src/skills/cli.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { sourceQualifiedId } from "../src/skills/normalize.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";
import { CLEAN } from "./fixtures/skill-workflow.js";

const COMMIT = "a".repeat(40);
const KEY = "github.com/obra/superpowers";
const md = (name: string, body: string) => `---\nname: ${name}\ndescription: Workflow skill ${name}.\n---\n\n${body}\n`;
// built from pieces: tools/secret-scan reads this file too
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const FILES: Record<string, string> = {
  "skills/test-driven-development/SKILL.md": md("test-driven-development", CLEAN["test-driven-development"]!),
  "skills/systematic-debugging/SKILL.md": md("systematic-debugging", `${CLEAN["systematic-debugging"]}\nDispatch a subagent for each cause.\nCreate a git worktree first.`),
  "skills/brainstorming/SKILL.md": md("brainstorming", "Ask questions."),
  "skills/writing-plans/SKILL.md": md("writing-plans", CLEAN["writing-plans"]!),
};
const sources = (repo: string) =>
  [
    "schema: 1",
    "sources:",
    "  - id: sp",
    `    repository: https://${repo}`,
    "    status: enabled",
    `    ref: {track: main, approved: '${COMMIT}'}`,
    "    paths: [skills]",
    "    adapter: agent-skills",
    "    trust: community",
    "    licence: {allow: [MIT]}",
    "    update: {cadence: weekly}",
    "    owner: '@octocat'",
    "",
  ].join("\n");

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}

const made: string[] = [];
let home: string;
let cwd: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillassess-")));
  made.push(d);
  return d;
};
beforeEach(() => {
  home = fresh();
  cwd = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), sources(KEY));
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function source(): SkillLibrarySource {
  const r = readSources(join(cwd, "skill-sources.yaml"));
  if (r.state !== "ok") throw new Error("bad sources");
  return r.manifest.sources[0]!;
}
const stage = (files: Record<string, string>) => publishImport(prepareImport(source(), tree(files)), { home });
async function assess(operands: string[] = ["sp"], values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: ["assess", ...operands], values }, (l) => void lines.push(l), { cwd, home });
  return { code, lines, text: lines.join("\n") };
}
const idOf = (name: string) => sourceQualifiedId({ source: "sp", repositoryKey: KEY }, name);
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const st = statSync(p);
    return e.isDirectory() ? [`${p} ${st.mode} ${st.mtimeMs}`, ...snapshot(p)] : [`${p} ${st.mode} ${st.mtimeMs} ${readFileSync(p).toString("hex")}`];
  });

describe("scf skills assess", () => {
  it("prints candidates, conflicts, exclusions and the summary, and exits 0", async () => {
    stage(FILES);
    const before = [...snapshot(home), ...snapshot(cwd)];
    const r = await assess();
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`CANDIDATE ${idOf("test-driven-development")} (test-driven-development): tools shell,write; roles coder; flows issue-code-daily,issue-gitflow; context ${r.text.match(/context (\d+)\/5000/)![1]}/5000`);
    expect(r.lines.some((l) => l.startsWith(`CONFLICT assumes-subagents exclude ${idOf("systematic-debugging")} SKILL.md:`))).toBe(true);
    expect(r.lines).toContain(`EXCLUDED ${idOf("systematic-debugging")} (systematic-debugging): assumes-subagents, assumes-worktrees`);
    expect(r.lines).toContain(`EXCLUDED ${idOf("brainstorming")} (brainstorming): not-selected`);
    expect(r.lines).toContain(`EXCLUDED ${idOf("writing-plans")} (writing-plans): no-compatible-flow`);
    expect(r.lines.at(-1)).toMatch(new RegExp(`^ASSESSED 4 skills from ${KEY.replace(/\./g, "\\.")}@aaaaaaaaaaaa sha256:[0-9a-f]{64} with profile superpowers: 1 candidate, 3 excluded$`));
    expect([...snapshot(home), ...snapshot(cwd)]).toEqual(before);
  });

  it("a skill that is not normalized is excluded by folder, without showing the credential", async () => {
    stage({ ...FILES, "skills/test-driven-development/references/x.md": "token " + TOKEN });
    const r = await assess();
    expect(r.code).toBe(0);
    expect(r.text).not.toContain(TOKEN);
    expect(r.lines.some((l) => l.startsWith("EXCLUDED skills/test-driven-development: not normalized ("))).toBe(true);
  });

  it("a source of another repository has no profile", async () => {
    writeFileSync(join(cwd, "skill-sources.yaml"), sources("github.com/example/skills"));
    stage(FILES);
    const r = await assess();
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["PROBLEM no workflow profile for github.com/example/skills"]);
  });

  it("gives one PROBLEM and assesses nothing without a staged import, for an unknown source and for a tampered import", async () => {
    const none = await assess();
    expect(none.code).toBe(1);
    expect(none.lines).toHaveLength(1);
    expect(none.lines[0]).toContain("no staged import of sp");
    expect((await assess(["other"])).lines).toEqual(["PROBLEM unknown source other"]);
    const { dir } = stage(FILES);
    writeFileSync(join(dir, "files", "skills", "brainstorming", "SKILL.md"), md("brainstorming", "Changed."));
    const tampered = await assess();
    expect(tampered.code).toBe(1);
    expect(tampered.lines).toHaveLength(1);
    expect(tampered.lines[0]).toMatch(/^PROBLEM the staged import does not match import\.json: .*nothing was scanned$/);
  });

  it("checks its syntax first", async () => {
    for (const bad of [[], ["a", "b"], ["Not A Source"]]) await expect(assess(bad)).rejects.toThrow(SKILLS_USAGE);
    await expect(assess(["sp"], { replace: true })).rejects.toThrow("unexpected option --replace");
  });
});
