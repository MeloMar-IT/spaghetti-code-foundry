// The rules and the profile of the workflow gate (src/skills/workflow.ts). Data only: no imports, nothing is run here.
//
// A profile names the individual skills of one third-party repository that may become candidates, and what each one
// may need. The declaration is the ceiling: upstream metadata or text that asks for more excludes the skill, it never
// raises the declaration. These are workflow findings, not security findings: the scanner's ids (scan-rules.ts) are a
// contract with stored exceptions and are not used here.
//
// Pattern constraints (they bound the cost of a scan): every pattern starts with a literal or `\b`, every gap is
// bounded (`[^\n]{0,N}`), no nested quantifiers, case-insensitive. tests/skill-no-network.test.ts rejects some words in
// every src/skills/*.ts, so no pattern spells them out.

export const WORKFLOW_CODES = [
  "not-selected", "assumes-subagents", "assumes-worktrees", "assumes-commands", "own-delivery-flow",
  "skips-approval", "orchestration", "grants-tools", "undeclared-tool", "requires-skill",
  "context-over-budget", "no-compatible-flow",
  "mentions-skill", "flow-unknown", "flow-incompatible", "extra-files",
] as const;
export type WorkflowCode = (typeof WORKFLOW_CODES)[number];
export type WorkflowEffect = "exclude" | "report";

export const WORKFLOW_EFFECT: Record<WorkflowCode, WorkflowEffect> = {
  "not-selected": "exclude",
  "assumes-subagents": "exclude",
  "assumes-worktrees": "exclude",
  "assumes-commands": "exclude",
  "own-delivery-flow": "exclude",
  "skips-approval": "exclude",
  orchestration: "exclude",
  "grants-tools": "exclude",
  "undeclared-tool": "exclude",
  "requires-skill": "exclude",
  "context-over-budget": "exclude",
  "no-compatible-flow": "exclude",
  "mentions-skill": "report",
  "flow-unknown": "report",
  "flow-incompatible": "report",
  "extra-files": "report",
};

export const WORKFLOW_LIMITS = { findings: 50, evidenceChars: 80, wrapperTokens: 300 } as const;

export interface WorkflowRule {
  id: string;
  code: WorkflowCode;
  says: string;
  re: RegExp;
  /** The rule only counts when the declaration lacks this tool. */
  needs?: "shell" | "network" | "write";
}

