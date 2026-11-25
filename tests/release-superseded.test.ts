import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveSupersededReleases, hiddenRuns, reconcileSupersededInBatches, reconcileSupersededReleases, releaseSettled, retainedSuccesses, SUPERSEDED_BY, supersededReleases, type ReleaseBrief } from "../src/release/superseded.js";

const T = (day: number) => new Date(Date.UTC(2026, 9, day)).toISOString();
const b = (runId: string, status: string, day: number, over: Partial<ReleaseBrief> = {}): ReleaseBrief =>
  ({ runId, flow: "release-daily", status, startedAt: T(day), githubRepo: "acme/app", ...over }) as ReleaseBrief;
const stub = (list: ReleaseBrief[], answer: string | ((id: string) => string) = "done") => {
  const setArchived = vi.fn((id: string) => (typeof answer === "function" ? answer(id) : answer));
  return { briefs: () => list, setArchived } as never as Parameters<typeof reconcileSupersededReleases>[0] & { setArchived: typeof setArchived };
};
const ids = (l: ReleaseBrief[]) => l.map((x) => x.runId);

describe("supersededReleases", () => {
  it("finds a failed run that started before a later success of the same flow and repository (any case)", () => {
    expect(ids(supersededReleases([b("old", "failed", 1), b("new", "succeeded", 2, { githubRepo: "Acme/App" })]))).toEqual(["old"]);
  });

  it("finds stopped runs and leaves the others", () => {
    const list = [b("s", "stopped", 1), b("f", "failed", 2), b("ok", "succeeded", 3), b("w", "waiting", 1), b("arch", "failed", 1, { archived: true })];
    expect(ids(supersededReleases(list)).sort()).toEqual(["f", "s"]);
  });

  it("keeps a run when the success is earlier, of another repository or of another flow", () => {
    expect(supersededReleases([b("f", "failed", 2), b("ok", "succeeded", 1)])).toEqual([]);
    expect(supersededReleases([b("f", "failed", 1), b("ok", "succeeded", 2, { githubRepo: "acme/other" })])).toEqual([]);
    expect(supersededReleases([b("f", "failed", 1), b("ok", "succeeded", 2, { flow: "daily-pr" })])).toEqual([]);
  });

  it("ignores other flows, runs without a repository and a bad start time", () => {
    expect(supersededReleases([b("f", "failed", 1, { flow: "github-issue" }), b("ok", "succeeded", 2, { flow: "github-issue" })])).toEqual([]);
    expect(supersededReleases([b("f", "failed", 1, { githubRepo: undefined }), b("ok", "succeeded", 2, { githubRepo: undefined })])).toEqual([]);
    expect(supersededReleases([b("f", "failed", 1, { startedAt: "nope" }), b("ok", "succeeded", 2)])).toEqual([]);
  });
});

describe("hiddenRuns", () => {
  it("has archived runs of any flow and superseded release runs", () => {
    const h = hiddenRuns([b("a", "failed", 1, { flow: "github-issue", archived: true }), b("old", "failed", 1), b("new", "succeeded", 2), b("keep", "failed", 3)]);
    expect([...h].sort()).toEqual(["a", "old"]);
  });
});

describe("archiveSupersededReleases", () => {
  it("archives every older failure of the repository, also a very old one, and returns the ids", () => {
    const logs: string[] = [];
    const s = stub([b("f1", "failed", 1, { startedAt: "2025-01-01T00:00:00Z" }), b("f2", "stopped", 1), b("late", "failed", 29), b("ok", "succeeded", 5)]);
    const done = { runId: "ok", flow: "release-daily", status: "succeeded", startedAt: T(5), vars: { github_repo: "acme/app" } };
    expect(archiveSupersededReleases(s, done as never, (m) => logs.push(m)).sort()).toEqual(["f1", "f2"]);
    expect(s.setArchived).toHaveBeenCalledWith("f1", true, SUPERSEDED_BY);
    expect(s.setArchived).not.toHaveBeenCalledWith("late", expect.anything(), expect.anything());
    expect(logs.join("\n")).toContain("f1 of acme/app");
  });

  it("finds a success that only exists as `done`", () => {
    const s = stub([b("f1", "failed", 1)]);
    expect(archiveSupersededReleases(s, { runId: "ok", flow: "release-daily", status: "succeeded", startedAt: T(2), vars: { github_repo: "acme/app" } } as never)).toEqual(["f1"]);
  });

  it("touches only the repository of `done`", () => {
    const s = stub([b("o1", "failed", 1, { githubRepo: "acme/other" }), b("o2", "succeeded", 2, { githubRepo: "acme/other" }), b("f1", "failed", 1)]);
    expect(archiveSupersededReleases(s, { runId: "ok", flow: "release-daily", status: "succeeded", startedAt: T(2), vars: { github_repo: "acme/app" } } as never)).toEqual(["f1"]);
  });

  it("does nothing for a failed, non-release or repo-less `done`", () => {
    const s = stub([b("f1", "failed", 1), b("ok", "succeeded", 2)]);
    const mk = (over: object) => ({ runId: "x", flow: "release-daily", status: "succeeded", startedAt: T(3), vars: { github_repo: "acme/app" }, ...over }) as never;
    expect(archiveSupersededReleases(s, mk({ status: "failed" }))).toEqual([]);
    expect(archiveSupersededReleases(s, mk({ flow: "github-issue" }))).toEqual([]);
    expect(archiveSupersededReleases(s, mk({ vars: {} }))).toEqual([]);
    expect(s.setArchived).not.toHaveBeenCalled();
  });

  it("leaves out a busy run, and never throws", () => {
    const s = stub([b("f1", "failed", 1), b("f2", "failed", 1), b("ok", "succeeded", 2)], (id) => (id === "f1" ? "busy" : "done"));
    expect(reconcileSupersededReleases(s)).toEqual(["f2"]);
    expect(reconcileSupersededReleases({ briefs: () => { throw new Error("x"); }, setArchived: vi.fn() } as never)).toEqual([]);
  });
});

