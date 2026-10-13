import { createHash } from "node:crypto";
import {
  COLLISION_BLOCKING_CLASSES, COLLISION_BLOCKING_REASONS, COLLISION_CLASSES, COLLISION_ID_HEADER, COLLISION_LIMITS,
  type CollisionClass, type CollisionReason,
} from "./collision-rules.js";
import { byteCmp } from "./import-plan.js";
import { relateSkills, type SkillIdentity } from "./identity.js";
import type { NormalizedSkill, SkillProvenance } from "./normalize.js";
import { canonicalJson } from "./normalize-values.js";
import type { SkillPackage, SkillProvider, SkillRisk, SkillToolProfile } from "./schema.js";
import { shownValue, type SkillLibrarySource, type SourceTrustTier } from "./sources.js";

// Classifies collisions between normalized skills and merges candidates with the same content into one entry. Pure: no file
// system, no process, no clock. Only `runSkillCatalogue` can call it, through its optional `candidate` dependency (none by default).

export interface CollisionCandidate {
  skill: NormalizedSkill;
  /** The source record is enabled and this commit is its approved one. */
  approved: boolean;
  trust: SourceTrustTier;
  /** licence.allow of the source record. */
  licencesAllowed: readonly string[];
  /** repositoryKey of the repository this one was forked from, when recorded. */
  forkOf?: string;
  evaluation?: "passed" | "failed";
  /** Fingerprint of the skill each dependency id points to, when known. Without it, dependencies are compared by name and version only. */
  dependencyFingerprints?: Readonly<Record<string, string>>;
}
/** What the normalizer reads from skill.yaml (and the frontmatter aliases), none of which the fingerprint covers. */
export interface MemberSettings {
  category: string;
  /** Sorted by name. */
  dependencies: { name: string; minVersion?: string; fingerprint?: string }[];
  connectors: string[];
  toolProfile: SkillToolProfile;
  risk: SkillRisk;
  technologies: { name: string; version?: string }[];
  /** The tool names the skill declares, before they are turned into a tool profile. */
  requiredTools: string[];
  /** Unrecognised `skill.yaml` keys: `manifest.<key>` → canonical JSON. */
  manifest: Record<string, string>;
  /** The provider block (#509); absent for a portable skill. */
  provider?: SkillProvider;
}
export interface CollisionMember {
  id: string;
  source: string;
  repository: string;
  repositoryKey: string;
  upstream: string;
  name: string;
  version: string;
  versionDeclared: boolean;
  commit: string;
  root: string;
  fingerprint: string;
  digest: string;
  /** Sorted. */
  capabilities: string[];
  settings: MemberSettings;
  compatibility?: string;
  licence?: string;
  /** Sorted. */
  licencesAllowed: string[];
  trust: SourceTrustTier;
  approved: boolean;
  forkOf?: string;
  /** files = package.files.evals.length */
  evaluation: { files: number; result?: "passed" | "failed" };
}
export interface SkillCollision {
  id: string;
  class: CollisionClass;
  reason: CollisionReason;
  /** The approved members of every unit are in a blocking class or reason. */
  blocking: boolean;
  /** 1 for a mirror, 2 otherwise; sorted. */
  fingerprints: string[];
  /** In the member order: id, source, repository, commit, root, digest. */
  members: CollisionMember[];
  /** capability-overlap only: the shared slugs, sorted. */
  shared?: string[];
}
export interface DedupedSkill {
  fingerprint: string;
  /** The representative, as it was given: package, identity and extra files are unchanged. */
  skill: NormalizedSkill;
  /** The records of the approved members. */
  provenance: SkillProvenance[];
  approved: boolean;
  unapproved: number;
  /** "differ" when the decisive members do not agree in version, capabilities and settings. */
  settings: "same" | "differ";
  /** Sorted collision ids. */
  collisions: string[];
  blockedBy: string[];
}
export interface CollisionReport {
  schema: 1;
  candidates: number;
  entries: number;
  collisions: SkillCollision[];
}
export interface CollisionResult {
  entries: DedupedSkill[];
  report: CollisionReport;
}

/** Throws TypeError when the skill is not from this source record. Approved: the record is enabled and this commit is its approved one. */
export function collisionCandidate(
  skill: NormalizedSkill,
  source: SkillLibrarySource,
  extra: { forkOf?: string; evaluation?: "passed" | "failed" } = {},
): CollisionCandidate {
  const { provenance, identity } = skill;
  const same =
    source.id === provenance.source && source.id === identity.source &&
    source.repositoryKey === provenance.repositoryKey && source.repositoryKey === identity.repositoryKey;
  if (!same) throw new TypeError("the skill does not come from this source record");
  return {
    skill,
    approved: source.status === "enabled" && source.ref.approved === provenance.commit,
    trust: source.trust,
    licencesAllowed: [...source.licence.allow],
    ...(extra.forkOf !== undefined ? { forkOf: extra.forkOf } : {}),
    ...(extra.evaluation !== undefined ? { evaluation: extra.evaluation } : {}),
  };
}

