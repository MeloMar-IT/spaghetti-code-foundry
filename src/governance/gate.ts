import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { readPolicyFile } from "../engine/policy-hooks.js";
import type { RunSummary } from "../engine/state.js";
import { evalsDir } from "../evals.js";
import { isRefinementRun } from "../auth/run-owner.js";
import { GONE_AFTER_MS, readFindings, type Finding } from "../monitor/findings.js";
import { SLO_DETECTORS } from "../monitor/slo-detectors.js";
import type { OutcomeFacts } from "../outcome-facts.js";
import { computeOutcomes, endOfRun, type OutcomeWindow } from "../outcomes.js";
import { MAX_REPORT_BYTES, REPORT_FILE } from "../promotion/promote.js";
import type { AutonomyLevel } from "./autonomy.js";
import type { AutonomyKind } from "./autonomy-store.js";

/**
 * The promotion gate: does a repository or a flow show enough to earn the next autonomy level? Four checks read evidence; the
 * fifth, `approval`, is a person's decision (parts 4 and 5 of the governance work) and shows as "pending". Read-only. It
 * enforces nothing and never throws: a source that cannot be read fails its check with a plain reason, it never passes one.
 * `deps` brings the server's data (runs, findings), so this file imports nothing from src/server/.
 */

export const GATE_CHECK_IDS = ["evidence_completeness", "eval_pass_rate", "policy_conformance", "operational_slos", "approval"] as const;
export type GateCheckId = (typeof GATE_CHECK_IDS)[number];
export interface GateCheck { id: GateCheckId; label: string; passed: boolean; value: number | string | null; threshold: number | string | null; detail: string }
/** `passed` comes from the four evidence checks only. `approval` never counts: read `passed`, not `checks.every`. */
export interface PromotionGate { passed: boolean; checks: GateCheck[] }

export interface GateRuns {
  runs: readonly RunSummary[];
  facts: ReadonlyMap<string, OutcomeFacts>;
  /** Runs of the window (or still open) whose run.json could not be loaded. */
  failedLoads: number;
}
export interface GateFindings {
  findings: Finding[];
  /** The findings file exists and could not be read. */
  broken: boolean;
  /** When the monitor last finished a check without an error; absent when it never did (or none runs). */
  monitorOkAt?: Date;
}
export interface EvalCover { report: string; suite: string; stamp: string; passed: number; total: number; rate: number; problem?: string }
export interface EvalCoverage { flows: ReadonlyMap<string, EvalCover>; /** More reports existed than were read. */ cut: boolean }
export type GateSettings = Config["governance"]["promotion"];
export interface GateDeps {
  settings: GateSettings;
  /** The GitHub name (owner/repo) of a stored repository. */
  repoName(id: string): string | undefined;
  runs(scope: { repo?: string; flow?: string }, window: OutcomeWindow): Promise<GateRuns>;
  evals(): Promise<EvalCoverage>;
  findings(): GateFindings;
}

export const MAX_EVAL_REPORTS = 200;
const DAY_MS = 86_400_000;
const NO_NAME = "This repository has no GitHub name, so its runs cannot be found.";
const FAILED_LOADS = "A run of the window could not be read, so the check cannot be trusted.";
const pct = (n: number): string => `${Math.round(n * 1000) / 10}%`;
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
const list = (names: readonly string[], n = 5): string => (names.length > n ? `${names.slice(0, n).join(", ")} and ${names.length - n} more` : names.join(", "));
const nap = () => new Promise<void>((r) => setImmediate(r));

const LABELS: Record<GateCheckId, string> = {
  evidence_completeness: "Evidence completeness",
  eval_pass_rate: "Eval pass rate",
  policy_conformance: "Policy conformance",
  operational_slos: "Operational SLOs",
  approval: "Approval",
};
const check = (id: GateCheckId, passed: boolean, value: GateCheck["value"], threshold: GateCheck["threshold"], detail: string): GateCheck => ({ id, label: LABELS[id], passed, value, threshold, detail });
const unknown = (id: GateCheckId, threshold: GateCheck["threshold"], detail: string): GateCheck => check(id, false, null, threshold, detail);
const unreadable = (id: GateCheckId, threshold: GateCheck["threshold"]): GateCheck => unknown(id, threshold, "The data for this check could not be read.");

