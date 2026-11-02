import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunPlanCheck, RunSkillCarry } from "./plan-carry.js";
import type { Flow, Step } from "../flow/schema.js";
import type { RunAutonomy } from "../governance/autonomy.js";
import type { PromotionRecord } from "../promotion/gate.js";
import type { AppliedChoice } from "../skills/choices.js";
import type { CanonicalSelectionRecord } from "../skills/run-canonical.js";
import type { RunSkillLockSummary } from "../skills/run-lock.js";
import type { RunSkillPlan } from "../skills/run-plan.js";
import type { SessionToolGrant } from "../skills/tool-policy.js";
import type { DecidedRound } from "./questions.js";
import type { OutputLabel } from "./untrusted.js";

export type RunStatus = "running" | "succeeded" | "failed" | "cancelled" | "stopped" | "waiting";

export interface StepRecord {
  id: string;
  type: Step["type"];
  visit: number;
  ok: boolean;
  output: string;
  error?: string;
  exitCode?: number | null;
  sessionId?: string;
  /** The Codex folder of this session: "run" or "personal:<12 hex>", never a path. Codex steps only. */
  codexHome?: string;
  costUsd?: number;
  /** Agent step target, e.g. "codex:openai:gpt-5". */
  agent?: string;
  /** The effort the agent step ran with, when one was set (by the flow or by the analyst). Absent on older runs. */
  effort?: string;
  tokens?: { input: number; output: number };
  /** Tool calls of this agent step and the time they took (whole ms), added up over all tries. Claude steps only; absent on Codex, shell and older runs. */
  tools?: { calls: number; totalMs: number; maxMs: number };
  /** The largest input of one model turn (input + cache read + cache creation tokens), the largest over all tries. Claude steps only; absent on Codex, shell and older runs. */
  contextTokens?: number;
  /** Time (ms) the step waited for a test slot, over all its tries; the time limit does not count it. Absent on older runs and on steps that did not wait. */
  slotWaitMs?: number;
  /** The agent hit a usage/rate limit and no fallback model could take over. */
  limited?: boolean;
  /** The AI service could not be reached at all (the limit flag is set so the run pauses). */
  unreachable?: boolean;
  /** Extra tries inside this step: after a brief outage, and on another model after a limit. */
  retried?: { blips: number; models: number };
  /** Tool calls Claude Code refused (at most 5), e.g. "Bash: mkdir out". */
  denied?: string[];
  /** The step was refused by an access rule (no key, no sign-in, no sandbox); the run failed at once. Absent on older runs. */
  accessFailed?: boolean;
  /** Foundry skills given to this agent session: `id@version` in load order, and the size of the block. `state` and `digest` say whether the session got the block (`loaded`, `reloaded`) or already held it (`reused`); `attached*` is what this step added to the prompt (0 when reused). `role` is set for a reviewer block. Absent without a current skill lock. `grant`: what a Claude coder session was given when the skill tools were checked; an estimate, absent on older runs, Codex and reviewer steps. */
  skills?: { grant?: SessionToolGrant; loaded: string[]; omitted?: string[]; bytes: number; estimatedTokens: number; role?: "reviewer"; state?: "loaded" | "reloaded" | "reused"; digest?: string; attachedBytes?: number; attachedEstimatedTokens?: number };
  /** A skill catalogue was put before this step's prompt: counts only, never the text. `hidden`: skills left out only because they are not pinned. */
  skillCatalogue?: { entries: number; omitted: number; estimatedTokens: number; hidden?: number; /** Skills with the same text, offered once: `id@version` only. */ mirrors?: { kept: string; collapsed: string[] }[]; mirrorsOmitted?: number; choices?: AppliedChoice[]; choicesOmitted?: number; choicesSource?: { pins: { commit: string; blob: string } }; canonical?: CanonicalSelectionRecord[]; /** Owner catalogue descriptions the agent saw, with their release. */ descriptions?: { skill: string; text: string; from: "skill-selections"; release: string }[]; descriptionsOmitted?: number };
  /** What the output of this step is: source, trust class, content type, size, hash, who may read it, risk (see untrusted.ts). Absent on older runs. */
  label?: OutputLabel;
  /** The step did not run: the content hashes it waits for a person to approve. Absent on older runs. */
  held?: string[];
  startedAt: string;
  durationMs: number;
  logFile: string;
  /** Set for steps run by a sub-flow step, e.g. "build/test". */
  parent?: string;
}

