import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analystSet, claudeIsolated, codexSandbox, sessionToResume } from "../src/agents/run.js";
import { isQuotaError, isTransientError, KNOWN_KEY_VARS, parseSpec, providerKeyVars, resolveTarget, stepRoute, toTarget } from "../src/agents/targets.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { PROJECT_BUDGET_REASON, liveLogFile } from "../src/engine/state.js";
import { readTranscript } from "../src/engine/transcript.js";
import { withModel } from "../src/evals.js";
import { parseFlow } from "../src/flow/load.js";
import type { ClaudeStep } from "../src/flow/schema.js";
import { buildClaudeArgs, FACTORY_AGENT_NOTE } from "../src/steps/claude.js";
import { buildCodexArgs, CODEX_AGENT_NOTE, codexExecFlags, resetCodexFlagsCache } from "../src/steps/codex.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], ...over });
const PROVIDERS = ["anthropic", "openai", "ollama", "lmstudio"];

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  delete process.env.CODEX_API_KEY;
});

describe("model specs", () => {
  it("peels agent and provider off the front; the rest is the model", () => {
    expect(parseSpec("sonnet", PROVIDERS)).toEqual({ model: "sonnet" });
    expect(parseSpec("codex", PROVIDERS)).toEqual({ agent: "codex" });
    expect(parseSpec("codex:gpt-5", PROVIDERS)).toEqual({ agent: "codex", model: "gpt-5" });
    expect(parseSpec("ollama:qwen3-coder:30b", PROVIDERS)).toEqual({ provider: "ollama", model: "qwen3-coder:30b" });
    expect(parseSpec("codex:ollama:gpt-oss:20b", PROVIDERS)).toEqual({ agent: "codex", provider: "ollama", model: "gpt-oss:20b" });
    expect(parseSpec("", PROVIDERS)).toEqual({});
  });

  it("fills default providers and rejects impossible pairs", () => {
    const c = cfg();
    expect(toTarget({ agent: "codex" }, c)).toMatchObject({ agent: "codex", providerName: "openai", free: true });
    expect(toTarget({ model: "opus" }, c)).toMatchObject({ agent: "claude", providerName: "anthropic", free: false, label: "claude:anthropic:opus" });
    expect(toTarget({ provider: "ollama", model: "q" }, c)).toMatchObject({ agent: "claude", free: true });
    expect(() => toTarget({ provider: "openai" }, c)).toThrow(/use agent codex/);
    expect(() => toTarget({ agent: "codex", provider: "anthropic" }, c)).toThrow(/can't use/);
    expect(() => toTarget({ provider: "ollama" }, c)).toThrow(/needs a model/);
    expect(() => toTarget({ provider: "nope" }, c)).toThrow(/unknown provider/);
    const withDefault = cfg({ providers: { ollama: { kind: "ollama", default_model: "qwen3-coder" } } });
    expect(toTarget({ provider: "ollama" }, withDefault)).toMatchObject({ model: "qwen3-coder", provider: { base_url: "http://localhost:11434" } });
  });
});

describe("providerKeyVars", () => {
  it("lists the config's key variables and the well-known ones, once each", () => {
    const c = cfg({ providers: { a: { kind: "anthropic-compatible", base_url: "http://x", api_key_env: "MY_KEY" }, b: { kind: "anthropic-compatible", base_url: "http://y", api_key_env: "OPENAI_API_KEY" } } });
    const names = providerKeyVars(c);
    expect(names).toEqual(expect.arrayContaining(["MY_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"]));
    expect(new Set(names).size).toBe(names.length);
    expect(providerKeyVars(cfg())).toEqual(KNOWN_KEY_VARS);
  });
});

describe("routing", () => {
  const flow = parseFlow(`
name: f
defaults: {model: sonnet}
steps:
  - {id: review, type: claude, model: opus, prompt: x}
  - {id: fix, type: claude, prompt: x}
  - {id: cross, type: claude, agent: codex, prompt: x}
`);
  const step = (id: string) => flow.steps.find((s) => s.id === id) as ClaudeStep;

  it("uses step model, then flow default; a switched agent doesn't inherit the other agent's model", () => {
    const c = cfg();
    expect(resolveTarget(step("review"), flow, c, 1).label).toBe("claude:anthropic:opus");
    expect(resolveTarget(step("fix"), flow, c, 1).label).toBe("claude:anthropic:sonnet");
    expect(resolveTarget(step("cross"), flow, c, 1).label).toBe("codex:openai");
  });

  it("lets the first matching rule win, even over a model set in the flow", () => {
    const c = cfg({ router: { rules: [
      { step: "^review$", model: "codex:gpt-5" },
      { step: "^fix$", min_visit: 2, model: "ollama:qwen3-coder:30b" },
    ] } });
    expect(resolveTarget(step("review"), flow, c, 1).label).toBe("codex:openai:gpt-5");
    expect(resolveTarget(step("fix"), flow, c, 1).label).toBe("claude:anthropic:sonnet");
    expect(resolveTarget(step("fix"), flow, c, 2).label).toBe("claude:ollama:qwen3-coder:30b");
  });

  it("a rule with `agent` matches only steps whose own target runs on that agent", () => {
    const toClaude = cfg({ router: { rules: [{ agent: "codex", model: "sonnet" }] } });
    expect(resolveTarget(step("cross"), flow, toClaude, 1).label).toBe("claude:anthropic:sonnet");
    expect(resolveTarget(step("review"), flow, toClaude, 1).label).toBe("claude:anthropic:opus");
    expect(resolveTarget(step("fix"), flow, toClaude, 1).label).toBe("claude:anthropic:sonnet");
    const toCodex = cfg({ router: { rules: [{ agent: "claude", model: "codex" }] } });
    expect(resolveTarget(step("review"), flow, toCodex, 1).label).toBe("codex:openai");
    expect(resolveTarget(step("fix"), flow, toCodex, 1).label).toBe("codex:openai");
    expect(resolveTarget(step("cross"), flow, toCodex, 1).label).toBe("codex:openai");
    expect(stepRoute(step("cross"), flow, toClaude, 1)).toBe("sonnet");
    expect(stepRoute(step("fix"), flow, toClaude, 1)).toBeUndefined();
  });

  it("a rule with `agent` leaves a step with a broken own target to report its own error", () => {
    const f = parseFlow("name: f\nsteps:\n  - {id: bad, type: claude, provider: nowhere, prompt: x}\n");
    const bad = f.steps[0] as ClaudeStep;
    const c = cfg({ router: { rules: [{ agent: "claude", model: "codex" }] } });
    expect(stepRoute(bad, f, c, 1)).toBeUndefined();
    expect(() => resolveTarget(bad, f, c, 1)).toThrow(/unknown provider/);
  });

  it("the analyst does not touch a step that an `agent` rule routes", () => {
    const c = cfg({ router: { rules: [{ agent: "claude", model: "codex" }] } });
    expect(analystSet(step("fix"), flow, c, 1)).toEqual({});
  });

  it("maps permissions onto Codex sandboxes", () => {
    const f = parseFlow(`
name: f
steps:
  - {id: plan, type: claude, prompt: x, permission_mode: plan}
  - {id: ro, type: claude, prompt: x, permission_mode: dontAsk, allowed_tools: [Read, Grep]}
  - {id: rw, type: claude, prompt: x}
  - {id: yolo, type: claude, prompt: x, permission_mode: bypassPermissions}
`);
    const scope = { flow: f } as Parameters<typeof codexSandbox>[1];
    const mode = (id: string, sbx = false) => codexSandbox(f.steps.find((s) => s.id === id) as ClaudeStep, scope, sbx);
    expect([mode("plan"), mode("ro"), mode("rw"), mode("yolo"), mode("yolo", true)]).toEqual(["read-only", "read-only", "workspace-write", "danger-full-access", "workspace-write"]);
  });

  it("isolates Claude Code from the user's setup and passes effort", () => {
    const args = buildClaudeArgs({ prompt: "p", cwd: "/w", logFile: "/l", isolated: true, effort: "xhigh", systemPrompt: "extra" });
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--setting-sources", "project,local", "--disable-slash-commands", "--effort", "xhigh"]));
    const sys = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(sys).toContain("running unattended as one step of a Spaghetti Code Foundry flow");
    expect(sys).toContain("extra");
    expect(buildClaudeArgs({ prompt: "p", cwd: "/w", logFile: "/l" })).not.toContain("--setting-sources");
    expect(buildCodexArgs({ prompt: "p", cwd: "/w", logFile: "/l", sandbox: "read-only", effort: "max" })).toContain('model_reasoning_effort="xhigh"');
  });

  it("lets Claude read the read-only folders and refuses its edits there, through the settings", () => {
    const base = { prompt: "p", cwd: "/w", logFile: "/l" };
    const args = buildClaudeArgs({ ...base, readOnlyDirs: ["/runs/r 1/context/", "/real/runs/r1/context"], sandbox: true, writableDirs: ["/req"] });
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(settings.permissions.allow).toEqual(["Read(//runs/r 1/context/**)", "Read(//real/runs/r1/context/**)"]);
    expect(settings.permissions.deny).toEqual(
      ["//runs/r 1/context/**", "//real/runs/r1/context/**"].flatMap((p) => [`Edit(${p})`, `Write(${p})`, `NotebookEdit(${p})`]),
    );
    expect(settings.sandbox.filesystem.allowWrite).toEqual(["/req"]);
    expect(args.filter((a) => a === "--add-dir")).toHaveLength(1); // only the writable folder
    expect(args).not.toContain("--allowedTools");
    expect(buildClaudeArgs({ ...base, sandbox: true })).not.toContain("--add-dir");
    expect(buildClaudeArgs(base)).not.toContain("--settings");
  });

  it("the note allows only the Foundry skill block, and keeps the isolation flags", () => {
    expect(FACTORY_AGENT_NOTE).not.toContain("Do not use skills");
    expect(FACTORY_AGENT_NOTE).toContain("<foundry-skills>");
    expect(FACTORY_AGENT_NOTE).toContain("do not use, load or look for any other skill");
    expect(FACTORY_AGENT_NOTE).toContain("win over it");
    expect(FACTORY_AGENT_NOTE).toContain("running unattended");
    expect(FACTORY_AGENT_NOTE).toContain("an earlier prompt of this session");
    const args = buildClaudeArgs({ prompt: "p", cwd: "/w", logFile: "/l", isolated: true, systemPrompt: "extra" });
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe(FACTORY_AGENT_NOTE + "\n\nextra");
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--setting-sources", "project,local", "--disable-slash-commands", "--disallowedTools", "Bash(git push*)"]));
  });

  it("finds the session a step resumes and the skill block it holds", () => {
    const steps = {
      impl: { agent: "claude:anthropic:opus", session_id: "s1", skills_digest: "sha256:x" },
      old: { agent: "claude:anthropic", session_id: "s2" },
      none: { agent: "claude:anthropic", session_id: "", skills_digest: "sha256:y" },
      odd: { agent: "claude:anthropic", session_id: "s3", skills_digest: 7 },
    };
    expect(sessionToResume({}, steps, "claude")).toEqual({ asked: false });
    expect(sessionToResume({ resume: "impl" }, steps, "claude")).toEqual({ asked: true, id: "s1", prevAgent: "claude", holds: "sha256:x" });
    // another agent cannot continue the session
    expect(sessionToResume({ resume: "impl" }, steps, "codex")).toEqual({ asked: true, id: undefined, prevAgent: "claude" });
    expect(sessionToResume({ resume: "old" }, steps, "claude").holds).toBeUndefined();
    expect(sessionToResume({ resume: "none" }, steps, "claude")).toEqual({ asked: true, id: undefined, prevAgent: "claude" });
    expect(sessionToResume({ resume: "odd" }, steps, "claude").holds).toBeUndefined();
  });

  it.each([
    [true, false, undefined, true],
    [false, false, undefined, false],
    [false, false, { loaded: [], omitted: [] }, false],
    [false, false, { loaded: ["a@1.0.0"], omitted: [] }, true],
    [false, false, { loaded: [], omitted: ["a@1.0.0"] }, true],
    [false, true, undefined, true],
  ])("claudeIsolated(%s, %s, %j) is %s", (setting, user, skills, want) => {
    expect(claudeIsolated(setting, user, skills)).toBe(want);
  });

  it("builds codex exec args for new, local and resumed sessions", () => {
    const base = { prompt: "p", cwd: "/w", logFile: "/l", sandbox: "workspace-write" as const };
    expect(buildCodexArgs({ ...base, model: "gpt-5" })).toEqual(["exec", "--json", "--skip-git-repo-check", "-c", 'sandbox_mode="workspace-write"', "-c", 'approval_policy="never"', "-m", "gpt-5", "-C", "/w", "--color", "never", "-"]);
    expect(buildCodexArgs({ ...base, localProvider: "ollama" })).toContain('model_provider="ollama"');
    const r = buildCodexArgs({ ...base, resumeSessionId: "T1" });
    expect(r.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(r.slice(-2)).toEqual(["T1", "-"]);
  });
});

describe("running on other agents and providers", () => {
  let tmp: string;
  let repo: string;
  let runsDir: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "factory-agents-"));
    repo = join(tmp, "repo");
    runsDir = join(tmp, "runs");
    mkdirSync(repo);
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const start = (yaml: string, config = cfg()) => runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, config });

  it("runs a codex step, resumes its session, and records tokens and a cost from the price table", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, agent: codex, model: gpt-5, prompt: "WRITE out.txt hi"}
  - {id: b, type: claude, agent: codex, resume: a, prompt: "SAY again"}
