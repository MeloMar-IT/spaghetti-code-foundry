import type { MonitorConfig } from "../config.js";
import { errorLine } from "../errors.js";
import { commentOnIssue, createIssue, createLabelIfMissing, ghLogin, issueComments, listIssuesByLabel, restIssue, type RateReading, type RestIssue } from "../github.js";
import { LABEL_WORDS } from "../words.js";
import { cleanLines, type CleanDeps, type Names } from "./clean.js";
import { dayOf, type Finding, type Severity, type StoryRef } from "./findings.js";
import { cameBack as fixCameBack, fixState, forgetFix, MAX_TRIES, triesOf } from "./fix.js";
import type { LogEntry, Mute, Verdict } from "./guard.js";
import { muteFor } from "./mutes.js";
import { buildStory, fixedComment, hashIn, isFixedComment, markerHash, seenAgainComment, type BuiltinSteps } from "./story.js";

const HOUR = 3_600_000;
const RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };
/** The "seen again" comment goes out at most this often per story. It is also how often a story of a finding that is not seen is looked at. */
export const COMMENT_EVERY_MS = 6 * HOUR;
/** At most this many calls to GitHub in one check (the manager's own reads of the request limit come on top). */
export const CALL_BUDGET = 6;
const CALL_TIMEOUT_MS = 20_000;
/** The skip reason of a finding that an admin muted. */
const MUTED = "muted";
const BUG = { name: "bug", color: "d73a4a", description: "Something isn't working" };

/** Pure helper for the watcher manager: the label of the issue watcher of a repository that builds its stories. */
export function buildLabelFor(watchers: { enabled: boolean; source: string; github_repo: string; flow: string; label: string }[], repo: string): string | undefined {
  const mine = watchers.filter((w) => w.enabled && w.source === "issues" && w.github_repo.toLowerCase() === repo.toLowerCase());
  return (mine.find((w) => w.flow === "issue-gitflow" || w.flow === "default") ?? mine[0])?.label;
}

export interface ReporterDeps {
  config: () => MonitorConfig;
  /** The label that makes a watcher build an issue of this repository; undefined when no watcher does. */
  buildLabel: (repo: string) => string | undefined;
  names: (target: string) => Names;
  builtinSteps: () => BuiltinSteps;
  rateLimit?: () => RateReading | undefined;
  /** May bug stories be made now? Asked at the top of a check and again before each call that makes or touches a story. Without it, always. */
  guard?: () => Verdict;
  /** Writes one line to the monitor's own log (a story made or skipped, with the reason). */
  record?: (entry: LogEntry) => void;
  /** The admin's mutes in force at a time. Asked at the top of a check and again right before a story or a comment. Without it, nothing is muted. */
  mutes?: (now: Date) => Mute[];
  /** The server log: only a cleaned error line goes there. */
  log?: (msg: string) => void;
  /** For tests. */
  clean?: CleanDeps;
}

export interface ReportResult {
  findings: Finding[];
  /** What was done (one line each). */
  actions: string[];
  /** What waits or is wrong, as plain sentences (shown on the monitor's card). */
  notes: string[];
}

const same = (a: string | undefined, b: string | undefined) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
const plural = (n: number) => `${n} bug ${n === 1 ? "story waits" : "stories wait"}`;
const stories = (n: number) => `${n} new bug ${n === 1 ? "story" : "stories"}`;
// "at most 3 new bug stories a day" / "at most 1 new bug story per check"

/** Writes bug stories for findings that last, once each, within limits. State lives in the findings (`due`, `report`). */
export class Reporter {
  /** `target|label` of labels this process knows to exist. Only a call that succeeded adds to it. */
  private labelsOk = new Set<string>();

  constructor(private d: ReporterDeps) {}

