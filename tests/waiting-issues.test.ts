import { describe, expect, it, vi } from "vitest";
import type { Comment } from "../src/github.js";
import { commentReads } from "../src/queue/waiting-issues.js";

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
