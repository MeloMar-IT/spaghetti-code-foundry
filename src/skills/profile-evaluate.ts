import { exclusionReasons } from "./import-exclusions.js";
import { evaluateLicence } from "./licence.js";
import { findProfileEvaluation, type ProfileEvaluationRecord } from "./profile-evaluations.js";
import { dayNumber, type ScanException } from "./scan-exceptions.js";
import { scanStaged } from "./scan-staged.js";
import type { SkillRisk } from "./schema.js";
import type { SkillProfile, SourceProfile } from "./source-profiles.js";
import { hidden, type StagedImport } from "./staged-import.js";
import { shownValue, type SkillLibrarySource } from "./sources.js";
import { skillNeeds } from "./tool-policy.js";

// The gates a staged skill of a profiled source must pass before promotion. Pure: no file system, no clock, no process.
// A report, not a promotion: it grants nothing and does not replace `scf skills promote check`.

export const PROFILE_GATES = ["declared", "licence", "security", "requirements", "evaluation"] as const;
export type ProfileGate = (typeof PROFILE_GATES)[number];

export interface ProfileCandidateResult {
  /** shownValue of the full upstream root. */
  root: string;
  /** The upstream name, shown safely. */
  name: string;
  /** The package id, when the skill normalized. */
  id?: string;
  /** package.digest, when the skill normalized. */
  digest?: string;
  /** The package version, category and risk, when the skill normalized. */
  version?: string;
  category?: string;
  risk?: SkillRisk;
  /** Absent: not declared. */
  profile?: SkillProfile;
  /** Empty means PASS. Ordered by PROFILE_GATES. */
  reasons: { gate: ProfileGate; text: string }[];
  /** Names from the profile; empty when not declared. */
  needs: { config: string[]; live_services: string[] };
}

export interface ProfileEvaluateInput {
  source: SkillLibrarySource;
  staged: Pick<StagedImport, "record" | "files" | "licence">;
  /** The entry of this source in skill-source-profiles.yaml, if any. */
  profile: SourceProfile | undefined;
  exceptions: readonly ScanException[];
  evaluations: readonly ProfileEvaluationRecord[];
  today: string;
}

export interface ProfileEvaluation {
  candidates: ProfileCandidateResult[];
  /** Profile skill names that no staged skill has, in profile order. */
  missing: string[];
}

const EVALUATION_TEXT = {
  "not-recorded": "not recorded",
  failed: "failed",
  expired: "expired",
  "other-digest": "recorded for another digest",
} as const;

export function evaluateProfileCandidates(input: ProfileEvaluateInput): ProfileEvaluation {
  const { source, staged, profile, exceptions, evaluations, today } = input;
  if (dayNumber(today) === undefined) throw new TypeError("today must be a date like 2026-10-13");
  const { skills } = scanStaged(staged, exceptions, today);
  const candidates: ProfileCandidateResult[] = [];
  const seen = new Set<string>();

  for (const scanned of skills) {
    const { entry, skill } = scanned;
    const pkg = skill?.package;
    const declared = profile?.skills.find((s) => s.name === entry.name);
    const result: ProfileCandidateResult = {
      root: shownValue(entry.root),
      name: shownValue(entry.name),
      ...(pkg ? { id: pkg.id, digest: pkg.digest, version: pkg.version, category: pkg.category, risk: pkg.risk } : {}),
      ...(declared ? { profile: declared } : {}),
      reasons: [],
      needs: { config: declared ? [...declared.requires.config] : [], live_services: declared ? [...declared.requires.live_services] : [] },
    };
    candidates.push(result);
    const add = (gate: ProfileGate, text: string) => void result.reasons.push({ gate, text });
    if (!declared) {
      add("declared", "not in skill-source-profiles.yaml");
      continue;
    }
    seen.add(declared.name);

    // licence
    if (!staged.licence) add("licence", `no licence evidence; run "scf skills import ${source.id}" again`);
    else {
      const verdict = evaluateLicence({
        root: entry.root,
        ...(pkg?.license ? { declared: pkg.license } : {}),
        allow: source.licence.allow,
        evidence: staged.licence,
      });
      if (verdict.status !== "allowed") add("licence", `${verdict.status} (${verdict.reasons.map(hidden).join("; ")})`);
    }

    // security: the same decision as `scf skills scan`
    if (!skill || !pkg) {
      add("security", `not normalized (${scanned.quarantine.map(hidden).join("; ")})`);
      continue;
    }
    const n = scanned.blockers.length;
    if (n > 0) add("security", `${n} high ${n === 1 ? "finding" : "findings"}`);
    if (scanned.exclusions.length > 0) add("security", `excluded (${exclusionReasons(scanned.exclusions).map(hidden).join("; ")})`);

    // requirements: every need of the package must be declared
    for (const need of skillNeeds(pkg)) {
      if (need.startsWith("connector:")) {
        const c = need.slice("connector:".length);
        if (!declared.requires.connectors.includes(c)) add("requirements", `needs the connector ${shownValue(c)}, not in requires.connectors`);
      } else if (!(declared.requires.tools as readonly string[]).includes(need)) {
        add("requirements", `needs ${need}, not in requires.tools`);
      }
    }

    // evaluation: one passed record per kind, for this exact digest
    for (const kind of declared.evaluations) {
      const found = findProfileEvaluation(evaluations, pkg.id, kind, pkg.digest, today);
      if (found.state !== "passed") add("evaluation", `${kind} ${EVALUATION_TEXT[found.state]}`);
    }
  }

  const missing = (profile?.skills ?? []).filter((s) => !seen.has(s.name)).map((s) => s.name);
  return { candidates, missing };
}