  async report(input: Finding[], now: Date, save: (findings: Finding[]) => void): Promise<ReportResult> {
    const cfg = this.d.config();
    const target = cfg.report_to;
    if (!target) return { findings: input, actions: [], notes: [] };
    const { per_day, per_check } = cfg.report_limits;
    const findings = input.map((f) => ({ ...f }));
    const actions: string[] = [];
    const notes: string[] = [];
    const t = now.getTime();
    const stamp = now.toISOString();
    let touched = false;
    const commit = () => {
      save(findings);
      touched = false;
    };
    const done = (): ReportResult => {
      for (const f of findings) {
        // Nothing owed any more (made, gone, adopted): the reasons are written again if it comes back.
        if (f.skipped && !(f.due && !muted(f) && !open(f)) && !owes(f)) {
          delete f.skipped;
          touched = true;
        }
      }
      for (const f of findings) if (f.report && same(f.report.repo, target) && f.report.muted && !f.gone) notes.push(`Bug story #${f.report.issue} was closed as not planned: no new story until it is reopened.`);
      if (touched) commit();
      return { findings, actions, notes };
    };

    const seenNow = (f: Finding) => !f.gone && f.lastSeen === stamp;
    const mine = (f: Finding): StoryRef | undefined => (f.report && same(f.report.repo, target) ? f.report : undefined);
    const open = (f: Finding) => !!mine(f) && !mine(f)!.closedAt && !mine(f)!.muted;
    const muted = (f: Finding) => !!mine(f)?.muted;
    const ripe = (f: Finding) => (f.severity === "minor" ? (f.days?.length ?? 0) >= 3 : (f.streak ?? f.count) >= 2);
    /** The problem is back after its story was closed as completed: the fix runs (the clock started), new proof was seen, and the usual rule is met. */
    const cameBack = (f: Finding): boolean => fixCameBack(f, { target, stamp });
    /** A story is owed for this finding (it is seen now, lasts, and has no story or a closed one). */
    const wouldOwe = (f: Finding): boolean => {
      if (!seenNow(f) || muted(f)) return false;
      const m = mine(f);
      return (!m && ripe(f)) || (!!m?.closedAt && cameBack(f));
    };
    /** Two bug stories were made since the count started: a third is not made, a person decides. */
    const spent = (f: Finding): boolean => triesOf(f) >= MAX_TRIES;
    const owes = (f: Finding): boolean => wouldOwe(f) && !spent(f);
    /** The gate: once it has said no in this check, it stays no. */
    let shut = undefined as Extract<Verdict, { go: false }> | undefined; // set by go(); the cast keeps TypeScript from narrowing it to undefined
    const go = (): boolean => {
      if (!shut) {
        const v = this.d.guard?.() ?? { go: true as const };
        if (!v.go) shut = v;
      }
      return !shut;
    };
    /** The admin's mutes: read at the top, and again right before a story or a comment (a mute may come in during the check). */
    let mutes = this.d.mutes?.(now) ?? [];
    const muteOf = (f: Finding) => muteFor(mutes, f);
    const markDue = (f: Finding) => {
      if (shut || f.due || !owes(f) || muteOf(f)) return;
      f.due = stamp;
      touched = true;
    };
    /** Writes a skipped story to the log, once per finding and reason. */
    const skip = (f: Finding, reason: string, by?: Mute) => {
      // A mute is remembered with its id (`muted:<id>`): another mute that takes over is logged again with its own reason.
      const key = by ? `${reason}:${by.id}` : reason;
      if (f.skipped?.includes(key)) return;
      f.skipped = [...(f.skipped ?? []).filter((r) => !by || !r.startsWith(`${reason}:`)), key];
      touched = true;
      this.d.record?.({ event: "story-skipped", reason, detector: f.detector, fingerprint: f.fingerprint, repo: target, ...(by ? { mute: by.id, text: by.reason, ...(by.until ? { until: by.until } : {}) } : {}) });
    };
    /** A muted finding that would be owed a story (or is owed one): the reason is logged once; nothing else happens. */
    const skipMuted = (f: Finding) => {
      const m = muteOf(f);
      if (m && (owes(f) || (f.due && !muted(f) && !open(f)))) skip(f, MUTED, m);
    };

    go(); // 1. May stories be made at all? A closed gate owes nothing new.

    // 2. Seen again.
    for (const f of findings) {
      const m = seenNow(f) ? mine(f) : undefined;
      if (m) {
        f.report = { ...m, seen: m.seen + 1 };
        touched = true;
      }
    }
    // 3. What is owed now.
    for (const f of findings) markDue(f);

    for (const f of findings) {
      // A mute that ended: the reason is written again if the finding is muted again.
      if (f.skipped?.some((r) => r.startsWith(`${MUTED}:`)) && !muteOf(f)) {
        const left = f.skipped.filter((r) => !r.startsWith(`${MUTED}:`));
        if (left.length) f.skipped = left;
        else delete f.skipped;
        touched = true;
      }
      skipMuted(f);
    }

    /** Findings that would be owed a story but have used their tries: they become "needs you" once GitHub has been asked. */
    const handOver = () => findings.filter((f) => wouldOwe(f) && spent(f) && !f.needsYou && !muteOf(f));
    const queueOf = () => findings.filter((f) => f.due && !muted(f) && !open(f) && !muteOf(f)).sort((a, b) => RANK[a.severity] - RANK[b.severity] || Date.parse(a.due!) - Date.parse(b.due!));
    const madeToday = () => findings.filter((f) => f.report && dayOf(new Date(f.report.at)) === dayOf(now)).length;
    const allowedNow = () => Math.max(0, Math.min(per_check, per_day - madeToday()));
    let queue = queueOf();
    const look = findings.filter((f) => seenNow(f) && !muteOf(f) && mine(f) && t - Date.parse(mine(f)!.lookedAt ?? mine(f)!.at) >= COMMENT_EVERY_MS);
    const lookedAt = (f: Finding) => Date.parse(mine(f)!.lookedAt ?? mine(f)!.at);
    /** Stories of findings that are not seen now, not asked about for 6 hours (a close or a reopen is noticed this way), oldest first. */
    const quiet = findings.filter((f) => !seenNow(f) && mine(f) && !mine(f)!.muted && !muteOf(f) && t - lookedAt(f) >= COMMENT_EVERY_MS).sort((a, b) => lookedAt(a) - lookedAt(b));
    /** The finding whose "not seen since the fix" comment is owed (one per check, the oldest first). */
    const note = findings.filter((f) => mine(f)?.fixNote && !muteOf(f)).sort((a, b) => Date.parse(mine(a)!.fixedAt ?? stamp) - Date.parse(mine(b)!.fixedAt ?? stamp))[0];

    // 6. Notes that need no call.
    const label = this.d.buildLabel(target);
    if (!label) notes.push(`No watcher builds bug stories for ${target}: the stories only get the label bug.`);

    const shutNote = (n: number) => `${plural(n)}: ${shut!.note}.`;
    if (shut) {
      // No call to GitHub, no comment. Findings that are owed (or would be) wait; each reason is logged once.
      const waiting = findings.filter((f) => !muteOf(f) && (queue.includes(f) || owes(f)));
      for (const f of waiting) skip(f, shut.reason);
      if (waiting.length) notes.push(shutNote(waiting.length));
      return done();
    }

    // 7. Nothing to ask GitHub?
    const dayNote = (left: number) => `${plural(left)}: at most ${stories(per_day)} a day.`;
    const checkNote = (left: number) => `${plural(left)}: at most ${stories(per_check)} per check.`;
    if (!look.length && !quiet.length && !note && !handOver().length && (!queue.length || allowedNow() === 0)) {
      if (queue.length) {
        notes.push(dayNote(queue.length));
        for (const f of queue) skip(f, "day_limit");
      }
      return done();
    }
    // 8. GitHub's request limit is used up: ask nothing.
    const rate = this.d.rateLimit?.();
    const core = rate && t - Date.parse(rate.at) < HOUR ? rate.resources.core : undefined;
    if (core && core.remaining === 0 && core.reset * 1000 > t) {
      if (queue.length) notes.push(`${plural(queue.length)}: GitHub's request limit is used up.`);
      for (const f of queue) skip(f, "request_limit");
      return done();
    }

    // 9. Ask GitHub, within a budget of calls.
    let calls = 0;
    const spend = (n: number) => (calls + n <= CALL_BUDGET ? ((calls += n), true) : false);
    const unresolved = new Set<Finding>();
    try {
      // The quiet stories are marked as asked before the call: a failed call waits another 6 hours. A story that is skipped only
      // for lack of budget gets its old time back below.
      const oldLooked = new Map<Finding, string | undefined>();
      if (quiet.length) {
        for (const f of quiet) {
          oldLooked.set(f, mine(f)!.lookedAt);
          f.report = { ...mine(f)!, lookedAt: stamp };
        }
        commit();
      }
      spend(1);
      const byHash = new Map<string, RestIssue>();
      for (const i of await listIssuesByLabel(target, BUG.name, CALL_TIMEOUT_MS)) {
        const h = hashIn(i.body ?? undefined);
        if (!h) continue;
        const have = byHash.get(h);
        const isOpen = (x: RestIssue) => x.state === "open";
        // An open story wins (the oldest of them); else the newest closed one.
        if (!have || (isOpen(i) && (!isOpen(have) || i.number < have.number)) || (!isOpen(i) && !isOpen(have) && i.number > have.number)) byHash.set(h, i);
      }
      /** Applies what GitHub says about the story of a finding. */
      const apply = (f: Finding, issue: RestIssue) => {
        const m = mine(f);
        const known = m?.issue === issue.number || (f.earlier ?? []).some((e) => same(e.repo, target) && e.issue === issue.number);
        // A story that was made but whose save was lost is adopted here: it counts as a try (before it is assigned).
        if (!known) {
          f.tries = triesOf(f) + 1;
          delete f.needsYou;
        }
        const r: StoryRef = m && m.issue === issue.number ? { ...m } : { repo: target, issue: issue.number, url: issue.html_url, at: issue.created_at, seen: 0, lookedAt: stamp };
        let next: StoryRef = r;
        if (issue.state === "open") {
          // Open again: the clock and the verdict are forgotten.
          next = forgetFix(r);
          delete next.closedAt;
          delete next.muted;
          delete f.due;
        } else if (!issue.state_reason || issue.state_reason === "completed") {
          const closed = issue.closed_at ?? r.closedAt ?? stamp;
          // Closed at another time (reopened and closed again): the fix state starts over.
          next = r.closedAt !== undefined && Date.parse(r.closedAt) !== Date.parse(closed) ? forgetFix(r) : r;
          next.closedAt = closed;
          delete next.muted;
        } else {
          next = forgetFix(r);
          next.muted = true;
          delete f.due;
          actions.push(`bug story #${issue.number} was closed as not planned: muted`);
        }
        f.report = next;
        touched = true;
      };
      const syncing = findings.filter((f) => !muteOf(f) && (queue.includes(f) || (seenNow(f) && mine(f)) || quiet.includes(f) || f === note));
      for (const f of syncing) {
        const match = byHash.get(markerHash(f.fingerprint));
        if (match) {
          apply(f, match);
          continue;
        }
        const m = mine(f);
        // Quiet stories outside the newest 100 are read after the comments, with what is left of the budget.
        if (!m || !(queue.includes(f) || look.includes(f) || f === note || handOver().includes(f))) continue;
        // Not in the newest 100: read it, before a successor or a comment is decided from the local state.
        if (!go() || !spend(1)) {
          unresolved.add(f);
          continue;
        }
        const issue = await restIssue(target, m.issue, CALL_TIMEOUT_MS);
        if (issue) apply(f, issue);
        else {
          f.tries = triesOf(f); // a story from before the count still counts as one try
          delete f.report;
          touched = true;
        }
      }
      go(); // switched off while GitHub answered: nothing new becomes owed
      for (const f of findings) {
        markDue(f);
        // A story that is owed stays owed (also when the problem goes away) as long as the problem was seen after the fix started running.
        if (mine(f)?.closedAt && f.due && !(mine(f)!.clockAt && mine(f)!.seenAfter)) {
          delete f.due;
          touched = true;
        }
      }

      // Two tries, then a person: the finding is marked once, and the third story is not made.
      if (handOver().length) mutes = this.d.mutes?.(now) ?? mutes;
      for (const f of handOver()) {
        if (shut) break;
        f.needsYou = stamp;
        delete f.due;
        touched = true;
        this.d.record?.({ event: "story-skipped", reason: "two_tries", detector: f.detector, fingerprint: f.fingerprint, repo: target, ...(mine(f) ? { issue: mine(f)!.issue } : {}) });
      }

      // Recount: adopted stories count against the limits.
      queue = queueOf().filter((f) => !unresolved.has(f));
      const allowed = allowedNow();
      const dayLeft = per_day - madeToday();
      let made = 0;
      let budgetOut = false;
      const names = queue.length ? this.d.names(target) : undefined;
      for (const f of queue.slice(0, allowed)) {
        if (!go()) break;
        const wanted = [BUG, ...(label ? [{ name: label, color: "c2410c", description: LABEL_WORDS.trigger }] : [])].filter((l, i, all) => all.findIndex((x) => x.name === l.name) === i);
        const missing = wanted.filter((l) => !this.labelsOk.has(`${target}|${l.name}`));
        if (!spend(missing.length + 1)) {
          budgetOut = true;
          break;
        }
        let stopped = false;
        for (const l of missing) {
          if (!go()) {
            stopped = true; // switched off while the call before answered: no further call
            break;
          }
          await createLabelIfMissing(target, l.name, l.color, l.description, CALL_TIMEOUT_MS);
          this.labelsOk.add(`${target}|${l.name}`);
        }
        if (stopped) break;
        const foreign = (f.repo !== undefined && !same(f.repo, target)) || (f.evidence?.repos ?? []).some((r) => !same(r, target));
        const raw = f.evidence?.lines ?? [];
        const lines = raw.length === 0 ? [] : foreign ? undefined : await cleanLines(raw, names!, this.d.clean);
        const previous = mine(f)?.issue;
        const story = buildStory(f, { lines, previous, builtinSteps: this.d.builtinSteps() });
        if (!go()) break; // asked again right before the call, after the awaits and the building of the text
        // A mute may have come in during the check (another process): no story. The slot is not given to another finding.
        mutes = this.d.mutes?.(now) ?? mutes;
        const late = muteOf(f);
        if (late) {
          skip(f, MUTED, late);
          continue;
        }
        let issue: RestIssue;
        try {
          issue = await createIssue(target, { title: story.title, body: story.body, labels: wanted.map((l) => l.name) }, CALL_TIMEOUT_MS);
        } catch (e) {
          // A label may have been deleted: make sure of them again next time.
          for (const l of wanted) this.labelsOk.delete(`${target}|${l.name}`);
          throw e;
        }
        // Written before the local save: a story that exists on GitHub must show in the log even when the save fails.
        this.d.record?.({ event: "story-made", detector: f.detector, fingerprint: f.fingerprint, repo: target, issue: issue.number });
        f.tries = triesOf(f) + 1;
        delete f.needsYou;
        f.report = { repo: target, issue: issue.number, url: issue.html_url, at: stamp, seen: 0, lookedAt: stamp };
        delete f.due;
        delete f.skipped;
        commit();
        made++;
        actions.push(`bug story #${issue.number} made (${f.detector})`);
      }

      // Comment: at most one, on an open story that was last looked at 6 hours ago or more.
      const open1: Finding[] = [];
      for (const f of look) {
        const m = mine(f);
        if (!m || m.lookedAt === stamp) continue;
        if (m.closedAt || m.muted) {
          f.report = { ...m, lookedAt: stamp };
          touched = true;
        } else open1.push(f);
      }
      open1.sort((a, b) => Date.parse(mine(a)!.lookedAt ?? mine(a)!.at) - Date.parse(mine(b)!.lookedAt ?? mine(b)!.at));
      const next = open1[0];
      if (next) mutes = this.d.mutes?.(now) ?? mutes;
      if (next && !muteOf(next) && go() && spend(1)) {
        const before = mine(next)!;
        next.report = { ...before, lookedAt: stamp };
        commit(); // saved first: a lost answer must not mean a second comment
        if (go()) {
          await commentOnIssue(target, mine(next)!.issue, seenAgainComment(next), CALL_TIMEOUT_MS);
          actions.push(`commented on bug story #${mine(next)!.issue}: seen again`);
        } else {
          // switched off while saving: no comment, and the story is looked at again later
          next.report = before;
          commit();
        }
      }

      // "Not seen since the fix": at most one comment, on a story the sync just confirmed is still closed. Saved before the post.
      const owed = note && !unresolved.has(note) && mine(note)?.fixNote ? note : undefined;
      if (owed) mutes = this.d.mutes?.(now) ?? mutes;
      if (owed && !muteOf(owed) && go()) {
        const number = mine(owed)!.issue;
        const setNote = (v: "due" | "tried" | undefined) => {
          const { fixNote, ...rest } = mine(owed)!;
          owed.report = v ? { ...rest, fixNote: v } : rest;
        };
        const written = () => {
          setNote(undefined);
          owed.report = { ...mine(owed)!, notedAt: stamp };
          commit();
        };
        let post = true;
        if (mine(owed)!.fixNote === "tried") {
          // A post was started before and the answer was lost: look for our comment first (once is all there is).
          if (spend(2)) {
            let found = false;
            let login: string | undefined;
            for (const c of await issueComments(target, number, CALL_TIMEOUT_MS)) {
              if (!isFixedComment(c)) continue;
              if (c.viewerDidAuthor === undefined && login === undefined) {
                if (!spend(1)) {
                  post = false; // cannot tell whose it is: wait
                  break;
                }
                login = await ghLogin(CALL_TIMEOUT_MS);
              }
              if (c.viewerDidAuthor === true || (c.viewerDidAuthor === undefined && c.author?.login === login)) {
                found = true;
                break;
              }
            }
            if (found) {
              written();
              post = false;
              calls -= 1; // the post was not needed
            }
          } else post = false;
        } else if (!spend(1)) post = false;
        if (post) {
          setNote("tried");
          commit(); // saved first: a lost answer must not mean a second comment
          if (go()) {
            await commentOnIssue(target, number, fixedComment(), CALL_TIMEOUT_MS);
            written();
            actions.push(`commented on bug story #${number}: not seen since the fix`);
          } else {
            setNote("due"); // switched off while saving: no comment
            commit();
          }
        }
      }

      // Quiet stories that were not in the newest 100: open and unsettled ones are read, as far as the budget goes.
      for (const f of quiet) {
        const m = mine(f);
        if (!m || m.lookedAt !== stamp || byHash.has(markerHash(f.fingerprint)) || (f === note && !unresolved.has(f))) continue;
        const state = fixState(m);
        if (!(open(f) || state === "waiting" || state === "watched")) continue;
        if (go() && spend(1)) {
          const issue = await restIssue(target, m.issue, CALL_TIMEOUT_MS);
          if (issue) apply(f, issue);
          else {
            f.tries = triesOf(f);
            delete f.report;
            touched = true;
          }
        } else {
          const { lookedAt: _now, ...kept } = m;
          const was = oldLooked.get(f);
          f.report = was ? { ...kept, lookedAt: was } : kept;
          touched = true;
        }
      }
      // Settled stories outside the newest 100 are not read one by one (that would cost calls for good): they were asked about as far as the list reaches.

      // Notes for what waits.
      const rest = queueOf();
      const left = rest.length;
      if (left) {
        if (shut) {
          notes.push(shutNote(left));
          for (const f of rest) skip(f, shut.reason);
        } else if (made < allowed || budgetOut || unresolved.size) {
          notes.push(`${plural(left)}: they are made at the next check.`);
          // Held back by the budget of calls (or by a story that could not be read): logged like any other limit.
          for (const f of rest) skip(f, "check_limit");
        } else if (dayLeft <= per_check) {
          notes.push(dayNote(left));
          for (const f of rest) skip(f, dayLeft - made <= 0 ? "day_limit" : "check_limit");
        } else {
          notes.push(checkNote(left));
          for (const f of rest) skip(f, "check_limit");
        }
      }
    } catch (e) {
      this.d.log?.(`bug stories: ${errorLine((e as Error).message)}`);
      const rest = queueOf();
      const left = rest.length;
      for (const f of rest) skip(f, "github");
      notes.push(left ? `${plural(left)}: GitHub did not answer or refused the call.` : "GitHub did not answer or refused a call of the monitor.");
    }
    return done();
  }
}
