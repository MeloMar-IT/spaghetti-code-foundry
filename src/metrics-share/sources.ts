import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRefinementRun } from "../auth/run-owner.js";
import { isService } from "../auth/service-accounts.js";
import { listUsers, sharingAnswer } from "../auth/users.js";
import { loadConfig } from "../config.js";
import { DECIDED_FILE, readDecidedQuestions, type DecidedRound } from "../engine/questions.js";
import { listRunBriefsAsync, loadRunAsync, type RunBrief, type RunSummary, type StepRecord } from "../engine/state.js";
import type { EvidenceEvent } from "../evidence/schema.js";
import { readPlainBytes } from "../evidence/stream.js";
import { approvalWaitsMs as approvalWaitsMsOf, measureRun } from "../monitor/measures.js";
import { evidenceFiles, MAX_EVIDENCE_BYTES, readEvidenceEvents } from "../monitor/slo-input.js";
import { outcomeFactsOf } from "../outcome-facts.js";
import { listRepoWatchers } from "../repos/watchers.js";
import { narrowBriefs } from "../server/api-outcomes.js";
import { usageFile } from "../usage/hub.js";
import { UsageEventSchema } from "../usage/schema.js";
import { dayWindow, shareReportFrom, type ShareRun, type ShareSplit } from "./build.js";
import { SHARE_SOURCES, type ShareReport, type SourceKey } from "./report.js";

// Reads what the shared report is made from and builds it: run briefs, run.json, evidence.jsonl (bounded, never through a
// link, one run at a time and reduced to facts at once), decided.json, the usage events of the month and the watchers.
// Read-only: nothing is written, nothing is sent.

const DAY_MS = 86_400_000;
/** A usage file above this size is not read: the splits are then left out. */
export const MAX_USAGE_BYTES = 64 * 1024 * 1024;
/** The steps at which a run stops with questions for a person. */
const QUESTION_STEPS = new Set(["send_back", "ask_for_info"]);
/** Top-level steps of release-daily that only run when a release is made (pull request develop → main, or the local merge). */
const RELEASE_STEPS = new Set(["handoff", "final_merge"]);
const YIELD_EVERY = 10;
const turn = () => new Promise<void>((r) => setImmediate(r));

export interface ShareDeps {
  briefs(): RunBrief[] | Promise<RunBrief[]>;
  load(b: RunBrief): Promise<RunSummary | undefined>;
  /** Watcher id → source. */
  watchers(): ReadonlyMap<string, SourceKey>;
  /** The bytes of `usage-<month>.jsonl`; undefined when there is none. Throws when it cannot be read. */
  usage(month: string): Buffer | undefined;
  foundryVersion(): string;
  install?: string;
  /** An evidence.jsonl above this size adds nothing. Default MAX_EVIDENCE_BYTES. */
  maxEvidenceBytes?: number;
}

type WatcherLike = { id?: unknown; source?: unknown };

/** Watcher id → source from config.yaml and repo-watchers.json. A config.yaml id wins (its watcher keeps the id, as in the server). */
export function watcherSources(config: readonly WatcherLike[], stored: readonly WatcherLike[]): Map<string, SourceKey> {
  const out = new Map<string, SourceKey>();
  const known = new Set<string>(SHARE_SOURCES);
  const add = (w: WatcherLike, wins: boolean) => {
    if (typeof w?.id !== "string" || (!wins && out.has(w.id))) return;
    const source = typeof w.source === "string" ? w.source : "issues"; // the default of both schemas
    out.set(w.id, known.has(source) ? (source as SourceKey) : "unknown");
  };
  for (const w of Array.isArray(stored) ? stored : []) add(w, false);
  for (const w of Array.isArray(config) ? config : []) add(w, true);
  return out;
}

/** The `issue.split` events of a usage file. Lines that cannot be read are skipped. */
export function readUsageSplits(bytes: Buffer): ShareSplit[] {
  const out: ShareSplit[] = [];
  for (const line of bytes.toString("utf8").split("\n")) {
    if (!line.includes('"issue.split"')) continue;
    try {
      const e = UsageEventSchema.safeParse(JSON.parse(line));
      if (e.success && e.data.name === "issue.split") out.push({ id: e.data.id, runId: e.data.runId, time: e.data.time, parts: e.data.parts.length });
    } catch {
      // a line that cannot be read is skipped
    }
  }
  return out;
}

