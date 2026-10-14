import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillsCommand, SKILLS_USAGE } from "../src/skills/cli.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { sourceQualifiedId } from "../src/skills/normalize.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const TODAY = "2026-10-13";
const NOW = "2026-10-01T10:00:00Z";
const KEY = "github.com/example/skills";
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
// built from pieces: tools/secret-scan reads this file too
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
const APACHE = readFileSync("tests/fixtures/licences/apache-2.0.txt", "utf8");
const GPL = "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n";
const BUSL = "Business Source License 1.1\nLicensor: Example\n";
const BENIGN: Record<string, string> = { "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") };

function tree(files: Record<string, string>, links: string[] = []): SourceTree {
  const all: TreeEntry[] = [
    ...Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path })),
    ...links.map((path): TreeEntry => ({ path, kind: "symlink", size: 1, id: "link:" + path })),
  ];
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}
const sourceYaml = (allow = "MIT") =>
  [
    "schema: 1",
    "sources:",
    "  - id: lib",
    "    repository: https://github.com/example/skills",
    "    status: enabled",
    `    ref: {track: main, approved: '${COMMIT}'}`,
    "    paths: [skills]",
    "    adapter: agent-skills",
    "    trust: community",
    `    licence: {allow: [${allow}]}`,
    "    update: {cadence: weekly}",
    "    owner: '@octocat'",
    "",
  ].join("\n");

const made: string[] = [];
let home: string;
let cwd: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillpromote-")));
  made.push(d);
  return d;
};
beforeEach(() => {
  home = fresh();
  cwd = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), sourceYaml());
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function source(): SkillLibrarySource {
  const r = readSources(join(cwd, "skill-sources.yaml"));
  if (r.state !== "ok") throw new Error("bad sources");
  return r.manifest.sources[0]!;
}
const stage = (files: Record<string, string>, links: string[] = []) => {
  const t = tree(files, links);
  const prep = prepareImport(source(), t);
  const licence = prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t));
  return publishImport(addLicenceEvidence(prep, licence, NOW), { home });
};
// an import staged before licence files were kept: no licence.json, no retrievedAt
const stageOld = (files: Record<string, string>) => publishImport(prepareImport(source(), tree(files)), { home });
async function check(operands: string[] = ["lib"], values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: ["promote", "check", ...operands], values }, (l) => void lines.push(l), { cwd, home, today: TODAY });
  return { code, lines, text: lines.join("\n") };
}
const idOf = (name: string) => sourceQualifiedId({ source: "lib", repositoryKey: KEY }, name);
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const st = statSync(p);
    return e.isDirectory() ? [`${p} ${st.mode} ${st.mtimeMs}`, ...snapshot(p)] : [`${p} ${st.mode} ${st.mtimeMs} ${readFileSync(p).toString("hex")}`];
  });