`);
    expect(s.status).toBe("succeeded");
    const [a, b] = s.history;
    expect(a!.agent).toBe("codex:openai:gpt-5");
    expect(a!.tokens).toEqual({ input: 1000, output: 50, cached: 0 });
    expect(a!.costUsd).toBeCloseTo((1000 * 1.25 + 50 * 10) / 1e6, 12);
    expect(a!.output).toContain('sandbox_mode="workspace-write"');
    expect(b!.output).toBe("again");
    expect(b!.sessionId).toBe(a!.sessionId);

    const t = readTranscript(a!.logFile);
    expect(t.map((e) => e.kind)).toEqual(["tool", "tool", "text", "result"]);
    expect(t[0]).toMatchObject({ name: "Edit", input: { file_path: "out.txt" } });
    expect(t[1]).toMatchObject({ name: "Bash", result: "clean\n", isError: false });
  });

  describe("Codex cost and cached tokens", () => {
    const one = (extra: string, config = cfg(), model = "gpt-5") =>
      start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, agent: codex, model: ${model}, prompt: "${extra}SAY ok"}
`, config);

    it("prices a Codex step from the built-in table, with the cached tokens at their own rate", async () => {
      const s = await one("CACHED 400\\n");
      expect(s.history[0]!.tokens).toEqual({ input: 1000, output: 50, cached: 400 });
      expect(s.history[0]!.costUsd).toBeCloseTo((600 * 1.25 + 400 * 0.125 + 50 * 10) / 1e6, 12);
      expect(s.totalCostUsd).toBeCloseTo(s.history[0]!.costUsd!, 12);
    });

    it("lets a configured price win over the built-in one", async () => {
      const s = await one("", cfg({ usage: { prices: { "gpt-5": { input_per_mtok: 2, cached_input_per_mtok: 1, output_per_mtok: 4 } } } }));
      expect(s.history[0]!.costUsd).toBeCloseTo((1000 * 2 + 50 * 4) / 1e6, 12);
    });

    it("leaves the cost out for a model with no price, and adds nothing to the total", async () => {
      const s = await one("", cfg(), "gpt-unknown-9");
      expect(s.status).toBe("succeeded");
      expect(s.history[0]!.costUsd).toBeUndefined();
      expect(s.totalCostUsd).toBe(0);
    });

    it("counts a paid failed try once: in the total, and in earlierCostUsd of the fallback that finished the step", async () => {
      const marker = join(mkdtempSync(join(tmpdir(), "lim-")), "seen");
      const s = await one(`PAID_FAIL\\nCODEX_LIMIT_ONCE ${marker}\\n`, cfg({ router: { fallback: ["codex:openai:gpt-5-mini"] } }));
      const rec = s.history[0]!;
      const failed = (2000 * 1.25 + 100 * 10) / 1e6;
      const final = (1000 * 0.25 + 50 * 2) / 1e6;
      expect(rec.agent).toBe("codex:openai:gpt-5-mini");
      expect(rec.retried?.models).toBe(1);
      expect(rec.earlierCostUsd).toBeCloseTo(failed, 12);
      expect(rec.costUsd).toBeCloseTo(final, 12);
      expect(s.totalCostUsd).toBeCloseTo(failed + final, 12);
    });

    it("counts a paid failed try once after a brief outage, too", async () => {
      const marker = join(mkdtempSync(join(tmpdir(), "cap-")), "seen");
      const s = await one(`PAID_FAIL\\nCODEX_CAPACITY_ONCE ${marker}\\n`);
      const failed = (2000 * 1.25 + 100 * 10) / 1e6;
      expect(s.history[0]!.retried).toEqual({ blips: 1, models: 0 });
      expect(s.history[0]!.earlierCostUsd).toBeCloseTo(failed, 12);
      expect(s.totalCostUsd).toBeCloseTo(failed + (1000 * 1.25 + 50 * 10) / 1e6, 12);
    });

    it("does not count the failed try twice when the run is cancelled during the wait before the retry", async () => {
      const marker = join(mkdtempSync(join(tmpdir(), "cap-")), "seen");
      const stop = new AbortController();
      const s = await runFlow(
        parseFlow(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, agent: codex, model: gpt-5, prompt: "PAID_FAIL\\nCODEX_CAPACITY_ONCE ${marker}\\nSAY ok"}
`),
        { task: "t", repo, runsDir, claudeBin, config: cfg(), signal: stop.signal, log: (l) => void (l.includes("trying again") && stop.abort()) },
      );
      const failed = (2000 * 1.25 + 100 * 10) / 1e6;
      expect(s.status).toBe("cancelled");
      const summed = s.history.reduce((n, r) => n + (r.costUsd ?? 0), 0);
      expect(summed).toBeCloseTo(failed, 12);
      expect(s.totalCostUsd).toBeCloseTo(failed, 12);
    });
  });

  it("points Claude Code at a local provider, without MCP, at $0", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, model: "ollama:qwen3-coder:30b", prompt: SHOWENV}
`);
    const out = s.history[0]!.output;
    expect(out).toContain("base=http://localhost:11434 token=ollama haiku=qwen3-coder:30b");
    expect(out).toContain("--strict-mcp-config");
    expect(out).toContain("--model qwen3-coder:30b");
    expect(s.history[0]!.costUsd).toBe(0);
    expect(s.history[0]!.agent).toBe("claude:ollama:qwen3-coder:30b");
  });

  it("falls back to the next model when one hits a usage limit", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "CLAUDE_LIMIT\\nSAY from codex"}
