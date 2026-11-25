import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunSummary } from "../src/engine/state.js";
import { supersededLines } from "../src/ops/digest.js";
import { loadAllRuns, runDigest } from "../src/ops/cli.js";
import { SUPERSEDED_BY } from "../src/release/superseded.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const run = (runId: string, over: Record<string, unknown> = {}) =>
  ({ runId, flow: "release-daily", status: "failed", startedAt: hoursAgo(50), vars: { github_repo: "acme/app" }, archivedAt: hoursAgo(1), archivedBy: SUPERSEDED_BY, history: [], state: { steps: {} }, ...over }) as never as RunSummary;

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "digest-sup-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("supersededLines", () => {
  it("has one line for each run archived by itself in the last day, newest first, with no cap", () => {
    const runs = Array.from({ length: 12 }, (_, i) => run(`r${i + 1}`, { archivedAt: hoursAgo(i + 1) }));
    const lines = supersededLines(runs, NOW);
    expect(lines).toHaveLength(12);
    expect(lines[0]).toBe("release-daily of acme/app (run r1, failed) — a later release succeeded");
  });

  it("says interrupted for a run.json that still says running", () => {
    expect(supersededLines([run("r1", { status: "running" })], NOW)[0]).toContain("r1, interrupted");
  });

  it("leaves out an old archive and one made by a person", () => {
    expect(supersededLines([run("old", { archivedAt: hoursAgo(30) }), run("me", { archivedBy: "user-1" })], NOW)).toEqual([]);
  });
});

describe("runDigest", () => {
  it("has the section only when there is a line", () => {
    const withRun = runDigest({ runs: [], allRuns: [run("r1")], home: tmp, now: NOW });
    expect(withRun.text).toContain("Archived by itself");
    expect(withRun.text).toContain("run r1");
    expect(runDigest({ runs: [], allRuns: [], home: tmp, now: NOW }).text).not.toContain("Archived by itself");
  });
});

describe("loadAllRuns", () => {
  const write = (dir: string, id: string, extra: object = {}) => {
    mkdirSync(join(dir, id), { recursive: true });
    writeFileSync(join(dir, id, "run.json"), JSON.stringify({ ...JSON.parse(JSON.stringify(run(id))), runId: id, runDir: join(dir, id), ...extra }));
  };

  it("reads the runs folder, the workspace folders and runs-archive (a run moved by housekeeping keeps its line)", () => {
    const runsDir = join(tmp, "runs");
    write(runsDir, "20261001-000001-aaaa");
    write(join(tmp, "workspaces", "w1", "runs"), "20261001-000002-bbbb");
    write(join(tmp, "runs-archive"), "20261001-000003-cccc");
    const got = loadAllRuns(runsDir);
    expect(got.map((r) => r.runId).sort()).toEqual(["20261001-000001-aaaa", "20261001-000002-bbbb", "20261001-000003-cccc"]);
    expect(supersededLines(got, NOW)).toHaveLength(3);
  });
});
