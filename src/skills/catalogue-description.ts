import { createHash } from "node:crypto";
import { CATALOGUE_DETAIL } from "./catalogue-rules.js";
import { credentialProblem } from "./credential-scan.js";
import type { NormalizedSkill } from "./normalize.js";
import { hasUnsafeChar, type SourceProblem, type SourcesManifest } from "./sources.js";

// A short catalogue description the owner sets for one reviewed skill (`catalogue_description` in skill-selections.yaml).
// Pure: no file system. It imports nothing that imports release.ts. The text reaches runs only through a published release.

export const CATALOGUE_DESCRIPTION_MAX = CATALOGUE_DETAIL.full.descriptionChars;
export const CATALOGUE_DESCRIPTION_FROM = "skill-selections" as const;
/** The name of the evidence entry of an evaluation record that holds the digest of the scored description. */
export const DESCRIPTION_EVIDENCE = "catalogue-description";

export interface DescriptionOverrideLike {
  source: string;
  skill: string;
  digest: string;
  catalogueDescription?: string;
}

/** Undefined when the text may be shown: 1–160 characters, trimmed, no control, invisible or lone surrogate character, no credential. */
export function catalogueDescriptionProblem(text: string): string | undefined {
  if (typeof text !== "string") return "must be text";
  if (text.trim().length === 0) return "must not be empty";
  if (text !== text.trim()) return "must not start or end with a space";
  if (text.length > CATALOGUE_DESCRIPTION_MAX) return `must be at most ${CATALOGUE_DESCRIPTION_MAX} characters (it has ${text.length})`;
  if (hasUnsafeChar(text) || /\p{Cs}/u.test(text)) return "holds a control or invisible character";
  const rule = credentialProblem(text);
  if (rule) return `holds what looks like a credential (${rule})`;
  return undefined;
}

/** The override for this staged skill: same source id, upstream name and package digest. */
export function catalogueDescriptionOf(skill: NormalizedSkill, sourceId: string, selections: readonly DescriptionOverrideLike[]): string | undefined {
  const sel = selections.find((s) => s.source === sourceId && s.skill === skill.provenance.name && s.digest === skill.package.digest);
  return sel?.catalogueDescription;
}

export function descriptionEvidence(text: string): { name: string; digest: string } {
  return { name: DESCRIPTION_EVIDENCE, digest: `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}` };
}

export interface OverrideCheckDeps {
  sources: SourcesManifest | { problem: string };
  /** Normalized skills of the staged import at that commit; undefined when there is none or it does not match import.json. */
  staged: (sourceId: string, commit: string) => readonly NormalizedSkill[] | undefined;
}

/** One problem per override that is not approved or not staged; [] when no entry has an override. */
export function descriptionOverrideProblems(selections: readonly DescriptionOverrideLike[], deps: OverrideCheckDeps): SourceProblem[] {
  const out: SourceProblem[] = [];
  selections.forEach((s, i) => {
    if (s.catalogueDescription === undefined) return;
    const where = `selections[${i}] (${s.source}/${s.skill}) catalogue_description`;
    const add = (message: string) => void out.push({ where, message });
    if ("problem" in deps.sources) return add(`cannot be checked: skill-sources.yaml ${deps.sources.problem}`);
    const source = deps.sources.sources.find((x) => x.id === s.source);
    if (!source) return add("names a source that is not in skill-sources.yaml");
    const commit = source.ref.approved;
    if (source.status !== "enabled" || !commit) {
      return add(`the source ${source.id} is ${source.status !== "enabled" ? source.status : "enabled but has no approved commit"}; only an enabled, approved source can set a catalogue description`);
    }
    const skills = deps.staged(source.id, commit);
    if (!skills?.some((k) => k.provenance.name === s.skill && k.package.digest === s.digest)) {
      add(`no staged skill ${s.skill} with this digest at ${commit.slice(0, 12)}; run "scf skills import ${source.id}" or update the entry`);
    }
  });
  return out;
}
