import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readOnlyStep, reviewerStepProblem, type ClaudeStep } from "../flow/schema.js";
import { resolveClaudeBin, runClaude } from "../steps/claude.js";
import { resolveCodexBin, runCodex, type CodexSandbox } from "../steps/codex.js";
import { DEFAULT_PERMISSION_MODE, stepEnv, type Engine, type Scope, type StepResult } from "../engine/execute.js";
import { type CommitIdentity, ISOLATED_AGENT_ENV, isolationEnv, stepIsolation, tokenVarNames } from "../engine/isolation.js";
import { skillSession } from "../engine/skill-lock.js";
import { attachSkillPayload, withSkillPayload, type SkillPayload } from "../skills/payload.js";
import { ghConfigDir, removeGhConfigDir } from "../engine/repo-access.js";
import { sandboxedRun, sandboxHomeEnv, sandboxProfile, stepSandboxPaths } from "../engine/os-sandbox.js";
import { shortEnv, shortEnvRun } from "../engine/short-env.js";
import { render } from "../engine/template.js";
import { codexHomeId, codexResumeRefusal } from "./codex-home.js";
import { agentHomeEnv, agentKeyNames, codexKeyEnv, dropLoginVars, missingAgentKey, noAgentKey } from "./boxed.js";
import { BUILTIN_PROVIDERS, claudeProviderEnv, fallbackTargets, isAuthError, isLimitError, isQuotaError, isTransientError, LOCAL_KINDS, providerKeyVars, resolveTarget, type Target } from "./targets.js";

/** Map Claude permission settings onto Codex's sandbox modes. */
export function codexSandbox(step: ClaudeStep, scope: Scope, sandboxed: boolean): CodexSandbox {
  const d = scope.flow.defaults;
  const mode = step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE;
  if (readOnlyStep(step, d)) return "read-only";
  if (mode === "bypassPermissions" && !sandboxed) return "danger-full-access";
  return "workspace-write";
}

type Iso = { who: CommitIdentity };

/** A step result; `final` is a refusal that no other try can change (no key for a boxed step). */
type Ran = StepResult & { final?: boolean };

async function runOn(t: Target, step: ClaudeStep, scope: Scope, engine: Engine, logFile: string, timeoutMs: number | undefined, iso: Iso | undefined, boxed: boolean, skills?: SkillPayload, again = false): Promise<Ran> {
  // Both agents get the same environment; an isolated step has no token, an empty gh folder of its own and the commit name.
  const base = stepEnv(scope, engine);
  const ghDir = iso ? ghConfigDir() : undefined;
  try {
    const extra = agentEnv(scope.ctx.vars.agent_env, Boolean(iso));
    // A boxed step signs in by the server's token variable only: a key a flow brings in `agent_env` is ignored.
    const dropped = boxed ? dropLoginVars(extra, providerKeyVars(engine.config)) : [];
    if (dropped.length) engine.log(`    · agent_env: ${dropped.join(", ")} ignored — a user's run signs in with the server's key only`);
    let env: Record<string, string | undefined> = iso
      ? { ...base, ...extra, ...isolationEnv(base, engine.config, ghDir!, iso.who) }
      : { ...base, ...(await engine.botEnv()), ...extra };
    // A user's run gets only the short environment plus what this agent and provider need (see short-env.ts).
    const short = shortEnvRun(engine.summary.owner);
    if (short) env = shortEnv(env, engine.config, { agent: t.agent, kind: t.provider.kind });
    if (t.agent === "claude") env = { ...env, ...claudeProviderEnv(t, iso ? tokenVarNames(engine.config) : []) };
    let profile: string | undefined;
    let bin: string | undefined;
    if (boxed) {
      const missing = missingAgentKey(t, env);
      if (missing) {
        engine.accessFailed = true;
        return { ok: false, output: missing, error: missing, final: true };
      }
      // private agent folders in the run folder, set by the server (the admin's are not inherited)
      const runDir = engine.summary.runDir;
      Object.assign(env, sandboxHomeEnv(runDir), agentHomeEnv(runDir), codexKeyEnv(t, env));
      // the learnings folder is made here: the step may write the file but not move or remove its folder
      if (env.FACTORY_LEARNINGS_FILE) mkdirSync(dirname(env.FACTORY_LEARNINGS_FILE), { recursive: true });
      // a Codex read-only step keeps the workspace read-only: Codex's own sandbox is off, so the profile holds it
      const readOnly = t.agent === "codex" && codexSandbox(step, scope, agentSandboxed(step, scope, engine)) === "read-only";
      // the exact program the step will start (also one under the home, like the Claude desktop app's): the profile opens it, and runClaude/runCodex get the same path
      bin = t.agent === "codex" ? (engine.codexBin ?? resolveCodexBin()) : (engine.claudeBin ?? resolveClaudeBin());
      profile = sandboxProfile(
        stepSandboxPaths({
          runDir,
          learnings: env.FACTORY_LEARNINGS_FILE ?? "",
          ghDir,
          claudeBin: t.agent === "codex" ? engine.claudeBin : bin,
          codexBin: t.agent === "codex" ? bin : engine.codexBin,
          agentBin: bin,
          userRead: engine.config.sandbox.user_read,
          workspaceReadOnly: readOnly,
        }),
      );
    }
    return await runWith(t, step, scope, engine, logFile, timeoutMs, env, { isolated: Boolean(iso), short, boxed, profile, bin, skills, again });
  } finally {
    if (ghDir) removeGhConfigDir(ghDir);
  }
}

