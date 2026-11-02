import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { splitAnswered, takesTooBig, timeLimitHandover, tooBigReason } from "../src/engine/auto-retry.js";
import { stepEnv, type Engine, type Scope } from "../src/engine/execute.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const REASON3 = "too big for one coding turn: timed out 3 times";

describe("tooBigReason", () => {
  it("is fixed words and a number", () => {
    expect(tooBigReason(3)).toBe(REASON3);
    expect(tooBigReason(1)).toBe("too big for one coding turn: timed out 1 time");
  });
});

const flowWith = (forceSplit?: Record<string, unknown>) => ({ steps: [{ id: "implement", type: "shell", run: "true" }, ...(forceSplit ? [forceSplit] : [])] }) as never;
const newFs = { id: "force_split", type: "claude", prompt: "This issue has to be split.\n{{steps.implement.too_big}}" };

describe("takesTooBig", () => {
  it("is true for a claude force_split that names the field", () => {
    expect(takesTooBig(flowWith(newFs))).toBe(true);
  });
  it("is false with no step, an old prompt or a shell step", () => {
    expect(takesTooBig(flowWith())).toBe(false);
    expect(takesTooBig(flowWith({ ...newFs, prompt: "Your plan is over the size limit" }))).toBe(false);
    expect(takesTooBig(flowWith({ id: "force_split", type: "shell", run: "echo steps.implement.too_big" }))).toBe(false);
  });
});

describe("timeLimitHandover", () => {
  const base = { top: true, stepType: "claude" as const, error: "timed out", storyRun: true, limit: 2, used: () => 2, stepId: "implement", flow: flowWith(newFs), coded: () => 2 };
  it("gives the reason for implement", () => {
    expect(timeLimitHandover(base)).toBe(REASON3);
  });
  it("gives nothing in any other case", () => {
    const old = flowWith({ ...newFs, prompt: "old" });
    for (const o of [
      { stepId: "plan" }, { limit: 0 }, { storyRun: false }, { accessFailed: true }, { ownFailurePath: true }, { error: "exit code 1" },
      { top: false }, { stepType: "flow" as const }, { flow: old },
    ]) expect(timeLimitHandover({ ...base, ...o }), JSON.stringify(o)).toBeUndefined();
  });
  it("never counts when it says no", () => {
    let asked = 0;
    const coded = () => (asked++, 0);
    timeLimitHandover({ ...base, stepId: "plan", coded });
    timeLimitHandover({ ...base, limit: 0, coded });
    expect(asked).toBe(0);
  });
});

describe("splitAnswered", () => {
  it("wants parts for the split gate and a question for send_back", () => {
    expect(splitAnswered("split_gate", "## Split\n### ISSUE 1: a\nPLAN_STATUS: TOO_BIG")).toBe(true);
    expect(splitAnswered("send_back", "**Q1. Which way?**\nPLAN_STATUS: NEEDS_INFO")).toBe(true);
  });
  it("is false without them, and without a route", () => {
    expect(splitAnswered("split_gate", "Cannot split.\nPLAN_STATUS: TOO_BIG")).toBe(false);
    expect(splitAnswered("send_back", "Unsure.\nPLAN_STATUS: NEEDS_INFO")).toBe(false);
    expect(splitAnswered(undefined, "### ISSUE 1: a\n**Q1. x")).toBe(false);
    expect(splitAnswered("risk_gate", "### ISSUE 1: a")).toBe(false);
  });
});

describe("stepEnv", () => {
  const engine = { baseEnv: { FACTORY_DECIDE_TECHNICAL: "1" }, config: { help: {} } } as unknown as Engine;
  const scope = (steps: Record<string, unknown>) => ({ flow: { steps: [{ id: "implement", type: "shell" }] }, ctx: { task: "", learnings: "", run: { id: "r", dir: "/d", branch: "b", history: "" }, vars: {}, workdir: "/w", steps }, visits: {}, prefix: "", depth: 0 }) as unknown as Scope;
  it("turns off deciding technical questions while the story is handed to the planner", () => {
    expect(stepEnv(scope({ implement: { ok: false, too_big: REASON3 } }), engine).FACTORY_DECIDE_TECHNICAL).toBe("0");
    expect(stepEnv(scope({ implement: { ok: true } }), engine).FACTORY_DECIDE_TECHNICAL).toBe("1");
  });
});

