import type { RunBrief, StepRecord } from "../engine/state.js";
import { storyKey } from "./breaker.js";
import { dayOf, type Finding, type StoryRef } from "./findings.js";

/**
 * Pure helpers for "did the fix work?": a story closed as completed waits for the update that has the fix, then the problem
 * has to stay away for 24 hours of normal work. Nothing here calls GitHub.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Normal work without a sighting that makes a finding "fixed". */
export const FIXED_AFTER_MS = DAY;

const same = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** The step that prints the commit of the fix, and the line it prints it on (the last part of a step id with a sub-flow prefix counts). */
const COMMIT_LINES: Record<string, RegExp> = {
  hotfix_done: /^MAIN: ([0-9a-f]{40})\s*$/m,
  push_develop: /^COMMIT: ([0-9a-f]{40})\s*$/m,
};

/** The full fix commit a run printed: `MAIN:` of the hotfix path or `COMMIT:` of the feature path. Undefined when it printed none. */
export function fixCommitOf(run: { history: Pick<StepRecord, "id" | "ok" | "output">[] }): string | undefined {
  let found: string | undefined;
  for (const s of run.history) {
    if (!s.ok) continue;
    const re = COMMIT_LINES[s.id.split("/").at(-1) ?? ""];
    const m = re ? re.exec(s.output ?? "") : null;
    if (m) found = m[1];
  }
  return found;
}

/** The succeeded runs that built this story, newest first. */
export function fixRunsOf(story: Pick<StoryRef, "repo" | "issue">, storyRuns: RunBrief[]): RunBrief[] {
  const key = storyKey(story.repo, story.issue);
  const done = (b: RunBrief) => Date.parse(b.finishedAt ?? b.startedAt);
  return storyRuns
    .filter((b) => b.status === "succeeded" && !!b.githubRepo && /^\d+$/.test(b.issue ?? "") && storyKey(b.githubRepo, b.issue!) === key)
    .sort((a, b) => done(b) - done(a));
}

/** The story's fix state is forgotten (it is open again, or closed at another time). */
export function forgetFix(r: StoryRef): StoryRef {
  const { fixCommit, clockAt, clockWhy, workedMs, seenAfter, fixedAt, fixNote, notedAt, ...rest } = r;
  return rest;
}

/** Bug stories for one finding before the monitor hands it to a person. */
export const MAX_TRIES = 2;

/** The bug stories made for a finding since the count started. A story from before the count (not fixed) counts as one. */
export function triesOf(f: Pick<Finding, "tries" | "report">): number {
  return f.tries ?? (f.report && !f.report.fixedAt ? 1 : 0);
}

/** The finding needs a person now: it is marked, still there, and no story is open or fixed in the target. */
export function waitsForPerson(f: Finding, target: string | undefined): boolean {
  if (!f.needsYou || f.gone || !target) return false;
  const m = f.report;
  if (!m || !same(m.repo, target)) return true;
  return !!(m.closedAt || m.muted) && !m.fixedAt;
}

/** "Try again": the count starts anew and the finding no longer needs a person. */
export function tryAgain(f: Finding): Finding {
  const { needsYou, ...rest } = f;
  return { ...rest, tries: 0 };
}

export type FixState = "waiting" | "watched" | "fixed";

/** What the list shows for a story closed as completed; undefined for any other story. */
export function fixState(r: StoryRef): FixState | undefined {
  if (!r.closedAt || r.muted) return undefined;
  if (r.seenAfter) return "watched";
  if (r.fixedAt) return "fixed";
  return r.clockAt ? "watched" : "waiting";
}

/** New proof that the problem is there after the clock started: first seen, missed (and back), or evidence from after it. */
function proofAfter(f: Finding, clock: number): boolean {
  return Date.parse(f.firstSeen) > clock || (f.missedAt !== undefined && Date.parse(f.missedAt) > clock) || (f.evidence?.times ?? []).some((x) => Date.parse(x) > clock);
}

/**
 * The problem is back after the fix: seen with new proof at an earlier check, and now the usual rule is met (seen in two
 * checks in a row; a minor finding on three different days after the clock started).
 */
