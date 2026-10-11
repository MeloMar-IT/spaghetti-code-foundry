import type { Config, SkillsConfig } from "../config.js";
import { buildSkillCatalogue, catalogueOptionsFrom, estimateTokens, renderSkillCatalogue } from "./catalogue.js";
import { CATALOGUE_SCORING } from "./catalogue-rules.js";
import { discoverSkills, type RegisteredSkill, type SkillRegistry } from "./registry.js";
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
    // Several skills may be requested together: keep only those the resolver admits as one set (conflicts, dependency and count budgets).
    const together = resolveSkills(reg, offered.map((s) => s.id), opts);
    const admitted = new Set(together.decisions.filter((d) => d.outcome === "selected").map((d) => d.id));
    const cat = buildSkillCatalogue({ skills: offered.filter((s) => admitted.has(s.id)) }, { profile, task: i.task, ...catalogueOptionsFrom(skills) });
    const body = [renderSkillCatalogue(cat)];
    if (cat.entries.length) body.push(`Request at most ${skills.selection.max_skills} skills, and only ids listed above.`);
    const text = `<${SKILL_CATALOGUE_TAG}>\n${body.join("\n")}\n</${SKILL_CATALOGUE_TAG}>`;
    const record: RunCatalogueRecord = { entries: cat.entries.length, omitted: cat.omitted, estimatedTokens: estimateTokens(text), ...(hidden ? { hidden } : {}) };
    const left = cat.omitted > 0 ? `, ${cat.omitted} left out` : "";
    const base = cat.entries.length
      ? `skill catalogue: ${cat.entries.length} of ${cat.eligible} skills${left}, about ${record.estimatedTokens} tokens`
      : "skill catalogue: no skills are available";
    return { text, log: `${base}${hidden ? `; ${hidden} hidden (not pinned)` : ""}`, record };
  } catch {
    return none("the catalogue could not be built");
  }
}
