import { execFileSync } from "node:child_process";
import type { Config } from "../config.js";
import {
  parsePlanCommentFacts, pickPlanRecord, planChanges, planCommentRefOf, planRecordKey, PLAN_RECORD_VERSION, storableRequest, technologyHashOf,
} from "../skills/plan-record-rules.js";
import { readPlanRecords, writePlanRecord } from "../skills/plan-record.js";
import { buildRepoProfile } from "../skills/repo-profile.js";
import { PLAN_CHECK_STEP, planGateRecord, planSkillRequest, type SkillRequest } from "../skills/request.js";
import { planHashOf, sha256Of } from "../skills/run-lock.js";
import { stopRunSkills } from "../skills/run-plan.js";
import { headCommit } from "./skill-lock.js";
import type { RunSummary } from "./state.js";

// What the engine carries from the posted plan to the coding run: the plan record. Written by the engine, after
// the post_plan step, from its recorded output (never by a step, so an agent cannot write the store). Read again
// after the plan_check step of the coding run, which sets run.skillCarry from the record (never from the comment).

export { PLAN_CHECK_STEP };

/** The skill request carried from the plan record into a coding run. */
export interface RunSkillCarry {
  request: SkillRequest;
  planHash: string;
  /** Equal to planHash when nothing changed since the plan; else a hash of planHash, the changes and HEAD. */
  lockHash: string;
  commentId: string;
  changes: ("comments" | "code" | "technology")[];
  at: string;
}

export interface PlanCarryDeps {
  home?: string;
  commitOf?: (workdir: string) => string | undefined;
  technologyOf?: (workdir: string) => string | undefined;
  pathsChanged?: (workdir: string, fromCommit: string, paths: string[]) => boolean;
}

const NOT_CHECKED = "skills not resolved: the plan record could not be checked";
const NOT_WRITTEN = "skills not resolved: the plan record could not be written";

const CHECK_REASONS = {
  "comment-missing": "the plan comment is gone — plan the issue again",
  "comment-changed": "the plan comment was edited — plan the issue again",
  "newer-plan": "a newer plan has no record here — plan the issue again",
  "record-purged": "the plan record was cleaned up — plan the issue again",
  "check-unreadable": "the plan comments could not be read — plan the issue again",
} as const;

function technologyOfDir(workdir: string): string | undefined {
  try {
    return technologyHashOf(buildRepoProfile(workdir));
  } catch {
    return undefined;
  }
}

/** True when something changed in the paths since the commit. An unknown commit counts as changed. Paths are literal. */
function pathsChangedIn(workdir: string, fromCommit: string, paths: string[]): boolean {
  try {
    execFileSync("git", ["--literal-pathspecs", "diff", "--quiet", fromCommit, "HEAD", "--", ...paths], { cwd: workdir, stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

/**
 * After post_plan: writes the plan record. After plan_check: reads it and sets run.skillCarry.
 * Returns a stop reason (skills in play) or undefined to go on.
 */
export function carryRunSkills(run: RunSummary, config: Config, stepId: string, log: (m: string) => void, deps: PlanCarryDeps = {}): string | undefined {
  if (stepId !== "post_plan" && stepId !== PLAN_CHECK_STEP) return undefined;
  try {
    const def = run.flowDef?.steps?.find((s) => s.id === stepId);
    if (!def || def.type !== "shell" || !def.run.includes("/plan-comment")) return undefined;
    return stepId === PLAN_CHECK_STEP ? checkRecord(run, config, log, deps) : writeRecord(run, config, stepId, log, deps);
  } catch {
    if (stepId === PLAN_CHECK_STEP) delete run.skillCarry;
    return stopRunSkills(run, stepId, NOT_CHECKED, log);
  }
}

function checkRecord(run: RunSummary, config: Config, log: (m: string) => void, deps: PlanCarryDeps): string | undefined {
  delete run.skillCarry;
  if (planGateRecord(run)) return undefined; // a plan gate in the history wins
  const stop = (reason: string): string => {
    delete run.skillCarry;
    return stopRunSkills(run, PLAN_CHECK_STEP, `skills not resolved: ${reason}`, log);
  };
  const read = readPlanRecords(run.vars?.github_repo ?? "", run.vars?.issue ?? "", { home: deps.home });
  if (read === "invalid") return stop("the plan records of this issue are not valid");
  const last = [...run.history].reverse().find((r) => !r.parent && r.id === PLAN_CHECK_STEP && r.ok);
  const pick = pickPlanRecord(read, last ? parsePlanCommentFacts(last.output) : undefined);
  if (pick.kind === "none") return undefined;
  if (pick.kind !== "record") {
    // Fail closed: any record with a skill (or a purge that held one) puts skills in play, not only the newest.
    const inPlay =
      config.skills.selection.include.length > 0 ||
      read.records.some((r) => r.request.skills.length > 0) ||
      (read.purged?.skills.length ?? 0) > 0;
    const why: string = CHECK_REASONS[pick.kind];
    if (inPlay) return stop(why);
    log(`⚠ plan check: ${why.split(" — ")[0]}; the run goes on without the plan's skills`);
    return undefined;
  }
  const { record } = pick;
  const paths = [...new Set(record.request.skills.flatMap((s) => s.evidence.filter((e) => e.startsWith("path:") && e !== "path:omitted").map((e) => e.slice(5))))];
  const pathsChanged = paths.length === 0 ? false : !record.commit || !run.workdir ? true : (deps.pathsChanged ?? pathsChangedIn)(run.workdir, record.commit, paths);
  const technologyNow = run.workdir ? (deps.technologyOf ?? technologyOfDir)(run.workdir) : undefined;
  const changes = planChanges({ later: pick.later, pathsChanged, technologyThen: record.technology, technologyNow });
  const head = (run.workdir ? (deps.commitOf ?? headCommit)(run.workdir) : undefined) ?? "";
  const lockHash = changes.length ? sha256Of(record.planHash + "\n" + changes.join(",") + "\n" + head) : record.planHash;
  run.skillCarry = { request: record.request, planHash: record.planHash, lockHash, commentId: record.commentId, changes, at: new Date().toISOString() };
  if (changes.includes("comments")) log("⚠ plan check: comments were added after the plan; the skills are resolved again");
  if (changes.includes("code")) log("⚠ plan check: files the plan named have changed; the skills are resolved again");
  if (changes.includes("technology")) log("⚠ plan check: the technology of the repository has changed; the skills are resolved again");
  log(`    · plan record: comment ${record.commentId}`);
  return undefined;
}

function writeRecord(run: RunSummary, config: Config, stepId: string, log: (m: string) => void, deps: PlanCarryDeps): string | undefined {
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
}
