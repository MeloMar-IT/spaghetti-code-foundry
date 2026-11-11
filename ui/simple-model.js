import { sameRepo } from "./filters.js";
import { needsUser, recordLink } from "./home.js";
import { myRunsEntries } from "./runs-list.js";
import { planPoints, plainPoints } from "./request-model.js";
import { plannedCards } from "./simple-change-model.js";
import { FINAL, WORDS, kindWords, safeText, stateLine, summaryOf } from "./simple-words.js";
import { phaseText, stepPhase } from "./phases.js";

// The Simple view as plain data: projects, the four groups of work and the cards. No DOM here.
// Grouping uses the next-step record (`run.next` or `job.next`), never the run status, as Home does.

/**
 * The identity of a project: "owner/name" for a GitHub repository, "local:<id>" for a local one, null when there is neither.
 * A local project's work is the work whose `vars.repo_id` (or `job.repoId`) is its id; no record carries that yet (see `workOf`).
 */
export const projectKey = (repo) => {
  if (typeof repo?.github === "string" && repo.github) return repo.github;
  return repo?.id ? `local:${repo.id}` : null;
};

/** True when a run or queued job belongs to the project: by the GitHub name, or by the local id. */
const workOf = (e, key, repo) => {
  const n = recordOf(e);
  if (!n) return false;
  if (key.startsWith("local:")) {
    // A run of a local project carries its local name (vars.github_repo); GET /api/repos gives it as `localName`.
    if (typeof repo.localName === "string" && repo.localName && sameRepo(e.run?.vars?.github_repo ?? e.job?.githubRepo ?? n.repo, repo.localName)) return true;
    return String(e.run?.vars?.repo_id ?? e.job?.repoId ?? "") === String(repo.id);
  }
  return sameRepo(e.run?.vars?.github_repo ?? e.job?.githubRepo ?? n.repo, key);
};

const lastPart = (s) => String(s ?? "").replace(/\/+$/, "").replace(/(\.git)+$/i, "").split(/[/:]/).pop() ?? "";

/** The project name: the short name, or the full "owner/name" when two projects of the list share the short name. */
export function projectName(repo, all = []) {
  const full = typeof repo?.github === "string" && repo.github ? repo.github : null;
  const short = full ? full.split("/").pop() : lastPart(repo?.url) || String(repo?.id ?? "");
  const shortOf = (r) => (typeof r?.github === "string" && r.github ? r.github.split("/").pop() : lastPart(r?.url));
  const clash = all.some((r) => r !== repo && shortOf(r).toLowerCase() === short.toLowerCase());
  return clash && full ? full : short;
}

/** Records Simple does not show as work. */
export const HIDDEN = new Set(["cancelled", "superseded", "issue_closed", "parked", "epic", "watcher_error", "watcher_stale", "monitor_stopped", "closed_elsewhere", "chore_late"]);
const ANSWER = new Set(["questions", "planner_questions", "owner_action"]);

const recordOf = (e) => e.run?.next ?? e.job?.next;
const idOf = (e) => e.run?.runId ?? e.job?.runId;
const finishedMs = (e) => Date.parse(e.run?.finishedAt ?? e.run?.startedAt ?? "") || 0;

/** "check" | "building" | "planned" | "done", or null for work Simple does not show. */
export function groupOf(entry) {
  const n = recordOf(entry);
  if (!n || HIDDEN.has(n.kind)) return null;
  // Stuck work nobody needs to look at: its change is closed, or the person put it aside with "Not now".
  if (n.kind === "failed" && (n.issueClosed || n.notNow)) return null;
  // A split that made all its parts is finished, though its last step failed.
  if (n.kind === "failed" && n.splitMade === "all") return "done";
  if (needsUser(n)) return "check";
  if (n.kind === "done" || n.kind === "release") return "done";
  if (n.kind === "running" || (entry.run?.history?.length ?? 0) > 0) return "building";
  return "planned";
}

/** The phase of a run's current step ({ key, index, word, line, source }), or null when it has no step yet. */
export function runPhase(run) {
  const step = run?.state?.next ?? run?.history?.at(-1)?.id ?? "";
  if (!step) return null;
  const steps = Array.isArray(run.flowDef?.steps) ? run.flowDef.steps : [];
  const index = steps.findIndex((s) => s?.id === step);
  return stepPhase(step, index >= 0 ? { index, total: steps.length } : undefined);
}

/** → (entry) => the id of the project the work belongs to, or null (also for work of a repository not in the list). */
export function projectOfWork(repos) {
  const all = (Array.isArray(repos) ? repos : []).map((repo) => ({ repo, key: projectKey(repo) })).filter((x) => x.key);
  return (entry) => all.find((x) => workOf(entry, x.key, x.repo))?.repo.id ?? null;
}

