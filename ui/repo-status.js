// The health of a repository row on My repositories: pure functions, no DOM, no imports.

export const FILTER_FROM = 8;
export const COMPACT_KEY = "scf.repos.compact";

const str = (v) => (typeof v === "string" ? v.trim() : "");

/** "owner/name" when `github` is a non-empty string, else the address ("" when neither). */
export const repoName = (repo) => str(repo?.github) || str(repo?.url);

/** The one attention state of a repository and its next action. The first rule that fits wins. */
export function repoAttention(repo, { admin = false, options } = {}) {
  if (repo?.method === "none" && !admin) return { level: "bad", text: "Needs authentication", action: "auth" };
  if (repo?.method === "github-app" && options && options.githubApp?.available !== true) {
    return { level: "bad", text: "GitHub App removed", action: "auth" };
  }
  const c = repo?.connection;
  if (c && !c.ok) {
    const first = (Array.isArray(c.checks) ? c.checks : []).find((x) => x && x.ok === false);
    const out = { level: "bad", text: "Last test failed", action: first?.code === "app-not-installed" ? "install" : "test" };
    if (typeof first?.message === "string") out.detail = first.message;
    return out;
  }
  if (!c) return { level: "warn", text: "Never tested", action: "test" };
  return { level: "ok", text: "Nothing to do", action: null };
}

const RANK = { bad: 0, warn: 1, ok: 2 };

/** A new array: bad, then warn, then ok; the given order is kept inside a level. */
export function sortByAttention(repos, ctx = {}) {
  return repos
    .map((r, i) => ({ r, i, k: RANK[repoAttention(r, ctx).level] }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}

/** How many repositories have a level other than "ok". */
export const attentionCount = (repos, ctx = {}) => repos.filter((r) => repoAttention(r, ctx).level !== "ok").length;

export const attentionSummary = (count) =>
  count === 0 ? "No repository needs attention." : count === 1 ? "1 repository needs attention." : `${count} repositories need attention.`;

/** Runs with status "running" or "waiting" whose vars.github_repo is repo.github, case ignored. */
export function activeRuns(runs, repo) {
  const name = str(repo?.github).toLowerCase();
  if (!name || !Array.isArray(runs)) return 0;
  return runs.filter((r) =>
    (r?.status === "running" || r?.status === "waiting") && typeof r.vars?.github_repo === "string" && r.vars.github_repo.trim().toLowerCase() === name).length;
}

/** True when the trimmed, lower-cased text is in the address or in the name; true for empty text. */
export function matchesText(repo, text) {
  const t = str(text).toLowerCase();
  if (!t) return true;
  return str(repo?.url).toLowerCase().includes(t) || repoName(repo).toLowerCase().includes(t);
}

/** The compact choice: "1" is on. Never throws. */
export function readCompact(store) {
  try {
    return store?.getItem(COMPACT_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCompact(store, on) {
  try {
    store?.setItem(COMPACT_KEY, on ? "1" : "0");
  } catch {
    // no storage: the choice lasts for this page only
  }
}
