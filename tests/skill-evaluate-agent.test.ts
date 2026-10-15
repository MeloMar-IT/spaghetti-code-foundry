import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { evaluationLimits } from "../src/engine/eval-limits.js";
import { commitIdentity, tokenVarNames } from "../src/engine/isolation.js";
import { resetSandboxCache } from "../src/engine/os-sandbox.js";
import { serverPassList } from "../src/engine/short-env.js";
import { skillEvaluateCommand } from "../src/skill-import/evaluate-cli.js";
import { instructionFixtureHash } from "../src/skills/evaluation-instructions.js";
import { skillsCommand } from "../src/skills/cli.js";
import type { EvaluationRecord } from "../src/skills/evaluation.js";
import { readNewestRecord } from "../src/skills/evaluation-store.js";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_TEMPLATES } from "../src/skills/licence-rules.js";
import { sourceQualifiedId } from "../src/skills/normalize.js";
import { clearSkillRegistryCache, discoverSkills } from "../src/skills/registry.js";
import { readSources, type SkillLibrarySource } from "../src/skills/sources.js";
import { cleanGitEnv, snapshotFixtures } from "../src/skill-eval/fixture.js";
import {
  agentEnvFor, evaluationConfig, evaluationFlow, EvaluationInterrupted, outboundFor, scenarioTools, scoreRun, switchDataFolder,
} from "../src/skill-eval/run.js";
import { scoreImportWithAgent, type AgentScoreOptions } from "../src/skill-eval/score.js";
import { toTarget, specOf } from "../src/agents/targets.js";
import { claudeBin } from "./helpers/fake-github.js";

// `scf skills score --agent`, with the fake claude only. Refusals and pure helpers run everywhere; the runs need macOS `sandbox-exec`.
const basic = process.platform === "darwin" && spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
if (!basic) console.warn("skill-evaluate-agent sandbox tests skipped: they need macOS sandbox-exec");

const COMMIT = "a".repeat(40);
const TODAY = "2026-10-13";
const NOW = new Date("2026-10-13T10:00:00Z");
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
const kafka = (name: string, over: { version?: string; caps?: string; md?: string } = {}): Record<string, string> => ({
  [`skills/${name}/SKILL.md`]: (over.md ?? KAFKA_MD).replace(/^name: kafka$/m, `name: ${name}`),
  [`skills/${name}/skill.yaml`]: `version: ${over.version ?? "2.0.0"}\ncategory: interface\ncapabilities: ${over.caps ?? "[kafka]"}\nroles: [coder, reviewer]\nrisk: high\n`,
});
function tree(files: Record<string, string>): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}

