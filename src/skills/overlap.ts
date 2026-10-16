import { canonicalKey, selectCanonicalSkills, type CanonicalCandidate } from "./canonical.js";
import { CANONICAL_CONFLICTS, CANONICAL_REJECT_CODES, type CanonicalLevel } from "./canonical-rules.js";
import { canonicalFromCollision, canonicalFromRegistered } from "./canonical-facts.js";
import { COLLISION_LIMITS } from "./collision-rules.js";
import { classifySkillCollisions, collisionCandidate, type CollisionCandidate } from "./collisions.js";
import { byteCmp } from "./import-plan.js";
import type { LicenceStatus } from "./licence.js";
import type { NormalizedSkill } from "./normalize.js";
import type { RegisteredSkill } from "./registry.js";
import { ToolPolicySchema, type ToolPolicy } from "./schema.js";
import { registeredCandidate } from "./source-skill-evaluation.js";
import type { SkillLibrarySource } from "./sources.js";
import { declaredVersions, effectiveSkill, type SelectionLike } from "./suite-checks.js";

// Compares the skills of a staged source with the registered skills: per capability the canonical skill, a conflict, or "new".
// Pure: no file system, no process, no clock; the input is never changed. No run reads the report. Every line is built from
// slugs, versions, fixed codes and levels; no description, name or path of an upstream skill reaches it.

export interface OverlapStagedSkill {
  /** Normalized, before the source profile. */
  skill: NormalizedSkill;
  /** The licence verdict for provenance.root, with the review approval already applied. */
  licence: LicenceStatus;
  /** No promotion blocker from the scan. */
  safe: boolean;
}
export interface OverlapStaged {
  source: SkillLibrarySource;
  skills: readonly OverlapStagedSkill[];
  /** Reviewed selections (skill-selections.yaml): they give capabilities to a skill that declares none, at the same digest. */
  selections?: readonly SelectionLike[];
}
export interface OverlapPolicy {
  highRisk: readonly string[];
  mandatory?: readonly string[];
  tools?: ToolPolicy;
}
export interface OverlapSkill {
  id: string;
  version: string;
  /** The name of the provider block, when the skill has one. */
  provider?: string;
  origin: "staged" | "builtin" | "admin" | "catalogue";
}
export type OverlapCode = (typeof CANONICAL_REJECT_CODES)[number];
export interface OverlapRejection {
  skill: OverlapSkill;
  code: OverlapCode;
}
export type OverlapEntry =
  | { kind: "canonical"; capability: string; winner: OverlapSkill; level: CanonicalLevel | "only-candidate"; rejected: OverlapRejection[] }
  | { kind: "conflict"; capability: string; conflict: (typeof CANONICAL_CONFLICTS)[number]; skills: OverlapSkill[]; rejected: OverlapRejection[] }
  | { kind: "none"; capability: string; rejected: OverlapRejection[] }
  | { kind: "new"; capability: string; skill: OverlapSkill; rejected: OverlapRejection[] };
export const OVERLAP_PROBLEM_CODES = ["profile", "scope-collision", "blocking-collision"] as const;
export interface OverlapProblem {
  skill: OverlapSkill;
  code: (typeof OVERLAP_PROBLEM_CODES)[number];
  /** blocking-collision: the collision classes, sorted. */
  detail?: string;
  /** blocking-collision: the other members, sorted. */
  with?: OverlapSkill[];
}
export interface OverlapReport {
  schema: 1;
  source: string;
  /** Sorted by the line they print. */
  problems: OverlapProblem[];
  /** One per capability a staged skill declares; sorted by capability. */
  entries: OverlapEntry[];
  shared: number;
  new: number;
  conflicts: number;
  /** Capabilities the profile scoped to the provider. */
  vendorOnly: number;
  /** The technology versions each staged skill declares (skills with none are left out); sorted by the skill's printed reference. */
  versions: { skill: OverlapSkill; technologies: { name: string; version: string }[] }[];
  /** No conflict and no problem. */
  ok: boolean;
}

const CONFLICT_CODES: readonly OverlapCode[] = ["outranked", "tied", "held", "overlap"];

const refText = (s: OverlapSkill) => `${s.id}@${s.version}`;
const withProvider = (s: OverlapSkill) => refText(s) + (s.provider ? ` provider ${s.provider}` : "");
const sortedUnique = (a: Iterable<string>): string[] => [...new Set(a)].sort(byteCmp);
const artifact = (id: string, version: string, digest: string) => `${id}@${version} ${digest}`;
const byRef = (a: OverlapSkill, b: OverlapSkill) => byteCmp(withProvider(a), withProvider(b));

