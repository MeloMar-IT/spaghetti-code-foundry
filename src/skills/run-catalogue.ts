import type { Config, SkillsConfig } from "../config.js";
import { buildSkillCatalogue, catalogueOptionsFrom, estimateTokens, renderSkillCatalogue } from "./catalogue.js";
import { CATALOGUE_SCORING } from "./catalogue-rules.js";
import { CANONICAL_STOP_PREFIX } from "./canonical-rules.js";
import { canonicalKey, canonicalStop, selectCanonicalSkills, type CanonicalCandidate, type CanonicalPolicy, type CanonicalResult } from "./canonical.js";
import { CHOICE_LIMITS } from "./choice-rules.js";
import { checkSkillChoices, choiceStop, planSkillChoices, type AppliedChoice, type ChoicePlan, type ChoiceProblem, type SkillOverride } from "./choices.js";
import { dedupeOffered, type CollisionCandidate } from "./collisions.js";
import type { ProjectPinsRead } from "./project-pins.js";
import { discoverSkills, findSkill, type RegisteredSkill, type SkillRegistry } from "./registry.js";
import { buildRepoProfile, type RepoProfile } from "./repo-profile.js";
import { collapseMirrors, instructionKey, MIRROR_LIMITS, registryRank, safetyProfile } from "./mirrors.js";
import { resolveOptionsFrom, resolveSkills } from "./resolve.js";

// The skill catalogue a planner step (`skills: catalog`) gets before its prompt. Synchronous; never throws.
// A skill is offered only when the resolver would select it on its own for the coder, so a pick cannot stop an unattended run.
// A catalogue stops a step only through `blocked`, and only with the `canonical` dependency.
// Skills with the same description and instructions (mirrors) are offered once: the best tier, then id, then version. With the
// `canonical` dependency, copies with the same safety profile are merged before the selection; every package keeps its own gate check.

export const SKILL_CATALOGUE_TAG = "foundry-skill-catalogue";
/** The step whose output is the issue text in the shipped flows. */
export const CATALOGUE_ISSUE_STEP = "pull_ticket";

export interface RunCatalogueRecord {
  entries: number;
  omitted: number;
  estimatedTokens: number;
  hidden?: number;
  /** Skills with the same text, offered once (`id@version` only; at most MIRROR_LIMITS.recorded collapsed ids). Absent without copies. */
  mirrors?: { kept: string; collapsed: string[] }[];
  mirrorsOmitted?: number;
  /** Owner overrides and project pins in scope, without free text (the digest leads back to the reviewed entry). */
  choices?: AppliedChoice[];
  choicesOmitted?: number;
  choicesSource?: { pins: { commit: string; blob: string } };
}
export interface RunCatalogue {
  /** "" when no block is attached. */
  text: string;
  /** One line, no path and no error text. */
  log: string;
  record?: RunCatalogueRecord;
  /** Only with the `canonical` dependency: the selection record. */
  canonical?: CanonicalResult;
  /** Only with the `canonical` dependency: why the step must stop. `text` is "" and `record` is absent. */
  blocked?: string;
}
type Registry = Pick<SkillRegistry, "skills" | "byKey" | "problems">;
export interface RunCatalogueDeps {
  discover?: (skills: SkillsConfig) => Registry;
  /** Default: buildRepoProfile(workdir). */
  profile?: (workdir: string) => RepoProfile;
  /**
   * Default: none. Gives a registered skill's provenance as a collision candidate (collisions.ts). A skill that returns one is offered
   * once per content and is left out while it is unapproved or held back by a blocking collision, and so is every skill that
   * depends on a held-back one. A skill that returns undefined is offered as it is. No run supplies this yet.
   */
  candidate?: (skill: RegisteredSkill) => CollisionCandidate | undefined;
  /** Default: none. Picks one skill per exclusive capability (canonical.ts). No run supplies this yet. */
  canonical?: {
    policy: Omit<CanonicalPolicy, "mandatory">;
    candidate: (skill: RegisteredSkill) => CanonicalCandidate | undefined;
    /**
     * Default: none. A skill whose candidate this returns true for is left out even when it provides no exclusive capability
     * (a failed safety gate must not depend on what else the skill offers). A mandatory skill that is withheld stops the step.
     */
    withhold?: (candidate: CanonicalCandidate) => boolean;
    /**
     * Owner overrides and project pins, already read by the caller. With this field the choices replace policy.pins and
     * policy.overrides, and every failure to read or check them stops the step. No run supplies this yet.
     */
    choices?: { overrides?: readonly SkillOverride[]; pins?: ProjectPinsRead; repository?: string; now?: Date };
  };
}

