import {
  CANONICAL_CONFLICTS, CANONICAL_GATES, CANONICAL_LEVELS, CANONICAL_LIMITS, CANONICAL_REJECT_CODES, CANONICAL_STATUSES, CANONICAL_STOP_PREFIX,
  CANONICAL_TIERS, CANONICAL_WEAK_LEVELS, type CanonicalLevel, type CanonicalTier,
} from "./canonical-rules.js";
import { COLLISION_LIMITS } from "./collision-rules.js";
import { byteCmp } from "./import-plan.js";
import { canonicalJson } from "./normalize-values.js";
import { isUtcTime } from "./release.js";
import { SKILL_ID_RE, SKILL_VERSION_RE, type SkillRisk } from "./schema.js";
import { hasTerm } from "./unresolved.js";

// Picks one canonical skill for every exclusive capability, the same way every time. Pure: no clock, file system or process, and the
// input is never changed. Only `runSkillCatalogue` can reach it, through its optional `canonical` dependency (none by default).

export interface CanonicalCandidate {
  id: string;
  version: string;
  /** Content fingerprint, or the package digest for a registry skill. */
  fingerprint: string;
  capabilities: readonly string[];
  category: string;
  risk: SkillRisk;
  tier: CanonicalTier;
  status: (typeof CANONICAL_STATUSES)[number];
  failed: readonly (typeof CANONICAL_GATES)[number][];
  compatibility: "incompatible" | "unchecked" | "generic" | "name" | "version";
  evaluation?: "passed" | "failed";
  /** UTC time of the approved release (isUtcTime). */
  approvedAt?: string;
  /** Exclusive capabilities this skill may be loaded with another provider for. A subset of `capabilities`. */
  composable?: readonly string[];
}
export interface CanonicalPolicy {
  exclusive: readonly string[];
  /** capability → skill id or id@version. */
  pins?: Readonly<Record<string, string>>;
  overrides?: Readonly<Record<string, string>>;
  highRisk: readonly string[];
  /** Ids of skills a run always loads (skills.selection.include). */
  mandatory?: readonly string[];
}
export interface CanonicalRef { id: string; version: string; fingerprint: string; tier: CanonicalTier }
export interface CanonicalRejection extends CanonicalRef {
  code: (typeof CANONICAL_REJECT_CODES)[number];
  /** outranked: the first level where the top candidate is ahead. */
  level?: CanonicalLevel;
  /** overlap: the capability it did not win. */
  via?: string;
  /** ambiguous-record: the names of the fields that differ, sorted. */
  differs?: string[];
}
export interface CanonicalResolution {
  capability: string;
  outcome: "selected" | "conflict" | "none";
  highRisk: boolean;
  winner?: CanonicalRef;
  /** Eligible providers loaded after the winner, in rank order. Empty without a winner. */
  companions: CanonicalRef[];
  decidedBy?: CanonicalLevel | "only-candidate";
  conflict?: (typeof CANONICAL_CONFLICTS)[number];
  /** In ranking order, then lexical. In a conflict it holds every provider. */
  rejected: CanonicalRejection[];
  ignored: { level: "project-pin" | "owner-override"; value: string; reason: "not-a-candidate" | "not-eligible" }[];
  /** conflict only. Built from validated ids, slugs and codes, never from free text. */
  message?: string;
}
export interface CanonicalResult {
  schema: 1;
  /** No conflict. */
  ok: boolean;
  /** One per exclusive capability, sorted. */
  resolutions: CanonicalResolution[];
  /** canonicalKey of the winners, sorted. */
  selected: string[];
  /** canonicalKey of companions that are not winners, sorted. */
  companions: string[];
  /** canonicalKey of every other provider of an exclusive capability, sorted. */
  left: string[];
}

type Code = (typeof CANONICAL_REJECT_CODES)[number];
type Conflict = (typeof CANONICAL_CONFLICTS)[number];

export const canonicalKey = (c: Pick<CanonicalCandidate, "id" | "version" | "fingerprint">): string => `${c.id}@${c.version} ${c.fingerprint}`;

interface Entry {
  key: string;
  c: CanonicalCandidate;
  caps: string[];
  code?: Code;
  differs?: string[];
}
interface Scored { e: Entry; s: number[] }

