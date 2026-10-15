import { selectCanonicalSkills, canonicalKey, type CanonicalCandidate, type CanonicalPolicy, type CanonicalResult } from "./canonical.js";
import { canonicalFromCollision, canonicalFromRegistered } from "./canonical-facts.js";
import { COLLISION_LIMITS, type CollisionClass, type CollisionReason } from "./collision-rules.js";
import { classifySkillCollisions, collisionCandidate, type CollisionCandidate } from "./collisions.js";
import { byteCmp } from "./import-plan.js";
import type { LicenceStatus } from "./licence.js";
import type { NormalizedSkill } from "./normalize.js";
import { PROVIDER_MARKERS, type ProviderMarker } from "./provider-rules.js";
import type { RegisteredSkill } from "./registry.js";
import { ToolPolicySchema, type SkillRisk, type ToolPolicy } from "./schema.js";
import { selectionConnectors, type SelectionScope, type SkillSelection } from "./selections.js";
import type { SkillLibrarySource } from "./sources.js";

// One verdict per imported skill: selection, licence, scan, undeclared provider needs, and overlap with other skills.
// Pure: no file system, no process, no clock. No run calls it.

export const SOURCE_SKILL_REASONS = [
  "blocking-collision", "compatibility-unchecked", "incompatible", "licence", "needs-unavailable-tools", "not-selected",
  "provider-content-in-portable", "provider-without-policy", "safety", "selection-stale", "source-not-approved", "undeclared-requirement",
] as const;
export type SourceSkillReason = (typeof SOURCE_SKILL_REASONS)[number];

type Tech = { name: string; version?: string };

export interface SourceSkillsInput {
  source: SkillLibrarySource;
  skills: readonly NormalizedSkill[];
  selections: readonly SkillSelection[];
  /** provenance.root → status. A root that is not listed is unknown. */
  licences: Readonly<Record<string, LicenceStatus>>;
  /** Package ids with a promotion blocker from the scan. */
  blocked: readonly string[];
  registered: readonly RegisteredSkill[];
  policy: CanonicalPolicy;
  /** Default: ToolPolicySchema.parse({}). */
  tools?: ToolPolicy;
  /** Project technologies; without it compatibility is "generic". */
  evidence?: readonly Tech[];
}
export interface SourceSkillVerdict {
  root: string;
  id: string;
  name: string;
  version: string;
  digest: string;
  fingerprint: string;
  /** Absent without a current selection. */
  scope?: SelectionScope;
  eligible: boolean;
  /** Sorted, each once. */
  reasons: SourceSkillReason[];
  /** Sorted rule ids of the markers that caused a reason. Never the matched text. */
  rules: string[];
  capabilities: string[];
  technologies: Tech[];
  connectors: string[];
  risk: SkillRisk;
  /** Capabilities this skill is the canonical winner of, sorted. */
  wins: string[];
  /** Sorted collision ids. */
  collisions: string[];
}
export interface SourceSkillCollision {
  id: string;
  class: CollisionClass;
  reason: CollisionReason;
  blocking: boolean;
  shared: string[];
  /** Sorted unique ids of the members. */
  skills: string[];
}
export interface SourceSkillsEvaluation {
  schema: 1;
  source: string;
  /** Sorted by id, then root. */
  skills: SourceSkillVerdict[];
  collisions: SourceSkillCollision[];
  exclusive: string[];
  /** The last selection run. */
  canonical: CanonicalResult;
}

const RISK_RANK: Record<SkillRisk, number> = { low: 0, medium: 1, high: 2 };
const TAKE_OUT: readonly SourceSkillReason[] = [
  "not-selected", "selection-stale", "provider-content-in-portable", "undeclared-requirement", "blocking-collision", "provider-without-policy",
];
const MAX_SLUG = 64;

const sortedUnique = (a: Iterable<string>): string[] => [...new Set(a)].sort(byteCmp);

function sdkSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SLUG).replace(/-+$/, "");
}

