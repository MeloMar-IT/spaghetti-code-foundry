import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { credentialProblem } from "./credential-scan.js";
import { readRegular } from "./package.js";
import { SKILL_DIGEST_RE, SkillIdSchema, SkillVersionSchema } from "./schema.js";

export const RELEASE_FILE = "catalogue-release.json";
export const MAX_RELEASE_BYTES = 262144;
/** Same number as MAX_SKILLS_PER_ROOT in registry.ts. */
export const MAX_RELEASE_SKILLS = 500;
export const RELEASE_DIGEST_HEADER = "scf-skill-catalogue-release-v1\n";

export interface ReleaseManifest {
  schema: 1;
  catalogue: string;
  version: string;
  createdAt: string;
  source: { repository: string; commit: string; ref?: string };
  skills: { id: string; version: string; digest: string }[];
}
export interface ApprovedRelease {
  catalogue: string;
  version: string;
  digest: string;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const CREATED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A real UTC calendar time: a date that JavaScript would roll over (30 February) is refused. */
export function isUtcTime(s: string): boolean {
  if (!CREATED_RE.test(s)) return false;
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 19) === s.slice(0, 19);
}
const createdAt = z.string().refine(isUtcTime, "must be a UTC time like 2026-01-31T12:00:00Z");

export const ReleaseManifestSchema = z
  .object({
    schema: z.literal(1),
    catalogue: SkillIdSchema,
    version: SkillVersionSchema,
    createdAt,
    source: z
      .object({
        repository: z.string().regex(REPO_RE, "must be like github.com/acme/scf-skills"),
        commit: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/, "must be a full commit id"),
        ref: z.string().regex(REPO_RE).optional(),
      })
      .strict(),
    skills: z
      .array(z.object({ id: SkillIdSchema, version: SkillVersionSchema, digest: z.string().regex(SKILL_DIGEST_RE) }).strict())
      .min(1)
      .max(MAX_RELEASE_SKILLS),
  })
  .strict()
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.skills.forEach((s, i) => {
      if (seen.has(s.id)) ctx.addIssue({ code: "custom", path: ["skills", i, "id"], message: "listed twice" });
      seen.add(s.id);
    });
  }) as z.ZodType<ReleaseManifest>;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The canonical text the digest is computed over. Independent of key order and white space of the file. */
export function releaseText(m: ReleaseManifest): string {
  const head = [m.catalogue, m.version, m.createdAt, m.source.repository, m.source.commit, m.source.ref ?? ""];
  const lines = [...m.skills].sort((a, b) => cmp(a.id, b.id)).map((s) => `${s.id}@${s.version} ${s.digest}`);
  return RELEASE_DIGEST_HEADER + [...head, ...lines].map((l) => l + "\n").join("");
}

export function releaseDigest(m: ReleaseManifest): string {
  return "sha256:" + createHash("sha256").update(releaseText(m), "utf8").digest("hex");
}

export type ReleaseRead = { state: "none" } | { state: "invalid"; reason: string } | { state: "ok"; manifest: ReleaseManifest; digest: string };

/** Reads `catalogue-release.json` of a root. Never opens a link or a special file; no reason repeats a path or file content. */
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
    data = readRegular(path, maxBytes);
  } catch (e) {
    return { state: "invalid", reason: `cannot be read (${String((e as NodeJS.ErrnoException)?.code ?? "unknown error")})` };
  }
  if (data === "link") return { state: "invalid", reason: "is a symbolic link" };
  if (data === "other") return { state: "invalid", reason: "is not a readable regular file" };
  if (data === "large") return { state: "invalid", reason: `is larger than ${maxBytes} bytes` };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    return { state: "invalid", reason: "is not valid JSON" };
  }
  const parsed = ReleaseManifestSchema.safeParse(json);
  if (!parsed.success) return { state: "invalid", reason: "has the wrong format" };
  const manifest = parsed.data;
  const rule = credentialProblem(releaseText(manifest));
  if (rule) return { state: "invalid", reason: `holds what looks like a credential (${rule})` };
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