/** Why a failed run failed, in one sentence written by a model (see failure-explain.ts). */
export interface FailureNote {
  kind: "code" | "environment";
  why: string;
  /** The agent that wrote it, e.g. "claude:anthropic:haiku". */
  by: string;
}

/** Everything needed to continue a run later. */
export interface RunState {
  /** Step to run when the run is resumed (null: nothing left). */
  next: string | null;
  steps: Record<string, Record<string, unknown>>;
  visits: Record<string, number>;
}

/** Why a run that is not a local test was refused at start by `promotion.enforce: on` (#740). Fixed text: no path, no id. */
export const PROMOTION_REFUSED =
  "refused: this run uses components that are not promoted (promotion.enforce is on); promote them, or start a local test with scf run --local-test";
/** The log line of a local test. */
export const LOCAL_TEST_LINE = "local test: this run never counts as a promoted delivery";

/** One stop at a step's time limit that the Foundry answers with a retry (auto_retry.timeouts). Only an event with `startedAt` (the retry began) counts. */
export interface TimeLimitEvent { at: string; step: string; attempt: number; of: number; startedAt?: string }

export interface RunSummary {
  runId: string;
  flow: string;
  /** The flow definition the run started with, so resumes behave the same. */
  flowDef: Flow;
  task: string;
  vars: Record<string, string>;
  repo: string;
  status: RunStatus;
  reason?: string;
  /** When a watcher saw the run's open issue without its trigger label while the run waited for answers or was cancelled while stopped. A resume removes it. */
  parkedAt?: string;
  runDir: string;
  workdir?: string;
  branch?: string;
  /** Commit the workspace started from (for diffs). */
  baseSha?: string;
  /** The empty-workspace base for the `paths` fact: HEAD after the first step that left a checkout. */
  pathsBaseSha?: string;
  /** Set on new runs; without it the `paths` fact is never worked out (older runs). */
  pathsTracked?: boolean;
  /** The empty-workspace base could not be read when the checkout appeared; `paths` stays incomplete for the rest of the run. */
  pathsBaseLost?: boolean;
  startedAt: string;
  finishedAt?: string;
  totalCostUsd: number;
  history: StepRecord[];
  state: RunState;
  /** Set while status is "waiting". */
  waiting?: { stepId: string; message: string; since: string };
  /** A model's one-sentence reason for a failed run; gone when the run is resumed. */
  failureNote?: FailureNote;
  /** How many times the run was resumed. */
  resumes?: number;
  /** The stops at a time limit that were answered with a retry, oldest first (watcher story runs). Absent on older runs. */
  timeLimits?: TimeLimitEvent[];
  /** How often `implement` was handed to the planner after its retries (the next count goes on from there). */
  timeoutHandovers?: number;
  /** After a time limit: the step to continue at once the areas are claimed again. Absent: none. */
  retryStep?: string;
  /** The last 50 resumes (when, and the step each restarted at); the monitor reads it to find restart loops. */
  resumeLog?: { at: string; from: string }[];
  /** Process that last started or resumed the run. */
  pid?: number;
  /** When the top-level step in `state.next` started; only while that step runs. */
  stepStartedAt?: string;
  /** Who started the run, e.g. "ui", "cli" or "watcher <id> issue #7". Absent on runs of older versions. */
  source?: string;
  /** The id of the account that started the run. Absent for runs of watchers, the CLI and older versions. */
  owner?: string;
  /** The declared tool profile saved at start: the parsed profile, or `null` when the supplied one could not be read (`null` always refuses). Trusted like `owner`. Absent: steps get the profile their settings give. */
  toolProfile?: unknown;
  /** True for a local test (`scf run --local-test`, evals): it is not checked against `promotion.enforce` and never counts as a promoted delivery (#740). Only evals skip governance (#665). */
  localTest?: true;
  /** The most autonomy the run may use, worked out once at the start (#643). Absent on older runs, which read as `delivery-handoff` through `autonomyOfRun`. The engine enforces it (#644); a resume keeps it. */
  autonomy?: RunAutonomy;
  /** The id of the custom flow as `scf promote` knows it (its file name), saved so a resume checks the same id (#665). Absent: the flow's name. */
  flowId?: string;
  /** The run start check of `promotion.enforce` (warn or on); absent when it is off, for a local test and for older runs. */
  promotion?: PromotionRecord;
  /** Answers a person gave on the run page to the questions the run stopped with, oldest first. */
  answers?: RunAnswer[];
  /** Summary of <runDir>/skill-lock.json. Absent on runs without a checked plan and on runs of older versions. */
  skillLock?: RunSkillLockSummary;
  /** The canonical choice made when the lock was made (skills.selection.exclusive), keyed by the plan. Not in skill-lock.json. Absent on older runs and without exclusive capabilities. */
  skillSelection?: { planHash: string; canonical: CanonicalSelectionRecord[] };
  /** The skill resolution of the plan and what was decided about skills that could not be used. Absent on older runs and when no skill was asked for. */
  skillPlan?: RunSkillPlan;
  /** The skill request carried from the plan record at plan_check. Absent on older runs and on runs without a plan record. */
  skillCarry?: RunSkillCarry;
  /** What plan_check found (see plan-carry.ts). Absent on older runs and on runs with their own plan gate. */
  planCheck?: RunPlanCheck;
  /** Values a step handed on in `<run dir>/outputs.json` (see run-outputs.ts), e.g. `release_url` and `release_tag` of release-build. Absent on older runs. */
  outputs?: Record<string, string>;
  /** The question rounds the Foundry decided, from `<run dir>/decided.json` (see questions.ts). Admin only; absent on older runs. */
  decidedQuestions?: DecidedRound[];
  /** The run stopped at this step because content it reads needs a person's approval (sha256 of each content). Only a resume by a person from that step approves it. Absent on older runs and when nothing is held. */
  heldContent?: { step: string; sha256: string[] };
  /** Content hashes a person approved on resume (the newest 200). Absent on older runs. */
  approvedContent?: string[];
  /** When the run was archived (taken out of the default list). Absent: not archived. */
  archivedAt?: string;
  /** The id of the account that archived it. Never shown to a user. */
  archivedBy?: string;
}

