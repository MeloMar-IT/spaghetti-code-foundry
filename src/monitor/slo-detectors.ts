import { cleanLine } from "../errors.js";
import { HOUR, latest, plural, type Detector, type DetectorInput } from "./detectors.js";
import type { FindingInput } from "./findings.js";
import { SETTLE_MS, type StepVisit } from "./slo-input.js";

// Detectors of the service levels: each says who owns the finding, the limit, the window and the next step.
// Plain data in (from run.json and the evidence files, built in slo-input.ts), findings out. They never read telemetry.
// Each observation is judged by its own time (a decision, the end of a step visit); only evidence-finalization judges ended runs.

const MIN = 60_000;

/** Nearest-rank 95th percentile. */
export function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
}

/** The middle value; the mean of the two middle values for an even count. */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

const inWindow = (at: number, now: Date, hours: number) => Number.isFinite(at) && at >= now.getTime() - hours * HOUR && at <= now.getTime();
const hours = (n: number) => `last ${plural(n, "hour")}`;
const minutesOf = (ms: number) => Math.round((ms / MIN) * 10) / 10;

const policyServiceFailure: Detector = {
  name: "policy-service-failure",
  description: "Policy decisions said the policy was unavailable or invalid. Runs go on without the checks that policy should make.",
  slo: {
    owner: "admin",
    threshold: (c) => `at least ${plural(c.policy_service_failure.decisions, "decision")} with policy.unavailable or policy.invalid`,
    window: (c) => hours(c.policy_service_failure.within_hours),
    action: "Repair the policy packs in policy.packs so each one can be read and is valid, then check that new policy decisions no longer report policy.unavailable or policy.invalid.",
  },
  run({ now, config, measures }) {
    const { decisions, within_hours } = config.policy_service_failure;
    const hits = (measures ?? []).map((m) => ({ m, times: m.policyFailures.filter((t) => inWindow(t, now, within_hours)) })).filter((x) => x.times.length);
    const total = hits.reduce((n, x) => n + x.times.length, 0);
    if (total < decisions) return [];
    const flows = [...new Set(hits.map((x) => x.m.flow))].sort();
    const repos = [...new Set(hits.flatMap((x) => (x.m.repo ? [x.m.repo] : [])))].sort();
    return [{
      detector: "policy-service-failure",
      fingerprint: "policy-service-failure",
      severity: "major",
      summary: `${plural(total, "policy decision")} in ${plural(hits.length, "run")} said the policy was unavailable or invalid in the last ${plural(within_hours, "hour")}.`,
      evidence: { counts: { decisions: total, runs: hits.length }, times: latest(hits.flatMap((x) => x.times)), flows, ...(repos.length ? { repos } : {}) },
      about: "foundry",
    }];
  },
};

const evidenceFinalization: Detector = {
  name: "evidence-finalization",
  description: "A run ended but its evidence was never finalized, or its evidence stream stopped. The run cannot be verified later.",
  slo: {
    owner: "admin",
    threshold: (c) => `${plural(c.evidence_finalization.runs, "run")} ended over 2 minutes ago without evidence.json, or with an incomplete stream`,
    window: (c) => hours(c.evidence_finalization.within_hours),
    action: "Read the run's live log for the line that says why no manifest was written, fix the cause, and check the run with `scf evidence verify <run-id>`.",
  },
  run({ now, config, evidence }) {
    const { runs, within_hours } = config.evidence_finalization;
    const bad = (evidence ?? []).filter((e) => {
      const ended = Date.parse(e.finishedAt);
      if (!inWindow(ended, now, within_hours) || now.getTime() - ended <= SETTLE_MS) return false;
      return e.incomplete || (e.stream && !e.manifest);
    });
    if (bad.length < runs) return [];
    const incomplete = bad.filter((e) => e.incomplete).length;
    const flows = [...new Set(bad.map((e) => e.flow))].sort();
    return [{
      detector: "evidence-finalization",
      fingerprint: "evidence-finalization",
      severity: "major",
      summary: `${plural(bad.length, "run")} ended without final evidence in the last ${plural(within_hours, "hour")}.`,
      evidence: { counts: { runs: bad.length, incomplete, no_manifest: bad.length - incomplete }, times: latest(bad.map((e) => Date.parse(e.finishedAt))), flows },
      about: "foundry",
    }];
  },
};

type Group = { flow: string; step: string; repo: string; visits: StepVisit[] };

function groupVisits(input: DetectorInput, hours: number, keep: (v: StepVisit) => boolean, byRepo: boolean): Map<string, Group> {
  const groups = new Map<string, Group>();
  for (const m of input.measures ?? []) {
    for (const v of m.visits) {
      if (!inWindow(v.at, input.now, hours) || !keep(v)) continue;
      const repo = byRepo ? (v.repo ?? "") : "";
      const key = `${repo}|${v.flow}|${v.step}`;
      const g = groups.get(key) ?? { flow: v.flow, step: v.step, repo, visits: [] };
      g.visits.push(v);
      groups.set(key, g);
    }
  }
  return groups;
}

