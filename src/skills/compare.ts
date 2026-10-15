import { canonicalFromCollision, canonicalFromRegistered, technologyCompatibility } from "./canonical-facts.js";
import { canonicalStop, selectCanonicalSkills, type CanonicalCandidate, type CanonicalResolution } from "./canonical.js";
import { CANONICAL_LIMITS, type CanonicalTier } from "./canonical-rules.js";
import { COLLISION_LIMITS } from "./collision-rules.js";
import { classifySkillCollisions, collisionCandidate, type CollisionCandidate, type SkillCollision } from "./collisions.js";
import { COMMUNITY_CAPABILITY_RULES, COMMUNITY_METADATA_KEYS, COMMUNITY_TERM_ALIASES, COMMUNITY_TERM_KEYS } from "./community-rules.js";
import { buildSkillIdentity } from "./identity.js";
import { byteCmp, SkillImportError, type RejectedSkill } from "./import-plan.js";
import { normalizeSkill, slugify, type NormalizedSkill } from "./normalize.js";
import { supportStatus } from "./project-technologies.js";
import type { RegisteredSkill } from "./registry.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";

// Compares a staged community import with the built-in skills: which capabilities they share, which skills collide, and which
// skill is recommended for each shared capability. Pure: no file system, no process, no clock. Used by `scf skills compare`.

type FileEntry = { path: string; content: Uint8Array };
type Tech = { name: string; version?: string };

export type CompareExclusion = "stale" | "incompatible" | "compatibility-unchecked";
export interface ComparedSkill {
  id: string;
  version: string;
  root: string;
  tier: CanonicalTier;
  /** The built-in capabilities the upstream tags and keywords map to. */
  capabilities: string[];
  excluded?: CompareExclusion;
}
export interface CompareReport {
  schema: 1;
  source: string;
  repositoryKey: string;
  commit: string;
  /** Sorted by id. */
  skills: ComparedSkill[];
  collisions: SkillCollision[];
  /** Capabilities an imported and a built-in skill both provide. Sorted. */
  shared: string[];
  resolutions: CanonicalResolution[];
  blocking: number;
  conflicts: number;
  stop?: string;
}

const MAX_TERMS = 256;

