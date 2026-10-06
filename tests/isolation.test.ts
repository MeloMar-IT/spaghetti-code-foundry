import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentEnv } from "../src/agents/run.js";
import { claudeProviderEnv, type Target } from "../src/agents/targets.js";
import { addRepo, hasStoredSignIn, listRepos } from "../src/auth/repos.js";
import { createUser, deleteUser, updateUser } from "../src/auth/users.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { NO_COMMIT_IDENTITY } from "../src/engine/guards.js";
import { commitIdentity, isolationEnv, stepIsolated, tokenVarNames } from "../src/engine/isolation.js";
import { runFlow } from "../src/engine/runner.js";
import { explainFailure } from "../src/failure-explain.js";
import { parseFlow } from "../src/flow/load.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);
const BOT = ["ghp", ""].join("_") + "Bot".repeat(12);
const SERVER = ["ghp", ""].join("_") + "Srv".repeat(12);
const TOKEN_NAMES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "BOT_TOKEN_FOR_TEST"];
const SAVED = [...TOKEN_NAMES, "GH_CONFIG_DIR", "SSH_AUTH_SOCK", "FAKE_GH_EXPECT_TOKEN", "FAKE_EXPLAIN", "FAKE_EXPLAIN_VARS", "FACTORY_NO_FAILURE_MODEL"];

let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let admin: { id: string };
let user: { id: string };
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  kc = fakeKeychain();
  admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
  const serverGh = join(gh.tmp, "server-gh");
  mkdirSync(serverGh);
  writeFileSync(join(serverGh, "hosts.yml"), "github.com:\n  oauth_token: x\n");
  Object.assign(process.env, { GH_TOKEN: SERVER, GITHUB_TOKEN: SERVER, GH_ENTERPRISE_TOKEN: SERVER, BOT_TOKEN_FOR_TEST: BOT, GH_CONFIG_DIR: serverGh, SSH_AUTH_SOCK: "/tmp/agent.sock", FAKE_GH_EXPECT_TOKEN: TOKEN });
  delete process.env.FAKE_EXPLAIN;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  kc.remove();
  gh.restore();
});

const runs = () => join(gh.tmp, "runs");
const cfg = (over: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], bot: { gh_token_env: "BOT_TOKEN_FOR_TEST" }, ...over });
const flowOf = (steps: string, github = "github_repo: acme/app") => parseFlow(`name: iso\nworkspace: empty\nvars: { ${github} }\nsteps:\n${steps}`, "iso.yaml");
const sh = (id: string, run: string, extra = "") => `  - id: ${id}\n    type: shell\n${extra}    run: ${JSON.stringify(run)}\n`;
const agent = (id: string, prompt: string, extra = "") => `  - id: ${id}\n    type: claude\n${extra}    prompt: ${JSON.stringify(prompt)}\n`;
const go = (flow: ReturnType<typeof flowOf>, extra: { owner?: string; config?: Config; vars?: Record<string, string> } = {}) =>
  runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: runs(), claudeBin, codexBin, vars: { github_repo: "acme/app" }, config: cfg(), ...extra });
const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
const tokenRepo = (owner: { id: string }, url = "acme/app") => addRepo(owner.id, { url, method: "github-token", token: TOKEN });
const noneRepo = (owner: { id: string }, url = "acme/app") => addRepo(owner.id, { url, method: "none" });

const SHOW = TOKEN_NAMES.map((n) => `${n}=\${${n}:-unset}`).join(" ");
const PLAIN = `echo "${SHOW} sock=\${SSH_AUTH_SOCK:-unset} global=\${GIT_CONFIG_GLOBAL:-unset} prompt=\${GIT_TERMINAL_PROMPT:-unset} dir=$GH_CONFIG_DIR"`;
const SHOWVARS = `SHOWVARS ${TOKEN_NAMES.join(" ")} SSH_AUTH_SOCK GIT_CONFIG_GLOBAL GIT_TERMINAL_PROMPT\nSHOWGHDIR`;

