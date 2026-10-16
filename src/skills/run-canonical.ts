import { join } from "node:path";
import type { Config } from "../config.js";
import { CANONICAL_STOP_PREFIX, type CanonicalLevel } from "./canonical-rules.js";
import { canonicalFromRegistered } from "./canonical-facts.js";
import { canonicalKey, canonicalStop, selectCanonicalSkills, type CanonicalCandidate, type CanonicalPolicy, type CanonicalRejection, type CanonicalResolution, type CanonicalResult } from "./canonical.js";
import { OVERRIDES_FILE } from "./choice-rules.js";
import { checkSkillChoices, choiceStop, planSkillChoices, type AppliedChoice, type ChoicePlan, type ChoiceProblem, type SkillOverride } from "./choices.js";
import { collapseMirrors, instructionKey, registryRank, safetyProfile } from "./mirrors.js";
import { readChoiceFile, readProjectPins, type ProjectPinsRead } from "./project-pins.js";
import { findSkill, type RegisteredSkill, type SkillRegistry } from "./registry.js";
import { resolveSkills, type ResolveOptions, type SkillResolution } from "./resolve.js";

// The canonical selection of a live run: the live dependencies (config, owner overrides, project pins) and the check that the
// catalogue (run-catalogue.ts) and the skill lock (engine/skill-lock.ts) share. Synchronous. The only files read are the owner
// overrides file and, through project-pins.ts, the project pins of the default branch.

type Registry = Pick<SkillRegistry, "skills" | "byKey" | "problems">;

export interface CanonicalDeps {
  policy: Omit<CanonicalPolicy, "mandatory">;
  candidate: (skill: RegisteredSkill) => CanonicalCandidate | undefined;
  /**
   * Default: none. A skill whose candidate this returns true for is left out even when it provides no exclusive capability
   * (a failed safety gate must not depend on what else the skill offers). A mandatory skill that is withheld stops the step.
   */
  withhold?: (candidate: CanonicalCandidate) => boolean;
  /**
   * Owner overrides and project pins, already read by the caller. With this field the choices replace policy.pins and
   * policy.overrides, and every failure to read or check them stops the step.
   * `overridesInvalid`: the overrides file exists but cannot be used.
   */
  choices?: { overrides?: readonly SkillOverride[]; overridesInvalid?: true; pins?: ProjectPinsRead; repository?: string; now?: Date };
}

export const CANONICAL_RECORD_LIMITS = { rejected: 5 } as const;
export const CANONICAL_UNCHECKED = `${CANONICAL_STOP_PREFIX}the canonical skills of this run could not be checked. Run again.`;

/** Compact record of one capability: ids, versions and codes only, no free text. */
export interface CanonicalSelectionRecord {
  capability: string;
  outcome: CanonicalResolution["outcome"];
  /** id@version */
  winner?: string;
  decidedBy?: CanonicalResolution["decidedBy"];
  rejected: { skill: string; code: CanonicalRejection["code"]; level?: CanonicalLevel }[];
  rejectedOmitted?: number;
  ignored?: CanonicalResolution["ignored"];
}

/** The live dependencies, or undefined when no capability is exclusive. Never throws. */
export function liveCanonicalDeps(
  i: { config: Pick<Config, "skills">; workdir?: string; home: string; repository?: string; now?: Date },
  io: { readPins?: (workdir: string) => ProjectPinsRead } = {},
): CanonicalDeps | undefined {
  const { skills } = i.config;
  const exclusive = skills.selection.exclusive;
  if (exclusive.length === 0) return undefined;
  const file = readChoiceFile(join(i.home, OVERRIDES_FILE), "overrides");
  const choices: NonNullable<CanonicalDeps["choices"]> = {
    ...(file.state === "ok" ? { overrides: file.items } : {}),
    ...(file.state === "invalid" ? { overridesInvalid: true as const } : {}),
    ...(i.workdir ? { pins: (io.readPins ?? readProjectPins)(i.workdir) } : {}),
    ...(i.repository ? { repository: i.repository } : {}),
    ...(i.now ? { now: i.now } : {}),
  };
  return {
    policy: { exclusive: [...exclusive], highRisk: [...skills.unresolved.high_risk] },
    candidate: (s) => canonicalFromRegistered(s, { tools: skills.tools }),
    choices,
  };
}

