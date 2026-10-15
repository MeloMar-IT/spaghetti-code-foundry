import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { evaluationLimits } from "../src/engine/eval-limits.js";
import { resetSandboxCache } from "../src/engine/os-sandbox.js";
import { effectWithAgent, type AgentEffectOptions } from "../src/skill-eval/effect.js";
import { EvaluationInterrupted, type Arm, type ArmContext, type ArmRun } from "../src/skill-eval/run.js";
import type { EffectOperands } from "../src/skills/effect.js";
import { parseEffectRecord } from "../src/skills/effect.js";
import { readNewestEffect } from "../src/skills/evaluation-store.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { sourceQualifiedId } from "../src/skills/normalize.js";
import { skillsCommand } from "../src/skills/cli.js";
import { clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";
import { claudeBin } from "./helpers/fake-github.js";

// `scf skills effect`, with the fake claude only. Refusals and the paths that need no agent run everywhere; the runs need macOS `sandbox-exec`.
const basic = process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
if (!basic) console.warn("skill-effect-agent sandbox tests skipped: they need macOS sandbox-exec");

const COMMIT = "a".repeat(40);
const TODAY = "2026-10-15";
const NOW = new Date("2026-10-15T10:00:00Z");
const RETRIEVED = "2026-10-01T10:00:00Z";
const KEY = "github.com/example/skills";
const MIT = LICENCE_TEMPLATES.find((t) => t.id === "MIT")!.text.replace("{name}", "the copyright holder");
const KAFKA_MD = readFileSync("skills/kafka/SKILL.md", "utf8");
const WRITES = `${KAFKA_MD}\nWRITE marker.txt ok\n`;
const sourcesYaml = [
  "schema: 1", "sources:", "  - id: lib", "    repository: https://github.com/example/skills", "    status: enabled",
  `    ref: {track: main, approved: '${COMMIT}'}`, "    paths: [skills]", "    adapter: agent-skills", "    trust: community", "    licence: {allow: [MIT]}",
  "    update: {cadence: weekly}", "    owner: '@octocat'", `    review: {by: '@octocat', on: '2026-01-01', commit: '${COMMIT}', licence: MIT}`, "",
].join("\n");
const kafka = (name: string, md: string = KAFKA_MD): Record<string, string> => ({
  [`skills/${name}/SKILL.md`]: md.replace(/^name: kafka$/m, `name: ${name}`),
  [`skills/${name}/skill.yaml`]: "version: 2.0.0\ncategory: interface\ncapabilities: [kafka]\nroles: [coder, reviewer]\nrisk: high\n",
});
function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}

// The runs make `scf-skill-eval-*` folders in TMPDIR. Each test gets its own TMPDIR, so other test files that run at the same time
// (skill-evaluate-agent.test.ts looks at the same folder names) never see them, and they never see ours.
const REAL_TMP = tmpdir();
const made: string[] = [];
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(REAL_TMP, "skilleffect-agent-")));
  made.push(d);
  return d;
};
const SKILLS = ConfigSchema.parse({ skills: { releases: { allow_unreleased: true } } }).skills;
const cfg = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ concurrency: 1, protected_branches: [], ...over });
const ENV = ["FACTORY_HOME", "SCF_HOME", "FACTORY_LOCK_DIR", "SCF_LOCK_DIR", "FACTORY_NO_NOTIFY", "FACTORY_NO_FAILURE_MODEL", "SCF_STEP_ENV_PASS", "FACTORY_STEP_ENV_PASS", "SCF_USER_SANDBOX", "FACTORY_USER_SANDBOX",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "TMPDIR"];
let saved: Record<string, string | undefined>;
let home: string;
let cwd: string;
let emptyBuiltin: string;
const evalFolders = () => readdirSync(tmpdir()).filter((n) => n.startsWith("scf-skill-eval-"));
let foldersBefore: string[];