/** One card: only word-list text and the person's own title and summary. Never the server's `text`, `status` or `where.label`. */
export function cardOf(entry) {
  const n = recordOf(entry);
  const { run, job } = entry;
  const task = String(run?.task ?? job?.task ?? "");
  const group = groupOf(entry);
  // A split that made all its parts reads as done, not as stuck.
  const words = kindWords(n.kind === "failed" && n.splitMade === "all" ? "done" : n.kind, n.who);
  const card = {
    id: idOf(entry),
    title: safeText(n.title || task.split(/\r?\n/)[0], WORDS.untitled),
    sentence: safeText(summaryOf(task)),
    line: words.line,
  };
  if (group === "building" && run) {
    const phase = runPhase(run);
    if (phase) card.progress = phaseText(phase);
  }
  if (group === "check") {
    card.todo = words.todo;
    const l = recordLink(n, "user", idOf(entry));
    if (l) card.link = { href: l.href, external: !!l.external };
    // a question card can be answered in place when the page finds the run among the items the person may answer
    if (ANSWER.has(n.kind) && idOf(entry)) card.ask = idOf(entry);
    // a real run that waits for a check can be opened with Try it ("the version being checked")
    if (run && !n.final && idOf(entry)) card.tryRun = idOf(entry);
    // A check (not the final one) can be decided in place; `own`: the run itself waits and no watcher follows it (the server says so)
    if (!n.final && (n.kind === "approval" || n.kind === "approve_plan") && idOf(entry)) {
      card.approve = idOf(entry);
      // the server refuses approve and reject of a refinement run (409), so such a run is not the person's own
      if (run?.status === "waiting" && !n.watched && !run.refinement) card.own = true;
      // "Your request": what the plan took from the request and what it assumed, on the card of a plan that waits for a decision
      if (n.kind === "approve_plan" && run) {
        const pts = plainPoints(planPoints(run));
        if (pts.length) card.points = pts;
      }
      // the checks the plan wrote for a person to try, with their marks (the card draws them)
      if (run?.status === "waiting" && Array.isArray(run.checks) && run.checks.length) {
        card.checkRun = { status: run.status, checks: run.checks, checkMarks: run.checkMarks, checksRev: run.checksRev };
      }
    }
    // A failed run: "stuck". `resume`: the run itself can be resumed; `stuckAt` tells one failure from the next.
    if (n.kind === "failed" && idOf(entry)) {
      card.stuck = idOf(entry);
      card.stuckAt = String(run?.finishedAt ?? "");
      // the server refuses resume of a refinement run (409): such a run gets Ask for help only
      if (run && !n.watched && !run.refinement && run.state?.next != null && !n.retired && !n.splitMade) card.resume = true;
    }
    // "Make this version final": the card decides by itself (the run page is not a Simple page); the stories in plain words.
    if (n.final && idOf(entry)) {
      card.todo = FINAL.yes;
      card.line = FINAL.line;
      card.decide = idOf(entry);
      card.items = String(run?.waiting?.message ?? "").split(/\r?\n/)
        .map((l2) => /^- #\d+ (.+)$/.exec(l2.trim())?.[1])
        .map((t) => (t ? safeText(t) : ""))
        .filter(Boolean);
      delete card.link;
    }
  }
  return card;
}

/** → { id, name, todo, groups: { planned, building, check, done }, state } of one project. */
export function projectModel(repo, all, runs, pending, changes = []) {
  const key = projectKey(repo);
  const groups = { planned: [], building: [], check: [], done: [] };
  let answer = false;
  if (key) {
    const mine = myRunsEntries(runs, pending).filter((e) => workOf(e, key, repo));
    mine.sort((a, b) => finishedMs(b) - finishedMs(a));
    for (const e of mine) {
      const g = groupOf(e);
      if (!g) continue;
      groups[g].push(cardOf(e));
      if (g === "check" && ANSWER.has(recordOf(e).kind)) answer = true;
    }
  }
  // requests kept with "Not now" wait under Planned, each with its own "Yes, build this"
  groups.planned.push(...plannedCards(changes));
  return {
    id: repo.id,
    name: projectName(repo, all),
    local: repo?.method === "local",
    todo: groups.check,
    groups,
    state: stateLine({ needs: groups.check.length, needsAnswer: answer, building: groups.building.length, planned: groups.planned.length, done: groups.done.length }),
  };
}

/** The projects in the order of the repositories, each with its one big `next` button. */
export function projectsModel(repos, runs, pending, changes = {}) {
  const all = Array.isArray(repos) ? repos : [];
  return all.map((repo) => {
    const m = projectModel(repo, all, runs, pending, changes?.[String(repo.id)] ?? []);
    const first = m.todo.find((c) => c.link || c.decide);
    // A card that decides in place has no link: the big button goes to the project page, where the card is.
    const next = first
      ? first.decide
        ? { label: first.todo, href: `#/repos/${encodeURIComponent(m.id)}`, external: false }
        : { label: first.todo, href: first.link.href, external: first.link.external }
      : { label: WORDS.open, href: `#/repos/${encodeURIComponent(m.id)}`, external: false };
    return { ...m, next };
  });
}