/** An answer a person gave on the run page to the questions a run stopped with. */
export interface RunAnswer { at: string; text: string; by: string }

export const ANSWER_MAX_CHARS = 4000;
export const TASK_MAX_BYTES = 100_000;
export const ANSWERS_HEADING = "## Answers to the questions of this run (oldest first)";

/** The task as the steps read it: the typed task, then all answers under one fixed heading. */
export function taskWithAnswers(s: { task: string; answers?: RunAnswer[] }): string {
  const answers = Array.isArray(s.answers) ? s.answers : [];
  if (!answers.length) return s.task;
  return [s.task, ANSWERS_HEADING + "\n\n" + answers.map((a, i) => "Answer " + (i + 1) + ":\n" + a.text).join("\n\n")].filter(Boolean).join("\n\n");
}

/** How many bytes the text of one more answer may have. Below 1: no answer fits. */
export function answerRoom(s: { task: string; answers?: RunAnswer[] }): number {
  const old = Array.isArray(s.answers) ? s.answers : [];
  return TASK_MAX_BYTES - Buffer.byteLength(taskWithAnswers({ task: s.task, answers: [...old, { at: "", text: "", by: "" }] }));
}

/** The few fields of a run that are cheap to keep for every run. */
export interface RunBrief {
  runId: string;
  flow: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  source?: string;
  owner?: string;
  runDir: string;
  /** The name of the folder the run.json was found in (the stored runId is not a path). */
  dirName: string;
  /** When run.json was last written. */
  updatedAt: string;
  /** `vars.github_repo` and `vars.issue` of the run, when it has them. */
  githubRepo?: string;
  /** True when run.json has archivedAt. */
  archived?: boolean;
  /** `timeLimits` of the run, when it has them. */
  timeLimits?: TimeLimitEvent[];
  issue?: string;
  /** `vars.pr` and `vars.ci_run` of the run, when it has them. */
  pr?: string;
  ciRun?: string;
  /** `vars.chore_day` of a schedule run (the day of its slot), when it is a string. */
  choreDay?: string;
  /** A "running" run.json with no live process (set by the scheduler). */
  interrupted?: boolean;
  /** The first line of the task, at most 200 characters. Absent when the task is empty. */
  taskLine?: string;
  /** The title the pull_ticket step printed ("# #37: Title"), at most 200 characters. Memory only; absent when there is none. */
  issueTitle?: string;
}