function mergeTechnologies(declared: readonly Tech[], add: readonly Tech[]): Tech[] {
  const out: Tech[] = declared.map((t) => ({ ...t }));
  for (const a of add) {
    const at = out.findIndex((t) => t.name === a.name);
    if (at < 0) out.push({ ...a });
    else if (out[at]!.version === undefined) out[at] = { ...a };
  }
  return out.sort((x, y) => byteCmp(x.name, y.name));
}

/** The skill with the selection's product, SDK, category, capabilities and requirements added. Never changes its input. */
export function applySelection(skill: NormalizedSkill, selection: SkillSelection): NormalizedSkill {
  const needs = selectionConnectors(selection);
  const pkg = skill.package;
  const add: Tech[] = [];
  if (selection.product) add.push({ name: selection.product.name, version: selection.product.version });
  if (selection.sdk) {
    const name = sdkSlug(selection.sdk.name);
    if (name) add.push({ name, version: selection.sdk.version });
  }
  const risk: SkillRisk = needs.length && RISK_RANK[pkg.risk] < RISK_RANK.medium ? "medium" : pkg.risk;
  return {
    ...skill,
    package: {
      ...pkg,
      category: selection.category,
      capabilities: sortedUnique([...(pkg.capabilities ?? []), ...selection.capabilities]),
      connectors: sortedUnique([...(pkg.connectors ?? []), ...needs]),
      risk,
    },
    provenance: { ...skill.provenance, technologies: mergeTechnologies(skill.provenance.technologies, add) },
  };
}

function textsOf(skill: NormalizedSkill): string[] {
  const { package: pkg, provenance } = skill;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const out: string[] = [pkg.description, pkg.instructions];
  for (const v of [pkg.review, pkg.allowedTools, pkg.compatibility, pkg.license]) if (v !== undefined) out.push(v);
  out.push(...Object.values(pkg.metadata ?? {}), ...Object.values(provenance.upstream), ...provenance.requiredTools);
  for (const files of Object.values(pkg.files ?? {})) for (const f of files) out.push(decoder.decode(f.content));
  for (const f of skill.extraFiles) out.push(decoder.decode(f.content));
  return out;
}

function markersIn(skill: NormalizedSkill): ProviderMarker[] {
  const texts = textsOf(skill);
  return PROVIDER_MARKERS.filter((m) => texts.some((t) => m.re.test(t)));
}

/** Sorted rule ids of the provider markers found in the text of the skill. */
export function providerMarkerRules(skill: NormalizedSkill): string[] {
  return markersIn(skill).map((m) => m.rule).sort(byteCmp);
}

const covered = (m: ProviderMarker, declared: readonly string[]): boolean =>
  declared.some((d) => m.aliases.includes(d) || m.names.some((n) => d === n || d.startsWith(n + "-")));

const REGISTRY_FIELDS = { schema: 1 as const, layout: "foundry" as const };

export function registeredCandidate(s: RegisteredSkill): CollisionCandidate {
  const repositoryKey = "registry/" + s.source;
  const skill: NormalizedSkill = {
    package: s.pkg,
    extraFiles: [],
    identity: {
      schema: 1, id: s.id, source: s.source, repositoryKey, upstream: `${repositoryKey}#${s.id}`, name: s.id,
      version: s.version, versionDeclared: true, fingerprint: s.digest, digest: s.digest,
    },
    provenance: {
      schema: REGISTRY_FIELDS.schema, source: s.source, repository: "", repositoryKey, commit: "", root: s.id, name: s.id,
      layout: REGISTRY_FIELDS.layout, versionDeclared: true, dependencies: [], technologies: [], requiredTools: [],
      entryPoints: { instructions: "SKILL.md", scripts: [], documents: [] }, context: { instructions: 0, text: 0 }, upstream: {},
    },
  };
  return { skill, approved: s.trust !== "unapproved", trust: "first-party", licencesAllowed: [] };
}

interface Item {
  original: NormalizedSkill;
  copy: NormalizedSkill;
  selection?: SkillSelection;
  reasons: Set<SourceSkillReason>;
  rules: Set<string>;
  candidate: CollisionCandidate;
  canonical: CanonicalCandidate;
  key: string;
}

