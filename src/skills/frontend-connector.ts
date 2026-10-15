import { evaluationState, declaredVersion, UNKNOWN_VERSION, type EvaluationResult } from "./connector.js";
import {
  FRONTEND_GROUP_CATEGORY,
  FRONTEND_PROFILES,
  type FrontendBlock,
  type FrontendGroup,
  type FrontendProfile,
} from "./frontend-rules.js";
import { byteCmp, importDigest, type ImportRecord, type RejectedSkill } from "./import-plan.js";
import type { NormalizedSkill } from "./normalize.js";
import type { RepoProfile } from "./repo-profile.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";

// Applies a reviewed frontend profile to a source evaluation. Pure: no file, no process, no network.
// Selection happens before normalization, and the profile is authoritative: its capabilities and technologies replace upstream's.

export interface FrontendRecord {
  profile: string;
  root: string;
  group: FrontendGroup;
  reviewed: boolean;
  evaluation: "passed" | "failed" | "missing";
  evaluations: string[];
  hold?: string;
  tokens: number;
  maxTokens: number;
  blocked: FrontendBlock[];
}

export function frontendProfileFor(repositoryKey: string): FrontendProfile | undefined {
  return FRONTEND_PROFILES.find((p) => p.repositoryKey === repositoryKey);
}

const isRoot = (profile: FrontendProfile, root: string) => Object.prototype.hasOwnProperty.call(profile.skills, root);

/** A staged skill is selected only at exactly a profile root; a rejection when it is at, below or above one. */
export function frontendSelection(profile: FrontendProfile, root: string, kind: "staged" | "rejected"): "selected" | "not-selected" {
  if (isRoot(profile, root)) return "selected";
  if (kind === "staged") return "not-selected";
  for (const r of Object.keys(profile.skills)) {
    if (root === "." || r.startsWith(root + "/") || root.startsWith(r + "/")) return "selected";
  }
  return "not-selected";
}

const underPath = (root: string, p: string) => root === p || root.startsWith(p + "/");

/** The record with only the selected skills and rejections. Never changes its input. */
export function partitionRecord(profile: FrontendProfile, record: ImportRecord): { record: ImportRecord; notSelected: string[]; missing: string[] } {
  const skills = record.skills.filter((s) => frontendSelection(profile, s.root, "staged") === "selected");
  const rejected = record.rejected.filter((r) => frontendSelection(profile, r.root, "rejected") === "selected");
  const notSelected = [
    ...new Set([
      ...record.skills.filter((s) => !skills.includes(s)).map((s) => s.root),
      ...record.rejected.filter((r) => !rejected.includes(r)).map((r) => r.root),
    ]),
  ].sort(byteCmp);
  const missing = Object.keys(profile.skills)
    .filter((r) => record.paths.some((p) => underPath(r, p)) && !record.skills.some((s) => s.root === r) && !record.rejected.some((x) => x.root === r))
    .sort(byteCmp);
  const sorted = [...skills].sort((a, b) => byteCmp(a.root, b.root));
  return {
    record: { ...record, skills: sorted, rejected: [...rejected].sort((a, b) => byteCmp(a.root, b.root)), digest: importDigest(sorted) },
    notSelected,
    missing,
  };
}

export function frontendBlocked(r: Pick<FrontendRecord, "reviewed" | "evaluation" | "hold" | "tokens" | "maxTokens">): FrontendBlock[] {
  const out: FrontendBlock[] = [];
  if (!r.reviewed) out.push("unreviewed");
  if (r.evaluation !== "passed") out.push("evaluation");
  if (r.hold !== undefined) out.push("hold");
  if (r.tokens > r.maxTokens) out.push("too-large");
  return out;
}

