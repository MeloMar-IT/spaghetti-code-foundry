import { existsSync, readFileSync } from "node:fs";
import { CANNOT_READ, redactedJson } from "../credentials/redact.js";
import { supersededRuns } from "../stats.js";
import { resolve } from "node:path";
import { runDiff } from "../engine/diff.js";
import { readTranscript } from "../engine/transcript.js";
import { auditAction } from "../auth/audit.js";
import { ownsRepo } from "../auth/repos.js";
import { DELETED_OWNER, isRefinementRun, ownerNames } from "../auth/run-owner.js";
import { isRefinementFlow } from "../flow/usage.js";
import { AnswerRefused, effectiveVars } from "../engine/runner.js";
import { ANSWER_MAX_CHARS, answerRoom, type RunSummary } from "../engine/state.js";
import { parseFlow, resolveFlowPath } from "../flow/load.js";
import { isPublished, userVars } from "../flow/publish.js";
import { isVarName, type Flow } from "../flow/schema.js";
import { guardedRepos } from "./api-repos.js";
import { publishedFlows } from "./permissions.js";
import { HttpError, NAME_RE, readJson, send, str } from "./http.js";
import { hideForeign, nextFor, ownQueue, ownRecord, queueWithNext } from "./next.js";
import { answerBlock, hidePaths, refinementSessionOf, userLogLine, userRecord, userRun } from "./user-view.js";
import type { NextStep } from "../next-step.js";
import type { JobMeta, RunEvent } from "../queue/scheduler.js";
import { gateRun } from "../run-gate.js";
import { matchesRun, parseRunFilter, runFilterValues } from "./run-filter.js";
import type { ApiContext, Route } from "./server.js";

const NEXT_RECHECK_MS = 2_000;

/** A run loaded by folder name. With an owner, the runId and owner inside the file must agree with it. A run.json that cannot be read gives undefined. */
export function readRun(scheduler: ApiContext["scheduler"], dirName: string, owner?: string): RunSummary | undefined {
  try {
    const s = scheduler.get(dirName);
    return s && (!owner || (s.runId === dirName && s.owner === owner)) ? s : undefined;
  } catch {
    return undefined;
  }
}

/** Like readRun, but the runId inside the file must always agree with the folder name. */
export function checkedRun(scheduler: ApiContext["scheduler"], dirName: string, owner?: string): RunSummary | undefined {
  const s = readRun(scheduler, dirName, owner);
  return s && s.runId === dirName ? s : undefined;
}

/** The newest 200 runs of one archive state (of one account when `owner` is given), the list the records are built from. */
export function runsListFor(ctx: ApiContext, owner?: string, archived = false): RunSummary[] {
  return ctx.scheduler.briefs()
    .filter((b) => (owner === undefined || b.owner === owner) && !!b.archived === archived)
    .slice(0, 200)
    .flatMap((b) => checkedRun(ctx.scheduler, b.dirName, owner) ?? []);
}