export function cameBack(f: Finding, o: { target: string; stamp: string }): boolean {
  const m = f.report;
  if (!m || !same(m.repo, o.target) || !m.closedAt || m.muted || !m.clockAt || !m.seenAfter || m.seenAfter === o.stamp) return false;
  if (f.severity === "minor") return (f.days ?? []).filter((d) => d > dayOf(new Date(m.clockAt!))).length >= 3;
  return (f.streak ?? f.count) >= 2;
}

export interface FixOptions {
  /** `report_to`: only stories there are looked at. */
  target: string;
  now: Date;
  /** When the server started. */
  startedAt?: Date;
  waitDays: number;
  /** Milliseconds of normal work this check stands for (0 for the first check of a process and after a sleep). */
  worked: number;
  /** Does the running Foundry contain this commit? Undefined when that cannot be told (no git checkout, or `report_to` is not the Foundry's repository). */
  contains?: (commit: string) => boolean;
  /** Fingerprints of findings whose fix commit is still being looked for: no restart clock for them. */
  pending?: Set<string>;
}

export interface FixEvent {
  event: "clock-started" | "fixed" | "came-back";
  finding: Finding;
  issue: number;
  /** clock-started: update, restart or waited. */
  reason?: "update" | "restart" | "waited";
  /** clock-started: the days waited. */
  count?: number;
}

/**
 * Starts clocks, counts normal work and says when a finding is fixed or the problem came back. Findings that did not change
 * are the same objects.
 */
export function checkFixes(findings: Finding[], o: FixOptions): { findings: Finding[]; events: FixEvent[] } {
  const events: FixEvent[] = [];
  const stamp = o.now.toISOString();
  const t = o.now.getTime();
  const out = findings.map((f) => {
    const m = f.report;
    if (!m || !same(m.repo, o.target) || !m.closedAt || m.muted) return f;
    const closed = Date.parse(m.closedAt);
    let r = m;
    if (!r.clockAt) {
      const known = !!o.contains && !!r.fixCommit;
      let clock: number | undefined;
      let why: "update" | "restart" | "waited" | undefined;
      if (known && o.contains!(r.fixCommit!)) {
        clock = Math.max(o.startedAt?.getTime() ?? closed, closed);
        why = "update";
      } else if (!known && !o.pending?.has(f.fingerprint) && o.startedAt && o.startedAt.getTime() > closed) {
        clock = o.startedAt.getTime();
        why = "restart";
      } else if (t - closed >= o.waitDays * DAY) {
        clock = t;
        why = "waited";
      }
      if (clock === undefined || why === undefined) return f;
      r = { ...r, clockAt: new Date(clock).toISOString(), clockWhy: why };
      events.push({ event: "clock-started", finding: f, issue: r.issue, reason: why, count: o.waitDays });
    }
    const clock = Date.parse(r.clockAt!);
    if (!f.gone && f.lastSeen === stamp) {
      if (!r.seenAfter && proofAfter(f, clock)) {
        const { fixNote, ...rest } = r;
        r = { ...rest, seenAfter: stamp };
        events.push({ event: "came-back", finding: f, issue: r.issue });
      }
    } else if (!r.seenAfter && !r.fixedAt) {
      const worked = Math.min((r.workedMs ?? 0) + o.worked, Math.max(0, t - clock));
      r = { ...r, workedMs: worked };
      if (worked >= FIXED_AFTER_MS) {
        // A fix that was waited for a long time gets no comment: it may never have run (and the close is old news).
        r = { ...r, fixedAt: stamp, ...(clock - closed < o.waitDays * DAY ? { fixNote: "due" as const } : {}) };
        events.push({ event: "fixed", finding: f, issue: r.issue });
        // A fixed problem starts a new count and no longer needs a person.
        const { needsYou, ...rest } = f;
        return { ...rest, report: r, tries: 0 };
      }
    }
    return r === m ? f : { ...f, report: r };
  });
  return { findings: out, events };
}