/** The version in package.json, or "unknown". */
export function foundryVersion(): string {
  try {
    const v = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown }).version;
    return typeof v === "string" ? v : "unknown";
  } catch {
    return "unknown";
  }
}

const safely = <T>(f: () => T, fallback: T): T => {
  try {
    return f();
  } catch {
    return fallback;
  }
};

export function defaultShareDeps(runsDir: string): ShareDeps {
  return {
    briefs: () => listRunBriefsAsync(runsDir),
    load: (b) => loadRunAsync(runsDir, b.dirName),
    watchers: () => watcherSources(safely(() => loadConfig().watchers, []), safely(() => listRepoWatchers(), [])),
    usage: (month) => readPlainBytes(usageFile(month), MAX_USAGE_BYTES),
    foundryVersion,
  };
}

/** Whether an admin allows metrics sharing; a config.yaml that cannot be read counts as not allowed. */
const readAllowed = (): boolean => safely(() => loadConfig().metrics_sharing.allowed, false);

/** The accounts that share: the person accounts that said yes (#887). None while an admin does not allow sharing. */
export function sharingAccounts(allowed: boolean = readAllowed()): string[] {
  if (!allowed) return [];
  return listUsers().filter((u) => !isService(u) && sharingAnswer(u) === "yes").map((u) => u.id);
}

/** A copy of run.json with only what the report needs: no task, no step output, no paths, no answers. */
function slimRun(run: RunSummary, runDir: string): RunSummary {
  const vars: Record<string, string> = {};
  for (const k of ["github_repo", "issue", "pr", "ci_run"]) if (typeof run.vars?.[k] === "string") vars[k] = run.vars[k]!;
  const history = (Array.isArray(run.history) ? run.history : []).flatMap((h): StepRecord[] =>
    h && typeof h === "object" && typeof h.id === "string"
      ? [{ id: h.id, type: h.type, visit: h.visit, ok: h.ok === true, output: "", startedAt: "", durationMs: h.durationMs, logFile: "",
          ...(h.parent ? { parent: h.parent } : {}), ...(h.agent ? { agent: h.agent } : {}), ...(h.tokens ? { tokens: h.tokens } : {}),
          ...(h.costUsd !== undefined ? { costUsd: h.costUsd } : {}), ...(h.earlierCostUsd !== undefined ? { earlierCostUsd: h.earlierCostUsd } : {}),
          ...(h.retried ? { retried: h.retried } : {}) }]
      : [],
  );
  return {
    runId: run.runId, flow: run.flow, status: run.status, startedAt: run.startedAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
    ...(run.source ? { source: run.source } : {}), ...(run.owner ? { owner: run.owner } : {}), ...(run.localTest ? { localTest: true } : {}),
    ...(typeof run.resumes === "number" ? { resumes: run.resumes } : {}),
    totalCostUsd: run.totalCostUsd, vars, history, runDir,
  } as RunSummary;
}

export interface EvidenceRead {
  /** undefined: the evidence could not be read (missing, too large, a link, an I/O error). */
  events?: readonly EvidenceEvent[];
  stream: boolean;
  manifest: boolean;
  incomplete: boolean;
  linesSkipped?: number;
}

/**
 * One run reduced to what the report needs, from its run.json, its evidence and its decided rounds. Pure.
 * `rounds` null means decided.json could not be read or is invalid: the answer counts are then unknown.
 */