export const TASK_LINE_MAX = 200;
/** The first line of a task, trimmed, at most TASK_LINE_MAX characters; undefined when there is none. */
export function taskLineOf(task: unknown): string | undefined {
  if (typeof task !== "string") return undefined;
  const line = [...task.split("\n", 1)[0]!.trim()].slice(0, TASK_LINE_MAX).join("");
  return line === "" ? undefined : line;
}

/** The issue title as the pull_ticket step printed it ("# #37: Title"); "" when the output is not text or has none. */
export function ticketTitleOf(output: unknown): string {
  return typeof output === "string" ? /^# #\d+: (.+)$/m.exec(output)?.[1]?.trim() ?? "" : "";
}

function issueTitleOf(s: RunSummary): string | undefined {
  const t = [...ticketTitleOf(s.state?.steps?.pull_ticket?.output)].slice(0, TASK_LINE_MAX).join("");
  return t === "" ? undefined : t;
}

/** When run.json was last written (undefined when it cannot be read). */
export function runUpdatedAt(runDir: string): string | undefined {
  try {
    return new Date(Math.round(statSync(runFile(runDir)).mtimeMs)).toISOString();
  } catch {
    return undefined;
  }
}

const briefCache = new Map<string, { mtimeMs: number; size: number; brief: RunBrief }>();

/** A brief of every run, newest first. A run.json is read again only when its time or size changed; broken files are skipped. */
export function listRunBriefs(runsDir: string): RunBrief[] {
  return listRunIds(runsDir).flatMap((id) => briefOf(runsDir, id) ?? []);
}

/** Like listRunBriefs, but gives the event loop a turn after every 50 runs (a cold start reads every file). */
export async function listRunBriefsAsync(runsDir: string): Promise<RunBrief[]> {
  const out: RunBrief[] = [];
  for (const [i, id] of listRunIds(runsDir).entries()) {
    if (i > 0 && i % 50 === 0) await new Promise<void>((r) => setImmediate(r));
    const b = briefOf(runsDir, id);
    if (b) out.push(b);
  }
  return out;
}

function briefOf(runsDir: string, id: string): RunBrief | undefined {
  const file = runFile(join(runsDir, id));
  try {
    const st = statSync(file);
    let hit = briefCache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const s = JSON.parse(readFileSync(file, "utf8")) as RunSummary;
      if (!s || typeof s.runId !== "string" || typeof s.status !== "string") return undefined;
      hit = { mtimeMs: st.mtimeMs, size: st.size, brief: { runId: s.runId, flow: s.flow, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, source: s.source, owner: s.owner, runDir: s.runDir, dirName: id, updatedAt: new Date(Math.round(st.mtimeMs)).toISOString(), ...(typeof s.vars?.github_repo === "string" ? { githubRepo: s.vars.github_repo } : {}), ...(typeof s.archivedAt === "string" ? { archived: true } : {}),...(typeof s.vars?.issue === "string" ? { issue: s.vars.issue } : {}), ...(Array.isArray(s.timeLimits) ? { timeLimits: s.timeLimits } : {}), ...(typeof s.vars?.pr === "string" ? { pr: s.vars.pr } : {}), ...(typeof s.vars?.ci_run === "string" ? { ciRun: s.vars.ci_run } : {}), ...(typeof s.vars?.chore_day === "string" ? { choreDay: s.vars.chore_day } : {}), ...(taskLineOf(s.task) !== undefined ? { taskLine: taskLineOf(s.task) } : {}), ...(issueTitleOf(s) !== undefined ? { issueTitle: issueTitleOf(s) } : {}) } };
      briefCache.set(file, hit);
    }
    return hit.brief;
  } catch {
    return undefined;
  }
}

