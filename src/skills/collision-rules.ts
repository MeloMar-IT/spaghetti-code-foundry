// What collisions between normalized skills are called. Data only; collisions.ts uses it.

/** First bytes of what a collision id hashes. Changing it changes every collision id. */
export const COLLISION_ID_HEADER = "scf-skill-collision-v1\n";
export const COLLISION_CLASSES = ["exact-mirror", "version-reuse", "id-conflict", "fork", "capability-overlap"] as const;
export type CollisionClass = (typeof COLLISION_CLASSES)[number];
export const COLLISION_REASONS = {
  "mirror.settings-differ": "The same content, but the approved copies differ in skill.yaml settings.",
  "mirror.same-artifact": "The same skill, version and content through more than one source record.",
  "mirror.same-content": "The same content from another repository or under another version.",
  "version.reused": "The same skill and version with other content.",
  "id.other-version": "The same skill at another version with other content.",
  "id.other-upstream": "The same id from another repository with other content.",
  "fork.declared-upstream": "Other content, with a recorded link to the other repository.",
  "fork.same-name": "Other content under the same declared name in another repository.",
  "capability.shared": "Different skills that declare the same capability.",
} as const;
export type CollisionReason = keyof typeof COLLISION_REASONS;
export const COLLISION_LIMITS = { candidates: 1000, idHex: 16 } as const;
/** Classes and reasons that hold an entry back from the planner when the approved members of every unit are in them. */
export const COLLISION_BLOCKING_CLASSES: readonly CollisionClass[] = ["version-reuse", "id-conflict"];
export const COLLISION_BLOCKING_REASONS: readonly CollisionReason[] = ["mirror.settings-differ"];
