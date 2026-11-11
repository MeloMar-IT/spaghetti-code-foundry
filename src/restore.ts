// Restore a safe point (#864): the pure part. Which changes a restore takes back (from the safe points #863 already computes) and the
// text of the issue that asks the flow to put the branch back to a commit. No I/O. The route is in server/api-restore.ts.
import { MAX_SAFE_CHANGES, type SafeChange, type SafePoint } from "./safe-points.js";

export const RESTORE_NOT_UNDONE = "Restoring does not undo data the app wrote, messages or e-mails that were already sent, or settings in outside services.";
export const RESTORE_OTHERS = "Any other later change, also one made outside the Foundry, is taken back too.";

export const restoreMarker = (commit: string): string => `<!-- claude-factory restore=${commit.toLowerCase()} -->`;

export interface TakenBack {
  changes: SafeChange[];
  /**
   * A lower bound, not an exact count. Points can report the same omitted changes, so the largest single count and the
   * overflow of the list are taken, never their sum.
   */
  more: number;
}

const keyOf = (c: SafeChange): string => (c.issue !== undefined ? `#${c.issue}` : c.title);

/**
 * The changes of every point newer than `commit` in `points` (newest first), once each. A change that also stands in the point itself
 * or in an older listed point is left out. `undefined` when the commit is not one of the points.
 */
export function takenBack(points: readonly SafePoint[], commit: string): TakenBack | undefined {
  const at = points.findIndex((p) => p.commit.toLowerCase() === commit.toLowerCase());
  if (at < 0) return undefined;
  const kept = new Set(points.slice(at).flatMap((p) => p.changes.map(keyOf)));
  const seen = new Set<string>();
  const all: SafeChange[] = [];
  let hidden = 0;
  for (const p of points.slice(0, at)) {
    hidden = Math.max(hidden, p.moreChanges ?? 0);
    for (const c of p.changes) {
      const k = keyOf(c);
      if (kept.has(k) || seen.has(k)) continue;
      seen.add(k);
      all.push(c);
    }
  }
  return { changes: all.slice(0, MAX_SAFE_CHANGES), more: Math.max(hidden, all.length - MAX_SAFE_CHANGES) };
}

/** Text that goes into a code span: no backtick and no line break, so it cannot break out and `@name` notifies no one. */
const span = (t: string): string => `\`${String(t).replace(/[`\r\n]+/g, " ").trim()}\``;

/** The title and the body of the issue. `failing` (when the base branch is red) names the failing tests, so the watcher does not hold it. */
export function restoreIssue(point: Pick<SafePoint, "commit" | "short" | "branch" | "at">, taken: TakenBack, failing?: readonly string[]): { title: string; body: string } {
  const title = `Restore the version ${point.short} from ${point.at.slice(0, 10)}`;
  const list = taken.changes.length
    ? taken.changes.map((c) => `- ${c.issue !== undefined ? `#${c.issue} ` : ""}${span(c.title)}`)
    : ["- no change of the Foundry is known after this version"];
  const lines = [
    `Make the code of the ${span(point.branch)} branch the same as commit ${span(point.commit)} again.`,
    "Build this as one change: it only takes back earlier changes.",
    "",
    "### What is taken back",
    ...list,
    ...(taken.more > 0 ? [`- and at least ${taken.more} more`] : []),
    "",
    RESTORE_OTHERS,
    "",
    "### What this does not undo",
    RESTORE_NOT_UNDONE,
    "",
    "### How",
    "Use new commits, such as `git revert`, so the history stays. Do not reset the branch and do not force-push.",
    "Tests and review run as usual.",
    ...(failing?.length ? ["", "### Failing tests to fix", ...failing.map((t) => `- ${span(t)}`)] : []),
    "",
    "### Acceptance criteria",
    `- The code equals commit ${span(point.commit)}, apart from what the flow itself adds.`,
    "- The tests pass.",
    "",
    restoreMarker(point.commit),
  ];
  return { title, body: lines.join("\n") };
}