const sortedStrings = (a: readonly string[]) => [...a].sort(byteCmp);
const ref = (c: CanonicalCandidate): CanonicalRef => ({ id: c.id, version: c.version, fingerprint: c.fingerprint, tier: c.tier });
const tierIndex = (t: CanonicalTier) => CANONICAL_TIERS.indexOf(t);

function checkSlug(what: string, v: unknown): string {
  if (typeof v !== "string" || !SKILL_ID_RE.test(v)) throw new TypeError(`${what} is not a valid id`);
  return v;
}
function checkRef(what: string, v: unknown): string {
  if (typeof v !== "string") throw new TypeError(`${what} is not a valid skill id`);
  const at = v.indexOf("@");
  checkSlug(what, at < 0 ? v : v.slice(0, at));
  if (at >= 0 && !SKILL_VERSION_RE.test(v.slice(at + 1))) throw new TypeError(`${what} is not a valid skill id`);
  return v;
}
function checkCandidate(c: CanonicalCandidate): void {
  checkSlug("a candidate id", c.id);
  if (typeof c.version !== "string" || !SKILL_VERSION_RE.test(c.version)) throw new TypeError("a candidate version is not valid");
  if (typeof c.fingerprint !== "string" || !c.fingerprint) throw new TypeError("a candidate fingerprint is empty");
  for (const cap of c.capabilities) checkSlug("a capability", cap);
  if (!CANONICAL_TIERS.includes(c.tier)) throw new TypeError("a candidate tier is not known");
  if (!CANONICAL_STATUSES.includes(c.status)) throw new TypeError("a candidate status is not known");
  if (c.approvedAt !== undefined && !isUtcTime(c.approvedAt)) throw new TypeError("a candidate approval time is not a UTC time");
  for (const cap of c.composable ?? []) {
    checkSlug("a composable capability", cap);
    if (!c.capabilities.includes(cap)) throw new TypeError("a composable capability is not one of the capabilities");
  }
}

/** The record as it is compared: sorted lists, no empty fields. */
function recordOf(c: CanonicalCandidate): Record<string, unknown> {
  return {
    id: c.id, version: c.version, fingerprint: c.fingerprint, capabilities: sortedStrings(c.capabilities), category: c.category, risk: c.risk,
    tier: c.tier, status: c.status, failed: sortedStrings(c.failed), compatibility: c.compatibility,
    ...(c.evaluation !== undefined ? { evaluation: c.evaluation } : {}),
    ...(c.approvedAt !== undefined ? { approvedAt: c.approvedAt } : {}),
    ...(c.composable?.length ? { composable: sortedStrings(c.composable) } : {}),
  };
}

function collapse(candidates: readonly CanonicalCandidate[]): Entry[] {
  const groups = new Map<string, CanonicalCandidate[]>();
  for (const c of candidates) {
    const k = canonicalKey(c);
    const g = groups.get(k);
    if (g) g.push(c);
    else groups.set(k, [c]);
  }
  const out: Entry[] = [];
  for (const [key, g] of groups) {
    const recs = g.map((c) => ({ c, r: recordOf(c), j: "" })).map((x) => ({ ...x, j: canonicalJson(x.r) }));
    recs.sort((a, b) => byteCmp(a.j, b.j));
    const first = recs[0]!;
    if (recs.every((x) => x.j === first.j)) {
      out.push({ key, c: first.c, caps: sortedStrings(first.c.capabilities) });
      continue;
    }
    const names = new Set<string>();
    for (const name of Object.keys(first.r))
      if (recs.some((x) => canonicalJson(x.r[name] ?? null) !== canonicalJson(first.r[name] ?? null))) names.add(name);
    for (const x of recs) for (const name of Object.keys(x.r)) if (!(name in first.r)) names.add(name);
    const caps = sortedStrings([...new Set(recs.flatMap((x) => x.c.capabilities))]);
    const worst = recs.reduce((t, x) => (tierIndex(x.c.tier) > tierIndex(t) ? x.c.tier : t), first.c.tier);
    out.push({ key, c: { ...first.c, capabilities: caps, tier: worst }, caps, code: "ambiguous-record", differs: sortedStrings([...names]) });
  }
  return out.sort((a, b) => byteCmp(a.key, b.key));
}

