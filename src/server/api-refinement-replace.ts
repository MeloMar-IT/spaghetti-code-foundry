import { githubKey } from "../auth/repo-url.js";
import { closeIssue, commentOnIssue, findOwnComment, issueComments, listOpenIssues, restIssue, setLabels, updateIssue, type RestIssue } from "../github.js";
import { storyKey, storyKeys } from "../monitor/breaker.js";
import { readFindings } from "../monitor/findings.js";
import { hashIn } from "../monitor/story.js";
import { announcesClose, dependantComment, dependsOnText, findDependants, originalComment, replaceMarker, rewriteDependsOn, type DependantKind } from "../refinement/dependants.js";
import type { PullKind } from "../refinement/issue-building.js";
import { endsWithMarker, type ReplacePart } from "../refinement/publish.js";
import { LABELS_MAX, markOf, mergeJournal, partsOf, replaceStarted, type Closed, type Found } from "../refinement/replace-journal.js";
import { getSession, recordDependantDone, recordDependantWrite, recordOriginalLabels, recordReplaced, recordReplacing, type Session } from "../refinement/store.js";
import { labelsOf, whatHappened, whyBuilding } from "./api-refinement-import.js";
import { HttpError } from "./http.js";
import type { ApiContext } from "./server.js";

/** Is this issue a story of the monitor: the marker is in its text, or a finding remembers it (also when the marker was taken out)? */
function isMonitorStory(repo: string, issue: number, body: string | null | undefined): boolean {
  if (hashIn(body ?? undefined) !== undefined) return true;
  return storyKeys(readFindings().findings).has(storyKey(repo, issue));
}

/** The title the source issue has on GitHub now (the stored one when the issue is gone or is a pull request), and whether it is a monitor story. */
export async function readOriginal(s: Session, timeout: number): Promise<{ title: string; monitor: boolean }> {
  const n = s.source!.issue;
  let issue;
  try {
    issue = await restIssue(s.repo, n, timeout);
  } catch (e) {
    throw new HttpError(502, `could not read issue #${n} on GitHub: ${whatHappened(e)}`);
  }
  const live = issue && !issue.pull_request ? issue : undefined;
  return { title: live && typeof live.title === "string" && live.title ? live.title : s.source!.title, monitor: live ? isMonitorStory(s.repo, n, live.body) : false };
}

/**
 * The open issues that depend on the issue a publish would replace: a fresh scan merged with the journal kept. It only reads.
 * `title` is the live title of the original when the caller read it already.
 */
export async function replacePlan(ctx: ApiContext, s: Session, replaces: { issue: number; parts: ReplacePart[] }, timeout: number, original?: { title: string; monitor: boolean }): Promise<{ cut?: true; staysOpen?: true; dependants: Found[] }> {
  const live = original ?? (await readOriginal(s, timeout));
  let open;
  try {
    open = await listOpenIssues(s.repo, { pages: ctx.opts.openIssuePages ?? 10, timeoutMs: timeout });
  } catch (e) {
    throw new HttpError(502, `could not read the open issues on GitHub: ${whatHappened(e)}`);
  }
  const exclude = replaces.parts.flatMap((p) => ("issue" in p ? [p.issue] : []));
  const shown = replaces.parts.map((p) => ("issue" in p ? p.issue : `new issue ${p.item}`));
  const found: Found[] = findDependants(open.issues, { number: replaces.issue, title: live.title }, exclude, shown).map((d) => ({
    issue: d.issue,
    title: d.title,
    ...(d.byHand ? { byHand: true as const } : { before: d.before, after: d.after }),
  }));
  const merged = mergeJournal(s.source?.replacing?.dependants ?? [], found);
  const dependants = merged.dependants
    .filter((d) => !d.done)
    .map((d): Found => ({ issue: d.issue, title: d.title, ...(d.byHand ? { byHand: true as const } : {}), ...(d.before !== undefined ? { before: d.before } : {}), ...(d.after !== undefined ? { after: d.after } : {}) }))
    .sort((a, b) => a.issue - b.issue);
  const cut = open.cut || s.source?.replacing?.cut || merged.cut;
  // A dependant the journal has as done that names the original again (a person changed it back) still points at it.
  const again = found.some((f) => merged.dependants.find((d) => d.issue === f.issue)?.done);
  const staysOpen = cut || again || live.monitor || dependants.some((d) => d.byHand) || merged.dependants.some((d) => d.outcome === "by-hand" || d.outcome === "check");
  return { ...(cut ? { cut: true as const } : {}), ...(staysOpen ? { staysOpen: true as const } : {}), dependants };
}

