import { describe, expect, it } from "vitest";
import { WatcherSchema } from "../src/config.js";
import type { IssueRecord, RepoIssueList } from "../src/queue/issue-list.js";
import { unlistedCandidates, UnlistedTracker, type RunState } from "../src/monitor/unlisted.js";

const T = "2026-10-01T12:00:00.000Z";
const at = (min: number) => new Date(Date.parse(T) + min * 60_000).toISOString();
const rec = (number: number, labels: string[] = ["factory:needs-info"], over: Partial<IssueRecord> = {}): IssueRecord => ({ number, title: "t", state: "open", labels, createdAt: T, dependsOn: [], ...over });
const list = (issues: IssueRecord[], readAt = T): RepoIssueList => ({ repo: "acme/app", readAt, cut: false, issues });
const cfg = (over: Record<string, unknown> = {}) => WatcherSchema.parse({ id: "w", github_repo: "acme/app", every: "5m", ...over });
const ok = (over: Record<string, unknown> = {}) => ({ id: "w", lastActions: [], lastOk: T, ...over }) as never;

function run(issues: IssueRecord[], o: { watchers?: { cfg: ReturnType<typeof cfg>; status: never }[]; listed?: { repo: string; issue: number }[]; stories?: string[]; runState?: (r: string, i: number) => RunState; readAt?: string } = {}) {
  return unlistedCandidates({
    watchers: o.watchers ?? [{ cfg: cfg(), status: ok() }],
    listed: o.listed ?? [],
    stories: new Set(o.stories ?? []),
    runState: o.runState ?? (() => "none"),
    read: () => list(issues, o.readAt),
  });
}
const numbers = (c: { issue: number }[]) => c.map((x) => x.issue);