export function evaluateSourceSkills(input: SourceSkillsInput): SourceSkillsEvaluation {
  const { source, policy } = input;
  const tools = input.tools ?? ToolPolicySchema.parse({});
  const evidence = input.evidence ? { evidence: input.evidence } : {};
  const skills = [...input.skills].sort((a, b) => byteCmp(a.package.id, b.package.id) || byteCmp(a.provenance.root, b.provenance.root) || byteCmp(a.package.digest, b.package.digest));
  const active = input.registered.filter((s) => s.active).sort((a, b) => byteCmp(a.key, b.key));
  if (skills.length + active.length > COLLISION_LIMITS.candidates) throw new RangeError("too many skill candidates");

  const chosen = new Map<string, SkillSelection>();
  for (const s of [...input.selections].filter((x) => x.source === source.id).sort((a, b) => byteCmp(a.skill, b.skill))) {
    if (chosen.has(s.skill)) throw new TypeError("a skill is selected twice");
    chosen.set(s.skill, s);
  }
  const blocked = new Set(input.blocked);

  const items: Item[] = skills.map((original) => {
    const reasons = new Set<SourceSkillReason>();
    const rules = new Set<string>();
    const found = chosen.get(original.provenance.name);
    let selection: SkillSelection | undefined;
    if (!found) reasons.add("not-selected");
    else if (found.digest !== original.package.digest) reasons.add("selection-stale");
    else selection = found;
    const copy = selection ? applySelection(original, selection) : original;
    if (selection) {
      for (const m of markersIn(original)) {
        if (selection.scope === "portable") {
          reasons.add("provider-content-in-portable");
          rules.add(m.rule);
        } else if (!covered(m, selection.requires[m.kind] ?? [])) {
          reasons.add("undeclared-requirement");
          rules.add(m.rule);
        }
      }
    }
    const root = original.provenance.root;
    const status = Object.hasOwn(input.licences, root) ? input.licences[root] : undefined;
    const candidate = collisionCandidate(copy, source);
    const canonical = canonicalFromCollision(candidate, {
      licence: status ?? "missing", sourceStatus: source.status, safety: !blocked.has(original.package.id), tools, ...evidence,
    });
    if (canonical.status !== "approved" || canonical.tier === "discovery-only") reasons.add("source-not-approved");
    if (canonical.failed.includes("safety")) reasons.add("safety");
    if (canonical.failed.includes("licence")) reasons.add("licence");
    if (canonical.failed.includes("tools")) reasons.add("needs-unavailable-tools");
    if (canonical.compatibility === "incompatible") reasons.add("incompatible");
    if (canonical.compatibility === "unchecked") reasons.add("compatibility-unchecked");
    return { original, copy, ...(selection ? { selection } : {}), reasons, rules, candidate, canonical, key: canonicalKey(canonical) };
  });

  // An installed copy of an imported package is the same artifact, not an overlap. The installed skill keeps its place in the
  // selection; the imported copy is left out of it.
  const artifact = (id: string, version: string, digest: string) => `${id}@${version} ${digest}`;
  const same = new Set(items.map((i) => artifact(i.original.package.id, i.original.package.version, i.original.package.digest)));
  const installed = new Set(active.map((s) => artifact(s.id, s.version, s.digest)));
  const installedCopy = (i: Item) => installed.has(artifact(i.original.package.id, i.original.package.version, i.original.package.digest));
  const registered = active.map((s) => {
    const bad = s.pin === "mismatch" || s.pin === "unverified";
    return {
      s,
      copy: same.has(artifact(s.id, s.version, s.digest)),
      candidate: registeredCandidate(s),
      canonical: canonicalFromRegistered(s, { tools, ...evidence, ...(bad ? { safety: false } : {}) }),
    };
  });

  // Collisions.
  const classified = classifySkillCollisions([...items.map((i) => i.candidate), ...registered.filter((r) => !r.copy).map((r) => r.candidate)]);
  const importedPrints = new Set(items.map((i) => i.copy.identity.fingerprint));
  const collisions = classified.report.collisions.filter((c) => c.fingerprints.some((f) => importedPrints.has(f)));
  const blockedPrints = new Set(classified.entries.filter((e) => e.blockedBy.length > 0).map((e) => e.fingerprint));
  for (const i of items) if (blockedPrints.has(i.copy.identity.fingerprint)) i.reasons.add("blocking-collision");

  // Selection.
  const out = (i: Item) => TAKE_OUT.some((r) => i.reasons.has(r));
  const importedByKey = new Map(items.map((i) => [i.key, i]));
  const portable = new Set<string>([
    ...items.filter((i) => i.selection?.scope === "portable").map((i) => i.key),
    ...registered.filter((r) => !r.s.pkg.provider).map((r) => canonicalKey(r.canonical)),
  ]);
  const participants = (): CanonicalCandidate[] => [...items.filter((i) => !out(i) && !installedCopy(i)).map((i) => i.canonical), ...registered.map((r) => r.canonical)];

  const first = participants();
  const exclusive = new Set(policy.exclusive);
  for (const i of items) {
    if (out(i) || installedCopy(i)) continue;
    for (const cap of i.canonical.capabilities) if (first.some((c) => canonicalKey(c) !== i.key && c.capabilities.includes(cap))) exclusive.add(cap);
  }
  const exclusiveList = [...exclusive].sort(byteCmp);
  const matches = (value: string | undefined, c: { id: string; version: string }) => value !== undefined && (value === c.id || value === `${c.id}@${c.version}`);

  let canonical: CanonicalResult;
  for (;;) {
    canonical = selectCanonicalSkills(participants(), { ...policy, exclusive: exclusiveList });
    const offenders = new Set<Item>();
    for (const r of canonical.resolutions) {
      if (r.outcome !== "selected" || !r.winner) continue;
      const winner = importedByKey.get(canonicalKey(r.winner));
      if (!winner || winner.selection?.scope !== "provider" || out(winner)) continue;
      if (matches(policy.pins?.[r.capability], r.winner) || matches(policy.overrides?.[r.capability], r.winner)) continue;
      if (r.rejected.some((x) => x.code === "outranked" && portable.has(canonicalKey(x)))) offenders.add(winner);
    }
    if (!offenders.size) break;
    for (const o of offenders) o.reasons.add("provider-without-policy");
  }

  const wins = new Map<string, string[]>();
  for (const r of canonical.resolutions) if (r.outcome === "selected" && r.winner) wins.set(canonicalKey(r.winner), [...(wins.get(canonicalKey(r.winner)) ?? []), r.capability]);

  const verdicts = items.map((i): SourceSkillVerdict => {
    const reasons = [...i.reasons].sort(byteCmp) as SourceSkillReason[];
    const { package: pkg, provenance, identity } = i.copy;
    return {
      root: provenance.root,
      id: pkg.id,
      name: provenance.name,
      version: pkg.version,
      digest: pkg.digest,
      fingerprint: identity.fingerprint,
      ...(i.selection ? { scope: i.selection.scope } : {}),
      eligible: reasons.length === 0,
      reasons,
      rules: [...i.rules].sort(byteCmp),
      capabilities: [...(pkg.capabilities ?? [])].sort(byteCmp),
      technologies: provenance.technologies.map((t) => ({ ...t })),
      connectors: [...(pkg.connectors ?? [])].sort(byteCmp),
      risk: pkg.risk,
      wins: (wins.get(i.key) ?? []).sort(byteCmp),
      collisions: collisions.filter((c) => c.fingerprints.includes(identity.fingerprint)).map((c) => c.id).sort(byteCmp),
    };
  });
  verdicts.sort((a, b) => byteCmp(a.id, b.id) || byteCmp(a.root, b.root));

  return {
    schema: 1,
    source: source.id,
    skills: verdicts,
    collisions: collisions.map((c) => ({
      id: c.id, class: c.class, reason: c.reason, blocking: c.blocking, shared: [...(c.shared ?? [])],
      skills: sortedUnique(c.members.map((m) => m.id)),
    })),
    exclusive: exclusiveList,
    canonical,
  };
}
