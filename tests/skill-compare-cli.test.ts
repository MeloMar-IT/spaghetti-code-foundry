import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILLS_USAGE, skillsCommand } from "../src/skills/cli.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { normalizeImport, sourceQualifiedId } from "../src/skills/normalize.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const NOW = new Date("2026-10-15T00:00:00Z");
const md = (name: string, front = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${front}---\n\nBody.\n`;
const TREE: Record<string, string> = {
  "skills/tx/SKILL.md": md("tx", "tags: [spring-boot, transactions]\n"),
  "skills/web/SKILL.md": md("web", "tags: [spring-boot, web]\n"),
  "skills/kafka/SKILL.md": md("kafka", "tags: [kafka]\n"),
};
const sources = (review: string, status = "enabled", trust = "community") =>
  [
    "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", `    status: ${status}`, ...(status === "enabled" ? [] : ["    reason: paused for review"]),
    `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", `    trust: ${trust}`,
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
const stageWithLicence = (files: Record<string, string>) => {
  const t = tree(files);
  const prep = prepareImport(source(), t);
  const licence = prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((x) => x.root), t));
  return publishImport(addLicenceEvidence(prep, licence, NOW.toISOString()), { home });
};
const COLLECTION_DIR = "tests/fixtures/skill-sources/community-spring";
function collection(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string, rel: string) => {
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      const path = rel ? `${rel}/${d.name}` : d.name;
      if (lstatSync(join(abs, d.name)).isDirectory()) walk(join(abs, d.name), path);
      else out[path] = readFileSync(join(abs, d.name), "utf8");
    }
  };
  walk(COLLECTION_DIR, "");
  return out;
}
const STALE = "skills/spring-boot2-legacy/SKILL.md";
/** Package id and digest per staged folder, from the normalized collection. */
function packages(files: Record<string, string>): Record<string, { id: string; digest: string }> {
  const { skills } = normalizeImport(prepareImport(source(), tree(files)));
  return Object.fromEntries(skills.map((x) => [x.provenance.root, { id: x.package.id, digest: x.package.digest }]));
}
const record = (id: string, digest: string, over: { verdict?: string; reviewed?: string; expires?: string } = {}) =>
  [`  - skill: ${id}`, `    digest: ${digest}`, "    kind: fixtures", `    verdict: ${over.verdict ?? "passed"}`, "    owner: '@octocat'", `    reviewed: ${over.reviewed ?? "2026-10-01"}`, `    expires: ${over.expires ?? "2027-04-01"}`].join("\n");
