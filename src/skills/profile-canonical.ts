import { canonicalKey, selectCanonicalSkills, type CanonicalCandidate, type CanonicalResolution } from "./canonical.js";
import { canonicalFromRegistered } from "./canonical-facts.js";
import { CANONICAL_GATES, CANONICAL_SOURCE_TIER } from "./canonical-rules.js";
import { COLLISION_LIMITS } from "./collision-rules.js";
import { byteCmp } from "./import-plan.js";
import { PROFILE_GATES, type ProfileCandidateResult, type ProfileGate } from "./profile-evaluate.js";
import { findProfileEvaluation, type ProfileEvaluationRecord } from "./profile-evaluations.js";
import type { RegisteredSkill } from "./registry.js";
import type { ToolPolicy } from "./schema.js";
import type { SourceProfile } from "./source-profiles.js";
import type { SourceTrustTier } from "./sources.js";

// The canonical skill per exclusive capability, from the part-3 results of a staged source and the registered skills.
// Pure: no file system, no clock, no process. A report that grants nothing: it promotes nothing and no run reads it.
// Only validated ids, versions, enum codes and the selector's own message are printed; no free text of an upstream skill.

export type ProfileOrigin = "staged" | "builtin" | "admin";
type CanonicalGate = (typeof CANONICAL_GATES)[number];

export interface ProfileCanonicalInput {
  trust: SourceTrustTier;
  candidates: readonly ProfileCandidateResult[];
  profile: SourceProfile | undefined;
  /** profiles.exclusive */
  exclusive: readonly string[];
  registered: readonly RegisteredSkill[];
  evaluations: readonly ProfileEvaluationRecord[];
  today: string;
  tools?: ToolPolicy;
}
export interface ProfileCanonicalReport {
  resolutions: CanonicalResolution[];
  /** canonicalKey → where the provider comes from */
  origin: ReadonlyMap<string, ProfileOrigin>;
  /** canonicalKey → failed part-3 gates of a staged provider, in PROFILE_GATES order */
  gates: ReadonlyMap<string, readonly ProfileGate[]>;
  conflicts: number;
}

const GATE_TO_CANONICAL: Partial<Record<ProfileGate, CanonicalGate>> = { security: "safety", licence: "licence", requirements: "tools" };
const sorted = (a: Iterable<string>) => [...new Set(a)].sort(byteCmp);

/** Exclusive capabilities that a declared skill of this source provides, sorted. Empty: no section, no discovery. */
export function profileExclusive(profile: SourceProfile | undefined, exclusive: readonly string[]): string[] {
  const declared = new Set((profile?.skills ?? []).flatMap((s) => s.capabilities));
  return sorted(exclusive.filter((c) => declared.has(c)));
}

export function canonicalFromProfile(
  c: ProfileCandidateResult,
  facts: { trust: SourceTrustTier; evaluations: readonly ProfileEvaluationRecord[]; today: string },
): CanonicalCandidate | undefined {
  const p = c.profile;
  if (!p || c.id === undefined || c.digest === undefined || c.version === undefined || c.category === undefined || c.risk === undefined) return undefined;
  const failed = CANONICAL_GATES.filter((g) => c.reasons.some((r) => GATE_TO_CANONICAL[r.gate] === g));
  const discovery = c.reasons.some((r) => r.gate === "evaluation" || r.gate === "declared");
  const states = p.evaluations.map((k) => findProfileEvaluation(facts.evaluations, c.id!, k, c.digest!, facts.today).state);
  const evaluation = states.includes("failed") ? "failed" : states.length > 0 && states.every((s) => s === "passed") ? "passed" : undefined;
  return {
    id: c.id,
    version: c.version,
    fingerprint: c.digest,
    capabilities: [...p.capabilities],
    category: c.category,
    risk: c.risk,
    tier: CANONICAL_SOURCE_TIER[facts.trust],
    status: discovery ? "discovery" : "approved",
    failed,
    compatibility: "generic",
    ...(evaluation ? { evaluation } : {}),
  };
}

const sameCaps = (a: readonly string[], b: readonly string[]) => a.length === b.length && sorted(a).join("\n") === sorted(b).join("\n");

