import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../auth/store.js";
import type { Config } from "../config.js";
import type { StepIdentity } from "../evidence/identity.js";
import type { Denial } from "../evidence/schema.js";
import type { RunRecorder } from "../evidence/record.js";
import { BASELINE_POLICY_ID, BASELINE_RULE_BOUNDARIES, BASELINE_VERSION, baselineControls, runBaseline, type BaselineControls, type BaselineRuleId } from "../policy/baseline.js";
import type { Flow } from "../flow/schema.js";
import { HOTFIX_FLOW, isShippedFlow } from "./guards.js";
import { baselineLimits, NO_STEP_LIMITS, scopedPacks, stepLimits } from "./policy-limits.js";
import { combineDecisions, layeredPackIds, type Layer, type LayeredDecision } from "../policy/compose.js";
import { parsePolicyDecision, parsePolicyPack } from "../policy/parse.js";
import { explanationLine, logNote, STOPPING_BOUNDARIES } from "../policy/explain.js";
import { reasonText, type ReasonCode } from "../policy/reasons.js";
import { evaluatePolicy, policyDenial, policyInputSha256 } from "../policy/evaluate.js";
import { FactsSchema, type Boundary, type FactName, type Facts, type Mode, type PolicyDecision, type PolicyInput, type PolicyPack } from "../policy/schema.js";
import { POLICY_INPUT_VERSION, PolicySchemaError } from "../policy/version.js";
import { activeBreakGlass, type BreakGlass } from "./policy-break-glass.js";
import { saveLastKnownGood } from "./policy-store.js";
import { userAccount } from "./isolation.js";
import type { RunSummary } from "./state.js";

/**
 * The baseline and the policy packs (and their rules) asked at the boundaries of a run, in observe mode: every decision is logged and
 * recorded as evidence, and nothing in the run changes because of it. The one exception is fail closed: a pack in the
 * mandatory layer that cannot be loaded or evaluated denies the privileged boundaries (see `privilegedBoundary`).
 * With `policy.enforce` (#727) the listed baseline rules decide in enforce mode and are asked first; when the baseline cannot be
 * used, the boundaries of those rules fail closed too (`push` excepted: the pre-push hook decides there).
 * The one way out is an active break-glass (#626): it turns that denial into a recorded `warn`, but only when the
 * decision can be written to the run's evidence. Nothing here throws into the engine.
 * The baseline is built in and always asked; it is asked at `push` only when the pre-push hook is installed.
 * Its limit rules (output, time, cost) are per flow: a step of a sub-flow is asked against a baseline built from its own
 * flow's limits (`subFlow`), at every boundary. A root baseline that cannot be built is never replaced.
 */

export const POLICY_FOLDER = "policies";
export const MAX_PACK_BYTES = 1 << 20;
export const UNKNOWN_POLICY_VERSION = "unknown";

export type LoadedPack =
  | { id: string; pack: PolicyPack; /** Asked instead of `pack` at a push whose repository is not known. */ pushWithoutRepository?: PolicyPack; /** Asked instead of `pack` at `step.before` when the `sandboxed` fact is not known. */ stepWithoutSandbox?: PolicyPack; /** Asked instead of `pack` at `step.after` when the `contextUncited` fact is not known. */ stepWithoutCitations?: PolicyPack }
  | { id: string; problem: "policy.unavailable" | "policy.invalid"; detail: string };

export type LayeredPack = LoadedPack & { layer: Layer };
type NoPackCode = "policy.unavailable" | "policy.invalid";

/** A mandatory policy that cannot be used stopped the step: why, and what to record (no decision when even that failed). */
export interface PolicyDenied {
  reason: string;
  decision?: PolicyDecision;
  denial?: Denial;
}
export interface PolicyAnswer {
  decisions: LayeredDecision[];
  combined?: LayeredDecision;
  denied?: PolicyDenied;
}

/** The boundaries at which a mandatory policy that cannot be used stops the step: a sign-in, a writing agent, a used approval. */
export function privilegedBoundary(boundary: Boundary, facts: Facts): boolean {
  if (boundary === "agent.write" || boundary === "approval.consume") return true;
  return boundary === "repository.access" && (facts.credential === "machine" || facts.credential === "repository");
}

