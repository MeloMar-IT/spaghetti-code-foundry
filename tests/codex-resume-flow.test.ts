import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_HOME_CHANGED, CODEX_HOME_UNKNOWN } from "../src/agents/codex-home.js";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const config = ConfigSchema.parse({ isolate_agents: false, protected_branches: [] });
const savedHome = process.env.CODEX_HOME;
let tmp: string;
let repo: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cx-flow-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  process.env.CODEX_HOME = join(tmp, "codex-a");
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  rmSync(tmp, { recursive: true, force: true });
});

const flow = () =>
  parseFlow(`
name: t
workspace: inplace
steps:
  - {id: first, type: claude, agent: codex, prompt: "hello"}
  - {id: second, type: claude, agent: codex, resume: first, prompt: "again {{steps.first.codex_home}}"}
`);
const runsDir = () => join(tmp, "runs");
const last = (s: { history: { id: string; output: string; sessionId?: string; codexHome?: string }[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)!;
const first = () => runFlow(flow(), { task: "t", repo, runsDir: runsDir(), claudeBin, codexBin, config });
const again = (runId: string) => resumeRun({ runId, runsDir: runsDir(), claudeBin, codexBin, config, from: "second" });

describe("Codex resume and the Codex folder", () => {
  it("resumes in the same folder; an old record without a folder starts a new session", async () => {
    const s = await first();
    expect(s.status, s.reason).toBe("succeeded");
    const a = last(s, "first");
    const b = last(s, "second");
    expect(b.output).toContain("args=exec resume ");
    expect(b.output).toContain(a.sessionId!);
    expect(a.codexHome).toMatch(/^personal:[0-9a-f]{12}$/);
    expect(b.codexHome).toBe(a.codexHome);
    // the template value reached the process
    expect(b.output).toContain(`again ${a.codexHome}`);
    const file = join(s.runDir, "run.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.state.steps.first.codex_home).toBe(a.codexHome);
    expect(readFileSync(file, "utf8")).not.toContain("codex-a");

    const same = await again(s.runId);
    expect(same.status, same.reason).toBe("succeeded");
    expect(last(same, "second").output).toContain("args=exec resume ");
    expect(last(same, "second").output).toContain(a.sessionId!);

    delete saved.state.steps.first.codex_home;
    writeFileSync(file, JSON.stringify(saved));
    const old = await again(s.runId);
    expect(old.status, old.reason).toBe("succeeded");
    expect(last(old, "second").output.startsWith("codex ok args=exec --json")).toBe(true);
    expect(last(old, "second").sessionId).not.toBe(a.sessionId);
    expect(readFileSync(liveLogFile(s.runDir), "utf8")).toContain(`not resuming first: ${CODEX_HOME_UNKNOWN}`);
  });

  it("another CODEX_HOME starts a new session and says why", async () => {
    const s = await first();
    const a = last(s, "first");
    process.env.CODEX_HOME = join(tmp, "codex-b");
    const r = await again(s.runId);
    expect(r.status, r.reason).toBe("succeeded");
    const b = last(r, "second");
    expect(b.output.startsWith("codex ok args=exec --json")).toBe(true);
    expect(b.codexHome).not.toBe(a.codexHome);
    expect(readFileSync(liveLogFile(s.runDir), "utf8")).toContain(`not resuming first: ${CODEX_HOME_CHANGED}`);
  });
});
