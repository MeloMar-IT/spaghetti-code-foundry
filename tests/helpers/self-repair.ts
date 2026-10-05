import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { createUserWithLink } from "../../src/auth/users.js";
import { ConfigSchema, type Config, type WatcherConfig } from "../../src/config.js";
import { selfBuild, selfContains } from "../../src/engine/guards.js";
import { saveRun, type RunSummary } from "../../src/engine/state.js";
import { flowDir, loadFlow, parseFlow } from "../../src/flow/load.js";
import { readRateLimit, type RateReading } from "../../src/github.js";
import { collectNames } from "../../src/monitor/clean.js";
import { loadFindings, type Finding, type Severity } from "../../src/monitor/findings.js";
import { loadGuard, logFile, storiesVerdict, writeLog } from "../../src/monitor/guard.js";
import { logRing, Monitor } from "../../src/monitor/monitor.js";
import { activeMutes } from "../../src/monitor/mutes.js";
import { buildLabelFor, Reporter } from "../../src/monitor/report.js";
import type { BuiltinSteps } from "../../src/monitor/story.js";
import { Scheduler } from "../../src/queue/scheduler.js";
import { Watcher } from "../../src/queue/watcher.js";
import { claudeBin, fakeGithub, type FakeIssue } from "./fake-github.js";

// The replay world of the self-repair tests: the real Monitor, Reporter, Watcher, Scheduler and flows, with the fake gh,
// a bare git remote and one clock that the tests can move.
export const REPO = "acme/app";
export const WATCHER_ID = "acme-stories";
// Built at run time, so no secret scanner finds a token in the source.
export const PRIVATE = {
  name: "Jane Doe",
  email: "jane.doe@secret-corp.example",
  repo: "secret-corp/payroll-app",
  watcher: "payroll-issues",
  home: "/Users/janedoe",
  token: ["ghp", "a1B2c3D4e5".repeat(4)].join("_"),
  userId: "4711042",
};

const LABELS = { working: "Factory_working", done: "Factory_done", needs_info: "Factory_needs_info", waiting: "Factory_waiting", failed: "Factory_ERROR" };
const PLAIN_TEST = "! grep -q BUG feature.txt 2>/dev/null";
const HOUR = 3_600_000;
const FAKES = [
  "FAKE_CODEX_VERDICT", "FAKE_CODEX_PLAN_VERDICT", "FAKE_CODEX_CODE_VERDICT", "FAKE_SIZE", "FAKE_AREAS", "FAKE_RISK", "FAKE_GH_COMMENTS",
  "FAKE_GH_ISSUE_LABELS", "FAKE_ISSUE_PLAN", "FAKE_RESOLVE_NOOP", "FAKE_GH_FAIL", "FAKE_GH_FAIL_TEXT", "FAKE_GH_FAIL_LABELS", "FAKE_FORCED_SPLIT",
  "FACTORY_SELF_DIR", "FAKE_GH_RATE_LIMIT", "FAKE_GH_ISSUES", "FAKE_GH_STORIES", "FAKE_GH_BUG_ISSUES", "FAKE_GH_FAIL_API",
];

export interface IssueSpec { number: number; labels?: string[]; createdAt?: string }
export interface WorldOptions { reportTo?: string | false; testCmd?: string; monitor?: Record<string, unknown>; monitorWatcher?: boolean }

/** A reading of `gh api rate_limit`: each resource as [used, limit]; the window resets in an hour. */
export function rateJson(res: Record<string, [number, number]>, resetAt = Math.floor(Date.now() / 1000) + 3600): string {
  const resources = Object.fromEntries(Object.entries(res).map(([k, [used, limit]]) => [k, { limit, used, remaining: limit - used, reset: resetAt }]));
  return JSON.stringify({ resources });
}
export const HEALTHY = () => rateJson({ core: [100, 5000], graphql: [100, 5000] });

