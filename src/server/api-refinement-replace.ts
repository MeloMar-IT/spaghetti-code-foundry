import { listOpenIssues, restIssue } from "../github.js";
import { findDependants } from "../refinement/dependants.js";
import type { ReplacePart } from "../refinement/publish.js";
import { mergeJournal, type Found } from "../refinement/replace-journal.js";
import type { Session } from "../refinement/store.js";
import { whatHappened } from "./api-refinement-import.js";
import { HttpError } from "./http.js";
import type { ApiContext } from "./server.js";

/** The title the source issue has on GitHub now; the stored one when the issue is gone or is a pull request. */
export async function originalTitle(s: Session, timeout: number): Promise<string> {
  const n = s.source!.issue;
  let issue;
  try {
    issue = await restIssue(s.repo, n, timeout);
  } catch (e) {
    throw new HttpError(502, `could not read issue #${n} on GitHub: ${whatHappened(e)}`);
  }
  return issue && !issue.pull_request && typeof issue.title === "string" && issue.title ? issue.title : s.source!.title;
}

/** The open issues that depend on the issue a publish would replace: a fresh scan merged with the journal kept. It only reads. */
export async function replacePlan(ctx: ApiContext, s: Session, replaces: { issue: number; parts: ReplacePart[] }, timeout: number): Promise<{ cut?: true; dependants: Found[] }> {
  const title = await originalTitle(s, timeout);
  let open;
  try {
    open = await listOpenIssues(s.repo, { pages: ctx.opts.openIssuePages ?? 10, timeoutMs: timeout });
  } catch (e) {
    throw new HttpError(502, `could not read the open issues on GitHub: ${whatHappened(e)}`);
  }
  const exclude = replaces.parts.flatMap((p) => ("issue" in p ? [p.issue] : []));
  const shown = replaces.parts.map((p) => ("issue" in p ? p.issue : `new issue ${p.item}`));
  const found: Found[] = findDependants(open.issues, { number: replaces.issue, title }, exclude, shown).map((d) => ({
    issue: d.issue,
    title: d.title,
    ...(d.byHand ? { byHand: true as const } : { before: d.before, after: d.after }),
  }));
  const merged = mergeJournal(s.source?.replacing?.dependants ?? [], found);
  const dependants = merged.dependants
    .filter((d) => !d.done)
    .map((d): Found => ({ issue: d.issue, title: d.title, ...(d.byHand ? { byHand: true as const } : {}), ...(d.before !== undefined ? { before: d.before } : {}), ...(d.after !== undefined ? { after: d.after } : {}) }))
    .sort((a, b) => a.issue - b.issue);
  return { ...(open.cut || s.source?.replacing?.cut || merged.cut ? { cut: true as const } : {}), dependants };
}
