import { githubKey } from "../auth/repo-url.js";
import type { WatcherConfig } from "../config.js";
import { DEFAULT_FLOWS } from "../queue/watcher.js";

export interface BuildLimits {
  flow?: string;
  maxFiles?: number;
  maxCodeLines?: number;
  reviewLabel?: string;
}
export type LoadFlowVars = (flow: string) => Record<string, string> | undefined;

const NUMBER = /^\d{1,9}$/;

/** The enabled watchers of a GitHub repository, in order: the stored watchers of `ownerId`, then config.yaml watchers, then any other. */
function candidatesOf(githubRepo: string, watchers: WatcherConfig[], ownerId?: string): WatcherConfig[] {
  const key = githubKey(githubRepo);
  const rank = (w: WatcherConfig) => (ownerId !== undefined && w.ownerId === ownerId ? 0 : w.repoId === undefined ? 1 : 2);
  return watchers
    .filter((w) => w.enabled && w.github_repo !== "" && githubKey(w.github_repo) === key)
    .map((w, i) => ({ w, i }))
    .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
    .map((x) => x.w);
}

/** The build label of a repository: the label of its first enabled `issues` watcher (same order as the build limits); undefined when there is none. */
export function buildLabelOf(githubRepo: string, watchers: WatcherConfig[], ownerId?: string): string | undefined {
  return candidatesOf(githubRepo, watchers, ownerId).find((w) => w.source === "issues")?.label;
}

/**
 * The build limits and the review label of a GitHub repository: from the first enabled watcher of it whose flow has both limits (the
 * watcher's vars win over the flow's). Order: the stored watchers of `ownerId`, then config.yaml watchers, then any other. When no watcher
 * has both limits, the first one whose flow loads gives the flow and the label only.
 */
export function buildLimitsOf(githubRepo: string, watchers: WatcherConfig[], loadFlowVars: LoadFlowVars, ownerId?: string): BuildLimits {
  const candidates = candidatesOf(githubRepo, watchers, ownerId);
  const loaded = new Map<string, Record<string, string> | undefined>();
  let fallback: BuildLimits | undefined;
  for (const w of candidates) {
    const flow = w.flow === "default" ? DEFAULT_FLOWS[w.source] : w.flow;
    if (!flow) continue;
    if (!loaded.has(flow)) loaded.set(flow, loadFlowVars(flow));
    const flowVars = loaded.get(flow);
    if (!flowVars) continue;
    const vars: Record<string, string> = { ...flowVars, ...w.vars };
    const label = vars.review_plan_label?.trim();
    const reviewLabel = label ? { reviewLabel: label } : {};
    const own = (k: string) => Object.hasOwn(flowVars, k);
    if (own("max_files") && own("max_code_lines") && NUMBER.test(vars.max_files ?? "") && NUMBER.test(vars.max_code_lines ?? "")) {
      return { flow, maxFiles: Number(vars.max_files), maxCodeLines: Number(vars.max_code_lines), ...reviewLabel };
    }
    fallback ??= { flow, ...reviewLabel };
  }
  return fallback ?? {};
}
