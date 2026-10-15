import { lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { OVERRIDES_FILE } from "./choice-rules.js";
import { planSkillChoices } from "./choices.js";
import { compareFailed, compareLines, compareWithBuiltins, type BuiltinSkill } from "./compare.js";
import { communityPromotionCheck, communityPromotionLines, type FixtureResult } from "./community-promotion.js";
import { COMMUNITY_FIXTURE_KIND, COMPARE_BUILTINS } from "./community-rules.js";
import { byteCmp, SkillImportError } from "./import-plan.js";
import { reviewImport } from "./licence-review.js";
import { normalizeImport, type NormalizedSkill } from "./normalize.js";
import { findProfileEvaluation, PROFILE_EVALUATIONS_FILE, readProfileEvaluations, type ProfileEvaluationRecord } from "./profile-evaluations.js";
import { NO_EVIDENCE_TIME } from "./promotion.js";
import { scanSkill } from "./scan.js";
import type { ScanException } from "./scan-exceptions.js";
import { filesOf, loadExceptions, type StagedImport } from "./staged-import.js";
import { loadSkillPackage, readRegular } from "./package.js";
import { readChoiceFile } from "./project-pins.js";
import { BUILTIN_SKILLS } from "./registry.js";
import { UNRESOLVED_HIGH_RISK_DEFAULT } from "./resolve-rules.js";
import { shownValue } from "./sources.js";

type FileEntry = { path: string; content: Uint8Array };

const FILE_LIMIT = 4 * 1048576;
const FILES_MAX = 500;

/** Every regular file below `dir`, with its original bytes. Links and other entries are left out. */
function readTree(dir: string): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (abs: string, rel: string) => {
    for (const d of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length > FILES_MAX) return;
      const path = rel ? `${rel}/${d.name}` : d.name;
      const full = join(abs, d.name);
      const st = lstatSync(full);
      if (st.isDirectory()) walk(full, path);
      else if (st.isFile()) {
        const r = readRegular(full, FILE_LIMIT);
        if (typeof r !== "string") out.push({ path, content: r });
      }
    }
  };
  walk(dir, "");
  return out;
}

class BuiltinReadError extends Error {
  constructor(readonly id: string) {
    super(`the built-in skill ${id} cannot be read`);
  }
}

/** The built-in skills to compare with, straight from their folders: no configuration, data folder or lock file is read. */
export function loadBuiltins(root: string): BuiltinSkill[] {
  const skills: BuiltinSkill[] = [];
  for (const id of COMPARE_BUILTINS) {
    const dir = join(root, id);
    try {
      const pkg = loadSkillPackage(dir);
      const key = `${pkg.id}@${pkg.version}`;
      skills.push({ key, id: pkg.id, version: pkg.version, source: "builtin", label: "built-in", dir, active: true, trust: "builtin", pin: "unpinned", digest: pkg.digest, pkg, files: readTree(dir) });
    } catch {
      throw new BuiltinReadError(id);
    }
  }
  return skills;
}

function fixtureResults(records: readonly ProfileEvaluationRecord[], skills: readonly NormalizedSkill[], today: string): Record<string, FixtureResult> {
  const results: Record<string, FixtureResult> = {};
  for (const s of skills) {
    const found = findProfileEvaluation(records, s.package.id, COMMUNITY_FIXTURE_KIND, s.package.digest, today);
    if (found.state === "passed" || found.state === "failed") results[s.package.id] = found.state;
  }
  return results;
}

/**
 * `scf skills compare`, after the staged import was read and proven: normalizes it, compares it with the built-in java and
 * spring-boot skills and prints the report. For a `trust: community` source it also prints PROMOTABLE or REFUSED per candidate
 * (communityPromotionCheck), from the licence evidence of the staged import, skill-scan-exceptions.yaml and the `kind: fixtures`
 * records of skill-profile-evaluations.yaml. Reads only. Returns 1 for a conflict, a blocking collision or a PROBLEM, and for a
 * community source also for a refused candidate or an entry that did not normalize.
 */
