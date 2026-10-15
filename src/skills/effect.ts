import { z } from "zod";
import { credentialProblem } from "./credential-scan.js";
import {
  EFFECT_LIMITS, EFFECT_REASONS, EFFECT_RULE, EFFECT_VERDICTS, EVALUATION_EPSILON, EVALUATION_INSTRUCTIONS_LIMITS, EVALUATION_SUITE_LIMITS,
} from "./evaluation-rules.js";
import { parseSkillKey } from "./lock.js";
import { SKILL_DIGEST_RE, SKILL_ID_RE, SkillIdSchema, SkillVersionSchema } from "./schema.js";

// The effect of a skill: the sample tasks of a suite run with and without the skill, and a fixed rule says whether the skill helps.
// Pure: the statistics, the record and its checks, the printed lines and the command operands. Nothing is run or stored here
// (skill-eval/effect.ts runs the agents, evaluation-store.ts stores the record).

const IL = EVALUATION_INSTRUCTIONS_LIMITS;
const COMMIT_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const RUN_ID_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${IL.runIdChars - 1}}$`);

export type EffectOperands =
  | { kind: "staged"; source: string; skill: string; suiteFile?: string }
  | { kind: "approved"; id: string; version: string; suiteFile?: string };

export interface EffectScenario { id: string; task: string; offered: boolean }
export interface EffectRun { scenario: string; attempt: number; runId: string; pass: boolean; loaded: boolean; tokens: number; durationMs: number }
export interface EffectVerdict {
  verdict: (typeof EFFECT_VERDICTS)[number];
  reason: (typeof EFFECT_REASONS)[number];
  with: { passed: number; runs: number };
  without: { passed: number; runs: number };
  /** Both are rounded to 6 decimals; the rule uses the unrounded values. */
  difference: number;
  p: number;
}
export interface EffectRecord {
  schema: 1;
  skill: { id: string; version: string; digest: string; source?: string; commit?: string };
  suite: { digest: string; repeat: number };
  runtime: { foundry: string; node: string; agent: string; model: string };
  ranAt: string;
  /** Every instructions scenario, sorted by id. */
  scenarios: EffectScenario[];
  /** Sorted by scenario, then attempt. */
  runs: { with: EffectRun[]; without: EffectRun[] };
  verdict: EffectVerdict;
}

// ---- statistics ----

const LOG_FACT: number[] = [0];
for (let i = 1; i <= 2 * EFFECT_LIMITS.runsPerArm; i++) LOG_FACT[i] = LOG_FACT[i - 1]! + Math.log(i);
const logChoose = (n: number, k: number): number => LOG_FACT[n]! - LOG_FACT[k]! - LOG_FACT[n - k]!;

/**
 * The two-sided exact p-value (Fisher) of `a` of `n1` passes against `b` of `n2` passes: the sum of the probabilities of every table
 * with the same totals that is not more likely than the observed one. Throws RangeError for values that are not whole numbers in range.
 */
export function fisherExact(a: number, n1: number, b: number, n2: number): number {
  const ok = (v: number) => Number.isInteger(v) && v >= 0;
  if (![a, n1, b, n2].every(ok) || a > n1 || b > n2 || n1 > EFFECT_LIMITS.runsPerArm || n2 > EFFECT_LIMITS.runsPerArm) {
    throw new RangeError("fisherExact: counts must be whole numbers, passes at most runs, at most 200 runs per arm");
  }
  // one order of the arms, so that swapping them gives exactly the same sum
  if (n1 > n2 || (n1 === n2 && a > b)) return fisherExact(b, n2, a, n1);
  const total = n1 + n2;
  const k = a + b;
  const lo = Math.max(0, n1 - (total - k));
  const hi = Math.min(n1, k);
  const logP = (x: number) => logChoose(k, x) + logChoose(total - k, n1 - x) - logChoose(total, n1);
  const seen = logP(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logP(x);
    if (lp <= seen + 1e-7) p += Math.exp(lp);
  }
  return Math.min(1, p);
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Pure. The verdict of the two arms. Tokens and time are not looked at. */
export function effectVerdict(input: {
  scenarios: readonly EffectScenario[];
  with: readonly Pick<EffectRun, "pass" | "loaded">[];
  without: readonly Pick<EffectRun, "pass">[];
}): EffectVerdict {
  const tally = (runs: readonly { pass: boolean }[]) => ({ passed: runs.filter((r) => r.pass).length, runs: runs.length });
  const w = tally(input.with);
  const wo = tally(input.without);
  const rate = (c: { passed: number; runs: number }) => (c.runs === 0 ? 0 : c.passed / c.runs);
  const diff = rate(w) - rate(wo);
  const never = !input.scenarios.some((s) => s.offered) || !input.with.some((r) => r.loaded);
  if (never) return { verdict: "no-measurable-effect", reason: "never-selected", with: w, without: wo, difference: round6(diff), p: 1 };
  const p = fisherExact(w.passed, w.runs, wo.passed, wo.runs);
  const significant = p <= EFFECT_RULE.alpha + EVALUATION_EPSILON;
  const big = Math.abs(diff) >= EFFECT_RULE.minDifference - EVALUATION_EPSILON;
  let verdict: EffectVerdict["verdict"] = "no-measurable-effect";
  let reason: EffectVerdict["reason"] = "not-significant";
  if (significant && big) {
    verdict = diff > 0 ? "helps" : "harms";
    reason = diff > 0 ? "pass-rate-higher" : "pass-rate-lower";
  }
  return { verdict, reason, with: w, without: wo, difference: round6(diff), p: round6(p) };
}

// ---- the record ----

/** The name of the first credential rule any decoded string or key of the value trips; "limit" when it is too big or deep. */
function rawCredential(raw: unknown): string | undefined {
  let nodes = 0;
  const walk = (v: unknown, depth: number): string | undefined => {
    if (++nodes > EFFECT_LIMITS.walkNodes || depth > EFFECT_LIMITS.walkDepth) return "limit";
    if (typeof v === "string") return credentialProblem(v);
    if (Array.isArray(v)) {
      for (const x of v) {
        const p = walk(x, depth + 1);
        if (p) return p;
      }
    } else if (v !== null && typeof v === "object") {
      for (const k of Object.keys(v)) {
        const val = (v as Record<string, unknown>)[k];
        const pair = typeof val === "string" ? (credentialProblem(`${k}: ${val}`) ?? credentialProblem(`${k}="${val}"`)) : undefined;
        const p = credentialProblem(k) ?? pair ?? walk(val, depth + 1);
        if (p) return p;
      }
    }
    return undefined;
  };
  return walk(raw, 1);
}

const digest = z.string().regex(SKILL_DIGEST_RE, "must be a sha256 digest");
const countSchema = z.number().int().min(0).max(EFFECT_LIMITS.runsPerArm);
const armCount = z.object({ passed: countSchema, runs: countSchema }).strict();
const runSchema = z
  .object({
    scenario: SkillIdSchema,
    attempt: z.number().int().min(1).max(IL.repeatMax),
    runId: z.string().regex(RUN_ID_RE, "must be a short run id"),
    pass: z.boolean(),
    loaded: z.boolean(),
    tokens: z.number().int().min(0).max(EFFECT_LIMITS.tokens),
    durationMs: z.number().int().min(0).max(EFFECT_LIMITS.durationMs),
  })
  .strict();
const RecordSchema = z
  .object({
    schema: z.literal(1),
    skill: z
      .object({ id: SkillIdSchema, version: SkillVersionSchema, digest, source: SkillIdSchema.optional(), commit: z.string().regex(COMMIT_RE, "must be a commit id").optional() })
      .strict()
      .refine((s) => (s.source === undefined) === (s.commit === undefined), { message: "source and commit come together" }),
    suite: z.object({ digest, repeat: z.number().int().min(IL.repeatMin).max(IL.repeatMax) }).strict(),
    runtime: z
      .object({
        foundry: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}$/),
        node: z.string().regex(/^v\d+\.\d+\.\d+$/),
        agent: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        model: z.string().regex(new RegExp(`^[\\x20-\\x7e]{1,${EFFECT_LIMITS.modelChars}}$`)),
      })
      .strict(),
    ranAt: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/),
    scenarios: z.array(z.object({ id: SkillIdSchema, task: z.string().min(1).max(EVALUATION_SUITE_LIMITS.taskChars), offered: z.boolean() }).strict()).max(IL.scenarios),
    runs: z.object({ with: z.array(runSchema).max(EFFECT_LIMITS.runsPerArm), without: z.array(runSchema).max(EFFECT_LIMITS.runsPerArm) }).strict(),
    verdict: z
      .object({
        verdict: z.enum(EFFECT_VERDICTS),
        reason: z.enum(EFFECT_REASONS),
        with: armCount,
        without: armCount,
        difference: z.number().min(-1).max(1),
        p: z.number().min(0).max(1),
      })
      .strict(),
  })
  .strict();

/** What the schema cannot say. Messages never hold any part of the record's text. */
function semanticProblem(r: EffectRecord): string | undefined {
  const ids = new Set(r.scenarios.map((s) => s.id));
  if (ids.size !== r.scenarios.length) return "scenarios: an id is used twice";
  const offered = r.scenarios.filter((s) => s.offered).map((s) => s.id);
  if (offered.length * r.suite.repeat > IL.total) return "too many runs (offered scenarios × repeat)";
  const arms = [["with", r.runs.with], ["without", r.runs.without]] as const;
  for (const [name, runs] of arms) {
    if (offered.length === 0) {
      if (runs.length > 0) return `runs.${name}: nothing is offered, so no run is expected`;
      continue;
    }
    const want = new Set(offered.flatMap((id) => Array.from({ length: r.suite.repeat }, (_, i) => `${id}#${i + 1}`)));
    const got = new Set<string>();
    for (const run of runs) {
      const key = `${run.scenario}#${run.attempt}`;
      if (!want.has(key)) return `runs.${name}: a run is of a scenario that is not offered, or of an attempt beyond repeat`;
      if (got.has(key)) return `runs.${name}: a scenario and attempt are run twice`;
      got.add(key);
    }
    if (got.size !== want.size) return `runs.${name}: every offered scenario must run repeat times`;
  }
  if (r.runs.without.some((x) => x.loaded)) return "runs.without: a run without the skill cannot have loaded it";
  const runIds = [...r.runs.with, ...r.runs.without].map((x) => x.runId);
  if (new Set(runIds).size !== runIds.length) return "runs: a run id is used twice";
  return undefined;
}

