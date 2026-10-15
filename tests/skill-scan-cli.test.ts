import { chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialProblem } from "../src/skills/credential-scan.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport, readStagedImport } from "../src/skills/import-stage.js";
import { skillsCommand, SKILLS_USAGE } from "../src/skills/cli.js";
import { sourceQualifiedId } from "../src/skills/normalize.js";
import { scanSkill } from "../src/skills/scan.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";

vi.mock("../src/skills/import-stage.js", async (orig) => {
  const m = await orig<typeof import("../src/skills/import-stage.js")>();
  return { ...m, readStagedImport: vi.fn(m.readStagedImport) };
});

const COMMIT = "a".repeat(40);
const TODAY = "2026-10-13";
const KEY = "github.com/example/skills";
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
// built from pieces: tools/secret-scan reads this file too
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const BENIGN: Record<string, string> = { "skills/a/SKILL.md": md("a"), "skills/a/references/x.md": "notes", "skills/b/SKILL.md": md("b") };
const HIGH: Record<string, string> = { ...BENIGN, "skills/a/scripts/a.sh": "rm -rf /" };

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}
const SOURCES = [
  "schema: 1",
  "sources:",
  "  - id: lib",
  "    repository: https://github.com/example/skills",
  "    status: enabled",
  `    ref: {track: main, approved: '${COMMIT}'}`,
  "    paths: [skills]",
  "    adapter: agent-skills",
  "    trust: community",
  "    licence: {allow: [MIT]}",
  "    update: {cadence: weekly}",
  "    owner: '@octocat'",
  `    review: {by: '@octocat', on: '2026-01-01', commit: '${COMMIT}', licence: MIT}`,
  "",
].join("\n");

const made: string[] = [];
let home: string;
let cwd: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillscan-")));
  made.push(d);
  return d;
};
beforeEach(() => {
  home = fresh();
  cwd = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), SOURCES);
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
async function scan(operands: string[] = ["lib"], over: { values?: Record<string, unknown> } = {}) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: ["scan", ...operands], values: over.values ?? {} }, (l) => void lines.push(l), { cwd, home, today: TODAY });
  return { code, lines, text: lines.join("\n") };
}
const idOf = (name: string) => sourceQualifiedId({ source: "lib", repositoryKey: KEY }, name);
const exceptionYaml = (over: Record<string, string> = {}) => {
  const e = { skill: idOf("a"), digest: "", finding: "", reason: "reviewed, harmless here", owner: "@octocat", reviewed: "2026-10-01", expires: "2027-01-01", ...over };
  return ["schema: 1", "exceptions:", ...Object.entries(e).map(([k, v], i) => `${i === 0 ? "  - " : "    "}${k}: '${v}'`), ""].join("\n");
};
function highFinding() {
  const { record, files } = prepareImport(source(), tree(HIGH));
  publishImport({ record, recordText: JSON.stringify(record, null, 2) + "\n", files }, { home });
  const entry = record.skills.find((s) => s.name === "a")!;
  const rep = scanSkill({ root: entry.root, files: [...files].filter(([p]) => p.startsWith(entry.root + "/")).map(([p, c]) => ({ path: p.slice(entry.root.length + 1), content: c })) });
  const f = rep.findings.find((x) => x.severity === "high")!;
  return { f, digest: entry.digest, record };
}
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    const st = statSync(p);
    return e.isDirectory() ? [`${p} ${st.mode} ${st.mtimeMs}`, ...snapshot(p)] : [`${p} ${st.mode} ${st.mtimeMs} ${readFileSync(p).toString("hex")}`];
  });

