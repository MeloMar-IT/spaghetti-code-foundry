import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { EvaluationPolicy } from "./evaluation.js";
import {
  EVALUATION_AGENT_CONFIG, EVALUATION_ARMS, EVALUATION_DIMENSIONS, EVALUATION_INSTRUCTIONS_LIMITS, EVALUATION_LIMITS, EVALUATION_NETWORK,
  EVALUATION_SANDBOXES, EVALUATION_SUITE_LIMITS, type EvaluationDimension,
} from "./evaluation-rules.js";
import { checkScenario, claimId, isObject, pathValue, text, toolsOf, type EvaluationSuite, type Problems, type ToolsScenario } from "./evaluation-suite.js";
import { byteCmp } from "./import-plan.js";
import { canonicalJson } from "./normalize-values.js";
import { readRegular } from "./package.js";
import { SKILL_DIGEST_RE, SkillIdSchema, SkillVersionSchema } from "./schema.js";
import { shownValue } from "./sources.js";

// The `instructions` section of the evaluation suite (sandboxed agent scenarios, run with repeats) and the `agent` block of the
// evaluation record (the runs and the paired baselines). Pure except instructionFixtureHash, which reads one fixture folder.
// Nothing is run here. evaluation-suite.ts and this file import each other: neither may use the other's bindings while loading.

const IL = EVALUATION_INSTRUCTIONS_LIMITS;
const L = EVALUATION_SUITE_LIMITS;

export interface InstructionsScenario { id: string; repo: string; task: string; check: string; policy: ToolsScenario["policy"]; timeout_sec: number }
export interface InstructionsSuite { mandatory: boolean; repeat: number; scenarios: InstructionsScenario[] }

const KEYS = ["repo", "task", "check", "policy", "timeout_sec"] as const;

/** Checks the `instructions` map. Claims the scenario ids in `used`. Returns undefined after reporting a problem. */
export function parseInstructions(raw: unknown, used: Map<string, string>, add: (where: string, message: string) => void): InstructionsSuite | undefined {
  let bad = false;
  const report = (where: string, message: string) => {
    bad = true;
    add(where, message);
  };
  if (!isObject(raw)) {
    report("instructions", "must be a map");
    return undefined;
  }
  for (const k of Object.keys(raw)) if (!["mandatory", "repeat", "scenarios"].includes(k)) report("instructions", `unknown key "${shownValue(k)}"`);
  let mandatory = false;
  if (raw.mandatory !== undefined) {
    if (typeof raw.mandatory === "boolean") mandatory = raw.mandatory;
    else report("instructions.mandatory", "must be true or false");
  }
  let repeat: number = IL.repeatDefault;
  if (raw.repeat !== undefined) {
    const v = raw.repeat;
    if (typeof v !== "number" || !Number.isInteger(v)) report("instructions.repeat", "must be a whole number");
    else if (v < IL.repeatMin || v > IL.repeatMax) report("instructions.repeat", `must be between ${IL.repeatMin} and ${IL.repeatMax}`);
    else repeat = v;
  }
  const list = raw.scenarios;
  const scenarios: InstructionsScenario[] = [];
  if (list === undefined) report("instructions.scenarios", "is required");
  else if (!Array.isArray(list)) report("instructions.scenarios", "must be a list");
  else if (list.length < 1) report("instructions.scenarios", "must hold at least one scenario");
  else if (list.length > IL.scenarios) report("instructions.scenarios", `must hold at most ${IL.scenarios} scenarios`);
  else {
    if (list.length * repeat > IL.total) report("instructions", `must hold at most ${IL.total} runs (scenarios × repeat)`);
    list.forEach((item, i) => {
      const base = `instructions.scenarios[${i}]`;
      const idRaw = isObject(item) ? item.id : undefined;
      const tag = typeof idRaw === "string" && SkillIdSchema.safeParse(idRaw).success ? `${base} (${idRaw})` : base;
      const p: Problems = { add: (field, message) => report(field ? `${tag} ${field}` : tag, message) };
      const map = checkScenario(item, KEYS, p);
      if (!map) return;
      const id = claimId(idRaw, base, used, p);
      let ok = id !== undefined;
      const sub: Problems = { add: (f, m) => { ok = false; p.add(f, m); } };
      const repo = map.repo === undefined ? (sub.add("repo", "is required"), undefined) : pathValue(map.repo, "repo", sub);
      const task = text(map, "task", L.taskChars, sub);
      const check = text(map, "check", IL.checkChars, sub);
      const policy = toolsOf(map, id ?? "", sub)?.policy;
      let timeout: number = IL.timeoutDefault;
      if (map.timeout_sec !== undefined) {
        const v = map.timeout_sec;
        if (typeof v !== "number" || !Number.isInteger(v)) sub.add("timeout_sec", "must be a whole number");
        else if (v < IL.timeoutMin || v > IL.timeoutMax) sub.add("timeout_sec", `must be between ${IL.timeoutMin} and ${IL.timeoutMax}`);
        else timeout = v;
      }
      if (!ok || id === undefined || repo === undefined || task === undefined || check === undefined || policy === undefined) return;
      scenarios.push({ id, repo, task, check, policy, timeout_sec: timeout });
    });
  }
  if (bad) return undefined;
  scenarios.sort((a, b) => byteCmp(a.id, b.id));
  return { mandatory, repeat, scenarios };
}

