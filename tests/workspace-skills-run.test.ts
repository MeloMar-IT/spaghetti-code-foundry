import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { runFlow } from "../src/engine/runner.js";
import { loadRun, type RunSummary } from "../src/engine/state.js";
import { parseFlow } from "../src/flow/load.js";
import { workspaceSkillsDir } from "../src/home.js";
import { recordLifecycleTransition } from "../src/skills/lifecycle.js";
import { applyAllowance } from "../src/skills/lifecycle-cli.js";
import { readRunSkillLock } from "../src/skills/run-lock.js";
import { discoverSkills, pinSkill, clearSkillRegistryCache } from "../src/skills/registry.js";
import { runSkillCatalogue } from "../src/skills/run-catalogue.js";
import { runSkillView } from "../src/server/skill-view.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";

// A workspace-only skill end to end (#825): a team run uses <data>/workspaces/team-a/skills; a default run does not see it.
// Uses runFlow with the fake Claude binary; the data folder is temporary.

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const saved = process.env.FACTORY_HOME;
const savedKey = process.env.ANTHROPIC_API_KEY;
let data: string;
let runsDir: string;
let repo: string;
let teamSkills: string;
let defaultSkills: string;
// A team's run is always held by the OS sandbox (#785), so the runs here need macOS; they also need a commit name and the server's key.
const basic = process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
const cfg: Config = ConfigSchema.parse({ protected_branches: [], bot: { name: "Bot", email: "bot@example.com" }, skills: { builtin: false, releases: { allow_unreleased: true }, roots: [] } });
const TEAM_A = "workspaces:\n  - {id: team-a, name: Team A}\n";
const ID = "team-only";
const K = `${ID}@1.0.0`;

beforeEach(() => {
  data = realpathSync(mkdtempSync(join(tmpdir(), "ws-skills-run-")));
  process.env.FACTORY_HOME = data;
  process.env.ANTHROPIC_API_KEY = "dummy-key-for-a-fake-claude";
  runsDir = join(data, "runs");
  repo = join(data, "repo");
  teamSkills = workspaceSkillsDir("team-a");
  defaultSkills = join(data, "skills");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(data, "config.yaml"), TEAM_A);
  mkdirSync(teamSkills, { recursive: true });
  mkdirSync(defaultSkills, { recursive: true });
  const d = join(teamSkills, ID);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${ID}\ndescription: A test skill called ${ID}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${ID}\nversion: 1.0.0\n`);
  const reg = discoverSkills(cfg.skills, { skillsDir: teamSkills });
  pinSkill(reg, K, reg.byKey.get(K)!.digest);
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  clearSkillRegistryCache();
  rmSync(data, { recursive: true, force: true });
});

const line = (ids: string[]) => `SKILL_REQUEST: ${JSON.stringify({ version: 1, skills: ids.map((id) => ({ id, reason: "needed", evidence: ["issue:asks for it"] })) })}`;
const flow = (ids: string[]) =>
  parseFlow(
    [
      "name: t", "workspace: empty", "steps:",
      "  - id: risk_gate", "    type: shell", "    run: |",
      `      echo '${line(ids)}'`, "      # $FACTORY_TOOLS/skill-request",
      "  - id: implement", "    type: claude", "    prompt: do it",
      "  - id: finish", "    type: shell", "    run: echo done > marker.txt",
    ].join("\n"),
  );
const teamRunsDir = () => join(data, "workspaces", "team-a", "runs");
const start = (ids: string[], workspace?: string): Promise<RunSummary> =>
  runFlow(flow(ids), { task: "t", repo, runsDir, claudeBin, config: cfg, ...(workspace ? { workspace } : {}) });
const marker = (r: RunSummary) => existsSync(join(r.workdir!, "marker.txt"));

describe("a workspace-only skill", () => {
  it.skipIf(!basic)("runs in its team, and the lock holds it", async () => {
    const r = await start([ID], "team-a");
    expect(r.status).toBe("succeeded");
    expect(marker(r)).toBe(true);
    const lock = readRunSkillLock(r.runDir);
    expect(lock.ok && lock.lock.skills.map((s) => `${s.id}@${s.version}`)).toEqual([K]);
  });

  it("stops in a default run, which does not see the team folder", async () => {
    const r = await start([ID]);
    expect(r.status).toBe("stopped");
    expect(r.reason).toMatch(/^skills not resolved:/);
    expect(marker(r)).toBe(false);
  });

  it.skipIf(!basic)("stops a team run when the team skills folder is a link out of the data folder", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ws-outside-"));
    rmSync(teamSkills, { recursive: true, force: true });
    symlinkSync(outside, teamSkills);
    try {
      const r = await start([ID], "team-a");
      expect(r.status).toBe("stopped");
      expect(r.reason).toMatch(/skill/);
      expect(marker(r)).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(!basic)("the run page shows the skill as verified, with a lock that is ok", async () => {
    const r = await start([ID], "team-a");
    const run = loadRun(teamRunsDir(), r.runId)!;
    const view = runSkillView(run, {
      admin: true,
      registry: () => ({ registry: discoverSkills(cfg.skills, { skillsDir: workspaceSkillsDir(run.workspace) }) }),
    });
    expect(view?.lock).toBe("ok");
    expect(view?.resolved.find((s) => s.id === ID)?.integrity).toBe("verified");
  });

  it("the run page checked against the data folder does not verify the team skill", async () => {
    const r = await start([ID], "team-a");
    const run = loadRun(teamRunsDir(), r.runId)!;
    const view = runSkillView(run, {
      admin: true,
      registry: () => ({ registry: discoverSkills(cfg.skills, { skillsDir: defaultSkills }) }),
    });
    expect(view?.resolved.find((s) => s.id === ID)?.integrity).not.toBe("verified");
  });

  it.skipIf(!basic)("a quarantined team skill is allowed for its run, through the team registry", async () => {
    const r = await start([ID], "team-a");
    const q = recordLifecycleTransition({ key: K, to: "quarantined", reason: "found a bug", by: "cli", waitMs: 0 });
    expect(q.status).toBe("ok");
    const asked: string[] = [];
    const res = applyAllowance(
      (ws) => (asked.push(ws), discoverSkills(cfg.skills, { skillsDir: workspaceSkillsDir(ws) })),
      { runId: r.runId, key: K, reason: "needed", by: "cli", runsDir, waitMs: 0 },
    );
    expect(asked).toEqual(["team-a"]);
    expect(res.status).toBe("ok");
  });

  it("a catalogue of a team run offers the team skill and a default one does not", () => {
    const profile = () => buildRepoProfile(repo);
    const task = "t";
    const team = runSkillCatalogue({ workdir: repo, config: cfg, task }, { profile, discover: (s) => discoverSkills(s, { skillsDir: teamSkills }) });
    const plain = runSkillCatalogue({ workdir: repo, config: cfg, task }, { profile, discover: (s) => discoverSkills(s, { skillsDir: defaultSkills }) });
    expect(team.text).toContain(ID);
    expect(plain.text).not.toContain(ID);
  });
});
