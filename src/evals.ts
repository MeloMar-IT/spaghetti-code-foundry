import { execFileSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import type { Config } from "./config.js";
import { BASELINE_RULE_IDS } from "./policy/baseline.js";
import { evalLive, homeInputs, suiteInputs, type EvalInputs } from "./eval-inputs.js";
import { FakeSecretSchema, registerFakeSecrets } from "./eval-secrets.js";
import { ControlsExpectSchema, evaluateControls, readControlsInput, type ControlsResult } from "./eval-controls.js";
import type { RunSummary } from "./engine/state.js";
import { FACTORY_HOME, loadFlow, parseFlow } from "./flow/load.js";
import type { Flow } from "./flow/schema.js";
import { Scheduler } from "./queue/scheduler.js";
import { evaluateSkillRun, SkillExpectSchema, type SkillEvalResult } from "./skills/eval.js";
import { runShell } from "./steps/shell.js";

const CaseSchema = z
  .object({
    name: z.string().regex(/^[\w.-]+$/),
    /** Plain directory (turned into a git repo), local git repo, or git URL — relative to the suite file. */
    repo: z.string(),
    task: z.string().default(""),
    vars: z.record(z.string(), z.string()).default({}),
    /** Shell command run in the workspace afterwards; exit 0 = pass. Default: the run succeeded. */
    check: z.string().optional(),
    /** Skill checks: skills that must be selected or absent, and the context budget. Reported apart from the check. */
    skills: SkillExpectSchema.optional(),
    /** Control checks: policy decisions, tools, privileges, evidence and output the run must (not) show. */
    controls: ControlsExpectSchema.optional(),
    /** A fresh copy of the fixture with its own local bare repository as `origin`, per run; the check sees its path in `$FACTORY_EVAL_REMOTE`. Plain fixture folders only. */
    fake_remote: z.boolean().default(false),
    /** A fake key set in the server's environment for the eval and hidden in logs, outputs and the stored diff. */
    fake_secret: FakeSecretSchema.optional(),
    /** Start the runs as a user's run (short environment, no sign-in). The flow needs `workspace: empty` and clones `$FACTORY_VAR_EVAL_REPO`. */
    user_run: z.boolean().default(false),
  })
  .strict();

export const SuiteConfigSchema = z
  .object({
    protected_branches: z.array(z.string().min(1).max(255)).max(100).optional(),
    secret_scan: z.boolean().optional(),
    policy: z
      .object({
        enforce: z
          .array(z.enum(BASELINE_RULE_IDS))
          .refine((l) => new Set(l).size === l.length, "names the same rule twice")
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SuiteConfig = z.infer<typeof SuiteConfigSchema>;

export const SuiteSchema = z
  .object({
    name: z.string().regex(/^[\w.-]+$/),
    description: z.string().optional(),
    flows: z.array(z.string()).min(1),
    /** Optional: run every flow once per model (overrides all claude steps). */
    models: z.array(z.string()).optional(),
    repeat: z.number().int().positive().max(20).default(1),
    /** Fake programs for offline suites, relative to the suite file. */
    programs: z.object({ claude: z.string().min(1).max(500).optional(), codex: z.string().min(1).max(500).optional(), gh: z.string().min(1).max(500).optional() }).strict().optional(),
    /** Settings this suite runs with, over the config it is given (only these keys). */
    config: SuiteConfigSchema.optional(),
    cases: z.array(CaseSchema).min(1),
  })
  .strict();

export type Suite = z.infer<typeof SuiteSchema>;

export interface EvalResult {
  variant: string;
  case: string;
  attempt: number;
  runId: string;
  status: RunSummary["status"];
  /** Overall verdict: quality, and the skill checks when the case has them. */
  passed: boolean;
  /** Output quality alone (the check, or the run succeeded). Absent in older reports: then it equals `passed`. */
  quality?: boolean;
  /** Selection, context and activation verdicts. Only for cases with `skills`. */
  skills?: SkillEvalResult;
  /** Control verdicts. Only for cases with `controls`; `passed` needs `controls.ok`. */
  controls?: ControlsResult;
  checkOutput?: string;
  costUsd: number;
  tokens: number;
  minutes: number;
  fixLoops: number;
}

export interface VariantSummary {
  variant: string;
  runs: number;
  passRate: number;
  qualityRate?: number;
  /** Rates over the results that have skill checks. Absent when the variant has none. */
  skills?: { runs: number; selectionRate: number; contextRate: number; activationRate: number };
  /** Rates over the results that have control checks. Absent when the variant has none. */
  controls?: { runs: number; okRate: number; policyConformanceRate: number; evidenceCompletenessRate: number };
  avgCostUsd: number;
  avgTokens: number;
  avgMinutes: number;
  avgFixLoops: number;
}

export interface EvalReport {
  suite: string;
  startedAt: string;
  finishedAt: string;
  /** What the eval ran against. Absent in reports from before #640. */
  inputs?: EvalInputs;
  results: EvalResult[];
  summary: VariantSummary[];
}

/** The account a `user_run` case starts its runs as: it has no user record, so it counts as a plain user. */
export const EVAL_USER = "safety-evaluation";

export const evalsDir = () => join(process.env.FACTORY_HOME ?? FACTORY_HOME, "evals");

export function loadSuite(path: string): Suite {
  const res = SuiteSchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!res.success) throw new Error(`${path}: invalid suite\n${res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return res.data;
}

/** Force one model spec (e.g. sonnet, codex:gpt-5, ollama:qwen3-coder) on every agent step. */
export function withModel(flow: Flow, model: string): Flow {
  const f = structuredClone(flow);
  f.name = `${flow.name}@${model}`;
  f.defaults.model = model;
  delete f.defaults.agent;
  delete f.defaults.provider;
  for (const s of f.steps) {
    if (s.type !== "claude") continue;
    s.model = model;
    delete s.agent;
    delete s.provider;
  }
  return f;
}

/** The config with the suite's settings over it. Without settings it is the same object; the input is never changed. */
export function withSuiteConfig(config: Config, over: SuiteConfig | undefined): Config {
  if (!over) return config;
  return {
    ...config,
    ...(over.protected_branches ? { protected_branches: [...over.protected_branches] } : {}),
    ...(over.secret_scan !== undefined ? { secret_scan: over.secret_scan } : {}),
    ...(over.policy?.enforce ? { policy: { ...config.policy, enforce: [...over.policy.enforce] } } : {}),
  };
}

export interface CaseRepo {
  dir: string;
  /** The local bare repository that is `origin` of `dir`. Only with `fake_remote`. */
  remote?: string;
}

const gitIn = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" });

/** Copies a fixture folder to a new temp dir and commits it. */
function copyFixture(src: string, branch?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `factory-eval-${basename(src)}-`));
  cpSync(src, dir, { recursive: true });
  gitIn(dir, "init", "-q", ...(branch ? ["-b", branch] : []));
  gitIn(dir, "add", "-A");
  gitIn(dir, "-c", "user.email=eval@factory", "-c", "user.name=eval", "commit", "-qm", "fixture");
  return dir;
}

/** A git repo for the case: fixtures are copied and committed, URLs cloned once per eval. With `fakeRemote` the copy is new every time, with its own bare `origin`. */
export function prepareRepo(spec: string, suiteDir: string, cache: Map<string, CaseRepo>, fakeRemote = false): CaseRepo {
  if (!fakeRemote && cache.has(spec)) return cache.get(spec)!;
  const isUrl = /^(https?:|git@|ssh:)/.test(spec);
  const src = isUrl ? spec : resolve(suiteDir, spec);
  if (fakeRemote && (isUrl || existsSync(join(src, ".git")))) throw new Error(`case repo ${spec}: fake_remote needs a plain fixture folder`);
  let repo: CaseRepo;
  if (isUrl) {
    const dir = mkdtempSync(join(tmpdir(), "factory-eval-"));
    gitIn(dir, "clone", "-q", spec, ".");
    repo = { dir };
  } else {
    if (!existsSync(src)) throw new Error(`case repo not found: ${src}`);
    if (existsSync(join(src, ".git"))) repo = { dir: src };
    else if (!fakeRemote) repo = { dir: copyFixture(src) };
    else {
      const dir = copyFixture(src, "main");
      const remote = mkdtempSync(join(tmpdir(), "factory-eval-remote-"));
      gitIn(remote, "init", "-q", "--bare");
      gitIn(dir, "remote", "add", "origin", remote);
      gitIn(dir, "-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD");
      return { dir, remote };
    }
  }
  cache.set(spec, repo);
  return repo;
}

export function summarize(results: EvalResult[]): VariantSummary[] {
  const by = new Map<string, EvalResult[]>();
  for (const r of results) by.set(r.variant, [...(by.get(r.variant) ?? []), r]);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
  const rate = (rs: EvalResult[], f: (r: EvalResult) => boolean) => round(rs.filter(f).length / rs.length, 3);
  return [...by].map(([variant, rs]): VariantSummary => {
    const withSkills = rs.filter((r) => r.skills);
    const withControls = rs.filter((r) => r.controls);
    return {
    variant,
    runs: rs.length,
    passRate: round(rs.filter((r) => r.passed).length / rs.length, 3),
    qualityRate: rate(rs, (r) => r.quality ?? r.passed),
    ...(withSkills.length ? { skills: {
      runs: withSkills.length,
      selectionRate: rate(withSkills, (r) => r.skills!.selection.ok),
      contextRate: rate(withSkills, (r) => r.skills!.context.ok),
      activationRate: rate(withSkills, (r) => r.skills!.activation.ok),
    } } : {}),
    ...(withControls.length ? { controls: {
      runs: withControls.length,
      okRate: rate(withControls, (r) => r.controls!.ok),
      policyConformanceRate: rate(withControls, (r) => r.controls!.policyOk),
      evidenceCompletenessRate: rate(withControls, (r) => r.controls!.evidenceOk),
    } } : {}),
    avgCostUsd: round(avg(rs.map((r) => r.costUsd))),
    avgTokens: Math.round(avg(rs.map((r) => r.tokens ?? 0))),
    avgMinutes: round(avg(rs.map((r) => r.minutes)), 2),
    avgFixLoops: round(avg(rs.map((r) => r.fixLoops)), 2),
    };
  });
}

/** The controls table and the first mismatch of each failed result, for `scf eval`. Empty when no result has controls. */
export function controlsReportText(report: Pick<EvalReport, "results" | "summary">): string {
  const rows = report.summary.filter((v) => v.controls);
  if (!rows.length) return "";
  const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(10);
  const head = `${"variant".padEnd(34)} ${"controls".padStart(10)} ${"policy".padStart(10)} ${"evidence".padStart(10)}`;
  const lines = rows.map((v) => `${v.variant.padEnd(34)} ${pct(v.controls!.okRate)} ${pct(v.controls!.policyConformanceRate)} ${pct(v.controls!.evidenceCompletenessRate)}`);
  const failed = report.results.filter((r) => r.controls && !r.controls.ok).map((r) => `✘ ${r.variant} · ${r.case}#${r.attempt} · ${r.controls!.firstMismatch?.message ?? "controls failed"}`);
  return `\n${head}\n${lines.join("\n")}\n${failed.length ? `${failed.join("\n")}\n` : ""}`;
}

interface Programs {
  claudeBin?: string;
  codexBin?: string;
  ghBin?: string;
}

/** The programs a run uses: the given ones win; a suite's `programs` are resolved against the suite folder and must be executable files. */
export function suitePrograms(suite: Pick<Suite, "programs">, suiteDir: string, given: Programs): Programs {
  const out: Programs = {};
  const keys = [["claude", "claudeBin"], ["codex", "codexBin"], ["gh", "ghBin"]] as const;
  for (const [key, bin] of keys) {
    if (given[bin]) {
      out[bin] = given[bin];
      continue;
    }
    const p = suite.programs?.[key];
    if (!p) continue;
    const path = resolve(suiteDir, p);
    try {
      accessSync(path, constants.X_OK);
      if (!statSync(path).isFile()) throw new Error("not a file");
    } catch {
      throw new Error(`programs.${key}: not an executable file: ${path}`);
    }
    out[bin] = path;
  }
  return out;
}

/** A flow entry that is a file (`flow.yaml`) next to the suite is loaded from there; any other entry is a flow name. */
export function loadSuiteFlow(name: string, suiteDir: string): Flow {
  if (/\.ya?ml$/.test(name)) {
    const path = resolve(suiteDir, name);
    if (existsSync(path)) return parseFlow(readFileSync(path, "utf8"), path);
  }
  return loadFlow(name, suiteDir).flow;
}

export async function runEval(o: {
  suitePath: string;
  runsDir: string;
  config: Config;
  flowsFilter?: string[];
  modelsOverride?: string[];
  claudeBin?: string;
  codexBin?: string;
  ghBin?: string;
  /** Run only the first n cases of the suite. */
  maxCases?: number;
  log: (m: string) => void;
}): Promise<{ report: EvalReport; file: string }> {
  const suite = loadSuite(o.suitePath);
  const suiteDir = dirname(resolve(o.suitePath));
  const programs = suitePrograms(suite, suiteDir, o);
  const cases = o.maxCases ? suite.cases.slice(0, o.maxCases) : suite.cases;
  const flowNames = o.flowsFilter?.length ? o.flowsFilter : suite.flows;
  const models = o.modelsOverride?.length ? o.modelsOverride : suite.models;
  const base = flowNames.map((entry) => ({ entry, flow: loadSuiteFlow(entry, suiteDir) }));
  const variants: Flow[] = base.flatMap(({ flow }) => (models?.length ? models.map((m) => withModel(flow, m)) : [flow])).map((f) => ({ ...f, one_per_repo: false })); // cases get their own worktrees: run them in parallel
  for (const c of cases) {
    if (c.user_run && variants.some((f) => f.workspace !== "empty")) throw new Error(`case ${c.name}: user_run needs flows with workspace: empty (a user's run may not use a worktree)`);
  }
  // Routing rules would override the model under test.
  const config = withSuiteConfig(models?.length ? { ...o.config, router: { ...o.config.router, rules: [] } } : o.config, suite.config);
  // Prepare every repo before the first run starts: a failure here must not leave live runs behind.
  const repos = new Map<string, CaseRepo>();
  for (const c of cases) if (!c.fake_remote) prepareRepo(c.repo, suiteDir, repos);
  // What the report is about: taken now, before the first run, so it is the home folder as the eval runs in it.
  const inputs: EvalInputs = { version: 1, live: evalLive(suite, o.claudeBin), ...suiteInputs(suite, suiteDir, base, cases.map((c) => c.name), models), components: homeInputs() };
  // A fake remote is per run: every run gets its own copy and bare remote, made here, before any run is submitted.
  const perRun = new Map<string, CaseRepo>();
  const runKey = (v: number, ci: number, attempt: number) => `${v}:${ci}:${attempt}`;
  const copies: CaseRepo[] = [];
  try {
    variants.forEach((_, v) => cases.forEach((c, ci) => {
      if (!c.fake_remote) return;
      for (let attempt = 1; attempt <= suite.repeat; attempt++) {
        const r = prepareRepo(c.repo, suiteDir, new Map(), true);
        copies.push(r);
        perRun.set(runKey(v, ci, attempt), r);
      }
    }));
  } catch (e) {
    for (const r of copies) for (const d of [r.dir, r.remote]) if (d) rmSync(d, { recursive: true, force: true });
    throw e;
  }
  // The fake `gh` is found by name, so it goes first on the PATH of the runs, in a folder that lives as long as they do.
  const binDir = programs.ghBin ? mkdtempSync(join(tmpdir(), "factory-eval-bin-")) : undefined;
  if (binDir) symlinkSync(programs.ghBin!, join(binDir, "gh"));
  // Case checks are shell commands too: they see the same fake `gh` first on the PATH.
  const checkEnv = binDir ? { PATH: [binDir, process.env.PATH ?? ""].join(delimiter) } : {};
  const startedAt = new Date().toISOString();
  const jobs: Promise<EvalResult>[] = [];
  let settled: PromiseSettledResult<EvalResult>[];
  let restoreSecrets = () => {};
  try {
  restoreSecrets = registerFakeSecrets(cases.flatMap((c) => (c.fake_secret ? [c.fake_secret] : [])));
  const scheduler = new Scheduler({ runsDir: o.runsDir, config: () => config, claudeBin: programs.claudeBin, codexBin: programs.codexBin, ...(binDir ? { pathPrefix: [binDir] } : {}) });

  o.log(`eval ${suite.name}: ${variants.length} variant(s) × ${cases.length} case(s) × ${suite.repeat} = ${variants.length * cases.length * suite.repeat} runs (concurrency ${o.config.concurrency})`);
  for (const [v, flow] of variants.entries()) {
    for (const [ci, c] of cases.entries()) {
      for (let attempt = 1; attempt <= suite.repeat; attempt++) {
        const caseRepo: CaseRepo = c.fake_remote ? perRun.get(runKey(v, ci, attempt))! : repos.get(c.repo)!;
        const runId = scheduler.submit({ kind: "run", flow, task: c.task, repo: caseRepo.dir, vars: { ...c.vars, ...(c.user_run ? { eval_repo: caseRepo.remote ?? caseRepo.dir } : {}) } }, { source: `eval ${suite.name}`, ...(c.user_run ? { owner: EVAL_USER } : {}) });
        jobs.push((async () => {
          try {
          const s = (await scheduler.wait(runId))!;
          const expected = c.controls?.status ?? (c.controls?.approval ? "waiting" : "succeeded");
          let quality = s.status === expected;
          let checkOutput: string | undefined;
          if (c.check && s.workdir && existsSync(s.workdir)) {
            const logFile = join(s.runDir, "eval-check.log");
            const r = await runShell({ command: c.check, cwd: s.workdir, env: { ...checkEnv, ...(caseRepo.remote ? { FACTORY_EVAL_REMOTE: caseRepo.remote } : {}) }, logFile, timeoutMs: 600_000 });
            quality = r.ok;
            checkOutput = r.output.slice(-2000);
          }
          const skills = c.skills ? evaluateSkillRun(s, c.skills) : undefined;
          const controls = c.controls ? evaluateControls(readControlsInput(s, c.controls, config), c.controls) : undefined;
          // an eval run has no person to approve it: once it is checked, a run that waits is cancelled so it does not stay in the run list
          if (s.status === "waiting") scheduler.cancel(runId);
          const passed = quality && (skills?.ok ?? true) && (controls?.ok ?? true);
          const res: EvalResult = {
            variant: flow.name, case: c.name, attempt, runId, status: s.status, passed, quality, ...(skills ? { skills } : {}), ...(controls ? { controls } : {}), checkOutput,
            costUsd: s.totalCostUsd,
            tokens: s.history.reduce((n, h) => n + (h.tokens ? h.tokens.input + h.tokens.output : 0), 0),
            minutes: s.finishedAt ? (new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 60_000 : 0,
            fixLoops: s.history.reduce((n, h) => n + (h.visit > 1 ? 1 : 0), 0),
          };
          o.log(`${passed ? "✔" : "✘"} ${flow.name} · ${c.name}#${attempt} · ${s.status} · $${s.totalCostUsd.toFixed(3)} · run ${runId}${skills ? ` · selection ${skills.selection.ok ? "✔" : "✘"} · context ${skills.context.ok ? "✔" : "✘"} · activation ${skills.activation.ok ? "✔" : "✘"} (${skills.activation.status})` : ""}${controls ? ` · controls ${controls.ok ? "✔" : "✘"}` : ""}`);
          return res;
          } finally {
            // The copy stays: the run's worktree lives in its git data. Only the remote goes once the checks are done.
            if (caseRepo.remote) rmSync(caseRepo.remote, { recursive: true, force: true });
          }
        })());
      }
    }
  }
  // Wait for every run, also after one failed: the fake `gh` folder must outlive them all.
  settled = await Promise.allSettled(jobs);
  } finally {
    // Every submitted run ends before the environment is put back, also when a later submit failed.
    await Promise.allSettled(jobs);
    restoreSecrets();
    if (binDir) rmSync(binDir, { recursive: true, force: true });
  }
  const failedJob = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failedJob) throw failedJob.reason;
  const results = settled.map((r) => (r as PromiseFulfilledResult<EvalResult>).value);
  const report: EvalReport = { suite: suite.name, startedAt, finishedAt: new Date().toISOString(), inputs, results, summary: summarize(results) };
  mkdirSync(evalsDir(), { recursive: true });
  const file = join(evalsDir(), `${suite.name}-${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  return { report, file };
}

// ---- safety suites: offline suites under evals/safety, run by `scf eval safety` ----

export const SAFETY_DIR = fileURLToPath(new URL("../evals/safety", import.meta.url));

/** The config safety runs use: nothing in it can reach a live model, a real token, a budget of the user or a notification. */
export function safetyConfig(config: Config): Config {
  const { gh_token_env: _token, ...bot } = config.bot;
  const { slack_webhook: _hook, command: _command, ...notify } = config.notify;
  const { github_app: _app, ...rest } = config;
  return {
    ...rest,
    router: { ...config.router, rules: [], fallback_on: [] },
    cost_limits: false,
    // A fallback identity: without one an isolated step is refused (NO_COMMIT_IDENTITY).
    bot: { ...bot, name: bot.name || "scf safety evaluation", email: bot.email || "safety-evaluation@invalid" },
    // The fake remotes live in the temp folder, which the OS sandbox of a user's run hides.
    sandbox: { ...config.sandbox, user_runs: "off" },
    notify: { ...notify, macos: false },
  };
}

/** The suite.yaml files in the folders of `dir`, sorted. */
export function safetySuites(dir = SAFETY_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((d) => join(dir, d, "suite.yaml")).filter((f) => existsSync(f));
}

export interface SafetySuiteSummary {
  suite: string;
  runs: number;
  passRate: number;
  costUsd: number;
  tokens: number;
  minutes: number;
  fixLoops: number;
  policyConformanceRate?: number;
  evidenceCompletenessRate?: number;
  failures: string[];
}

export function safetySummary(report: EvalReport): SafetySuiteSummary {
  const rs = report.results;
  const sum = (f: (r: EvalResult) => number) => rs.reduce((n, r) => n + f(r), 0);
  const withControls = rs.filter((r) => r.controls);
  const rate = (f: (r: EvalResult) => boolean) => (withControls.length ? Math.round((withControls.filter(f).length / withControls.length) * 1000) / 1000 : undefined);
  const policy = rate((r) => r.controls!.policyOk);
  const evidence = rate((r) => r.controls!.evidenceOk);
  const reason = (r: EvalResult) =>
    r.controls?.firstMismatch?.message ?? (r.skills && !r.skills.ok ? "skills: selection failed" : r.quality === false && r.status === "succeeded" ? "check failed" : `run ${r.status}`);
  return {
    suite: report.suite,
    runs: rs.length,
    passRate: rs.length ? Math.round((rs.filter((r) => r.passed).length / rs.length) * 1000) / 1000 : 0,
    costUsd: sum((r) => r.costUsd),
    tokens: sum((r) => r.tokens ?? 0),
    minutes: (new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime()) / 60_000,
    fixLoops: sum((r) => r.fixLoops),
    ...(policy !== undefined ? { policyConformanceRate: policy } : {}),
    ...(evidence !== undefined ? { evidenceCompletenessRate: evidence } : {}),
    failures: rs.filter((r) => !r.passed).map((r) => `✘ ${report.suite} · ${r.case}#${r.attempt} · ${reason(r)}`),
  };
}

export function safetyReportText(rows: SafetySuiteSummary[], broken: string[]): string {
  const pct = (n?: number) => (n === undefined ? "—" : `${Math.round(n * 100)}%`).padStart(8);
  const head = `${"suite".padEnd(28)} ${"pass".padStart(8)} ${"cost".padStart(8)} ${"tokens".padStart(8)} ${"time".padStart(7)} ${"loops".padStart(6)} ${"policy".padStart(8)} ${"evidence".padStart(8)}`;
  const lines = rows.map((s) =>
    `${s.suite.padEnd(28)} ${pct(s.passRate)} ${`$${s.costUsd.toFixed(3)}`.padStart(8)} ${`${Math.round(s.tokens / 1000)}k`.padStart(8)} ${`${s.minutes.toFixed(1)}m`.padStart(7)} ${String(s.fixLoops).padStart(6)} ${pct(s.policyConformanceRate)} ${pct(s.evidenceCompletenessRate)}`);
  const failures = [...rows.flatMap((s) => s.failures), ...broken];
  return `${head}\n${lines.join("\n")}\n${failures.length ? `${failures.join("\n")}\n` : ""}`;
}

/** Runs every safety suite, at the same time, with the isolated config. A suite that cannot run is reported, not thrown. */
export async function runSafetyEvals(o: {
  dir?: string;
  runsDir: string;
  config: Config;
  claudeBin?: string;
  codexBin?: string;
  ghBin?: string;
  maxCasesPerSuite?: number;
  log: (m: string) => void;
}): Promise<{ suites: SafetySuiteSummary[]; files: string[]; failed: number; text: string }> {
  const dir = o.dir ?? SAFETY_DIR;
  const paths = safetySuites(dir);
  if (!paths.length) throw new Error(`no safety suites in ${dir}`);
  const config = safetyConfig(o.config);
  const suites: SafetySuiteSummary[] = [];
  const files: string[] = [];
  const broken: string[] = [];
  await Promise.all(paths.map(async (suitePath) => {
    try {
      const { report, file } = await runEval({ suitePath, runsDir: o.runsDir, config, claudeBin: o.claudeBin, codexBin: o.codexBin, ghBin: o.ghBin, maxCases: o.maxCasesPerSuite, log: o.log });
      suites.push(safetySummary(report));
      files.push(file);
    } catch (e) {
      broken.push(`✘ ${basename(dirname(suitePath))} · ${(e as Error).message.split("\n")[0]}`);
    }
  }));
  suites.sort((a, b) => a.suite.localeCompare(b.suite));
  const failed = suites.reduce((n, s) => n + s.failures.length, 0) + broken.length;
  return { suites, files, failed, text: safetyReportText(suites, broken) };
}

export function listEvalReports(limit = 20): (Omit<EvalReport, "results" | "inputs"> & { file: string })[] {
  const dir = evalsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => {
      const { results: _results, inputs: _inputs, ...rest } = JSON.parse(readFileSync(join(dir, f), "utf8")) as EvalReport;
      return { ...rest, file: join(dir, f) };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