describe("the pure functions", () => {
  it("stepIsolated: users always, admins only with a stored sign-in, fail closed", async () => {
    expect(stepIsolated(undefined, "acme/app")).toBe(false);
    tokenRepo(admin, "acme/token");
    noneRepo(admin, "acme/none");
    tokenRepo(user, "acme/utoken");
    for (const repo of ["acme/utoken", "acme/token", "acme/none", "acme/other", undefined]) expect(stepIsolated(user.id, repo)).toBe(true);
    expect(stepIsolated(admin.id, "acme/none")).toBe(false);
    expect(stepIsolated(admin.id, "acme/other")).toBe(false);
    expect(stepIsolated(admin.id, "")).toBe(false);
    expect(stepIsolated(admin.id, "acme/token")).toBe(true);
    expect(stepIsolated("no-such-id", "acme/none")).toBe(true);
    writeFileSync(join(process.env.FACTORY_HOME!, "repos.json"), "{broken");
    expect(stepIsolated(admin.id, "acme/none")).toBe(true);
  });

  it("hasStoredSignIn: any case, .git, ssh address; not for method none or another account; sets no last used", () => {
    tokenRepo(user, "Acme/App");
    noneRepo(user, "acme/none");
    expect(hasStoredSignIn(user.id, "acme/app")).toBe(true);
    expect(hasStoredSignIn(user.id, "ACME/APP.git")).toBe(true);
    addRepo(user.id, { url: "git@github.com:acme/ssh.git", method: "ssh-deploy-key" });
    expect(hasStoredSignIn(user.id, "acme/ssh")).toBe(true);
    expect(hasStoredSignIn(user.id, "acme/none")).toBe(false);
    expect(hasStoredSignIn(admin.id, "acme/app")).toBe(false);
    expect(hasStoredSignIn(user.id, "not a name")).toBe(false);
    expect(listRepos(user.id).every((r) => !("lastUsed" in r) || !r.lastUsed)).toBe(true);
  });

  it("commitIdentity: the bot field by field, else the owner, else nothing", async () => {
    const both = ConfigSchema.parse({ bot: { name: "Bot", email: "bot@example.com" } });
    expect(commitIdentity(both, user.id)).toEqual({ name: "Bot", email: "bot@example.com" });
    expect(commitIdentity(ConfigSchema.parse({ bot: { name: "Bot" } }), user.id)).toEqual({ name: "Bot", email: "user@example.com" });
    expect(commitIdentity(ConfigSchema.parse({}), user.id)).toEqual({ name: "User", email: "user@example.com" });
    expect(commitIdentity(both, "gone")).toEqual({ name: "Bot", email: "bot@example.com" });
    expect(commitIdentity(ConfigSchema.parse({ bot: { name: "Bot" } }), "gone")).toBeUndefined();
    expect(commitIdentity(ConfigSchema.parse({}), "gone")).toBeUndefined();
    expect(commitIdentity(ConfigSchema.parse({}), undefined)).toBeUndefined();
  });

  it("tokenVarNames: the four, the bot's own and the twin prefix", () => {
    expect(tokenVarNames(ConfigSchema.parse({}))).toEqual(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);
    expect(tokenVarNames(ConfigSchema.parse({ bot: { gh_token_env: "X" } }))).toContain("X");
    expect(tokenVarNames(ConfigSchema.parse({ bot: { gh_token_env: "FACTORY_X" } }))).toEqual(expect.arrayContaining(["FACTORY_X", "SCF_X"]));
    expect(tokenVarNames(ConfigSchema.parse({ bot: { gh_token_env: "SCF_X" } }))).toEqual(expect.arrayContaining(["SCF_X", "FACTORY_X"]));
  });

  it("isolationEnv appends to the git config entries and removes tokens, the agent and ssh", () => {
    const e = isolationEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath" }, ConfigSchema.parse({ bot: { gh_token_env: "X" } }), "/g", { name: "N", email: "e@x" });
    expect(e.GIT_CONFIG_COUNT).toBe("4");
    expect("GIT_CONFIG_KEY_0" in e).toBe(false);
    for (const i of [1, 2, 3]) expect(e[`GIT_CONFIG_KEY_${i}`]).toBeTruthy();
    for (const n of [...tokenVarNames(ConfigSchema.parse({ bot: { gh_token_env: "X" } })), "SSH_AUTH_SOCK", "GIT_SSH", "SSH_ASKPASS"]) {
      expect(n in e, n).toBe(true);
      expect(e[n], n).toBeUndefined();
    }
    expect(e).toMatchObject({ GH_CONFIG_DIR: "/g", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "N", GIT_COMMITTER_EMAIL: "e@x" });
  });

  it("agentEnv drops the login, git and ssh names only in an isolated step", () => {
    const spec = "GH_TOKEN=x; GH_ENTERPRISE_TOKEN=x; GH_CONFIG_DIR=/x; GIT_CONFIG_COUNT=0; SSH_AUTH_SOCK=/x; XDG_CONFIG_HOME=/x; JAVA_HOME=/opt/jdk";
    expect(agentEnv(spec, true)).toEqual({ JAVA_HOME: "/opt/jdk" });
    expect(Object.keys(agentEnv(spec))).toEqual(["GH_ENTERPRISE_TOKEN", "GH_CONFIG_DIR", "GIT_CONFIG_COUNT", "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "JAVA_HOME"]);
  });
});

describe("a provider key", () => {
  const target = (api_key_env: string) => ({ providerName: "p", model: "m", provider: { kind: "anthropic-compatible", base_url: "http://x", api_key_env } }) as unknown as Target;

  it("never takes a GitHub token variable as the provider's key", () => {
    const never = tokenVarNames(cfg());
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "BOT_TOKEN_FOR_TEST"]) expect(claudeProviderEnv(target(name), never).ANTHROPIC_AUTH_TOKEN, name).toBe("none");
    process.env.PROVIDER_KEY_FOR_TEST = "pk";
    expect(claudeProviderEnv(target("PROVIDER_KEY_FOR_TEST"), never).ANTHROPIC_AUTH_TOKEN).toBe("pk");
    delete process.env.PROVIDER_KEY_FOR_TEST;
  });
});

