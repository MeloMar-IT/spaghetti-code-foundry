import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import type { PolicyDecision } from "../policy/schema.js";
import { contextBundleRef, contextTotalBytes, hashContextSources } from "../context/bundle.js";
import { CONTEXT_OMISSION_REASONS, type ContextBundle, type ContextOmissionReason } from "../context/schema.js";
import type { RunContextCode } from "../engine/run-context.js";
import type { RunSummary, StepRecord } from "../engine/state.js";
import type { Step } from "../flow/schema.js";
import {
  CommitSchema, GitIdentitySchema, isSafeRelativePath, modelIdentityOf, PullRequestIdentitySchema, RepositorySchema, StepIdSchema, ToolIdentitySchema,
  type Actor, type ArtifactRef, type GitIdentity, type ModelIdentity, type PullRequestIdentity, type StepIdentity, type TestResult,
} from "./identity.js";
import type { Denial } from "./schema.js";
import { emitTelemetry,telemetryEnabled } from "../telemetry/telemetry.js";
import { telemetryFromEvidence } from "../telemetry/envelope.js";
import { closeEvidenceStream, evidenceStream, hashPlainFile, type EvidenceEventBody, type EvidenceStream } from "./stream.js";

/**
 * What the engine tells the evidence stream. Every method takes what the engine already has and turns it into one
 * event (or none); none of them throws, and none of them reads a prompt, an output or another free text.
 */

export const SYSTEM_ACTOR: Actor = { kind: "system" };

/**
 * Who asked for a run, from what is saved with it. `account` is the id of the person who asked (never the account a
 * run without an asker falls to). Anything that is not known is the Foundry itself.
 */
export function actorOf(source: string | undefined, account?: string): Actor {
  if (account !== undefined && z.uuid().safeParse(account).success) return { kind: "user", id: account };
  if (source === "cli") return { kind: "cli" };
  const watcher = /^watcher ([\w-]{1,128})(?: |$)/.exec(source ?? "")?.[1];
  return watcher ? { kind: "watcher", id: watcher } : SYSTEM_ACTOR;
}

/** The model name evidence gives a target that names none ("codex:openai"): the agent then picks its own model. */
export const AGENT_DEFAULT_MODEL = "default";

/** The model of an agent target such as "codex:openai:gpt-5" or "claude:anthropic". An effort that is not a short label is left out. */
export function targetModel(target: unknown, effort?: string): ModelIdentity | undefined {
  if (typeof target !== "string") return undefined;
  const full = target.split(":").length === 2 ? `${target}:${AGENT_DEFAULT_MODEL}` : target;
  return modelIdentityOf(full, effort) ?? modelIdentityOf(full);
}

/** One visit of a step as evidence names it. */
export function stepIdentity(step: Pick<Step, "id" | "type">, prefix: string, visit: number): StepIdentity {
  return { id: step.id, visit, type: step.type, ...(prefix ? { parent: prefix.replace(/\/$/, "") } : {}) };
}

function identityOfRecord(rec: StepRecord): StepIdentity {
  const id = rec.parent && rec.id.startsWith(`${rec.parent}/`) ? rec.id.slice(rec.parent.length + 1) : rec.id;
  return { id, visit: rec.visit, type: rec.type, ...(rec.parent ? { parent: rec.parent } : {}) };
}

/**
 * A shell step whose id has the word "test" or "tests" (words are split by `_` and `-`), such as `test`,
 * `run_tests` or `test_main`, counts as a test run. The flow format has no other mark for it.
 */
export function isTestStep(rec: Pick<StepRecord, "id" | "type">): boolean {
  const own = rec.id.slice(rec.id.lastIndexOf("/") + 1);
  return rec.type === "shell" && own.split(/[_-]/).some((w) => w === "test" || w === "tests");
}

/** The commit with the branch and repository of the run, when each of them has a form evidence can hold. */
function gitIdentity(commit: string | undefined, run: Pick<RunSummary, "branch" | "vars">): GitIdentity | undefined {
  if (!CommitSchema.safeParse(commit).success) return undefined;
  const branch = GitIdentitySchema.shape.branch.safeParse(run.branch || undefined);
  const repo = repositoryOf(run.vars);
  return { commit: commit!, ...(branch.success && branch.data ? { branch: branch.data } : {}), ...(repo ? { repository: repo } : {}) };
}

export function repositoryOf(vars: Record<string, string> | undefined): string | undefined {
  const name = vars?.github_repo;
  return name && name !== "owner/repo" && RepositorySchema.safeParse(name).success ? name : undefined;
}

