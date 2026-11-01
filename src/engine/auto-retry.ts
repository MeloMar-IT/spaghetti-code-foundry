import type { Flow, Step } from "../flow/schema.js";
import { isTimedOut } from "../errors.js";
import { isFoundryComment, type Comment } from "../github.js";
import { isTimeLimitStop, type RunBrief, type RunSummary, type StepRecord, type TimeLimitEvent } from "./state.js";

/**
 * Retries by themselves (auto_retry.timeouts): a step of a watcher story run that ran out of time stops the run
 * (instead of failing it), and the watcher resumes it. The decisions are here, apart from the engine, so they can be tested alone.
 */

/** The stop reason, and the text of the issue comment (only the step id and numbers: no untrusted text). */
export function timeLimitReason(step: string, attempt: number, of: number): string {
  return `ran out of time in \`${step}\`; trying again (${attempt} of ${of})`;
}

/** A run of a watcher for one issue (a story). Runs started by a person or by the command line are not. */
export function isStoryRun(s: Pick<RunSummary, "source" | "vars" | "localTest">): boolean {
  return !s.localTest && /^watcher \S+ issue #\d+$/.test(s.source ?? "") && typeof s.vars?.issue === "string" && s.vars.issue !== "";
}

const startedEvents = (events: unknown): TimeLimitEvent[] =>
  Array.isArray(events) ? events.filter((e): e is TimeLimitEvent => !!e && typeof e === "object" && typeof (e as TimeLimitEvent).startedAt === "string") : [];

/** The retries of a story that began: the run's own, and those of the other runs of the same issue. */
export function timeLimitsUsed(
  own: Pick<RunSummary, "runId" | "timeLimits" | "vars">,
  briefs: readonly Pick<RunBrief, "runId" | "githubRepo" | "issue" | "timeLimits">[],
): number {
  let n = startedEvents(own.timeLimits).length;
  const repo = own.vars?.github_repo;
  const issue = own.vars?.issue;
  if (!repo || !issue) return n;
  for (const b of briefs) {
    if (b.runId === own.runId || b.githubRepo !== repo || b.issue !== issue) continue;
    n += startedEvents(b.timeLimits).length;
  }
  return n;
}

/** Should the step that just failed be answered with a retry? `used` is asked last, and only when everything else says yes. */
export function timeLimitAction(o: {
  top: boolean;
  stepType: Step["type"];
  /** The step names its own failure path (`on_failure`, also `fail`): it decides itself. */
  ownFailurePath?: boolean;
  error?: string;
  accessFailed?: boolean;
  storyRun: boolean;
  limit: number;
  used: () => number;
}): { attempt: number; of: number } | undefined {
  if (!o.top || (o.stepType !== "claude" && o.stepType !== "shell") || o.ownFailurePath) return undefined;
  if (!isTimedOut(o.error) || o.accessFailed || !o.storyRun || !(o.limit > 0)) return undefined;
  const used = o.used();
  return used < o.limit ? { attempt: used + 1, of: o.limit } : undefined;
}

/**
 * Where a retry of `stepId` starts. The areas the run claimed may be held by another run by now, so a step that ran after
 * a successful claim goes through `claim_areas` first and continues at the step. This follows what ran (the history), not the
 * order of the steps in the flow: a handler can run after the claim wherever it is declared. A claim that only waited
 * (WAIT_AREA) did not claim anything.
 */
export function retryEntry(flow: Pick<Flow, "steps">, history: readonly StepRecord[], stepId: string): { next: string; retryStep?: string } {
  if (stepId === "claim_areas" || !flow.steps.some((s) => s.id === "claim_areas")) return { next: stepId };
  const top = history.filter((h) => !h.parent);
  const last = top.length - 1;
  let claim = -1;
  for (let i = last - 1; i >= 0; i--) {
    if (top[i]!.id === "claim_areas") { claim = i; break; }
  }
  const c = claim >= 0 ? top[claim]! : undefined;
  if (c && c.ok && !/^WAIT_AREA\s*$/m.test(c.output ?? "")) return { next: "claim_areas", retryStep: stepId };
  return { next: stepId };
}

/** On a resume: remembers when a retry began (once), or drops `retryStep` when the resume starts somewhere else. */
export function markRetryStart(s: RunSummary, from: string, at: string): void {
  if (from !== s.state.next) {
    s.retryStep = undefined;
    return;
  }
  if (!isTimeLimitStop(s.reason)) return;
  const last = Array.isArray(s.timeLimits) ? s.timeLimits.at(-1) : undefined;
  if (last && last.startedAt === undefined) last.startedAt = at;
}

/** The last retry that is stopped and has not begun yet (the resume that is about to start it), if any. */
export function pendingRetry(s: Pick<RunSummary, "reason" | "timeLimits">, from: string, next: string | null): TimeLimitEvent | undefined {
  if (from !== next || !isTimeLimitStop(s.reason)) return undefined;
  const last = Array.isArray(s.timeLimits) ? s.timeLimits.at(-1) : undefined;
  return last && last.startedAt === undefined ? last : undefined;
}

const NOTE_START = "**Nothing needed from you** — ran out of time in ";

/** The marker that ends the note of one retry: a comment with it is the note, so a note is never posted twice. */
export const retryNoteMarker = (runId: string, attempt: number): string => `<!-- claude-factory run=${runId} retry=${attempt} -->`;

/** The comment for the last retry of a run (its id and number make the marker). */
export function retryComment(run: Pick<RunSummary, "runId" | "timeLimits">): string | undefined {
  const ev = Array.isArray(run.timeLimits) ? run.timeLimits.at(-1) : undefined;
  if (!ev || typeof ev.step !== "string" || !/^[\w-]+$/.test(ev.step) || !Number.isInteger(ev.attempt) || !Number.isInteger(ev.of)) return undefined;
  return `**Nothing needed from you** — ${timeLimitReason(ev.step, ev.attempt, ev.of)}.\n\n${retryNoteMarker(run.runId, ev.attempt)}`;
}

/** A comment of the Foundry that says a step ran out of time: it asks nothing. */
export function isTimeLimitNote(c: Pick<Comment, "body" | "viewerDidAuthor">): boolean {
  return isFoundryComment(c) && c.body.startsWith(NOTE_START);
}
