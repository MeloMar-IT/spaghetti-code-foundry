import { join } from "node:path";
import type { Config } from "../config.js";
import { loadFlow } from "../flow/load.js";
import type { Flow, Step } from "../flow/schema.js";
import { runAgentStep } from "../agents/run.js";
import type { Target } from "../agents/targets.js";
import { runShell } from "../steps/shell.js";
import { isRefinementRun } from "../auth/run-owner.js";
import { KEY_UNREADABLE } from "../auth/repos.js";
import { DEPLOY_KEY_NO_GH, KEY_NOT_READY, KEY_REFUSED_RUN, APP_REFUSED_RUN, APP_TOKEN_EXPIRED, SIGN_IN_NOT_REMOVED, TOKEN_REFUSED_REASON, TOKEN_REFUSED_RUN, grantPush, keyRefused, pushAllowEnv, stepMaxOutput, tokenRefused } from "./guards.js";
import { IDENTITY_VARS, isolationEnv, stepIsolation } from "./isolation.js";
import { appTokenAccess, ghConfigDir, ghStandInCalled, prepareKeyStep, removeGhConfigDir, removeSignInDir, repoTokenEnv, stepRepoAccess } from "./repo-access.js";
import type { RunSummary, StepRecord } from "./state.js";
import { outputEnvName, render, varEnvName, withScfAliases, type TemplateContext } from "./template.js";

/** Shell commands may only template trusted values; task and outputs go via env. */
export const SHELL_TEMPLATE_ROOTS = ["vars", "workdir", "run"] as const;
export const DEFAULT_PERMISSION_MODE = "acceptEdits";
const MAX_FLOW_DEPTH = 5;

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
}

export interface Engine {
  summary: RunSummary;
  config: Config;
  baseEnv: Record<string, string>;
  /** The bot's name and token (asked once per run). Only for steps that keep the machine's login. */
  botEnv: () => Promise<Record<string, string>>;
  /** Whether this run may take the hotfix path (see hotfixState); "off" when unset. */
  hotfix?: "on" | "off" | "other";
  logsDir: string;
  claudeBin?: string;
  codexBin?: string;
  signal?: AbortSignal;
  /** Set once a budget is used up and a free fallback exists: all agent steps run there. */
  budgetFallback?: Target;
  log: (msg: string) => void;
  save: () => void;
  /** Remaining budget in USD for the next claude call (undefined = unlimited). */
  remainingBudget: () => number | undefined;
  runLoop: (scope: Scope, startAt: string | null) => Promise<LoopResult>;
  /** Set when a token step could not sign in: the run ends there, `on_failure` is not followed. */
  accessFailed?: boolean;
  /** A human decision for the approval step the run is waiting at (consumed on use). */
  decision?: ApprovalDecision & { stepId: string };
}

export interface ApprovalDecision {
  approved: boolean;
  by?: string;
  note?: string;
}

export type StepResult = Pick<StepRecord, "ok" | "output" | "error" | "exitCode" | "sessionId" | "costUsd" | "agent" | "tokens" | "limited" | "denied" | "unreachable" | "retried">;

export function stepEnv(scope: Scope, engine: Engine, step?: Pick<Step, "id">): Record<string, string> {
  const hotfix = engine.hotfix ?? "off";
  // Never inherited from the server's own environment: only pushAllowEnv() can set it, for one step.
  const env: Record<string, string> = { ...engine.baseEnv, FACTORY_HOTFIX: hotfix, FACTORY_PUSH_ALLOW: "" };
  if (step) Object.assign(env, pushAllowEnv(step, scope.depth, scope.ctx.vars, hotfix));
  for (const [k, v] of Object.entries(scope.ctx.vars)) env[varEnvName(k)] = v;
  for (const [id, s] of Object.entries(scope.ctx.steps)) env[outputEnvName(id)] = String(s.output ?? "");
  return withScfAliases(env);
}

export function historySummary(summary: RunSummary): string {
  return summary.history
    .map((h) => `- ${h.id}${h.visit > 1 ? ` (visit ${h.visit})` : ""}: ${h.ok ? "ok" : `FAILED${h.error ? ` — ${h.error}` : ""}`}`)
    .join("\n");
}

/** Store a finished step in history and in the scope's template context. */
export function recordStep(step: Step, scope: Scope, engine: Engine, res: StepResult, startedAt: Date, logFile: string, visit: number): StepRecord {
  const rec: StepRecord = {
    id: scope.prefix + step.id,
    type: step.type,
    visit,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    logFile,
    ...res,
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
    agent: res.agent ?? "",
    visit,
  };
  engine.save();
  const secs = (rec.durationMs / 1000).toFixed(1);
  const tok = res.tokens ? `, ${Math.round((res.tokens.input + res.tokens.output) / 1000)}k tok` : "";
  engine.log(`${res.ok ? "✔" : "✘"} ${rec.id} (${secs}s${res.costUsd ? `, $${res.costUsd.toFixed(4)}` : ""}${tok})${res.error ? ` — ${res.error}` : ""}`);
  return rec;
}

/** Log file of the step that runs after `historyLength` finished steps. */
export function stepLogFile(logsDir: string, historyLength: number, id: string): string {
  return join(logsDir, `${String(historyLength + 1).padStart(3, "0")}-${id.replace(/\//g, "__")}.log`);
}

export function newLogFile(engine: Engine, id: string): string {
  return stepLogFile(engine.logsDir, engine.summary.history.length, id);
}

/** Execute a claude, shell, parallel or flow step (approvals are handled by the loop). */
export async function executeStep(step: Step, scope: Scope, engine: Engine, logFile: string): Promise<StepResult> {
  const d = scope.flow.defaults;
  const timeoutSec = step.timeout_sec ?? d.timeout_sec;
  const timeoutMs = timeoutSec ? timeoutSec * 1000 : undefined;
  const { ctx } = scope;
  ctx.run.history = historySummary(engine.summary);

  switch (step.type) {
    case "claude":
      return runAgentStep(step, scope, engine, logFile, timeoutMs);

    case "shell": {
      const image = scope.flow.sandbox.docker_image ?? engine.config.sandbox.docker_image;
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
      let r: Awaited<ReturnType<typeof runShell>> | undefined;
      let thrown: unknown;
      let gone = true;
      let noGh = false;
      try {
        r = await runShell({
          command: render(step.run, ctx, SHELL_TEMPLATE_ROOTS),
          cwd: engine.summary.workdir!,
          env,
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
        return { ok: false, output: r.output, error: reason, exitCode: r.exitCode };
      }
      return { ok: r.ok, output: r.output, error: r.error, exitCode: r.exitCode };
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
          let res: StepResult;
          try {
            res = await executeStep(sub, scope, engine, lf);
          } catch (e) {
            res = { ok: false, output: "", error: (e as Error).message };
          }
          res = applyChecks(sub, res);
          recordStep(sub, scope, engine, res, started, lf, visit);
          return { id, res };
        }),
      );
      const failed = results.filter((r) => !r.res.ok).map((r) => r.id);
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
      for (const [k, v] of Object.entries(step.vars ?? {})) vars[k] = render(v, ctx, SHELL_TEMPLATE_ROOTS);
      const subScope: Scope = {
        flow,
        ctx: { ...ctx, vars, steps: {}, run: { ...ctx.run } },
        visits: {},
        prefix: `${scope.prefix}${step.id}/`,
        depth: scope.depth + 1,
      };
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
