// Rules of the normalizer (normalize.ts). Data only, like resolve-rules.ts.

/** First bytes of what a source-qualified skill id hashes. Changing it renames every imported skill. */
export const NORMALIZE_ID_HEADER = "scf-skill-id-v1\n";

export const NORMALIZE_LIMITS = {
  idReadable: 51,
  idHash: 12,
  upstreamBytes: 16384,
  technologies: 32,
  tools: 64,
  rangeChars: 64,
  connectors: 16,
  yamlDepth: 16,
  yamlNodes: 2000,
} as const;

/** How the upstream skill lays out its metadata; recorded in the provenance. */
export const SKILL_LAYOUTS = ["plain", "metadata", "extended", "foundry"] as const;

/** Frontmatter keys of the Agent Skills standard. */
export const STANDARD_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"] as const;

/** Spellings that are read for one field, in order. */
export const FIELD_ALIASES = {
  version: ["version"],
  capabilities: ["capabilities", "tags", "keywords"],
  composable: ["composable"],
  category: ["category"],
  dependencies: ["dependencies", "depends-on"],
  technologies: ["technologies", "requires", "engines"],
  tools: ["tools"],
  provider: ["provider"],
} as const;

/** Keys of skill.yaml that are read; the others are kept as provenance. */
export const MANIFEST_FIELDS = ["version", "capabilities", "composable", "dependencies", "category", "tool_profile", "connectors", "risk", "provider"] as const;

export const MCP_TOOL_PREFIX = "mcp__";

/** What a tool may do. A tool that is not listed and is not an MCP tool counts as shell, network and write. */
export const TOOL_EFFECTS: Record<string, "shell" | "network" | "write" | "none"> = {
  Bash: "shell",
  WebFetch: "network",
  WebSearch: "network",
  Write: "write",
  Edit: "write",
  MultiEdit: "write",
  NotebookEdit: "write",
  Read: "none",
  Grep: "none",
  Glob: "none",
  LS: "none",
  NotebookRead: "none",
  TodoWrite: "none",
};
