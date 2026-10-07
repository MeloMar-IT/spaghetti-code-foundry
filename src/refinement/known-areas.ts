import { githubKey } from "../auth/repo-url.js";
import type { RunBrief, RunSummary } from "../engine/state.js";
import type { ArchitectScheduler } from "./architect.js";
import type { Draft } from "./draft.js";
import { normArea, safeAreas } from "./draft-impact.js";
import type { KnownDraft, KnownIssue } from "./impact-text.js";
import { listSessions, type Session } from "./store.js";

export const KNOWN_ISSUES_MAX = 50;

// A run in one of these states is building the story now (or will, when its job starts).
const BUILDING = new Set(["running", "stopped", "waiting"]);

// The `ignorable` rule of tools/area-lock: the lock skips documentation and whole test folders, so the plans' areas leave them out too.
const ignorable = (a: string): boolean => /\.md$/i.test(a) || /(^|\/)docs$/.test(a) || /(^|\/)(tests?|__tests__|specs?)$/.test(a);

/** The AREAS: of a run's plan, read as the claim_areas step reads it: the revise_plan output when it has an AREAS: line, else the plan. */
export function planAreas(run: Pick<RunSummary, "history">): string[] {
  const last = (id: string) => run.history.filter((h) => h.id === id).at(-1)?.output;
  const has = (t: string | undefined): t is string => t !== undefined && /^AREAS:/m.test(t);
  const revised = last("revise_plan");
  const plan = has(revised) ? revised : last("plan");
  if (plan === undefined) return [];
  const line = plan.split("\n").filter((l) => /^AREAS:/.test(l)).at(-1);
  if (line === undefined) return [];
  const raw = line.replace(/^AREAS: */, "").replace(/`/g, "").split(/[,\s]+/).map(normArea).filter((a) => a && !a.startsWith("@") && !ignorable(a));
  return safeAreas(raw);
}

/** The drafts of the owner's other sessions on the same repository (dropped sessions do not count). */
export function otherDrafts(s: Session): Draft[] {
  const key = githubKey(s.repo);
  return listSessions(s.owner).flatMap((o) => (o.id !== s.id && o.state !== "dropped" && githubKey(o.repo) === key ? o.drafts : []));
}

/**
 * What the Foundry knows about the code areas of other work on the repository of a session: for issues, the areas of the newest run of
 * each (at most 50 issues; runs of all accounts; only the number and the paths are used), and for drafts of the owner's other
 * sessions, the areas of their stored view. Never throws: a run that cannot be read is skipped.
 */
export function knownAreas(scheduler: Pick<ArchitectScheduler, "briefs" | "get" | "queue">, s: Session): { issues: KnownIssue[]; drafts: KnownDraft[] } {
  const key = githubKey(s.repo);
  const mine = (repo: string | undefined, issue: string | undefined): issue is string => repo !== undefined && issue !== undefined && /^\d+$/.test(issue) && githubKey(repo) === key;
  const newest = new Map<string, RunBrief>();
  const queued = new Set<string>();
  let briefs: RunBrief[] = [];
  try {
    briefs = [...scheduler.briefs()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const p of scheduler.queue().pending) if (p.kind === "run" && mine(p.githubRepo, p.issue)) queued.add(String(Number(p.issue)));
  } catch {
    // Whatever was read stays.
  }
  for (const b of briefs) {
    if (!mine(b.githubRepo, b.issue)) continue;
    const n = String(Number(b.issue));
    if (!newest.has(n)) newest.set(n, b);
  }
  const candidates = [...new Set([...newest.keys(), ...queued])].map((n) => ({ n, brief: newest.get(n), active: queued.has(n) || BUILDING.has(newest.get(n)?.status ?? "") }));
  candidates.sort((a, b) => Number(b.active) - Number(a.active) || (b.brief?.startedAt ?? "9").localeCompare(a.brief?.startedAt ?? "9"));
  const issues: KnownIssue[] = [];
  for (const c of candidates.slice(0, KNOWN_ISSUES_MAX)) {
    let areas: string[] = [];
    try {
      const run = c.brief ? scheduler.get(c.brief.dirName) ?? scheduler.get(c.brief.runId) : undefined;
      if (run) areas = planAreas(run);
    } catch {
      // Skipped; an issue that is being built stays in the list without areas.
    }
    if (areas.length || c.active) issues.push({ issue: Number(c.n), areas, active: c.active });
  }
  const drafts: KnownDraft[] = otherDrafts(s).flatMap((d) => {
    const areas = d.impact ? safeAreas(d.impact.areas.map((a) => a.area)) : [];
    return areas.length ? [{ id: d.id, title: d.title?.text ?? "", areas }] : [];
  });
  return { issues, drafts };
}
