// Owner overrides and project pins: limits, codes and words. Data only; choices.ts and project-pins.ts use it.

export const PINS_FILE = ".claude-factory/skill-pins.yaml";
export const OVERRIDES_FILE = "skill-overrides.yaml";
export const CHOICE_LIMITS = { entries: 200, reasonChars: 300, repositories: 50, bytes: 65536, recorded: 100, gitMs: 10000 } as const;
export const CHOICE_LEVELS = ["project-pin", "owner-override"] as const;
export const CHOICE_PROBLEMS = [
  "invalid", "no-default-branch", "unreadable", "unchecked", // the file or the run
  "expired", "not-exclusive", // the entry
  "missing", "not-active", "not-usable", "ambiguous-record", "revoked", "quarantined", "unapproved", // the target
  "safety", "licence", "tools", "incompatible", "compatibility-unchecked",
] as const;
/** code → the words used in the stop line. */
export const CHOICE_PROBLEM_TEXT: Record<(typeof CHOICE_PROBLEMS)[number], string> = {
  invalid: "which is not valid",
  "no-default-branch": "which cannot be read because the default branch is not known",
  unreadable: "which cannot be read",
  unchecked: "which could not be checked",
  expired: "which has expired",
  "not-exclusive": "but that capability is not exclusive, so the choice would do nothing",
  missing: "which is not installed",
  "not-active": "which is installed but is not the active version of that skill",
  "not-usable": "which does not provide that capability or cannot be loaded by this run",
  "ambiguous-record": "whose records disagree",
  revoked: "which is revoked",
  quarantined: "which is quarantined",
  unapproved: "which is not approved",
  safety: "which failed the safety check",
  licence: "which failed the licence check",
  tools: "which failed the tools check",
  incompatible: "which is not compatible with this repository",
  "compatibility-unchecked": "whose compatibility with this repository is not checked",
};
export const DEFAULT_BRANCH_HEAD = "refs/remotes/origin/HEAD";
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
