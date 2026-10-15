import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { credentialProblem } from "./credential-scan.js";
import { readRegular } from "./package.js";
import { relativePathProblem, SKILL_DIGEST_RE, SKILL_LIMITS, SkillIdSchema, SkillVersionSchema } from "./schema.js";
import { hasUnsafeChar, OWNER_RE, SOURCE_TRUST_TIERS, sourcePathProblem } from "./sources.js";

export const RELEASE_FILE = "catalogue-release.json";
export const MAX_RELEASE_BYTES = 262144;
/** A schema-2 manifest lists every file of up to 500 packages. */
export const MAX_RELEASE_V2_BYTES = 2097152;
/** Same number as MAX_SKILLS_PER_ROOT in registry.ts. */
export const MAX_RELEASE_SKILLS = 500;
export const MAX_RELEASE_ATTRIBUTION = 20;
export const RELEASE_DIGEST_HEADER = "scf-skill-catalogue-release-v1\n";
export const RELEASE_DIGEST_HEADER_V2 = "scf-skill-catalogue-release-v2\n";
export const RELEASE_VERDICTS = ["passed", "failed", "not-run"] as const;

export interface ReleaseManifestV1 {
  schema: 1;
  catalogue: string;
  version: string;
  createdAt: string;
  source: { repository: string; commit: string; ref?: string };
  skills: { id: string; version: string; digest: string }[];
}
export interface ReleaseFileEntry {
  path: string;
  /** 64 lower-case hex digits, without a prefix. */
  sha256: string;
  bytes: number;
}
export interface ReleaseSkillV2 {
  id: string;
  version: string;
  digest: string;
  files: ReleaseFileEntry[];
  provenance: {
    source: string;
    repositoryKey: string;
    commit: string;
    path: string;
    trust: (typeof SOURCE_TRUST_TIERS)[number];
    review?: { by: string; on: string; commit: string; licence: string };
  };
  licences: string[];
  attribution: ReleaseFileEntry[];
  evaluation: { suite: string; record: string; verdict: (typeof RELEASE_VERDICTS)[number] };
  revoked?: { on: string; reason: string };
}
export interface ReleaseManifestV2 extends Omit<ReleaseManifestV1, "schema" | "skills"> {
  schema: 2;
  skills: ReleaseSkillV2[];
}
export type ReleaseManifest = ReleaseManifestV1 | ReleaseManifestV2;
export interface ApprovedRelease {
  catalogue: string;
  version: string;
  digest: string;
}

export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CREATED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A real UTC calendar time: a date that JavaScript would roll over (30 February) is refused. */
export function isUtcTime(s: string): boolean {
  if (!CREATED_RE.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === s.slice(0, 19);
}
const createdAt = z.string().refine(isUtcTime, "must be a UTC time like 2026-01-31T12:00:00Z");

const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const head = {
  catalogue: SkillIdSchema,
  version: SkillVersionSchema,
  createdAt,
  source: z
    .object({
      repository: z.string().regex(REPO_RE, "must be like github.com/acme/scf-skills"),
      commit: z.string().regex(COMMIT_RE, "must be a full commit id"),
      ref: z.string().regex(REPO_RE).optional(),
    })
    .strict(),
};
const uniqueSkills = (m: { skills: { id: string }[] }, ctx: z.RefinementCtx) => {
  const seen = new Set<string>();
  m.skills.forEach((s, i) => {
    if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["skills", i, "id"], message: "listed twice" });
    seen.add(s.id);
  });
};

const V1 = z
  .object({
    schema: z.literal(1),
    ...head,
    skills: z
      .array(z.object({ id: SkillIdSchema, version: SkillVersionSchema, digest: z.string().regex(SKILL_DIGEST_RE) }).strict())
      .min(1)
      .max(MAX_RELEASE_SKILLS),
  })
  .strict()
  .superRefine(uniqueSkills);

/** No control, format or line-separator character, and no lone surrogate (UTF-8 turns it into U+FFFD, so two values would hash the same). */
const plain = z.string().refine((s) => !hasUnsafeChar(s) && !/\p{Cs}/u.test(s), "holds a control character or a lone surrogate");
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (s: string) => {
  if (!DAY_RE.test(s)) return false;
  const ms = Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === s;
};
const day = z.string().refine(isDay, "must be a real date like 2026-01-31");
const commitId = z.string().regex(COMMIT_RE, "must be a full commit id");
const licenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/);