/** The runs that count: not refinement, not a local test (`scf eval` runs are marked so), ended in the window or still open. */
function eligible(runs: readonly RunSummary[], window: OutcomeWindow): { ended: RunSummary[]; open: RunSummary[] } {
  const from = window.from.getTime();
  const to = window.to.getTime();
  const own = runs.filter((r) => r && typeof r === "object" && !isRefinementRun(r.source) && !r.localTest);
  const ended = own.filter((r) => endOfRun(r) >= from && endOfRun(r) < to);
  const open = own.filter((r) => !Number.isFinite(endOfRun(r)));
  return { ended, open };
}

function evidenceCheck(loaded: GateRuns, window: OutcomeWindow, s: GateSettings): GateCheck {
  const threshold = s.evidence_completeness;
  if (loaded.failedLoads > 0) return unknown("evidence_completeness", threshold, FAILED_LOADS);
  const { ended } = eligible(loaded.runs, window);
  const m = computeOutcomes(ended, loaded.facts, window).measures.find((x) => x.id === "evidence_completeness");
  const counted = m?.counted ?? 0;
  if (counted < s.min_runs) {
    return unknown("evidence_completeness", threshold, `Only ${plural(counted, "run")} with an evidence file in the last ${plural(s.within_days, "day")}; at least ${s.min_runs} are needed.`);
  }
  if (m?.value === null || m?.value === undefined) return unknown("evidence_completeness", threshold, "The share could not be worked out.");
  const passed = m.value >= threshold;
  return check("evidence_completeness", passed, m.value, threshold,
    `${pct(m.value)} of ${plural(counted, "run")} have complete evidence${passed ? "" : `; ${pct(threshold)} is needed`}.`);
}

function policyCheck(loaded: GateRuns, window: OutcomeWindow, s: GateSettings): GateCheck {
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (loaded.failedLoads > 0) return unknown("policy_conformance", "none", FAILED_LOADS);
  const { ended, open } = eligible(loaded.runs, window);
  const problems: string[] = [];
  let bad = 0;
  let unreadableRuns = 0;
  for (const r of ended) {
    const f = loaded.facts.get(r.runId);
    if (!f || !f.evidence.stream || !f.evidence.read || f.linesSkipped > 0) {
      unreadableRuns++;
      continue;
    }
    bad += f.policyBadAt.filter((t) => Date.parse(t) >= from && Date.parse(t) < to).length;
  }
  if (bad > 0) problems.push(`${plural(bad, "policy decision")} in the window denied or failed (deny, policy.unavailable or policy.invalid), also those in observe mode.`);
  if (unreadableRuns > 0) problems.push(`${plural(unreadableRuns, "run")} with no evidence that could be read in full (or that ended less than 2 minutes ago), so their policy decisions are not known.`);
  if (open.length > 0) problems.push(`${plural(open.length, "run")} not ended yet, so their policy decisions are not known.`);
  if (ended.length < s.min_runs) problems.push(`Only ${plural(ended.length, "run")} ended in the last ${plural(s.within_days, "day")}; at least ${s.min_runs} are needed.`);
  if (problems.length) return check("policy_conformance", false, bad > 0 ? bad : null, "none", problems.join(" "));
  return check("policy_conformance", true, 0, "none", `No deny, policy.unavailable or policy.invalid decision in ${plural(ended.length, "run")}.`);
}

