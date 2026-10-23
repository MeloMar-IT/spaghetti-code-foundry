import { describe, expect, it } from "vitest";
import { onTurn } from "../src/clarity.js";
import { nextStep } from "../src/next-step.js";
import { boardFor } from "../src/server/board.js";
import { allNext, collectNext, knownRuns, oneIssueEach } from "../src/server/next.js";
import { turnFor } from "../src/server/your-turn.js";
import type { ApiContext } from "../src/server/server.js";
import { ago, cfg, hold, NOW, REPO, run, scenarioCtx, track, type Tracked } from "./helpers/scenarios.js";

// One record per issue when several watchers list it (#654). Unit tests: a stub context, no server, no GitHub.

const A = { id: "a", github_repo: REPO, flow: "github-issue", label: "la" };
const B = { ...A, id: "b", label: "lb" };
const url = (n: number, repo = REPO) => `https://github.com/${repo}/issues/${n}`;
const step = (kind: Parameters<typeof nextStep>[0], n: number, data: Record<string, unknown> = {}, repo = REPO) =>
  nextStep(kind, { repo, issue: n, title: `Story ${n}` }, { watched: true, issueUrl: url(n, repo), ...data });
const failedHold = (n: number, runId: string, repo = REPO) => hold(step("failed", n, { runId }, repo));
const failedRun = (id: string, n: number, over: Record<string, unknown> = {}) => run(id, { vars: { github_repo: REPO, issue: String(n) }, ...over });

const c = cfg([A, B]);
const ctxOf = (tracked: Tracked[], runs: ReturnType<typeof run>[] = []): ApiContext => scenarioCtx({ config: c, runs, tracked });
const issuesOf = (ctx: ApiContext) => collectNext(ctx, knownRuns(ctx)).issues;
/** Runs one check with the watchers in both orders. */
const orders = (ta: Tracked, tb: Tracked, check: (tracked: Tracked[], first: "a" | "b") => void) => {
  check([ta, tb], "a");
  check([tb, ta], "b");
};
const cardsFor = (ctx: ApiContext) => boardFor(ctx, NOW).repos.flatMap((r) => r.columns.flatMap((col) => col.cards)).filter((card) => card.issue === 4);
const items = (ctx: ApiContext) => turnFor(ctx, NOW).data.groups.flatMap((g) => g.items);