const filePath = plain.superRefine((p, ctx) => {
  const problem = relativePathProblem(p);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
  else if (p.length > SKILL_LIMITS.pathChars || p.split("/").length > SKILL_LIMITS.pathSegments) ctx.addIssue({ code: "custom", message: "path is too long or too deep" });
  else if (p.split("/").pop() === ".DS_Store") ctx.addIssue({ code: "custom", message: ".DS_Store is not part of a release" });
});
const fileEntry = z
  .object({
    path: filePath,
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lower-case hex digits without a prefix"),
    bytes: z.number().int().min(0).max(SKILL_LIMITS.fileBytes),
  })
  .strict();
const fileList = (min: number, max: number) =>
  z
    .array(fileEntry)
    .min(min)
    .max(max)
    .superRefine((list, ctx) => {
      const seen = new Set<string>();
      let total = 0;
      list.forEach((f, i) => {
        const k = f.path.toLowerCase();
        if (seen.has(k)) ctx.addIssue({ code: "custom", path: [i, "path"], message: "listed twice" });
        seen.add(k);
        total += f.bytes;
      });
      if (total > SKILL_LIMITS.totalBytes) ctx.addIssue({ code: "custom", message: "lists more bytes than a package may hold" });
    });

const V2Skill = z
  .object({
    id: SkillIdSchema,
    version: SkillVersionSchema,
    digest: z.string().regex(SKILL_DIGEST_RE),
    files: fileList(1, SKILL_LIMITS.files),
    provenance: z
      .object({
        source: SkillIdSchema,
        repositoryKey: z.string().regex(REPO_RE),
        commit: commitId,
        path: plain.superRefine((p, ctx) => {
          const problem = sourcePathProblem(p);
          if (problem) ctx.addIssue({ code: "custom", message: problem });
        }),
        trust: z.enum(SOURCE_TRUST_TIERS),
        review: z.object({ by: z.string().regex(OWNER_RE), on: day, commit: commitId, licence: licenceId }).strict().optional(),
      })
      .strict(),
    licences: z
      .array(licenceId)
      .min(1)
      .max(20)
      .refine((l) => new Set(l).size === l.length, "listed twice"),
    attribution: fileList(0, MAX_RELEASE_ATTRIBUTION),
    evaluation: z.object({ suite: SkillIdSchema, record: z.string().regex(SKILL_DIGEST_RE), verdict: z.enum(RELEASE_VERDICTS) }).strict(),
    revoked: z
      .object({ on: day, reason: plain.refine((r) => r.length >= 1 && r.length <= 200 && r === r.trim(), "must be 1–200 characters, trimmed") })
      .strict()
      .optional(),
  })
  .strict();

const V2 = z
  .object({ schema: z.literal(2), ...head, skills: z.array(V2Skill).min(1).max(MAX_RELEASE_SKILLS) })
  .strict()
  .superRefine(uniqueSkills);

export const ReleaseManifestSchema = z.union([V1, V2]) as unknown as z.ZodType<ReleaseManifest>;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byPath = (a: ReleaseFileEntry, b: ReleaseFileEntry) => cmp(a.path, b.path);

/** Only the last value of a line can hold a space; no value holds a newline. */
function skillLinesV2(s: ReleaseSkillV2): string[] {
  const p = s.provenance;
  return [
    `skill ${s.id}@${s.version} ${s.digest}`,
    `provenance ${p.source} ${p.repositoryKey} ${p.commit} ${p.trust} ${p.path}`,
    ...(p.review ? [`review ${p.review.by} ${p.review.on} ${p.review.commit} ${p.review.licence}`] : []),
    ...[...s.licences].sort(cmp).map((l) => `licence ${l}`),
    `evaluation ${s.evaluation.suite} ${s.evaluation.record} ${s.evaluation.verdict}`,
    ...[...s.files].sort(byPath).map((f) => `file ${f.sha256} ${f.bytes} ${f.path}`),
    ...[...s.attribution].sort(byPath).map((f) => `attribution ${f.sha256} ${f.bytes} ${f.path}`),
    ...(s.revoked ? [`revoked ${s.revoked.on} ${s.revoked.reason}`] : []),
  ];
}

/** The canonical text the digest is computed over. Independent of key order and white space of the file. */
export function releaseText(m: ReleaseManifest): string {
  const top = [m.catalogue, m.version, m.createdAt, m.source.repository, m.source.commit, m.source.ref ?? ""];
  if (m.schema === 2) {
    const lines = [...m.skills].sort((a, b) => cmp(a.id, b.id)).flatMap(skillLinesV2);
    return RELEASE_DIGEST_HEADER_V2 + [...top, ...lines].map((l) => l + "\n").join("");
  }
  const lines = [...m.skills].sort((a, b) => cmp(a.id, b.id)).map((s) => `${s.id}@${s.version} ${s.digest}`);
  return RELEASE_DIGEST_HEADER + [...top, ...lines].map((l) => l + "\n").join("");
}