/** The skill with the capabilities, technologies and category of its rule. Digest, id and fingerprint stay. */
export function applyFrontendRule(
  profile: FrontendProfile,
  skill: NormalizedSkill,
  results: readonly EvaluationResult[],
): { skill: NormalizedSkill; record: FrontendRecord } {
  const { package: pkg, provenance } = skill;
  if (provenance.repositoryKey !== profile.repositoryKey) throw new TypeError("the skill does not come from the repository of this profile");
  if (!isRoot(profile, provenance.root)) throw new TypeError("the profile has no rule for this folder");
  const rule = profile.skills[provenance.root]!;
  const state = evaluationState({ id: pkg.id, digest: pkg.digest, evaluations: [...rule.evaluations] }, results).state;
  const evaluation = state === "not-required" ? "missing" : state;
  const reviewed = rule.reviewed.includes(pkg.digest);
  const tokens = provenance.context.instructions;
  const base = { reviewed, evaluation, hold: rule.hold, tokens, maxTokens: profile.maxSkillTokens } as const;
  return {
    skill: {
      ...skill,
      package: { ...pkg, category: FRONTEND_GROUP_CATEGORY[rule.group], capabilities: [...rule.capabilities].sort(byteCmp) },
      provenance: { ...provenance, technologies: rule.technologies.map((t) => ({ ...t })).sort((a, b) => byteCmp(a.name, b.name)) },
    },
    record: {
      profile: profile.id,
      root: provenance.root,
      group: rule.group,
      reviewed,
      evaluation,
      evaluations: [...rule.evaluations],
      ...(rule.hold !== undefined ? { hold: rule.hold } : {}),
      tokens,
      maxTokens: profile.maxSkillTokens,
      blocked: frontendBlocked(base),
    },
  };
}

/** What a scan left out that could hide a conflicting version. */
export function repoScanGaps(repo: Pick<RepoProfile, "truncated" | "skipped">): string[] {
  const out: string[] = [];
  if (repo.truncated.files) out.push("too many files or folders");
  if (repo.truncated.bytes) out.push("too many bytes");
  if (repo.truncated.findings) out.push("too many findings");
  if ((repo.skipped.other ?? 0) > 0) out.push("unreadable entries");
  return out;
}

/** Versions of the profile's technologies from package.json dependencies. Throws when the scan is incomplete. */
export function frontendEvidence(profile: FrontendProfile, repo: Pick<RepoProfile, "findings" | "truncated" | "skipped">): { name: string; version: string }[] {
  const gaps = repoScanGaps(repo);
  if (gaps.length) throw new TypeError(`the scan is incomplete: ${gaps.join(", ")}`);
  const seen = new Map<string, Set<string>>();
  for (const f of repo.findings) {
    if (f.kind !== "dependency" || !profile.evidence.includes(f.name)) continue;
    if (f.path.slice(f.path.lastIndexOf("/") + 1) !== "package.json") continue;
    const set = seen.get(f.name) ?? new Set<string>();
    set.add(declaredVersion(f.value) ?? UNKNOWN_VERSION);
    seen.set(f.name, set);
  }
  return [...seen.entries()]
    .map(([name, set]) => ({ name, version: set.size === 1 ? [...set][0]! : UNKNOWN_VERSION }))
    .sort((a, b) => byteCmp(a.name, b.name));
}

/** The report of an import that staged nothing. */
export function emptyImportLines(
  profile: FrontendProfile,
  source: Pick<SkillLibrarySource, "paths" | "repositoryKey">,
  commit: string,
  rejected: readonly RejectedSkill[],
): string[] {
  const out: string[] = [];
  let refused = 0;
  for (const r of [...rejected].sort((a, b) => byteCmp(a.root, b.root))) {
    if (frontendSelection(profile, r.root, "rejected") === "selected") {
      refused++;
      out.push(`REFUSED ${shownValue(r.root)}: ${r.reasons.map(shownValue).join(", ")}`);
    } else {
      out.push(`NOT-SELECTED ${shownValue(r.root)}: the profile does not select it; not evaluated`);
    }
  }
  for (const root of Object.keys(profile.skills).sort(byteCmp)) {
    if (source.paths.some((p) => underPath(root, p)) && !rejected.some((x) => x.root === root)) {
      out.push(`MISSING ${root}: the profile selects it; the import does not have it`);
    }
  }
  out.push(`EVALUATED 0 skills from ${source.repositoryKey}@${commit.slice(0, 12)}: ${refused} refused, 0 conflicts`);
  return out;
}