export function compareStaged(
  staged: Pick<StagedImport, "source" | "commit" | "record" | "files" | "licence">,
  out: (line: string) => void,
  opts: { cwd: string; now: Date; today: string; builtinRoot?: string },
): number {
  const { source, record, files } = staged;
  const community = source.trust === "community";

  let builtins: BuiltinSkill[];
  try {
    builtins = loadBuiltins(opts.builtinRoot ?? BUILTIN_SKILLS);
  } catch (e) {
    if (!(e instanceof BuiltinReadError)) throw e;
    out(`PROBLEM ${e.message}`);
    return 1;
  }

  const read = readChoiceFile(resolve(opts.cwd, OVERRIDES_FILE), "overrides");
  if (read.state === "invalid") {
    for (const p of read.problems) out(`PROBLEM ${p.where}: ${p.message}`);
    return 1;
  }
  const exclusive = [...new Set(builtins.flatMap((s) => s.pkg.capabilities ?? []))];
  // No repository is given, so only the overrides of scope all apply.
  const overrides = read.state === "ok" ? planSkillChoices({ overrides: read.items, now: opts.now, exclusive }).overrides : {};

  let exceptions: ScanException[] = [];
  let evaluations: ProfileEvaluationRecord[] = [];
  if (community) {
    const ex = loadExceptions(undefined, out, { cwd: opts.cwd, today: opts.today });
    const ev = readProfileEvaluations(resolve(opts.cwd, PROFILE_EVALUATIONS_FILE), opts.today);
    if (ev.state === "invalid") for (const p of ev.problems) out(`PROBLEM ${PROFILE_EVALUATIONS_FILE} ${p.where}: ${p.message}`);
    else if (ev.state === "ok") evaluations = ev.manifest.evaluations;
    if (ex === undefined || ev.state === "invalid") return 1;
    exceptions = ex;
  }

  try {
    const prep = { record: { ...record, rejected: [] }, files };
    const review = community
      ? reviewImport({
        allow: source.licence.allow,
        prep,
        evidence: staged.licence ?? { repositoryKey: record.repositoryKey, commit: record.commit, files: [] },
      })
      : undefined;
    const { skills, report: norm } = review ? review.normalized : normalizeImport(prep);
    const report = compareWithBuiltins({
      source, skills, builtins, overrides, highRisk: UNRESOLVED_HIGH_RISK_DEFAULT,
    });
    const lines = compareLines(report, norm.quarantined);
    let refused = false;
    if (review) {
      const scans = Object.fromEntries(skills.map((s) => [s.package.id, scanSkill({ root: s.provenance.root, files: filesOf(s.provenance.root, files) })]));
      const decisions = communityPromotionCheck({
        source, record, skills, evidence: review.evidence, retrievedAt: record.retrievedAt ?? NO_EVIDENCE_TIME,
        licenceReview: review, scans, exceptions, today: opts.today, builtins, overrides,
        highRisk: UNRESOLVED_HIGH_RISK_DEFAULT, fixtures: fixtureResults(evaluations, skills, opts.today),
      });
      const normalized = new Set(skills.map((s) => s.provenance.root));
      const missing = record.skills
        .filter((s) => !normalized.has(s.root))
        .map((s) => `REFUSED ${shownValue(s.root)}: not-normalized`)
        .sort(byteCmp);
      lines.splice(lines.length - 1, 0, ...communityPromotionLines(decisions), ...missing);
      refused = decisions.some((d) => d.decision === "refused") || missing.length > 0;
    }
    for (const line of lines) out(line);
    return compareFailed(report) || refused ? 1 : 0;
  } catch (e) {
    if (e instanceof SkillImportError) {
      out(`PROBLEM ${shownValue(e.message)}`);
      return 1;
    }
    throw e;
  }
}
