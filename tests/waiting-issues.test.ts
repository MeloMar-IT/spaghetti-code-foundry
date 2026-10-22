import { describe, expect, it, vi } from "vitest";
import type { Comment } from "../src/github.js";
import type { RunSummary } from "../src/engine/state.js";
import { commentReads, extraWaitingIssues, openQuestion, waitingLabelOf, waitsAs } from "../src/queue/waiting-issues.js";

const L = { needsInfo: "factory:needs-info", waiting: "factory:waiting-approval" };

describe("waitingLabelOf", () => {
  it("prefers needs-info, then waiting-approval, whatever the order", () => {
    expect(waitingLabelOf(["T", L.needsInfo], L)).toBe(L.needsInfo);
    expect(waitingLabelOf([L.needsInfo, "factory:done"], L)).toBe(L.needsInfo);
    expect(waitingLabelOf(["factory:done", L.waiting], L)).toBe(L.waiting);
    expect(waitingLabelOf([L.waiting, L.needsInfo], L)).toBe(L.needsInfo);
    expect(waitingLabelOf([L.needsInfo, L.waiting], L)).toBe(L.needsInfo);
    expect(waitingLabelOf(["T", "factory:done"], L)).toBeUndefined();
    expect(waitingLabelOf([], L)).toBeUndefined();
  });
});

describe("waitsAs", () => {
  const run = (over: Partial<RunSummary> = {}) => ({
    runId: "r1", flow: "issue-gitflow", repo: process.cwd(), status: "stopped", reason: 'stopped at step "ask_for_info"', history: [], ...over,
  }) as unknown as RunSummary;
  const retired = { flow: "no-such-flow", repo: "/nowhere" };
  it("needs-info: a stopped run that asks questions", () => {
    expect(waitsAs(run(), L.needsInfo, L)).toBe(true);
    expect(waitsAs(run(), L.waiting, L)).toBe(false);
  });
  it("needs-info: not when parked, retired, paused, stepped aside or stopped elsewhere", () => {
    expect(waitsAs(run({ parkedAt: "2026-01-01T00:00:00Z" }), L.needsInfo, L)).toBe(false);
    expect(waitsAs(run(retired), L.needsInfo, L)).toBe(false);
    expect(waitsAs(run({ reason: 'daily budget reached — stopped at step "ask_for_info"' }), L.needsInfo, L)).toBe(false);
    expect(waitsAs(run({ reason: 'stopped at step "wait_for_area"', history: [{ id: "claim_areas", output: "waiting for run r2 (x)" }] as never }), L.needsInfo, L)).toBe(false);
    expect(waitsAs(run({ reason: 'stopped at step "ask"' }), L.needsInfo, L)).toBe(false);
  });
  it("waiting-approval: a waiting run that is not retired", () => {
    expect(waitsAs(run({ status: "waiting", reason: undefined }), L.waiting, L)).toBe(true);
    expect(waitsAs(run({ status: "waiting", reason: undefined }), L.needsInfo, L)).toBe(false);
    expect(waitsAs(run({ status: "waiting", reason: undefined, ...retired }), L.waiting, L)).toBe(false);
  });
  it("an unknown label never matches", () => {
    expect(waitsAs(run(), "factory:done", L)).toBe(false);
  });
});

describe("openQuestion", () => {
  const bot = (body: string, createdAt = "2026-01-01T00:00:00Z") => ({ author: { login: "bot" }, body: `${body} <!-- claude-factory run=r1 -->`, createdAt }) as Comment;
  const human = { author: { login: "marcel" }, body: "ok", createdAt: "2026-01-01T02:00:00Z" } as Comment;
  const status = { author: { login: "bot" }, body: "status\n<!-- claude-factory status -->", createdAt: "2026-01-01T03:00:00Z" } as Comment;
  it("counts the questions of the newest bot comment", () => {
    expect(openQuestion([bot("**Q1.** a")])).toEqual({ questions: 1, since: "2026-01-01T00:00:00Z" });
    expect(openQuestion([bot("**Q1.** a"), bot("**Q1.** a\n**Q2.** b", "2026-01-01T01:00:00Z")])).toEqual({ questions: 2, since: "2026-01-01T01:00:00Z" });
    expect(openQuestion([bot("no markers")])?.questions).toBe(0);
  });
  it("skips a status comment", () => {
    expect(openQuestion([bot("**Q1.** a"), status])?.questions).toBe(1);
  });
  it("is undefined after a human comment, with only a status comment, or without comments", () => {
    expect(openQuestion([bot("**Q1.** a"), human])).toBeUndefined();
    expect(openQuestion([status])).toBeUndefined();
    expect(openQuestion([])).toBeUndefined();
  });
});

const c = (body: string) => ({ body }) as unknown as Comment;