function exclusion(e: Entry): Code | undefined {
  const c = e.c;
  if (e.code) return e.code;
  if (c.status === "revoked") return "revoked";
  if (c.status === "quarantined") return "quarantined";
  if (c.status === "discovery" || c.tier === "discovery-only") return "discovery-only";
  for (const g of CANONICAL_GATES) if (c.failed.includes(g)) return g;
  if (c.compatibility === "incompatible") return "incompatible";
  if (c.compatibility === "unchecked") return "compatibility-unchecked";
  return undefined;
}

const COMPAT_SCORE = { version: 2, name: 1, generic: 0, unchecked: 0, incompatible: 0 } as const;
const matches = (c: CanonicalCandidate, value: string | undefined) => value !== undefined && (value === c.id || value === `${c.id}@${c.version}`);

function score(e: Entry, cap: string, policy: CanonicalPolicy): Scored {
  const c = e.c;
  const fresh = c.approvedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(c.approvedAt);
  return {
    e,
    s: [
      matches(c, policy.pins?.[cap]) ? 1 : 0,
      matches(c, policy.overrides?.[cap]) ? 1 : 0,
      CANONICAL_TIERS.length - 1 - tierIndex(c.tier),
      COMPAT_SCORE[c.compatibility],
      c.evaluation === "passed" ? 2 : c.evaluation === "failed" ? 0 : 1,
      -c.capabilities.length,
      fresh,
    ],
  };
}
/** Index of the first level where a and b differ (7 is the lexical key, 8 is identical). */
function firstDiff(a: Scored, b: Scored): number {
  for (let i = 0; i < a.s.length; i++) if (a.s[i] !== b.s[i]) return i;
  return a.e.key === b.e.key ? CANONICAL_LEVELS.length : CANONICAL_LEVELS.length - 1;
}
function rank(a: Scored, b: Scored): number {
  const i = firstDiff(a, b);
  if (i < a.s.length) return a.s[i]! > b.s[i]! ? -1 : 1;
  return byteCmp(a.e.c.id, b.e.c.id) || byteCmp(a.e.c.version, b.e.c.version) || byteCmp(a.e.c.fingerprint, b.e.c.fingerprint);
}

function list(keys: readonly string[]): string {
  const shown = keys.slice(0, CANONICAL_LIMITS.messageKeys).join(", ");
  return keys.length > CANONICAL_LIMITS.messageKeys ? `${shown} and ${keys.length - CANONICAL_LIMITS.messageKeys} more` : shown;
}

interface Work {
  cap: string;
  providers: Entry[];
  eligible: Scored[];
  top?: Scored;
  tied: Scored[];
  decidedBy?: CanonicalLevel | "only-candidate";
  highRisk: boolean;
  ignored: CanonicalResolution["ignored"];
  conflict?: Conflict;
  message?: string;
  /** Rejection overrides for the would-be winner, a mandatory skill or a provider that cannot be a companion. */
  marks: Map<string, Partial<CanonicalRejection>>;
}