export function shareRunOf(run: RunSummary, runDir: string, ev: EvidenceRead, rounds: readonly DecidedRound[] | null = []): ShareRun {
  const read = ev.events ?? [];
  const facts = outcomeFactsOf(run, read, { stream: ev.stream, read: ev.events !== undefined, manifest: ev.manifest, incomplete: ev.incomplete }, ev.linesSkipped ?? 0);
  const measures = measureRun(run, read);
  let evidence: ShareRun["evidence"];
  if (ev.events) {
    evidence = { fallbacks: 0, questionStops: [], released: false };
    for (const e of read) {
      if (e.type === "step.routed" && e.fallbackFrom) evidence.fallbacks++;
      else if (e.type === "run.stopped" && e.at && QUESTION_STEPS.has(e.at.split("/").at(-1)!)) evidence.questionStops.push(e.time);
      else if (e.type === "step.completed" && !e.step.parent && RELEASE_STEPS.has(e.step.id) && run.flow === "release-daily") evidence.released = true;
    }
  }
  const decided = rounds === null ? undefined : rounds.map((d) => ({ at: d.at, outcome: d.outcome, questions: Array.isArray(d.questions) ? d.questions.length : 0 }));
  const approvalWaitsMs = ev.events ? approvalWaitsMsOf(run, read) : [];
  return { run: slimRun(run, runDir), facts, measures, approvalWaitsMs, ...(evidence ? { evidence } : {}), ...(decided ? { decided } : {}) };
}

/** The rounds of decided.json: [] when there is no file (no rounds were decided), null when it cannot be read or is invalid. */
function roundsOf(runDir: string): DecidedRound[] | null {
  if (!existsSync(join(runDir, DECIDED_FILE))) return [];
  return readDecidedQuestions(runDir) ?? null;
}

/** Reads and reduces one run. The events are read with a size limit, never through a link, and dropped once reduced. */
export async function reduceRun(run: RunSummary, b: RunBrief, maxBytes = MAX_EVIDENCE_BYTES): Promise<ShareRun> {
  const events: EvidenceEvent[] = [];
  const stats = { skipped: 0 };
  const status = await readEvidenceEvents(b.runDir, run.runId, (e) => void events.push(e), maxBytes, stats);
  const files = await evidenceFiles(b.runDir);
  return shareRunOf(run, b.runDir, { ...(status === "read" ? { events, linesSkipped: stats.skipped } : {}), stream: status !== "missing", manifest: files.manifest, incomplete: files.incomplete }, roundsOf(b.runDir));
}

const stamp = (t: unknown): number => (typeof t === "string" ? Date.parse(t) : NaN);

/**
 * The report of one UTC day for the given accounts. Only their runs count, never runs without an owner.
 * Throws DAY_TEXT for a bad day.
 */
export async function buildShareReport(day: string, accountIds: readonly string[], deps: ShareDeps): Promise<ShareReport> {
  const { from, to } = dayWindow(day);
  const f = from.getTime();
  const t = to.getTime();
  const accounts = new Set(accountIds);
  const briefs = await deps.briefs();
  const owned = briefs.filter((b) => typeof b.owner === "string" && accounts.has(b.owner) && !isRefinementRun(b.source) && !b.localTest);
  // the runs the outcome measures need (by when they ended, with the earlier runs of their work items) …
  const outcome = narrowBriefs(owned, {}, { from, to, previousFrom: new Date(f - DAY_MS) });
  // … and the runs active on the day, for what is counted by when it happened (question stops)
  const active = owned.filter((b) => stamp(b.startedAt) < t && !(stamp(b.finishedAt) < f));
  const wanted = new Map<string, RunBrief>();
  for (const b of [...outcome, ...active]) wanted.set(b.runDir, b);
  const runs: ShareRun[] = [];
  let i = 0;
  for (const b of wanted.values()) {
    if (i++ % YIELD_EVERY === YIELD_EVERY - 1) await turn();
    try {
      const run = await deps.load(b);
      if (!run || run.runId !== b.runId) continue;
      runs.push(await reduceRun(run, b, deps.maxEvidenceBytes));
    } catch {
      // a run that cannot be read is left out
    }
  }
  let splits: ShareSplit[] | undefined;
  try {
    const bytes = deps.usage(day.slice(0, 7));
    splits = bytes ? readUsageSplits(bytes) : undefined;
  } catch {
    splits = undefined;
  }
  return shareReportFrom({
    day, accountIds, foundryVersion: deps.foundryVersion(), briefs, runs, splits, watcherSources: deps.watchers(),
    ...(deps.install ? { install: deps.install } : {}),
  });
}