function evalCheck(kind: AutonomyKind, id: string, loaded: GateRuns | undefined, cover: EvalCoverage | undefined, window: OutcomeWindow, s: GateSettings): GateCheck {
  const threshold = s.eval_pass_rate;
  if (!cover) return unreadable("eval_pass_rate", threshold);
  let flows: string[];
  if (kind === "flows") flows = [id];
  else {
    if (!loaded) return unreadable("eval_pass_rate", threshold);
    flows = [...new Set(eligible(loaded.runs, window).ended.map((r) => r.flow))].sort();
    if (!flows.length) return unknown("eval_pass_rate", threshold, "No run of this repository in the window, so no flow can be checked.");
  }
  const failing: string[] = [];
  const rates: number[] = [];
  let missing = 0;
  for (const flow of flows) {
    const c = cover.flows.get(flow);
    if (!c || c.problem) {
      missing++;
      failing.push(`${flow} (${c?.problem ?? "no eval report covers it"})`);
    } else {
      rates.push(c.rate);
      if (c.rate < threshold) failing.push(`${flow} (${pct(c.rate)}, report ${c.report})`);
    }
  }
  const cut = cover.cut ? " Only the newest reports were read." : "";
  if (failing.length) {
    return check("eval_pass_rate", false, missing ? null : Math.min(...rates), threshold, `${plural(failing.length, "flow")} below ${pct(threshold)} or without a usable eval report: ${list(failing)}.${cut}`);
  }
  const names = kind === "flows" ? `report ${cover.flows.get(id)!.report}` : plural(flows.length, "flow");
  return check("eval_pass_rate", true, Math.min(...rates), threshold, `Lowest pass rate ${pct(Math.min(...rates))} (${names}).`);
}

const SLO_NAMES: ReadonlySet<string> = new Set(SLO_DETECTORS.map((d) => d.name));

function sloCheck(kind: AutonomyKind, id: string, name: string | undefined, found: GateFindings | undefined, now: Date): GateCheck {
  if (!found) return unreadable("operational_slos", "none");
  if (found.broken) return unknown("operational_slos", "none", "The findings file could not be read, so open problems are not known.");
  if (!found.monitorOkAt) return unknown("operational_slos", "none", "The monitor has not finished a check, so open problems are not known. Turn on a watcher with source: monitor.");
  if (now.getTime() - found.monitorOkAt.getTime() > GONE_AFTER_MS) return unknown("operational_slos", "none", "The monitor has not finished a check in the last 24 hours, so open problems are not known.");
  const repo = name?.toLowerCase();
  const names = (f: Finding): boolean =>
    kind === "flows"
      ? !!f.evidence?.flows?.includes(id)
      : repo !== undefined && (f.repo?.toLowerCase() === repo || !!f.evidence?.repos?.some((r) => r.toLowerCase() === repo));
  const open = found.findings.filter((f) => !f.gone && SLO_NAMES.has(f.detector) && names(f));
  if (open.length) return check("operational_slos", false, open.length, "none", `${plural(open.length, "open SLO finding")}: ${list([...new Set(open.map((f) => f.detector))])}.`);
  return check("operational_slos", true, 0, "none", "No open SLO finding names this component.");
}

const APPROVAL: GateCheck = check("approval", false, "pending", "approved", "A person decides this; it does not count in the result of the gate yet.");

/**
 * The gate of one repository (`kind` "repos", `id` its stored id) or flow ("flows", its declared name) for the level above its
 * own. The checks and thresholds are the same for every level, so `toLevel` is not used yet. Never throws.
 */
