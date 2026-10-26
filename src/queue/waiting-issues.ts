import { isStatusComment, isOverruleReply, isBot, type Comment } from "../github.js";
import { isUserBudgetStop, type RunSummary } from "../engine/state.js";
import { asksQuestions, countQuestions } from "../next-step.js";
import { flowRetired } from "../run-gate.js";

/** The comment reads of one watcher check: one time limit per read, one budget for all, one gh call per issue. */
export interface CommentReads {
  /** The comments, or undefined when they could not be read (failed, timed out, skipped). Never rejects. */
  read(n: number): Promise<Comment[] | undefined>;
  /** Would read(n) ask GitHub, or does it already have an answer? */
  canRead(n: number): boolean;
  /** The budget of this check is used up. */
  readonly exhausted: boolean;
}

export function commentReads(o: {
  read: (n: number, timeoutMs: number) => Promise<Comment[]>;
  perReadMs: number;
  budgetMs: number;
  now?: () => number;
  skip?: (n: number) => boolean;
  onSlow?: (n: number) => void;
}): CommentReads {
  const now = o.now ?? Date.now;
  let used = 0;
  const left = () => o.budgetMs - used;
  const memo = new Map<number, Promise<Comment[] | undefined>>();

  const once = async (n: number): Promise<Comment[] | undefined> => {
    try {
      if (o.skip?.(n) || left() <= 0) return undefined;
      const timeout = Math.min(o.perReadMs, left());
      const start = now();
      try {
        return await o.read(n, timeout);
      } catch {
        if (now() - start >= timeout) {
          try { o.onSlow?.(n); } catch { /* a callback must not break the check */ }
        }
        return undefined;
      } finally {
        used += Math.max(0, now() - start);
      }
    } catch {
      return undefined;
    }
  };

  return {
    read(n) {
      let p = memo.get(n);
      if (!p) { p = once(n); memo.set(n, p); }
      return p;
    },
    canRead: (n) => memo.has(n) || (!o.skip?.(n) && left() > 0),
    get exhausted() { return left() <= 0; },
  };
}

export interface WaitingLabels { needsInfo: string; waiting: string }

/** Stopped for a reason that clears by itself: daily budget, a usage limit, signed out, or a `wait_*` step. */
export function isPaused(s: RunSummary): boolean {
  return isUserBudgetStop(s.reason) || /daily budget|usage limit reached|signed out —|stopped at step "(?:[\w-]+\/)*wait_/.test(s.reason ?? "");
}

/** Stepped aside for a busy code area (stopped at wait_for_area): the run that holds the area. */
export function steppedAsideFor(s: RunSummary): string | undefined {
  if (s.status !== "stopped" || !/stopped at step "(?:[\w-]+\/)*wait_for_area"/.test(s.reason ?? "")) return undefined;
  const out = [...s.history].reverse().find((h) => h.id === "claim_areas")?.output ?? "";
  return /^waiting for run (\S+) \(/m.exec(out)?.[1];
}

/** The waiting label an issue carries: needs-info first, then waiting-approval; label order does not matter. */
export function waitingLabelOf(names: readonly string[], L: WaitingLabels): string | undefined {
  if (names.includes(L.needsInfo)) return L.needsInfo;
  if (names.includes(L.waiting)) return L.waiting;
  return undefined;
}

/** Does this run really wait the way `label` says? A run of a retired flow never does. */
export function waitsAs(run: RunSummary, label: string, L: WaitingLabels): boolean {
  if (flowRetired(run)) return false;
  if (label === L.waiting) return run.status === "waiting";
  if (label === L.needsInfo) return run.status === "stopped" && asksQuestions(run) && !run.parkedAt && !isPaused(run) && !steppedAsideFor(run);
  return false;
}

/** The newest bot comment that is not a status comment or an overrule reply, while no human has commented after it. */
export function openQuestion(comments: readonly Comment[]): { questions: number; since?: string } | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    if (isStatusComment(c) || isOverruleReply(c)) continue;
    if (!isBot(c)) return undefined;
    return { questions: countQuestions(c.body), ...(c.createdAt ? { since: c.createdAt } : {}) };
  }
  return undefined;
}

/** At most this many comment reads for needs-info extras per check. */
export const EXTRA_READS_PER_CHECK = 20;
/** A successful read of an extra is remembered for this long. */
export const EXTRA_READ_MEMO_MS = 10 * 60_000;

/** Open issues with a waiting label that are not in `listed`, once each, sorted by number (the watcher's extras). */
export function extraWaitingIssues(
  all: readonly { number: number; title: string; state?: string | null; labels: readonly ({ name?: string } | string)[] }[],
  listed: ReadonlySet<number>, L: WaitingLabels, excluded: ReadonlySet<string>,
): { number: number; title: string; label: string }[] {
  const taken = new Set<number>();
  const out: { number: number; title: string; label: string }[] = [];
  for (const i of all) {
    if (listed.has(i.number) || taken.has(i.number)) continue;
    taken.add(i.number);
    if (String(i.state ?? "open").toLowerCase() === "closed") continue;
    const names = i.labels.map((l) => (typeof l === "string" ? l : l.name ?? ""));
    if (names.some((n) => excluded.has(n))) continue;
    const label = waitingLabelOf(names, L);
    if (label) out.push({ number: i.number, title: i.title, label });
  }
  return out.sort((a, b) => a.number - b.number);
}