export function overlapReport(staged: OverlapStaged, registered: readonly RegisteredSkill[], policy: OverlapPolicy): OverlapReport {
  const { source } = staged;
  const profile = source.profile;
  const tools = policy.tools ?? ToolPolicySchema.parse({});
  const skills = [...staged.skills].sort(
    (a, b) =>
      byteCmp(a.skill.package.id, b.skill.package.id) || byteCmp(a.skill.provenance.root, b.skill.provenance.root) ||
      byteCmp(a.skill.package.digest, b.skill.package.digest),
  );
  const active = registered.filter((s) => s.active && s.source !== "repository").sort((a, b) => byteCmp(a.key, b.key));
  if (skills.length + active.length > COLLISION_LIMITS.candidates) throw new RangeError("too many skill candidates");

  const stagedRef = (s: NormalizedSkill, provider?: string): OverlapSkill => {
    const name = provider ?? s.package.provider?.name;
    return { id: s.package.id, version: s.package.version, ...(name !== undefined ? { provider: name } : {}), origin: "staged" };
  };
  const problems: OverlapProblem[] = [];

  // 1. The source profile, per skill; which of its capabilities are vendor-scoped and which are portable.
  // A skill that declares no capabilities may get them from a reviewed selection of the same digest (effectiveSkill).
  interface Item { entry: OverlapStagedSkill; skill: NormalizedSkill; vendor: Set<string>; portable: Set<string> }
  const items: Item[] = [];
  /** Vendor capability → the provider that owns it. */
  const owners = new Map<string, string>();
  for (const entry of skills) {
    const e = effectiveSkill(entry.skill, source, staged.selections ?? []);
    if (!e.skill) {
      problems.push({ skill: stagedRef(entry.skill, e.vendor.length ? e.provider : undefined), code: "profile" });
      continue;
    }
    items.push({ entry, skill: e.skill, vendor: new Set(e.vendor), portable: new Set(e.portable) });
    if (e.provider !== undefined) for (const c of e.vendor) owners.set(c, e.provider);
  }

  // A slug that is vendor-scoped for one skill and portable for another cannot keep both scopes.
  const portableSlugs = new Set(items.flatMap((i) => [...i.portable]));
  const scoped = items.filter((i) => {
    if (![...i.vendor].some((c) => portableSlugs.has(c))) return true;
    problems.push({ skill: stagedRef(i.skill), code: "scope-collision" });
    return false;
  });
  const vendorSlugs = new Set(scoped.flatMap((i) => [...i.vendor]));

  // 2. Registered skills: a vendor-scoped capability belongs only to a skill of the provider that owns it.
  const shown = (s: RegisteredSkill): RegisteredSkill => {
    if (!vendorSlugs.size) return s;
    const mine = (c: string) => vendorSlugs.has(c) && owners.get(c) !== s.pkg.provider?.name;
    const caps = s.pkg.capabilities ?? [];
    if (!caps.some(mine)) return s;
    return { ...s, pkg: { ...s.pkg, capabilities: caps.filter((c) => !mine(c)) } };
  };
  const registeredRef = (s: RegisteredSkill): OverlapSkill => ({
    id: s.id, version: s.version, ...(s.pkg.provider ? { provider: s.pkg.provider.name } : {}), origin: s.source as OverlapSkill["origin"],
  });

  // 3. Blocking collisions hold a staged skill back, like the evaluation of a source does.
  const candidates = new Map<Item, CollisionCandidate>(scoped.map((i) => [i, collisionCandidate(i.skill, source)]));
  // An installed copy is the same artifact as the imported skill, so it does not collide with it.
  const imported = new Set(scoped.map((i) => artifact(i.skill.package.id, i.skill.package.version, i.skill.package.digest)));
  const classified = classifySkillCollisions([
    ...candidates.values(),
    ...active.filter((s) => !imported.has(artifact(s.id, s.version, s.digest))).map((s) => registeredCandidate(shown(s))),
  ]);
  const blocked = new Map(classified.entries.filter((e) => e.blockedBy.length > 0).map((e) => [e.fingerprint, e.blockedBy] as const));
  const kept = scoped.filter((i) => {
    const ids = blocked.get(i.skill.identity.fingerprint);
    if (!ids) return true;
    const mine = classified.report.collisions.filter((c) => ids.includes(c.id));
    const others = new Map<string, OverlapSkill>();
    for (const c of mine) {
      for (const m of c.members) {
        if (m.fingerprint === i.skill.identity.fingerprint && m.source === source.id) continue;
        const o: OverlapSkill = {
          id: m.id, version: m.version, ...(m.settings.provider ? { provider: m.settings.provider.name } : {}),
          origin: m.source === source.id ? "staged" : (m.source as OverlapSkill["origin"]),
        };
        others.set(withProvider(o), o);
      }
    }
    problems.push({
      skill: stagedRef(i.skill), code: "blocking-collision", detail: sortedUnique(mine.map((c) => c.class)).join(","),
      with: [...others.values()].sort(byRef),
    });
    return false;
  });

  // 4. An installed copy is the same artifact as an imported skill: the installed skill keeps its place and its facts.
  // It is a copy only when the profile leaves it declaring what the installed skill declares; otherwise it competes on its own.
  const installed = new Map(active.map((s) => [artifact(s.id, s.version, s.digest), s] as const));
  const installedFor = (i: Item): RegisteredSkill | undefined => {
    const s = installed.get(artifact(i.skill.package.id, i.skill.package.version, i.skill.package.digest));
    if (!s) return undefined;
    const mine = [...(i.skill.package.capabilities ?? [])].sort(byteCmp);
    const theirs = [...(shown(s).pkg.capabilities ?? [])].sort(byteCmp);
    const same = mine.length === theirs.length && mine.every((c, n) => c === theirs[n]) && i.skill.package.provider?.name === s.pkg.provider?.name;
    return same ? s : undefined;
  };
  const isCopy = (i: Item) => installedFor(i) !== undefined;
  const participating = kept.filter((i) => !isCopy(i));
  // The gate verdicts of the imported artifact hold for its installed copy too.
  const copyOf = new Map<string, Item>();
  for (const i of kept) {
    const s = installedFor(i);
    if (s) copyOf.set(s.key, i);
  }

  const refs = new Map<string, OverlapSkill>();
  const stagedCands = new Map<Item, CanonicalCandidate>();
  for (const i of participating) {
    const c = canonicalFromCollision(candidates.get(i)!, { licence: i.entry.licence, sourceStatus: source.status, safety: i.entry.safe, tools });
    stagedCands.set(i, c);
    refs.set(canonicalKey(c), stagedRef(i.skill));
  }
  const copyCands = new Map<Item, CanonicalCandidate>();
  const registeredCands: CanonicalCandidate[] = active.map((s) => {
    const mine = copyOf.get(s.key);
    const bad = s.pin === "mismatch" || s.pin === "unverified" || (mine !== undefined && !mine.entry.safe);
    const c = canonicalFromRegistered(shown(s), { tools, ...(bad ? { safety: false } : {}), ...(mine ? { licence: mine.entry.licence } : {}) });
    refs.set(canonicalKey(c), registeredRef(s));
    if (mine) copyCands.set(mine, c);
    return c;
  });
  const all = [...stagedCands.values(), ...registeredCands];

  // 5. Exclusive: every capability with two or more providers.
  const providers = new Map<string, Set<string>>();
  for (const c of all) for (const cap of c.capabilities) providers.set(cap, (providers.get(cap) ?? new Set()).add(canonicalKey(c)));
  const exclusive = [...providers].filter(([, p]) => p.size >= 2).map(([cap]) => cap).sort(byteCmp);
  const result = selectCanonicalSkills(all, { exclusive, highRisk: policy.highRisk, ...(policy.mandatory ? { mandatory: policy.mandatory } : {}) });
  const resolution = new Map(result.resolutions.map((r) => [r.capability, r]));

  const refOf = (r: { id: string; version: string; fingerprint: string }) => refs.get(canonicalKey(r))!;
  const rejections = (list: readonly { id: string; version: string; fingerprint: string; code: OverlapCode }[]): OverlapRejection[] =>
    list.map((r) => ({ skill: refOf(r), code: r.code }));

  // 6. One entry per capability a staged skill declares, installed copies included.
  const declared = sortedUnique(kept.flatMap((i) => i.skill.package.capabilities ?? []));
  const entries: OverlapEntry[] = declared.map((capability): OverlapEntry => {
    const r = resolution.get(capability);
    if (r) {
      if (r.outcome === "selected" && r.winner) {
        return { kind: "canonical", capability, winner: refOf(r.winner), level: r.decidedBy ?? "only-candidate", rejected: rejections(r.rejected) };
      }
      if (r.outcome === "conflict" && r.conflict) {
        const rivals = r.rejected.filter((x) => CONFLICT_CODES.includes(x.code));
        const unique = new Map(rivals.map((x) => [withProvider(refOf(x)), refOf(x)] as const));
        return {
          kind: "conflict", capability, conflict: r.conflict, skills: [...unique.values()].sort(byRef),
          rejected: rejections(r.rejected.filter((x) => !CONFLICT_CODES.includes(x.code))),
        };
      }
      return { kind: "none", capability, rejected: rejections(r.rejected) };
    }
    // Only the installed copy provides it: it is its own canonical skill, if the gates of the imported artifact allow it.
    const copy = kept.find((x) => isCopy(x) && (x.skill.package.capabilities ?? []).includes(capability));
    if (copy && !participating.some((x) => (x.skill.package.capabilities ?? []).includes(capability))) {
      const alone = selectCanonicalSkills([copyCands.get(copy)!], { exclusive: [capability], highRisk: [] }).resolutions[0]!;
      return alone.outcome === "selected"
        ? { kind: "canonical", capability, winner: refOf(alone.winner!), level: "only-candidate", rejected: [] }
        : { kind: "none", capability, rejected: rejections(alone.rejected) };
    }
    // Only the source declares it: it still has to pass the gates to be usable.
    const i = participating.find((x) => (x.skill.package.capabilities ?? []).includes(capability))!;
    const cand = stagedCands.get(i)!;
    const alone = selectCanonicalSkills([cand], { exclusive: [capability], highRisk: [] }).resolutions[0]!;
    return { kind: "new", capability, skill: stagedRef(i.skill), rejected: alone.outcome === "selected" ? [] : rejections(alone.rejected) };
  });

  const conflicts = entries.filter((e) => e.kind === "conflict").length;
  const news = entries.filter((e) => e.kind === "new").length;
  problems.sort((a, b) => byteCmp(problemLine(a), problemLine(b)));
  const versions = items
    .map((i) => ({ skill: stagedRef(i.skill), technologies: declaredVersions(i.skill, source) }))
    .filter((v) => v.technologies.length > 0)
    .sort((a, b) => byRef(a.skill, b.skill));
  return {
    schema: 1,
    source: source.id,
    problems,
    entries,
    shared: entries.length - news,
    new: news,
    conflicts,
    vendorOnly: vendorSlugs.size,
    versions,
    ok: conflicts === 0 && problems.length === 0,
  };
}

