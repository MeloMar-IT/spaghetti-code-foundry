import { watcherOwner } from "../auth/run-owner.js";
import type { WatcherConfig } from "../config.js";
import { isStoppedCancel, isUserBudgetStop, loadRun, spentToday, spentTodayBy, type RunBrief, type RunSummary } from "../engine/state.js";
import { errorLine, explainError } from "../errors.js";
import { ActorSchema, RepositorySchema } from "../evidence/identity.js";
import { watcherRef } from "../telemetry/envelope.js";
import { emitLiveTelemetry } from "../telemetry/telemetry.js";
import { loadFlow } from "../flow/load.js";
import { commentReads, extraWaitingIssues, EXTRA_READS_PER_CHECK, EXTRA_READ_MEMO_MS, isPaused, openQuestion, steppedAsideFor, waitingLabelOf, waitsAs, type CommentReads } from "./waiting-issues.js";
import { canWrite, commentOnIssue, commentsAfter, ensureLabel, gh, ghActsAsApp, ghJson, isBot, isStatusComment, issueComments, issueStates, listOpenIssuesByLabelPages, setLabels, withGhEnv, type Comment, type Issue, type RestIssue } from "../github.js";
import { knownIssueState, markIssueCheckFailed, noteIssueState, saveIssueStates } from "../issue-states.js";
import { failedIndex, failureSummary } from "../failure.js";
import { asksQuestions, countQuestions, firstLine, releaseAtFor, runClosedIssue, LIMIT_RETRY_MS, nextStep, runNextStep, type NextData, type BlockerInfo, type NextKind, type NextStep } from "../next-step.js";
import { flowRetired } from "../run-gate.js";
import { LABEL_WORDS } from "../words.js";
import { RELEASE_BUILD_FLOW, RELEASE_BUILD_SUBMISSION_VAR, RELEASE_BUILD_VAR } from "../release/auto-build.js";
import { effectiveVars } from "../engine/runner.js";
import { DEPS_MARK, dependencies, foundryDependsOn, openDependencies, type DoneRule } from "./deps.js";
import { checkReleaseBuild, mainBranchOf, releaseCheckEvery } from "./release-trigger.js";
import { freshIssueList, isTrackingEpic } from "./issue-list.js";
import type { RepoGhIdentity } from "./gh-identity.js";
import type { Scheduler } from "./scheduler.js";
import { StatusComments } from "./status-comment.js";
import { notCodeStop, parkedComment, wantsPark } from "./park.js";
import { contentsPath, filesToCheck, openOwnerActions, OWNER_FILE_MARK, type OwnerAsk } from "./owner-action.js";
import { validBranchName } from "../auth/repo-settings.js";

/** Status labels the watcher puts on issues. Remove one to have the issue picked up again. */
export const STATUS_LABELS = {
  working: { name: "factory:working", color: "1d4ed8", description: LABEL_WORDS.working },
  done: { name: "factory:done", color: "15803d", description: LABEL_WORDS.done },
  needsInfo: { name: "factory:needs-info", color: "d97706", description: LABEL_WORDS.needsInfo },
  waiting: { name: "factory:waiting-approval", color: "7c3aed", description: LABEL_WORDS.waiting },
  failed: { name: "factory:failed", color: "b91c1c", description: LABEL_WORDS.failed },
} as const;
type LabelKey = keyof typeof STATUS_LABELS;
type LabelNames = Record<LabelKey, string>;

/** Status label names for a watcher: its own names where set, factory:* otherwise. */
export function labelNames(cfg: WatcherConfig): LabelNames {
  const o = cfg.status_labels ?? {};
  return {
    working: o.working ?? STATUS_LABELS.working.name,
    done: o.done ?? STATUS_LABELS.done.name,
    needsInfo: o.needs_info ?? STATUS_LABELS.needsInfo.name,
    waiting: o.waiting ?? STATUS_LABELS.waiting.name,
    failed: o.failed ?? STATUS_LABELS.failed.name,
  };
}

/**
 * The failure comment on an issue: what to do first, then what happened and why, then the raw text under Details.
 * `factoryWhat` (the record's "The Foundry failed, not the code: …") is set when the Foundry itself failed:
 * the first line says so and it replaces the What and Why lines.
 */
export function failureComment(s: RunSummary, next: NextStep): string {
  const factory = next.cause === "factory";
  const e = explainError(s.reason);
  const sum = next.failure ?? failureSummary(s, { watched: true });
  const hist = Array.isArray(s.history) ? s.history : [];
  const failed = hist[failedIndex(hist)];
  const tail = (failed?.output || failed?.error || "").trim().slice(-3000);
  const raw = [e.detail, tail].filter(Boolean).join("\n\n");
  return [
    firstLine(next),
    "",
    factory ? "🤖 **Spaghetti Code Foundry** itself failed on this issue, not the code." : "🤖 **Spaghetti Code Foundry** could not finish this issue.",
    "",
    `- **What happened:** ${sum.what.replace(/[.!?]+$/, "")}.`,
    `- **Why:** ${sum.why}`,
    `- **Kind of problem:** ${sum.kind}`,
    `- **Already tried:** ${sum.tried.replace(/[.!?]+$/, "")}.`,
    ...(sum.byModel ? ["", "_(A model read the output of the failing step to write the Why line. It can be wrong; the raw text is under Details.)_"] : []),
    "",
    "**Your options**",
    ...sum.options.map((o) => `- ${o}`),
    failed ? `\nLast failing step: \`${failed.id}\`${failed.visit > 1 ? ` (attempt ${failed.visit})` : ""}` : "",
    raw ? `\n<details><summary>Details</summary>\n\n\`\`\`\n${raw.replace(/`{3,}/g, (m) => "ˋ".repeat(m.length))}\n\`\`\`\n</details>` : "",
    `\n<!-- claude-factory run=${s.runId} -->`,
  ].join("\n");
}

/** Flow each source runs when the watcher doesn't name one. */
export const DEFAULT_FLOWS: Partial<Record<WatcherConfig["source"], string>> = {
  issues: "issue-gitflow",
  schedule: "release-daily",
  // pr-feedback and ci-failures have no shipped flow any more: such a watcher names its own.
};

/** "5m" | "30s" | "1h" | "7d" | "10" (minutes) → ms. */
export function parseInterval(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/.exec(text.trim());
  if (!m) throw new Error(`invalid interval "${text}" (use e.g. 30s, 5m, 1h, 7d)`);
  const n = Number(m[1]) * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? "m") as "s" | "m" | "h" | "d"];
  if (n > 2_000_000_000) throw new Error("interval must be at most 23 days");
  if (n < 10_000) throw new Error("interval must be at least 10s");
  return n;
}

export interface WatcherDeps {
  scheduler: Scheduler;
  runsDir: string;
  /** Local dir used to look up flows by name. */
  repo: string;
  dailyBudget?: () => number | undefined;
  /** Is this running run waiting for a code area? (reads the step log) */
  areaWait?: (run: RunSummary) => { runId: string; areas: string } | undefined;
  log: (msg: string) => void;
  /** Shared by the watchers of one repository (the manager sets it). */
  statusComments?: StatusComments;
  /** Every watcher's config, to find the scheduled release of a finished run. */
  watchers?: () => WatcherConfig[];
  /** The other watchers and what their last check saw (the manager sets it). */
  peers?: () => { watcher: WatcherConfig; status: WatcherStatus; issues: TrackedIssue[] }[];
  /** Called after every check, good or failed (the monitor's request-limit reading). A rejection is ignored. */
  afterCheck?: () => Promise<void> | void;
  /** The sign-in of the watcher's repository (stored watchers); without it the watcher uses the host's `gh` login. */
  gh?: RepoGhIdentity;
}

export interface WatcherStatus {
  id: string;
  lastTick?: string;
  /** End of the last check that finished without an error. */
  lastOk?: string;
  /** When the watcher was started (for the stale check, before its first check). */
  startedAt?: string;
  nextTick?: string;
  lastError?: string;
  lastActions: string[];
  /** The monitor: what waits or is wrong with its bug stories, in plain sentences (rebuilt every check). */
  notes?: string[];
  /** Why issues with the trigger label are not being started right now (rebuilt every check). */
  holds?: Hold[];
  /** Since when the checks fail (kept while they keep failing). */
  errorSince?: string;
  /** How many checks in a row failed (kept while they keep failing). */
  errorCount?: number;
  /** The pull request that pauses new work (pause_while_pr_open). */
  pausedBy?: { number: number; url?: string; title?: string; createdAt?: string };
}

export interface Hold {
  issue?: number;
  title?: string;
  /** The record's one sentence. */
  reason: string;
  /** Link to what it waits for (e.g. the release pull request). */
  url?: string;
  next: NextStep;
  /** A time from GitHub (comment, pull request); the same after a restart. */
  since?: string;
  /** When this server first saw the hold; starts again after a restart. */
  seen?: string;
  /** Built from the label alone: the comments could not be read in this check. */
  byLabel?: true;
}

const holdKey = (h: Hold) => `${h.issue ?? ""}|${h.next.kind}|${h.next.runId ?? ""}`;

/** A hold carries its record; reason and url come from it. */
export function toHold(next: NextStep): Hold {
  return { issue: next.issue, title: next.title || undefined, reason: next.text, url: next.where.url, next };
}

/** Every non-excluded issue a tick saw. */
export interface TrackedIssue {
  issue: number; title: string; runId?: string; done?: boolean;
  /** A bug story: it goes before other stories. */
  priority?: boolean;
  /** When the issue was created (GitHub). */
  createdAt?: string;
  /** Priority only: the run that holds the code area this story waits for. */
  claims?: string;
  /** The status label has not fitted the newest run for `checks` checks in a row (for the monitor). `label` is the key, e.g. "working". */
  labelOff?: { checks: number; label: string; run: string };
  /** Listed only because of its waiting label (not in the trigger list): never changed. */
  extra?: true;
}

/** Does the issue carry one of the priority labels? GitHub label names ignore case. */
export function goesFirst(issue: { labels: { name: string }[] }, labels: string[]): boolean {
  const want = new Set(labels.map((l) => l.trim().toLowerCase()).filter(Boolean));
  return want.size > 0 && issue.labels.some((l) => want.has(l.name.trim().toLowerCase()));
}

const firstMeta = (first?: { storyAt?: string }) => (first ? { priority: true, ...(first.storyAt ? { storyAt: first.storyAt } : {}) } : {});

const APPROVE_RE = /^\s*\/(approve|reject)\b[ \t]*(.*)$/im;

/** The hidden mark of a `/defaults` comment the watcher wrote itself (auto_defaults), and how many it writes per issue. */
const AUTO_DEFAULTS_MARK = "<!-- spaghetti-code-foundry auto-defaults -->";
const AUTO_DEFAULTS_MAX = 2;

/** A contents answer that is one file (not a directory's list). */
function isFileBody(body: string): boolean {
  try {
    const v: unknown = JSON.parse(body);
    return !!v && typeof v === "object" && !Array.isArray(v) && (v as { type?: unknown }).type === "file";
  } catch {
    return false;
  }
}

/** owner_action questions that wait for a file: how often a found file resumes one issue, and the limits of the file checks per check. */
const OWNER_FILE_MAX = 2;
const FILE_CHECKS_PER_TICK = 20;
const FILE_CHECK_MS = 30_000;
/** When the cap was reached at the last check, an issue checked within this time waits its turn, so later issues get checked too. */
const FILE_RECHECK_MS = 5 * 60_000;

export { steppedAsideFor };

/** Usage limits reset after a while; try a limited run again at most every 30 minutes. */
export { LIMIT_RETRY_MS };
function retryLimitAfter(s: RunSummary): boolean {
  return Date.now() - new Date(s.finishedAt ?? s.startedAt).getTime() >= LIMIT_RETRY_MS;
}

/** Direct confirmations (gh issue view) per check that an issue lost its trigger label, and how long a "no" is remembered. */
const PARK_CHECKS_PER_TICK = 10;
const PARK_RECHECK_MS = 10 * 60_000;
/** How long an issue whose comment read timed out is listed from its label before it is read again. */
const SLOW_READ_MS = 10 * 60_000;

