import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { allowRunCommand, applyAllowance, applyTransition, lifecycleCommand, runsLocking } from "../src/skills/lifecycle-cli.js";
import { skillsCommand } from "../src/skills/cli.js";
import { discoverSkills, clearSkillRegistryCache } from "../src/skills/registry.js";
import { RunSkillLockSchema, writeRunSkillLock } from "../src/skills/run-lock.js";

// `scf skills lifecycle` and `scf skills allow-run`, with real packages in a temporary data folder.

const saved = process.env.FACTORY_HOME;
const tmps: string[] = [];
let base: string;
let home: string;
let runsDir: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-cli-")));
  tmps.push(base);
  home = join(base, "home");
  runsDir = join(base, "elsewhere-runs");
  mkdirSync(runsDir);
  // The folder is named like the id, so a second version lives in a second root.
  for (const [root, id, v] of [[join(home, "skills"), "kafka", "1.0.0"], [join(base, "root1"), "kafka", "2.0.0"], [join(base, "repo", ".claude-factory", "skills"), "repo-skill", "1.0.0"]] as const) {
    const d = join(root, id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "SKILL.md"), `---\nname: ${id}\ndescription: A test skill called ${id}.\n---\n\nDo it.\n`);
    writeFileSync(join(d, "skill.yaml"), `id: ${id}\nversion: ${v}\n`);
  }
  process.env.FACTORY_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  clearSkillRegistryCache();
});

const skills = () => ConfigSchema.parse({ skills: { roots: [join(base, "root1")], repository: true, releases: { allow_unreleased: true } } }).skills;
async function cli(positionals: string[], values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals, values }, (l) => lines.push(l), { home, skills: skills(), repo: join(base, "repo"), builtinRoot: join(base, "none"), userHome: join(base, "user"), env: {} });
  return { code, lines, text: lines.join("\n") };
}
const lockRun = (runId: string, ...keys: string[]) => {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeRunSkillLock(dir, RunSkillLockSchema.parse({
    version: 1, runId, createdAt: "2026-01-01T00:00:00.000Z", planHash: `sha256:${"c".repeat(64)}`, estimatedTokens: 1,
    skills: keys.map((k) => ({ id: k.split("@")[0], version: k.split("@")[1], digest: `sha256:${"a".repeat(64)}`, source: "admin", role: "coder", selection: "requested", requiredBy: [], estimatedTokens: 1 })),
  }));
};
const K = "kafka@1.0.0";
const reasonOpt = { reason: "found a bug" };

describe("syntax is checked before anything is read", () => {
  it("refuses bad operands and options", async () => {
    const bad: [string[], Record<string, unknown>][] = [
      [["lifecycle", K, "retired"], {}],
      [["lifecycle", K, "retired"], { reason: "" }],
      [["lifecycle", K], reasonOpt],
      [["lifecycle", K, "gone"], reasonOpt],
      [["lifecycle", "nokey", "retired"], reasonOpt],
      [["lifecycle", K, "active"], { ...reasonOpt, replacement: "kafka@2.0.0" }],
      [["lifecycle", K, "retired"], { ...reasonOpt, replacement: "nokey" }],
      [["lifecycle", K, "retired", "extra"], reasonOpt],
      [["allow-run", "run-1", K], {}],
      [["allow-run", "run-1", K], { ...reasonOpt, replacement: "kafka@2.0.0" }],
      [["allow-run", "bad id!", K], reasonOpt],
      [["allow-run", "run-1", "nokey"], reasonOpt],
      [["allow-run", "run-1"], reasonOpt],
      [["pin", K, "sha256:" + "a".repeat(64)], reasonOpt],
    ];
    for (const [pos, values] of bad) {
      await expect(cli(pos, { "runs-dir": runsDir, ...values }), pos.join(" ") + JSON.stringify(values)).rejects.toThrow(/scf skills/);
    }
    // nothing was written
    expect(() => readFileSync(join(home, "skill-lifecycle.jsonl"))).toThrow();
  });
});

