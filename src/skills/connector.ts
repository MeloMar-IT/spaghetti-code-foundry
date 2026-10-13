import type { CanonicalCandidate, CanonicalPolicy } from "./canonical.js";
import { canonicalFromCollision, technologyCompatibility } from "./canonical-facts.js";
import { collisionCandidate } from "./collisions.js";
import { SOURCE_CONNECTORS, type ConnectorSkillRule, type SourceConnector } from "./connector-rules.js";
import { byteCmp } from "./import-plan.js";
import type { LicenceStatus } from "./licence.js";
import type { NormalizedSkill } from "./normalize.js";
import type { RepoProfile } from "./repo-profile.js";
import type { SkillRisk, ToolPolicy } from "./schema.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";

// Applies a reviewed connector profile (connector-rules.ts) to normalized skills and gives the canonical selector its facts.
// Pure: no file system, no process, no network, no clock. Nothing is installed or run.

type Tech = { name: string; version?: string };
type Unmapped = { root: string; name: string; reason: "not-in-profile" | "companion-missing" };

export const UNKNOWN_VERSION = "unknown";

export interface ConnectorRecord {
  schema: 1;
  connector: string;
  profile: number;
  id: string;
  name: string;
  digest: string;
  /** The skill's commit is one the profile was checked against. */
  reviewed: boolean;
  specific: string[];
  general: string[];
  orm?: string;
  engines: string[];
  runtime?: string;
  requirements: string[];
  evaluations: string[];
  /** Guard phrases found in the skill's text; sorted. */
  guarded: string[];
  highRisk: boolean;
  /** What the normalizer had read, before the connector. */
  original: { capabilities: string[]; category: string; risk: SkillRisk; technologies: Tech[] };
}
export interface ConnectedSkill { skill: NormalizedSkill; record: ConnectorRecord }
export interface EvaluationResult { skill: string; digest: string; evaluation: string; result: "passed" | "failed" }

const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort(byteCmp);
const decoder = new TextDecoder("utf-8");

export function connectorFor(source: Pick<SkillLibrarySource, "repositoryKey">): SourceConnector | undefined {
  return SOURCE_CONNECTORS.find((c) => c.repositoryKey === source.repositoryKey);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const guardRegex = (phrase: string): RegExp => new RegExp(phrase.trim().split(/\s+/).map(escapeRe).join("\\s+"), "i");

function textOf(skill: NormalizedSkill): string[] {
  const parts = [skill.package.instructions];
  if (skill.package.review) parts.push(skill.package.review);
  const files = [...skill.extraFiles, ...Object.values(skill.package.files).flat()];
  for (const f of files) parts.push(decoder.decode(f.content));
  return parts;
}

export function applyConnector(
  connector: SourceConnector,
  skills: readonly NormalizedSkill[],
): { mapped: ConnectedSkill[]; unmapped: Unmapped[]; absent: string[] } {
  for (const s of skills) {
    if (s.provenance.repositoryKey !== connector.repositoryKey) throw new TypeError("the skill does not come from the repository of this connector");
  }
  const unmapped: Unmapped[] = [];
  const note = (s: NormalizedSkill, reason: Unmapped["reason"]) =>
    unmapped.push({ root: shownValue(s.provenance.root), name: shownValue(s.provenance.name), reason });
  let live: { skill: NormalizedSkill; rule: ConnectorSkillRule }[] = [];
  for (const s of skills) {
    const name = s.provenance.name;
    if (!Object.hasOwn(connector.skills, name)) note(s, "not-in-profile");
    else live.push({ skill: s, rule: connector.skills[name]! });
  }
  for (;;) {
    const names = new Set(live.map((l) => l.skill.provenance.name));
    const keep = live.filter((l) => l.rule.companions.every((c) => names.has(c)));
    if (keep.length === live.length) break;
    for (const l of live) if (!keep.includes(l)) note(l.skill, "companion-missing");
    live = keep;
  }
  const guards = connector.guard.phrases.map((p) => ({ p, re: guardRegex(p) }));
  const mapped: ConnectedSkill[] = live.map(({ skill, rule }) => {
    const { package: pkg, provenance } = skill;
    const text = textOf(skill);
    const guarded = sortedUnique(guards.filter((g) => text.some((t) => g.re.test(t))).map((g) => g.p));
    const evaluations = sortedUnique([...rule.evaluations, ...(guarded.length ? connector.guard.evaluations : [])]);
    const highRisk = evaluations.length > 0;
    const technologies: Tech[] = [
      { name: connector.technology, ...(rule.orm !== undefined ? { version: rule.orm } : {}) },
      { name: connector.runtime, ...(rule.runtime !== undefined ? { version: rule.runtime } : {}) },
      ...rule.engines.map((e) => ({ name: e })),
    ].sort((a, b) => byteCmp(a.name, b.name));
    const record: ConnectorRecord = {
      schema: 1,
      connector: connector.id,
      profile: connector.profile,
      id: pkg.id,
      name: provenance.name,
      digest: pkg.digest,
      reviewed: connector.reviewed.includes(provenance.commit),
      specific: sortedUnique(rule.specific),
      general: sortedUnique(rule.general),
      ...(rule.orm !== undefined ? { orm: rule.orm } : {}),
      engines: sortedUnique(rule.engines),
      ...(rule.runtime !== undefined ? { runtime: rule.runtime } : {}),
      requirements: sortedUnique(rule.requirements),
      evaluations,
      guarded,
      highRisk,
      original: {
        capabilities: [...(pkg.capabilities ?? [])],
        category: pkg.category,
        risk: pkg.risk,
        technologies: provenance.technologies.map((t) => ({ ...t })),
      },
    };
    return {
      skill: {
        ...skill,
        package: { ...pkg, category: connector.category, capabilities: sortedUnique([...rule.specific, ...rule.general]), risk: highRisk ? "high" : pkg.risk },
        provenance: { ...provenance, technologies },
      },
      record,
    };
  });
  mapped.sort((a, b) => byteCmp(a.skill.package.id, b.skill.package.id));
  unmapped.sort((a, b) => byteCmp(a.root, b.root));
  const named = new Set(skills.map((s) => s.provenance.name));
  const absent = Object.keys(connector.skills).filter((n) => !named.has(n)).sort(byteCmp);
  return { mapped, unmapped, absent };
}

const FULL_RE = /^[v=]*(\d{1,15}\.\d{1,15}\.\d{1,15}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,63})?)$/;
const CARET_RE = /^\^v?(\d{1,15})(?:\.(?:\d{1,15}|[xX])){0,2}$/;
const TILDE_RE = /^~v?(\d{1,15})(?:\.(\d{1,15}))?(?:\.(?:\d{1,15}|[xX]))?$/;
const PARTIAL_RE = /^[v=]*(\d{1,15})(?:\.(\d{1,15}|[xX]))?(?:\.[xX])?$/;

