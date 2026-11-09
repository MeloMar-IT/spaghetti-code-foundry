import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { TEAM_INPLACE_REFUSED } from "../src/engine/isolation.js";
import { resetSandboxCache, TEAM_SANDBOX_REFUSED } from "../src/engine/os-sandbox.js";
import { runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { claudeBin } from "./helpers/fake-github.js";
import { TEST_PASSWORD } from "./helpers/session.js";

// A team's steps in the OS sandbox (#785), with the real `sandbox-exec` and the fake `claude` and `codex` (the real ones are never started).
// An admin owns the runs: a team's run is held whoever owns it.
const basic = process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
if (!basic) console.warn(`workspace-sandbox-run tests skipped: ${process.platform === "darwin" ? "sandbox-exec does not work here (perhaps this process is already inside a sandbox)" : "they need macOS"}`);

const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const VARS = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FACTORY_HOME", "FACTORY_LOCK_DIR", "SCF_LOCK_DIR", "SCF_USER_SANDBOX", "FACTORY_USER_SANDBOX"];
const saved: Record<string, string | undefined> = {};
let data: string;
let repo: string;
let admin: { id: string };
let servers: Server[] = [];

const config = (over: Record<string, unknown> = {}) =>
  ConfigSchema.parse({
    protected_branches: [],
    bot: { name: "Bot", email: "bot@example.com" },
    ...over,
  });

describe.skipIf(!basic)("a team's step in the OS sandbox", () => {
  beforeEach(async () => {
    for (const k of VARS) saved[k] = process.env[k];
    data = realpathSync(mkdtempSync(join(tmpdir(), "ws-sandbox-")));
    process.env.FACTORY_HOME = data;
    process.env.FACTORY_LOCK_DIR = join(data, "locks");
    process.env.SCF_LOCK_DIR = join(data, "locks");
    process.env.ANTHROPIC_API_KEY = "dummy-anthropic-value";
    process.env.OPENAI_API_KEY = "dummy-openai-value";
    delete process.env.SCF_USER_SANDBOX;
    delete process.env.FACTORY_USER_SANDBOX;
    repo = join(data, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(data, "runs"), { recursive: true });
    // the workspace list is read from config.yaml
    writeFileSync(join(data, "config.yaml"), "workspaces:\n  - {id: team-a, name: Team A, hosts: [repo.example.test]}\n  - {id: team-b, name: Team B}\n");
    resetSandboxCache();
    admin = await createUser({ name: "Admin", email: "admin@example.com", password: TEST_PASSWORD, role: "admin" });
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSandboxCache();
    rmSync(data, { recursive: true, force: true });
  });

  const shellStep = (id: string, cmd: string, extra = "") => `  - id: ${id}\n    type: shell\n${extra}    run: |\n${cmd.split("\n").map((l) => `      ${l}`).join("\n")}\n`;
  const agentStep = (id: string, agent: "claude" | "codex", prompt: string, extra = "") => `  - id: ${id}\n    type: claude\n    agent: ${agent}\n${extra}    prompt: ${JSON.stringify(prompt)}\n`;
  const flowOf = (steps: string[], head = "workspace: empty") => parseFlow(`name: team\n${head}\nsteps:\n${steps.join("")}`, "team.yaml");
  const go = (flow: ReturnType<typeof flowOf>, over: { config?: ReturnType<typeof config>; workspace?: string } = {}) =>
    runFlow(flow, { task: "idea", repo, runsDir: join(data, "runs"), claudeBin, codexBin, config: over.config ?? config(), owner: admin.id, workspace: over.workspace ?? "team-a" });
  const out = (s: { history: { id: string; output: string }[] }, id: string) => (s.history.find((h) => h.id === id)?.output ?? "").trim();
  const log = (s: { runDir: string }) => readFileSync(join(s.runDir, "live.log"), "utf8");
  const listen = async (): Promise<number> => {
    const srv = createServer((c) => c.end());
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    return (srv.address() as { port: number }).port;
  };
  const node = JSON.stringify(process.execPath);

  describe.each([["with the default settings", {}], ["with user_runs off and a broad user_read", { sandbox: { user_runs: "off", user_read: [tmpdir(), homedir()] } }]])("a shell step %s", (_name, over) => {
    it("cannot read another workspace's run, the data folder or the Mac account's home, and can read and write its own", async () => {
      mkdirSync(join(data, "workspaces", "team-b", "runs", "x"), { recursive: true });
      writeFileSync(join(data, "workspaces", "team-b", "runs", "x", "secret.txt"), "OTHER-TEAM-SECRET");
      writeFileSync(join(data, "users-copy.json"), "DATA-FOLDER-SECRET");
      const probe = (label: string, path: string) => `cat "${path}" > /dev/null 2>&1 && echo "${label}:readable" || echo "${label}:denied"`;
      const s = await go(
        flowOf([
          shellStep(
            "s1",
            [
              probe("team-b", join(data, "workspaces", "team-b", "runs", "x", "secret.txt")),
              probe("data", join(data, "users-copy.json")),
              `ls "${homedir()}" > /dev/null 2>&1 && echo "home:readable" || echo "home:denied"`,
              `echo mine > "$FACTORY_WORKDIR/mine.txt" && cat "$FACTORY_WORKDIR/mine.txt" && echo "own:readable"`,
              `echo note >> "$FACTORY_LEARNINGS_FILE" && echo "learnings:written"`,
            ].join("\n"),
          ),
        ]),
        { config: config(over) },
      );
      expect(s.status, out(s, "s1")).toBe("succeeded");
      const o = out(s, "s1");
      expect(o).toContain("team-b:denied");
      expect(o).toContain("data:denied");
      expect(o).toContain("home:denied");
      expect(o).toContain("own:readable");
      expect(o).toContain("learnings:written");
      expect(existsSync(join(data, "workspaces", "team-a", "learnings"))).toBe(true);
      expect(existsSync(join(data, "learnings"))).toBe(false);
    });
  });

  it("is boxed by Seatbelt when a Docker image is configured, and says so", async () => {
    writeFileSync(join(data, "users-copy.json"), "DATA-FOLDER-SECRET");
    const s = await go(flowOf([shellStep("s1", `cat "${join(data, "users-copy.json")}" > /dev/null 2>&1 && echo readable || echo denied`, "    sandbox: true\n")]), { config: config({ sandbox: { docker_image: "scf-test-image:none" } }) });
    expect(out(s, "s1")).toContain("denied");
    expect(log(s)).toContain("a team's run does not use the Docker image");
  });

  it("refuses the run before any step when the sandbox cannot be used", async () => {
    resetSandboxCache(false);
    const s = await go(flowOf([shellStep("s1", "echo ran")]));
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(TEAM_SANDBOX_REFUSED);
    expect(s.history).toEqual([]);
  });

  it("refuses an inplace flow", async () => {
    const s = await go(flowOf([shellStep("s1", "echo ran")], "workspace: inplace"));
    expect(s.status).toBe("failed");
    expect(s.reason).toBe(TEAM_INPLACE_REFUSED);
    expect(s.history).toEqual([]);
  });

  it("reaches no other localhost port, and the proxy refuses a host that is not listed (and the step log names it)", async () => {
    const port = await listen();
    const tryPort = `${node} -e "require('net').connect(${port},'127.0.0.1').on('connect',()=>{console.log('LOCAL:connected');process.exit(0)}).on('error',()=>{console.log('LOCAL:blocked');process.exit(0)})"`;
    const viaProxy = `${node} -e "const u=new URL(process.env.HTTPS_PROXY);const s=require('net').connect(+u.port,u.hostname,()=>s.write('CONNECT example.invalid:443 HTTP/1.1\\r\\n\\r\\n'));s.on('data',d=>{console.log('PROXY:'+String(d).split('\\r')[0]);process.exit(0)});s.on('error',()=>{console.log('PROXY:error');process.exit(0)})"`;
    const s = await go(flowOf([shellStep("s1", [tryPort, viaProxy, 'echo "NOPROXY=[$NO_PROXY]"'].join("\n"))]));
    const o = out(s, "s1");
    expect(o).toContain("LOCAL:blocked");
    expect(o).toContain("PROXY:HTTP/1.1 403");
    expect(log(s)).toContain("hosts refused: example.invalid:443");
  });

  it("gets the cache variables, and its test slots work through the link in its workspace folder", async () => {
    const s = await go(flowOf([shellStep("s1", ['echo "CACHE=$npm_config_cache"', '"$FACTORY_TOOLS/test-slot" "{{run.dir}}/../../test-slots" echo slot-ran'].join("\n"))]));
    expect(s.status, out(s, "s1")).toBe("succeeded");
    expect(out(s, "s1")).toContain(`CACHE=${join(data, "workspaces", "team-a", "cache", "npm")}`);
    expect(out(s, "s1")).toContain("slot-ran");
  });

  it("does not let team-a's step read team-b's slot folder", async () => {
    mkdirSync(join(data, "test-slots", "workspaces", "team-b"), { recursive: true });
    writeFileSync(join(data, "test-slots", "workspaces", "team-b", "x"), "B");
    const s = await go(flowOf([shellStep("s1", `cat "${join(data, "test-slots", "workspaces", "team-b", "x")}" > /dev/null 2>&1 && echo readable || echo denied`)]));
    expect(out(s, "s1")).toContain("denied");
  });

  describe.each([["claude"], ["codex"]] as const)("a %s step", (agent) => {
    it("cannot read another workspace's run, the data folder or the home, and can read its own slot folder", async () => {
      mkdirSync(join(data, "workspaces", "team-b", "runs", "x"), { recursive: true });
      writeFileSync(join(data, "workspaces", "team-b", "runs", "x", "secret.txt"), "OTHER-TEAM-SECRET");
      writeFileSync(join(data, "users-copy.json"), "DATA-FOLDER-SECRET");
      for (const path of [join(data, "workspaces", "team-b", "runs", "x", "secret.txt"), join(data, "users-copy.json"), homedir()]) {
        const s = await go(flowOf([agentStep("a", agent, `READ ${path}`)]));
        expect(s.status, path).toBe("failed");
      }
      const ok = await go(flowOf([agentStep("a", agent, `READ ${join(data, "test-slots", "workspaces", "team-a")}`)]));
      expect(ok.status, ok.reason).toBe("succeeded");
    });

    it("gets the proxy, the cache and the test gate in its environment", async () => {
      const s = await go(flowOf([agentStep("a", agent, "SHOWVARS HTTPS_PROXY NO_PROXY CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC npm_config_cache FACTORY_TEST_SLOTS_DIR")]));
      expect(s.status, s.reason).toBe("succeeded");
      const o = out(s, "a");
      expect(o).toMatch(/HTTPS_PROXY=http:\/\/127\.0\.0\.1:\d+/);
      expect(o).toContain("NO_PROXY=");
      expect(o).toContain(`npm_config_cache=${join(data, "workspaces", "team-a", "cache", "npm")}`);
      expect(o).toContain(`FACTORY_TEST_SLOTS_DIR=${join(data, "workspaces", "team-a", "test-slots")}`);
      expect(o).toContain(agent === "claude" ? "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1" : "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=(unset)");
    });
  });

  it("sends a local model around the proxy", async () => {
    const s = await go(flowOf([agentStep("a", "claude", "SHOWVARS NO_PROXY ANTHROPIC_BASE_URL", '    model: "ollama:qwen3"\n')]));
    expect(s.status, s.reason).toBe("succeeded");
    expect(out(s, "a")).toContain("NO_PROXY=localhost,127.0.0.1,::1");
    expect(out(s, "a")).toContain("ANTHROPIC_BASE_URL=http://localhost:11434");
  });
});
