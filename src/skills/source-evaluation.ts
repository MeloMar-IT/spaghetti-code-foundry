import { canonicalFromCollision, canonicalFromRegistered, technologyCompatibility } from "./canonical-facts.js";
import { selectCanonicalSkills, type CanonicalCandidate, type CanonicalResult } from "./canonical.js";
import { CANONICAL_LIMITS } from "./canonical-rules.js";
import { COLLISION_LIMITS } from "./collision-rules.js";
import { collisionCandidate } from "./collisions.js";
import { byteCmp, SkillImportError, type ImportRecord, type RejectedSkill } from "./import-plan.js";
import type { LicenceEvidence, LicenceStatus } from "./licence.js";
import { reviewImport } from "./licence-review.js";
import type { NormalizedSkill } from "./normalize.js";
import { promoteImport, type PromotionManifest } from "./promotion.js";
import type { RegisteredSkill } from "./registry.js";
import type { SkillRisk, ToolPolicy } from "./schema.js";
import { scanSkill } from "./scan.js";
import { applyExceptions, promotionBlockers, type ScanException } from "./scan-exceptions.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";
import { skillNeeds } from "./tool-policy.js";

// Evaluates what a source record offers: compatibility, tools, access, licence and overlap with the installed skills.
// Pure: no file system, no process, no clock. Used by `scf skills evaluate`; it stages and writes nothing.

export { evaluateSourceSkills, type SourceSkillsEvaluation, type SourceSkillsInput, type SourceSkillVerdict } from "./source-skill-evaluation.js";

export type TechnologyOrigin = "skill" | "source";
type Tech = { name: string; version?: string };

const MAX_CAPABILITIES = 32;

/** Adds the capabilities and technology ranges the source record states. A range the skill declares itself wins. Never changes its input. */
export function applySourceScope(
  skill: NormalizedSkill,
  source: Pick<SkillLibrarySource, "id" | "scope">,
): { ok: true; skill: NormalizedSkill; origins: Record<string, TechnologyOrigin> } | { ok: false; reasons: string[] } {
  if (skill.provenance.source !== source.id) throw new TypeError("the skill does not come from this source record");
  const origins: Record<string, TechnologyOrigin> = {};
  for (const t of skill.provenance.technologies) origins[t.name] = "skill";
  const scope = source.scope;
  if (!scope) return { ok: true, skill, origins };

  const capabilities = [...new Set([...(skill.package.capabilities ?? []), ...scope.capabilities])].sort(byteCmp);
  if (capabilities.length > MAX_CAPABILITIES) return { ok: false, reasons: [`capabilities: more than ${MAX_CAPABILITIES} entries with the source scope`] };

  const technologies: Tech[] = skill.provenance.technologies.map((t) => ({ ...t }));
  for (const add of scope.technologies) {
    const at = technologies.findIndex((t) => t.name === add.name);
    if (at < 0) {
      technologies.push({ name: add.name, version: add.version });
      origins[add.name] = "source";
    } else if (technologies[at]!.version === undefined) {
      technologies[at] = { name: add.name, version: add.version };
      origins[add.name] = "source";
    }
  }
  technologies.sort((a, b) => byteCmp(a.name, b.name));
  return {
    ok: true,
    origins,
    skill: {
      ...skill,
      package: { ...skill.package, capabilities },
      provenance: { ...skill.provenance, technologies },
    },
  };
}

export interface EvaluatedSkill {
  /** Fit with the project technologies; absent when none were given. */
  compatibility?: ReturnType<typeof technologyCompatibility>;
  root: string;
  id: string;
  name: string;
  version: string;
  digest: string;
  capabilities: string[];
  technologies: { name: string; version?: string; from: TechnologyOrigin }[];
  requiredTools: string[];
  connectors: string[];
  needs: string[];
  risk: SkillRisk;
  licence: { status: LicenceStatus | "excluded"; licences: string[]; reasons: string[]; attribution: string[]; authorNotice: string[] };
  blockers: number;
}
export interface InstalledIntegrity {
  key: string;
  label: string;
  pin: "mismatch" | "unverified";
}
export interface SourceEvaluation {
  schema: 1;
  source: string;
  repositoryKey: string;
  commit: string;
  digest: string;
  /** Sorted by id. */
  skills: EvaluatedSkill[];
  /** Not staged, not normalized, or the scope cannot be applied. Sorted by root. */
  refused: RejectedSkill[];
  /** Active installed skills that cannot be trusted. Sorted by key. */
  integrity: InstalledIntegrity[];
  /** Capabilities an imported and an installed skill both provide. */
  shared: string[];
  comparison: CanonicalResult;
  manifest: PromotionManifest;
}

