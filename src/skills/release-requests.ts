import { lstatSync } from "node:fs";
import { parseDocument } from "yaml";
import { z } from "zod";
import { credentialProblem } from "./credential-scan.js";
import { readRegular } from "./package.js";
import { isDay, MAX_RELEASE_SKILLS, REPO_RE } from "./release.js";
import { SkillIdSchema, SkillVersionSchema } from "./schema.js";
import { hasUnsafeChar, MAX_SOURCES_BYTES, OWNER_RE, type SourceProblem } from "./sources.js";

// Owner-reviewed release requests: which catalogue versions to publish from which promoted skills.
// Pure except readReleaseRequests (it reads one file). Called by `scf skills releases check` (release-cli.ts) and by the publish command (release-publish.ts).

export const RELEASES_FILE = "skill-releases.yaml";
export const MAX_RELEASE_REQUESTS = 200;
export const MAX_REVOKE_REASON = 200;

export interface ReleaseRequest {
  catalogue: string;
  version: string;
  skills: { source: string; id: string }[];
  review?: { by: string; on: string };
  revoked?: { id: string; version: string; on: string; reason: string }[];
}
export interface ReleaseRequests {
  schema: 1;
  repository: string;
  releases: ReleaseRequest[];
}
export type ReleaseRequestsRead =
  | { state: "none" }
  | { state: "invalid"; problems: SourceProblem[] }
  | { state: "ok"; manifest: ReleaseRequests };

function releaseRequestsSchema(today: string) {
  const text = z
    .string()
    .refine((s) => !hasUnsafeChar(s) && !/\p{Cs}/u.test(s), "holds a control character or a lone surrogate")
    .refine((s) => credentialProblem(s) === undefined, "must not hold what looks like a credential");
  const day = z
    .string()
    .refine(isDay, "must be a real date like 2026-01-31")
    .refine((d) => !isDay(d) || d <= today, "must not be after today");
  const skill = z.object({ source: SkillIdSchema, id: SkillIdSchema }).strict();
  const review = z.object({ by: z.string().regex(OWNER_RE, "must be a GitHub user or team like @octocat or @acme/skills"), on: day }).strict();
  const revocation = z
    .object({
      id: SkillIdSchema,
      version: SkillVersionSchema,
      on: day,
      reason: text.refine((r) => r.length >= 1 && r.length <= MAX_REVOKE_REASON && r === r.trim(), "must be 1–200 characters, trimmed"),
    })
    .strict();
  const entry = z
    .object({
      catalogue: SkillIdSchema,
      version: SkillVersionSchema,
      skills: z.array(skill).min(1, "must list at least one skill").max(MAX_RELEASE_SKILLS, "must list at most 500 skills"),
      review: review.optional(),
      revoked: z.array(revocation).max(MAX_RELEASE_SKILLS, "must list at most 500 revocations").optional(),
    })
    .strict()
    .superRefine((e, ctx) => {
      const ids = new Set<string>();
      e.skills.forEach((s, j) => {
        if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["skills", j, "id"], message: "listed twice" });
        ids.add(s.id);
      });
      const revoked = new Set<string>();
      (e.revoked ?? []).forEach((r, j) => {
        if (!ids.has(r.id)) ctx.addIssue({ code: "custom", path: ["revoked", j, "id"], message: "is not in skills" });
        else if (revoked.has(r.id)) ctx.addIssue({ code: "custom", path: ["revoked", j, "id"], message: "listed twice" });
        revoked.add(r.id);
      });
    });
  return z
    .object({
      schema: z.literal(1, "must be 1"),
      repository: text.pipe(z.string().regex(REPO_RE, "must be like github.com/acme/scf-skills")),
      releases: z.array(entry).min(1, "must list at least one release").max(MAX_RELEASE_REQUESTS, "must list at most 200 releases"),
    })
    .strict()
    .superRefine((m, ctx) => {
      const seen = new Map<string, number>();
      m.releases.forEach((r, i) => {
        const key = `${r.catalogue}@${r.version}`;
        const first = seen.get(key);
        if (first !== undefined) ctx.addIssue({ code: "custom", path: ["releases", i], message: `has the same catalogue and version as releases[${first}]` });
        else seen.set(key, i);
      });
    });
}