describe("one record per issue", () => {
  it("ignores the case of the repository, on every view", () => {
    const upper = cfg([A, { ...B, github_repo: "Acme/App" }]);
    const q = (repo: string) => hold(step("questions", 4, { questions: 1 }, repo));
    const ctx = scenarioCtx({
      config: upper, runs: [],
      tracked: [track(upper, [q(REPO)], [{ issue: 4, title: "Story 4" }], {}, 0), track(upper, [q("Acme/App")], [{ issue: 4, title: "Story 4" }], {}, 1)],
    });
    expect(issuesOf(ctx)).toHaveLength(1);
    expect(allNext(ctx).issues).toHaveLength(1);
    expect(items(ctx).filter((i) => i.next.issue === 4)).toHaveLength(1);
    expect(cardsFor(ctx)).toHaveLength(1);
  });

  it("shows one Board card for a differently cased live run or queued job", () => {
    const upper = cfg([{ ...A, github_repo: "Acme/App" }]);
    const waiting = track(upper, [hold(step("questions", 4, { questions: 1 }, "Acme/App"))], [{ issue: 4, title: "Story 4" }], {}, 0);
    const live = run("rL", { status: "running", finishedAt: undefined, startedAt: ago(0.01), vars: { github_repo: REPO, issue: "4" } });
    const ctx = scenarioCtx({ config: upper, runs: [live], active: ["rL"], tracked: [waiting] });
    expect(cardsFor(ctx)).toHaveLength(1);
    const queued = scenarioCtx({ config: upper, runs: [], tracked: [waiting], pending: ["rQ"] });
    (queued.scheduler as unknown as { queue: () => unknown }).queue = () => ({ active: [], pending: [{ runId: "rQ", kind: "run", githubRepo: REPO, issue: "4", enqueuedAt: ago(0.01) }] });
    expect(cardsFor(queued)).toHaveLength(1);
  });

  it("counts a run as shown when the repository is spelled differently", () => {
    const candidate = { next: step("failed", 4, { runId: "rB" }, REPO) };
    const shown = [{ key: "k", next: step("failed", 4, { runId: "rA" }, "Acme/App") }];
    expect(onTurn(candidate, shown)).toBe(true);
  });

  it("keeps an ordinary listing over an extra, whichever comes first", () => {
    const ta = track(c, [failedHold(4, "r1")], [{ issue: 4, title: "Story 4", runId: "r1" }], {}, 0);
    const tb = track(c, [hold(step("questions", 4, { questions: 1 }), { byLabel: true })], [{ issue: 4, title: "Story 4", extra: true }], {}, 1);
    const r1 = failedRun("r1", 4);
    orders(ta, tb, (tracked) => {
      const kept = issuesOf(ctxOf(tracked, [r1]));
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ watcher: "a", next: { runId: "r1" } });
    });
  });

  it("keeps an ordinary listing that does not need you over an extra that does", () => {
    const ta = track(c, [], [{ issue: 4, title: "Story 4" }], {}, 0);
    const tb = track(c, [hold(step("questions", 4, { questions: 1 }), { byLabel: true })], [{ issue: 4, title: "Story 4", extra: true }], {}, 1);
    orders(ta, tb, (tracked) => {
      const kept = issuesOf(ctxOf(tracked));
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ watcher: "a", next: { kind: "starting" } });
    });
  });

  it("keeps the one that needs you", () => {
    const ta = track(c, [hold(step("dependency", 4, { blockers: [{ issue: 3 }] }))], [{ issue: 4, title: "Story 4" }], {}, 0);
    const tb = track(c, [hold(step("questions", 4, { questions: 1 }))], [{ issue: 4, title: "Story 4" }], {}, 1);
    orders(ta, tb, (tracked) => {
      const kept = issuesOf(ctxOf(tracked));
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ watcher: "b", next: { kind: "questions" } });
    });
  });

  it("keeps the first watcher's failed run, with no separate run item", () => {
    const ta = track(c, [failedHold(7, "r1")], [{ issue: 7, title: "Story 7", runId: "r1" }], {}, 0);
    const tb = track(c, [failedHold(7, "r2")], [{ issue: 7, title: "Story 7", runId: "r2" }], {}, 1);
    const runs = [failedRun("r1", 7), failedRun("r2", 7)];
    orders(ta, tb, (tracked, first) => {
      const ctx = ctxOf(tracked, runs);
      const want = first === "a" ? "r1" : "r2";
      expect(issuesOf(ctx).map((i) => i.next.runId)).toEqual([want]);
      expect(items(ctx).filter((i) => i.next.issue === 7).map((i) => i.next.runId)).toEqual([want]);
    });
  });

  it("keeps a waiting decision on the Board when another watcher's live run is listed", () => {
    // A's decision (failed run r1) needs the user; B's run r2 is live. The card keeps A's decision.
    const ta = track(c, [failedHold(4, "r1")], [{ issue: 4, title: "Story 4", runId: "r1" }], {}, 0);
    const tb = track(c, [], [{ issue: 4, title: "Story 4", runId: "r2" }], {}, 1);
    const runs = [failedRun("r1", 4), run("r2", { status: "running", finishedAt: undefined, startedAt: ago(0.01), vars: { github_repo: REPO, issue: "4" } })];
    orders(ta, tb, (tracked) => {
      const ctx = scenarioCtx({ config: c, runs, active: ["r2"], tracked });
      const cards = boardFor(ctx, NOW).repos.flatMap((r) => r.columns.flatMap((col) => col.cards)).filter((card) => card.issue === 4);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ next: { kind: "failed" }, runId: "r1" });
    });
  });

  it("keeps a failed run over a starting record", () => {
    const ta = track(c, [], [{ issue: 7, title: "Story 7" }], {}, 0);
    const tb = track(c, [failedHold(7, "r2")], [{ issue: 7, title: "Story 7", runId: "r2" }], {}, 1);
    orders(ta, tb, (tracked) => {
      const kept = issuesOf(ctxOf(tracked, [failedRun("r2", 7)]));
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ watcher: "b", next: { kind: "failed", runId: "r2" } });
    });
  });
});

