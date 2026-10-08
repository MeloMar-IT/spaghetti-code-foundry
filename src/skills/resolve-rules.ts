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