/** Whether the resolver would select `s` on its own. */
export function usableFor(reg: Registry, opts: ResolveOptions): (s: RegisteredSkill) => boolean {
  return (s) => {
    const res = resolveSkills(reg, [s.id], opts);
    return res.ok && res.decisions.some((d) => d.id === s.id && d.outcome === "selected");
  };
}

/** The first of `ids` that `root` depends on, directly or through other registry skills. */
export function needsAny(reg: Registry, root: RegisteredSkill, ids: ReadonlySet<string>): string | undefined {
  const seen = new Set<string>();
  const todo = [root];
  for (let cur = todo.pop(); cur; cur = todo.pop())
    for (const dep of cur.pkg.dependencies ?? []) {
      if (seen.has(dep.id)) continue;
      seen.add(dep.id);
      if (ids.has(dep.id)) return dep.id;
      const next = findSkill(reg, dep.id);
      if (next) todo.push(next);
    }
  return undefined;
}

/** The roots and everything they depend on in the registry, once each. */
export function withDependencies(reg: Registry, roots: readonly RegisteredSkill[]): RegisteredSkill[] {
  const judged = new Map<string, RegisteredSkill>();
  for (const root of roots) {
    judged.set(root.key, root);
    const seen = new Set<string>();
    const todo = [root];
    for (let cur = todo.pop(); cur; cur = todo.pop())
      for (const dep of cur.pkg.dependencies ?? []) {
        if (seen.has(dep.id)) continue;
        seen.add(dep.id);
        const next = findSkill(reg, dep.id);
        if (!next) continue;
        judged.set(next.key, next);
        todo.push(next);
      }
  }
  return [...judged.values()];
}

export interface ChoiceStart { plan?: ChoicePlan; known: ChoiceProblem[]; inEffect: boolean }

/** Owner choices are planned first: with any in effect, no exit may fall back to an unblocked result. */
export function startChoices(deps: CanonicalDeps | undefined): ChoiceStart {
  const ch = deps?.choices;
  let plan: ChoicePlan | undefined;
  const known: ChoiceProblem[] = [];
  if (deps && ch) {
    const pins = ch.pins;
    if (ch.overridesInvalid) known.push({ code: "invalid", level: "owner-override" });
    if (pins?.state === "invalid") known.push({ code: "invalid", level: "project-pin" });
    else if (pins?.state === "unreadable") known.push({ code: pins.why === "no-default-branch" ? "no-default-branch" : "unreadable", level: "project-pin" });
    try {
      plan = planSkillChoices({
        ...(ch.overrides ? { overrides: ch.overrides } : {}),
        ...(pins?.state === "ok" ? { pins: pins.items } : {}),
        ...(ch.repository !== undefined ? { repository: ch.repository } : {}),
        now: ch.now ?? new Date(),
        exclusive: deps.policy.exclusive,
      });
    } catch {
      known.push({ code: "unchecked" });
    }
  }
  const inEffect = known.length > 0 || (plan !== undefined && (plan.planned.length > 0 || plan.problems.length > 0));
  return { ...(plan ? { plan } : {}), known, inEffect };
}

/** The stop text for a result that could not be built while owner choices are in effect; undefined when none are. */
export function choicesUnchecked(start: ChoiceStart): string | undefined {
  if (!start.inEffect) return undefined;
  const problems: ChoiceProblem[] = [...start.known, ...(start.plan?.problems ?? [])];
  if (!start.known.some((p) => p.code === "unchecked")) problems.push({ code: "unchecked" });
  return choiceStop(problems)!;
}

export interface CanonicalCheck {
  canonical: CanonicalResult;
  /** Ids of the losers, their merged copies and the withheld skills. */
  left: Set<string>;
  /** Per selected representative: [its id, ...the ids of its merged copies]. */
  copies: string[][];
  applied: AppliedChoice[];
  /** Starts with CANONICAL_STOP_PREFIX. */
  blocked?: string;
}

