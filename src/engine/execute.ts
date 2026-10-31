import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { deliveryAfterStep, deliveryKeyEnv } from "../delivery/write.js";
import { FACTORY_HOME } from "../home.js";
import { loadFlow } from "../flow/load.js";
import type { Flow, Step } from "../flow/schema.js";
import { runAgentStep } from "../agents/run.js";
import type { Target } from "../agents/targets.js";
import type { ProcessMeter } from "../steps/process.js";
import { runShell } from "../steps/shell.js";
import { isRefinementRun } from "../auth/run-owner.js";
import { KEY_UNREADABLE } from "../auth/repos.js";
import { DEPLOY_KEY_NO_GH, KEY_NOT_READY, KEY_REFUSED_RUN, APP_REFUSED_RUN, APP_TOKEN_EXPIRED, SIGN_IN_NOT_REMOVED, TOKEN_REFUSED_REASON, TOKEN_REFUSED_RUN, grantPush, keyRefused, pushAllowEnv, stepMaxOutput, tokenRefused } from "./guards.js";
import { IDENTITY_VARS, isolationEnv, stepIsolation } from "./isolation.js";
import { appTokenAccess, ghConfigDir, ghStandInCalled, prepareKeyStep, removeGhConfigDir, removeSignInDir, repoTokenEnv, stepRepoAccess } from "./repo-access.js";
import { sandboxedRun, sandboxHomeEnv, sandboxProfile, stepSandboxPaths, wrapsStep } from "./os-sandbox.js";
import { stepContextUncited } from "./context-index.js";
import { claimAfterResolve } from "./release-claim.js";
import { readDecidedQuestions } from "./questions.js";
import { readRunOutputs } from "./run-outputs.js";
import { shortEnv,shortEnvRun } from "./short-env.js";
import { shellImage, shellSandboxed, stepAfterPaths } from "./step-facts.js";
import type { RunSummary, StepRecord } from "./state.js";
import { GitIdentitySchema, RepositorySchema, type Actor, type StepIdentity } from "../evidence/identity.js";
import { emitLiveTelemetry, telemetryEnabled } from "../telemetry/telemetry.js";
import { stepIdentity, type RunRecorder } from "../evidence/record.js";
import { drainPushLog, pushLogFile, repositoryFact, type PolicyAnswer, type PolicyDenied, type RunPolicy } from "./policy-hooks.js";
import { outputEnvName, ranEnvName, varEnvName, withScfAliases, type TemplateContext } from "./template.js";
import { boundEnv, capEnvValue, labelOutput, renderTrusted, stepTypesOf, trustOf, type OutputClassifier } from "./untrusted.js";

/** Shell commands may only template trusted values; task and outputs go via env. */
export const SHELL_TEMPLATE_ROOTS = ["vars", "workdir", "run"] as const;
export const DEFAULT_PERMISSION_MODE = "acceptEdits";
export const MAX_FLOW_DEPTH = 5;

export type StepContext = TemplateContext & {
  vars: Record<string, string>;
  steps: Record<string, Record<string, unknown>>;
  run: Record<string, unknown>;
};

/** One flow being executed: the top-level flow or a sub-flow. */
export interface Scope {
  flow: Flow;
  ctx: StepContext;
  visits: Record<string, number>;
  /** History id prefix for sub-flow steps, e.g. "build/". */
  prefix: string;
  depth: number;
}

export type Outcome = "succeeded" | "failed" | "stopped" | "waiting" | "cancelled";

export interface LoopResult {
  outcome: Outcome;
  reason?: string;
  /** Step to continue from if the run is resumed. */
  next: string | null;
  lastOutput: string;
  /** Evidence only: the step whose failure ended the loop. */
  failedStep?: StepIdentity;
}

