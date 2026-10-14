import { describe, expect, it } from "vitest";
import { NOT_HANDED } from "../src/epics/model.js";
import type { Forecast } from "../src/epics/forecast.js";
import type { RepoForecasts } from "../src/epics/forecast-store.js";
import { epicIdOf, epicKeyOf, epicsView, epicView, forecastText, holdUps, runStateOf, NO_DATA_WORDS, type EpicsViewInput } from "../src/epics/view.js";
import { nextStep, type NextKind, type NextStep } from "../src/next-step.js";
import type { IssueRecord } from "../src/queue/issue-list.js";
import { userWords } from "../src/server/next.js";
import { LABEL_WORDS, statusHelp } from "../src/words.js";

const NOW = new Date("2026-10-14T12:00:00Z");
const rec = (number: number, over: Partial<IssueRecord> = {}): IssueRecord => ({
  number, title: `Story ${number}`, state: "open", labels: ["go"], createdAt: "2026-10-01T12:00:00Z", dependsOn: [], ...over,
});
const done = (day: number): Partial<IssueRecord> => ({ state: "closed", stateReason: "completed", closedAt: `2026-10-${String(day).padStart(2, "0")}T09:00:00Z` });
const step = (kind: NextKind, issue: number): NextStep => nextStep(kind, { repo: "acme/app", issue, title: `Story ${issue}` }, kind === "questions" ? { questions: 2 } : {});
const input = (issues: IssueRecord[], states: [number, NextStep][] = [], over: Partial<EpicsViewInput> = {}): EpicsViewInput => ({
  repo: "acme/app", watched: true, labels: ["go"], doneLabels: [], states: new Map(states), now: NOW,
  list: { repo: "acme/app", readAt: "2026-10-14T11:00:00Z", cut: false, issues }, ...over,
});
/** Epic #1 with stories 2–4, done ones 5–9 over the last days so that a range exists. */
const world = (): IssueRecord[] => [
  rec(1, { title: "Epic", stories: [2, 3, 4] }),
  rec(2, { epic: 1, ...done(10) }), rec(3, { epic: 1 }), rec(4, { epic: 1, dependsOn: [3] }), rec(5, { epic: 1 }),
  ...[6, 7, 8, 9, 10].map((n) => rec(n, done(10 + (n % 3)))),
];

describe("epicsView", () => {
  it("says no data without a watcher, and when nothing was read yet", () => {
    const a = epicsView({ ...input([]), list: undefined, watched: false });
    expect(a.answer.data).toEqual({ state: "no-data", why: "no-watcher", text: NO_DATA_WORDS["no-watcher"] });
    expect(a.answer.epics).toEqual([]);
    expect(a.answer.noEpic).toBeUndefined();
    expect(a.save.size).toBe(0);
    const b = epicsView({ ...input([]), list: undefined });
    expect(b.answer.data).toMatchObject({ state: "no-data", why: "not-read-yet" });
  });

  it("says how fresh the data is", () => {
    const a = epicsView(input(world())).answer;
    expect(a.data).toEqual({ state: "fresh", readAt: "2026-10-14T11:00:00Z", cut: false, ageMs: 3_600_000 });
  });

  it("sorts by expected finish, too early ones next, finished epics last", () => {
    const issues = [
      rec(1, { title: "Soon", stories: [2] }), rec(2, { epic: 1 }),
      rec(20, { title: "Later", stories: [21, 22, 23, 24, 25, 26] }),
      ...[21, 22, 23, 24, 25, 26].map((n) => rec(n, { epic: 20 })),
      rec(30, { title: "Empty", stories: [] }), rec(31, { parent: 30, ...done(12) }), rec(32, { parent: 30, ...done(13) }),
      rec(40, { title: "Old", stories: [41], createdAt: "2026-10-02T00:00:00Z" }), rec(41, { epic: 40, ...done(3) }),
      ...[50, 51, 52, 53, 54, 55].map((n) => rec(n, done(12))),
    ];
    const { answer } = epicsView(input(issues));
    const kinds = answer.epics.map((e) => `${e.title}:${e.finished ? "finished" : e.forecast.kind}`);
    expect(kinds.at(-1)).toBe("Old:finished");
    expect(kinds.indexOf("Soon:range")).toBeLessThan(kinds.indexOf("Later:range"));
    const old = answer.epics.at(-1)!;
    expect(old.finishedAt).toBe("2026-10-03T09:00:00Z");
    expect(old.tookMs).toBe(Date.parse("2026-10-03T09:00:00Z") - Date.parse("2026-10-02T00:00:00Z"));
    expect(answer.noEpic).toBeDefined();
  });

  it("gives counts, growth and a forecast with its reason", () => {
    const e = epicsView(input(world())).answer.epics[0]!;
    expect(e).toMatchObject({ id: "1", key: "#1", issue: 1, title: "Epic", total: 4 });
    expect(e.counts.done).toBe(1);
    expect(e.growthText).toMatch(/at the start, 4 now/);
    expect(e.forecast.kind).toBe("range");
    if (e.forecast.kind === "range") {
      expect(e.forecast.text).toMatch(/^3 stories left at about/);
      expect(e.forecast.leavesOut).toEqual(["stops for usage limits", "waiting for a person's answer"]);
    }
  });

  it("saves a forecast once per day", () => {
    const none = epicsView(input(world()));
    expect([...none.save.keys()]).toEqual(["#1"]);
    const today: RepoForecasts = { version: 1, repo: "acme/app", epics: { "#1": [{ day: "2026-10-14", at: "2026-10-14T01:00:00Z", kind: "too-early", reason: "no-stories" }] } };
    expect(epicsView(input(world(), [], { stored: today })).save.size).toBe(0);
    const yesterday: RepoForecasts = { version: 1, repo: "acme/app", epics: { "#1": [{ day: "2026-10-13", at: "2026-10-13T01:00:00Z", kind: "too-early", reason: "no-stories" }] } };
    const again = epicView(input(world(), [], { stored: yesterday }), "#1")!;
    expect(again.save.has("#1")).toBe(true);
    expect(again.answer.history.map((h) => h.day)).toEqual(["2026-10-13"]); // today is added by the route after it saved
    const kept = epicView(input(world(), [], { stored: today }), "#1")!;
    expect(kept.answer.history).toEqual(today.epics["#1"]);
  });

  it("never saves a finished epic", () => {
    const issues = [rec(40, { stories: [41] }), rec(41, { epic: 40, ...done(3) })];
    const r = epicsView(input(issues));
    expect(r.answer.epics[0]!.forecast).toEqual({ kind: "finished" });
    expect(r.save.size).toBe(0);
  });
});

