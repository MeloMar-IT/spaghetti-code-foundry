import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noAgentKey } from "../src/agents/boxed.js";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { TOOLS_DIR } from "../src/engine/guards.js";
import { resetSandboxCache } from "../src/engine/os-sandbox.js";
import { runFlow } from "../src/engine/runner.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { parseFlow } from "../src/flow/load.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

// A user's agent steps run inside `sandbox-exec` on macOS, with the fake `claude` and `codex` (the real ones are never started here).
const basic = process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
if (!basic) console.warn(`os-sandbox-agent-run tests skipped: ${process.platform === "darwin" ? "sandbox-exec does not work here (perhaps this process is already inside a sandbox)" : "they need macOS"}`);

const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const hereGit = spawnSync("/usr/bin/which", ["git"], { encoding: "utf8" }).stdout.trim();
const config = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({ protected_branches: [], sandbox: { user_read: [resolve("tests/fixtures"), ...(hereGit ? [resolve(hereGit, "..")] : [])] }, ...over });

const VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "FACTORY_HOME", "FACTORY_LOCK_DIR", "SCF_USER_SANDBOX"];
let gh: ReturnType<typeof fakeGithub>;
let kc: FakeKeychain;
let admin: { id: string };
let user: { id: string };
let saved: Record<string, string | undefined>;
const runs = () => join(gh.tmp, "runs");

