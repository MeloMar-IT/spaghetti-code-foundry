import type { WatcherConfig } from "../config.js";
import { readIssueList, type RepoIssueList } from "../queue/issue-list.js";
import { labelNames, parseInterval, type WatcherStatus } from "../queue/watcher.js";
import { waitingLabelOf } from "../queue/waiting-issues.js";
import { storyKey } from "./breaker.js";
import type { WaitingUnlisted } from "./detectors.js";

export type Listed = { repo: string; issue: number };
/** The newest run of an issue: no brief, parked, not parked, or a brief whose run.json is missing, unreadable or another run. */
export type RunState = "none" | "parked" | "open" | "unknown";
export interface UnlistedCandidate { watcher: string; repo: string; issue: number; label: "needs-info" | "waiting-approval" }

/** Open issues with a waiting label from the saved issue lists that Needs you does not list. Never throws. */
export function unlistedCandidates(o: {
  watchers: readonly { cfg: WatcherConfig; status: WatcherStatus }[];
  listed: readonly Listed[];
  /** Issues of the monitor's own bug stories (storyKey form), current and earlier: never candidates. */
  stories: ReadonlySet<string>;
  /** The newest run of this issue. Called only for issues that pass every other rule. */
  runState: (repo: string, issue: number) => RunState;
  read?: (repo: string) => RepoIssueList | undefined;
}): UnlistedCandidate[] {
  try {
    const read = o.read ?? readIssueList;
    const listedKeys = new Set(o.listed.map((l) => storyKey(l.repo, l.issue)));
    const lists = new Map<string, RepoIssueList | undefined>();
    const taken = new Set<string>();
    const out: UnlistedCandidate[] = [];
    for (const { cfg, status } of o.watchers) {
      if (cfg.source !== "issues" || !cfg.enabled || !cfg.github_repo || !status.lastOk || status.lastError) continue;
      const repo = cfg.github_repo;
      if (!lists.has(repo)) {
        try { lists.set(repo, read(repo)); } catch { lists.set(repo, undefined); }
      }
      const list = lists.get(repo);
      if (!list) continue;
      let every: number;
      try { every = parseInterval(cfg.every); } catch { continue; }
      if (Date.parse(status.lastOk) - Date.parse(list.readAt) > every) continue; // the newest good check did not save this list
      const epics = new Set<number>();
      for (const r of list.issues) {
        if (r.stories?.length) epics.add(r.number);
        for (const n of [r.epic, r.parent, r.epicLabel?.issue]) if (n !== undefined) epics.add(n);
      }
      const L = labelNames(cfg);
      const excluded = new Set(cfg.exclude_labels);
      for (const r of list.issues) {
        if (r.state !== "open" || epics.has(r.number)) continue;
        const found = waitingLabelOf(r.labels, L);
        if (!found || r.labels.some((l) => excluded.has(l))) continue;
        const k = storyKey(repo, r.number);
        if (listedKeys.has(k) || o.stories.has(k) || taken.has(k)) continue;
        const state = o.runState(repo, r.number);
        if (state === "unknown" || (state === "parked" && !r.labels.includes(cfg.label))) continue;
        taken.add(k);
        out.push({ watcher: cfg.id, repo, issue: r.number, label: found === L.needsInfo ? "needs-info" : "waiting-approval" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Keeps the first time each candidate was seen; forgets the ones that are gone. */
export class UnlistedTracker {
  private seen = new Map<string, string>();

  /** `listed` undefined → resets and returns undefined. `candidates` is called only when `listed` is set. */
  build(now: Date, candidates: () => UnlistedCandidate[], listed: readonly Listed[] | undefined): WaitingUnlisted[] | undefined {
    if (!listed) {
      this.seen = new Map();
      return undefined;
    }
    const next = new Map<string, string>();
    const out = candidates().map((c) => {
      const k = `${c.watcher}|${storyKey(c.repo, c.issue)}|${c.label}`;
      const since = this.seen.get(k) ?? now.toISOString();
      next.set(k, since);
      return { ...c, since };
    });
    this.seen = next;
    return out;
  }
}