describe("a provider key in an admin run that keeps the machine's login", { timeout: 60_000 }, () => {
  it("may still be a token variable", async () => {
    noneRepo(admin);
    process.env.PROVIDER_KEY_FOR_TEST = "pk";
    const config = cfg({ providers: { gh: { kind: "anthropic-compatible", base_url: "http://127.0.0.1:1", api_key_env: "BOT_TOKEN_FOR_TEST" } } });
    const s = await go(flowOf(agent("a", "SHOWENV", "    model: gh:m\n")), { owner: admin.id, config });
    delete process.env.PROVIDER_KEY_FOR_TEST;
    expect(out(s, "a")).toContain(`token=${BOT}`);
  });
});

describe("a user run", { timeout: 60_000 }, () => {
  const steps = (codex = true) =>
    `${sh("marked", PLAIN, "    repo_access: true\n")}${sh("plain", PLAIN)}${agent("agent", SHOWVARS)}${codex ? agent("codexagent", SHOWVARS, "    model: codex:gpt-5\n") : ""}`;

  it("gives no step a token or the machine's gh login; a marked step only the repository's token", async () => {
    tokenRepo(user);
    const s = await go(flowOf(steps()), { owner: user.id });
    expect(s.status, s.reason).toBe("succeeded");
    const own = /dir=(\S+)/.exec(out(s, "plain"))![1]!;
    expect(own).not.toBe(process.env.GH_CONFIG_DIR);
    expect(existsSync(own)).toBe(false);
    expect(out(s, "plain")).toBe(`${TOKEN_NAMES.map((n) => `${n}=unset`).join(" ")} sock=unset global=/dev/null prompt=0 dir=${own}`);
    for (const id of ["agent", "codexagent"]) {
      const o = out(s, id);
      expect(o, id).toContain("gh_dir=empty");
      for (const n of TOKEN_NAMES) expect(o, id).toContain(`${n}=(unset)`);
      expect(o, id).toContain("SSH_AUTH_SOCK=(unset)");
      expect(o, id).toContain("GIT_CONFIG_GLOBAL=/dev/null");
      expect(o, id).toContain("GIT_TERMINAL_PROMPT=0");
    }
    expect(out(s, "marked")).toMatch(/^GH_TOKEN=\[redacted\] GITHUB_TOKEN=unset GH_ENTERPRISE_TOKEN=unset BOT_TOKEN_FOR_TEST=unset sock=unset /);
    expect(readdirSync(tmpdir()).filter((f) => f.startsWith("scf-gh-") && existsSync(join(tmpdir(), f, "hosts.yml")))).toEqual([]);
  });

  it("is isolated on a repository without a stored sign-in, and without a repository", async () => {
    noneRepo(user);
    for (const vars of [{ github_repo: "acme/app" }, { github_repo: "" }]) {
      const s = await go(flowOf(`${sh("plain", PLAIN)}${agent("agent", SHOWVARS)}`, `github_repo: "${vars.github_repo}"`), { owner: user.id, vars });
      expect(s.status, s.reason).toBe("succeeded");
      expect(out(s, "plain")).toContain("GH_TOKEN=unset GITHUB_TOKEN=unset");
      expect(out(s, "agent")).toContain("gh_dir=empty");
      expect(out(s, "agent")).toContain("BOT_TOKEN_FOR_TEST=(unset)");
    }
  });

  it("does not need the bot's token variable to exist", async () => {
    tokenRepo(user);
    delete process.env.BOT_TOKEN_FOR_TEST;
    const s = await go(flowOf(sh("plain", "echo ok")), { owner: user.id });
    expect(s.status, s.reason).toBe("succeeded");
  });

  it("keeps --strict-mcp-config for the agent even with isolate_agents off", async () => {
    tokenRepo(user);
    const s = await go(flowOf(agent("a", "hello")), { owner: user.id, config: cfg({ isolate_agents: false }) });
    expect(out(s, "a")).toContain("--strict-mcp-config");
    const adm = await go(flowOf(agent("a", "hello")), { owner: admin.id, config: cfg({ isolate_agents: false }) });
    expect(out(adm, "a")).toContain("args=");
    expect(out(adm, "a")).not.toContain("--strict-mcp-config");
  });

  it("agent_env cannot bring a token or a machine setting back", async () => {
    tokenRepo(user);
    const flow = flowOf(agent("a", "SHOWVARS GH_TOKEN GH_CONFIG_DIR GIT_CONFIG_COUNT SSH_AUTH_SOCK JAVA_HOME GIT_CONFIG_KEY_0"), "github_repo: acme/app, agent_env: 'GH_TOKEN=x; GH_CONFIG_DIR=/srv; GIT_CONFIG_COUNT=0; SSH_AUTH_SOCK=/x; JAVA_HOME=/opt/jdk'");
    const s = await go(flow, { owner: user.id, config: cfg({ protected_branches: ["main"] }) });
    const o = out(s, "a");
    expect(o).toContain("GH_TOKEN=(unset)");
    expect(o).not.toContain("GH_CONFIG_DIR=/srv");
    expect(o).not.toContain("GIT_CONFIG_COUNT=0");
    expect(o).toContain("SSH_AUTH_SOCK=(unset)");
    expect(o).toContain("JAVA_HOME=/opt/jdk");
    expect(o).toContain("GIT_CONFIG_KEY_0=core.hooksPath");
  });

  it("explains a failure without any token variable", async () => {
    tokenRepo(user);
    delete process.env.FACTORY_NO_FAILURE_MODEL;
    process.env.FAKE_EXPLAIN = "ARGS";
    process.env.FAKE_EXPLAIN_VARS = "BOT_TOKEN_FOR_TEST";
    const s = await runFlow(flowOf(sh("bad", "exit 1")), { task: "t", repo: gh.tmp, runsDir: runs(), claudeBin, vars: { github_repo: "acme/app" }, config: cfg(), owner: user.id });
    expect(s.status).toBe("failed");
    expect(s.failureNote?.why ?? "").toMatch(/gh=$/);
    const direct = await explainFailure({ run: s, config: cfg(), runsDir: runs(), claudeBin });
    expect(direct?.note?.why ?? "").toMatch(/gh=$/);
  });
});

