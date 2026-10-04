import { readFileSync } from "node:fs";
import { storyKey } from "./breaker.js";
import { dayOf, type Finding, type StoryRef } from "./findings.js";
import { waitsForPerson } from "./fix.js";
import { logFile, olderLogFile } from "./guard.js";

/** What the Problems page says about a finding, in one word. */
export type FindingState = "seen" | "waiting" | "building" | "fixed-watching" | "came-back" | "needs-you" | "muted" | "gone";

const RANK = { critical: 0, major: 1, minor: 2 } as const;
const same = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

export interface StateInput {
  /** `report_to`: only a story there counts. */
  target?: string;
  /** An admin's mute is in force for the finding. */
  muted?: boolean;
  /** A run that builds the finding's story is active now. */
  building?: boolean;
}

/** Pure. The state of a finding: gone wins, then an admin's mute, then a person is needed, then the story tells. */
export function findingState(f: Finding, o: StateInput): FindingState {
  if (f.gone) return "gone";
  if (o.muted) return "muted";
  if (waitsForPerson(f, o.target)) return "needs-you";
  const m: StoryRef | undefined = f.report && o.target && same(f.report.repo, o.target) ? f.report : undefined;
  if (!m) return "seen";
  if (m.muted) return "muted";
  if (!m.closedAt) return o.building ? "building" : "waiting";
  return m.seenAfter ? "came-back" : "fixed-watching";
}

/** The keys (`owner/repo#N`) of the stories that an active run builds. A run that cannot be read is left out. */
export function buildingStories(scheduler: { queue(): { active: { runId: string }[] }; get(id: string): { vars?: Record<string, unknown> } | undefined }): Set<string> {
  const out = new Set<string>();
  try {
    for (const a of scheduler.queue().active) {
      try {
        const vars = scheduler.get(a.runId)?.vars;
        const repo = vars?.github_repo;
        const issue = vars?.issue;
        if (typeof repo === "string" && repo && (typeof issue === "string" || typeof issue === "number") && /^\d+$/.test(String(issue))) out.add(storyKey(repo, String(issue)));
      } catch {
        // a run.json that cannot be read is left out
      }
    }
  } catch {
    // no queue: nothing is building
  }
  return out;
}

/** Gone last, then critical before major before minor, then the newest first. */
export function byUrgency(a: Finding, b: Finding): number {
  return Number(a.gone) - Number(b.gone) || RANK[a.severity] - RANK[b.severity] || Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
}

/** How many bug stories the monitor's log says were made on the local day of `now` (both log files; a broken line is skipped). */
export function madeToday(now: Date, files: string[] = [logFile(), olderLogFile()]): number {
  const today = dayOf(now);
  let n = 0;
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { at?: unknown; event?: unknown };
        if (e.event === "story-made" && typeof e.at === "string" && !Number.isNaN(Date.parse(e.at)) && dayOf(new Date(e.at)) === today) n++;
      } catch {
        // a broken line is skipped
      }
    }
  }
  return n;
}

/**
 * Pure. Puts the story of `f` (its `report` and `tries`) onto the newest record of the same finding and clears what the story
 * settles (`due`, `skipped`, `needsYou`). Everything else of the newest record is kept; a missing record is appended.
 */
export function withStory(newest: Finding[], f: Finding): Finding[] {
  const put = (x: Finding): Finding => {
    const { due, skipped, needsYou, report, tries, ...rest } = x;
    return { ...rest, ...(f.report ? { report: f.report } : {}), ...(f.tries !== undefined ? { tries: f.tries } : {}) };
  };
  if (!newest.some((x) => x.fingerprint === f.fingerprint)) return [...newest, put(f)];
  return newest.map((x) => (x.fingerprint === f.fingerprint ? put(x) : x));
}
