import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { readOnlyStep, reviewerStepProblem, type ClaudeStep, type Flow } from "../flow/schema.js";
import { resolveClaudeBinAsync, runClaude } from "../steps/claude.js";
import { resolveCodexBin, runCodex, type CodexSandbox } from "../steps/codex.js";
import type { ProcessMeter } from "../steps/process.js";
import type { SlotWaitWatch } from "../steps/slot-waits.js";
import { DEFAULT_PERMISSION_MODE, pushLogFor, refuseByPolicy, slotWaitsFor, stepEnv, type Engine, type Scope, type StepResult } from "../engine/execute.js";
import { type CommitIdentity, ISOLATED_AGENT_ENV, agentNoSignInEnv, isolationEnv, stepIsolation, tokenVarNames } from "../engine/isolation.js";
import { evaluationLimits } from "../engine/eval-limits.js";
import { skillSession } from "../engine/skill-lock.js";
import { catalogueTaskText, CATALOGUE_ISSUE_STEP, runSkillCatalogue, type RunCatalogue } from "../skills/run-catalogue.js";
import { liveCanonicalDeps } from "../skills/run-canonical.js";
import { dataHome } from "../auth/store.js";
import { attachSkillPayload, withSkillPayload, type SkillPayload } from "../skills/payload.js";
import { sessionToolGrant, sessionTools, sessionToolsLine, type SessionToolGrant, type SessionTools, type ToolCheck } from "../skills/tool-policy.js";
import { ghConfigDir, removeGhConfigDir } from "../engine/repo-access.js";
import { sandboxedRun, sandboxHomeEnv, sandboxProfile, stepSandboxPaths } from "../engine/os-sandbox.js";
import { shortEnv, shortEnvRun } from "../engine/short-env.js";
import { applyRepoRequests, repoRequestsEnv } from "../engine/repo-requests.js";
import { TOOLS_DIR, botIdentityEnv } from "../engine/guards.js";
import { stepContextIndex } from "../engine/context-index.js";
import { boundAgentPrompt, boundEnv, classifyBound, stepTypesOf, UntrustedRefusal, type BoundPrompt, type OutputLabel } from "../engine/untrusted.js";
import { GuardError } from "../help/guard.js";
import { CODEX_PUSH_BLOCKED_LINE, codexHomeId, codexIsolationLine, codexIsolationMode, codexLoginReturnLine, codexResumeRefusal, personalCodexDir, prepareCleanCodex, type CleanCodex, type CodexIsolation } from "./codex-home.js";
import { discoverJavaHome, javaStandIn } from "./java-gate.js";
import { agentHomeEnv, agentKeyNames, codexKeyEnv, dropLoginVars, missingAgentKey, noAgentKey } from "./boxed.js";
import { BUILTIN_PROVIDERS, claudeProviderEnv, fallbackTargets, formatSpec, isAuthError, isLimitError, isQuotaError, isTransientError, LOCAL_KINDS, providerKeyVars, resolveTarget, routeModel, type Target } from "./targets.js";
import { stepOverride, type Override } from "../analyst/overrides.js";
import { modelOf } from "../analyst/reference.js";
import type { Config } from "../config.js";
import { repositoryOf, stepIdentity } from "../evidence/record.js";
import { ToolIdentitySchema } from "../evidence/identity.js";
import { emitLiveTelemetry } from "../telemetry/telemetry.js";
import { repositoryFact } from "../engine/policy-hooks.js";
import type { ToolProfile } from "../tool-profile/schema.js";
import type { SessionMapping } from "../tool-profile/session.js";
import { agentSandboxed, claudeIsolated, codexIsolated, codexSandbox, gateTarget, isolationSkills, resolveStepProfile, type StepProfile, type StepProfiledFields } from "./tool-gate.js";

export { codexSandbox, claudeIsolated, isolationSkills };

type Iso = { who: CommitIdentity };

/** A step result; `final` is a refusal that no other try can change (no key for a boxed step, no private Codex folder). */
type Ran = StepResult & { final?: boolean };