describe("a story that keeps timing out in implement", () => {
  let tmp: string;
  let repo: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "split-to-"));
    repo = join(tmp, "repo");
    mkdirSync(repo);
    for (const k of ["FAKE_FORCED_SPLIT", "FAKE_FORCED_SPLIT_CAPTURE"]) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(tmp, { recursive: true, force: true });
  });

  const cfg = (timeouts = 1) => ConfigSchema.parse({ isolate_agents: false, protected_branches: [], auto_retry: { timeouts } });
  const story = { source: "watcher go issue #7", vars: { issue: "7", github_repo: "o/r" } };
  const runsDir = () => join(tmp, "runs");
  const flow = (prompt = "This issue has to be split.\\n{{steps.implement.too_big}}\\nSAY ok", extra = "") => parseFlow(`
name: t
workspace: inplace
steps:
  - {id: implement, type: shell, timeout_sec: 0.2, run: "sleep 5"}
  - {id: force_split, type: claude, jump_only: true, prompt: "${prompt}", routes: [{if: "^PLAN_STATUS: TOO_BIG", goto: split_gate}, {if: "^PLAN_STATUS: NEEDS_INFO", goto: send_back}], on_success: risk_gate, on_failure: risk_gate}
  - {id: split_gate, type: shell, jump_only: true, run: "echo gate", on_success: end}
  - {id: send_back, type: shell, jump_only: true, run: "echo asked", on_success: end}
  - {id: risk_gate, type: shell, jump_only: true, run: "echo risk", on_success: end}
${extra}`);
  const go = async (f = flow(), timeouts = 1) => {
    const s1 = await runFlow(f, { task: "t", repo, runsDir: runsDir(), config: cfg(timeouts), claudeBin, ...story });
    return s1.status === "stopped" ? resumeRun({ runId: s1.runId, runsDir: runsDir(), config: cfg(timeouts), claudeBin }) : s1;
  };
  const ids = (s: Awaited<ReturnType<typeof go>>) => s.history.map((h) => h.id);

  it("hands over after the retry, with the reason, and stores it", async () => {
    const s = await go();
    expect(ids(s)).toEqual(["implement", "implement", "force_split", "split_gate"]);
    const stored = JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8"));
    expect(stored.state.steps.implement.too_big).toBe("too big for one coding turn: timed out 2 times");
  });

  it("shows the reason to the planner", async () => {
    process.env.FAKE_FORCED_SPLIT_CAPTURE = join(tmp, "capture.jsonl");
    process.env.FAKE_FORCED_SPLIT = "### ISSUE 1: a\nPLAN_STATUS: TOO_BIG";
    const s = await go();
    const seen = JSON.parse(readFileSync(process.env.FAKE_FORCED_SPLIT_CAPTURE, "utf8").trim().split("\n")[0]!) as { prompt: string };
    expect(seen.prompt).toContain("timed out 2 times");
    expect(ids(s)).toContain("split_gate");
    expect(s.status).toBe("succeeded");
  });

  it("fails for an answer with no split and no question, and never goes on to risk_gate", async () => {
    for (const answer of ["READY\\nPLAN_STATUS: READY", "PLAN_STATUS: NOT_CODE", "no status", "Cannot split.\\nPLAN_STATUS: TOO_BIG", "Unsure.\\nPLAN_STATUS: NEEDS_INFO"]) {
      process.env.FAKE_FORCED_SPLIT = answer.replaceAll("\\n", "\n");
      const s = await go();
      expect(s.status, answer).toBe("failed");
      expect(ids(s), answer).not.toContain("risk_gate");
      expect(ids(s).at(-1)).toBe("force_split");
      expect(s.state.next).toBe("force_split");
    }
  });

  it("fails when the planner fails", async () => {
    const s = await go(flow("This issue has to be split.\\n{{steps.implement.too_big}}\\nERROR"));
    expect(s.status).toBe("failed");
    expect(ids(s)).not.toContain("risk_gate");
  });

  it("goes on to send_back with a question", async () => {
    process.env.FAKE_FORCED_SPLIT = "**Q1. Split how?**\nPLAN_STATUS: NEEDS_INFO";
    const s = await go();
    expect(ids(s)).toContain("send_back");
    expect(s.status).toBe("succeeded");
  });

  it("keeps today's failure for a flow with the old prompt", async () => {
    const s = await go(flow("Your plan is over the size limit\\nSAY ok"));
    expect(s.status).toBe("failed");
    expect(s.reason).toContain('step "implement" failed: timed out');
    expect(ids(s)).not.toContain("force_split");
  });

  it("keeps today's failure for another step that times out", async () => {
    const f = parseFlow(`
name: t
workspace: inplace
steps:
  - {id: implement, type: shell, run: "true"}
  - {id: tests, type: shell, timeout_sec: 0.2, run: "sleep 5"}
  - {id: force_split, type: claude, jump_only: true, prompt: "This issue has to be split.\\n{{steps.implement.too_big}}"}
`);
    const s = await go(f);
    expect(s.status).toBe("failed");
    expect(ids(s)).not.toContain("force_split");
  });

  it("counts a time-out after the hand-over too", async () => {
    process.env.FAKE_FORCED_SPLIT_CAPTURE = join(tmp, "capture.jsonl");
    process.env.FAKE_FORCED_SPLIT = "### ISSUE 1: a\nPLAN_STATUS: TOO_BIG";
    const f = flow();
    for (const x of f.steps) {
      if (x.id === "split_gate") x.on_success = "implement"; // the split was not taken: coding starts again
      if (x.id === "force_split") x.max_visits = 2;
    }
    const s = await go(f);
    expect(s.status).toBe("failed");
    const lines = readFileSync(process.env.FAKE_FORCED_SPLIT_CAPTURE, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { prompt: string });
    expect(lines[0]!.prompt).toContain("timed out 2 times");
    expect(lines.at(-1)!.prompt).toContain("timed out 3 times");
  });

  it("goes to risk_gate when force_split has no route and no hand-over", async () => {
    const f = parseFlow(`
name: t
workspace: inplace
steps:
  - {id: force_split, type: claude, prompt: "This issue has to be split.\\nSAY ok", on_success: risk_gate}
  - {id: split_gate, type: shell, jump_only: true, run: "echo gate", on_success: end}
  - {id: risk_gate, type: shell, run: "echo risk", on_success: end}
`);
    const s = await runFlow(f, { task: "t", repo, runsDir: runsDir(), config: cfg(), claudeBin, ...story });
    expect(s.status).toBe("succeeded");
    expect(ids(s)).toEqual(["force_split", "risk_gate"]);
  });
});
