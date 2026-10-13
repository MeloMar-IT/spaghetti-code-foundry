// Epics: which stories belong to which epic, and the counts. Pure: records and run states in, epics out.
// No server, no GitHub, no files, no clock (`now` is a parameter).
import type { IssueRecord } from "../queue/issue-list.js";

export type StoryState = "done" | "working" | "waiting" | "your_turn" | "failed" | "split" | "dropped";
/** What the Foundry knows from its runs and holds; part 5 fills it. */
export type RunState = "working" | "your_turn" | "failed";

export const STORY_STATES: readonly StoryState[] = ["done", "working", "waiting", "your_turn", "failed", "split", "dropped"];
/** The app's words (`statusName` in src/words.ts, the column titles in src/board.ts); a test pins them. */
export const STATE_WORDS: Record<StoryState, string> = {
  done: "Done", working: "Working", waiting: "Waiting", your_turn: "Your turn",
  failed: "Failed", split: "Split", dropped: "Dropped",
};
export const NO_EPIC = "No epic";
export const NOT_HANDED = "not handed to the Foundry yet";

export interface EpicsOptions {
  /** The watchers' trigger labels. Empty: nothing is "not handed". */
  labels: string[];
  /** `dependency_done_labels` of the watcher. */
  doneLabels?: string[];
  states?: ReadonlyMap<number, RunState>;
  now: Date;
  /** The day of a time, "YYYY-MM-DD". Default: the UTC day. */
  day?: (iso: string) => string;
}

export interface EpicStory {
  issue: number; title: string; state: StoryState;
  createdAt: string; closedAt?: string;
  partOf?: number; notHanded?: true;
}
export interface StoryGroup {
  title: string;
  stories: EpicStory[]; // ascending by issue
  counts: Record<StoryState, number>;
  total: number; // without split and dropped
  notHanded: number;
}
export interface DayPoint { day: string; stories: number; done: number }
export interface Growth { atStart: number; now: number; split: number }
export interface Epic extends StoryGroup {
  key: string; // "#12" or "label:updates"
  issue?: number;
  startedAt?: string;
  growth: Growth;
  /** `done` of a point counts dated completions only. */
  series: DayPoint[];
  /** Done stories without a close date (done by label): in `counts.done`, not in the series. */
  doneUndated: number;
  finished: boolean;
  finishedAt?: string;
  tookMs?: number;
}
export interface EpicsModel { epics: Epic[]; noEpic: StoryGroup; stories: number }

const norm = (s: string): string => s.trim().toLowerCase();
const utcDay = (iso: string): string => new Date(iso).toISOString().slice(0, 10);

function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

function emptyCounts(): Record<StoryState, number> {
  return { done: 0, working: 0, waiting: 0, your_turn: 0, failed: 0, split: 0, dropped: 0 };
}

/** "21 at the start, 95 now (16 were split)"; "(1 was split)"; no brackets when none was split. */
export function growthText(g: Growth): string {
  const base = `${g.atStart} at the start, ${g.now} now`;
  if (g.split <= 0) return base;
  return `${base} (${g.split} ${g.split === 1 ? "was" : "were"} split)`;
}