const errCode = (e: unknown) => String((e as NodeJS.ErrnoException)?.code ?? "unknown error").replace(/[^A-Za-z0-9_ ]/g, "").slice(0, 40);

/**
 * A content hash of one fixture folder: the sorted relative paths, the bytes and the executable bit of every file.
 * Refuses `.claude` and `.mcp.json` (an agent would load them), links and anything that cannot be read completely.
 * Never throws: a failure is a short problem text without a path of the machine. `read` is for tests.
 */
export function instructionFixtureHash(dir: string, read: typeof readRegular = readRegular): { hash: string } | { problem: string } {
  try {
    const files: { rel: string; executable: boolean; sha256: string }[] = [];
    const queue: { abs: string; rel: string }[] = [{ abs: dir, rel: "" }];
    for (let q = queue.shift(); q; q = queue.shift()) {
      for (const name of readdirSync(q.abs).sort(byteCmp)) {
        if (EVALUATION_AGENT_CONFIG.includes(name.toLowerCase())) return { problem: "holds .claude or .mcp.json, which an agent would load" };
        const abs = join(q.abs, name);
        const rel = q.rel ? `${q.rel}/${name}` : name;
        const st = lstatSync(abs);
        if (st.isSymbolicLink()) return { problem: "holds a symbolic link" };
        if (st.isDirectory()) queue.push({ abs, rel });
        else if (st.isFile()) {
          if (files.length >= L.fixtureFiles) return { problem: "is larger than the fixture limits" };
          const bytes = read(abs, L.fixtureFileBytes);
          if (typeof bytes === "string") return { problem: "cannot be read completely" };
          files.push({ rel, executable: (st.mode & 0o111) !== 0, sha256: createHash("sha256").update(bytes).digest("hex") });
        } else return { problem: "holds a file that is not a regular file" };
      }
    }
    files.sort((a, b) => byteCmp(a.rel, b.rel));
    const h = createHash("sha256");
    for (const f of files) h.update(canonicalJson({ path: f.rel, executable: f.executable, sha256: f.sha256 }) + "\n");
    return { hash: "sha256:" + h.digest("hex") };
  } catch (e) {
    return { problem: `cannot be read (${errCode(e)})` };
  }
}

// ---- the record ----

export const SamplesSchema = z.array(z.number().finite().min(0).max(1)).min(1).max(EVALUATION_LIMITS.samples);
export const DimensionsSchema = z
  .object({ selection: SamplesSchema.optional(), instructions: SamplesSchema.optional(), conflicts: SamplesSchema.optional(), context: SamplesSchema.optional(), tools: SamplesSchema.optional() })
  .strict();

