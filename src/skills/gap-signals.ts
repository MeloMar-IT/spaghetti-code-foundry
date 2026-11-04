import type { RunSummary, StepRecord } from "../engine/state.js";
import { skillCoversTechnology } from "./catalogue.js";
import type { RegisteredSkill } from "./registry.js";
import { SKILL_ID_RE } from "./schema.js";

// Skill gap signals (#776): what in the runs and the monitor's findings says that a skill is missing. Pure: no file system,
// no clock, no GitHub. Only validated tokens leave this module (skill ids, run ids, kinds from the tables, versions, repository names).

export const GAP_KINDS = ["unknown", "technology", "review", "failure"] as const;
export type GapKind = (typeof GAP_KINDS)[number];

const DAY = 86_400_000;
export const GAP_WINDOWS = { unknownDays: 30, technologyDays: 30, reviewDays: 14, failureDays: 14 } as const;
export const GAP_THRESHOLDS = { reviewRuns: 3, failureRuns: 3, fixVisits: 3 } as const;
export const GAP_LIMITS = { runs: 10, kinds: 5 } as const;

/** Review finding kinds, from fixed keywords. The first match wins. */
export const REVIEW_KINDS: readonly (readonly [string, RegExp])[] = [
  // A stem matches its word forms (security, vulnerability, validation); only the start of a word is required.
  ["security", /\b(?:secur|injection|xss|csrf|vulnerab|credential|secret|sanitiz)/i],
  ["error-handling", /\b(?:error handling|unhandled|uncaught|rejection|exception|swallow|catch)/i],
  ["test-coverage", /\b(?:test coverage|untested|missing tests?|no tests?|not tested)\b/i],
  ["concurrency", /\b(?:race condition|concurren|deadlock|thread|atomic|parallel)/i],
  ["input-validation", /\b(?:validat|untrusted input|user input|bounds|malformed)/i],
  ["resource-cleanup", /\b(?:leak|not closed|cleanup|clean up|dispose|never closed|file handle)/i],
  ["compatibility", /\b(?:compatib|breaking change|backward|deprecated|regression)/i],
];

/** Step id keyword → repair kind. */
const REPAIR_KINDS: readonly (readonly [string, string])[] = [["test", "testing"], ["build", "build"], ["review", "review"]];

export interface GapEvidence {
  runs: string[];
  findingKinds: string[];
  technology?: { name: string; version?: string };
}
export interface GapSignal {
  topic: string;
  kind: GapKind;
  repo: string;
  evidence: GapEvidence;
  /** The newest evidence time (ms). */
  at: number;
}
/** The few fields of a monitor finding the failure signal reads. */
export interface GapFinding { detector: string; about: "foundry" | "project"; repo?: string; gone: boolean }
export interface GapInput {
  now: number;
  runs: readonly RunSummary[];
  findings: readonly GapFinding[];
  skills: readonly (Pick<RegisteredSkill, "id" | "active" | "pkg"> & { trust?: string })[];
}

const REPO_RE = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9_.-]{1,100}$/;
const RUN_ID_RE = /^[\w-]{1,80}$/;
const VERSION_RE = /^\d[0-9A-Za-z.+-]{0,30}$/;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const bare = (id: string) => id.slice(id.lastIndexOf("/") + 1);
/** A review step: its id has "review" and is not a fix or change step. */
const isReview = (id: string) => /review/.test(bare(id)) && !/^(address|revise|fix)_/.test(bare(id));

const repoOf = (r: RunSummary): string | undefined => {
  const v = r.vars?.github_repo?.trim().toLowerCase();
  return v && REPO_RE.test(v) ? v : undefined;
};
export const timeOf = (r: RunSummary): number => {
  const t = Date.parse(r.finishedAt ?? r.startedAt);
  return Number.isNaN(t) ? 0 : t;
};
export const within = (r: RunSummary, now: number, days: number) => {
  const t = timeOf(r);
  return t > 0 && now - t <= days * DAY && t <= now + DAY;
};
export const history = (r: RunSummary): StepRecord[] => (Array.isArray(r.history) ? r.history : []);