describe("scf skills lifecycle", () => {
  it("sets a state, prints the transition and the runs that lock the key; --runs-dir decides where it looks", async () => {
    lockRun("run-a", K);
    lockRun("run-b", "kafka@2.0.0");
    const r = await cli(["lifecycle", K, "quarantined"], { ...reasonOpt, "runs-dir": runsDir });
    expect(r.code, r.text).toBe(0);
    expect(r.lines).toEqual([
      `${K}: active → quarantined (#1)`,
      `RUN run-a locks ${K}: stops at its next agent step unless allowed with scf skills allow-run`,
      "OK",
    ]);
    // the default runs folder is <data>/runs, which has none of these runs
    const again = await cli(["lifecycle", K, "retired"], reasonOpt);
    expect(again.lines).toEqual([`${K}: quarantined → retired (#2)`, "OK"]);
  });

  it("refuses an unknown key, a repository skill, a bad replacement and a bad transition", async () => {
    expect((await cli(["lifecycle", "nope@1.0.0", "retired"], reasonOpt)).text).toContain("PROBLEM nope@1.0.0 is not installed");
    expect((await cli(["lifecycle", "repo-skill@1.0.0", "retired"], reasonOpt)).text).toContain("comes from the repository");
    expect((await cli(["lifecycle", K, "retired"], { ...reasonOpt, replacement: "nope@1.0.0" })).text).toContain("PROBLEM the replacement");
    expect((await cli(["lifecycle", K, "retired"], { ...reasonOpt, replacement: "repo-skill@1.0.0" })).code).toBe(1);
    expect((await cli(["lifecycle", "kafka@2.0.0", "retired"], reasonOpt)).code).toBe(0);
    expect((await cli(["lifecycle", K, "deprecated"], { ...reasonOpt, replacement: "kafka@2.0.0" })).code).toBe(1);
    expect((await cli(["lifecycle", "kafka@2.0.0", "retired"], reasonOpt)).text).toContain("PROBLEM the version is already retired");
    expect((await cli(["lifecycle", K, "revoked"], reasonOpt)).code).toBe(0);
    expect((await cli(["lifecycle", K, "active"], reasonOpt)).text).toContain("can never change state again");
    expect((await cli(["lifecycle", K, "deprecated"], { reason: "tab\there" })).code).toBe(1);
  });

  it("lists the states and the history of one key", async () => {
    expect((await cli(["lifecycle"])).lines).toEqual(["No skill has a lifecycle state"]);
    await cli(["lifecycle", K, "quarantined"], { ...reasonOpt, replacement: "kafka@2.0.0" });
    lockRun("run-a", K);
    await cli(["allow-run", "run-a", K], { reason: "needed", "runs-dir": runsDir });
    const list = (await cli(["lifecycle"])).lines;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatch(new RegExp(`^LIFECYCLE ${K} quarantined since \\S+ by cli: found a bug replaced by kafka@2\\.0\\.0, 1 run allowed$`));
    const hist = (await cli(["lifecycle", K])).lines;
    expect(hist[0]).toMatch(/^#1 \S+ cli active → quarantined: found a bug replaced by kafka@2\.0\.0$/);
    expect(hist[1]).toMatch(/^#2 \S+ cli allow-run run-a: needed$/);
    expect((await cli(["lifecycle", "kafka@2.0.0"])).lines).toEqual(["No lifecycle history for kafka@2.0.0"]);
  });

  it("shows the state in the skill list", async () => {
    await cli(["lifecycle", K, "retired"], { ...reasonOpt, replacement: "kafka@2.0.0" });
    const list = await cli([]);
    expect(list.lines.find((l) => /^kafka\s+1\.0\.0/.test(l))).toMatch(/ lifecycle retired → kafka@2\.0\.0$/);
    expect(list.lines.find((l) => /^kafka\s+2\.0\.0/.test(l))).not.toContain("lifecycle");
  });

  it("fails closed on a broken record, with the line number and without its content", async () => {
    writeFileSync(join(home, "skill-lifecycle.jsonl"), "this is not json\n");
    const list = await cli([]);
    expect(list.code).toBe(1);
    expect(list.text).toMatch(/PROBLEM skill lifecycle .*skill-lifecycle\.jsonl: the skill lifecycle record has a line that is not valid \(line 1\)/);
    expect(list.text).not.toContain("this is not json");
    for (const args of [["lifecycle"], ["lifecycle", K, "retired"], ["allow-run", "run-a", K]]) {
      const r = await cli(args, args.length === 1 ? {} : { ...reasonOpt, "runs-dir": runsDir });
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.text).toContain("line 1");
    }
  });
});

describe("scf skills allow-run", () => {
  it("finds the run in --runs-dir and lets it go on", async () => {
    lockRun("run-a", K);
    await cli(["lifecycle", K, "quarantined"], reasonOpt);
    const r = await cli(["allow-run", "run-a", K], { reason: "ok", "runs-dir": runsDir });
    expect(r.lines).toEqual([`ALLOWED run-a ${K} (#2). Resume the run to go on.`]);
    expect((await cli(["allow-run", "run-a", K], { reason: "ok", "runs-dir": runsDir })).lines).toEqual([`ALLOWED run-a ${K} (already, #2). Resume the run to go on.`]);
    expect((await cli(["allow-run", "run-a", K], { reason: "ok" })).text).toContain("PROBLEM no run run-a");
  });

  it("is refused for a run that does not lock the key, a missing run, and a version that is not quarantined", async () => {
    lockRun("run-a", "kafka@2.0.0");
    lockRun("run-b", K);
    await cli(["lifecycle", K, "quarantined"], reasonOpt);
    const o = { reason: "ok", "runs-dir": runsDir };
    expect((await cli(["allow-run", "run-a", K], o)).text).toContain("does not lock");
    expect((await cli(["allow-run", "run-zz", K], o)).text).toContain("PROBLEM no run run-zz");
    await cli(["lifecycle", K, "retired"], reasonOpt);
    expect((await cli(["allow-run", "run-b", K], o)).text).toContain(`${K} is not quarantined`);
  });
});

describe("with a release revocation", () => {
  const revoked = new Map([[K, { by: "acme@1.0.0", on: "2026-03-04", reason: "unsafe" }]]);
  const reg = () => ({ ...discoverSkills(skills(), { home, builtinRoot: join(base, "none"), userHome: join(base, "user"), env: {} }), revoked });
  const out = () => {
    const lines: string[] = [];
    return { lines, f: (l: string) => void lines.push(l) };
  };

  it("lists and explains it, refuses a new state and an allowance", () => {
    const o = { reg: reg(), runsDir, home };
    const a = out();
    expect(lifecycleCommand([], {}, a.f, o)).toBe(0);
    expect(a.lines).toEqual([`LIFECYCLE ${K} revoked since 2026-03-04 by release acme@1.0.0: unsafe`]);
    const b = out();
    lifecycleCommand([K], {}, b.f, o);
    expect(b.lines).toEqual(["release acme@1.0.0 revoked 2026-03-04: unsafe"]);
    const c = out();
    expect(lifecycleCommand([K, "retired"], { reason: "r" }, c.f, o)).toBe(1);
    expect(c.lines[0]).toBe(`PROBLEM ${K} is revoked by release acme@1.0.0`);
    lockRun("run-a", K);
    const d = out();
    expect(allowRunCommand(["run-a", K], { reason: "r" }, d.f, o)).toBe(1);
    expect(d.lines[0]).toContain("revoked by release");
    expect(applyAllowance(reg(), { runId: "run-a", key: K, reason: "r", by: "cli", runsDir })).toMatchObject({ status: "release-revoked" });
  });
});

describe("the shared helpers", () => {
  it("scan a runs folder for locks, and map the failures to statuses", () => {
    lockRun("run-a", K);
    lockRun("run-b", K, "kafka@2.0.0");
    mkdirSync(join(runsDir, "run-empty"));
    expect(runsLocking(runsDir, K)).toEqual({ runs: ["run-a", "run-b"], unreadable: false });
    expect(runsLocking(join(base, "missing"), K)).toEqual({ runs: [], unreadable: false });
    const reg = discoverSkills(skills(), { home, repo: join(base, "repo"), builtinRoot: join(base, "none"), userHome: join(base, "user"), env: {} });
    const t = (key: string, state: string, extra: object = {}) => applyTransition(reg, { key, state, reason: "r", by: "cli", runsDir, ...extra });
    expect(t("nokey", "retired")).toMatchObject({ status: "bad-input" });
    expect(t(K, "gone")).toMatchObject({ status: "bad-input" });
    expect(t("nope@1.0.0", "retired")).toMatchObject({ status: "unknown" });
    expect(t("repo-skill@1.0.0", "retired")).toMatchObject({ status: "unapproved" });
    expect(t(K, "retired", { replacement: "nope@1.0.0" })).toMatchObject({ status: "bad-replacement" });
    expect(t(K, "retired")).toMatchObject({ status: "ok", lockedRuns: [{ runId: "run-a" }, { runId: "run-b" }] });
    expect(applyAllowance(reg, { runId: "bad id!", key: K, reason: "r", by: "cli", runsDir })).toMatchObject({ status: "bad-input" });
  });
});