/** The gate example suite plus one instructions scenario `mark` of 4 repeats. */
const writeSuite = (o: { repo?: string; check?: string; task?: string; repeat?: number } = {}) =>
  writeFileSync(
    join(cwd, "skill-evaluation.yaml"),
    readFileSync("evals/skill-gate/suite.yaml", "utf8") +
      `instructions:\n  repeat: ${o.repeat ?? 4}\n  scenarios:\n    - { id: mark, repo: ${o.repo ?? "fixtures/kins"}, task: ${JSON.stringify(o.task ?? "Do the thing")}, check: ${JSON.stringify(o.check ?? "test -f marker.txt")}, policy: { shell: true, network: false, filesystem: write }, timeout_sec: 60 }\n`,
  );

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  home = fresh();
  process.env.TMPDIR = fresh();
  process.env.FACTORY_HOME = home;
  process.env.ANTHROPIC_API_KEY = "sk-ant-dummy-0123456789";
  for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "SCF_USER_SANDBOX", "FACTORY_USER_SANDBOX"]) delete process.env[k];
  cwd = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml);
  cpSync("evals/skill-gate/fixtures", join(cwd, "fixtures"), { recursive: true });
  mkdirSync(join(cwd, "fixtures/ins"));
  writeFileSync(join(cwd, "fixtures/ins/README.md"), "# fixture\n");
  mkdirSync(join(cwd, "fixtures/kins"));
  writeFileSync(join(cwd, "fixtures/kins/README.md"), "# fixture\n");
  writeFileSync(join(cwd, "fixtures/kins/package.json"), '{"name":"orders","version":"1.0.0","dependencies":{"kafkajs":"2"}}\n');
  writeSuite();
  emptyBuiltin = fresh();
  foldersBefore = evalFolders();
  resetSandboxCache(true);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetSandboxCache();
  clearSkillRegistryCache();
  for (const d of made.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // gone
    }
    rmSync(d, { recursive: true, force: true });
  }
});

const source = (): SkillLibrarySource => {
  const r = readSources(join(cwd, "skill-sources.yaml"));
  if (r.state !== "ok") throw new Error("bad sources");
  return r.manifest.sources[0]!;
};
function stage(files: Record<string, string>, licence = true) {
  const t = tree(licence ? { LICENSE: MIT, ...files } : files);
  const prep = prepareImport(source(), t);
  if (!licence) return publishImport(prep, { home });
  const ev = prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t));
  return publishImport(addLicenceEvidence(prep, ev, RETRIEVED), { home });
}
const idOf = (name: string) => sourceQualifiedId({ source: "lib", repositoryKey: KEY }, name);
const discover = () => ({ home, builtinRoot: emptyBuiltin, env: {}, userHome: emptyBuiltin });
const staged = (name: string): EffectOperands => ({ kind: "staged", source: "lib", skill: idOf(name) });
async function effect(ops: EffectOperands, over: Partial<AgentEffectOptions> = {}) {
  const lines: string[] = [];
  const code = await effectWithAgent(ops, (l) => void lines.push(l), {
    cwd, home, today: TODAY, now: NOW, skills: SKILLS, discover: discover(), config: cfg(), claudeBin, ...over,
  });
  return { code, lines, text: lines.join("\n") };
}
const noRecords = () => expect(existsSync(join(home, "skill-effects"))).toBe(false);
const noFolders = () => expect(evalFolders()).toEqual(foldersBefore);
/** The only digest folder of a skill, and its newest record read back. */
function stored(id: string) {
  const hex = readdirSync(join(home, "skill-effects", id));
  expect(hex).toHaveLength(1);
  const digest = "sha256:" + hex[0];
  const read = readNewestEffect(id, digest, { home });
  if (read.state !== "ok") throw new Error("no valid record");
  return { digest, ...read };
}
/** An administrator skill (the built-in kafka folder under another id), pinned unless `pin` is false. */
async function approved(id: string, version: string, over: { md?: string; pin?: boolean } = {}) {
  const dir = join(home, "skills", id);
  cpSync("skills/kafka", dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), (over.md ?? KAFKA_MD).replace(/^name: kafka$/m, `name: ${id}`));
  writeFileSync(join(dir, "skill.yaml"), `id: ${id}\nversion: ${version}\ncategory: interface\ncapabilities: [kafka]\nroles: [coder, reviewer]\nrisk: high\n`);
  if (over.pin === false) return;
  const s = discoverSkills(SKILLS, discover()).byKey.get(`${id}@${version}`)!;
  await skillsCommand({ positionals: ["pin", `${id}@${version}`, s.digest], values: {} }, () => {}, { home, builtinRoot: emptyBuiltin, env: {}, userHome: emptyBuiltin, skills: SKILLS });
}

