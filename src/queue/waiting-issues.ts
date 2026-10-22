import type { Comment } from "../github.js";

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