export function releaseDigest(m: ReleaseManifest): string {
  return "sha256:" + createHash("sha256").update(releaseText(m), "utf8").digest("hex");
}

/** `v2`: the file says `schema: 2`, so it must never be treated like a file that is not a release. */
export type ReleaseRead = { state: "none" } | { state: "invalid"; reason: string; v2?: true } | { state: "ok"; manifest: ReleaseManifest; digest: string };

/** Reads `catalogue-release.json` of a root. Never opens a link or a special file; no reason repeats a path or file content. Only a schema-2 manifest may be larger than `maxBytes`. */
export function readRelease(root: string, maxBytes = MAX_RELEASE_BYTES): ReleaseRead {
  const path = join(root, RELEASE_FILE);
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    const c = String((e as NodeJS.ErrnoException)?.code ?? "unknown error");
    return c === "ENOENT" ? { state: "none" } : { state: "invalid", reason: `cannot be read (${c})` };
  }
  if (st.isSymbolicLink()) return { state: "invalid", reason: "is a symbolic link" };
  if (!st.isFile()) return { state: "invalid", reason: "is not a readable regular file" };
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, Math.max(maxBytes, MAX_RELEASE_V2_BYTES));
  } catch (e) {
    return { state: "invalid", reason: `cannot be read (${String((e as NodeJS.ErrnoException)?.code ?? "unknown error")})` };
  }
  if (data === "link") return { state: "invalid", reason: "is a symbolic link" };
  if (data === "other") return { state: "invalid", reason: "is not a readable regular file" };
  const large = { state: "invalid" as const, reason: `is larger than ${maxBytes} bytes` };
  if (data === "large") return large;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    return data.byteLength > maxBytes ? large : { state: "invalid", reason: "is not valid JSON" };
  }
  if (data.byteLength > maxBytes && (json as { schema?: unknown } | null)?.schema !== 2) return large;
  const parsed = ReleaseManifestSchema.safeParse(json);
  const v2 = (json as { schema?: unknown } | null)?.schema === 2 ? ({ v2: true } as const) : {};
  if (!parsed.success) return { state: "invalid", reason: "has the wrong format", ...v2 };
  const manifest = parsed.data;
  const rule = credentialProblem(releaseText(manifest));
  if (rule) return { state: "invalid", reason: `holds what looks like a credential (${rule})`, ...v2 };
  return { state: "ok", manifest, digest: releaseDigest(manifest) };
}

export type ReleaseState = "none" | "invalid" | "unapproved" | "mismatch" | "approved";
export interface ReleaseCheck {
  state: ReleaseState;
  catalogue?: string;
  version?: string;
  digest?: string;
  reason?: string;
}

/** Identity only: is this manifest one of the approved releases? */
export function matchRelease(read: ReleaseRead, approved: readonly ApprovedRelease[]): ReleaseCheck {
  if (read.state === "none") return { state: "none" };
  if (read.state === "invalid") return { state: "invalid", reason: read.reason };
  const { catalogue, version } = read.manifest;
  const id = { catalogue, version, digest: read.digest };
  const same = approved.filter((a) => a.catalogue === catalogue && a.version === version);
  if (!same.length) return { state: "unapproved", ...id };
  if (!same.some((a) => a.digest === read.digest)) return { state: "mismatch", ...id, reason: "has another digest than the approved one" };
  return { state: "approved", ...id };
}

/** Content: undefined when `found` is exactly the listed packages, else the reason. */
export function releaseContentProblem(m: ReleaseManifest, found: readonly { id: string; version: string; digest: string }[]): string | undefined {
  const want = new Map(m.skills.map((s) => [s.id, s]));
  const have = new Map<string, { version: string; digest: string }>();
  const dup: string[] = [];
  for (const f of found) {
    if (have.has(f.id)) dup.push(f.id);
    have.set(f.id, f);
  }
  const bad = [...dup];
  for (const [id, w] of want) {
    const h = have.get(id);
    if (!h || h.version !== w.version || h.digest !== w.digest) bad.push(id);
  }
  for (const id of have.keys()) if (!want.has(id)) bad.push(id);
  if (!bad.length) return undefined;
  return `does not hold exactly the listed packages (${bad.sort(cmp)[0]})`;
}

/** One sentence for a state that is not `approved`. Built from checked fields only, never a path. */
export function releaseProblemText(rel: ReleaseCheck): string {
  switch (rel.state) {
    case "none":
      return "not a catalogue release (no catalogue-release.json)";
    case "invalid":
      return `the release manifest ${rel.reason}`;
    case "unapproved":
      return `${rel.catalogue}@${rel.version} (${rel.digest}) is not in skills.releases.approved`;
    default:
      return `${rel.catalogue}@${rel.version} ${rel.reason}`;
  }
}