// ---- the ledger ----------------------------------------------------------------------------------------------------------------------

export type Write = { issue: number; what: "created" | "found" | "updated" | "rewritten" | "commented" | "labelled" | "unlabelled" | "closed" };
/** How many writes an error message names. */
const LEDGER_SHOWN = 10;
const PHRASE: Record<Exclude<Write["what"], "found">, string> = {
  created: "was made",
  updated: "was changed",
  rewritten: "was changed",
  commented: "got a comment",
  labelled: "got a label",
  unlabelled: "lost a label",
  closed: "was closed",
};

/** Every write of one publish, in order: the issues made and changed, the dependants rewritten, the comments, the labels taken off. */
export function newLedger() {
  const list: Write[] = [];
  const phrases = () => list.flatMap((w) => (w.what === "found" ? [] : [`#${w.issue} ${PHRASE[w.what]}`]));
  return {
    add: (w: Write) => void list.push(w),
    /** Each issue once, in the order of its first write (an issue that was taken over counts too: it is part of the audit line). */
    numbers: (): number[] => [...new Set(list.map((w) => w.issue))],
    /** "nothing was written" only when there is no write; else what was written (the last ten). */
    text: (): string => {
      const p = phrases();
      if (!p.length) return "nothing was written";
      return `written so far: ${p.length > LEDGER_SHOWN ? "… " : ""}${p.slice(-LEDGER_SHOWN).join(", ")}`;
    },
    /** The last write, e.g. "#20 got a comment"; undefined when there is none. */
    last: (): string | undefined => phrases().at(-1),
  };
}
export type Ledger = ReturnType<typeof newLedger>;

/** The longest audit line. */
const AUDIT_MAX = 500;
/** Room kept for " (9999/9999)". */
const AUDIT_SUFFIX = 12;

/** The audit lines of a publish: `repo #1,#2`, cut into lines of at most 500 characters ending in `(i/n)` when there are several. Each number once. */
export function auditLines(repo: string, numbers: number[]): string[] {
  const unique = [...new Set(numbers)];
  if (!unique.length) return [];
  const whole = `${repo} ${unique.map((n) => `#${n}`).join(",")}`;
  if (whole.length <= AUDIT_MAX) return [whole];
  const room = AUDIT_MAX - AUDIT_SUFFIX;
  const chunks: string[][] = [[]];
  let size = repo.length + 1;
  for (const n of unique) {
    const piece = `#${n}`;
    const cur = chunks[chunks.length - 1]!;
    const add = piece.length + (cur.length ? 1 : 0);
    if (cur.length && size + add > room) {
      chunks.push([piece]);
      size = repo.length + 1 + piece.length;
    } else {
      cur.push(piece);
      size += add;
    }
  }
  return chunks.map((c, i) => `${repo} ${c.join(",")} (${i + 1}/${chunks.length})`);
}

// ---- checks and reads ---------------------------------------------------------------------------------------------------------------

/** The body of the own comment with this marker on the issue; undefined when there is none. A comment of another login does not count. Rejects with 502. */
export async function ownCommentBody(repo: string, issue: number, marker: string, timeout: number): Promise<string | undefined> {
  try {
    return (await findOwnComment(await issueComments(repo, issue, timeout), (c) => endsWithMarker(c.body, marker), timeout))?.body;
  } catch (e) {
    throw new HttpError(502, `could not read the comments of issue #${issue} on GitHub: ${whatHappened(e)}`);
  }
}

/** Does an own comment with this marker exist on the issue? */
export async function hasOwnComment(repo: string, issue: number, marker: string, timeout: number): Promise<boolean> {
  return (await ownCommentBody(repo, issue, marker, timeout)) !== undefined;
}

