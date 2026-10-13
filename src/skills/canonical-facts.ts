import type { CanonicalCandidate } from "./canonical.js";
import { CANONICAL_REGISTRY_TIER, CANONICAL_SOURCE_TIER, type CanonicalTier } from "./canonical-rules.js";
import type { CollisionCandidate } from "./collisions.js";
import type { LicenceStatus } from "./licence.js";
import type { RegisteredSkill } from "./registry.js";
import { compareSkillVersions, type ToolPolicy } from "./schema.js";
import type { SourceStatus } from "./sources.js";
import { policyAllows, skillNeeds } from "./tool-policy.js";

// The facts the canonical selector ranks on, built from what the registry and the importer know. Pure: no file system, no process, no clock.

type Tech = { name: string; version?: string };
type Compat = CanonicalCandidate["compatibility"];
type Gate = CanonicalCandidate["failed"][number];

const PART = "(\\d{1,15}|x|X|\\*)";
const VERSION_RE = new RegExp(`^v?${PART}(?:\\.${PART})?(?:\\.${PART})?(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,63}))?$`);
const TOKEN_RE = /^(>=|<=|>|<|=|\^|~)?(.+)$/;
const MAX_TOKENS = 64;

interface Partial3 { n: number; parts: number[]; pre?: string }
type Core = [number, number, number];

