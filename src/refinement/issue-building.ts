import type { labelNames } from "../queue/watcher.js";
import type { RunStatus } from "../engine/state.js";

type Names = ReturnType<typeof labelNames>;
/** What GitHub says about a pull request. Only "closed" (not merged) lets the issue be refined. */
export type PullKind = "open" | "merged" | "closed" | "gone" | "unknown";

/** A run of the issue, as the run list has it. */
export interface IssueRun {
  status: RunStatus;
  /** `vars.pr` of the run. */
  pr?: string;
  startedAt?: string;
}

export interface BuildingInput {
  /** The label names of the issue. */
  labels: readonly string[];
  /** The runs of this issue (repository and number), of any status. */
  runs: readonly IssueRun[];
  /** A job for this issue waits in the queue. */
  queued?: boolean;
  /** The status label names: the defaults, and those of each watcher of the repository. */
  labelNames: Names | readonly Names[];
  /** What was read about pull requests of the runs, by number. A number that is not here counts as not known. */
  pulls?: ReadonlyMap<string, PullKind>;
}

const PR_NUMBER = /^\d{1,10}$/;
const lower = (s: string) => s.toLowerCase();

/** The pull request numbers of the runs that need a read to decide, newest run first, each once. A number that is not a plain number needs none. */
export function pullsToRead(runs: readonly IssueRun[]): string[] {
  const out: string[] = [];
  const sorted = runs.map((r, i) => ({ r, i })).sort((a, b) => (b.r.startedAt ?? "").localeCompare(a.r.startedAt ?? "") || b.i - a.i);
  for (const { r } of sorted) if (r.pr !== undefined && PR_NUMBER.test(r.pr) && !out.includes(r.pr)) out.push(r.pr);
  return out;
}

/**
 * A sentence that says why the Foundry is building or has built the issue, or undefined when it may be refined. In this order: a run that
 * is live or a job that waits; a status label (working, waiting, needs info, done); a run with a pull request, failed or not, unless that
 * pull request is read as closed and not merged. A failed run alone, or the failed label alone, does not block.
 */
export function buildingReason(i: BuildingInput): string | undefined {
  if (i.runs.some((r) => r.status === "running")) return "the Foundry is building it now";
  if (i.runs.some((r) => r.status === "waiting")) return "a run of the Foundry for it is waiting for an answer";
  if (i.queued) return "a run of the Foundry for it is waiting in the queue";

  const all: readonly Names[] = Array.isArray(i.labelNames) ? (i.labelNames as readonly Names[]) : [i.labelNames as Names];
  const has = new Set(i.labels.map(lower));
  const kinds: [keyof Names, string][] = [
    ["working", "the Foundry is working on it"],
    ["waiting", "the Foundry is waiting for something on it"],
    ["needsInfo", "the Foundry asked for more information on it"],
    ["done", "the Foundry has built it"],
  ];
  for (const [key, why] of kinds) {
    const name = all.map((n) => n[key]).find((n) => has.has(lower(n)));
    if (name !== undefined) return `${why} (it has the label "${name}")`;
  }

  for (const r of i.runs) {
    if (r.pr === undefined || r.pr === "") continue;
    const kind = PR_NUMBER.test(r.pr) ? (i.pulls?.get(r.pr) ?? "unknown") : "unknown";
    if (kind === "closed") continue;
    const what = kind === "merged" ? "merged" : kind === "open" ? "open" : "not known";
    return `the Foundry has built it: a run opened pull request #${r.pr} (${what})`;
  }
  return undefined;
}