describe("an admin run", { timeout: 60_000 }, () => {
  it("keeps the machine's login on a repository without a stored sign-in", async () => {
    noneRepo(admin);
    for (const [vars, github] of [[{ github_repo: "acme/app" }, "acme/app"], [{ github_repo: "acme/unlisted" }, "acme/unlisted"], [{ github_repo: "" }, ""]] as const) {
      const s = await go(flowOf(`${sh("plain", `echo "$GH_TOKEN|$GH_CONFIG_DIR|$SSH_AUTH_SOCK|\${GIT_CONFIG_GLOBAL-unset}|$GIT_AUTHOR_NAME"`)}${agent("agent", "SHOWGH")}`, `github_repo: "${github}"`), {
        owner: admin.id,
        vars,
        config: cfg({ bot: { gh_token_env: "BOT_TOKEN_FOR_TEST", name: "The Bot", email: "bot@example.com" } }),
      });
      expect(out(s, "plain")).toBe(`${BOT}|${process.env.GH_CONFIG_DIR}|/tmp/agent.sock|unset|The Bot`);
      expect(out(s, "agent")).toContain("gh_token=other");
    }
  });

  it("agent_env still wins over the bot name where the machine's login is kept", async () => {
    noneRepo(admin);
    const flow = flowOf(agent("a", "SHOWVARS GIT_AUTHOR_NAME"), "github_repo: acme/app, agent_env: 'GIT_AUTHOR_NAME=x'");
    const s = await go(flow, { owner: admin.id, config: cfg({ bot: { gh_token_env: "BOT_TOKEN_FOR_TEST", name: "The Bot" } }) });
    expect(out(s, "a")).toMatch(/^GIT_AUTHOR_NAME=x\n/);
  });

  it("is isolated on a repository with a stored sign-in and does not ask for the bot's token", async () => {
    tokenRepo(admin);
    delete process.env.BOT_TOKEN_FOR_TEST;
    const s = await go(flowOf(`${sh("plain", PLAIN)}${agent("agent", SHOWVARS)}`), { owner: admin.id });
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "plain")).toContain("GH_TOKEN=unset GITHUB_TOKEN=unset");
    expect(out(s, "agent")).toContain("gh_dir=empty");
  });

  it("still fails before any step when the bot's token variable is missing and the run keeps the machine's login", async () => {
    noneRepo(admin);
    delete process.env.BOT_TOKEN_FOR_TEST;
    const s = await go(flowOf(sh("plain", "echo ok")), { owner: admin.id });
    expect(s.status).toBe("failed");
    expect(s.history).toEqual([]);
    expect(s.reason).toMatch(/bot\.gh_token_env is "BOT_TOKEN_FOR_TEST"/);
  });

  it("isolates a step of a sub-flow that sets a repository with a stored sign-in, and not the outer one", async () => {
    noneRepo(admin, "acme/none");
    tokenRepo(admin, "acme/token");
    const show = sh("plain", 'echo "t=${GH_TOKEN:-none}"');
    writeFileSync(join(gh.tmp, ".claude-factory", "flows", "inner-iso.yaml"), `name: inner-iso\nworkspace: empty\nsteps:\n${show}`);
    const flow = flowOf(`${show}  - id: sub\n    type: flow\n    flow: inner-iso\n    vars: { github_repo: acme/token }\n`, "github_repo: acme/none");
    const s = await go(flow, { owner: admin.id, vars: { github_repo: "acme/none" } });
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "plain")).toBe(`t=${BOT}`);
    expect(out(s, "sub/plain")).toBe("t=none");
  });

  it("is isolated from the next step on when the owner becomes a plain user", async () => {
    noneRepo(admin);
    await createUser({ name: "Admin2", email: "admin2@example.com", password: TEST_PASSWORD, role: "admin" });
    const flow = flowOf(sh("second", 'echo "t=${GH_TOKEN:-none}"'));
    expect(out(await go(flow, { owner: admin.id }), "second")).toBe(`t=${BOT}`);
    await updateUser(admin.id, { role: "user" });
    expect(out(await go(flow, { owner: admin.id }), "second")).toBe("t=none");
  });
});