`, cfg({ router: { fallback: ["codex"] } }));
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.agent).toBe("codex:openai");
    expect(s.history[0]!.output).toBe("from codex");
    expect(s.history[0]!.retried?.models).toBe(1);
  });

  it("keeps the tool times and context size of the earlier try when another model takes over", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "WRITE a.txt x\\nCLAUDE_LIMIT\\nSAY from codex"}
`, cfg({ router: { fallback: ["codex"] } }));
    const rec = s.history[0]!;
    expect(rec.agent).toBe("codex:openai");
    expect(rec.retried?.models).toBe(1);
    // the Claude try that hit the limit made one call; the Codex try reports none
    expect(rec.tools?.calls).toBe(1);
    expect(Number.isInteger(rec.tools?.totalMs)).toBe(true);
    expect(rec.contextTokens).toBe(1110);
  });

  it("pauses the run on a usage limit when no fallback is left, and resumes where it stopped", async () => {
    const flow = `
name: t
workspace: inplace
steps:
  - {id: a, type: shell, run: echo before}
  - {id: b, type: claude, prompt: "{{vars.p}}"}
`;
    const s = await runFlow(parseFlow(flow), { task: "t", repo, runsDir, claudeBin, config: cfg(), vars: { p: "CLAUDE_LIMIT" } });
    expect(s.status).toBe("stopped");
    expect(s.reason).toMatch(/^usage limit reached: You've hit your limit .* continues automatically/);
    expect(s.state.next).toBe("b");
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg() });
    expect(r.status).toBe("stopped"); // still limited (same prompt) — but no visits were used up
    expect(r.state.visits.b ?? 0).toBe(0);
  });

  it("tries a step again when the service is briefly at capacity, instead of failing the story", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "cap-")), "seen");
    const flow = `
name: t
workspace: inplace
steps:
  - {id: review, type: claude, agent: codex, prompt: "CODEX_CAPACITY_ONCE ${marker}\\nSAY looks fine"}
`;
    const s = await runFlow(parseFlow(flow), { task: "t", repo, runsDir, claudeBin, config: cfg() });
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.output).toContain("looks fine");
    expect(s.history[0]!.retried).toEqual({ blips: 1, models: 0 });
  });

  it("pauses as unreachable when the AI service cannot be reached, after two brief retries", async () => {
    const flow = `
name: t
workspace: inplace
steps:
  - {id: b, type: claude, prompt: "{{vars.p}}"}
`;
    const s = await runFlow(parseFlow(flow), { task: "t", repo, runsDir, claudeBin, config: cfg(), vars: { p: "CLAUDE_UNREACHABLE" } });
    expect(s.status).toBe("stopped");
    expect(s.reason).toMatch(/^usage limit reached:/);
    expect(s.history[0]).toMatchObject({ limited: true, unreachable: true, retried: { blips: 2, models: 0 } });
  });

  it("an overloaded service (529) counts as unreachable, a 429 rate limit does not", async () => {
    const flow = `
name: t
workspace: inplace
steps:
  - {id: b, type: claude, prompt: "{{vars.p}}"}
`;
    const o = await runFlow(parseFlow(flow), { task: "t", repo, runsDir, claudeBin, config: cfg(), vars: { p: "CLAUDE_OVERLOADED" } });
    expect(o.history[0]).toMatchObject({ limited: true, unreachable: true });
    expect(isQuotaError("API Error: 429 rate limit", "")).toBe(true);
    expect(isQuotaError("API Error: 529 overloaded_error", "")).toBe(false);
    expect(isTransientError("429 rate limit exceeded: try again later", "")).toBe(true); // overlap: still a quota error
  });

  it("a true usage limit is limited but not unreachable", async () => {
    const flow = `
name: t
workspace: inplace
steps:
  - {id: b, type: claude, prompt: "{{vars.p}}"}
`;
    const s = await runFlow(parseFlow(flow), { task: "t", repo, runsDir, claudeBin, config: cfg(), vars: { p: "CLAUDE_LIMIT" } });
    expect(s.history[0]!.limited).toBe(true);
    expect(s.history[0]!.unreachable).toBeUndefined();
  });

  it("buildClaudeArgs gives the model no tools only when asked", () => {
    const args = buildClaudeArgs({ prompt: "x", cwd: ".", logFile: "l", noTools: true });
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(buildClaudeArgs({ prompt: "x", cwd: ".", logFile: "l" })).not.toContain("--tools");
  });

  it("buildClaudeArgs is unchanged without tools", () => {
    const o = { prompt: "x", cwd: ".", logFile: "l" };
    expect(buildClaudeArgs(o)).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--disallowedTools", "Bash(git push*)"]);
    const args = buildClaudeArgs({ ...o, isolated: true, sandbox: true });
    expect(args[args.indexOf("--settings") + 1]).toBe('{"sandbox":{"enabled":true,"autoAllowBashIfSandboxed":true}}');
    expect(args.filter((a) => a === "--settings")).toHaveLength(1);
  });

  it("buildClaudeArgs with tools: only those tools, no hooks, no personal setup", () => {
    const o = { prompt: "x", cwd: ".", logFile: "l", tools: ["Read", "Grep"] };
    const args = buildClaudeArgs(o);
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep");
    expect(args[args.indexOf("--settings") + 1]).toBe('{"disableAllHooks":true}');
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local");
    expect(args).not.toContain("--append-system-prompt");
    const both = buildClaudeArgs({ ...o, sandbox: true });
    expect(both.filter((a) => a === "--settings")).toHaveLength(1);
    expect(JSON.parse(both[both.indexOf("--settings") + 1]!)).toEqual({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true }, disableAllHooks: true });
    expect(buildClaudeArgs({ ...o, tools: [] })[buildClaudeArgs({ ...o, tools: [] }).indexOf("--tools") + 1]).toBe("");
    const no = buildClaudeArgs({ ...o, tools: ["Read"], noTools: true });
    expect(no.filter((a) => a === "--tools")).toHaveLength(1);
    expect(no[no.indexOf("--tools") + 1]).toBe("");
  });

  it("pauses the run when the agent is signed out, and says how to sign in", async () => {
    const flow = `
name: t
workspace: inplace
steps:
  - {id: b, type: claude, prompt: "{{vars.p}}"}
`;
    const s = await runFlow(parseFlow(flow), { task: "t", repo, runsDir, claudeBin, config: cfg(), vars: { p: "CLAUDE_SIGNED_OUT" } });
    expect(s.status).toBe("stopped"); // paused and retried later, not failed
    expect(s.reason).toBe('signed out — the Claude Code login has expired. Sign in again: run "claude" in a terminal and type /login. The run continues by itself after that.');
    expect(s.state.next).toBe("b");
  });

  it("recognises every wording of a plan limit (usage, session, weekly)", async () => {
    const { isLimitError } = await import("../src/agents/targets.js");
    for (const m of ["You've hit your limit · resets 3pm", "You've hit your usage limit", "You've hit your session limit · resets 4:20pm (Europe/Amsterdam)", "Weekly limit reached", "5-hour limit reached"]) {
      expect(isLimitError(m, ""), m).toBe(true);
    }
  });

  it("does not treat a long answer that mentions quota as a limit", async () => {
    const long = "x".repeat(500);
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "SAY quota exceeded ${long}", pass_if: NEVER}
`, cfg({ router: { fallback: ["codex"] } }));
    expect(s.status).toBe("failed");
    expect(s.history).toHaveLength(1);
  });

  it("does not fall back on ordinary failures", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "ERROR"}
`, cfg({ router: { fallback: ["codex"] } }));
    expect(s.status).toBe("failed");
    expect(s.history[0]!.agent).toBe("claude:anthropic");
  });

  it("continues on a free fallback when the run budget is used up", async () => {
    const flow = `
name: t
workspace: inplace
limits: {max_cost_usd: 0.005}
steps:
  - {id: a, type: claude, prompt: "SAY paid"}
  - {id: b, type: claude, prompt: "SAY free"}
`;
    const paused = await start(flow);
    expect(paused.status).toBe("failed");
    expect(paused.reason).toMatch(/run budget/);

    const s = await start(flow, cfg({ router: { fallback: ["sonnet", "codex"] } }));
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.agent)).toEqual(["claude:anthropic", "codex:openai"]);
    // Resuming keeps honouring it.
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, from: "b", config: cfg({ router: { fallback: ["codex"] } }) });
    expect(r.history.at(-1)!.agent).toBe("codex:openai");
  });

  it("continues on a free fallback when the owner's daily budget is used up", async () => {
    const s = await runFlow(parseFlow(`
name: t
workspace: empty
steps:
  - {id: a, type: claude, prompt: "SAY paid"}
  - {id: b, type: claude, prompt: "SAY free"}
`), {
      task: "t", repo, runsDir, claudeBin, owner: "u1", userDailyBudget: () => 0.005,
      config: cfg({ bot: { name: "Bot", email: "bot@example.com" }, router: { fallback: ["codex"] } }),
    });
    expect(s.status).toBe("succeeded");
    expect(s.history.map((h) => h.agent)).toEqual(["claude:anthropic", "codex:openai"]);
    expect(readFileSync(liveLogFile(s.runDir), "utf8")).toMatch(/the owner's daily budget reached — agent steps continue on/);
  });

  it("the daily cap of the project stops the run although a free fallback is configured or already active (#792)", async () => {
    const flow = parseFlow(`
name: t
workspace: empty
steps:
  - {id: a, type: claude, prompt: "SAY paid"}
  - {id: b, type: claude, prompt: "SAY free"}
  - {id: c, type: claude, prompt: "SAY more"}
`);
    const run = (config: Config, cap: () => number | undefined) => runFlow(flow, {
      task: "t", repo, runsDir, claudeBin, owner: "u1", vars: { github_repo: "acme/a" }, projectDailyBudget: cap, config,
    });
    const conf = (over: Record<string, unknown>) => cfg({ bot: { name: "Bot", email: "bot@example.com" }, ...over });
    // a free fallback is configured: the owner budget would use it, the project cap does not
    const s = await run(conf({ router: { fallback: ["codex"] } }), () => 0.005);
    expect(s.status).toBe("stopped");
    expect(s.reason).toBe(PROJECT_BUDGET_REASON);
    expect(s.history).toHaveLength(1);
    // the fallback is already active (the run budget switched to it): the cap of the project still stops the run
    const t = await runFlow(parseFlow(`
name: t
workspace: empty
limits: {max_cost_usd: 0.005}
steps:
  - {id: a, type: claude, prompt: "SAY paid"}
  - {id: b, type: claude, prompt: "SAY free"}
  - {id: c, type: claude, prompt: "SAY more"}
`), { task: "t", repo, runsDir, claudeBin, owner: "u1", vars: { github_repo: "acme/a" }, projectDailyBudget: () => 0.007, config: conf({ router: { fallback: ["codex"] } }) });
    expect(t.status).toBe("stopped");
    expect(t.reason).toBe(PROJECT_BUDGET_REASON);
  });

  it("does not resume a session across agents", async () => {
    const s = await start(`
name: t
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "SAY first"}
  - {id: b, type: claude, agent: codex, resume: a, prompt: "SAY second"}
`);
    expect(s.status).toBe("succeeded");
    expect(s.history[1]!.sessionId).not.toBe(s.history[0]!.sessionId);
  });
});

