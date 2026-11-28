import { createHash } from "node:crypto";
import { subjectPage } from "../help/actions.js";
import { aboutOf } from "../help/contract.js";
import { GUARD_MAX, GuardError, guardExcerpt, type GuardOptions } from "../help/guard.js";
import type { ListRunsArgs, ToolCall, ToolResult, ToolRunner } from "../help/tools.js";
import type { Asker, Source } from "../help/turn.js";
import { sinceMs } from "../since-date.js";
import { runsFor } from "./api-runs.js";
import { currentAccount, runWithNext } from "./help-context.js";
import { STATE_EXCERPT_MAX, stateId } from "./help-evidence.js";
import { githubStatusTool } from "./help-github-status.js";
import { issuePullsTool, issueTool, type GithubToolOptions } from "./help-github.js";
import { NOT_FOUND, failingTests, stepLog } from "./help-log-tools.js";
import { nextFor, ownRecord } from "./next.js";
import { authorize, findRule } from "./permissions.js";
import type { RunFilter } from "./run-filter.js";
import type { ApiContext } from "./server.js";
import { hidePaths, userError, userRecord, userRun, userTask } from "./user-view.js";
import { runInScope } from "./workspace-scope.js";

/**
 * Carries out the look-ups of Ask Foundry (`help/tools.ts`). It has no rules of its own: each look-up asks the
 * permission table for the `GET` call that reads the same thing, reads through the reader of that call with its owner
 * check, for the account as it is now, and keeps a short list of plain fields in a user's words (also for an
 * administrator: no cost, model, folder or owner). Nothing is written.
 */

export { NOT_FOUND };
export const NO_RUNS = "No runs were found.";
const FAILED = "The look-up could not be done.";
const HELD_BACK = "(held back)";
/** The most runs a list holds, the longest task line of one, and the most steps of a run. */
const LIST_RUNS = 10;
const TASK_CHARS = 120;
const STEPS = 20;

const nothing = (note: string): ToolResult => ({ note, sources: [] });

/** One value of a record as it may go into a source: one line, without secrets, held back when it reads like an order. */
function value(v: unknown, guard: GuardOptions): string {
  const g = guardExcerpt(String(v).replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim(), guard);
  return g.withheld ? HELD_BACK : g.text;
}

/**
 * The first line of a run's task as the list shows it. The whole task is guarded before it is cut, so a secret that
 * reaches past the cut is still taken out. A task that is too long for the guard to check is held back, not sent.
 */
function taskLine(r: { flow: string; source?: string; task?: string }, guard: GuardOptions): string {
  const full = userTask(r.flow, r.source, r.task ?? "");
  if (full.length > GUARD_MAX) return HELD_BACK;
  const g = guardExcerpt(full, guard);
  const first = (g.withheld ? HELD_BACK : g.text).split("\n", 1)[0] ?? "";
  return first.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").slice(0, TASK_CHARS);
}

