import { describe, expect, it, vi } from "vitest";
import { WatcherSchema } from "../src/config.js";
import { lateChores, slotTime, type LateChoreInput } from "../src/server/late-chores.js";

const iso = (t: number) => new Date(t).toISOString();
const cfg = WatcherSchema.parse({ id: "rel", github_repo: "acme/app", source: "schedule", flow: "release-daily", at: "17:00", timezone: "UTC", task: "release" });
const at = (s: string) => new Date(`${s}Z`);

type W = LateChoreInput["watchers"][number];
const checked = { id: "rel", lastTick: "2026-07-01T18:00:00Z", lastOk: "2026-07-01T18:20:00Z", startedAt: "2026-06-30T10:00:00Z", lastActions: [] };
const input = (o: Partial<LateChoreInput> = {}, w: Partial<W> = {}): LateChoreInput => ({
  watchers: [{ ...cfg, status: checked, ...w } as W],
  pending: [], active: [], briefs: () => [], concurrency: 2, waitsToRestart: false, dailyBudgetUsed: false, ownerBudgetUsed: () => false,
  now: at("2026-07-01T18:30:00"), ...o,
});
const job = (o: Record<string, unknown> = {}) => ({ runId: "q1", kind: "run", source: "watcher rel schedule", enqueuedAt: "2026-07-01T17:00:00Z", choreDay: "2026-07-01", ...o });
const kinds = (i: LateChoreInput) => lateChores(i).map((n) => n.kind);

