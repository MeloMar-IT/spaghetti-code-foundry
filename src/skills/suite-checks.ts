import { technologyCompatibility } from "./canonical-facts.js";
import { byteCmp } from "./import-plan.js";
import type { NormalizedSkill } from "./normalize.js";
import { supportStatus, technologyName } from "./project-technologies.js";
import { SKILL_ID_RE, type SkillProvider } from "./schema.js";
import { applySourceScope } from "./source-evaluation.js";
import { profileSkill, vendorCapability } from "./source-profile.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";
import {
  EXACTLY_ONCE, MESSAGING_CLAIMS, MESSAGING_CODES, SUITE_CAPABILITY_PREFIXES, SUITE_LIMITS, SUITE_PROVIDERS, SUITES,
  type CompatibilityCode, type MessagingCode, type SuiteCode, type SuiteName, type SuiteRecord,
} from "./suite-rules.js";

// The checks behind the evaluation gate of `scf skills promote check`: which suites a skill needs, the messaging-semantics text
// rules, the compatibility check and the verdict lines. Pure: no file system, no process, no clock; no input is changed.
// Only codes, slugs, digests and `path:line` are returned: no upstream text. It must not import selections.js (the CLI reads that
// file), so a selection is described by a structural type.

export interface SelectionLike {
  source: string;
  skill: string;
  digest: string;
  scope: "portable" | "provider";
  provider?: string;
  product?: { name: string; version: string };
  capabilities: readonly string[];
}
export interface EffectiveSkill {
  /** The skill with profile or selection applied; absent when it cannot be applied. */
  skill?: NormalizedSkill;
  /** Catalogue capabilities. */
  portable: string[];
  /** Capabilities scoped to `provider`. */
  vendor: string[];
  /** The provider that owns the vendor capabilities. */
  provider?: string;
  /** A reviewed selection supplied the capabilities. */
  selected: boolean;
}
type Versioned = { name: string; version: string };

const sorted = (a: Iterable<string>): string[] => [...new Set(a)].sort(byteCmp);

/**
 * The skill as the catalogue sees it: the source profile applied, and, for a skill that declares no capabilities, the capabilities
 * of a reviewed selection with the same source, name and digest. Never changes its input.
 */
export function effectiveSkill(skill: NormalizedSkill, source: SkillLibrarySource, selections: readonly SelectionLike[]): EffectiveSkill {
  const profile = source.profile;
  const caps = skill.package.capabilities ?? [];
  const sel = caps.length === 0
    ? selections.find((s) => s.source === source.id && s.skill === skill.provenance.name && s.digest === skill.package.digest)
    : undefined;
  if (!sel) {
    const portable = new Set<string>();
    const vendor = new Set<string>();
    if (profile) {
      const map = new Map(profile.portable.map((p) => [p.upstream, p.capability] as const));
      for (const c of caps) {
        const mapped = map.get(c);
        if (mapped !== undefined) portable.add(mapped);
        else vendor.add(vendorCapability(profile.provider, c));
      }
    }
    const r = profileSkill(skill, source);
    return {
      ...(r.skill ? { skill: r.skill } : {}),
      portable: sorted(portable), vendor: sorted(vendor), ...(profile && vendor.size ? { provider: profile.provider } : {}), selected: false,
    };
  }

  if (sel.scope === "portable") {
    const capabilities = sorted(sel.capabilities);
    return { skill: { ...skill, package: { ...skill.package, capabilities } }, portable: capabilities, vendor: [], selected: true };
  }
  const provider = sel.provider;
  const have = skill.package.provider;
  const vendor = sorted(provider === undefined ? [] : sel.capabilities.map((c) => vendorCapability(provider, c)));
  const fail: EffectiveSkill = { portable: [], vendor, ...(provider !== undefined ? { provider } : {}), selected: true };
  if (provider === undefined || !vendor.every((c) => SKILL_ID_RE.test(c))) return fail;
  if ((profile && profile.provider !== provider) || (have && have.name !== provider)) return fail;
  const products = new Map<string, { name: string; version?: string }>();
  for (const p of have && have.products.length ? have.products : (profile?.products ?? [])) products.set(p.name, { ...p });
  if (sel.product) products.set(sel.product.name, { name: sel.product.name, version: sel.product.version });
  const merged: SkillProvider = {
    name: provider,
    products: [...products.values()].sort((a, b) => byteCmp(a.name, b.name)),
    tools: have ? [...have.tools] : [],
  };
  return { skill: { ...skill, package: { ...skill.package, capabilities: vendor, provider: merged } }, portable: [], vendor, provider, selected: true };
}