export const runFile = (runDir: string) => join(runDir, "run.json");
export const liveLogFile = (runDir: string) => join(runDir, "live.log");

export function saveRun(s: RunSummary) {
  writeFileSync(runFile(s.runDir), JSON.stringify(s, null, 2));
}

export const pidAlive = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Adds `owner` to a run.json that has none, and changes nothing else (not the other fields, the file time or the mode).
 * Skips a run that is live (status "running" and its process is alive). The file is written beside it and renamed over
 * it; if run.json changed in between, nothing is replaced. Returns true when the owner was added. Never throws.
 */
export function adoptRun(runDir: string, owner: string, hooks: { beforeSwap?: () => void } = {}): boolean {
  const file = runFile(runDir);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const st = statSync(file);
    const text = readFileSync(file, "utf8");
    const s = JSON.parse(text) as Record<string, unknown>;
    if (!s || typeof s !== "object" || Array.isArray(s) || typeof s.owner === "string") return false;
    if (s.status === "running" && pidAlive(s.pid)) return false;
    writeFileSync(tmp, JSON.stringify({ ...s, owner }, null, 2), { mode: st.mode & 0o777, flag: "wx" });
    chmodSync(tmp, st.mode & 0o777);
    utimesSync(tmp, st.atime, new Date(Math.round(st.mtimeMs)));
    hooks.beforeSwap?.();
    // A second look: another process may have written run.json while we worked.
    if (readFileSync(file, "utf8") !== text) return false;
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Sets (at: ISO time) or removes (at: null) the archive mark of a run.json and changes nothing else (not the file
 * time or the mode). Skips a live run. Written beside the file and renamed over it; if run.json changed in between,
 * nothing is replaced. Returns true when the file was replaced. Never throws.
 */
export function setRunArchived(runDir: string, at: string | null, by?: string, hooks: { beforeSwap?: () => void } = {}): boolean {
  return rewriteRunMark(
    runDir,
    (s) => {
      if (s.status === "running" && pidAlive(s.pid)) return undefined;
      if ((typeof s.archivedAt === "string") === (at !== null)) return undefined;
      let next: Record<string, unknown>;
      if (at !== null) next = { ...s, archivedAt: at, ...(by ? { archivedBy: by } : {}) };
      else {
        next = { ...s };
        delete next.archivedAt;
        delete next.archivedBy;
      }
      return next;
    },
    hooks,
  );
}

/** Sets the parked mark of a stopped or cancelled run (once). Changes nothing else. Returns true when the file was replaced. Never throws. */
export function setRunParked(runDir: string, at: string): boolean {
  return rewriteRunMark(runDir, (s) => {
    if ((s.status !== "stopped" && s.status !== "cancelled") || typeof s.parkedAt === "string") return undefined;
    return { ...s, parkedAt: at };
  });
}

/** Takes the parked mark off a run again (a park that could not be finished). Changes nothing else. Returns true when the file was replaced. Never throws. */
export function clearRunParked(runDir: string): boolean {
  return rewriteRunMark(runDir, (s) => {
    if (typeof s.parkedAt !== "string") return undefined;
    const next = { ...s };
    delete next.parkedAt;
    return next;
  });
}

/** The reason of a run cancelled while it was stopped: it sets this cancel apart from an aborted running run, which a watcher resumes. */
export const STOPPED_CANCEL_REASON = "cancelled by user while stopped";
/** The reason of a run the Foundry stopped before its next step to plan it again (an overrule). */
export const OVERRULED_REASON = "overruled";
export const isOverruledStop = (s: Pick<RunSummary, "status" | "reason">): boolean => s.status === "stopped" && s.reason === OVERRULED_REASON;
export const isStoppedCancel =(reason?: string): boolean => reason === STOPPED_CANCEL_REASON;

/**
 * Rewrites run.json with `change` and changes nothing else (not the file time or the mode). `change` returns the new
 * content, or undefined to skip. Written beside the file and renamed over it; if run.json changed in between, nothing
 * is replaced. Returns true when the file was replaced. Never throws.
 */
function rewriteRunMark(runDir: string, change: (s: Record<string, unknown>) => Record<string, unknown> | undefined, hooks: { beforeSwap?: () => void } = {}): boolean {
  const file = runFile(runDir);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const st = statSync(file);
    const text = readFileSync(file, "utf8");
    const s = JSON.parse(text) as Record<string, unknown>;
    if (!s || typeof s !== "object" || Array.isArray(s)) return false;
    const next = change(s);
    if (!next) return false;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: st.mode & 0o777, flag: "wx" });
    chmodSync(tmp, st.mode & 0o777);
    utimesSync(tmp, st.atime, new Date(Math.round(st.mtimeMs)));
    hooks.beforeSwap?.();
    // A second look: another process may have written run.json while we worked.
    if (readFileSync(file, "utf8") !== text) return false;
    renameSync(tmp, file);
    briefCache.delete(file);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function loadRun(runsDir: string, runId: string): RunSummary | undefined {
  if (!/^[\w-]+$/.test(runId)) return undefined;
  const p = runFile(join(runsDir, runId));
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as RunSummary;
}

