import { describe, expect, it } from "vitest";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { canonicalLicenceEvidence } from "../src/skills/import-licence.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { reviewImport } from "../src/skills/licence-review.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { normalizeImport } from "../src/skills/normalize.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { ToolPolicySchema } from "../src/skills/schema.js";
import { applySourceScope, evaluateSource, evaluationFailed, evaluationLines, type SourceEvaluation } from "../src/skills/source-evaluation.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text;
const NOTICE = "Copyright (c) 2025 Oracle and/or its affiliates.\n";
const TOOLS = ToolPolicySchema.parse({});
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
  paths: ["db"],
  adapter: "agent-skills",
  trust: "first-party",
  licence: { allow: ["MIT"] },
  scope: { capabilities: ["oracle"], technologies: [{ name: "oracle", version: ">=19" }] },
  update: { cadence: "manual" },
  owner: "@example",
  ...over,
});
const GOOD = { LICENSE: MIT, "db/NOTICE": NOTICE, "db/sql/SKILL.md": md("sql") };

const installed = (o: { id?: string; source?: "builtin" | "admin"; pin?: RegisteredSkill["pin"]; caps?: string[]; label?: string } = {}): RegisteredSkill =>
  ({
    key: `${o.id ?? "oracle"}@1.0.0`,
    id: o.id ?? "oracle",
    version: "1.0.0",
    source: o.source ?? "builtin",
    label: o.label ?? "built-in",
    active: true,
    trust: o.source === "admin" ? "approved" : "builtin",
    pin: o.pin ?? "pinned",
    digest: "sha256:" + "b".repeat(64),
    pkg: { capabilities: o.caps ?? ["oracle"], category: "database", risk: "low" },
  }) as unknown as RegisteredSkill;

function run(files: Record<string, string>, over: Partial<SkillLibrarySource> = {}, more: Partial<Parameters<typeof evaluateSource>[0]> = {}): SourceEvaluation {
  const src = source(over);
  const t = tree(files);
  const prep = prepareImport(src, t);
  const evidence = collectLicenceEvidence({ repositoryKey: src.repositoryKey, commit: COMMIT }, prep.record.skills.map((s) => s.root), t);
  return evaluateSource({
    source: src, prep, evidence, installed: [installed()], exceptions: [], today: "2026-10-13", retrievedAt: "2026-10-13T10:00:00Z",
    tools: TOOLS, highRisk: [], ...more,
  });
}
const lines = (e: SourceEvaluation) => evaluationLines(e);
const pick = (e: SourceEvaluation, prefix: string) => lines(e).filter((l) => l.startsWith(prefix));
const rejection = (e: SourceEvaluation, idPrefix: string) => e.comparison.resolutions[0]!.rejected.find((r) => r.id.startsWith(idPrefix));

describe("applySourceScope", () => {
  const norm = (extra = "") => {
    const src = source();
    const prep = prepareImport(src, tree({ "db/sql/SKILL.md": md("sql", extra) }));
    return { skill: normalizeImport(prep).skills[0]!, src };
  };
  it("adds the capability and the range with origin source", () => {
    const { skill, src } = norm();
    const r = applySourceScope(skill, src);
    expect(r.ok && r.skill.package.capabilities).toContain("oracle");
    expect(r.ok && r.skill.provenance.technologies).toEqual([{ name: "oracle", version: ">=19" }]);
    expect(r.ok && r.origins).toEqual({ oracle: "source" });
  });
  it("leaves the input, the digest and the fingerprint alone", () => {
    const { skill, src } = norm();
    const before = JSON.stringify(skill);
    const r = applySourceScope(skill, src);
    expect(JSON.stringify(skill)).toBe(before);
    expect(r.ok && r.skill.package.digest).toBe(skill.package.digest);
    expect(r.ok && r.skill.identity.fingerprint).toBe(skill.identity.fingerprint);
  });
  it("returns the skill unchanged without a scope", () => {
    const { skill } = norm();
    const r = applySourceScope(skill, { id: "lib" });
    expect(r.ok && r.skill).toBe(skill);
  });
  it("throws for another source", () => {
    const { skill } = norm();
    expect(() => applySourceScope(skill, { id: "other" })).toThrow(TypeError);
  });
  it("refuses more than 32 capabilities", () => {
    const caps = Array.from({ length: 30 }, (_, i) => `cap-${i}`).join(", ");
    const { skill } = norm(`capabilities: [${caps}]\n`);
    const r = applySourceScope(skill, { id: "lib", scope: { capabilities: ["x-1", "x-2", "x-3"], technologies: [] } });
    expect(r.ok).toBe(false);
  });
});

