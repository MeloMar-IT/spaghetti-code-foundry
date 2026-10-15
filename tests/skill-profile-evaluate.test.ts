import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { normalizeImport, sourceQualifiedId } from "../src/skills/normalize.js";
import { evaluateProfileCandidates, type ProfileEvaluateInput } from "../src/skills/profile-evaluate.js";
import type { ProfileEvaluationRecord } from "../src/skills/profile-evaluations.js";
import { scanSkill } from "../src/skills/scan.js";
import type { ScanException } from "../src/skills/scan-exceptions.js";
import { parseSources } from "../src/skills/sources.js";
import type { SkillProfile, SourceProfile } from "../src/skills/source-profiles.js";

const COMMIT = "a".repeat(40);
const TODAY = "2026-10-13";
const KEY = "github.com/example/skills";
const md = (name: string, extra = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\nBody.\n`;
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
// built from pieces: tools/secret-scan reads this file too
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const GPL ="GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n";

function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}
const SOURCE_YAML = [
  "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", "    status: enabled",
  `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: verified",
  "    licence: {allow: [MIT]}", "    update: {cadence: weekly}", "    owner: '@octocat'",
  `    review: {by: '@octocat', on: '2026-01-01', commit: '${COMMIT}', licence: MIT}`, "",
].join("\n");
const source = () => parseSources(parseYaml(SOURCE_YAML), TODAY).manifest!.sources[0]!;
const idOf = (name: string) => sourceQualifiedId({ source: "lib", repositoryKey: KEY }, name);

const BENIGN: Record<string, string> = { LICENSE: MIT, "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") };

function stage(files: Record<string, string>, evidence = true) {
  const t = tree(files);
  const { record, files: staged } = prepareImport(source(), t);
  const licence = evidence ? collectLicenceEvidence({ repositoryKey: record.repositoryKey, commit: record.commit }, record.skills.map((s) => s.root), t) : undefined;
  return { record, files: staged, licence };
}
function digestOf(s: ReturnType<typeof stage>, name: string): string {
  const { skills } = normalizeImport({ record: { ...s.record, rejected: [] }, files: s.files });
  return skills.find((k) => k.provenance.name === name)!.package.digest;
}
const profileSkill = (name: string, over: Partial<Omit<SkillProfile, "requires">> & { requires?: Partial<SkillProfile["requires"]> } = {}): SkillProfile => ({
  name, class: "portable", capabilities: [`cap-${name}`], high_risk: [], evaluations: [], ...over,
  requires: { config: [], tools: [], connectors: [], live_services: [], ...over.requires },
});
const profileOf = (...skills: SkillProfile[]): SourceProfile => ({ id: "lib", skills });
const record = (s: ReturnType<typeof stage>, name: string, over: Partial<ProfileEvaluationRecord> = {}): ProfileEvaluationRecord => ({
  skill: idOf(name), digest: digestOf(s, name), kind: "correctness", verdict: "passed", owner: "@octocat", reviewed: "2026-10-01", expires: "2027-01-01", ...over,
});

function run(s: ReturnType<typeof stage>, profile: SourceProfile | undefined, over: Partial<ProfileEvaluateInput> = {}) {
  return evaluateProfileCandidates({ source: source(), staged: s, profile, exceptions: [], evaluations: [], today: TODAY, ...over });
}
const texts = (r: ReturnType<typeof run>, name: string) => r.candidates.find((c) => c.name === name)!.reasons.map((x) => `${x.gate}: ${x.text}`);