describe("a waiting-label listing speaks for the runs of its story", () => {
  const stopped = 'stopped at step "ask_for_info"';
  const rA = run("rA", { status: "stopped", reason: stopped, vars: { github_repo: REPO, issue: "4", trigger_label: "la" }, startedAt: ago(2), finishedAt: ago(2) });
  const rX = run("rX", { flow: "removed-flow", status: "stopped", reason: stopped, vars: { github_repo: REPO, issue: "4" }, startedAt: ago(1), finishedAt: ago(1) });
  const lister = track(c, [hold(step("questions", 4, { questions: 1 }), { byLabel: true })], [{ issue: 4, title: "Story 4", extra: true }], {}, 1);

  it("gives one item for the issue, with the run of the watcher that links it, in both orders", () => {
    const ta = track(c, [hold(step("planner_questions", 4, { runId: "rA" }), { byLabel: true })], [{ issue: 4, title: "Story 4", runId: "rA" }], {}, 0);
    orders(ta, lister, (tracked) => {
      const found = items(ctxOf(tracked, [rX, rA])).filter((i) => i.next.issue === 4);
      expect(found).toHaveLength(1);
      expect(found[0]!.next.runId).toBe("rA");
    });
  });

  it("builds the set from every watcher, also the extra that the dedupe drops", () => {
    // A lists #4 ordinarily and holds nothing by label; only B's extra speaks for the story.
    const ta = track(c, [failedHold(4, "rA")], [{ issue: 4, title: "Story 4", runId: "rA" }], {}, 0);
    orders(ta, lister, (tracked) => {
      const found = items(ctxOf(tracked, [rX, rA])).filter((i) => i.next.issue === 4);
      expect(found.map((i) => i.next.runId)).toEqual(["rA"]);
    });
    // Without that extra, the run of the removed flow gets its own item.
    const alone = items(ctxOf([ta], [rX, rA])).filter((i) => i.next.issue === 4);
    expect(alone.map((i) => i.next.runId)).toContain("rX");
  });
});

describe("oneIssueEach", () => {
  const e = (key: string, kind: "questions" | "starting", extra?: true, tag = "") => ({ key, tag, next: step(kind, 1), ...(extra ? { extra } : {}) });

  it("keeps the place of the first, even when a later one replaces it", () => {
    const out = oneIssueEach([e("a/b#1", "starting", undefined, "first"), e("a/b#2", "starting"), e("A/B#1", "questions", undefined, "later")]);
    expect(out.map((o) => o.tag)).toEqual(["later", ""]);
    expect(out.map((o) => o.key)).toEqual(["A/B#1", "a/b#2"]);
  });

  it("returns a list without duplicates unchanged", () => {
    const list = [e("a/b#1", "starting"), e("a/b#2", "questions", true)];
    expect(oneIssueEach(list)).toEqual(list);
  });

  it("ignores rank: equal extra and needs-you keep the first watcher, in both orders", () => {
    const ta = track(c, [], [{ issue: 4, title: "Story 4" }], {}, 0);
    const tb = track(c, [], [{ issue: 4, title: "Story 4", runId: "r2" }], {}, 1);
    const running = run("r2", { status: "running", finishedAt: undefined, startedAt: ago(0.01), vars: { github_repo: REPO, issue: "4" } });
    orders(ta, tb, (tracked, first) => {
      const kept = issuesOf(scenarioCtx({ config: c, runs: [running], active: ["r2"], tracked }));
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ watcher: first, next: { kind: first === "a" ? "starting" : "running" } });
    });
  });

  it("lets an ordinary listing win over an extra, and the first win a tie", () => {
    expect(oneIssueEach([e("a/b#1", "questions", true, "x"), e("a/b#1", "starting", undefined, "y")]).map((o) => o.tag)).toEqual(["y"]);
    expect(oneIssueEach([e("a/b#1", "questions", undefined, "x"), e("a/b#1", "questions", undefined, "y")]).map((o) => o.tag)).toEqual(["x"]);
  });
});
