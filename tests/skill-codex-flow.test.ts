import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CODEX_SKILLS_REFUSED, codexHomeId, codexIsolationLine } from "../src/agents/codex-home.js";
import { ConfigSchema } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { liveLogFile } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { addSkillPins } from "../src/skills/lock.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { CODEX_AGENT_NOTE, resetCodexFlagsCache } from "../src/steps/codex.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const codexBin = resolve("tests/fixtures/fake-codex.mjs");
const VARS = ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "FAKE_CODEX_NO_IGNORE_CONFIG"];
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
let tmp: string;
let repo: string;
let personal: string;
let skills: string;
let low: string;

beforeEach(() => {
  for (const k of VARS) delete process.env[k];
  resetCodexFlagsCache();
  tmp = mkdtempSync(join(tmpdir(), "skill-codex-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  personal = join(tmp, "personal");
  mkdirSync(join(personal, "skills", "canary"), { recursive: true });
  writeFileSync(join(personal, "config.toml"), '[mcp_servers.canary]\ncommand = "x"\n');
  writeFileSync(join(personal, "skills", "canary", "SKILL.md"), "canary");
  process.env.CODEX_HOME = personal;
  skills = join(process.env.FACTORY_HOME!, "skills");
  low = join(tmp, "low-skills");
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCodexFlagsCache();
  rmSync(tmp, { recursive: true, force: true });
  rmSync(skills, { recursive: true, force: true });
});

/** A valid package `demo`, pinned; an optional REVIEW.md. */
function demo(version: string, body = "Do it.", review?: string): void {
  const d = join(low, "demo");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: demo\ndescription: A test skill.\n---\n\n${body}\n`);
  writeFileSync(join(d, "skill.yaml"), `id: demo\nversion: ${version}\n`);
  if (review) writeFileSync(join(d, "REVIEW.md"), `${review}\n`);
  addSkillPins([{ key: `demo@${version}`, digest: loadSkillPackage(d).digest }]);
}

const REQUEST = 'SKILL_REQUEST: {"version":1,"skills":[{"id":"demo","reason":"Needed for the change","evidence":["catalogue:demo"]}]}';
const GATE = `  - id: risk_gate
    type: shell
    run: |
      # /skill-request
      echo READY
      echo '${REQUEST}'
`;
const cfg = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ protected_branches: [], skills: { roots: [low] }, ...over });
const run = (steps: string, config = cfg()) =>
  runFlow(parseFlow(`\nname: t\nworkspace: inplace\nsteps:\n${steps}`), { task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, codexBin, config });
const agentStep = (id: string, extra: string, prompt: string) => `  - {id: ${id}, type: claude, ${extra} prompt: ${JSON.stringify(prompt)}}\n`;
type Hist = { id: string; output: string; sessionId?: string; codexHome?: string; skills?: Record<string, unknown> };
const get = (s: { history: Hist[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)!;
const log = (s: { runDir: string }) => readFileSync(liveLogFile(s.runDir), "utf8");
const promptOf = (out: string) => out.split("\nPROMPT<<")[1] ?? "";
const block = (out: string) => /<foundry-skills count="[^"]*"[^>]*>[\s\S]*?<\/foundry-skills>/.exec(promptOf(out))?.[0];

describe("locked skills in Codex sessions", () => {
  it("gives Claude, Codex login and Codex local the same block, with isolation on and nothing written", async () => {
    demo("1.0.0");
    const s = await run(GATE + agentStep("login", "agent: codex,", "SHOWCODEXHOME") + agentStep("local", 'model: "codex:ollama:m",', "SHOWCODEXHOME") + agentStep("cl", 'model: "ollama:m",', "SHOWPROMPT"), cfg({ isolate_agents: false }));
    expect(s.status, s.reason).toBe("succeeded");
    const [login, local, cl] = ["login", "local", "cl"].map((id) => get(s, id));
    const b = block(login!.output);
    expect(b).toBeDefined();
    expect(b).toBe(block(local!.output));
    expect(b).toBe(block(cl!.output));
    expect(b).toMatch(/^<foundry-skills count="1">/);
    expect(b).toContain('id="demo" version="1.0.0"');

    const p = promptOf(login!.output);
    expect(p.indexOf("</instructions>")).toBeGreaterThanOrEqual(0);
    expect(p.indexOf("</instructions>")).toBeLessThan(p.indexOf("<foundry-skills count="));
    expect(p.indexOf("<foundry-skills count=")).toBeLessThan(p.indexOf("SHOWCODEXHOME"));
    expect(login!.output).toContain("--ignore-user-config");
    expect(login!.output).toContain(CODEX_AGENT_NOTE);
    expect(login!.skills).toMatchObject({ loaded: ["demo@1.0.0"], state: "loaded" });
    expect(login!.codexHome).toBe(codexHomeId({ run: false, codexHome: personal }));

    expect(local!.codexHome).toBe("run");
    expect(local!.skills).toMatchObject({ loaded: ["demo@1.0.0"] });
    expect(local!.output).toContain(`codex_home=${s.runDir}/home/.codex`);
    expect(readdirSync(repo)).toEqual([]);
    const l = log(s);
    expect(l).toContain("skill context: loaded demo@1.0.0");
    expect(l).toContain(codexIsolationLine("ignore-config"));
    expect(l).toContain(codexIsolationLine("private"));
  });

  it("gives a resumed Codex step the full block again", async () => {
    demo("1.0.0");
    const s = await run(GATE + agentStep("a", "agent: codex,", "hello") + agentStep("b", "agent: codex, resume: a,", "again"), cfg());
    expect(s.status, s.reason).toBe("succeeded");
    const a = get(s, "a");
    const b = get(s, "b");
    expect(b.output).toContain("args=exec resume ");
    expect(promptOf(b.output).split("<foundry-skills count=").length - 1).toBe(1);
    expect(b.skills).toMatchObject({ state: "reloaded", digest: a.skills!.digest, attachedBytes: b.skills!.bytes });
    expect(log(s)).toMatch(/skill context: reloaded demo@1\.0\.0.*the full block is sent again/);
  });

  it("stops a Codex step before Codex starts when the mandatory skill does not fit", async () => {
    demo("1.0.0");
    const s = await run(GATE + agentStep("x", "agent: codex,", "WRITE ran.txt yes"), cfg({ skills: { roots: [low], selection: { include: ["demo"], max_tokens: 100 } } }));
    expect(s.status).toBe("failed");
    expect(s.reason).toMatch(/skill selection is blocked: .*demo@1\.0\.0 does not fit the skill context budget/);
    expect(existsSync(join(repo, "ran.txt"))).toBe(false);
    expect(get(s, "x").sessionId).toBeUndefined();
  });

  it("refuses a block from the lock on a CLI without --ignore-user-config, with no fallback and no on_failure", async () => {
    demo("1.0.0");
    process.env.FAKE_CODEX_NO_IGNORE_CONFIG = "1";
    const steps = GATE + agentStep("x", "agent: codex, on_failure: sentinel,", "WRITE ran.txt yes") + "  - {id: sentinel, type: shell, jump_only: true, run: echo failed > failure-branch.txt}\n";
    const s = await run(steps);
    expect(s.status).toBe("failed");
    expect(s.reason).toContain(CODEX_SKILLS_REFUSED);
    expect(existsSync(join(repo, "ran.txt"))).toBe(false);
    expect(existsSync(join(repo, "failure-branch.txt"))).toBe(false);
    expect(s.history.filter((h) => h.id === "x")).toHaveLength(1);
    expect(get(s, "x").sessionId).toBeUndefined();
    const l = log(s);
    expect(l).toContain("skill context: rejected");
    expect(l).not.toContain("↪");
  });

  it("still runs the review of a draft plan on a CLI without --ignore-user-config", async () => {
    // its own version: a pin of another test (same key, other text) would be kept
    demo("9.0.0", "Do it. ".repeat(200), "Check it.");
    process.env.FAKE_CODEX_NO_IGNORE_CONFIG = "1";
    const plan = `  - id: plan\n    type: shell\n    run: |\n      echo '${REQUEST}'\n      echo 'PLAN_STATUS: READY'\n`;
    const s = await run(plan + agentStep("rev", "agent: codex, skill_role: reviewer, permission_mode: plan,", "SHOWCODEXHOME"));
    expect(s.status, s.reason).toBe("succeeded");
    const rev = get(s, "rev");
    expect(promptOf(rev.output)).toContain('<foundry-skills count="1" role="reviewer">');
    expect(promptOf(rev.output)).toContain("Check it.");
    expect(rev.skills).toMatchObject({ role: "reviewer", loaded: ["demo@9.0.0"] });
    const l = log(s);
    expect(l).toContain(codexIsolationLine("unsupported"));
    expect(l).not.toContain("skill context: rejected");
    expect(existsSync(join(s.runDir, "skill-lock.json"))).toBe(false);
  });

  it("changes nothing without a lock", async () => {
    const s = await run(agentStep("x", "agent: codex,", "SHOWCODEXHOME"), cfg({ isolate_agents: false }));
    expect(s.status, s.reason).toBe("succeeded");
    const x = get(s, "x");
    expect(x.output).not.toContain("<foundry-skills count=");
    expect(x.skills).toBeUndefined();
    expect(x.output).not.toContain("--ignore-user-config");
    expect(log(s)).not.toContain("Codex:");
  });
});