/** A runner that does not start anything: it records the arms it gets and returns runs of the given kind. */
function fakeRunner(over: { loaded?: boolean; throws?: boolean } = {}) {
  const calls: { skillId?: string; key: string; hasWrite: boolean; scenarios: string[]; repeat: number }[] = [];
  const runArm = async (arm: Arm, ctx: ArmContext) => {
    calls.push({ skillId: arm.skillId, key: arm.key, hasWrite: arm.write !== undefined, scenarios: ctx.suite.scenarios.map((s) => s.id), repeat: ctx.suite.repeat });
    if (over.throws) throw new EvaluationInterrupted();
    const runs: ArmRun[] = [];
    for (const s of ctx.suite.scenarios) {
      for (let attempt = 1; attempt <= ctx.suite.repeat; attempt++) {
        runs.push({ scenario: s.id, attempt, runId: `${arm.key.replace("@", "-")}-${s.id}-${attempt}`, score: 1, passed: true, loaded: arm.skillId !== undefined && (over.loaded ?? true), tokens: 10, durationMs: 100 });
      }
    }
    return { runs };
  };
  return { calls, runArm };
}

describe("without an agent run", () => {
  beforeEach(() => {
    stage(kafka("kafka"));
  });

  it("is never-selected, and starts nothing, when the skill is not offered for any scenario", async () => {
    writeSuite({ repo: "fixtures/ins", task: "Tidy the README." });
    const started = vi.fn();
    const r = await effect(staged("kafka"), { onRunStarted: started });
    expect(r.code, r.text).toBe(0);
    expect(r.lines.find((l) => l.startsWith("EFFECT "))).toMatch(/no-measurable-effect \(never-selected\): with 0\/0, without 0\/0/);
    expect(r.lines).toContain(`SKIPPED ${idOf("kafka")}@2.0.0 mark: not offered; not run`);
    expect(r.lines.some((l) => l.startsWith("RUN ") || l.startsWith("NOTE "))).toBe(false);
    expect(started).not.toHaveBeenCalled();
    noFolders();
    const rec = stored(idOf("kafka")).record;
    expect(rec.scenarios).toMatchObject([{ id: "mark", offered: false }]);
    expect(rec.runs).toEqual({ with: [], without: [] });
    expect(r.lines.at(-1)).toMatch(/^STORED skill-effects\/.+\/effect--0000000001\.json$/);
  });

  it("runs both arms on the offered scenarios even when the skill never loads, and says never-selected", async () => {
    const fake = fakeRunner({ loaded: false });
    const r = await effect(staged("kafka"), { runArm: fake.runArm });
    expect(r.code, r.text).toBe(0);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]).toMatchObject({ skillId: idOf("kafka"), hasWrite: true, scenarios: ["mark"], repeat: 4 });
    expect(fake.calls[1]).toMatchObject({ skillId: undefined, key: "no-skill", hasWrite: false, scenarios: ["mark"], repeat: 4 });
    const { record } = stored(idOf("kafka"));
    expect(record.runs.with).toHaveLength(4);
    expect(record.runs.without).toHaveLength(4);
    expect(record.verdict).toMatchObject({ verdict: "no-measurable-effect", reason: "never-selected", p: 1 });
    expect(r.lines.filter((l) => l.endsWith("(skill-not-loaded)"))).toHaveLength(4);
    expect(parseEffectRecord(JSON.parse(readFileSync(join(home, "skill-effects", idOf("kafka"), readdirSync(join(home, "skill-effects", idOf("kafka")))[0]!, "effect--0000000001.json"), "utf8")))).toHaveProperty("record");
    noFolders();
    expect(process.env.FACTORY_HOME).toBe(home);
  });

  it("prints INTERRUPTED, stores nothing and removes the temporary folder when an arm is interrupted", async () => {
    const fake = fakeRunner({ throws: true });
    let root = "";
    const r = await effect(staged("kafka"), { runArm: fake.runArm, onTempRoot: (d) => (root = d) });
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the evaluation was interrupted");
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
    noRecords();
    noFolders();
  });

  it("stores nothing when an arm reports a problem", async () => {
    const r = await effect(staged("kafka"), { runArm: async () => ({ problem: "scenario mark: the fixture step failed" }) });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/PROBLEM .*the fixture step failed; no record/);
    noRecords();
    noFolders();
  });

  describe("refusals", () => {
    const refused = async (ops: EffectOperands, text: RegExp, over: Partial<AgentEffectOptions> = {}) => {
      const started = vi.fn();
      const fake = fakeRunner();
      const r = await effect(ops, { onRunStarted: started, runArm: fake.runArm, ...over });
      expect(r.code).toBe(1);
      expect(r.lines.some((l) => l.startsWith("PROBLEM ") && text.test(l)), r.text).toBe(true);
      expect(r.lines.some((l) => l.startsWith("RUN ") || l.startsWith("NOTE ") || l.startsWith("STORED "))).toBe(false);
      expect(fake.calls).toHaveLength(0);
      expect(started).not.toHaveBeenCalled();
      noRecords();
      noFolders();
    };

    it("for a staged skill that is not in the import", async () => {
      await refused({ kind: "staged", source: "lib", skill: "nothing-here" }, /nothing-here is not a staged skill of lib/);
    });
    it("for a staged skill whose licence is not allowed", async () => {
      rmSync(join(home, "quarantine"), { recursive: true, force: true });
      rmSync(join(home, "skill-quarantine"), { recursive: true, force: true });
      for (const d of readdirSync(home)) if (d !== "skills") rmSync(join(home, d), { recursive: true, force: true });
      stage(kafka("kafka"), false);
      await refused(staged("kafka"), /licence/);
    });
    it("for an approved key that is unknown", async () => {
      await refused({ kind: "approved", id: "kafka-x", version: "1.0.0" }, /kafka-x@1\.0\.0 is not an active, approved and pinned skill/);
    });
    it("for an approved skill that is not pinned", async () => {
      await approved("kafka-x", "1.0.0", { pin: false });
      await refused({ kind: "approved", id: "kafka-x", version: "1.0.0" }, /is not an active, approved and pinned skill/);
    });
    it("without the OS sandbox", async () => {
      resetSandboxCache(false);
      await refused(staged("kafka"), /sandbox is not available.*scf skills effect runs only in the sandbox/);
    });
    it("for a suite without instructions scenarios", async () => {
      writeFileSync(join(cwd, "skill-evaluation.yaml"), readFileSync("evals/skill-gate/suite.yaml", "utf8"));
      await refused(staged("kafka"), /no instructions scenarios.*scf skills effect/);
    });
    it("without a model key", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      await refused(staged("kafka"), /no key on this server/);
    });
    it("for a model that is not Claude", async () => {
      await refused(staged("kafka"), /needs Claude Code/, { config: cfg({ default_model: "codex" }) });
    });
  });
});