const made: string[] = [];
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skilleval-agent-")));
  made.push(d);
  return d;
};
const SKILLS = ConfigSchema.parse({ skills: { releases: { allow_unreleased: true } } }).skills;
const cfg = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ concurrency: 1, protected_branches: [], ...over });
const ENV = ["FACTORY_HOME", "SCF_HOME", "FACTORY_LOCK_DIR", "SCF_LOCK_DIR", "FACTORY_NO_NOTIFY", "FACTORY_NO_FAILURE_MODEL", "SCF_STEP_ENV_PASS", "FACTORY_STEP_ENV_PASS", "SCF_USER_SANDBOX", "FACTORY_USER_SANDBOX",
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CORP_KEY", "GH_TOKEN", "EVAL_BOT_TOKEN", "AWS_SECRET_ACCESS_KEY"];
let saved: Record<string, string | undefined>;
let home: string;
let cwd: string;
let emptyBuiltin: string;
const evalFolders = () => readdirSync(tmpdir()).filter((n) => n.startsWith("scf-skill-eval-"));
let foldersBefore: string[];

const suiteYaml = (ins?: { check?: string; task?: string; extra?: string }) =>
  readFileSync("evals/skill-gate/suite.yaml", "utf8") +
  (ins
    ? `instructions:\n  repeat: 3\n  scenarios:\n    - { id: mark, repo: fixtures/ins, task: ${JSON.stringify(ins.task ?? "Do the thing")}, check: ${JSON.stringify(ins.check ?? "test -f marker.txt")}, policy: { shell: true, network: false, filesystem: write }, timeout_sec: 60 }\n${ins.extra ?? ""}`
    : "");

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  home = fresh();
  process.env.FACTORY_HOME = home;
  process.env.ANTHROPIC_API_KEY = "sk-ant-dummy-0123456789";
  for (const k of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CORP_KEY", "SCF_USER_SANDBOX", "FACTORY_USER_SANDBOX"]) delete process.env[k];
  cwd = fresh();
  writeFileSync(join(cwd, "skill-sources.yaml"), sourcesYaml);
  cpSync("evals/skill-gate/fixtures", join(cwd, "fixtures"), { recursive: true });
  mkdirSync(join(cwd, "fixtures/ins"));
  writeFileSync(join(cwd, "fixtures/ins/README.md"), "# fixture\n");
  writeFileSync(join(cwd, "fixtures/ins/.gitignore"), "ignored.txt\n");
  writeFileSync(join(cwd, "fixtures/ins/ignored.txt"), "kept\n");
  writeFileSync(join(cwd, "skill-evaluation.yaml"), suiteYaml({}));
  emptyBuiltin = fresh();
  foldersBefore = evalFolders();
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
async function agent(over: Partial<AgentScoreOptions> = {}, id = "lib") {
  const lines: string[] = [];
  const code = await scoreImportWithAgent(id, undefined, (l) => void lines.push(l), {
    cwd, home, today: TODAY, now: NOW, skills: SKILLS, discover: discover(), config: cfg(), claudeBin, ...over,
  });
  return { code, lines, text: lines.join("\n") };
}
async function sub(name: "score" | "gate", values: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const code = await skillsCommand({ positionals: [name, "lib"], values }, (l) => void lines.push(l), { cwd, today: TODAY, now: NOW, skills: SKILLS, ...discover() });
  return { code, lines, text: lines.join("\n") };
}
const newest = (id: string) => {
  const r = readNewestRecord("lib", COMMIT, id, { home });
  if (r.state !== "ok") throw new Error("no record");
  return r.raw as EvaluationRecord;
};
const noRecords = () => expect(existsSync(join(home, "skill-evaluations"))).toBe(false);
const noFolders = () => expect(evalFolders()).toEqual(foldersBefore);
/** An approved, pinned administrator skill (the built-in kafka folder under another id). */
async function approved(id: string, version: string, caps = "[kafka]") {
  const dir = join(home, "skills", id);
  cpSync("skills/kafka", dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), KAFKA_MD.replace(/^name: kafka$/m, `name: ${id}`));
  writeFileSync(join(dir, "skill.yaml"), `id: ${id}\nversion: ${version}\ncategory: interface\ncapabilities: ${caps}\nroles: [coder, reviewer]\nrisk: high\n`);
  const s = discoverSkills(SKILLS, discover()).byKey.get(`${id}@${version}`)!;
  await skillsCommand({ positionals: ["pin", `${id}@${version}`, s.digest], values: {} }, () => {}, { home, builtinRoot: emptyBuiltin, env: {}, userHome: emptyBuiltin, skills: SKILLS });
}

describe("refusals (before anything starts)", () => {
  let staged = false;
  const refused = async (over: Partial<AgentScoreOptions>, text: RegExp) => {
    if (!staged) stage(kafka("kafka"));
    staged = true;
    const started = vi.fn();
    const r = await agent({ onRunStarted: started, ...over });
    expect(r.code).toBe(1);
    expect(r.lines.some((l) => l.startsWith("PROBLEM ") && text.test(l))).toBe(true);
    expect(r.lines.some((l) => l.startsWith("RUN ") || l.startsWith("NOTE "))).toBe(false);
    expect(started).not.toHaveBeenCalled();
    noRecords();
    noFolders();
  };
  beforeEach(() => {
    staged = false;
    resetSandboxCache(true);
  });

  it("without the OS sandbox", async () => {
    resetSandboxCache(false);
    await refused({}, /sandbox is not available/);
  });
  it("with SCF_USER_SANDBOX or FACTORY_USER_SANDBOX off", async () => {
    process.env.SCF_USER_SANDBOX = "off";
    await refused({}, /sandbox is switched off/);
    delete process.env.SCF_USER_SANDBOX;
    process.env.FACTORY_USER_SANDBOX = "off";
    await refused({}, /sandbox is switched off/);
  });
  it("for a suite without instructions", async () => {
    writeFileSync(join(cwd, "skill-evaluation.yaml"), suiteYaml());
    await refused({}, /no instructions scenarios/);
  });
  it("when the default model is not Claude", async () => {
    await refused({ config: cfg({ default_model: "codex" }) }, /needs Claude Code/);
  });
  it("without a model key", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await refused({}, /no key on this server/);
  });
  it("for a custom provider whose own key variable is unset, whatever else is set", async () => {
    const providers = { corp: { kind: "anthropic-compatible", base_url: "https://llm.example.com:8443", api_key_env: "CORP_KEY" } };
    await refused({ config: cfg({ providers, default_model: "corp:big" }) }, /CORP_KEY/);
  });
  it("accepts a custom provider with its key (a blocked candidate is skipped, nothing runs)", async () => {
    process.env.CORP_KEY = "corp-dummy-0123456789";
    stage(kafka("kafka"), false);
    staged = true;
    const providers = { corp: { kind: "anthropic-compatible", base_url: "https://llm.example.com:8443", api_key_env: "CORP_KEY" } };
    const started = vi.fn();
    const r = await agent({ config: cfg({ providers, default_model: "corp:big" }), onRunStarted: started });
    expect(r.lines.some((l) => l.startsWith(`SKIPPED ${idOf("kafka")}: `) && l.endsWith("; no agent run"))).toBe(true);
    expect(started).not.toHaveBeenCalled();
  });
  it("for more than 4 baselines", async () => {
    const caps = ["c1", "c2", "c3", "c4", "c5"];
    for (const [i, c] of caps.entries()) await approved(`old${i}`, "1.0.0", `[${c}]`);
    stage(kafka("kafka", { caps: `[${caps.join(", ")}]` }));
    staged = true;
    await refused({}, /5 baselines; at most 4/);
  });
  it("for a signal that was aborted already", async () => {
    await refused({ signal: AbortSignal.abort() }, /the evaluation was interrupted/);
  });
  it("when a fixture changed after the suite was read, and removes the folder it made", async () => {
    stage(kafka("kafka"));
    let root = "";
    const r = await agent({ onTempRoot: (d) => { root = d; writeFileSync(join(cwd, "fixtures/ins/README.md"), "changed\n"); } });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/PROBLEM instructions fixture fixtures\/ins does not match its hash/);
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
    noRecords();
  });
  it("when a fixture holds a .git entry", async () => {
    stage(kafka("kafka"));
    const r = await agent({ onTempRoot: () => mkdirSync(join(cwd, "fixtures/ins/.git")) });
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/holds a \.git entry/);
    noRecords();
    noFolders();
  });
});

