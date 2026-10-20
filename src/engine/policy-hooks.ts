import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../auth/store.js";
import type { Config } from "../config.js";
import type { StepIdentity } from "../evidence/identity.js";
import type { Denial } from "../evidence/schema.js";
import type { RunRecorder } from "../evidence/record.js";
import { BASELINE_PACK, BASELINE_POLICY_ID } from "../policy/baseline.js";
import { combineDecisions, layeredPackIds, type Layer, type LayeredDecision } from "../policy/compose.js";
import { parsePolicyDecision, parsePolicyPack } from "../policy/parse.js";
import { evaluatePolicy, policyDenial, policyInputSha256 } from "../policy/evaluate.js";
import { FactsSchema, type Boundary, type FactName, type Facts, type Mode, type PolicyDecision, type PolicyInput, type PolicyPack } from "../policy/schema.js";
import { POLICY_INPUT_VERSION, PolicySchemaError } from "../policy/version.js";
import { saveLastKnownGood } from "./policy-store.js";
import { userAccount } from "./isolation.js";
import type { RunSummary } from "./state.js";

/**
 * The baseline and the policy packs asked at the boundaries of a run, in observe mode: every decision is logged and
 * recorded as evidence, and nothing in the run changes because of it. The one exception is fail closed: a pack in the
 * mandatory layer that cannot be loaded or evaluated denies the privileged boundaries (see `privilegedBoundary`).
 * Nothing here throws into the engine.
 * The baseline is built in and always asked; it is asked at `push` only when the pre-push hook is installed.
 */

export const POLICY_FOLDER = "policies";
export const MAX_PACK_BYTES = 1 << 20;
export const UNKNOWN_POLICY_VERSION = "unknown";

export type LoadedPack =
  | { id: string; pack: PolicyPack }
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
  if (pack.mode !== "observe") return invalid(id, `mode ${pack.mode} is not supported yet: set mode to observe`);
  return { id, pack };
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

/** The facts every boundary of this run has (repository, flow, workspace, owner). */
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

  constructor(o: { runId: string; packs: LayeredPack[]; base: Facts; log: (line: string) => void; evidence?: RunRecorder; now?: () => string; observesPushes?: boolean }) {
    this.observesPushes = o.observesPushes ?? false;
    this.mandatoryUnusable = o.packs.some((p) => p.layer === "mandatory" && "problem" in p);
    this.runId = o.runId;
    this.packs = o.packs;
    this.base = o.base;
    this.log = o.log;
    this.evidence = o.evidence;
    this.now = o.now ?? (() => new Date().toISOString());
  }

  /**
   * Asks every pack at one boundary; logs and records each decision; returns them and the winner. Never throws.
   * Observe only, except: a mandatory pack that cannot be loaded or evaluated at a privileged boundary sets `denied`.
   */
  at(boundary: Boundary, facts: Facts = {}, step?: StepIdentity): PolicyAnswer {
    const decisions: LayeredDecision[] = [];
    let denied: PolicyDenied | undefined;
    let input: PolicyInput;
    try {
      input = { version: POLICY_INPUT_VERSION, boundary, runId: this.runId, facts: policyFacts({ ...this.base, ...facts }) };
    } catch (e) {
      this.fail(e);
      let privileged = true;
      try {
        privileged = privilegedBoundary(boundary, facts);
      } catch {
        // counts as privileged
      }
      const first = this.packs.find((p) => p.layer === "mandatory");
      return privileged && first ? { decisions, denied: { reason: deniedReason(first.id, "policy.invalid", boundary) } } : { decisions };
    }
    for (const loaded of this.packs) {
      const mode: Mode = loaded.layer === "mandatory" && privilegedBoundary(boundary, input.facts) ? "enforce" : "observe";
      try {
        const decision = this.decide(loaded, input, mode);
        decisions.push({ layer: loaded.layer, decision });
        if (decision.mode === "enforce" && decision.outcome === "deny") {
          const denial = policyDenial(decision);
          denied ??= { reason: deniedReason(loaded.id, decision.reasonCode as NoPackCode, boundary), decision, ...(denial ? { denial } : {}) };
        }
      } catch (e) {
        // the answer is not lost silently: a decision that says so is recorded, and when even that fails the evidence is marked incomplete
        try {
          const decision = this.noPack(loaded.id, "policy.invalid", input, mode);
          this.log(`! policy ${loaded.id}: could not be evaluated at ${boundary} — recorded as policy.invalid; ${mode === "enforce" ? "the step is stopped" : "the run goes on"}`);
          decisions.push({ layer: loaded.layer, decision });
          if (mode === "enforce") {
            const denial = policyDenial(decision);
            denied ??= { reason: deniedReason(loaded.id, "policy.invalid", boundary), decision, ...(denial ? { denial } : {}) };
          }
        } catch (e2) {
          this.fail(e2 ?? e);
          if (mode === "enforce") denied ??= { reason: deniedReason(loaded.id, "policy.invalid", boundary) };
        }
      }
    }
    const combined = combineDecisions(decisions);
    for (const ld of decisions) {
      try {
        this.report(ld, step, decisions.length > 1 && ld === combined);
      } catch (e) {
        this.fail(e);
      }
    }
    return { decisions, ...(combined ? { combined } : {}), ...(denied ? { denied } : {}) };
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
        { step: step.id, credential: known.credential, isolated: known.isolated, shippedFlow: known.shippedFlow, repository: p.repository, branch: p.branch, secretsFound: p.secretsFound, commitIdentity: p.commitIdentity },
        step,
      );
    }
  }

  private decide(loaded: LayeredPack, input: PolicyInput, mode: Mode): PolicyDecision {
    const at = this.now();
    if ("problem" in loaded) return this.noPack(loaded.id, loaded.problem, input, mode, at);
    return evaluatePolicy(loaded.pack, input, at);
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

  private report(ld: LayeredDecision, step: StepIdentity | undefined, wins: boolean): void {
    const d = ld.decision;
    this.log(`· policy ${d.policy.id} ${d.policy.version} [${ld.layer}] · ${d.boundary}${step ? ` ${stepName(step)}` : ""}: ${d.outcome} (${d.reasonCode}${d.rule ? `, rule ${d.rule}` : ""})${wins ? " · wins" : ""} ${d.mode === "enforce" ? "— enforced: the step is stopped" : "— observe only, nothing was stopped"}`);
    this.evidence?.policyDecided(d, step);
  }

  private fail(e: unknown): void {
    this.log("! policy: a decision could not be made or recorded; the run goes on");
    this.evidence?.incomplete(e);
  }
}

/**
 * The policy of one start of a run: always there, with the baseline first. Files are read only for the packs that are
 * configured. The baseline is asked at `push` only when the pre-push hook is installed (see `observesPushes`).
 * Logs one "!" line per pack that could not be loaded.
 */
export function runPolicy(summary: RunSummary, config: Pick<Config, "policy">, log: (line: string) => void, evidence?: RunRecorder, home?: string): RunPolicy {
  const base = baseFacts(summary);
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
  const packs: LayeredPack[] = [{ layer: "mandatory", id: BASELINE_POLICY_ID, pack: BASELINE_PACK }, ...loaded.map((l, i) => ({ ...l, layer: ids[i]!.layer }))];
  return new RunPolicy({ runId: summary.runId, packs, base, log, evidence, observesPushes: ids.length > 0 });
}