describe("holdUps", () => {
  const story = (issue: number, state: "your_turn" | "failed" | "waiting" | "done" | "split" | "dropped", extra = {}) =>
    ({ issue, title: `S${issue}`, state, createdAt: "2026-10-01T00:00:00Z", ...extra });

  it("names each kind in the app's words", () => {
    const states = new Map<number, NextStep>([[2, step("questions", 2)], [3, step("failed", 3)], [5, step("usage_limit", 5)], [6, step("queued", 6)]]);
    const h = holdUps([story(2, "your_turn"), story(3, "failed"), story(4, "waiting", { notHanded: true }), story(5, "waiting"), story(6, "waiting"), story(7, "done"), story(8, "split"), story(9, "dropped")], states);
    expect(h.map((x) => [x.kind, x.issues])).toEqual([["person", [2]], ["failed", [3]], ["limit", [5]], ["no-slot", [6]], ["not-handed", [4]]]);
    expect(h[0]!.status).toBe(states.get(2)!.status);
    expect(h[4]).toMatchObject({ status: NOT_HANDED, help: LABEL_WORDS.trigger });
    expect(h[1]!.help).toBe(states.get(3)!.help);
  });

  it("does not give questions and an approval the same words", () => {
    const states = new Map<number, NextStep>([[2, step("questions", 2)], [3, step("approve_plan", 3)], [4, step("questions", 4)]]);
    const h = holdUps([story(2, "your_turn"), story(3, "your_turn"), story(4, "your_turn")], states);
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ kind: "person", issues: [2, 4], status: states.get(2)!.status });
    expect(h[1]).toMatchObject({ kind: "person", issues: [3], status: states.get(3)!.status });
    expect(h[0]!.help).not.toBe(h[1]!.help);
  });

  it("uses the words of a failed story when there is no record", () => {
    const h = holdUps([story(3, "failed")], new Map());
    expect(h[0]!.help).toBe(statusHelp("failed"));
  });

  it("lists the stories that wait for a failed one, also through others", () => {
    const issues = [rec(1, { stories: [2, 3, 4, 5] }), rec(2, { epic: 1 }), rec(3, { epic: 1, dependsOn: [2] }), rec(4, { epic: 1, dependsOn: [3] }), rec(5, { epic: 1 })];
    const v = epicView(input(issues, [[2, step("failed", 2)]]), "#1")!;
    const failed = v.answer.epic!.holdUps.find((x) => x.kind === "failed")!;
    expect(failed.issues).toEqual([2]);
    expect(failed.waiting).toEqual([3, 4]);
  });
});