/** Does the flow ask for the agent's own sandbox on this step? */
function agentSandboxed(step: ClaudeStep, scope: Scope, engine: Engine): boolean {
  return step.sandbox ?? scope.flow.sandbox.claude ?? engine.config.sandbox.claude ?? false;
}

interface WithOptions {
  isolated: boolean;
  short: boolean;
  /** Held by the OS sandbox profile: the agent's own sandbox is off. */
  boxed: boolean;
  profile?: string;
  /** The program a boxed step starts (the one the profile opens). */
  bin?: string;
  /** The skills of the run's lock for a Claude session. */
  skills?: SkillPayload;
  /** Not the first session of this step: a retry or a fallback. */
  again?: boolean;
}

/** Which session a step with `resume:` asks to continue, and the digest of the skill block that session received. */
export function sessionToResume(
  step: Pick<ClaudeStep, "resume">,
  steps: Record<string, Record<string, unknown>>,
  agent: "claude" | "codex",
): { asked: boolean; id?: string; prevAgent?: string; holds?: string } {
  const prev = step.resume ? steps[step.resume] : undefined;
  if (!prev) return { asked: false };
  const prevAgent = String(prev.agent || "claude").split(":")[0]!;
  const id = prevAgent === agent && typeof prev.session_id === "string" && prev.session_id ? prev.session_id : undefined;
  // --resume replays the transcript on any provider or model, so the resumed session still holds its block.
  const holds = id && typeof prev.skills_digest === "string" && prev.skills_digest ? prev.skills_digest : undefined;
  return { asked: true, id, prevAgent, ...(holds ? { holds } : {}) };
}

/** A Claude session runs without the personal setup when the server says so, on a user's run, and always when the run's lock holds skills. */
export function claudeIsolated(isolateAgents: boolean, userRun: boolean, skills?: Pick<SkillPayload, "loaded" | "omitted">, reviewer = false): boolean {
  return isolateAgents || userRun || reviewer || Boolean(skills && (skills.loaded.length || skills.omitted.length));
}

/** The record of a skill block on a step result. */
function skillsRecord(s?: SkillPayload, attach?: ReturnType<typeof attachSkillPayload>): Pick<StepResult, "skills"> {
  return s ? { skills: { loaded: s.loaded, ...(s.omitted.length ? { omitted: s.omitted } : {}), bytes: s.bytes, estimatedTokens: s.estimatedTokens, ...(s.role ? { role: s.role } : {}), ...(attach ? { state: attach.state, digest: attach.digest, attachedBytes: attach.attachedBytes, attachedEstimatedTokens: attach.attachedEstimatedTokens } : {}) } } : {};
}