function problemLine(p: OverlapProblem): string {
  const detail = p.detail ? ` ${p.detail}` : "";
  const others = p.with?.length ? ` with ${p.with.map(withProvider).join(", ")}` : "";
  return `PROBLEM ${withProvider(p.skill)}: ${p.code}${detail}${others}`;
}

const rejectedLine = (r: OverlapRejection) => `REJECTED ${refText(r.skill)}: ${r.code}${r.skill.provider ? ` provider ${r.skill.provider}` : ""}`;

/** `VERSIONS <id>@<version>: <name range, …>` per staged skill that declares versions. */
export function versionLines(report: OverlapReport): string[] {
  return report.versions.map((v) => `VERSIONS ${refText(v.skill)}: ${v.technologies.map((t) => `${t.name} ${t.version}`).join(", ")}`);
}

/** The lines of the report, without the final summary. The same for any order of the input. */
export function overlapLines(report: OverlapReport): string[] {
  const out = report.problems.map(problemLine);
  for (const e of report.entries) {
    if (e.kind === "canonical") {
      out.push(`CANONICAL ${e.capability}: ${refText(e.winner)} (${e.level})${e.winner.provider ? ` provider ${e.winner.provider}` : ""}`);
    } else if (e.kind === "conflict") {
      out.push(`CONFLICT ${e.capability}: ${e.conflict} ${e.skills.map(withProvider).join(", ")}`);
    } else if (e.kind === "none") {
      out.push(`NONE ${e.capability}: no skill can be used`);
    } else {
      out.push(`NEW ${e.capability}: ${withProvider(e.skill)}`);
    }
    for (const r of e.rejected) out.push(rejectedLine(r));
  }
  return out;
}
