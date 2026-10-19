import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow, type RunSummary } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { parseFlow } from "../src/flow/load.js";
import { resetCodexFlagsCache } from "../src/steps/codex.js";
import { assembleToolProfile, type OperationGrant } from "../src/tool-profile/resolve.js";
import { OPERATIONS, type ToolKind } from "../src/tool-profile/schema.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const codexBin = resolve("tests/fixtures/fake-codex.mjs");
let tmp: string;
let repo: string;

beforeEach(() => {
  resetCodexFlagsCache();
  tmp = mkdtempSync(join(tmpdir(), "tool-gate-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
});
afterEach(() => {
  resetCodexFlagsCache();
  rmSync(tmp, { recursive: true, force: true });
});

const grant = (kind: ToolKind, operation: string, targets = ["*"], more: Partial<OperationGrant> = {}): OperationGrant => ({
  kind, operation, targets, dataClassification: "restricted", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none",
  ...(kind === "shell" ? { sandbox: { filesystem: "unrestricted" as const, network: "unrestricted" as const } } : {}), ...more,
});
const all = (kind: ToolKind) => OPERATIONS[kind].map((op) => grant(kind, op));
const REVIEWER = assembleToolProfile({ id: "reviewer", version: "1" }, [grant("files", "read"), grant("builtin", "call")]);
const NPM_TEST = assembleToolProfile({ id: "npm-test", version: "1" }, [grant("files", "read"), grant("builtin", "call"), grant("shell", "run", ["npm test", "npm test *"], { credential: "machine" }), ...all("git"), ...all("github")]);
const SHELL_READ_ONLY = assembleToolProfile({ id: "ro-shell", version: "1" }, [
  grant("files", "read"), grant("files", "write"), grant("shell", "run", ["*"], { sandbox: { filesystem: "read-only", network: "unrestricted" } }),
  ...all("git"), ...all("github"), grant("web", "fetch"), grant("web", "search"), grant("builtin", "call"),
]);

const cfg = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ protected_branches: [], isolate_agents: true, ...over });
const start = (steps: string, o: Partial<Parameters<typeof runFlow>[1]> = {}) =>
  runFlow(parseFlow(`name: t\nworkspace: inplace\nsteps:\n${steps}`), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, codexBin, config: cfg(), ...o });
const resume = (s: RunSummary, o: Partial<Parameters<typeof resumeRun>[0]> = {}) => resumeRun({ runId: s.runId, runsDir: join(tmp, "runs"), claudeBin, codexBin, config: cfg(), ...o });
const step = (id: string, extra: string, prompt = "SAY hi") => `  - {id: ${id}, type: claude, ${extra} prompt: ${JSON.stringify(prompt)}}\n`;
const approval = "  - {id: ok, type: approval, message: go}\n";
const events = (s: Pick<RunSummary, "runDir">): EvidenceEvent[] => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
type Profiled = Extract<EvidenceEvent, { type: "step.profiled" }>;
const profiled = (s: Pick<RunSummary, "runDir">, id?: string) => events(s).filter((e): e is Profiled => e.type === "step.profiled" && (!id || e.step.id === id));
const types = (s: Pick<RunSummary, "runDir">, id: string) => events(s).filter((e) => e.type.startsWith("step.") && "step" in e && e.step?.id === id).map((e) => e.type.replace("step.", ""));
const log = (s: Pick<RunSummary, "runDir">) => readFileSync(liveLogFile(s.runDir), "utf8");
const out = (s: RunSummary, id: string) => s.history.filter((h) => h.id === id).at(-1)!.output;