export interface Engine {
  summary: RunSummary;
  config: Config;
  baseEnv: Record<string, string>;
  /** The bot's name and token (asked once per run). Only for steps that keep the machine's login. Not fetched up front when a mandatory policy cannot be used. */
  botEnv: () => Promise<Record<string, string>>;
  /** Whether this run may take the hotfix path (see hotfixState); "off" when unset. */
  hotfix?: "on" | "off" | "other";
  logsDir: string;
  claudeBin?: string;
  codexBin?: string;
  /** The declared tool profile saved with the run (`null`: it could not be read). Undefined: generated profiles. */
  toolProfile?: unknown;
  signal?: AbortSignal;
  /** Asked before each top-level step: a non-empty answer stops the run there with that reason (the step runs on resume). */
  stopBefore?: (stepId: string) => string | undefined;
  /** Set once a budget is used up and a free fallback exists: all agent steps run there. */
  budgetFallback?: Target;
  /** Today's spend in US dollars, for the policy's daily budget rule. Only set when a daily budget is in effect. */
  dailyCostUsd?: () => number;
  log: (msg: string) => void;
  save: () => void;
  /** Remaining budget in USD for the next claude call (undefined = unlimited). */
  remainingBudget: () => number | undefined;
  runLoop: (scope: Scope, startAt: string | null) => Promise<LoopResult>;
  /** Set when a token step could not sign in: the run ends there, `on_failure` is not followed. */
  accessFailed?: boolean;
  /** A human decision for the approval step the run is waiting at (consumed on use). */
  decision?: ApprovalDecision & { stepId: string };
  /** Writes the evidence events of the run; it never throws. Absent: no evidence is written. */
  evidence?: RunRecorder;
  /** Asks the baseline and the configured policy packs at the boundaries of the run (observe mode; a mandatory pack that cannot be used denies privileged boundaries, see `refuseByPolicy`); always there for a run started by the engine. */
  policy?: RunPolicy;
  /** Evidence only: who asked for this start or resume (and so who decided at an approval step). */
  actor?: Actor;
  /** Optional content classifier (tests only; the server sets none). It can only raise risk, quarantine or require approval. */
  classifier?: OutputClassifier;
  /** The delivery settings, read again for each step. */
  deliverySettings?: () => Config["delivery"];
}

export interface ApprovalDecision {
  approved: boolean;
  by?: string;
  note?: string;
}

export type StepResult = Pick<StepRecord, "ok" | "output" | "error" | "exitCode" | "sessionId" | "codexHome" | "costUsd" | "agent" | "tokens" | "limited" | "denied" | "unreachable" | "retried" | "tools" | "contextTokens" | "skills" | "skillCatalogue" | "held"> & {
  /** A shell step printed more than it kept. Not stored in the record: it shows as the `oversize` signal of its label. */
  oversize?: boolean;
};

/** Position (1-based) of each step's latest record in the run history, for the steps of `scope` (keys without the scope prefix). */
export function ranOrder(history: Pick<StepRecord, "id" | "parent">[], prefix: string): Record<string, number> {
  const parent = prefix.slice(0, -1);
  const out: Record<string, number> = {};
  history.forEach((h, i) => {
    if ((h.parent ?? "") !== parent || !h.id.startsWith(prefix)) return;
    out[h.id.slice(prefix.length)] = i + 1;
  });
  return out;
}

export function stepEnv(scope: Scope, engine: Engine, step?: Pick<Step, "id">, o: { bound?: (env: Record<string, string>) => Record<string, string> } = {}): Record<string, string> {
  const hotfix = engine.hotfix ?? "off";
  // Never inherited from the server's own environment: only pushAllowEnv() can set it, for one step.
  const env: Record<string, string> = { ...engine.baseEnv, FACTORY_HOTFIX: hotfix, FACTORY_PUSH_ALLOW: "" };
  if (step) Object.assign(env, pushAllowEnv(step, scope.depth, scope.ctx.vars, hotfix));
  for (const [k, v] of Object.entries(scope.ctx.vars)) env[varEnvName(k)] = v;
  for (const [id, s] of Object.entries(scope.ctx.steps)) env[outputEnvName(id)] = capEnvValue(String(s.output ?? ""), `steps.${id}.output`);
  const ran = ranOrder(engine.summary?.history ?? [], scope.prefix);
  for (const id of Object.keys(scope.ctx.steps)) if (ran[id]) env[ranEnvName(id)] = String(ran[id]);
  // Every consumer gets untrusted values scrubbed (secrets and configured patterns) before the step's own credentials are
  // added by the callers. An agent step may also quarantine them (`bound`). The SCF_ aliases get the same values.
  const scrubbed = boundEnv(env, { stepTypes: stepTypesOf(scope.flow), patterns: engine.config.help.sensitive_patterns });
  // The trusted public key comes only from the engine, never from the server's own environment: a missing value is blank.
  const keyEnv = { FACTORY_DELIVERY_PUBLIC_KEY: "", ...deliveryKeyEnv((engine.deliverySettings ?? (() => engine.config?.delivery))(), process.env.FACTORY_HOME ?? FACTORY_HOME) };
  return withScfAliases({ ...(o.bound ? o.bound(scrubbed) : scrubbed), ...keyEnv });
}