export interface OriginalState {
  title: string;
  closed: boolean;
  closedAt?: string;
  /** Why GitHub closed it (`state_reason`). */
  reason?: string;
  /** It is a story of the monitor: closing it as not planned would mute the finding. */
  monitor: boolean;
  /** The labels the original has now. */
  labels: string[];
}

/**
 * Reads the original before the first write of a publish that makes a part or is due. A closed or built original is refused (409) while the
 * replacement has not started, and nothing was written then. Once it has started, a closed original is only reported (the comment says so),
 * and a built one is refused without that phrase: parts are on GitHub already.
 */
export async function checkOriginal(ctx: ApiContext, s: Session, timeout: number): Promise<OriginalState> {
  const n = s.source!.issue;
  const started = replaceStarted(s);
  const nothing = started ? "" : "; nothing was written";
  let issue: RestIssue | undefined;
  try {
    issue = await restIssue(s.repo, n, timeout);
  } catch (e) {
    throw new HttpError(502, `could not read issue #${n} on GitHub: ${whatHappened(e)}${nothing}`);
  }
  if (!issue) throw new HttpError(409, `issue #${n} does not exist on GitHub any more${nothing || "; drop the session"}`);
  if (issue.pull_request) throw new HttpError(409, `#${n} is a pull request, not an issue${nothing || "; drop the session"}`);
  const labels = labelsOf(issue);
  const title = issue.title || s.source!.title;
  const monitor = isMonitorStory(s.repo, n, issue.body);
  if (issue.state !== "open") {
    if (!started) throw new HttpError(409, `issue #${n} is closed, so nothing was written; reopen it on GitHub and publish again`);
    const at = typeof issue.closed_at === "string" ? Date.parse(issue.closed_at) : NaN;
    return { title, closed: true, monitor, ...(typeof issue.state_reason === "string" ? { reason: issue.state_reason } : {}), ...(Number.isFinite(at) ? { closedAt: new Date(at).toISOString() } : {}), labels };
  }
  let why: string | undefined;
  try {
    why = await whyBuilding(ctx, s.repo, n, labels, timeout, new Map<string, PullKind>());
  } catch (e) {
    throw new HttpError(502, `could not read a pull request of issue #${n} on GitHub: ${whatHappened(e)}${nothing}`);
  }
  if (why) throw new HttpError(409, `issue #${n} cannot be replaced: ${why}${nothing || "; remove the label or drop the session, then publish again"}`);
  return { title, closed: false, monitor, labels };
}

/** The acceptance criteria that stay on the split drafts of the session (the mark and every split draft reached from it), in order. */
export function leftBehindOf(s: Session): string[] {
  const mark = markOf(s);
  const byId = new Map(s.drafts.map((d) => [d.id, d]));
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    const d = byId.get(id);
    if (!d || seen.has(id) || !d.splitInto) return;
    seen.add(id);
    out.push(...d.criteria.map((c) => c.text));
    for (const p of d.splitInto) walk(p);
  };
  if (mark !== undefined) walk(mark);
  return out;
}

// ---- the replacement ---------------------------------------------------------------------------------------------------------------

export interface ReplaceInput {
  ctx: ApiContext;
  s: Session;
  by: string;
  timeout: number;
  actor: { id: string; admin: boolean };
  original: OriginalState;
  leftBehind: string[];
  /** Called as soon as GitHub confirmed a write. */
  wrote: (w: { issue: number; what: "rewritten" | "commented" | "unlabelled" | "closed" }) => void;
  /** What was written so far (for error messages) and the last write. */
  written: () => string;
  lastWrite: () => string | undefined;
}

/** The labels the issue watchers of the repository start a build with (enabled or not), and the build label the session remembers. */
function triggerLabels(ctx: ApiContext, s: Session): string[] {
  const key = githubKey(s.repo);
  const fromWatchers = ctx.config().watchers.filter((w) => w.source === "issues" && w.github_repo !== "" && githubKey(w.github_repo) === key).map((w) => w.label);
  return [...fromWatchers, ...(s.source?.buildLabel ? [s.source.buildLabel] : [])].filter(Boolean);
}

/**
 * Finishes the replacement of a split original once every part is on GitHub. In this order: the journal of the dependants; each unfinished
 * dependant in issue-number order (read, evidence, read again, PATCH of the "Depends on" text, comment); the trigger labels off the original;
 * the comment on the original; the original read again; the close as not planned (not when it stays open); the end. The original is never changed otherwise. A retry finishes from the journal and from the markers of
 * the own comments: nothing is written twice. Issue text only goes to GitHub through stdin.
 */