export interface World {
  gh: ReturnType<typeof fakeGithub>;
  config: Config;
  scheduler: Scheduler;
  watcher: Watcher;
  monitor: Monitor;
  now(): Date;
  advance(ms: number): void;
  /** Moves the clock 15 minutes when the local day would change within 10 minutes (the daily limit counts local days). */
  awayFromMidnight(): void;
  issues(...list: IssueSpec[]): void;
  addIssue(i: IssueSpec): void;
  relabel(n: number, labels: string[]): void;
  seedRun(over: Partial<RunSummary>): RunSummary;
  watch(): Promise<void>;
  settle(): Promise<void>;
  check(): Promise<number>;
  /** Builds the monitor again with the same wiring (a restart of the server on the same build); `startedAt` defaults to the first start. */
  restartMonitor(startedAt?: Date): void;
  findings(): Finding[];
  stories(): FakeIssue[];
  sent(): string[];
  storyCalls(): string[];
  log(event?: string): Record<string, unknown>[];
  runOf(issue: number): RunSummary | undefined;
  rev(branch: string): string;
  firstSeenAt(fp: string): number | undefined;
  storyMadeAt(fp: string): number | undefined;
  /** The Foundry restarts on a checkout of the new main. */
  takeTheFix(): void;
  dirs: { runs: string; home: string };
  close(): void;
}