export const deniedReason = (id: string, code: NoPackCode, boundary: Boundary): string => `mandatory policy ${id} cannot be used (${code}): ${boundary} is denied`;

/** Why an enforced rule of a usable policy denied a boundary. */
export const ruleDeniedReason = (d: Pick<PolicyDecision, "policy" | "boundary" | "reasonCode" | "rule">): string =>
  `policy ${d.policy.id} denies ${d.boundary}: ${reasonText(d.reasonCode as ReasonCode)} (${d.reasonCode}${d.rule ? `, rule ${d.rule}` : ""})`;

/**
 * The log text for what an unusable mandatory policy denies: sign-ins and writing agents always; with enforced rules also
 * the other stopping boundaries of those rules (push is only recorded).
 */
export function outageScope(enforce: readonly BaselineRuleId[]): string {
  const base = "this mandatory policy denies steps with a sign-in and writing agents";
  if (!enforce.length) return base;
  const boundaries = new Set<Boundary>();
  for (const id of enforce) for (const b of BASELINE_RULE_BOUNDARIES[id]) if (STOPPING_BOUNDARIES.includes(b) && !PRIVILEGED_BOUNDARIES.includes(b)) boundaries.add(b);
  return boundaries.size ? `${base}; for the enforced rules ${enforce.join(", ")} it also denies ${[...boundaries].join(", ")}` : base;
}

/** The boundaries an unusable mandatory policy always denies, with or without enforced rules. */
const PRIVILEGED_BOUNDARIES: readonly Boundary[] = ["repository.access", "agent.write", "approval.consume"];

const unavailable = (id: string, detail: string): LoadedPack => ({ id, problem: "policy.unavailable", detail });
const invalid = (id: string, detail: string): LoadedPack => ({ id, problem: "policy.invalid", detail });

export type PolicyFileRead = { text: string } | { problem: "missing" | "not-file" | "too-large" | "unreadable" };

/** Reads a plain file up to `maxBytes`: never follows a link and never waits for a pipe. Never throws. */
export function readPolicyFile(path: string, maxBytes: number): PolicyFileRead {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { problem: code === "ENOENT" || code === "ENOTDIR" ? "missing" : code === "ELOOP" ? "not-file" : "unreadable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { problem: "not-file" };
    if (st.size > maxBytes) return { problem: "too-large" };
    const buf = Buffer.alloc(st.size);
    let done = 0;
    while (done < buf.length) {
      const n = readSync(fd, buf, done, buf.length - done, done);
      if (n === 0) break;
      done += n;
    }
    return { text: buf.subarray(0, done).toString("utf8") };
  } catch {
    return { problem: "unreadable" };
  } finally {
    closeSync(fd);
  }
}

function loadOne(id: string, home: string): LoadedPack {
  const name = `${POLICY_FOLDER}/${id}.json`;
  const read = readPolicyFile(join(home, POLICY_FOLDER, `${id}.json`), MAX_PACK_BYTES);
  if ("problem" in read) {
    if (read.problem === "missing") return unavailable(id, `no file ${name}`);
    if (read.problem === "not-file") return unavailable(id, "not a plain file");
    if (read.problem === "too-large") return invalid(id, "larger than 1 MiB");
    return unavailable(id, "could not be read");
  }
  const text = read.text;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return invalid(id, "not valid JSON");
  }
  let pack: PolicyPack;
  try {
    pack = parsePolicyPack(json);
  } catch (e) {
    return invalid(id, e instanceof PolicySchemaError ? (e.message.split("\n")[0] ?? "not valid") : "not valid");
  }
  if (pack.policy.id !== id) return invalid(id, `the file is for policy ${pack.policy.id}`);
  const problem = enforceProblem(pack);
  if (problem) return invalid(id, problem);
  return { id, pack };
}

/** Why a pack cannot be used yet: the pack or one of its rules is in enforce mode. Undefined when everything is observe. */
export function enforceProblem(pack: PolicyPack): string | undefined {
  if (pack.mode !== "observe") return `mode ${pack.mode} is not supported yet: set mode to observe`;
  const rule = pack.rules.find((r) => r.mode === "enforce");
  return rule ? `rule ${rule.id} has mode enforce, which is not supported yet: set its mode to observe or leave it out` : undefined;
}

