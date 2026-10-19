import { OUTCOMES, type PolicyDecision } from "./schema.js";

/**
 * Layers of policy packs and which answer wins. Pure.
 * Order: the baseline and the admin's overlays (`mandatory`), the packs of the run's repository, the optional packs.
 */

export const LAYERS = ["mandatory", "repository", "optional"] as const;
export type Layer = (typeof LAYERS)[number];
export interface LayeredDecision {
  layer: Layer;
  decision: PolicyDecision;
}
export interface PackLists {
  mandatory?: readonly string[];
  repositories?: Readonly<Record<string, readonly string[]>>;
  packs?: readonly string[];
}
export interface LayeredPackId {
  id: string;
  layer: Layer;
}

/** The most restrictive outcome; on a tie the higher layer; on a full tie the first. Undefined for no decision. */
export function combineDecisions(ds: readonly LayeredDecision[]): LayeredDecision | undefined {
  let best: LayeredDecision | undefined;
  for (const d of ds) {
    if (!best) {
      best = d;
      continue;
    }
    const a = OUTCOMES.indexOf(d.decision.outcome);
    const b = OUTCOMES.indexOf(best.decision.outcome);
    if (a > b || (a === b && LAYERS.indexOf(d.layer) < LAYERS.indexOf(best.layer))) best = d;
  }
  return best;
}

/** mandatory, then the packs of this repository, then the optional packs; an id seen before is skipped. */
export function layeredPackIds(lists: PackLists, repository: string | undefined): LayeredPackId[] {
  const seen = new Set<string>();
  const out: LayeredPackId[] = [];
  const add = (ids: readonly string[] | undefined, layer: Layer) => {
    for (const id of ids ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, layer });
    }
  };
  add(lists.mandatory, "mandatory");
  const repos = lists.repositories;
  if (repository !== undefined && repos && Object.hasOwn(repos, repository)) add(repos[repository], "repository");
  add(lists.packs, "optional");
  return out;
}