async function runWith(t: Target, step: ClaudeStep, scope: Scope, engine: Engine, logFile: string, timeoutMs: number | undefined, env: Record<string, string | undefined>, o: WithOptions): Promise<StepResult> {
  const { isolated, short, boxed, profile, bin } = o;
  const { ctx, flow } = scope;
  const d = flow.defaults;
  const local = LOCAL_KINDS.includes(t.provider.kind);
  const asked = agentSandboxed(step, scope, engine);
  // profiles may not nest: the outer profile holds a boxed step, so the agent's own sandbox is off
  const sandboxed = boxed ? false : asked;
  if (boxed && asked && t.agent === "claude") engine.log("    · Claude's own sandbox is off: the run's sandbox holds this step");
  const effort = step.effort ?? d.effort;
  const { asked: resumeAsked, id: askedId, prevAgent, holds } = sessionToResume(step, ctx.steps, t.agent);
  let resumeId = askedId;
  if (resumeAsked && !resumeId) engine.log(`    · not resuming ${step.resume}: it ran on ${prevAgent}, this step on ${t.agent}`);
  if (resumeId && step.skills === "off") {
    resumeId = undefined;
    engine.log(`    · not resuming ${step.resume}: this step has skills: off and a resumed session may hold a skill block`);
  }
  const prev = step.resume ? ctx.steps[step.resume] : undefined;
  // A Codex session lives in one Codex folder: resume only where the earlier step ran with the same one.
  let home: string | undefined;
  if (t.agent === "codex") {
    const seen = (n: string) => (n in env ? env[n] : short ? undefined : process.env[n]);
    home = codexHomeId({ run: boxed, codexHome: seen("CODEX_HOME"), home: seen("HOME") });
    const reason = resumeId ? codexResumeRefusal(prev!.codex_home, home) : undefined;
    if (reason) {
      resumeId = undefined;
      engine.log(`    · not resuming ${step.resume}: ${reason}`);
    }
  }
  const common = {
    prompt: render(step.prompt, ctx),
    systemPrompt: step.system_prompt ? render(step.system_prompt, ctx) : undefined,
    cwd: engine.summary.workdir!,
    logFile,
    timeoutMs,
    signal: engine.signal,
    resumeSessionId: resumeId,
    onProgress: (m: string) => engine.log(`    · ${m}`),
  };
  engine.log(`    · agent ${t.label}`);

  if (t.agent === "codex") {
    const builtinUrl = BUILTIN_PROVIDERS[t.providerName]?.base_url;
    const r = await runCodex({
      ...common,
      prompt: withSkillPayload(common.prompt, o.skills?.role === "reviewer" ? o.skills.text : ""),
      env,
      cleanEnv: short,
      codexBin: bin ?? engine.codexBin,
      model: t.model,
      localProvider: local ? t.provider.kind : undefined,
      localBaseUrl: local && t.provider.base_url !== builtinUrl ? t.provider.base_url : undefined,
      sandboxProfile: profile,
      sandbox: boxed ? "danger-full-access" : codexSandbox(step, scope, sandboxed),
      reviewer: step.skill_role === "reviewer",
      effort,
    });
    const p = t.provider.price;
    const costUsd = p ? (r.inputTokens * p.input_per_mtok + r.outputTokens * p.output_per_mtok) / 1e6 : 0;
    return { ok: r.ok, output: r.output, error: r.error, sessionId: r.sessionId, codexHome: home, costUsd, agent: t.label, tokens: { input: r.inputTokens, output: r.outputTokens }, ...skillsRecord(o.skills?.role === "reviewer" ? o.skills : undefined) };
  }

  // No --max-budget-usd at all when cost limits are off (fixed-price subscriptions); costs are still recorded.
  const caps = t.free || !engine.config.cost_limits ? [] : [step.max_budget_usd ?? d.max_budget_usd, engine.remainingBudget()].filter((n): n is number => n !== undefined);
  const isolatedSession = claudeIsolated(engine.config.isolate_agents, isolated, o.skills, step.skill_role === "reviewer");
  if (isolatedSession && !engine.config.isolate_agents && !isolated) engine.log("    · skills: this session runs without the personal Claude setup");
  const attach = o.skills ? attachSkillPayload(o.skills, { continues: Boolean(resumeId), holds, again: resumeAsked || Boolean(o.again) }) : undefined;
  if (o.skills && attach) {
    const keys = o.skills.loaded.join(", ");
    if (attach.state === "reused") engine.log(`    · skill context: reused ${keys} from the session of ${step.resume}; nothing added`);
    else engine.log(`    · skill context: ${attach.state} ${keys} (${attach.attachedBytes} bytes, about ${attach.attachedEstimatedTokens} tokens)${attach.state === "reloaded" ? ": new session" : ""}`);
  }
  const r = await runClaude({
    ...common,
    prompt: withSkillPayload(common.prompt, attach?.text ?? ""),
    env,
    cleanEnv: short,
    sandboxProfile: profile,
    claudeBin: bin ?? engine.claudeBin,
    model: t.model,
    permissionMode: step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE,
    allowedTools: step.allowed_tools ?? d.allowed_tools,
    maxBudgetUsd: caps.length ? Math.max(0.01, Math.min(...caps)) : undefined,
    sandbox: sandboxed,
    noMcp: local,
    isolated: isolatedSession,
    effort,
  });
  for (const d of r.denied ?? []) engine.log(`    ⚠ blocked: ${d}`);
  return {
    ok: r.ok,
    output: r.output,
    error: r.error,
    sessionId: r.sessionId,
    ...(r.denied ? { denied: r.denied } : {}),
    // Claude Code prices unknown local models as if they were Claude — they cost nothing.
    costUsd: local ? 0 : r.costUsd,
    agent: t.label,
    tokens: r.inputTokens !== undefined ? { input: r.inputTokens, output: r.outputTokens ?? 0 } : undefined,
    ...skillsRecord(o.skills, attach),
  };
}