/** Reads <home>/policies/<id>.json for each id. Never throws; the detail names no machine path and no file content. */
export function loadPolicyPacks(ids: readonly string[], home: string = dataHome()): LoadedPack[] {
  return ids.map((id) => {
    try {
      return loadOne(id, home);
    } catch {
      return unavailable(id, "could not be read");
    }
  });
}

/** The facts that are valid by their own schema; any other value is left out, never changed. */
export function policyFacts(raw: { [K in FactName]?: unknown }): Facts {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(raw) as FactName[]) {
    const value = raw[name];
    if (value === undefined) continue;
    const field = (FactsSchema.shape as Record<string, { safeParse: (v: unknown) => { success: boolean } }>)[name];
    if (field?.safeParse(value).success) out[name] = value;
  }
  return out as Facts;
}

/** The repository of a set of variables as a fact: lower case, and not the placeholder. Undefined when it is not known. */
export function repositoryFact(vars: Record<string, string> | undefined): string | undefined {
  const name = vars?.github_repo?.toLowerCase();
  return name && name !== "owner/repo" ? name : undefined;
}

/** The facts every boundary of this run has (repository, flow, workspace, owner); `runPolicy` adds `shippedFlow`. */
export function baseFacts(summary: Pick<RunSummary, "vars" | "flow" | "flowDef" | "owner">): Facts {
  return policyFacts({
    repository: repositoryFact(summary.vars),
    flow: summary.flow,
    workspace: summary.flowDef?.workspace,
    owner: !summary.owner ? "none" : userAccount(summary.owner) ? "user" : "admin",
  });
}

const stepKey = (s: StepIdentity) => `${s.parent ?? ""}/${s.id}#${s.visit}`;

// ── The pushes of a step: the pre-push hook (guards.ts) appends "<branch>\t<remote url>\t<secrets found>\t<identity>" to FACTORY_PUSH_LOG ──

export const MAX_PUSH_LOG_BYTES = 64 * 1024;
export const MAX_PUSHES_PER_STEP = 100;
export interface ObservedPush {
  branch: string;
  /** The repository the push went to, when its remote is a GitHub address; absent otherwise (never the run's own repository). */
  repository?: string;
  /** How many secrets the scan found; absent when not known. */
  secretsFound?: number;
  /** Whether git could find a committer identity; absent when not known. */
  commitIdentity?: boolean;
}

/** The place where the hook of one visit of a step writes its pushes. */
export const pushLogFile = (runDir: string, stepId: string, visit: number): string => join(runDir, "pushes", `${stepId.replace(/[^\w.-]/g, "_")}-${visit}.log`);

function repositoryOfUrl(url: string): string | undefined {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : undefined;
}

/**
 * Reads the pushes a step logged and removes the file. Only a plain file, up to 64 KiB and 100 lines; never throws.
 * A step can write to this file too, so its lines are only facts for observation, checked by their own schemas later.
 */
export function drainPushLog(file: string): ObservedPush[] {
  let text = "";
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile()) return [];
    const buf = Buffer.alloc(Math.min(st.size, MAX_PUSH_LOG_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    text = buf.subarray(0, n).toString("utf8");
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(file);
    } catch {
      // nothing to remove
    }
  }
  const out: ObservedPush[] = [];
  for (const line of text.split("\n")) {
    if (!line || out.length >= MAX_PUSHES_PER_STEP) continue;
    const [branch, url = "", found = "", ident = ""] = line.split("\t");
    if (!branch) continue;
    const repository = repositoryOfUrl(url);
    out.push({
      branch,
      ...(repository ? { repository } : {}),
      ...(/^\d{1,9}$/.test(found) ? { secretsFound: Number(found) } : {}),
      ...(ident === "1" || ident === "0" ? { commitIdentity: ident === "1" } : {}),
    });
  }
  return out;
}

const MAX_SEEN_KEYS = 1000;
const stepName =(s: StepIdentity) => (s.parent ? `${s.parent}/${s.id}` : s.id);