describe("scf skills scan", () => {
  it("a benign import prints OK and exits 0", async () => {
    stage(BENIGN);
    const r = await scan();
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`OK ${idOf("a")}: 0 findings, none blocks`);
    expect(r.lines).toContain(`OK ${idOf("b")}: 0 findings, none blocks`);
    expect(r.lines.at(-1)).toMatch(/^SCANNED 2 skills from github\.com\/example\/skills@aaaaaaaaaaaa sha256:[0-9a-f]{64}: 0 blocked$/);
    expect(r.text).not.toContain("FINDING");
  });

  it("lists mentioned web addresses and does not block", async () => {
    const skillMd = "---\nname: a\ndescription: A skill called a.\nhomepage: https://vercel.com\n---\n\nBody.\n";
    stage({
      ...BENIGN,
      "skills/a/SKILL.md": skillMd,
      "skills/a/references/pom.xml": "<url>https://repo.maven.apache.org/maven2</url>",
      "skills/a/metadata.json": '{"homepage":"https://vercel.com/x"}',
      "skills/a/references/x.md": "see https://u" + ":p@h.io/x",
    });
    const r = await scan();
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`OK ${idOf("a")}: 0 findings, none blocks`);
    expect(r.lines).toContain(`ADDRESS ${idOf("a")} mentioned references/pom.xml: https://repo.maven.apache.org/maven2 (under references/, which the agent only reads)`);
    expect(r.lines).toContain(`ADDRESS ${idOf("a")} mentioned metadata.json: https://vercel.com/x (a document or data file, which the agent only reads)`);
    expect(r.lines.some((l) => l.startsWith(`ADDRESS ${idOf("a")} mentioned SKILL.md: https://vercel.com (`))).toBe(true);
    expect(r.lines).toContain(`ADDRESS ${idOf("a")} mentioned references/x.md: https://(hidden)@h.io/x (under references/, which the agent only reads)`);
    expect(r.text).not.toContain("u" + ":p@");
  });

  it("hides a credential in the query of a web address", async () => {
    stage({ ...BENIGN, "skills/a/references/x.md": "see https://h.io/?api_" + "key=A1b2C3d4E5f6 now" });
    const r = await scan();
    expect(r.lines).toContain(`ADDRESS ${idOf("a")} mentioned references/x.md: https://h.io/?api_key=(hidden) (under references/, which the agent only reads)`);
    expect(r.text).not.toContain("A1b2C3d4E5f6");
  });

  it("a web address in a script is called and excludes the skill", async () => {
    stage({ ...BENIGN, "skills/a/scripts/b.sh": "URL=https://api.x.io/v1\n" });
    const r = await scan();
    expect(r.code).toBe(1);
    expect(r.lines).toContain(`EXCLUDED ${idOf("a")}: holds a web address in code (scripts/b.sh)`);
    expect(r.lines).toContain(`ADDRESS ${idOf("a")} called scripts/b.sh: https://api.x.io/v1 (under scripts/, which is code)`);
  });

  it("a shell file test on .env is not an upload", async () => {
    stage({ ...BENIGN, "skills/a/scripts/create-topics.sh": "if [[ -f .env ]]; then\n    source .env\nfi\n" });
    const r = await scan();
    expect(r.code).toBe(0);
    expect(r.text).not.toContain("upload");
  });

  it("a skill that needs network prints EXCLUDED, no OK line for it, and exits 1", async () => {
    stage({ ...BENIGN, "skills/c/SKILL.md": "---\nname: c\ndescription: A skill called c.\nallowed-tools: WebFetch\n---\n\nBody.\n" });
    const r = await scan();
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith(`EXCLUDED ${idOf("c")}: needs network access`))).toBe(true);
    expect(r.lines.some((l) => l.startsWith(`OK ${idOf("c")}`))).toBe(false);
    expect(r.lines.at(-1)).toContain(": 1 blocked");
  });

  it("counts a skill with a high finding and an exclusion once", async () => {
    stage({ ...HIGH, "skills/a/scripts/b.sh": "curl https://api.example.io/x\n" });
    const r = await scan();
    expect(r.lines.some((l) => l.startsWith(`BLOCKED ${idOf("a")}`))).toBe(true);
    expect(r.lines.some((l) => l.startsWith(`EXCLUDED ${idOf("a")}`))).toBe(true);
    expect(r.lines.at(-1)).toContain(": 1 blocked");
  });

  it("a high finding is shown and blocks", async () => {
    const { f } = highFinding();
    const r = await scan();
    expect(r.code).toBe(1);
    expect(r.lines).toContain(`FINDING ${f.id} high open ${idOf("a")} ${f.path}: ${f.evidence}`);
    expect(r.lines).toContain(`BLOCKED ${idOf("a")}: 1 high finding`);
    expect(r.lines).toContain(`OK ${idOf("b")}: 0 findings, none blocks`);
    expect(r.lines.at(-1)).toContain(": 1 blocked");
  });

  it("a valid exception accepts the finding, from the default and from a named file", async () => {
    const { f, digest } = highFinding();
    writeFileSync(join(cwd, "skill-scan-exceptions.yaml"), exceptionYaml({ finding: f.id, digest }));
    const r = await scan();
    expect(r.code).toBe(0);
    expect(r.lines).toContain(`FINDING ${f.id} high accepted ${idOf("a")} ${f.path}: ${f.evidence}`);
    expect(r.lines).toContain(`OK ${idOf("a")}: ${r.lines.filter((l) => l.startsWith("FINDING")).length} finding${r.lines.filter((l) => l.startsWith("FINDING")).length === 1 ? "" : "s"}, none blocks`);
    writeFileSync(join(cwd, "mine.yaml"), exceptionYaml({ finding: f.id, digest }));
    expect((await scan(["lib", "mine.yaml"])).code).toBe(0);
  });

  it("an expired exception, a review-required one and another digest still block", async () => {
    const { f, digest } = highFinding();
    writeFileSync(join(cwd, "e.yaml"), exceptionYaml({ finding: f.id, digest, expires: "2026-10-01" }));
    const expired = await scan(["lib", "e.yaml"]);
    expect(expired.code).toBe(1);
    expect(expired.text).toContain(`FINDING ${f.id} high expired`);
    const review = exceptionYaml({ finding: f.id, digest }).replace(/expires: '[^']*'/, "review: 'required'");
    writeFileSync(join(cwd, "r.yaml"), review);
    const r = await scan(["lib", "r.yaml"]);
    expect(r.code).toBe(1);
    expect(r.text).toContain(`FINDING ${f.id} high review-required`);
    writeFileSync(join(cwd, "d.yaml"), exceptionYaml({ finding: f.id, digest: "sha256:" + "b".repeat(64) }));
    const d = await scan(["lib", "d.yaml"]);
    expect(d.code).toBe(1);
    expect(d.text).toContain(`FINDING ${f.id} high open`);
  });

  it("a medium or low finding does not block", async () => {
    stage({ ...BENIGN, "skills/a/references/y.md": "run: pip install requests" });
    const r = await scan();
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => l.startsWith("FINDING") && !l.includes(" high "))).toBe(true);
    expect(r.text).not.toContain("BLOCKED");
  });

  it("a skill that cannot be normalized is scanned by root and blocks, without showing the credential", async () => {
    stage({ ...BENIGN, "skills/a/references/x.md": "token " + TOKEN });
    const r = await scan();
    expect(r.code).toBe(1);
    expect(r.text).not.toContain(TOKEN);
    expect(r.lines.some((l) => l.startsWith("FINDING ") && l.includes(" open skills/a "))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("BLOCKED skills/a: not normalized ("))).toBe(true);
    expect(r.lines).toContain(`OK ${idOf("b")}: 0 findings, none blocks`);
  });

  it("two skills with the same name are both blocked", async () => {
    stage({ ...BENIGN, "skills/c/SKILL.md": md("a") });
    const r = await scan();
    expect(r.code).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("BLOCKED ") && l.includes("not normalized"))).toHaveLength(2);
  });

  it("an edited rejected text is hidden and does not decide the exit code", async () => {
    const { dir, record } = stage(BENIGN);
    const edited = { ...record, rejected: [{ root: TOKEN, reasons: ["see " + TOKEN] }, { root: "skills/a", reasons: ["made up reason"] }] };
    writeFileSync(join(dir, "import.json"), JSON.stringify(edited, null, 2) + "\n", { mode: 0o600 });
    const r = await scan();
    expect(r.code).toBe(0);
    expect(r.text).not.toContain(TOKEN);
    expect(r.lines).toContain("REJECTED (hidden): (hidden)");
    expect(r.lines).toContain("REJECTED skills/a: made up reason");
    expect(r.text).not.toContain("BLOCKED");
  });

  it("a tampered quarantine gives one PROBLEM and scans nothing", async () => {
    const { dir } = stage(HIGH);
    const file = join(dir, "files", "skills", "b", "SKILL.md");
    writeFileSync(file, md("b") + "x");
    const changed = await scan();
    expect(changed.code).toBe(1);
    expect(changed.lines).toHaveLength(1);
    expect(changed.lines[0]).toMatch(/^PROBLEM the staged import does not match import\.json: .*nothing was scanned$/);
    rmSync(file);
    symlinkSync(join(cwd, "skill-sources.yaml"), file);
    const link = await scan();
    expect(link.lines).toHaveLength(1);
    expect(link.lines[0]).toMatch(/^PROBLEM /);
    rmSync(file);
    writeFileSync(join(dir, "files", "extra.txt"), "x");
    const extra = await scan();
    expect(extra.lines).toHaveLength(1);
    expect(extra.lines[0]).toContain("is not part of the import");
  });

  it.each([
    ["no source file", () => rmSync(join(cwd, "skill-sources.yaml")), ["lib"], "the skill source file does not exist"],
    ["an invalid source file", () => writeFileSync(join(cwd, "skill-sources.yaml"), "schema: 2\n"), ["lib"], "PROBLEM"],
    ["an unknown source", () => undefined, ["other"], "unknown source other"],
    ["nothing staged", () => undefined, ["lib"], 'no staged import of lib at aaaaaaaaaaaa; run "scf skills import lib" first'],
    ["a missing named exception file", () => undefined, ["lib", "none.yaml"], "the exception file does not exist"],
  ])("%s is a PROBLEM", async (_n, setup, operands, text) => {
    setup();
    const r = await scan(operands);
    expect(r.code).toBe(1);
    expect(r.lines.every((l) => l.startsWith("PROBLEM "))).toBe(true);
    expect(r.text).toContain(text);
  });

  it("an invalid exception file is a PROBLEM and nothing is scanned", async () => {
    stage(BENIGN);
    writeFileSync(join(cwd, "skill-scan-exceptions.yaml"), "schema: 1\nexceptions: nope\n");
    const r = await scan();
    expect(r.code).toBe(1);
    expect(r.lines.every((l) => l.startsWith("PROBLEM "))).toBe(true);
  });

  it("a source without ref.approved and another repository are PROBLEMs", async () => {
    stage(BENIGN);
    writeFileSync(join(cwd, "skill-sources.yaml"), SOURCES.replace("repository: https://github.com/example/skills", "repository: https://github.com/example/other"));
    const other = await scan();
    expect(other.code).toBe(1);
    expect(other.text).toContain("another repository");
    writeFileSync(join(cwd, "skill-sources.yaml"), SOURCES.replace(`, approved: '${COMMIT}'`, ""));
    const none = await scan();
    expect(none.code).toBe(1);
    expect(none.text).toContain("PROBLEM");
  });

  it("a disabled source with a staged import is scanned", async () => {
    stage(BENIGN);
    writeFileSync(join(cwd, "skill-sources.yaml"), SOURCES.replace("status: enabled", "status: disabled").replace("    owner: '@octocat'", "    owner: '@octocat'\n    reason: paused"));
    expect((await scan()).code).toBe(0);
  });

  it("checks the syntax before any read", async () => {
    rmSync(join(cwd, "skill-sources.yaml"));
    for (const operands of [[], ["a", "b", "c"], ["Bad_Id"]]) {
      await expect(scan(operands)).rejects.toThrow(SKILLS_USAGE);
    }
    await expect(scan(["lib"], { values: { repo: "." } })).rejects.toThrow("unexpected option --repo");
  });

  it("prints only checked lines and writes nothing", async () => {
    highFinding();
    chmodSync(home, 0o700);
    const before = snapshot(home);
    const r = await scan();
    for (const l of r.lines) {
      expect(l).toMatch(/^(FINDING|BLOCKED|EXCLUDED|OK|REJECTED|SCANNED|PROBLEM) /);
      expect(l).not.toMatch(/\p{Cc}/u);
      expect(credentialProblem(l)).toBeUndefined();
    }
    expect(snapshot(home)).toEqual(before);
    expect(readdirSync(home)).not.toContain("skill-quarantine.lock");
  });
});