/** Text or a list of text, as upstream wrote it: a string is split at commas. */
function termList(v: unknown): string[] {
  if (typeof v === "string") return v.split(",");
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * The built-in capabilities a skill maps to. Terms come from the normalized capabilities (upstream capabilities, tags and keywords),
 * from the lists upstream kept as metadata text, and from the leftover lists in the provenance. Does not change the skill.
 */
export function mappedCapabilities(skill: NormalizedSkill): string[] {
  const raw: string[] = [...(skill.package.capabilities ?? [])];
  for (const k of COMMUNITY_METADATA_KEYS) {
    const v = skill.package.metadata && Object.hasOwn(skill.package.metadata, k) ? skill.package.metadata[k] : undefined;
    raw.push(...termList(v));
  }
  for (const k of COMMUNITY_TERM_KEYS) {
    if (!Object.hasOwn(skill.provenance.upstream, k)) continue;
    try {
      raw.push(...termList(JSON.parse(skill.provenance.upstream[k]!)));
    } catch {
      // a value that is not JSON holds no list
    }
  }
  const terms = new Set<string>();
  for (const r of raw.slice(0, MAX_TERMS)) {
    const slug = slugify(r);
    if (slug === "") continue;
    terms.add(Object.hasOwn(COMMUNITY_TERM_ALIASES, slug) ? COMMUNITY_TERM_ALIASES[slug]! : slug);
  }
  const out = new Set<string>();
  for (const rule of COMMUNITY_CAPABILITY_RULES) if (rule.terms.every((t) => terms.has(t))) out.add(rule.capability);
  return [...out].sort(byteCmp);
}

/** A registered built-in with the original bytes of its package folder. The fingerprint and the settings come from these bytes. */
export type BuiltinSkill = RegisteredSkill & { files: readonly FileEntry[] };

const BUILTIN_ORIGIN = { source: "builtin", repository: "builtin", repositoryKey: "builtin", commit: "builtin" } as const;

/**
 * A collision member for a built-in skill: source `builtin`, approved, first-party. The content fingerprint and the settings are
 * taken from the original files the same way an imported copy gets them, so a verbatim copy is an exact mirror with the same
 * settings. Throws TypeError when the original files are missing: rebuilt bytes would change the fingerprint.
 */
export function builtinCollisionCandidate(s: RegisteredSkill & { files?: readonly FileEntry[] }): CollisionCandidate {
  if (!s.files) throw new TypeError(`the built-in skill ${s.id} has no original files`);
  const normalized = normalizeSkill(BUILTIN_ORIGIN, { root: ".", files: s.files.map((f) => ({ path: f.path, content: f.content })) });
  if (!normalized.ok) throw new TypeError(`the built-in skill ${s.id} cannot be read as a skill package`);
  const n = normalized.skill;
  const identity = buildSkillIdentity({
    id: s.id, source: "builtin", repositoryKey: "builtin", name: s.id, version: s.version, versionDeclared: true, digest: s.digest, files: s.files,
  });
  const pkg = { ...n.package, id: s.id, version: s.version, capabilities: s.pkg.capabilities, ...(s.pkg.dependencies ? { dependencies: s.pkg.dependencies } : {}) };
  const skill: NormalizedSkill = {
    package: pkg,
    provenance: {
      ...n.provenance, ...BUILTIN_ORIGIN, root: ".", name: s.id, versionDeclared: true,
      dependencies: (s.pkg.dependencies ?? []).map((d) => ({ name: d.id, id: d.id })),
    },
    extraFiles: [],
    identity,
  };
  return { skill, approved: true, trust: "first-party", licencesAllowed: [] };
}

export function compareWithBuiltins(input: {
  source: SkillLibrarySource;
  skills: readonly NormalizedSkill[];
  /** Each with its original files (see BuiltinSkill). */
  builtins: readonly BuiltinSkill[];
  evidence?: readonly Tech[];
  /** capability → skill id or id@version (owner overrides, scope all). */
  overrides?: Readonly<Record<string, string>>;
  highRisk?: readonly string[];
}): CompareReport {
  const { source, evidence } = input;
  const skills = [...input.skills].sort((a, b) => byteCmp(a.identity.id, b.identity.id) || byteCmp(a.identity.fingerprint, b.identity.fingerprint));
  const builtins = [...input.builtins].sort((a, b) => byteCmp(a.key, b.key));
  if (skills.length + builtins.length > COLLISION_LIMITS.candidates) throw new SkillImportError("too-many-skills", `more than ${COLLISION_LIMITS.candidates} skills to compare`);
  const commit = skills[0]?.provenance.commit ?? source.ref.approved ?? "";

  // The comparison uses the mapped capabilities; the skill itself and its digest stay as they are.
  const mapped = skills.map((skill) => {
    const capabilities = mappedCapabilities(skill);
    return { skill, capabilities, copy: { ...skill, package: { ...skill.package, capabilities } } as NormalizedSkill };
  });
  const reviewed = source.trust !== "community" || (source.review !== undefined && source.review.commit === commit);

  const compared: { c: ComparedSkill; candidate?: CanonicalCandidate }[] = mapped.map(({ skill, capabilities, copy }) => {
    const technologies = skill.provenance.technologies;
    const support = supportStatus(technologies);
    const compat = evidence ? technologyCompatibility(technologies, evidence) : undefined;
    const excluded: CompareExclusion | undefined =
      support === "stale" ? "stale"
      : support === "unchecked" || compat === "unchecked" ? "compatibility-unchecked"
      : compat === "incompatible" ? "incompatible"
      : undefined;
    let candidate = canonicalFromCollision(collisionCandidate(copy, source), { licence: "allowed", sourceStatus: source.status, ...(evidence ? { evidence } : {}) });
    if (!reviewed) candidate = { ...candidate, tier: "discovery-only", status: candidate.status === "approved" ? "discovery" : candidate.status };
    return {
      c: { id: skill.identity.id, version: skill.identity.version, root: skill.provenance.root, tier: candidate.tier, capabilities, ...(excluded ? { excluded } : {}) },
      ...(excluded ? {} : { candidate }),
    };
  });

  const collisions = classifySkillCollisions([
    ...mapped.map((m) => collisionCandidate(m.copy, source)),
    ...builtins.map((b) => builtinCollisionCandidate(b)),
  ]).report.collisions;

  const present = builtins.map((b) => canonicalFromRegistered(b, evidence ? { evidence } : {}));
  const importedCaps = new Set(mapped.flatMap((m) => m.capabilities));
  const shared = [...new Set(present.flatMap((c) => c.capabilities).filter((c) => importedCaps.has(c)))].sort(byteCmp);
  if (shared.length > CANONICAL_LIMITS.exclusive) throw new SkillImportError("too-many-skills", `more than ${CANONICAL_LIMITS.exclusive} capabilities are shared with built-in skills`);

  const candidates = [...compared.flatMap((x) => (x.candidate ? [x.candidate] : [])), ...present];
  const result = selectCanonicalSkills(candidates, { exclusive: shared, overrides: input.overrides ?? {}, highRisk: input.highRisk ?? [] });
  const stop = canonicalStop(result);
  const blocking = collisions.filter((c) => c.blocking).length;
  const conflicts = result.resolutions.filter((r) => r.outcome !== "selected").length;

  return {
    schema: 1,
    source: source.id,
    repositoryKey: source.repositoryKey,
    commit,
    skills: compared.map((x) => x.c),
    collisions,
    shared,
    resolutions: result.resolutions,
    blocking,
    conflicts,
    ...(stop !== undefined ? { stop } : {}),
  };
}

/** A conflict or a blocking collision. */
export function compareFailed(r: CompareReport): boolean {
  return r.conflicts > 0 || r.blocking > 0;
}

/** The report, one line each, in a fixed order. Free text goes through shownValue; ids, slugs and codes are printed as they are. */
export function compareLines(r: CompareReport, quarantined: readonly RejectedSkill[] = []): string[] {
  const out: string[] = [];
  for (const s of r.skills) {
    out.push(`SKILL ${s.id}@${s.version} ${s.tier} capabilities=${s.capabilities.length ? s.capabilities.join(",") : "-"}`);
    if (s.excluded) out.push(`EXCLUDED ${s.id} ${s.excluded}`);
    else if (!s.capabilities.length) out.push(`NO-OVERLAP ${s.id}`);
  }
  for (const q of [...quarantined].sort((a, b) => byteCmp(a.root, b.root))) out.push(`EXCLUDED ${shownValue(q.root)} not-normalized`);
  for (const c of r.collisions) out.push(`COLLISION ${c.id} ${c.class} ${c.reason} ${c.members.map((m) => `${m.id}@${m.version}`).join(",")}${c.blocking ? " blocking" : ""}`);
  const byCap = new Map(r.resolutions.map((x) => [x.capability, x]));
  for (const cap of r.shared) {
    const x = byCap.get(cap);
    if (x?.outcome === "selected" && x.winner) out.push(`RECOMMEND ${cap} ${x.winner.id}@${x.winner.version} (${x.decidedBy ?? "only-candidate"})`);
    else out.push(`CONFLICT ${cap} ${x?.conflict ?? "no-eligible-skill"}`);
  }
  if (r.stop !== undefined) out.push(`NOTE ${r.stop}`);
  out.push(`COMPARED ${r.skills.length} skills from ${r.repositoryKey}@${r.commit.slice(0, 12)}: ${r.collisions.length} collisions (${r.blocking} blocking), ${r.conflicts} conflicts`);
  return out;
}