describe("evals", () => {
  it("withModel overrides agent and provider on every agent step", () => {
    const f = withModel(parseFlow(`
name: f
defaults: {agent: codex}
steps:
  - {id: a, type: claude, agent: codex, provider: openai, prompt: x}
`), "ollama:qwen3-coder");
    expect(f.name).toBe("f@ollama:qwen3-coder");
    const s = f.steps[0] as ClaudeStep;
    expect([s.agent, s.provider, s.model, f.defaults.agent]).toEqual([undefined, undefined, "ollama:qwen3-coder", undefined]);
  });
});

describe("Codex isolation arguments", () => {
  const base = { prompt: "p", cwd: "/w", logFile: "/l", sandbox: "workspace-write" as const };
  const withFlag = (a: string[], at: number) => [...a.slice(0, at), "--ignore-user-config", ...a.slice(at)];
  const only = (a: string[], p: string) => a.filter((x) => x.startsWith(p));

  it("ignoreUserConfig adds only the flag, right after --skip-git-repo-check", () => {
    const plain = buildCodexArgs(base);
    const on = buildCodexArgs({ ...base, ignoreUserConfig: true });
    expect(on).toEqual(withFlag(plain, 3));
    expect(on[2]).toBe("--skip-git-repo-check");
    const rPlain = buildCodexArgs({ ...base, resumeSessionId: "T1" });
    const rOn = buildCodexArgs({ ...base, resumeSessionId: "T1", ignoreUserConfig: true });
    expect(rOn).toEqual(withFlag(rPlain, 4));
    for (const a of [on, rOn]) {
      expect(only(a, "sandbox_mode=")).toEqual(only(plain, "sandbox_mode="));
      expect(only(a, "approval_policy=")).toEqual(only(plain, "approval_policy="));
    }
  });

  it("a reviewer has the flag once, unless ignoreUserConfig is false", () => {
    for (const ignoreUserConfig of [undefined, true]) {
      expect(buildCodexArgs({ ...base, reviewer: true, ignoreUserConfig }).filter((x) => x === "--ignore-user-config")).toHaveLength(1);
    }
    const off = buildCodexArgs({ ...base, reviewer: true, ignoreUserConfig: false });
    expect(off).not.toContain("--ignore-user-config");
    expect(off).toContain("mcp_servers={}");
    expect(off).toContain("features.codex_hooks=false");
  });

  it("a clean session adds the two overrides once (also for a reviewer) and no flag", () => {
    for (const reviewer of [false, true]) {
      const a = buildCodexArgs({ ...base, clean: true, reviewer, ignoreUserConfig: false });
      expect(a.filter((x) => x === "mcp_servers={}")).toHaveLength(1);
      expect(a.filter((x) => x === "features.codex_hooks=false")).toHaveLength(1);
      expect(a).not.toContain("--ignore-user-config");
    }
    expect(buildCodexArgs(base)).not.toContain("mcp_servers={}");
  });

  it("noNetwork switches off the network of the workspace-write sandbox only", () => {
    const net = "sandbox_workspace_write.network_access=false";
    expect(buildCodexArgs({ ...base, noNetwork: true })).toContain(net);
    expect(buildCodexArgs({ ...base, noNetwork: false })).not.toContain(net);
    for (const sandbox of ["read-only", "danger-full-access"] as const) expect(buildCodexArgs({ ...base, sandbox, noNetwork: true })).not.toContain(net);
  });

  it("no combination passes --ignore-rules", () => {
    for (const reviewer of [false, true]) for (const clean of [false, true]) for (const ignoreUserConfig of [undefined, false, true]) for (const agentNote of [false, true]) for (const resumeSessionId of [undefined, "T"]) for (const localProvider of [undefined, "ollama"]) {
      expect(buildCodexArgs({ ...base, reviewer, clean, ignoreUserConfig, agentNote, resumeSessionId, localProvider })).not.toContain("--ignore-rules");
    }
  });

  it("CODEX_AGENT_NOTE names the setup and the skills block, and is about Codex", () => {
    expect(CODEX_AGENT_NOTE).toContain("unattended");
    expect(CODEX_AGENT_NOTE).toContain("<foundry-skills>");
    expect(CODEX_AGENT_NOTE).toContain("~/.codex");
    expect(CODEX_AGENT_NOTE).not.toContain("~/.claude");
  });
});