/** The task text and the issue text, joined by a line break and cut to the scoring limit. Used for ranking only. */
export function catalogueTaskText(task: string | undefined, issue: string | undefined): string {
  return `${task ?? ""}\n${issue ?? ""}`.slice(0, CATALOGUE_SCORING.taskChars);
}

const none = (why: string): RunCatalogue => ({ text: "", log: `skill catalogue: none (${why})` });

/** The same skills with every pin failure cleared. Only used to count; never to offer or load. */
function pinnedCopy(reg: Registry): Registry {
  const skills = reg.skills.map((s): RegisteredSkill => (s.trust === "unapproved" ? s : { ...s, pin: "pinned" }));
  return { skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: reg.problems };
}

export function runSkillCatalogue(i: { workdir?: string; config: Pick<Config, "skills">; task: string }, deps: RunCatalogueDeps = {}): RunCatalogue {
  // Owner choices are planned first: with any in effect, no exit may fall back to an unblocked catalogue.
  const ch = deps.canonical?.choices;
  let plan: ChoicePlan | undefined;
  const known: ChoiceProblem[] = [];
  if (ch) {
    const pins = ch.pins;
    if (pins?.state === "invalid") known.push({ code: "invalid", level: "project-pin" });
    else if (pins?.state === "unreadable") known.push({ code: pins.why === "no-default-branch" ? "no-default-branch" : "unreadable", level: "project-pin" });
    try {
      plan = planSkillChoices({
        ...(ch.overrides ? { overrides: ch.overrides } : {}),
        ...(pins?.state === "ok" ? { pins: pins.items } : {}),
        ...(ch.repository !== undefined ? { repository: ch.repository } : {}),
        now: ch.now ?? new Date(),
        exclusive: deps.canonical!.policy.exclusive,
      });
    } catch {
      known.push({ code: "unchecked" });
    }
  }
  const inEffect = known.length > 0 || (plan !== undefined && (plan.planned.length > 0 || plan.problems.length > 0));
  const fail = (why: string): RunCatalogue => {
    if (!inEffect) return none(why);
    const problems: ChoiceProblem[] = [...known, ...(plan?.problems ?? [])];
    if (!known.some((p) => p.code === "unchecked")) problems.push({ code: "unchecked" });
    return { text: "", log: "skill catalogue: none (skill selection stopped)", blocked: choiceStop(problems)! };
  };
  let profile: RepoProfile;
  try {
    if (!i.workdir) return fail("the repository could not be read");
    profile = (deps.profile ?? buildRepoProfile)(i.workdir);
  } catch {
    return fail("the repository could not be read");
  }
  try {
    const { skills } = i.config;
    const reg = (deps.discover ?? discoverSkills)(skills);
    const opts = { role: "coder" as const, ...resolveOptionsFrom(skills) };
    const usable = (r: Registry, s: RegisteredSkill) => {
      const res = resolveSkills(r, [s.id], opts);
      return res.ok && res.decisions.some((d) => d.id === s.id && d.outcome === "selected");
    };
    const hypo = pinnedCopy(reg);
    const offered: RegisteredSkill[] = [];
    let hidden = 0;
    for (const s of reg.skills) {
      if (!s.active || s.trust === "unapproved") continue;
      if (usable(reg, s)) offered.push(s);
      else if (usable(hypo, hypo.byKey.get(s.key)!)) hidden++;
    }
    /** The first of `ids` that `root` depends on, directly or through other registry skills. */
    const needs = (root: RegisteredSkill, ids: ReadonlySet<string>): string | undefined => {
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
    };
    // Skill collisions. A mandatory id is never taken out. A dependency on a mirror that was left out stays as it is in the registry:
    // the resolver loads it as a dependency and counts it in the budgets, so the offer still matches what a run would load.
    let pool = offered;
    let merged = 0;
    let held = 0;
    if (deps.candidate) {
      const d = dedupeOffered(offered, deps.candidate);
      const mandatory = new Set(opts.include ?? []);
      const heldNow = new Set(d.heldItems.filter((s) => !mandatory.has(s.id)));
      const heldIds = new Set([...heldNow].map((s) => s.id));
      const kept = new Set(d.kept);
      const heldAll = new Set(d.heldItems);
      pool = offered.filter((s) => !heldNow.has(s) && (kept.has(s) || heldAll.has(s)) && !(heldIds.size && needs(s, heldIds) !== undefined));
      merged = d.merged;
      held = offered.length - pool.length - merged;
    }
    // Canonical selection. The resolver loads dependencies and mandatory ids from the registry whatever the offer says, so every
    // skill a run could load is judged, and a skill that needs a left-out one is left out too.
    let canonical: CanonicalResult | undefined;
    let notCanonical = 0;
    let applied: AppliedChoice[] = [];
    if (deps.canonical) {
      const judged = new Map<string, RegisteredSkill>();
      // The resolver always loads the mandatory ids too, so they and their dependencies are judged as well.
      const mandatoryRoots = (opts.include ?? []).flatMap((id) => { const m = findSkill(reg, id); return m ? [m] : []; });
      for (const root of [...pool, ...mandatoryRoots]) {
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
      const byKey = new Map<string, RegisteredSkill>();
      const withhold = deps.canonical.withhold;
      const all: { s: RegisteredSkill; c: CanonicalCandidate; withheld: boolean; ck: string }[] = [];
      for (const s of judged.values()) {
        const c = deps.canonical.candidate(s);
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
      const policyPins = mapRecord(deps.canonical.policy.pins);
      const policyOverrides = mapRecord(deps.canonical.policy.overrides);
      const mappedPlan: ChoicePlan | undefined = plan && {
        ...plan,
        pins: mapRecord(plan.pins)!,
        overrides: mapRecord(plan.overrides)!,
        planned: plan.planned.map((p) => ({ ...p, target: mapTarget(p.target) })),
      };
      canonical = selectCanonicalSkills(candidates, {
        ...deps.canonical.policy,
        ...(policyPins ? { pins: policyPins } : {}),
        ...(policyOverrides ? { overrides: policyOverrides } : {}),
        ...(mappedPlan ? { pins: mappedPlan.pins, overrides: mappedPlan.overrides } : {}),
        mandatory: [...new Set((opts.include ?? []).map((id) => repIdOf.get(id) ?? id))],
      });
      if (ch) {
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
        if (choiceBlock) return { text: "", log: "skill catalogue: none (skill selection stopped)", canonical, blocked: choiceBlock };
      }
      const leftIds = new Set<string>();
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
        if (held) return { text: "", log: "skill catalogue: none (skill selection stopped)", canonical, blocked: `${CANONICAL_STOP_PREFIX}"${held.id}" is always loaded (skills.selection.include) but it fails a safety gate. Take it off the include list or fix the gate, then run again.` };
      }
      const before = pool.length;
      pool = pool.filter((s) => !leftIds.has(s.id) && needs(s, leftIds) === undefined);
      notCanonical = before - pool.length;
      const mandatoryIds = new Set(mandatoryRoots.map((m) => m.id));
      const broken = [...new Set([...canonical.selected.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : [])), ...mandatoryRoots])]
        .filter((s) => !leftIds.has(s.id) || mandatoryIds.has(s.id))
        .flatMap((s) => {
          const n = needs(s, leftIds);
          return n !== undefined ? [{ id: s.id, needs: n }] : [];
        });
      const stop = canonicalStop(canonical, broken);
      if (stop) return { text: "", log: "skill catalogue: none (skill selection stopped)", canonical, blocked: stop };
    }
    // Mirrors: skills with the same text are offered once. An excluded id takes no part, so it cannot knock out an allowed twin.
    const excludedIds = new Set(skills.catalogue.exclude);
    const mirrors = collapseMirrors(pool.filter((s) => !excludedIds.has(s.id)), (s) => instructionKey(s.pkg), registryRank);
    const dropped = new Set(mirrors.groups.flatMap((g) => g.collapsed));
    const toKept = new Map(mirrors.groups.flatMap((g) => g.collapsed.map((c) => [c.id, g.kept.id] as const)));
    const mirrorCount = dropped.size;
    pool = pool.filter((s) => !dropped.has(s));
    const include = [...new Set(skills.catalogue.include.map((id) => toKept.get(id) ?? id))];
    // Several skills may be requested together: keep only those the resolver admits as one set (conflicts, dependency and count budgets).
    const together = resolveSkills(reg, pool.map((s) => s.id), opts);
    const admitted = new Set(together.decisions.filter((d) => d.outcome === "selected").map((d) => d.id));
    const cat = buildSkillCatalogue({ skills: pool.filter((s) => admitted.has(s.id)) }, { profile, task: i.task, ...catalogueOptionsFrom(skills), ...(mirrorCount ? { include } : {}) });
    const body = [renderSkillCatalogue(cat)];
    if (cat.entries.length) body.push(`Request at most ${skills.selection.max_skills} skills, and only ids listed above.`);
    const text = `<${SKILL_CATALOGUE_TAG}>\n${body.join("\n")}\n</${SKILL_CATALOGUE_TAG}>`;
    const record: RunCatalogueRecord = { entries: cat.entries.length, omitted: cat.omitted, estimatedTokens: estimateTokens(text), ...(hidden ? { hidden } : {}) };
    const left = cat.omitted > 0 ? `, ${cat.omitted} left out` : "";
    const base = cat.entries.length
      ? `skill catalogue: ${cat.entries.length} of ${cat.eligible} skills${left}, about ${record.estimatedTokens} tokens`
      : "skill catalogue: no skills are available";
    const notes = [merged ? `${merged} merged` : "", held ? `${held} held back` : ""].filter(Boolean).join(", ");
    const superseded = applied.filter((a) => a.effect === "superseded").length;
    const due = applied.filter((a) => a.reviewDue).length;
    const extra = superseded || due ? ` (${[superseded ? `${superseded} superseded` : "", due ? `${due} due for review` : ""].filter(Boolean).join(", ")})` : "";
    const choiceNote = applied.length ? `; ${applied.length} owner choice${applied.length === 1 ? "" : "s"} applied${extra}` : "";
    if (applied.length) {
      record.choices = applied.slice(0, CHOICE_LIMITS.recorded);
      if (applied.length > CHOICE_LIMITS.recorded) record.choicesOmitted = applied.length - CHOICE_LIMITS.recorded;
      if (ch?.pins?.state === "ok") record.choicesSource = { pins: ch.pins.source };
    }
    if (mirrorCount) {
      let room: number = MIRROR_LIMITS.recorded;
      const recorded: { kept: string; collapsed: string[] }[] = [];
      for (const g of mirrors.groups) {
        if (room <= 0) break;
        const ids = g.collapsed.slice(0, room).map((c) => `${c.id}@${c.version}`);
        room -= ids.length;
        recorded.push({ kept: `${g.kept.id}@${g.kept.version}`, collapsed: ids });
      }
      record.mirrors = recorded;
      const rest = mirrorCount - (MIRROR_LIMITS.recorded - room);
      if (rest > 0) record.mirrorsOmitted = rest;
    }
    const mirrorNote = mirrorCount ? `; ${mirrorCount} mirror${mirrorCount === 1 ? "" : "s"} collapsed` : "";
    const picked = notCanonical ? `; ${notCanonical} not canonical (skill selection)` : "";
    return {
      text,
      log: `${base}${hidden ? `; ${hidden} hidden (not pinned)` : ""}${notes ? `; ${notes} (skill collisions)` : ""}${mirrorNote}${picked}${choiceNote}`,
      record,
      ...(canonical ? { canonical } : {}),
    };
  } catch {
    return fail("the catalogue could not be built");
  }
}
