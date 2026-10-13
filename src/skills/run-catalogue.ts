import type { Config, SkillsConfig } from "../config.js";
import { buildSkillCatalogue, catalogueOptionsFrom, estimateTokens, renderSkillCatalogue } from "./catalogue.js";
import { CATALOGUE_SCORING } from "./catalogue-rules.js";
import { canonicalKey, canonicalStop, selectCanonicalSkills, type CanonicalCandidate, type CanonicalPolicy, type CanonicalResult } from "./canonical.js";
import { CHOICE_LIMITS } from "./choice-rules.js";
import { checkSkillChoices, choiceStop, planSkillChoices, type AppliedChoice, type ChoicePlan, type ChoiceProblem, type SkillOverride } from "./choices.js";
import { dedupeOffered, type CollisionCandidate } from "./collisions.js";
import type { ProjectPinsRead } from "./project-pins.js";
import { discoverSkills, findSkill, type RegisteredSkill, type SkillRegistry } from "./registry.js";
import { buildRepoProfile, type RepoProfile } from "./repo-profile.js";
import { resolveOptionsFrom, resolveSkills } from "./resolve.js";

// The skill catalogue a planner step (`skills: catalog`) gets before its prompt. Synchronous; never throws.
// A skill is offered only when the resolver would select it on its own for the coder, so a pick cannot stop an unattended run.
// A catalogue stops a step only through `blocked`, and only with the `canonical` dependency.

export const SKILL_CATALOGUE_TAG = "foundry-skill-catalogue";
/** The step whose output is the issue text in the shipped flows. */
export const CATALOGUE_ISSUE_STEP = "pull_ticket";

export interface RunCatalogueRecord {
  entries: number;
  omitted: number;
  estimatedTokens: number;
  hidden?: number;
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
      const candidates: CanonicalCandidate[] = [];
      for (const s of judged.values()) {
        const c = deps.canonical.candidate(s);
        if (!c) continue;
        byKey.set(canonicalKey(c), s);
        candidates.push(c);
      }
      canonical = selectCanonicalSkills(candidates, {
        ...deps.canonical.policy,
        ...(plan ? { pins: plan.pins, overrides: plan.overrides } : {}),
        mandatory: opts.include ?? [],
      });
      if (ch) {
        // `plan` is set here: a planning failure is in `known`, and the check below stops on it.
        const checked = plan
          ? checkSkillChoices(plan, canonical, (target) => {
              const s = reg.byKey.get(target);
              return !s ? "missing" : !s.active ? "not-active" : s.trust === "unapproved" ? "unapproved" : "not-usable";
            })
          : { problems: [], applied: [] };
        applied = checked.applied;
        const choiceBlock = choiceStop([...known, ...checked.problems]);
        if (choiceBlock) return { text: "", log: "skill catalogue: none (skill selection stopped)", canonical, blocked: choiceBlock };
      }
      const leftIds = new Set(canonical.left.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!.id] : [])));
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
    // Several skills may be requested together: keep only those the resolver admits as one set (conflicts, dependency and count budgets).
    const together = resolveSkills(reg, pool.map((s) => s.id), opts);
    const admitted = new Set(together.decisions.filter((d) => d.outcome === "selected").map((d) => d.id));
    const cat = buildSkillCatalogue({ skills: pool.filter((s) => admitted.has(s.id)) }, { profile, task: i.task, ...catalogueOptionsFrom(skills) });
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
    const picked = notCanonical ? `; ${notCanonical} not canonical (skill selection)` : "";
    return {
      text,
      log: `${base}${hidden ? `; ${hidden} hidden (not pinned)` : ""}${notes ? `; ${notes} (skill collisions)` : ""}${picked}${choiceNote}`,
      record,
      ...(canonical ? { canonical } : {}),
    };
  } catch {
    return fail("the catalogue could not be built");
  }
}
