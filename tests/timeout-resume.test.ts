import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ownSessionStep, sessionRecords, sessionToResume, stepTimedOut, TIMED_OUT_NOTE } from "../src/agents/run.js";
import { ConfigSchema } from "../src/config.js";
import type { Scope } from "../src/engine/execute.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { noConversation, runClaude } from "../src/steps/claude.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const config = ConfigSchema.parse({ isolate_agents: false, protected_branches: [] });
let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "to-resume-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const timedOut = { error: "timed out", session_id: "sess-old" };

describe("ownSessionStep", () => {
  const step = { id: "impl", resume: "other" as string | undefined, skill_role: undefined as "reviewer" | undefined };
  it("continues its own session after a time-out, replacing another resume", () => {
    expect(ownSessionStep(step, { impl: timedOut }).resume).toBe("impl");
    expect(ownSessionStep<{ id: string; resume?: string }>({ id: "impl" }, { impl: timedOut }).resume).toBe("impl");
  });
  it("counts the slot-wait form of a time-out", () => {
    const e = "timed out (waited 18 min for a test slot, which did not count)";
    expect(ownSessionStep(step, { impl: { error: e } }).resume).toBe("impl");
  });
  it("leaves any other record alone", () => {
    for (const rec of [{ error: "the step timed out" }, { error: "exit code 1" }, { error: 5 }, undefined]) {
      const steps: Record<string, Record<string, unknown>> = rec ? { impl: rec } : {};
      expect(ownSessionStep(step, steps)).toBe(step);
    }
  });
  it("never continues a reviewer session, and does not change the step", () => {
    const reviewer = { ...step, skill_role: "reviewer" as const };
    expect(ownSessionStep(reviewer, { impl: timedOut })).toBe(reviewer);
    const before = { ...step };
    ownSessionStep(step, { impl: timedOut });
    expect(step).toEqual(before);
  });
  it("does not resume a session of another agent", () => {
    const own = ownSessionStep(step, { impl: { ...timedOut, agent: "codex:openai:x" } });
    expect(sessionToResume(own, { impl: { ...timedOut, agent: "codex:openai:x" } }, "claude").id).toBeUndefined();
  });
  it("stepTimedOut reads the last record", () => {
    expect(stepTimedOut({ a: timedOut }, "a")).toBe(true);
    expect(stepTimedOut({ a: { error: "" } }, "a")).toBe(false);
    expect(stepTimedOut({}, "a")).toBe(false);
  });
});

describe("sessionRecords", () => {
  const ctx = (steps: Record<string, Record<string, unknown>> = {}) => ({ ctx: { steps } as unknown as Scope["ctx"], prefix: "a/" });
  const rec = (o: Record<string, unknown>) => ({ id: "a/impl", parent: "a", error: "timed out", sessionId: "sess-sub", codexHome: "run", agent: "claude", skills: { digest: "sha256:x" } as never, ...o });

  it("is ctx.steps at the top level, without a history lookup", () => {
    const steps = { x: {} };
    expect(sessionRecords("impl", { ctx: { steps } as unknown as Scope["ctx"], prefix: "" },[rec({ id: "impl", parent: undefined })])).toBe(steps);
  });
  it("is ctx.steps when the record is already there", () => {
    const scope = ctx({ impl: { error: "" } });
    expect(sessionRecords("impl", scope, [rec({})])).toBe(scope.ctx.steps);
  });
  it("adds the last record in the shape recordStep writes, and does not change ctx.steps", () => {
    const scope = ctx();
    const out = sessionRecords("impl", scope, [rec({ sessionId: "sess-1" }), rec({})]);
    expect(out.impl).toEqual({ ok: false, error: "timed out", session_id: "sess-sub", codex_home: "run", agent: "claude", skills_digest: "sha256:x" });
    expect(scope.ctx.steps).toEqual({});
  });
  it("does not use a record of another parent or prefix, or no record", () => {
    const scope = ctx();
    expect(sessionRecords("impl", scope, [rec({ id: "b/impl", parent: "b" }), rec({ parent: "other" })])).toBe(scope.ctx.steps);
    expect(sessionRecords("impl", scope, [])).toBe(scope.ctx.steps);
  });
  it("restores nothing when the latest record is not a time-out (also after an older one)", () => {
    const scope = ctx();
    expect(sessionRecords("impl", scope, [rec({}), rec({ error: undefined })])).toBe(scope.ctx.steps);
    expect(sessionRecords("impl", scope, [rec({}), rec({ error: "exit code 1" })])).toBe(scope.ctx.steps);
  });
});