describe("commits", { timeout: 60_000 }, () => {
  const COMMIT = "git init -q . && git commit -q --allow-empty -m x && git log -1 --format='%an <%ae>|%cn <%ce>'";

  it("use the bot, else the owner's name and e-mail, in every kind of step, whatever .git/config says", async () => {
    tokenRepo(user);
    const flow = flowOf(`${sh("plain", `git init -q . && git config user.name Intruder && ${COMMIT.replace("git init -q . && ", "")}`)}`);
    const a = await go(flow, { owner: user.id, config: cfg({ bot: {} }) });
    expect(out(a, "plain")).toBe("User <user@example.com>|User <user@example.com>");
    const b = await go(flow, { owner: user.id, config: cfg({ bot: { name: "Bot", email: "bot@example.com" } }) });
    expect(out(b, "plain")).toBe("Bot <bot@example.com>|Bot <bot@example.com>");
    const c = await go(flow, { owner: user.id, config: cfg({ bot: { name: "Bot" } }) });
    expect(out(c, "plain")).toBe("Bot <user@example.com>|Bot <user@example.com>");
    const marked = await go(flowOf(sh("m", COMMIT, "    repo_access: true\n")), { owner: user.id, config: cfg({ bot: {} }) });
    expect(out(marked, "m")).toBe("User <user@example.com>|User <user@example.com>");
  });

  it("fail when the identity variables are missing: git never guesses a name", async () => {
    tokenRepo(user);
    const s = await go(flowOf(sh("c", "git init -q . && env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u GIT_COMMITTER_EMAIL git commit -q --allow-empty -m x")), { owner: user.id });
    expect(s.status).toBe("failed");
  });

  it("stop the run before the step when no name is known (the account is gone)", async () => {
    tokenRepo(user);
    await createUser({ name: "Other", email: "other@example.com", password: TEST_PASSWORD, role: "admin" });
    deleteUser(user.id);
    const marker = join(gh.tmp, "ran");
    const flow = flowOf(`${sh("c", `touch ${marker}`, "    on_failure: other\n")}${sh("other", `touch ${marker}-other`)}`);
    for (const bot of [{}, { name: "Bot" }]) {
      const s = await go(flow, { owner: user.id, config: cfg({ bot }) });
      expect(s.status).toBe("failed");
      expect(s.reason).toBe(`step "c" failed: ${NO_COMMIT_IDENTITY}`);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(`${marker}-other`)).toBe(false);
      expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toContain(NO_COMMIT_IDENTITY);
      expect(readdirSync(tmpdir()).filter((f) => f.startsWith("scf-gh-") && existsSync(join(tmpdir(), f)) && readdirSync(join(tmpdir(), f)).length)).toEqual([]);
    }
    const a = await go(flowOf(agent("g", "SAY hi", "    on_failure: other\n") + sh("other", `touch ${marker}-other`)), { owner: user.id });
    expect(a.reason).toBe(`step "g" failed: ${NO_COMMIT_IDENTITY}`);
    expect(existsSync(`${marker}-other`)).toBe(false);
    const ok = await go(flowOf(sh("c", `git init -q . && git commit -q --allow-empty -m x && git log -1 --format=%an`)), { owner: user.id, config: cfg({ bot: { name: "Bot", email: "bot@example.com" } }) });
    expect(out(ok, "c")).toBe("Bot");
  });
});

