import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { DEFAULT_WORKSPACE, validWorkspaceId } from "../workspaces/list.js";
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
  tokens?: { input: number; output: number; cached?: number };
  /** The cost (USD) of earlier tries of this step (paid retries and fallbacks); it is already in the run's total. Absent when there were none. */
  earlierCostUsd?: number;
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
  skillCatalogue?: { entries: number; omitted: number; estimatedTokens: number; hidden?: number; /** Skills with the same text, offered once: `id@version` only. */ mirrors?: { kept: string; collapsed: string[] }[]; mirrorsOmitted?: number; choices?: AppliedChoice[]; choicesOmitted?: number; choicesSource?: { pins: { commit: string; blob: string } }; canonical?: CanonicalSelectionRecord[]; /** Owner catalogue descriptions the agent saw, with their release. */ descriptions?: { skill: string; text: string; from: "skill-selections"; release: string }[]; descriptionsOmitted?: number; /** Technologies seen in the repository profile (observations only). */ technologies?: { name: string; confidence: string; version?: string }[] };
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
  /** The workspace (#816). Absent: "default" (also older runs). */
  workspace?: string;
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
  /** Skill-gap issues opened for the unknown skills this run stopped for (#776). While set, a stop for those skills waits and resumes by itself. */
  skillGap?: { topic: string; issue: number; url: string }[];
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
  /** `autonomy` of the run as stored (read it with `autonomyOfRun`); absent on older runs. */
  autonomy?: unknown;
  /** True for a local-test run. */
  localTest?: true;
  /** The workspace stored with the run (#817); absent: "default". */
  workspace?: string;
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
  return listAllRunIds(runsDir).flatMap((e) => briefOf(e.runsDir, e.id) ?? []);
}

