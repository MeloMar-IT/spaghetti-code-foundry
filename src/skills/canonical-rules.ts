import type { SkillSourceKind } from "./registry.js";
import type { SourceTrustTier } from "./sources.js";

// How one canonical skill is chosen. Data only; canonical.ts and canonical-facts.ts use it.

/** Best first. `local` is an administrator folder, a local owner choice above every catalogue tier. An approved catalogue release ranks with built-ins. */
export const CANONICAL_TIERS = ["local", "scf-curated", "official-vendor", "vetted-community", "discovery-only"] as const;
export type CanonicalTier = (typeof CANONICAL_TIERS)[number];
export const CANONICAL_SOURCE_TIER: Record<SourceTrustTier, CanonicalTier> = {
  "first-party": "scf-curated",
  verified: "official-vendor",
  community: "vetted-community",
};
export const CANONICAL_REGISTRY_TIER: Record<SkillSourceKind, CanonicalTier> = {
  admin: "local",
  builtin: "scf-curated",
  catalogue: "scf-curated",
  repository: "discovery-only",
};
/** In the order they are applied. */
export const CANONICAL_LEVELS = ["project-pin", "owner-override", "trust-tier", "compatibility", "evaluation", "specificity", "freshness", "lexical"] as const;
export type CanonicalLevel = (typeof CANONICAL_LEVELS)[number];
/** Levels that may not decide a high-risk capability. */
export const CANONICAL_WEAK_LEVELS: readonly CanonicalLevel[] = ["freshness", "lexical"];
export const CANONICAL_STATUSES = ["approved", "discovery", "quarantined", "revoked"] as const;
export const CANONICAL_GATES = ["safety", "licence", "tools"] as const;
/** The first nine exclude a candidate, in this order. */
export const CANONICAL_REJECT_CODES = [
  "ambiguous-record", "revoked", "quarantined", "discovery-only", "safety", "licence", "tools", "incompatible", "compatibility-unchecked",
  "outranked", "tied", "held", "overlap",
] as const;
export const CANONICAL_CONFLICTS = ["tie", "mandatory", "winners-overlap"] as const;
export const CANONICAL_LIMITS = { exclusive: 200, messageKeys: 5 } as const;
/** The watcher and the evaluations know this prefix (SKILL_REFUSED_RE). */
export const CANONICAL_STOP_PREFIX = "skills not resolved: ";
