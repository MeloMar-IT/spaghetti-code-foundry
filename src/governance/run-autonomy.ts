import { repoIdsOf } from "../auth/repos.js";
import { StoreError } from "../auth/store.js";
import type { RunRecorder } from "../evidence/record.js";
import { autonomyLine, type RunAutonomy } from "./autonomy.js";
import { levelsOf, readAutonomy } from "./autonomy-store.js";

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

/** Records the level: the evidence event first, then the log lines, each guarded. Never throws. */
export function recordRunAutonomy(r: RunAutonomyStart, log: (l: string) => void, evidence: Pick<RunRecorder, "runAutonomy">): void {
  try {
    evidence.runAutonomy(r.autonomy);
  } catch {
    // the run goes on without the event
  }
  for (const line of [...r.problems.map((p) => `! autonomy: ${p}`), autonomyLine(r.autonomy)]) {
    try {
      log(line);
    } catch {
      // a failing logger must not stop the run
    }
  }
}
