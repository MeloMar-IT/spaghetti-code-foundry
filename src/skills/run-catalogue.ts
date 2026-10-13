import type { Config, SkillsConfig } from "../config.js";
import { buildSkillCatalogue, catalogueOptionsFrom, estimateTokens, renderSkillCatalogue } from "./catalogue.js";
import { CATALOGUE_SCORING } from "./catalogue-rules.js";
import { dedupeOffered, type CollisionCandidate } from "./collisions.js";
import { discoverSkills, findSkill, type RegisteredSkill, type SkillRegistry } from "./registry.js";
import { buildRepoProfile, type RepoProfile } from "./repo-profile.js";
import { resolveOptionsFrom, resolveSkills } from "./resolve.js";

// The skill catalogue a planner step (`skills: catalog`) gets before its prompt. Synchronous; never throws.
// A skill is offered only when the resolver would select it on its own for the coder, so a pick cannot stop an unattended run.

export const SKILL_CATALOGUE_TAG = "foundry-skill-catalogue";
/** The step whose output is the issue text in the shipped flows. */
export const CATALOGUE_ISSUE_STEP = "pull_ticket";

export interface RunCatalogueRecord { entries: number; omitted: number; estimatedTokens: number; hidden?: number }
export interface RunCatalogue {
  /** "" when no block is attached. */
  text: string;
  /** One line, no path and no error text. */
  log: string;
  record?: RunCatalogueRecord;
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
  let profile: RepoProfile;
  try {
    if (!i.workdir) return none("the repository could not be read");
    profile = (deps.profile ?? buildRepoProfile)(i.workdir);
  } catch {
    return none("the repository could not be read");
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
      const needsHeld = (root: RegisteredSkill): boolean => {
        const seen = new Set<string>();
        const todo = [root];
        for (let cur = todo.pop(); cur; cur = todo.pop())
          for (const dep of cur.pkg.dependencies ?? []) {
            if (seen.has(dep.id)) continue;
            seen.add(dep.id);
            if (heldIds.has(dep.id)) return true;
            const next = findSkill(reg, dep.id);
            if (next) todo.push(next);
          }
        return false;
      };
      const kept = new Set(d.kept);
      const heldAll = new Set(d.heldItems);
      pool = offered.filter((s) => !heldNow.has(s) && (kept.has(s) || heldAll.has(s)) && !(heldIds.size && needsHeld(s)));
      merged = d.merged;
      held = offered.length - pool.length - merged;
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
    return { text, log: `${base}${hidden ? `; ${hidden} hidden (not pinned)` : ""}${notes ? `; ${notes} (skill collisions)` : ""}`, record };
  } catch {
    return none("the catalogue could not be built");
  }
}
