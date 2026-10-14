import { selectCanonicalSkills, type CanonicalCandidate, type CanonicalResult } from "./canonical.js";
import { canonicalFromCollision } from "./canonical-facts.js";
import { classifySkillCollisions, type CollisionCandidate, type CollisionReport } from "./collisions.js";
import { AREA_TERMS, EVALUATION_AREAS, type EvaluationArea } from "./import-review-rules.js";
import { byteCmp } from "./import-plan.js";
import { supportStatus } from "./project-technologies.js";
import type { LicenceStatus } from "./licence.js";
import type { NormalizedSkill } from "./normalize.js";

// Compares imported skills with the skills that exist: which areas they cover, which capabilities they share, and which
// collisions hold them back. Uses the canonical policy of canonical.ts. Pure: no file system, no process, no clock.
// Every imported copy carries its own facts (trust, licence verdict, safety); none is taken from another copy.

export interface ImportedCandidate {
  candidate: CollisionCandidate;
  licence: LicenceStatus;
  safety: boolean;
}
export interface EvaluatedSkill {
  id: string;
  name: string;
  root: string;
  fingerprint: string;
  areas: EvaluationArea[];
  /** Sorted by capability. `existing`: ids of existing skills that declare it. `winner`: id of the canonical winner, when one was selected. */
  overlaps: { capability: string; existing: string[]; winner?: string }[];
  /** Sorted ids of the blocking collisions that hold this skill back. */
  blockedBy: string[];
  /** `stale`: the skill declares Java, Spring or build tool versions that fit no supported release line (see technology-rules.ts). */
  outcome: "new" | "duplicate" | "blocked" | "stale";
}
export interface ImportEvaluation {
  schema: 1;
  skills: EvaluatedSkill[];
  collisions: CollisionReport;
  canonical: CanonicalResult;
}

const sorted = (a: Iterable<string>): string[] => [...a].sort(byteCmp);

/** The areas a skill belongs to, by its category, its capabilities and the hyphen-bounded parts of its upstream name. */
export function evaluationAreas(skill: NormalizedSkill): EvaluationArea[] {
  const { package: pkg, provenance } = skill;
  const exact = new Set([pkg.category, ...(pkg.capabilities ?? [])]);
  const name = `-${provenance.name.toLowerCase()}-`;
  return EVALUATION_AREAS.filter((area) => AREA_TERMS[area].some((t) => exact.has(t) || name.includes(`-${t}-`)));
}

export function evaluateImport(input: {
  imported: readonly ImportedCandidate[];
  existing: readonly CanonicalCandidate[];
  highRisk?: readonly string[];
}): ImportEvaluation {
  const { imported, existing } = input;
  const result = classifySkillCollisions(imported.map((i) => i.candidate));
  const entryOf = new Map(result.entries.map((e) => [e.fingerprint, e]));
  const fp = (i: ImportedCandidate) => i.candidate.skill.identity.fingerprint;
  const eligible = imported.filter((i) => (entryOf.get(fp(i))?.blockedBy.length ?? 0) === 0);
  const canonical = eligible.map((i) => canonicalFromCollision(i.candidate, { licence: i.licence, safety: i.safety }));

  const caps = (e: { skill: NormalizedSkill }) => e.skill.package.capabilities ?? [];
  const existingBy = new Map<string, Set<string>>();
  for (const c of existing) for (const cap of c.capabilities) (existingBy.get(cap) ?? existingBy.set(cap, new Set()).get(cap)!).add(c.id);
  const importedBy = new Map<string, Set<string>>();
  for (const i of eligible) for (const cap of caps(i.candidate)) (importedBy.get(cap) ?? importedBy.set(cap, new Set()).get(cap)!).add(fp(i));

  const exclusive = new Set<string>();
  for (const i of eligible) {
    for (const cap of caps(i.candidate)) {
      const others = [...(importedBy.get(cap) ?? [])].some((f) => f !== fp(i));
      if (existingBy.has(cap) || others) exclusive.add(cap);
    }
  }
  const selection = selectCanonicalSkills([...existing, ...canonical], { exclusive: sorted(exclusive), highRisk: input.highRisk ?? [] });
  const winners = new Map(selection.resolutions.map((r) => [r.capability, r.winner?.id]));

  const skills = result.entries.map((e): EvaluatedSkill => {
    const blocked = e.blockedBy.length > 0;
    const overlaps = sorted(new Set(caps(e)))
      .filter((cap) => existingBy.has(cap) || (!blocked && [...(importedBy.get(cap) ?? [])].some((f) => f !== e.fingerprint)))
      .map((cap) => {
        const winner = blocked ? undefined : winners.get(cap);
        return { capability: cap, existing: sorted(existingBy.get(cap) ?? []), ...(winner === undefined ? {} : { winner }) };
      });
    return {
      id: e.skill.identity.id,
      name: e.skill.provenance.name,
      root: e.skill.provenance.root,
      fingerprint: e.fingerprint,
      areas: evaluationAreas(e.skill),
      overlaps,
      blockedBy: [...e.blockedBy],
      outcome: blocked ? "blocked" : supportStatus(e.skill.provenance.technologies) === "stale" ? "stale" : overlaps.length > 0 ? "duplicate" : "new",
    };
  });
  skills.sort((a, b) => byteCmp(a.id, b.id) || byteCmp(a.fingerprint, b.fingerprint));
  return { schema: 1, skills, collisions: result.report, canonical: selection };
}
