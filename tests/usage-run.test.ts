import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import type { UsageEvent } from "../src/usage/events.js";
import { resetUsage, subscribeUsage, usageDir, usageIdle } from "../src/usage/hub.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const config = ConfigSchema.parse({ protected_branches: [] });
let tmp: string;
let repo: string;
let runsDir: string;
let got: UsageEvent[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "usage-run-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  resetUsage();
  got = [];
  subscribeUsage({ owner: "t", plugin: "t", handler: (e) => void got.push(e as UsageEvent), report: () => {} });
});
afterEach(() => {
  resetUsage();
  rmSync(tmp, { recursive: true, force: true });
});

const names = () => got.map((e) => e.name);
const fileEvents = (): UsageEvent[] => {
  const month = got[0]!.time.slice(0, 7);
  return readFileSync(join(usageDir(), `usage-${month}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as UsageEvent);
};

describe("usage events of a run", () => {
  it("sends one run.started, one step.finished per history record and one run.finished per end, also over a resume", async () => {
    const marker = join(tmp, "marker");
    const flow = parseFlow(`
name: stops and resumes
workspace: inplace
steps:
  - {id: a, type: shell, run: "true"}
  - {id: b, type: shell, run: 'test -f "${marker}"'}
`);
    const first = await runFlow(flow, { task: "t", repo, runsDir, claudeBin, config });
    expect(first.status).toBe("failed");
    await usageIdle();
    expect(names()).toEqual(["run.started", "step.finished", "step.finished", "run.finished"]);

    writeFileSync(marker, "");
    const last = await resumeRun({ runId: first.runId, runsDir, claudeBin, config });
    expect(last.status).toBe("succeeded");
    await usageIdle();

    expect(names().filter((n) => n === "run.started")).toHaveLength(1);
    const steps = got.filter((e) => e.name === "step.finished");
    expect(steps.map((e) => e.id)).toEqual(last.history.map((_, i) => `${last.runId}:step:${i}`));
    const finished = got.filter((e) => e.name === "run.finished");
    expect(finished.map((e) => [e.id, (e as { status: string }).status])).toEqual([
      [`${last.runId}:finished:0`, "failed"],
      [`${last.runId}:finished:${last.resumes ?? 0}`, "succeeded"],
    ]);
    // no issue event for a run that no watcher started
    expect(names().some((n) => n.startsWith("issue."))).toBe(false);
    // what a plugin got is what the file holds
    expect(fileEvents()).toEqual(got);
    // the flow name and the task are in no event
    expect(JSON.stringify(got)).not.toContain("stops and resumes");
  });

  it("sends issue.split for a story run whose last step is a successful create_split", async () => {
    const s = await runFlow(
      parseFlow(`
name: story
workspace: inplace
steps:
  - {id: create_split, type: shell, run: 'echo "SPLIT: #11 #12 — #10 closed"'}
`),
      { task: "t", repo, runsDir, claudeBin, config, source: "watcher w1 issue #10", vars: { issue: "10", github_repo: "acme/widgets" } },
    );
    expect(s.status).toBe("succeeded");
    await usageIdle();
    expect(names()).toEqual(["run.started", "step.finished", "run.finished", "issue.split"]);
    expect(got.at(-1)).toMatchObject({ name: "issue.split", parent: 10, parts: [11, 12], issue: 10, repository: "acme/widgets", id: `${s.runId}:issue:0` });
  });

  it("sends issue.done and issue.failed for story runs", async () => {
    const story = { source: "watcher w1 issue #7", vars: { issue: "7", github_repo: "acme/widgets" } };
    const ok = await runFlow(parseFlow("name: s\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'true'}\n"), { task: "t", repo, runsDir, claudeBin, config, ...story });
    const bad = await runFlow(parseFlow("name: s\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: 'false'}\n"), { task: "t", repo, runsDir, claudeBin, config, ...story });
    await usageIdle();
    expect(got.filter((e) => e.runId === ok.runId).map((e) => e.name)).toContain("issue.done");
    expect(got.filter((e) => e.runId === bad.runId).map((e) => e.name)).toContain("issue.failed");
    expect(existsSync(usageDir())).toBe(true);
  });

  it("carries the run's workspace: in run.json and every event; default is not written", async () => {
    const flow = parseFlow(`name: ws\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: "true"}\n`);
    const team = await runFlow(flow, { task: "t", repo, runsDir, claudeBin, config, workspace: "team-a" });
    const plain = await runFlow(flow, { task: "t", repo, runsDir, claudeBin, config });
    await usageIdle();
    expect(JSON.parse(readFileSync(join(runsDir, team.runId, "run.json"), "utf8")).workspace).toBe("team-a");
    expect("workspace" in JSON.parse(readFileSync(join(runsDir, plain.runId, "run.json"), "utf8"))).toBe(false);
    const of = (id: string) => got.filter((e) => e.runId === id);
    expect(of(team.runId).map((e) => e.workspace)).toEqual(of(team.runId).map(() => "team-a"));
    expect(of(team.runId).map((e) => e.name)).toEqual(expect.arrayContaining(["run.started", "run.finished"]));
    expect(of(plain.runId).every((e) => e.workspace === "default")).toBe(true);
  });
});
