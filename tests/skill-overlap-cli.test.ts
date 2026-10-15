import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { skillsCommand } from "../src/skills/cli.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { sourceQualifiedId } from "../src/skills/normalize.js";
import { scanSkill } from "../src/skills/scan.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const TODAY = "2026-10-13";
const KEY = "github.com/example/skills";
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
const A: Record<string, string> = {
  "skills/a/SKILL.md": "---\nname: a\ndescription: A skill called a.\n---\n\nBody.\n",
  "skills/a/skill.yaml": "capabilities: [code-review]\n",
  LICENSE: MIT,
};
const BUILTIN = resolve("tests/fixtures/skills/overlap");

const sourceYaml = (licence = "{allow: [MIT]}") =>
  [
    "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", "    status: enabled",
    `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: community",
    `    licence: ${licence}`, "    update: {cadence: weekly}", "    owner: '@octocat'",
    `    review: {by: '@octocat', on: '2026-01-01', commit: '${COMMIT}', licence: MIT}`, "",
  ].join("\n");

const made: string[] = [];
let home: string;
let cwd: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skilloverlap-")));
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

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}
function source(): SkillLibrarySource {
  const r = readSources(join(cwd, "skill-sources.yaml"));
  if (r.state !== "ok") throw new Error("bad sources");
  return r.manifest.sources[0]!;
}
const stage = (files: Record<string, string>) => {
  const t = tree(files);
  const prep = prepareImport(source(), t);
  const licence = prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t));
  return publishImport(addLicenceEvidence(prep, licence, "2026-10-01T10:00:00Z"), { home });
};
const idOf = (name: string) => sourceQualifiedId({ source: "lib", repositoryKey: KEY }, name);
const dev = () => ConfigSchema.parse({ skills: { releases: { allow_unreleased: true } } }).skills;
async function overlap(operands: string[] = ["lib"], builtinRoot = BUILTIN) {
  const lines: string[] = [];
  const code = await skillsCommand(
    { positionals: ["overlap", ...operands], values: {} }, (l) => void lines.push(l),
    { cwd, home, builtinRoot, userHome: join(home, "u"), env: {}, skills: dev(), today: TODAY },
  );
  return { code, lines, text: lines.join("\n") };
}
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const st = statSync(p);
    return e.isDirectory() ? [`${p} ${st.mode} ${st.mtimeMs}`, ...snapshot(p)] : [`${p} ${st.mode} ${st.mtimeMs} ${readFileSync(p).toString("hex")}`];
  });
const find = (dir: string, name: string): string | undefined => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const r = find(p, name);
      if (r) return r;
    } else if (e.name === name) return p;
  }
  return undefined;
};

describe("scf skills overlap", () => {
  it("prints the canonical skill and the loser, a summary line, writes nothing and exits 0", async () => {
    stage(A);
    const before = [...snapshot(home), ...snapshot(cwd)];
    const r = await overlap();
    expect(r.code).toBe(0);
    expect(r.lines.slice(0, 2)).toEqual(["CANONICAL code-review: review-guide@1.0.0 (trust-tier)", `REJECTED ${idOf("a")}@0.0.0-gaaaaaaaaaaaa: outranked`]);
    expect(r.lines.at(-1)).toMatch(/^OVERLAP 1 skill from github\.com\/example\/skills@aaaaaaaaaaaa sha256:[0-9a-f]{64}: 1 shared, 0 new, 0 vendor-only, 0 conflicts$/);
    expect(existsSync(join(home, "skills.lock.json"))).toBe(false);
    expect([...snapshot(home), ...snapshot(cwd)]).toEqual(before);
  });

  it("reports a capability that nothing else provides as NEW, and a failing registry as a problem", async () => {
    stage(A);
    const empty = join(cwd, "none");
    mkdirSync(empty);
    const fresh1 = await overlap(["lib"], empty);
    expect(fresh1.code).toBe(0);
    expect(fresh1.lines[0]).toMatch(/^NEW code-review: \S+$/);
    const broken = await overlap(["lib"], join(cwd, "missing-root"));
    expect(broken.code).toBe(1);
    expect(broken.lines).toContain("PROBLEM catalogue builtin root-missing");
  });

  it("rejects the skill when licence.reviewed is stale, and accepts the matching digest", async () => {
    stage(A);
    const lines: string[] = [];
    await skillsCommand({ positionals: ["promote", "check", "lib"], values: {} }, (l) => void lines.push(l), { cwd, home, today: TODAY });
    const digest = lines.find((l) => l.startsWith("LICENCES "))!.split(" ")[1]!;

    writeFileSync(join(cwd, "skill-sources.yaml"), sourceYaml(`{allow: [MIT], reviewed: '${digest}'}`));
    expect((await overlap()).lines[0]).toBe("CANONICAL code-review: review-guide@1.0.0 (trust-tier)");

    writeFileSync(join(cwd, "skill-sources.yaml"), sourceYaml(`{allow: [MIT], reviewed: 'sha256:${"0".repeat(64)}'}`));
    const stale = await overlap();
    expect(stale.lines.slice(0, 2)).toEqual(["CANONICAL code-review: review-guide@1.0.0 (only-candidate)", `REJECTED ${idOf("a")}@0.0.0-gaaaaaaaaaaaa: licence`]);
  });

  describe("scan blockers and exceptions", () => {
    const HIGH = { ...A, "skills/a/scripts/a.sh": "rm -rf /" };
    const exceptionFile = (over: Record<string, string>) => {
      const e = { skill: idOf("a"), digest: "", finding: "", reason: "reviewed, harmless here", owner: "@octocat", reviewed: "2026-10-01", expires: "2027-01-01", ...over };
      writeFileSync(join(cwd, "skill-scan-exceptions.yaml"), ["schema: 1", "exceptions:", ...Object.entries(e).map(([k, v], i) => `${i === 0 ? "  - " : "    "}${k}: '${v}'`), ""].join("\n"));
    };
    function finding() {
      const done = stage(HIGH);
      const entry = done.record.skills.find((s) => s.name === "a")!;
      const files = Object.entries(HIGH).filter(([p]) => p.startsWith(entry.root + "/")).map(([p, c]) => ({ path: p.slice(entry.root.length + 1), content: Buffer.from(c) }));
      const f = scanSkill({ root: entry.root, files }).findings.find((x) => x.severity === "high")!;
      return { id: f.id, digest: entry.digest };
    }

    it("an open high finding makes the skill REJECTED safety", async () => {
      stage(HIGH);
      const r = await overlap();
      expect(r.lines.slice(0, 2)).toEqual(["CANONICAL code-review: review-guide@1.0.0 (only-candidate)", `REJECTED ${idOf("a")}@0.0.0-gaaaaaaaaaaaa: safety`]);
    });

    it("a matching current exception removes the blocker; an expired or other-digest one does not", async () => {
      const { id, digest } = finding();
      exceptionFile({ finding: id, digest });
      expect((await overlap()).lines[0]).toBe("CANONICAL code-review: review-guide@1.0.0 (trust-tier)");
      exceptionFile({ finding: id, digest, expires: "2026-10-01" });
      expect((await overlap()).text).toContain(": safety");
      exceptionFile({ finding: id, digest: "sha256:" + "b".repeat(64) });
      expect((await overlap()).text).toContain(": safety");
    });
  });

  it("prints only fixed text when the staged import is damaged", async () => {
    const done = stage(A);
    const skillMd = find(done.dir, "SKILL.md")!;
    writeFileSync(join(dirname(skillMd), "UPSTREAM-MARKER.md"), "x");
    const r = await overlap();
    expect(r.code).toBe(1);
    expect(r.text).toContain("does not match import.json; nothing was compared");
    expect(r.text).not.toContain("UPSTREAM-MARKER");
  });

  it("problems of the call itself", async () => {
    expect((await overlap(["other"])).text).toContain("PROBLEM unknown source other");
    expect((await overlap(["other"])).code).toBe(1);
    expect((await overlap(["lib"])).text).toContain("no staged import of lib");
  });
});
