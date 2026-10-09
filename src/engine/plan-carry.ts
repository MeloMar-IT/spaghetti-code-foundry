import type { Config } from "../config.js";
import { planCommentRefOf, planRecordKey, PLAN_RECORD_VERSION, storableRequest, technologyHashOf } from "../skills/plan-record-rules.js";
import { writePlanRecord } from "../skills/plan-record.js";
import { buildRepoProfile } from "../skills/repo-profile.js";
import { planGateRecord, planSkillRequest } from "../skills/request.js";
import { planHashOf } from "../skills/run-lock.js";
import { stopRunSkills } from "../skills/run-plan.js";
import { headCommit } from "./skill-lock.js";
import type { RunSummary } from "./state.js";

// What the engine carries from the posted plan to the coding run: the plan record. Written by the engine, after
// the post_plan step, from its recorded output (never by a step, so an agent cannot write the store).

export interface PlanCarryDeps {
  home?: string;
  commitOf?: (workdir: string) => string | undefined;
  technologyOf?: (workdir: string) => string | undefined;
}

const NOT_CHECKED = "skills not resolved: the plan record could not be checked";
const NOT_WRITTEN = "skills not resolved: the plan record could not be written";

function technologyOfDir(workdir: string): string | undefined {
  try {
    return technologyHashOf(buildRepoProfile(workdir));
  } catch {
    return undefined;
  }
}

/** After post_plan: writes the plan record. Returns a stop reason (skills in play) or undefined to go on. */
export function carryRunSkills(run: RunSummary, config: Config, stepId: string, log: (m: string) => void, deps: PlanCarryDeps = {}): string | undefined {
  if (stepId !== "post_plan") return undefined;
  try {
    const def = run.flowDef?.steps?.find((s) => s.id === stepId);
    if (!def || def.type !== "shell" || !def.run.includes("/plan-comment")) return undefined;
    const request = planSkillRequest(run);
    const gate = planGateRecord(run);
    const inPlay = (request?.skills.length ?? 0) > 0 || config.skills.selection.include.length > 0;
    const fail = (why: string): string | undefined => {
      if (inPlay) return stopRunSkills(run, stepId, `${NOT_WRITTEN} (${why})`, log);
      log(`⚠ plan record not written: ${why}`);
      return undefined;
    };
    if (!request || !gate) return fail("the plan has no skill request");
    const ref = planCommentRefOf(gate.output);
    if (!ref) return fail("the comment link or the hash line is missing");
    const key = planRecordKey(run.vars?.github_repo ?? "", run.vars?.issue ?? "");
    if (!key) return fail("the repository or the issue is not valid");
    const commit = run.workdir ? (deps.commitOf ?? headCommit)(run.workdir) : undefined;
    const technology = run.workdir ? (deps.technologyOf ?? technologyOfDir)(run.workdir) : undefined;
    try {
      writePlanRecord(
        {
          version: PLAN_RECORD_VERSION,
          repo: `${key.owner}/${key.name}`,
          issue: key.issue,
          runId: run.runId,
          planHash: planHashOf(gate.output),
          commentId: ref.id,
          commentSha256: ref.sha256,
          request: storableRequest(request),
          ...(commit ? { commit } : {}),
          ...(technology ? { technology } : {}),
          createdAt: new Date().toISOString(),
        },
        { home: deps.home },
      );
    } catch {
      return fail("the data folder could not be written");
    }
    log(`    · plan record: comment ${ref.id}`);
    return undefined;
  } catch {
    return stopRunSkills(run, stepId, NOT_CHECKED, log);
  }
}
