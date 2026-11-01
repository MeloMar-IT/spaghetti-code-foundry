import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRun } from "../engine/state.js";
import { descendants, psEnv, psPath, STEP_PIDS_DIR, type ProcRow } from "../steps/proc-tree.js";
import { HOLD_MS } from "./governor.js";

/** A process with its CPU time and command line. The command line is used to find out who owns the process and then dropped. */
export interface CpuRow extends ProcRow { cpuSec: number; command: string }
export interface ActiveRun { runId: string; repo: string; pid: number; pids: number[] }
export type Owner = { kind: "run"; runId: string; repo: string } | { kind: "tests" } | { kind: "server" };
export interface Learned { cores: number; readings: number }
export interface UsageState { at: string; procs: Record<string, [start: string, cpuSec: number]>; learned: Record<string, Learned> }
export interface Usage {
  windowSec: number;
  foundry: { cores: number; tests: number; server: number; runs: { runId: string; repo: string; cores: number }[]; repos: Record<string, number> };
  other: { cores: number; top: { program: string; cores: number }[] };
  /** Repository → learned cores of one run. */
  perRun: Record<string, number>;
}

/** The slowest a learned figure moves per check, and the slowest it learns once it has many readings. */
export const LEARN_RATE = 0.05;
export const LEARN_STEP_MAX = 0.25;
/** Two checks closer than this give no figures (a manual run right after another). */
export const MIN_WINDOW_MS = 20_000;
export const TOP_PROGRAMS = 3;
/** A process may have started this long before the previous check and still count as new (clock slack). */
const START_SLACK_MS = 5000;
/** The helpers of the Foundry (`scf <name> run`); tests keep this equal to the keys of JOBS in cli.ts. */
export const HELPERS = ["governor", "flaky", "limits", "blockage", "digest", "housekeeping"];
/** The folder of this install's entry points (`dist/` or `src/`). */
export const ENTRY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const START = /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2}:\d{2} \d{4}$/;
const PS_CPU_ARGS = ["-A", "-ww", "-o", "pid=,ppid=,time=,lstart=,command="];
const PS_NAME_ARGS = ["-A", "-o", "pid=,ucomm="];

/** `[dd-][hh:]mm:ss[.ss]` → seconds. */
export function parseCpuTime(text: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!m) return undefined;
  const sec = Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return Number.isFinite(sec) ? sec : undefined;
}

const CPU_LINE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2}\s+\d{1,2} \d{1,2}:\d{2}:\d{2} \d{4})\s+(.*)$/;

/** `ps -A -ww -o pid=,ppid=,time=,lstart=,command=` → rows. Lines that do not fit are skipped. */
export function parseCpuPs(text: string): CpuRow[] {
  const rows: CpuRow[] = [];
  for (const line of text.split("\n")) {
    const m = CPU_LINE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const cpuSec = parseCpuTime(m[3]!);
    const start = m[4]!.replace(/\s+/g, " ");
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || cpuSec === undefined || !START.test(start)) continue;
    rows.push({ pid, ppid, start, cpuSec, command: m[5]! });
  }
  return rows;
}

const cleanName = (raw: string): string => {
  let n = raw.trim().replace(/^-+/, "");
  if (n.startsWith("(") && n.endsWith(")")) n = n.slice(1, -1);
  n = n.trim().slice(0, 40).trim();
  return n || "unknown";
};

/** `ps -A -o pid=,ucomm=` → pid → program name (the executable's name, never a command line). */
export function parseNames(text: string): Map<number, string> {
  const names = new Map<number, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isSafeInteger(pid) && pid > 0) names.set(pid, cleanName(m[2] ?? ""));
  }
  return names;
}