export class RunPolicy {
  private readonly runId: string;
  private readonly packs: LayeredPack[];
  /** Pushes are observed: the pre-push hook is installed because file packs are configured. */
  readonly observesPushes: boolean;
  private readonly base: Facts;
  private readonly log: (line: string) => void;
  private readonly evidence?: RunRecorder;
  private readonly now: () => string;
  /** What each step in progress was asked at repository.access, for its pushes. */
  private readonly access = new Map<string, Facts>();
  /** A mandatory pack could not be loaded: privileged steps will be denied, so the runner does not fetch the bot's token up front. */
  readonly mandatoryUnusable: boolean;
  private readonly breakGlass: () => BreakGlass | undefined;
  /** How often each decision came in this start of the run, for the "seen" suffix of the log. Capped. */
  private readonly seen = new Map<string, { count: number; first: string }>();

  /** Builds the baseline entry for a sub-flow (its own step limits), or without step limits when no scope is given. */
  private readonly scopedBaseline?: (scope?: { flow: Flow; depth: number }) => LayeredPack;
  /** The scoped baseline of each sub-flow, by the parent prefix of its steps. */
  private readonly scoped = new Map<string, LayeredPack>();
  private fallbackEntry?: LayeredPack;
  /** `policy.enforce`: the baseline rules that decide in enforce mode. */
  private readonly enforce: readonly BaselineRuleId[];
  /** Boundaries (not `push`) at which an unusable mandatory baseline is denied because of `enforce`. */
  private readonly enforcedAt: ReadonlySet<Boundary>;

  constructor(o: { scopedBaseline?: (scope?: { flow: Flow; depth: number }) => LayeredPack; breakGlass?: () => BreakGlass | undefined; runId: string; packs: LayeredPack[]; base: Facts; log: (line: string) => void; evidence?: RunRecorder; now?: () => string; observesPushes?: boolean; enforce?: readonly BaselineRuleId[] }) {
    this.enforce = o.enforce ?? [];
    this.enforcedAt = new Set(this.enforce.flatMap((id) => BASELINE_RULE_BOUNDARIES[id] ?? []).filter((b) => b !== "push"));
    this.observesPushes = o.observesPushes ?? false;
    this.mandatoryUnusable = o.packs.some((p) => p.layer === "mandatory" && "problem" in p);
    this.runId = o.runId;
    this.packs = o.packs;
    this.base = o.base;
    this.log = o.log;
    this.evidence = o.evidence;
    this.now = o.now ?? (() => new Date().toISOString());
    this.breakGlass = o.breakGlass ?? (() => undefined);
    this.scopedBaseline = o.scopedBaseline;
  }

  /**
   * A sub-flow starts under `parent` (the prefix of its step ids, without the closing slash): its steps are asked against a
   * baseline with the limits of that flow. Never throws; a baseline that cannot be built is logged and denies the privileged
   * boundaries of that sub-flow's steps.
   */
  subFlow(parent: string, flow: Flow, depth: number): void {
    if (!this.scopedBaseline) return;
    let entry: LayeredPack;
    try {
      entry = this.scopedBaseline({ flow, depth });
    } catch {
      entry = { layer: "mandatory", ...invalid(BASELINE_POLICY_ID, "could not be built") };
    }
    this.scoped.set(parent, entry);
    if ("problem" in entry) this.log(`! policy ${entry.id}: sub-flow ${parent}: ${entry.detail} — ${outageScope(this.enforce)} in this sub-flow`);
  }

  /** Does any usable pack have a rule at this boundary that uses this fact? Never throws. */
  needsFact(boundary: Boundary, fact: FactName): boolean {
    try {
      for (const loaded of [...this.packs, ...this.scoped.values()]) {
        if ("problem" in loaded) continue;
        if (loaded.pack.rules.some((r) => r.boundaries.includes(boundary) && (r.when as Record<string, unknown>)[fact] !== undefined)) return true;
      }
    } catch {
      // not known: no
    }
    return false;
  }

  /** The packs to ask for one step: the root's, or with the sub-flow's baseline swapped in. */
  private packsFor(step?: StepIdentity): readonly LayeredPack[] {
    if (step?.parent === undefined || !this.scopedBaseline) return this.packs;
    try {
      this.fallbackEntry ??= this.scopedBaseline();
      return scopedPacks(this.packs, this.scoped.get(step.parent) ?? this.fallbackEntry);
    } catch {
      return this.packs;
    }
  }