/** Like listRunBriefs, but gives the event loop a turn after every 50 runs (a cold start reads every file). */
export async function listRunBriefsAsync(runsDir: string): Promise<RunBrief[]> {
  const out: RunBrief[] = [];
  for (const [i, e] of listAllRunIds(runsDir).entries()) {
    if (i > 0 && i % 50 === 0) await new Promise<void>((r) => setImmediate(r));
    const b = briefOf(e.runsDir, e.id);
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
      hit = { mtimeMs: st.mtimeMs, size: st.size, brief: { runId: s.runId, flow: s.flow, status: s.status, startedAt: s.startedAt, finishedAt: s.finishedAt, source: s.source, owner: s.owner, runDir: s.runDir, dirName: id, updatedAt: new Date(Math.round(st.mtimeMs)).toISOString(), ...(typeof s.vars?.github_repo === "string" ? { githubRepo: s.vars.github_repo } : {}), ...(typeof s.archivedAt === "string" ? { archived: true } : {}),...(typeof s.vars?.issue === "string" ? { issue: s.vars.issue } : {}), ...(Array.isArray(s.timeLimits) ? { timeLimits: s.timeLimits } : {}), ...(typeof s.vars?.pr === "string" ? { pr: s.vars.pr } : {}), ...(typeof s.vars?.ci_run === "string" ? { ciRun: s.vars.ci_run } : {}), ...(typeof s.vars?.chore_day === "string" ? { choreDay: s.vars.chore_day } : {}), ...(taskLineOf(s.task) !== undefined ? { taskLine: taskLineOf(s.task) } : {}), ...(issueTitleOf(s) !== undefined ? { issueTitle: issueTitleOf(s) } : {}), ...(s.autonomy !== undefined ? { autonomy: s.autonomy } : {}), ...(s.localTest ? { localTest: true as const } : {}), ...(typeof s.workspace === "string" ? { workspace: s.workspace } : {}) } };
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
  const dir = runDirOf(runsDir, runId);
  if (!dir) return undefined;
  return JSON.parse(readFileSync(runFile(dir), "utf8")) as RunSummary;
}

/** Like loadRun, but reads with fs/promises so the event loop stays free. A missing run.json gives undefined. */
export async function loadRunAsync(runsDir: string, runId: string): Promise<RunSummary | undefined> {
  if (!RUN_ID_RE.test(runId)) return undefined;
  for (const dir of allRunsDirs(runsDir)) {
    try {
      return JSON.parse(await readFile(runFile(join(dir, runId)), "utf8")) as RunSummary;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
  }
  return undefined;
}

/** Reads one run from one runs folder; undefined when it is not there. */
function loadRunIn(dir: string, id: string): RunSummary | undefined {
  const p = runFile(join(dir, id));
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as RunSummary;
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
  for (const e of listAllRunIds(runsDir).slice(0, 500)) {
    const s = loadRunIn(e.runsDir, e.id);
    if (!s) continue;
    if (new Date(s.startedAt).toDateString() === day) total += s.totalCostUsd;
    else if (new Date(s.startedAt) < new Date(now.getTime() - 2 * 86_400_000)) break; // sorted newest first
  }
  return total;
}

/** The stop reason of a run that reached its owner's daily budget. It carries no amount: it reaches users. */
export const USER_BUDGET_REASON = "your daily limit is reached — resume tomorrow";
/** The stop reason of a run whose project reached its daily cap (#792). It carries no amount. */
export const PROJECT_BUDGET_REASON = "the project's daily limit is reached — resume tomorrow";
/** The stop reason of a run whose issue reached its spending limit (#786). It carries amounts: only admins see run reasons. */
export const ISSUE_LIMIT_START = "the issue's spending limit";
export function issueLimitReason(spentUsd: number, limitUsd: number): string {
  return `${ISSUE_LIMIT_START} is reached: $${spentUsd.toFixed(2)} spent of $${limitUsd.toFixed(2)} (the issue, its split parts and retries) — an administrator can raise it on the run page`;
}
export const ISSUE_LIMIT_UNCHECKED = `${ISSUE_LIMIT_START} could not be checked — an administrator can look at the run and resume it`;
export const isIssueLimitStop = (reason?: string): boolean => (reason ?? "").startsWith(ISSUE_LIMIT_START);
export const isProjectBudgetStop = (reason?: string): boolean => /^the project's daily limit is reached/.test(reason ?? "");
/** A stop by a daily spending limit, the owner's or (#792) the project's; paused work that goes on by itself. */
export const isUserBudgetStop = (reason?: string): boolean => /^your daily limit is reached/.test(reason ?? "") || isProjectBudgetStop(reason);

/** A project: a GitHub repository (`vars.github_repo`) or a local one (`vars.repo_id`). */
export interface ProjectRef {
  githubRepo?: string;
  repoId?: string;
}

export function projectOfVars(vars?: Record<string, string>): ProjectRef | undefined {
  if (vars?.github_repo) return { githubRepo: vars.github_repo };
  if (vars?.repo_id) return { repoId: vars.repo_id };
  return undefined;
}

/**
 * Total spend of the runs of one project that started today. Unlike spentTodayBy there is no 500-run window:
 * a cap must not release a project because newer runs of others pushed today's runs out of the window.
 */
export function spentTodayByProject(runsDir: string, project: ProjectRef, now = new Date()): number {
  const day = now.toDateString();
  const want = project.githubRepo?.toLowerCase();
  let total = 0;
  for (const e of listAllRunIds(runsDir)) {
    let s: RunSummary | undefined;
    try {
      s = loadRunIn(e.runsDir, e.id);
    } catch {
      continue;
    }
    if (!s) continue;
    const at = new Date(s.startedAt);
    if (at.toDateString() === day) {
      const p = projectOfVars(s.vars);
      const mine = want !== undefined ? p?.githubRepo?.toLowerCase() === want : project.repoId !== undefined && p?.repoId === project.repoId && !p.githubRepo;
      if (mine && Number.isFinite(s.totalCostUsd)) total += s.totalCostUsd;
    } else if (at < new Date(now.getTime() - 2 * 86_400_000)) break; // sorted newest first
  }
  return total;
}
const monthCache = new Map<string, { mtimeMs: number; size: number; startedAt: string; workspace: string; cost: number }>();

/**
 * The runs folders for spend accounting (#786): the given one, then the `runs` folder of every workspace folder. Unlike
 * allRunsDirs it THROWS when the workspaces cannot be listed or a workspace's `runs` cannot be looked at: an absent folder is
 * unused, but a failed look would understate the total and release work (fail closed).
 */
export function accountingRunsDirs(runsDir: string): string[] {
  const data = dirname(runsDir);
  const container = join(data, WORKSPACES_DIR);
  const out = [runsDir];
  try {
    lstatSync(container);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return out;
    throw e;
  }
  // a container that leaves the data folder is not followed (the same rule as allRunsDirs)
  if (!realInside(data, container)) return out;
  for (const d of readdirSync(container, { withFileTypes: true })) {
    if (!d.isDirectory() || !validWorkspaceId(d.name) || d.name === DEFAULT_WORKSPACE) continue;
    const runs = join(container, d.name, "runs");
    try {
      if (lstatSync(runs).isDirectory()) out.push(runs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e;
    }
  }
  return out;
}

/** The ids with a run.json in one folder; THROWS when the folder exists but cannot be listed. */
export function accountingRunIds(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names.filter((d) => {
    try {
      statSync(runFile(join(dir, d)));
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") return false;
      throw e;
    }
  });
}

/** Every run.json of the accounting folders, parsed with the mtime/size cache. THROWS when a file cannot be read. */
function monthSpend(runsDir: string, now: Date, keep: (workspace: string) => boolean): number {
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  let total = 0;
  for (const dir of accountingRunsDirs(runsDir)) {
    for (const id of accountingRunIds(dir)) {
      const file = runFile(join(dir, id));
      const st = statSync(file);
      let e = monthCache.get(file);
      if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
        const s = JSON.parse(readFileSync(file, "utf8")) as RunSummary;
        e = { mtimeMs: st.mtimeMs, size: st.size, startedAt: String(s.startedAt), workspace: validWorkspaceId(s.workspace) ? s.workspace : DEFAULT_WORKSPACE, cost: s.totalCostUsd };
        monthCache.set(file, e);
      }
      const at = Date.parse(e.startedAt);
      if (keep(e.workspace) && at >= from && at < to && Number.isFinite(e.cost)) total += e.cost;
    }
  }
  return total;
}

/**
 * Total spend of the runs of one workspace that started in the current UTC calendar month (#819), also those kept in
 * workspace folders (#824). A run without a `workspace` counts for "default". Costs that are not finite are skipped. THROWS
 * when a folder or a run file cannot be read: a caller that holds work treats that as "over" (fail closed). A small cache
 * keyed by the file's mtime and size keeps a look to one stat per run.
 */
export function spentThisMonthByWorkspace(runsDir: string, workspace: string, now = new Date()): number {
  return monthSpend(runsDir, now, (w) => w === workspace);
}

/** Total spend of all runs of all workspaces that started in the current UTC month (#786). May throw, like spentThisMonthByWorkspace. */
export function spentThisMonth(runsDir: string, now = new Date()): number {
  return monthSpend(runsDir, now, () => true);
}

/** A stop that the Foundry answers with a retry after a step ran out of time (see engine/auto-retry.ts). */
export const isTimeLimitStop = (reason?: string): boolean => /^ran out of time in /.test(reason ?? "");

/** Total spend of the runs of one account that started today (same day rule, 500-run window and early break as spentToday). */
export function spentTodayBy(runsDir: string, owner: string, now = new Date()): number {
  const day = now.toDateString();
  let total = 0;
  for (const e of listAllRunIds(runsDir).slice(0, 500)) {
    let s: RunSummary | undefined;
    try {
      s = loadRunIn(e.runsDir, e.id);
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

// ---- Workspace folders (#824) ----------------------------------------------------------------------------------------
// The runs folder is the anchor every caller passes. `default` runs stay in it; the runs of any other listed workspace
// live in `<dirname(runsDir)>/workspaces/<id>/runs/`. Folder names come only from validated ids.

export const WORKSPACES_DIR = "workspaces";
export const RUN_ID_RE = /^[\w-]+$/;
export const WORKSPACE_REMOVED = "WORKSPACE_REMOVED: this run's workspace is no longer in the list; its runs can be read but not started, resumed or changed";

export class WorkspaceFolderError extends Error {
  constructor(message: string) {
    super("WORKSPACE_FOLDER_REFUSED: " + message);
  }
}

/** Throws when `p` is a link whose real path is not inside the real data folder. A missing path is fine. */
function refuseEscapingLink(realData: string, p: string): void {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return;
  }
  if (!st.isSymbolicLink()) return;
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    throw new WorkspaceFolderError("a link in the workspace folder cannot be resolved");
  }
  if (real !== realData && !real.startsWith(realData + sep)) throw new WorkspaceFolderError("a link in the workspace folder leaves the data folder");
}

/** `<data>/workspaces/<id>` for a valid id other than `default`. Throws for a bad id or a link that leaves the data folder. */
export function workspaceFolderIn(data: string, id: string): string {
  if (!validWorkspaceId(id) || id === DEFAULT_WORKSPACE) throw new WorkspaceFolderError("that is not a workspace folder id");
  const container = join(data, WORKSPACES_DIR);
  const dir = join(container, id);
  let realData: string;
  try {
    realData = realpathSync(data);
  } catch {
    return dir; // no data folder yet: nothing can be a link
  }
  for (const p of [container, dir, join(dir, "runs"), join(dir, "locks")]) refuseEscapingLink(realData, p);
  return dir;
}

/** `<data>/workspaces/<id>/skills` (#825). Refuses a link that leaves the data folder; a bad skills link does not block the rest of the workspace. */
export function workspaceSkillsFolderIn(data: string, id: string): string {
  const dir = join(workspaceFolderIn(data, id), "skills");
  let realData: string;
  try {
    realData = realpathSync(data);
  } catch {
    return dir;
  }
  refuseEscapingLink(realData, dir);
  return dir;
}

export const workspaceDir = (runsDir: string, id: string): string => workspaceFolderIn(dirname(runsDir), id);

/** The runs folder of a workspace; the given runs folder for `default` or none. */
export function workspaceRunsDir(runsDir: string, ws?: string): string {
  return ws === undefined || ws === DEFAULT_WORKSPACE ? runsDir : join(workspaceDir(runsDir, ws), "runs");
}

/** The workspace folders under `<data>/workspaces`: real folders with a valid id other than `default` (links and files are skipped). Never throws. */
export function workspaceFoldersIn(data: string): { id: string; dir: string }[] {
  try {
    const container = join(data, WORKSPACES_DIR);
    // a container that is a link must still point inside the data folder, or nothing under it is listed
    if (!realInside(data, container)) return [];
    return readdirSync(container, { withFileTypes: true })
      .filter((d) => d.isDirectory() && validWorkspaceId(d.name) && d.name !== DEFAULT_WORKSPACE)
      .map((d) => ({ id: d.name, dir: join(container, d.name) }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch {
    return [];
  }
}

export const workspaceDirsIn = (runsDir: string): { id: string; dir: string }[] => workspaceFoldersIn(dirname(runsDir));

function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True when `p` exists and its real path is the data folder or inside it (a link that leaves the data folder is false). */
function realInside(data: string, p: string): boolean {
  try {
    const real = realpathSync(p);
    const root = realpathSync(data);
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
}

/** The given runs folder, then the `runs` folder of every workspace folder (only real folders). Never throws. */
export function allRunsDirs(runsDir: string): string[] {
  return [runsDir, ...workspaceDirsIn(runsDir).map((w) => join(w.dir, "runs")).filter(isRealDir)];
}

/** Ids of runs with a run.json in every runs folder, newest first. On a duplicate id the first folder (the given runs folder) wins. */
export function listAllRunIds(runsDir: string): { id: string; runsDir: string }[] {
  const seen = new Map<string, string>();
  for (const dir of allRunsDirs(runsDir)) for (const id of listRunIds(dir)) if (!seen.has(id)) seen.set(id, dir);
  return [...seen.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)).map(([id, dir]) => ({ id, runsDir: dir }));
}

/** The folder of a run: the first runs folder with `<id>/run.json`. Undefined for an invalid or unknown id. */
export function runDirOf(runsDir: string, runId: string): string | undefined {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) return undefined;
  const first = join(runsDir, runId);
  if (existsSync(runFile(first))) return first;
  // the same rule as allRunsDirs: a `runs` link is not followed
  for (const dir of workspaceDirsIn(runsDir).map((w) => join(w.dir, "runs")).filter(isRealDir)) {
    const d = join(dir, runId);
    if (existsSync(runFile(d))) return d;
  }
  return undefined;
}

/** True when any runs folder (but `except`, a runs folder) has an entry with this id, with or without run.json. */
export function runIdTaken(runsDir: string, runId: string, except?: string): boolean {
  for (const dir of allRunsDirs(runsDir)) {
    if (dir === except) continue;
    try {
      lstatSync(join(dir, runId));
      return true;
    } catch {
      // not here
    }
  }
  return false;
}

/**
 * Reserves the run folder of `summary` (its parent is the runs folder): `mkdir` without `recursive` on the run folder itself,
 * so an existing folder, with or without run.json, is refused and never touched. Then the id must not exist in another runs
 * folder; if it does, only our own empty folder is removed again. Throws `run id <id> is already taken`.
 */
export function claimRunDir(runsDir: string, summary: Pick<RunSummary, "runDir">, hooks: { afterClaim?: () => void } = {}): void {
  const dir = summary.runDir;
  const parent = dirname(dir);
  const id = dir.slice(parent.length + 1);
  if (!RUN_ID_RE.test(id)) throw new Error("invalid run id");
  mkdirSync(parent, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`run id ${id} is already taken`);
    throw e;
  }
  hooks.afterClaim?.();
  if (runIdTaken(runsDir, id, parent)) {
    try {
      rmdirSync(dir);
    } catch {
      // not empty: not ours to remove
    }
    throw new Error(`run id ${id} is already taken`);
  }
}

/**
 * Test slots stay machine-wide: flows and the test gate use `<runDir>/../../test-slots`, which for a workspace run is
 * `<data>/workspaces/<id>/test-slots`. That is a relative link to `<data>/test-slots`. An existing entry is left alone.
 */
export function ensureWorkspaceTestSlots(runsDir: string, ws: string): void {
  const data = dirname(runsDir);
  const dir = workspaceDir(runsDir, ws);
  mkdirSync(join(data, "test-slots"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  try {
    lstatSync(join(dir, "test-slots"));
  } catch {
    try {
      symlinkSync(join("..", "..", "test-slots"), join(dir, "test-slots"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
}