export async function promotionGate(kind: AutonomyKind, id: string, _toLevel: AutonomyLevel, now: Date, deps: GateDeps): Promise<PromotionGate> {
  const s = deps.settings;
  const to = now;
  const from = new Date(to.getTime() - s.within_days * DAY_MS);
  const window: OutcomeWindow = { from, to, previousFrom: from };
  const name = kind === "repos" ? safe(() => deps.repoName(id)) : undefined;
  let checks: GateCheck[];
  if (kind === "repos" && !name) {
    checks = [
      unknown("evidence_completeness", s.evidence_completeness, NO_NAME),
      unknown("eval_pass_rate", s.eval_pass_rate, NO_NAME),
      unknown("policy_conformance", "none", NO_NAME),
      unknown("operational_slos", "none", NO_NAME),
      APPROVAL,
    ];
  } else {
    const loaded = await attempt(() => deps.runs(kind === "repos" ? { repo: name } : { flow: id }, window));
    const cover = await attempt(() => deps.evals());
    const found = safe(() => deps.findings());
    checks = [
      loaded ? evidenceCheck(loaded, window, s) : unreadable("evidence_completeness", s.evidence_completeness),
      evalCheck(kind, id, loaded, cover, window, s),
      loaded ? policyCheck(loaded, window, s) : unreadable("policy_conformance", "none"),
      sloCheck(kind, id, name, found, now),
      APPROVAL,
    ];
  }
  return { passed: checks.slice(0, 4).every((c) => c.passed), checks };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** The findings file as it is, never renamed (`loadFindings` would move a broken file), and when the monitor last finished a check. */
export function readGateFindings(monitorOkAt?: Date, file?: string): GateFindings {
  const r = readFindings(file);
  return { findings: r.findings, broken: r.broken, ...(monitorOkAt && Number.isFinite(monitorOkAt.getTime()) ? { monitorOkAt } : {}) };
}

/**
 * The newest eval report that covers each flow: a result whose `variant` is the flow or `<flow>@<model>`. Reads the reports
 * newest first (at most `max`), one file at a time, yielding between files. A report that cannot be read blocks the flows of its
 * own suite that an older report covers; it never blocks another suite. Ids only, never a path.
 */
export async function evalCoverage(dir = evalsDir(), max = MAX_EVAL_REPORTS): Promise<EvalCoverage> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { flows: new Map(), cut: false };
  }
  const files = names
    .flatMap((n) => {
      const m = REPORT_FILE.exec(n);
      return m ? [{ n, suite: m[1]!, stamp: m[2]! }] : [];
    })
    .sort((a, b) => (a.stamp === b.stamp ? (a.n < b.n ? 1 : -1) : a.stamp < b.stamp ? 1 : -1));
  const cut = files.length > max;
  const flows = new Map<string, EvalCover>();
  const broken: { suite: string; stamp: string; id: string }[] = [];
  for (const [i, f] of files.slice(0, max).entries()) {
    if (i > 0) await nap();
    const id = f.n.slice(0, -".json".length);
    const read = readPolicyFile(join(dir, f.n), MAX_REPORT_BYTES);
    let results: unknown;
    if (!("problem" in read)) {
      try {
        results = (JSON.parse(read.text) as { results?: unknown } | null)?.results;
      } catch {
        results = undefined;
      }
    }
    // one malformed result makes the whole report unusable: a partly read report would give a rate that the file does not show
    const valid = Array.isArray(results) && (results as unknown[]).every((r) => {
      const x = r as { variant?: unknown; passed?: unknown } | null;
      return !!x && typeof x === "object" && typeof x.variant === "string" && typeof x.passed === "boolean";
    });
    if (!valid) {
      broken.push({ suite: f.suite, stamp: f.stamp, id });
      continue;
    }
    const tally = new Map<string, { passed: number; total: number }>();
    for (const r of results as { variant: string; passed: boolean }[]) {
      for (const key of new Set([r.variant, r.variant.split("@")[0]!])) {
        const t = tally.get(key) ?? { passed: 0, total: 0 };
        t.total++;
        if (r.passed) t.passed++;
        tally.set(key, t);
      }
    }
    for (const [flow, t] of tally) {
      if (!flows.has(flow)) flows.set(flow, { report: id, suite: f.suite, stamp: f.stamp, passed: t.passed, total: t.total, rate: t.passed / t.total });
    }
  }
  for (const [flow, c] of flows) {
    const newer = broken.find((b) => b.suite === c.suite && b.stamp > c.stamp);
    if (newer) flows.set(flow, { ...c, problem: `a newer report of the same suite (${newer.id}) could not be read` });
  }
  return { flows, cut };
}
