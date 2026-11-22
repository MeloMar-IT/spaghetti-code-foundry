import { z } from "zod";
import { repoIdsOf } from "../auth/repos.js";
import { StoreError } from "../auth/store.js";
import type { RunRecorder } from "../evidence/record.js";
import { AUTONOMY_LEVELS, RunAutonomySchema, autonomyLine, autonomyOfRun, nextLevel, type AutonomyLevel, type RunAutonomy } from "./autonomy.js";
import { levelIn, levelsOf, readAutonomy } from "./autonomy-store.js";

export interface RunAutonomyStart {
  autonomy: RunAutonomy;
  problems: string[];
}

const kindOf = (e: unknown): string => (e instanceof StoreError ? e.kind : "error");

/**
 * The autonomy of a run that starts now. The repository is found by its GitHub name across all accounts (several records
 * on an old install: the lowest level wins). A store that cannot be read counts as `observe`. Never throws.
 */
export function runAutonomyAtStart(o: { githubRepo?: string; flow: string }): RunAutonomyStart {
  const problems: string[] = [];
  let ids: string[] = [];
  let repoUnknown = false;
  if (o.githubRepo) {
    try {
      ids = repoIdsOf(o.githubRepo);
    } catch (e) {
      repoUnknown = true;
      problems.push(`repos.json could not be read (${kindOf(e)}); the repository counts as observe`);
    }
  }
  try {
    const autonomy = levelsOf(readAutonomy(), ids, o.flow);
    if (repoUnknown) return { autonomy: { level: "observe", repository: "observe", flow: autonomy.flow }, problems };
    return { autonomy, problems };
  } catch (e) {
    problems.push(`autonomy.json could not be read (${kindOf(e)}); this run counts as observe`);
    const hasRepo = repoUnknown || ids.length > 0;
    return { autonomy: { level: "observe", ...(hasRepo ? { repository: "observe" as const } : {}), flow: "observe" }, problems };
  }
}

export interface RunAutonomyResume extends RunAutonomyStart {
  /** The stored level is missing, invalid, or differs in `level`, `repository` or `flow`. */
  changed: boolean;
  /** The level the run had before (`autonomyOfRun` of the stored value). */
  was: AutonomyLevel;
}

function sameAutonomy(stored: unknown, now: RunAutonomy): boolean {
  const res = RunAutonomySchema.safeParse(stored);
  return res.success && res.data.level === now.level && res.data.repository === now.repository && res.data.flow === now.flow;
}

/** The autonomy of a run that is resumed: worked out again from the stores as they are now. Never throws. */
export function runAutonomyOnResume(run: { flow: string; vars?: Record<string, string>; autonomy?: unknown }): RunAutonomyResume {
  const githubRepo = typeof run.vars?.github_repo === "string" ? run.vars.github_repo : undefined;
  const r = runAutonomyAtStart({ githubRepo, flow: run.flow });
  return { ...r, changed: !sameAutonomy(run.autonomy, r.autonomy), was: autonomyOfRun(run) };
}

/** Logs the problem lines, each guarded. Never throws. */
export function logAutonomyProblems(problems: string[], log: (l: string) => void): void {
  for (const p of problems) {
    try {
      log(`! autonomy: ${p}`);
    } catch {
      // a failing logger must not stop the run
    }
  }
}

/** Records the level: the evidence event first, then the log lines, each guarded. Never throws. */
export function recordRunAutonomy(r: RunAutonomyStart, log: (l: string) => void, evidence: Pick<RunRecorder, "runAutonomy">, o: { resumed?: true; was?: AutonomyLevel } = {}): void {
  try {
    evidence.runAutonomy(r.autonomy, o.resumed ? { resumed: true } : {});
  } catch {
    // the run goes on without the event
  }
  logAutonomyProblems(r.problems, log);
  try {
    log(o.resumed ? `${autonomyLine(r.autonomy)}; resumed, was ${o.was ?? "delivery-handoff"}` : autonomyLine(r.autonomy));
  } catch {
    // a failing logger must not stop the run
  }
}

const SAFE_FLOW = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const rank = (l: AutonomyLevel): number => AUTONOMY_LEVELS.indexOf(l);

/**
 * The command that raises the level that limits a run, as advice. Undefined when there is none to name: at the top, no id,
 * a store that cannot be read, or a name that is not safe to print. Never throws.
 */
export function raiseCommand(run: { flow?: string; vars?: Record<string, string> }): string | undefined {
  try {
    const flow = run.flow;
    if (flow !== undefined && !SAFE_FLOW.test(flow)) return undefined;
    const store = readAutonomy();
    const github = run.vars?.github_repo;
    const ids = typeof github === "string" && github ? repoIdsOf(github) : [];
    let repo: { id: string; level: AutonomyLevel } | undefined;
    for (const id of ids) {
      const level = levelIn(store, "repos", id);
      if (!repo || rank(level) < rank(repo.level)) repo = { id, level };
    }
    const flowLevel = flow ? levelIn(store, "flows", flow) : undefined;
    let kind: "repos" | "flows";
    let id: string;
    let level: AutonomyLevel;
    if (repo && (flowLevel === undefined || rank(repo.level) <= rank(flowLevel))) {
      if (!z.uuid().safeParse(repo.id).success) return undefined;
      kind = "repos";
      id = repo.id;
      level = repo.level;
    } else if (flow && flowLevel !== undefined) {
      kind = "flows";
      id = flow;
      level = flowLevel;
    } else {
      return undefined;
    }
    const next = nextLevel(level);
    if (!next) return undefined;
    return `scf autonomy promote ${kind} ${id} ${next} --reason "<why>"`;
  } catch {
    return undefined;
  }
}