describe("scf skills scan: connector report", () => {
  const PRISMA = { "skills/prisma-cli/SKILL.md": md("prisma-cli"), "skills/other/SKILL.md": md("other") };
  const useRepo = () => writeFileSync(join(cwd, "skill-sources.yaml"), SOURCES.replace("github.com/example/skills", "github.com/prisma/skills"));

  it("prints one CONNECTOR line per mapped skill, the unmapped ones and the absent ones", async () => {
    useRepo();
    stage(PRISMA);
    const r = await scan();
    expect(r.code).toBe(0);
    const lines = r.lines.filter((l) => l.startsWith("CONNECTOR "));
    const mapped = lines.filter((l) => !/^CONNECTOR prisma (unmapped|absent) /.test(l));
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatch(
      /^CONNECTOR prisma lib-prisma-cli-[0-9a-f]+: specific=prisma-cli,prisma-migrations,prisma-schema general=none orm=>=7 <8 engines=any runtime=any needs=prisma-cli risk=high evaluations=migration-no-data-loss,migration-no-production-reset,migration-review-before-apply reviewed=no$/,
    );
    expect(lines).toContain("CONNECTOR prisma unmapped skills/other: not offered, the profile does not name other");
    expect(lines).toContain("CONNECTOR prisma absent prisma-postgres");
    expect(r.lines.indexOf(mapped[0]!)).toBeLessThan(r.lines.findIndex((l) => l.startsWith("SCANNED")));
  });

  it("prints no CONNECTOR line for another source", async () => {
    stage(BENIGN);
    expect((await scan()).text).not.toContain("CONNECTOR");
  });
});