const inside = (root: string, p: string) => root === "." || p === root || p.startsWith(root + "/");

export function evaluateSource(input: {
  source: SkillLibrarySource;
  prep: { record: ImportRecord; files: ReadonlyMap<string, Uint8Array> };
  evidence: LicenceEvidence;
  installed: readonly RegisteredSkill[];
  exceptions: readonly ScanException[];
  today: string;
  retrievedAt: string;
  tools: ToolPolicy;
  highRisk: readonly string[];
  project?: readonly Tech[];
}): SourceEvaluation {
  const { source, prep, evidence, installed, exceptions, today, tools, highRisk, project } = input;
  const review = reviewImport({ allow: source.licence.allow, prep, evidence });
  const { skills: normalized, report } = review.normalized;
  const refused: RejectedSkill[] = report.quarantined.map((q) => ({ root: q.root, reasons: [...q.reasons] }));

  const scoped: { skill: NormalizedSkill; origins: Record<string, TechnologyOrigin> }[] = [];
  for (const n of normalized) {
    const r = applySourceScope(n, source);
    if (r.ok) scoped.push({ skill: r.skill, origins: r.origins });
    else refused.push({ root: shownValue(n.provenance.root), reasons: r.reasons });
  }

  const promotion = promoteImport({ source, record: prep.record, skills: scoped.map((s) => s.skill), evidence: review.evidence, retrievedAt: input.retrievedAt, review });
  const manifest = promotion.manifest;

  const evaluated: { e: EvaluatedSkill; skill: NormalizedSkill }[] = [];
  for (const { skill, origins } of scoped) {
    const { package: pkg, provenance } = skill;
    const files: { path: string; content: Uint8Array }[] = [];
    for (const [path, content] of prep.files) {
      if (inside(provenance.root, path)) files.push({ path: provenance.root === "." ? path : path.slice(provenance.root.length + 1), content });
    }
    const decided = applyExceptions(pkg.id, scanSkill({ root: provenance.root, files }), exceptions, today);
    const blockers = promotionBlockers(decided).length;

    const promoted = manifest.packages.find((p) => p.path === provenance.root);
    const refusal = manifest.refused.find((r) => r.root === shownValue(provenance.root));
    const licence: EvaluatedSkill["licence"] = promoted
      ? { status: "allowed", licences: [...promoted.licences], reasons: [], attribution: promoted.attribution.map((a) => a.path), authorNotice: [...promoted.authorNotice] }
      : { status: refusal?.status ?? "missing", licences: [], reasons: [...(refusal?.reasons ?? [])], attribution: [], authorNotice: [] };

    evaluated.push({
      skill,
      e: {
        ...(project ? { compatibility: technologyCompatibility(provenance.technologies, project) } : {}),
        root: provenance.root,
        id: pkg.id,
        name: provenance.name,
        version: pkg.version,
        digest: pkg.digest,
        capabilities: [...(pkg.capabilities ?? [])],
        technologies: provenance.technologies.map((t) => ({ ...t, from: origins[t.name] ?? "skill" })),
        requiredTools: [...provenance.requiredTools].sort(byteCmp),
        connectors: [...(pkg.connectors ?? [])],
        needs: skillNeeds(pkg),
        risk: pkg.risk,
        licence,
        blockers,
      },
    });
  }
  evaluated.sort((a, b) => byteCmp(a.e.id, b.e.id));
  refused.sort((a, b) => byteCmp(a.root, b.root) || byteCmp(a.reasons[0] ?? "", b.reasons[0] ?? ""));

  // An excluded skill (live integration, network, plugin configuration) says nothing about its licence: a connector shows as
  // the "tools" gate; any other exclusion is held back by the "safety" gate.
  const imported: CanonicalCandidate[] = evaluated.map(({ skill, e }) =>
    canonicalFromCollision(collisionCandidate(skill, source), {
      licence: e.licence.status === "excluded" ? "allowed" : e.licence.status,
      sourceStatus: source.status,
      safety: e.blockers === 0 && !(e.licence.status === "excluded" && e.connectors.length === 0),
      tools,
      ...(project ? { evidence: project } : {}),
    }),
  );

  const integrity: InstalledIntegrity[] = [];
  const present: CanonicalCandidate[] = [];
  for (const s of installed) {
    if (!s.active) continue;
    const bad = s.pin === "mismatch" || s.pin === "unverified";
    if (bad) integrity.push({ key: s.key, label: s.label, pin: s.pin as "mismatch" | "unverified" });
    present.push(canonicalFromRegistered(s, { tools, ...(project ? { evidence: project } : {}), ...(bad ? { safety: false } : {}) }));
  }
  integrity.sort((a, b) => byteCmp(a.key, b.key));

  const importedCaps = new Set(imported.flatMap((c) => c.capabilities));
  const shared = [...new Set(present.flatMap((c) => c.capabilities).filter((c) => importedCaps.has(c)))].sort(byteCmp);
  if (shared.length > CANONICAL_LIMITS.exclusive) throw new SkillImportError("too-many-skills", `more than ${CANONICAL_LIMITS.exclusive} capabilities are shared with installed skills`);
  if (imported.length + present.length > COLLISION_LIMITS.candidates) throw new SkillImportError("too-many-skills", `more than ${COLLISION_LIMITS.candidates} skills to compare`);
  const comparison = selectCanonicalSkills([...imported, ...present], { exclusive: shared, highRisk });

  return {
    schema: 1,
    source: source.id,
    repositoryKey: source.repositoryKey,
    commit: prep.record.commit,
    digest: prep.record.digest,
    skills: evaluated.map((x) => x.e),
    refused,
    integrity,
    shared,
    comparison,
    manifest,
  };
}

