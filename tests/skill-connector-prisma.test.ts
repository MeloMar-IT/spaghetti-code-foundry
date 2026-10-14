import { describe, expect, it } from "vitest";
import { selectCanonicalSkills, type CanonicalCandidate } from "../src/skills/canonical.js";
import { classifySkillCollisions, collisionCandidate } from "../src/skills/collisions.js";
import {
  applyConnector, connectorCandidate, connectorCompatibility, connectorEvidence, connectorFor, connectorPolicy, declaredVersion,
  evaluationState, UNKNOWN_VERSION, type ConnectedSkill, type EvaluationResult,
} from "../src/skills/connector.js";
import { PRISMA_CONNECTOR, type SourceConnector } from "../src/skills/connector-rules.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { normalizeImport, normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";
import { attributionProblem, promoteImport } from "../src/skills/promotion.js";
import { SKILL_ID_RE } from "../src/skills/schema.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const ORIGIN: NormalizeOrigin = { source: "prisma", repository: "https://github.com/prisma/skills", repositoryKey: "github.com/prisma/skills", commit: COMMIT };
const CONN: SourceConnector = { ...PRISMA_CONNECTOR, reviewed: [COMMIT] };
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text;
type F = { path: string; content: Uint8Array };
const f = (path: string, text: string): F => ({ path, content: new Uint8Array(Buffer.from(text)) });
const doc = (name: string, body = "Do the work.") => [f("SKILL.md", `---\nname: ${name}\ndescription: About ${name}.\n---\n\n${body}\n`)];

