import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { SKILL_LOCK_CHANGED } from "../src/engine/skill-lock.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { addSkillPins } from "../src/skills/lock.js";
import { loadSkillPackage } from "../src/skills/package.js";
import { discoverSkills, findSkill } from "../src/skills/registry.js";
import { RUN_SKILL_LOCK_FILE } from "../src/skills/run-lock.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
let config = ConfigSchema.parse({});
let tmp: string;
let repo: string;
let skills: string;
let low: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "runlock-flow-"));
  repo = join(tmp, "repo");
  mkdirSync(repo);
  skills = join(process.env.FACTORY_HOME!, "skills");
  low = join(tmp, "low-skills");
  config = ConfigSchema.parse({ skills: { roots: [low] } });
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(skills, { recursive: true, force: true });
});

/** A valid package `demo`, pinned. Version 1 lives in a lower source: the data folder always comes first. */
function demo(version: string, root = low, body = "Do it.", frontmatter = ""): string {
  const d = join(root, "demo");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: demo\ndescription: A test skill.\n${frontmatter}---\n\n${body}\n`);
  writeFileSync(join(d, "skill.yaml"), `id: demo\nversion: ${version}\n`);
  addSkillPins([{ key: `demo@${version}`, digest: loadSkillPackage(d).digest }]);
  return d;
}

const REQUEST = 'SKILL_REQUEST: {"version":1,"skills":[{"id":"demo","reason":"Needed for the change","evidence":["catalogue:demo"]}]}';
const flow = () =>
  parseFlow(`
name: t
workspace: inplace
steps:
  - id: risk_gate
    type: shell
    run: |
      # /skill-request
      echo READY
      echo '${REQUEST}'
  - id: impl
    type: claude
    prompt: "WRITE ran.txt yes"
    on_failure: sentinel
  - id: sentinel
    type: shell
    jump_only: true
    run: echo failed > failure-branch.txt
`);
const runOpts = () => ({ task: "t", repo, runsDir: join(tmp, "runs"), claudeBin, config });
const resume = (runId: string) => resumeRun({ runId, runsDir: join(tmp, "runs"), claudeBin, config, from: "impl" });
const runJson = (dir: string) => JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as { skillLock?: { skills: { id: string; version: string }[] } };
const ranAgain = () => {
  rmSync(join(repo, "ran.txt"), { force: true });
  return () => existsSync(join(repo, "ran.txt"));
};

describe("skill lock in a run", () => {
  it("locks at the first agent step; a resume uses the pinned version, not the registry's new default", async () => {
    demo("1.0.0");
    const s = await runFlow(flow(), runOpts());
    expect(s.status).toBe("succeeded");
    expect(runJson(s.runDir).skillLock!.skills).toEqual([expect.objectContaining({ id: "demo", version: "1.0.0" })]);
    expect(existsSync(join(s.runDir, RUN_SKILL_LOCK_FILE))).toBe(true);

    // a newer pinned version next to the locked one: a new run would choose it, the resumed run does not
    demo("2.0.0", skills, "Do it better.");
    expect(findSkill(discoverSkills(config.skills), "demo")!.version).toBe("2.0.0");
    const ran = ranAgain();
    const again = await resume(s.runId);
    expect(again.status).toBe("succeeded");
    expect(ran()).toBe(true);
    expect(runJson(s.runDir).skillLock!.skills.map((k) => k.version)).toEqual(["1.0.0"]);
  });

  it.each([
    ["changed", (d: string) => writeFileSync(join(d, "SKILL.md"), "---\nname: demo\ndescription: A test skill.\n---\n\nDo something else.\n"), /skill integrity: demo@1\.0\.0 changed/],
    ["missing", (d: string) => rmSync(d, { recursive: true }), /skill integrity: demo@1\.0\.0 is missing/],
  ])("a %s package stops the resume before the agent starts and before on_failure", async (_name, damage, reason) => {
    const dir = demo("1.0.0");
    const s = await runFlow(flow(), runOpts());
    expect(s.status).toBe("succeeded");
    damage(dir);
    const ran = ranAgain();
    const r = await resume(s.runId);
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(reason);
    expect(ran()).toBe(false); // the agent did not start
    expect(existsSync(join(repo, "failure-branch.txt"))).toBe(false); // the failure branch did not run
    expect(r.history.filter((h) => h.id === "impl").at(-1)!.sessionId).toBeUndefined();
  });

  it("a lock file that was removed or a summary that was lost stops or repairs, never locks again", async () => {
    demo("1.0.0");
    const s = await runFlow(flow(), runOpts());
    const lockFile = join(s.runDir, RUN_SKILL_LOCK_FILE);
    const summaryOf = () => runJson(s.runDir).skillLock;
    // lost summary (crash between the two writes): repaired from the file
    const saved = JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8"));
    delete saved.skillLock;
    writeFileSync(join(s.runDir, "run.json"), JSON.stringify(saved));
    demo("2.0.0", skills, "Do it better.");
    expect((await resume(s.runId)).status).toBe("succeeded");
    expect(summaryOf()!.skills.map((k) => k.version)).toEqual(["1.0.0"]);
    // lost file
    rmSync(lockFile);
    const ran = ranAgain();
    const r = await resume(s.runId);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain(SKILL_LOCK_CHANGED);
    expect(ran()).toBe(false);
    expect(existsSync(join(repo, "failure-branch.txt"))).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("a run saved by an older version, without a lock, loads and resumes", async () => {
    const s = await runFlow(parseFlow("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: claude, prompt: 'SAY hi'}\n"), runOpts());
    const saved = JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8"));
    expect("skillLock" in saved).toBe(false);
    expect(existsSync(join(s.runDir, RUN_SKILL_LOCK_FILE))).toBe(false);
    const again = await resumeRun({ runId: s.runId, runsDir: join(tmp, "runs"), claudeBin, config, from: "a" });
    expect(again.status).toBe("succeeded");
    expect(existsSync(join(s.runDir, RUN_SKILL_LOCK_FILE))).toBe(false);
  });
});

describe("skills in a Claude session", () => {
  const codexBin = resolve("tests/fixtures/fake-codex.mjs");
  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  });

  const showFlow = (agentLine = "") =>
    parseFlow(`
name: t
workspace: inplace
steps:
  - id: risk_gate
    type: shell
    run: |
      # /skill-request
      echo READY
      echo '${REQUEST}'
  - id: impl
    type: claude
${agentLine}    prompt: |
      WRITE ran.txt yes
      SHOWPROMPT
`);
  const outputOf = (s: { history: { id: string; output: string }[] }) => s.history.find((h) => h.id === "impl")!.output;
  const split = (out: string) => ({ args: out.split("\nPROMPT<<")[0]!, prompt: out.split("\nPROMPT<<")[1] ?? "" });

  it.each([true, false])("gives the session the locked skill and nothing of the personal setup (isolate_agents %s)", async (isolate) => {
    demo("1.1.0", low, "Do it.", "allowed-tools: Bash(curl *) WebFetch\n");
    const personal = join(tmp, "claude-config");
    mkdirSync(join(personal, "skills", "personal"), { recursive: true });
    writeFileSync(join(personal, "skills", "personal", "SKILL.md"), "PERSONAL_SENTINEL");
    process.env.CLAUDE_CONFIG_DIR = personal;

    const s = await runFlow(showFlow(), { ...runOpts(), config: ConfigSchema.parse({ skills: { roots: [low] }, isolate_agents: isolate }) });
    expect(s.status).toBe("succeeded");
    const rec = s.history.find((h) => h.id === "impl")!;
    expect(rec.skills).toMatchObject({ loaded: ["demo@1.1.0"] });
    expect(rec.skills!.bytes).toBeGreaterThan(0);
    expect(rec.skills!.estimatedTokens).toBeLessThanOrEqual(15000);
    const { args, prompt } = split(outputOf(s));
    expect(prompt.startsWith('<foundry-skills count="1">')).toBe(true);
    expect(prompt).toContain('<foundry-skill id="demo" version="1.1.0"');
    expect(prompt).toContain("Do it.");
    expect(prompt.indexOf("<foundry-skills")).toBeLessThan(prompt.indexOf("WRITE ran.txt yes"));
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--setting-sources project,local");
    expect(args).toContain("--disable-slash-commands");
    expect(args).not.toContain("Do it.");
    expect(args).not.toContain("<foundry-skill id=");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("WebFetch");
    expect(outputOf(s)).not.toContain("PERSONAL_SENTINEL");
    expect(readdirSync(repo)).toEqual(["ran.txt"]);
  });

  it("gives a Codex step no block and records no skills", async () => {
    demo("1.0.0");
    const s = await runFlow(showFlow("    agent: codex\n"), { ...runOpts(), codexBin });
    expect(s.status).toBe("succeeded");
    expect(outputOf(s)).not.toContain("<foundry-skills");
    expect(s.history.find((h) => h.id === "impl")!.skills).toBeUndefined();
  });

  describe("a repair that continues the session", () => {
    const repairFlow = (fixLine = "") =>
      parseFlow(`
name: t
workspace: inplace
steps:
  - id: risk_gate
    type: shell
    run: |
      # /skill-request
      echo READY
      echo '${REQUEST}'
  - id: impl
    type: claude
    prompt: |
      WRITE ran.txt yes
      SHOWPROMPT
  - id: fix
    type: claude
    resume: impl
${fixLine}    prompt: |
      SHOWPROMPT
`);
    const count = (prompt: string) => prompt.split("<foundry-skills count=").length - 1;
    const out = (s: { history: { id: string; output: string }[] }, id: string) => split(s.history.filter((h) => h.id === id).at(-1)!.output);
    const rec = (s: { history: { id: string; skills?: unknown }[] }, id: string) => s.history.filter((h) => h.id === id).at(-1)!.skills as Record<string, unknown>;
    const resumeFrom = (runId: string, from: string, cfg = config) => resumeRun({ runId, runsDir: join(tmp, "runs"), claudeBin, config: cfg, from });

    it("adds only a reminder, keeps the isolation flags and logs it", async () => {
      demo("1.3.0", low, "Prefer small functions.");
      const s = await runFlow(repairFlow(), runOpts());
      expect(s.status).toBe("succeeded");
      const first = out(s, "impl");
      const second = out(s, "fix");
      expect(count(first.prompt)).toBe(1);
      expect(rec(s, "impl")).toMatchObject({ state: "loaded" });
      expect(second.args).toContain("--resume");
      expect(count(second.prompt)).toBe(0);
      expect(second.prompt).not.toContain("<foundry-skill id=");
      expect(second.prompt).not.toContain("Prefer small functions.");
      expect(second.prompt).toContain("still applies: demo@1.3.0");
      expect(rec(s, "fix")).toMatchObject({ state: "reused", digest: rec(s, "impl").digest, attachedBytes: 0, loaded: ["demo@1.3.0"] });
      expect(rec(s, "fix").bytes).toBe(rec(s, "impl").bytes);
      for (const flag of ["--setting-sources project,local", "--strict-mcp-config", "--disable-slash-commands"]) expect(second.args).toContain(flag);
      const log = readFileSync(join(s.runDir, "live.log"), "utf8");
      expect(log).toMatch(/skill context: loaded demo@1\.3\.0/);
      expect(log).toMatch(/skill context: reused demo@1\.3\.0 from the session of impl/);
      expect(log).not.toContain("Prefer small functions.");
    });

    it("a resume at the repair reuses the session; a resume at the start loads a new one once", async () => {
      demo("1.0.0");
      const s = await runFlow(repairFlow(), runOpts());
      demo("2.0.0", skills, "Do it better.");
      const a = await resumeFrom(s.runId, "fix");
      expect(rec(a, "fix")).toMatchObject({ state: "reused" });
      const b = await resumeFrom(s.runId, "impl");
      expect(count(out(b, "impl").prompt)).toBe(1);
      expect(count(out(b, "fix").prompt)).toBe(0);
      expect(rec(b, "impl")).toMatchObject({ state: "loaded", loaded: ["demo@1.0.0"] });
      expect(runJson(s.runDir).skillLock!.skills.map((k) => k.version)).toEqual(["1.0.0"]);
    });

    it("an older run without the mark gets the block once, as reloaded", async () => {
      demo("1.0.0");
      const s = await runFlow(repairFlow(), runOpts());
      const saved = JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8"));
      delete saved.state.steps.impl.skills_digest;
      writeFileSync(join(s.runDir, "run.json"), JSON.stringify(saved));
      const r = await resumeFrom(s.runId, "fix");
      expect(count(out(r, "fix").prompt)).toBe(1);
      expect(rec(r, "fix")).toMatchObject({ state: "reloaded" });
      expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toMatch(/skill context: reloaded demo@1\.0\.0.*new session/);
    });

    it.each([["another provider", "ollama:q"], ["another model of the same provider", "anthropic:haiku"]])("%s continues the session and reuses the block", async (_n, model) => {
      demo("1.0.0");
      const p = await runFlow(repairFlow(`    model: ${model}\n`), runOpts());
      expect(p.status).toBe("succeeded");
      expect(out(p, "fix").args).toContain("--resume");
      expect(count(out(p, "fix").prompt)).toBe(0);
      expect(rec(p, "fix")).toMatchObject({ state: "reused" });
    });

    it("a package that changed after the first session stops the repair before the agent starts", async () => {
      const dir = demo("1.0.0");
      const s = await runFlow(repairFlow(), runOpts());
      writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\ndescription: A test skill.\n---\n\nDo something else.\n");
      const r = await resumeFrom(s.runId, "fix");
      expect(r.status).toBe("failed");
      expect(r.reason).toMatch(/skill integrity: demo@1\.0\.0 changed/);
      expect(r.history.filter((h) => h.id === "fix").at(-1)!.sessionId).toBeUndefined();
      expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toContain("skill context: rejected");
    });

    it("a Codex repair gets no block and a later Claude repair still reuses the first session", async () => {
      demo("1.0.0");
      const f = repairFlow("    agent: codex\n");
      f.steps.push({ id: "fix2", type: "claude", resume: "impl", prompt: "SHOWPROMPT" } as never);
      const s = await runFlow(f, { ...runOpts(), codexBin });
      expect(s.status).toBe("succeeded");
      expect(s.history.find((h) => h.id === "fix")!.skills).toBeUndefined();
      expect(count(out(s, "fix").prompt)).toBe(0);
      expect(rec(s, "fix2")).toMatchObject({ state: "reused" });
    });
  });

  it("a run without a lock gets no block, no record and no isolation when the setting is off", async () => {
    const s = await runFlow(parseFlow("name: t\nworkspace: inplace\nsteps:\n  - {id: a, type: claude, prompt: 'SHOWPROMPT'}\n"), { ...runOpts(), config: ConfigSchema.parse({ isolate_agents: false }) });
    expect(s.history[0]!.skills).toBeUndefined();
    expect(s.history[0]!.output).not.toContain("<foundry-skills");
    expect(s.history[0]!.output).not.toContain("--setting-sources");
  });
});