/** The technology versions a skill declares: its own first, then the source scope, then the provider products. Sorted by name. */
export function declaredVersions(skill: NormalizedSkill, source: Pick<SkillLibrarySource, "scope">): Versioned[] {
  const out = new Map<string, string>();
  const add = (name: string, version: string | undefined) => {
    if (version !== undefined && !out.has(name)) out.set(name, version);
  };
  for (const t of skill.provenance.technologies) add(t.name, t.version);
  for (const t of source.scope?.technologies ?? []) add(t.name, t.version);
  for (const p of skill.package.provider?.products ?? []) add(p.name, p.version);
  return [...out].map(([name, version]) => ({ name, version })).sort((a, b) => byteCmp(a.name, b.name));
}

/** Which suites a skill has to pass; both, or none. A profile or scope that cannot be applied needs both. */
export function requiredSuites(
  skill: NormalizedSkill,
  source: SkillLibrarySource,
  selections: readonly SelectionLike[],
): { suites: SuiteName[]; profileFailed: boolean } {
  const both = (profileFailed: boolean) => ({ suites: [...SUITES] as SuiteName[], profileFailed });
  const e = effectiveSkill(skill, source, selections);
  if (!e.skill) return both(true);
  const scoped = applySourceScope(e.skill, source);
  if (!scoped.ok) return both(true);
  const caps = scoped.skill.package.capabilities ?? [];
  if (caps.some((c) => SUITE_CAPABILITY_PREFIXES.some((p) => c.startsWith(p)))) return both(false);
  if (caps.length === 0 && source.profile !== undefined && (SUITE_PROVIDERS as readonly string[]).includes(source.profile.provider)) return both(false);
  return { suites: [], profileFailed: false };
}

const LINE_SPLIT = /\r\n|\r|\n/;

/** Does this line claim more exactly-once than the repository's kafka skill allows? */
function exactlyOnceViolation(line: string): boolean {
  const rules = EXACTLY_ONCE;
  const claims = [...line.matchAll(rules.claim)];
  if (!claims.length || rules.enumeration.test(line)) return false;
  // A claim the line denies ("does not guarantee exactly-once") is no claim.
  const live = claims.filter((m) => !rules.negation.test(line.slice(Math.max(0, m.index - 60), m.index)));
  if (!live.length) return false;
  if (!rules.inside.test(line)) return true;
  if (!rules.client.every((re) => re.test(line)) && !rules.streams.every((re) => re.test(line))) return true;
  if (!rules.external.test(line)) return false;
  if (!rules.outside.test(line)) return true;
  // The line names an external effect: it must not say the guarantee covers it.
  return [...line.matchAll(rules.externalClaim)].some((m) => !rules.externalNegation.test(line.slice(Math.max(0, m.index - 40), m.index)));
}