describe("the tool profile of an agent step", () => {
  it("records the profile its settings give, once for both agents, and changes no argument", async () => {
    const s = await start(step("a", "permission_mode: plan,", "SHOWPROMPT") + step("b", "agent: codex, permission_mode: plan,", "WRITE out.txt hi"));
    expect(s.status, s.reason).toBe("succeeded");
    const [a, b] = profiled(s);
    expect([a!.agent, a!.source, a!.outcome], "claude").toEqual(["claude", "generated", "enforced"]);
    expect([b!.agent, b!.source, b!.outcome], "codex").toEqual(["codex", "generated", "partial"]);
    expect(a!.profile!.sha256).toBe(b!.profile!.sha256);
    expect(log(s)).toMatch(/· tools: generated profile [0-9a-f]{12} on Codex: partial — Codex cannot hold .* \(recorded only\)/);
    expect(out(s, "a")).toContain("--permission-mode plan");
    expect(out(s, "b")).toContain('sandbox_mode="read-only"');
  });

  it("records the same profile on every try: retries and the fallback", async () => {
    const s = await start(step("a", "", "CLAUDE_OVERLOADED\nSAY from codex"), { config: cfg({ router: { fallback: ["codex"] } }) });
    expect(s.status, s.reason).toBe("succeeded");
    expect(types(s, "a")).toEqual(["started", "routed", "profiled", "retried", "profiled", "retried", "profiled", "retried", "routed", "profiled", "completed"]);
    const all = profiled(s);
    expect(all.map((e) => e.agent)).toEqual(["claude", "claude", "claude", "codex"]);
    expect(new Set(all.map((e) => e.profile!.sha256)).size).toBe(1);
  });

  it("refuses a declared profile the agent cannot hold, on the target, without a retry", async () => {
    const s = await start(step("a", "permission_mode: plan,") + step("b", "agent: codex, permission_mode: plan,"), { toolProfile: REVIEWER });
    expect(s.status).toBe("failed");
    expect(profiled(s, "a").map((e) => [e.source, e.agent, e.outcome])).toEqual([["declared", "claude", "enforced"]]);
    const b = profiled(s, "b");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ agent: "codex", outcome: "refused" });
    expect(types(s, "b")).toEqual(["started", "routed", "profiled", "failed"]);
    expect(log(s)).not.toContain("· agent codex");
    expect(log(s)).toMatch(/! tools: the declared tool profile [0-9a-f]{12} cannot be held on Codex: Codex cannot hold files limit-targets/);
  });

  it("refuses before routing when the step's settings allow more than the profile", async () => {
    const s = await start(step("a", "permission_mode: dontAsk, sandbox: true,"), { toolProfile: NPM_TEST });
    expect(s.status).toBe("failed");
    const [p] = profiled(s);
    expect(p).toMatchObject({ source: "declared", outcome: "refused", excess: [{ kind: "shell", operation: "run", field: "targets" }] });
    expect(p!.agent).toBeUndefined();
    expect(types(s, "a")).toEqual(["started", "profiled", "failed"]);
    expect(log(s)).not.toContain("· agent");
  });

  it("checks the profile against the Codex sandbox the session really gets", async () => {
    const s = await start(step("b", "agent: codex,"), { toolProfile: SHELL_READ_ONLY });
    expect(s.status).toBe("failed");
    const [p] = profiled(s);
    expect(p).toMatchObject({ agent: "codex", outcome: "refused" });
    // the sandbox is narrowed to the level of the shell grant, so that level is not what refuses the step
    expect(p!.gaps).not.toContainEqual({ kind: "shell", restriction: "sandbox-filesystem" });
    expect(log(s)).not.toContain("· agent codex");
  });
});

describe("a declared profile on resume", () => {
  const FLOW = approval + step("b", "agent: codex, permission_mode: plan,");
  const runJson = (s: RunSummary) => join(s.runDir, "run.json");

  it("is saved in run.json and used again, and an unreadable one is refused", async () => {
    const s = await start(FLOW, { toolProfile: REVIEWER });
    expect(s.status).toBe("waiting");
    const saved = JSON.parse(readFileSync(runJson(s), "utf8"));
    expect(saved.toolProfile).toEqual(REVIEWER);

    const r = await resume(s, { decision: { approved: true, by: "marcel" } });
    expect(r.status).toBe("failed");
    const [p] = profiled(s, "b");
    expect(p).toMatchObject({ agent: "codex", outcome: "refused", source: "declared" });
    expect(p!.profile!.id).toBe("reviewer");
    expect(log(s)).not.toContain("· agent codex");

    saved.toolProfile.version = 2;
    writeFileSync(runJson(s), JSON.stringify(saved, null, 2));
    const again = await resume(s, { from: "b" });
    expect(again.status).toBe("failed");
    expect(log(s)).toContain("! tools: the declared tool profile cannot be used (unsupported-version, 0 fields)");
    expect(profiled(s, "b").at(-1)).toMatchObject({ source: "declared", unreadable: "unsupported-version", outcome: "refused" });
  });

  it("never turns a profile that could not be saved into no profile", async () => {
    const s = await start(FLOW, { toolProfile: () => 1 });
    expect(s.status).toBe("waiting");
    expect(JSON.parse(readFileSync(runJson(s), "utf8"))).toHaveProperty("toolProfile", null);
    const r = await resume(s, { decision: { approved: true, by: "marcel" } });
    expect(r.status).toBe("failed");
    expect(log(s)).toContain("! tools: the declared tool profile cannot be used (not-an-object, 0 fields)");
    expect(log(s)).not.toContain("· agent codex");
  });
});