export const WORKFLOW_RULES: readonly WorkflowRule[] = [
  { id: "subagents.words", code: "assumes-subagents", says: "Assumes subagents", re: /\b(?:sub-?agents?|Task tool|parallel agents|fresh agent)\b/i },
  { id: "subagents.dispatch", code: "assumes-subagents", says: "Assumes subagents", re: /\bdispatch[^\n]{0,40}\bagents?\b/i },
  { id: "worktrees.words", code: "assumes-worktrees", says: "Assumes git worktrees", re: /\bworktrees?\b/i },
  { id: "commands.slash", code: "assumes-commands", says: "Assumes a slash command", re: /(?:^|\s)\/[a-z][a-z-]{2,39}(?![\w/.-])/im },
  { id: "commands.words", code: "assumes-commands", says: "Assumes a command tool", re: /\b(?:slash command|Skill tool)\b/i },
  { id: "delivery.git", code: "own-delivery-flow", says: "Has its own delivery step", re: /\b(?:git (?:push|merge|commit)|gh pr create|finishing-a-development-branch)\b/i },
  { id: "delivery.pull-request", code: "own-delivery-flow", says: "Has its own delivery step", re: /\b(?:open|create) a pull request\b/i },
  { id: "delivery.merge", code: "own-delivery-flow", says: "Has its own delivery step", re: /\bmerge[^\n]{0,40}\b(?:to|into) (?:main|master)\b/i },
  { id: "approval.skip", code: "skips-approval", says: "Skips approval", re: /\b(?:without waiting for|do not ask|don't wait for approval|proceed automatically|auto-merge)\b/i },
  { id: "orchestration.words", code: "orchestration", says: "Part of a session orchestration", re: /\b(?:using-superpowers|SessionStart|hooks\.json|EXTREMELY_IMPORTANT|before any response)\b/i },
  { id: "grants.words", code: "grants-tools", says: "Asks for tool permissions", re: /\b(?:allowed-tools:|permission_mode|permissions\.allow)/i },
  { id: "grants.allowed", code: "grants-tools", says: "Grants itself tool permissions", re: /\byou (?:are|have been) (?:allowed|authorized|granted)\b[^\n]{0,40}\b(?:use|run)\b/i },
  { id: "tool.shell-block", code: "undeclared-tool", says: "Needs a shell", needs: "shell", re: /```(?:bash|sh|shell|zsh)\b/i },
  { id: "tool.shell-words", code: "undeclared-tool", says: "Needs a shell", needs: "shell", re: /\bBash tool\b/i },
  { id: "tool.shell-run", code: "undeclared-tool", says: "Needs a shell", needs: "shell", re: /\brun[^\n]{0,40}\bcommand\b/i },
  { id: "tool.network", code: "undeclared-tool", says: "Needs network access", needs: "network", re: /\b(?:WebFetch|WebSearch|curl |wget |gh api|gh pr|gh issue)\b/i },
  { id: "tool.write-tools", code: "undeclared-tool", says: "Needs write access", needs: "write", re: /\b(?:Edit tool|Write tool|fix the (?:bug|code|issue))\b/i },
  { id: "tool.write-tests", code: "undeclared-tool", says: "Needs write access", needs: "write", re: /\b(?:write|add|create)\b[^\n]{0,40}\btests?\b/i },
  { id: "tool.write-change", code: "undeclared-tool", says: "Needs write access", needs: "write", re: /\bimplement\b[^\n]{0,40}\b(?:fix|change)\b/i },
  { id: "tool.write-files", code: "undeclared-tool", says: "Needs write access", needs: "write", re: /\b(?:edit|modify|create|update)\b[^\n]{0,40}\b(?:file|code)\b/i },
  { id: "requires.marker", code: "requires-skill", says: "Requires another skill", re: /\bREQUIRED (?:SUB-SKILL|BACKGROUND)\b[^\n]{0,80}superpowers:[a-z0-9-]+/i },
  { id: "requires.verb", code: "requires-skill", says: "Requires another skill", re: /\b(?:use|follow|invoke|apply|load|read|see)\b[^\n]{0,40}superpowers:[a-z0-9-]+/i },
  { id: "requires.named", code: "requires-skill", says: "Requires another skill", re: /\b(?:use|follow|invoke|apply) (?:the )?[a-z0-9]{1,20}-[a-z0-9-]{1,40} skill\b/i },
  { id: "requires.must", code: "requires-skill", says: "Requires another skill", re: /\byou must use\b[^\n]{0,60}\bskill\b/i },
  { id: "mentions.skill", code: "mentions-skill", says: "Mentions another skill", re: /\bsuperpowers:[a-z0-9-]+/i },
];

export interface WorkflowDeclaration {
  tools: { shell: boolean; network: boolean; filesystem: "read" | "write" };
  roles: readonly ("planner" | "coder" | "reviewer" | "tester")[];
  capability: string;
  /** Built-in flows that may deliver the skill. A flow only counts when one of its steps really receives it. */
  flows: readonly string[];
  /** Budget for description plus instructions, not for the wrapped payload. */
  maxTokens: number;
}
export interface ConnectorProfile {
  id: string;
  repositoryKey: string;
  /** Upstream skill name → declaration. */
  skills: Readonly<Record<string, WorkflowDeclaration>>;
}

const CODE_FLOWS = ["issue-code-daily", "issue-gitflow"] as const;

export const CONNECTOR_PROFILES: readonly ConnectorProfile[] = [
  {
    id: "superpowers",
    repositoryKey: "github.com/obra/superpowers",
    skills: {
      "test-driven-development": { tools: { shell: true, network: false, filesystem: "write" }, roles: ["coder"], capability: "tdd-workflow", flows: CODE_FLOWS, maxTokens: 5000 },
      "systematic-debugging": { tools: { shell: true, network: false, filesystem: "write" }, roles: ["coder"], capability: "debugging-workflow", flows: CODE_FLOWS, maxTokens: 5000 },
      "verification-before-completion": { tools: { shell: true, network: false, filesystem: "read" }, roles: ["coder"], capability: "verification-workflow", flows: CODE_FLOWS, maxTokens: 3000 },
      "requesting-code-review": { tools: { shell: true, network: false, filesystem: "read" }, roles: ["coder"], capability: "code-review-request-workflow", flows: CODE_FLOWS, maxTokens: 3000 },
      "receiving-code-review": { tools: { shell: true, network: false, filesystem: "write" }, roles: ["coder"], capability: "code-review-response-workflow", flows: CODE_FLOWS, maxTokens: 3000 },
      "writing-plans": { tools: { shell: false, network: false, filesystem: "read" }, roles: ["planner"], capability: "planning-workflow", flows: ["issue-plan"], maxTokens: 4000 },
    },
  },
];
