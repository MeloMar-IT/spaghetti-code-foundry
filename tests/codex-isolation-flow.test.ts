import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_HOME_CHANGED, CODEX_PUSH_BLOCKED_LINE, CODEX_PUSH_UNHELD, codexIsolationLine } from "../src/agents/codex-home.js";
import { CODEX_NO_LOGIN, codexLoginRecord } from "../src/agents/codex-login.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { addSkillPins } from "../src/skills/lock.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { CODEX_AGENT_NOTE, resetCodexFlagsCache } from "../src/steps/codex.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const VARS = ["HOME", "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "FAKE_CODEX_NO_IGNORE_CONFIG", "GH_TOKEN", "SCF_CANARY_SECRET"];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
const FLAG = "--ignore-user-config";
const PERSONAL_LOGIN = '{"tokens":{"personal":true}}';
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
  writeFileSync(join(personal, "auth.json"), PERSONAL_LOGIN);
  writeFileSync(join(personal, "config.toml"), '[mcp_servers.canary]\ncommand = "x"\n');
  writeFileSync(join(personal, "skills", "canary", "SKILL.md"), "canary");
  writeFileSync(join(personal, "AGENTS.md"), "canary");
  writeFileSync(join(personal, ".env"), "CANARY=1");
  writeFileSync(join(personal, "rules", "canary.rules"), "canary");
  process.env.CODEX_HOME = personal;
  process.env.GH_TOKEN = "ghp_canary";
  process.env.SCF_CANARY_SECRET = "canary";
  // personal skills Codex also reads from $HOME/.agents/skills, whatever CODEX_HOME is
  process.env.HOME = join(tmp, "myhome");
  mkdirSync(join(process.env.HOME, ".agents", "skills", "homecanary"), { recursive: true });
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCodexFlagsCache();
  rmSync(tmp, { recursive: true, force: true });
});

type Hist = { id: string; output: string; sessionId?: string; codexHome?: string; skills?: { loaded: string[]; role?: string } };
const run = (steps: string, over: Record<string, unknown> = {}, source?: string) =>
  runFlow(parseFlow(`\nname: t\nworkspace: inplace\nsteps:\n${steps}`), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, codexBin, source, config: ConfigSchema.parse({ protected_branches: [], ...over }) });
