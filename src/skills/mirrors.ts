import { createHash } from "node:crypto";
import type { CanonicalCandidate } from "./canonical.js";
import { CANONICAL_REGISTRY_TIER, CANONICAL_TIERS, type CanonicalTier } from "./canonical-rules.js";
import { byteCmp } from "./import-plan.js";
import type { RegisteredSkill } from "./registry.js";

// Mirrors: skills whose description and instructions render to the same text. Pure. The payload, the resolver and the
// catalogue use one key, so "same key" means "the same bytes would reach the model".

export const MIRROR_LIMITS = { recorded: 50 } as const;

const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** Any tag that looks like one of ours, in any case or spacing: its `<` is escaped so it cannot close or open a block. */
const OWN_TAG = /<(\s*\/?\s*foundry-skill)/gi;

export const safeSkillText = (s: string): string => s.replace(/\r\n?/g, "\n").replace(CONTROL, "").replace(OWN_TAG, "&lt;$1");
export const oneLineSkillText = (s: string): string => safeSkillText(s).replace(/\s+/g, " ").trim();

/** The text between the opening and the closing tag of a section. */
export const sectionBody = (description: string, body: string): string => `${oneLineSkillText(description)}\n\n${safeSkillText(body).trim()}`;

export const textKey = (description: string, body: string): string => `sha256:${createHash("sha256").update(sectionBody(description, body)).digest("hex")}`;

/** `sha256:` of the description and instructions as the payload renders them. Never reads the id, the version or skill.yaml. */
export const instructionKey = (pkg: { description: string; instructions: string }): string => textKey(pkg.description, pkg.instructions);

/** The same for a reviewer block: the description and REVIEW.md. */
export const reviewKey = (s: { description: string; review: string }): string => textKey(s.description, s.review);

export interface MirrorRank { id: string; version: string; tier: CanonicalTier }

/** Best tier first, then id, then version, in byte order. */
export const compareMirrors = (a: MirrorRank, b: MirrorRank): number =>
  CANONICAL_TIERS.indexOf(a.tier) - CANONICAL_TIERS.indexOf(b.tier) || byteCmp(a.id, b.id) || byteCmp(a.version, b.version);

export interface MirrorGroup<T> { key: string; kept: T; collapsed: T[] }

/**
 * One item per key. `kept` holds the kept items in input order; `groups` only the keys with copies, sorted by the kept
 * id@version, each with its collapsed copies in `compareMirrors` order. The result does not depend on the input order.
 */
export function collapseMirrors<T>(items: readonly T[], keyOf: (t: T) => string, rankOf: (t: T) => MirrorRank): { kept: T[]; groups: MirrorGroup<T>[] } {
  const by = new Map<string, T[]>();
  for (const t of items) {
    const k = keyOf(t);
    const list = by.get(k);
    if (list) list.push(t);
    else by.set(k, [t]);
  }
  const keptSet = new Set<T>();
  const groups: MirrorGroup<T>[] = [];
  for (const [key, list] of by) {
    const sorted = [...list].sort((a, b) => compareMirrors(rankOf(a), rankOf(b)));
    keptSet.add(sorted[0]!);
    if (sorted.length > 1) groups.push({ key, kept: sorted[0]!, collapsed: sorted.slice(1) });
  }
  const at = (t: T) => `${rankOf(t).id}@${rankOf(t).version}`;
  groups.sort((a, b) => byteCmp(at(a.kept), at(b.kept)));
  return { kept: items.filter((t) => keptSet.has(t)), groups };
}

export const registryRank = (s: Pick<RegisteredSkill, "id" | "version" | "source">): MirrorRank => ({ id: s.id, version: s.version, tier: CANONICAL_REGISTRY_TIER[s.source] });

/** The candidate fields that must match for two copies to merge in the canonical selection. */
export function safetyProfile(c: CanonicalCandidate, withheld: boolean): string {
  return JSON.stringify([
    [...c.capabilities].sort(byteCmp), c.category, c.risk, c.status, [...c.failed].sort(byteCmp), c.compatibility, c.evaluation ?? null, withheld,
    [...(c.composable ?? [])].sort(byteCmp),
  ]);
}
