import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentHomeEnv, agentKeyNames, codexKeyEnv, dropLoginVars, freeWhenBoxed, missingAgentKey, noAgentKey } from "../src/agents/boxed.js";
import { providers, specOf, toTarget } from "../src/agents/targets.js";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { resetSandboxCache } from "../src/engine/os-sandbox.js";
import { runFlow } from "../src/engine/runner.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { parseFlow } from "../src/flow/load.js";
import { buildClaudeArgs } from "../src/steps/claude.js";
import { buildCodexArgs } from "../src/steps/codex.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const conf = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    protected_branches: [],
    providers: {
      gh: { kind: "anthropic-compatible", base_url: "http://127.0.0.1:1", api_key_env: "PROVIDER_KEY_FOR_TEST" },
      nokey: { kind: "anthropic-compatible", base_url: "http://127.0.0.1:1" },
    },
    ...over,
  });
const target = (spec: string, config: Config = conf()) => toTarget(specOf(spec, config), config);
const KEY_VARS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "PROVIDER_KEY_FOR_TEST", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SCF_USER_SANDBOX"];
const CLAUDE_NAMES = "CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN";
const CODEX_NAMES = "OPENAI_API_KEY or CODEX_API_KEY";

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEY_VARS.map((k) => [k, process.env[k]]));
  for (const k of KEY_VARS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetSandboxCache();
});

describe("missingAgentKey", () => {
  const key = "k".repeat(20);
  it("Claude on anthropic needs one of three variables", () => {
    const t = target("claude:anthropic");
    expect(missingAgentKey(t, {})).toBe(noAgentKey(CLAUDE_NAMES));
    expect(missingAgentKey(t, { ANTHROPIC_API_KEY: "" })).toBe(noAgentKey(CLAUDE_NAMES));
    for (const n of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) expect(missingAgentKey(t, { [n]: key }), n).toBeUndefined();
  });

  it("Codex on openai needs OPENAI_API_KEY or CODEX_API_KEY", () => {
    const t = target("codex");
    expect(missingAgentKey(t, {})).toBe(noAgentKey(CODEX_NAMES));
    expect(missingAgentKey(t, { OPENAI_API_KEY: key })).toBeUndefined();
    expect(missingAgentKey(t, { CODEX_API_KEY: key })).toBeUndefined();
  });

  it("a compatible provider needs its api_key_env: the token 'none' and a missing api_key_env count as missing", () => {
    const t = target("claude:gh:m");
    expect(missingAgentKey(t, { ANTHROPIC_AUTH_TOKEN: "none" })).toBe(noAgentKey("PROVIDER_KEY_FOR_TEST"));
    expect(missingAgentKey(t, { ANTHROPIC_AUTH_TOKEN: key })).toBeUndefined();
    const n = target("claude:nokey:m");
    expect(missingAgentKey(n, { ANTHROPIC_AUTH_TOKEN: key })).toBe(noAgentKey("api_key_env for the nokey provider"));
    expect(agentKeyNames(n)).toContain("nokey");
  });

  it("a local provider needs none, for both agents", () => {
    expect(missingAgentKey(target("claude:ollama:m"), {})).toBeUndefined();
    expect(missingAgentKey(target("codex:lmstudio:m"), {})).toBeUndefined();
  });
});

describe("the other helpers", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "agent-box-"));

  it("agentHomeEnv gives private folders, mode 0700, that are real folders and keep their files", () => {
    const run = tmp();
    mkdirSync(join(run, "home"));
    const elsewhere = tmp();
    symlinkSync(elsewhere, join(run, "home", ".claude"));
    const env = agentHomeEnv(run);
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: join(run, "home", ".claude"), CODEX_HOME: join(run, "home", ".codex") });
    for (const d of Object.values(env)) expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(run, "home", ".claude")).isDirectory()).toBe(true);
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, "session"), "x");
    agentHomeEnv(run);
    expect(existsSync(join(env.CLAUDE_CONFIG_DIR, "session"))).toBe(true);
  });

  it("codexKeyEnv copies OPENAI_API_KEY only when CODEX_API_KEY is empty, and only for openai", () => {
    const t = target("codex");
    expect(codexKeyEnv(t, { OPENAI_API_KEY: "o" })).toEqual({ CODEX_API_KEY: "o" });
    expect(codexKeyEnv(t, { OPENAI_API_KEY: "o", CODEX_API_KEY: "c" })).toEqual({});
    expect(codexKeyEnv(t, {})).toEqual({});
    expect(codexKeyEnv(target("codex:ollama:m"), { OPENAI_API_KEY: "o" })).toEqual({});
    expect(codexKeyEnv(target("claude"), { OPENAI_API_KEY: "o" })).toEqual({});
  });

  it("dropLoginVars removes login names and reports them", () => {
    const extra = { CLAUDE_CODE_OAUTH_TOKEN: "a", CODEX_API_KEY: "b", MY_KEY: "c", JAVA_HOME: "/jdk" };
    expect(dropLoginVars(extra, ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "MY_KEY", "OPENAI_API_KEY"])).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "MY_KEY"]);
    expect(extra).toEqual({ JAVA_HOME: "/jdk" });
  });

  it("freeWhenBoxed is true for a local model only; the target of Codex on openai stays free as before", () => {
    expect(freeWhenBoxed(target("codex:openai"))).toBe(false);
    expect(freeWhenBoxed(target("claude:anthropic"))).toBe(false);
    expect(freeWhenBoxed(target("claude:ollama:m"))).toBe(true);
    process.env.OPENAI_API_KEY = "o";
    expect(target("codex").free).toBe(true);
    expect(Object.keys(providers(conf()))).toContain("gh");
  });

  it("the agents' own sandbox can be left out of the arguments", () => {
    expect(buildClaudeArgs({ prompt: "x", cwd: ".", logFile: "l", sandbox: false })).not.toContain("--settings");
    expect(buildClaudeArgs({ prompt: "x", cwd: ".", logFile: "l", sandbox: true })).toContain("--settings");
    expect(buildCodexArgs({ prompt: "x", cwd: ".", logFile: "l", sandbox: "danger-full-access" })).toContain('sandbox_mode="danger-full-access"');
  });
});