export function evaluationFailed(e: SourceEvaluation): boolean {
  return e.refused.length > 0 || e.integrity.length > 0 || e.skills.some((s) => s.licence.status !== "allowed" || s.blockers > 0 || s.compatibility === "incompatible" || s.compatibility === "unchecked") || !e.comparison.ok;
}

const label = (r: { id: string; version: string }) => `${r.id}@${r.version}`;

/** The report. Free text goes through shownValue; ids, slugs and codes are printed as they are. */
export function evaluationLines(e: SourceEvaluation): string[] {
  const out: string[] = [];
  const list = (a: readonly string[]) => a.map(shownValue).join(", ");
  for (const s of e.skills) {
    out.push(`SKILL ${s.id} ${s.version} ${shownValue(s.root)} capabilities=${s.capabilities.length ? s.capabilities.join(",") : "-"} risk=${s.risk}`);
    out.push(
      `COMPATIBILITY ${s.id}: ` +
        (s.technologies.length ? s.technologies.map((t) => `${t.name}${t.version !== undefined ? ` ${shownValue(t.version)}` : ""} (${t.from})`).join(", ") : "none declared") +
        (s.compatibility !== undefined ? `; project: ${s.compatibility}` : ""),
    );
    out.push(`TOOLS ${s.id}: ${s.requiredTools.length ? list(s.requiredTools) : "none declared"}`);
    out.push(`ACCESS ${s.id}: asks for ${s.needs.length ? s.needs.join(", ") : "nothing"}; importing grants none`);
    if (s.licence.status === "allowed") out.push(`LICENCE ${s.id}: allowed ${list(s.licence.licences)}`);
    else out.push(`REFUSED ${shownValue(s.root)}: licence ${s.licence.status}: ${list(s.licence.reasons)}`);
    if (s.licence.attribution.length) out.push(`NOTICE ${s.id}: kept ${s.licence.attribution.length} files: ${list(s.licence.attribution)}`);
    if (s.blockers > 0) out.push(`BLOCKED ${s.id}: ${s.blockers} high findings; see "scf skills scan"`);
  }
  for (const r of e.refused) out.push(`REFUSED ${r.root}: ${list(r.reasons)}`);
  for (const i of e.integrity) {
    const [id, version] = i.key.split("@");
    out.push(
      `INTEGRITY ${id}@${version} (${shownValue(i.label)}): ` +
        (i.pin === "mismatch" ? "does not match its pin; not recommended" : "cannot be verified, the skill lock cannot be read; not recommended"),
    );
  }
  let conflicts = 0;
  const byCap = new Map(e.comparison.resolutions.map((r) => [r.capability, r]));
  for (const cap of e.shared) {
    const r = byCap.get(cap);
    if (!r) continue;
    const notChosen = r.rejected.map((x) => `${label(x)} (${x.code}${x.level ? ` at ${x.level}` : ""})`);
    if (r.outcome === "selected" && r.winner) {
      out.push(`RECOMMEND ${cap}: ${label(r.winner)} (${r.winner.tier}, by ${r.decidedBy}); not chosen: ${notChosen.length ? notChosen.join(", ") : "none"}`);
    } else if (r.outcome === "conflict") {
      conflicts++;
      out.push(`CONFLICT ${cap}: ${r.message ?? "no skill could be chosen"}`);
    } else {
      out.push(`NONE ${cap}: no eligible skill${notChosen.length ? `; ${notChosen.join(", ")}` : ""}`);
    }
  }
  out.push(`EVALUATED ${e.skills.length} skills from ${e.repositoryKey}@${e.commit.slice(0, 12)} ${e.digest}: ${e.refused.length + e.skills.filter((s) => s.licence.status !== "allowed").length} refused, ${conflicts} conflicts`);
  return out;
}