async function listRuns(ctx: ApiContext, asker: Asker, args: ListRunsArgs, guard: GuardOptions): Promise<ToolResult> {
  await ctx.scheduler.whenIndexReady();
  const user = currentAccount(asker);
  const rule = findRule("GET", ["runs"]);
  if (!user || !rule) return nothing(NO_RUNS);
  try {
    authorize(ctx, user, rule, ["runs"]);
  } catch {
    return nothing(NO_RUNS);
  }
  const q = args.q?.trim().toLowerCase();
  const filter: RunFilter = {
    archived: args.archived ?? false,
    admin: user.role === "admin",
    ...(q ? { q } : {}),
    ...(args.repo !== undefined ? { repo: args.repo } : {}),
    ...(args.flow !== undefined ? { flow: args.flow } : {}),
    ...(args.status !== undefined ? { status: args.status } : {}),
    ...(args.since !== undefined ? { since: sinceMs(args.since) } : {}),
  };
  const runs = runsFor(ctx, user, filter).slice(0, LIST_RUNS);
  if (!runs.length) return nothing(NO_RUNS);
  const v = (x: unknown) => value(x, guard);
  const lines = runs.map((r) => {
    const repo = r.vars?.github_repo;
    const task = taskLine(r, guard);
    return [`- ${v(r.runId)}`, v(r.flow), v(r.status), `started ${v(r.startedAt)}`, ...(repo ? [`${v(repo)}${r.vars?.issue ? `#${v(r.vars.issue)}` : ""}`] : []), ...(task ? [task] : [])].join(" · ");
  });
  const observedAt = new Date().toISOString();
  const source: Source = {
    id: `tool-runs-${createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 10)}`,
    kind: "state",
    title: "A list of runs, newest first",
    ref: "#/runs",
    observedAt,
    excerpt: [`Observed by the server at ${observedAt}. The newest runs that match, at most ${LIST_RUNS}.`, ...lines].join("\n"),
  };
  return { note: `Found ${runs.length} run(s).`, sources: [source] };
}

async function showRun(ctx: ApiContext, asker: Asker, id: string, guard: GuardOptions): Promise<ToolResult> {
  await ctx.scheduler.whenIndexReady();
  const user = currentAccount(asker);
  // authorizes the account for `GET /api/runs/:id` and checks the owner
  const found = user ? runWithNext(ctx, user, id) : undefined;
  if (!user || !found) return nothing(NOT_FOUND);
  const run = userRun(found.run);
  const v = (x: unknown) => value(x, guard);
  const line = (name: string, x: unknown) => (x === undefined || x === null || x === "" ? [] : [`${name}: ${v(x)}`]);
  const reason = run.status !== "running" && run.status !== "succeeded" && found.run.reason ? hidePaths(userError(found.run.reason), found.run) : undefined;
  // never `found.next`: an administrator's record can name a budget amount. The user's words are built for both roles.
  let next: ReturnType<typeof userRecord> | undefined;
  try {
    next = userRecord(ownRecord(nextFor(ctx, undefined, true)(found.run), (rid) => runInScope(ctx, user, rid)));
  } catch {
    next = undefined;
  }
  // the newest first: when the text is cut, the oldest steps go. `i` is the number `step_log` takes.
  const steps = run.history.map((h, i) => ({ ...h, i })).slice(-STEPS).reverse();
  const observedAt = new Date().toISOString();
  const text = [
    `Observed by the server at ${observedAt}. These are facts as recorded, not conclusions.`,
    ...line("run", id), ...line("flow", run.flow), ...line("status", run.status), ...line("startedAt", run.startedAt), ...line("finishedAt", run.finishedAt),
    ...line("repository", run.vars.github_repo), ...line("issue", run.vars.issue), ...line("why it ended or waits", reason),
    ...line("nextStatus", next?.status), ...line("nextWho", next?.who), ...line("nextWhy", next?.why),
    ...(steps.length ? ["steps, newest first:", ...steps.map((h) => `- ${v(h.id)} (visit ${h.visit}, step ${h.i}): ${h.ok ? "succeeded" : "failed"}${h.error ? ` · ${v(h.error)}` : ""}`)] : ["steps: none recorded"]),
  ].join("\n");
  const about = ctx.scheduler.ownerOf(id) === asker.id ? aboutOf({ kind: "run", id }) : undefined;
  const source: Source = {
    id: stateId("run", id),
    kind: "state",
    title: `A run of the flow ${v(run.flow)}`,
    ref: subjectPage("run", id),
    observedAt,
    subject: { kind: "run", id },
    excerpt: text.length > STATE_EXCERPT_MAX ? `${text.slice(0, STATE_EXCERPT_MAX - 2)} …` : text,
    ...(about ? { about } : {}),
  };
  return { note: `Read the run: its status is ${v(run.status)}.`, sources: [source] };
}

/** The look-ups of this server. A `GuardError` goes on to the caller: then nothing more may be sent. */
export function helpTools(ctx: ApiContext, options: GithubToolOptions = {}): ToolRunner {
  const run = (asker: Asker, call: ToolCall, guard: GuardOptions): Promise<ToolResult> => {
    switch (call.tool) {
      case "list_runs":
        return listRuns(ctx, asker, call.args, guard);
      case "show_run":
        return showRun(ctx, asker, call.args.id, guard);
      case "step_log":
        return stepLog(ctx, asker, call.args, guard);
      case "failing_tests":
        return failingTests(ctx, asker, call.args, guard);
      case "issue":
        return issueTool(ctx, asker, call.args, guard, options);
      case "issue_pulls":
        return issuePullsTool(ctx, asker, call.args, guard, options);
      case "github_status":
        return githubStatusTool(guard, options);
    }
  };
  return async (asker, call) => {
    try {
      return await run(asker, call, { patterns: ctx.config().help.sensitive_patterns ?? [] });
    } catch (e) {
      if (e instanceof GuardError) throw e;
      ctx.diagLog?.("help: a look-up could not be done");
      return nothing(FAILED);
    }
  };
}
