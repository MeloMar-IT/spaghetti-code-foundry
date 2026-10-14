import { byteCmp } from "./import-plan.js";
import type { NormalizedSkill } from "./normalize.js";
import { SKILL_ID_RE, type SkillProvider } from "./schema.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";

// Applies the profile of a source (skill-sources.yaml) to a normalized skill: portable capabilities get the catalogue name,
// every other one is prefixed with the provider. Pure: no file system, no clock. Only `package.capabilities` and
// `package.provider` change; provenance keeps what upstream wrote, and digest and fingerprint do not move.

export interface SourceProfileProblem {
  skill: string;
  capability: string;
  message: string;
}

export class SourceProfileError extends Error {
  readonly problems: SourceProfileProblem[];
  constructor(problems: SourceProfileProblem[]) {
    super(`source profile: ${problems.length} problem(s) in skill "${problems[0]?.skill ?? ""}"`);
    this.name = "SourceProfileError";
    this.problems = problems;
  }
}

/** `<provider>-<capability>`, unless the capability already is the provider or starts with `<provider>-`. */
export function vendorCapability(provider: string, capability: string): string {
  return capability === provider || capability.startsWith(provider + "-") ? capability : `${provider}-${capability}`;
}

export function profileSkill(skill: NormalizedSkill, source: SkillLibrarySource): { skill?: NormalizedSkill; problems: SourceProfileProblem[] } {
  const profile = source.profile;
  if (!profile) return { skill, problems: [] };
  const name = shownValue(skill.provenance.name);
  const problems: SourceProfileProblem[] = [];
  const add = (capability: string, message: string) => void problems.push({ skill: name, capability: shownValue(capability), message });

  const map = new Map(profile.portable.map((p) => [p.upstream, p.capability] as const));
  const landed = new Map<string, string>();
  let firstVendor: string | undefined;
  for (const c of [...skill.package.capabilities].sort(byteCmp)) {
    const mapped = map.get(c);
    const out = mapped ?? vendorCapability(profile.provider, c);
    if (mapped === undefined) firstVendor ??= c;
    if (!SKILL_ID_RE.test(out)) {
      add(c, `"${shownValue(out)}" is not a valid capability: it would be longer than 64 characters`);
      continue;
    }
    const other = landed.get(out);
    if (other !== undefined) add(c, `lands on "${out}" like "${shownValue(other)}"`);
    else landed.set(out, c);
  }

  let provider: SkillProvider | undefined = skill.package.provider;
  if (firstVendor !== undefined) {
    const products = profile.products.map((p) => ({ name: p.name, version: p.version }));
    const have = skill.package.provider;
    if (!have) provider = { name: profile.provider, products, tools: [] };
    else if (have.name !== profile.provider) {
      add(firstVendor, `the skill declares provider "${shownValue(have.name)}"; the source profile names "${profile.provider}"`);
    } else {
      provider = {
        name: have.name,
        products: have.products.length ? have.products.map((p) => ({ ...p })) : products,
        tools: [...have.tools],
      };
    }
  }

  if (problems.length) {
    problems.sort((a, b) => byteCmp(a.capability, b.capability) || byteCmp(a.message, b.message));
    return { problems };
  }
  const capabilities = [...landed.keys()].sort(byteCmp);
  return {
    skill: { ...skill, package: { ...skill.package, capabilities, ...(provider ? { provider } : {}) } },
    problems,
  };
}

/** The skill with the profile applied; throws SourceProfileError (all problems) when a slug cannot be built. */
export function applySourceProfile(skill: NormalizedSkill, source: SkillLibrarySource): NormalizedSkill {
  const r = profileSkill(skill, source);
  if (!r.skill) throw new SourceProfileError(r.problems);
  return r.skill;
}