/** Checks a raw record: credentials first, then the schema, then the rules, then the verdict is computed again. */
export function parseEffectRecord(raw: unknown): { record: EffectRecord } | { problem: string } {
  const hit = rawCredential(raw);
  if (hit === "limit") return { problem: "is too large or nested too deep" };
  if (hit) return { problem: `holds credential-like text (${hit})` };
  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { problem: i ? `${i.path.join(".") || "record"}: ${i.message}` : "is not a valid record" };
  }
  const record = parsed.data as EffectRecord;
  const why = semanticProblem(record);
  if (why) return { problem: why };
  const again = effectVerdict({ scenarios: record.scenarios, with: record.runs.with, without: record.runs.without });
  const v = record.verdict;
  const same =
    again.verdict === v.verdict && again.reason === v.reason && again.difference === v.difference && again.p === v.p &&
    again.with.passed === v.with.passed && again.with.runs === v.with.runs && again.without.passed === v.without.passed && again.without.runs === v.without.runs;
  if (!same) return { problem: "the stored verdict differs from its runs" };
  return { record };
}

/** The lines printed for a record: skipped scenarios, every run, then the verdict. */
export function effectLines(r: EffectRecord): string[] {
  const key = `${r.skill.id}@${r.skill.version}`;
  const lines: string[] = [];
  for (const s of r.scenarios) if (!s.offered) lines.push(`SKIPPED ${key} ${s.id}: not offered; not run`);
  for (const arm of ["with", "without"] as const) {
    for (const x of r.runs[arm]) {
      lines.push(`RUN ${key} ${arm} ${x.scenario} ${x.attempt}/${r.suite.repeat} run ${x.runId}: ${x.pass ? 1 : 0}${arm === "with" && !x.loaded ? " (skill-not-loaded)" : ""}`);
    }
  }
  const v = r.verdict;
  const sum = (runs: EffectRun[], f: (x: EffectRun) => number) => runs.reduce((n, x) => n + f(x), 0);
  const secs = (runs: EffectRun[]) => `${Math.round(sum(runs, (x) => x.durationMs) / 1000)} s`;
  const sign = v.difference >= 0 ? "+" : "-";
  lines.push(
    `EFFECT ${key} ${v.verdict} (${v.reason}): with ${v.with.passed}/${v.with.runs}, without ${v.without.passed}/${v.without.runs}, difference ${sign}${Math.abs(v.difference).toFixed(2)}, p ${v.p.toFixed(4)}; ` +
      `tokens ${sum(r.runs.with, (x) => x.tokens)} vs ${sum(r.runs.without, (x) => x.tokens)}; time ${secs(r.runs.with)} vs ${secs(r.runs.without)}`,
  );
  return lines;
}

/** The operands of `scf skills effect`: `<source-id> <skill-id> [<suite>]` or `<id@version> [<suite>]`. */
export function parseEffectOperands(operands: string[]): EffectOperands | { problem: string } {
  const bad = { problem: "scf skills effect: expects <source-id> <skill-id> or <id@version>, and at most one suite file" };
  const [a, b, c] = operands;
  if (operands.length < 1 || operands.length > 3 || a === undefined) return bad;
  if (operands.length === 1 || (operands.length === 2 && a.includes("@"))) {
    const key = parseSkillKey(a);
    if (!key) return bad;
    return { kind: "approved", ...key, ...(b !== undefined ? { suiteFile: b } : {}) };
  }
  if (a.includes("@") || !SKILL_ID_RE.test(a) || b === undefined || !SKILL_ID_RE.test(b)) return bad;
  return { kind: "staged", source: a, skill: b, ...(c !== undefined ? { suiteFile: c } : {}) };
}