/** A reader on a fake clock: every call takes `took` ms; it rejects when `fail` says so. */
function setup(o: { perReadMs?: number; budgetMs?: number; took?: number; fail?: (n: number) => boolean; skip?: (n: number) => boolean; onSlow?: (n: number) => void } = {}) {
  let t = 0;
  const timeouts: number[] = [];
  const read = vi.fn(async (n: number, timeoutMs: number) => {
    timeouts.push(timeoutMs);
    t += o.took ?? 0;
    if (o.fail?.(n)) throw new Error("gh failed");
    return [c(`#${n}`)];
  });
  const reads = commentReads({ read, perReadMs: o.perReadMs ?? 100, budgetMs: o.budgetMs ?? 1000, now: () => t, skip: o.skip, onSlow: o.onSlow });
  return { reads, read, timeouts };
}

describe("commentReads", () => {
  it("gives the comments and counts the elapsed time", async () => {
    const { reads } = setup({ perReadMs: 100, budgetMs: 150, took: 100 });
    expect(await reads.read(4)).toEqual([c("#4")]);
    expect(reads.exhausted).toBe(false);
    await reads.read(5); // 50 ms left
    expect(reads.exhausted).toBe(true);
  });

  it("passes min(per-read limit, time left) as the timeout", async () => {
    const { reads, timeouts } = setup({ perReadMs: 100, budgetMs: 250, took: 100 });
    await reads.read(1); await reads.read(2); await reads.read(3);
    expect(timeouts).toEqual([100, 100, 50]);
  });

  it("makes one call for two reads of the same issue, also when it failed", async () => {
    const { reads, read } = setup({ fail: (n) => n === 5 });
    const [a, b] = await Promise.all([reads.read(4), reads.read(4)]);
    expect(a).toBe(b);
    await reads.read(5); await reads.read(5);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await reads.read(5)).toBeUndefined();
  });

  it("counts the time of a rejection", async () => {
    const { reads, timeouts } = setup({ perReadMs: 100, budgetMs: 100, took: 80, fail: (n) => n === 1 });
    expect(await reads.read(1)).toBeUndefined();
    await reads.read(2);
    expect(timeouts).toEqual([100, 20]);
  });

  it("calls onSlow only when the rejection took the whole timeout", async () => {
    const onSlow = vi.fn();
    const slow = setup({ perReadMs: 100, took: 100, fail: () => true, onSlow });
    await slow.reads.read(4);
    expect(onSlow).toHaveBeenCalledWith(4);
    const onFast = vi.fn();
    const fast = setup({ perReadMs: 100, took: 10, fail: () => true, onSlow: onFast });
    await fast.reads.read(4);
    expect(onFast).not.toHaveBeenCalled();
  });

  it("does not ask for a skipped issue and uses no budget", async () => {
    const { reads, read } = setup({ skip: (n) => n === 5, budgetMs: 100, took: 10 });
    expect(reads.canRead(5)).toBe(false);
    expect(await reads.read(5)).toBeUndefined();
    expect(await reads.read(5)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(reads.exhausted).toBe(false);
  });

  it("gives undefined without a call once the budget is used up", async () => {
    const { reads, read } = setup({ perReadMs: 100, budgetMs: 100, took: 100 });
    await reads.read(4);
    expect(reads.exhausted).toBe(true);
    expect(reads.canRead(9)).toBe(false);
    expect(reads.canRead(4)).toBe(true);
    expect(await reads.read(9)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("never rejects", async () => {
    const sync = commentReads({ read: () => { throw new Error("sync"); }, perReadMs: 10, budgetMs: 100 });
    expect(await sync.read(1)).toBeUndefined();
    const bad = commentReads({
      read: () => Promise.reject(new Error("no")), perReadMs: 10, budgetMs: 100, now: () => 0,
      onSlow: () => { throw new Error("callback"); },
    });
    expect(await bad.read(1)).toBeUndefined();
  });
});

describe("extraWaitingIssues", () => {
  const issue = (number: number, labels: ({ name?: string } | string)[], state?: string | null) => ({ number, title: `t${number}`, state, labels });
  const none = new Set<string>();

  it("picks needs-info and waiting-approval issues, once each, sorted by number", () => {
    const all = [issue(9, [L.waiting]), issue(3, [{ name: "x" }]), issue(5, [L.waiting, L.needsInfo]), issue(5, [L.waiting]), issue(2, [{ name: L.needsInfo }])];
    expect(extraWaitingIssues(all, new Set(), L, none)).toEqual([
      { number: 2, title: "t2", label: L.needsInfo },
      { number: 5, title: "t5", label: L.needsInfo },
      { number: 9, title: "t9", label: L.waiting },
    ]);
  });
  it("leaves out listed, closed and excluded issues", () => {
    const all = [issue(1, [L.needsInfo]), issue(2, [L.needsInfo], "closed"), issue(3, [L.needsInfo], "CLOSED"), issue(4, [L.needsInfo, "skip"]), issue(5, [L.needsInfo], "OPEN"), issue(6, [L.needsInfo], null)];
    expect(extraWaitingIssues(all, new Set([1]), L, new Set(["skip"])).map((i) => i.number)).toEqual([5, 6]);
  });
});