describe("without --agent, and with a blocked candidate", () => {
  it("the output has no agent lines and the record has no agent block", async () => {
    stage(kafka("kafka"));
    writeFileSync(join(cwd, "skill-evaluation.yaml"), suiteYaml({}));
    const r = await sub("score");
    expect(r.code).toBe(0);
    expect(r.lines.some((l) => /^(RUN|NOTE|SKIPPED) /.test(l))).toBe(false);
    const rec = newest(idOf("kafka"));
    expect(rec.agent).toBeUndefined();
    expect(rec.dimensions.instructions).toBeUndefined();
  });
  it("skips a candidate whose licence is not allowed and writes the offline record", async () => {
    resetSandboxCache(true);
    stage(kafka("kafka"), false);
    writeFileSync(join(cwd, "skill-evaluation.yaml"), suiteYaml({}));
    const started = vi.fn();
    const r = await agent({ onRunStarted: started });
    expect(r.lines).toContain(`SKIPPED ${idOf("kafka")}: licence missing; no agent run`);
    expect(r.lines.some((l) => l.startsWith("SCORED "))).toBe(true);
    expect(started).not.toHaveBeenCalled();
    const rec = newest(idOf("kafka"));
    expect(rec.agent).toBeUndefined();
    noFolders();
  });
  it("scf skills score --agent goes to the agent runner given by the entry point, with the same operands", async () => {
    const calls: unknown[][] = [];
    const agentScore = async (...a: unknown[]) => (calls.push(a), 7);
    const lines: string[] = [];
    const code = await skillsCommand({ positionals: ["score", "lib", "s.yaml"], values: { agent: true } }, (l) => void lines.push(l), { cwd, today: TODAY, now: NOW, skills: SKILLS, agentScore, ...discover() } as never);
    expect(code).toBe(7);
    expect(calls[0]!.slice(0, 2)).toEqual(["lib", "s.yaml"]);
    await expect(skillsCommand({ positionals: ["gate", "lib"], values: { agent: true } }, () => {}, { cwd, agentScore } as never)).rejects.toThrow("unexpected option --agent");
  });
  it("scf skills evaluate --agent points to score", async () => {
    await expect(skillEvaluateCommand({ positionals: ["x"], values: { agent: true } }, () => {})).rejects.toThrow(/scf skills score/);
  });
});