describe("noConversation", () => {
  it("finds the wording in stderr, the result and the errors array", () => {
    expect(noConversation("No conversation found with session ID: x\n")).toBe(true);
    expect(noConversation("", { result: "No conversation found with session ID: x" })).toBe(true);
    expect(noConversation("", { errors: ["boom", "No conversation found with session ID: x"] })).toBe(true);
  });
  it("is false for anything else", () => {
    expect(noConversation("")).toBe(false);
    expect(noConversation("rate limited", { result: "ok", errors: "No conversation found" })).toBe(false);
    expect(noConversation("", { errors: [1, null] })).toBe(false);
  });
});

describe("runClaude with the fake", () => {
  const run = (prompt: string, extra: { resumeSessionId?: string; timeoutMs?: number } = {}) => runClaude({ prompt, cwd: repo, logFile: join(tmp, "log.txt"), claudeBin, ...extra });
  it("keeps the session id of a timed-out session, and none when no event carried one", async () => {
    const a = await run("CLAUDE_HANG", { timeoutMs: 2000 });
    expect(a.error).toBe("timed out");
    expect(a.sessionId).toBe("sess-hang");
    rmSync(join(repo, ".fake-claude-hang"));
    const b = await run("CLAUDE_HANG_SILENT", { timeoutMs: 300 });
    expect(b.error).toBe("timed out");
    expect(b.sessionId).toBeUndefined();
  });
  it("flags a lost session on stderr and in the result event, only for a --resume", async () => {
    expect((await run("CLAUDE_NO_SESSION", { resumeSessionId: "gone" })).sessionLost).toBe(true);
    expect((await run("CLAUDE_NO_SESSION_RESULT", { resumeSessionId: "gone" })).sessionLost).toBe(true);
    const fresh = await run("CLAUDE_NO_SESSION");
    expect(fresh.ok).toBe(true);
    expect(fresh.sessionLost).toBeUndefined();
  });
});

