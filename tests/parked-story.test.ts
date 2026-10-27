import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { boardFor } from "../src/server/board.js";
import { allNext } from "../src/server/next.js";
import { turnFor } from "../src/server/your-turn.js";
import { STOPPED_CANCEL_REASON } from "../src/engine/state.js";
import { needsUser } from "../src/your-turn.js";
import { isPaused } from "../src/queue/waiting-issues.js";
import { ago, cfg, issuesWatcher, NOW, run, scenarioCtx, track } from "./helpers/scenarios.js";

let home: string;
const saved = process.env.FACTORY_HOME;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "parked-")); process.env.FACTORY_HOME = home; });
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const c = cfg([issuesWatcher]);
const vars = { github_repo: "acme/app", issue: "7" };
const asks = (id: string, over: Record<string, unknown> = {}) =>
  run(id, { vars, status: "stopped", reason: 'stopped at step "send_back" — needs attention', ...over });
type Ctx = ReturnType<typeof scenarioCtx>;
const items = (ctx: Ctx) => turnFor(ctx, NOW).data.groups.flatMap((g) => g.items);
const cards = (ctx: Ctx) => boardFor(ctx, NOW).repos.flatMap((r) => r.columns.flatMap((col) => col.cards));
const recordOf = (ctx: Ctx, id: string) => allNext(ctx).runs.find((n) => n.runId === id);

describe("a parked story", () => {
  it("is not waiting for the person on any page", () => {
    const r = asks("r1", { parkedAt: ago(0.1) });
    const ctx = scenarioCtx({ config: c, runs: [r], tracked: [track(c, [], [{ issue: 99, title: "Other" }])] });
    const rec = recordOf(ctx, "r1")!;
    expect(rec).toMatchObject({ kind: "parked", who: "Foundry", status: "parked — not tracked by a watcher", action: "Nothing — the story is parked" });
    expect(needsUser(rec)).toBe(false);
    expect(items(ctx).filter((i) => i.next.issue === 7)).toEqual([]);
    expect(cards(ctx).filter((k) => k.issue === 7)).toEqual([]);
  });

  it("an ask_for_info stop is parked too", () => {
    const r = asks("r1", { reason: 'stopped at step "ask_for_info" — needs attention', parkedAt: ago(0.1) });
    const ctx = scenarioCtx({ config: c, runs: [r], tracked: [track(c, [], [])] });
    expect(recordOf(ctx, "r1")?.kind).toBe("parked");
  });

  it("a story that keeps its label still waits for the person", () => {
    const r = asks("r1");
    const ctx = scenarioCtx({ config: c, runs: [r], tracked: [track(c, [], [{ issue: 7, title: "Seven", runId: "r1" }])] });
    const rec = recordOf(ctx, "r1")!;
    expect(rec.kind).toBe("planner_questions");
    expect(rec.status).toBe("waiting for you — questions");
    expect(needsUser(rec)).toBe(true);
  });

  it("after the label is added again the old run is replaced and the issue follows the new run", () => {
    const old = asks("r1", { parkedAt: ago(0.1), startedAt: ago(1), finishedAt: ago(1) });
    const fresh = run("r2", { vars, status: "running", reason: undefined, finishedAt: undefined, startedAt: ago(0.01) });
    const ctx = scenarioCtx({ config: c, runs: [fresh, old], active: ["r2"], tracked: [track(c, [], [{ issue: 7, title: "Seven", runId: "r2" }])] });
    expect(recordOf(ctx, "r1")?.kind).toBe("superseded");
    expect(recordOf(ctx, "r2")?.kind).toBe("running");
  });
});

describe("a story waiting for another story", () => {
  it("is a dependency, asks nobody, and the watcher counts it as paused", () => {
    const r = run("r1", {
      vars, status: "stopped", reason: 'stopped at step "wait_for_story" — needs attention',
      history: [{ id: "wait_for_story", type: "shell", visit: 1, ok: true, output: "WAITS_FOR: #12\nPARKED" }],
    });
    const ctx = scenarioCtx({ config: c, runs: [r], tracked: [track(c, [], [{ issue: 7, title: "Seven", runId: "r1" }])] });
    const rec = recordOf(ctx, "r1")!;
    expect(rec.kind).toBe("dependency");
    expect(rec.why).toContain("waits for #12");
    expect(needsUser(rec)).toBe(false);
    expect(items(ctx).filter((i) => i.next.issue === 7)).toEqual([]);
    expect(isPaused(r)).toBe(true);
  });
});

describe("a stopped run that was cancelled", () => {
  it("is not waiting for the person and has no card", () => {
    const r = run("r1", { vars, status: "cancelled", reason: STOPPED_CANCEL_REASON });
    const ctx = scenarioCtx({ config: c, runs: [r], tracked: [track(c, [], [{ issue: 7, title: "Seven", runId: "r1" }])] });
    const rec = recordOf(ctx, "r1")!;
    expect(rec).toMatchObject({ kind: "cancelled", ended: true, who: "Foundry", status: "cancelled — nothing to do" });
    expect(needsUser(rec)).toBe(false);
    expect(items(ctx).filter((i) => i.next.issue === 7)).toEqual([]);
    expect(cards(ctx).filter((k) => k.issue === 7)).toEqual([]);
  });
});