  /**
   * Asks every pack at one boundary; logs and records each decision; returns them and the winner. Never throws.
   * Observe only, except: a mandatory pack that cannot be loaded or evaluated at a privileged boundary (or, for the baseline, at a
   * boundary of an enforced rule) sets `denied`, and so does a deny of an enforced baseline rule (not at `push`).
   * While a break-glass is active, that denial becomes a `warn` (policy.break-glass), but only once the decision is recorded.
   */
  at(boundary: Boundary, facts: Facts = {}, step?: StepIdentity): PolicyAnswer {
    const decisions: LayeredDecision[] = [];
    const glass = new Map<LayeredDecision, { id: string; original: PolicyDecision; bg: BreakGlass }>();
    let denied: PolicyDenied | undefined;
    let input: PolicyInput;
    try {
      input = { version: POLICY_INPUT_VERSION, boundary, runId: this.runId, facts: policyFacts({ ...this.base, ...facts }) };
    } catch (e) {
      // recorded first: `fail` stops the evidence stream, and a break-glass needs its record
      const answer = this.inputFailed(boundary, facts, step);
      this.fail(e);
      return answer;
    }
    for (const loaded of this.packsFor(step)) {
      const mode: Mode = loaded.layer === "mandatory" && (privilegedBoundary(boundary, input.facts) || (loaded.id === BASELINE_POLICY_ID && this.enforcedAt.has(boundary))) ? "enforce" : "observe";
      try {
        const raw = this.decide(loaded, input, mode);
        const o = loaded.layer === "mandatory" ? this.outage(loaded.id, raw, boundary) : { decision: raw };
        const decision = o.decision;
        const entry: LayeredDecision = { layer: loaded.layer, decision };
        decisions.push(entry);
        if (o.breakGlass) glass.set(entry, { id: loaded.id, original: raw, bg: o.breakGlass });
        denied ??= this.deniedFor(loaded.id, decision, boundary);
      } catch (e) {
        // the answer is not lost silently: a decision that says so is recorded, and when even that fails the evidence is marked incomplete
        try {
          const raw = this.noPack(loaded.id, "policy.invalid", input, mode);
          const o = loaded.layer === "mandatory" ? this.outage(loaded.id, raw, boundary) : { decision: raw };
          const decision = o.decision;
          this.log(`! policy ${loaded.id}: could not be evaluated at ${boundary} — recorded as ${decision.reasonCode}; ${decision.reasonCode === "policy.break-glass" ? "break-glass: the step goes on" : mode === "enforce" ? "the step is stopped" : "the run goes on"}`);
          const entry: LayeredDecision = { layer: loaded.layer, decision };
          decisions.push(entry);
          if (o.breakGlass) glass.set(entry, { id: loaded.id, original: raw, bg: o.breakGlass });
          denied ??= this.deniedFor(loaded.id, decision, boundary);
        } catch (e2) {
          this.fail(e2 ?? e);
          if (mode === "enforce") denied ??= { reason: deniedReason(loaded.id, "policy.invalid", boundary) };
        }
      }
    }
    return this.settle(boundary, decisions, glass, denied, step);
  }

  /** Records and logs the decisions of one question and applies break-glass where it was recorded. Never throws. */
  private settle(boundary: Boundary, decisions: LayeredDecision[], glass: Map<LayeredDecision, { id: string; original: PolicyDecision; bg: BreakGlass }>, denied: PolicyDenied | undefined, step?: StepIdentity): PolicyAnswer {
    const combined = combineDecisions(decisions);
    for (const ld of decisions) {
      let recorded = false;
      try {
        recorded = this.evidence?.policyDecided(ld.decision, step) ?? false;
      } catch (e) {
        this.fail(e);
      }
      const g = glass.get(ld);
      // the log shows what really happened: a break-glass that could not be recorded is logged as the enforced denial
      if (!g || recorded) this.logDecision(ld, step, decisions.length > 1 && ld === combined);
      if (!g) continue;
      if (recorded) {
        this.log(`! policy: break-glass active until ${g.bg.expiresAt} (${g.bg.reason}) — ${g.id} ${g.original.reasonCode} allowed`);
        continue;
      }
      // the override needs its audit record: without it the original denial stands
      this.log(`! policy ${g.id}: the break-glass decision could not be recorded — ${boundary} is denied`);
      this.logDecision({ layer: ld.layer, decision: g.original }, step, false);
      denied ??= this.deniedFor(g.id, g.original, boundary) ?? { reason: deniedReason(g.id, g.original.reasonCode as NoPackCode, boundary) };
    }
    return { decisions, ...(combined ? { combined } : {}), ...(denied ? { denied } : {}) };
  }