/** Collapses copies, picks the canonical skills of `judged` and checks the owner choices, the safety gates and the dependencies. */
export function checkCanonical(i: { reg: Registry; judged: readonly RegisteredSkill[]; mandatory: readonly string[]; deps: CanonicalDeps; start: ChoiceStart }): CanonicalCheck {
  const { reg, deps, start } = i;
  const { plan, known } = start;
  const mandatoryRoots = i.mandatory.flatMap((id) => { const m = findSkill(reg, id); return m ? [m] : []; });
  const byKey = new Map<string, RegisteredSkill>();
  const withhold = deps.withhold;
  const all: { s: RegisteredSkill; c: CanonicalCandidate; withheld: boolean; ck: string }[] = [];
  for (const s of i.judged) {
    const c = deps.candidate(s);
    if (!c) continue;
    const ck = canonicalKey(c);
    byKey.set(ck, s);
    all.push({ s, c, withheld: withhold ? withhold(c) : false, ck });
  }
  // Copies (same text and same safety profile) are merged before the selection: only the representative is a candidate.
  const grouped = collapseMirrors(all, (e) => `${instructionKey(e.s.pkg)}\n${safetyProfile(e.c, e.withheld)}`, (e) => registryRank(e.s));
  const repCk = new Map<string, string>(); // copy canonical key -> representative canonical key
  const members = new Map<string, string[]>(); // representative canonical key -> its copies' ids
  const repKeyOf = new Map<string, string>(); // copy id@version -> representative id@version
  for (const g of grouped.groups)
    for (const m of g.collapsed) {
      repCk.set(m.ck, g.kept.ck);
      members.set(g.kept.ck, [...(members.get(g.kept.ck) ?? []), m.s.id]);
      repKeyOf.set(`${m.s.id}@${m.s.version}`, `${g.kept.s.id}@${g.kept.s.version}`);
    }
  // A bare id is remapped only when every judged package with that id is a copy of the same representative.
  const repIdOf = new Map<string, string>();
  for (const id of new Set(all.map((e) => e.s.id))) {
    const reps = new Set(all.filter((e) => e.s.id === id).map((e) => byKey.get(repCk.get(e.ck) ?? e.ck)!.id));
    if (reps.size === 1 && !reps.has(id)) repIdOf.set(id, [...reps][0]!);
  }
  const mapTarget = (t: string): string => (t.includes("@") ? repKeyOf.get(t) : repIdOf.get(t)) ?? t;
  const mapRecord = (r: Readonly<Record<string, string>> | undefined) => (r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, mapTarget(v)])) : undefined);
  const candidates = grouped.kept.map((e) => e.c);
  const policyPins = mapRecord(deps.policy.pins);
  const policyOverrides = mapRecord(deps.policy.overrides);
  const mappedPlan: ChoicePlan | undefined = plan && {
    ...plan,
    pins: mapRecord(plan.pins)!,
    overrides: mapRecord(plan.overrides)!,
    planned: plan.planned.map((p) => ({ ...p, target: mapTarget(p.target) })),
  };
  const canonical = selectCanonicalSkills(candidates, {
    ...deps.policy,
    ...(policyPins ? { pins: policyPins } : {}),
    ...(policyOverrides ? { overrides: policyOverrides } : {}),
    ...(mappedPlan ? { pins: mappedPlan.pins, overrides: mappedPlan.overrides } : {}),
    mandatory: [...new Set(i.mandatory.map((id) => repIdOf.get(id) ?? id))],
  });
  const leftIds = new Set<string>();
  const copies = canonical.selected.flatMap((k) => { const s = byKey.get(k); return s ? [[s.id, ...(members.get(k) ?? [])]] : []; });
  let applied: AppliedChoice[] = [];
  const result = (blocked?: string): CanonicalCheck => ({ canonical, left: leftIds, copies, applied, ...(blocked ? { blocked } : {}) });
  if (deps.choices) {
    // `plan` is set here: a planning failure is in `known`, and the check below stops on it.
    const checked = mappedPlan
      ? checkSkillChoices(mappedPlan, canonical, (target) => {
          const s = reg.byKey.get(target);
          return !s ? "missing" : !s.active ? "not-active" : s.trust === "unapproved" ? "unapproved" : "not-usable";
        })
      : { problems: [], applied: [] };
    // The record keeps the target the owner wrote.
    applied = checked.applied.map((a, n) => ({ ...a, target: plan!.planned[n]!.target }));
    const choiceBlock = choiceStop([...known, ...checked.problems]);
    if (choiceBlock) return result(choiceBlock);
  }
  for (const k of canonical.left) {
    const s = byKey.get(k);
    if (!s) continue;
    leftIds.add(s.id);
    for (const id of members.get(k) ?? []) leftIds.add(id);
  }
  if (withhold) {
    const chosen = new Set(canonical.selected);
    for (const e of all) if (!chosen.has(e.ck) && !chosen.has(repCk.get(e.ck) ?? "") && e.withheld) leftIds.add(e.s.id);
    const held = mandatoryRoots.find((m) => leftIds.has(m.id) && all.some((e) => e.s.id === m.id && e.withheld));
    if (held) return result(`${CANONICAL_STOP_PREFIX}"${held.id}" is always loaded (skills.selection.include) but it fails a safety gate. Take it off the include list or fix the gate, then run again.`);
  }
  const mandatoryIds = new Set(mandatoryRoots.map((m) => m.id));
  const broken = [...new Set([...canonical.selected.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : [])), ...mandatoryRoots])]
    .filter((s) => !leftIds.has(s.id) || mandatoryIds.has(s.id))
    .flatMap((s) => {
      const n = needsAny(reg, s, leftIds);
      return n !== undefined ? [{ id: s.id, needs: n }] : [];
    });
  return result(canonicalStop(canonical, broken));
}

