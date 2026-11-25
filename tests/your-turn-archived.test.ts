import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { briefsOf } from "./helpers/briefs.js";
import { flowRepo } from "./helpers/flow-repo.js";
import { ConfigSchema } from "../src/config.js";
import { nextStep } from "../src/next-step.js";
import { candidatesFor } from "../src/server/clarity.js";
import type { ApiContext } from "../src/server/server.js";
import { turnMine } from "../src/server/turn-actions.js";
import { dismissTurn, turnFor } from "../src/server/your-turn.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const watcher = { id: "a", github_repo: "acme/app", flow: "github-issue" };

const run = (runId: string, over: Record<string, unknown> = {}) => ({
  runId, flow: "github-issue", flowDef: { steps: [] }, task: `task ${runId}`, vars: { github_repo: "acme/app" }, repo: flowRepo(),
  status: "failed", reason: "boom", runDir: "/tmp/none", startedAt: ago(1), finishedAt: ago(1), history: [], source: "ui",
  state: { next: null, steps: {}, visits: {} }, totalCostUsd: 0, ...over,
}) as never as import("../src/engine/state.js").RunSummary;

function stub(runs: ReturnType<typeof run>[], tracked: unknown[] = [], watchers: Record<string, unknown>[] = []) {
  const config = ConfigSchema.parse({ watchers });
  return {
    config: () => config,
    scheduler: {
      list: (n = 100) => runs.slice(0, n), get: (id: string) => runs.find((r) => r.runId === id), slimRuns: (n = 100) => runs.slice(0, n),
      slimOf: (id: string) => runs.find((r) => r.runId === id), statusOf: (id: string) => runs.find((r) => r.runId === id)?.status,
      runIndexReady: () => true, whenIndexReady: async () => {}, ownerOf: () => undefined, briefs: () => briefsOf(runs),
      queue: () => ({ pending: [], active: [] }), isActive: () => false,
    },
    watchers: { tracked: () => tracked, statuses: () => [] },
  } as unknown as ApiContext;
}
let home: string;
let saved: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "turn-archived-"));
  saved = process.env.FACTORY_HOME;
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(home, { recursive: true, force: true });
});
const ids = (ctx: ApiContext) => turnFor(ctx, NOW).all.map((i) => i.next.runId);

describe("Your turn and archived runs", () => {
  it("hides a tracked-issue item once its run is archived, and brings it back", () => {
    const failed = nextStep("failed", { repo: "acme/app", issue: 7, title: "T7", runId: "r1" }, { watched: true });
    const mk = (extra: object) => {
      const c = ConfigSchema.parse({ watchers: [watcher] });
      const tracked = [{ watcher: c.watchers[0], status: { id: "a", lastActions: [], lastOk: ago(0.001), holds: [{ issue: 7, reason: "x", next: failed, since: ago(1) }] }, issues: [{ issue: 7, title: "T7", runId: "r1" }] }];
      return stub([run("r1", { source: "watcher a issue #7", vars: { github_repo: "acme/app", issue: "7" }, ...extra })], tracked, [watcher]);
    };
    const open = mk({});
    expect(ids(open)).toContain("r1");
    expect(turnMine(open, { id: "adm" } as never, true, NOW).items.length).toBe(1);
    const archived = mk({ archivedAt: ago(0.1) });
    expect(ids(archived)).not.toContain("r1");
    expect(turnFor(archived, NOW).data.count).toBe(0);
    expect(turnMine(archived, { id: "adm" } as never, true, NOW).items).toEqual([]);
    expect(ids(mk({}))).toContain("r1");
  });

  it("lists a hand run, hides it when archived, and a dismissal made before still holds after unarchiving", () => {
    expect(ids(stub([run("h1")]))).toEqual(["h1"]);
    expect(ids(stub([run("h1", { archivedAt: ago(0.1) })]))).toEqual([]);
    const key = turnFor(stub([run("h1")]), NOW).all[0]!.key;
    dismissTurn(stub([run("h1")]), key, NOW);
    expect(turnFor(stub([run("h1")]), NOW).data.count).toBe(0); // dismissed: still hidden after the archive mark is gone
    expect(turnFor(stub([run("h1", { archivedAt: ago(0.1) })]), NOW).data.count).toBe(0);
  });

  describe("release runs", () => {
    const rel = (id: string, status: string, days: number, repo = "acme/app", over: Record<string, unknown> = {}) =>
      run(id, { flow: "release-daily", status, source: "watcher s schedule", vars: { github_repo: repo }, startedAt: ago(days), finishedAt: ago(days), ...over });

    it("lists a failed release alone, not after a later success of the repository", () => {
      expect(ids(stub([rel("f", "failed", 2)]))).toEqual(["f"]);
      expect(ids(stub([rel("f", "failed", 2), rel("ok", "succeeded", 1, "Acme/App")]))).toEqual([]);
    });

    it("lists it when the success is of another repository or started earlier", () => {
      expect(ids(stub([rel("f", "failed", 2), rel("ok", "succeeded", 1, "acme/other")]))).toEqual(["f"]);
      expect(ids(stub([rel("f", "failed", 1), rel("ok", "succeeded", 2)]))).toEqual(["f"]);
    });
  });
});

describe("clarity candidates", () => {
  const has = (runs: ReturnType<typeof run>[]) => candidatesFor(stub(runs), NOW).some((c) => c.next.runId === runs[0]!.runId);

  it("has no candidate for an archived run", () => {
    expect(has([run("h1", { finishedAt: ago(0.5) })])).toBe(true);
    expect(has([run("h1", { finishedAt: ago(0.5), archivedAt: ago(0.1) })])).toBe(false);
  });

  it("has no candidate for a superseded release run", () => {
    const f = run("f", { flow: "release-daily", source: "watcher s schedule", startedAt: ago(0.6), finishedAt: ago(0.5) });
    const ok = run("ok", { flow: "release-daily", status: "succeeded", startedAt: ago(0.4), finishedAt: ago(0.3) });
    expect(has([f])).toBe(true);
    expect(has([f, ok])).toBe(false);
  });
});