  /** What stops the step for one decision: nothing, the outage reason, or the reason of an enforced rule (never at `push`, where the pre-push hook decides). */
  private deniedFor(id: string, d: PolicyDecision, boundary: Boundary): PolicyDenied | undefined {
    if (d.mode !== "enforce" || d.outcome !== "deny") return undefined;
    const outage = d.reasonCode === "policy.unavailable" || d.reasonCode === "policy.invalid";
    if (!outage && boundary === "push") return undefined;
    const reason = outage ? deniedReason(id, d.reasonCode as NoPackCode, boundary) : ruleDeniedReason(d);
    try {
      const denial = policyDenial(d);
      return { reason, decision: d, ...(denial ? { denial } : {}) };
    } catch {
      return { reason };
    }
  }

  /** The question could not even be built: a recorded `policy.invalid` for the mandatory pack that guards this boundary, if any. Never throws. */
  private inputFailed(boundary: Boundary, facts: Facts, step?: StepIdentity): PolicyAnswer {
    let privileged = true;
    try {
      privileged = privilegedBoundary(boundary, facts);
    } catch {
      // counts as privileged
    }
    const mandatory = this.packs.filter((p) => p.layer === "mandatory");
    const entry = privileged ? mandatory[0] : this.enforcedAt.has(boundary) ? mandatory.find((p) => p.id === BASELINE_POLICY_ID) : undefined;
    if (!entry) return { decisions: [] };
    try {
      const raw = this.noPack(entry.id, "policy.invalid", { version: POLICY_INPUT_VERSION, boundary, runId: this.runId, facts: {} }, "enforce");
      const o = this.outage(entry.id, raw, boundary);
      const ld: LayeredDecision = { layer: entry.layer, decision: o.decision };
      const glass = new Map<LayeredDecision, { id: string; original: PolicyDecision; bg: BreakGlass }>();
      if (o.breakGlass) glass.set(ld, { id: entry.id, original: raw, bg: o.breakGlass });
      return this.settle(boundary, [ld], glass, this.deniedFor(entry.id, o.decision, boundary), step);
    } catch {
      return { decisions: [], denied: { reason: deniedReason(entry.id, "policy.invalid", boundary) } };
    }
  }

  /**
   * A step starts in the repository's checkout (with a sign-in or without one): asks repository.access. The facts that
   * describe how the step reaches it are kept for the pushes the step makes (see `pushes`).
   */
  repository(step: StepIdentity, facts: Facts): PolicyAnswer {
    this.access.set(stepKey(step), facts);
    return this.at("repository.access", facts, step);
  }

  /** The pushes a step made, as the pre-push hook saw them: one `push` question for each, with its own repository and branch. */
  pushes(step: StepIdentity, pushed: readonly ObservedPush[]): void {
    const known = this.access.get(stepKey(step)) ?? {};
    this.access.delete(stepKey(step));
    for (const p of pushed) {
      this.at(
        "push",
        { step: step.id, credential: known.credential, isolated: known.isolated, repository: p.repository, branch: p.branch, secretsFound: p.secretsFound, commitIdentity: p.commitIdentity },
        step,
      );
    }
  }

