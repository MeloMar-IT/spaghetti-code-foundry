import type { CanonicalCandidate } from "./canonical.js";
import { CANONICAL_REGISTRY_TIER, CANONICAL_SOURCE_TIER, type CanonicalTier } from "./canonical-rules.js";
import type { CollisionCandidate } from "./collisions.js";
import type { LicenceStatus } from "./licence.js";
import { supportStatus, technologyName } from "./project-technologies.js";
import type { RegisteredSkill } from "./registry.js";
import type { ToolPolicy } from "./schema.js";
import type { SourceStatus } from "./sources.js";
import { policyAllows, skillNeeds } from "./tool-policy.js";
import { parsePartial, rangeSatisfied } from "./version-range.js";

export { rangeSatisfied };

// The facts the canonical selector ranks on, built from what the registry and the importer know. Pure: no file system, no process, no clock.

type Tech = { name: string; version?: string };
type Compat = CanonicalCandidate["compatibility"];
type Gate = CanonicalCandidate["failed"][number];

/** Does the project version `seen` fit the declared range? undefined: it cannot be checked. */
function fits(range: string, seen: string): boolean | undefined {
  const parsed = parsePartial(seen);
  // A version that was given but cannot be read cannot be checked safely.
  if (!parsed || parsed.n === 0) return undefined;
  if (parsed.n === 3) return rangeSatisfied(range, seen);
  // A partial project version (17, 17.1) stands for every version it covers: the range has to agree for the lowest and the highest.
  const fill = (n: number) => [...parsed.parts, n, n].slice(0, 3).join(".");
  const lo = rangeSatisfied(range, fill(0));
  const hi = rangeSatisfied(range, fill(999999));
  return lo === undefined || hi === undefined ? undefined : lo === hi ? lo : undefined;
}

/**
 * How well the technologies a skill declares fit the project evidence. Names are compared after alias mapping (jdk is java);
 * when the evidence names one technology several times (modules with different versions), the declared range has to fit all of them.
 */
export function technologyCompatibility(declared: readonly Tech[], evidence?: readonly Tech[]): Compat {
  if (!evidence || !declared.length) return "generic";
  let misses = 0;
  let unchecked = false;
  let version = false;
  for (const d of declared) {
    const seen = evidence.filter((e) => technologyName(e.name) === technologyName(d.name));
    if (!seen.length) { misses++; continue; }
    for (const s of seen) {
      if (d.version === undefined || s.version === undefined) continue;
      const r = fits(d.version, s.version);
      if (r === undefined) unchecked = true;
      else if (!r) return "incompatible";
      else version = true;
    }
  }
  if (misses === declared.length) return "incompatible";
  if (unchecked) return "unchecked";
  return version ? "version" : "name";
}

/** A declaration that fits no supported release line is never compatible, with or without project evidence. */
const withSupport = (declared: readonly Tech[], evidence?: readonly Tech[]): Compat =>
  supportStatus(declared) === "stale" ? "incompatible" : technologyCompatibility(declared, evidence);

const failedGates = (g: Record<Gate, boolean>): Gate[] => (["safety", "licence", "tools"] as const).filter((k) => g[k]);

export function canonicalFromCollision(
  c: CollisionCandidate,
  facts: { licence: LicenceStatus; sourceStatus?: SourceStatus; safety?: boolean; tools?: ToolPolicy; approvedAt?: string; evidence?: readonly Tech[] },
): CanonicalCandidate {
  const { package: pkg, provenance, identity } = c.skill;
  const status: CanonicalCandidate["status"] =
    facts.sourceStatus === "quarantined" ? "quarantined"
    : facts.sourceStatus === "retired" || facts.sourceStatus === "disabled" ? "revoked"
    : c.approved ? "approved" : "discovery";
  const tier: CanonicalTier = c.approved ? CANONICAL_SOURCE_TIER[c.trust] : "discovery-only";
  const tools = facts.tools;
  const toolsFail = tools !== undefined && skillNeeds(pkg).some((n) => n.startsWith("connector:") || !policyAllows(n as "shell" | "network" | "write", tools));
  return {
    id: identity.id,
    version: identity.version,
    fingerprint: identity.fingerprint,
    capabilities: [...(pkg.capabilities ?? [])],
    category: pkg.category,
    risk: pkg.risk,
    tier,
    status,
    failed: failedGates({ safety: facts.safety === false, licence: facts.licence !== "allowed", tools: toolsFail }),
    compatibility: withSupport(provenance.technologies, facts.evidence),
    ...(c.evaluation !== undefined ? { evaluation: c.evaluation } : {}),
    ...(facts.approvedAt !== undefined ? { approvedAt: facts.approvedAt } : {}),
  };
}

export function canonicalFromRegistered(
  s: RegisteredSkill,
  facts: { licence?: LicenceStatus; safety?: boolean; tools?: ToolPolicy; approvedAt?: string; evaluation?: "passed" | "failed"; technologies?: readonly Tech[]; evidence?: readonly Tech[] } = {},
): CanonicalCandidate {
  const tools = facts.tools;
  const toolsFail = tools !== undefined && skillNeeds(s.pkg).some((n) => n.startsWith("connector:") || !policyAllows(n as "shell" | "network" | "write", tools));
  return {
    id: s.id,
    version: s.version,
    fingerprint: s.digest,
    capabilities: [...(s.pkg.capabilities ?? [])],
    category: s.pkg.category,
    risk: s.pkg.risk,
    tier: CANONICAL_REGISTRY_TIER[s.source],
    status: s.trust === "unapproved" ? "discovery" : "approved",
    failed: failedGates({ safety: facts.safety === false, licence: facts.licence !== undefined && facts.licence !== "allowed", tools: toolsFail }),
    compatibility: withSupport(facts.technologies ?? [], facts.evidence),
    ...(facts.evaluation !== undefined ? { evaluation: facts.evaluation } : {}),
    ...(facts.approvedAt !== undefined ? { approvedAt: facts.approvedAt } : {}),
  };
}