describe("hooks and containers", { timeout: 60_000 }, () => {
  it("keep blocking pushes to protected branches and secrets in an unflagged step of a user run", async () => {
    tokenRepo(user);
    const remote = join(gh.tmp, "remote.git");
    const secret = `ghp_${"a1B2c3D4e5".repeat(4)}`;
    const script = (branch: string, file = "") => `git clone -q ${remote} r && cd r && ${file}git push -q ${remote} HEAD:${branch} 2>&1; echo "rc=$?"`;
    const config = cfg({ protected_branches: ["main"], secret_scan: true });
    const main = await go(flowOf(sh("p", script("main", "echo hi > m.txt && git add m.txt && git commit -qm m && "))), { owner: user.id, config });
    expect(out(main, "p")).toMatch(/protected branch 'main' is blocked[\s\S]*rc=1/);
    const leak = await go(flowOf(sh("p", script("feature/x", `echo ${secret} > s.txt && git add s.txt && git commit -qm leak && `))), { owner: user.id, config });
    expect(out(leak, "p")).toMatch(/rc=1/);
    const clean = await go(flowOf(sh("p", script("feature/y", "echo hi > a.txt && git add a.txt && git commit -qm ok && "))), { owner: user.id, config });
    expect(out(clean, "p")).toMatch(/rc=0$/);
  });

  it("pass the four commit variables, and nothing of the machine, into a sandboxed step", async () => {
    tokenRepo(user);
    writeFileSync(join(gh.tmp, "bin", "docker"), '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; done\n', { mode: 0o755 });
    const config = cfg({ sandbox: { docker_image: "img" } });
    const s = await go(flowOf(sh("box", "true", "    sandbox: true\n")), { owner: user.id, config });
    const o = out(s, "box");
    for (const n of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) expect(o).toContain(`arg:${n}\n`);
    for (const n of ["GH_TOKEN", "BOT_TOKEN_FOR_TEST", "GH_CONFIG_DIR", "SSH_AUTH_SOCK", "GIT_CONFIG_COUNT"]) expect(o).not.toContain(`arg:${n}\n`);
  });
});