async function runOn(t: Target, step: ClaudeStep, scope: Scope, engine: Engine, logFile: string, timeoutMs: number | undefined, iso: Iso | undefined, boxed: boolean, skills: SkillPayload | undefined, again: boolean, draft: boolean, catalogue: RunCatalogue | undefined, toolCheck: { tools: SessionTools; check: ToolCheck } | undefined, gate: Gate, meter?: ProcessMeter): Promise<Ran> {
  // Both agents get the same environment: no token and no Git or GitHub sign-in, an empty gh folder of its own and the commit name.
  const base = stepEnv(scope, engine, undefined, { bound: (e) => boundEnv(e, { stepTypes: stepTypesOf(scope.flow), quarantined: gate.bounded.quarantined, patterns: engine.config.help.sensitive_patterns }) });
  const pushLog = pushLogFor(engine, scope, step, scope.visits[step.id] ?? 1);
  if (pushLog) base.FACTORY_PUSH_LOG = pushLog;
  const ghDir = ghConfigDir();
  try {
    const extra = agentEnv(scope.ctx.vars.agent_env, Boolean(iso));
    // A boxed step signs in by the server's token variable only: a key a flow brings in `agent_env` is ignored.
    const dropped = boxed ? dropLoginVars(extra, providerKeyVars(engine.config)) : [];
    if (dropped.length) engine.log(`    · agent_env: ${dropped.join(", ")} ignored — a user's run signs in with the server's key only`);
    // agent_env first, then the sign-in removal, so agent_env cannot put a token, the gh folder or a protocol back
    let env: Record<string, string | undefined> = { ...base, ...botIdentityEnv(engine.config), ...extra };
    env = { ...env, ...agentNoSignInEnv(engine.config, ghDir, env) };
    // an agent gets only the file protocol: isolationEnv also serves shell steps, which keep https:file
    if (iso) env = { ...env, ...isolationEnv(env, engine.config, ghDir, iso.who), GIT_ALLOW_PROTOCOL: "file" };
    // The request file of a repo_ops step (made fresh for every try); any other step has no such variable.
    env = { ...env, ...repoRequestsEnv(engine, scope, step) };
    // A user's run gets only the short environment plus what this agent and provider need (see short-env.ts).
    const short = shortEnvRun(engine.summary.owner);
    if (short) env = shortEnv(env, engine.config, { agent: t.agent, kind: t.provider.kind });
    if (t.agent === "claude") env = { ...env, ...claudeProviderEnv(t, tokenVarNames(engine.config)) };
    // Test runs the agent starts itself go through the machine's test slots, at low priority (tools/agent-bin). A boxed step cannot write the slots folder.
    let slotWaits: SlotWaitWatch | undefined;
    if (!boxed) {
      env = { ...env, ...testGateEnv(env.PATH ?? process.env.PATH, engine.summary.runDir, env.JAVA_HOME) };
      // The waits for a slot are recorded in a folder of this try, so the time limit can leave them out. A read-only Codex session cannot write it.
      slotWaits = slotWaitsRecordable(t.agent, gate.mapping.codexSandbox) ? slotWaitsFor(engine, logFile) : undefined;
      if (slotWaits) env.FACTORY_TEST_SLOT_WAIT_DIR = slotWaits.dir;
    }
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
      const readOnly = t.agent === "codex" && gate.mapping.codexSandbox === "read-only";
      // the exact program the step will start (also one under the home, like the Claude desktop app's): the profile opens it, and runClaude/runCodex get the same path
      bin = t.agent === "codex" ? (engine.codexBin ?? resolveCodexBin()) : (engine.claudeBin ?? (await resolveClaudeBinAsync()));
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
          requestsDir: env.FACTORY_REPO_REQUESTS ? dirname(env.FACTORY_REPO_REQUESTS) : undefined,
        }),
      );
    }
    return await runWith(t, step, scope, engine, logFile, timeoutMs, env, { isolated: Boolean(iso), short, boxed, profile, bin, skills, again, draft, catalogue, toolCheck, meter, slotWaits, ...gate });
  } finally {
    removeGhConfigDir(ghDir);
  }
}

/**
 * Can the session write a wait record outside the workspace? Claude can (its sandbox gets the folder), and so can Codex with
 * `workspace-write` (writable roots) or no sandbox. A read-only Codex session cannot, so its limit counts every second as before.
 */
export function slotWaitsRecordable(agent: Target["agent"], codex: CodexSandbox): boolean {
  return agent !== "codex" || codex !== "read-only";
}

/** What the tool profile of the step decided for one try. */
interface Gate {
  /** The sandboxes the session runs with. */
  mapping: SessionMapping;
  /** The tool profile of the session (it decides whether Codex may push). `profile` below is the OS sandbox profile. */
  toolProfile: ToolProfile;
  /** The prompt with its data blocks, and the system prompt with the data note (see untrusted.ts). */
  bounded: BoundPrompt;
  /** Folders the agent may read but not edit (the run's context folder). Claude only; Codex reads the disk and never writes there. */
  readOnlyDirs?: string[];
}