const flowSource = (second: string) => `
name: t
workspace: inplace
steps:
  - {id: first, type: claude, prompt: "hello"}
  - {id: other, type: claude, prompt: "hello"}
  - {id: second, type: claude, ${second}}
`;
const runsDir = () => join(tmp, "runs");
const last = (s: { history: { id: string; output: string; sessionId?: string }[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)!;
const count = (s: { history: { id: string }[] }, id: string) => s.history.filter((h) => h.id === id).length;
const log = (s: { runDir: string }) => readFileSync(liveLogFile(s.runDir), "utf8");

/** Run a flow once, change its saved state, and resume from `from`. */
async function seeded(source: string, edit: (saved: any) => void, from: string, firstStatus = "succeeded", codexBin?: string) {
  const bins = { claudeBin, ...(codexBin ? { codexBin } : {}) };
  const s = await runFlow(parseFlow(source), { task: "t", repo, runsDir: runsDir(), config, ...bins });
  expect(s.status, s.reason).toBe(firstStatus);
  const file = join(s.runDir, "run.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  edit(saved);
  writeFileSync(file, JSON.stringify(saved));
  return { first: s, again: await resumeRun({ runId: s.runId, runsDir: runsDir(), config, from, ...bins }) };
}
const show = "SHOWPROMPT";

describe("a step that ran out of time (seeded state)", () => {
  it("continues its own session, even with resume: other, and gets the note", async () => {
    const { first, again } = await seeded(flowSource(`resume: other, prompt: ${show}`), (j) => Object.assign(j.state.steps.second, { error: "timed out", session_id: "sess-old" }), "second");
    expect(again.status, again.reason).toBe("succeeded");
    const out = last(again, "second").output;
    expect(out).toContain("--resume sess-old");
    expect(out).not.toContain(`--resume ${last(first, "other").sessionId}`);
    expect(out).toContain(`PROMPT<<${TIMED_OUT_NOTE}`);
  });

  it("starts a new session with the note when it kept no session id", async () => {
    const { again } = await seeded(flowSource(`prompt: ${show}`), (j) => Object.assign(j.state.steps.second, { error: "timed out (waited 18 min for a test slot, which did not count)", session_id: "" }), "second");
    const out = last(again, "second").output;
    expect(out).not.toContain("--resume");
    expect(out).toContain(TIMED_OUT_NOTE);
    expect(log(again)).toContain("it kept no session id");
  });

  it("starts a new session in the same try when Claude no longer has the session", async () => {
    for (const directive of ["CLAUDE_NO_SESSION", "CLAUDE_NO_SESSION_RESULT"]) {
      const { first, again } = await seeded(flowSource(`prompt: "${show}\\n${directive}"`), (j) => Object.assign(j.state.steps.second, { error: "timed out", session_id: "sess-old" }), "second");
      expect(again.status, again.reason).toBe("succeeded");
      const rec = last(again, "second");
      expect(rec.output).not.toContain("--resume");
      expect(rec.output).toContain(TIMED_OUT_NOTE);
      expect(count(again, "second")).toBe(count(first, "second") + 1);
      expect(log(again)).toContain("the session of second is gone");
      expect(readFileSync(join(again.runDir, "run.json"), "utf8")).not.toContain("lostSession");
      rmSync(tmp, { recursive: true, force: true });
      mkdirSync(repo, { recursive: true });
    }
  });

  it("gets no note and no own session after another failure; its flow resume: works as before", async () => {
    const { first, again } = await seeded(flowSource(`resume: other, prompt: ${show}`), (j) => Object.assign(j.state.steps.second, { error: "claude result: error_max_turns", session_id: "sess-old" }), "second");
    const out = last(again, "second").output;
    expect(out).toContain(`--resume ${last(first, "other").sessionId}`);
    expect(out).not.toContain("sess-old");
    expect(out).not.toContain(TIMED_OUT_NOTE);
  });

  it("fails a lost session of a flow's own resume:, with one session", async () => {
    const { first, again } = await seeded(flowSource(`resume: other, prompt: "${show}\\nCLAUDE_NO_SESSION"`), () => {}, "second", "failed");
    expect(again.status).toBe("failed");
    expect(last(again, "second").output).toBe("");
    expect(count(again, "second")).toBe(count(first, "second") + 1);
    expect(log(again)).not.toContain("is gone");
  });
});

describe("a reviewer and a Codex step that ran out of time", () => {
  const codexBin = resolve("tests/fixtures/fake-codex.mjs");
  const savedHome = process.env.CODEX_HOME;
  beforeEach(() => {
    process.env.CODEX_HOME = join(tmp, "codex-a");
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
  });

  it("a timed-out reviewer step never continues a session, but gets the note", async () => {
    const { again } = await seeded(flowSource(`skill_role: reviewer, permission_mode: plan, prompt: ${show}`), (j) => Object.assign(j.state.steps.second, { error: "timed out", session_id: "sess-review" }), "second");
    expect(again.status, again.reason).toBe("succeeded");
    const out = last(again, "second").output;
    expect(out).not.toContain("--resume");
    expect(out).toContain(`PROMPT<<${TIMED_OUT_NOTE}`);
  });

  const codexFlow = `
name: t
workspace: inplace
steps:
  - {id: first, type: claude, agent: codex, prompt: "hello"}
  - {id: second, type: claude, agent: codex, prompt: ${show}}
`;
  it("a timed-out Codex step continues its own thread when its Codex folder matches", async () => {
    const { again } = await seeded(codexFlow, (j) => Object.assign(j.state.steps.second, { error: "timed out", session_id: "sess-codex" }), "second", "succeeded", codexBin);
    expect(again.status, again.reason).toBe("succeeded");
    const out = last(again, "second").output;
    expect(out).toMatch(/args=exec resume .*sess-codex -/);
    expect(out).toContain(TIMED_OUT_NOTE);
  });

  it("a timed-out Codex step in another Codex folder starts a new session, with the note", async () => {
    const { again } = await seeded(
      codexFlow,
      (j) => {
        const rec = j.history.filter((h: { id: string }) => h.id === "second").at(-1);
        Object.assign(rec, { error: "timed out", sessionId: "sess-codex", codexHome: "personal:000000000000" });
        Object.assign(j.state.steps.second, { error: "timed out", session_id: "sess-codex", codex_home: "personal:000000000000" });
      },
      "second",
      "succeeded",
      codexBin,
    );
    expect(again.status, again.reason).toBe("succeeded");
    const out = last(again, "second").output;
    expect(out).not.toContain("sess-codex");
    expect(out).toContain(TIMED_OUT_NOTE);
    expect(log(again)).toMatch(/not resuming second: /);
  });
});

describe("a step in a sub-flow", () => {
  const child = (resume = "") => `
name: child
workspace: inplace
steps:
  - {id: impl, type: claude, ${resume}prompt: ${show}}
`;
  const parent = `
name: t
workspace: inplace
steps:
  - {id: a, type: flow, flow: child}
  - {id: b, type: flow, flow: child}
`;
  const setup = (resume?: string) => {
    mkdirSync(join(repo, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(repo, ".claude-factory", "flows", "child.yaml"), child(resume));
  };
  const lastImpl = (s: { history: { id: string; output: string }[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)!.output;

  it("continues the session of a timed-out child, and only under its own parent", async () => {
    setup();
    const { again } = await seeded(parent, (j) => Object.assign(j.history.filter((h: any) => h.id === "a/impl").at(-1), { error: "timed out", sessionId: "sess-sub", ok: false }), "a");
    expect(again.status, again.reason).toBe("succeeded");
    expect(lastImpl(again, "a/impl")).toContain("--resume sess-sub");
    expect(lastImpl(again, "a/impl")).toContain(TIMED_OUT_NOTE);
    expect(lastImpl(again, "b/impl")).not.toContain("--resume");
    expect(lastImpl(again, "b/impl")).not.toContain(TIMED_OUT_NOTE);
  });

  it("starts a new session with the note when the child kept no session id", async () => {
    setup();
    const { again } = await seeded(parent, (j) => Object.assign(j.history.filter((h: any) => h.id === "a/impl").at(-1), { error: "timed out", sessionId: undefined, ok: false }), "a");
    expect(lastImpl(again, "a/impl")).not.toContain("--resume");
    expect(lastImpl(again, "a/impl")).toContain(TIMED_OUT_NOTE);
    expect(log(again)).toContain("it kept no session id");
  });

  it("does not bring back the session of a child that resumes itself after a success", async () => {
    setup("resume: impl, ");
    const { again } = await seeded(parent, () => {}, "a");
    expect(again.status, again.reason).toBe("succeeded");
    expect(lastImpl(again, "a/impl")).not.toContain("--resume");
    expect(lastImpl(again, "a/impl")).not.toContain(TIMED_OUT_NOTE);
  });
});

describe("end to end", () => {
  it("a real time-out keeps the session, and the retry continues it", async () => {
    const source = `
name: t
workspace: inplace
steps:
  - {id: work, type: claude, timeout_sec: 6, prompt: "SHOWPROMPT\\nCLAUDE_HANG"}
`;
    const s = await runFlow(parseFlow(source), { task: "t", repo, runsDir: runsDir(), claudeBin, config });
    const rec = last(s, "work");
    expect(s.status).toBe("failed");
    expect((rec as { error?: string }).error).toBe("timed out");
    expect(rec.sessionId).toBe("sess-hang");
    const again = await resumeRun({ runId: s.runId, runsDir: runsDir(), claudeBin, config, from: "work" });
    expect(again.status, again.reason).toBe("succeeded");
    expect(last(again, "work").output).toContain("--resume sess-hang");
    expect(last(again, "work").output).toContain(TIMED_OUT_NOTE);
  }, 30_000);
});