describe.skipIf(!basic)("runs in the OS sandbox", () => {
  const tree = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort() : [];
  const bytes = () => [tree(join(home, "skills")), existsSync(join(home, "skills.lock.json")) ? readFileSync(join(home, "skills.lock.json"), "utf8") : ""];
  const restored = () => {
    expect(evaluationLimits()).toBeUndefined();
    expect(process.env.FACTORY_HOME).toBe(home);
    noFolders();
  };

  it("helps: the skill writes the marker, so 4/4 against 0/4; a second run adds a second record", async () => {
    stage(kafka("kafka", WRITES));
    writeSuite({ check: "test -f marker.txt" });
    const before = bytes();
    const ops = staged("kafka");
    const first = await effect(ops, { config: cfg({ concurrency: 4 }) });
    expect(first.code, first.text).toBe(0);
    expect(first.lines.filter((l) => l.startsWith("RUN "))).toHaveLength(8);
    expect(first.lines.filter((l) => l.startsWith("NOTE network: "))).toHaveLength(1);
    expect(first.lines.find((l) => l.startsWith("EFFECT "))).toMatch(/helps \(pass-rate-higher\): with 4\/4, without 0\/4, difference \+1\.00, p 0\.0286;/);
    expect(first.lines.at(-1)).toMatch(/^STORED skill-effects\/.+\/effect--0000000001\.json$/);
    expect(bytes()).toEqual(before);
    restored();

    const second = await effect(ops, { config: cfg({ concurrency: 4 }), now: new Date("2026-10-16T10:00:00Z") });
    expect(second.code, second.text).toBe(0);
    expect(second.lines.find((l) => l.startsWith("EFFECT "))).toMatch(/helps/);
    expect(second.lines.at(-1)).toMatch(/effect--0000000002\.json$/);
    const { record, digest } = stored(idOf("kafka"));
    expect(record).toMatchObject({ skill: { id: idOf("kafka"), source: "lib", commit: COMMIT }, runtime: { agent: "claude" }, ranAt: "2026-10-16T10:00:00Z" });
    expect(record.runs.with.every((r) => r.loaded && r.pass)).toBe(true);
    expect(record.runs.without.every((r) => !r.loaded && !r.pass)).toBe(true);
    const files = readdirSync(join(home, "skill-effects", idOf("kafka"), digest.slice(7)));
    expect(files.sort()).toEqual(["effect--0000000001.json", "effect--0000000002.json"]);
    expect(existsSync(join(home, "skill-evaluations"))).toBe(false);
    restored();
  }, 180_000);

  it("harms: an approved skill that writes a stray file, so 0/4 against 4/4", async () => {
    await approved("kafka-x", "1.0.0", { md: `${KAFKA_MD}\nWRITE bad.txt x\n` });
    writeSuite({ task: "WRITE marker.txt ok", check: "test -f marker.txt && test ! -f bad.txt" });
    const before = bytes();
    const r = await effect({ kind: "approved", id: "kafka-x", version: "1.0.0" }, { config: cfg({ concurrency: 4 }) });
    expect(r.code, r.text).toBe(0);
    expect(r.lines.find((l) => l.startsWith("EFFECT "))).toMatch(/harms \(pass-rate-lower\): with 0\/4, without 4\/4, difference -1\.00, p 0\.0286;/);
    const { record } = stored("kafka-x");
    expect(record.skill).toMatchObject({ id: "kafka-x", version: "1.0.0" });
    expect(record.skill.source).toBeUndefined();
    expect(bytes()).toEqual(before);
    restored();
  }, 180_000);

  it("on a signal during the without arm cancels running and queued jobs, waits for them, cleans up and stores nothing", async () => {
    stage(kafka("kafka", WRITES));
    // with the skill the marker exists and the check ends at once; without it the check hangs
    writeSuite({ check: "if test -f marker.txt; then true; else echo $$ > check.pid; exec sleep 30; fi" });
    const ctrl = new AbortController();
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const started: string[] = [];
    const before = bytes();
    let root = "";
    const done = effect(staged("kafka"), { config: cfg({ concurrency: 2 }), signal: ctrl.signal, onRunStarted: (id) => started.push(id), onTempRoot: (d) => (root = d) });
    let pidFiles: string[] = [];
    await vi.waitFor(() => {
      pidFiles = tree(root).filter((f) => f.endsWith("check.pid"));
      expect(pidFiles.length).toBeGreaterThanOrEqual(2);
      for (const f of pidFiles) expect(readFileSync(f, "utf8").trim()).not.toBe("");
    }, { timeout: 90_000, interval: 100 });
    const pids = pidFiles.map((f) => Number(readFileSync(f, "utf8").trim()));
    expect(started).toHaveLength(8); // four with the skill, four without: two running and two queued
    if (listeners[1] === 0) process.emit("SIGTERM");
    else ctrl.abort();
    const r = await done;
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the evaluation was interrupted");
    expect(r.lines.some((l) => l.startsWith("EFFECT ") || l.startsWith("STORED "))).toBe(false);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(existsSync(root)).toBe(false);
    noRecords();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    expect(bytes()).toEqual(before);
    restored();
  }, 180_000);
});
