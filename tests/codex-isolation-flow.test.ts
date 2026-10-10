import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_HOME_CHANGED, codexIsolationLine } from "../src/agents/codex-home.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { CODEX_AGENT_NOTE, resetCodexFlagsCache } from "../src/steps/codex.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const VARS = ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "FAKE_CODEX_NO_IGNORE_CONFIG"];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
const FLAG = "--ignore-user-config";
let tmp: string;
let repo: string;
let personal: string;

beforeEach(() => {
  for (const k of VARS) delete process.env[k];
  resetCodexFlagsCache();
  tmp = mkdtempSync(join(tmpdir(), "cx-iso-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  personal = join(tmp, "personal");
  mkdirSync(join(personal, "skills", "canary"), { recursive: true });
  mkdirSync(join(personal, "rules"));
  writeFileSync(join(personal, "config.toml"), '[mcp_servers.canary]\ncommand = "x"\n');
  writeFileSync(join(personal, "skills", "canary", "SKILL.md"), "canary");
  writeFileSync(join(personal, "AGENTS.md"), "canary");
  writeFileSync(join(personal, "rules", "canary.rules"), "canary");
  process.env.CODEX_HOME = personal;
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCodexFlagsCache();
  rmSync(tmp, { recursive: true, force: true });
});

type Hist = { id: string; output: string; sessionId?: string; codexHome?: string };
const run = (steps: string, over: Record<string, unknown> = {}) =>
  runFlow(parseFlow(`\nname: t\nworkspace: inplace\nsteps:\n${steps}`), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, codexBin, config: ConfigSchema.parse({ protected_branches: [], ...over }) });
const step = (id: string, extra = "") => `  - {id: ${id}, type: claude, ${extra} prompt: "SHOWCODEXHOME"}\n`;
const get = (s: { history: Hist[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)!;
const log = (s: { runDir: string }) => readFileSync(liveLogFile(s.runDir), "utf8");

describe("Codex steps and the personal Codex setup", () => {
  it("login mode, private folder for a local model, and a session that moves between them", async () => {
    const s = await run(step("login", "agent: codex,") + step("local", 'model: "codex:ollama:m",') + step("again", 'model: "codex:ollama:m", resume: login,') + step("same", "agent: codex, resume: login,"));
    expect(s.status, s.reason).toBe("succeeded");
    const login = get(s, "login");
    expect(login.output).toContain(`--skip-git-repo-check ${FLAG} -c sandbox_mode=`);
    expect(login.output).toContain('approval_policy="never"');
    expect(login.output).not.toContain("--ignore-rules");
    expect(login.output).toContain(`codex_home=${personal} config=ignored mcp=- skills=canary instructions=yes rules=canary`);
    expect(login.output).toContain(CODEX_AGENT_NOTE);
    expect(login.codexHome).toMatch(/^personal:/);
    expect(log(s)).toContain(`    · ${codexIsolationLine("ignore-config")}`);

    const local = get(s, "local");
    expect(local.output).toContain(`codex_home=${s.runDir}/home/.codex config=none mcp=- skills=- instructions=no rules=-`);
    expect(local.output).not.toContain(FLAG);
    expect(local.codexHome).toBe("run");
    expect(log(s)).toContain(`    · ${codexIsolationLine("private")}`);

    const again = get(s, "again");
    expect(again.output).toContain("args=exec --json");
    expect(again.output).not.toContain("exec resume");
    expect(log(s)).toContain(`not resuming login: ${CODEX_HOME_CHANGED}`);

    const same = get(s, "same");
    expect(same.output).toContain("args=exec resume ");
    expect(same.output).toContain(FLAG);
    expect(same.sessionId).toBe(login.sessionId);
  });

  it("a CODEX_API_KEY gives the private folder, the note and no flag; OPENAI_API_KEY alone does not", async () => {
    process.env.CODEX_API_KEY = "k".repeat(20);
    const s = await run(step("a", "agent: codex,"));
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(a.output).toContain(`codex_home=${s.runDir}/home/.codex config=none mcp=- skills=- instructions=no rules=-`);
    expect(a.output).not.toContain(FLAG);
    expect(a.codexHome).toBe("run");
    expect(a.output).toContain(`PROMPT<<<instructions>\n${CODEX_AGENT_NOTE}`);

    delete process.env.CODEX_API_KEY;
    process.env.OPENAI_API_KEY = "k".repeat(20);
    const t = await run(step("b", "agent: codex,"));
    expect(get(t, "b").output).toContain(FLAG);
    expect(get(t, "b").output).toContain(`codex_home=${personal} config=ignored`);
  });

  it("a CLI without the flag: no flag, a ! line, the personal setup is visible, the step succeeds; a resumed step uses exec resume", async () => {
    process.env.FAKE_CODEX_NO_IGNORE_CONFIG = "1";
    const s = await run(step("a", "agent: codex,") + step("b", "agent: codex, resume: a,"));
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(a.output).not.toContain(FLAG);
    expect(a.output).toContain("config=read mcp=canary");
    const b = get(s, "b");
    expect(b.output).toContain("args=exec resume ");
    expect(b.output).not.toContain(FLAG);
    expect(b.sessionId).toBe(a.sessionId);
    const l = log(s);
    expect(l).toContain(`    ! ${codexIsolationLine("unsupported")}`);
    expect(l.split(`    ! ${codexIsolationLine("unsupported")}`)).toHaveLength(3);
  });

  it("isolate_agents: false runs Codex exactly as before", async () => {
    const s = await run(step("a", "agent: codex,"), { isolate_agents: false });
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(a.output).not.toContain(FLAG);
    expect(a.output).not.toContain("<instructions>");
    expect(a.output).toContain(`codex_home=${personal} config=read mcp=canary`);
    expect(log(s)).not.toContain("Codex:");
  });

  it("a read-only reviewer is not isolated by its skill payload when isolate_agents is false", async () => {
    const s = await run(step("a", "agent: codex, skill_role: reviewer, permission_mode: plan,"), { isolate_agents: false });
    const a = get(s, "a");
    expect(a.output).not.toContain("<instructions>");
    expect(log(s)).not.toContain("Codex:");
  });
});