export async function replaceOriginal(o: ReplaceInput): Promise<{ issue: number; parts: number[]; dependants: { issue: number; outcome: string }[]; closed: Closed; closedAt?: string }> {
  const { ctx, s, timeout, actor, original } = o;
  const repo = s.repo;
  const n = s.source!.issue;
  const parts = partsOf(s.drafts, markOf(s)!).map((d) => d.published!.issue);
  const end = () => `${o.written()}. Publish again, after a moment.`;

  /** A GitHub call; its failure is 502 and names what was written. */
  const github = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.status, `${e.message}; ${end()}`);
      throw new HttpError(502, `${what}: ${whatHappened(e)}; ${end()}`);
    }
  };
  /** A write to the session; its failure is 500 and names the last write. */
  const keep = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      ctx.diagLog?.(`refinement: publish could not record the replacement of an issue (${e instanceof Error ? e.name : "error"})`);
      const last = o.lastWrite();
      throw new HttpError(
        500,
        last
          ? `${last}, but that could not be saved in the session. Publish again, after a moment: nothing is written twice.`
          : `the replacement of issue #${n} could not be saved in the session; nothing was written. Publish again, after a moment.`,
      );
    }
  };

  const scan = await replacePlan(ctx, s, { issue: n, parts: parts.map((issue) => ({ issue })) }, timeout, { title: original.title, monitor: original.monitor });
  const journal = keep(() => recordReplacing(actor, s.id, { parts, found: scan.dependants, ...(scan.cut ? { cut: true } : {}) }));
  const ownComment = (issue: number) => github(`could not read the comments of issue #${issue} on GitHub`, () => hasOwnComment(repo, issue, replaceMarker(s.id, issue), timeout));
  const read = (issue: number) => github(`could not read issue #${issue} on GitHub`, () => restIssue(repo, issue, timeout));

  const entries = journal.source!.replacing!.dependants.filter((d) => !d.done).sort((a, b) => a.issue - b.issue);
  for (const e of entries) {
    const k = e.issue;
    const a = await read(k);
    if (!a || a.pull_request) {
      keep(() => recordDependantDone(actor, s.id, k, "gone"));
      continue;
    }
    if (a.state !== "open") {
      keep(() => recordDependantDone(actor, s.id, k, "closed"));
      continue;
    }
    const body = a.body ?? "";
    const now = dependsOnText(body);
    let kind: DependantKind;
    let before: string | undefined;
    let after: string | undefined;
    const r = rewriteDependsOn(body, n, parts);
    if (e.rangeAfter !== undefined && now === e.rangeAfter) {
      // Written by an earlier try: the text names the parts already; only the comment may be missing.
      kind = "rewritten";
      before = e.before;
      after = e.after;
    } else if (r) {
      const ev = { before: r.before, after: r.after, rangeBefore: r.before, rangeAfter: dependsOnText(r.body) ?? r.after };
      keep(() => recordDependantWrite(actor, s.id, k, ev, {}, e.rangeAfter !== undefined));
      // Read again right before the write: a person may have edited the issue meanwhile.
      const b = await read(k);
      const rewrite = b && !b.pull_request && b.state === "open" ? rewriteDependsOn(b.body ?? "", n, parts) : undefined;
      if (!b || !rewrite || dependsOnText(b.body ?? "") !== now) {
        throw new HttpError(409, `the "Depends on" text of issue #${k} changed on GitHub while it was read, so that issue was not changed; publish again. ${o.written()}`);
      }
      await github(`GitHub did not change issue #${k}`, () => updateIssue(repo, k, { body: rewrite.body }, timeout));
      o.wrote({ issue: k, what: "rewritten" });
      kind = "rewritten";
      before = ev.before;
      after = ev.after;
    } else if (e.rangeAfter !== undefined) {
      kind = "check";
    } else if (findDependants([{ number: k, title: a.title, body }], { number: n, title: original.title }, [], parts).length) {
      kind = "byHand";
    } else if (await ownComment(k)) {
      // An earlier try wrote the comment and a person removed the dependency since: the outcome stays.
      keep(() => recordDependantDone(actor, s.id, k, "by-hand"));
      continue;
    } else {
      keep(() => recordDependantDone(actor, s.id, k, "no-longer-depends"));
      continue;
    }
    if (!(await ownComment(k))) {
      const text = dependantComment({ kind, original: n, parts, by: o.by, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}), marker: replaceMarker(s.id, k) });
      await github(`GitHub did not add the comment on issue #${k}`, () => commentOnIssue(repo, k, text, timeout));
      o.wrote({ issue: k, what: "commented" });
    }
    keep(() => recordDependantDone(actor, s.id, k, kind === "byHand" ? "by-hand" : kind));
  }

  // The trigger labels come off the original, so that the watcher does not build it as well; also off a closed one, which may be reopened.
  const wanted = triggerLabels(ctx, s).map((l) => l.toLowerCase());
  const found = original.labels.filter((l) => wanted.includes(l.toLowerCase()));
  if (found.length) {
    // Every label taken off is journalled first, so a retry can name it; a label that does not fit is not taken off.
    const have = (getSession(s.id)?.source?.replacing?.labels ?? []).map((l) => l.toLowerCase());
    const fresh = new Set(found.map((l) => l.toLowerCase()).filter((l) => !have.includes(l)));
    if (have.length + fresh.size > LABELS_MAX) {
      throw new HttpError(409, `issue #${n} has more trigger labels than the session can keep (${LABELS_MAX}); ${o.written()}. Take them off by hand and publish again.`);
    }
    keep(() => recordOriginalLabels(actor, s.id, found));
    await github(`GitHub did not take the label off issue #${n}`, () => setLabels(repo, n, undefined, found, timeout));
    o.wrote({ issue: n, what: "unlabelled" });
  }

  const replacing = getSession(s.id)!.source!.replacing!;
  const dependants = replacing.dependants.map((d) => ({ issue: d.issue, outcome: d.outcome ?? "" })).sort((a, b) => a.issue - b.issue);
  const keepOpen = scan.staysOpen === true || replacing.cut || original.monitor || replacing.dependants.some((d) => d.outcome === "by-hand" || d.outcome === "check");
  const marker = replaceMarker(s.id, n);
  const before = await github(`could not read the comments of issue #${n} on GitHub`, () => ownCommentBody(repo, n, marker, timeout));
  let announced: boolean;
  if (before === undefined) {
    // The original is read again: it may have changed while the parts and the dependants were written.
    const fresh = await checkOriginal(ctx, s, timeout);
    const text = originalComment({
      ending: fresh.closed ? "closedAlready" : keepOpen || fresh.monitor ? "staysOpen" : "closes",
      parts,
      by: o.by,
      marker,
      ...(replacing.cut ? { cut: true } : {}),
      ...(replacing.labels?.length ? { labels: replacing.labels } : {}),
      leftBehind: o.leftBehind,
    });
    await github(`GitHub did not add the comment on issue #${n}`, () => commentOnIssue(repo, n, text, timeout));
    o.wrote({ issue: n, what: "commented" });
    announced = announcesClose(text);
  } else {
    announced = announcesClose(before);
  }
  // Right before the close: built meanwhile gives 409 and nothing is closed; closed meanwhile is reported.
  const now = await checkOriginal(ctx, s, timeout);
  let result: { closed: Closed; closedAt?: string };
  if (now.closed) {
    result = now.reason === "not_planned" && before !== undefined && now.closedAt ? { closed: "not_planned", closedAt: now.closedAt } : { closed: "other" };
  } else if (announced && !keepOpen && !now.monitor) {
    const done = await github(`GitHub did not close issue #${n}`, () => closeIssue(repo, n, "not_planned", timeout));
    o.wrote({ issue: n, what: "closed" });
    const at = typeof done.closed_at === "string" ? Date.parse(done.closed_at) : NaN;
    result = { closed: "not_planned", closedAt: new Date(Number.isFinite(at) ? at : Date.now()).toISOString() };
  } else {
    result = { closed: "open" };
  }
  keep(() => recordReplaced(actor, s.id, result));
  return { issue: n, parts, dependants, ...result };
}