describe("unlistedCandidates", () => {
  it("picks open waiting issues, leaves out closed and listed ones (repo case is ignored)", () => {
    const out = run([rec(1), rec(2, ["factory:waiting-approval"]), rec(3, ["factory:needs-info"], { state: "closed" }), rec(4), rec(5, ["bug"])], { listed: [{ repo: "ACME/app", issue: 4 }] });
    expect(out).toEqual([
      { watcher: "w", repo: "acme/app", issue: 1, label: "needs-info" },
      { watcher: "w", repo: "acme/app", issue: 2, label: "waiting-approval" },
    ]);
  });
  it("reports needs-info when both labels are present", () => {
    expect(run([rec(1, ["factory:waiting-approval", "factory:needs-info"])])[0]!.label).toBe("needs-info");
  });
  it("leaves out epics: stories, epicLabel.issue, epic and parent", () => {
    const out = run([rec(1, undefined, { stories: [5] }), rec(2), rec(3), rec(4), rec(5), rec(6, [], { epicLabel: { name: "e", issue: 2 } }), rec(7, [], { epic: 3 }), rec(8, [], { parent: 4 })]);
    expect(numbers(out)).toEqual([5]);
  });
  it("leaves out an issue with an excluded label", () => {
    expect(numbers(run([rec(1, ["factory:needs-info", "skip"]), rec(2)], { watchers: [{ cfg: cfg({ exclude_labels: ["skip"] }), status: ok() }] }))).toEqual([2]);
  });
  it("leaves out the issues of current and earlier bug stories", () => {
    expect(numbers(run([rec(12), rec(13), rec(14)], { stories: ["acme/app#12", "acme/app#13"] }))).toEqual([14]);
  });
  describe("the newest run", () => {
    it("keeps none and open, with and without the trigger label", () => {
      for (const s of ["none", "open"] as RunState[]) expect(numbers(run([rec(1), rec(2, ["factory:needs-info", "claude-factory"])], { runState: () => s }))).toEqual([1, 2]);
    });
    it("skips parked without the trigger label, keeps it with the label", () => {
      expect(numbers(run([rec(1), rec(2, ["factory:needs-info", "claude-factory"])], { runState: () => "parked" }))).toEqual([2]);
    });
    it("skips unknown with and without the trigger label", () => {
      expect(run([rec(1), rec(2, ["factory:needs-info", "claude-factory"])], { runState: () => "unknown" })).toEqual([]);
    });
    it("is asked only for issues that pass every other rule", () => {
      const asked: number[] = [];
      run([rec(1, undefined, { stories: [9] }), rec(3), rec(4), rec(5, ["bug"])], { listed: [{ repo: "acme/app", issue: 3 }], stories: ["acme/app#4"], runState: (_r, i) => (asked.push(i), "none") });
      expect(asked).toEqual([]);
    });
  });
  it("uses custom status label names", () => {
    const w = [{ cfg: cfg({ status_labels: { needs_info: "ask", waiting: "approve" } }), status: ok() }];
    const out = run([rec(1, ["factory:needs-info"]), rec(2, ["ask"]), rec(3, ["approve"])], { watchers: w });
    expect(out.map((c) => [c.issue, c.label])).toEqual([[2, "needs-info"], [3, "waiting-approval"]]);
  });
  it("skips a watcher with lastError, without lastOk, a disabled one and one that is not an issues watcher", () => {
    const all = [
      { cfg: cfg(), status: ok({ lastError: "x" }) },
      { cfg: cfg(), status: ok({ lastOk: undefined }) },
      { cfg: cfg({ enabled: false }), status: ok() },
      { cfg: cfg({ source: "ci-failures" }), status: ok() },
    ];
    for (const w of all) expect(run([rec(1)], { watchers: [w] })).toEqual([]);
  });
  it("skips a stale list and keeps a fresh one", () => {
    expect(run([rec(1)], { readAt: at(-6) })).toEqual([]);
    expect(run([rec(1)], { readAt: at(-4) })).toHaveLength(1);
  });
  it("gives an issue of one repo to the first watcher only; the second gets it when the first excludes it", () => {
    const two = [{ cfg: cfg({ id: "a" }), status: ok() }, { cfg: cfg({ id: "b" }), status: ok() }];
    expect(run([rec(1)], { watchers: two }).map((c) => c.watcher)).toEqual(["a"]);
    const first = [{ cfg: cfg({ id: "a", exclude_labels: ["factory:needs-info"] }), status: ok() }, two[1]!];
    expect(run([rec(1)], { watchers: first }).map((c) => c.watcher)).toEqual(["b"]);
  });
  it("skips an issue some watcher holds for its dependencies, in either watcher order and for any repo case", () => {
    const dep = (issue: number, kind = "dependency") => ({ holds: [{ issue, next: { kind } }] });
    const holder = { cfg: cfg({ id: "a", github_repo: "ACME/app" }), status: ok(dep(1)) };
    const other = { cfg: cfg({ id: "b" }), status: ok() };
    expect(numbers(run([rec(1), rec(2)], { watchers: [holder, other] }))).toEqual([2]);
    expect(numbers(run([rec(1), rec(2)], { watchers: [other, holder] }))).toEqual([2]);
  });
  it("keeps an issue whose hold is of another kind or belongs to another issue", () => {
    const w = (h: object) => [{ cfg: cfg(), status: ok(h) }];
    expect(numbers(run([rec(1)], { watchers: w({ holds: [{ issue: 1, next: { kind: "questions" } }] }) }))).toEqual([1]);
    expect(numbers(run([rec(1)], { watchers: w({ holds: [{ issue: 2, next: { kind: "dependency" } }] }) }))).toEqual([1]);
  });
  it("returns [] and does not throw when read or runState throws", () => {
    const boom = () => { throw new Error("x"); };
    expect(unlistedCandidates({ watchers: [{ cfg: cfg(), status: ok() }], listed: [], stories: new Set(), runState: () => "none", read: boom })).toEqual([]);
    expect(run([rec(1)], { runState: boom })).toEqual([]);
  });
});

describe("UnlistedTracker", () => {
  const c = (issue: number) => ({ watcher: "w", repo: "acme/app", issue, label: "needs-info" as const });
  const t0 = new Date(T);
  it("keeps since across calls", () => {
    const t = new UnlistedTracker();
    t.build(t0, () => [c(1)], []);
    expect(t.build(new Date(at(10)), () => [c(1)], [])![0]!.since).toBe(T);
  });
  it("forgets an issue that went away and starts fresh when it comes back", () => {
    const t = new UnlistedTracker();
    t.build(t0, () => [c(1)], []);
    expect(t.build(new Date(at(5)), () => [], [])).toEqual([]);
    expect(t.build(new Date(at(10)), () => [c(1)], [])![0]!.since).toBe(at(10));
  });
  it("returns undefined without calling candidates when listed is unknown, and resets", () => {
    const t = new UnlistedTracker();
    t.build(t0, () => [c(1)], []);
    let called = false;
    expect(t.build(new Date(at(5)), () => ((called = true), []), undefined)).toBeUndefined();
    expect(called).toBe(false);
    expect(t.build(new Date(at(10)), () => [c(1)], [])![0]!.since).toBe(at(10));
  });
});