describe("epicView", () => {
  it("gives the stories in build order, chains, series, pace and the median", () => {
    const issues = world();
    const v = epicView(input(issues, [[3, step("running", 3)]], { medianStoryMs: 1_800_000 }), "#1")!.answer;
    expect(v.stories.map((s) => s.issue)).toEqual(v.chains!.order);
    expect(v.stories.indexOf(v.stories.find((s) => s.issue === 3)!)).toBeLessThan(v.stories.indexOf(v.stories.find((s) => s.issue === 4)!));
    expect(v.stories.find((s) => s.issue === 3)).toMatchObject({ state: "working", words: "Working" });
    expect(v.chains!.criticalPath.stories).toContain(4);
    expect(v.series.length).toBeGreaterThan(0);
    expect(v.pace.days).toHaveLength(14);
    expect(v.pace.perDay).toBeGreaterThan(0);
    expect(v.medianStoryMs).toBe(1_800_000);
    expect(v.history).toEqual([]); // the route saves a day and asks again
  });

  it("returns undefined for an unknown epic and an empty answer without data", () => {
    expect(epicView(input(world()), "#99")).toBeUndefined();
    const none = epicView({ ...input([]), list: undefined }, "#1")!;
    expect(none.answer).toMatchObject({ epic: null, chains: null, stories: [], series: [], history: [], pace: { perDay: 0, days: [] } });
  });

  it("reaches a label epic whose name holds a slash, a percent and a space", () => {
    const name = "Area 51/50%";
    const issues = [rec(2, { epicLabel: { name } }), rec(3, { epicLabel: { name } })];
    const list = epicsView(input(issues)).answer;
    const row = list.epics[0]!;
    expect(row.key).toBe("label:area 51/50%");
    expect(row.id).toMatch(/^l-[\w-]+$/);
    expect(epicKeyOf(row.id)).toBe(row.key);
    expect(epicView(input(issues), epicKeyOf(row.id)!)!.answer.stories.map((s) => s.issue)).toEqual([2, 3]);
  });

  it("carries no issue body, labels or failure text", () => {
    const failed = { ...step("failed", 3), why: "SECRET-WHY", failure: undefined };
    const text = JSON.stringify([epicsView(input(world(), [[3, failed]])).answer, epicView(input(world(), [[3, failed]]), "#1")!.answer]);
    expect(text).not.toContain("SECRET-WHY");
    expect(text).not.toContain('"labels"');
    expect(text).not.toContain('"go"');
  });
});

describe("userWords", () => {
  it("rewords a budget hold for a user and keeps its kind and facts", () => {
    const hold = nextStep("daily_budget", { repo: "acme/app", issue: 3, title: "Story 3", runId: "r1" });
    const mine = userWords(hold);
    expect(mine).toMatchObject({ kind: "daily_budget", issue: 3, runId: "r1", who: hold.who });
    expect(mine.status).not.toBe("");
    expect(mine.why).toBe(nextStep("daily_budget", { repo: "acme/app", issue: 3 }, { forUser: true }).why);
    expect(mine.why).not.toBe(hold.why);
    expect(runStateOf(mine)).toBeUndefined(); // still a limit (queued), not the failure of an older run
  });
});

describe("helpers", () => {
  it("maps a record to a run state like the board", () => {
    expect(runStateOf(step("running", 1))).toBe("working");
    expect(runStateOf(step("failed", 1))).toBe("failed");
    expect(runStateOf(step("questions", 1))).toBe("your_turn");
    expect(runStateOf(step("queued", 1))).toBeUndefined();
  });

  it("reads epic ids", () => {
    expect(epicKeyOf("12")).toBe("#12");
    expect(epicKeyOf("#12")).toBe("#12");
    expect(epicKeyOf("abc")).toBeUndefined();
    expect(epicKeyOf("0")).toBeUndefined();
    expect(epicKeyOf("l-!!")).toBeUndefined();
    expect(epicIdOf("#7")).toBe("7");
  });

  it("words a forecast", () => {
    const base = { earliest: "a", expected: "b", latest: "c", leavesOut: [], left: 3, perDay: 1.5, chain: 2, partsPerStory: 1.5 } as const;
    expect(forecastText({ kind: "range", ...base, drivers: [{ kind: "pace", left: 1, perDay: 2 }] } as Forecast)).toBe("1 story left at about 2 a day");
    expect(forecastText({ kind: "range", ...base, drivers: [{ kind: "chain", stories: 3, storyMs: 1_800_000 }, { kind: "pace", left: 5, perDay: 1 }] } as Forecast))
      .toBe("A chain of 3 stories that are built one after another, about 30 min each; 5 stories left at about 1 a day");
    expect(forecastText({ kind: "range", ...base, drivers: [{ kind: "splits", partsPerStory: 1.54 }] } as Forecast)).toBe("Stories are split into about 1.5 parts each");
    expect(forecastText({ kind: "too-early", reason: "no-stories", leavesOut: [] })).toMatch(/no stories yet/);
    expect(forecastText({ kind: "too-early", reason: "little-history", leavesOut: [] })).toMatch(/^Too early to say: fewer than \d+ stories were finished in the last 14 days$/);
  });
});