  private decide(loaded: LayeredPack, input: PolicyInput, mode: Mode): PolicyDecision {
    const at = this.now();
    if ("problem" in loaded) return this.noPack(loaded.id, loaded.problem, input, mode, at);
    let pack = loaded.pack;
    if (input.boundary === "push") {
      if (input.facts.repository === undefined && loaded.pushWithoutRepository) pack = loaded.pushWithoutRepository;
    } else if (input.boundary === "step.before" && input.facts.sandboxed === undefined && loaded.stepWithoutSandbox) pack = loaded.stepWithoutSandbox;
    else if (input.boundary === "step.after" && input.facts.contextUncited === undefined && loaded.stepWithoutCitations) pack = loaded.stepWithoutCitations;
    return evaluatePolicy(pack, input, at);
  }

  private noPack(id: string, reasonCode: NoPackCode, input: PolicyInput, mode: Mode, at = this.now()): PolicyDecision {
    return parsePolicyDecision({
      version: 1,
      policy: { id, version: UNKNOWN_POLICY_VERSION },
      mode,
      boundary: input.boundary,
      inputSha256: policyInputSha256(input),
      outcome: "deny",
      reasonCode,
      evaluatedAt: at,
    });
  }

  /** A mandatory outage denial while a break-glass is active: the warn decision that replaces it, with the record; otherwise the same decision. Never throws. */
  private outage(id: string, decision: PolicyDecision, boundary: Boundary): { decision: PolicyDecision; breakGlass?: BreakGlass } {
    if (decision.mode !== "enforce" || decision.outcome !== "deny") return { decision };
    if (decision.reasonCode !== "policy.unavailable" && decision.reasonCode !== "policy.invalid") return { decision };
    // no recorder, no audit record: no break-glass
    if (!this.evidence) return { decision };
    let bg: BreakGlass | undefined;
    try {
      bg = this.breakGlass();
    } catch {
      return { decision };
    }
    if (!bg) return { decision };
    try {
      const warn = parsePolicyDecision({
        version: 1,
        policy: { id, version: UNKNOWN_POLICY_VERSION },
        mode: "enforce",
        boundary,
        inputSha256: decision.inputSha256,
        outcome: "warn",
        reasonCode: "policy.break-glass",
        evaluatedAt: decision.evaluatedAt,
      });
      return { decision: warn, breakGlass: bg };
    } catch {
      return { decision };
    }
  }

  /** Logs one decision line; the first time a decision is seen, a "Why" line follows; a repeat carries a count and the first time. */
  private logDecision(ld: LayeredDecision, step: StepIdentity | undefined, wins: boolean): void {
    const d = ld.decision;
    const key = JSON.stringify([d.policy.id, d.policy.version, ld.layer, d.boundary, d.outcome, d.reasonCode, d.mode, d.rule ?? null]);
    const before = this.seen.get(key);
    let suffix = "";
    if (before) {
      before.count++;
      suffix = ` · seen ${before.count} times, first at ${before.first}, now ${d.evaluatedAt}`;
    } else if (this.seen.size < MAX_SEEN_KEYS) this.seen.set(key, { count: 1, first: d.evaluatedAt });
    this.log(`· policy ${d.policy.id} ${d.policy.version} [${ld.layer}] · ${d.boundary}${step ? ` ${stepName(step)}` : ""}: ${d.outcome} (${d.reasonCode}${d.rule ? `, rule ${d.rule}` : ""})${wins ? " · wins" : ""} — ${logNote(d)}${suffix}`);
    if (!before) this.log(explanationLine(d));
  }

  private fail(e: unknown): void {
    this.log("! policy: a decision could not be made or recorded; the run goes on");
    this.evidence?.incomplete(e);
  }
}

/** The mandatory baseline entry of a run. Never throws: a baseline that cannot be built is a `policy.invalid` entry (no weaker fallback). */
export function baselineEntry(version: string, controls: BaselineControls): LayeredPack {
  try {
    const { pack, pushWithoutRepository, stepWithoutSandbox, stepWithoutCitations } = runBaseline(version, controls);
    return { layer: "mandatory", id: BASELINE_POLICY_ID, pack, stepWithoutSandbox, stepWithoutCitations, ...(pushWithoutRepository ? { pushWithoutRepository } : {}) };
  } catch (e) {
    return { layer: "mandatory", ...invalid(BASELINE_POLICY_ID, e instanceof PolicySchemaError ? (e.message.split("\n")[0] ?? "could not be built") : "could not be built") };
  }
}