describe("scf skills promote check", () => {
  it("prints PROMOTABLE per allowed skill and exits 0", async () => {
    stage({ ...BENIGN, LICENSE: MIT });
    const r = await check();
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 2)).toEqual([`PROMOTABLE ${idOf("a")} skills/a MIT`, `PROMOTABLE ${idOf("b")} skills/b MIT`]);
    expect(r.lines.at(-1)).toMatch(/^CHECKED 2 skills from github\.com\/example\/skills@aaaaaaaaaaaa sha256:[0-9a-f]{64}: 2 promotable, 0 refused$/);
  });

  it("refuses with missing when there is no licence file", async () => {
    stage(BENIGN);
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^REFUSED skills\/a: missing \(/);
    expect(r.lines[1]).toMatch(/^REFUSED skills\/b: missing \(/);
    expect(r.lines.at(-1)).toContain("0 promotable, 2 refused");
  });

  it("refuses an import staged without evidence with missing for every path", async () => {
    stageOld(BENIGN);
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("REFUSED") && l.includes(": missing ("))).toHaveLength(2);
    expect(r.text).not.toContain("PROMOTABLE");
  });

  it("refuses ambiguous, review and rejected licences", async () => {
    stage({ ...BENIGN, LICENSE: "just some words\n", "skills/a/LICENSE": GPL, "skills/b/LICENSE": BUSL });
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^REFUSED skills\/a: review \(/);
    expect(r.lines[1]).toMatch(/^REFUSED skills\/b: rejected \(/);
  });

  it("refuses an unrecognised licence as ambiguous", async () => {
    stage({ ...BENIGN, LICENSE: "just some words\n" });
    const r = await check();
    expect(r.lines[0]).toMatch(/^REFUSED skills\/a: ambiguous \(/);
  });

  it("refuses a licence that is not in licence.allow", async () => {
    stage({ ...BENIGN, LICENSE: APACHE });
    const r = await check();
    expect(r.lines[0]).toMatch(/^REFUSED skills\/a: rejected \(/);
    writeFileSync(join(cwd, "skill-sources.yaml"), sourceYaml("MIT, Apache-2.0"));
    expect((await check()).code).toBe(0);
  });

  it("does not fall back to a parent licence when the nearer file is a symlink", async () => {
    stage({ "skills/a/SKILL.md": md("a"), LICENSE: MIT }, ["skills/LICENSE"]);
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^REFUSED skills\/a: ambiguous \(/);
    expect(r.text).not.toContain("PROMOTABLE");
  });

  it("an open high finding blocks", async () => {
    stage({ ...BENIGN, LICENSE: MIT, "skills/a/scripts/a.sh": "rm -rf /" });
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe("REFUSED skills/a: blocked (1 high finding)");
    expect(r.lines[1]).toBe(`PROMOTABLE ${idOf("b")} skills/b MIT`);
  });

  it("a skill that does not normalize is not-normalized and never prints the secret", async () => {
    stage({ ...BENIGN, LICENSE: MIT, "skills/a/references/x.md": "token " + TOKEN });
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^REFUSED skills\/a: not-normalized \(/);
    expect(r.text).not.toContain(TOKEN);
  });

  it("the licence status wins and the findings are added to the reasons", async () => {
    stage({ ...BENIGN, "skills/a/scripts/a.sh": "rm -rf /" });
    const r = await check();
    expect(r.lines[0]).toMatch(/^REFUSED skills\/a: missing \(.*1 high finding\)$/);
  });

  it("missing evidence wins over not-normalized, for an old record and for an empty list", async () => {
    const files = { ...BENIGN, "skills/c/SKILL.md": md("c"), "skills/c/references/x.md": "token " + TOKEN };
    for (const staging of [stageOld, stage]) {
      rmSync(join(home, "skill-quarantine"), { recursive: true, force: true });
      staging(files);
      const r = await check();
      expect(r.code).toBe(1);
      expect(r.lines.filter((l) => /^REFUSED skills\/[abc]: missing \(/.test(l))).toHaveLength(3);
      expect(r.lines.find((l) => l.startsWith("REFUSED skills/c"))).toContain("not normalized");
      expect(r.text).not.toContain(TOKEN);
    }
  });

  it("decides each root separately when shown paths collide", async () => {
    const base = "skills/" + "x".repeat(80);
    const build = (first: string, second: string) => ({
      [`${base}-a/SKILL.md`]: md("a"),
      [`${base}-a/LICENSE`]: first,
      [`${base}-b/SKILL.md`]: md("b"),
      [`${base}-b/LICENSE`]: second,
    });
    stage(build(MIT, "unrecognised words\n"));
    let r = await check();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^PROMOTABLE \S+ \S+ MIT$/);
    expect(r.lines[0]).toContain(idOf("a"));
    expect(r.lines[1]).toMatch(/^REFUSED \S+: ambiguous \(/);

    rmSync(join(home, "skill-quarantine"), { recursive: true, force: true });
    stage(build("unrecognised words\n", MIT));
    r = await check();
    expect(r.lines[0]).toMatch(/^REFUSED \S+: ambiguous \(/);
    expect(r.lines[1]).toContain(idOf("b"));
    expect(r.lines[1]).toMatch(/^PROMOTABLE /);
  });

  it("a path that no longer fits the approved paths is refused and the others are still checked", async () => {
    stage({ ...BENIGN, "other/c/SKILL.md": md("c"), LICENSE: MIT });
    // the staged record still lists skills/a and skills/b; the approved paths now cover only skills/a
    writeFileSync(join(cwd, "skill-sources.yaml"), sourceYaml().replace("paths: [skills]", "paths: [skills/a]"));
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe(`PROMOTABLE ${idOf("a")} skills/a MIT`);
    expect(r.lines[1]).toMatch(/^REFUSED skills\/b: not-promotable \(.*approved path/);
    expect(r.lines.at(-1)).toMatch(/^CHECKED 2 skills .*: 1 promotable, 1 refused$/);
  });

  it("gives each colliding long path its own normalization reasons", async () => {
    const base = "skills/" + "x".repeat(80);
    const bad = (name: string, extra: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\nBody.\n`;
    stage({
      [`${base}-a/SKILL.md`]: bad("a", "version: not-a-version\n"),
      [`${base}-b/SKILL.md`]: bad("b", "compatibility: 5\n"),
      LICENSE: MIT,
    });
    const r = await check();
    const [a, b] = r.lines;
    expect(a).toMatch(/not-normalized/);
    expect(b).toMatch(/not-normalized/);
    expect(a).not.toBe(b);
    expect(a!.toLowerCase()).toContain("version");
    expect(b!.toLowerCase()).toContain("compatib");
  });

  it("a mixed import exits 1, in record order, with the right counts", async () => {
    stage({ ...BENIGN, "skills/b/LICENSE": MIT });
    const r = await check();
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^REFUSED skills\/a: missing/);
    expect(r.lines[1]).toBe(`PROMOTABLE ${idOf("b")} skills/b MIT`);
    expect(r.lines[2]).toContain("1 promotable, 1 refused");
  });

  it("never prints licence file content", async () => {
    stage({ ...BENIGN, LICENSE: "DISTINCTIVE-MARKER-LINE\n" });
    const r = await check();
    expect(r.text).not.toContain("DISTINCTIVE-MARKER-LINE");
  });

  it("writes nothing", async () => {
    stage({ ...BENIGN, LICENSE: MIT });
    const before = [...snapshot(home), ...snapshot(cwd)];
    await check();
    expect([...snapshot(home), ...snapshot(cwd)]).toEqual(before);
  });
});

describe("scf skills promote check problems", () => {
  const problem = async (operands: string[] = ["lib"]) => {
    const r = await check(operands);
    expect(r.code).toBe(1);
    expect(r.lines.every((l) => l.startsWith("PROBLEM "))).toBe(true);
    return r.text;
  };
  it("nothing staged", async () => expect(await problem()).toContain("no staged import of lib"));
  it("unknown source", async () => expect(await problem(["other"])).toContain("unknown source other"));
  it("a tampered licence file", async () => {
    const done = stage({ ...BENIGN, LICENSE: MIT });
    writeFileSync(join(done.dir, "licence", "LICENSE"), MIT.replace("a", "b"));
    const t = await problem();
    expect(t).toContain("does not match import.json");
    expect(t).toContain("nothing was checked");
  });
  it("a missing exception file", async () => {
    stage({ ...BENIGN, LICENSE: MIT });
    expect(await problem(["lib", "nope.yaml"])).toContain("the exception file does not exist");
  });
  it("a disabled source", async () => {
    stage({ ...BENIGN, LICENSE: MIT });
    writeFileSync(join(cwd, "skill-sources.yaml"), sourceYaml().replace("status: enabled", "status: disabled\n    reason: paused"));
    expect(await problem()).toContain("only an enabled source can be promoted");
  });
  it("no approved commit", async () => {
    writeFileSync(join(cwd, "skill-sources.yaml"), sourceYaml().replace(`, approved: '${COMMIT}'`, "").replace("status: enabled", "status: disabled\n    reason: paused"));
    expect(await problem()).toContain("no approved commit");
  });
  it("an import from another repository", async () => {
    stage({ ...BENIGN, LICENSE: MIT });
    writeFileSync(join(cwd, "skill-sources.yaml"), sourceYaml().replace("example/skills", "example/other"));
    expect(await problem()).toContain("another repository");
  });
});

describe("scf skills promote syntax", () => {
  const bad = async (positionals: string[], values: Record<string, unknown> = {}) => {
    await expect(skillsCommand({ positionals, values }, () => undefined, { cwd, home, today: TODAY })).rejects.toThrow(SKILLS_USAGE);
  };
  it("refuses wrong operands and options", async () => {
    await bad(["promote"]);
    await bad(["promote", "foo", "lib"]);
    await bad(["promote", "check"]);
    await bad(["promote", "check", "Bad_Id"]);
    await bad(["promote", "check", "lib", "a", "b"]);
    await bad(["promote", "check", "lib"], { replace: true });
  });
});