export function historySummary(summary: RunSummary): string {
  return summary.history
    .map((h) => `- ${h.id}${h.visit > 1 ? ` (visit ${h.visit})` : ""}: ${h.ok ? "ok" : `FAILED${h.error ? ` — ${h.error}` : ""}`}`)
    .join("\n");
}

/** The label of a step's output, saved with its record. */
export function outputLabel(step: Step, scope: Scope, res: StepResult): StepRecord["label"] {
  const path = `steps.${step.id}.output`;
  const oversize = step.type === "shell" && res.oversize === true;
  return labelOutput(res.output, { path, kind: trustOf(path, stepTypesOf(scope.flow)).kind ?? "log", step: step.id, stepType: step.type }, { timedOut: res.error === "timed out", oversize });
}

/** Store a finished step in history and in the scope's template context. */
export function recordStep(step: Step, scope: Scope, engine: Engine, res: StepResult, startedAt: Date, logFile: string, visit: number, meter?: ProcessMeter, paths?: string[]): StepRecord {
  const { oversize: _oversize, ...stored } = res;
  const rec: StepRecord = {
    id: scope.prefix + step.id,
    label: outputLabel(step, scope, res),
    type: step.type,
    visit,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    logFile,
    ...stored,
    ...(engine.accessFailed && !res.ok ? { accessFailed: true } : {}),
    ...(scope.prefix ? { parent: scope.prefix.slice(0, -1) } : {}),
  };
  engine.summary.history.push(rec);
  engine.summary.totalCostUsd += res.costUsd ?? 0;
  scope.ctx.steps[step.id] = {
    ok: res.ok,
    output: res.output,
    error: res.error ?? "",
    exit_code: res.exitCode ?? "",
    session_id: res.sessionId ?? "",
    codex_home: res.codexHome ?? "",
    agent: res.agent ?? "",
    skills_digest: res.skills?.digest ?? "",
    visit,
  };
  if (!scope.prefix) {
    try {
      const line = claimAfterResolve({ flow: engine.summary.flow, stepId: step.id, ok: res.ok, runDir: engine.summary.runDir, runId: engine.summary.runId, vars: scope.ctx.vars });
      if (line) engine.log(line);
    } catch (e) {
      engine.log(`  release commit claim failed: ${(e as Error).message}`);
    }
  }
  const outputs = readRunOutputs(engine.summary.runDir, engine.log);
  if (outputs) engine.summary.outputs = { ...engine.summary.outputs, ...outputs };
  const decided = readDecidedQuestions(engine.summary.runDir, engine.log);
  if (decided?.length) engine.summary.decidedQuestions = decided;
  engine.save();
  const identity = stepIdentity(step, scope.prefix, visit);
  let daily: number | undefined;
  try {
    daily = engine.dailyCostUsd?.();
  } catch {
    daily = undefined;
  }
  // A process step counts only the final attempt's process time (no setup, no retries); a shell step counts what it printed, also when the call was rejected.
  const measured = step.type === "claude" || step.type === "shell";
  // step.after is asked before the step's end is recorded: an enforced deny can still turn the step into a failed one.
  const after = engine.policy?.at(
    "step.after",
    {
      repository: repositoryFact(scope.ctx.vars),
      step: step.id,
      outputBytes: step.type === "shell" && meter?.printedBytes !== undefined ? meter.printedBytes : Buffer.byteLength(res.output ?? "", "utf8"),
      elapsedMs: Math.max(0, Math.round(measured ? (meter?.ms ?? 0) : rec.durationMs)),
      stepCostUsd: res.costUsd ?? 0,
      runCostUsd: engine.summary.totalCostUsd,
      dailyCostUsd: daily,
      paths,
      contextUncited: stepContextUncited({ summary: engine.summary, step, topLevel: !scope.prefix, output: res.output }),
    },
    identity,
  );
  if (after?.denied) {
    const reason = refuseByPolicy(engine, identity, after.denied).error!;
    rec.error = res.ok || !rec.error ? reason : `${rec.error}; ${reason}`;
    rec.ok = false;
    rec.accessFailed = true;
    delete rec.held;
    delete rec.limited;
    scope.ctx.steps[step.id]!.ok = false;
    scope.ctx.steps[step.id]!.error = rec.error;
    engine.save();
  }
  engine.evidence?.stepEnded(rec);
  if (!scope.prefix) deliveryAfterStep(engine);
  const pushed = drainPushLog(pushLogFile(engine.summary.runDir, scope.prefix + step.id, visit));
  engine.policy?.pushes(identity, pushed);
  for (const p of pushed) {
    emitLiveTelemetry("delivery", "delivery.push_attempted", {
      runId: engine.summary.runId,
      step: identity,
      ...(p.repository && RepositorySchema.safeParse(p.repository).success ? { repository: p.repository } : {}),
      ...(GitIdentitySchema.shape.branch.safeParse(p.branch).success ? { branch: p.branch } : {}),
    });
  }
  const secs =(rec.durationMs / 1000).toFixed(1);
  const tok = res.tokens ? `, ${Math.round((res.tokens.input + res.tokens.output) / 1000)}k tok` : "";
  engine.log(`${rec.ok ? "✔" : "✘"} ${rec.id} (${secs}s${res.costUsd ? `, $${res.costUsd.toFixed(4)}` : ""}${tok})${rec.error ? ` — ${rec.error}` : ""}`);
  return rec;
}