describe("helpers", () => {
  const policy = (shell: boolean, network: boolean, filesystem: "read" | "write") => ({ shell, network, filesystem });
  it("scenarioTools follows the policy", () => {
    expect(scenarioTools(policy(false, false, "read"))).toEqual(["Read", "Glob", "Grep", "LS"]);
    expect(scenarioTools(policy(true, false, "write"))).toEqual(["Read", "Glob", "Grep", "LS", "Edit", "Write", "MultiEdit", "Bash"]);
    expect(scenarioTools(policy(false, true, "read"))).toEqual(["Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch"]);
  });
  it("outboundFor takes the port of the base URL", () => {
    expect(outboundFor({})).toEqual({ rule: "*:443", host: "api.anthropic.com:443", port: 443 });
    expect(outboundFor({ ANTHROPIC_BASE_URL: "https://LLM.example.com:8443/x" })).toMatchObject({ rule: "*:8443", host: "llm.example.com:8443" });
    expect(outboundFor({ ANTHROPIC_BASE_URL: "http://localhost:11434" })).toEqual({ rule: "localhost:11434", host: "localhost:11434", port: 11434 });
    expect(outboundFor({ ANTHROPIC_BASE_URL: "http://proxy.example.com" }).port).toBe(80);
  });
  it("evaluationConfig has a bot identity, reads only the fixtures and keeps the token variable name", () => {
    const real = cfg({ bot: { gh_token_env: "EVAL_BOT_TOKEN" }, sandbox: { user_read: ["/opt/creds"] }, router: { rules: [{ model: "haiku" }], fallback: ["sonnet"] } });
    const c = evaluationConfig(real, policy(true, false, "write"), ["/tmp/fx"]);
    expect(commitIdentity(c, "skill-evaluation")).toEqual({ name: "scf skill evaluation", email: "skill-evaluation@invalid" });
    expect(c.sandbox.user_read).toEqual(["/tmp/fx"]);
    expect(tokenVarNames(c)).toContain("EVAL_BOT_TOKEN");
    expect(c.router.rules).toEqual([]);
    expect(c.router.fallback).toEqual([]);
    expect(c.skills.builtin).toBe(false);
    expect(c.skills.tools).toMatchObject({ shell: true, filesystem: "write", missing: "degrade" });
  });
  it("evaluationFlow has the three boxed steps and the scenario's tools", () => {
    const f = evaluationFlow("s-a", { id: "mark", repo: "r", task: "t", check: "true", policy: policy(true, false, "write"), timeout_sec: 77 }, undefined);
    expect(f.workspace).toBe("empty");
    expect(f.skills).toEqual({ mode: "explicit", ids: ["s-a"] });
    expect(f.steps.map((s) => [s.id, s.timeout_sec])).toEqual([["fixture", 120], ["work", 77], ["check", 300]]);
    expect(f.steps[1]).toMatchObject({ permission_mode: "dontAsk", allowed_tools: ["Read", "Glob", "Grep", "LS", "Edit", "Write", "MultiEdit", "Bash"] });
  });
  it("the key check sees what the agent step would get", () => {
    const providers = { corp: { kind: "anthropic-compatible", base_url: "https://llm.example.com", api_key_env: "CORP_KEY" } };
    process.env.CORP_KEY = "k";
    const c = cfg({ providers, default_model: "corp:big" });
    const target = toTarget(specOf(c.default_model, c), c);
    expect(agentEnvFor(target, c, { ANTHROPIC_API_KEY: "x", CORP_KEY: "k" })).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "k", ANTHROPIC_BASE_URL: "https://llm.example.com" });
  });

  const step = (id: string, ok: boolean, extra: Record<string, unknown> = {}) => ({ id, type: "shell", visit: 1, ok, output: "", startedAt: "", durationMs: 0, logFile: "", ...extra });
  const loaded = { id: "s-a", version: "1.0.0", digest: "sha256:" + "a".repeat(64) };
  const summary = (status: string, history: ReturnType<typeof step>[], skills = true) =>
    ({ status, history: history.map((h) => (h.id === "work" && skills ? { ...h, type: "claude", skills: { loaded: ["s-a@1.0.0"], bytes: 1, estimatedTokens: 1, state: "loaded" } } : h)), skillLock: { skills: [loaded] } }) as never;
  it("scoreRun scores 1 only when fixture, work, check and the skill all succeed", () => {
    expect(scoreRun(summary("succeeded", [step("fixture", true), step("work", true), step("check", true)]), "s-a")).toEqual({ score: 1 });
    expect(scoreRun(summary("failed", [step("fixture", true), step("work", true), step("check", false)]), "s-a")).toEqual({ score: 0, finding: "check-failed" });
    expect(scoreRun(summary("failed", [step("fixture", true), step("work", false)]), "s-a")).toEqual({ score: 0, finding: "agent-failed" });
    expect(scoreRun(summary("succeeded", [step("fixture", true), step("work", true), step("check", true)], false), "s-a")).toEqual({ score: 0, finding: "skill-not-loaded" });
  });
  it("scoreRun reports a problem for an access failure, a broken fixture and a run that did not end", () => {
    expect(scoreRun(summary("failed", [step("fixture", true), step("work", false, { accessFailed: true })]), "s-a")).toHaveProperty("problem");
    expect(scoreRun(summary("failed", [step("fixture", false)]), "s-a")).toHaveProperty("problem");
    expect(scoreRun(summary("cancelled", [step("fixture", true)]), "s-a")).toHaveProperty("problem");
  });

  it("switchDataFolder sets the folder, flags and pass lists, and restores unset and set values exactly", () => {
    process.env.SCF_HOME = "/was/set";
    delete process.env.FACTORY_NO_NOTIFY;
    process.env.SCF_STEP_ENV_PASS = "AWS_SECRET_ACCESS_KEY";
    process.env.FACTORY_STEP_ENV_PASS = "X";
    const dir = fresh();
    const before = ENV.map((k) => process.env[k]);
    const restore = switchDataFolder(dir);
    expect([process.env.FACTORY_HOME, process.env.SCF_HOME]).toEqual([dir, dir]);
    expect([process.env.FACTORY_LOCK_DIR, process.env.SCF_LOCK_DIR]).toEqual([join(dir, "locks"), join(dir, "locks")]);
    expect([process.env.FACTORY_NO_NOTIFY, process.env.FACTORY_NO_FAILURE_MODEL]).toEqual(["1", "1"]);
    expect(serverPassList()).toEqual([]);
    restore();
    expect(ENV.map((k) => process.env[k])).toEqual(before);
    expect("FACTORY_NO_NOTIFY" in process.env).toBe(false);
  });
});