interface WithOptions extends Gate {
  /** Filled by the process of this attempt (see ProcessMeter). */
  meter?: ProcessMeter;
  /** Where test-slot records the waits of this try (absent: not recorded). */
  slotWaits?: SlotWaitWatch;
  isolated: boolean;
  short: boolean;
  /** Held by the OS sandbox profile: the agent's own sandbox is off. */
  boxed: boolean;
  profile?: string;
  /** The program a boxed step starts (the one the profile opens). */
  bin?: string;
  /** The skill block of this session (the run's lock, or review checks), for Claude and Codex. */
  skills?: SkillPayload;
  /** The block is for a draft plan under review: it does not isolate a Codex session and is not refused on an old CLI. */
  draft?: boolean;
  /** Not the first session of this step: a retry or a fallback. */
  again?: boolean;
  /** The skill catalogue of a `skills: catalog` step: put before the prompt on both agents. */
  catalogue?: RunCatalogue;
  /** A Claude coder session: what the step gives and how the locked skills were checked against it. */
  toolCheck?: { tools: SessionTools; check: ToolCheck };
}

/** The folders outside the workspace a session may write: the request folder of a repo_ops step and the folder of slot waits. Undefined when there are none. */
function writable(env: Record<string, string | undefined>, slotWaits?: SlotWaitWatch): string[] | undefined {
  const dirs = [...(env.FACTORY_REPO_REQUESTS ? [dirname(env.FACTORY_REPO_REQUESTS)] : []), ...(slotWaits ? [slotWaits.dir] : [])];
  return dirs.length ? dirs : undefined;
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

/** May the session a step continues hold a skill this step was not given? The last digest a session recorded does not prove what its transcript holds, so any left-out skill means no resume. */
export function resumeHoldsLeftOut(check: Pick<ToolCheck, "leftOut"> | undefined): boolean {
  return Boolean(check?.leftOut.length);
}

/** The record of a skill block on a step result. */
function skillsRecord(s?: SkillPayload, attach?: ReturnType<typeof attachSkillPayload>, grant?: SessionToolGrant): Pick<StepResult, "skills"> {
  return s ? { skills: { ...(grant ? { grant } : {}), loaded: s.loaded, ...(s.omitted.length ? { omitted: s.omitted } : {}), bytes: s.bytes, estimatedTokens: s.estimatedTokens, ...(s.role ? { role: s.role } : {}), ...(attach ? { state: attach.state, digest: attach.digest, attachedBytes: attach.attachedBytes, attachedEstimatedTokens: attach.attachedEstimatedTokens } : {}) } } : {};
}

function catalogueRecord(o: WithOptions): Pick<StepResult, "skillCatalogue"> {
  return o.catalogue?.record ? { skillCatalogue: o.catalogue.record } : {};
}

/**
 * What the analyst set for this step, as far as it applies now: nothing when a router rule of yours
 * matches the step (your policy wins), and nothing when the flow no longer says what it said when the
 * analyst set it (`from`), so an edit of the flow wins too. A model is only replaced inside the
 * step's own target: the agent and the provider stay, and it must be a Claude step (the analyst only
 * knows the Claude model levels).
 */
export function analystSet(step: ClaudeStep, flow: Flow, config: Config, visit: number): { target?: Target; effort?: Override["effort"] } {
  const o = stepOverride(flow.name, step.id);
  if (!o.model && !o.effort) return {};
  if (routeModel(config, flow.name, step.id, visit)) return {};
  let own: Target;
  try {
    own = resolveTarget(step, flow, config, visit);
  } catch {
    return {}; // the step's own target is the error to report, not the override
  }
  if (o.from && (o.from.model !== modelOf(own.label) || o.from.effort !== (step.effort ?? flow.defaults.effort ?? ""))) return {};
  const model = own.agent === "claude" && o.model !== own.model ? o.model : undefined;
  return {
    ...(o.effort ? { effort: o.effort } : {}),
    ...(model ? { target: { ...own, model, label: formatSpec({ agent: own.agent, provider: own.providerName, model }) } } : {}),
  };
}

async function runWith(t: Target, step: ClaudeStep, scope: Scope, engine: Engine, logFile: string, timeoutMs: number | undefined, env: Record<string, string | undefined>, o: WithOptions): Promise<Ran> {
  const { isolated, short, boxed, profile, bin } = o;
  const { ctx, flow } = scope;
  const d = flow.defaults;
  const local = LOCAL_KINDS.includes(t.provider.kind);
  const asked = agentSandboxed(step, scope, engine);
  // profiles may not nest: the outer profile holds a boxed step, so the agent's own sandbox is off
  const sandboxed = boxed ? false : o.mapping.claudeSandbox;
  if (boxed && asked && t.agent === "claude") engine.log("    · Claude's own sandbox is off: the run's sandbox holds this step");
  const tuned = analystSet(step, flow, engine.config, scope.visits[step.id] ?? 1).effort;
  if (tuned && tuned !== (step.effort ?? d.effort)) engine.log(`    · effort ${tuned}: set by the analyst`);
  const effort = tuned ?? step.effort ?? d.effort;
  const { asked: resumeAsked, id: askedId, prevAgent, holds } = sessionToResume(step, ctx.steps, t.agent);
  let resumeId = askedId;
  if (resumeAsked && !resumeId) engine.log(`    · not resuming ${step.resume}: it ran on ${prevAgent}, this step on ${t.agent}`);
  if (resumeId && (step.skills === "off" || step.skills === "catalog")) {
    resumeId = undefined;
    engine.log(`    · not resuming ${step.resume}: this step has skills: ${step.skills} and a resumed session may hold a skill block`);
  }
  const prev = step.resume ? ctx.steps[step.resume] : undefined;
  // A skill left out of this step for its tools must not come back with the transcript of the earlier session.
  if (resumeId && t.agent === "claude" && resumeHoldsLeftOut(o.toolCheck?.check)) {
    resumeId = undefined;
    engine.log(`    · not resuming ${step.resume}: a skill was left out of this step for its tools and that session may hold it`);
  }
  // A Codex session lives in one Codex folder: resume only where the earlier step ran with the same one.
  const locked = o.draft ? undefined : o.skills;
  let home: string | undefined;
  let mode: CodexIsolation | undefined;
  let clean: CleanCodex | undefined;
  if (t.agent === "codex") {
    const seen = (n: string) => (n in env ? env[n] : short ? undefined : process.env[n]);
    const personal = personalCodexDir({ codexHome: seen("CODEX_HOME"), home: seen("HOME") });
    // 1. mode: a boxed step already has the run's folder. Runs the server starts are always isolated; a block from the run's lock isolates the session even with isolate_agents off; a draft review block does not.
    if (!boxed) mode = codexIsolationMode({ isolate: codexIsolated({ source: engine.summary.source, isolateAgents: engine.config.isolate_agents, isolated, skills: locked }), local, hasKey: Boolean(seen("CODEX_API_KEY")) });
    // 2. the clean Codex folder: never the personal one when it cannot be made
    if (boxed || mode === "private" || mode === "login") {
      const made = prepareCleanCodex({
        runDir: engine.summary.runDir,
        env,
        config: engine.config,
        kind: t.provider.kind,
        short,
        isolated,
        boxed,
        mode,
        sandbox: boxed ? "danger-full-access" : o.mapping.codexSandbox,
        personal,
        profile: o.toolProfile,
        repo: ctx.vars.github_repo,
      });
      if ("refused" in made) {
        if (made.access) engine.accessFailed = true;
        return { ok: false, output: made.refused, error: made.refused, final: true };
      }
      clean = made;
      env = made.env;
    }
    // 3. the folder this session lives in
    home = codexHomeId({ run: Boolean(clean), codexHome: seen("CODEX_HOME"), home: seen("HOME") });
    // 4. resume only in the same folder
    const reason = resumeId ? codexResumeRefusal(prev!.codex_home, home) : undefined;
    if (reason) {
      resumeId = undefined;
      engine.log(`    · not resuming ${step.resume}: ${reason}`);
    }
    const line = mode ? codexIsolationLine(mode) : undefined;
    if (line) engine.log(`    · ${line}`);
    if (clean && !clean.push) engine.log(`    · ${CODEX_PUSH_BLOCKED_LINE}`);
  }
  // Codex never reuses a block: a resumed Codex session gets it again.
  const attach = o.skills ? attachSkillPayload(o.skills, { continues: t.agent === "claude" && Boolean(resumeId), holds, again: resumeAsked || Boolean(o.again) }) : undefined;
  const skills = skillsRecord(o.skills, attach);
  const logSkills = () => {
    if (!o.skills || !attach) return;
    const keys = o.skills.loaded.join(", ");
    if (attach.state === "reused") engine.log(`    · skill context: reused ${keys} from the session of ${step.resume}; nothing added`);
    else engine.log(`    · skill context: ${attach.state} ${keys} (${attach.attachedBytes} bytes, about ${attach.attachedEstimatedTokens} tokens)${attach.state === "reloaded" ? (t.agent === "codex" && resumeId ? ": the full block is sent again" : ": new session") : ""}`);
  };
  const common = {
    prompt: withSkillPayload(withSkillPayload(o.bounded.prompt, attach?.text ?? ""), o.catalogue?.text ?? ""),
    systemPrompt: o.bounded.system,
    cwd: engine.summary.workdir!,
    logFile,
    timeoutMs,
    meter: o.meter,
    slotWaits: o.slotWaits,
    priority: engine.config.governor.priority,
    signal: engine.signal,
    resumeSessionId: resumeId,
    onProgress: (m: string) => engine.log(`    · ${m}`),
  };
  engine.log(`    · agent ${t.label}`);
  if (t.agent === "codex") logSkills();

  if (t.agent === "codex") {
    if (env.FACTORY_REPO_REQUESTS && !boxed && o.mapping.codexSandbox === "read-only") {
      const refused = "repo_ops needs a Codex session that can write the request file; a read-only session outside the run sandbox cannot";
      engine.log(`    ! repo: ${refused}`);
      return { ok: false, output: refused, error: refused, final: true };
    }
    const builtinUrl = BUILTIN_PROVIDERS[t.providerName]?.base_url;
    let r: Awaited<ReturnType<typeof runCodex>>;
    try {
      r = await runCodex({
        ...common,
        env,
        cleanEnv: clean?.cleanEnv ?? short,
        codexBin: bin ?? engine.codexBin,
        model: t.model,
        localProvider: local ? t.provider.kind : undefined,
        localBaseUrl: local && t.provider.base_url !== builtinUrl ? t.provider.base_url : undefined,
        sandboxProfile: profile,
        sandbox: boxed ? "danger-full-access" : o.mapping.codexSandbox,
        reviewer: step.skill_role === "reviewer",
        agentNote: mode !== undefined && mode !== "off",
        // unset (not isolated): a reviewer skips the personal config as before; a clean folder never needs the flag
        ignoreUserConfig: mode === "off" ? undefined : false,
        clean: Boolean(clean),
        noNetwork: Boolean(clean && !clean.push),
        writableRoots: writable(env, o.slotWaits),
        effort,
      });
    } finally {
      // the lent login comes back after every session, also when it failed
      const back = clean ? codexLoginReturnLine(clean.done()) : undefined;
      if (back) engine.log(`    ${back}`);
    }
    const p = t.provider.price;
    const costUsd = p ? (r.inputTokens * p.input_per_mtok + r.outputTokens * p.output_per_mtok) / 1e6 : 0;
    return { ok: r.ok, output: r.output, error: r.error, sessionId: r.sessionId, codexHome: home, costUsd, agent: t.label, ...(effort ? { effort } : {}), tokens: { input: r.inputTokens, output: r.outputTokens }, ...(r.slotWaitMs ? { slotWaitMs: r.slotWaitMs } : {}), ...skills, ...catalogueRecord(o) };
  }

  // No --max-budget-usd at all when cost limits are off (fixed-price subscriptions); costs are still recorded.
  const caps = t.free || !engine.config.cost_limits ? [] : [step.max_budget_usd ?? d.max_budget_usd, engine.remainingBudget()].filter((n): n is number => n !== undefined);
  const isolatedSession = claudeIsolated(engine.config.isolate_agents, isolated, isolationSkills(o.skills, o.toolCheck?.check), step.skill_role === "reviewer");
  if (isolatedSession && !engine.config.isolate_agents && !isolated) engine.log("    · skills: this session runs without the personal Claude setup");
  let claudeSkills = skills;
  if (o.toolCheck) {
    claudeSkills = skillsRecord(o.skills, attach, sessionToolGrant(o.toolCheck.tools, o.toolCheck.check, isolatedSession));
    engine.log(`    · ${sessionToolsLine(o.toolCheck.tools)}`);
  }
  logSkills();
  const limit = evaluationLimits();
  const stepId = stepIdentity(step, scope.prefix, scope.visits[step.id] ?? 1);
  const repository = repositoryOf(scope.ctx.vars);
  const r = await runClaude({
    ...common,
    env,
    cleanEnv: short,
    sandboxProfile: profile,
    ...(limit ? { tools: [...limit.tools] } : {}),
    claudeBin: bin ?? engine.claudeBin,
    model: t.model,
    permissionMode: step.permission_mode ?? d.permission_mode ?? DEFAULT_PERMISSION_MODE,
    allowedTools: step.allowed_tools ?? d.allowed_tools,
    maxBudgetUsd: caps.length ? Math.max(0.01, Math.min(...caps)) : undefined,
    sandbox: sandboxed,
    writableDirs: writable(env, sandboxed ? o.slotWaits : undefined),
    readOnlyDirs: o.readOnlyDirs,
    noMcp: local,
    isolated: isolatedSession,
    effort,
    onTool: (name, durationMs) => {
      const tool = ToolIdentitySchema.safeParse({ name });
      // whole, non-negative ms only: anything else is left out rather than making the event invalid
      const ms = typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : undefined;
      if (tool.success) emitLiveTelemetry("tool", "tool.called", { runId: engine.summary.runId, step: stepId, ...(repository ? { repository } : {}), tool: tool.data, ...(ms !== undefined ? { durationMs: ms } : {}) });
    },
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
    ...(effort ? { effort } : {}),
    tokens: r.inputTokens !== undefined ? { input: r.inputTokens, output: r.outputTokens ?? 0 } : undefined,
    ...(r.tools ? { tools: r.tools } : {}),
    ...(r.contextTokens !== undefined ? { contextTokens: r.contextTokens } : {}),
    ...(r.slotWaitMs ? { slotWaitMs: r.slotWaitMs } : {}),
    ...claudeSkills,
    ...catalogueRecord(o),
  };
}

/**
 * Run an agent step on the target the step, router and defaults pick. On a rate or usage
 * limit, retry on the router's fallbacks in order. When the budget is used up the loop sets
 * engine.budgetFallback and every agent step runs on that free target instead.
 */
export async function runAgentStep(step: ClaudeStep, scope: Scope, engine: Engine, logFile: string, timeoutMs?: number, meter?: ProcessMeter): Promise<StepResult> {
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
    const visit = scope.visits[step.id] ?? 1;
    // your router rules are your policy and win; below them the analyst may have set another model for this step
    const tuned = engine.budgetFallback ? undefined : analystSet(step, scope.flow, config, visit).target;
    target = engine.budgetFallback ?? tuned ?? resolveTarget(step, scope.flow, config, visit);
    if (tuned) engine.log(`    · model ${tuned.model}: set by the analyst`);
  } catch (e) {
    return { ok: false, output: "", error: (e as Error).message };
  }
  const fallbacks = config.router.fallback_on.includes("rate_limit") ? fallbackTargets(config) : [];
  const tried = new Set<string>();
  let blips = 0;
  let models = 0;
  // Tool times and context size over every try: a retry must not hide a slower call or a larger context of an earlier one.
  let toolTimes: StepResult["tools"];
  let contextTokens: number | undefined;
  let slotWaitMs = 0;
  const seen = (r: Pick<StepResult, "tools" | "contextTokens" | "slotWaitMs">) => {
    slotWaitMs += r.slotWaitMs ?? 0;
    if (r.tools) toolTimes = { calls: (toolTimes?.calls ?? 0) + r.tools.calls, totalMs: (toolTimes?.totalMs ?? 0) + r.tools.totalMs, maxMs: Math.max(toolTimes?.maxMs ?? 0, r.tools.maxMs) };
    if (r.contextTokens !== undefined) contextTokens = Math.max(contextTokens ?? 0, r.contextTokens);
  };
  const tries = () => ({
    ...(blips || models ? { retried: { blips, models } } : {}),
    ...(toolTimes ? { tools: toolTimes } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    ...(slotWaitMs ? { slotWaitMs } : {}),
  });
  // Built once: one log line and the same bytes for every try, retries and fallbacks included.
  const canon =
    step.skills === "catalog"
      ? liveCanonicalDeps({ config, workdir: engine.summary.workdir, home: dataHome(), repository: engine.summary.vars?.github_repo || undefined })
      : undefined;
  const catalogue =
    step.skills === "catalog"
      ? runSkillCatalogue(
          { workdir: engine.summary.workdir, config, task: catalogueTaskText(scope.ctx.task as string | undefined, String(scope.ctx.steps?.[CATALOGUE_ISSUE_STEP]?.output ?? "")) },
          canon ? { canonical: canon } : {},
        )
      : undefined;
  if (catalogue) engine.log(`    · ${catalogue.log}`);
  if (catalogue?.blocked) {
    engine.log(`    ! ${catalogue.blocked}`);
    engine.accessFailed = true;
    return { ok: false, output: catalogue.blocked, error: catalogue.blocked };
  }
  const tools = sessionTools({
    stepId: scope.prefix + step.id,
    step,
    defaults: scope.flow.defaults,
    sandbox: { step: step.sandbox, flow: scope.flow.sandbox.claude, config: config.sandbox.claude, boxed },
  });
  const identity = stepIdentity(step, scope.prefix, scope.visits[step.id] ?? 1);
  let fallbackFrom: string | undefined;
  const repository = repositoryFact(scope.ctx.vars);
  // The agent works in the repository's checkout, and never has a sign-in of its own; repository work goes through the broker or a shell step (policy: a mandatory policy that cannot be used stops it).
  const access = engine.policy?.repository(identity, { repository, step: step.id, credential: "none", isolated: iso !== undefined });
  if (access?.denied) return refuseByPolicy(engine, identity, access.denied);
  // One tool profile per step: the same for Claude and Codex, and for every try. A declared profile the step cannot stay within is refused before an agent is picked.
  const resolved: StepProfile | { refused: string; event: StepProfiledFields } = resolveStepProfile(step, scope, engine, { boxed, isolated: iso !== undefined });
  if ("refused" in resolved) {
    engine.evidence?.stepProfiled(identity, resolved.event);
    engine.log(`    ! ${resolved.refused}`);
    engine.accessFailed = true;
    return { ok: false, output: resolved.refused, error: resolved.refused };
  }
  // Deterministic bounding of everything from outside the policy; a refusal here is a denial like the ones above.
  let bounded: BoundPrompt;
  // `{{context.index}}` becomes the list of the run's context files, or the pasted issue when there is no bundle; a bundle that cannot be used stops the step.
  const withIndex = stepContextIndex({ summary: engine.summary, step, ctx: scope.ctx });
  if ("refuse" in withIndex) {
    engine.log(`    ! ${withIndex.refuse}`);
    engine.accessFailed = true;
    return { ok: false, output: withIndex.refuse, error: withIndex.refuse };
  }
  if (withIndex.log) engine.log(`    ${withIndex.log}`);
  const readOnlyDirs = withIndex.readOnlyDirs;
  try {
    bounded = boundAgentPrompt({ ...step, prompt: withIndex.prompt }, withIndex.ctx, { stepTypes: stepTypesOf(scope.flow), patterns: config.help.sensitive_patterns });
  } catch (e) {
    if (!(e instanceof UntrustedRefusal || e instanceof GuardError)) throw e;
    engine.log(`    ! ${e.message}`);
    engine.accessFailed = true;
    return { ok: false, output: e.message, error: e.message };
  }
  const memo = new Map<string, OutputLabel>();
  const heldFor = !scope.prefix && engine.summary.heldContent?.step === step.id ? engine.summary.heldContent.sha256 : undefined;
  for (;;) {
    // only the final attempt counts
    if (meter) {
      meter.ms = undefined;
      meter.printedBytes = undefined;
      meter.slotWaitMs = undefined;
    }
    // Before every session of the agent, retries and fallbacks included: the skills this run locked must still be what they were.
    const session = skillSession(engine, {}, step.skill_role ?? "coder", step.skills !== "off" && step.skills !== "catalog", target.agent === "claude" ? tools : undefined);
    if ("refused" in session) {
      engine.log(`    ! skill context: rejected (${session.refused})`);
      engine.accessFailed = true;
      return { ok: false, output: session.refused, error: session.refused, ...tries() };
    }
    // Before every session that can write, retries and fallbacks included, with the sandbox the target really gets.
    if (!readOnlyStep(step, scope.flow.defaults)) {
      const sandboxed = boxed || (target.agent === "codex" ? resolved.mapping.codexSandbox !== "danger-full-access" : resolved.mapping.claudeSandbox);
      const write = engine.policy?.at("agent.write", { repository, step: step.id, isolated: iso !== undefined, sandboxed }, identity);
      if (write?.denied) return { ...refuseByPolicy(engine, identity, write.denied), ...tries() };
    }
    if (!tried.has(target.label)) engine.evidence?.stepRouted(identity, target.label, stepOverride(scope.flow.name, step.id).effort ?? step.effort ?? scope.flow.defaults.effort, fallbackFrom);
    tried.add(target.label);
    // Every try records how well this agent holds the profile; a declared profile it cannot hold is refused here, with no retry or fallback.
    const gated = gateTarget(target, resolved, { step, engine, boxed, isolated: iso !== undefined, skills: session.payload, check: session.tools, draft: Boolean(session.draft), repo: scope.ctx.vars.github_repo });
    engine.evidence?.stepProfiled(identity, gated.event);
    engine.log(`    ${gated.refused ? "!" : "·"} ${gated.line}`);
    if (gated.refused) {
      engine.accessFailed = true;
      return { ok: false, output: gated.refused, error: gated.refused, ...tries() };
    }
    // After every deterministic denial: the optional classifier, then the hold for a person's approval.
    const classified = await classifyBound(bounded, { classifier: engine.classifier, approved: engine.summary.approvedContent, heldFor, stepId: step.id, memo });
    if (classified.items.length) engine.log(`    · ${classified.items.length} data block${classified.items.length === 1 ? "" : "s"}, highest risk ${classified.labels.reduce((m, l) => (l.risk === "high" || (l.risk === "elevated" && m === "low") ? l.risk : m), "low" as OutputLabel["risk"])}, ${classified.quarantined.size} quarantined`);
    if (classified.held) {
      const reason = classified.held.reason;
      engine.log(`    ! ${reason}`);
      if (scope.depth > 0) {
        engine.accessFailed = true;
        return { ok: false, output: reason, error: reason, ...tries() };
      }
      return { ok: false, output: reason, error: reason, held: classified.held.sha256, ...tries() };
    }
    const { final, ...r } = await runOn(target, step, scope, engine, logFile, timeoutMs, iso, boxed, session.payload, blips + models > 0, Boolean(session.draft), catalogue, session.tools && { tools, check: session.tools }, { mapping: gated.mapping, toolProfile: resolved.session.profile, bounded: classified, readOnlyDirs }, meter);
    seen(r);
    if (r.ok || engine.signal?.aborted || final) return await applyRepoRequests({ engine, scope, step, identity, logFile, profile: resolved.session.profile }, { ...r, ...tries() });
    // The service was briefly unavailable (overloaded, "at capacity", a network blip): wait and try
    // the same step again a few times before treating it as a limit.
    if (isTransientError(r.error, r.output) && !isAuthError(r.error, r.output) && blips < TRANSIENT_RETRIES.length) {
      const wait = TRANSIENT_RETRIES[blips++]!;
      engine.log(`    ↻ ${target.label}: ${(r.error || r.output).trim().split("\n")[0]!.slice(0, 120)} — trying again in ${Math.round(wait / 1000)}s`);
      engine.summary.totalCostUsd += r.costUsd ?? 0;
      if (!(await pause(wait, engine.signal))) return { ...r, ...tries() };
      engine.evidence?.stepRetried(identity, "outage");
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
    engine.evidence?.stepRetried(identity, "limit");
    fallbackFrom = target.label;
    target = next;
  }
}

/**
 * The environment of the test gate of agent steps: tools/agent-bin first on the PATH and the machine's slots folder
 * (next to `runs/`, where the test steps of a flow take theirs). The gate sends test commands through tools/test-slot.
 */
export function testGateEnv(path: string | undefined, runDir: string, javaHome?: string): Record<string, string> {
  const bin = join(TOOLS_DIR, "agent-bin");
  const rest = (path ?? "").split(delimiter).filter((p) => p && p !== bin);
  const env: Record<string, string> = { PATH: [bin, ...rest].join(delimiter), FACTORY_TEST_SLOTS_DIR: join(runDir, "..", "..", "test-slots") };
  // A wrapper started by its path (./gradlew, ./mvnw) ends in $JAVA_HOME/bin/java: JAVA_HOME becomes a stand-in JDK whose
  // java goes through the gate (the JDK the wrapper would find itself, when JAVA_HOME is not set). Without one: the PATH only.
  const home = javaHome || discoverJavaHome(path);
  const stand = home ? javaStandIn(home, join(runDir, "..", "..", "agent-java")) : undefined;
  if (stand) {
    env.JAVA_HOME = stand.home;
    env.FACTORY_REAL_JAVA_HOME = stand.real;
  }
  return env;
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
