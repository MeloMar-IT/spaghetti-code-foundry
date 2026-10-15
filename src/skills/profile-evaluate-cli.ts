import { resolve } from "node:path";
import { evaluateProfileCandidates, type ProfileCandidateResult } from "./profile-evaluate.js";
import { PROFILE_EVALUATIONS_FILE, readProfileEvaluations, type ProfileEvaluationRecord } from "./profile-evaluations.js";
import type { ScanException } from "./scan-exceptions.js";
import { PROFILES_FILE, readSourceProfiles, type SourceProfile } from "./source-profiles.js";
import { loadExceptions, plural, stagedImport } from "./staged-import.js";

// `scf skills profiles evaluate`: offline and read-only. Reads the files, prints PASS or BLOCKED per staged skill.
// It writes nothing, promotes nothing, takes no lock and reads no environment variable or credential.

const list = (a: readonly string[]) => (a.length ? a.join(",") : "-");

function head(c: ProfileCandidateResult): string {
  const p = c.profile;
  const label = `${c.id ?? c.root} (${c.name})`;
  return `${label} ${p?.class ?? "-"} capabilities=${list(p?.capabilities ?? [])} high_risk=${list(p?.high_risk ?? [])}`;
}

/** Returns 1 when a candidate is blocked or a PROBLEM was printed. */
export function profilesEvaluate(id: string, out: (line: string) => void, opts: { cwd: string; home?: string; today: string }): number {
  let exceptions: ScanException[] = [];
  let profile: SourceProfile | undefined;
  let records: ProfileEvaluationRecord[] = [];
  const staged = stagedImport(
    id,
    out,
    opts,
    () => {
      let ok = true;
      const read = loadExceptions(undefined, out, opts);
      if (read) exceptions = read;
      else ok = false;
      const profiles = readSourceProfiles(resolve(opts.cwd, PROFILES_FILE));
      if (profiles.state === "none") {
        out("PROBLEM the source profile file does not exist");
        ok = false;
      } else if (profiles.state === "invalid") {
        for (const p of profiles.problems) out(`PROBLEM ${PROFILES_FILE} ${p.where}: ${p.message}`);
        ok = false;
      } else profile = profiles.profiles.sources.find((s) => s.id === id);
      const evaluations = readProfileEvaluations(resolve(opts.cwd, PROFILE_EVALUATIONS_FILE), opts.today);
      if (evaluations.state === "invalid") {
        for (const p of evaluations.problems) out(`PROBLEM ${PROFILE_EVALUATIONS_FILE} ${p.where}: ${p.message}`);
        ok = false;
      } else if (evaluations.state === "ok") records = evaluations.manifest.evaluations;
      return ok;
    },
    "evaluated",
  );
  if (!staged) return 1;
  const { source, commit, record } = staged;

  const result = evaluateProfileCandidates({ source, staged, profile, exceptions, evaluations: records, today: opts.today });
  let pass = 0;
  let blocked = 0;
  for (const c of result.candidates) {
    const digest = c.digest ? ` ${c.digest}` : "";
    if (c.reasons.length === 0) {
      pass++;
      out(`PASS ${head(c)}${digest}`);
    } else {
      blocked++;
      out(`BLOCKED ${head(c)}${digest}: ${c.reasons.map((r) => `${r.gate}: ${r.text}`).join("; ")}`);
    }
    if (c.profile && (c.needs.config.length > 0 || c.needs.live_services.length > 0)) {
      out(`NEEDS ${c.id ?? c.root} config=${list(c.needs.config)} live_services=${list(c.needs.live_services)}`);
    }
  }
  for (const name of result.missing) out(`MISSING ${source.id}/${name}: in skill-source-profiles.yaml, not staged`);
  out(`EVALUATED ${plural(record.skills.length, "skill")} from ${source.repositoryKey}@${commit.slice(0, 12)} ${record.digest}: ${pass} pass, ${blocked} blocked, ${result.missing.length} missing`);
  return blocked > 0 ? 1 : 0;
}