describe("fixture snapshots (real git)", () => {
  const suiteOf = (repo: string) => ({ mandatory: false, repeat: 3, scenarios: [{ id: "mark", repo, task: "t", check: "true", policy: { shell: true, network: false, filesystem: "write" as const }, timeout_sec: 60 }] });
  const hashOf = (dir: string) => (instructionFixtureHash(dir) as { hash: string }).hash;
  const snap = (repo: string, expected: string, signal = new AbortController().signal) => snapshotFixtures(cwd, suiteOf(repo), new Map([[repo, expected]]), fresh(), signal);

  it("keeps an ignored file and verifies the committed tree", async () => {
    const r = await snap("fixtures/ins", hashOf(join(cwd, "fixtures/ins")));
    expect(r).toHaveProperty("repos");
    const dir = (r as { repos: Map<string, string> }).repos.get("fixtures/ins")!;
    const tracked = spawnSync("git", ["ls-files"], { cwd: dir, encoding: "utf8", env: cleanGitEnv(process.env) }).stdout.split("\n");
    expect(tracked).toContain("ignored.txt");
  });
  it("refuses a .git entry before any git command, and a hash that differs", async () => {
    mkdirSync(join(cwd, "fixtures/ins/.git"));
    expect(await snap("fixtures/ins", "sha256:x")).toEqual({ problem: "instructions fixture fixtures/ins holds a .git entry" });
    rmSync(join(cwd, "fixtures/ins/.git"), { recursive: true });
    expect(await snap("fixtures/ins", "sha256:" + "0".repeat(64))).toEqual({ problem: "instructions fixture fixtures/ins does not match its hash" });
  });
  it("refuses a tree that git changes (an eol rule)", async () => {
    mkdirSync(join(cwd, "fixtures/eol"));
    writeFileSync(join(cwd, "fixtures/eol/a.txt"), "one\ntwo\n");
    writeFileSync(join(cwd, "fixtures/eol/.gitattributes"), "* text eol=crlf\n");
    const r = await snap("fixtures/eol", hashOf(join(cwd, "fixtures/eol")));
    expect(r).toEqual({ problem: "instructions fixture fixtures/eol does not match its hash after commit" });
  });
  it("waits for git to end when the signal aborts during preparation", async () => {
    const ctrl = new AbortController();
    const root = fresh();
    const p = snapshotFixtures(cwd, suiteOf("fixtures/ins"), new Map([["fixtures/ins", hashOf(join(cwd, "fixtures/ins"))]]), root, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(EvaluationInterrupted);
    const seen = readdirSync(root, { recursive: true }).length;
    await new Promise((r) => setTimeout(r, 300));
    expect(readdirSync(root, { recursive: true }).length).toBe(seen); // nothing still writes into the root
  });
  it("throws when the signal is aborted", async () => {
    await expect(snap("fixtures/ins", hashOf(join(cwd, "fixtures/ins")), AbortSignal.abort())).rejects.toBeInstanceOf(EvaluationInterrupted);
  });
});

describe.skipIf(!basic)("runs in the OS sandbox", () => {
  const BOT = "EVAL_BOT_TOKEN";
  beforeEach(() => {
    resetSandboxCache();
  });
  const suite = (check: string, task = "Do the thing") => writeFileSync(join(cwd, "skill-evaluation.yaml"), suiteYaml({ check, task }));
  const tree = (dir: string): string[] =>
    existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name)).sort() : [];
  const bytes = () => [tree(join(home, "skills")), existsSync(join(home, "skills.lock.json")) ? readFileSync(join(home, "skills.lock.json"), "utf8") : ""];

  it("scores a new candidate [1,1,1] and the gate passes it", async () => {
    stage(kafka("kafka", { md: WRITES }));
    suite("test -f marker.txt");
    const r = await agent();
    expect(r.code, r.text).toBe(0);
    expect(r.lines.filter((l) => l.startsWith("RUN "))).toHaveLength(3);
    expect(r.lines.filter((l) => l.startsWith("NOTE network: not host-limited; outbound is limited to port 443, not to the model's host"))).toHaveLength(1);
    const rec = newest(idOf("kafka"));
    expect(rec.dimensions.instructions).toEqual([1, 1, 1]);
    expect(rec.agent).toMatchObject({ sandbox: "os", network: "not-host-limited", outbound: ["api.anthropic.com:443"], repeat: 3, baselines: [] });
    expect(rec.agent!.runs).toHaveLength(3);
    expect(rec.runtime.agent).toBe("claude");
    expect(rec.runtime.model).toBeTruthy();
    expect(rec.evidence.map((e) => e.name)).toContain("agent-package");
    expect(evaluationLimits()).toBeUndefined();
    expect(process.env.FACTORY_HOME).toBe(home);
    noFolders();
    const g = await sub("gate");
    expect(g.lines[0]).toMatch(/^PASSED /);
  }, 90_000);

  it("pairs an upgrade with its baseline [0,0,0] and leaves the real skills and lock unchanged", async () => {
    await approved("kafka-old", "1.0.0");
    stage(kafka("kafka", { md: WRITES }));
    suite("test -f marker.txt");
    const before = bytes();
    const r = await agent();
    expect(r.code, r.text).toBe(0);
    expect(r.lines.filter((l) => l.startsWith("RUN "))).toHaveLength(6);
    const rec = newest(idOf("kafka"));
    expect(rec.dimensions.instructions).toEqual([1, 1, 1]);
    expect(rec.agent!.baselines).toHaveLength(1);
    expect(rec.agent!.baselines[0]).toMatchObject({ id: "kafka-old", dimensions: { instructions: [0, 0, 0] } });
    expect(bytes()).toEqual(before);
    const g = await sub("gate");
    expect(g.text).not.toMatch(/baseline-missing/);
  }, 120_000);

  it("keeps a baseline that a scenario names in `with` in the offline comparison", async () => {
    await approved("kafka-old", "1.0.0");
    stage(kafka("kafka", { md: WRITES }));
    writeFileSync(join(cwd, "skill-evaluation.yaml"), suiteYaml({}).replace("with: all", "with: [kafka-old]"));
    const r = await agent();
    expect(r.code, r.text).toBe(0);
    const rec = newest(idOf("kafka"));
    expect(rec.agent!.baselines[0]!.dimensions.conflicts).toEqual([1]);
    expect(r.text).not.toMatch(/compared-skill-missing/);
  }, 120_000);

  it("keeps GitHub tokens, the server pass list and the real lock folder out of the runs", async () => {
    stage(kafka("kafka", { md: WRITES }));
    process.env.GH_TOKEN = "ghp_dummytoken0123456789";
    process.env[BOT] = "ghp_dummybot0123456789";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-dummy-0123456789";
    process.env.SCF_STEP_ENV_PASS = "AWS_SECRET_ACCESS_KEY";
    process.env.FACTORY_STEP_ENV_PASS = "AWS_SECRET_ACCESS_KEY";
    mkdirSync(join(home, "locks"), { recursive: true });
    process.env.SCF_LOCK_DIR = join(home, "locks");
    const locks = readdirSync(join(home, "locks"));
    suite(`test -z "$GH_TOKEN" && test -z "$${BOT}" && test -z "$AWS_SECRET_ACCESS_KEY" && test -z "$SCF_STEP_ENV_PASS" && test -f marker.txt`);
    const r = await agent({ config: cfg({ bot: { gh_token_env: BOT } }) });
    expect(r.code, r.text).toBe(0);
    expect(newest(idOf("kafka")).dimensions.instructions).toEqual([1, 1, 1]);
    expect(readdirSync(join(home, "locks"))).toEqual(locks);
    expect(process.env.SCF_LOCK_DIR).toBe(join(home, "locks"));
    expect(process.env.SCF_STEP_ENV_PASS).toBe("AWS_SECRET_ACCESS_KEY");
    expect(process.env.FACTORY_STEP_ENV_PASS).toBe("AWS_SECRET_ACCESS_KEY");
  }, 90_000);

  it("keeps a credential folder of the real config closed, and the real config.yaml unreadable", async () => {
    stage(kafka("kafka", { md: WRITES }));
    const creds = fresh();
    writeFileSync(join(creds, "token"), "secret\n");
    suite(`! cat ${creds}/token && test -f marker.txt`);
    const r = await agent({ config: cfg({ sandbox: { user_read: [creds] } }) });
    expect(r.code, r.text).toBe(0);
    expect(newest(idOf("kafka")).dimensions.instructions).toEqual([1, 1, 1]);

    writeFileSync(join(home, "config.yaml"), "concurrency: 1\n");
    suite("true", `READ ${join(home, "config.yaml")}`);
    const bad = await agent({ now: new Date("2026-10-14T10:00:00Z") });
    expect(bad.code, bad.text).toBe(0);
    expect(bad.lines.filter((l) => l.includes("(agent-failed)"))).toHaveLength(3);
    expect(newest(idOf("kafka")).dimensions.instructions).toEqual([0, 0, 0]);
  }, 120_000);

  it("times out a hanging check and cleans up", async () => {
    stage(kafka("kafka", { md: WRITES }));
    suite("sleep 30");
    let root = "";
    const r = await agent({ config: cfg({ concurrency: 3 }), deadlines: { fixtureSec: 120, checkSec: 2 }, onTempRoot: (d) => (root = d) });
    expect(r.code, r.text).toBe(0);
    expect(r.lines.filter((l) => l.includes("(check-failed)"))).toHaveLength(3);
    expect(newest(idOf("kafka")).dimensions.instructions).toEqual([0, 0, 0]);
    expect(existsSync(root)).toBe(false);
    expect(process.env.FACTORY_HOME).toBe(home);
    expect(evaluationLimits()).toBeUndefined();
  }, 120_000);

  it("on a signal cancels running and queued jobs, waits for them, cleans up and writes no record", async () => {
    stage(kafka("kafka", { md: WRITES }));
    suite("echo $$ > check.pid; exec sleep 30");
    const ctrl = new AbortController();
    const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const started: string[] = [];
    let root = "";
    const done = agent({ signal: ctrl.signal, onRunStarted: (id) => started.push(id), onTempRoot: (d) => (root = d) });
    let pidFile = "";
    await vi.waitFor(() => {
      pidFile = tree(root).find((f) => f.endsWith("check.pid")) ?? "";
      expect(pidFile).not.toBe("");
      expect(readFileSync(pidFile, "utf8").trim()).not.toBe("");
    }, { timeout: 60_000, interval: 100 });
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(tree(root).filter((f) => f.endsWith("check.pid"))).toHaveLength(1);
    // the real signal path, unless the test runner has handlers of its own that a signal would reach
    if (listeners[1] === 0) process.emit("SIGTERM");
    else ctrl.abort();
    const r = await done;
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe("PROBLEM the evaluation was interrupted");
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    expect(existsSync(root)).toBe(false);
    noRecords();
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
    expect(process.env.FACTORY_HOME).toBe(home);
    expect(evaluationLimits()).toBeUndefined();
  }, 120_000);
});