interface Entry {
  member: CollisionMember;
  candidate: CollisionCandidate;
  /** The member order, as text. */
  order: string[];
}
interface Unit {
  fingerprint: string;
  members: Entry[];
  approved: Entry[];
  decisive: Entry[];
  representative: Entry;
  settings: "same" | "differ";
}

const sorted = (list: readonly string[]): string[] => [...list].sort(byteCmp);

/** A key that is equal for equal provenance. The safety record is written one finding per line, so its size never meets the limit of canonicalJson. */
function provenanceKey(p: SkillProvenance): string {
  const { safety, ...rest } = p;
  if (!safety) return canonicalJson(rest);
  return [canonicalJson(rest), safety.report, ...safety.findings.map((f) => canonicalJson(f))].join("\n");
}

function settingsOf(skill: NormalizedSkill, targets: Readonly<Record<string, string>> = {}): MemberSettings {
  const { package: pkg, provenance } = skill;
  const names = new Map(provenance.dependencies.map((d) => [d.id, d.name]));
  const dependencies = (pkg.dependencies ?? [])
    .map((d) => {
      const target = Object.hasOwn(targets, d.id) ? targets[d.id] : undefined;
      return {
        name: names.get(d.id) ?? d.id,
        ...(d.min_version !== undefined ? { minVersion: d.min_version } : {}),
        ...(target !== undefined ? { fingerprint: target } : {}),
      };
    })
    .sort((a, b) => byteCmp(a.name, b.name));
  const provider = provenance.provider ?? pkg.provider;
  const manifest: Record<string, string> = {};
  for (const k of Object.keys(provenance.upstream).sort(byteCmp)) if (k.startsWith("manifest.")) manifest[k] = provenance.upstream[k]!;
  return {
    category: pkg.category,
    dependencies,
    connectors: sorted(pkg.connectors ?? []),
    toolProfile: { ...pkg.tool_profile },
    risk: pkg.risk,
    technologies: provenance.technologies.map((t) => ({ ...t })).sort((a, b) => byteCmp(a.name, b.name) || byteCmp(a.version ?? "", b.version ?? "")),
    requiredTools: sorted(provenance.requiredTools),
    manifest,
    ...(provider ? { provider: { name: provider.name, products: provider.products.map((p) => ({ ...p })).sort((a, b) => byteCmp(a.name, b.name)), tools: sorted(provider.tools) } } : {}),
  };
}

function memberOf(c: CollisionCandidate): Entry {
  const { package: pkg, provenance, identity } = c.skill;
  const member: CollisionMember = {
    id: identity.id,
    source: identity.source,
    repository: provenance.repository,
    repositoryKey: identity.repositoryKey,
    upstream: identity.upstream,
    name: identity.name,
    version: identity.version,
    versionDeclared: identity.versionDeclared,
    commit: provenance.commit,
    root: provenance.root,
    fingerprint: identity.fingerprint,
    digest: identity.digest,
    capabilities: sorted(pkg.capabilities ?? []),
    settings: settingsOf(c.skill, c.dependencyFingerprints),
    ...(pkg.compatibility !== undefined ? { compatibility: shownValue(pkg.compatibility) } : {}),
    ...(pkg.license !== undefined ? { licence: shownValue(pkg.license) } : {}),
    licencesAllowed: sorted(c.licencesAllowed),
    trust: c.trust,
    approved: c.approved,
    ...(c.forkOf !== undefined ? { forkOf: shownValue(c.forkOf) } : {}),
    evaluation: { files: pkg.files.evals.length, ...(c.evaluation !== undefined ? { result: c.evaluation } : {}) },
  };
  return { member, candidate: c, order: [member.id, member.source, member.repositoryKey, member.commit, member.root, member.digest, canonicalJson(member)] };
}

function entryCmp(a: Entry, b: Entry): number {
  for (let i = 0; i < a.order.length; i++) {
    const d = byteCmp(a.order[i]!, b.order[i]!);
    if (d !== 0) return d;
  }
  return 0;
}

/** Version (when declared), capabilities and skill.yaml settings: what must agree for copies of one content to be interchangeable. */
function settingsKey(m: CollisionMember): string {
  return canonicalJson({ version: m.versionDeclared ? m.version : null, capabilities: m.capabilities, ...m.settings });
}

