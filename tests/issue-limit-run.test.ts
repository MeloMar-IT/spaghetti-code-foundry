import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { issueKey, setIssueLimit } from "../src/engine/issue-limit.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { isIssueLimitStop, liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { runNextStep } from "../src/next-step.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
let tmp: string;
let repo: string;
let runsDir: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "factory-issue-limit-run-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  mkdirSync(runsDir);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const config = (limit?: number, over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], ...(limit !== undefined ? { limits: { issue_cost_usd: limit } } : {}), ...over });
const vars = (issue: number) => ({ github_repo: "acme/app", issue: String(issue) });
const start = (yaml: string, c: Config, v: Record<string, string>) => runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, vars: v, config: c });
const TWO = `
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: one}
  - {id: b, type: claude, prompt: two}
`;
/** An earlier run of an issue, written by hand. */
const earlier = (id: string, issue: number, cost: number, history: unknown[] = []) => {
  mkdirSync(join(runsDir, id), { recursive: true });
  writeFileSync(join(runsDir, id, "run.json"), JSON.stringify({ runId: id, startedAt: "2026-11-01T10:00:00Z", status: "failed", totalCostUsd: cost, vars: vars(issue), history }));
};

describe("the spending limit per issue in a run (#786)", () => {
  it("stops before the second agent step once the first one brought the issue to the limit", async () => {
    const s = await start(TWO, config(0.01), vars(5));
    expect(s.status).toBe("stopped");
    expect(s.state.next).toBe("b");
    expect(s.history.map((h) => h.id)).toEqual(["a"]);
    expect(s.reason).toMatch(/^the issue's spending limit is reached: \$0\.01 spent of \$0\.01/);
    expect(readFileSync(liveLogFile(s.runDir), "utf8")).toContain('■ stopped before "b"');
  });

  it("stops before the first step when earlier runs of the issue cost enough", async () => {
    earlier("20261101-100000-aaaa", 5, 0.02);
    const s = await start(TWO, config(0.015), vars(5));
    expect(s.status).toBe("stopped");
    expect(s.state.next).toBe("a");
    expect(s.history).toHaveLength(0);
    expect(s.reason).toMatch(/\$0\.02 spent of \$0\.0[12] /);
    expect(isIssueLimitStop(s.reason)).toBe(true);
  });

  it("a run of a split part counts the parent and its other parts", async () => {
    earlier("20261101-100000-aaaa", 5, 0.02, [{ id: "create_split", ok: true, output: "SPLIT: #6 #7 — #5 closed" }]);
    earlier("20261101-100001-aaaa", 6, 0.01);
    const s = await start(TWO, config(0.03), vars(7));
    expect(s.status).toBe("stopped");
    expect(s.history).toHaveLength(0);
    // another issue of the same repository is not part of the family
    const other = await start(TWO, config(0.03), vars(9));
    expect(other.status).toBe("succeeded"); // two steps cost $0.02, below the limit
  });

  it("shell steps still run after the limit is reached", async () => {
    earlier("20261101-100000-aaaa", 5, 5);
    const s = await start(`
name: t
workspace: empty
steps:
  - {id: a, type: shell, run: 'echo free'}
`, config(1), vars(5));
    expect(s.status).toBe("succeeded");
  });

  it("with cost_limits false, or without the setting, nothing stops", async () => {
    earlier("20261101-100000-aaaa", 5, 5);
    expect((await start(TWO, config(1, { cost_limits: false }), vars(5))).status).toBe("succeeded");
    expect((await start(TWO, config(), vars(5))).status).toBe("succeeded");
  });

  it("a raised limit lets a resume go on, and the next-step record has no amount for a user", async () => {
    earlier("20261101-100000-aaaa", 5, 0.02);
    const s = await start(TWO, config(0.015), vars(5));
    expect(s.status).toBe("stopped");
    for (const forUser of [true, false]) {
      const n = runNextStep(s, { forUser });
      expect(n.kind).toBe("stopped");
      expect(n.why).toBe("The issue reached its spending limit");
      expect(JSON.stringify(n)).not.toMatch(/\$\d/);
    }
    // the same run goes on only after an administrator raised the limit
    setIssueLimit(issueKey({ project: { githubRepo: "acme/app" }, issue: 5 }), 10, "admin", tmp);
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: config(0.015) });
    expect(r.status).toBe("succeeded");
  });

  it("a limit stop inside a sub-flow ends the run there: on_failure is not followed", async () => {
    const flows = join(tmp, "flows");
    mkdirSync(flows);
    writeFileSync(join(flows, "inner.yaml"), "name: inner\nworkspace: inplace\nsteps:\n  - {id: x, type: claude, prompt: inner}\n");
    earlier("20261101-100000-aaaa", 5, 5);
    const s = await runFlow(
      parseFlow(`
name: outer
workspace: inplace
steps:
  - {id: sub, type: flow, flow: ${JSON.stringify(join(flows, "inner.yaml"))}, on_failure: after}
  - {id: after, type: shell, run: 'echo ran-after'}
`),
      { task: "t", repo, runsDir, claudeBin, vars: vars(5), config: config(1) },
    );
    expect(s.status).toBe("stopped");
    expect(s.state.next).toBe("sub");
    expect(s.history.some((h) => h.id === "after")).toBe(false);
    expect(isIssueLimitStop(s.reason)).toBe(true);
  });

  it("a limit stop inside a parallel step stops the run, not the other steps' failure path", async () => {
    earlier("20261101-100000-aaaa", 5, 5);
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: p, type: parallel, steps: [a, b], on_failure: after}
  - {id: a, type: claude, prompt: one, jump_only: true}
  - {id: b, type: claude, prompt: two, jump_only: true}
  - {id: after, type: shell, run: 'echo ran-after'}
`, config(1), vars(5));
    expect(s.status).toBe("stopped");
    expect(s.history.some((h) => h.id === "after")).toBe(false);
    expect(isIssueLimitStop(s.reason)).toBe(true);
  });
});