export async function makeWorld(o: WorldOptions = {}): Promise<World> {
  for (const k of FAKES) delete process.env[k];
  const gh = fakeGithub();
  const home = join(gh.tmp, "home");
  mkdirSync(home, { recursive: true });
  const saved = { home: process.env.FACTORY_HOME, codex: process.env.FACTORY_CODEX_BIN, poll: process.env.AREA_LOCK_POLL_MS, lock: process.env.FACTORY_LOCK_DIR };
  Object.assign(process.env, {
    FACTORY_HOME: home, FACTORY_LOCK_DIR: join(gh.tmp, "locks"), FACTORY_CODEX_BIN: resolve("tests/fixtures/fake-codex.mjs"),
    AREA_LOCK_POLL_MS: "100", FAKE_GH_STORIES: "1", FAKE_GH_ISSUE_LABELS: "Factory_go", FAKE_GH_ISSUES: "[]",
  });
  const runsDir = join(gh.tmp, "runs");

  let offset = 0;
  const now = () => new Date(Date.now() + offset);
  const startedAt0 = new Date(Date.now() - HOUR);

  const monitorCfg: WatcherConfig = ConfigSchema.parse({ watchers: [{ id: "monitor", source: "monitor", every: "1h" }] }).watchers[0]!;
  const config = ConfigSchema.parse({
    protected_branches: ["main"], concurrency: 1, hotfix_to_main: true,
    monitor: { ...(o.reportTo === false ? {} : { report_to: o.reportTo ?? REPO }), ...(o.monitor ?? {}) },
    watchers: [
      {
        id: WATCHER_ID, github_repo: REPO, label: "Factory_go", flow: "issue-gitflow", max_per_tick: 1, status_comment: false, status_labels: LABELS,
        remove_on_done: ["Factory_go"],
        vars: { test_cmd: o.testCmd ?? PLAIN_TEST, docs_required: "docs/CHANGELOG.md", union_merge_files: "docs/CHANGELOG.md" },
      },
      ...(o.monitorWatcher === false ? [] : [{ id: "monitor", source: "monitor", every: "1h" }]),
      { id: PRIVATE.watcher, github_repo: PRIVATE.repo, enabled: false },
    ],
  });
  const issueCfg = config.watchers.find((w) => w.id === WATCHER_ID)!;
  await createUserWithLink({ name: PRIVATE.name, email: PRIVATE.email });

  const ring = logRing();
  const log = (m: string) => ring.push(m);
  const scheduler = new Scheduler({ runsDir, config: () => config, claudeBin });
  const watcher = new Watcher(issueCfg, { scheduler, runsDir, repo: gh.tmp, log, watchers: () => config.watchers });

  // The Foundry's own checkout of its repository.
  const folders: string[] = [];
  const checkout = (): string => {
    const d = mkdtempSync(join(tmpdir(), "self-"));
    folders.push(d);
    spawnSync("git", ["clone", "-q", gh.remote, d]);
    spawnSync("git", ["remote", "set-url", "origin", `https://github.com/${REPO}.git`], { cwd: d });
    return d;
  };
  let selfDir = checkout();
  process.env.FACTORY_SELF_DIR = selfDir;

  let rate: RateReading | undefined;
  let steps: BuiltinSteps | undefined;
  const builtinSteps = (): BuiltinSteps => {
    if (steps) return steps;
    steps = {};
    const dir = flowDir("builtin", gh.tmp);
    for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
      const flow = parseFlow(readFileSync(join(dir, f), "utf8"), f);
      steps[flow.name] = flow.steps.map((s) => s.id);
    }
    return steps;
  };

  const firstSeen = new Map<string, number>();
  const madeAt = new Map<string, number>();
  let checks = 0;

  const build = (startedAt: Date, dir: string): Monitor => {
    const m: Monitor = new Monitor(monitorCfg, {
      scheduler,
      watchers: () => [{ cfg: issueCfg, status: watcher.status, issues: watcher.tracked }],
      thresholds: () => config.monitor,
      serverLog: ring.lines,
      rateLimit: () => rate,
      beforeCheck: async () => { rate = (await readRateLimit()) ?? rate; },
      log,
      now,
      guard: { startedAt },
      self: { repo: selfBuild(dir)!.repo, contains: (c) => selfContains(c, dir) },
      reporter: new Reporter({
        config: () => config.monitor,
        buildLabel: (r) => buildLabelFor(config.watchers, r),
        names: (t) => collectNames(t, config),
        builtinSteps,
        rateLimit: () => rate,
        guard: () => storiesVerdict({ startedAt, cooldownMinutes: config.monitor.cooldown_minutes, now: now() }),
        mutes: (at) => activeMutes(loadGuard(), at),
        record: (e) => writeLog(e, { now: now() }),
        log,
      }),
    });
    return m;
  };
  const world = { monitor: build(startedAt0, selfDir) } as World;

  const writeIssues = (list: IssueSpec[]) => {
    process.env.FAKE_GH_ISSUES = JSON.stringify(
      list.map((i) => ({ number: i.number, title: `issue ${i.number}`, labels: (i.labels ?? ["Factory_go"]).map((name) => ({ name })), createdAt: i.createdAt ?? now().toISOString() })),
    );
  };
  let listed: IssueSpec[] = [];
  const keepAlive = () => { watcher.status.lastTick = now().toISOString(); };

  const ghLines = () => gh.ghLog().split("\n");
  Object.assign(world, {
    gh, config, scheduler, watcher, dirs: { runs: runsDir, home },
    now,
    advance(ms: number) { offset += ms; keepAlive(); },
    awayFromMidnight() {
      const at = now();
      const next = new Date(at); next.setHours(24, 0, 0, 0);
      const prev = new Date(at); prev.setHours(0, 0, 0, 0);
      if (next.getTime() - at.getTime() < 10 * 60_000 || at.getTime() - prev.getTime() < 10 * 60_000) offset += 15 * 60_000 + (next.getTime() - at.getTime() < 10 * 60_000 ? 10 * 60_000 : 0);
      keepAlive();
    },
    issues(...list: IssueSpec[]) { listed = list; writeIssues(listed); },
    addIssue(i: IssueSpec) { listed = [...listed.filter((x) => x.number !== i.number), i]; writeIssues(listed); },
    relabel(n: number, labels: string[]) { listed = listed.map((x) => (x.number === n ? { ...x, labels } : x)); writeIssues(listed); },
    seedRun(over: Partial<RunSummary>): RunSummary {
      const at = now();
      const stamp = at.toISOString().replace(/\D/g, "").slice(0, 14);
      const runId = `${stamp.slice(0, 8)}-${stamp.slice(8)}-${Math.random().toString(16).slice(2, 6).padEnd(4, "0")}`;
      const runDir = join(runsDir, runId);
      mkdirSync(join(runDir, "logs"), { recursive: true });
      const summary: RunSummary = {
        runId, flow: "issue-gitflow", flowDef: loadFlow("issue-gitflow", gh.tmp).flow, task: "", vars: { github_repo: REPO, issue: "1" }, repo: gh.tmp,
        status: "failed", runDir, startedAt: at.toISOString(), finishedAt: at.toISOString(), totalCostUsd: 0, history: [],
        state: { next: null, steps: {}, visits: {} }, ...over,
      };
      saveRun(summary);
      return summary;
    },
    async watch() { await watcher.tick(); keepAlive(); },
    async settle() { await scheduler.idle(); await new Promise((r) => setTimeout(r, 300)); },
    async check() {
      checks++;
      await world.monitor.tick();
      if (world.monitor.status.lastError) throw new Error(`the monitor failed: ${world.monitor.status.lastError}`);
      for (const f of loadFindings().findings) {
        if (!firstSeen.has(f.fingerprint)) firstSeen.set(f.fingerprint, checks);
        if (f.report && !madeAt.has(f.fingerprint)) madeAt.set(f.fingerprint, checks);
      }
      return checks;
    },
    restartMonitor(startedAt = startedAt0) { world.monitor.stop(); world.monitor = build(startedAt, selfDir); },
    findings: () => loadFindings().findings,
    stories: () => gh.bugIssues(),
    sent() {
      const made = gh.createdBodies().flatMap((c) => [c.title, c.body]);
      return [...made, ...gh.comments().map((c) => c.body).filter((b) => b.includes("claude-factory monitor-"))];
    },
    storyCalls() {
      const calls = ghLines().filter((l) => (/^gh api repos\/\S+\/issues(\s|\?|\/\d|$)/.test(l) && !l.includes("/issues/comments/")) || (l.startsWith("gh label create") && !l.includes("--force")));
      return [...calls, ...gh.comments().filter((c) => c.body.includes("claude-factory monitor-")).map((c) => `comment on #${c.issue}`)];
    },
    log(event?: string) {
      if (!existsSync(logFile())) return [];
      const lines = readFileSync(logFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      return event ? lines.filter((l) => l.event === event) : lines;
    },
    runOf: (issue: number) => scheduler.list().find((s) => s.flow === "issue-gitflow" && s.vars.issue === String(issue)),
    rev: (b: string) => gh.remoteGit("rev-parse", b).trim(),
    firstSeenAt: (fp: string) => firstSeen.get(fp),
    storyMadeAt: (fp: string) => madeAt.get(fp),
    takeTheFix() {
      world.monitor.stop();
      selfDir = checkout();
      process.env.FACTORY_SELF_DIR = selfDir;
      world.monitor = build(now(), selfDir);
    },
    close() {
      world.monitor.stop();
      watcher.stop();
      for (const d of folders) rmSync(d, { recursive: true, force: true });
      for (const [k, v] of Object.entries({ FACTORY_HOME: saved.home, FACTORY_CODEX_BIN: saved.codex, AREA_LOCK_POLL_MS: saved.poll, FACTORY_LOCK_DIR: saved.lock })) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      for (const k of FAKES) delete process.env[k];
      gh.restore();
    },
  });
  return world;
}