/**
 * Run an agent step on the target the step, router and defaults pick. On a rate or usage
 * limit, retry on the router's fallbacks in order. When the budget is used up the loop sets
 * engine.budgetFallback and every agent step runs on that free target instead.
 */
export async function runAgentStep(step: ClaudeStep, scope: Scope, engine: Engine, logFile: string, timeoutMs?: number): Promise<StepResult> {
  const { config } = engine;
  // A stored run can hold a flow that was not checked by this version: a reviewer must not be able to write.
  if (step.skill_role === "reviewer") {
    const msg = reviewerStepProblem(step, scope.flow.defaults) ? "a reviewer step must be read-only" : undefined;
    if (msg) return { ok: false, output: msg, error: msg };
  }
  const iso = stepIsolation(engine, scope.ctx.vars);
  if (iso && "refused" in iso) {
    engine.accessFailed = true;
    return { ok: false, output: iso.refused, error: iso.refused };
  }
  // A user's run is held by an OS sandbox profile (the same refusal and setting as a shell step).
  const sb = sandboxedRun(engine.summary.owner, config);
  if (typeof sb === "object") {
    engine.accessFailed = true;
    return { ok: false, output: sb.refused, error: sb.refused };
  }
  const boxed = sb === "on";
  let target: Target;
  try {
    target = engine.budgetFallback ?? resolveTarget(step, scope.flow, config, scope.visits[step.id] ?? 1);
  } catch (e) {
    return { ok: false, output: "", error: (e as Error).message };
  }
  const fallbacks = config.router.fallback_on.includes("rate_limit") ? fallbackTargets(config) : [];
  const tried = new Set<string>();
  let blips = 0;
  let models = 0;
  const tries = () => (blips || models ? { retried: { blips, models } } : {});
  for (;;) {
    // Before every session of the agent, retries and fallbacks included: the skills this run locked must still be what they were.
    const session = skillSession(engine, target.agent, {}, step.skill_role ?? "coder", step.skills !== "off");
    if ("refused" in session) {
      engine.log(`    ! skill context: rejected (${session.refused})`);
      engine.accessFailed = true;
      return { ok: false, output: session.refused, error: session.refused, ...tries() };
    }
    tried.add(target.label);
    const { final, ...r } = await runOn(target, step, scope, engine, logFile, timeoutMs, iso, boxed, session.payload, blips + models > 0);
    if (r.ok || engine.signal?.aborted || final) return { ...r, ...tries() };
    // The service was briefly unavailable (overloaded, "at capacity", a network blip): wait and try
    // the same step again a few times before treating it as a limit.
    if (isTransientError(r.error, r.output) && !isAuthError(r.error, r.output) && blips < TRANSIENT_RETRIES.length) {
      const wait = TRANSIENT_RETRIES[blips++]!;
      engine.log(`    ↻ ${target.label}: ${(r.error || r.output).trim().split("\n")[0]!.slice(0, 120)} — trying again in ${Math.round(wait / 1000)}s`);
      engine.summary.totalCostUsd += r.costUsd ?? 0;
      if (!(await pause(wait, engine.signal))) return { ...r, ...tries() };
      continue;
    }
    // Signed out: pause like a usage limit (the run is tried again by itself) instead of failing.
    if (isAuthError(r.error, r.output)) {
      // A boxed step has no login of the Mac to renew: the server's key is missing or wrong, and the run ends here.
      if (boxed && !LOCAL_KINDS.includes(target.provider.kind)) {
        engine.accessFailed = true;
        return { ...r, ...tries(), error: noAgentKey(agentKeyNames(target)) };
      }
      const cli = target.agent === "codex" ? 'run "codex login"' : 'run "claude" in a terminal and type /login';
      return { ...r, ...tries(), limited: true, error: `signed out — the ${target.agent === "codex" ? "Codex" : "Claude Code"} login has expired. Sign in again: ${cli}. The run continues by itself after that.` };
    }
    // Still unavailable after the retries: pause the run like a limit (it is tried again later).
    if (!isLimitError(r.error, r.output) && !isTransientError(r.error, r.output)) return { ...r, ...tries() };
    const next = fallbacks.find((t) => !tried.has(t.label));
    // No model left to try: the loop pauses the run until the limit resets.
    if (!next) return { ...r, ...tries(), limited: true, ...(isTransientError(r.error, r.output) && !isQuotaError(r.error, r.output) ? { unreachable: true } : {}), error: `usage limit reached: ${r.output.trim().split("\n")[0] || r.error}` };
    engine.log(`    ↪ ${target.label} hit a limit — retrying on ${next.label}`);
    engine.summary.totalCostUsd += r.costUsd ?? 0;
    models++;
    target = next;
  }
}

/**
 * Extra environment for agent steps from the `agent_env` flow variable: `KEY=value` pairs, one per
 * line or separated by `;` (e.g. `JAVA_HOME=/path/to/jdk`), so agents can run the project's build.
 * Names with the FACTORY_ or SCF_ prefix and a few sensitive ones are ignored.
 */
export function agentEnv(spec: string | undefined, isolated = false): Record<string, string> {
  const env: Record<string, string> = {};
  for (const part of (spec ?? "").split(/[\n;]/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(part);
    if (m && !/^(PATH|HOME|FACTORY_.*|SCF_.*|ANTHROPIC_.*|OPENAI_.*|GH_TOKEN|GITHUB_TOKEN)$/.test(m[1]!) && !(isolated && ISOLATED_AGENT_ENV.test(m[1]!))) env[m[1]!] = m[2]!;
  }
  return env;
}

/** Waits before each retry of a briefly unavailable service (1 and 3 minutes; tests set them short). */
const TRANSIENT_RETRIES = (process.env.FACTORY_TRANSIENT_RETRY_MS ?? "60000,180000").split(",").map(Number);

/** Sleeps, unless the run is cancelled meanwhile (then false). */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve(false)), { once: true });
  });
}
