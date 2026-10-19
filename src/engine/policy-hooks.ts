import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataHome } from "../auth/store.js";
import type { Config } from "../config.js";
import type { StepIdentity } from "../evidence/identity.js";
import type { RunRecorder } from "../evidence/record.js";
import { BASELINE_PACK, BASELINE_POLICY_ID } from "../policy/baseline.js";
import { combineDecisions, layeredPackIds, type Layer, type LayeredDecision } from "../policy/compose.js";
import { parsePolicyDecision, parsePolicyPack } from "../policy/parse.js";
import { evaluatePolicy, policyInputSha256 } from "../policy/evaluate.js";
import { FactsSchema, type Boundary, type FactName, type Facts, type PolicyDecision, type PolicyInput, type PolicyPack } from "../policy/schema.js";
import { POLICY_INPUT_VERSION, PolicySchemaError } from "../policy/version.js";
import { userAccount } from "./isolation.js";
import type { RunSummary } from "./state.js";

/**
 * The baseline and the policy packs asked at the boundaries of a run, in observe mode: every decision is logged and
 * recorded as evidence, and nothing in the run changes because of it. Nothing here throws into the engine.
 * The baseline is built in and always asked; it is asked at `push` only when the pre-push hook is installed.
 */

export const POLICY_FOLDER = "policies";
export const MAX_PACK_BYTES = 1 << 20;
export const UNKNOWN_POLICY_VERSION = "unknown";

export type LoadedPack =
  | { id: string; pack: PolicyPack }
  | { id: string; problem: "policy.unavailable" | "policy.invalid"; detail: string };

export type LayeredPack = LoadedPack & { layer: Layer };
export interface PolicyAnswer {
  decisions: LayeredDecision[];
  combined?: LayeredDecision;
}

const unavailable = (id: string, detail: string): LoadedPack => ({ id, problem: "policy.unavailable", detail });
const invalid = (id: string, detail: string): LoadedPack => ({ id, problem: "policy.invalid", detail });

function loadOne(id: string, home: string): LoadedPack {
  const name = `${POLICY_FOLDER}/${id}.json`;
  let fd: number;
  try {
    // never follows a link and never waits for a pipe
    fd = openSync(join(home, POLICY_FOLDER, `${id}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return unavailable(id, code === "ENOENT" || code === "ENOTDIR" ? `no file ${name}` : code === "ELOOP" ? "not a plain file" : "could not be read");
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return unavailable(id, "not a plain file");
    if (st.size > MAX_PACK_BYTES) return invalid(id, "larger than 1 MiB");
    const buf = Buffer.alloc(st.size);
    let done = 0;
    while (done < buf.length) {
      const n = readSync(fd, buf, done, buf.length - done, done);
      if (n === 0) break;
      done += n;
    }
    text = buf.subarray(0, done).toString("utf8");
  } catch {
    return unavailable(id, "could not be read");
  } finally {
    closeSync(fd);
  }
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

  constructor(o: { runId: string; packs: LayeredPack[]; base: Facts; log: (line: string) => void; evidence?: RunRecorder; now?: () => string; observesPushes?: boolean }) {
    this.observesPushes = o.observesPushes ?? false;
    this.runId = o.runId;
    this.packs = o.packs;
    this.base = o.base;
    this.log = o.log;
    this.evidence = o.evidence;
    this.now = o.now ?? (() => new Date().toISOString());
  }

  /** Asks every pack at one boundary; logs and records each decision; returns them and the winner. Never throws; decides nothing for the run. */
  at(boundary: Boundary, facts: Facts = {}, step?: StepIdentity): PolicyAnswer {
    const decisions: LayeredDecision[] = [];
    let input: PolicyInput;
    try {
      input = { version: POLICY_INPUT_VERSION, boundary, runId: this.runId, facts: policyFacts({ ...this.base, ...facts }) };
    } catch (e) {
      this.fail(e);
      return { decisions };
    }
    for (const loaded of this.packs) {
      try {
        decisions.push({ layer: loaded.layer, decision: this.decide(loaded, input) });
      } catch (e) {
        // the answer is not lost silently: a decision that says so is recorded, and when even that fails the evidence is marked incomplete
        try {
          const decision = this.noPack(loaded.id, "policy.invalid", input);
          this.log(`! policy ${loaded.id}: could not be evaluated at ${boundary} — recorded as policy.invalid; the run goes on`);
          decisions.push({ layer: loaded.layer, decision });
        } catch (e2) {
          this.fail(e2 ?? e);
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
    return combined ? { decisions, combined } : { decisions };
  }

  /**
   * A step starts in the repository's checkout (with a sign-in or without one): asks repository.access. The facts that
   * describe how the step reaches it are kept for the pushes the step makes (see `pushes`).
   */
  repository(step: StepIdentity, facts: Facts): void {
    this.access.set(stepKey(step), facts);
    this.at("repository.access", facts, step);
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

  private decide(loaded: LayeredPack, input: PolicyInput): PolicyDecision {
    const at = this.now();
    if ("problem" in loaded) return this.noPack(loaded.id, loaded.problem, input, at);
    return evaluatePolicy(loaded.pack, input, at);
  }

  private noPack(id: string, reasonCode: "policy.unavailable" | "policy.invalid", input: PolicyInput, at = this.now()): PolicyDecision {
    return parsePolicyDecision({
      version: 1,
      policy: { id, version: UNKNOWN_POLICY_VERSION },
      mode: "observe",
      boundary: input.boundary,
      inputSha256: policyInputSha256(input),
      outcome: "deny",
      reasonCode,
      evaluatedAt: at,
    });
  }

  private report(ld: LayeredDecision, step: StepIdentity | undefined, wins: boolean): void {
    const d = ld.decision;
    this.log(`· policy ${d.policy.id} ${d.policy.version} [${ld.layer}] · ${d.boundary}${step ? ` ${stepName(step)}` : ""}: ${d.outcome} (${d.reasonCode}${d.rule ? `, rule ${d.rule}` : ""})${wins ? " · wins" : ""} — observe only, nothing was stopped`);
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
  for (const p of loaded) {
    if ("problem" in p) log(`! policy ${p.id}: ${p.detail} — recorded as ${p.problem}; the run goes on`);
  }
  const packs: LayeredPack[] = [{ layer: "mandatory", id: BASELINE_POLICY_ID, pack: BASELINE_PACK }, ...loaded.map((l, i) => ({ ...l, layer: ids[i]!.layer }))];
  return new RunPolicy({ runId: summary.runId, packs, base, log, evidence, observesPushes: ids.length > 0 });
}