/**
 * The policy of one start of a run: always there, with the baseline first, built from the settings and the run
 * (protected branches, secret scan, repository, shipped flow). Files are read only for the packs that are
 * configured. The baseline is asked at `push` only when the pre-push hook is installed (see `observesPushes`).
 * Its limit rules come from the flow and the config (`baselineLimits`); a sub-flow gets its own (see `RunPolicy.subFlow`).
 * Logs one "!" line per pack that could not be loaded, and one for patterns the baseline cannot hold.
 */
export function runPolicy(
  summary: RunSummary,
  config: Pick<Config, "policy"> & Partial<Pick<Config, "protected_branches" | "secret_scan" | "cost_limits" | "daily_budget_usd">>,
  log: (line: string) => void,
  evidence?: RunRecorder,
  home?: string,
): RunPolicy {
  const shipped = isShippedFlow(summary.flowDef);
  const base = policyFacts({ ...baseFacts(summary), shippedFlow: shipped });
  let limits: ReturnType<typeof baselineLimits> | undefined;
  let limitsFailed = false;
  try {
    limits = baselineLimits(summary.flowDef, config);
  } catch {
    limitsFailed = true; // the baseline is then invalid: no weaker fallback
  }
  const { controls, leftOut, leftOutPaths } = baselineControls(config, { forbiddenPaths: summary.vars?.forbidden_paths, repository: base.repository, shippedHotfixFlow: shipped && summary.flowDef?.name === HOTFIX_FLOW, ...(limits ? { limits } : {}) });
  if (leftOut.length) {
    const shown = leftOut.slice(0, 10).map((p) => JSON.stringify(p)).join(", ");
    log(`! policy ${BASELINE_POLICY_ID}: protected branch patterns ${shown}${leftOut.length > 10 ? ` and ${leftOut.length - 10} more` : ""} cannot be expressed in the baseline (? [ ] \\, other spaces or control characters, or over 255 characters) and are not in it — the hook still blocks them`);
  }
  if (leftOutPaths.length) {
    const shown = leftOutPaths.slice(0, 10).map((p) => JSON.stringify(p)).join(", ");
    log(`! policy ${BASELINE_POLICY_ID}: forbidden path patterns ${shown}${leftOutPaths.length > 10 ? ` and ${leftOutPaths.length - 10} more` : ""} cannot be expressed in the baseline (spaces, control characters, or over 255 characters) and are not in it — the guard step still checks them`);
  }
  const entry: LayeredPack = limitsFailed ? { layer: "mandatory", ...invalid(BASELINE_POLICY_ID, "its limits could not be read") } : baselineEntry(BASELINE_VERSION, controls);
  if ("problem" in entry) log(`! policy ${entry.id}: ${entry.detail} — recorded as ${entry.problem}; ${outageScope(controls.enforce ?? [])}`);
  const ids = layeredPackIds({ mandatory: config.policy?.mandatory, repositories: config.policy?.repositories, packs: config.policy?.packs }, base.repository);
  const loaded = ids.length
    ? loadPolicyPacks(
        ids.map((i) => i.id),
        home,
      )
    : [];
  loaded.forEach((p, i) => {
    if ("problem" in p) {
      const tail = ids[i]!.layer === "mandatory" ? "this mandatory policy denies steps with a sign-in and writing agents" : "the run goes on";
      log(`! policy ${p.id}: ${p.detail} — recorded as ${p.problem}; ${tail}`);
    } else if (ids[i]!.layer === "mandatory") saveLastKnownGood(home ?? dataHome(), p.id, p.pack, log);
  });
  const packs: LayeredPack[] = [entry,...loaded.map((l, i) => ({ ...l, layer: ids[i]!.layer }))];
  const scopedBaseline = (s?: { flow: Flow; depth: number }): LayeredPack =>
    baselineEntry(BASELINE_VERSION, { ...controls, limits: { ...limits, ...(s ? stepLimits(s.flow, s.depth, config) : NO_STEP_LIMITS) } });
  return new RunPolicy({ runId: summary.runId, packs, base, log, evidence, observesPushes: ids.length > 0, enforce: controls.enforce, breakGlass: () => activeBreakGlass(home ?? dataHome()), scopedBaseline });
}