export const runRoutes: Route = async (ctx, req, res, seg, method, user) => {
  const { opts, scheduler } = ctx;
  const admin = user.role === "admin";
  // What a user sees of a record: another account's run is not named in it.
  const mine = (rid: string) => scheduler.ownerOf(rid) === user.id;
  const view = admin ? (n: NextStep) => n : (n: NextStep) => userRecord(ownRecord(n, mine));
  // What a user sees of a run: no costs and no setup (see user-view.ts).
  const shape: (r: RunSummary & { next?: NextStep; superseded?: boolean; ownerName?: string; canAnswer?: boolean }) => unknown = admin ? (r) => (refinementSessionOf(r.source) ? { ...r, refinement: refinementSessionOf(r.source) } : r) : userRun;
  const hide = <T,>(v: T): T => (admin ? v : hideForeign(v, mine));
  // Present only when an answer sent now would be accepted. The active check is left out on purpose: finish() sends its last update while the run is still active.
  const answerable = (r: RunSummary) => (!scheduler.isQueued(r.runId) && !answerBlock(r, ctx.config().watchers) && answerRoom(r) > 0 ? { canAnswer: true as const } : {});
  // The lock key and the place of a bug story, for a job that resumes a run.
  const jobMeta = (s: RunSummary, source: string): JobMeta => {
    const vars = s.vars ?? {};
    const lockKey = vars.github_repo && (vars.issue || vars.pr) ? `${vars.github_repo}#${vars.issue || vars.pr}` : undefined;
    // A bug story keeps its place at the front: its watcher saw the label at its last check.
    const story = ctx.watchers.tracked().flatMap((t) => t.issues).find((i) => i.runId === s.runId && i.priority);
    return { lockKey, source, queuedBy: user.id, ...(story ? { priority: true, storyAt: story.createdAt } : {}) };
  };
  if (seg[0] === "queue" && method === "GET") {
    // A queued architect read says which refinement session it is for; the source itself stays with the admin.
    const sessionOf = new Map(scheduler.queue().pending.flatMap((p) => (refinementSessionOf(p.source) ? [[p.runId, refinementSessionOf(p.source)!] as const] : [])));
    const q = admin ? queueWithNext(ctx) : ownQueue(ctx, user.id);
    return send(res, 200, { ...q, pending: q.pending.map((p) => (sessionOf.has(p.runId) ? { ...p, refinement: sessionOf.get(p.runId) } : p)) }), true;
  }
  if (seg[0] === "run-owners" && !seg[1] && method === "GET") {
    const counts = new Map<string, number>();
    for (const b of scheduler.briefs()) if (b.owner) counts.set(b.owner, (counts.get(b.owner) ?? 0) + 1);
    const names = ownerNames();
    const owners = [...counts].map(([oid, runs]) => ({ id: oid, name: names.get(oid) ?? DELETED_OWNER, runs }));
    return send(res, 200, owners.sort((a, b) => a.name.localeCompare(b.name))), true;
  }
  if (seg[0] === "run-filters" && !seg[1] && method === "GET") {
    // A user gets the values of their own runs only.
    return send(res, 200, runFilterValues(scheduler.briefs().filter((b) => admin || b.owner === user.id))), true;
  }
  if (seg[0] !== "runs") return false;
  const id = seg[1];

  if (!id && method === "GET") {
    const parsed = parseRunFilter(new URL(req.url ?? "/", "http://x").searchParams, admin);
    const want = admin ? parsed.owner : user.id;
    const filter = { ...parsed, owner: want };
    // The archive choice, the owner and q, repo, flow, status and since are applied before the cap. Loaded by folder name;
    // with an owner, the runId and owner inside the file must agree with it, else the run is left out.
    const runs = scheduler.briefs()
      .filter((b) => matchesRun(b, filter))
      .slice(0, 200)
      .flatMap((b) => readRun(scheduler, b.dirName, want) ?? []);
    const replaced = supersededRuns(runs);
    const next = nextFor(ctx, runs, !admin);
    const names = admin ? ownerNames() : undefined;
    return send(res, 200, runs.map((r) => hide(shape({
      ...r,
      ...answerable(r),
      ...(replaced.has(r.runId) ? { superseded: true } : {}),
      ...(names && r.owner ? { ownerName: names.get(r.owner) ?? DELETED_OWNER } : {}),
      next: view(next(r)),
    })))), true;
  }
  if (!id && method === "POST") {
    const body = await readJson(req);
    if (body.likeUser !== undefined && typeof body.likeUser !== "boolean") throw new HttpError(400, "likeUser must be true or false");
    // An admin who asks for it starts under the rules of a user.
    const asUser = !admin || body.likeUser === true;
    // What a user may never do is refused first, before any other field is looked at.
    if (asUser) {
      if (body.yaml !== undefined) throw new HttpError(403, "only an admin can run a flow that is not saved");
      if (body.repo !== undefined && body.repo !== null && body.repo !== "") throw new HttpError(403, "only an admin can choose the folder");
    }
    const task = str(body, "task", false).trim();
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries((body.vars as Record<string, unknown>) ?? {})) {
      if (!isVarName(k) || typeof v !== "string") throw new HttpError(400, `invalid var "${k}"`);
      vars[k] = v;
    }
    let flow: Flow;
    let repo: string;
    let runVars = vars;
    if (!asUser) {
      repo = resolve(str(body, "repo", false) || opts.repo);
      if (!existsSync(repo)) throw new HttpError(400, `repo not found: ${repo}`);
      flow = typeof body.yaml === "string"
        ? parseFlow(body.yaml)
        : parseFlow(readFileSync(resolveFlowPath(str(body, "flow"), opts.repo), "utf8"));
    } else {
      // A user (or an admin who starts like one) starts a published, saved flow in the server's default folder, on one of their own repositories.
      const name = str(body, "flow");
      if (!NAME_RE.test(name)) throw new HttpError(400, "invalid flow name");
      // The architect's flows are started from a refinement session only, also when an admin published a copy of them.
      if (isRefinementFlow(name)) throw new HttpError(404, "flow not found");
      const listing = publishedFlows(opts.repo).find((f) => f.name === name);
      if (!listing) throw new HttpError(404, "flow not found");
      try {
        flow = parseFlow(readFileSync(listing.path, "utf8"), listing.path);
      } catch {
        throw new HttpError(404, "flow not found"); // the message of a failure holds a file path
      }
      if (!isPublished(flow) || isRefinementFlow(flow.name)) throw new HttpError(404, "flow not found");
      if (flow.workspace === "inplace") throw new HttpError(403, "this flow works directly in the server's folder; only an admin can start it");
      if (flow.workspace === "worktree") throw new HttpError(403, "this flow works in a branch of the server's folder; only an admin can start it");
      repo = resolve(opts.repo);
      if (!existsSync(repo)) throw new HttpError(400, "the server's folder was not found");
      // The folder's own settings are read now and kept with the job; the user may fill in the published inputs only.
      const set = userVars(flow, effectiveVars(flow, repo, {}, (m) => opts.log?.(m)), vars);
      if (!set.ok) throw new HttpError(set.status, set.error);
      runVars = set.vars;
      const given = vars.github_repo;
      if (given === undefined) {
        // A repository from the flow or the folder is fine only when it is one of the user's own.
        const dflt = runVars.github_repo;
        if (dflt !== undefined && !guardedRepos(ctx, () => ownsRepo(user.id, dflt))) {
          const input = flow.publish?.vars.github_repo?.mode === "input";
          throw new HttpError(403, input ? 'set the var "github_repo" to one of your repositories' : "this flow works on a repository that is not one of yours");
        }
      } else if (given === "" || given.toLowerCase() === "owner/repo") {
        throw new HttpError(403, 'set the var "github_repo" to one of your repositories');
      } else if (!guardedRepos(ctx, () => ownsRepo(user.id, given))) {
        throw new HttpError(403, `"${given}" is not one of your repositories`);
      }
    }
    const lockKey = runVars.github_repo && (runVars.issue || runVars.pr) ? `${runVars.github_repo}#${runVars.issue || runVars.pr}` : undefined;
    const runId = scheduler.submit(
      { kind: "run", flow, task, repo, vars: runVars, ...(asUser ? { frozenVars: true } : {}) },
      { lockKey, source: "ui", owner: user.id, queuedBy: user.id },
    );
    auditAction(ctx.diagLog, user.id, "run-start", runId);
    return send(res, 201, { runId, queued: scheduler.isQueued(runId) }), true;
  }

  if (!id || !/^[\w-]+$/.test(id)) throw new HttpError(400, "invalid run id");
  const action = seg[2];

  if ((action === "archive" || action === "unarchive") && method === "POST") {
    const archived = action === "archive";
    const result = scheduler.setArchived(id, archived, user.id);
    if (result === "missing") throw new HttpError(404, "run not found");
    if (result === "busy") throw new HttpError(409, "only a finished run can be archived; this run is running, waiting or queued");
    auditAction(ctx.diagLog, user.id, archived ? "run-archive" : "run-unarchive", id);
    return send(res, 200, { runId: id, archived }), true;
  }
  if (action === "cancel" && method === "POST") {
    const cancelled = scheduler.cancel(id);
    if (cancelled) auditAction(ctx.diagLog, user.id, "run-cancel", id);
    return send(res, 200, { cancelled }), true;
  }

  if (action === "answer" && method === "POST") {
    const body = await readJson(req);
    let s = scheduler.get(id);
    if (!s) throw new HttpError(404, "run not found");
    const text = str(body, "text"); // not trimmed: the text is kept as sent
    if ([...text].length > ANSWER_MAX_CHARS) throw new HttpError(400, `the answer can have at most ${ANSWER_MAX_CHARS} characters`);
    if (text.includes("\u0000")) throw new HttpError(400, "the answer has characters that are not allowed");
    if (isRefinementRun(s.source)) throw new HttpError(409, "this run belongs to a refinement session; ask the architect again from that session");
    // A run in its finish window (the notify command runs) is still active, but its last update said "stopped".
    if (scheduler.isActive(id) && !scheduler.isQueued(id) && s.status !== "running") {
      await scheduler.wait(id);
      s = scheduler.get(id);
      if (!s) throw new HttpError(404, "run not found");
    }
    // Everything from here on is synchronous, so two calls cannot both pass.
    if (scheduler.isActive(id) || scheduler.isQueued(id)) throw new HttpError(400, `run ${id} is already queued or running`);
    const block = answerBlock(s, ctx.config().watchers);
    if (block) throw new HttpError(409, block);
    try {
      scheduler.answer(id, text, user.id, jobMeta(s, "ui answer"));
    } catch (e) {
      if (e instanceof AnswerRefused) throw new HttpError(e.kind === "state" ? 409 : e.kind === "size" ? 400 : 500, e.message);
      throw e;
    }
    auditAction(ctx.diagLog, user.id, "run-answer", id);
    return send(res, 202, { runId: id }), true;
  }

  if ((action === "resume" || action === "approve" || action === "reject") && method === "POST") {
    const body = await readJson(req);
    const s = scheduler.get(id);
    if (!s) throw new HttpError(404, "run not found");
    const from = str(body, "from", false) || undefined;
    if (from && !admin) throw new HttpError(403, "only an admin can restart a run from a step");
    // The one-read-at-a-time rules live in the session: an architect run is continued from there, for every role.
    if (isRefinementRun(s.source)) throw new HttpError(409, "this run belongs to a refinement session; ask the architect again from that session");
    // One live look at the issue; a closed one is not continued (see run-gate.ts).
    const gate = await gateRun(s, ctx.config());
    if (!gate.ok) throw new HttpError(409, gate.message);
    if (action !== "resume" && s.status !== "waiting") throw new HttpError(409, "run is not waiting for approval");
    // The same answer for both roles; any other failure of submit is unexpected (and generic for a user).
    if (scheduler.isActive(id) || scheduler.isQueued(id)) throw new HttpError(400, `run ${id} is already queued or running`);
    scheduler.submit(
      action === "resume"
        ? { kind: "resume", runId: id, from }
        : { kind: "resume", runId: id, decision: { approved: action === "approve", by: "ui", note: str(body, "note", false) || undefined } },
      jobMeta(s, `ui ${action}`),
    );
    auditAction(ctx.diagLog, user.id, `run-${action}`, id);
    return send(res, 202, { runId: id }), true;
  }

  if (action === "events" && method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    // What a viewer sees of the record, sent last.
    const shown = (n: NextStep) => [n.kind, n.issueUnchecked ? "unchecked" : "", n.retired ? "retired" : "", n.text, n.until, n.timing?.progress, n.timing?.estimate, n.timing?.note].join("\n");
    const first = scheduler.get(id);
    let last = first ? shown(view(nextFor(ctx, undefined, !admin)(first))) : "";
    let lastCan = false;
    // The folders of the run, to take out of what a user reads.
    let known = admin ? undefined : scheduler.get(id);
    const write = (e: RunEvent) => {
      let out: unknown = e;
      if (e.type === "update") {
        known = admin ? undefined : e.summary;
        const next = view(nextFor(ctx, undefined, !admin)(e.summary));
        last = shown(next);
        const can = answerable(e.summary);
        lastCan = "canAnswer" in can;
        out = { type: "update", summary: shape({ ...e.summary, ...can, next }) };
      } else if (!admin) {
        const line = userLogLine(e.line);
        if (line === undefined) return;
        out = { type: "log", line: hidePaths(line, known) };
      }
      const data = redactedJson(hide(out));
      if (data === undefined) return void res.write(`event: log\ndata: ${JSON.stringify({ type: "log", line: CANNOT_READ })}\n\n`);
      res.write(`event: ${e.type}\ndata: ${data}\n\n`);
    };
    const unsubscribe = scheduler.subscribe(id, write);
    // A wait for a code area shows up in the step log only, without an update event: look again now and then.
    const recheck = setInterval(() => {
      const s = scheduler.get(id);
      if (!s) return;
      // A queued, dropped or cancelled resume sends no update: also look at whether an answer would be accepted.
      if (shown(view(nextFor(ctx, undefined, !admin)(s))) !== last || ("canAnswer" in answerable(s)) !== lastCan) write({ type: "update", summary: s });
    }, NEXT_RECHECK_MS);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(ping);
      clearInterval(recheck);
      unsubscribe();
    });
    return true;
  }

  const s = scheduler.get(id);
  if (!s) throw new HttpError(404, "run not found");
  if (!action && method === "GET") return send(res, 200, hide(shape({ ...s, ...answerable(s), next: view(nextFor(ctx, undefined, !admin)(s)) }))), true;
  if (action === "diff" && method === "GET") {
    if (!admin && (s.flowDef?.workspace === "inplace" || (s.workdir !== undefined && s.workdir === s.repo))) throw new HttpError(403, "only an admin can see the changes of a run that works in the server's folder");
    return send(res, 200, runDiff(s)), true;
  }
  if (action === "transcript" && method === "GET") {
    const n = Number(seg[3]);
    const rec = s.history[n];
    if (!Number.isInteger(n) || !rec) throw new HttpError(404, "no such step");
    if (!rec.logFile.startsWith(s.runDir)) throw new HttpError(400, "bad log path");
    return send(res, 200, hide({ step: rec.id, type: rec.type, events: readTranscript(rec.logFile) })), true;
  }
  return false;
};