const stepLatencyP95: Detector = {
  name: "step-latency-p95",
  description: "The slowest usual visits of a step take longer than the limit. Something may be slow, such as a tool, a model or the machine.",
  slo: {
    owner: "admin",
    threshold: (c) => `p95 above ${c.step_latency_p95.minutes} minutes, from at least ${plural(c.step_latency_p95.min_visits, "visit")}`,
    window: (c) => hours(c.step_latency_p95.within_hours),
    action: "Look at the slowest visits of the step, then speed up its tool, model or machine, or give it a longer timeout.",
  },
  run(input) {
    const { minutes, min_visits, within_hours } = input.config.step_latency_p95;
    // An approval step is a person's wait and a flow step holds other steps: neither measures a step's speed.
    const groups = groupVisits(input, within_hours, (v) => v.type !== "approval" && v.type !== "flow" && v.durationMs !== undefined, true);
    const out: FindingInput[] = [];
    for (const [key, g] of groups) {
      const times = g.visits.map((v) => v.durationMs!);
      if (times.length < min_visits) continue;
      const p = p95(times);
      if (p <= minutes * MIN) continue;
      out.push({
        detector: "step-latency-p95",
        fingerprint: `step-latency-p95|${key}`,
        severity: "minor",
        summary: `Step ${g.step} of flow ${g.flow} has a p95 of ${minutesOf(p)} minutes over ${plural(times.length, "visit")}, above ${minutes}.`,
        evidence: { counts: { visits: times.length, p95_minutes: Math.round(p / MIN), slowest_minutes: Math.round(Math.max(...times) / MIN) }, times: latest(g.visits.map((v) => v.at)), steps: [g.step], flows: [g.flow], ...(g.repo ? { repos: [g.repo] } : {}) },
        about: "foundry",
        ...(g.repo ? { repo: g.repo } : {}),
      });
    }
    return out;
  },
};

const repeatedToolDenial: Detector = {
  name: "repeated-tool-denial",
  description: "The agent was refused the same tool again and again in one repository. Its steps may lack a tool they need, or ask for one they should not use.",
  slo: {
    owner: "repository owner",
    threshold: (c) => `the same tool refused ${plural(c.repeated_tool_denial.times, "time")} in one repository`,
    window: (c) => hours(c.repeated_tool_denial.within_hours),
    action: "Add the tool to `allowed_tools` of the step or the flow's defaults if the step needs it; otherwise change the prompt so the agent does not ask for it.",
  },
  run({ now, config, measures }) {
    const { times, within_hours } = config.repeated_tool_denial;
    const groups = new Map<string, { repo: string; tool: string; count: number; runs: Set<string>; at: number[] }>();
    for (const m of measures ?? []) {
      for (const d of m.toolDenials) {
        if (!inWindow(d.at, now, within_hours)) continue;
        const repo = d.repo ?? "";
        const key = `${repo}|${d.tool}`;
        const g = groups.get(key) ?? { repo, tool: d.tool, count: 0, runs: new Set(), at: [] };
        g.count += d.count;
        g.runs.add(m.runId);
        g.at.push(d.at);
        groups.set(key, g);
      }
    }
    return [...groups].filter(([, g]) => g.count >= times).map(([key, g]) => ({
      detector: "repeated-tool-denial",
      fingerprint: `repeated-tool-denial|${key}`,
      severity: "minor" as const,
      summary: `The tool ${cleanLine(g.tool).slice(0, 100)} was refused ${g.count} times${g.repo ? ` in ${g.repo}` : ""} in the last ${plural(within_hours, "hour")}.`,
      evidence: { counts: { denials: g.count, runs: g.runs.size }, times: latest(g.at), lines: [`tool ${cleanLine(g.tool).slice(0, 100)}`], ...(g.repo ? { repos: [g.repo] } : {}) },
      about: "project" as const,
      ...(g.repo ? { repo: g.repo } : {}),
    }));
  },
};

const abnormalOutput: Detector = {
  name: "abnormal-output",
  description: "A step wrote far more output than is usual for that step. It may loop or have a task that is too wide.",
  slo: {
    owner: "repository owner",
    threshold: (c) => `output above ${c.abnormal_output.factor} × the median of the step and above ${c.abnormal_output.min_tokens} tokens (median of at least ${plural(c.abnormal_output.min_samples, "visit")})`,
    window: (c) => hours(c.abnormal_output.within_hours),
    action: "Read the step's transcript for a loop or a task that is too wide, then narrow the prompt or route the step to another model.",
  },
  run(input) {
    const { factor, min_tokens, min_samples, within_hours } = input.config.abnormal_output;
    // The median is per flow + step across all repositories; the findings are per repository.
    const all = groupVisits(input, within_hours, (v) => v.tokensOut !== undefined, false);
    const out: FindingInput[] = [];
    const found = new Map<string, { flow: string; step: string; repo: string; visits: StepVisit[]; median: number }>();
    for (const g of all.values()) {
      if (g.visits.length < min_samples) continue;
      const mid = median(g.visits.map((v) => v.tokensOut!));
      for (const v of g.visits) {
        if (v.tokensOut! <= factor * mid || v.tokensOut! <= min_tokens) continue;
        const key = `${v.repo ?? ""}|${g.flow}|${g.step}`;
        const f = found.get(key) ?? { flow: g.flow, step: g.step, repo: v.repo ?? "", visits: [], median: mid };
        f.visits.push(v);
        found.set(key, f);
      }
    }
    for (const [key, f] of found) {
      const biggest = Math.max(...f.visits.map((v) => v.tokensOut!));
      out.push({
        detector: "abnormal-output",
        fingerprint: `abnormal-output|${key}`,
        severity: "minor",
        summary: `Step ${f.step} of flow ${f.flow} had ${plural(f.visits.length, "visit")} with more than ${factor} times its usual output${f.repo ? ` in ${f.repo}` : ""}.`,
        evidence: { counts: { visits: f.visits.length, largest_tokens: biggest, median_tokens: Math.round(f.median) }, times: latest(f.visits.map((v) => v.at)), steps: [f.step], flows: [f.flow], ...(f.repo ? { repos: [f.repo] } : {}) },
        about: "project",
        ...(f.repo ? { repo: f.repo } : {}),
      });
    }
    return out;
  },
};

export const SLO_DETECTORS: Detector[] = [policyServiceFailure, evidenceFinalization, stepLatencyP95, repeatedToolDenial, abnormalOutput];