/** The messaging-semantics rules over the text of a skill. Codes sorted; `at` is `path:line`, sorted, at most 10 and `+N more`. */
export function messagingSemantics(texts: readonly { path: string; text: string }[]): { codes: MessagingCode[]; at: string[] } {
  const codes = new Set<MessagingCode>();
  const at = new Set<string>();
  for (const { path, text } of texts) {
    const lines = text.split(LINE_SPLIT);
    lines.forEach((line, i) => {
      const hit: MessagingCode[] = [];
      if (exactlyOnceViolation(line)) hit.push("exactly-once");
      for (const r of MESSAGING_CLAIMS) if (r.claim.test(line) && !(r.unless && r.unless.test(line))) hit.push(r.code);
      if (!hit.length) return;
      for (const c of hit) codes.add(c);
      at.add(`${shownValue(path)}:${i + 1}`);
    });
  }
  const all = [...at].sort(byteCmp);
  const shown = all.slice(0, SUITE_LIMITS.at);
  if (all.length > shown.length) shown.push(`+${all.length - shown.length} more`);
  return { codes: MESSAGING_CODES.filter((c) => codes.has(c)), at: shown };
}

/** The compatibility suite: undefined when every declared version is backed by project evidence and fits it. */
export function compatibilitySuite(declared: readonly Versioned[], project: readonly Versioned[]): CompatibilityCode | undefined {
  if (!declared.length) return "no-declared-versions";
  if (supportStatus(declared) === "stale") return "stale";
  const c = technologyCompatibility(declared, project);
  if (c === "incompatible") return "incompatible";
  // technologyCompatibility passes on one matching technology; here every declared version needs evidence.
  const missing = declared.some((d) => !project.some((p) => technologyName(p.name) === technologyName(d.name)));
  return missing || c !== "version" ? "unchecked" : undefined;
}

export interface SuiteVerdict {
  suite: SuiteName;
  ok: boolean;
  codes: SuiteCode[];
  at: string[];
}

const order = (codes: Iterable<SuiteCode>): SuiteCode[] => [...new Set(codes)].sort(byteCmp);

/** One verdict per required suite, in SUITES order; [] when the skill needs none. */
export function suiteVerdicts(input: {
  source: SkillLibrarySource;
  skill: NormalizedSkill;
  selections: readonly SelectionLike[];
  records: readonly SuiteRecord[];
  texts: readonly { path: string; text: string }[];
}): SuiteVerdict[] {
  const { source, skill } = input;
  const required = requiredSuites(skill, source, input.selections);
  if (!required.suites.length) return [];
  const eff = effectiveSkill(skill, source, input.selections).skill;
  const messaging = required.profileFailed ? undefined : messagingSemantics(input.texts);
  return SUITES.filter((s) => required.suites.includes(s)).map((suite): SuiteVerdict => {
    if (required.profileFailed || !eff) return { suite, ok: false, codes: ["profile"], at: [] };
    const record = input.records.find((r) => r.source === source.id && r.skill === skill.provenance.name && r.suite === suite);
    const codes: SuiteCode[] = [];
    if (!record) codes.push("not-recorded");
    else {
      if (record.digest !== skill.package.digest) codes.push("other-digest");
      if (record.result === "failed") codes.push("recorded-failed");
    }
    let at: string[] = [];
    if (suite === "messaging-semantics") {
      codes.push(...messaging!.codes);
      at = messaging!.at;
    } else if (record) {
      const c = compatibilitySuite(declaredVersions(eff, source), record.project ?? []);
      if (c) codes.push(c);
    }
    const list = order(codes);
    return { suite, ok: list.length === 0, codes: list, at };
  });
}

/** `<suite>: <codes>; …` for the failed suites, or undefined when all passed. */
export function suiteRefusal(verdicts: readonly SuiteVerdict[]): string | undefined {
  const failed = verdicts.filter((v) => !v.ok);
  return failed.length ? failed.map((v) => `${v.suite}: ${v.codes.join(", ")}`).join("; ") : undefined;
}

export function suiteLines(sourceId: string, skill: NormalizedSkill, verdicts: readonly SuiteVerdict[]): string[] {
  const name = shownValue(skill.provenance.name);
  return verdicts.map(
    (v) => `EVALUATION ${sourceId}/${name} ${v.suite} ${skill.package.digest}: ${v.ok ? "passed" : v.codes.join(", ")}${v.at.length ? ` at ${v.at.join(", ")}` : ""}`,
  );
}