describe("evaluateSource", () => {
  it("prints compatibility, tools, access, licence and notice lines", () => {
    const e = run(GOOD);
    expect(e.skills).toHaveLength(1);
    expect(pick(e, "COMPATIBILITY")[0]).toMatch(/^COMPATIBILITY lib-sql-\w+: oracle >=19 \(source\)$/);
    expect(pick(e, "TOOLS")[0]).toMatch(/: none declared$/);
    expect(pick(e, "ACCESS")[0]).toMatch(/: asks for nothing; importing grants none$/);
    expect(pick(e, "LICENCE")[0]).toMatch(/: allowed MIT$/);
    expect(pick(e, "NOTICE")[0]).toMatch(/: kept 2 files: LICENSE, db\/NOTICE$/);
    expect(e.manifest.packages[0]!.attribution.map((a) => a.path)).toEqual(["LICENSE", "db/NOTICE"]);
  });
  it("prints none declared when a skill and its source name no technology", () => {
    const e = run(GOOD, { scope: undefined });
    expect(pick(e, "COMPATIBILITY")[0]).toMatch(/: none declared$/);
  });

  it("decides canonical selection by project evidence", () => {
    const old = run(GOOD, {}, { project: [{ name: "oracle", version: "12.2" }] });
    expect(rejection(old, "lib-sql")!.code).toBe("incompatible");
    expect(pick(old, "RECOMMEND")[0]).toContain("oracle@1.0.0");
    const ok = run(GOOD, {}, { project: [{ name: "oracle", version: "19" }] });
    const res = ok.comparison.resolutions[0]!;
    expect(res.winner!.id).toMatch(/^lib-sql/);
    expect(res.decidedBy).toBe("compatibility");
  });
  it("reports an incompatible skill even when no installed skill overlaps", () => {
    const e = run(GOOD, {}, { installed: [], project: [{ name: "oracle", version: "12.2" }] });
    expect(e.shared).toEqual([]);
    expect(e.skills[0]!.compatibility).toBe("incompatible");
    expect(pick(e, "COMPATIBILITY")[0]).toMatch(/oracle >=19 \(source\); project: incompatible$/);
    expect(evaluationFailed(e)).toBe(true);
    const ok = run(GOOD, {}, { installed: [], project: [{ name: "oracle", version: "19" }] });
    expect(ok.skills[0]!.compatibility).toBe("version");
    expect(evaluationFailed(ok)).toBe(false);
  });
  it("prefers the built-in skill over a verified source by trust tier", () => {
    const e = run(GOOD, { trust: "verified" });
    expect(pick(e, "RECOMMEND")[0]).toMatch(/^RECOMMEND oracle: oracle@1\.0\.0 \(scf-curated, by trust-tier\)/);
  });
  it("reports an explicit conflict for a high-risk tie", () => {
    const e = run(GOOD, {}, { highRisk: ["oracle"] });
    expect(pick(e, "CONFLICT oracle:")).toHaveLength(1);
    expect(pick(e, "RECOMMEND")).toEqual([]);
    expect(e.comparison.ok).toBe(false);
    expect(evaluationFailed(e)).toBe(true);
  });

  it("never recommends an installed skill whose pin fails", () => {
    for (const [pin, text] of [["mismatch", "does not match its pin"], ["unverified", "cannot be verified, the skill lock cannot be read"]] as const) {
      const e = run(GOOD, {}, { installed: [installed({ source: "admin", label: "admin", pin })] });
      expect(pick(e, "INTEGRITY")[0]).toContain(text);
      const rec = pick(e, "RECOMMEND oracle:");
      expect(rec).toHaveLength(1);
      expect(rec[0]).toContain("oracle@1.0.0 (safety)");
      expect(rec[0]).toMatch(/^RECOMMEND oracle: lib-sql/);
      expect(evaluationFailed(e)).toBe(true);
    }
  });
  it("prints NONE when no skill is eligible", () => {
    const e = run({ "db/sql/SKILL.md": md("sql") }, {}, { installed: [installed({ source: "admin", pin: "mismatch" })] });
    expect(pick(e, "NONE oracle:")).toHaveLength(1);
  });
  it("does not print INTEGRITY for pinned or unpinned skills", () => {
    for (const pin of ["pinned", "unpinned"] as const) {
      expect(pick(run(GOOD, {}, { installed: [installed({ pin })] }), "INTEGRITY")).toEqual([]);
    }
  });

  it("prints the tools a skill declares and what they need", () => {
    const read = run({ ...GOOD, "db/sql/SKILL.md": md("sql", "allowed-tools: Read Grep\n") });
    expect(pick(read, "TOOLS")[0]).toMatch(/: Grep, Read$/);
    expect(pick(read, "ACCESS")[0]).toMatch(/: asks for nothing; importing grants none$/);
    const bash = run({ ...GOOD, "db/sql/SKILL.md": md("sql", "allowed-tools: Bash(sqlplus:*)\n") });
    expect(pick(bash, "TOOLS")[0]).toMatch(/: Bash$/);
    expect(bash.skills[0]!.needs).toContain("shell");
    expect(pick(bash, "ACCESS")[0]).toContain("shell");
  });
  it("excludes a skill that names a connector with code tools", () => {
    const e = run({ ...GOOD, "db/sql/SKILL.md": md("sql", "allowed-tools: Bash mcp__oci__list_instances\n") });
    expect(e.skills[0]!.connectors).toEqual(["oci"]);
    expect(pick(e, "TOOLS")[0]).toContain("mcp__oci__list_instances");
    expect(pick(e, "ACCESS")[0]).toContain("connector:oci");
    expect(rejection(e, "lib-sql")!.code).toBe("tools");
  });
  it("refuses a skill that holds a credential and prints no value", () => {
    const token = "sk-" + "ant-" + "abcdefghijklmnopqrstuvwx";
    const e = run({ ...GOOD, "db/sql/SKILL.md": md("sql") + `\nkey = ${token}\n`, "db/ok/SKILL.md": md("ok") });
    expect(lines(e).join("\n")).not.toContain(token);
    expect(e.refused.length + e.skills.filter((s) => s.blockers > 0).length).toBeGreaterThan(0);
    expect(evaluationFailed(e)).toBe(true);
  });

  it("lists only skills of the selected domain", () => {
    const e = run({ ...GOOD, "oci/x/SKILL.md": md("x"), "apex/y/SKILL.md": md("y"), "graalvm/z/SKILL.md": md("z", "capabilities: [vm]\n") });
    expect(e.skills).toHaveLength(1);
    expect(e.manifest.packages).toHaveLength(1);
    expect(lines(e).join("\n")).not.toMatch(/oci|apex|graalvm/);
    expect(e.shared).toEqual(["oracle"]);
  });
  it("refuses a domain folder with skills below its own SKILL.md, and accepts leaf paths", () => {
    const files = { LICENSE: MIT, "oci/SKILL.md": md("oci"), "oci/compute/SKILL.md": md("compute"), "oci/network/SKILL.md": md("network") };
    expect(() => run(files, { paths: ["oci"] })).toThrow(/no skill could be staged/);
    const leaf = run(files, { paths: ["oci/compute", "oci/network"] });
    expect(leaf.skills).toHaveLength(2);
    expect(leaf.refused).toEqual([]);
  });

  it("refuses a licence outside the allowed list", () => {
    const e = run(GOOD, { licence: { allow: ["Apache-2.0"] } });
    expect(pick(e, "REFUSED")[0]).toMatch(/^REFUSED db\/sql: licence rejected: /);
    expect(e.manifest.packages).toEqual([]);
  });
  it("refuses a missing licence", () => {
    const e = run({ "db/sql/SKILL.md": md("sql") });
    expect(e.skills[0]!.licence.status).toBe("missing");
  });
  it("fails closed for an unknown licence, and the built-in skill is still recommended", () => {
    const e = run({ "db/sql/SKILL.md": md("sql"), "db/sql/LICENSE.txt": "Copyright (c) 2025 Oracle and/or its affiliates.\n\nThe Universal Permissive License (UPL), Version 1.0\n" });
    expect(e.skills[0]!.licence.status).not.toBe("allowed");
    expect(e.manifest.packages).toEqual([]);
    expect(pick(e, "REFUSED")[0]).toMatch(/licence /);
    const rec = pick(e, "RECOMMEND oracle:");
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatch(/^RECOMMEND oracle: oracle@1\.0\.0 .*lib-sql-\w+@\S+ \(licence\)/);
    expect(evaluationFailed(e)).toBe(true);
  });

  it("prints the same lines for shuffled installed input", () => {
    const a = installed({ id: "oracle" });
    const b = installed({ id: "other", caps: ["oracle"], source: "admin", label: "admin", pin: "mismatch" });
    expect(lines(run(GOOD, {}, { installed: [a, b] }))).toEqual(lines(run(GOOD, {}, { installed: [b, a] })));
  });
});

describe("evaluateSource: licence review", () => {
  it("shows review for a stale licence.reviewed", () => {
    const e = run(GOOD, { licence: { allow: ["MIT"], reviewed: "sha256:" + "0".repeat(64) } });
    expect(e.skills[0]!.licence.status).toBe("review");
  });
  it("accepts the digest of the staged form of the same tree, also with a LICENSE/license collision", () => {
    const files = { ...GOOD, license: MIT, "db/sql/LICENSE": MIT };
    const src = source();
    const t = tree(files);
    const prep = prepareImport(src, t);
    const live = collectLicenceEvidence({ repositoryKey: src.repositoryKey, commit: COMMIT }, prep.record.skills.map((s) => s.root), t);
    const staged = reviewImport({ allow: ["MIT"], prep, evidence: canonicalLicenceEvidence(live) }).classification.digest;
    const e = run(files, { licence: { allow: ["MIT"], reviewed: staged } });
    expect(e.skills[0]!.licence.status).toBe("allowed");
  });
});