const writeRecords = (...entries: string[]) => writeFileSync(join(cwd, "skill-profile-evaluations.yaml"), ["schema: 1", "evaluations:", ...entries, ""].join("\n"));
const passedAll = (files: Record<string, string>, except: string[] = []) =>
  writeRecords(...Object.entries(packages(files)).filter(([root]) => !except.includes(root)).map(([, p]) => record(p.id, p.digest)));
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
    expect(r.code).toBe(1);
    expect(r.lines.filter((l) => /^REFUSED \S+: .*fixtures-missing/.test(l))).toHaveLength(3);
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
    expect(r.code).toBe(1);
    expect(r.lines.filter((l) => /^REFUSED \S+: .*source-not-enabled/.test(l))).toHaveLength(3);
    expect(r.lines.filter((l) => /^SKILL \S+ discovery-only /.test(l))).toHaveLength(3);
    expect(r.lines).toContain("RECOMMEND spring-boot-web spring-boot@1.0.0 (only-candidate)");
  });

  it("an owner override with scope all picks the imported skill", async () => {
    stage({ "skills/tx/SKILL.md": TREE["skills/tx/SKILL.md"]! });
    const key = keyOf(await compare(), "tx");
    override("spring-boot-transactions", key);
    const r = await compare();
    expect(r.code).toBe(1);
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

  it("a stale skill is excluded and refused with version-stale", async () => {
    stage({ ...TREE, "skills/old/SKILL.md": md("old", "tags: [spring-boot, web]\n"), "skills/old/skill.yaml": "technologies: {spring-boot: '^2'}\n" });
    const r = await compare();
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => /^EXCLUDED \S+ stale$/.test(l))).toBe(true);
    expect(r.lines.some((l) => /^REFUSED \S+: .*version-stale/.test(l))).toBe(true);
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
    writeRecords();
    writeFileSync(join(cwd, "skill-scan-exceptions.yaml"), "schema: 1\nexceptions: []\n");
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

describe("scf skills compare: the promotion decision of a community source", () => {
  const lineOf = (r: { lines: string[] }, name: string) => r.lines.find((l) => l.includes(name) && /^(PROMOTABLE|REFUSED) /.test(l));
  const collectionWithoutStale = () => {
    const files = collection();
    delete files[STALE];
    return files;
  };

  it("prints PROMOTABLE for candidates with passed records and REFUSED version-stale for the stale one", async () => {
    const files = collection();
    stageWithLicence(files);
    passedAll(files);
    const r = await compare();
    const p = packages(files);
    expect(r.code).toBe(1);
    for (const [root, x] of Object.entries(p)) {
      if (root !== "skills/spring-boot2-legacy") expect(r.lines).toContain(`PROMOTABLE ${x.id}`);
    }
    const stale = lineOf(r, p["skills/spring-boot2-legacy"]!.id)!;
    expect(stale).toMatch(/^REFUSED \S+: .*version-stale/);
    expect(stale).not.toContain("fixtures-missing");
    const last = r.lines.length - 1;
    expect(r.lines[last]).toMatch(/^COMPARED /);
    expect(r.lines.findLastIndex((l) => /^(PROMOTABLE|REFUSED) /.test(l))).toBeLessThan(last);
  });

  it("exits 0 when every candidate is promotable", async () => {
    const files = collectionWithoutStale();
    stageWithLicence(files);
    passedAll(files);
    const r = await compare();
    expect(r.lines.filter((l) => l.startsWith("REFUSED "))).toEqual([]);
    expect(r.lines.filter((l) => l.startsWith("PROMOTABLE "))).toHaveLength(4);
    expect(r.code).toBe(0);
  });

  it("a candidate without a record is fixtures-missing, the others stay promotable", async () => {
    const files = collectionWithoutStale();
    stageWithLicence(files);
    passedAll(files, ["skills/java-code-review"]);
    const r = await compare();
    expect(r.code).toBe(1);
    expect(r.lines).toContain(`REFUSED ${packages(files)["skills/java-code-review"]!.id}: fixtures-missing`);
    expect(r.lines.filter((l) => l.startsWith("PROMOTABLE "))).toHaveLength(3);
  });

  it("a failed record is fixtures-failed", async () => {
    const files = collectionWithoutStale();
    stageWithLicence(files);
    const p = packages(files);
    writeRecords(...Object.entries(p).map(([root, x]) => record(x.id, x.digest, { verdict: root === "skills/java-code-review" ? "failed" : "passed" })));
    const r = await compare();
    expect(r.code).toBe(1);
    expect(r.lines).toContain(`REFUSED ${p["skills/java-code-review"]!.id}: fixtures-failed`);
  });

  it("a record for another digest is fixtures-missing", async () => {
    const files = collectionWithoutStale();
    stageWithLicence(files);
    const p = packages(files);
    writeRecords(...Object.entries(p).map(([root, x]) => record(x.id, root === "skills/java-code-review" ? "sha256:" + "0".repeat(64) : x.digest)));
    const r = await compare();
    expect(r.lines).toContain(`REFUSED ${p["skills/java-code-review"]!.id}: fixtures-missing`);
    expect(r.code).toBe(1);
  });

  it("an expired record is fixtures-missing", async () => {
    const files = collectionWithoutStale();
    stageWithLicence(files);
    const p = packages(files);
    writeRecords(...Object.entries(p).map(([root, x]) => (root === "skills/java-code-review" ? record(x.id, x.digest, { reviewed: "2025-01-01", expires: "2025-06-01" }) : record(x.id, x.digest))));
    const r = await compare();
    expect(r.lines).toContain(`REFUSED ${p["skills/java-code-review"]!.id}: fixtures-missing`);
  });

  it("an entry that did not normalize is REFUSED not-normalized before COMPARED", async () => {
    const files = { ...collectionWithoutStale(), "skills/broken/SKILL.md": md("broken", "version: not-a-version\n") };
    expect(prepareImport(source(), tree(files)).record.skills.map((x) => x.root)).toContain("skills/broken");
    stageWithLicence(files);
    const r = await compare();
    expect(r.code).toBe(1);
    const at = r.lines.indexOf("REFUSED skills/broken: not-normalized");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(r.lines.length - 1);
    expect(r.lines.at(-1)).toMatch(/^COMPARED /);
  });

  it("an invalid record file or exception file is a PROBLEM and prints no COMPARED", async () => {
    stageWithLicence(collection());
    writeFileSync(join(cwd, "skill-profile-evaluations.yaml"), "schema: 2\n");
    const a = await compare();
    expect(a.code).toBe(1);
    expect(a.lines.some((l) => l.startsWith("PROBLEM skill-profile-evaluations.yaml "))).toBe(true);
    expect(a.text).not.toContain("COMPARED");
    rmSync(join(cwd, "skill-profile-evaluations.yaml"));
    writeFileSync(join(cwd, "skill-scan-exceptions.yaml"), "schema: 2\n");
    const b = await compare();
    expect(b.code).toBe(1);
    expect(b.lines[0]).toMatch(/^PROBLEM /);
    expect(b.text).not.toContain("COMPARED");
  });

  it("an import without licence evidence is refused with licence-missing", async () => {
    const files = collection();
    stage(files);
    passedAll(files);
    const r = await compare();
    expect(r.code).toBe(1);
    expect(r.lines.filter((l) => /^REFUSED \S+: .*licence-missing/.test(l)).length).toBeGreaterThan(0);
  });

  it("another trust tier keeps the old output and ignores both reviewed files", async () => {
    writeFileSync(join(cwd, "skill-sources.yaml"), sources(COMMIT, "enabled", "verified"));
    stage();
    writeFileSync(join(cwd, "skill-profile-evaluations.yaml"), "schema: 2\n");
    writeFileSync(join(cwd, "skill-scan-exceptions.yaml"), "schema: 2\n");
    const r = await compare();
    expect(r.code).toBe(0);
    expect(r.text).not.toMatch(/PROMOTABLE|REFUSED|PROBLEM/);
    expect(r.lines.at(-1)).toMatch(/^COMPARED /);
  });
});