const step = (id: string, extra = "", prompt = "SHOWCODEXHOME") => `  - {id: ${id}, type: claude, ${extra} prompt: ${JSON.stringify(prompt)}}\n`;
const reviewer = (id: string) => step(id, "agent: codex, skill_role: reviewer, permission_mode: plan,");
const count = (out: string) => out.split(FLAG).length - 1;
const OVERRIDES = "-c mcp_servers={} -c features.codex_hooks=false";
const CLEAN = (runDir: string) => `codex_home=${runDir}/home/.codex config=none mcp=- skills=- instructions=no rules=foundry agents_skills=-`;
const REQUEST = 'SKILL_REQUEST: {"version":1,"skills":[{"id":"demo","reason":"Needed for the change","evidence":["catalogue:demo"]}]}';
const gate = `  - id: risk_gate\n    type: shell\n    run: |\n      # /skill-request\n      echo READY\n      echo '${REQUEST}'\n`;
/** A pinned skill `demo` with a review block; the coding block is longer than the review block. */
function demoSkill(): string {
  const root = join(tmp, "skills");
  const d = join(root, "demo");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: demo\ndescription: A test skill.\n---\n\n${"Do it. ".repeat(60)}\n`);
  writeFileSync(join(d, "skill.yaml"), "id: demo\nversion: 1.0.0\n");
  writeFileSync(join(d, "REVIEW.md"), "Check the canary.\n");
  addSkillPins([{ key: "demo@1.0.0", digest: loadSkillPackage(d).digest }]);
  return root;
}
const get = (s: { history: Hist[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)!;
const log = (s: { runDir: string }) => readFileSync(liveLogFile(s.runDir), "utf8");
const runCopy = (s: { runDir: string }) => join(s.runDir, "home", ".codex", "auth.json");

describe("Codex steps and the personal Codex setup", () => {
  it("login mode, a local model, and a session that moves between them, all in the run's clean folder", async () => {
    const s = await run(step("login", "agent: codex,") + step("local", 'model: "codex:ollama:m",') + step("again", 'model: "codex:ollama:m", resume: login,') + step("same", "agent: codex, resume: login,"));
    expect(s.status, s.reason).toBe("succeeded");
    const login = get(s, "login");
    expect(login.output).toContain("--skip-git-repo-check -c sandbox_mode=");
    expect(login.output).toContain('approval_policy="never"');
    expect(login.output).not.toContain("--ignore-rules");
    expect(login.output).not.toContain(FLAG);
    expect(login.output).toContain(OVERRIDES);
    expect(login.output).toContain("sandbox_workspace_write.network_access=false");
    expect(login.output).toContain(`${CLEAN(s.runDir)} login=yes env=no`);
    expect(login.output).toContain(CODEX_AGENT_NOTE);
    expect(login.codexHome).toBe("run");
    const l = log(s);
    expect(l).toContain(`    · ${codexIsolationLine("login")}`);
    expect(l).toContain(`    · ${CODEX_PUSH_BLOCKED_LINE}`);

    const local = get(s, "local");
    expect(local.output).toContain(`${CLEAN(s.runDir)} login=no env=no`);
    expect(local.output).not.toContain(FLAG);
    expect(local.codexHome).toBe("run");
    expect(l).toContain(`    · ${codexIsolationLine("private")}`);

    // one folder for every step: the session carries on
    for (const id of ["again", "same"]) {
      expect(get(s, id).output).toContain("args=exec resume ");
      expect(get(s, id).sessionId).toBe(login.sessionId);
    }
    expect(l).not.toContain(CODEX_HOME_CHANGED);

    // the lent copy and its record are gone, and the person's login is unchanged
    expect(existsSync(runCopy(s))).toBe(false);
    expect(existsSync(codexLoginRecord(s.runDir))).toBe(false);
    expect(readFileSync(join(personal, "auth.json"), "utf8")).toBe(PERSONAL_LOGIN);
  });

  it("a login step sees no ambient credential variable", async () => {
    const s = await run(step("a", "agent: codex,", "SHOWALLENV\nSHOWVARS GIT_CONFIG_GLOBAL HOME CODEX_HOME GIT_ALLOW_PROTOCOL"));
    expect(s.status, s.reason).toBe("succeeded");
    const out = get(s, "a").output;
    const names = /env: (.*)/.exec(out)![1]!.split(" ");
    expect(names).not.toContain("GH_TOKEN");
    expect(names).not.toContain("SCF_CANARY_SECRET");
    expect(names).not.toContain("SSH_AUTH_SOCK");
    expect(out).toContain("GIT_CONFIG_GLOBAL=/dev/null");
    expect(out).toContain("GIT_ALLOW_PROTOCOL=file");
    expect(out).toContain(`HOME=${s.runDir}/home\n`);
    expect(out).toContain(`CODEX_HOME=${s.runDir}/home/.codex`);
  });

  it("a key step has no login; OPENAI_API_KEY alone is not a Codex key", async () => {
    process.env.CODEX_API_KEY = "k".repeat(20);
    const shown = await run(step("v", "agent: codex,", "SHOWVARS GIT_ALLOW_PROTOCOL GH_TOKEN"));
    expect(get(shown, "v").output).toContain("GIT_ALLOW_PROTOCOL=file");
    expect(get(shown, "v").output).toContain("GH_TOKEN=(unset)");
    const t = await run(step("k", "agent: codex,"));
    expect(get(t, "k").output).toContain("login=no");
    expect(get(t, "k").output).toContain(`${CLEAN(t.runDir)} login=no env=no`);
    expect(get(t, "k").output).not.toContain(FLAG);
    expect(get(t, "k").codexHome).toBe("run");
    expect(get(t, "k").output).toContain(`PROMPT<<<instructions>\n${CODEX_AGENT_NOTE}`);

    delete process.env.CODEX_API_KEY;
    process.env.OPENAI_API_KEY = "k".repeat(20);
    const u = await run(step("b", "agent: codex,"));
    expect(get(u, "b").output).toContain("login=yes");
  });

  it("writes a refreshed login back to the personal folder", async () => {
    const s = await run(step("a", "agent: codex,", 'SHOWCODEXHOME\nCODEX_REFRESH {"new":1}'));
    expect(s.status, s.reason).toBe("succeeded");
    expect(readFileSync(join(personal, "auth.json"), "utf8")).toBe('{"new":1}');
    expect(log(s)).toContain("the refreshed Codex login was written back");
    expect(log(s)).not.toContain(personal);
    expect(existsSync(runCopy(s))).toBe(false);
    expect(existsSync(codexLoginRecord(s.runDir))).toBe(false);
  });

  it("fails without a login file: Codex never starts, one try, no fallback to the personal folder", async () => {
    rmSync(join(personal, "auth.json"));
    const s = await run(step("a", "agent: codex,", "WRITE ran.txt yes"));
    expect(s.status).toBe("failed");
    expect(s.reason).toContain(CODEX_NO_LOGIN);
    expect(s.history.filter((h) => h.id === "a")).toHaveLength(1);
    expect(get(s, "a").sessionId).toBeUndefined();
    expect(existsSync(join(repo, "ran.txt"))).toBe(false);
  });

  it("refuses bypassPermissions without a sandbox on a run the server started", async () => {
    const s = await run(step("a", "agent: codex, permission_mode: bypassPermissions,", "WRITE ran.txt yes"), {}, "watcher w issue #1");
    expect(s.status).toBe("failed");
    expect(s.reason).toContain(CODEX_PUSH_UNHELD);
    expect(existsSync(join(repo, "ran.txt"))).toBe(false);
    expect(existsSync(runCopy(s))).toBe(false);
  });

  it("a CLI without the flag is just as clean: no flag, no ! line, a resumed step uses exec resume", async () => {
    process.env.FAKE_CODEX_NO_IGNORE_CONFIG = "1";
    const s = await run(step("a", "agent: codex,") + step("b", "agent: codex, resume: a,"));
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(a.output).not.toContain(FLAG);
    expect(a.output).toContain("config=none mcp=-");
    const b = get(s, "b");
    expect(b.output).toContain("args=exec resume ");
    expect(b.sessionId).toBe(a.sessionId);
    expect(log(s)).not.toContain("    ! ");
  });

  it("isolate_agents: false on a CLI run: Codex keeps its personal folder, and still gets no token", async () => {
    const s = await run(step("a", "agent: codex,", "SHOWCODEXHOME\nSHOWVARS GH_TOKEN GIT_ALLOW_PROTOCOL"), { isolate_agents: false });
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(a.output).not.toContain(FLAG);
    expect(a.output).not.toContain("<instructions>");
    expect(a.output).not.toContain("mcp_servers={}");
    expect(a.output).toContain(`codex_home=${personal} config=read mcp=canary`);
    expect(a.output).toContain("GH_TOKEN=(unset)");
    expect(a.output).toContain("GIT_ALLOW_PROTOCOL=file");
    expect(log(s).replace(/^.*· tools: .*$/gm, "")).not.toContain("Codex:");
  });

  it("isolate_agents: false does not switch isolation off on a run the server started", async () => {
    const s = await run(step("a", "agent: codex,", "SHOWCODEXHOME\nSHOWVARS GH_TOKEN"), { isolate_agents: false }, "watcher w issue #1");
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(a.output).toContain(`${CLEAN(s.runDir)} login=yes env=no`);
    expect(a.output).toContain("GH_TOKEN=(unset)");
    expect(log(s)).toContain("Codex: a clean Codex folder");
  });

  it("a reviewer in login mode gets the overrides once, no flag and the clean folder", async () => {
    const s = await run(reviewer("a"));
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(count(a.output)).toBe(0);
    expect(a.output.split("mcp_servers={}")).toHaveLength(2);
    expect(a.output).toContain(OVERRIDES);
    expect(a.output).toContain(`${CLEAN(s.runDir)} login=yes`);
    expect(a.output).toContain(CODEX_AGENT_NOTE);
    expect(log(s)).toContain(`    · ${codexIsolationLine("login")}`);
  });

  it("a reviewer with a key gets the overrides, no flag and no login", async () => {
    process.env.CODEX_API_KEY = "k".repeat(20);
    const s = await run(reviewer("a"));
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(count(a.output)).toBe(0);
    expect(a.output).toContain(OVERRIDES);
    expect(a.output).toContain(`${CLEAN(s.runDir)} login=no`);
    expect(a.codexHome).toBe("run");
    expect(log(s)).toContain(`    · ${codexIsolationLine("private")}`);
  });

  it("a reviewer without a lock keeps the old behaviour when isolate_agents is false", async () => {
    const s = await run(reviewer("a"), { isolate_agents: false });
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(count(a.output)).toBe(1);
    expect(a.output).toContain(OVERRIDES);
    expect(a.output).not.toContain("<instructions>");
    expect(a.output).not.toContain(CODEX_AGENT_NOTE);
    expect(a.codexHome).toMatch(/^personal:/);
    expect(log(s).replace(/^.*· tools: .*$/gm, "")).not.toContain("Codex:");
  });

  it("a reviewer with a loaded review block is isolated even when isolate_agents is false", async () => {
    const s = await run(gate + reviewer("a"), { isolate_agents: false, skills: { releases: { allow_unreleased: true }, roots: [demoSkill()] } });
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    expect(a.skills).toMatchObject({ loaded: ["demo@1.0.0"], role: "reviewer" });
    expect(a.output).toContain('<foundry-skills count="1" role="reviewer">');
    expect(a.output).toContain("Check the canary.");
    expect(count(a.output)).toBe(0);
    expect(a.output).toContain(OVERRIDES);
    expect(a.output).toContain(CODEX_AGENT_NOTE);
    expect(a.codexHome).toBe("run");
    expect(log(s)).toContain(`    · ${codexIsolationLine("login")}`);
  });
});
