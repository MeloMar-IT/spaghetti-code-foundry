import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalFromCollision } from "../src/skills/canonical-facts.js";
import { selectCanonicalSkills } from "../src/skills/canonical.js";
import { classifySkillCollisions, collisionCandidate } from "../src/skills/collisions.js";
import { connectorFor, connectorSource } from "../src/skills/connectors.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { reviewImport } from "../src/skills/licence-review.js";
import { normalizeImport, type NormalizedSkill } from "../src/skills/normalize.js";
import { promoteImport } from "../src/skills/promotion.js";
import { ToolPolicySchema } from "../src/skills/schema.js";
import { checkSkillTools, skillNeeds, type Capabilities, type SkillToolNeed } from "../src/skills/tool-policy.js";
import { parseSources, type SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const NOW = "2026-10-13T10:00:00Z";
const APACHE = readFileSync("tests/fixtures/licences/apache-2.0.txt", "utf8");
const PROPRIETARY = "These materials are proprietary. All rights reserved. Use is governed by your agreement.\n";
const UNKNOWN = "All rights reserved. Use is governed by your agreement.\n";
const md = (name: string, extra = "", body = "Body.") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\n${body}\n`;

function tree(files: Record<string, string>): SourceTree {
  const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
  const all: TreeEntry[] = [...content].map(([path, bytes]) => ({ path, kind: "file", size: bytes.byteLength, id: "id:" + path }));
  return {
    list: (p) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")),
    read: (entries) => entries.map((e) => content.get(e.path) ?? new Uint8Array(0)),
  };
}
const FILES: Record<string, string> = {
  "THIRD_PARTY_NOTICES.md": "Notices for third party material.\n",
  "skills/mcp-builder/SKILL.md": md("mcp-builder", "license: Complete terms in LICENSE.txt\n", "Use WebFetch to load a page."),
  "skills/mcp-builder/LICENSE.txt": APACHE,
  "skills/skill-creator/SKILL.md": md("skill-creator", "license: Complete terms in LICENSE.txt\n"),
  "skills/skill-creator/LICENSE.txt": APACHE,
  "skills/docx/SKILL.md": md("docx", "license: Proprietary. LICENSE.txt has complete terms\n"),
  "skills/docx/LICENSE.txt": PROPRIETARY,
  "skills/pdf/SKILL.md": md("pdf"),
  "skills/pdf/LICENSE.txt": UNKNOWN,
  "skills/bare/SKILL.md": md("bare"),
};
const connector = connectorFor("github.com/anthropics/skills")!;
const sourceOf = (reviewed?: string): SkillLibrarySource => {
  const s = connectorSource(connector, { commit: COMMIT, owner: "@example" });
  return reviewed === undefined ? s : { ...s, licence: { ...s.licence, reviewed } };
};

function setup(files: Record<string, string>, reviewed?: string | "matching") {
  const base = sourceOf();
  const t = tree(files);
  const prep = prepareImport(base, t);
  const evidence = collectLicenceEvidence({ repositoryKey: base.repositoryKey, commit: COMMIT }, prep.record.skills.map((s) => s.root), t);
  const review = reviewImport({ allow: base.licence.allow, prep, evidence });
  const src = sourceOf(reviewed === "matching" ? review.classification.digest : reviewed);
  const skills = review.normalized.skills;
  return { src, prep, review, skills, digest: review.classification.digest };
}
const promote = (s: ReturnType<typeof setup>, skills: readonly NormalizedSkill[] = s.skills) =>
  promoteImport({ source: s.src, record: s.prep.record, skills, evidence: s.review.evidence, retrievedAt: NOW, review: s.review });
const status = (r: ReturnType<typeof promote>, root: string) => r.manifest.refused.find((x) => x.root === root)?.status;

describe("the anthropic-skills connector", () => {
  it("classifies the five folders", () => {
    const c = setup(FILES).review.classification;
    expect(c.paths.map((p) => [p.root, p.status])).toEqual([
      ["skills/bare", "missing"],
      ["skills/docx", "rejected"],
      ["skills/mcp-builder", "allowed"],
      ["skills/pdf", "ambiguous"],
      ["skills/skill-creator", "allowed"],
    ]);
  });

  it("promotes nothing without licence.reviewed; the Apache folders are refused with review", () => {
    const r = promote(setup(FILES));
    expect(r.promoted).toEqual([]);
    expect(status(r, "skills/mcp-builder")).toBe("review");
    expect(status(r, "skills/skill-creator")).toBe("review");
    expect(status(r, "skills/docx")).toBe("rejected");
    expect(status(r, "skills/pdf")).toBe("ambiguous");
    expect(status(r, "skills/bare")).toBe("missing");
  });

  it("promotes exactly the two Apache folders with the matching digest, keeping the notices", () => {
    const r = promote(setup(FILES, "matching"));
    expect(r.promoted.map((p) => p.provenance.path)).toEqual(["skills/mcp-builder", "skills/skill-creator"]);
    for (const p of r.promoted) expect(p.attribution.map((a) => a.path)).toEqual(["THIRD_PARTY_NOTICES.md", `${p.provenance.path}/LICENSE.txt`].sort());
  });

  it("refuses with a stale digest after a skill licence changes", () => {
    const digest = setup(FILES).digest;
    const r = promote(setup({ ...FILES, "skills/mcp-builder/LICENSE.txt": PROPRIETARY }, digest));
    expect(r.promoted).toEqual([]);
    expect(status(r, "skills/skill-creator")).toBe("review");
    expect(r.manifest.refused.find((x) => x.root === "skills/skill-creator")!.reasons[0]).toContain("changed since it was reviewed");
  });

  it("refuses with a stale digest after a root LICENSE is added", () => {
    const digest = setup(FILES).digest;
    const r = promote(setup({ ...FILES, LICENSE: APACHE }, digest));
    expect(r.promoted).toEqual([]);
    expect(status(r, "skills/mcp-builder")).toBe("review");
  });

  it("refuses an entry of this repository with other trust, paths or licences", () => {
    const entry = {
      id: "anthropic-skills", repository: connector.repository, status: "enabled", ref: { track: "main", approved: COMMIT }, paths: ["skills"],
      adapter: "agent-skills", trust: "verified", licence: { allow: ["Apache-2.0"] }, update: { cadence: "manual" }, owner: "@example",
    };
    const parse = (over: Record<string, unknown>) => parseSources({ schema: 1, sources: [{ ...entry, ...over }] }).problems.map((p) => p.message).join("; ");
    expect(parse({})).toBe("");
    expect(parse({ licence: { allow: ["Apache-2.0"], reviewed: "sha256:" + "0".repeat(64) } })).toBe("");
    expect(parse({ trust: "community" })).toContain("trust must be verified");
    expect(parse({ paths: ["."] })).toContain("paths");
    expect(parse({ licence: { allow: ["MIT"] } })).toContain("licence.allow");
  });

  it("makes the same content through a community source an exact mirror, and picks the official copy", () => {
    const a = setup(FILES, "matching");
    const community: SkillLibrarySource = { ...a.src, id: "mirror", repository: "https://github.com/example/mirror", repositoryKey: "github.com/example/mirror", trust: "community", paths: ["skills"] };
    const mirrorPrep = prepareImport(community, tree(FILES));
    const mirrorSkill = normalizeImport(mirrorPrep).skills.find((s) => s.provenance.name === "skill-creator")!;
    const official = a.skills.find((s) => s.provenance.name === "skill-creator")!;
    const cands = [collisionCandidate(official, a.src), collisionCandidate(mirrorSkill, community)];
    const result = classifySkillCollisions(cands);
    expect(result.report.collisions.map((c) => c.class)).toContain("exact-mirror");

    const canon = cands.map((c) => ({ ...canonicalFromCollision(c, { licence: "allowed" }), capabilities: ["cap"] }));
    const res = selectCanonicalSkills(canon, { exclusive: ["cap"], highRisk: [] }).resolutions.find((r) => r.capability === "cap")!;
    expect(res.decidedBy).toBe("trust-tier");
    expect(res.winner?.id).toBe(official.package.id);

    const docx = a.skills.find((s) => s.provenance.name === "docx")!;
    const rej = selectCanonicalSkills(
      [{ ...canonicalFromCollision(collisionCandidate(docx, a.src), { licence: "rejected" }), capabilities: ["cap2"] }],
      { exclusive: ["cap2"], highRisk: [] },
    ).resolutions.find((r) => r.capability === "cap2")!;
    expect(rej.rejected[0]?.code).toBe("licence");
  });

  it("reads allowed-tools as a tool profile and the tool gate refuses a shell", () => {
    const s = setup({ ...FILES, "skills/sh/SKILL.md": md("sh", "allowed-tools: Bash(git:*) Read\n"), "skills/sh/LICENSE.txt": APACHE }).skills.find((x) => x.provenance.name === "sh")!;
    expect(s.package.tool_profile.shell).toBe(true);
    const caps: Capabilities = { shell: true, network: true, filesystem: "write", sources: { shell: "x", network: "x", filesystem: "x" } };
    const need: SkillToolNeed = { key: s.package.id, id: s.package.id, selection: "requested", requiredBy: [], pkg: s.package };
    const check = checkSkillTools([need], caps, ToolPolicySchema.parse({ shell: false }), "flow");
    expect(skillNeeds(s.package)).toContain("shell");
    expect(check.missing.map((m) => m.code)).toContain("tool-not-approved");
  });

  it("records a tool named only in the instructions and grants nothing", () => {
    const s = setup(FILES).skills.find((x) => x.provenance.name === "mcp-builder")!;
    expect(s.provenance.assumes).toEqual(["claude-tools"]);
    expect(s.package.tool_profile.network).toBe(false);
    expect(s.package.allowedTools).toBeUndefined();
    expect(s.provenance.requiredTools).toEqual([]);
  });
});