/** Throws RangeError like selectCanonicalSkills when there are too many candidates. */
export function profileCanonical(input: ProfileCanonicalInput): ProfileCanonicalReport {
  const scope = profileExclusive(input.profile, input.exclusive);
  const active = input.registered
    .filter((s) => s.active && (s.source === "builtin" || s.source === "admin"))
    .sort((a, b) => byteCmp(a.key, b.key));
  if (input.candidates.length + active.length > COLLISION_LIMITS.candidates) throw new RangeError("too many skill candidates");

  const origin = new Map<string, ProfileOrigin>();
  const gates = new Map<string, readonly ProfileGate[]>();
  const facts = { trust: input.trust, evaluations: input.evaluations, today: input.today };
  const installed = new Map<string, RegisteredSkill>(active.map((s) => [`${s.id}@${s.version} ${s.digest}`, s]));
  /** Installed artifact → the staged copy of it that declares the same capabilities. */
  const copies = new Map<string, CanonicalCandidate>();
  const all: CanonicalCandidate[] = [];

  for (const c of input.candidates) {
    const cand = canonicalFromProfile(c, facts);
    if (!cand) continue;
    const key = canonicalKey(cand);
    const s = installed.get(key);
    if (s && sameCaps(s.pkg.capabilities ?? [], cand.capabilities)) {
      // The installed skill keeps its place and its facts; the staged verdicts hold for it too.
      copies.set(key, cand);
    } else {
      origin.set(key, "staged");
      all.push(cand);
    }
    const failedGates = PROFILE_GATES.filter((g) => c.reasons.some((r) => r.gate === g));
    if (failedGates.length) gates.set(key, failedGates);
  }
  for (const s of active) {
    const bad = s.pin === "mismatch" || s.pin === "unverified";
    const reg = canonicalFromRegistered(s, { ...(input.tools ? { tools: input.tools } : {}), ...(bad ? { safety: false } : {}) });
    const key = canonicalKey(reg);
    const copy = copies.get(key);
    const merged: CanonicalCandidate = copy
      ? {
          ...reg,
          failed: CANONICAL_GATES.filter((g) => reg.failed.includes(g) || copy.failed.includes(g)),
          status: copy.status === "discovery" ? "discovery" : reg.status,
          ...(copy.evaluation ? { evaluation: copy.evaluation } : {}),
        }
      : reg;
    origin.set(key, s.source as ProfileOrigin);
    all.push(merged);
  }

  const providers = new Map<string, Set<string>>();
  for (const c of all) for (const cap of c.capabilities) providers.set(cap, (providers.get(cap) ?? new Set()).add(canonicalKey(c)));
  // Select over every exclusive capability with two providers, so a winner that loses another capability it provides is seen
  // (winners-overlap); only the capabilities this source declares are reported.
  const exclusive = sorted(input.exclusive).filter((cap) => (providers.get(cap)?.size ?? 0) >= 2);
  const highRisk = sorted((input.profile?.skills ?? []).flatMap((s) => s.high_risk));
  const result = selectCanonicalSkills(all, { exclusive, highRisk });
  const resolutions = result.resolutions.filter((r) => scope.includes(r.capability));
  return { resolutions, origin, gates, conflicts: resolutions.filter((r) => r.outcome === "conflict").length };
}

export function profileCanonicalLines(report: ProfileCanonicalReport): string[] {
  const out: string[] = [];
  const ref = (r: { id: string; version: string; fingerprint: string }) =>
    `${r.id}@${r.version} ${report.origin.get(canonicalKey(r)) ?? "staged"}`;
  for (const r of report.resolutions) {
    const hr = r.highRisk ? " high-risk" : "";
    if (r.outcome === "selected" && r.winner) out.push(`CANONICAL ${r.capability}: ${ref(r.winner)} (${r.decidedBy ?? "only-candidate"})${hr}`);
    else if (r.outcome === "conflict") out.push(`CONFLICT ${r.capability}: ${r.conflict}${hr}: ${r.message ?? ""}`);
    else out.push(`NONE ${r.capability}: no skill can be used${hr}`);
    for (const x of r.rejected) {
      const g = report.gates.get(canonicalKey(x)) ?? [];
      out.push(`REJECTED ${r.capability} ${ref(x)}: ${x.code}${x.level ? ` (${x.level})` : ""}${g.length ? ` gates=${g.join(",")}` : ""}`);
    }
  }
  return out;
}