describe.skipIf(!basic)("a user's agent step in the OS sandbox", () => {
  beforeEach(async () => {
    saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    gh = fakeGithub();
    process.env.FACTORY_HOME = join(gh.tmp, "home");
    process.env.FACTORY_LOCK_DIR = join(gh.tmp, "home", "locks");
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
    delete process.env.SCF_USER_SANDBOX;
    for (const k of ["CODEX_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) delete process.env[k];
    process.env.ANTHROPIC_API_KEY = "sk-ant-dummy-0123456789";
    process.env.OPENAI_API_KEY = "sk-oai-dummy-0123456789";
    resetSandboxCache();
    kc = fakeKeychain();
    resetRedactCache();
    admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
    user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
    addRepo(user.id, { url: "acme/app", method: "none" });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(join(TOOLS_DIR, "zz-probe"), { force: true });
    resetSandboxCache();
    resetRedactCache();
    kc.remove();
    gh.restore();
  });

  const step = (id: string, agent: "claude" | "codex", prompt: string, extra = "") => `  - id: ${id}\n    type: claude\n    agent: ${agent}\n${extra}    prompt: ${JSON.stringify(prompt)}\n`;
  const flowOf = (...steps: string[]) => parseFlow(`name: boxed\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${steps.join("")}`, "boxed.yaml");
  const go = (flow: ReturnType<typeof flowOf>, owner: string, over: { vars?: Record<string, string>; config?: ReturnType<typeof config> } = {}) =>
    runFlow(flow, { task: "idea", repo: gh.tmp, runsDir: runs(), claudeBin, codexBin, vars: { github_repo: "acme/app", ...over.vars }, config: over.config ?? config(), owner });
  const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
  const AGENTS = ["claude", "codex"] as const;

  it("starts Claude and Codex in the profile with no own sandbox, private folders and the key", async () => {
    process.env.CLAUDE_CONFIG_DIR = "/elsewhere";
    const s = await go(
      flowOf(
        step("c1", "claude", "hello", "    sandbox: true\n"),
        step("c2", "claude", "SHOWVARS HOME TMPDIR CLAUDE_CONFIG_DIR CODEX_HOME"),
        step("c3", "claude", "SHOWALLENV"),
        step("x1", "codex", "hello"),
        step("x2", "codex", "SHOWVARS HOME TMPDIR CLAUDE_CONFIG_DIR CODEX_HOME"),
        step("x3", "codex", "SHOWALLENV"),
      ),
      user.id,
      { vars: { agent_env: "CODEX_HOME=/elsewhere" } },
    );
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "c1")).not.toContain("--settings");
    expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toContain("own sandbox is off");
    expect(out(s, "x1")).toContain('sandbox_mode="danger-full-access"');
    // a boxed step keeps its path: no isolation flag, no agent note, no "Codex:" line
    expect(out(s, "x1")).not.toContain("--ignore-user-config");
    expect(out(s, "x1")).not.toContain("<instructions>");
    expect(readFileSync(join(s.runDir, "live.log"), "utf8")).not.toContain("Codex:");
    for (const id of ["c2", "x2"]) {
      const o = out(s, id);
      expect(o).toContain(`HOME=${s.runDir}/home`);
      expect(o).toContain(`TMPDIR=${s.runDir}/tmp`);
      expect(o).toContain(`CLAUDE_CONFIG_DIR=${s.runDir}/home/.claude`);
      expect(o).toContain(`CODEX_HOME=${s.runDir}/home/.codex`);
    }
    expect(out(s, "c3")).toContain("ANTHROPIC_API_KEY");
    expect(out(s, "x3")).toContain("OPENAI_API_KEY");
    expect(out(s, "x3")).toContain("CODEX_API_KEY");
  });

  it("hides a key a flow brings in agent_env: it is ignored, and the server's key is not shown", async () => {
    const s = await go(flowOf(step("x", "codex", "SHOWVARS CODEX_API_KEY")), user.id, { vars: { agent_env: "CODEX_API_KEY=flow-value-0123456789" } });
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "x")).not.toContain("flow-value-0123456789");
    expect(out(s, "x")).not.toContain("sk-oai-dummy-0123456789");
  });

  for (const agent of AGENTS) {
    it(`${agent}: can write in the workspace, also from a child process`, async () => {
      const s = await go(flowOf(step("a", agent, "WRITE w.txt x\nCHILD WRITE c.txt y", agent === "codex" ? "    permission_mode: acceptEdits\n" : "")), user.id);
      expect(s.status, s.reason).toBe("succeeded");
      expect(existsSync(join(s.workdir!, "w.txt"))).toBe(true);
      expect(existsSync(join(s.workdir!, "c.txt"))).toBe(true);
    });

    const probes: { name: string; line: (runDir: string) => string; before?: () => void; skip?: () => boolean }[] = [
      { name: "the home of the Mac account", line: () => `READ ${homedir()}` },
      { name: "another run's folder", line: () => `READ ${runs()}/other/secret.txt`, before: () => (mkdirSync(join(runs(), "other"), { recursive: true }), writeFileSync(join(runs(), "other", "secret.txt"), "OTHER-RUN-SECRET")) },
      { name: "~/.ssh", line: () => `READ ${homedir()}/.ssh`, skip: () => !existsSync(join(homedir(), ".ssh")) },
      { name: "~/.claude", line: () => `READ ${homedir()}/.claude`, skip: () => !existsSync(join(homedir(), ".claude")) },
      { name: "~/.codex/config.toml", line: () => `READ ${homedir()}/.codex/config.toml`, skip: () => !existsSync(join(homedir(), ".codex", "config.toml")) },
      { name: "a write to tools/", line: () => `WRITE ${TOOLS_DIR}/zz-probe x` },
    ];
    for (const p of probes) {
      for (const via of ["", "CHILD "]) {
        if (via && p.name.startsWith("a write")) continue;
        it(`${agent}: cannot ${p.name}${via ? " from a child process" : ""}`, async () => {
          if (p.skip?.()) return;
          p.before?.();
          const text = p.line("");
          const prompt = via ? text.replace(/^READ/, "CHILD READ") : text;
          const s = await go(flowOf(step("a", agent, prompt, agent === "codex" ? "    permission_mode: acceptEdits\n" : "")), user.id);
          expect(s.status).toBe("failed");
          expect(s.reason).toMatch(/EPERM|not permitted/);
          expect(`${s.reason}${out(s, "a")}`).not.toContain("read ok");
          expect(`${s.reason}${out(s, "a")}`).not.toContain("OTHER-RUN-SECRET");
          expect(existsSync(join(TOOLS_DIR, "zz-probe"))).toBe(false);
        });
      }
    }
  }

  it("a Codex read-only step cannot write in the workspace, but can write in its tmp", async () => {
    for (const prompt of ["WRITE w.txt x", "CHILD WRITE w.txt x"]) {
      const s = await go(flowOf(step("a", "codex", prompt, "    permission_mode: plan\n")), user.id);
      expect(s.status).toBe("failed");
      expect(s.reason).toMatch(/EPERM|not permitted/);
      expect(existsSync(join(s.workdir!, "w.txt"))).toBe(false);
    }
    const ok = await go(flowOf(step("a", "codex", "WRITE {{run.dir}}/tmp/t.txt x", "    permission_mode: plan\n")), user.id);
    expect(ok.status, ok.reason).toBe("succeeded");
    expect(existsSync(join(ok.runDir, "tmp", "t.txt"))).toBe(true);
  });

  for (const agent of AGENTS) {
    it(`${agent}: a later step of the run resumes the session in the same private folder`, async () => {
      const s = await go(flowOf(step("a", agent, "SHOWVARS CLAUDE_CONFIG_DIR CODEX_HOME"), step("b", agent, "hello", "    resume: a\n")), user.id);
      expect(s.status, s.reason).toBe("succeeded");
      const sessionId = s.history.find((h) => h.id === "a")?.sessionId;
      expect(sessionId).toBeTruthy();
      expect(out(s, "b")).toContain(sessionId!);
      expect(out(s, "a")).toContain(`${s.runDir}/home/.`);
      if (agent === "codex") {
        expect(s.history.filter((h) => h.codexHome !== "run")).toHaveLength(0);
        expect(s.history.map((h) => h.codexHome)).toEqual(["run", "run"]);
      }
    });
  }

  it("a signed-out answer in a boxed step gives the no-key sentence, fails the run and does not retry", async () => {
    const cases = [
      { agent: "claude" as const, prompt: "CLAUDE_SIGNED_OUT", names: "CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN", fallback: "codex" },
      { agent: "codex" as const, prompt: "CODEX_SIGNED_OUT", names: "OPENAI_API_KEY or CODEX_API_KEY", fallback: "claude" },
    ];
    for (const c of cases) {
      const s = await go(flowOf(step("a", c.agent, c.prompt)), user.id, { config: config({ router: { fallback: [c.fallback] } }) });
      expect(s.status).toBe("failed");
      expect(s.reason).toContain(noAgentKey(c.names));
      expect(s.reason).not.toContain("/login");
      expect(s.reason).not.toContain("codex login");
      expect(s.history[0]!.limited).toBeFalsy();
      expect(readFileSync(join(s.runDir, "live.log"), "utf8")).not.toContain("retrying on");
    }
  });

  it("starts the program that FACTORY_CLAUDE_BIN and FACTORY_CODEX_BIN name when the engine has none", async () => {
    const saveBins = [process.env.FACTORY_CLAUDE_BIN, process.env.FACTORY_CODEX_BIN];
    process.env.FACTORY_CLAUDE_BIN = claudeBin;
    process.env.FACTORY_CODEX_BIN = codexBin;
    try {
      const s = await runFlow(flowOf(step("c", "claude", "SAY via-env"), step("x", "codex", "SAY via-env")), {
        task: "idea", repo: gh.tmp, runsDir: runs(), vars: { github_repo: "acme/app" }, config: config(), owner: user.id,
      });
      expect(s.status, s.reason).toBe("succeeded");
      expect(out(s, "c")).toMatch(/^via-env/);
      expect(out(s, "x")).toMatch(/^via-env/);
    } finally {
      for (const [k, v] of [["FACTORY_CLAUDE_BIN", saveBins[0]], ["FACTORY_CODEX_BIN", saveBins[1]]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("a local provider needs no key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const s = await go(flowOf(step("a", "claude", "SAY fine", "    model: ollama:m\n")), user.id);
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "a")).toMatch(/^fine/);
  });

  it("a user's boxed run that reached its budget does not continue on Codex", async () => {
    const flow = parseFlow(
      `name: boxed\nworkspace: empty\nvars: { github_repo: acme/app }\nlimits: { max_cost_usd: 0.005 }\nsteps:\n${step("a", "claude", "hello")}${step("b", "claude", "hello")}`,
      "boxed.yaml",
    );
    const cfg = config({ cost_limits: true, router: { fallback: ["codex"], fallback_on: ["budget"] } });
    const s = await go(flow, user.id, { config: cfg });
    expect(s.status).toBe("failed");
    expect(s.reason).toMatch(/run budget .* reached/);
  });

  it("an admin's run is not held: another run's folder is readable", async () => {
    mkdirSync(join(runs(), "other"), { recursive: true });
    writeFileSync(join(runs(), "other", "secret.txt"), "OTHER-RUN-SECRET");
    const s = await go(flowOf(step("a", "claude", `READ ${runs()}/other/secret.txt`)), admin.id);
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "a")).toContain("read ok");
  });
});