/** The pull request a run is about: only for a run that was started for one (`vars.pr`). */
function pullRequestOf(vars: Record<string, string> | undefined): PullRequestIdentity | undefined {
  const repository = repositoryOf(vars);
  if (!repository || !/^[1-9]\d{0,9}$/.test(vars?.pr ?? "")) return undefined;
  const pr = PullRequestIdentitySchema.safeParse({ repository, number: Number(vars!.pr), url: `https://github.com/${repository}/pull/${vars!.pr}` });
  return pr.success ? pr.data : undefined;
}

function headCommit(run: Pick<RunSummary, "workdir" | "baseSha">): string | undefined {
  if (!run.baseSha || !run.workdir || !existsSync(run.workdir)) return undefined;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: run.workdir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

export class RunRecorder {
  constructor(
    private readonly stream: EvidenceStream,
    private readonly runDir: string,
    private readonly repository?: string,
  ) {}

  /**
   * Makes the event and writes it. A problem while making it stops the stream like a failed write. The same event is
   * also given to telemetry, with the same time, even when the evidence stream has stopped.
   */
  private put(make: () => EvidenceEventBody | undefined, time?: string): boolean {
    let body: EvidenceEventBody | undefined;
    try {
      body = make();
    } catch (e) {
      this.stream.stop(e);
      return false;
    }
    if (!body) return false;
    const at = time ?? new Date().toISOString();
    const written = this.stream.append(body, at);
    if (telemetryEnabled()) emitTelemetry(telemetryFromEvidence(this.stream.runId, body, written, at, this.repository));
    return written !== undefined;
  }

  /** `queuedAt`: when the job was put in the queue. A new run has no folder then, so the event is written now with that time. */
  queued(queuedAt: string | undefined): void {
    if (queuedAt !== undefined) this.put(() => ({ type: "run.queued" }), queuedAt);
  }

  created(run: Pick<RunSummary, "flow" | "flowDef" | "localTest">, by: Actor): void {
    this.put(() => {
      const version = run.flowDef?.publish?.enabled ? run.flowDef.publish.version : undefined;
      return { type: "run.created", flow: { name: run.flow, ...(version !== undefined ? { version } : {}) }, by, ...(run.localTest ? { localTest: true as const } : {}) };
    });
  }

  started(run: Pick<RunSummary, "baseSha" | "branch" | "vars">): void {
    this.put(() => {
      const base = gitIdentity(run.baseSha, run);
      return { type: "run.started", ...(base ? { base } : {}) };
    });
  }

  resumed(from: string, by: Actor): void {
    this.put(() => ({ type: "run.resumed", from, by }));
  }

  /** The end of one start of the run: its last event until it is started again. */
  ended(run: Pick<RunSummary, "status" | "state" | "workdir" | "baseSha" | "branch" | "vars">, o: { failedStep?: StepIdentity; cancelledBy?: Actor } = {}): void {
    this.put(() => {
      switch (run.status) {
        case "succeeded": {
          const final = gitIdentity(headCommit(run), run);
          const pullRequest = pullRequestOf(run.vars);
          return { type: "run.completed", ...(final ? { final } : {}), ...(pullRequest ? { pullRequest } : {}) };
        }
        case "failed":
          return { type: "run.failed", ...(o.failedStep ? { step: o.failedStep } : {}) };
        case "cancelled":
          return { type: "run.cancelled", by: o.cancelledBy ?? SYSTEM_ACTOR };
        case "stopped":
        case "waiting": {
          const at = run.state?.next;
          return { type: "run.stopped", ...(typeof at === "string" && StepIdSchema.safeParse(at).success ? { at } : {}) };
        }
        default:
          return undefined;
      }
    });
    closeEvidenceStream(this.runDir);
  }

  stepStarted(step: StepIdentity): void {
    this.put(() => ({ type: "step.started", step }));
  }

  /** The step is given to a model. `target` and `from` are agent targets such as "codex:openai:gpt-5". */
  stepRouted(step: StepIdentity, target: string, effort: string | undefined, from?: string): void {
    this.put(() => {
      // a target that is not one (an agent the evidence format does not know) gives no event; the step's end is still recorded
      const model = targetModel(target, effort);
      if (!model) return undefined;
      const fallbackFrom = targetModel(from);
      return { type: "step.routed", step, model, ...(fallbackFrom ? { fallbackFrom } : {}) };
    });
  }

  /** The tool profile of one try, with how well the agent holds it. */
  stepProfiled(step: StepIdentity, fields: Omit<Extract<EvidenceEventBody, { type: "step.profiled" }>, "type" | "step">): void {
    this.put(() => ({ type: "step.profiled", step, ...fields }));
  }

  stepRetried(step: StepIdentity, cause: "outage" | "limit"): void {
    this.put(() => ({ type: "step.retried", step, cause }));
  }

  /** The decision of a person at an approval step. */
  stepDecided(step: StepIdentity, approved: boolean, by: Actor): void {
    this.put(() => (approved ? { type: "step.approved", step, by } : { type: "step.denied", step, denial: { kind: "approval", by } }));
  }

  /** A policy refused the step (see policy-hooks.ts `PolicyDenied`). */
  stepDenied(step: StepIdentity, denial: Denial): void {
    this.put(() => ({ type: "step.denied", step, denial }));
  }

  /** A policy refused something about the whole run, not one step: `step.denied` without `step`. Only a policy denial fits. */
  runDenied(denial: Denial): void {
    this.put(() => ({ type: "step.denied", denial }));
  }

  /** Something that had to be recorded could not be: the stream stops and the run has no manifest. The run itself goes on. */
  incomplete(e: unknown): void {
    this.stream.stop(e);
  }

  /** A policy pack decided at a boundary. `step` is given exactly for the boundaries that are about a step. True when the event is in the evidence. */
  policyDecided(decision: PolicyDecision, step?: StepIdentity): boolean {
    return this.put(() => ({ type: "policy.decided", decision, ...(step ? { step } : {}) }), decision.evaluatedAt);
  }

  /** The repository broker did, or refused, one operation. */
  repoOperation(fields: Omit<Extract<EvidenceEventBody, { type: "repo.operation" }>, "type">): void {
    this.put(() => ({ type: "repo.operation", ...fields }));
  }

  /** The context bundle of the run was written, or making it failed with a fixed code. */
  contextBundled(result: { bundle: ContextBundle } | { failed: RunContextCode }): void {
    this.put(() => {
      if ("failed" in result) return { type: "context.bundled", outcome: "failed", failure: result.failed };
      const b = result.bundle;
      const omitted = Object.fromEntries(CONTEXT_OMISSION_REASONS.map((r) => [r, b.omitted.filter((o) => o.reason === r).length])) as Record<ContextOmissionReason, number>;
      return {
        type: "context.bundled",
        outcome: "written",
        bundle: contextBundleRef(b),
        sourcesSha256: hashContextSources(b),
        limits: b.budget,
        sources: b.sources.length,
        bytes: contextTotalBytes(b),
        omitted,
      };
    });
  }

  /** The governance check of a production run (#665): only kinds, ids, versions and fixed words. */
  governanceDecided(fields: Omit<Extract<EvidenceEventBody, { type: "governance.decided" }>, "type">): void {
    this.put(() => ({ type: "governance.decided", ...fields }));
  }

  /** The end of one visit: a `step.denied` for every tool the agent was refused, then `step.completed` or `step.failed`. */
  stepEnded(rec: StepRecord): void {
    let step: StepIdentity;
    try {
      step = identityOfRecord(rec);
      for (const d of rec.denied ?? []) {
        // "Bash: mkdir out": only the name of the tool is evidence, never what it was asked to do
        const tool = ToolIdentitySchema.safeParse({ name: String(d).split(": ")[0] });
        if (tool.success) this.put(() => ({ type: "step.denied", step, denial: { kind: "tool", tool: tool.data } }));
      }
    } catch (e) {
      // nothing here may reach the engine: an odd record costs the evidence, never the run
      this.stream.stop(e);
      return;
    }
    this.put(() => {
      const model = targetModel(rec.agent, rec.effort);
      const test: TestResult | undefined = isTestStep(rec) ? { suite: rec.id, outcome: rec.ok ? "passed" : "failed" } : undefined;
      const end = {
        step,
        ...(model ? { model } : {}),
        ...(typeof rec.exitCode === "number" && Number.isInteger(rec.exitCode) ? { exitCode: rec.exitCode } : {}),
        durationMs: Math.max(0, Math.round(rec.durationMs)),
        artifacts: this.logOf(rec),
        ...(test ? { test } : {}),
      };
      return rec.ok ? { type: "step.completed", ...end } : { type: "step.failed", ...end };
    });
  }

  /** The log of a step as a reference: the transcript of an agent step, the output of a shell step. Named, never copied. */
  private logOf(rec: StepRecord): ArtifactRef[] {
    const path = relative(this.runDir, rec.logFile).split(sep).join("/");
    if (!isSafeRelativePath(path)) return [];
    const file = hashPlainFile(join(this.runDir, path));
    return file ? [{ kind: rec.type === "claude" ? "transcript" : "log", path, ...file, required: true }] : [];
  }
}

/** The recorder of a run. Making it reads and writes nothing. */
export function runRecorder(run: Pick<RunSummary, "runDir" | "runId" | "vars">): RunRecorder {
  return new RunRecorder(evidenceStream(run.runDir, run.runId), run.runDir, repositoryOf(run.vars));
}
