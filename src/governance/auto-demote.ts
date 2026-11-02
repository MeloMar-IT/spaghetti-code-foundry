import { z } from "zod";
import { repoIdsOf } from "../auth/repos.js";
import { MONITOR_ACTOR } from "../auth/audit.js";
import { StoreError } from "../auth/store.js";
import { breakGlassReasonProblem } from "../engine/policy-break-glass.js";
import { cleanText, type Finding } from "../monitor/findings.js";
import { credentialProblem } from "../skills/credential-scan.js";
import { AutonomyError, levelIn, readAutonomy, AUTONOMY_REASON_MAX, type AutonomyKind } from "./autonomy-store.js";
import { AutonomyRefused, demoteLevel, type ComponentRef } from "./autonomy-change.js";
import { previousLevel, type AutonomyLevel } from "./autonomy.js";

/**
 * The monitor lowers a component by one level for a new serious finding that names it (#647). A new `critical` finding from any
 * detector does it, and a new `major` one from the detectors below. Which findings are new is decided by `mergeFindings` (its
 * `fresh` list); what is still to do for one finding is kept on the finding itself (`autoDemote.left`), so the state of a
 * finding is never read from the audit log or from the reason of a stored level. Each key (one record of a repository, or a
 * flow) is taken out of `left` and the findings are saved before its level is lowered: a crash loses one demotion and never
 * repeats one, and a failure on one record never repeats or loses another.
 */

/** Detectors whose `major` findings also lower a level: the policy service and the evidence records are the controls themselves. */
export const AUTO_DEMOTE_DETECTORS: readonly string[] = ["policy-service-failure", "evidence-finalization"];

export const demotesOn = (f: Pick<Finding, "severity" | "detector">): boolean =>
  f.severity === "critical" || (f.severity === "major" && AUTO_DEMOTE_DETECTORS.includes(f.detector));

/** The components a finding names, as `repos:<owner/name, lower case>` and `flows:<name>`, each once. */
export function componentsOf(f: Pick<Finding, "repo" | "evidence">): string[] {
  const keys = new Set<string>();
  const repos = [f.repo, ...(Array.isArray(f.evidence?.repos) ? f.evidence.repos : [])];
  for (const r of repos) if (typeof r === "string" && r.trim()) keys.add(`repos:${r.trim().toLowerCase()}`);
  const flows = Array.isArray(f.evidence?.flows) ? f.evidence.flows : [];
  for (const n of flows) if (typeof n === "string" && n.trim()) keys.add(`flows:${n}`);
  return [...keys].slice(0, 20);
}

/** The reason of the audit line: display only, never used to tell findings apart. Falls back to the detector alone if the text would be refused. */
export function autoDemoteReason(f: Pick<Finding, "detector" | "fingerprint">): string {
  const short = `auto: ${cleanText(f.detector)}`.slice(0, AUTONOMY_REASON_MAX);
  const full = cleanText(`auto: ${f.detector} ${f.fingerprint}`).slice(0, AUTONOMY_REASON_MAX).trim();
  return credentialProblem(full) || breakGlassReasonProblem(full) ? short : full;
}

/** Marks the new findings that lower a level and name a component. Changes the findings in place. */
export function markAutoDemotions(fresh: Finding[], at: Date): void {
  for (const f of fresh) {
    if (!demotesOn(f)) continue;
    const left = componentsOf(f);
    if (left.length) f.autoDemote = { at: at.toISOString(), left };
  }
}

export interface AutoDemoted { ref: ComponentRef; name: string; from: AutonomyLevel; to: AutonomyLevel; detector: string }
export interface AutoDemoteResult { changed: boolean; demoted: AutoDemoted[]; problems: string[] }

const UUID = z.uuid();

const split = (key: string): { kind: AutonomyKind; name: string } => {
  const i = key.indexOf(":");
  return { kind: key.slice(0, i) as AutonomyKind, name: key.slice(i + 1) };
};

/** The records a key stands for: a flow, one record by id (`repos:<uuid>`), or every record of a GitHub name. Throws like repoIdsOf. */
function refsOf(key: string): ComponentRef[] {
  const { kind, name } = split(key);
  if (kind === "flows") return [{ kind, id: name }];
  return UUID.safeParse(name).success ? [{ kind, id: name }] : repoIdsOf(name).map((id) => ({ kind, id }));
}

const keyOf = (ref: ComponentRef): string => `${ref.kind}:${ref.id}`;
const kindOf = (e: unknown): string => (e instanceof StoreError ? e.kind : "error");

/**
 * Does what is still to do for the open findings, in place. `saveClaim` saves the findings (it may throw). Never throws; a
 * failure that may pass is put back to be tried at the next check, and is named in `problems` without a path or a value.
 */
export function runAutoDemotions(findings: Finding[], saveClaim: (f: Finding[]) => void): AutoDemoteResult {
  const out: AutoDemoteResult = { changed: false, demoted: [], problems: [] };
  const problem = (name: string, why: string) => out.problems.push(`auto-demote: ${name} not lowered (${why}); tried again at the next check`);
  for (const f of findings) {
    const mark = f.autoDemote;
    if (f.gone || !mark || mark.left.length === 0) continue;
    // One unit per record: a GitHub name with several records becomes one key per record, each claimed and demoted on its own.
    const units: { key: string; ref: ComponentRef; name: string }[] = [];
    // Keys that could not be resolved this time stay in `left` as they are, and are not processed.
    const kept: string[] = [];
    for (const key of mark.left) {
      const name = split(key).name;
      let refs: ComponentRef[];
      try {
        refs = refsOf(key);
      } catch (e) {
        problem(name, kindOf(e));
        if (!kept.includes(key)) kept.push(key);
        continue;
      }
      if (refs.length === 0) out.changed = true; // an unknown name is dropped silently
      for (const ref of refs) if (!units.some((u) => u.key === keyOf(ref))) units.push({ key: keyOf(ref), ref, name });
    }
    mark.left = [...kept, ...units.map((u) => u.key)];
    for (const { key, ref, name } of units) {
      let to: AutonomyLevel | null;
      try {
        to = previousLevel(levelIn(readAutonomy(), ref.kind, ref.id));
      } catch (e) {
        problem(name, kindOf(e)); // the key stays in `left`
        continue;
      }
      // The claim: the key leaves `left` and the findings are saved before the level is lowered.
      mark.left = mark.left.filter((k) => k !== key);
      out.changed = true;
      if (to === null) continue; // at observe: nothing to do
      try {
        saveClaim(findings);
      } catch (e) {
        mark.left.push(key);
        problem(name, kindOf(e));
        continue;
      }
      try {
        const r = demoteLevel({ ref, to, reason: autoDemoteReason(f), by: MONITOR_ACTOR, waitMs: 0 });
        out.demoted.push({ ref, name, from: r.from, to: r.to, detector: f.detector });
      } catch (e) {
        if (e instanceof AutonomyRefused) continue; // the level moved in the meantime: the claim stays
        if (e instanceof AutonomyError) {
          out.problems.push(`auto-demote: ${name} not lowered (refused)`);
          continue;
        }
        mark.left.push(key); // a store or lock error: this record is tried again at the next check
        problem(name, kindOf(e));
      }
    }
  }
  return out;
}