/** One dependency value as evidence, never wider than the range allows. Anything not bounded gives UNKNOWN_VERSION. */
export function declaredVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const v = value.trim();
  const full = FULL_RE.exec(v);
  if (full) return full[1]!;
  const caret = CARET_RE.exec(v);
  if (caret) return Number(caret[1]) >= 1 ? caret[1]! : UNKNOWN_VERSION;
  const tilde = TILDE_RE.exec(v);
  if (tilde) return tilde[2] !== undefined ? `${tilde[1]}.${tilde[2]}` : tilde[1]!;
  const part = PARTIAL_RE.exec(v);
  if (part) return part[2] !== undefined && !/^[xX]$/.test(part[2]) ? `${part[1]}.${part[2]}` : part[1]!;
  return UNKNOWN_VERSION;
}

export function connectorEvidence(connector: SourceConnector, profile: Pick<RepoProfile, "findings">): Tech[] {
  const deps = profile.findings.filter((f) => f.kind === "dependency");
  const out = new Map<string, Tech>();
  const orm = deps.filter((d) => connector.evidence.orm.includes(d.name));
  if (orm.length) {
    const versions = sortedUnique(orm.map((d) => declaredVersion(d.value)).filter((v): v is string => v !== undefined));
    const version = versions.length === 0 ? undefined : versions.length === 1 ? versions[0] : UNKNOWN_VERSION;
    out.set(connector.technology, { name: connector.technology, ...(version !== undefined ? { version } : {}) });
  }
  for (const d of deps) {
    if (Object.hasOwn(connector.evidence.engines, d.name)) {
      const e = connector.evidence.engines[d.name]!;
      out.set(e, { name: e });
    }
  }
  const node = deps.find((d) => d.name === connector.runtime);
  if (node) {
    const version = declaredVersion(node.value);
    out.set(connector.runtime, { name: connector.runtime, ...(version !== undefined ? { version } : {}) });
  }
  return [...out.values()].sort((a, b) => byteCmp(a.name, b.name));
}

