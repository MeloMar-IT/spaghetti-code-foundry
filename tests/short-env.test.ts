import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { SERVER_SETUP_ENV, SHORT_ENV, serverPassList, shortEnv, shortEnvRun } from "../src/engine/short-env.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { parseFlow } from "../src/flow/load.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const conf = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ protected_branches: [], ...over });
const names = (env: Record<string, string>) => Object.keys(env).sort();

describe("shortEnv", () => {
  const source = {
    PATH: "/bin",
    HOME: "/home/x",
    FACTORY_HOME: "/f",
    SECRET_X: "s",
    ANTHROPIC_API_KEY: "a",
    OPENAI_API_KEY: "o",
    FACTORY_BOT_TOKEN: "b",
    GH_TOKEN: "g",
    JAVA_HOME: "/jdk",
    LC_TIME: "C",
    AWS_SECRET_ACCESS_KEY: "aws",
  };

  it("a shell step keeps the short list and the server's folder, and drops everything else", () => {
    const env = shortEnv({}, conf(), undefined, source);
    expect(names(env)).toEqual(["FACTORY_HOME", "HOME", "PATH"]);
    for (const n of SHORT_ENV) expect(typeof n).toBe("string");
    expect(SERVER_SETUP_ENV).toContain("FACTORY_HOME");
  });

  it("names on the lists are passed; agent_pass only to agent steps", () => {
    const c = conf({ step_env: { pass: ["JAVA_HOME", "LC_*"], agent_pass: ["AWS_*"] } });
    const shell = shortEnv({}, c, undefined, source);
    expect(shell.JAVA_HOME).toBe("/jdk");
    expect(shell.LC_TIME).toBe("C");
    expect(shell.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(shortEnv({}, c, { agent: "claude", kind: "anthropic" }, source).AWS_SECRET_ACCESS_KEY).toBe("aws");
  });

  it("the step's own env wins; undefined removes", () => {
    const env = shortEnv({ GH_TOKEN: undefined, PATH: "/x", FACTORY_X: "1" }, conf(), undefined, { ...source });
    expect(env.PATH).toBe("/x");
    expect(env.FACTORY_X).toBe("1");
    expect(Object.values(env)).not.toContain(undefined);
    expect(shortEnv({ HOME: undefined }, conf(), undefined, source).HOME).toBeUndefined();
  });

  const agentSource = {
    ANTHROPIC_API_KEY: "a",
    ANTHROPIC_BASE_URL: "u",
    CLAUDE_CODE_OAUTH_TOKEN: "c",
    CLAUDE_CONFIG_DIR: "d",
    OPENAI_API_KEY: "o",
    CODEX_API_KEY: "x",
    CODEX_HOME: "h",
  };

  it("claude on anthropic gets its own login and not the other agent's keys", () => {
    const env = shortEnv({}, conf(), { agent: "claude", kind: "anthropic" }, agentSource);
    expect(names(env)).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"]);
  });

  it("claude on another provider gets no Anthropic key", () => {
    const env = shortEnv({}, conf(), { agent: "claude", kind: "anthropic-compatible" }, agentSource);
    expect(names(env)).toEqual(["CLAUDE_CONFIG_DIR"]);
  });

  it("codex on openai and on ollama: the mirror cases", () => {
    expect(names(shortEnv({}, conf(), { agent: "codex", kind: "openai" }, agentSource))).toEqual(["CODEX_API_KEY", "CODEX_HOME", "OPENAI_API_KEY"]);
    expect(names(shortEnv({}, conf(), { agent: "codex", kind: "ollama" }, agentSource))).toEqual(["CODEX_HOME"]);
  });

  it("same-prefix secrets pass for no agent and no provider kind", () => {
    const src = { ANTHROPIC_OTHER_SECRET: "1", CLAUDE_PRIVATE_TOKEN: "2", CLAUDE_CODE_USE_BEDROCK: "3", OPENAI_OTHER_SECRET: "4", CODEX_OTHER_SECRET: "5" };
    for (const agent of ["claude", "codex"] as const) {
      for (const kind of ["anthropic", "anthropic-compatible", "openai", "ollama", "lmstudio"] as const) expect(shortEnv({}, conf(), { agent, kind }, src)).toEqual({});
    }
    expect(shortEnv({}, conf(), undefined, src)).toEqual({});
  });

  it("a list can open a prefix, but never gives a key variable", () => {
    const src = { ...agentSource, ANTHROPIC_OTHER_SECRET: "1", ANTHROPIC_AUTH_TOKEN: "t" };
    const c = conf({ step_env: { agent_pass: ["ANTHROPIC_*"] } });
    expect(shortEnv({}, c, { agent: "codex", kind: "openai" }, src).ANTHROPIC_OTHER_SECRET).toBe("1");
    const codex = shortEnv({}, c, { agent: "codex", kind: "openai" }, src);
    expect(codex.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codex.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(shortEnv({}, conf({ step_env: { pass: ["OPENAI_API_KEY"] } }), undefined, src).OPENAI_API_KEY).toBeUndefined();
  });

  it("a configured api_key_env never passes, even when listed or matched by a prefix", () => {
    const c = conf({
      providers: { p: { kind: "anthropic-compatible", base_url: "http://x", api_key_env: "MY_PROXY_KEY" }, q: { kind: "anthropic-compatible", base_url: "http://y", api_key_env: "ANTHROPIC_PROXY_KEY" } },
      step_env: { pass: ["MY_PROXY_KEY", "ANTHROPIC_*"], agent_pass: ["ANTHROPIC_*"] },
    });
    const src = { MY_PROXY_KEY: "k", ANTHROPIC_PROXY_KEY: "k2" };
    expect(shortEnv({}, c, undefined, src)).toEqual({});
    expect(shortEnv({}, c, { agent: "claude", kind: "anthropic-compatible" }, src)).toEqual({});
  });
});

describe("a key variable that has a reserved name", () => {
  it("is not passed on the strength of the fixed or agent lists", () => {
    const c = conf({ providers: { p: { kind: "anthropic-compatible", base_url: "http://x", api_key_env: "HOME" }, q: { kind: "anthropic-compatible", base_url: "http://y", api_key_env: "CLAUDE_CONFIG_DIR" }, r: { kind: "anthropic-compatible", base_url: "http://z", api_key_env: "OPENAI_API_KEY" } } });
    const src = { HOME: "/h", CLAUDE_CONFIG_DIR: "d", OPENAI_API_KEY: "o", FACTORY_HOME: "/f", PATH: "/bin" };
    expect(shortEnv({}, c, undefined, src)).toEqual({ FACTORY_HOME: "/f", PATH: "/bin" });
    expect(shortEnv({}, c, { agent: "claude", kind: "anthropic-compatible" }, src)).toEqual({ FACTORY_HOME: "/f", PATH: "/bin" });
    expect(shortEnv({}, c, { agent: "codex", kind: "openai" }, src).OPENAI_API_KEY).toBe("o"); // codex's own login
  });
});

describe("serverPassList", () => {
  it("keeps valid names and drops the rest", () => {
    expect(serverPassList({ FACTORY_STEP_ENV_PASS: "FAKE_*, A1 ,GH_TOKEN,bad-name," })).toEqual(["FAKE_*", "A1"]);
    expect(serverPassList({ SCF_STEP_ENV_PASS: "X_*", FACTORY_STEP_ENV_PASS: "Y" })).toEqual(["X_*", "Y"]);
    expect(serverPassList({})).toEqual([]);
  });
});

describe("the setting step_env", () => {
  it("defaults to two empty lists", () => {
    expect(conf().step_env).toEqual({ pass: [], agent_pass: [] });
  });
  it("refuses names a user's run may not get", () => {
    for (const bad of ["GH_TOKEN", "GIT_DIR", "FACTORY_X", "SCF_X", "*", "A*", "a-b"]) expect(() => conf({ step_env: { pass: [bad] } }), bad).toThrow();
    for (const bad of ["GH_TOKEN", "*"]) expect(() => conf({ step_env: { agent_pass: [bad] } }), bad).toThrow();
  });
  it("accepts names and prefixes", () => {
    expect(() => conf({ step_env: { pass: ["JAVA_HOME", "AWS_*"], agent_pass: ["ANTHROPIC_*"] } })).not.toThrow();
  });
});

// ---- whole runs ---------------------------------------------------------------------------------------------

const MARKERS = ["SERVER_MARKER_FOR_TEST", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_OTHER_SECRET", "CLAUDE_PRIVATE_TOKEN", "OPENAI_OTHER_SECRET", "EXTRA_FOR_TEST", "PROVIDER_KEY_FOR_TEST"];
let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let admin: { id: string };
let user: { id: string };
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries([...MARKERS, "FACTORY_HOME"].map((k) => [k, process.env[k]]));
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  resetRedactCache();
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
  Object.assign(process.env, {
    SERVER_MARKER_FOR_TEST: "marker-value",
    OPENAI_API_KEY: "sk-openai-0123456789",
    ANTHROPIC_API_KEY: "sk-anthropic-0123456789",
    ANTHROPIC_OTHER_SECRET: "other-a",
    CLAUDE_PRIVATE_TOKEN: "other-b",
    OPENAI_OTHER_SECRET: "other-c",
    EXTRA_FOR_TEST: "extra-value",
  });
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetRedactCache();
  kc.remove();
  gh.restore();
});

const flowOf = (steps: string) => parseFlow(`name: short\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${steps}`, "short.yaml");
const agent = (id: string, prompt: string, extra = "") => `  - id: ${id}\n    type: claude\n${extra}    prompt: ${JSON.stringify(prompt)}\n`;
const sh = (id: string, run: string, extra = "") => `  - id: ${id}\n    type: shell\n${extra}    run: ${JSON.stringify(run)}\n`;
const THREE = sh("sh", "env | cut -d= -f1 | sort | tr '\\n' ' '") + agent("cl", "SHOWALLENV") + agent("cx", "SHOWALLENV", "    agent: codex\n");
const go = (flow: ReturnType<typeof flowOf>, owner: string | undefined, config: Config = conf()) =>
  runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: join(gh.tmp, "runs"), claudeBin, codexBin, vars: { github_repo: "acme/app" }, config, ...(owner ? { owner } : {}) });
