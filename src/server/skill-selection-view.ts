import type { RunSummary } from "../engine/state.js";
import { CANONICAL_LEVELS, CANONICAL_REJECT_CODES, type CanonicalLevel } from "../skills/canonical-rules.js";
import { catalogueDescriptionProblem } from "../skills/catalogue-description.js";
import { CHOICE_LEVELS } from "../skills/choice-rules.js";
import { parseSkillKey } from "../skills/lock.js";
import { SkillIdSchema } from "../skills/schema.js";
import { OWNER_RE } from "../skills/sources.js";

// Why the skills of a run were chosen, for the run page. Built only from the compact records the run already keeps
// (the last catalogue record of a step and `summary.skillSelection`): ids, versions, codes and choice metadata.
// Nothing of the catalogue entries is copied, so skills that played no part never appear. Never throws; every
// field is checked by type and a bad entry is dropped.

export const SELECTION_VIEW_LIMITS = { capabilities: 20, mirrorGroups: 20, rejected: 5, choices: 20, companions: 20, descriptions: 20 } as const;
export type DecidedBy = CanonicalLevel | "only-candidate";
export interface CapabilityChoiceView {
  capability: string;
  outcome: "selected" | "conflict" | "none";
  /** id@version */
  winner?: string;
  decidedBy?: DecidedBy;
  companions?: string[];
  rejected: { skill: string; code: (typeof CANONICAL_REJECT_CODES)[number]; level?: CanonicalLevel }[];
  /** Rejected skills that are not listed. */
  more?: number;
}
export interface MirrorGroupView { kept: string; collapsed: string[] }
export interface ChoiceView {
  level: (typeof CHOICE_LEVELS)[number];
  capability: string;
  target: string;
  effect: "selected" | "superseded";
  reviewDue?: true;
  /** Administrator only. */
  by?: string;
  /** Administrator only. */
  digest?: string;
}
/** A catalogue description the agent saw instead of the package's own, with where it came from. */
export interface DescriptionView { skill: string; text: string; from: "skill-selections"; release: string }
export interface SkillSelectionView {
  capabilities: CapabilityChoiceView[];
  mirrors: MirrorGroupView[];
  choices: ChoiceView[];
  descriptions?: DescriptionView[];
  /** Totals before the caps, plus what the record itself left out. */
  counts: { capabilities: number; mirrorGroups: number; collapsed: number; choices: number; descriptions?: number };
  /** Administrator only. */
  choicesSource?: { pins: { commit: string; blob: string } };
}
export interface SelectionViewOptions {
  admin: boolean;
  /** Plan hash of the lock that is shown; the lock-time decisions are used when they belong to it. */
  lockPlanHash?: string;
  /** false: the run planned again after it locked, so the catalogue record is not the one behind the lock. Default true. */
  catalogueCurrent?: boolean;
}

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);
const slug = (v: unknown): string | undefined => (typeof v === "string" && SkillIdSchema.safeParse(v).success ? v : undefined);
const keyOf = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 200 && parseSkillKey(v) !== undefined ? v : undefined);
const count = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1e9 ? v : 0);
const gitId = (v: unknown): string | undefined => (typeof v === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v) ? v : undefined);

function capabilityOf(x: unknown): CapabilityChoiceView | undefined {
  const o = obj(x);
  const capability = slug(o?.capability);
  const outcome = oneOf(o?.outcome, ["selected", "conflict", "none"] as const);
  if (!o || !capability || !outcome) return undefined;
  const winner = keyOf(o.winner);
  const decidedBy = oneOf(o.decidedBy, [...CANONICAL_LEVELS, "only-candidate"] as const);
  const companions = list(o.companions).flatMap((c) => keyOf(c) ?? []).slice(0, SELECTION_VIEW_LIMITS.companions);
  const valid = list(o.rejected).flatMap((r) => {
    const e = obj(r);
    const skill = keyOf(e?.skill);
    const code = oneOf(e?.code, CANONICAL_REJECT_CODES);
    const level = oneOf(e?.level, CANONICAL_LEVELS);
    return e && skill && code ? [{ skill, code, ...(level ? { level } : {}) }] : [];
  });
  const more = count(o.rejectedOmitted) + Math.max(0, valid.length - SELECTION_VIEW_LIMITS.rejected);
  if (!winner && !companions.length && !valid.length && outcome !== "conflict") return undefined;
  return {
    capability, outcome,
    ...(winner ? { winner } : {}), ...(winner && decidedBy ? { decidedBy } : {}),
    ...(companions.length ? { companions } : {}),
    rejected: valid.slice(0, SELECTION_VIEW_LIMITS.rejected),
    ...(more > 0 ? { more } : {}),
  };
}

