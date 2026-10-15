// Reviewed profiles of frontend skill repositories. Pure data: no imports, no file, no network.
// The upstream facts below (folder names, ranges, the remote fetch) were not verified when this was written.
// A digest is added to a root's `reviewed` list by a code change, after a content review of that exact SKILL.md.

export const FRONTEND_GROUPS = ["frontend", "typescript"] as const;
export type FrontendGroup = (typeof FRONTEND_GROUPS)[number];
export const FRONTEND_GROUP_CATEGORY: Readonly<Record<FrontendGroup, string>> = { frontend: "frontend", typescript: "language" };
export const FRONTEND_BLOCKS = ["unreviewed", "evaluation", "hold", "too-large"] as const;
export type FrontendBlock = (typeof FRONTEND_BLOCKS)[number];

export interface FrontendSkillRule {
  group: FrontendGroup;
  capabilities: readonly string[];
  technologies: readonly { name: string; version?: string }[];
  /** Package digests (sha256:…, skill-relative) of the declaration reviewed for this root. */
  reviewed: readonly string[];
  /** Evaluations that must have passed for this digest; never empty. */
  evaluations: readonly string[];
  /** Why the skill is held back; present: never offered. */
  hold?: string;
}

export interface FrontendProfile {
  id: string;
  profile: number;
  repositoryKey: string;
  /** package.json dependency names read as technologies of the same name. */
  evidence: readonly string[];
  maxSkillTokens: number;
  /** Upstream root → rule. */
  skills: Readonly<Record<string, FrontendSkillRule>>;
}

const rule = (r: Omit<FrontendSkillRule, "group" | "reviewed" | "evaluations">): FrontendSkillRule => ({
  group: "frontend",
  reviewed: [],
  evaluations: ["skill-gate"],
  ...r,
});

export const VERCEL_PROFILE: FrontendProfile = {
  id: "vercel-agent-skills",
  profile: 1,
  repositoryKey: "github.com/vercel-labs/agent-skills",
  evidence: ["next", "react", "react-native", "typescript"],
  maxSkillTokens: 5000,
  skills: {
    "skills/react-best-practices": rule({
      capabilities: ["react-performance", "nextjs-performance"],
      technologies: [{ name: "react", version: ">=18" }, { name: "next", version: ">=15.1" }],
    }),
    "skills/composition-patterns": rule({
      capabilities: ["react-composition"],
      technologies: [{ name: "react", version: ">=18" }],
    }),
    "skills/react-native-skills": rule({
      capabilities: ["react-native-performance"],
      technologies: [{ name: "react-native", version: ">=0.72" }],
    }),
    "skills/web-design-guidelines": rule({
      capabilities: ["web-interface-review"],
      technologies: [],
      hold: "pulls its rules from a remote address when it runs",
    }),
  },
};

export const FRONTEND_PROFILES: readonly FrontendProfile[] = [VERCEL_PROFILE];