describe("slotTime", () => {
  it("gives the instant of a local time", () => {
    expect(iso(slotTime("2026-07-01", "17:00", "UTC"))).toBe("2026-07-01T17:00:00.000Z");
    expect(iso(slotTime("2026-07-01", "17:00", "Europe/Berlin"))).toBe("2026-07-01T15:00:00.000Z");
    expect(iso(slotTime("2026-03-29", "17:00", "Europe/Berlin"))).toBe("2026-03-29T15:00:00.000Z");
  });
  it("uses the first minute past a skipped time", () => {
    expect(iso(slotTime("2026-03-29", "02:30", "Europe/Berlin"))).toBe("2026-03-29T01:00:00.000Z");
    expect(iso(slotTime("2026-03-08", "02:30", "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
  });
  it("uses the first of a repeated hour", () => {
    expect(iso(slotTime("2026-10-25", "02:30", "Europe/Berlin"))).toBe("2026-10-25T00:30:00.000Z");
  });
  it("uses this machine's zone without one", () => {
    expect(slotTime("2026-07-01", "12:00")).toBe(new Date("2026-07-01T12:00:00").getTime());
  });
  it("refuses a day that is not a date", () => {
    expect(() => slotTime("2026-02-30", "10:00", "UTC")).toThrow(RangeError);
    expect(() => slotTime("garbage", "10:00", "UTC")).toThrow(RangeError);
    expect(() => slotTime("2028-02-29", "10:00", "UTC")).not.toThrow();
  });
});

describe("lateChores: queued", () => {
  it("warns an hour after the time, not before", () => {
    expect(lateChores(input({ pending: [job()], now: at("2026-07-01T17:59:00") }))).toEqual([]);
    const r = lateChores(input({ pending: [job()], now: at("2026-07-01T18:00:00") }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "chore_late", runId: "q1" });
    expect(r[0]!.why).toMatch(/^The 17:00 release of acme\/app is waiting: /);
  });
  it("keeps the slot of the day it was queued for past midnight, once", () => {
    expect(lateChores(input({ pending: [job()], now: at("2026-07-02T00:40:00") }))).toHaveLength(1);
  });
  it("is not late at 00:10 for a slot at 23:30", () => {
    const w = { at: "23:30" };
    expect(lateChores(input({ pending: [job({ choreDay: "2026-07-01" })], now: at("2026-07-02T00:10:00") }, w))).toEqual([]);
    expect(lateChores(input({ pending: [job({ choreDay: "2026-07-01" })], now: at("2026-07-02T00:30:00") }, w))).toHaveLength(1);
  });
  it("takes the day from the queue time without chore_day", () => {
    expect(lateChores(input({ pending: [job({ choreDay: undefined })], now: at("2026-07-01T18:00:00") }))).toHaveLength(1);
  });
  it("follows real minutes on a clock change day", () => {
    const berlin = { timezone: "Europe/Berlin" };
    const p = (d: string, extra = {}) => [job({ choreDay: d, ...extra })];
    expect(lateChores(input({ pending: p("2026-03-29"), now: at("2026-03-29T01:10:00") }, { ...berlin, at: "01:30" }))).toEqual([]);
    expect(lateChores(input({ pending: p("2026-03-29"), now: at("2026-03-29T01:30:00") }, { ...berlin, at: "01:30" }))).toHaveLength(1);
    expect(lateChores(input({ pending: p("2026-03-29"), now: at("2026-03-29T01:59:00") }, { ...berlin, at: "02:30" }))).toEqual([]);
    expect(lateChores(input({ pending: p("2026-03-29"), now: at("2026-03-29T02:00:00") }, { ...berlin, at: "02:30" }))).toHaveLength(1);
    expect(lateChores(input({ pending: p("2026-10-25"), now: at("2026-10-25T01:10:00") }, { ...berlin, at: "01:30" }))).toHaveLength(1);
  });

  const waitOf = (o: Partial<LateChoreInput>, p = {}) => {
    const r = lateChores(input({ pending: [job(p)], now: at("2026-07-01T19:00:00"), ...o }))[0]!;
    return r;
  };
  it("gives the reasons in order", () => {
    expect(waitOf({ waitsToRestart: true, concurrency: 0 }, { waitingFor: "b" }).why).toContain("restart");
    expect(waitOf({ concurrency: 0 }).why).toContain("no run may start");
    const other = waitOf({}, { waitingFor: "blocker" });
    expect(other.why).toContain("another run it waits for");
    expect(other.where.url).toBe("#/runs/blocker");
    const owner = waitOf({}, { limit: "budget" });
    expect(owner).toMatchObject({ who: "A time limit", until: "tomorrow" });
    const chore = waitOf({ active: [{ runId: "a1", source: "watcher x schedule" }] });
    expect(chore.why).toContain("another schedule run is working");
    expect(chore.where.url).toBe("#/runs/a1");
    expect(waitOf({}).why).toContain("queued but was not started");
  });
});

describe("lateChores: not queued", () => {
  const brief = (o: Record<string, unknown> = {}) => ({ runId: "b1", source: "watcher rel schedule", startedAt: "2026-07-01T17:05:00Z", ...o });
  const run = (o: Partial<LateChoreInput>, w: Partial<W> = {}) => lateChores(input(o, w));
  const why = (o: Partial<LateChoreInput>, w: Partial<W> = {}) => run(o, w)[0]?.why ?? "";

  it("is quiet when a run for the day started", () => {
    expect(run({ briefs: () => [brief({ choreDay: "2026-07-01" })] })).toEqual([]);
    expect(run({ briefs: () => [brief({ choreDay: undefined })] })).toEqual([]);
    expect(run({ active: [{ runId: "a1", source: "watcher rel schedule", choreDay: "2026-07-01" }] })).toEqual([]);
    expect(run({ active: [{ runId: "a1", source: "watcher rel schedule" }] })).toEqual([]);
  });
  it("does not count yesterday's run that started today", () => {
    expect(why({ briefs: () => [brief({ choreDay: "2026-06-30" })] })).toContain("did not queue it");
    expect(why({ active: [{ runId: "b1", source: "watcher rel schedule", choreDay: "2026-06-30" }] })).toContain("another run it waits for");
    expect(why({ active: [{ runId: "b1", source: "watcher rel schedule" }], briefs: () => [brief({ choreDay: "2026-06-30" })] })).toContain("another run it waits for");
  });
  it("names the reason", () => {
    expect(why({ pending: [{ runId: "r9", kind: "resume", source: "watcher rel schedule", enqueuedAt: "2026-07-01T10:00:00Z" }] })).toContain("another run it waits for");
    expect(why({}, { status: { ...checked, lastError: "boom" } })).toContain("checks fail");
    expect(why({}, { status: { ...checked, lastOk: "2026-07-01T16:55:00Z" } })).toContain("not finished a check");
    expect(why({}, { status: { ...checked, lastOk: undefined } })).toContain("not finished a check");
    expect(why({ dailyBudgetUsed: true })).toContain("the daily budget");
    const owned = { repoId: "r1", ownerId: "u1" } as Partial<W>;
    expect(why({ ownerBudgetUsed: () => true }, owned)).toContain("owner's daily budget");
    expect(why({ ownerBudgetUsed: () => true, dailyBudgetUsed: true }, owned)).toContain("the daily budget is used up");
  });
  it("is quiet without a finished check", () => {
    expect(run({}, { status: undefined })).toEqual([]);
    expect(run({}, { status: { ...checked, lastTick: undefined } })).toEqual([]);
  });
  it("shows restart for today's slot, not for yesterday's", () => {
    expect(why({ waitsToRestart: true }, { status: { ...checked, lastError: "x" } })).toContain("server waits to restart");
    expect(why({ waitsToRestart: true, now: at("2026-07-02T10:00:00") })).toContain("did not queue it");
  });
  it("keeps a missed slot until the next one", () => {
    const w = { at: "23:30", status: { ...checked, lastOk: "2026-07-02T00:20:00Z" } };
    expect(run({ now: at("2026-07-02T00:29:00") }, w)).toEqual([]);
    expect(why({ now: at("2026-07-02T00:30:00") }, w)).toContain("did not queue it");
    expect(run({ now: at("2026-07-02T00:30:00") }, { ...w, status: { ...w.status, startedAt: "2026-07-01T23:40:00Z" } })).toEqual([]);
    expect(why({ now: at("2026-07-02T10:00:00") }, { status: { ...checked, lastOk: "2026-07-02T09:50:00Z" } })).toContain("did not queue it");
    expect(run({ now: at("2026-07-02T17:00:00") }, { status: { ...checked, lastOk: "2026-07-02T16:50:00Z" } })).toEqual([]);
  });
});

describe("lateChores: bad input and scope", () => {
  const good = { ...cfg, id: "good", status: { ...checked, id: "good" } } as W;
  const pending = [job(), job({ runId: "q2", source: "watcher good schedule" })];
  const now = at("2026-07-01T19:00:00");

  it("answers for an empty time zone", () => {
    const r = lateChores(input({ now: new Date(2026, 6, 1, 18, 30) }, { timezone: "", status: { ...checked, lastError: "x" } }));
    expect(r).toHaveLength(1);
    expect(r[0]!.why).toContain("checks fail");
  });
  it("skips a watcher with a bad zone or day and keeps the others", () => {
    const bad = (o: Partial<W>) => lateChores({ ...input({ now }), watchers: [{ ...cfg, ...o } as W, good], pending });
    expect(bad({ timezone: "Nowhere/Land" }).map((n) => n.runId)).toEqual(["q2"]);
    const withDay = (d: string) => lateChores({ ...input({ now }), watchers: [cfg as W, good], pending: [job({ choreDay: d }), pending[1]!] });
    expect(withDay("garbage").map((n) => n.runId)).toEqual(["q2"]);
    expect(withDay("2026-02-30").map((n) => n.runId)).toEqual(["q2"]);
  });
  it("never warns for an interval, disabled or issues watcher", () => {
    const p = { pending: [job()], now };
    expect(lateChores(input(p, { at: undefined }))).toEqual([]);
    expect(lateChores(input(p, { enabled: false }))).toEqual([]);
    expect(lateChores(input(p, { source: "issues" } as Partial<W>))).toEqual([]);
  });
  it("names a release or a schedule run by the effective flow", () => {
    const name = (flow?: string) => lateChores(input({ pending: [job()], now }, { flow } as Partial<W>))[0]!.why;
    expect(name("daily-pr")).toContain("17:00 release of");
    expect(name("default")).toContain("17:00 release of");
    expect(name("my-report")).toContain("17:00 schedule run of");
  });
  it("looks things up only when needed, and once", () => {
    const briefs = vi.fn(() => []);
    const ownerBudgetUsed = vi.fn(() => true);
    const owned = (id: string) => ({ ...cfg, id, repoId: "r1", ownerId: "u1", status: { ...checked, id } }) as W;
    lateChores(input({ briefs, ownerBudgetUsed, now: at("2026-07-01T17:30:00") }));
    expect(briefs).not.toHaveBeenCalled();
    expect(ownerBudgetUsed).not.toHaveBeenCalled();
    lateChores({ ...input({ briefs, ownerBudgetUsed, now }), watchers: [owned("a"), owned("b")] });
    expect(briefs).toHaveBeenCalledTimes(1);
    expect(ownerBudgetUsed).toHaveBeenCalledTimes(1);
    ownerBudgetUsed.mockClear();
    lateChores(input({ briefs, ownerBudgetUsed, now }, { repoId: "r1" } as Partial<W>));
    expect(ownerBudgetUsed).not.toHaveBeenCalled();
  });
});
