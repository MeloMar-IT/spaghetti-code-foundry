import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILLS_USAGE, skillsCommand } from "../src/skills/cli.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { sourceQualifiedId } from "../src/skills/normalize.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const NOW = new Date("2026-10-15T00:00:00Z");
const md = (name: string, front = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${front}---\n\nBody.\n`;
const TREE: Record<string, string> = {
  "skills/tx/SKILL.md": md("tx", "tags: [spring-boot, transactions]\n"),
  "skills/web/SKILL.md": md("web", "tags: [spring-boot, web]\n"),
  "skills/kafka/SKILL.md": md("kafka", "tags: [kafka]\n"),
};
const sources = (review: string, status = "enabled") =>
  [
    "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", `    status: ${status}`, ...(status === "enabled" ? [] : ["    reason: paused for review"]),
    `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: community",
    "    licence: {allow: [MIT]}", "    update: {cadence: weekly}", "    owner: '@octocat'", ...(review ? [`    review: {by: '@octocat', on: '2026-01-01', commit: '${review}', licence: MIT}`] : []), "",
  ].join("\n");

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}

const made: string[] = [];
let home: string;
let cwd: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillcompare-")));
  made.push(d);
  return d;
};
beforeEach(() => {
  home = fresh();
  cwd = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), sources(COMMIT));
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function source(): SkillLibrarySource {
  const r = readSources(join(cwd, "skill-sources.yaml"));
  if (r.state !== "ok") throw new Error("bad sources");
  return r.manifest.sources[0]!;
}
const stage = (files: Record<string, string> = TREE) => publishImport(prepareImport(source(), tree(files)), { home });
async function compare(operands: string[] = ["lib"], over: { values?: Record<string, unknown>; builtinRoot?: string } = {}) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: ["compare", ...operands], values: over.values ?? {} }, (l) => void lines.push(l), { cwd, home, now: NOW, today: "2026-10-15", ...(over.builtinRoot ? { builtinRoot: over.builtinRoot } : {}) });
  return { code, lines, text: lines.join("\n") };
}
const override = (capability: string, target: string) =>
  writeFileSync(
    join(cwd, "skill-overrides.yaml"),
    ["schema: 1", "overrides:", `  - capability: ${capability}`, `    target: ${target}`, "    by: '@octocat'", "    reason: reviewed by the owners", "    from: 2026-01-01T00:00:00Z", "    expires: 2027-01-01T00:00:00Z", "    scope: all", ""].join("\n"),
  );
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const st = statSync(p);
    return e.isDirectory() ? [`${p} ${st.mode} ${st.mtimeMs}`, ...snapshot(p)] : [`${p} ${st.mode} ${st.mtimeMs} ${readFileSync(p).toString("hex")}`];
  });
const keyOf = (r: { lines: string[] }, name: string) => {
  const id = sourceQualifiedId({ source: "lib", repositoryKey: "github.com/example/skills" }, name);
  const line = r.lines.find((l) => l.startsWith(`SKILL ${id}@`));
  if (!line) throw new Error(`no SKILL line for ${name}`);
  return line.split(" ")[1]!;
};

describe("scf skills compare", () => {
  it("prints the skills, one line per shared capability and the summary, and exits 0", async () => {
    stage();
    const r = await compare();
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => /^SKILL \S+ vetted-community /.test(l))).toHaveLength(3);
    expect(r.lines.filter((l) => l.startsWith("NO-OVERLAP "))).toHaveLength(1);
    expect(r.lines).toContain("RECOMMEND spring-boot-transactions spring-boot@1.0.0 (trust-tier)");
    expect(r.lines).toContain("RECOMMEND spring-boot-web spring-boot@1.0.0 (trust-tier)");
    expect(r.lines.at(-1)).toMatch(/^COMPARED 3 skills from github\.com\/example\/skills@aaaaaaaaaaaa: \d+ collisions \(0 blocking\), 0 conflicts$/);
  });

  it("prints discovery-only when the source is not enabled", async () => {
    stage();
    writeFileSync(join(cwd, "skill-sources.yaml"), sources(COMMIT, "disabled"));
    const r = await compare();
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => /^SKILL \S+ discovery-only /.test(l))).toHaveLength(3);
    expect(r.lines).toContain("RECOMMEND spring-boot-web spring-boot@1.0.0 (only-candidate)");
  });

  it("an owner override with scope all picks the imported skill", async () => {
    stage({ "skills/tx/SKILL.md": TREE["skills/tx/SKILL.md"]! });
    const key = keyOf(await compare(), "tx");
    override("spring-boot-transactions", key);
    const r = await compare();
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`RECOMMEND spring-boot-transactions ${key} (owner-override)`);
  });

  it("an override that cannot win every capability of its skill prints CONFLICT and exits 1", async () => {
    stage({ ...TREE, "skills/both/SKILL.md": md("both", "tags: [spring-boot, transactions, web]\n") });
    const key = keyOf(await compare(), "both");
    override("spring-boot-transactions", key);
    const r = await compare();
    expect(r.code).toBe(1);
    expect(r.lines).toContain("CONFLICT spring-boot-transactions winners-overlap");
    expect(r.lines).toContain("CONFLICT spring-boot-web winners-overlap");
    expect(r.lines.some((l) => l.startsWith("NOTE skills not resolved: "))).toBe(true);
  });

  it("a stale skill is excluded and exits 0", async () => {
    stage({ ...TREE, "skills/old/SKILL.md": md("old", "tags: [spring-boot, web]\n"), "skills/old/skill.yaml": "technologies: {spring-boot: '^2'}\n" });
    const r = await compare();
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => /^EXCLUDED \S+ stale$/.test(l))).toBe(true);
  });

  it("an invalid overrides file is a PROBLEM", async () => {
    stage();
    writeFileSync(join(cwd, "skill-overrides.yaml"), "schema: 2\n");
    const r = await compare();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^PROBLEM /);
    expect(r.text).not.toContain("COMPARED");
  });

  it("no staged import and an unknown source are PROBLEMs", async () => {
    const none = await compare();
    expect(none.code).toBe(1);
    expect(none.text).toMatch(/^PROBLEM no staged import of lib at aaaaaaaaaaaa/);
    const unknown = await compare(["nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.text).toContain("PROBLEM unknown source");
  });

  it("a folder without the built-in skills is a PROBLEM", async () => {
    stage();
    const r = await compare(["lib"], { builtinRoot: fresh() });
    expect(r.code).toBe(1);
    expect(r.lines).toEqual(["PROBLEM the built-in skill java cannot be read"]);
  });

  it("reads only: home and the working folder are unchanged", async () => {
    stage();
    override("spring-boot-web", "x-y@1.0.0");
    const before = [...snapshot(home), ...snapshot(cwd)];
    await compare();
    expect([...snapshot(home), ...snapshot(cwd)]).toEqual(before);
  });

  it("checks the syntax before reading anything", async () => {
    for (const operands of [[], ["a", "b"], ["Bad Id"]]) {
      await expect(compare(operands)).rejects.toThrow(SKILLS_USAGE);
    }
    await expect(compare(["lib"], { values: { repo: "x" } })).rejects.toThrow(SKILLS_USAGE);
  });
});