describe("codexExecFlags", () => {
  const calls: string[][] = [];
  const run = (_b: string, a: string[]) => {
    calls.push(a);
    return "  --json\n  --ignore-user-config  Skip\n -m";
  };
  beforeEach(() => {
    resetCodexFlagsCache();
    calls.length = 0;
  });

  it("parses the help text", () => {
    const f = codexExecFlags("c1", { run });
    expect(f.has("--json")).toBe(true);
    expect(f.has("--ignore-user-config")).toBe(true);
    expect(f.has("-m")).toBe(false);
  });

  it("gives an empty set on a throw and caches it", () => {
    let n = 0;
    const bad = () => {
      n++;
      throw new Error("x");
    };
    expect(codexExecFlags("c2", { run: bad }).size).toBe(0);
    expect(codexExecFlags("c2", { run: bad }).size).toBe(0);
    expect(n).toBe(1);
  });

  it("reads each form once and keeps them apart", () => {
    codexExecFlags("c3", { run });
    codexExecFlags("c3", { run });
    codexExecFlags("c3", { run, resume: true });
    codexExecFlags("c3", { run, resume: true });
    expect(calls).toEqual([["exec", "--help"], ["exec", "resume", "--help"]]);
  });

  it("reads again after a reset or after 10 minutes", () => {
    const t0 = 1_000_000;
    codexExecFlags("c4", { run, now: t0 });
    codexExecFlags("c4", { run, now: t0 + 599_999 });
    expect(calls).toHaveLength(1);
    codexExecFlags("c4", { run, now: t0 + 600_000 });
    expect(calls).toHaveLength(2);
    resetCodexFlagsCache();
    codexExecFlags("c4", { run, now: t0 + 600_000 });
    expect(calls).toHaveLength(3);
  });
});