function make(name: string, files: F[] = doc(name), origin: NormalizeOrigin = ORIGIN): NormalizedSkill {
  const r = normalizeSkill(origin, { root: `skills/${name}`, files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
}
const source = (over: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
  id: "prisma", repository: ORIGIN.repository, repositoryKey: ORIGIN.repositoryKey, status: "enabled", ref: { approved: COMMIT }, paths: ["skills"],
  adapter: "agent-skills", trust: "verified", licence: { allow: ["MIT"] }, update: { cadence: "manual" }, owner: "@example", ...over,
});
const one = (name: string, files?: F[]): ConnectedSkill => {
  const r = applyConnector(CONN, [make(name, files)]);
  if (!r.mapped[0]) throw new Error("not mapped");
  return r.mapped[0];
};
const passAll = (c: ConnectedSkill): EvaluationResult[] => c.record.evaluations.map((evaluation) => ({ skill: c.record.id, digest: c.record.digest, evaluation, result: "passed" }));
const FIT = [{ name: "prisma", version: "7.1.0" }, { name: "postgresql" }, { name: "node", version: "22.1.0" }];

function candidate(c: ConnectedSkill, o: Partial<Parameters<typeof connectorCandidate>[0]> = {}): CanonicalCandidate {
  return connectorCandidate({ connector: CONN, connected: c, source: source(), licence: "allowed", scanClean: true, results: passAll(c), evidence: FIT, ...o });
}
const resolution = (cs: CanonicalCandidate[], cap: string, policy = connectorPolicy(CONN)) => selectCanonicalSkills(cs, policy).resolutions.find((r) => r.capability === cap)!;

describe("the profile", () => {
  it("is well formed", () => {
    const evalIds = [...PRISMA_CONNECTOR.guard.evaluations];
    for (const r of Object.values(PRISMA_CONNECTOR.skills)) {
      for (const s of [...r.specific, ...r.general, ...r.evaluations, ...r.requirements]) expect(s).toMatch(SKILL_ID_RE);
      evalIds.push(...r.evaluations);
      for (const e of r.engines) expect(PRISMA_CONNECTOR.engines).toContain(e);
      for (const c of r.companions) expect(PRISMA_CONNECTOR.skills).toHaveProperty(c);
      if (r.specific.some((s) => PRISMA_CONNECTOR.highRisk.includes(s))) expect(r.evaluations.length).toBeGreaterThan(0);
    }
    for (const s of [...evalIds, ...PRISMA_CONNECTOR.exclusive]) expect(s).toMatch(SKILL_ID_RE);
    for (const h of PRISMA_CONNECTOR.highRisk) expect(PRISMA_CONNECTOR.exclusive).toContain(h);
    for (const c of PRISMA_CONNECTOR.reviewed) expect(c).toMatch(/^[0-9a-f]{40}$/);
  });
  it("is bound by repository key only", () => {
    expect(connectorFor({ repositoryKey: "github.com/prisma/skills" })).toBe(PRISMA_CONNECTOR);
    expect(connectorFor({ repositoryKey: "github.com/someone/skills" })).toBeUndefined();
    expect(connectorFor({ repositoryKey: "github.com/prisma/skills-fork" })).toBeUndefined();
  });
});

describe("applyConnector", () => {
  it("maps prisma-cli and leaves the input and the identity alone", () => {
    const input = make("prisma-cli");
    const copy = structuredClone(input);
    const { mapped } = applyConnector(CONN, [input]);
    expect(input).toEqual(copy);
    const m = mapped[0]!;
    expect(m.skill.package.category).toBe("database");
    expect(m.skill.package.capabilities).toEqual(["prisma-cli", "prisma-migrations", "prisma-schema"]);
    expect(m.skill.package.risk).toBe("high");
    expect(m.skill.provenance.technologies).toContainEqual({ name: "prisma", version: ">=7 <8" });
    expect(m.skill.package.digest).toBe(input.package.digest);
    expect(m.skill.package.id).toBe(input.package.id);
    expect(m.skill.identity).toEqual(input.identity);
    expect(m.skill.extraFiles).toEqual(input.extraFiles);
    expect(m.skill.provenance.root).toBe(input.provenance.root);
    expect(m.record.original).toEqual({ capabilities: [...(input.package.capabilities ?? [])], category: input.package.category, risk: input.package.risk, technologies: input.provenance.technologies });
  });
  it("separates specific and general capabilities", () => {
    const r = one("prisma-postgres").record;
    expect(r.specific).toEqual(["prisma-postgres"]);
    expect(r.general).toEqual(["postgresql"]);
    for (const x of r.specific) expect(r.general).not.toContain(x);
  });
  it("does not map names the profile does not hold", () => {
    const r = applyConnector(CONN, [make("something-else"), make("prisma-database-setup"), make("constructor"), make("prisma-cli")]);
    expect(r.mapped.map((m) => m.record.name)).toEqual(["prisma-cli"]);
    expect(r.unmapped.map((u) => u.name).sort()).toEqual(["constructor", "prisma-database-setup", "something-else"]);
    expect(r.unmapped.every((u) => u.reason === "not-in-profile")).toBe(true);
    expect(r.absent).toEqual(["prisma-client-api", "prisma-orm-setup", "prisma-postgres", "prisma-upgrade-v7"]);
  });
  it("needs the companions in the import, in a chain too", () => {
    const rule = PRISMA_CONNECTOR.skills["prisma-client-api"]!;
    const test: SourceConnector = { ...CONN, skills: { a: { ...rule, companions: ["b"] }, b: { ...rule, companions: ["c"] }, c: rule } };
    const alone = applyConnector(test, [make("a"), make("b")]);
    expect(alone.mapped).toEqual([]);
    expect(alone.unmapped.map((u) => u.reason)).toEqual(["companion-missing", "companion-missing"]);
    expect(applyConnector(test, [make("a"), make("b"), make("c")]).mapped).toHaveLength(3);
  });
  it("adds the migration evaluations when the text has a migration command", () => {
    const plain = one("prisma-client-api");
    expect(plain.record.evaluations).toEqual([]);
    expect(plain.skill.package.risk).not.toBe("high");
    for (const body of ["Run npx prisma migrate dev now.", "Run prisma  MIGRATE\n  DEPLOY now."]) {
      const g = one("prisma-client-api", doc("prisma-client-api", body));
      expect(g.record.evaluations).toEqual([...PRISMA_CONNECTOR.guard.evaluations].sort());
      expect(g.skill.package.risk).toBe("high");
      expect(g.record.guarded.length).toBe(1);
    }
    const extra = one("prisma-client-api", [...doc("prisma-client-api"), f("references/x.md", "use prisma db push here")]);
    expect(extra.record.guarded).toEqual(["db push"]);
  });
  it("sets reviewed only for a listed commit", () => {
    expect(one("prisma-cli").record.reviewed).toBe(true);
    expect(applyConnector(PRISMA_CONNECTOR, [make("prisma-cli")]).mapped[0]!.record.reviewed).toBe(false);
  });
  it("throws for a skill of another repository", () => {
    const other: NormalizeOrigin = { source: "x", repository: "https://github.com/x/skills", repositoryKey: "github.com/x/skills", commit: COMMIT };
    expect(() => applyConnector(CONN, [make("prisma-cli", undefined, other)])).toThrow(TypeError);
  });
  it("gives the same result for any input order", () => {
    const a = [make("prisma-cli"), make("prisma-postgres"), make("zzz")];
    expect(applyConnector(CONN, [...a].reverse())).toEqual(applyConnector(CONN, a));
  });
});

describe("declaredVersion", () => {
  it.each([
    ["6.2.0", "6.2.0"], ["v6.2.0", "6.2.0"], ["^6.2.0", "6"], ["~6.2.0", "6.2"], ["~6", "6"], ["6", "6"], ["6.x", "6"], ["6.2.x", "6.2"],
    ["<6.0.0", UNKNOWN_VERSION], ["<=6.0.0", UNKNOWN_VERSION], [">5.0.0", UNKNOWN_VERSION], [">=6.0.0", UNKNOWN_VERSION], ["*", UNKNOWN_VERSION],
    ["^0.4.0", UNKNOWN_VERSION], ["latest", UNKNOWN_VERSION], ["workspace:*", UNKNOWN_VERSION], ["catalog:", UNKNOWN_VERSION],
  ])("%s", (value, want) => expect(declaredVersion(value)).toBe(want));
  it("passes undefined through", () => expect(declaredVersion(undefined)).toBeUndefined());
});

const finding = (name: string, value?: string, kind: "dependency" | "command" = "dependency") =>
  ({ kind, name, ...(value !== undefined ? { value } : {}), path: "package.json", detector: "deps", reason: "r" }) as never;
const profile = (...findings: unknown[]) => ({ findings: findings as never[] });

describe("connectorEvidence", () => {
  it("reads versions, engines and runtime", () => {
    expect(connectorEvidence(CONN, profile(finding("@prisma/client", "^6.2.0"), finding("pg", "8.0.0"), finding("node", "22.1.0")))).toEqual([
      { name: "node", version: "22.1.0" }, { name: "postgresql" }, { name: "prisma", version: "6" },
    ]);
  });
  it("is unknown when the packages disagree, name only without a value", () => {
    expect(connectorEvidence(CONN, profile(finding("prisma", "7.1.0"), finding("@prisma/client", "6.0.0")))).toEqual([{ name: "prisma", version: UNKNOWN_VERSION }]);
    expect(connectorEvidence(CONN, profile(finding("prisma")))).toEqual([{ name: "prisma" }]);
  });
  it("ignores other kinds", () => expect(connectorEvidence(CONN, profile(finding("prisma", "7.1.0", "command")))).toEqual([]));
});

describe("connectorCompatibility", () => {
  const rec = (name: string) => one(name).record;
  const cc = (name: string, ev?: { name: string; version?: string }[]) => connectorCompatibility(CONN, rec(name), ev);
  const up = (ev: { name: string; version?: string }[]) => cc("prisma-upgrade-v7", ev);
  it("handles missing evidence", () => {
    expect(cc("prisma-client-api")).toBe("generic");
    expect(cc("prisma-cli")).toBe("unchecked");
  });
  it("rejects a project without Prisma", () => expect(cc("prisma-client-api", [{ name: "postgresql" }])).toBe("incompatible"));
  it("checks the upgrade skill", () => {
    expect(up([{ name: "prisma", version: "5.9.0" }, { name: "postgresql" }, { name: "node", version: "22.1.0" }])).toBe("incompatible");
    expect(up([{ name: "prisma", version: "6.2.0" }, { name: "postgresql" }, { name: "node", version: "22.1.0" }])).toBe("version");
    for (const v of [undefined, UNKNOWN_VERSION]) expect(up([{ name: "prisma", ...(v ? { version: v } : {}) }, { name: "postgresql" }, { name: "node", version: "22.1.0" }])).toBe("unchecked");
    expect(up([{ name: "prisma", version: "6.2.0" }, { name: "mongodb" }, { name: "node", version: "22.1.0" }])).toBe("incompatible");
    expect(up([{ name: "prisma", version: "6.2.0" }, { name: "postgresql" }, { name: "node", version: "18.20.0" }])).toBe("incompatible");
    expect(up([{ name: "prisma", version: "6.2.0" }, { name: "postgresql" }])).toBe("unchecked");
    expect(up([{ name: "prisma", version: "6.2.0" }, { name: "postgresql" }, { name: "node", version: UNKNOWN_VERSION }])).toBe("unchecked");
  });
  it("never reads a declared range as an installed version", () => {
    for (const range of ["<6.0.0", ">=6.0.0"]) {
      const ev = connectorEvidence(CONN, profile(finding("prisma", range), finding("pg"), finding("node", "22.1.0")));
      expect(up(ev)).toBe("unchecked");
    }
  });
  it("checks the CLI skill range", () => {
    expect(cc("prisma-cli", [{ name: "prisma", version: "6.19.0" }, { name: "postgresql" }])).toBe("incompatible");
    expect(cc("prisma-cli", [{ name: "prisma", version: "7" }, { name: "postgresql" }])).toBe("version");
  });
  it("checks engines", () => {
    expect(cc("prisma-postgres", [{ name: "prisma" }, { name: "mongodb" }])).not.toBe("name");
    expect(cc("prisma-postgres", [{ name: "prisma" }, { name: "mongodb" }])).toBe("incompatible");
    expect(cc("prisma-postgres", [{ name: "prisma" }, { name: "postgresql" }, { name: "mysql" }])).not.toBe("incompatible");
  });
  it("engine evidence: high risk without it is unchecked, low risk is not", () => {
    expect(cc("prisma-postgres", [{ name: "prisma" }])).toBe("unchecked");
    expect(cc("prisma-client-api", [{ name: "prisma" }])).toBe("name");
  });
});

describe("evaluationState", () => {
  const c = one("prisma-upgrade-v7");
  const r = c.record;
  const res = (evaluation: string, result: "passed" | "failed" = "passed", over: Partial<EvaluationResult> = {}): EvaluationResult => ({ skill: r.id, digest: r.digest, evaluation, result, ...over });
  it("covers the states", () => {
    expect(evaluationState(one("prisma-client-api").record, []).state).toBe("not-required");
    expect(evaluationState(r, [])).toEqual({ state: "missing", missing: r.evaluations, failed: [] });
    expect(evaluationState(r, passAll(c)).state).toBe("passed");
    expect(evaluationState(r, [...passAll(c).slice(1), res(r.evaluations[0]!, "failed")]).state).toBe("failed");
  });
  it("ignores other digests, other skills and unknown evaluations", () => {
    const all = r.evaluations.map((e) => res(e));
    expect(evaluationState(r, all.map((x) => ({ ...x, digest: "sha256:" + "0".repeat(64) }))).state).toBe("missing");
    expect(evaluationState(r, all.map((x) => ({ ...x, skill: "other" }))).state).toBe("missing");
    expect(evaluationState(r, [...all.slice(1), res("unknown-eval")]).state).toBe("missing");
  });
});

describe("selection", () => {
  it("excludes migration guidance without passed evaluations", () => {
    const c = one("prisma-cli");
    const none = resolution([candidate(c, { results: [] })], "prisma-migrations");
    expect(none.outcome).toBe("none");
    expect(none.rejected[0]!.code).toBe("safety");
    expect(resolution([candidate(c)], "prisma-migrations").outcome).toBe("selected");
  });
  it("fails safety for a dirty scan or an unreviewed commit, licence for a licence in review", () => {
    const c = one("prisma-cli");
    expect(resolution([candidate(c, { scanClean: false })], "prisma-migrations").rejected[0]!.code).toBe("safety");
    const unreviewed = applyConnector(PRISMA_CONNECTOR, [make("prisma-cli")]).mapped[0]!;
    expect(resolution([candidate(unreviewed, { connector: PRISMA_CONNECTOR, results: passAll(unreviewed) })], "prisma-migrations").rejected[0]!.code).toBe("safety");
    expect(resolution([candidate(c, { licence: "review" })], "prisma-migrations").rejected[0]!.code).toBe("licence");
  });
  it("ignores a project pin on the failing skill", () => {
    const c = one("prisma-cli");
    const cand = candidate(c, { results: [] });
    const r = selectCanonicalSkills([cand], { ...connectorPolicy(CONN), pins: { "prisma-migrations": cand.id } }).resolutions.find((x) => x.capability === "prisma-migrations")!;
    expect(r.ignored).toEqual([{ level: "project-pin", value: cand.id, reason: "not-eligible" }]);
  });
  it("treats the upgrade skill the same way", () => {
    const c = one("prisma-upgrade-v7");
    expect(resolution([candidate(c, { results: [] })], "prisma-upgrade").rejected[0]!.code).toBe("safety");
    expect(resolution([candidate(c)], "prisma-upgrade").outcome).toBe("selected");
    for (const range of [undefined, "<6.0.0"]) {
      const ev = connectorEvidence(CONN, profile(finding("prisma", range), finding("pg"), finding("node", "22.1.0")));
      expect(resolution([candidate(c, { evidence: ev })], "prisma-upgrade").outcome).not.toBe("selected");
    }
  });
  it("gates general capabilities of a high-risk skill too", () => {
    const c = one("prisma-postgres");
    expect(resolution([candidate(c, { results: [] })], "postgresql").rejected[0]!.code).toBe("safety");
    expect(resolution([candidate(c)], "postgresql").outcome).toBe("selected");
  });
});

describe("PostgreSQL duplicates", () => {
  const OTHER: NormalizeOrigin = { source: "other", repository: "https://github.com/other/skills", repositoryKey: "github.com/other/skills", commit: "b".repeat(40) };
  const otherSource = (trust: SkillLibrarySource["trust"]) => source({ id: "other", repository: OTHER.repository, repositoryKey: OTHER.repositoryKey, ref: { approved: OTHER.commit }, trust });
  const pgFiles = [f("SKILL.md", "---\nname: pg-guide\ndescription: Postgres.\ncapabilities: [postgresql]\n---\n\nUse PostgreSQL.\n")];
  const other = () => make("pg-guide", pgFiles, OTHER);
  const asCanon = (trust: SkillLibrarySource["trust"], extra: Partial<CanonicalCandidate> = {}): CanonicalCandidate => ({
    ...connectorCandidate({ connector: CONN, connected: { skill: other(), record: { ...one("prisma-client-api").record, id: other().package.id, digest: other().package.digest, evaluations: [] } }, source: otherSource(trust), licence: "allowed", scanClean: true, results: [] }),
    ...extra,
  });
  it("reports an overlap and decides by trust tier", () => {
    const prisma = one("prisma-postgres");
    const o = other();
    expect(o.package.capabilities).toContain("postgresql");
    const report = classifySkillCollisions([collisionCandidate(prisma.skill, source()), collisionCandidate(o, otherSource("community"))]);
    expect(report.report.collisions).toMatchObject([{ class: "capability-overlap", shared: ["postgresql"], blocking: false }]);
    const p = candidate(prisma);
    const win = resolution([p, asCanon("community")], "postgresql");
    expect(win.winner!.id).toBe(prisma.skill.package.id);
    expect(win.decidedBy).toBe("trust-tier");
    const lose = resolution([candidate(prisma, { source: source({ trust: "community" }) }), asCanon("community", { tier: "official-vendor" })], "postgresql");
    expect(lose.winner!.id).toBe(o.package.id);
  });
  it("is a tie when the facts are equal and postgresql is high risk", () => {
    const prisma = one("prisma-postgres");
    const p = candidate(prisma);
    const twin: CanonicalCandidate = { ...p, id: "twin", fingerprint: "sha256:" + "9".repeat(64) };
    const r = resolution([p, twin], "postgresql", { exclusive: ["postgresql"], highRisk: ["postgresql"] });
    expect(r.outcome).toBe("conflict");
    expect(r.conflict).toBe("tie");
  });
  it("merges the same content from a second source record into one entry", () => {
    const o1 = make("pg-guide", pgFiles, { ...OTHER, source: "m1" });
    const o2 = make("pg-guide", pgFiles, { ...OTHER, source: "m2" });
    const s = (id: string) => otherSource("community") && { ...otherSource("community"), id };
    const result = classifySkillCollisions([collisionCandidate(o1, s("m1")), collisionCandidate(o2, s("m2"))]);
    expect(result.entries).toHaveLength(1);
    expect(result.report.collisions.map((c) => c.class)).toContain("exact-mirror");
  });
});

describe("licence and provenance", () => {
  function setup(files: Record<string, string>) {
    const content = new Map(Object.entries(files).map(([p, t]) => [p, Buffer.from(t)]));
    const all: TreeEntry[] = [...content].map(([path, b]) => ({ path, kind: "file", size: b.byteLength, id: "id:" + path }));
    const tree: SourceTree = { list: (p) => all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/")), read: (es) => es.map((e) => content.get(e.path)!) };
    const src = source();
    const prep = prepareImport(src, tree);
    const { skills } = normalizeImport(prep);
    const evidence = collectLicenceEvidence({ repositoryKey: src.repositoryKey, commit: COMMIT }, skills.map((s) => s.provenance.root), tree);
    const { mapped } = applyConnector(CONN, skills);
    return promoteImport({ source: src, record: prep.record, skills: mapped.map((m) => m.skill), evidence, retrievedAt: "2026-10-12T10:00:00Z" });
  }
  const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
  it("keeps commit, path, licences and attribution", () => {
    const r = setup({ "skills/prisma-cli/SKILL.md": md("prisma-cli"), "skills/prisma-cli/LICENSE": MIT, "skills/prisma-cli/NOTICE": "Copyright (c) 2024 Prisma\n" });
    expect(r.manifest.refused).toEqual([]);
    const p = r.manifest.packages[0]!;
    expect(p).toMatchObject({ commit: COMMIT, path: "skills/prisma-cli", name: "prisma-cli" });
    expect(p.licences).toContain("MIT");
    expect(p.licenceFiles.length).toBeGreaterThan(0);
    expect(p.attribution.length).toBeGreaterThan(0);
    const kept = r.promoted[0]!;
    expect(attributionProblem(kept.provenance, kept.attribution)).toBeUndefined();
  });
  it("refuses a skill without a licence file", () => {
    const r = setup({ "skills/prisma-cli/SKILL.md": md("prisma-cli") });
    expect(r.manifest.refused.map((x) => x.status)).toEqual(["missing"]);
    expect(r.promoted).toEqual([]);
  });
});

describe("connectorPolicy", () => {
  it("returns copies", () => {
    const p = connectorPolicy(CONN);
    p.exclusive = [];
    expect(CONN.exclusive.length).toBeGreaterThan(0);
  });
});