export interface EvaluationAgentRun { scenario: string; arm: "candidate" | "baseline"; skill: string; digest: string; attempt: number; runId: string; score: number }
export interface EvaluationAgentBaseline { id: string; version: string; digest: string; dimensions: Partial<Record<EvaluationDimension, number[]>> }
export interface EvaluationAgent {
  sandbox: (typeof EVALUATION_SANDBOXES)[number];
  network: (typeof EVALUATION_NETWORK)[number];
  outbound: string[];
  repeat: number;
  runs: EvaluationAgentRun[];
  baselines: EvaluationAgentBaseline[];
}

const digest = z.string().regex(SKILL_DIGEST_RE, "must be a sha256 digest");
const RUN_ID_RE = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,${IL.runIdChars - 1}}$`);
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,252})(:[0-9]{1,5})?$/;

export const EvaluationAgentSchema = z
  .object({
    sandbox: z.enum(EVALUATION_SANDBOXES),
    network: z.enum(EVALUATION_NETWORK),
    outbound: z.array(z.string().regex(HOST_RE, "must be a host name")).max(IL.outbound),
    repeat: z.number().int().min(IL.repeatMin).max(IL.repeatMax),
    runs: z
      .array(
        z
          .object({
            scenario: SkillIdSchema,
            arm: z.enum(EVALUATION_ARMS),
            skill: SkillIdSchema,
            digest,
            attempt: z.number().int().min(1).max(IL.repeatMax),
            runId: z.string().regex(RUN_ID_RE, "must be a short run id"),
            score: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .max(IL.runs),
    baselines: z
      .array(
        z
          .object({ id: SkillIdSchema, version: SkillVersionSchema, digest, dimensions: DimensionsSchema })
          .strict()
          .refine((b) => b.dimensions.instructions !== undefined, { message: "needs dimensions.instructions", path: ["dimensions", "instructions"] }),
      )
      .max(IL.baselines),
  })
  .strict();

const sortedNums = (s: readonly number[]): string => JSON.stringify([...s].sort((a, b) => a - b));

/** What the schema cannot say: the runs, the scenarios and the dimensions must agree. Messages never hold any part of the text. */
export function agentProblems(r: {
  candidate: { id: string; digest: string };
  suite: { scenarios: { id: string; inputs: Record<string, string> }[] };
  dimensions: Partial<Record<EvaluationDimension, number[]>>;
  agent: EvaluationAgent;
}): { path: (string | number)[]; message: string }[] {
  const out: { path: (string | number)[]; message: string }[] = [];
  const a = r.agent;
  const add = (path: (string | number)[], message: string) => {
    if (!out.some((x) => x.message === message && x.path.join(".") === path.join("."))) out.push({ path, message });
  };
  const mine = r.dimensions.instructions;
  if (!mine) {
    add(["agent"], "needs dimensions.instructions");
    return out;
  }
  const scenarios = new Set(r.suite.scenarios.filter((s) => s.inputs.dimension === "instructions").map((s) => s.id));
  const listed = new Set(a.baselines.map((b) => `${b.id} ${b.digest}`));
  if (listed.size !== a.baselines.length || listed.has(`${r.candidate.id} ${r.candidate.digest}`)) add(["agent", "baselines"], "baselines must be unique and not the candidate");
  const runIds = new Set<string>();
  const slots = new Set<string>();
  for (const run of a.runs) {
    if (!scenarios.has(run.scenario)) add(["agent", "runs"], "a run names an unknown scenario");
    if (runIds.has(run.runId)) add(["agent", "runs"], "run ids must be unique");
    runIds.add(run.runId);
    const slot = canonicalJson([run.arm, run.skill, run.digest, run.scenario, run.attempt]);
    if (slots.has(slot)) add(["agent", "runs"], "a run is listed twice");
    slots.add(slot);
    if (run.attempt > a.repeat) add(["agent", "runs"], "an attempt is larger than repeat");
    if (run.arm === "candidate") {
      if (run.skill !== r.candidate.id || run.digest !== r.candidate.digest) add(["agent", "runs"], "a candidate run names another skill");
    } else if (!listed.has(`${run.skill} ${run.digest}`)) add(["agent", "runs"], "a baseline run names a skill that is not listed");
  }
  // Every arm must cover every instructions scenario for attempts 1..repeat, so both arms are scored on the same tasks.
  const covered = (arm: string, id: string, dg: string): boolean => {
    const have = new Set(a.runs.filter((x) => x.arm === arm && x.skill === id && x.digest === dg).map((x) => `${x.scenario} ${x.attempt}`));
    for (const s of scenarios) for (let n = 1; n <= a.repeat; n++) if (!have.has(`${s} ${n}`)) return false;
    return true;
  };
  if (!covered("candidate", r.candidate.id, r.candidate.digest)) add(["agent", "runs"], "the candidate runs must cover every scenario and attempt");
  a.baselines.forEach((b, i) => {
    if (!covered("baseline", b.id, b.digest)) add(["agent", "baselines", i], "the baseline runs must cover every scenario and attempt");
  });
  const scores = (arm: string, id: string, dg: string) => a.runs.filter((x) => x.arm === arm && x.skill === id && x.digest === dg).map((x) => x.score);
  if (sortedNums(scores("candidate", r.candidate.id, r.candidate.digest)) !== sortedNums(mine)) add(["agent"], "the candidate runs differ from dimensions.instructions");
  a.baselines.forEach((b, i) => {
    const have = b.dimensions.instructions;
    if (!have) add(["agent", "baselines", i], "needs dimensions.instructions");
    else if (sortedNums(scores("baseline", b.id, b.digest)) !== sortedNums(have)) add(["agent", "baselines", i], "instructions differ from its runs");
  });
  return out;
}

/** A fresh copy in a fixed order: outbound deduped and sorted, runs and baselines sorted, dimensions in the fixed order. */
export function normaliseAgent(a: EvaluationAgent): EvaluationAgent {
  const baselines = a.baselines.map((b) => {
    const dimensions: Partial<Record<EvaluationDimension, number[]>> = {};
    for (const d of EVALUATION_DIMENSIONS) if (b.dimensions[d]) dimensions[d] = [...b.dimensions[d]!];
    return { id: b.id, version: b.version, digest: b.digest, dimensions };
  });
  baselines.sort((x, y) => byteCmp(`${x.id} ${x.digest}`, `${y.id} ${y.digest}`));
  const runs = a.runs
    .map((x) => ({ scenario: x.scenario, arm: x.arm, skill: x.skill, digest: x.digest, attempt: x.attempt, runId: x.runId, score: x.score }))
    .map((x) => ({ x, k: canonicalJson([x.arm, x.skill, x.digest, x.scenario, x.attempt, x.runId]) }))
    .sort((p, q) => byteCmp(p.k, q.k))
    .map((e) => e.x);
  return { sandbox: a.sandbox, network: a.network, outbound: [...new Set(a.outbound)].sort(byteCmp), repeat: a.repeat, runs, baselines };
}

/** The lines the record digest adds for a normalised `agent` block. One value list per line keeps canonicalJson under its limit. */
export function agentLines(a: EvaluationAgent): string[] {
  const lines = [`agent ${canonicalJson([a.sandbox, a.network, a.outbound, a.repeat])}`];
  for (const x of a.runs) lines.push(`run ${canonicalJson([x.scenario, x.arm, x.skill, x.digest, x.attempt, x.runId, x.score])}`);
  for (const b of a.baselines) {
    lines.push(`baseline ${canonicalJson([b.id, b.version, b.digest])}`);
    for (const d of EVALUATION_DIMENSIONS) if (b.dimensions[d]) lines.push(`baseline-dimension ${b.id} ${b.digest} ${d} ${b.dimensions[d]!.join(",")}`);
  }
  return lines;
}

/** The gate policy a suite asks for: its digest, `instructions` mandatory when the suite says so, and repeat × scenarios samples. */
export function instructionsPolicy(suite: EvaluationSuite, suiteDigest: string): EvaluationPolicy {
  const ins = suite.instructions;
  return {
    suite: suiteDigest,
    ...(ins?.mandatory ? { mandatory: ["instructions"] as const } : {}),
    ...(ins ? { minSamples: { instructions: ins.repeat * ins.scenarios.length } } : {}),
  };
}