const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
const set = (text: string) => new Set(text.replace(/^env:/, "").trim().split(/\s+/));

describe("a user's run", () => {
  it("shows no step the server's other variables", async () => {
    addRepo(user.id, { url: "acme/app", method: "none" });
    const s = await go(flowOf(THREE), user.id);
    const [shell, claude, codex] = [set(out(s, "sh")), set(out(s, "cl")), set(out(s, "cx"))];
    for (const seen of [shell, claude, codex]) for (const n of ["SERVER_MARKER_FOR_TEST", "ANTHROPIC_OTHER_SECRET", "CLAUDE_PRIVATE_TOKEN", "OPENAI_OTHER_SECRET", "EXTRA_FOR_TEST"]) expect(seen.has(n), n).toBe(false);
    for (const n of ["PATH", "HOME", "FACTORY_TASK", "GIT_AUTHOR_NAME"]) expect(shell.has(n), n).toBe(true);
    expect(shell.has("ANTHROPIC_API_KEY")).toBe(false);
    expect(shell.has("OPENAI_API_KEY")).toBe(false);
    expect(claude.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(claude.has("OPENAI_API_KEY")).toBe(false);
    expect(codex.has("OPENAI_API_KEY")).toBe(true);
    expect(codex.has("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("step_env.pass reaches all three steps, agent_pass only the agents", async () => {
    addRepo(user.id, { url: "acme/app", method: "none" });
    const all = await go(flowOf(THREE), user.id, conf({ step_env: { pass: ["EXTRA_FOR_TEST"] } }));
    for (const id of ["sh", "cl", "cx"]) expect(set(out(all, id)).has("EXTRA_FOR_TEST"), id).toBe(true);
    const agents = await go(flowOf(THREE), user.id, conf({ step_env: { agent_pass: ["EXTRA_FOR_TEST"] } }));
    expect(set(out(agents, "sh")).has("EXTRA_FOR_TEST")).toBe(false);
    for (const id of ["cl", "cx"]) expect(set(out(agents, id)).has("EXTRA_FOR_TEST"), id).toBe(true);
  });

  it("gives a Claude step on a compatible provider the key as token, but not as a variable", async () => {
    addRepo(user.id, { url: "acme/app", method: "none" });
    process.env.PROVIDER_KEY_FOR_TEST = "provider-key-0123456789";
    const config = conf({ providers: { gh: { kind: "anthropic-compatible", base_url: "http://127.0.0.1:1", api_key_env: "PROVIDER_KEY_FOR_TEST" } } });
    const s = await go(flowOf(agent("tok", "SHOWENV", "    model: gh:m\n") + agent("all", "SHOWALLENV", "    model: gh:m\n")), user.id, config);
    expect(out(s, "tok")).toContain("token=[redacted]"); // it reached the agent, and its value is hidden in the output
    const seen = set(out(s, "all"));
    expect(seen.has("PROVIDER_KEY_FOR_TEST")).toBe(false);
    expect(seen.has("ANTHROPIC_API_KEY")).toBe(false);
  });

  it("puts no server variable into a sandboxed step", async () => {
    addRepo(user.id, { url: "acme/app", method: "none" });
    writeFileSync(join(gh.tmp, "bin", "docker"), '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\n', { mode: 0o755 });
    const config = conf({ sandbox: { docker_image: "img" }, step_env: { pass: ["EXTRA_FOR_TEST"] } });
    const s = await go(flowOf(sh("box", "true", "    sandbox: true\n")), user.id, config);
    const o = out(s, "box");
    expect(o).toContain("arg:img");
    for (const n of ["SERVER_MARKER_FOR_TEST", "EXTRA_FOR_TEST"]) expect(o).not.toContain(`arg:${n}\n`);
  });
});

describe("runs that keep the machine's environment", () => {
  const SHELL = sh("sh", "echo marker=$SERVER_MARKER_FOR_TEST");
  it("an admin's run and a run without an owner see the server's variables", async () => {
    addRepo(admin.id, { url: "acme/app", method: "none" });
    expect(out(await go(flowOf(SHELL), admin.id), "sh")).toBe("marker=marker-value");
    expect(out(await go(flowOf(SHELL), undefined), "sh")).toBe("marker=marker-value");
  });
  it("an admin's run with a stored sign-in still sees them", async () => {
    addRepo(admin.id, { url: "acme/app", method: "github-token", token: ["github", "pat", ""].join("_") + "Zx9".repeat(12) });
    expect(out(await go(flowOf(SHELL), admin.id), "sh")).toBe("marker=marker-value");
  });
});
