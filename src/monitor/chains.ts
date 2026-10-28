import type { WatcherConfig } from "../config.js";
import { effectiveVars } from "../engine/runner.js";
import { loadFlow } from "../flow/load.js";
import { readIssueList, type IssueRecord, type RepoIssueList } from "../queue/issue-list.js";
import { DEFAULT_FLOWS, labelNames, parseInterval, type WatcherStatus } from "../queue/watcher.js";
import { storyKey } from "./breaker.js";
import type { IssueListInput } from "./detectors.js";
import type { RunState } from "./unlisted.js";

export type DeadReason = "no-label" | "not-planned" | "parked";
/** An issue that will never be built, and the stories that wait for it. Each chain runs from a waiting story to `issue`, both included. */
export interface DeadEnd { issue: number; reason: DeadReason; chains: number[][] }

/** Does the watcher's flow merge into a develop branch (its gitflow)? False when the flow cannot be read. */
function gitflowOf(cfg: WatcherConfig, repo: string): boolean {
  try {
    const name = cfg.flow === "default" ? DEFAULT_FLOWS[cfg.source as keyof typeof DEFAULT_FLOWS] : cfg.flow;
    if (!name) return false;
    const flow = loadFlow(name, repo).flow;
    return !!(effectiveVars(flow, repo, cfg.vars).develop_branch ?? "").trim();
  } catch {
    return false;
  }
}

/**
 * The saved issue lists of the repositories that eligible issue watchers check, one per repository (names compared without
 * case; `repo` is lower case, so the fingerprints do not depend on the order of the watchers). Missing, stale or cut lists
 * are left out. A dependency counts as done when any of the watchers would count it done (the same rule as `dependencyDone`).
 * Never throws.
 */
export function chainLists(o: {
  watchers: readonly { cfg: WatcherConfig; status: WatcherStatus }[];
  runState: (repo: string, issue: number) => RunState;
  /** Issues of the monitor's own bug stories (storyKey form), current and earlier: never a waiting story. */
  stories?: ReadonlySet<string>;
  read?: (repo: string) => RepoIssueList | undefined;
  /** Does this watcher run a gitflow (default: read its flow). */
  gitflow?: (cfg: WatcherConfig, repo: string) => boolean;
}): IssueListInput[] {
  try {
    const read = o.read ?? readIssueList;
    const groups = new Map<string, { names: Set<string>; cfgs: WatcherConfig[]; statuses: WatcherStatus[] }>();
    for (const { cfg, status } of o.watchers) {
      if (cfg.source !== "issues" || !cfg.enabled || !cfg.github_repo || !status.lastOk || status.lastError) continue;
      const k = cfg.github_repo.toLowerCase();
      const g = groups.get(k) ?? { names: new Set(), cfgs: [], statuses: [] };
      g.names.add(cfg.github_repo);
      g.cfgs.push(cfg);
      g.statuses.push(status);
      groups.set(k, g);
    }
    const out: IssueListInput[] = [];
    for (const [repo, g] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      try {
        const everys = g.cfgs.map((c) => parseInterval(c.every));
        // The newest list that every watcher of the repository's newest good check saved; the spelling decides a tie.
        let list: RepoIssueList | undefined;
        for (const name of [...g.names].sort()) {
          let l: RepoIssueList | undefined;
          try { l = read(name); } catch { l = undefined; }
          if (!l || l.cut) continue;
          if (g.statuses.some((s, i) => Date.parse(s.lastOk!) - Date.parse(l!.readAt) > everys[i]!)) continue;
          if (!list || Date.parse(l.readAt) > Date.parse(list.readAt)) list = l;
        }
        if (!list) continue;
        const labels = [...new Set(g.cfgs.map((c) => c.label))];
        // The completion rules of each watcher: its dependency_done_labels, and (on a gitflow) its done label.
        const done = new Set<string>();
        for (const c of g.cfgs) {
          for (const l of c.dependency_done_labels) done.add(l);
          if ((o.gitflow ?? gitflowOf)(c, list.repo)) done.add(labelNames(c).done);
        }
        const open = list.issues.filter((r) => r.state === "open");
        const wanted = new Set(open.flatMap((r) => (Array.isArray(r.dependsOn) ? r.dependsOn : [])));
        const parked: number[] = [];
        for (const r of open) {
          if (!wanted.has(r.number) || !r.labels.some((l) => labels.includes(l))) continue;
          let s: RunState;
          try { s = o.runState(list.repo, r.number); } catch { s = "unknown"; }
          if (s === "parked") parked.push(r.number);
        }
        const skip = list.issues.filter((r) => o.stories?.has(storyKey(list!.repo, r.number))).map((r) => r.number);
        out.push({
          repo, watchers: g.cfgs.map((c) => c.id).sort(), labels, done: [...done].sort(), cut: false, issues: list.issues,
          parked: parked.sort((a, b) => a - b), skip: skip.sort((a, b) => a - b),
        });
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** The issues at the start of a chain that can never be built, sorted by number; the chains are sorted by story number. Cut lists give []. */
export function deadChains(list: IssueListInput): DeadEnd[] {
  if (list.cut) return [];
  const byNumber = new Map<number, IssueRecord>();
  for (const r of list.issues) byNumber.set(r.number, r);
  const parked = new Set(list.parked);
  const skip = new Set(list.skip ?? []);
  const triggered = (r: IssueRecord) => r.labels.some((l) => list.labels.includes(l));
  // An open issue with a completion label is done, like a closed one: the walk does not judge or follow it.
  const finished = (r: IssueRecord) => r.state === "closed" || r.labels.some((l) => (list.done ?? []).includes(l));
  const ends = new Map<number, DeadEnd>();
  for (const root of list.issues) {
    if (root.state !== "open" || !triggered(root) || finished(root) || skip.has(root.number)) continue;
    const prev = new Map<number, number>();
    const seen = new Set<number>([root.number]);
    const queue = [root.number];
    for (let i = 0; i < queue.length; i++) {
      const from = queue[i]!;
      const deps = byNumber.get(from)?.dependsOn;
      for (const d of Array.isArray(deps) ? deps : []) {
        if (seen.has(d)) continue;
        seen.add(d);
        const r = byNumber.get(d);
        if (!r) continue; // not in the list: not judged
        prev.set(d, from);
        let reason: DeadReason | undefined;
        if (r.state === "closed") {
          if (r.stateReason !== "not_planned") continue; // done
          reason = "not-planned";
        } else if (finished(r)) continue; // done by a completion label
        else if (!triggered(r)) reason = "no-label";
        else if (parked.has(d)) reason = "parked";
        if (!reason) {
          queue.push(d);
          continue;
        }
        const chain = [d];
        for (let n = prev.get(d); n !== undefined; n = prev.get(n)) chain.unshift(n);
        const end = ends.get(d) ?? { issue: d, reason, chains: [] };
        end.chains.push(chain);
        ends.set(d, end);
      }
    }
  }
  return [...ends.values()]
    .map((e) => ({ ...e, chains: e.chains.sort((a, b) => a[0]! - b[0]!) }))
    .sort((a, b) => a.issue - b.issue);
}
