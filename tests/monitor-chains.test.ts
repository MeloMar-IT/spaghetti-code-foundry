import { describe, expect, it } from "vitest";
import { WatcherSchema } from "../src/config.js";
import { chainLists, deadChains } from "../src/monitor/chains.js";
import type { IssueListInput } from "../src/monitor/detectors.js";
import type { RunState } from "../src/monitor/unlisted.js";
import type { IssueRecord, RepoIssueList } from "../src/queue/issue-list.js";
import { labelNames } from "../src/queue/watcher.js";

const OK = "2026-10-01T12:00:00.000Z";
const rec = (number: number, dependsOn: number[] = [], over: Partial<IssueRecord> = {}): IssueRecord =>
  ({ number, title: `t${number}`, state: "open", labels: ["claude-factory"], createdAt: OK, dependsOn, ...over });
const saved = (repo: string, issues: IssueRecord[], over: Partial<RepoIssueList> = {}): RepoIssueList => ({ repo, readAt: OK, cut: false, issues, ...over });
const watcher = (over: Record<string, unknown> = {}, status: Record<string, unknown> = {}) => {
  const cfg = WatcherSchema.parse({ id: "w", github_repo: "acme/app", every: "5m", ...over });
  return { cfg, status: { id: cfg.id, lastActions: [], lastOk: OK, ...status } as never };
};
const ISSUES = [rec(1, [7]), rec(7), rec(8)];
const none = (): RunState => "none";