/** The compact record of the resolutions (a CanonicalResult is accepted too). Capabilities without a winner, a rejection or an ignored choice are left out. */
export function canonicalRecord(from: CanonicalResult | readonly CanonicalResolution[]): CanonicalSelectionRecord[] {
  const resolutions = Array.isArray(from) ? (from as readonly CanonicalResolution[]) : (from as CanonicalResult).resolutions;
  const out: CanonicalSelectionRecord[] = [];
  for (const r of resolutions) {
    if (!r.winner && r.rejected.length === 0 && r.ignored.length === 0) continue;
    const rejected = r.rejected.slice(0, CANONICAL_RECORD_LIMITS.rejected).map((x) => ({ skill: `${x.id}@${x.version}`, code: x.code, ...(x.level ? { level: x.level } : {}) }));
    const omitted = r.rejected.length - rejected.length;
    out.push({
      capability: r.capability,
      outcome: r.outcome,
      ...(r.winner ? { winner: `${r.winner.id}@${r.winner.version}` } : {}),
      ...(r.decidedBy ? { decidedBy: r.decidedBy } : {}),
      rejected,
      ...(omitted > 0 ? { rejectedOmitted: omitted } : {}),
      ...(r.ignored.length ? { ignored: r.ignored.map((g) => ({ level: g.level, value: g.value, reason: g.reason })) } : {}),
    });
  }
  return out;
}

const PRIORITY = { mandatory: 0, dependency: 1, requested: 2 } as const;

/**
 * One round of the lock-time check over the skills the resolver chose. `drop`: requested ids to leave out (ask again without them).
 * Never throws: a failure is a `blocked` text.
 */