describe("reconcileSupersededReleases", () => {
  it("without a filter archives every repository", () => {
    const s = stub([b("a1", "failed", 1), b("a2", "succeeded", 2), b("o1", "failed", 1, { githubRepo: "acme/other" }), b("o2", "succeeded", 2, { githubRepo: "acme/other" })]);
    expect(reconcileSupersededReleases(s).sort()).toEqual(["a1", "o1"]);
  });

  it("in batches: every eligible run is archived and the event loop gets turns in between", async () => {
    const list = [b("ok", "succeeded", 20), ...Array.from({ length: 7 }, (_, i) => b(`f${i}`, "failed", 1))];
    const s = stub(list);
    let other = false;
    const seen: boolean[] = [];
    s.setArchived.mockImplementation(() => {
      if (seen.length === 0) setImmediate(() => (other = true)); // other work, queued during the first batch
      seen.push(other);
      return "done";
    });
    const out = await reconcileSupersededInBatches(s, { batch: 2 });
    expect(out).toHaveLength(7);
    expect(seen).toEqual([false, false, true, true, true, true, true]);
  });
});

describe("start-up sweep with runs-archive", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "superseded-archive-")); });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const put = (dir: string, id: string, status: string, day: number) => {
    mkdirSync(join(dir, id), { recursive: true });
    const runDir = join(dir, id);
    writeFileSync(join(runDir, "run.json"), JSON.stringify({ runId: id, runDir, flow: "release-daily", status, startedAt: T(day), finishedAt: T(day), vars: { github_repo: "acme/app" }, task: "t", history: [], state: { steps: {}, visits: {} }, totalCostUsd: 0 }));
  };

  it("archives an older failure in runs when the newer success was moved to runs-archive", () => {
    const runsDir = join(tmp, "runs");
    const archive = join(tmp, "runs-archive");
    put(runsDir, "old-fail", "failed", 1);
    put(archive, "new-ok", "succeeded", 2);
    const s = stub([b("old-fail", "failed", 1)]);
    expect(reconcileSupersededReleases(s)).toEqual([]); // the index alone does not see the success
    expect(retainedSuccesses(runsDir)).toEqual([{ runId: "new-ok", flow: "release-daily", status: "succeeded", startedAt: T(2), githubRepo: "acme/app" }]);
    expect(reconcileSupersededReleases(s, { retained: () => retainedSuccesses(runsDir) })).toEqual(["old-fail"]);
    expect(s.setArchived).toHaveBeenCalledWith("old-fail", true, SUPERSEDED_BY);
  });

  it("keeps only succeeded release runs from runs-archive", () => {
    const runsDir = join(tmp, "runs");
    put(join(tmp, "runs-archive"), "old-fail", "failed", 1);
    expect(retainedSuccesses(runsDir)).toEqual([]);
  });
});

describe("releaseSettled", () => {
  it("archives a late finisher: the older failed run that ends after a newer success (its brief still says running)", () => {
    const s = stub([b("old", "running", 1), b("new", "succeeded", 2)]);
    expect(releaseSettled(s, { runId: "old", flow: "release-daily", status: "failed", startedAt: T(1), vars: { github_repo: "acme/app" } } as never)).toEqual(["old"]);
    expect(s.setArchived).toHaveBeenCalledWith("old", true, SUPERSEDED_BY);
  });

  it("hands a success to the narrow helper, and ignores other endings", () => {
    const s = stub([b("f1", "failed", 1)]);
    const done = (status: string, flow = "release-daily") => ({ runId: "n", flow, status, startedAt: T(2), vars: { github_repo: "acme/app" } }) as never;
    expect(releaseSettled(s, done("cancelled"))).toEqual([]);
    expect(releaseSettled(s, done("succeeded", "github-issue"))).toEqual([]);
    expect(releaseSettled(s, done("succeeded"))).toEqual(["f1"]);
  });
});