/** The status label a run's issue should carry; none for a run cancelled while it was stopped (nothing continues it). */
function labelFor(s: RunSummary, L: LabelNames): string | undefined {
  if (s.status === "cancelled" && isStoppedCancel(s.reason)) return undefined;
  switch (s.status) {
    case "succeeded": return L.done;
    case "waiting": return L.waiting;
    case "stopped": return isPaused(s) ? L.working : L.needsInfo;
    case "running": return L.working;
    default: return /interrupted/.test(s.reason ?? "") ? L.working : L.failed;
  }
}

/**
 * Does the issue's status label disagree with its newest run? Returns the label (its key) and what the run says, or
 * undefined when they fit. A done label is left alone, as the watcher does; an issue without a run or a label fits.
 * A job that is queued or active counts as working. A cancelled run fits working too (the watcher resumes it).
 */
export function labelLies(status: string | undefined, busy: boolean, run: RunSummary | undefined, L: LabelNames): { label: string; run: string } | undefined {
  if (!status || status === L.done) return undefined;
  const key = (Object.keys(L) as LabelKey[]).find((k) => L[k] === status);
  if (!key) return undefined;
  if (busy) return status === L.working ? undefined : { label: key, run: "working" };
  if (!run) return undefined;
  if (status === labelFor(run, L) || (run.status === "cancelled" && status === L.working && !isStoppedCancel(run.reason))) return undefined;
  return { label: key, run: run.status };
}

