/** Signal weights, limits and keyword patterns for skill candidates (see candidates.ts). Data only. */
import type { RepoFinding } from "./repo-profile.js";

export const CANDIDATE_SKILLS = ["java", "spring-boot", "typescript", "nodejs"] as const;
export type CandidateSkill = (typeof CANDIDATE_SKILLS)[number];
export const SIGNAL_STRENGTHS = ["strong", "medium", "weak"] as const;
export type SignalStrength = (typeof SIGNAL_STRENGTHS)[number];
export const CONFIDENCES = ["high", "medium", "low"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const CANDIDATE_LIMITS = { modules: 20, evidence: 12, taskChars: 20000, affectedPaths: 200, pathChars: 200 } as const;
export const CONFIDENCE_MIN = { high: 60, medium: 30 } as const;
export const KEYWORD_WEIGHT = 10;

export interface SignalRule {
  signal: string;
  strength: SignalStrength;
  weight: number;
  /** Fixed text for the evidence entry. */
  reason: string;
  matches(f: RepoFinding): boolean;
  /** Language that must have a finding in the module itself (java-build only). */
  needsOwnLanguage?: string;
}

export interface SkillRule {
  skill: CandidateSkill;
  category: "language" | "platform";
  keyword: RegExp;
  keywordLabel: string;
  signals: SignalRule[];
}

export const NODE_PACKAGES: ReadonlySet<string> = new Set(["node", "@types/node","express", "fastify", "koa", "@nestjs/core", "@hapi/hapi"]);

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const inPackageJson = (f: RepoFinding) => f.kind === "dependency" && base(f.path) === "package.json";

export const SKILL_RULES: readonly SkillRule[] = [
  {
    skill: "java",
    category: "language",
    keyword: /\bjava\b/i,
    keywordLabel: "java",
    signals: [
      {
        signal: "java-build", strength: "strong", weight: 45, needsOwnLanguage: "java",
        reason: "Maven or Gradle build file with Java sources",
        // settings.gradle names no Java plugin or build, so only the build files count.
        matches: (f) => f.kind === "manifest" && f.value !== "lockfile" && (f.name === "maven" || (f.name === "gradle" && /^build\.gradle(?:\.kts)?$/.test(base(f.path)))),
      },
      {
        signal: "java-import", strength: "medium", weight: 20, reason: "Java source imports a library",
        matches: (f) => f.kind === "import" && f.value === "jvm" && f.path.endsWith(".java"),
      },
      { signal: "java-source", strength: "weak", weight: 15, reason: "Java source files", matches: (f) => f.kind === "language" && f.name === "java" },
    ],
  },
  {
    skill: "spring-boot",
    category: "platform",
    keyword: /\bspring[\s-]?boot\b/i,
    keywordLabel: "spring boot",
    signals: [
      {
        signal: "spring-boot-dependency", strength: "strong", weight: 60, reason: "Spring Boot dependency in a build file",
        matches: (f) => f.kind === "dependency" && f.name.startsWith("org.springframework.boot:"),
      },
      {
        signal: "spring-boot-import", strength: "medium", weight: 25, reason: "Source imports Spring Boot",
        matches: (f) => f.kind === "import" && f.value === "jvm" && f.name === "org.springframework.boot",
      },
    ],
  },
  {
    skill: "typescript",
    category: "language",
    keyword: /\btypescript\b/i,
    keywordLabel: "typescript",
    signals: [
      {
        signal: "typescript-dependency", strength: "strong", weight: 45, reason: "typescript dependency in package.json",
        matches: (f) => inPackageJson(f) && f.name === "typescript",
      },
      { signal: "typescript-source", strength: "weak", weight: 15, reason: "TypeScript source files", matches: (f) => f.kind === "language" && f.name === "typescript" },
    ],
  },
  {
    skill: "nodejs",
    category: "platform",
    keyword: /\bnode\.?js\b/i,
    keywordLabel: "node.js",
    signals: [
      {
        signal: "node-dependency", strength: "strong", weight: 45, reason: "Node.js runtime or server package in package.json",
        matches: (f) => inPackageJson(f) && NODE_PACKAGES.has(f.name),
      },
      {
        signal: "node-import", strength: "medium", weight: 35, reason: "Source imports Node built-in modules",
        matches: (f) => f.kind === "import" && f.name === "node" && f.value === "node",
      },
    ],
  },
];

export function confidenceOf(score: number): Confidence {
  return score >= CONFIDENCE_MIN.high ? "high" : score >= CONFIDENCE_MIN.medium ? "medium" : "low";
}