function buildUnit(fingerprint: string, raw: Entry[]): Unit {
  // One member per (id, source, commit, root). When the evidence differs, the first in the member order wins.
  const members: Entry[] = [];
  const seen = new Set<string>();
  for (const e of [...raw].sort(entryCmp)) {
    const key = [e.member.id, e.member.source, e.member.commit, e.member.root].join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(e);
  }
  const approved = members.filter((e) => e.member.approved);
  const decisive = approved.length ? approved : members;
  const keys = new Set(decisive.map((e) => settingsKey(e.member)));
  return { fingerprint, members, approved, decisive, representative: decisive[0]!, settings: keys.size > 1 ? "differ" : "same" };
}

const PAIR_REASONS = ["version.reused", "id.other-version", "id.other-upstream", "fork.declared-upstream", "fork.same-name", "capability.shared"] as const;
type PairReason = (typeof PAIR_REASONS)[number];
const classOf = (reason: PairReason): CollisionClass => {
  switch (reason) {
    case "version.reused": return "version-reuse";
    case "id.other-version":
    case "id.other-upstream": return "id-conflict";
    case "fork.declared-upstream":
    case "fork.same-name": return "fork";
    case "capability.shared": return "capability-overlap";
    default: {
      const never: never = reason;
      return never;
    }
  }
};

function sharedCapabilities(a: Entry, b: Entry): string[] {
  const other = new Set(b.member.capabilities);
  return a.member.capabilities.filter((c) => other.has(c));
}

function classifyPair(a: Entry, b: Entry): PairReason | undefined {
  const ia: SkillIdentity = a.candidate.skill.identity;
  const ib: SkillIdentity = b.candidate.skill.identity;
  const relation = relateSkills(ia, ib);
  if (relation === "version-conflict") return "version.reused";
  if (relation === "other-version") return "id.other-version";
  if (ia.id === ib.id) return ia.upstream === ib.upstream ? undefined : "id.other-upstream";
  if (ia.upstream !== ib.upstream) {
    if ((a.candidate.forkOf !== undefined && a.candidate.forkOf === ib.repositoryKey) || (b.candidate.forkOf !== undefined && b.candidate.forkOf === ia.repositoryKey)) return "fork.declared-upstream";
    if (ia.name === ib.name) return "fork.same-name";
  }
  return sharedCapabilities(a, b).length ? "capability.shared" : undefined;
}

/** The first rule that matches any pair of members. */
function bestReason(as: readonly Entry[], bs: readonly Entry[]): PairReason | undefined {
  let best: number = PAIR_REASONS.length;
  for (const a of as)
    for (const b of bs) {
      const r = classifyPair(a, b);
      if (r !== undefined) best = Math.min(best, PAIR_REASONS.indexOf(r));
    }
  return PAIR_REASONS[best];
}

const collisionId = (fingerprints: readonly string[]): string =>
  "col-" + createHash("sha256").update(COLLISION_ID_HEADER + sorted(fingerprints).join("\0"), "utf8").digest("hex").slice(0, COLLISION_LIMITS.idHex);