/** The lock-time decision tells what was loaded; the catalogue decision of the same winner keeps the reasons that were later hidden by it. */
function merge(lock: CapabilityChoiceView[] | undefined, cat: CapabilityChoiceView[]): CapabilityChoiceView[] {
  if (!lock) return cat;
  const byCap = new Map(cat.map((c) => [c.capability, c] as const));
  const out = lock.map((l) => {
    const c = byCap.get(l.capability);
    byCap.delete(l.capability);
    if (!c || c.winner !== l.winner) return l;
    // The lock decides what was loaded, so its companions are final, also when it has none.
    const { companions: _offered, ...reasons } = c;
    return { ...reasons, ...(l.companions ? { companions: l.companions } : {}) };
  });
  return [...out, ...byCap.values()];
}

/** What explains the skills of a run; undefined when there is nothing to explain. Never throws. */
export function skillSelectionView(s: Pick<RunSummary, "history" | "skillSelection">, opts: SelectionViewOptions): SkillSelectionView | undefined {
  try {
    return build(s, opts);
  } catch {
    return undefined;
  }
}

function build(s: Pick<RunSummary, "history" | "skillSelection">, opts: SelectionViewOptions): SkillSelectionView | undefined {
  const current = opts.catalogueCurrent !== false;
  // The last step of the run itself (not of a sub-flow) that recorded a catalogue.
  let cat: Record<string, unknown> | undefined;
  if (current) {
    const history = Array.isArray(s.history) ? (s.history as unknown[]) : [];
    for (let i = history.length - 1; i >= 0 && !cat; i--) {
      const step = obj(history[i]);
      if (step && !step.parent) cat = obj(step.skillCatalogue);
    }
  }
  const sel = obj(s.skillSelection);
  const locked = sel && Array.isArray(sel.canonical) && typeof sel.planHash === "string" && (opts.lockPlanHash === undefined || sel.planHash === opts.lockPlanHash);
  const fromLock = locked ? list(sel.canonical).flatMap((x) => capabilityOf(x) ?? []) : undefined;
  const fromCat = cat ? list(cat.canonical).flatMap((x) => capabilityOf(x) ?? []) : [];
  const allCaps = merge(fromLock, fromCat);

  const groups = list(cat?.mirrors).flatMap((x): MirrorGroupView[] => {
    const o = obj(x);
    const kept = keyOf(o?.kept);
    const collapsed = list(o?.collapsed).flatMap((c) => keyOf(c) ?? []);
    return o && kept && collapsed.length ? [{ kept, collapsed }] : [];
  });
  const choices = list(cat?.choices).flatMap((x): ChoiceView[] => {
    const o = obj(x);
    const level = oneOf(o?.level, CHOICE_LEVELS);
    const capability = slug(o?.capability);
    const target = keyOf(o?.target);
    const effect = oneOf(o?.effect, ["selected", "superseded"] as const);
    if (!o || !level || !capability || !target || !effect) return [];
    const by = typeof o.by === "string" && OWNER_RE.test(o.by) ? o.by : undefined;
    const digest = typeof o.digest === "string" && /^sha256:[0-9a-f]{64}$/.test(o.digest) ? o.digest : undefined;
    return [{
      level, capability, target, effect, ...(o.reviewDue === true ? { reviewDue: true as const } : {}),
      ...(opts.admin && by ? { by } : {}), ...(opts.admin && digest ? { digest } : {}),
    }];
  });
  const descriptions = list(cat?.descriptions).flatMap((x): DescriptionView[] => {
    const o = obj(x);
    const skill = keyOf(o?.skill);
    const release = keyOf(o?.release);
    const from = oneOf(o?.from, ["skill-selections"] as const);
    const text = o?.text;
    if (!o || !skill || !release || !from || typeof text !== "string" || catalogueDescriptionProblem(text) !== undefined) return [];
    return [{ skill, text, from, release }];
  });
  const pins = obj(obj(cat?.choicesSource)?.pins);
  const commit = gitId(pins?.commit);
  const blob = gitId(pins?.blob);

  const collapsed = groups.reduce((n, g) => n + g.collapsed.length, 0) + count(cat?.mirrorsOmitted);
  if (!allCaps.length && !groups.length && !choices.length && collapsed === 0 && !descriptions.length) return undefined;
  const L = SELECTION_VIEW_LIMITS;
  return {
    capabilities: allCaps.slice(0, L.capabilities),
    mirrors: groups.slice(0, L.mirrorGroups),
    choices: choices.slice(0, L.choices),
    ...(descriptions.length ? { descriptions: descriptions.slice(0, L.descriptions) } : {}),
    counts: {
      capabilities: allCaps.length, mirrorGroups: groups.length, collapsed, choices: choices.length + count(cat?.choicesOmitted),
      ...(descriptions.length ? { descriptions: descriptions.length + count(cat?.descriptionsOmitted) } : {}),
    },
    ...(opts.admin && commit && blob ? { choicesSource: { pins: { commit, blob } } } : {}),
  };
}