/**
 * Where the pre-push hook logs the pushes of this visit of a step (FACTORY_PUSH_LOG). Undefined without policy packs,
 * unless telemetry is on and the protected-branch/secret-scan hook is installed anyway; the hook is never installed for this.
 * Also undefined when the folder can't be made.
 */
export function pushLogFor(engine: Engine, scope: Scope, step: Pick<Step, "id">, visit: number): string | undefined {
  const hook = engine.config.protected_branches.length > 0 || engine.config.secret_scan;
  if (!engine.policy && !(telemetryEnabled() && hook)) return undefined;
  const file = pushLogFile(engine.summary.runDir, scope.prefix + step.id, visit);
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch {
    return undefined; // pushes are then not observed; the step runs as before
  }
  return file;
}

/** A visit of a step begins: the evidence event, then the policy question for `step.before`. Every step visit passes here. */
export function beginStep(engine: Engine, scope: Scope, step: Pick<Step, "id" | "type"> & { sandbox?: boolean }, identity: StepIdentity): PolicyAnswer | undefined {
  engine.evidence?.stepStarted(identity);
  return engine.policy?.at("step.before", { repository: repositoryFact(scope.ctx.vars), step: step.id, sandboxed: shellSandboxed(engine, scope, step) }, identity);
}

/** A mandatory policy cannot be used at a privileged boundary: the step is refused and the run ends there (`on_failure` is not followed). */
export function refuseByPolicy(engine: Engine, step: StepIdentity, denied: PolicyDenied): StepResult {
  engine.accessFailed = true;
  if (denied.denial) engine.evidence?.stepDenied(step, denied.denial);
  engine.log(`    ! ${denied.reason}`);
  return { ok: false, output: denied.reason, error: denied.reason };
}

/** An enforced policy refused the run itself (run.start, run.complete): logged and recorded as a step.denied without a step. Returns the reason. */
export function refuseRunByPolicy(to: Pick<Engine, "log" | "evidence">, denied: PolicyDenied): string {
  if (denied.denial) to.evidence?.runDenied(denied.denial);
  to.log(`! ${denied.reason}`);
  return denied.reason;
}

/** Log file of the step that runs after `historyLength` finished steps. */
export function stepLogFile(logsDir: string, historyLength: number, id: string): string {
  return join(logsDir, `${String(historyLength + 1).padStart(3, "0")}-${id.replace(/\//g, "__")}.log`);
}

export function newLogFile(engine: Engine, id: string): string {
  return stepLogFile(engine.logsDir, engine.summary.history.length, id);
}