export function selectCanonicalSkills(candidates: readonly CanonicalCandidate[], policy: CanonicalPolicy): CanonicalResult {
  if (candidates.length > COLLISION_LIMITS.candidates) throw new RangeError(`more than ${COLLISION_LIMITS.candidates} candidates`);
  if (policy.exclusive.length > CANONICAL_LIMITS.exclusive) throw new RangeError(`more than ${CANONICAL_LIMITS.exclusive} exclusive capabilities`);
  for (const c of candidates) checkCandidate(c);
  const exclusive = sortedStrings([...new Set(policy.exclusive.map((x) => checkSlug("an exclusive capability", x)))]);
  for (const [k, v] of Object.entries(policy.pins ?? {})) { checkSlug("a pinned capability", k); checkRef("a pin", v); }
  for (const [k, v] of Object.entries(policy.overrides ?? {})) { checkSlug("an overridden capability", k); checkRef("an override", v); }
  for (const t of policy.highRisk) checkSlug("a high-risk term", t);
  const mandatory = new Set((policy.mandatory ?? []).map((m) => checkSlug("a mandatory skill", m)));

  const entries = collapse(candidates);
  for (const e of entries) e.code = exclusion(e);

  // 1. Each capability on its own.
  const works: Work[] = exclusive.map((cap) => {
    const providers = entries.filter((e) => e.caps.includes(cap));
    const eligible = providers.filter((e) => !e.code).map((e) => score(e, cap, policy)).sort(rank);
    const top = eligible[0];
    const tied = top ? eligible.filter((s) => s.s.slice(0, 6).every((v, i) => v === top.s[i])) : [];
    const second = eligible[1];
    const diff = top && second ? firstDiff(top, second) : undefined;
    const ignored: CanonicalResolution["ignored"] = [];
    for (const [level, value] of [["project-pin", policy.pins?.[cap]], ["owner-override", policy.overrides?.[cap]]] as const) {
      if (value === undefined || eligible.some((s) => matches(s.e.c, value))) continue;
      ignored.push({ level, value, reason: providers.some((e) => matches(e.c, value)) ? "not-eligible" : "not-a-candidate" });
    }
    const highRisk =
      policy.highRisk.some((t) => hasTerm(cap, t)) ||
      tied.some((s) => s.e.c.risk === "high" || policy.highRisk.some((t) => hasTerm(s.e.c.id, t) || hasTerm(s.e.c.category, t)));
    const w: Work = { cap, providers, eligible, ...(top ? { top } : {}), tied, highRisk, ignored, marks: new Map() };
    if (top) {
      const level = diff === undefined ? undefined : CANONICAL_LEVELS[diff]!;
      w.decidedBy = level ?? "only-candidate";
      if (highRisk && level && CANONICAL_WEAK_LEVELS.includes(level)) {
        w.conflict = "tie";
        const names = [...new Set(tied.map((s) => `${s.e.c.id}@${s.e.c.version}`))];
        w.message = `Two or more skills provide "${cap}" and only age or name separates them: ${list(names)}. Pin one of them for this capability, then run again.`;
        for (const s of tied) w.marks.set(s.e.key, { code: "tied" });
      }
    }
    return w;
  });
  const winnerOf = (w: Work) => (w.top && !w.conflict ? w.top.e : undefined);
  const provisional = new Map(works.map((w) => [w.cap, winnerOf(w)]));

  // 2. A mandatory skill is loaded anyway, so it has to be the canonical one.
  for (const w of works) {
    const held = w.providers.filter((e) => mandatory.has(e.c.id) && provisional.get(w.cap) !== e).sort((a, b) => byteCmp(a.key, b.key));
    if (!held.length) continue;
    const first = held[0]!;
    const code = first.code ?? "outranked";
    if (!w.conflict) {
      w.conflict = "mandatory";
      w.message = `"${first.c.id}" is always loaded (skills.selection.include) and provides "${w.cap}", but it is not the canonical skill for it (${code}). Pin it for this capability or take it off the include list, then run again.`;
      if (w.top) w.marks.set(w.top.e.key, { code: "held" });
    }
  }

  // 3. A winner has to win, or accompany the winner of, every exclusive capability it provides. A companion is an eligible provider
  // ranked after the winner when both list the capability as composable, and it is covered the same way for its other capabilities.
  // Offers only shrink and winners only turn into conflicts, so the loop ends and the result does not depend on the input order.
  const comp = (e: Entry, cap: string) => (e.c.composable ?? []).includes(cap);
  const offer = new Map<string, Scored[]>(
    works.map((w) => {
      const win = w.conflict ? undefined : provisional.get(w.cap);
      return [w.cap, win && comp(win, w.cap) ? w.eligible.filter((s) => s.e !== win && !w.marks.has(s.e.key) && comp(s.e, w.cap)) : []];
    }),
  );
  const covered = (e: Entry, cap: string) => provisional.get(cap) === e || offer.get(cap)!.some((o) => o.e === e);
  const wins = new Map<string, string[]>();
  for (const [cap, e] of provisional) if (e) wins.set(e.key, [...(wins.get(e.key) ?? []), cap]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of works) {
      const before = offer.get(w.cap)!;
      const kept = before.filter((s) => {
        const via = exclusive.find((c) => c !== w.cap && s.e.caps.includes(c) && !covered(s.e, c));
        if (via === undefined) return true;
        w.marks.set(s.e.key, { code: "overlap", via });
        return false;
      });
      if (kept.length !== before.length) { offer.set(w.cap, kept); changed = true; }
    }
    for (const [key, won] of [...wins].sort((a, b) => byteCmp(a[0], b[0]))) {
      const e = entries.find((x) => x.key === key)!;
      const lost = exclusive.filter((cap) => e.caps.includes(cap) && !covered(e, cap));
      if (!lost.length) continue;
      const via = lost[0]!;
      for (const cap of won) {
        const w = works.find((x) => x.cap === cap)!;
        if (w.conflict) continue;
        w.conflict = "winners-overlap";
        w.message = `${e.c.id}@${e.c.version} is the best skill for "${cap}" but not for "${via}", which it also provides. Pin one skill for both capabilities, then run again.`;
        w.marks.set(key, { code: "overlap", via });
        offer.set(cap, []);
        changed = true;
      }
    }
  }

  // 4. The record.
  const selected: string[] = [];
  const resolutions = works.map((w): CanonicalResolution => {
    const winner = w.top && !w.conflict ? w.top : undefined;
    const rejected: CanonicalRejection[] = [];
    const mine = new Set(offer.get(w.cap)!.map((s) => s.e.key));
    const ranked = w.eligible.filter((s) => s !== winner && !mine.has(s.e.key)).map((s) => {
      const mark = w.marks.get(s.e.key);
      if (mark) return { ...ref(s.e.c), code: "outranked" as Code, ...mark } as CanonicalRejection;
      const level = CANONICAL_LEVELS[firstDiff(w.top!, s)]!;
      return { ...ref(s.e.c), code: "outranked" as Code, level } as CanonicalRejection;
    });
    rejected.push(...ranked);
    const excluded = w.providers.filter((e) => e.code).sort((a, b) => CANONICAL_REJECT_CODES.indexOf(a.code!) - CANONICAL_REJECT_CODES.indexOf(b.code!) || byteCmp(a.key, b.key));
    for (const e of excluded)
      rejected.push({ ...ref(e.c), code: e.code!, ...(e.differs ? { differs: e.differs } : {}), ...w.marks.get(e.key) } as CanonicalRejection);
    if (winner) selected.push(winner.e.key);
    return {
      capability: w.cap,
      outcome: winner ? "selected" : w.conflict ? "conflict" : "none",
      highRisk: w.highRisk,
      ...(winner ? { winner: ref(winner.e.c) } : {}),
      companions: winner ? offer.get(w.cap)!.map((s) => ref(s.e.c)) : [],
      ...(w.decidedBy && !w.conflict ? { decidedBy: w.decidedBy } : {}),
      ...(w.conflict ? { conflict: w.conflict } : {}),
      rejected,
      ignored: w.ignored,
      ...(w.message ? { message: w.message } : {}),
    };
  });
  const chosen = new Set(selected);
  const companionKeys = new Set(resolutions.flatMap((r) => r.companions.map((c) => canonicalKey(c))).filter((k) => !chosen.has(k)));
  const left = entries.filter((e) => !chosen.has(e.key) && !companionKeys.has(e.key) && e.caps.some((c) => exclusive.includes(c))).map((e) => e.key);
  return { schema: 1, ok: !resolutions.some((r) => r.outcome === "conflict"), resolutions, selected: sortedStrings([...chosen]), companions: sortedStrings([...companionKeys]), left: sortedStrings(left) };
}

/** The reason a step must stop: the first conflict message, or a winner that needs a left-out skill. undefined when nothing stops. */
export function canonicalStop(result: CanonicalResult, broken: readonly { id: string; needs: string }[] = []): string | undefined {
  const messages = result.resolutions.flatMap((r) => (r.message ? [r.message] : []));
  for (const b of broken) messages.push(`"${b.id}" is a canonical skill but needs "${b.needs}", which is not. Pin the skills so that they agree, then run again.`);
  if (!messages.length) return undefined;
  const more = messages.length - 1;
  return `${CANONICAL_STOP_PREFIX}${messages[0]}${more > 0 ? ` (and ${more} more)` : ""}`;
}