export function buildEpics(records: readonly IssueRecord[], o: EpicsOptions): EpicsModel {
  const dayOf = o.day ?? utcDay;
  const byNumber = new Map<number, IssueRecord>();
  for (const r of records) byNumber.set(r.number, r);
  const keyOfNumber = (n: number) => `#${n}`;
  const keyOfLabel = (name: string) => `label:${norm(name)}`;

  // Epic issues: named by an `epic`, `parent` or `epicLabel` of some record.
  const epicIssues = new Set<number>();
  const labelEpics = new Map<string, string>(); // key → name
  for (const r of records) {
    if (r.epic !== undefined) epicIssues.add(r.epic);
    if (r.parent !== undefined) epicIssues.add(r.parent);
    if (r.epicLabel?.issue !== undefined) epicIssues.add(r.epicLabel.issue);
    else if (r.epicLabel?.name) labelEpics.set(keyOfLabel(r.epicLabel.name), r.epicLabel.name.trim());
  }
  const storyLists = [...epicIssues].filter((n) => byNumber.get(n)?.stories?.length).sort((a, b) => a - b);

  const partsOf = new Set<number>();
  for (const r of records) if (r.partOf !== undefined) partsOf.add(r.partOf);

  const directKey = (r: IssueRecord): string | undefined => {
    if (r.epic !== undefined) return keyOfNumber(r.epic);
    if (r.parent !== undefined) return keyOfNumber(r.parent);
    if (r.epicLabel) return r.epicLabel.issue !== undefined ? keyOfNumber(r.epicLabel.issue) : keyOfLabel(r.epicLabel.name);
    for (const n of storyLists) if (byNumber.get(n)!.stories!.includes(r.number)) return keyOfNumber(n);
    return undefined;
  };
  const epicKeyOf = (r: IssueRecord): string | undefined => {
    const seen = new Set<number>();
    let cur: IssueRecord | undefined = r;
    while (cur && !seen.has(cur.number)) {
      seen.add(cur.number);
      const k = directKey(cur);
      if (k) return k;
      if (cur.partOf === undefined) return undefined;
      if (epicIssues.has(cur.partOf)) return keyOfNumber(cur.partOf);
      cur = byNumber.get(cur.partOf);
    }
    return undefined;
  };

  const handLabels = new Set(o.labels.map(norm));
  const doneLabels = new Set((o.doneLabels ?? []).map(norm));
  const stateOf = (r: IssueRecord): { state: StoryState; notHanded?: true } => {
    const closed = r.state === "closed";
    if (closed && partsOf.has(r.number)) return { state: "split" };
    if (closed && (r.stateReason ?? "").toLowerCase() === "not_planned") return { state: "dropped" };
    const mine = r.labels.map(norm);
    if (closed || mine.some((l) => doneLabels.has(l))) return { state: "done" };
    if (handLabels.size > 0 && !mine.some((l) => handLabels.has(l))) return { state: "waiting", notHanded: true };
    return { state: o.states?.get(r.number) ?? "waiting" };
  };

  const groups = new Map<string, EpicStory[]>();
  const noEpicStories: EpicStory[] = [];
  const recordOf = new Map<number, IssueRecord>();
  for (const r of [...records].sort((a, b) => a.number - b.number)) {
    if (epicIssues.has(r.number)) continue; // an epic issue is never a story
    const s = stateOf(r);
    const story: EpicStory = { issue: r.number, title: r.title, state: s.state, createdAt: r.createdAt };
    if (r.closedAt) story.closedAt = r.closedAt;
    if (r.partOf !== undefined) story.partOf = r.partOf;
    if (s.notHanded) story.notHanded = true;
    recordOf.set(r.number, r);
    const k = epicKeyOf(r);
    if (k === undefined) noEpicStories.push(story);
    else (groups.get(k) ?? groups.set(k, []).get(k)!).push(story);
  }

  const summarize = (title: string, stories: EpicStory[]): StoryGroup => {
    const counts = emptyCounts();
    let notHanded = 0;
    for (const s of stories) { counts[s.state]++; if (s.notHanded) notHanded++; }
    const total = counts.done + counts.working + counts.waiting + counts.your_turn + counts.failed;
    return { title, stories, counts, total, notHanded };
  };

  const keys = new Set<string>([...epicIssues].map(keyOfNumber));
  for (const k of labelEpics.keys()) keys.add(k);
  const ordered = [...keys].sort((a, b) => {
    const an = a.startsWith("#"), bn = b.startsWith("#");
    if (an && bn) return Number(a.slice(1)) - Number(b.slice(1));
    if (an !== bn) return an ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const epics: Epic[] = ordered.map((key) => {
    const stories = groups.get(key) ?? [];
    const issue = key.startsWith("#") ? Number(key.slice(1)) : undefined;
    const rec = issue === undefined ? undefined : byNumber.get(issue);
    const title = rec?.title ?? (issue !== undefined ? key : labelEpics.get(key)!);
    const g = summarize(title, stories);
    const earliest = stories.map((s) => s.createdAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    const startedAt = rec?.createdAt ?? earliest;
    const epic: Epic = { ...g, key, growth: { atStart: 0, now: g.total, split: g.counts.split }, series: [], doneUndated: stories.filter((s) => s.state === "done" && !s.closedAt).length, finished: false };
    if (issue !== undefined) epic.issue = issue;
    if (startedAt) epic.startedAt = startedAt;

    const inEpic = new Set(stories.map((s) => s.issue));
    const firstDay = startedAt ? dayOf(startedAt) : undefined;
    // "At the start" = the stories that existed when the epic issue's first day ended, counting the
    // originals and not their later parts (a part of another story of the same epic).
    if (firstDay) {
      epic.growth.atStart = stories.filter((s) => dayOf(s.createdAt) <= firstDay && !(s.partOf !== undefined && inEpic.has(s.partOf))).length;
    }

    epic.finished = g.total > 0 && g.counts.done === g.total;
    // The finish is when the last of the work ended: the latest close among done, split and dropped
    // stories. A done story without a date (done by label) leaves the time unknown.
    let finishedAt: string | undefined;
    if (epic.finished) {
      const ended = stories.filter((s) => s.state === "done" || s.state === "split" || s.state === "dropped");
      const doneUndated = stories.some((s) => s.state === "done" && !s.closedAt);
      if (!doneUndated) {
        const times = ended.filter((s) => s.closedAt).map((s) => s.closedAt!);
        times.sort((a, b) => Date.parse(a) - Date.parse(b));
        finishedAt = times[times.length - 1];
        // Work that was all done before the epic began finishes when the epic starts.
        if (finishedAt && startedAt && Date.parse(finishedAt) < Date.parse(startedAt)) finishedAt = startedAt;
      }
    }
    if (finishedAt) {
      epic.finishedAt = finishedAt;
      if (startedAt) epic.tookMs = Date.parse(finishedAt) - Date.parse(startedAt);
    }

    if (firstDay) epic.series = seriesOf(stories, firstDay, finishedAt, o.now, dayOf);
    return epic;
  });

  return { epics, noEpic: summarize(NO_EPIC, noEpicStories), stories: recordOf.size };
}

function seriesOf(stories: EpicStory[], firstDay: string, finishedAt: string | undefined, now: Date, dayOf: (iso: string) => string): DayPoint[] {
  const clamp = (d: string) => (d < firstDay ? firstDay : d);
  // The series runs to the finish day, or else to the latest of today and every date of the stories,
  // so its last point always equals the totals.
  let lastDay: string;
  if (finishedAt) lastDay = dayOf(finishedAt);
  else {
    lastDay = clamp(dayOf(now.toISOString()));
    for (const s of stories) {
      lastDay = [lastDay, clamp(dayOf(s.createdAt)), s.closedAt ? clamp(dayOf(s.closedAt)) : lastDay].reduce((a, b) => (a > b ? a : b));
    }
  }
  if (lastDay < firstDay) lastDay = firstDay;
  const ins = new Map<string, number>(), outs = new Map<string, number>(), dones = new Map<string, number>();
  const add = (m: Map<string, number>, d: string) => m.set(d, (m.get(d) ?? 0) + 1);
  for (const s of stories) {
    const inDay = clamp(dayOf(s.createdAt));
    add(ins, inDay);
    if (s.state === "split" || s.state === "dropped") add(outs, s.closedAt ? clamp(dayOf(s.closedAt)) : inDay);
    // A done story without a close date is not put on any day: that would move it every day.
    if (s.state === "done" && s.closedAt) {
      const d = dayOf(s.closedAt);
      add(dones, d < inDay ? inDay : d);
    }
  }
  const points: DayPoint[] = [];
  let inSum = 0, outSum = 0, doneSum = 0;
  for (let d = firstDay; d <= lastDay; d = nextDay(d)) {
    inSum += ins.get(d) ?? 0;
    outSum += outs.get(d) ?? 0;
    doneSum += dones.get(d) ?? 0;
    points.push({ day: d, stories: inSum - outSum, done: doneSum });
  }
  return points;
}