describe("chainLists", () => {
  // gitflow is stubbed off: the default would read the real flow files.
  const lists = (watchers: ReturnType<typeof watcher>[], read: (repo: string) => RepoIssueList | undefined, runState: (repo: string, issue: number) => RunState = none, stories?: Set<string>) =>
    chainLists({ watchers, read, runState, gitflow: () => false, ...(stories ? { stories } : {}) });

  it("returns the list of an eligible watcher", () => {
    const out = lists([watcher()], (r) => saved(r, ISSUES));
    expect(out).toEqual([{ repo: "acme/app", watchers: ["w"], labels: ["claude-factory"], done: [], cut: false, issues: ISSUES, parked: [], skip: [] }]);
  });

  it("asks runState only for open, triggered issues that another issue names", () => {
    const asked: number[] = [];
    const issues = [rec(1, [7, 8, 9]), rec(7), rec(8, [], { labels: [] }), rec(9, [], { state: "closed" }), rec(10)];
    const out = lists([watcher()], (r) => saved(r, issues), (_r, n) => { asked.push(n); return n === 7 ? "parked" : "unknown"; });
    expect(asked).toEqual([7]);
    expect(out[0]!.parked).toEqual([7]);
  });

  it("counts unknown, none, open and a throwing runState as not parked", () => {
    for (const s of ["unknown", "none", "open"] as RunState[]) expect(lists([watcher()], (r) => saved(r, ISSUES), () => s)[0]!.parked).toEqual([]);
    expect(lists([watcher()], (r) => saved(r, ISSUES), () => { throw new Error("x"); })[0]!.parked).toEqual([]);
  });

  it("leaves out watchers and lists that cannot be trusted", () => {
    const read = (r: string) => saved(r, ISSUES);
    expect(lists([watcher({ enabled: false })], read)).toEqual([]);
    expect(lists([watcher({}, { lastError: "x" })], read)).toEqual([]);
    expect(lists([watcher({}, { lastOk: undefined })], read)).toEqual([]);
    expect(lists([watcher({ source: "ci-failures" })], read)).toEqual([]);
    const noRepo = watcher();
    expect(lists([{ ...noRepo, cfg: { ...noRepo.cfg, github_repo: undefined } as never }], read)).toEqual([]);
    expect(lists([watcher()], () => undefined)).toEqual([]);
    expect(lists([watcher()], (r) => saved(r, ISSUES, { cut: true }))).toEqual([]);
    expect(lists([watcher()], (r) => saved(r, ISSUES, { readAt: "2026-10-01T11:00:00.000Z" }))).toEqual([]); // older than `every`
    expect(lists([watcher({ every: "soon" })], read)).toEqual([]);
  });

  it("never throws", () => {
    expect(lists([watcher()], () => { throw new Error("x"); })).toEqual([]);
    expect(chainLists({ watchers: null as never, runState: none })).toEqual([]);
  });

  it("collects the configured completion labels, and the gitflow done label only on a gitflow watcher", () => {
    const read = (r: string) => saved(r, ISSUES);
    const p = watcher({ id: "p", dependency_done_labels: ["Factory_done"] });
    const g = watcher({ id: "g", label: "other" });
    expect(lists([p], read)[0]!.done).toEqual(["Factory_done"]);
    const out = chainLists({ watchers: [p, g], read, runState: none, gitflow: (cfg) => cfg.id === "g" });
    expect(out[0]!.done).toEqual(["Factory_done", labelNames(g.cfg).done].sort());
  });

  it("gives one entry for two watchers of a repository, with both labels", () => {
    const out = lists([watcher({ id: "b", label: "other" }), watcher({ id: "a" })], (r) => saved(r, ISSUES));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ watchers: ["a", "b"], labels: ["other", "claude-factory"] });
  });

  it("is the same for mixed casing and either order of the watchers, even when the first spelling has no list", () => {
    const read = (r: string) => (r === "acme/app" ? saved(r, ISSUES) : undefined);
    const a = watcher({ id: "a", github_repo: "Acme/App" });
    const b = watcher({ id: "b", github_repo: "acme/app" });
    const one = lists([a, b], read);
    const two = lists([b, a], read);
    expect(one).toHaveLength(1);
    expect(one[0]!.repo).toBe("acme/app");
    expect(one).toEqual(two);
  });

  it("takes the newest of two saved spellings", () => {
    const read = (r: string) => saved(r, r === "Acme/App" ? [rec(2)] : [rec(3)], { readAt: r === "Acme/App" ? "2026-10-01T11:59:00.000Z" : "2026-10-01T11:58:00.000Z" });
    const out = lists([watcher({ github_repo: "acme/app" }), watcher({ id: "x", github_repo: "Acme/App" })], read);
    expect(out[0]!.issues.map((i) => i.number)).toEqual([2]);
  });

  it("marks the issues of the monitor's bug stories, current and earlier", () => {
    const out = lists([watcher()], (r) => saved(r, ISSUES), none, new Set(["acme/app#1", "acme/app#8", "acme/app#99"]));
    expect(out[0]!.skip).toEqual([1, 8]);
  });
});

describe("deadChains", () => {
  const L = (issues: IssueRecord[], over: Partial<IssueListInput> = {}): IssueListInput =>
    ({ repo: "acme/app", watchers: ["w"], labels: ["claude-factory"], cut: false, issues, parked: [], ...over });
  const bare = (n: number, over: Partial<IssueRecord> = {}) => rec(n, [], { labels: [], ...over });

  it("shows the shortest chain, sorted by story number", () => {
    const out = deadChains(L([rec(3, [2, 7]), rec(2, [7]), rec(1, [3]), bare(7)]));
    expect(out).toEqual([{ issue: 7, reason: "no-label", chains: [[1, 3, 7], [2, 7], [3, 7]] }]);
  });

  it("does not follow past a blocker", () => {
    expect(deadChains(L([rec(1, [7]), bare(7, { dependsOn: [8] }), bare(8)])).map((e) => e.issue)).toEqual([7]);
  });

  it("ignores a dependsOn that is not an array, and a self dependency", () => {
    expect(deadChains(L([rec(1, 5 as never), rec(2, [2])]))).toEqual([]);
  });

  it("gives [] for a cut list", () => {
    expect(deadChains(L([rec(1, [7]), bare(7)], { cut: true }))).toEqual([]);
  });
});