export function connectorCompatibility(connector: SourceConnector, record: ConnectorRecord, evidence?: readonly Tech[]): CanonicalCandidate["compatibility"] {
  if (!evidence) return record.highRisk ? "unchecked" : "generic";
  const base = technologyCompatibility([{ name: connector.technology, ...(record.orm !== undefined ? { version: record.orm } : {}) }], evidence);
  if (base === "incompatible") return base;
  let unchecked = false;
  const orm = evidence.find((e) => e.name === connector.technology);
  if (record.orm !== undefined && orm && orm.version === undefined) unchecked = true;

  const seen = evidence.filter((e) => connector.engines.includes(e.name)).map((e) => e.name);
  if (record.engines.length && seen.length && !seen.some((e) => record.engines.includes(e))) return "incompatible";
  if (!seen.length && record.highRisk) unchecked = true;

  if (record.runtime !== undefined) {
    const rt = evidence.find((e) => e.name === connector.runtime);
    if (!rt || rt.version === undefined) unchecked = true;
    else {
      const r = technologyCompatibility([{ name: connector.runtime, version: record.runtime }], [rt]);
      if (r === "incompatible") return r;
      if (r === "unchecked") unchecked = true;
    }
  }
  return unchecked || base === "unchecked" ? "unchecked" : base;
}

export function evaluationState(
  record: Pick<ConnectorRecord, "id" | "digest" | "evaluations">,
  results: readonly EvaluationResult[],
): { state: "not-required" | "passed" | "failed" | "missing"; missing: string[]; failed: string[] } {
  if (!record.evaluations.length) return { state: "not-required", missing: [], failed: [] };
  const mine = results.filter((r) => r.skill === record.id && r.digest === record.digest && record.evaluations.includes(r.evaluation));
  const failed = record.evaluations.filter((e) => mine.some((r) => r.evaluation === e && r.result === "failed"));
  const missing = record.evaluations.filter((e) => !mine.some((r) => r.evaluation === e && r.result === "passed"));
  if (failed.length) return { state: "failed", missing, failed };
  if (missing.length) return { state: "missing", missing, failed };
  return { state: "passed", missing, failed };
}

export function connectorCandidate(input: {
  connector: SourceConnector;
  connected: ConnectedSkill;
  source: SkillLibrarySource;
  licence: LicenceStatus;
  scanClean: boolean;
  results: readonly EvaluationResult[];
  evidence?: readonly Tech[];
  tools?: ToolPolicy;
  approvedAt?: string;
}): CanonicalCandidate {
  const { connector, connected, source, licence, scanClean, results, evidence, tools, approvedAt } = input;
  const st = evaluationState(connected.record, results);
  const c = collisionCandidate(connected.skill, source, st.state === "passed" || st.state === "failed" ? { evaluation: st.state } : {});
  const safety = scanClean && connected.record.reviewed && (st.state === "passed" || st.state === "not-required");
  return {
    ...canonicalFromCollision(c, {
      licence,
      sourceStatus: source.status,
      safety,
      ...(tools !== undefined ? { tools } : {}),
      ...(approvedAt !== undefined ? { approvedAt } : {}),
    }),
    compatibility: connectorCompatibility(connector, connected.record, evidence),
  };
}

/**
 * The `canonical` dependency of runSkillCatalogue for the mapped skills of one connector. A skill that fails its safety gate is
 * withheld whatever capabilities it offers, so guidance that is not an exclusive capability cannot stay offered without its evaluations.
 */
export function connectorCanonical(input: Omit<Parameters<typeof connectorCandidate>[0], "connected"> & { mapped: readonly ConnectedSkill[] }): {
  policy: Pick<CanonicalPolicy, "exclusive" | "highRisk">;
  candidate: (skill: { id: string }) => CanonicalCandidate | undefined;
  withhold: (candidate: CanonicalCandidate) => boolean;
} {
  const { mapped, ...rest } = input;
  const byId = new Map(mapped.map((m) => [m.skill.package.id, m]));
  return {
    policy: connectorPolicy(input.connector),
    candidate: (skill) => {
      const connected = byId.get(skill.id);
      return connected ? connectorCandidate({ ...rest, connected }) : undefined;
    },
    withhold: (c) => c.failed.includes("safety"),
  };
}

export function connectorPolicy(connector: SourceConnector): Pick<CanonicalPolicy, "exclusive" | "highRisk"> {
  return { exclusive: [...connector.exclusive], highRisk: [...connector.highRisk] };
}