/** Nothing the monitor sent to GitHub holds anything private. */
export function expectClean(w: World): void {
  const words = PRIVATE.name.split(/\s+/);
  const bad = [...Object.values(PRIVATE), ...words, w.gh.tmp, homedir(), "ghp_", "@", "/Users/", "/home/"];
  for (const text of w.sent()) {
    for (const b of bad) expect(text, `the text holds "${b}"`).not.toContain(b);
    expect(text).not.toMatch(/\d{8}-\d{6}-[0-9a-f]{4}/);
  }
}

export interface Incident {
  id: string;
  realCase: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  testCmd?: string;
  stage(w: World): Promise<void>;
  lasts?(w: World): Promise<void>;
  heal?: { when: "before the build" | "after the fix"; run(w: World): Promise<void> };
}

const GENERAL_TITLE = "The monitor found a problem of the Foundry";
const agoIso = (w: World, ms: number) => new Date(w.now().getTime() - ms).toISOString();

export const INCIDENTS: Incident[] = [
  {
    id: "restart-loop",
    realCase: "Runs that step aside waiting for a code area were resumed again and again.",
    fingerprint: "restart-loop|issue-gitflow|claim_areas",
    severity: "critical",
    title: "Runs that step aside are restarted in a loop",
    async stage(w) {
      w.seedRun({
        status: "stopped", reason: 'stopped at step "wait_for_area"', vars: { github_repo: REPO, issue: "31" },
        resumeLog: Array.from({ length: 24 }, (_, i) => ({ at: agoIso(w, (24 - i) * 25_000), from: "claim_areas" })),
      });
    },
    async lasts(w) {
      const run = w.scheduler.list().find((r) => r.vars.issue === "31")!;
      const next = { ...run, resumeLog: [...(run.resumeLog ?? []), { at: w.now().toISOString(), from: "claim_areas" }] };
      saveRun(next);
    },
  },
  {
    id: "github-limit",
    realCase: "The watchers used up GitHub's GraphQL request limit; every call was refused.",
    fingerprint: "github-limit|graphql",
    severity: "critical",
    title: "The Foundry uses up GitHub's request limit",
    async stage(w) {
      process.env.FAKE_GH_RATE_LIMIT = rateJson({ graphql: [5000, 5000], core: [1200, 5000] });
      process.env.FAKE_GH_FAIL = "issue list";
      process.env.FAKE_GH_FAIL_TEXT = `GraphQL: API rate limit already exceeded for user ID ${PRIVATE.userId}. ${PRIVATE.home} ${PRIVATE.email} ${PRIVATE.token} ${PRIVATE.repo}`;
      w.issues();
      await w.watch();
    },
    heal: {
      when: "before the build",
      async run() {
        process.env.FAKE_GH_RATE_LIMIT = HEALTHY();
        delete process.env.FAKE_GH_FAIL;
        delete process.env.FAKE_GH_FAIL_TEXT;
      },
    },
  },
  {
    id: "same-step-failing",
    realCase: "Every run failed at the tests before the change, because develop was broken.",
    fingerprint: `same-step-failing|${REPO}|issue-gitflow|baseline_tests`,
    severity: "major",
    title: GENERAL_TITLE,
    testCmd: "test -f feature.txt || ! test -f flaky.txt",
    async stage(w) {
      const dir = mkdtempSync(join(tmpdir(), "flaky-"));
      const git = (...a: string[]) => spawnSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_COUNT: undefined } });
      git("clone", "-q", w.gh.remote, ".");
      git("checkout", "-q", "-B", "develop"); // develop is made from main when it does not exist yet
      spawnSync("sh", ["-c", "echo flaky > flaky.txt"], { cwd: dir });
      git("add", ".");
      git("commit", "-qm", "break develop");
      git("push", "-q", "origin", "develop");
      rmSync(dir, { recursive: true, force: true });
      for (const n of [11, 12, 13]) {
        w.addIssue({ number: n });
        await w.watch();
        await w.settle();
        w.relabel(n, ["Factory_go", "Factory_ERROR"]);
      }
    },
  },
  {
    id: "label-mismatch",
    realCase: "An issue kept the working label while its run had failed; nobody looked at it.",
    fingerprint: `label-mismatch|${WATCHER_ID}`,
    severity: "major",
    title: GENERAL_TITLE,
    async stage(w) {
      w.seedRun({
        status: "failed", reason: 'step "run_tests" failed: exit code 1', vars: { github_repo: REPO, issue: "21" },
        history: [{ id: "run_tests", type: "shell", ok: false, output: "", error: "exit code 1", startedAt: w.now().toISOString(), finishedAt: w.now().toISOString(), costUsd: 0, by: "shell" } as unknown as RunSummary["history"][number]],
      });
      w.issues({ number: 21, labels: ["Factory_go", "Factory_working"] });
      for (let i = 0; i < 4; i++) await w.watch();
    },
    heal: { when: "after the fix", async run(w) { w.relabel(21, ["Factory_go", "Factory_ERROR"]); } },
  },
];