/** Every process now with its CPU time and name; undefined when `ps` fails, is too slow or gives nothing usable. Blocks. */
export function readCpuTable(timeoutMs = 10_000): { rows: CpuRow[]; names: Map<number, string> } | undefined {
  const run = (args: string[]) => execFileSync(psPath(), args, { env: psEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let rows: CpuRow[];
  try {
    rows = parseCpuPs(run(PS_CPU_ARGS));
  } catch {
    return undefined;
  }
  if (!rows.length) return undefined;
  let names = new Map<number, string>();
  try {
    names = parseNames(run(PS_NAME_ARGS));
  } catch {
    // programs are "unknown"; the rest still works
  }
  return { rows, names };
}

/** Runs that are running and have a step process marked in `<run folder>/step-pids/`. Only those run.json files are read. */
export function activeRuns(runsDir: string): ActiveRun[] {
  let ids: string[];
  try {
    ids = readdirSync(runsDir);
  } catch {
    return [];
  }
  const out: ActiveRun[] = [];
  for (const runId of ids) {
    let pids: number[];
    try {
      pids = readdirSync(join(runsDir, runId, STEP_PIDS_DIR)).filter((f) => /^\d+$/.test(f)).map(Number).filter((p) => Number.isSafeInteger(p) && p > 0);
    } catch {
      continue;
    }
    if (!pids.length) continue;
    try {
      const run = loadRun(runsDir, runId);
      if (!run || run.status !== "running" || !Number.isSafeInteger(run.pid)) continue;
      const repo = run.vars?.github_repo || run.repo;
      if (typeof repo !== "string" || !repo) continue;
      out.push({ runId, repo, pid: run.pid as number, pids });
    } catch {
      // a run.json that cannot be read
    }
  }
  return out;
}

/** The pids that hold a test slot (`<slots folder>/slot-N/pid`). */
export function slotHolders(slotsDir: string): number[] {
  const out: number[] = [];
  let names: string[];
  try {
    names = readdirSync(slotsDir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^slot-\d+$/.test(n)) continue;
    try {
      const pid = Number(readFileSync(join(slotsDir, n, "pid"), "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) out.push(pid);
    } catch {
      // being made or gone
    }
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `<interpreter> <entryDir>/(cli|factory).(js|ts) (serve|ui|<helper> run)`: this install's server or one of its helpers. Nothing else. */
export function isFoundryCommand(command: string, entryDir: string): "server" | undefined {
  const re = new RegExp(`(?:^|\\s)${escapeRe(entryDir)}/(?:cli|factory)\\.(?:js|ts)\\s+(?:serve|ui|(?:${HELPERS.join("|")})\\s+run)(?:\\s|$)`);
  return re.test(command) ? "server" : undefined;
}

/**
 * Who owns which process. First claim wins: step processes of active runs (a mark counts only when the process is a
 * child of the run's server pid), then test slot holders, then the server and its helpers. Each claim covers the
 * descendants too. Everything else has no owner.
 */
export function ownersOf(rows: CpuRow[], runs: ActiveRun[], slots: number[], entryDir: string): Map<number, Owner> {
  const owners = new Map<number, Owner>();
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const claim = (root: number, owner: Owner) => {
    if (!owners.has(root)) owners.set(root, owner);
    for (const d of descendants(rows, root)) if (!owners.has(d.pid)) owners.set(d.pid, owner);
  };
  for (const run of runs) {
    for (const pid of run.pids) {
      const row = byPid.get(pid);
      if (row && row.ppid === run.pid) claim(pid, { kind: "run", runId: run.runId, repo: run.repo });
    }
  }
  for (const pid of slots) if (byPid.has(pid)) claim(pid, { kind: "tests" });
  for (const r of rows) if (isFoundryCommand(r.command, entryDir)) claim(r.pid, { kind: "server" });
  return owners;
}

const round = (n: number, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;

/** Cores used by each process since the previous check, split by owner. `seconds` is the length of the window. */
export function splitCpu(rows: CpuRow[], names: Map<number, string>, prev: UsageState["procs"], prevAt: Date, owners: Map<number, Owner>, runs: ActiveRun[], seconds: number): Omit<Usage, "perRun"> {
  const perRun = new Map(runs.map((r) => [r.runId, 0]));
  let tests = 0;
  let server = 0;
  let other = 0;
  const programs = new Map<string, number>();
  for (const r of rows) {
    const before = prev[String(r.pid)];
    let sec = 0;
    if (before && before[0] === r.start) sec = Math.max(0, r.cpuSec - before[1]);
    else if (Date.parse(r.start) >= prevAt.getTime() - START_SLACK_MS) sec = Math.max(0, r.cpuSec); // started inside the window
    // otherwise: no usable baseline, this check only gives one
    const cores = sec / seconds;
    if (!cores) continue;
    const o = owners.get(r.pid);
    if (!o) {
      other += cores;
      const p = names.get(r.pid) ?? "unknown";
      programs.set(p, (programs.get(p) ?? 0) + cores);
    } else if (o.kind === "run") perRun.set(o.runId, (perRun.get(o.runId) ?? 0) + cores);
    else if (o.kind === "tests") tests += cores;
    else server += cores;
  }
  const runList = runs.map((r) => ({ runId: r.runId, repo: r.repo, cores: round(perRun.get(r.runId) ?? 0) }));
  const repos: Record<string, number> = {};
  for (const r of runList) repos[r.repo] = round((repos[r.repo] ?? 0) + r.cores);
  const runCores = runList.reduce((a, r) => a + r.cores, 0);
  const top = [...programs].map(([program, c]) => ({ program, cores: round(c) })).filter((p) => p.cores > 0).sort((a, b) => b.cores - a.cores || a.program.localeCompare(b.program)).slice(0, TOP_PROGRAMS);
  return {
    windowSec: round(seconds, 1),
    foundry: { cores: round(runCores + tests + server), tests: round(tests), server: round(server), runs: runList, repos },
    other: { cores: round(other), top },
  };
}

/** One reading per repository (the mean cores of its active runs) moves the learned figure by a bounded step. A repository without a reading is kept. */
export function learn(prev: Record<string, Learned>, usage: Pick<Usage, "foundry">): Record<string, Learned> {
  const next: Record<string, Learned> = { ...prev };
  const count = new Map<string, number>();
  for (const r of usage.foundry.runs) count.set(r.repo, (count.get(r.repo) ?? 0) + 1);
  for (const [repo, n] of count) {
    const reading = (usage.foundry.repos[repo] ?? 0) / n;
    const old = prev[repo];
    if (!old || !Number.isFinite(old.cores)) {
      next[repo] = { cores: round(reading), readings: 1 };
      continue;
    }
    const readings = (Number.isFinite(old.readings) && old.readings > 0 ? old.readings : 1) + 1;
    const rate = Math.max(LEARN_RATE, 1 / readings);
    const step = Math.max(-LEARN_STEP_MAX, Math.min(LEARN_STEP_MAX, rate * (reading - old.cores)));
    next[repo] = { cores: round(Math.max(0, old.cores + step)), readings };
  }
  return next;
}

/** `the Foundry uses 3.2 cores, other programs use 6.1 cores (top: Xcode 3.1, node 1.4)` */
export function usageLine(u: Pick<Usage, "foundry" | "other">): string {
  const top = u.other.top.slice(0, TOP_PROGRAMS).map((p) => `${p.program} ${p.cores.toFixed(1)}`).join(", ");
  return `the Foundry uses ${u.foundry.cores.toFixed(1)} cores, other programs use ${u.other.cores.toFixed(1)} cores${top ? ` (top: ${top})` : ""}`;
}

const usageFile = (dir: string) => join(dir, "usage.json");

function loadUsage(dir: string): UsageState | undefined {
  try {
    const s = JSON.parse(readFileSync(usageFile(dir), "utf8")) as Partial<UsageState>;
    const procs: UsageState["procs"] = {};
    for (const [k, v] of Object.entries(s.procs ?? {})) if (Array.isArray(v) && typeof v[0] === "string" && Number.isFinite(v[1])) procs[k] = [v[0], v[1]];
    const learned: Record<string, Learned> = {};
    for (const [k, v] of Object.entries(s.learned ?? {})) if (v && Number.isFinite(v.cores) && v.cores >= 0) learned[k] = { cores: v.cores, readings: Number.isFinite(v.readings) && v.readings > 0 ? v.readings : 1 };
    return { at: typeof s.at === "string" ? s.at : "", procs, learned };
  } catch {
    return undefined;
  }
}

function saveUsage(dir: string, s: UsageState) {
  mkdirSync(dir, { recursive: true });
  const tmp = `${usageFile(dir)}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(s));
    renameSync(tmp, usageFile(dir));
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * One measurement: the Foundry's CPU and other programs', from the CPU time used since the previous check (kept in
 * `usage.json`, separate from the governor's state: learned figures outlast a reset and a gap). Gives undefined, and
 * leaves the files alone or only writes a new baseline, when there is nothing to report. Never throws.
 */
export function measureUsage(o: { dir: string; runsDir: string; slotsDir: string; now: Date; read?: () => ReturnType<typeof readCpuTable>; entryDir?: string }): Usage | undefined {
  try {
    const table = (o.read ?? readCpuTable)();
    if (!table || !table.rows.length) return undefined;
    const prev = loadUsage(o.dir);
    const baseline: UsageState["procs"] = {};
    for (const r of table.rows) baseline[String(r.pid)] = [r.start, r.cpuSec];
    const learned = prev?.learned ?? {};
    const at = o.now.getTime();
    const gap = prev ? at - Date.parse(prev.at) : NaN;
    if (!prev || !Number.isFinite(gap) || gap < 0 || gap > HOLD_MS) {
      saveUsage(o.dir, { at: o.now.toISOString(), procs: baseline, learned });
      return undefined;
    }
    if (gap < MIN_WINDOW_MS) return undefined;
    const runs = activeRuns(o.runsDir);
    const owners = ownersOf(table.rows, runs, slotHolders(o.slotsDir), o.entryDir ?? ENTRY_DIR);
    const split = splitCpu(table.rows, table.names, prev.procs, new Date(Date.parse(prev.at)), owners, runs, gap / 1000);
    const next = learn(learned, split);
    saveUsage(o.dir, { at: o.now.toISOString(), procs: baseline, learned: next });
    return { ...split, perRun: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v.cores])) };
  } catch {
    return undefined;
  }
}