describe("evaluateProfileCandidates", () => {
  it("passes a declared skill with every gate satisfied, in record order, and lists its needs", () => {
    const s = stage(BENIGN);
    const r = run(s, profileOf(profileSkill("a", { requires: { config: ["DATABASE_URL"], live_services: ["postgres"] } }), profileSkill("b")));
    expect(r.candidates.map((c) => c.name)).toEqual(s.record.skills.map((k) => k.name));
    expect(r.candidates.every((c) => c.reasons.length === 0)).toBe(true);
    expect(r.candidates[0]!.needs).toEqual({ config: ["DATABASE_URL"], live_services: ["postgres"] });
    expect(r.candidates[0]!.id).toBe(idOf("a"));
    expect(r.candidates[0]!.digest).toBe(digestOf(s, "a"));
    expect(r.missing).toEqual([]);
  });

  it("declared: a staged skill with no profile entry is blocked and no other gate runs", () => {
    const s = stage({ ...BENIGN, "skills/a/scripts/a.sh": "rm -rf /" });
    const r = run(s, profileOf(profileSkill("b")));
    expect(texts(r, "a")).toEqual(["declared: not in skill-source-profiles.yaml"]);
    expect(texts(r, "b")).toEqual([]);
    expect(r.candidates.find((c) => c.name === "a")!.profile).toBeUndefined();
  });

  it("declared: without a profile entry for the source every skill is blocked", () => {
    const r = run(stage(BENIGN), undefined);
    expect(r.candidates.map((c) => c.reasons.map((x) => x.gate))).toEqual([["declared"], ["declared"]]);
    expect(r.missing).toEqual([]);
  });

  it("missing: a profile entry with no staged skill is listed in profile order", () => {
    const r = run(stage(BENIGN), profileOf(profileSkill("z"), profileSkill("a"), profileSkill("y"), profileSkill("b")));
    expect(r.missing).toEqual(["z", "y"]);
  });

  describe("licence", () => {
    it("no evidence asks to import again", () => {
      const r = run(stage(BENIGN, false), profileOf(profileSkill("a"), profileSkill("b")));
      expect(texts(r, "a")).toEqual(['licence: no licence evidence; run "scf skills import lib" again']);
    });
    it("a licence outside allow is not allowed", () => {
      const r = run(stage({ ...BENIGN, LICENSE: GPL }), profileOf(profileSkill("a"), profileSkill("b")));
      expect(texts(r, "a")[0]).toMatch(/^licence: (review|rejected) \(/);
    });
    it("no licence file is missing", () => {
      const { LICENSE: _l, ...none } = BENIGN;
      const r = run(stage(none), profileOf(profileSkill("a"), profileSkill("b")));
      expect(texts(r, "a")[0]).toMatch(/^licence: missing \(/);
    });
  });

  describe("security", () => {
    const high = { ...BENIGN, "skills/a/scripts/a.sh": "rm -rf /" };
    // the script needs a shell, which the profile declares
    const profile = profileOf(profileSkill("a", { requires: { tools: ["shell"] } }), profileSkill("b"));
    function exceptionFor(s: ReturnType<typeof stage>, over: Partial<ScanException> = {}): ScanException {
      const entry = s.record.skills.find((k) => k.name === "a")!;
      const rep = scanSkill({ root: entry.root, files: [...s.files].filter(([p]) => p.startsWith(entry.root + "/")).map(([p, c]) => ({ path: p.slice(entry.root.length + 1), content: c })) });
      const f = rep.findings.find((x) => x.severity === "high")!;
      return { finding: f.id, skill: idOf("a"), digest: digestOf(s, "a"), reason: "reviewed, harmless here", owner: "@octocat", reviewed: "2026-10-01", expires: "2027-01-01", ...over } as ScanException;
    }
    it("a high finding blocks", () => {
      expect(texts(run(stage(high), profile), "a")).toEqual(["security: 1 high finding"]);
    });
    it("an accepted exception lifts it", () => {
      const s = stage(high);
      expect(texts(run(s, profile, { exceptions: [exceptionFor(s)] }), "a")).toEqual([]);
    });
    it("an expired exception blocks", () => {
      const s = stage(high);
      expect(texts(run(s, profile, { exceptions: [exceptionFor(s, { expires: "2026-10-12" })] }), "a")).toEqual(["security: 1 high finding"]);
    });
    it("a skill that does not normalize is blocked, with no requirements or evaluation reasons", () => {
      const s = stage({ ...BENIGN, "skills/a/references/x.md": "token " + TOKEN });
      const r = run(s, profileOf(profileSkill("a", { evaluations: ["correctness"] }), profileSkill("b")));
      const cand = r.candidates.find((c) => c.root === "skills/a")!;
      expect(cand.reasons.map((x) => x.gate)).toEqual(["security"]);
      expect(cand.reasons[0]!.text).toMatch(/^not normalized \(/);
      expect(cand.id).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    });
    it("an import exclusion blocks", () => {
      const s = stage({ ...BENIGN, "skills/a/.mcp.json": "{}" });
      expect(texts(run(s, profile), "a")[0]).toMatch(/^security: excluded \(/);
    });
  });

  describe("requirements", () => {
    const shell = { ...BENIGN, "skills/a/SKILL.md": md("a", "allowed-tools: Bash\n") };
    it("an undeclared connector blocks, a declared one does not", () => {
      const s = stage({ ...BENIGN, "skills/a/skill.yaml": "connectors: [supabase]\n" });
      const blocked = texts(run(s, profileOf(profileSkill("a"), profileSkill("b"))), "a");
      expect(blocked).toContain("requirements: needs the connector supabase, not in requires.connectors");
      const declared = texts(run(s, profileOf(profileSkill("a", { requires: { connectors: ["supabase"] } }), profileSkill("b"))), "a");
      expect(declared.filter((t) => t.startsWith("requirements"))).toEqual([]);
    });
    it("an undeclared tool blocks, a declared one does not", () => {
      const s = stage(shell);
      expect(texts(run(s, profileOf(profileSkill("a"), profileSkill("b"))), "a")).toContain("requirements: needs shell, not in requires.tools");
      expect(texts(run(s, profileOf(profileSkill("a", { requires: { tools: ["shell"] } }), profileSkill("b"))), "a").filter((t) => t.startsWith("requirements"))).toEqual([]);
    });
  });

  describe("evaluation", () => {
    const profile = (s: ReturnType<typeof stage>, ...kinds: string[]) => {
      void s;
      return profileOf(profileSkill("a", { evaluations: kinds }), profileSkill("b"));
    };
    it("an empty list passes this gate", () => {
      expect(texts(run(stage(BENIGN), profile(stage(BENIGN))), "a")).toEqual([]);
    });
    it("a passed record passes", () => {
      const s = stage(BENIGN);
      expect(texts(run(s, profile(s, "correctness"), { evaluations: [record(s, "a")] }), "a")).toEqual([]);
    });
    it("each failure has its own reason", () => {
      const s = stage(BENIGN);
      const p = profile(s, "correctness");
      expect(texts(run(s, p), "a")).toEqual(["evaluation: correctness not recorded"]);
      expect(texts(run(s, p, { evaluations: [record(s, "a", { verdict: "failed" })] }), "a")).toEqual(["evaluation: correctness failed"]);
      expect(texts(run(s, p, { evaluations: [record(s, "a", { expires: "2026-10-12" })] }), "a")).toEqual(["evaluation: correctness expired"]);
      expect(texts(run(s, p, { evaluations: [record(s, "a", { digest: "sha256:" + "9".repeat(64) })] }), "a")).toEqual(["evaluation: correctness recorded for another digest"]);
      expect(texts(run(s, p, { evaluations: [record(s, "a", { kind: "security" })] }), "a")).toEqual(["evaluation: correctness not recorded"]);
    });
    it("two kinds where one passes still block", () => {
      const s = stage(BENIGN);
      expect(texts(run(s, profile(s, "correctness", "security"), { evaluations: [record(s, "a")] }), "a")).toEqual(["evaluation: security not recorded"]);
    });
  });

  it("changes nothing in its input and throws for a bad today", () => {
    const s = stage(BENIGN);
    const input: ProfileEvaluateInput = { source: source(), staged: s, profile: profileOf(profileSkill("a"), profileSkill("b")), exceptions: [], evaluations: [], today: TODAY };
    const before = JSON.stringify({ ...input, staged: { record: s.record, licence: s.licence, files: [...s.files].map(([k, v]) => [k, Buffer.from(v).toString("hex")]) } });
    evaluateProfileCandidates(input);
    expect(JSON.stringify({ ...input, staged: { record: s.record, licence: s.licence, files: [...s.files].map(([k, v]) => [k, Buffer.from(v).toString("hex")]) } })).toBe(before);
    expect(() => evaluateProfileCandidates({ ...input, today: "soon" })).toThrow(TypeError);
  });
});
