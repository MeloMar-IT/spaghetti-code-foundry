import { taskLineOf, ticketTitleOf, type RunSummary } from "../../src/engine/state.js";

/** Briefs for a scheduler stub, built the way `listRunBriefs` builds them. */
export const briefsOf = (runs: RunSummary[]) => runs.map((r) => ({ runId: r.runId, dirName: r.runId, flow: r.flow, status: r.status, startedAt: r.startedAt, finishedAt: r.finishedAt, source: r.source, owner: r.owner, runDir: r.runDir, updatedAt: r.finishedAt ?? r.startedAt, githubRepo: r.vars?.github_repo, issue: r.vars?.issue, pr: r.vars?.pr, ciRun: r.vars?.ci_run, taskLine: taskLineOf(r.task), ...(ticketTitleOf(r.state?.steps?.pull_ticket?.output) ? { issueTitle: [...ticketTitleOf(r.state?.steps?.pull_ticket?.output)].slice(0, 200).join("") } : {}) }));