describe("scf skills scan with a community source", () => {
  const without = (t: string) => t.split("\n").filter((l) => !l.startsWith("    review:")).join("\n");

  it("reads the staged import when the review is current", async () => {
    stage(BENIGN);
    vi.mocked(readStagedImport).mockClear();
    expect((await scan()).code).toBe(0);
    expect(vi.mocked(readStagedImport)).toHaveBeenCalled();
  });

  it.each([
    ["no review", without(SOURCES), /^PROBLEM sources\[0\] \(lib\) review: an enabled community source needs a review/m],
    ["a review of another commit", SOURCES.replace(`commit: '${COMMIT}'`, `commit: '${"b".repeat(40)}'`), /^PROBLEM sources\[0\] \(lib\) review\.commit: /m],
  ])("refuses %s and reads nothing", async (_name, yaml, line) => {
    stage(BENIGN);
    const before = snapshot(home);
    writeFileSync(join(cwd, "skill-sources.yaml"), yaml);
    vi.mocked(readStagedImport).mockClear();
    const r = await scan();
    expect(r.code).toBe(1);
    expect(r.text).toMatch(line);
    expect(r.text).not.toMatch(/SCANNED|FINDING/);
    expect(vi.mocked(readStagedImport)).not.toHaveBeenCalled();
    expect(snapshot(home)).toEqual(before);
  });
});
