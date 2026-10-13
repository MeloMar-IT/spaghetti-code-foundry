// Data for the import review: what keeps an imported skill from promotion, and the areas the evaluation reports.
// Only data: no code runs here. Patterns start with a word boundary and a literal, have bounded gaps and no nested quantifiers.

export const EXCLUSION_CODES = ["connector", "network", "network-use", "plugin-file", "mcp-config", "integration-key"] as const;
export type ExclusionCode = (typeof EXCLUSION_CODES)[number];

/** Lower-case. `name` is a file name, `segment` a folder name anywhere in the path. */
export const EXCLUSION_FILES: readonly { code: ExclusionCode; name?: string; segment?: string }[] = [
  { code: "mcp-config", name: ".mcp.json" },
  { code: "plugin-file", name: "plugin.json" },
  { code: "plugin-file", segment: ".plugin" },
];

/** Keys that declare a live integration, in the frontmatter, `metadata` or `skill.yaml`. */
export const EXCLUSION_KEYS: readonly string[] = ["mcp_tools"];

/** `says` is a fixed phrase; the matched text is never shown. `any`: instructions and every text file. `script`: executable content only. `shell`: executable content, and any text when the skill declares a shell tool (its instructions are then actionable). */
export const NETWORK_USE_RULES: readonly { id: string; scope: "any" | "script" | "shell"; says: string; re: RegExp }[] = [
  { id: "web-client", scope: "any", says: "runs a web client command", re: /\b(?:curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b/i },
  {
    id: "service-cli",
    scope: "any",
    says: "runs the command line tool of a hosted service",
    re: /\b(?:gh|glab)\s{1,8}(?:api|pr|issue|repo|release|run|workflow|auth|gist|search)\b/,
  },
  { id: "git-remote", scope: "shell", says: "runs a remote git command", re: /\bgit\s{1,8}(?:clone|fetch|pull|push|ls-remote)\b/ },
  {
    id: "web-call",
    scope: "script",
    says: "calls a web address from code",
    re: /\brequests\.(?:get|post|put|delete|patch|head|request)\s{0,4}\(|\burllib\.request\b|\burlopen\s{0,4}\(|\bhttp\.client\b|\bhttpx\.|\baxios\b|\bfetch\s{0,4}\(/,
  },
  {
    id: "web-address",
    scope: "script",
    says: "holds a web address",
    re: /\bhttps?:\/\/(?!localhost\b|127\.|0\.0\.0\.0|\[::1\]|(?:[\w-]{1,63}\.){0,4}(?:example\.(?:com|org|net)|example|test|invalid|localhost)(?![\w.-]))[^\s"'<>)\]]{1,120}/i,
  },
];

export const EVALUATION_AREAS = ["code-review", "documentation", "development-workflow"] as const;
export type EvaluationArea = (typeof EVALUATION_AREAS)[number];
export const AREA_TERMS: Record<EvaluationArea, readonly string[]> = {
  "code-review": ["code-review", "review", "reviewer", "pr-review"],
  documentation: ["documentation", "docs", "readme", "changelog", "docstring"],
  "development-workflow": ["workflow", "git", "commit", "pull-request", "release", "ci", "branch", "merge", "rebase"],
};
