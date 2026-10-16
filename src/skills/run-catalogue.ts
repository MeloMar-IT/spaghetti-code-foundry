import type { Config, SkillsConfig } from "../config.js";
import { buildSkillCatalogue, catalogueOptionsFrom, estimateTokens, renderSkillCatalogue } from "./catalogue.js";
import { CATALOGUE_SCORING } from "./catalogue-rules.js";
import type { CanonicalResult } from "./canonical.js";
import { CHOICE_LIMITS } from "./choice-rules.js";
import type { AppliedChoice } from "./choices.js";
import { dedupeOffered, type CollisionCandidate } from "./collisions.js";
import { discoverSkills, findSkill, type RegisteredSkill, type SkillRegistry } from "./registry.js";
import { buildRepoProfile, type RepoProfile } from "./repo-profile.js";
import { collapseMirrors, instructionKey, MIRROR_LIMITS, registryRank } from "./mirrors.js";
import { resolveOptionsFrom, resolveSkills } from "./resolve.js";
import { canonicalRecord, checkCanonical, choicesUnchecked, needsAny, startChoices, usableFor, withDependencies, type CanonicalDeps, type CanonicalSelectionRecord } from "./run-canonical.js";

// The skill catalogue a planner step (`skills: catalog`) gets before its prompt. Synchronous; never throws.
// A skill is offered only when the resolver would select it on its own for the coder, so a pick cannot stop an unattended run.
// A catalogue stops a step only through `blocked`, and only with the `canonical` dependency.
// Skills with the same description and instructions (mirrors) are offered once: the best tier, then id, then version. With the
// `canonical` dependency, copies with the same safety profile are merged before the selection; every package keeps its own gate check.
// Complementary providers that both declare the capability composable are offered after the winner, and only while the budget allows it.

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
  /** The canonical choice per exclusive capability: ids, versions and codes only. Absent without canonical dependencies or a decision. */
  canonical?: CanonicalSelectionRecord[];
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
  /** Default: none. Picks one skill per exclusive capability (canonical.ts). Runs supply it through liveCanonicalDeps when skills.selection.exclusive is set. */
  canonical?: CanonicalDeps;
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
  const start = startChoices(deps.canonical);
  const fail = (why: string): RunCatalogue => {
    const blocked = choicesUnchecked(start);
    return blocked === undefined ? none(why) : { text: "", log: "skill catalogue: none (skill selection stopped)", blocked };
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
    const usable = usableFor(reg, opts);
    const hypo = pinnedCopy(reg);
    const usableHypo = usableFor(hypo, opts);
    const offered: RegisteredSkill[] = [];
    let hidden = 0;
    for (const s of reg.skills) {
      if (!s.active || s.trust === "unapproved") continue;
      if (usable(s)) offered.push(s);
      else if (usableHypo(hypo.byKey.get(s.key)!)) hidden++;
    }
    const needs = (root: RegisteredSkill, ids: ReadonlySet<string>) => needsAny(reg, root, ids);
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
    let canonicalRec: CanonicalSelectionRecord[] | undefined;
    let later: string[] = [];
    let notCanonical = 0;
    let applied: AppliedChoice[] = [];
    if (deps.canonical) {
      // The resolver always loads the mandatory ids too, so they and their dependencies are judged as well.
      const mandatoryRoots = (opts.include ?? []).flatMap((id) => { const m = findSkill(reg, id); return m ? [m] : []; });
      const check = checkCanonical({ reg, judged: withDependencies(reg, [...pool, ...mandatoryRoots]), mandatory: opts.include ?? [], deps: deps.canonical, start });
      canonical = check.canonical;
      applied = check.applied;
      later = check.companions;
      if (check.blocked) return { text: "", log: "skill catalogue: none (skill selection stopped)", canonical, blocked: check.blocked };
      const before = pool.length;
      pool = pool.filter((s) => !check.left.has(s.id) && needsAny(reg, s, check.left) === undefined);
      notCanonical = before - pool.length;
      const rec = canonicalRecord(canonical);
      if (rec.length) canonicalRec = rec;
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
    const together = resolveSkills(reg, pool.map((s) => s.id), later.length ? { ...opts, later } : opts);
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
    if (canonicalRec) record.canonical = canonicalRec;
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