/** Pure. Throws RangeError("too many skill candidates") above COLLISION_LIMITS.candidates. Does not change its input. */
export function classifySkillCollisions(candidates: readonly CollisionCandidate[]): CollisionResult {
  if (candidates.length > COLLISION_LIMITS.candidates) throw new RangeError("too many skill candidates");
  const groups = new Map<string, Entry[]>();
  for (const c of candidates) {
    const e = memberOf(c);
    const list = groups.get(e.member.fingerprint);
    if (list) list.push(e);
    else groups.set(e.member.fingerprint, [e]);
  }
  const units = [...groups.entries()].sort((a, b) => byteCmp(a[0], b[0])).map(([fp, list]) => buildUnit(fp, list));

  const collisions: SkillCollision[] = [];
  const involved = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string) => map.set(key, [...(map.get(key) ?? []), id]);
  const record = (c: SkillCollision, units: readonly Unit[], blockedUnits: readonly Unit[]) => {
    collisions.push(c);
    for (const u of units) add(involved, u.fingerprint, c.id);
    if (c.blocking) for (const u of blockedUnits) add(blockedBy, u.fingerprint, c.id);
  };

  for (const u of units) {
    if (u.members.length < 2) continue;
    const reason: CollisionReason =
      u.settings === "differ"
        ? "mirror.settings-differ"
        : u.members.every((e) => e.member.upstream === u.members[0]!.member.upstream && e.member.version === u.members[0]!.member.version)
          ? "mirror.same-artifact"
          : "mirror.same-content";
    record(
      {
        id: collisionId([u.fingerprint]), class: "exact-mirror", reason,
        blocking: COLLISION_BLOCKING_REASONS.includes(reason) && u.approved.length > 0,
        fingerprints: [u.fingerprint], members: u.members.map((e) => e.member),
      },
      [u], [u],
    );
  }
  for (let i = 0; i < units.length; i++)
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i]!;
      const b = units[j]!;
      const reason = bestReason(a.members, b.members);
      if (reason === undefined) continue;
      // Blocking looks at the approved members only: an unapproved copy is evidence, but it cannot hold an approved skill back.
      const approvedReason = bestReason(a.approved, b.approved);
      const members = [...a.members, ...b.members].sort(entryCmp);
      const collision: SkillCollision = {
        id: collisionId([a.fingerprint, b.fingerprint]), class: classOf(reason), reason,
        blocking: approvedReason !== undefined && COLLISION_BLOCKING_CLASSES.includes(classOf(approvedReason)),
        fingerprints: sorted([a.fingerprint, b.fingerprint]), members: members.map((e) => e.member),
      };
      if (reason === "capability.shared") {
        const shared = new Set<string>();
        for (const x of a.members) for (const y of b.members) if (classifyPair(x, y) === "capability.shared") for (const s of sharedCapabilities(x, y)) shared.add(s);
        collision.shared = sorted([...shared]);
      }
      record(collision, [a, b], [a, b]);
    }

  collisions.sort((a, b) => COLLISION_CLASSES.indexOf(a.class) - COLLISION_CLASSES.indexOf(b.class) || byteCmp(a.id, b.id));
  const entries = units
    .map((u): DedupedSkill => {
      const records = new Map<string, SkillProvenance>();
      for (const e of u.approved) records.set(provenanceKey(e.candidate.skill.provenance), e.candidate.skill.provenance);
      const provenance = [...records.values()].sort(
        (x, y) => byteCmp(x.source, y.source) || byteCmp(x.repositoryKey, y.repositoryKey) || byteCmp(x.commit, y.commit) || byteCmp(x.root, y.root),
      );
      return {
        fingerprint: u.fingerprint,
        skill: u.representative.candidate.skill,
        provenance,
        approved: u.approved.length > 0,
        unapproved: u.members.length - u.approved.length,
        settings: u.settings,
        collisions: sorted(involved.get(u.fingerprint) ?? []),
        blockedBy: sorted(blockedBy.get(u.fingerprint) ?? []),
      };
    })
    .sort((a, b) => byteCmp(a.skill.identity.id, b.skill.identity.id) || byteCmp(a.fingerprint, b.fingerprint));
  return { entries, report: { schema: 1, candidates: candidates.length, entries: entries.length, collisions } };
}

const offerable = (e: DedupedSkill): boolean => e.approved && e.blockedBy.length === 0;

/** The packages the planner may be offered: approved, and not held back by a blocking collision. */
export function plannerPackages(result: CollisionResult): SkillPackage[] {
  return result.entries.filter(offerable).map((e) => e.skill.package);
}

/**
 * Items without a candidate are kept as they are. Of the others, one per fingerprint is kept (the representative);
 * unapproved and blocked ones are dropped. Keeps the input order. `heldItems` are the unapproved items and the items of blocked units.
 */
export function dedupeOffered<T>(
  items: readonly T[],
  candidateOf: (item: T) => CollisionCandidate | undefined,
): { kept: T[]; merged: number; held: number; heldItems: T[]; report: CollisionReport } {
  const found = items.map((item) => ({ item, candidate: candidateOf(item) }));
  const result = classifySkillCollisions(found.flatMap((f) => (f.candidate ? [f.candidate] : [])));
  const entries = new Map(result.entries.map((e) => [e.fingerprint, e]));
  const taken = new Set<string>();
  const kept: T[] = [];
  const heldItems: T[] = [];
  let merged = 0;
  for (const { item, candidate } of found) {
    if (!candidate) {
      kept.push(item);
      continue;
    }
    const fp = candidate.skill.identity.fingerprint;
    const entry = entries.get(fp);
    // An unapproved copy is held back even when its unit is offered: the registry would still load it for a dependant.
    if (!entry || !offerable(entry) || !candidate.approved) heldItems.push(item);
    else if (candidate.skill === entry.skill && !taken.has(fp)) {
      taken.add(fp);
      kept.push(item);
    } else merged++;
  }
  return { kept, merged, held: heldItems.length, heldItems, report: result.report };
}