function problemsOf(err: z.ZodError): SourceProblem[] {
  return err.issues.slice(0, 20).map((i) => ({
    where: i.path.length ? i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("").replace(/^\./, "") : "file",
    message:
      i.code === "unrecognized_keys"
        ? "has a key that is not known"
        : i.code === "invalid_type"
          ? i.message.endsWith("received undefined")
            ? "is required"
            : "has the wrong type"
          : i.message,
  }));
}

/** Checks parsed YAML. Never throws; no problem repeats file content. */
export function parseReleaseRequests(raw: unknown, today: string): { manifest?: ReleaseRequests; problems: SourceProblem[] } {
  if (!isDay(today)) return { problems: [{ where: "today", message: "must be a date like 2026-10-13" }] };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { problems: [{ where: "file", message: "must be a map with schema, repository and releases" }] };
  }
  try {
    const r = releaseRequestsSchema(today).safeParse(raw);
    return r.success ? { manifest: r.data as ReleaseRequests, problems: [] } : { problems: problemsOf(r.error) };
  } catch {
    return { problems: [{ where: "file", message: "cannot be checked" }] };
  }
}

const fail = (message: string): ReleaseRequestsRead => ({ state: "invalid", problems: [{ where: "file", message }] });
const errCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);

/** Reads the file safely (no links, no special files, size limit, no aliases), then parseReleaseRequests. No message repeats a path or file content. */
export function readReleaseRequests(path: string, today: string, maxBytes = MAX_SOURCES_BYTES): ReleaseRequestsRead {
  let st;
  try {
    st = lstatSync(path);
  } catch (e) {
    const c = String((e as NodeJS.ErrnoException)?.code ?? "unknown error");
    return c === "ENOENT" ? { state: "none" } : fail(`cannot be read (${errCode(e)})`);
  }
  if (st.isSymbolicLink()) return fail("is a symbolic link");
  if (!st.isFile()) return fail("is not a readable regular file");
  let data: ReturnType<typeof readRegular>;
  try {
    data = readRegular(path, maxBytes);
  } catch (e) {
    return fail(`cannot be read (${errCode(e)})`);
  }
  if (data === "link") return fail("is a symbolic link");
  if (data === "other") return fail("is not a readable regular file");
  if (data === "large") return fail(`is larger than ${maxBytes} bytes`);
  return releaseRequestsFromBytes(data, today);
}

/** The YAML and schema part of `readReleaseRequests`, for a caller that has read the bytes itself (one read, one snapshot). */
export function releaseRequestsFromBytes(data: Uint8Array, today: string): ReleaseRequestsRead {
  let doc: unknown;
  try {
    // logLevel "silent": the library must not print warnings, they repeat the source line.
    const parsed = parseDocument(Buffer.from(data).toString("utf8"), { logLevel: "silent" });
    if (parsed.errors.length) throw parsed.errors[0];
    doc = parsed.toJS({ maxAliasCount: 0 });
  } catch (e) {
    const x = e as { code?: unknown; linePos?: { line?: unknown; col?: unknown }[] };
    const code = typeof x.code === "string" && /^[A-Z_]{1,40}$/.test(x.code) ? x.code : undefined;
    const pos = x.linePos?.[0];
    if (code && pos && Number.isInteger(pos.line) && Number.isInteger(pos.col)) {
      return fail(`is not valid YAML (${code} at line ${pos.line}, column ${pos.col})`);
    }
    return fail("is not valid YAML");
  }
  const r = parseReleaseRequests(doc, today);
  return r.manifest ? { state: "ok", manifest: r.manifest } : { state: "invalid", problems: r.problems };
}

export function findReleaseRequest(m: ReleaseRequests, catalogue: string, version: string): ReleaseRequest | undefined {
  return m.releases.find((r) => r.catalogue === catalogue && r.version === version);
}
