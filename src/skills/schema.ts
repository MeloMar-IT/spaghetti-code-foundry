import { z } from "zod";

/** Skill id: lower-case slug, 1–64 chars, letters/digits with single hyphens between. Stable format. */
export const SKILL_ID_RE = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

const NUM = "(?:0|[1-9]\\d*)";
const PRE = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
/** Skill version: SemVer MAJOR.MINOR.PATCH with an optional -prerelease (no build metadata), at most 64 chars. */
export const SKILL_VERSION_RE = new RegExp(`^(?=.{1,64}$)${NUM}\\.${NUM}\\.${NUM}(?:-${PRE}(?:\\.${PRE})*)?$`);

/** A package digest: `sha256:` and 64 lower-case hex digits. See `skillDigest` in package.ts. */
export const SKILL_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

export const SKILL_ROLES =["planner", "coder", "reviewer", "tester"] as const;
export const SKILL_RISKS = ["low", "medium", "high"] as const;
export const SKILL_FOLDERS = ["references", "scripts", "assets", "evals"] as const;
export const SKILL_LIMITS = {
  skillMdBytes: 65536,
  manifestBytes: 16384,
  fileBytes: 262144,
  totalBytes: 2097152,
  files: 200,
  pathChars: 200,
  pathSegments: 6,
} as const;

const PATH_REASON = "path leaves the package or is not a plain relative path";

/** Why a logical relative path is not acceptable, or undefined when it is. Used for entry paths and globs. */
export function relativePathProblem(p: string): string | undefined {
  if (p === "") return "path is empty";
  if (p.includes("\0") || p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p)) return PATH_REASON;
  if (p.split("/").some((s) => s === "" || s === "." || s === "..")) return PATH_REASON;
  return undefined;
}

export const SkillIdSchema = z.string().regex(SKILL_ID_RE, "must be a lower-case slug of 1–64 characters (letters, digits, single hyphens)");
export const SkillVersionSchema = z.string().regex(SKILL_VERSION_RE, "must be a version like 1.2.3 or 1.0.0-rc.1");

const slug = z.string().regex(SKILL_ID_RE, "must be a lower-case slug");

const glob = z.string().max(200).superRefine((g, ctx) => {
  const problem = relativePathProblem(g);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

export const SkillDetectorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("file"), glob }).strict(),
  z.object({ type: z.literal("content"), glob, contains: z.string().min(1).max(200) }).strict(),
]);

export const SkillToolProfileSchema = z
  .object({
    shell: z.boolean().default(false),
    network: z.boolean().default(false),
    filesystem: z.enum(["none", "read", "write"]).default("read"),
  })
  .strict()
  .default({ shell: false, network: false, filesystem: "read" });

/** SKILL.md frontmatter: the standard Agent Skills fields. */
export const SkillFrontmatterSchema = z
  .object({
    name: SkillIdSchema,
    description: z.string().trim().min(1).max(1024),
    license: z.string().max(200).optional(),
    compatibility: z.string().max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().max(500).optional(),
  })
  .strict();

function duplicates(ctx: z.RefinementCtx, key: string, items: readonly string[]) {
  const seen = new Set<string>();
  items.forEach((v, i) => {
    if (seen.has(v)) ctx.addIssue({ code: "custom", path: [key, i], message: `duplicate "${v}"` });
    seen.add(v);
  });
}

const dependency = z.object({ id: SkillIdSchema, min_version: SkillVersionSchema.optional() }).strict();

/** skill.yaml: Foundry's own metadata (a Foundry extension next to the standard SKILL.md). */
export const SkillManifestSchema = z
  .object({
    id: SkillIdSchema,
    version: SkillVersionSchema,
    category: slug.default("general"),
    capabilities: z.array(slug).max(32).default([]),
    detectors: z.array(SkillDetectorSchema).max(32).default([]),
    roles: z.array(z.enum(SKILL_ROLES)).max(SKILL_ROLES.length).default([]),
    dependencies: z.array(dependency).max(32).default([]),
    conflicts: z.array(SkillIdSchema).max(32).default([]),
    tool_profile: SkillToolProfileSchema,
    risk: z.enum(SKILL_RISKS).default("low"),
  })
  .strict()
  .superRefine((m, ctx) => {
    duplicates(ctx, "capabilities", m.capabilities);
    duplicates(ctx, "roles", m.roles);
    duplicates(ctx, "conflicts", m.conflicts);
    duplicates(ctx, "dependencies", m.dependencies.map((d) => d.id));
    duplicates(ctx, "detectors", m.detectors.map((d) => JSON.stringify([d.type, d.glob, "contains" in d ? d.contains : ""])));
    m.dependencies.forEach((d, i) => {
      if (d.id === m.id) ctx.addIssue({ code: "custom", path: ["dependencies", i, "id"], message: "a skill cannot depend on itself" });
      if (m.conflicts.includes(d.id)) ctx.addIssue({ code: "custom", path: ["dependencies", i, "id"], message: "also listed in conflicts" });
    });
    m.conflicts.forEach((c, i) => {
      if (c === m.id) ctx.addIssue({ code: "custom", path: ["conflicts", i], message: "a skill cannot conflict with itself" });
    });
  });

export type SkillRole = (typeof SKILL_ROLES)[number];
export type SkillRisk = (typeof SKILL_RISKS)[number];
export type SkillFolder = (typeof SKILL_FOLDERS)[number];
export type SkillDetector = z.infer<typeof SkillDetectorSchema>;
export type SkillToolProfile = z.infer<typeof SkillToolProfileSchema>;
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
export interface SkillFile {
  path: string;
  size: number;
  content: Uint8Array;
}
export interface SkillPackage extends SkillManifest {
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string;
  /** SKILL.md without the frontmatter, trimmed. */
  instructions: string;
  /** Digest of every file in the package (raw bytes, paths included). */
  digest: string;
  files: Record<SkillFolder, SkillFile[]>;
}
