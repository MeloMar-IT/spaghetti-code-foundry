import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMMUNITY_PROMOTION_CODES, communityPromotionCheck, communityPromotionLines,
  type CommunityPromotionCode, type CommunityPromotionDecision, type CommunityPromotionInput,
} from "../src/skills/community-promotion.js";
import { loadBuiltins } from "../src/skills/compare-cli.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { collectLicenceEvidence, type LicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { reviewImport } from "../src/skills/licence-review.js";
import { normalizeImport } from "../src/skills/normalize.js";
import { BUILTIN_SKILLS } from "../src/skills/registry.js";
import { scanSkill } from "../src/skills/scan.js";
import type { ScanException } from "../src/skills/scan-exceptions.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text;
const BUSL = "Business Source License 1.1\nLicensor: Example\n";
const BUILTINS = loadBuiltins(BUILTIN_SKILLS);
const md = (name: string, extra = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\nBody.\n`;

function tree(files: Record<string, string>): SourceTree {
  const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
  const all: TreeEntry[] = [...content].map(([path, bytes]) => ({ path, kind: "file", size: bytes.byteLength, id: "id:" + path }));
  return {
    list: (p) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")),
    read: (entries) => entries.map((e) => content.get(e.path) ?? new Uint8Array(0)),
  };
}
const source = (over: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
  id: "lib",
  repository: "https://github.com/example/skills",
  repositoryKey: "github.com/example/skills",
  status: "enabled",
  ref: { approved: COMMIT },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "manual" },
  owner: "@example",
  review: { by: "@example", on: "2026-10-01", commit: COMMIT, licence: "MIT" },
  ...over,
});

/** Everything the check needs, built the way a caller would: prepare, normalize, collect evidence, review, scan. */
function setup(files: Record<string, string>): CommunityPromotionInput & { rawEvidence: LicenceEvidence } {
  const src = source();
  const prep = prepareImport(src, tree(files));
  const { skills } = normalizeImport(prep);
  const rawEvidence = collectLicenceEvidence({ repositoryKey: src.repositoryKey, commit: COMMIT }, skills.map((s) => s.provenance.root), tree(files));
  const licenceReview = reviewImport({ allow: src.licence.allow, prep, evidence: rawEvidence });
  const scans = Object.fromEntries(skills.map((s) => {
    const root = s.provenance.root;
    const own = [...prep.files].filter(([p]) => p.startsWith(root + "/")).map(([p, content]) => ({ path: p.slice(root.length + 1), content }));
    return [s.package.id, scanSkill({ root, files: own })];
  }));
  const fixtures = Object.fromEntries(skills.map((s) => [s.package.id, "passed" as const]));
  return {
    source: src, record: prep.record, skills, evidence: licenceReview.evidence, retrievedAt: "2026-10-12T10:00:00Z", licenceReview,
    scans, exceptions: [], today: "2026-10-15", builtins: BUILTINS, fixtures, rawEvidence,
  };
}
const BASE = { LICENSE: MIT, "skills/a/SKILL.md": md("a") };
const base = (files: Record<string, string> = BASE) => setup(files);
const idOf = (i: CommunityPromotionInput) => i.skills[0]!.package.id;
const nameId = (i: CommunityPromotionInput, name: string) => i.skills.find((s) => s.provenance.name === name)!.package.id;
const only = (i: CommunityPromotionInput): CommunityPromotionDecision => {
  const r = communityPromotionCheck(i);
  expect(r).toHaveLength(1);
  return r[0]!;
};
const withTech = (extra: string) => ({ ...BASE, "skills/a/SKILL.md": md("a", extra) });

const shippedJava = BUILTINS.find((b) => b.id === "java")!.files;
const collidingJava = Object.fromEntries([
  ["LICENSE", MIT],
  ...shippedJava.map((f) => {
    const text = Buffer.from(f.content).toString("utf8");
    return [`skills/java/${f.path}`, f.path === "skill.yaml" ? text.replace("category: language", "category: security") : text] as [string, string];
  }),
]);

const CASES: Record<CommunityPromotionCode, () => CommunityPromotionDecision> = {
  "source-not-enabled": () => {
    const d = only({ ...base(), source: source({ status: "disabled", reason: "x" } as Partial<SkillLibrarySource>) });
    expect(d.codes).toEqual(["source-not-enabled"]);
    return d;
  },
  "source-not-community": () => {
    const d = only({ ...base(), source: source({ trust: "verified" }) });
    expect(d.codes).toEqual(["source-not-community"]);
    return d;
  },
  "review-missing": () => {
    const { review: _r, ...rest } = source();
    return only({ ...base(), source: rest });
  },
  "review-stale": () => only({ ...base(), source: source({ review: { by: "@example", on: "2026-10-01", commit: OTHER, licence: "MIT" } }) }),
  "import-not-approved": () => {
    const d = only({ ...base(), source: source({ ref: { approved: OTHER }, review: { by: "@example", on: "2026-10-01", commit: OTHER, licence: "MIT" } }) });
    expect(d.codes).toEqual(["import-not-approved"]);
    return d;
  },
  "import-mismatch": () => only({ ...base(), source: source({ paths: ["elsewhere"] }) }),
  excluded: () => only(base({ ...BASE, "skills/a/SKILL.md": md("a", "allowed-tools: mcp__github__create_pr\n") })),
  "licence-review": () => {
    const d = only({ ...base(), source: source({ licence: { allow: ["MIT"], reviewed: "sha256:" + "0".repeat(64) } }) });
    expect(d.codes).not.toContain("import-mismatch");
    return d;
  },
  "licence-rejected": () => only(base({ "skills/a/SKILL.md": md("a"), "skills/a/LICENSE": BUSL })),
  "licence-missing": () => only(base({ "skills/a/SKILL.md": md("a") })),
  "licence-ambiguous": () => {
    const i = base({ ...BASE, "skills/NOTICE": "n\n" });
    const evidence: LicenceEvidence = {
      ...i.rawEvidence,
      files: i.rawEvidence.files.map((f) => (f.path === "skills/NOTICE" ? { path: f.path, dir: f.dir, kind: f.kind, problem: "a symbolic link" } : f)),
    };
    const { licenceReview: _l, ...rest } = i;
    return only({ ...rest, evidence });
  },
  "scan-missing": () => {
    const i = base();
    const other = scanSkill({ root: "x", files: [{ path: "SKILL.md", content: Buffer.from("something else\n") }] });
    expect(only({ ...i, scans: { [idOf(i)]: other } }).codes).toContain("scan-missing");
    return only({ ...i, scans: {} });
  },
  "scan-blocked": () => only(base({ ...BASE, "skills/a/scripts/a.sh": "rm -rf /\n" })),
  "version-stale": () => only(base(withTech("technologies:\n  spring-boot: '^2'\n"))),
  "version-unchecked": () => only(base(withTech("technologies:\n  spring-boot: 'banana'\n"))),
  "collision-blocking": () => only(base(collidingJava)),
  "canonical-conflict": () => {
    const i = base(withTech("tags: [spring-boot, transactions, web]\n"));
    return only({ ...i, overrides: { "spring-boot-transactions": idOf(i) } });
  },
  "fixtures-failed": () => {
    const i = base();
    return only({ ...i, fixtures: { [idOf(i)]: "failed" } });
  },
  "fixtures-missing": () => {
    const i = base();
    const id = idOf(i);
    expect(only({ ...i, fixtures: { [id]: "maybe" } as never }).codes).toContain("fixtures-missing");
    expect(only({ ...i, fixtures: Object.create({ [id]: "passed" }) }).codes).toContain("fixtures-missing");
    return only({ ...i, fixtures: {} });
  },
};

describe("communityPromotionCheck", () => {
  it("promotes a skill that passes every check", () => {
    expect(only(base())).toEqual({ skill: idOf(base()), decision: "promotable", codes: [] });
  });

  it("has a case for every code", () => {
    expect(Object.keys(CASES).sort()).toEqual([...COMMUNITY_PROMOTION_CODES].sort());
  });

  it.each(COMMUNITY_PROMOTION_CODES)("refuses with %s", (code) => {
    const d = CASES[code]();
    expect(d.decision).toBe("refused");
    expect(d.codes).toContain(code);
  });

  it("does not call promoteImport when the source fails, so there is no import-mismatch", () => {
    const i = base();
    const d = only({ ...i, source: source({ status: "disabled", reason: "x", paths: ["elsewhere"], trust: "verified" } as Partial<SkillLibrarySource>) });
    expect(d.codes).not.toContain("import-mismatch");
  });

  it("refuses with import-mismatch when the licence review is of other evidence", () => {
    const i = base();
    const d = only({ ...i, evidence: i.rawEvidence, source: source({ licence: { allow: ["MIT"], reviewed: "sha256:" + "0".repeat(64) } }) });
    expect(d.codes).toEqual(["import-mismatch"]);
  });

  it("lifts scan-blocked with an accepted exception for each high finding", () => {
    const i = base({ ...BASE, "skills/a/scripts/a.sh": "rm -rf /\n" });
    const id = idOf(i);
    const report = i.scans[id]!;
    const high = report.findings.filter((f) => f.severity === "high");
    expect(high.length).toBeGreaterThan(0);
    const exceptions: ScanException[] = high.map((f) => ({
      finding: f.id, skill: id, digest: report.digest, reason: "reviewed", owner: "@example", reviewed: "2026-10-01", expires: "2027-01-01",
    }));
    expect(only(i).codes).toContain("scan-blocked");
    expect(only({ ...i, exceptions }).codes).not.toContain("scan-blocked");
  });

  it("rethrows an error that is not a SkillImportError", () => {
    expect(() => communityPromotionCheck({ ...base(), evidence: null as never })).toThrow(TypeError);
  });

  it("refuses only the skill that does not match, not the others", () => {
    const i = base({ ...BASE, "skills/b/SKILL.md": md("b") });
    const narrow = communityPromotionCheck({ ...i, source: source({ paths: ["skills/a"] }) });
    expect(narrow.map((d) => [d.skill, d.codes])).toEqual([[nameId(i, "a"), []], [nameId(i, "b"), ["import-mismatch"]]]);
  });

  it("refuses a candidate of another source alone and still decides the others", () => {
    const i = base({ ...BASE, "skills/b/SKILL.md": md("b") });
    const b = i.skills.find((s) => s.provenance.name === "b")!;
    const foreign = { ...b, provenance: { ...b.provenance, source: "other", repositoryKey: "github.com/other/skills" } };
    const r = communityPromotionCheck({ ...i, skills: i.skills.map((s) => (s === b ? foreign : s)) });
    expect(r.map((d) => [d.skill, d.codes])).toEqual([[nameId(i, "a"), []], [nameId(i, "b"), ["import-mismatch"]]]);
  });

  it("refuses both copies of a repeated id", () => {
    const i = base();
    const r = communityPromotionCheck({ ...i, skills: [i.skills[0]!, i.skills[0]!] });
    expect(r.map((d) => d.codes)).toEqual([["import-mismatch"], ["import-mismatch"]]);
  });

  it("lists the codes of one skill in the fixed order, each once", () => {
    const i = base(withTech("technologies:\n  spring-boot: '^2'\n"));
    const id = idOf(i);
    const mixed = only({ ...i, scans: {}, fixtures: { [id]: "failed" } });
    expect(mixed.codes).toEqual(["scan-missing", "version-stale", "fixtures-failed"]);
    const more = only({ ...i, scans: {}, fixtures: { [id]: "failed" }, source: source({ status: "disabled", reason: "x" } as Partial<SkillLibrarySource>) });
    expect(more.codes).toEqual(["source-not-enabled", "scan-missing", "version-stale", "fixtures-failed"]);
  });

  it("gives the same output for shuffled input, sorted by skill id", () => {
    const i = base({ ...BASE, "skills/b/SKILL.md": md("b"), "skills/c/SKILL.md": md("c", "technologies:\n  spring-boot: '^2'\n") });
    const a = communityPromotionCheck(i);
    expect(a.map((d) => d.skill)).toEqual(["a", "b", "c"].map((n) => nameId(i, n)).sort());
    const b = communityPromotionCheck({
      ...i,
      skills: [...i.skills].reverse(),
      builtins: [...i.builtins].reverse(),
      scans: Object.fromEntries(Object.entries(i.scans).reverse()),
      fixtures: Object.fromEntries(Object.entries(i.fixtures).reverse()),
    });
    expect(b).toEqual(a);
  });

  it("does not change its input", () => {
    const i = base({ ...BASE, "skills/b/SKILL.md": md("b") });
    const before = JSON.stringify(i);
    communityPromotionCheck(i);
    expect(JSON.stringify(i)).toBe(before);
  });

  it("uses no file system, process or clock", () => {
    const text = readFileSync(new URL("../src/skills/community-promotion.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/node:fs|node:child_process|process\.|Date/);
  });
});

describe("communityPromotionLines", () => {
  it("prints PROMOTABLE and REFUSED lines", () => {
    const decisions: CommunityPromotionDecision[] = [
      { skill: "a-skill", decision: "promotable", codes: [] },
      { skill: "b-skill", decision: "refused", codes: ["scan-missing", "fixtures-failed"] },
    ];
    expect(communityPromotionLines(decisions)).toEqual(["PROMOTABLE a-skill", "REFUSED b-skill: scan-missing, fixtures-failed"]);
  });
});