type Tech = { name: string; confidence: string; version?: string };
/** The technologies of the newest step record that has them. */
function techsOf(r: RunSummary): Tech[] {
  const h = history(r);
  for (let i = h.length - 1; i >= 0; i--) {
    const t = h[i]!.skillCatalogue?.technologies;
    if (Array.isArray(t) && t.length) return t;
  }
  return [];
}

/** The first technology of the newest run of a repository that recorded one. */
export function repoTechnology(runs: readonly RunSummary[], repo: string): { name: string; version?: string } | undefined {
  const mine = runs.filter((r) => repoOf(r) === repo).sort((a, b) => timeOf(b) - timeOf(a));
  for (const r of mine) {
    const t = techsOf(r).find((x) => SKILL_ID_RE.test(x.name));
    if (t) return { name: t.name, ...(t.version && VERSION_RE.test(t.version) ? { version: t.version } : {}) };
  }
  return undefined;
}

/** The kind of a review line that starts with [high] or [medium]; undefined for other lines. */
export function reviewKindOf(line: string): string | undefined {
  if (!/^\s*(?:[-*]\s*|\d+[.)]\s*)?(?:\*\*)?\[(high|medium)\]/i.test(line)) return undefined;
  return REVIEW_KINDS.find(([, re]) => re.test(line))?.[0];
}

/** The review finding kinds a run's review steps raised. */
export function reviewKindsOfRun(r: RunSummary): Set<string> {
  const kinds = new Set<string>();
  for (const h of history(r)) {
    if (!isReview(h.id)) continue;
    for (const line of String(h.output ?? "").split("\n")) {
      const k = reviewKindOf(line);
      if (k) kinds.add(k);
    }
  }
  return kinds;
}

export const runIds = (runs: Iterable<RunSummary>): string[] =>
  [...new Set([...runs].map((r) => r.runId).filter((id) => RUN_ID_RE.test(id)))].sort(cmp).slice(0, GAP_LIMITS.runs);

function make(topic: string, kind: GapKind, repo: string, runs: RunSummary[], extra: Partial<GapEvidence> = {}): GapSignal {
  return {
    topic, kind, repo, at: Math.max(0, ...runs.map(timeOf)),
    evidence: { runs: runIds(runs), findingKinds: [], ...extra },
  };
}

/** Signal 1: a run asked for a skill that does not exist. */
export function unknownSkillGaps(i: GapInput): GapSignal[] {
  const by = new Map<string, { repo: string; runs: RunSummary[] }>();
  for (const r of i.runs) {
    const repo = repoOf(r);
    if (!repo || !within(r, i.now, GAP_WINDOWS.unknownDays)) continue;
    for (const u of r.skillPlan?.unresolved ?? []) {
      if (u.code !== "unknown") continue;
      // installed since the run: the run resumes by itself, so no issue is asked for it
      if (i.skills.some((s) => s.active && s.id === u.id)) continue;
      const key = `${u.id}|${repo}`;
      const g = by.get(key) ?? { repo, runs: [] };
      g.runs.push(r);
      by.set(key, g);
    }
  }
  return [...by].map(([key, g]) => make(key.slice(0, key.indexOf("|")), "unknown", g.repo, g.runs));
}

/** Signal 2: a recorded technology that no current skill covers. Coverage is read from the registry now. */
export function uncoveredTechnologyGaps(i: GapInput): GapSignal[] {
  const by = new Map<string, { repo: string; runs: RunSummary[]; version?: string }>();
  for (const r of i.runs) {
    const repo = repoOf(r);
    if (!repo || !within(r, i.now, GAP_WINDOWS.technologyDays)) continue;
    for (const t of techsOf(r)) {
      if ((t.confidence !== "high" && t.confidence !== "medium") || !SKILL_ID_RE.test(t.name) || skillCoversTechnology(i.skills, t.name)) continue;
      const key = `${t.name}|${repo}`;
      const g = by.get(key) ?? { repo, runs: [] };
      g.runs.push(r);
      if (t.version && VERSION_RE.test(t.version)) g.version ??= t.version;
      by.set(key, g);
    }
  }
  return [...by].map(([key, g]) => {
    const name = key.slice(0, key.indexOf("|"));
    return make(name, "technology", g.repo, g.runs, { technology: { name, ...(g.version ? { version: g.version } : {}) } });
  });
}

