import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { workspaceSkillsDir } from "../src/home.js";
import { applyAllowance, runsLocking } from "../src/skills/lifecycle-cli.js";
import { skillsCommand } from "../src/skills/cli.js";
import { releaseList } from "../src/skills/release-cli.js";
import { cachedSkillRegistry, clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";
import { RunSkillLockSchema, writeRunSkillLock } from "../src/skills/run-lock.js";

// A skills folder per workspace (#825): the folder, the registry option and its cache, the run lookup of allowance and the lock lists, and the CLI.

const saved = process.env.FACTORY_HOME;
let base: string;
let home: string;
let runsDir: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ws-skills-")));
  home = join(base, "home");
  runsDir = join(home, "runs");
  mkdirSync(runsDir, { recursive: true });
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(base, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const skillsCfg = () => ConfigSchema.parse({ skills: { builtin: false, releases: { allow_unreleased: true } } }).skills;
const install = (root: string, id: string) => {
  const d = join(root, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
  writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: 1.0.0\n`);
};
const opts = (extra: object = {}) => ({ home, builtinRoot: join(base, "none"), userHome: join(base, "user"), env: {}, ...extra });
const runIn = (folder: string, runId: string, o: { workspace?: string; keys?: string[]; json?: boolean } = {}) => {
  const dir = join(folder, runId);
  mkdirSync(dir, { recursive: true });
  if (o.json !== false) writeFileSync(join(dir, "run.json"), JSON.stringify({ runId, ...(o.workspace ? { workspace: o.workspace } : {}) }));
  if (o.keys)
    writeRunSkillLock(dir, RunSkillLockSchema.parse({
      version: 1, runId, createdAt: "2026-01-01T00:00:00.000Z", planHash: `sha256:${"c".repeat(64)}`, estimatedTokens: 1,
      skills: o.keys.map((k) => ({ id: k.split("@")[0], version: k.split("@")[1], digest: `sha256:${"a".repeat(64)}`, source: "admin", role: "coder", selection: "requested", requiredBy: [], estimatedTokens: 1 })),
    }));
  return dir;
};
const teamRuns = (id = "team-a") => join(home, "workspaces", id, "runs");
const reg = (problems: object[] = []) => ({ byKey: new Map(), problems: problems as never, lifecycle: undefined, revoked: undefined });

describe("workspaceSkillsDir", () => {
  it("is the workspace folder for a team and the data folder otherwise", () => {
    expect(workspaceSkillsDir("team-a")).toBe(join(home, "workspaces", "team-a", "skills"));
    expect(workspaceSkillsDir("default")).toBe(join(home, "skills"));
    expect(workspaceSkillsDir(undefined)).toBe(join(home, "skills"));
    expect(workspaceSkillsDir("Bad_Id!")).toBe(join(home, "skills"));
  });
  it("refuses a link that leaves the data folder and accepts one inside", () => {
    mkdirSync(join(home, "workspaces", "team-a"), { recursive: true });
    mkdirSync(join(home, "shared"));
    symlinkSync(join(home, "shared"), join(home, "workspaces", "team-a", "skills"));
    expect(workspaceSkillsDir("team-a")).toBe(join(home, "workspaces", "team-a", "skills"));
    rmSync(join(home, "workspaces", "team-a", "skills"));
    symlinkSync(tmpdir(), join(home, "workspaces", "team-a", "skills"));
    expect(() => workspaceSkillsDir("team-a")).toThrow(/leaves the data folder/);
  });
});

describe("registry skillsDir", () => {
  it("reads the given folder instead of <home>/skills, and caches each one", () => {
    install(join(home, "skills"), "default-only");
    install(workspaceSkillsDir("team-a"), "team-only");
    const ids = (r: { skills: { id: string }[] }) => r.skills.map((s) => s.id);
    expect(ids(discoverSkills(skillsCfg(), opts({ skillsDir: workspaceSkillsDir("team-a") })))).toEqual(["team-only"]);
    expect(ids(discoverSkills(skillsCfg(), opts()))).toEqual(["default-only"]);
    const cfg = skillsCfg();
    const a = cachedSkillRegistry(cfg, 1000, 60_000, opts({ skillsDir: workspaceSkillsDir("team-a") }));
    const d = cachedSkillRegistry(cfg, 1000, 60_000, opts());
    expect(a).not.toBe(d);
    expect(cachedSkillRegistry(cfg, 1001, 60_000, opts({ skillsDir: workspaceSkillsDir("team-a") }))).toBe(a);
    expect(cachedSkillRegistry(cfg, 1001, 60_000, opts())).toBe(d);
  });
});

describe("run lookup over every runs folder", () => {
  it("runsLocking counts workspace runs and a duplicate id once", () => {
    runIn(runsDir, "r1", { keys: ["x@1.0.0"] });
    runIn(teamRuns(), "run-w", { workspace: "team-a", keys: ["x@1.0.0"] });
    runIn(teamRuns(), "r1", { workspace: "team-a", keys: ["x@1.0.0"] });
    expect(runsLocking(runsDir, "x@1.0.0").runs).toEqual(["r1", "run-w"]);
  });
  it("uses the first folder with a run.json, and a lock-only dir only as a fallback", () => {
    runIn(runsDir, "dup", { keys: ["a@1.0.0"] });
    runIn(teamRuns(), "dup", { workspace: "team-a", keys: ["b@1.0.0"] });
    runIn(runsDir, "lockonly", { keys: ["a@1.0.0"], json: false });
    expect(runsLocking(runsDir, "a@1.0.0").runs).toEqual(["dup", "lockonly"]);
    expect(runsLocking(runsDir, "b@1.0.0").runs).toEqual([]);
    const out: string[] = [];
    releaseList((l) => out.push(l), { home, runsDir, approved: [] });
    expect(out.join("\n")).not.toMatch(/b@1/);
  });
  it("allowance does not fall through to another folder's lock", () => {
    runIn(runsDir, "dup"); // run.json, no lock
    runIn(teamRuns(), "dup", { workspace: "team-a", keys: ["a@1.0.0"] });
    const r = applyAllowance(reg(), { runId: "dup", key: "a@1.0.0", reason: "x", by: "cli", runsDir });
    expect(r.status).toBe("no-run");
  });
  it("asks for the registry of the run's workspace", () => {
    runIn(teamRuns(), "run-w", { workspace: "team-a", keys: ["x@1.0.0"] });
    runIn(runsDir, "old-team", { workspace: "team-a", keys: ["x@1.0.0"] });
    runIn(runsDir, "plain", { keys: ["x@1.0.0"], json: false });
    const asked: string[] = [];
    const ask = (runId: string) => {
      applyAllowance((ws) => (asked.push(ws), reg()), { runId, key: "x@1.0.0", reason: "x", by: "cli", runsDir, waitMs: 0 });
      return asked.at(-1);
    };
    expect(ask("run-w")).toBe("team-a");
    expect(ask("old-team")).toBe("team-a");
    expect(ask("plain")).toBe("default");
    expect(ask("unknown")).toBe("default");
  });
  it("answers the failure of the workspace registry and writes no allowance", () => {
    runIn(teamRuns(), "run-w", { workspace: "team-a", keys: ["x@1.0.0"] });
    const bad = reg([{ kind: "lifecycle", reason: "the lifecycle record is broken" }]);
    const r = applyAllowance((ws) => (ws === "team-a" ? bad : reg()), { runId: "run-w", key: "x@1.0.0", reason: "x", by: "cli", runsDir, waitMs: 0 });
    expect(r.status).toBe("unreadable");
    expect(existsSync(join(home, "skill-lifecycle.jsonl"))).toBe(false);
  });
  it("a team run whose key is not quarantined reaches the lifecycle check, not no-run", () => {
    runIn(teamRuns(), "run-w", { workspace: "team-a", keys: ["x@1.0.0"] });
    const r = applyAllowance(() => reg(), { runId: "run-w", key: "x@1.0.0", reason: "x", by: "cli", runsDir, waitMs: 0 });
    expect(r.status).toBe("not-quarantined");
  });
});

describe("scf skills --workspace", () => {
  const cli = async (positionals: string[], values: Record<string, unknown>) => {
    const lines: string[] = [];
    const code = await skillsCommand({ positionals, values }, (l) => lines.push(l), { ...opts(), skills: skillsCfg() });
    return { code, text: lines.join("\n") };
  };
  it("lists and pins the skill of a workspace", async () => {
    install(workspaceSkillsDir("team-a"), "team-only");
    expect((await cli([], {})).text).not.toMatch(/team-only/);
    const listed = await cli([], { workspace: "team-a" });
    const digest = /team-only\s+1\.0\.0.*(sha256:[0-9a-f]{64})/.exec(listed.text)![1]!;
    const pin = await cli(["pin", "team-only@1.0.0", digest], { workspace: "team-a" });
    expect(pin.text).toContain("Pinned team-only@1.0.0");
  });
  it("refuses a bad id and refuses --workspace on allow-run", async () => {
    await expect(cli([], { workspace: "Bad!" })).rejects.toThrow(/--workspace must be a workspace id/);
    await expect(cli(["allow-run", "run-1", "x@1.0.0"], { workspace: "team-a", reason: "r" })).rejects.toThrow(/unexpected option --workspace/);
  });
});