/** Like loadRun, but reads with fs/promises so the event loop stays free. A missing run.json gives undefined. */
export async function loadRunAsync(runsDir: string, runId: string): Promise<RunSummary | undefined> {
  if (!/^[\w-]+$/.test(runId)) return undefined;
  try {
    return JSON.parse(await readFile(runFile(join(runsDir, runId)), "utf8")) as RunSummary;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export function listRunIds(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((d) => existsSync(runFile(join(runsDir, d)))).sort().reverse();
}

export function appendLiveLog(runDir: string, line: string) {
  try {
    appendFileSync(liveLogFile(runDir), line + "\n");
  } catch {
    // run dir removed (e.g. by clean) — logging must never break a run
  }
}

export function readLiveLog(runDir: string): string[] {
  const p = liveLogFile(runDir);
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean) : [];
}

/** Total spend of runs that started today (local time). Run ids start with a UTC timestamp, so read startedAt. */
export function spentToday(runsDir: string, now = new Date()): number {
  const day = now.toDateString();
  let total = 0;
  for (const id of listRunIds(runsDir).slice(0, 500)) {
    const s = loadRun(runsDir, id);
    if (!s) continue;
    if (new Date(s.startedAt).toDateString() === day) total += s.totalCostUsd;
    else if (new Date(s.startedAt) < new Date(now.getTime() - 2 * 86_400_000)) break; // sorted newest first
  }
  return total;
}

/** The stop reason of a run that reached its owner's daily budget. It carries no amount: it reaches users. */
export const USER_BUDGET_REASON = "your daily limit is reached — resume tomorrow";
export const isUserBudgetStop = (reason?: string): boolean => /^your daily limit is reached/.test(reason ?? "");
/** A stop that the Foundry answers with a retry after a step ran out of time (see engine/auto-retry.ts). */
export const isTimeLimitStop = (reason?: string): boolean => /^ran out of time in /.test(reason ?? "");

/** Total spend of the runs of one account that started today (same day rule, 500-run window and early break as spentToday). */
export function spentTodayBy(runsDir: string, owner: string, now = new Date()): number {
  const day = now.toDateString();
  let total = 0;
  for (const id of listRunIds(runsDir).slice(0, 500)) {
    let s: RunSummary | undefined;
    try {
      s = loadRun(runsDir, id);
    } catch {
      continue;
    }
    if (!s) continue;
    if (new Date(s.startedAt).toDateString() === day) {
      if (s.owner === owner && Number.isFinite(s.totalCostUsd)) total += s.totalCostUsd;
    } else if (new Date(s.startedAt) < new Date(now.getTime() - 2 * 86_400_000)) break; // sorted newest first
  }
  return total;
}