/** Signal 3: the same review finding kind in at least 3 runs of one repository. */
export function reviewRepeatGaps(i: GapInput): GapSignal[] {
  const by = new Map<string, Map<string, RunSummary[]>>();
  for (const r of i.runs) {
    const repo = repoOf(r);
    if (!repo || !within(r, i.now, GAP_WINDOWS.reviewDays)) continue;
    const kinds = reviewKindsOfRun(r);
    for (const k of kinds) {
      const m = by.get(repo) ?? new Map<string, RunSummary[]>();
      m.set(k, [...(m.get(k) ?? []), r]);
      by.set(repo, m);
    }
  }
  const out: GapSignal[] = [];
  for (const [repo, kinds] of by) {
    const tech = repoTechnology(i.runs, repo);
    for (const [k, runs] of kinds) {
      if (runs.length < GAP_THRESHOLDS.reviewRuns) continue;
      out.push(make(tech ? `${tech.name}-${k}` : k, "review", repo, runs, { findingKinds: [k], ...(tech ? { technology: tech } : {}) }));
    }
  }
  return out;
}

/** The repair kind of a step id, from the fixed table. */
export function repairKindOf(step: string, reviewKind?: string): string {
  const id = bare(step).toLowerCase();
  for (const [word, kind] of REPAIR_KINDS) if (id.includes(word)) return kind === "review" ? reviewKind ?? "review" : kind;
  return "repair";
}

/** Signal 4: runs that failed at a test step or went through one fix step 3 or more times. */
export function repeatFailureGaps(i: GapInput): GapSignal[] {
  const by = new Map<string, { runs: RunSummary[]; steps: string[]; single: boolean }>();
  for (const r of i.runs) {
    const repo = repoOf(r);
    if (!repo || !within(r, i.now, GAP_WINDOWS.failureDays)) continue;
    let step: string | undefined;
    let single = false;
    const bad = history(r).filter((h) => h.ok === false && /test/i.test(bare(h.id))).pop();
    if (r.status === "failed" && bad) step = bad.id;
    const visits = new Map<string, number>();
    for (const h of history(r)) if (/^fix_/.test(bare(h.id))) visits.set(h.id, (visits.get(h.id) ?? 0) + 1);
    const worst = [...visits].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0];
    if (worst && worst[1] >= GAP_THRESHOLDS.fixVisits) {
      single = true;
      step ??= worst[0];
    }
    if (!step) continue;
    const g = by.get(repo) ?? { runs: [], steps: [], single: false };
    g.runs.push(r);
    g.steps.push(step);
    g.single ||= single;
    by.set(repo, g);
  }
  const out: GapSignal[] = [];
  for (const [repo, g] of by) {
    const open = i.findings.some((f) => f.about === "project" && !f.gone && f.repo?.toLowerCase() === repo && (f.detector === "same-step-failing" || f.detector === "develop-red"));
    if (!(g.runs.length >= GAP_THRESHOLDS.failureRuns || g.single || open)) continue;
    const tech = repoTechnology(i.runs, repo);
    if (!tech) continue;
    const counts = new Map<string, number>();
    for (const s of g.steps) counts.set(s, (counts.get(s) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))[0]![0];
    const kind = repairKindOf(top);
    out.push(make(`${tech.name}-${kind}`, "failure", repo, g.runs, { findingKinds: [kind], technology: tech }));
  }
  return out;
}

/** All four signals, merged by topic. A topic keeps the evidence of the one repository with the most runs. */
export function gapSignals(i: GapInput): GapSignal[] {
  const all = [...unknownSkillGaps(i), ...uncoveredTechnologyGaps(i), ...reviewRepeatGaps(i), ...repeatFailureGaps(i)]
    .filter((s) => SKILL_ID_RE.test(s.topic) && s.evidence.runs.length > 0 && REPO_RE.test(s.repo));
  const best = new Map<string, GapSignal>();
  for (const s of all) {
    const old = best.get(s.topic);
    if (!old) best.set(s.topic, s);
    else if (s.evidence.runs.length > old.evidence.runs.length || (s.evidence.runs.length === old.evidence.runs.length && s.at > old.at)) best.set(s.topic, s);
  }
  return [...best.values()].sort((a, b) => b.at - a.at || cmp(a.topic, b.topic));
}