export function lockCanonical(i: {
  reg: Registry;
  resolution: SkillResolution;
  mandatory: readonly string[];
  deps: CanonicalDeps;
  start: ChoiceStart;
  usable: (s: RegisteredSkill) => boolean;
}): { blocked: string } | { drop: string[]; resolutions: CanonicalResolution[] } {
  try {
    const { reg, resolution } = i;
    const judged = new Map<string, RegisteredSkill>();
    for (const s of resolution.selected) {
      const r = reg.byKey.get(`${s.id}@${s.version}`);
      if (r) judged.set(r.key, r);
    }
    // The usable targets of the owner choices are judged too (never loaded), so the choice check agrees with the catalogue.
    for (const p of i.start.plan?.planned ?? []) {
      const t = reg.byKey.get(p.target) ?? findSkill(reg, p.target);
      if (t && t.active && t.trust !== "unapproved" && !judged.has(t.key) && i.usable(t)) judged.set(t.key, t);
    }
    const check = checkCanonical({ reg, judged: [...judged.values()], mandatory: i.mandatory, deps: i.deps, start: i.start });
    if (check.blocked) return { blocked: check.blocked };
    const reasonOf = new Map(resolution.selected.map((s) => [s.id, s]));
    const marked = new Set<string>();
    for (const s of resolution.selected) if (check.left.has(s.id)) marked.add(s.id);
    for (const group of check.copies) {
      const here = group.filter((id) => reasonOf.has(id) && !marked.has(id));
      // The representative is the canonical copy. A loaded copy while it is not loaded is not canonical.
      if (!here.includes(group[0]!)) {
        for (const id of here) marked.add(id);
        continue;
      }
      if (here.length < 2) continue;
      let keep = here[0]!;
      for (const id of here) if (PRIORITY[reasonOf.get(id)!.reason] < PRIORITY[reasonOf.get(keep)!.reason]) keep = id;
      for (const id of here) if (id !== keep) marked.add(id);
    }
    const drop = [...marked].filter((id) => reasonOf.get(id)!.reason === "requested");
    if (drop.length) return { drop, resolutions: check.canonical.resolutions };
    const rest = [...marked];
    if (rest.length) {
      const first = reasonOf.get(rest[0]!)!;
      const as = first.reason === "mandatory" ? "a mandatory skill (skills.selection.include)" : `a dependency of "${first.requiredBy[0] ?? "another skill"}"`;
      const more = rest.length > 1 ? ` (and ${rest.length - 1} more)` : "";
      return { blocked: `${CANONICAL_STOP_PREFIX}"${first.id}" is loaded as ${as} but it is not the canonical skill for its capability. Pin the skills so that they agree, or change the plan or skills.selection.include, then run again.${more}` };
    }
    return { drop: [], resolutions: check.canonical.resolutions };
  } catch {
    return { blocked: CANONICAL_UNCHECKED };
  }
}

/** The decision that caused a removal is kept: a later round, with the loser gone, would only see an only-candidate. */
function keepDecision(seen: Map<string, CanonicalResolution>, round: readonly CanonicalResolution[]): void {
  const key = (r: CanonicalResolution) => (r.winner ? `${r.winner.id}@${r.winner.version}` : undefined);
  for (const r of round) {
    const p = seen.get(r.capability);
    if (!p || key(p) === undefined || (key(r) !== undefined && key(r) !== key(p))) seen.set(r.capability, r);
  }
}

export type CanonicalResolved =
  | { blocked: string }
  | { notOk: SkillResolution }
  | { resolution: SkillResolution; dropped: string[]; record: CanonicalSelectionRecord[] };

/**
 * Resolves `ids` and applies the canonical selection until nothing is left to drop. Requested losers are dropped (listed in `dropped`);
 * a conflict, an owner-choice problem, or a mandatory or dependency loser is `blocked`. The record keeps the decisions that caused a drop.
 */
export function canonicalResolve(i: { reg: Registry; ids: readonly string[]; opts: ResolveOptions; deps: CanonicalDeps }): CanonicalResolved {
  const { reg, opts, deps } = i;
  const start = startChoices(deps);
  const usable = usableFor(reg, opts);
  const seen = new Map<string, CanonicalResolution>();
  const dropped: string[] = [];
  let ids = [...i.ids];
  for (;;) {
    const resolution = resolveSkills(reg, ids, opts);
    if (!resolution.ok) return { notOk: resolution };
    const r = lockCanonical({ reg, resolution, mandatory: opts.include ?? [], deps, start, usable });
    if ("blocked" in r) return r;
    keepDecision(seen, r.resolutions);
    if (!r.drop.length) return { resolution, dropped, record: canonicalRecord([...seen.values()].sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))) };
    const next = ids.filter((x) => !r.drop.includes(x));
    if (next.length === ids.length) return { blocked: CANONICAL_UNCHECKED };
    dropped.push(...r.drop);
    ids = next;
  }
}
