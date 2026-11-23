import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { indexEntryOf, saveRun, SLIM_OUTPUT_MAX, slimRunOf, type RunSummary } from "../src/engine/state.js";
import { parseWaitsFor } from "../src/queue/waits-for.js";
import { usesTask } from "../src/flow/publish.js";
import { storyTitle } from "../src/since.js";
import { supersededRuns } from "../src/stats.js";

const big = "x".repeat(200_000);
const full = (): RunSummary =>
  ({
    runId: "r1", flow: "f", status: "failed", startedAt: "2026-10-01T10:00:00Z", totalCostUsd: 1.5, vars: { github_repo: "a/b", issue: "7" },
    repo: "/r", runDir: "/tmp/none", task: "Fix the bug\nwith two lines",
    flowDef: { name: "f", steps: [
      { id: "plan", type: "claude", prompt: "Plan this.\n{{task}}\n" + big },
      { id: "report", type: "shell", run: "echo\ngh issue close 7\n" + big, on_failure: "end" },
    ] },
    history: [
      { id: "plan", type: "claude", visit: 1, ok: true, output: "intro\n### ISSUE 1: a\n### ISSUE 2: b\n" + big },
      { id: "create_split", type: "shell", visit: 1, ok: false, output: "#12 A\n#13 B\nfailed here" },
    ],
    state: { next: "create_split", steps: { pull_ticket: { output: big } }, visits: { plan: 1 } },
  }) as unknown as RunSummary;

describe("slimRunOf", () => {
  it("drops the heavy parts and keeps what readers look for", () => {
    const f = full();
    const slim = slimRunOf(f);
    expect(JSON.stringify(slim).length).toBeLessThan(JSON.stringify(f).length / 10);
    expect(slim.task).toBe(f.task); // the whole task: answer room and the user's view read it
    expect(slim.state).toEqual({ next: "create_split", steps: {}, visits: { plan: 1 } }); // no title line in this output
    expect(slim.history[0]!.output).toBe("### ISSUE 1: a\n### ISSUE 2: b");
    expect(slim.history[1]!.output).toBe("#12 A\n#13 B\nfailed here");
    expect(usesTask(slim.flowDef)).toBe(usesTask(f.flowDef));
    expect((slim.flowDef.steps[1] as { run: string }).run).toBe("gh issue close 7");
    expect((slim.flowDef.steps[1] as { on_failure?: string }).on_failure).toBe("end");
  });

  it("cuts a very long failed output to its head and tail", () => {
    const f = full();
    f.history[1]!.output = "HEAD\n" + big + "\nTAIL";
    const out = slimRunOf(f).history[1]!.output;
    expect(out.startsWith("HEAD")).toBe(true);
    expect(out.endsWith("TAIL")).toBe(true);
    expect(out.length).toBeLessThan(40_000);
  });

  it("is a deep copy: a later change of the run does not reach it", () => {
    const f = full();
    const slim = slimRunOf(f);
    f.vars.issue = "8";
    f.history[0]!.ok = false;
    expect(slim.vars.issue).toBe("7");
    expect(slim.history[0]!.ok).toBe(true);
  });

  it("gives the same answers as the full run for superseded runs", () => {
    const a = { ...full(), runId: "a", startedAt: "2026-10-01T10:00:00Z" } as RunSummary;
    const b = { ...full(), runId: "b", startedAt: "2026-10-01T11:00:00Z" } as RunSummary;
    expect([...supersededRuns([a, b].map(slimRunOf))]).toEqual([...supersededRuns([a, b])]);
  });

  it("cannot be saved, also after a spread", () => {
    const dir = mkdtempSync(join(tmpdir(), "slim-"));
    try {
      const slim = slimRunOf({ ...full(), runDir: dir });
      expect(() => saveRun(slim)).toThrow("a slim run cannot be saved");
      expect(JSON.stringify(slim)).not.toContain("slim run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not throw on an older run without flow, history or state", () => {
    const old = { runId: "o", flow: "f", status: "succeeded", startedAt: "2026-01-01T00:00:00Z", totalCostUsd: 0, vars: {}, task: "t", runDir: "/x" } as unknown as RunSummary;
    expect(() => slimRunOf(old)).not.toThrow();
    expect(indexEntryOf(old, "o", 1)?.step).toBeNull();
  });
});

describe("slimRunOf: sub-flow steps", () => {
  it("keeps the WAITS_FOR output of a wait_for_story step with a sub-flow prefix", () => {
    const waits = "WAITS_FOR: #3, #4\n" + big;
    const f = full();
    f.history = [{ id: "build/wait_for_story", type: "shell", visit: 1, ok: true, output: waits }] as never;
    const slim = slimRunOf(f);
    expect(slim.history[0]!.output).toBe(waits.slice(0, SLIM_OUTPUT_MAX));
    expect(parseWaitsFor(slim.history[0]!.output!)?.issues).toEqual([3, 4]);
    expect(parseWaitsFor(slim.history[0]!.output!)).toEqual(parseWaitsFor(waits));
  });
});

describe("slimRunOf: the issue title", () => {
  it("keeps only the title line of pull_ticket in state.steps and in the history output", () => {
    const f = full();
    const out = "# #7: Seven\n\nbody\n" + big;
    f.state.steps = { pull_ticket: { output: out } } as never;
    (f.history as unknown[]).unshift({ id: "pull_ticket", type: "shell", visit: 1, ok: true, output: out });
    const slim = slimRunOf(f);
    expect(slim.state.steps).toEqual({ pull_ticket: { output: "# #7: Seven" } });
    expect(slim.history[0]!.output).toBe("# #7: Seven");
    expect(storyTitle(slim)).toBe(storyTitle(f));
    expect(storyTitle(slim)).toBe("Seven");
  });
});

describe("indexEntryOf", () => {
  it("holds the brief, the cost, the step and the slim run", () => {
    const e = indexEntryOf(full(), "r1", 1000)!;
    expect(e.brief).toMatchObject({ runId: "r1", githubRepo: "a/b", issue: "7", taskLine: "Fix the bug" });
    expect(e.totalCostUsd).toBe(1.5);
    expect(e.step).toBe("create_split");
    expect(e.slim.state.steps).toEqual({});
  });

  it("gives nothing for a file without a runId or status", () => {
    expect(indexEntryOf({ runId: 1 } as never, "x", 1)).toBeUndefined();
  });
});