/** Minutes since midnight in a time zone (default: this machine's). */
export function minutesNow(timeZone?: string, now = new Date()): { day: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Polls one GitHub repo and turns tickets / PR comments into runs. */
export class Watcher {
  status: WatcherStatus;
  /** Issues the last tick saw (for the next-step records). */
  tracked: TrackedIssue[] = [];
  /** Per issue: in how many checks in a row its label did not fit its newest run. */
  private labelOff = new Map<number, number>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private tickToken = 0;
  /** A check that takes longer is given up, so "Check now" and the next check work again (gh has no timeout). */
  checkTimeoutMs = 10 * 60_000;
  /** Time limit of one comment read. */
  commentReadMs = 15_000;
  /** Time all comment reads of one check share. */
  commentBudgetMs = 120_000;
  /** Issues whose comment read used its whole time limit, and until when they are not read again. */
  private slowUntil = new Map<number, number>();
  /** Pages of 100 issues the issue list read takes at most per check. */
  issueListPages = 20;
  /** Pages of the waiting-label query, per label, taken at most per check when the issue list is cut. */
  waitingListPages = 10;
  private waitingPages = new Map<string, Map<number, RestIssue[]>>();
  private waitingCursor = new Map<string, number>();
  /** Comment reads of needs-info extras: when, whether it worked, and the open question. */
  private readMemo = new Map<number, { at: number; ok: boolean; open?: { questions: number; since?: string } }>();
  private kickAgain = false;
  private setupDone = false;
  private stopped = false;
  /** Stopped for good (changed or removed): a check that is still running starts nothing more. */
  private retired = false;
  /** Per stopped or cancelled run (folder@file time): may it be parked? Saves loading the same run.json every check. */
  private parkEligible = new Map<string, boolean>();
  /** Issues confirmed as not parked, with the time: not asked again for a while. */
  private parkNegative = new Map<number, number>();
  /** Runs whose end will set the label (so a run is waited for once). */
  private waitingFor = new Set<string>();

  private L: LabelNames;
  private allStatus: string[];
  private statusComments: StatusComments;

  constructor(public cfg: WatcherConfig, private d: WatcherDeps) {
    this.status = { id: cfg.id, lastActions: [] };
    this.L = labelNames(cfg);
    this.allStatus = Object.values(this.L);
    this.statusComments = d.statusComments ?? new StatusComments(cfg.github_repo, (m) => d.log(`[${cfg.id}] ${m}`), { gh: d.gh });
    if (cfg.source === "issues" && cfg.status_comment) this.statusComments.expect(cfg.id);
  }

  private get repo() {
    return this.cfg.github_repo;
  }

  private flowName() {
    // "default" (the schema default) means the source's own flow.
    if (this.cfg.flow !== "default") return this.cfg.flow;
    const f = DEFAULT_FLOWS[this.cfg.source];
    if (!f) throw new Error(`a ${this.cfg.source} watcher must name its flow (there is no default for it)`);
    return f;
  }

  start() {
    this.stopped = false;
    this.status.startedAt = new Date().toISOString();
    const loop = async () => {
      await this.tick();
      if (this.stopped) return;
      let every: number;
      try {
        every = releaseCheckEvery(this.cfg, parseInterval(this.cfg.every));
      } catch {
        return; // tick() reported the invalid interval as the watcher's error
      }
      this.status.nextTick = new Date(Date.now() + every).toISOString();
      this.timer = setTimeout(loop, every);
    };
    void loop();
  }

  /**
   * Stop polling. Runs keep going; their labels are reconciled on the next start. With `retire` a check that is
   * running now also starts nothing more (the watcher was changed or removed).
   */
  stop(retire = false) {
    this.stopped = true;
    if (retire) this.retired = true;
    clearTimeout(this.timer);
    this.status.nextTick = undefined;
  }

  private act(msg: string) {
    this.d.log(`[${this.cfg.id}] ${msg}`);
    this.status.lastActions = [`${new Date().toLocaleTimeString()} ${msg}`, ...this.status.lastActions].slice(0, 20);
  }

  private async setup() {
    if (this.setupDone) return;
    await gh(["repo", "view", this.repo, "--json", "nameWithOwner"]).catch((e: Error) => {
      throw new Error(`cannot access ${this.repo} with gh: ${errorLine(e.message)}`);
    });
    if (this.cfg.source === "issues") {
      const review = this.cfg.vars.review_plan_label ?? "";
      const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase(); // GitHub label names ignore case
      const both = same(review, this.cfg.label); // one label starts the work and asks for a plan check
      await ensureLabel(this.repo, this.cfg.label, "c2410c", both ? LABEL_WORDS.triggerReview : LABEL_WORDS.trigger);
      for (const [k, l] of Object.entries(STATUS_LABELS)) await ensureLabel(this.repo, this.L[k as LabelKey], l.color, l.description);
      if (review.trim() && !both) {
        if (this.allStatus.some((s) => same(s, review))) this.act(`label ${review} is the review label and a status label — it keeps the status description`);
        else await ensureLabel(this.repo, review, "0e7490", LABEL_WORDS.review);
      }
    }
    loadFlow(this.flowName(), this.d.repo); // fail early on a missing flow
    this.setupDone = true;
  }

  /** Check now (e.g. a run just finished): no human needed means no waiting for the next interval. */
  kick() {
    if (this.stopped) return;
    if (this.ticking) this.kickAgain = true;
    else void this.tick();
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const token = ++this.tickToken;
    const checkStartedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.asRepo(() => this.check(token, checkStartedAt)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            this.tickToken++; // the check that was given up must not write anything more
            reject(new Error(`the check took longer than ${Math.round(this.checkTimeoutMs / 1000)}s and was given up`));
          }, this.checkTimeoutMs);
        }),
      ]);
      if (token === this.tickToken) {
        this.status.lastError = undefined;
        this.status.errorSince = undefined;
        this.status.errorCount = undefined;
        this.status.lastOk = new Date().toISOString();
        emitLiveTelemetry("watcher", "watcher.checked", { ...this.teleLabels(), durationMs: Math.max(0, Date.now() - checkStartedAt), outcome: "ok" });
      }
    } catch (e) {
      emitLiveTelemetry("watcher", "watcher.failed", { ...this.teleLabels(), durationMs: Math.max(0, Date.now() - checkStartedAt), outcome: "failed" });
      this.status.lastError = errorLine((e as Error).message);
      this.status.errorSince ??= new Date().toISOString();
      this.status.errorCount = (this.status.errorCount ?? 0) + 1;
      this.d.log(`[${this.cfg.id}] ! ${this.status.lastError}`);
    } finally {
      clearTimeout(timer);
      this.status.lastTick = new Date().toISOString();
      try {
        await withGhEnv(undefined, () => this.d.afterCheck?.());
      } catch {
        // the hook must not change the outcome of a check
      }
      this.ticking = false;
      if (this.kickAgain && !this.stopped) {
        this.kickAgain = false;
        setTimeout(() => void this.tick(), 0);
      }
    }
  }

  /** Runs `fn` as the watcher's repository (its token or app); rejects with a plain sentence when there is no sign-in. The host login without one. */
  private async asRepo<T>(fn: () => Promise<T>): Promise<T> {
    const s = await this.d.gh?.prepare();
    return withGhEnv(s, fn);
  }

  /** One check; throws when it fails. */
  private async check(token: number, checkStartedAt: number) {
    parseInterval(this.cfg.every);
    await this.setup();
    if (this.cfg.source === "issues") await this.tickIssues(token, checkStartedAt);
    else if (this.cfg.source === "pr-feedback") await this.tickPrs();
    else if (this.cfg.source === "ci-failures") await this.tickCi();
    else await this.tickSchedule(token);
  }

  /** Latest run per issue/PR number for this repo (newest first in the list). */
  /**
   * A run that stepped aside for a code area is resumed only when the run that holds the area no
   * longer works. Resuming sooner only stops again — and when every stop makes the watchers check
   * again, that is an endless loop of checks that uses up GitHub's request limit.
   */
  private areaMayBeFree(run: RunSummary): boolean {
    const holder = steppedAsideFor(run);
    if (!holder) return true;
    try {
      return loadRun(this.d.runsDir, holder)?.status !== "running";
    } catch {
      return true; // the holder's run is gone: its area is free
    }
  }

  /** Would takeDefaults answer now: auto_defaults on and the per-issue limit not reached. */
  private canTakeDefaults(comments: Comment[]): boolean {
    if (!this.cfg.auto_defaults) return false;
    // Something only a person can do is never answered with a recommendation.
    if (openOwnerActions(comments)) return false;
    return comments.filter((c) => c.body.includes(AUTO_DEFAULTS_MARK)).length < AUTO_DEFAULTS_MAX;
  }

  /** Files an owner_action question waits for are looked for here: the develop branch with gitflow, else the default branch. */
  private fileRef(): { ref?: string; where: string } | undefined {
    let branch = "";
    try {
      const flow = loadFlow(this.flowName(), this.d.repo).flow;
      branch = (effectiveVars(flow, this.d.repo, this.cfg.vars).develop_branch ?? "").trim();
    } catch { /* unknown flow: no gitflow */ }
    if (!branch) return { where: "the default branch" };
    return validBranchName(branch) ? { ref: branch, where: `\`${branch}\`` } : undefined;
  }

  private fileChecked = new Map<number, number>();
  private filePressed = false;

  /** Are all these files on the branch? One request per file, one total time limit; any failure means "not there". */
  private async filesThere(files: string[], ref: string | undefined, alive: () => void): Promise<boolean> {
    const until = Date.now() + FILE_CHECK_MS;
    for (const f of files) {
      const left = until - Date.now();
      if (left <= 0) return false;
      try {
        const body = await gh(["api", contentsPath(this.repo, f, ref)], undefined, left);
        alive();
        // A directory answers with a list, a file with one object: only a file counts.
        if (!isFileBody(body)) return false;
      } catch (e) {
        alive();
        const msg = errorLine((e as Error).message);
        if (!/\b404\b|Not Found/i.test(msg)) this.d.log(`[${this.cfg.id}] ! looking for ${f}: ${msg}`);
        return false;
      }
    }
    return true;
  }

  private async noteFile(n: number, met: string): Promise<void> {
    await gh(["issue", "comment", String(n), "--repo", this.repo, "--body", `**Nothing needed from you** — ${met}, so the Foundry goes on.\n\n${OWNER_FILE_MARK}`]);
  }

  /** How this watcher judges a dependency done. */
  private doneRule(): DoneRule {
    let gitflow = false;
    try {
      const flow = loadFlow(this.flowName(), this.d.repo).flow;
      gitflow = !!(effectiveVars(flow, this.d.repo, this.cfg.vars).develop_branch ?? "").trim();
    } catch { /* unknown flow: no gitflow */ }
    return { doneLabels: this.cfg.dependency_done_labels, doneLabel: this.L.done, gitflow };
  }

  /**
   * auto_defaults: answer the open questions of an issue with the Foundry's own recommendations, by a
   * `/defaults` comment (so the issue shows what happened). At most twice per issue: a planner that
   * keeps asking needs a person. Returns whether the questions count as answered.
   */
  private async takeDefaults(n: number, comments: Comment[]): Promise<boolean> {
    if (!this.canTakeDefaults(comments)) return false;
    await gh(["issue", "comment", String(n), "--repo", this.repo, "--body", `/defaults\n\n— taken by the Foundry itself: this watcher answers questions with the recommendations. ${AUTO_DEFAULTS_MARK}`]);
    this.act(`#${n} questions answered with the recommendations (auto_defaults)`);
    return true;
  }

  private latestRuns(key: "issue" | "pr", anyFlow = false): Map<string, RunSummary> {
    const m = new Map<string, RunSummary>();
    for (const s of this.d.scheduler.list(1000)) {
      if (s.vars?.github_repo !== this.repo || !s.vars[key]) continue;
      if (!anyFlow && s.flow !== this.flowName()) continue; // e.g. a plan watcher and a code watcher on the same issues
      if (!m.has(s.vars[key]!)) m.set(s.vars[key]!, s);
    }
    return m;
  }

  /**
   * Does a run of any flow for this issue work or wait in the queue? Checks the queued and the running jobs by run id,
   * so an old resumed run outside the newest runs counts too (a queued resume has no issue in queue()).
   */
  private issueBusy(n: number, run?: RunSummary): boolean {
    const sch = this.d.scheduler;
    if (run && (sch.isActive(run.runId) || sch.isQueued(run.runId))) return true;
    const q = sch.queue();
    if (q.pending.some((p) => p.githubRepo === this.repo && p.issue === String(n))) return true;
    // Every run of every flow for this issue (the uncapped brief index), and the queued or running jobs by run id.
    const ids = [
      ...sch.briefs().filter((b) => b.githubRepo === this.repo && b.issue === String(n)).map((b) => b.dirName),
      ...q.pending.map((p) => p.runId), ...q.active.map((a) => a.runId),
    ];
    return ids.some((id) => sch.isActive(id) || sch.isQueued(id));
  }

  /** The folder of the newest run of this watcher's flow per issue, found without a cap (the brief index covers every run). */
  private olderIndex(): Map<string, string> {
    const m = new Map<string, string>();
    for (const x of this.d.scheduler.briefs()) {
      if (x.githubRepo === this.repo && x.issue && x.flow === this.flowName() && !m.has(x.issue)) m.set(x.issue, x.dirName);
    }
    return m;
  }

  private budgetLeft(): boolean {
    const cap = this.d.dailyBudget?.();
    return cap === undefined || spentToday(this.d.runsDir) < cap;
  }

  /** The account whose limits this watcher's work counts for (the same rule as queue()). */
  private ownerAccount(): string | undefined {
    return this.cfg.repoId !== undefined ? this.cfg.ownerId : watcherOwner(this.cfg.owner);
  }

  /** False when the owner's daily budget is used up. True without an owner or a cap. */
  private budgetLeftFor(owner?: string): boolean {
    if (!owner) return true;
    const cap = this.d.scheduler.userDailyBudget(owner);
    return cap === undefined || spentTodayBy(this.d.runsDir, owner) < cap;
  }

  private ownerBudgetLeft(): boolean {
    return this.budgetLeftFor(this.ownerAccount());
  }

  /** Newest runs this watcher's repo has with var `key` set (newest first). */
  private runsWith(key: string): RunSummary[] {
    return this.d.scheduler.list(1000).filter((s) => s.vars?.github_repo === this.repo && s.vars[key]);
  }

  /**
   * The latest finished run of each workflow on the watched branch; a failed one gets a
   * ci-fix run (once per CI run). A workflow that went green again is left alone.
   */
  private async tickCi() {
    const branch = this.cfg.branch ?? (await ghJson<{ defaultBranchRef: { name: string } }>(["repo", "view", this.repo, "--json", "defaultBranchRef"])).defaultBranchRef.name;
    const ciRuns = await ghJson<{ databaseId: number; workflowName: string; status: string; conclusion: string; headSha: string; url: string }[]>(
      ["run", "list", "--repo", this.repo, "--branch", branch, "--limit", "40", "--json", "databaseId,workflowName,status,conclusion,headSha,url"]);
    const handled = new Set(this.runsWith("ci_run").map((s) => s.vars.ci_run));
    const seen = new Set<string>();
    let started = 0;
    for (const r of ciRuns) {
      if (r.status !== "completed" || seen.has(r.workflowName)) continue;
      seen.add(r.workflowName);
      if (r.conclusion !== "failure" || handled.has(String(r.databaseId))) continue;
      const lockKey = `${this.repo}#ci:${r.workflowName}`;
      if (this.d.scheduler.isLocked(lockKey) || started >= this.cfg.max_per_tick || !this.budgetLeft() || !this.ownerBudgetLeft()) continue;
      const { flow } = loadFlow(this.flowName(), this.d.repo);
      const runId = this.queue({
        kind: "run", flow, repo: this.d.repo,
        task: `Fix failing CI: ${r.workflowName} on ${branch} (${r.headSha.slice(0, 7)})`,
        vars: { ...this.cfg.vars, github_repo: this.repo, ci_run: String(r.databaseId), ci_workflow: r.workflowName, ci_sha: r.headSha, ci_url: r.url },
      }, { lockKey, source: `watcher ${this.cfg.id} ci ${r.workflowName}` });
      this.act(`CI “${r.workflowName}” is red on ${branch} → run ${runId}`);
      started++;
    }
  }

  private async tickSchedule(token: number) {
    await this.tickChore();
    if (this.cfg.release_build) await this.tickReleaseBuild(token);
  }

  /** Looks at the main branch; a new commit with a release-build recipe gets one queued release-build run (see queue/release-trigger.ts). */
  private async tickReleaseBuild(token: number) {
    const alive = () => {
      if (token !== this.tickToken || this.retired) throw new Error("this check was given up");
    };
    const branch = mainBranchOf(this.cfg);
    const { flow } = loadFlow(RELEASE_BUILD_FLOW, this.d.repo);
    const r = await checkReleaseBuild({
      repo: this.repo,
      branch,
      alive,
      jobs: {
        busy: (lock) => {
          const q = this.d.scheduler.queue();
          return [...q.pending, ...q.active].find((j) => j.lockKey === lock)?.runId;
        },
        // called only when no job with the lock key is queued or running: a job that got in has left a run behind
        accepted: (submission) => this.d.scheduler.list(1000).some((s) => s.vars?.[RELEASE_BUILD_SUBMISSION_VAR] === submission),
        queue: (lock, submission) =>
          this.queue(
            {
              kind: "run", flow, repo: this.d.repo, task: `Build the release files of ${this.repo} at the newest commit on ${branch}`,
              vars: { github_repo: this.repo, ref: branch, [RELEASE_BUILD_VAR]: this.cfg.id, [RELEASE_BUILD_SUBMISSION_VAR]: submission },
            },
            { lockKey: lock, source: `watcher ${this.cfg.id} release-build` },
          ),
      },
    });
    for (const n of r.notes) this.act(n);
    const sha = (r.head ?? "").slice(0, 7);
    if (r.kind === "queued") this.act(`new commit ${sha} on ${branch} → release build run ${r.runId}`);
    else if (r.kind === "no_recipe") this.act(`new commit ${sha} on ${branch} has no release-build recipe — nothing built`);
  }

  /** Run the chore when the last one started at least `every` ago (survives restarts). */
  private async tickChore() {
    const last = this.d.scheduler.list(1000).find((s) => s.vars?.chore_watcher === this.cfg.id);
    let choreDay: string | undefined;
    if (this.cfg.at) {
      // Once a day at `at` (caught up later that day if the Mac was off at that time). A chore belongs to the day it was
      // queued for (`chore_day`), not the day it started: one that waited in the queue past midnight does not take the
      // next day's turn. Older runs without `chore_day` count by their start day, as before.
      const now = minutesNow(this.cfg.timezone);
      const [hh, mm] = this.cfg.at.split(":").map(Number) as [number, number];
      if (now.minutes < hh * 60 + mm) return;
      if (last && (last.vars?.chore_day ?? minutesNow(this.cfg.timezone, new Date(last.startedAt)).day) === now.day) return;
      choreDay = now.day;
    } else {
      const every = parseInterval(this.cfg.every);
      // 5% slack so timer jitter doesn't skip a whole period.
      if (last && Date.now() - new Date(last.startedAt).getTime() < every * 0.95) return;
    }
    const lockKey = `${this.repo}#chore:${this.cfg.id}`;
    if (this.d.scheduler.isLocked(lockKey) || !this.budgetLeft() || !this.ownerBudgetLeft()) return;
    const { flow } = loadFlow(this.flowName(), this.d.repo);
    const runId = this.queue({
      kind: "run", flow, repo: this.d.repo, task: this.cfg.task ?? "",
      vars: { ...this.cfg.vars, github_repo: this.repo, chore_watcher: this.cfg.id, ...(choreDay ? { chore_day: choreDay } : {}) },
    }, { lockKey, source: `watcher ${this.cfg.id} schedule` });
    this.act(`scheduled chore → run ${runId}`);
  }

  /** Every run a watcher starts goes through here: a new run belongs to the watcher's owner; a resume keeps the run's own. */
  private queue(job: Parameters<Scheduler["submit"]>[0], meta: { lockKey?: string; source?: string; priority?: boolean; storyAt?: string }): string {
    if (this.retired) throw new Error("this watcher was stopped");
    // A watcher of a repository passes the repository owner's id; it never falls back to the first admin.
    if (this.cfg.repoId !== undefined && !this.cfg.ownerId) throw new Error("this watcher has no owner (the repository's owner is not an account)");
    const owner = this.cfg.repoId !== undefined ? this.cfg.ownerId : watcherOwner(this.cfg.owner);
    // the owner's account also counts as the one that queued it, so a block or delete drops the job and holds it while blocked
    const queuedBy = this.cfg.repoId !== undefined ? { queuedBy: this.cfg.ownerId } : {};
    const runId = this.d.scheduler.submit(job, { ...meta, ...queuedBy, ...(job.kind === "run" ? { owner } : {}) });
    const actor = ActorSchema.safeParse({ kind: "watcher", id: this.cfg.id });
    emitLiveTelemetry("watcher", "watcher.queued", { ...this.teleLabels(), runId, ...(actor.success ? { actor: actor.data } : {}) });
    return runId;
  }

  /** The labels of a watcher event; each one is left out when telemetry would not accept it. */
  private teleLabels(): { watcher?: NonNullable<ReturnType<typeof watcherRef>>; repository?: string } {
    const watcher = watcherRef(this.cfg.id, this.cfg.source);
    const repo = RepositorySchema.safeParse(this.repo);
    return { ...(watcher ? { watcher } : {}), ...(repo.success ? { repository: repo.data } : {}) };
  }

  private submit(n: number, kind: "issue" | "pr", job: Parameters<Scheduler["submit"]>[0], first?: { storyAt?: string }): string {
    const runId = this.queue(job, { lockKey: kind === "issue" ? this.lockFor(n) : `${this.repo}#${n}`, source: `watcher ${this.cfg.id} ${kind} #${n}`, ...firstMeta(first) });
    if (kind === "pr") {
      const { watcher, repository } = this.teleLabels();
      emitLiveTelemetry("pull_request", "pull_request.feedback", { ...(repository ? { pullRequest: { repository, number: n } } : {}), runId, ...(watcher ? { watcher } : {}) });
    }
    return runId;
  }

  /** Is this run still after a code area held by `holder`: stepped aside for it, or about to claim areas? */
  private stillClaims(runId: string, holder: string): boolean {
    try {
      const run = this.d.scheduler.get(runId);
      return !!run && (steppedAsideFor(run) === holder || (run.status === "running" && run.state?.next === "claim_areas"));
    } catch {
      return false;
    }
  }

  /** Update labels when a run we started finishes (the next tick would also reconcile). */
  private labelWhenDone(issue: number, runId: string) {
    if (this.waitingFor.has(runId)) return;
    this.waitingFor.add(runId);
    void this.d.scheduler.wait(runId).then(async (s) => {
      this.waitingFor.delete(runId);
      if (!s || this.stopped) return;
      await this.asRepo(async () => {
        // Cancelled while the issue is closed: clear the labels, no failure comment.
        if (s.status === "cancelled" && (await this.issueClosed(issue))) {
          await setLabels(this.repo, issue, undefined, this.allStatus).catch(() => {});
          this.act(`#${issue} (closed) → cancelled · label → none`);
          return;
        }
        // A split original was closed in favour of its parts: clear its labels, don't mark it done.
        const split = s.status === "succeeded" && s.history.at(-1)?.id === "create_split";
        const label = split ? undefined : labelFor(s, this.L);
        const remove = s.status === "succeeded" ? [...this.allStatus, ...this.cfg.remove_on_done] : this.allStatus;
        await setLabels(this.repo, issue, label, remove).catch(() => {});
        if (label === this.L.failed && this.cfg.comment_on_failure) await this.commentFailure(issue, s).catch(() => {});
        const asks = s.status === "stopped" && asksQuestions(s);
        const why = !asks && s.reason ? explainError(s.reason) : undefined;
        this.act(`#${issue} → ${s.status}${asks ? " (asks questions)" : why ? ` (${why.what}: ${why.why})` : ""} · $${s.totalCostUsd.toFixed(3)} · label → ${label ?? "none"}`);
      });
    }).catch(() => {}); // prepare() can reject (no sign-in); the next check reconciles the labels
  }

  private async issueClosed(issue: number): Promise<boolean> {
    try {
      const out = await gh(["issue", "view", String(issue), "--repo", this.repo, "--json", "state", "--jq", ".state"]);
      return out.trim().toUpperCase() === "CLOSED";
    } catch {
      return false; // unknown: count it as open
    }
  }

  /** Tell the issue why the run failed, with the tail of the failing step's output. */
  private async commentFailure(issue: number, s: RunSummary) {
    const next = this.failedHold({ number: issue, title: "" }, s, s.reason).next;
    const body = failureComment(s, next);
    await gh(["issue", "comment", String(issue), "--repo", this.repo, "--body", body]);
  }

  /** Lock key for a run on this issue: per issue, or per watcher when runs share a branch. */
  private lockFor(n: number) {
    return this.cfg.one_at_a_time ? `${this.repo}#watcher:${this.cfg.id}` : `${this.repo}#${n}`;
  }

  /** An open PR whose head branch starts with pause_while_pr_open (then start nothing new). */
  private async pausingPr(): Promise<{ text: string; number: number; url?: string; title?: string; createdAt?: string } | undefined> {
    const prefix = this.cfg.pause_while_pr_open;
    if (!prefix) return undefined;
    const prs = await ghJson<{ number: number; headRefName: string; state: string; url?: string; title?: string; createdAt?: string }[]>(["pr", "list", "--repo", this.repo, "--state", "open", "--limit", "100", "--json", "number,headRefName,state,url,title,createdAt"]);
    const pr = prs.find((p) => p.state === "OPEN" && p.headRefName.startsWith(prefix));
    return pr ? { text: `PR #${pr.number} (${pr.headRefName})`, number: pr.number, url: pr.url, title: pr.title, createdAt: pr.createdAt } : undefined;
  }

  private startNew(issue: Issue, first?: { storyAt?: string }) {
    const { flow } = loadFlow(this.flowName(), this.d.repo);
    const runId = this.submit(issue.number, "issue", {
      kind: "run", flow, task: "", repo: this.d.repo,
      vars: { trigger_label: this.cfg.label, ...this.cfg.vars, github_repo: this.repo, issue: String(issue.number) },
    }, first);
    this.act(`#${issue.number} “${issue.title}” → run ${runId} · label → ${this.L.working}`);
    return runId;
  }

  private resume(issue: number, runId: string, why: string, decision?: { approved: boolean; by: string; note?: string }, labelled = false, first?: { storyAt?: string }) {
    this.submit(issue, "issue", { kind: "resume", runId, decision }, first);
    this.act(`#${issue} ${why} → resuming run ${runId}${labelled ? ` · label → ${this.L.working}` : ""}`);
  }

  /** A hold for a reason; the text comes from the next-step module. */
  private held(kind: NextKind, issue?: { number: number; title: string }, data: NextData = {}): Hold {
    const issueUrl = issue ? `https://github.com/${this.repo}/issues/${issue.number}` : undefined;
    return toHold(nextStep(kind, { repo: this.repo, issue: issue?.number, title: issue?.title }, { watched: true, issueUrl, ...data }));
  }

  /** A hold for an issue with the failed label: the run's own record when it failed, else a plain one (a cancelled run also gets the label). */
  private failedHold(issue: { number: number; title: string }, run?: RunSummary, reason?: string): Hold {
    if (run?.status === "failed") {
      const next = runNextStep(run, { watched: true, failedLabel: this.L.failed, title: issue.title, retired: flowRetired(run) });
      if (next.kind === "failed") return toHold(next);
    }
    return this.held("failed", issue, { failedLabel: this.L.failed, runId: run?.runId, reason, retired: !!run && flowRetired(run) });
  }

  /** A hold for an issue whose run exists. */
  private heldRun(issue: Issue, run: RunSummary, extra: Parameters<typeof runNextStep>[1] = {}): Hold {
    return toHold(runNextStep(run, { watched: true, failedLabel: this.L.failed, title: issue.title, retired: flowRetired(run), ...extra }));
  }

  /** A hold from a waiting label alone (no run waits that way): listed as waiting for you, nothing changes. */
  private labelHold(issue: Issue, open?: { questions: number; since?: string }): Hold {
    return { ...this.held("questions", issue, open?.questions ? { questions: open.questions } : {}), byLabel: true, ...(open?.since ? { since: open.since } : {}) };
  }

  /** The open issues with a waiting label from the label query: a few pages per check, continuing where the last check stopped. */
  private async waitingFromLabels(alive: () => void): Promise<RestIssue[]> {
    for (const label of new Set([this.L.needsInfo, this.L.waiting])) {
      let r: Awaited<ReturnType<typeof listOpenIssuesByLabelPages>>;
      try {
        r = await listOpenIssuesByLabelPages(this.repo, label, { fromPage: this.waitingCursor.get(label) ?? 1, pages: this.waitingListPages, timeoutMs: 30_000 });
      } catch (e) {
        alive();
        this.d.log(`[${this.cfg.id}] ! waiting label ${label}: ${errorLine((e as Error).message)}`);
        continue;
      }
      alive();
      const m = this.waitingPages.get(label) ?? new Map<number, RestIssue[]>();
      for (const [p, list] of r.pages) m.set(p, list);
      if (r.next === 1) {
        const last = Math.max(...r.pages.keys());
        for (const p of [...m.keys()]) if (p > last) m.delete(p);
      }
      this.waitingPages.set(label, m);
      this.waitingCursor.set(label, r.next);
    }
    return [...this.waitingPages.values()].flatMap((m) => [...m.values()].flat());
  }

  /** Open issues with a waiting label outside the trigger list: listed under Needs you, never changed (#653). */
  private async addExtras(o: { listed: Set<number>; whole?: Issue[]; excluded: Set<string>; reads: CommentReads; holds: Hold[]; tracked: TrackedIssue[]; alive: () => void }) {
    type Row = { number: number; title: string; state?: string | null; labels: ({ name?: string } | string)[] };
    let all: Row[];
    if (o.whole) {
      all = o.whole;
      this.waitingPages.clear();
      this.waitingCursor.clear();
    } else all = await this.waitingFromLabels(o.alive);
    const labelNamesOf = (i: Row) => i.labels.map((l) => (typeof l === "string" ? l : l.name ?? ""));
    const byNo = new Map(all.map((i) => [i.number, i]));
    const newest = new Map<string, RunBrief>(); // the newest run of each issue of this repository, in any flow
    for (const b of this.d.scheduler.briefs()) {
      if (b.githubRepo !== this.repo || !b.issue || newest.has(b.issue)) continue;
      newest.set(b.issue, b);
    }
    const kept: { number: number; title: string; label: string; linked?: RunSummary }[] = [];
    for (const e of extraWaitingIssues(all, o.listed, this.L, o.excluded)) {
      const b = newest.get(String(e.number));
      const found = b ? this.d.scheduler.get(b.dirName) : undefined;
      const run = found && b && found.runId === b.dirName ? found : undefined;
      const triggered = labelNamesOf(byNo.get(e.number)!).includes(this.cfg.label);
      if (run?.parkedAt && !triggered) continue;
      kept.push({ ...e, ...(run && waitsAs(run, e.label, this.L) ? { linked: run } : {}) });
    }
    const asking = kept.filter((e) => e.label === this.L.needsInfo);
    const askNo = new Set(asking.map((e) => e.number));
    for (const n of [...this.readMemo.keys()]) if (!askNo.has(n)) this.readMemo.delete(n);
    const now = Date.now();
    const fresh = (n: number) => { const m = this.readMemo.get(n); return !!m && m.ok && now - m.at < EXTRA_READ_MEMO_MS; };
    // Never read first, then the oldest attempt. A failed attempt counts as an attempt, so it does not block the others.
    const order = asking.filter((e) => !fresh(e.number)).sort((a, b) => (this.readMemo.get(a.number)?.at ?? -1) - (this.readMemo.get(b.number)?.at ?? -1) || a.number - b.number);
    let count = 0;
    for (const e of order) {
      if (count >= EXTRA_READS_PER_CHECK || o.reads.exhausted) break;
      if (!o.reads.canRead(e.number)) continue; // slow right now: the next one gets the read
      o.alive();
      const c = await o.reads.read(e.number);
      count++;
      this.readMemo.set(e.number, c ? { at: Date.now(), ok: true, open: openQuestion(c) } : { at: Date.now(), ok: false });
    }
    const open = (n: number) => (fresh(n) ? this.readMemo.get(n)?.open : undefined);
    o.alive();
    for (const e of kept) {
      const issue: Issue = { number: e.number, title: e.title, labels: [] };
      const q = e.label === this.L.needsInfo ? open(e.number) : undefined;
      if (e.linked) o.holds.push({ ...this.heldRun(issue, e.linked, e.linked.status === "stopped" && q ? { questions: q.questions } : {}), byLabel: true });
      else o.holds.push(this.labelHold(issue, q));
      o.tracked.push({ issue: e.number, title: e.title, ...(e.linked ? { runId: e.linked.runId } : {}), extra: true });
    }
  }

  private async tickIssues(mine: number, checkStartedAt: number) {
    // A check that was given up (timeout) must not start runs or store holds next to a newer check.
    // `mine` is the token of the tick itself, so a check whose sign-in or setup outlasted the timeout is already given up here.
    const alive = () => { if (mine !== this.tickToken || this.retired) throw new Error("this check was given up"); };
    alive();
    const issues = await ghJson<Issue[]>(["issue", "list", "--repo", this.repo, "--label", this.cfg.label, "--state", "open", "--limit", "100", "--json", "number,title,labels,body,createdAt"]);
    alive();
    // All issues, read once per check and shared with the other watchers of this repository; also saved as the issue list file.
    let everyIssue: Issue[] | undefined; // all issues, for the dependency check
    const list = await freshIssueList(this.repo, { since: checkStartedAt, pages: this.issueListPages, wanted: () => mine === this.tickToken && !this.retired });
    alive();
    if (list.ok) {
      everyIssue = list.issues.map((i) => ({
        number: i.number, title: i.title, labels: i.labels.map((l) => ({ name: typeof l === "string" ? l : l.name ?? "" })), state: i.state, body: i.body ?? "",
      }));
      if (list.saveError) this.d.log(`[${this.cfg.id}] ! issue list not saved: ${list.saveError}`);
    } else {
      this.d.log(`[${this.cfg.id}] ! issue list: ${list.error}`);
    }
    const wholeList = list.ok && !list.cut ? everyIssue : undefined; // before allIssues can replace everyIssue
    const whole = issues.length < 100;
    const prioLabels = this.cfg.priority_labels.filter((l) => l.trim());
    // The list is cut at 100 and has no order we can use: ask for the bug stories on their own, so none is missed.
    if (!whole && prioLabels.length) {
      const extra = await ghJson<Issue[]>(["issue", "list", "--repo", this.repo, "--label", this.cfg.label, "--state", "open", "--limit", "1000", // gh pages through the results up to the limit
        "--search", `label:${prioLabels.map((l) => `"${l.replace(/"/g, "")}"`).join(",")} sort:created-asc`, "--json", "number,title,labels,body,createdAt"]);
      const have = new Set(issues.map((i) => i.number));
      for (const i of extra) if (!have.has(i.number)) issues.push(i);
    }
    const prio = (i: Issue) => goesFirst(i, this.cfg.priority_labels);
    let rule: DoneRule | undefined;
    const allIssues = async () => (everyIssue ??= await ghJson<Issue[]>(["issue", "list", "--repo", this.repo, "--state", "all", "--limit", "500", "--json", "number,title,labels,state,body"]));
    const openDepsOf = async (issue: Issue) => {
      const body = issue.body ?? "";
      if (!/depends\s+on|blocked\s+by/i.test(body) && !body.includes(DEPS_MARK)) return [];
      const every = await allIssues();
      return openDependencies(dependencies(body, issue.number, every), every, (rule ??= this.doneRule()));
    };
    const openFoundryDepsOf = async (issue: Issue) => {
      const marked = foundryDependsOn(issue.body ?? "").filter((n) => n !== issue.number);
      if (!marked.length) return [];
      return openDependencies(marked, await allIssues(), (rule ??= this.doneRule()));
    };
    const blockedBy = async (issue: Issue) => (this.cfg.wait_for_dependencies ? openDepsOf(issue) : openFoundryDepsOf(issue));
    /** What a blocker is doing: its hold, its newest run (any flow), or what it waits for itself. */
    const describeBlocker = async (b: number, seen: Set<number>): Promise<BlockerInfo> => {
      const own = holds.find((h) => h.issue === b)?.next;
      if (own) return { issue: b, next: own };
      anyRuns ??= this.latestRuns("issue", true);
      const r = anyRuns.get(String(b));
      if (r) return { issue: b, next: runNextStep(r, { watched: true, failedLabel: this.L.failed, retired: flowRetired(r) }) };
      const blocker = everyIssue?.find((i) => i.number === b);
      if (!blocker || seen.has(b)) return { issue: b };
      const deps = (await blockedBy(blocker)).filter((d) => !seen.has(d));
      if (!deps.length) return { issue: b };
      const next = nextStep("dependency", { repo: this.repo, issue: b, title: blocker.title }, {
        watched: true, issueUrl: `https://github.com/${this.repo}/issues/${b}`,
        blockers: await Promise.all(deps.map((d) => describeBlocker(d, new Set([...seen, b])))),
      });
      return { issue: b, next };
    };
    const runs = this.latestRuns("issue");
    let olderIdx: Map<string, string> | undefined;
    const budgetLeft = this.budgetLeft();
    const ownerLeft = this.ownerBudgetLeft();
    let started = 0;
    let firstStarted = 0; // bug stories started or queued in this check
    // Code areas bug stories wait for: the runs that hold them (of this watcher, and of other watchers of this repository).
    const firstWaits = new Set<string>();
    for (const p of this.d.peers?.() ?? []) {
      if (p.watcher.id === this.cfg.id || p.watcher.github_repo !== this.repo || p.status.lastError) continue;
      for (const t of p.issues) if (t.priority && t.claims && t.runId && this.stillClaims(t.runId, t.claims)) firstWaits.add(t.claims);
    }
    const excluded = new Set(this.cfg.exclude_labels);
    const paused = await this.pausingPr();
    if (paused && this.status.lastActions[0]?.includes(paused.text) !== true) this.act(`not starting new work while ${paused.text} is open`);
    const holds: Hold[] = [];
    const tracked: TrackedIssue[] = [];
    const offNow = new Map<number, number>(); // checks in a row that the label did not fit, per issue
    let anyRuns: Map<string, RunSummary> | undefined; // newest run per issue in any flow (to describe blockers)
    const checked = this.prechecked();
    const toCheck: Issue[] = [];
    // The status comment is ours too, but it is not a question or an approval request: it never ends the wait.
    const asked = (c: Comment) => isBot(c) && !isStatusComment(c);
    const nowMs = Date.now();
    for (const [k, t] of this.slowUntil) if (t <= nowMs) this.slowUntil.delete(k);
    const reads = commentReads({
      read: (n, t) => issueComments(this.repo, n, t),
      perReadMs: this.commentReadMs, budgetMs: this.commentBudgetMs,
      skip: (n) => (this.slowUntil.get(n) ?? 0) > Date.now(),
      onSlow: (n) => this.slowUntil.set(n, Date.now() + SLOW_READ_MS),
    });
    const unknown = new Set<number>(); // issues whose comments could not be read in this check
    const quietNow = new Set<number>(); // issues parked (or a park refused) in this check: no status comment change
    const questionCount = (comments: Comment[]) => countQuestions([...comments].reverse().find(asked)?.body);

    const overLimit = (isFirst: boolean) => started >= this.cfg.max_per_tick && !isFirst;
    /** Why a story is not started: the per-check limit, or the bug stories that went first. */
    const limited = (issue: Issue, runId?: string) =>
      firstStarted > 0 ? this.held("bug_first", issue, { runId }) : this.held("starting", issue, { maxPerTick: this.cfg.max_per_tick, runId });

    /** A story with open dependencies neither starts nor resumes: all "Depends on" issues with wait_for_dependencies, else only those in the Foundry's marked part. True when it is held. */
    const holdForDeps = async (issue: Issue, runId?: string): Promise<boolean> => {
      const blockers = await blockedBy(issue);
      alive();
      if (!blockers.length) return false;
      const msg = `#${issue.number} waits for ${blockers.map((b) => `#${b}`).join(", ")} (depends on)`;
      if (!this.status.lastActions.some((a) => a.endsWith(msg))) this.act(msg);
      const info = await Promise.all(blockers.map((b) => describeBlocker(b, new Set([issue.number]))));
      alive();
      holds.push(this.held("dependency", issue, { blockers: info, ...(runId ? { runId } : {}) }));
      return true;
    };
    const depHeldBefore = new Set((this.status.holds ?? []).filter((h) => h.next.kind === "dependency" && h.issue !== undefined).map((h) => h.issue!));
    const why = (n: number, normal: string) => (depHeldBefore.has(n) ? "its dependencies are done" : normal);
    const keepAsking = new Set<number>(); // held for dependencies with open questions: the needs-info label stays

    // Open owner_action questions (something only a person can do): a hold with the action, or `met` when every file they wait for is there.
    let fileChecks = 0;
    const pressedBefore = this.filePressed;
    this.filePressed = false;
    const ownerWait = async (issue: Issue, comments: Comment[], runId?: string): Promise<{ met: string } | { hold: Hold } | undefined> => {
      const ask: OwnerAsk | undefined = openOwnerActions(comments);
      if (!ask) return undefined;
      const files = filesToCheck(ask);
      const target = files.length ? this.fileRef() : undefined;
      const marks = comments.filter((c) => c.body.includes(OWNER_FILE_MARK)).length;
      const auto = !!target && marks < OWNER_FILE_MAX;
      const list = files.map((f) => `\`${f}\``).join(", ");
      if (auto) {
        const recent = Date.now() - (this.fileChecked.get(issue.number) ?? 0) < FILE_RECHECK_MS;
        if (fileChecks + files.length > FILE_CHECKS_PER_TICK) this.filePressed = true;
        else if (!(pressedBefore && recent)) {
          fileChecks += files.length;
          this.fileChecked.set(issue.number, Date.now());
          if (await this.filesThere(files, target.ref, alive)) return { met: `${list} ${files.length === 1 ? "is" : "are"} on ${target.where}` };
        }
      }
      const first = ask.actions[0]!.action;
      const ownerAction = ask.actions.length > 1 ? `${first} (and ${ask.actions.length - 1} more on the issue)` : first;
      return {
        hold: {
          ...this.held("owner_action", issue, { runId, ownerAction, ...(auto ? { ownerFiles: { paths: files, where: target.where } } : {}) }),
          since: ask.since,
        },
      };
    };

    // Bug stories first, the oldest issue first (its creation time; the number only breaks a tie or fills a gap).
    const age = (i: Issue) => { const t = Date.parse(i.createdAt ?? ""); return Number.isNaN(t) ? undefined : t; };
    const byAge = (a: Issue, b: Issue) => { const x = age(a), y = age(b); return x !== undefined && y !== undefined ? x - y : 0; };
    for (const issue of issues.sort((a, b) => Number(prio(b)) - Number(prio(a)) || (prio(a) ? byAge(a, b) : 0) || a.number - b.number)) {
      alive();
      const n = issue.number;
      if (issue.labels.some((l) => excluded.has(l.name))) continue;
      const names = issue.labels.map((l) => l.name);
      const status = names.find((l) => this.allStatus.includes(l));
      const wl = waitingLabelOf(names, this.L);
      const mixed = !!wl && names.some((l) => l !== wl && this.allStatus.includes(l));
      // The newest run may be older than the cap of latestRuns(): then the uncapped index finds it.
      let run = runs.get(String(n));
      if (!run) {
        const dir = (olderIdx ??= this.olderIndex()).get(String(n));
        const found = dir ? this.d.scheduler.get(dir) : undefined;
        if (found && found.runId === dir) run = found;
      }
      const isFirst = prio(issue);
      const first = isFirst ? { storyAt: issue.createdAt } : undefined;
      // A job that is still queued has no run file yet: take its id from the queue.
      // A queued job may be a fresh run next to an older run file: the queued one is the current work.
      const pending = this.d.scheduler.queue().pending;
      const queuedId = pending.find((p) => p.githubRepo === this.repo && p.issue === String(n))?.runId;
      const track: TrackedIssue = { issue: n, title: issue.title, runId: queuedId ?? run?.runId, done: status === this.L.done, ...(isFirst ? { priority: true, createdAt: issue.createdAt } : {}) };
      tracked.push(track);
      const off = labelLies(status, queuedId !== undefined || (!!run && this.d.scheduler.isActive(run.runId)), run, this.L);
      if (off) {
        const checks = (this.labelOff.get(n) ?? 0) + 1;
        offNow.set(n, checks);
        track.labelOff = { checks, ...off };
      }
      // A job of this watcher that is queued follows the label: it goes first, or goes back when the label is gone.
      const own = pending.find((p) => p.runId === (queuedId ?? run?.runId) && (p.source === `watcher ${this.cfg.id} issue #${n}` || /^ui (resume|approve|reject|answer)$/.test(p.source ?? "")));
      if (own) this.d.scheduler.setPriority(own.runId, isFirst, issue.createdAt);

      // An epic: its stories are built one by one; the epic itself starts no run and asks nothing.
      // Work in any flow for this issue (running or queued) is left alone.
      if (queuedId === undefined && isTrackingEpic(issue) && !this.issueBusy(n, run)) {
        const leftover = names.filter((l) => this.allStatus.includes(l) && l !== this.L.done);
        if (leftover.length) {
          await setLabels(this.repo, n, undefined, leftover);
          alive();
          this.act(`#${n} is an epic → label ${leftover.join(", ")} removed`);
        }
        // The edit above waited: work may have started for this issue meanwhile.
        if (run && !run.parkedAt && asksQuestions(run) && !this.issueBusy(n, run)) {
          if (this.d.scheduler.setParked(run.runId)) this.act(`#${n} is an epic → run ${run.runId} is parked, nothing waits for it`);
          else this.d.log(`[${this.cfg.id}] ! #${n} is an epic, but run ${run.runId} could not be parked`);
        }
        offNow.delete(n); delete track.labelOff;
        holds.push(this.held("epic", issue));
        continue;
      }

      // Questions asked up front (no run yet): wait for an answer, then start like a new issue.
      let answeredEarly = false;
      if (status === this.L.needsInfo && !run && !mixed) {
        const comments = await reads.read(n);
        alive();
        if (!comments) { unknown.add(n); holds.push({ ...this.held("questions", issue), byLabel: true }); continue; }
        const answers = commentsAfter(comments, asked);
        const parked = answers.length ? await this.parkOnRequest(n, answers, undefined, alive) : undefined;
        if (parked) {
          quietNow.add(n); offNow.delete(n); delete track.labelOff;
          if (parked === "parked") tracked.splice(tracked.indexOf(track), 1);
          continue;
        }
        const owner = answers.length ? undefined : await ownerWait(issue, comments);
        if (owner && "hold" in owner) { holds.push(owner.hold); continue; }
        if (owner) this.act(`#${n} ${owner.met} → it starts`);
        if (!owner && !answers.length && this.canTakeDefaults(comments) && (await holdForDeps(issue))) { keepAsking.add(n); continue; }
        if (!owner && !answers.length && !(await this.takeDefaults(n, comments))) {
          holds.push({ ...this.held("questions", issue, { questions: questionCount(comments) }), since: [...comments].reverse().find(asked)?.createdAt });
          continue;
        }
        answeredEarly = true;
      }
      // A run that is working (running or queued, e.g. approved or resumed in the UI): the label says so.
      // A queued job counts too when a waiting label sits next to another status label (it may have no run file yet).
      const workingRun = !!run && (this.d.scheduler.isActive(run.runId) || this.d.scheduler.isQueued(run.runId));
      if (workingRun || (mixed && queuedId !== undefined)) {
        // Mixed labels: the label goes to working whatever the order (the first status label may be working already).
        if (mixed || (status && status !== this.L.working)) {
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.act(`#${n} label → ${this.L.working} (its run is working)`);
          this.labelWhenDone(n, workingRun ? run!.runId : queuedId!);
        }
        if (workingRun) {
          const areaWait = run!.status === "running" ? this.d.areaWait?.(run!) : undefined;
          if (areaWait) holds.push(this.heldRun(issue, run!, { areaWait }));
          const claim = isFirst ? steppedAsideFor(run!) ?? areaWait?.runId : undefined;
          if (claim) { firstWaits.add(claim); track.claims = claim; }
        }
        continue;
      }
      // A waiting label next to another status label: listed as waiting for you; no label, /defaults, comment, resume or run.
      if (mixed) {
        const linked = run && waitsAs(run, wl!, this.L) ? run : undefined;
        const comments = await reads.read(n);
        if (!comments) unknown.add(n);
        if (linked) holds.push({ ...this.heldRun(issue, linked, linked.status === "stopped" && comments ? { questions: questionCount(comments) } : {}), byLabel: true });
        else holds.push(this.labelHold(issue, comments && openQuestion(comments)));
        continue;
      }
      // A waiting label alone on a run of a retired flow: nothing is changed or resumed (also when the run is parked).
      if (wl && run && flowRetired(run)) {
        const comments = await reads.read(n);
        if (!comments) unknown.add(n);
        holds.push(this.labelHold(issue, comments && openQuestion(comments)));
        continue;
      }
      // A waiting-approval label alone whose run does not wait: a label hold, before the parked cleanup can start replacement work.
      if (wl === this.L.waiting && !(run && waitsAs(run, wl, this.L))) {
        const comments = await reads.read(n);
        if (!comments) unknown.add(n);
        holds.push(this.labelHold(issue, comments && openQuestion(comments)));
        continue;
      }
      // A run parked while the label was gone, or cancelled while it was stopped: nothing continues it, and a new run replaces it.
      if (run && run.status !== "running" && ((run.parkedAt && (asksQuestions(run) || isStoppedCancel(run.reason))) || (run.status === "cancelled" && isStoppedCancel(run.reason)))) {
        const clear = !!status && status !== this.L.done;
        if (clear) await setLabels(this.repo, n, undefined, this.allStatus);
        if (run.parkedAt) {
          // The trigger label is back. With a status label left, it goes first; without one, a new run starts below.
          if (clear) {
            this.act(`#${n} has its ${this.cfg.label} label again → status label removed, a new run replaces ${run.runId}`);
            offNow.delete(n); delete track.labelOff;
            holds.push(this.held("starting", issue));
            continue;
          }
        } else {
          if (clear) this.act(`#${n} run ${run.runId} was cancelled while stopped → label removed, nothing starts`);
          offNow.delete(n); delete track.labelOff;
          continue;
        }
      }
      // Reopened: closed at the last check, and its newest run failed or still waits. No second run: the label comes back.
      if (!status && knownIssueState(this.repo, n) === "closed") {
        const kept = run;
        if (kept && ["failed", "stopped", "waiting"].includes(kept.status)) {
          const label = labelFor(kept, this.L);
          await setLabels(this.repo, n, label, this.allStatus);
          noteIssueState(this.repo, n, "open");
          this.act(`#${n} was reopened → label → ${label} (run ${kept.runId} is kept)`);
          continue;
        }
      }
      // A needs-info label alone on a stopped run that does not ask: nothing is changed or resumed.
      // (A succeeded run is still relabelled.)
      if (wl === this.L.needsInfo && run?.status === "stopped" && labelFor(run, this.L) === this.L.needsInfo && !waitsAs(run, wl, this.L)) {
        const comments = await reads.read(n);
        if (!comments) unknown.add(n);
        holds.push(this.labelHold(issue, comments && openQuestion(comments)));
        continue;
      }
      if (this.d.scheduler.isLocked(this.lockFor(n))) {
        const blockingRun =this.cfg.one_at_a_time ? this.d.scheduler.queue().active.find((a) => a.lockKey === this.lockFor(n))?.runId : undefined;
        const askedRun = this.cfg.one_at_a_time && !!run && waitsAs(run, this.L.needsInfo, this.L) && (status === this.L.needsInfo || status === this.L.working);
        const decidingRun = this.cfg.one_at_a_time && !!run && waitsAs(run, this.L.waiting, this.L) && (status === this.L.waiting || status === this.L.working);
        if (run && (askedRun || decidingRun)) {
          // A run that waits for the person, behind another story: when it is answered, nothing is needed from the
          // person any more. The label says working; the run resumes when the lock is free.
          const comments = await reads.read(n);
          alive();
          if (!comments) { unknown.add(n); holds.push({ ...this.heldRun(issue, run), byLabel: true }); continue; }
          if (askedRun) {
            const parked = await this.parkOnRequest(n, commentsAfter(comments, asked), run, alive);
            if (parked) { quietNow.add(n); offNow.delete(n); delete track.labelOff; continue; }
          }
          const answered = askedRun ? commentsAfter(comments, asked).length > 0 : !!(await this.findDecision(run.runId, comments));
          if (answered) {
            if (status !== this.L.working) {
              await setLabels(this.repo, n, this.L.working, this.allStatus);
              this.act(`#${n} label → ${this.L.working} (answered, waits for its turn)`);
            }
            offNow.delete(n); delete track.labelOff;
            holds.push(this.held("one_at_a_time", issue, { blockingRun, runId: run.runId }));
          } else if (askedRun) {
            if (status !== this.L.needsInfo) {
              await setLabels(this.repo, n, this.L.needsInfo, this.allStatus);
              this.act(`#${n} label → ${this.L.needsInfo}`);
            }
            const ask = openOwnerActions(comments);
            holds.push(ask ? { ...this.held("owner_action", issue, { runId: run.runId, ownerAction: ask.actions[0]!.action }), since: ask.since } : this.heldRun(issue, run, { questions: questionCount(comments) }));
          } else {
            if (status !== this.L.waiting) {
              await setLabels(this.repo, n, this.L.waiting, this.allStatus);
              this.act(`#${n} label → ${this.L.waiting}`);
            }
            holds.push(this.heldRun(issue, run));
          }
        } else if (this.cfg.one_at_a_time && (!status || answeredEarly)) {
          holds.push(this.held("one_at_a_time", issue, { blockingRun }));
        }
        continue;
      }

      if (!status || (status === this.L.working && !run) || answeredEarly) {
        if (this.cfg.precheck_flow && !status && !run && !checked.has(n)) {
          toCheck.push(issue);
          continue;
        }
        // No run yet — also when the working label is left over from a start that failed.
        if (await holdForDeps(issue)) continue;
        if (paused) { holds.push(this.held("release", issue, { pr: paused })); continue; }
        if (!budgetLeft) { holds.push(this.held("daily_budget", issue)); continue; }
        if (!ownerLeft) { holds.push(this.held("user_limit", issue, { userLimit: "budget" })); continue; }
        if (overLimit(isFirst)) { holds.push(limited(issue)); continue; }
        alive();
        // It ran before: GitHub's issue list can lag behind (a just-failed or just-finished issue still
        // listed without its new label, or as open). Ask for this issue directly before starting again.
        if (run && run.status !== "running" && !(await this.reallyStartable(n))) continue;
        const runId = this.startNew(issue, first);
        track.runId = runId;
        await setLabels(this.repo, n, this.L.working, this.allStatus);
        this.labelWhenDone(n, runId);
        started++;
        if (isFirst) firstStarted++;
      } else if (status === this.L.working && run) {
        // Reconcile: the label says working but nothing is running (restart, crash, budget pause).
        const resumable = run.status === "cancelled" || /interrupted/.test(run.reason ?? "") ||
          (run.status === "stopped" && /daily budget/.test(run.reason ?? "") && budgetLeft) ||
          (run.status === "stopped" && isUserBudgetStop(run.reason) && budgetLeft && this.budgetLeftFor(run.owner)) ||
          (run.status === "stopped" && /usage limit reached|signed out —/.test(run.reason ?? "") && retryLimitAfter(run)) ||
          (run.status === "stopped" && isPaused(run) && !isUserBudgetStop(run.reason) && !/daily budget|usage limit reached|signed out —/.test(run.reason ?? "") && !paused && this.areaMayBeFree(run));
        const asks = !resumable && run.status === "stopped" && labelFor(run, this.L) === this.L.needsInfo;
        const decides = !resumable && run.status === "waiting";
        const late = asks || decides ? await reads.read(n) : [];
        alive();
        if (!late) unknown.add(n);
        const lateAnswers = asks && late ? commentsAfter(late, asked) : [];
        if (lateAnswers.length) {
          const parked = await this.parkOnRequest(n, lateAnswers, run, alive);
          if (parked) { quietNow.add(n); offNow.delete(n); delete track.labelOff; continue; }
        }
        const lateDecision = decides && late ? await this.findDecision(run.runId, late) : undefined;
        const holder = steppedAsideFor(run);
        if (isFirst && holder && !paused) { firstWaits.add(holder); track.claims = holder; }
        if ((resumable || lateDecision || lateAnswers.length) && (await holdForDeps(issue, run.runId))) { offNow.delete(n); delete track.labelOff; continue; }
        if (resumable && !isFirst && holder && firstWaits.has(holder)) {
          // A bug story waits for the same code area: it gets the area first.
          holds.push(this.held("bug_first", issue, { runId: run.runId }));
        } else if (resumable && !overLimit(isFirst)) {
          this.resume(n, run.runId, why(n, run.status !== "stopped" ? "was interrupted" : /daily budget/.test(run.reason ?? "") ? "budget available again" : isUserBudgetStop(run.reason) ? "the owner's limit allows it again" : /usage limit/.test(run.reason ?? "") ? "trying again after the usage limit" : "can continue now"), undefined, false, first);
          this.labelWhenDone(n, run.runId);
          started++;
          if (isFirst) firstStarted++;
        } else if (lateDecision) {
          // Approved while the label already said working: it waits for its turn (or resumes now).
          offNow.delete(n); delete track.labelOff;
          if (overLimit(isFirst)) holds.push(limited(issue, run.runId));
          else {
            this.resume(n, run.runId, why(n, `${lateDecision.approved ? "approved" : "rejected"} by @${lateDecision.by}`), lateDecision, false, first);
            this.labelWhenDone(n, run.runId);
            started++;
            if (isFirst) firstStarted++;
          }
        } else if (lateAnswers.length) {
          // Answered while the label already said working: it waits for its turn (or resumes now).
          const answers = lateAnswers;
          offNow.delete(n); delete track.labelOff;
          if (overLimit(isFirst)) holds.push(limited(issue, run.runId));
          else {
            this.resume(n, run.runId, why(n, `answered by @${answers[0]!.author.login}`), undefined, false, first);
            this.labelWhenDone(n, run.runId);
            started++;
            if (isFirst) firstStarted++;
          }
        } else if (!late) {
          // The comments could not be read: change nothing, say nothing (it is listed from its label).
        } else if (!resumable && labelFor(run, this.L) !== this.L.working) {
          await setLabels(this.repo, n, labelFor(run, this.L), this.allStatus);
          this.act(`#${n} label → ${labelFor(run, this.L)}`);
        } else if (!resumable) {
          // Paused on a limit, a code area or an interruption: say why nothing happens.
          const next = runNextStep(run, { watched: true, failedLabel: this.L.failed, title: issue.title, pr: paused, areaWait: this.d.areaWait?.(run), retired: flowRetired(run) });
          if (["usage_limit", "daily_budget", "user_limit", "interrupted", "release", "area_lock"].includes(next.kind)) holds.push(toHold(next));
        } else {
          // Resumable, but max_per_tick is used up: only the per-check limit is in the way.
          holds.push(limited(issue, run.runId));
        }
      } else if (run && status !== this.L.done && labelFor(run, this.L) !== status) {
        // Reconcile: the label does not match the newest run (e.g. approved in the UI, or the
        // server restarted meanwhile). A done label is left alone.
        const label = labelFor(run, this.L);
        await setLabels(this.repo, n, label, run.status === "succeeded" ? [...this.allStatus, ...this.cfg.remove_on_done] : this.allStatus);
        this.act(`#${n} label → ${label}`);
      } else if (status === this.L.needsInfo && run?.status === "stopped") {
        const comments = await reads.read(n);
        alive();
        if (!comments) { unknown.add(n); holds.push({ ...this.heldRun(issue, run), byLabel: true }); continue; }
        const answers = commentsAfter(comments, asked);
        if (answers.length) {
          const parked = await this.parkOnRequest(n, answers, run, alive);
          if (parked) { quietNow.add(n); offNow.delete(n); delete track.labelOff; continue; }
        }
        const owner = answers.length ? undefined : await ownerWait(issue, comments, run.runId);
        if (owner && "hold" in owner) { holds.push(owner.hold); continue; }
        if ((answers.length || owner || (!notCodeStop(run) && this.canTakeDefaults(comments))) && (await holdForDeps(issue, run.runId))) {
          if (answers.length) {
            await setLabels(this.repo, n, this.L.working, this.allStatus);
            this.act(`#${n} label → ${this.L.working} (answered by @${answers[0]!.author.login}, waits for its dependencies)`);
            offNow.delete(n); delete track.labelOff;
          } else keepAsking.add(n);
          continue;
        }
        // auto_defaults: nobody answered yet, so the recommendations are taken (only when the run can go on now).
        // A "not a coding task" stop is not answered with defaults: it needs a person (the planner_questions hold stays).
        const auto = !answers.length && !owner && !notCodeStop(run) && !overLimit(isFirst) && (await this.takeDefaults(n, comments));
        if ((answers.length || auto || owner) && !overLimit(isFirst)) {
          // The file a question waited for is there: say so once (the mark limits it), then go on.
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.resume(n, run.runId, why(n, owner ? owner.met : auto ? "answered with the recommendations (auto_defaults)" : `answered by @${answers[0]!.author.login}`), undefined, true, first);
          this.labelWhenDone(n, run.runId);
          // Written only after the resume went out: a failed resume must not use up the note limit.
          if (owner) {
            alive();
            try { await this.noteFile(n, owner.met); } catch (e) { this.d.log(`[${this.cfg.id}] ! #${n} note for the file: ${errorLine((e as Error).message)}`); }
          }
          started++;
          if (isFirst) firstStarted++;
        } else if (owner) {
          // The file is there but the per-check limit is used up: the label stays, nothing is posted yet.
          holds.push(limited(issue, run.runId));
        } else if (!answers.length) {
          holds.push(this.heldRun(issue, run, { questions: questionCount(comments) }));
        } else {
          // Answered; waits for the per-check limit. Nothing is needed from the person: the label says working.
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.act(`#${n} label → ${this.L.working} (answered by @${answers[0]!.author.login}, waits for its turn)`);
          offNow.delete(n); delete track.labelOff;
          holds.push(limited(issue, run.runId));
        }
      } else if (status === this.L.waiting && run?.status === "waiting") {
        const comments = await reads.read(n);
        if (!comments) { unknown.add(n); holds.push({ ...this.heldRun(issue, run), byLabel: true }); continue; }
        const decision = await this.findDecision(run.runId, comments);
        if (decision && (await holdForDeps(issue, run.runId))) {
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.act(`#${n} label → ${this.L.working} (${decision.approved ? "approved" : "rejected"} by @${decision.by}, waits for its dependencies)`);
          offNow.delete(n); delete track.labelOff;
          continue;
        }
        if (decision) {
          await setLabels(this.repo, n, this.L.working, this.allStatus);
          this.resume(n, run.runId, why(n, `${decision.approved ? "approved" : "rejected"} by @${decision.by}`), decision, true, first);
          this.labelWhenDone(n, run.runId);
        } else {
          holds.push(this.heldRun(issue, run));
        }
      } else if (status === this.L.failed) {
        holds.push(this.failedHold(issue, run, run?.status === "failed" ? run.reason : undefined));
      }
    }
    if (toCheck.length) {
      // Bug stories are checked on their own and first; the others follow in a later check, so they never ride along at the front.
      const bugs = toCheck.filter(prio);
      if (bugs.length) {
        const firstAt = bugs.map((i) => i.createdAt).filter((t): t is string => !!t).sort()[0];
        await this.precheck(bugs, holds, budgetLeft, { storyAt: firstAt });
        for (const i of toCheck) if (!prio(i)) holds.push(this.held("bug_first", i));
      } else await this.precheck(toCheck, holds, budgetLeft);
    }
    // An issue that was answered but cannot start (dependency, release, budget, limit, busy watcher) needs nothing
    // from the person: the needs-info label goes, as the status comment says. Without a run nothing is lost.
    if (reads.exhausted) this.d.log(`[${this.cfg.id}] comment reads: the time for this check is used up, the other issues are listed from their labels`);
    let labelError: Error | undefined;
    await this.dropAnsweredLabels(issues, runs, holds, alive, keepAsking).catch((e: Error) => { labelError = e; });
    let tidyError: Error | undefined;
    const closed: { issue: number; title: string }[] = [];
    let closedWhole = false;
    await this.tidyClosed(runs, holds, closed).then((w) => { closedWhole = w; }, (e: Error) => { tidyError = e; });
    let statesError: Error | undefined;
    await this.checkIssueStates(issues, alive).catch((e: Error) => { statesError = e; });
    // After the states: an issue known to be closed is not asked about again.
    await this.parkUntracked(issues, everyIssue, alive);
    // After parking: a run parked in this check does not list its issue as an extra.
    alive();
    await this.addExtras({ listed: new Set(issues.map((i) => i.number)), whole: wholeList, excluded, reads, holds, tracked, alive });
    if (paused && !holds.some((x) => x.next.kind === "release")) holds.unshift(this.held("release", undefined, { pr: paused }));
    alive();
    const before = new Map((this.status.holds ?? []).map((h) => [holdKey(h), h.seen]));
    const now = new Date().toISOString();
    for (const h of holds) {
      if (!h.since && h.next.kind === "release") h.since = paused?.createdAt;
      h.seen = before.get(holdKey(h)) ?? now;
    }
    this.status.holds = holds;
    this.status.pausedBy = paused ? { number: paused.number, url: paused.url, title: paused.title, createdAt: paused.createdAt } : undefined;
    this.tracked = tracked;
    this.labelOff = offNow;
    const quiet = [...new Set([...holds.filter((h) => h.byLabel && h.issue !== undefined).map((h) => h.issue!), ...unknown, ...quietNow])];
    if (this.cfg.status_comment) await this.reportStatus(runs, holds, tracked, closed, !tidyError && closedWhole && whole, () => mine === this.tickToken && !this.stopped, quiet);
    // The closed-issue scan is part of the check: its failure is the check's error.
    if (statesError) throw new Error(`checking closed issues: ${errorLine(statesError.message)}`); // first: this prefix is the contract
    if (tidyError) throw new Error(`tidying closed issues: ${errorLine(tidyError.message)}`);
    if (labelError) throw new Error(`correcting labels: ${errorLine(labelError.message)}`);
  }

  /** Stores which issues with an unfinished run are open or closed: one batched call for those not in the open list. */
  private async checkIssueStates(open: Issue[], alive: () => void) {
    const UNFINISHED = ["failed", "stopped", "waiting", "cancelled"];
    const candidates = new Set<number>();
    for (const b of this.d.scheduler.briefs()) {
      if (b.githubRepo !== this.repo || !b.issue || !/^\d+$/.test(b.issue) || !UNFINISHED.includes(b.status)) continue;
      const n = Number(b.issue); // "004" is issue 4
      if (n >= 1 && n <= 2147483647) candidates.add(n);
    }
    const listed = new Set(open.map((i) => i.number));
    const states = new Map<number, "open" | "closed">();
    const ask: number[] = [];
    for (const n of candidates) if (listed.has(n)) states.set(n, "open"); else ask.push(n);
    try {
      // alive() runs before every chunk, so a check that was given up asks and writes nothing more.
      for (const [n, s] of await issueStates(this.repo, ask, 60_000, alive)) states.set(n, s);
      alive();
    } catch (e) {
      try {
        alive(); // a retired or given-up watcher writes nothing (its entry may just have been dropped)
        markIssueCheckFailed(this.repo);
      } catch {
        // nothing to record
      }
      throw e;
    }
    saveIssueStates(this.repo, states);
  }

  /** Removes needs-info from issues without a run whose hold of this check says nothing is needed from the person. */
  private async dropAnsweredLabels(issues: Issue[], runs: Map<string, RunSummary>, holds: Hold[], alive: () => void, keep: ReadonlySet<number> = new Set()) {
    const notYours: NextKind[] = ["dependency", "release", "daily_budget", "user_limit", "starting", "bug_first", "one_at_a_time"];
    const pending = this.d.scheduler.queue().pending;
    for (const issue of issues) {
      const n = issue.number;
      const names = issue.labels.map((l) => l.name);
      if (!names.includes(this.L.needsInfo) || runs.has(String(n)) || keep.has(n)) continue;
      if (pending.some((p) => p.githubRepo === this.repo && p.issue === String(n))) continue;
      const hold = holds.find((h) => h.issue === n);
      if (!hold || !notYours.includes(hold.next.kind)) continue;
      alive();
      await setLabels(this.repo, n, undefined, [this.L.needsInfo]);
      this.act(`#${n} label ${this.L.needsInfo} removed (it no longer waits for you)`);
    }
  }

  /** Tells the shared writer what this check saw. Never throws, and does not touch Recent activity. */
  private async reportStatus(runs: Map<string, RunSummary>, holds: Hold[], tracked: TrackedIssue[], closed: { issue: number; title: string }[], complete: boolean, alive: () => boolean, quiet: number[]) {
    try {
      let all: RunSummary[] | undefined; // loaded at most once per check
      await this.statusComments.report(this.cfg.id, {
        id: this.cfg.id, label: this.cfg.label, failedLabel: this.L.failed, tracked, holds, closed, complete, quiet,
        scheduler: this.d.scheduler, areaWait: this.d.areaWait,
        lastRunId: (n) => runs.get(String(n))?.runId,
        releaseAt: (run) => releaseAtFor(this.d.watchers?.() ?? [], run, (all ??= this.d.scheduler.list(1000))),
      }, alive);
    } catch (e) {
      this.d.log(`[${this.cfg.id}] ! status comments: ${errorLine((e as Error).message)}`);
    }
  }

  /**
   * Closed issues (e.g. by a merged pull request) that still carry a waiting/working/error label:
   * done if their last run succeeded, otherwise just without the stale status labels.
   * A run that waits for a person is kept as it is.
   * Fills `handled` with the closed issues it dealt with; returns true when GitHub's list was whole (not cut at its limit).
   */
  private async tidyClosed(runs: Map<string, RunSummary>, holds: Hold[], handled: { issue: number; title: string }[]): Promise<boolean> {
    const pending = this.d.scheduler.queue().pending;
    const stale = [this.L.working, this.L.waiting, this.L.needsInfo, this.L.failed];
    const limit = 30;
    const closed = await ghJson<Issue[]>(["issue", "list", "--repo", this.repo, "--state", "closed", "--limit", String(limit),
      "--search", `label:${stale.map((l) => `"${l}"`).join(",")} sort:updated-desc`, "--json", "number,title,labels,state"]);
    for (const issue of closed) {
      if (issue.state && issue.state.toUpperCase() !== "CLOSED") continue;
      const names = issue.labels.map((l) => l.name);
      if (!names.some((l) => stale.includes(l))) continue;
      const run = runs.get(String(issue.number));
      handled.push({ issue: issue.number, title: issue.title ?? "" });
      const queuedId = pending.find((p) => p.githubRepo === this.repo && p.issue === String(issue.number))?.runId;
      const working = !!queuedId || (!!run && (this.d.scheduler.isActive(run.runId) || this.d.scheduler.isQueued(run.runId)));
      if (working) {
        // Still working: change nothing. Say so, unless the run closed the issue itself.
        if (!(run?.runId === (queuedId ?? run?.runId) && runClosedIssue(run))) holds.push(this.held("closed_elsewhere", { number: issue.number, title: issue.title ?? "" }, { runId: queuedId ?? run?.runId }));
        continue;
      }
      const done = run?.status === "succeeded" && run.history.at(-1)?.id !== "create_split";
      await setLabels(this.repo, issue.number, done ? this.L.done : undefined, [...this.allStatus, ...this.cfg.remove_on_done].filter((l) => names.includes(l)));
      this.act(`#${issue.number} (closed) label → ${done ? this.L.done : "none"}`);
    }
    return closed.length < limit;
  }

  /** Issues already covered by a finished precheck run (a failed check doesn't hold issues back). */
  private prechecked(): Set<number> {
    const done = new Set<number>();
    if (!this.cfg.precheck_flow) return done;
    for (const r of this.d.scheduler.list(1000)) {
      if (r.flow !== this.cfg.precheck_flow || r.vars?.github_repo !== this.repo || !r.vars.issues) continue;
      if (!["succeeded", "failed", "stopped", "cancelled"].includes(r.status)) continue;
      for (const x of r.vars.issues.split(/[\s,]+/)) if (/^\d+$/.test(x)) done.add(Number(x));
    }
    return done;
  }

  /** One run over all new issues that asks the owner's open questions before any of them is built. */
  private async precheck(list: Issue[], holds: Hold[], budgetLeft: boolean, first?: { storyAt?: string }) {
    const lockKey = `${this.repo}#precheck:${this.cfg.id}`;
    const hold = (kind: NextKind) => { for (const i of list) holds.push(this.held(kind, i)); };
    if (this.d.scheduler.isLocked(lockKey)) return hold("checking");
    if (!budgetLeft) return hold("daily_budget");
    if (!this.ownerBudgetLeft()) { for (const i of list) holds.push(this.held("user_limit", i, { userLimit: "budget" })); return; }
    const { flow } = loadFlow(this.cfg.precheck_flow!, this.d.repo);
    const nums = list.map((i) => i.number);
    const runId = this.queue({
      kind: "run", flow, task: "", repo: this.d.repo,
      vars: { ...this.cfg.vars, github_repo: this.repo, issues: nums.join(" "), needs_info_label: this.L.needsInfo },
    }, { lockKey, source: `watcher ${this.cfg.id} precheck ${nums.map((x) => `#${x}`).join(" ")}`, ...firstMeta(first) });
    this.act(`checking ${nums.map((x) => `#${x}`).join(", ")} for open questions → run ${runId}`);
    hold("checking");
  }

  /**
   * Marks the newest run of an open issue that lost its trigger label, when the run waits for answers or was cancelled
   * while stopped: nothing continues it, so nobody is asked about it. Candidates come from the uncapped run index; an
   * issue missing from the (possibly cut) issue list is confirmed directly. At most PARK_CHECKS_PER_TICK confirmations
   * per check; a "not parked" answer is remembered for a while, so the next checks reach the other runs.
   */
  private async parkUntracked(triggered: Issue[], everyIssue: Issue[] | undefined, alive: () => void) {
    if (!everyIssue) return; // no list this check: nothing is known about the labels
    const withLabel = new Set(triggered.map((i) => i.number));
    const listed = new Map(everyIssue.map((i) => [i.number, i]));
    const now = Date.now();
    for (const [k, t] of this.parkNegative) if (now - t > PARK_RECHECK_MS) this.parkNegative.delete(k);
    const pending = this.d.scheduler.queue().pending;
    const newest = new Map<string, RunBrief>(); // the newest run of each issue of this repository, in any flow
    for (const b of this.d.scheduler.briefs()) {
      if (b.githubRepo !== this.repo || !b.issue || newest.has(b.issue)) continue;
      newest.set(b.issue, b);
    }
    let confirmations = 0;
    for (const [issueNo, b] of newest) {
      const n = Number(issueNo);
      if (b.flow !== this.flowName() || (b.status !== "stopped" && b.status !== "cancelled")) continue;
      if (!Number.isSafeInteger(n) || withLabel.has(n) || this.parkNegative.has(n)) continue;
      if (this.d.scheduler.isActive(b.dirName) || pending.some((p) => p.githubRepo === this.repo && p.issue === issueNo)) continue;
      const key = `${b.dirName}@${b.updatedAt}`;
      let eligible = this.parkEligible.get(key);
      if (eligible === undefined) {
        const run = this.d.scheduler.get(b.dirName);
        eligible = !!run && run.runId === b.dirName && !run.parkedAt && (run.vars?.trigger_label ?? this.cfg.label) === this.cfg.label
          && (asksQuestions(run) || (run.status === "cancelled" && isStoppedCancel(run.reason)));
        this.parkEligible.set(key, eligible);
        if (this.parkEligible.size > 5000) this.parkEligible.delete(this.parkEligible.keys().next().value!);
      }
      if (!eligible) continue;
      const known = listed.get(n);
      if (known && (known.state?.toUpperCase() !== "OPEN" || known.labels.some((l) => l.name === this.cfg.label))) continue;
      if (!known && knownIssueState(this.repo, n) === "closed") continue;
      if (confirmations >= PARK_CHECKS_PER_TICK) break;
      confirmations++;
      alive();
      if (!(await this.reallyParked(n))) { this.parkNegative.set(n, now); continue; }
      if (this.d.scheduler.setParked(b.dirName)) {
        this.parkEligible.set(key, false);
        this.act(`#${n} has no ${this.cfg.label} label → run ${b.dirName} is parked, nothing waits for it`);
      }
    }
  }

  /** The issue as GitHub has it right now: open, and without the trigger label. False when it cannot be told. */
  private async reallyParked(n: number): Promise<boolean> {
    try {
      const fresh = await ghJson<{ state: string; labels: { name: string }[] }>(["issue", "view", String(n), "--repo", this.repo, "--json", "state,labels"]);
      return fresh.state.toUpperCase() === "OPEN" && !fresh.labels.some((l) => l.name === this.cfg.label);
    } catch {
      return false;
    }
  }

  /** The issue as GitHub has it right now (not the search list): open, and without a status label. */
  private async reallyStartable(n: number): Promise<boolean> {
    try {
      const fresh = await ghJson<{ state: string; labels: { name: string }[] }>(["issue", "view", String(n), "--repo", this.repo, "--json", "state,labels"]);
      return fresh.state.toUpperCase() === "OPEN" && !fresh.labels.some((l) => this.allStatus.includes(l.name));
    } catch {
      return false; // can't tell: try again at the next check rather than start twice
    }
  }

  /** May this comment's author decide (approve, reject, park)? An app has no user: its own comment (gh says so) counts as written with write access. */
  private async mayDecide(c: Comment): Promise<boolean> {
    return (c.viewerDidAuthor === true && ghActsAsApp()) || (await canWrite(this.repo, c.author.login));
  }

  /** Work of this issue that is queued or running (also a queued job that has no run file yet). */
  private workOf(n: number): boolean {
    const q = this.d.scheduler.queue();
    if (q.pending.some((p) => p.githubRepo === this.repo && p.issue === String(n))) return true;
    return q.active.some((a) => { const v = this.d.scheduler.get(a.runId)?.vars; return v?.github_repo === this.repo && v.issue === String(n); });
  }

  /**
   * /park, or a "do not build" answer to a NOT_CODE stop, among `answers` (oldest first). The first one from someone
   * with write access parks the issue. undefined: no such request (the answers are ordinary answers).
   * "refused": nothing was parked (work for the issue is queued or running again, or the labels could not be removed);
   * nothing is changed on GitHub and the run is not marked parked.
   */
  private async parkOnRequest(n: number, answers: Comment[], run: RunSummary | undefined, alive: () => void): Promise<"parked" | "refused" | undefined> {
    const notCode = !!run && notCodeStop(run);
    const id = this.cfg.id;
    const still = () => {
      try { alive(); } catch (e) {
        this.d.log(`[${id}] #${n} not parked: ${errorLine((e as Error).message)}; nothing changed`);
        throw e;
      }
    };
    still();
    let by: string | undefined;
    for (const c of answers) {
      if (!wantsPark(c.body, notCode)) continue;
      const ok = await this.mayDecide(c);
      still();
      if (ok) { by = c.author.login; break; }
      this.act(`#${n} ignored /park from @${c.author.login} (no write access)`);
    }
    if (by === undefined) return undefined;
    // No await between this check and setParked: work queued during the permission read is seen here.
    if (this.workOf(n) || (run && !this.d.scheduler.setParked(run.runId))) {
      this.act(`#${n} /park by @${by} not done: ${run ? `run ${run.runId} is` : "work for it is"} queued or running again; labels and comments unchanged`);
      return "refused";
    }
    const remove = [...new Set([this.cfg.label, ...this.allStatus])];
    let removed = false;
    for (let i = 0; i < 2 && !removed; i++) {
      try { await setLabels(this.repo, n, undefined, remove); removed = true; } catch (e) {
        this.d.log(`[${id}] #${n} parking: removing the labels failed: ${errorLine((e as Error).message)}`);
      }
    }
    if (!removed) {
      // The trigger label would read as "added again" and start the story over: take the mark back; the next check tries again.
      if (run) this.d.scheduler.clearParked(run.runId);
      this.act(`#${n} /park by @${by} not done: the labels could not be removed; it is tried again at the next check`);
      return "refused";
    }
    await commentOnIssue(this.repo, n, parkedComment(this.cfg.label, run?.runId)).catch((e: Error) => {
      this.d.log(`[${id}] ! #${n} parked, but the comment could not be posted: ${errorLine(e.message)}`);
    });
    this.act(`#${n} parked by @${by}${run ? ` → run ${run.runId} is parked` : ""} · labels removed`);
    return "parked";
  }

  /** First /approve or /reject after the run's approval request, from someone with write access. */
  private async findDecision(runId: string, comments: Comment[]) {
    const after = commentsAfter(comments, (c) => c.body.includes(`run=${runId} approval`));
    for (const c of after) {
      const m = APPROVE_RE.exec(c.body);
      if (!m) continue;
      // An app has no user: its own comment (gh says so) counts as written with write access.
      if (!(await this.mayDecide(c))) {
        this.act(`ignored /${m[1]} from @${c.author.login} (no write access)`);
        continue;
      }
      return { approved: m[1]!.toLowerCase() === "approve", by: c.author.login, note: m[2]?.trim() || undefined };
    }
    return undefined;
  }

  private async tickPrs() {
    const prs = await ghJson<{ number: number; headRefName: string }[]>(["pr", "list", "--repo", this.repo, "--state", "open", "--limit", "50", "--json", "number,headRefName"]);
    const runs = this.latestRuns("pr");
    let started = 0;
    for (const pr of prs) {
      if (!pr.headRefName.startsWith("factory/") || started >= this.cfg.max_per_tick) continue;
      if (this.d.scheduler.isLocked(`${this.repo}#${pr.number}`)) continue;
      const view = await ghJson<{
        comments: Comment[];
        reviews: { author: { login: string }; body: string; state: string; submittedAt: string }[];
        commits: { committedDate: string }[];
      }>(["pr", "view", String(pr.number), "--repo", this.repo, "--json", "comments,reviews,commits"]);
      const lineComments = await ghJson<{ body: string; created_at: string }[]>(["api", `repos/${this.repo}/pulls/${pr.number}/comments`]);
      const t = (s: string | undefined) => (s ? new Date(s).getTime() : 0);
      const human = [
        ...view.comments.filter((c) => !isBot(c)).map((c) => t(c.createdAt)),
        ...view.reviews.filter((r) => r.body || r.state === "CHANGES_REQUESTED").filter((r) => !isBot(r)).map((r) => t(r.submittedAt)),
        ...lineComments.filter((c) => !isBot(c)).map((c) => t(c.created_at)),
      ];
      const lastHuman = Math.max(0, ...human);
      const lastOurs = Math.max(
        0,
        ...view.comments.filter(isBot).map((c) => t(c.createdAt)),
        ...view.commits.map((c) => t(c.committedDate)),
        t(runs.get(String(pr.number))?.startedAt),
      );
      if (lastHuman > lastOurs) {
        const { flow } = loadFlow(this.flowName(), this.d.repo);
        const runId = this.submit(pr.number, "pr", {
          kind: "run", flow, task: "", repo: this.d.repo,
          vars: { ...this.cfg.vars, github_repo: this.repo, pr: String(pr.number) },
        });
        this.act(`PR #${pr.number} has new review feedback → run ${runId}`);
        started++;
      }
    }
  }
}