let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let admin: { id: string };
let user: { id: string };
let savedHome: string | undefined;

describe("steps of runs", () => {
  beforeEach(async () => {
    savedHome = process.env.FACTORY_HOME;
    gh = fakeGithub();
    process.env.FACTORY_HOME = join(gh.tmp, "home");
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
    kc = fakeKeychain();
    resetRedactCache();
    admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
    user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
    addRepo(user.id, { url: "acme/app", method: "none" });
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = savedHome;
    resetRedactCache();
    resetSandboxCache();
    kc.remove();
    gh.restore();
  });

  const agent = (id: string, prompt: string, extra = "") => `  - id: ${id}\n    type: claude\n${extra}    prompt: ${JSON.stringify(prompt)}\n`;
  const flowOf = (steps: string) => parseFlow(`name: boxed\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${steps}`, "boxed.yaml");
  const go = (flow: ReturnType<typeof flowOf>, owner: string, config: Config = conf(), vars: Record<string, string> = {}) =>
    runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, codexBin, vars: { github_repo: "acme/app", ...vars }, config, owner });
  const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
  const boxedOn = () => {
    delete process.env.SCF_USER_SANDBOX;
    resetSandboxCache(true);
  };

  const CASES: { name: string; step: string; names: string; fallback: string }[] = [
    { name: "Claude on anthropic", step: agent("a", "hello", "    on_failure: rescue\n"), names: CLAUDE_NAMES, fallback: "codex" },
    { name: "Codex on openai", step: agent("a", "hello", "    agent: codex\n    on_failure: rescue\n"), names: CODEX_NAMES, fallback: "claude" },
    { name: "Claude on a compatible provider without its key", step: agent("a", "hello", "    model: gh:m\n    on_failure: rescue\n"), names: "PROVIDER_KEY_FOR_TEST", fallback: "codex" },
  ];
  const RESCUE = "  - id: rescue\n    type: shell\n    jump_only: true\n    run: echo rescued\n";

  for (const c of CASES) {
    it(`refuses ${c.name} in a user's boxed run, with no other try`, async () => {
      boxedOn();
      const s = await go(flowOf(c.step + RESCUE), user.id, conf({ router: { fallback: [c.fallback] } }));
      expect(s.status).toBe("failed");
      expect(s.reason).toContain(noAgentKey(c.names));
      expect(s.history).toHaveLength(1);
      expect(s.history[0]!.limited).toBeFalsy();
      expect(out(s, "a")).not.toContain("ok args=");
      expect(readFileSync(join(s.runDir, "live.log"), "utf8")).not.toContain("retrying on");
      expect(s.history.some((h) => h.id === "rescue")).toBe(false);
    });
  }

  it("refuses also when the flow's agent_env brings a key, and says it is ignored", async () => {
    boxedOn();
    const cl = await go(flowOf(agent("a", "hello")), user.id, conf(), { agent_env: `CLAUDE_CODE_OAUTH_TOKEN=${"t".repeat(20)}` });
    expect(cl.status).toBe("failed");
    expect(cl.reason).toContain(noAgentKey(CLAUDE_NAMES));
    expect(readFileSync(join(cl.runDir, "live.log"), "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN ignored");
    const cx = await go(flowOf(agent("a", "hello", "    agent: codex\n")), user.id, conf(), { agent_env: `CODEX_API_KEY=${"t".repeat(20)}` });
    expect(cx.status).toBe("failed");
    expect(cx.reason).toContain(noAgentKey(CODEX_NAMES));
    expect(readFileSync(join(cx.runDir, "live.log"), "utf8")).toContain("CODEX_API_KEY ignored");
  });

  it("an admin's run is unchanged: no key needed, own sandbox, inherited folders and agent_env", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/elsewhere-claude";
    process.env.CODEX_HOME = "/elsewhere-codex";
    const s = await go(
      flowOf(
        agent("cl", "hello", "    sandbox: true\n") +
          agent("cx", "hello", "    agent: codex\n    permission_mode: plan\n") +
          agent("vars", "SHOWVARS CLAUDE_CONFIG_DIR CODEX_HOME") +
          agent("env", "SHOWALLENV"),
      ),
      admin.id,
      conf(),
      { agent_env: `CLAUDE_CODE_OAUTH_TOKEN=${"t".repeat(20)}` },
    );
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "cl")).toContain("--settings");
    expect(out(s, "cx")).toContain('sandbox_mode="read-only"');
    expect(out(s, "vars")).toContain("CLAUDE_CONFIG_DIR=/elsewhere-claude");
    expect(out(s, "vars")).toContain("CODEX_HOME=/elsewhere-codex");
    expect(out(s, "env")).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("a signed-out Codex in an admin's run still pauses with the codex login text", async () => {
    const s = await go(flowOf(agent("a", "CODEX_SIGNED_OUT", "    agent: codex\n")), admin.id);
    expect(s.status).toBe("stopped");
    expect(s.reason).toContain('run "codex login"');
    expect(s.history[0]!.limited).toBe(true);
  });

  it("a user's run with the sandbox setting off runs as today, with no key and no refusal", async () => {
    process.env.SCF_USER_SANDBOX = "off";
    const s = await go(flowOf(agent("a", "SAY fine")), user.id);
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "a")).toMatch(/^fine/);
  });
});