/** Execute a claude, shell, parallel or flow step (approvals are handled by the loop). */
export async function executeStep(step: Step, scope: Scope, engine: Engine, logFile: string, meter?: ProcessMeter): Promise<StepResult> {
  const d = scope.flow.defaults;
  const timeoutSec = step.timeout_sec ?? d.timeout_sec;
  const timeoutMs = timeoutSec ? timeoutSec * 1000 : undefined;
  const { ctx } = scope;
  ctx.run.history = historySummary(engine.summary);

  switch (step.type) {
    case "claude":
      return runAgentStep(step, scope, engine, logFile, timeoutMs, meter);

    case "shell": {
      const image = shellImage(scope, engine);
      if (step.sandbox && !image) engine.log(`    ⚠ ${step.id}: not sandboxed (no sandbox.docker_image configured)`);
      const env = stepEnv(scope, engine, step);
      // The stored token of the repository, looked up now, only for a step with repo_access (or the old grant by name).
      const access = stepRepoAccess(step, scope.depth, scope.flow.name, engine.summary, ctx.vars);
      // A step that cannot sign in ends the run there: `on_failure` is not followed.
      const refuse = (reason: string): StepResult => {
        engine.accessFailed = true;
        return { ok: false, output: reason, error: reason };
      };
      if (access?.kind === "refused") {
        if (access.detail) engine.log(`    ! ${step.id}: the stored ${access.reason === KEY_UNREADABLE ? "deploy key" : "token"} could not be read: ${access.detail}`);
        return refuse(access.reason);
      }
      // A step of an isolated run never sees the machine's login or the bot's token (see isolation.ts).
      const holds = access?.kind === "token" || access?.kind === "app" || access?.kind === "key";
      const iso = stepIsolation(engine, ctx.vars, holds);
      if (iso && "refused" in iso) return refuse(iso.refused);
      // The step works in the repository's checkout, with a sign-in or without one (policy: a mandatory policy that cannot be used stops it).
      const identity = stepIdentity(step, scope.prefix, scope.visits[step.id] ?? 1);
      const asked = engine.policy?.repository(identity, {
        repository: repositoryFact(ctx.vars),
        step: step.id,
        credential: holds ? "repository" : !iso ? "machine" : "none",
        isolated: Boolean(iso),
      });
      if (asked?.denied) return refuseByPolicy(engine, identity, asked.denied);
      const pushLog = pushLogFor(engine, scope, step, scope.visits[step.id] ?? 1);
      if (pushLog) env.FACTORY_PUSH_LOG = pushLog;
      if (!iso) Object.assign(env, await engine.botEnv()); // nothing is made yet, so a throw leaves nothing behind
      // The GitHub App: a new token limited to this repository, for this step only (never stored).
      let tokenAccess = access?.kind === "token" ? access : undefined;
      let appExpires: number | undefined;
      if (access?.kind === "app") {
        const t = await appTokenAccess(access, engine.config);
        if (!t.ok) return refuse(t.reason);
        tokenAccess = { kind: "token", token: t.token, url: access.url, username: "x-access-token" };
        appExpires = t.expires;
      }
      const keyAccess = access?.kind === "key" ? access : undefined;
      const refinement = isRefinementRun(engine.summary.source);
      const ghDir = iso ? ghConfigDir() : undefined;
      const runDir = engine.summary.runDir;
      let readEnv: Record<string, string | undefined> = {};
      let marker = "";
      if (iso) Object.assign(env, isolationEnv(env, engine.config, ghDir!, iso.who));
      if (tokenAccess) readEnv = repoTokenEnv(tokenAccess, env, ghDir);
      if (keyAccess) {
        try {
          ({ env: readEnv, marker } = prepareKeyStep(keyAccess, runDir, env, ghDir));
        } catch {
          removeSignInDir(runDir);
          if (ghDir) removeGhConfigDir(ghDir);
          return refuse(KEY_NOT_READY);
        }
      }
      Object.assign(env, readEnv);
      const readNames = Object.keys(readEnv).filter((k) => readEnv[k] !== undefined);
      // the git config entries stay whole in a container, and an isolated step keeps its commit name there
      const count = readNames.includes("GIT_CONFIG_COUNT") ? Number.parseInt(env.GIT_CONFIG_COUNT ?? "0", 10) || 0 : 0;
      const dockerEnv = [...readNames];
      for (let i = 0; i < count; i++) for (const k of ["GIT_CONFIG_KEY_" + i, "GIT_CONFIG_VALUE_" + i]) if (env[k] !== undefined && !dockerEnv.includes(k)) dockerEnv.push(k);
      if (iso) for (const k of IDENTITY_VARS) if (!dockerEnv.includes(k)) dockerEnv.push(k);
      // The push exception is a one-time token that only this step gets (see grantPush), not a plain name.
      const grant = env.FACTORY_PUSH_ALLOW ? grantPush(env.FACTORY_PUSH_ALLOW) : undefined;
      if (grant) Object.assign(env, grant.env);
      // A step of a user's run gets only the short environment, not the server's (see short-env.ts).
      const short = shortEnvRun(engine.summary.owner);
      let r: Awaited<ReturnType<typeof runShell>> | undefined;
      let thrown: unknown;
      let gone = true;
      let noGh = false;
      try {
        // A shell step of a user's run is held in an OS sandbox (a step in a Docker image is held by the container).
        const sb = sandboxedRun(engine.summary.owner, engine.config);
        if (typeof sb === "object") throw new Error(sb.refused);
        const boxed = short && wrapsStep(sb, step.sandbox ? image : undefined);
        const stepEnvVars = short ? shortEnv(env, engine.config) : env;
        let sandboxProfileText: string | undefined;
        if (boxed) {
          Object.assign(stepEnvVars, sandboxHomeEnv(runDir));
          // the learnings folder is made here: the step may write the file but not move or remove its folder
          if (env.FACTORY_LEARNINGS_FILE) mkdirSync(dirname(env.FACTORY_LEARNINGS_FILE), { recursive: true });
          sandboxProfileText = sandboxProfile(
            stepSandboxPaths({ runDir, learnings: env.FACTORY_LEARNINGS_FILE ?? "", ghDir, claudeBin: engine.claudeBin, codexBin: engine.codexBin, userRead: engine.config.sandbox.user_read }),
          );
        }
        r = await runShell({
          command: renderTrusted(step.run, ctx, stepTypesOf(scope.flow), SHELL_TEMPLATE_ROOTS),
          cwd: engine.summary.workdir!,
          env: stepEnvVars,
          sandboxProfile: sandboxProfileText,
          cleanEnv: short,
          logFile,
          timeoutMs,
          signal: engine.signal,
          dockerImage: step.sandbox ? image : undefined,
          dockerEnv,
          // the token or key of this step stays hidden even if the stored one is changed or removed while it runs
          pinnedSecrets: tokenAccess ? [tokenAccess.token] : keyAccess ? [keyAccess.key] : undefined,
          scan: tokenAccess ? tokenRefused : keyAccess ? keyRefused : undefined,
          maxOutput: stepMaxOutput(step, scope.depth, scope.flow.name),
          ownGroup: Boolean(tokenAccess || keyAccess),
          meter,
        });
      } catch (e) {
        thrown = e;
      } finally {
        grant?.revoke();
        if (ghDir) removeGhConfigDir(ghDir);
        if (keyAccess) {
          noGh = ghStandInCalled(marker);
          gone = removeSignInDir(runDir);
        }
      }
      // A folder with the key that cannot be removed fails the step, whatever else happened.
      if (keyAccess && !gone) {
        engine.log(`    ! ${step.id}: the sign-in folder could not be removed`);
        return refuse(SIGN_IN_NOT_REMOVED);
      }
      if (thrown) throw thrown;
      if (!r) return refuse(KEY_NOT_READY);
      // A refusal on stderr fails the step even when the script goes on; on a failed step the output counts too.
      const stopped = r.error === "cancelled"; // a refusal that came before a timeout still counts
      const denied = (tokenAccess || keyAccess) && !stopped && (r.ok ? r.scanned?.stderr : r.scanned?.output) === true;
      if (noGh) return refuse(DEPLOY_KEY_NO_GH);
      if (denied) {
        const expired = appExpires !== undefined && Date.now() >= appExpires;
        const reason = keyAccess ? KEY_REFUSED_RUN : access?.kind === "app" ? (expired ? APP_TOKEN_EXPIRED : APP_REFUSED_RUN) : refinement ? TOKEN_REFUSED_REASON : TOKEN_REFUSED_RUN;
        engine.accessFailed = true;
        return { ok: false, output: r.output, error: reason, exitCode: r.exitCode, ...(r.truncated ? { oversize: true } : {}) };
      }
      return { ok: r.ok, output: r.output, error: r.error, exitCode: r.exitCode, ...(r.truncated ? { oversize: true } : {}) };
    }

    case "parallel": {
      const byId = new Map(scope.flow.steps.map((s) => [s.id, s]));
      engine.log(`  ⇉ running ${step.steps.join(", ")} in parallel`);
      const results = await Promise.all(
        step.steps.map(async (id) => {
          const sub = byId.get(id)!;
          const visit = (scope.visits[id] = (scope.visits[id] ?? 0) + 1);
          const started = new Date();
          const lf = newLogFile(engine, scope.prefix + id);
          const identity = stepIdentity(sub, scope.prefix, visit);
          const began = beginStep(engine, scope, sub, identity);
          const meter: ProcessMeter = {};
          let res: StepResult;
          if (began?.denied) {
            res = refuseByPolicy(engine, identity, began.denied);
          } else {
            try {
              res = await executeStep(sub, scope, engine, lf, meter);
            } catch (e) {
              res = { ok: false, output: "", error: (e as Error).message };
            }
            res = applyChecks(sub, res);
          }
          const rec = recordStep(sub, scope, engine, res, started, lf, visit, meter, await stepAfterPaths(engine));
          res = { ...res, ok: rec.ok, error: rec.error, held: rec.held, limited: rec.limited };
          return { id, res };
        }),
      );
      const failed = results.filter((r) => !r.res.ok).map((r) => r.id);
      // A hold needs a person at this step; inside a parallel step it cannot be kept, so the run ends here (on_failure is not followed).
      if (results.some((r) => r.res.held)) {
        engine.accessFailed = true;
        const reason = "content held for approval inside a parallel step; run that step outside the parallel block";
        return { ok: false, output: reason, error: reason };
      }
      return {
        ok: failed.length === 0,
        output: results.map((r) => `## ${r.id}\n${r.res.output}`).join("\n\n"),
        error: failed.length ? `failed: ${failed.join(", ")}` : undefined,
      };
    }

    case "flow": {
      if (scope.depth >= MAX_FLOW_DEPTH) return { ok: false, output: "", error: `sub-flows nested deeper than ${MAX_FLOW_DEPTH}` };
      const { flow } = loadFlow(step.flow, engine.summary.repo);
      if (flow.steps.some((s) => s.type === "approval")) {
        return { ok: false, output: "", error: `sub-flow "${flow.name}" contains approval steps; put approvals in the parent flow` };
      }
      const vars = { ...flow.vars, ...ctx.vars };
      for (const [k, v] of Object.entries(step.vars ?? {})) vars[k] = renderTrusted(v, ctx, stepTypesOf(scope.flow), SHELL_TEMPLATE_ROOTS);
      const subScope: Scope = {
        flow,
        ctx: { ...ctx, vars, steps: {}, run: { ...ctx.run } },
        visits: {},
        prefix: `${scope.prefix}${step.id}/`,
        depth: scope.depth + 1,
      };
      engine.policy?.subFlow(subScope.prefix.slice(0, -1), flow, subScope.depth);
      engine.log(`  ↳ sub-flow ${flow.name}`);
      const r = await engine.runLoop(subScope, null);
      const ok = r.outcome === "succeeded";
      return { ok, output: r.lastOutput, error: ok ? undefined : `sub-flow ${flow.name} ${r.outcome}${r.reason ? `: ${r.reason}` : ""}` };
    }

    case "approval":
      throw new Error("approval steps are handled by the loop");
  }
}

export function applyChecks(step: Step, res: StepResult): StepResult {
  if (!res.ok) return res;
  if (step.fail_if && new RegExp(step.fail_if, "m").test(res.output)) {
    return { ...res, ok: false, error: `output matched fail_if /${step.fail_if}/` };
  }
  if (step.pass_if && !new RegExp(step.pass_if, "m").test(res.output)) {
    return { ...res, ok: false, error: `output did not match pass_if /${step.pass_if}/` };
  }
  return res;
}
