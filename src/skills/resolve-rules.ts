// Numbers and codes of the skill resolver. Data only: config.ts imports this file.

export const RESOLVE_DEFAULTS = { maxSkills: 6, maxSkillTokens: 5000, maxTokens: 15000 } as const;
export const RESOLVE_RANGE = {
  maxSkills: [1, 20],
  maxSkillTokens: [100, 20000],
  maxTokens: [100, 100000],
  include: 20,
  exclude: 500,
  depth: 32,
} as const;
export const RESOLVE_REASONS = ["mandatory", "requested", "dependency"] as const;
export const RESOLVE_REJECT_CODES = [
  "excluded", "unknown", "unapproved", "unpinned", "mismatch", "unverified", "role", "too-large",
  "dependency-cycle", "dependency-unavailable", "dependency-version", "conflict", "over-count", "over-budget",
  "blocked",
] as const;

// What happens to a skill that cannot be used.
export const UNRESOLVED_KINDS = ["unknown", "missing", "untrusted", "conflict", "oversized"] as const;
export const UNRESOLVED_ACTIONS = ["stop", "warn"] as const;
/** Which kind of policy decides each reject code. */
export const UNRESOLVED_KIND: Record<(typeof RESOLVE_REJECT_CODES)[number], (typeof UNRESOLVED_KINDS)[number]> = {
  unknown: "unknown",
  excluded: "untrusted",
  unapproved: "untrusted",
  unpinned: "untrusted",
  mismatch: "untrusted",
  unverified: "untrusted",
  role: "untrusted",
  "too-large": "oversized",
  "over-count": "oversized",
  "over-budget": "oversized",
  "dependency-unavailable": "missing",
  "dependency-version": "missing",
  "dependency-cycle": "missing",
  conflict: "conflict",
  blocked: "conflict",
};
/** A skill is high risk when its id, category or a capability equals one of these terms (whole hyphen-separated words, no substrings). */
export const UNRESOLVED_HIGH_RISK_DEFAULT = [
  "migration", "migrations", "security", "messaging", "kafka", "rabbitmq", "amqp", "queue", "outbox",
] as const;
export const UNRESOLVED_LIMITS = { messageChars: 400, reasonItems: 3, terms: 50 } as const;