function parsePartial(text: string): Partial3 | undefined {
  const m = VERSION_RE.exec(text);
  if (!m) return undefined;
  const parts: number[] = [];
  for (let i = 1; i <= 3; i++) {
    const p = m[i];
    if (p === undefined || /^[xX*]$/.test(p)) break;
    parts.push(Number(p));
  }
  const pre = m[4];
  // A prerelease tag only makes sense on a full version.
  if (pre !== undefined && parts.length < 3) return undefined;
  return { n: parts.length, parts, ...(pre !== undefined ? { pre } : {}) };
}
const pad = (p: readonly number[]): Core => [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
const str = (c: Core, pre?: string) => `${c[0]}.${c[1]}.${c[2]}${pre ? `-${pre}` : ""}`;
const bump = (p: readonly number[], i: number): Core => {
  const c = pad(p);
  c[i] = c[i]! + 1;
  for (let j = i + 1; j < 3; j++) c[j] = 0;
  return c;
};
const coreOf = (v: string): Core => {
  const [a, b, c] = (v.split("-")[0] ?? "").split(".").map(Number);
  return [a!, b!, c!];
};

/** version < U, and no prerelease of U itself. */
const below = (v: string, u: Core): boolean => {
  const same = v.includes("-") && coreOf(v).every((x, i) => x === u[i]);
  return compareSkillVersions(v, str(u)) < 0 && !same;
};
const atLeast = (v: string, c: Core, pre?: string): boolean => compareSkillVersions(v, str(c, pre)) >= 0;

type Test = (v: string) => boolean;
function comparator(token: string): Test | undefined {
  const m = TOKEN_RE.exec(token);
  if (!m) return undefined;
  const op = m[1] ?? "";
  const p = parsePartial(m[2]!);
  if (!p) return undefined;
  const any: Test = () => true;
  const lowFrom = (): Core => pad(p.parts);
  switch (op) {
    case "":
    case "=":
      if (p.n === 0) return any;
      if (p.pre !== undefined) return (v) => compareSkillVersions(v, str(lowFrom(), p.pre)) === 0;
      return (v) => atLeast(v, lowFrom()) && below(v, bump(p.parts, p.n - 1));
    case ">=":
      return p.n === 0 ? any : (v) => atLeast(v, lowFrom(), p.pre);
    case ">":
      if (p.n === 0) return () => false;
      if (p.n < 3) return (v) => atLeast(v, bump(p.parts, p.n - 1));
      return (v) => compareSkillVersions(v, str(lowFrom(), p.pre)) > 0;
    case "<=":
      if (p.n === 0) return any;
      if (p.n < 3) return (v) => below(v, bump(p.parts, p.n - 1));
      return (v) => compareSkillVersions(v, str(lowFrom(), p.pre)) <= 0;
    case "<":
      if (p.n === 0) return () => false;
      if (p.pre !== undefined) return (v) => compareSkillVersions(v, str(lowFrom(), p.pre)) < 0;
      return (v) => below(v, lowFrom());
    case "^": {
      if (p.n === 0) return any;
      let i = p.parts.findIndex((x) => x !== 0);
      if (i < 0) i = p.n - 1;
      return (v) => atLeast(v, lowFrom(), p.pre) && below(v, bump(p.parts, i));
    }
    default: {
      if (p.n === 0) return any;
      return (v) => atLeast(v, lowFrom(), p.pre) && below(v, bump(p.parts, p.n === 1 ? 0 : 1));
    }
  }
}

/** Does `version` satisfy `range`? undefined: the range or the version cannot be read. */
export function rangeSatisfied(range: string, version: string): boolean | undefined {
  const pv = parsePartial(version);
  if (!pv || pv.n !== 3) return undefined;
  const v = str(pad(pv.parts), pv.pre);
  const alternatives = range.split("||").map((a) => a.trim().split(/\s+/).filter(Boolean));
  if (alternatives.some((a) => !a.length) || alternatives.reduce((n, a) => n + a.length, 0) > MAX_TOKENS) return undefined;
  let ok = false;
  for (const alt of alternatives) {
    const tests = alt.map(comparator);
    if (tests.some((t) => !t)) return undefined;
    if (tests.every((t) => t!(v))) ok = true;
  }
  return ok;
}

/** How well the technologies a skill declares fit the project evidence. */
export function technologyCompatibility(declared: readonly Tech[], evidence?: readonly Tech[]): Compat {
  if (!evidence || !declared.length) return "generic";
  let misses = 0;
  let unchecked = false;
  let version = false;
  for (const d of declared) {
    const seen = evidence.find((e) => e.name === d.name);
    if (!seen) { misses++; continue; }
    if (d.version === undefined || seen.version === undefined) continue;
    const parsed = parsePartial(seen.version);
    // A version that was given but cannot be read cannot be checked safely.
    if (!parsed || parsed.n === 0) { unchecked = true; continue; }
    let r: boolean | undefined;
    if (parsed.n === 3) r = rangeSatisfied(d.version, seen.version);
    else {
      // A partial project version (17, 17.1) stands for every version it covers: the range has to agree for the lowest and the highest.
      const fill = (n: number) => [...parsed.parts, n, n].slice(0, 3).join(".");
      const lo = rangeSatisfied(d.version, fill(0));
      const hi = rangeSatisfied(d.version, fill(999999));
      r = lo === undefined || hi === undefined ? undefined : lo === hi ? lo : undefined;
    }
    if (r === undefined) unchecked = true;
    else if (!r) return "incompatible";
    else version = true;
  }
  if (misses === declared.length) return "incompatible";
  if (unchecked) return "unchecked";
  return version ? "version" : "name";
}

const failedGates = (g: Record<Gate, boolean>): Gate[] => (["safety", "licence", "tools"] as const).filter((k) => g[k]);

export function canonicalFromCollision(
  c: CollisionCandidate,
  facts: { licence: LicenceStatus; sourceStatus?: SourceStatus; safety?: boolean; tools?: ToolPolicy; approvedAt?: string; evidence?: readonly Tech[] },
): CanonicalCandidate {
  const { package: pkg, provenance, identity } = c.skill;
  const status: CanonicalCandidate["status"] =
    facts.sourceStatus === "quarantined" ? "quarantined"
    : facts.sourceStatus === "retired" || facts.sourceStatus === "disabled" ? "revoked"
    : c.approved ? "approved" : "discovery";
  const tier: CanonicalTier = c.approved ? CANONICAL_SOURCE_TIER[c.trust] : "discovery-only";
  const tools = facts.tools;
  const toolsFail = tools !== undefined && skillNeeds(pkg).some((n) => n.startsWith("connector:") || !policyAllows(n as "shell" | "network" | "write", tools));
  return {
    id: identity.id,
    version: identity.version,
    fingerprint: identity.fingerprint,
    capabilities: [...(pkg.capabilities ?? [])],
    category: pkg.category,
    risk: pkg.risk,
    tier,
    status,
    failed: failedGates({ safety: facts.safety === false, licence: facts.licence !== "allowed", tools: toolsFail }),
    compatibility: technologyCompatibility(provenance.technologies, facts.evidence),
    ...(c.evaluation !== undefined ? { evaluation: c.evaluation } : {}),
    ...(facts.approvedAt !== undefined ? { approvedAt: facts.approvedAt } : {}),
  };
}

export function canonicalFromRegistered(
  s: RegisteredSkill,
  facts: { licence?: LicenceStatus; safety?: boolean; tools?: ToolPolicy; approvedAt?: string; evaluation?: "passed" | "failed"; technologies?: readonly Tech[]; evidence?: readonly Tech[] } = {},
): CanonicalCandidate {
  const tools = facts.tools;
  const toolsFail = tools !== undefined && skillNeeds(s.pkg).some((n) => n.startsWith("connector:") || !policyAllows(n as "shell" | "network" | "write", tools));
  return {
    id: s.id,
    version: s.version,
    fingerprint: s.digest,
    capabilities: [...(s.pkg.capabilities ?? [])],
    category: s.pkg.category,
    risk: s.pkg.risk,
    tier: CANONICAL_REGISTRY_TIER[s.source],
    status: s.trust === "unapproved" ? "discovery" : "approved",
    failed: failedGates({ safety: facts.safety === false, licence: facts.licence !== undefined && facts.licence !== "allowed", tools: toolsFail }),
    compatibility: technologyCompatibility(facts.technologies ?? [], facts.evidence),
    ...(facts.evaluation !== undefined ? { evaluation: facts.evaluation } : {}),
    ...(facts.approvedAt !== undefined ? { approvedAt: facts.approvedAt } : {}),
  };
}
