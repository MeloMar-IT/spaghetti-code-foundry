import { z } from "zod";
import {
  ActorSchema, ApprovalSchema, ArtifactRefSchema, CommitSchema, GitIdentitySchema, ModelIdentitySchema, PolicyIdentitySchema, PullRequestIdentitySchema,
  ReasonCodeSchema, RepositorySchema, RunIdSchema, Sha256Schema, StepIdentitySchema, StepIdSchema, TestResultSchema, TimeSchema, ToolIdentitySchema,
} from "./identity.js";
import { PolicyDecisionSchema } from "../policy/schema.js";
import { EVIDENCE_EVENT_VERSION, EVIDENCE_EVENTS_FILE, RUN_EVIDENCE_VERSION } from "./version.js";

/**
 * The two evidence formats of a run. Both are extra files in the run folder; `run.json` is not changed by them.
 *
 * - `EvidenceEvent`: one line of `evidence.jsonl`, something that happened to the run or to one of its steps.
 * - `RunEvidence`: `evidence.json`, the manifest written once when the run has ended.
 *
 * Every object refuses unknown fields, so a field can only be added with a new version (see version.ts).
 */

/** The flow a run uses: its name and, for a published flow, the version the server gave it. */
export const FlowIdentitySchema = z.object({ name: z.string().refine((s) => s.length >= 1 && s.length <= 200 && s === s.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(s), "must be a flow name on one line"), version: z.number().int().min(1).optional() }).strict();
export type FlowIdentity = z.infer<typeof FlowIdentitySchema>;

/** What every event has. */
const envelope = {
  version: z.literal(EVIDENCE_EVENT_VERSION),
  /** The id of the event: unique in its run, given once and never changed or reused. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "must be an event id: 1 to 64 letters, digits, _ or -"),
  /** The place of the event in the stream of its run: 0 for the first event, then 1, 2, … with no gaps. */
  seq: z.number().int().min(0),
  runId: RunIdSchema,
  /** When it happened (not when it was written). */
  time: TimeSchema,
  /**
   * The `hash` of the event before this one; null for the first event (seq 0). Present exactly when `hash` is.
   * An event without both is not chained yet.
   */
  prevHash: Sha256Schema.nullable().optional(),
  /** The SHA-256 of this event in its canonical form without the `hash` field itself (so `prevHash` is covered). */
  hash: Sha256Schema.optional(),
};

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) => z.object({ ...envelope, type: z.literal(type), ...shape }).strict();

const step = StepIdentitySchema;
/** What a finished step leaves behind. `artifacts` are its log and transcript; `durationMs` is the time the step took. */
const stepEnd = {
  step,
  /** The model that did the work; absent for a step that is not an agent step. */
  model: ModelIdentitySchema.optional(),
  /** The exit code of the program of the step, when it had one. */
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().min(0),
  artifacts: z.array(ArtifactRefSchema),
  /** Set when the step was a test run. */
  test: TestResultSchema.optional(),
};

/** Why a step was not allowed to go on. */
export const DenialSchema = z.discriminatedUnion("kind", [
  /** A person rejected the approval step. */
  z.object({ kind: z.literal("approval"), by: ActorSchema }).strict(),
  /** The agent was refused the use of a tool. */
  z.object({ kind: z.literal("tool"), tool: ToolIdentitySchema }).strict(),
  /** A policy said no. `tool` is set when the decision was about one tool. */
  z.object({ kind: z.literal("policy"), policy: PolicyIdentitySchema, reasonCode: ReasonCodeSchema, tool: ToolIdentitySchema.optional() }).strict(),
]);
export type Denial = z.infer<typeof DenialSchema>;

const EventUnion = z.discriminatedUnion("type", [
  /** The run got its id and folder. `by` is who asked for it. */
  event("run.created", { flow: FlowIdentitySchema, by: ActorSchema }),
  /** The run was put in the queue. */
  event("run.queued", {}),
  /** The first step is about to run. `base` is the commit the workspace started from, when there is one. */
  event("run.started", { base: GitIdentitySchema.optional() }),
  /** The run was paused and can go on later. `at` is the step it will go on with, when one is left. */
  event("run.stopped", { at: StepIdSchema.optional() }),
  /** A paused, waiting or failed run goes on. `from` is the step it restarts at. */
  event("run.resumed", { from: StepIdSchema, by: ActorSchema }),
  /** The run was ended on request and will not go on. */
  event("run.cancelled", { by: ActorSchema }),
  /** The run ended without success. `step` is the step that failed, when one did. */
  event("run.failed", { step: step.optional() }),
  /** The run ended with success. `final` is the last commit of its work; `pullRequest` the pull request it made or changed. */
  event("run.completed", { final: GitIdentitySchema.optional(), pullRequest: PullRequestIdentitySchema.optional() }),

  /** A visit of a step begins. */
  event("step.started", { step }),
  /** The step was given to a model. `fallbackFrom` is the model that was tried first, when this one took over after a limit. */
  event("step.routed", { step, model: ModelIdentitySchema, fallbackFrom: ModelIdentitySchema.optional() }),
  /** The same visit is tried again: "outage" after the service could not be reached, "limit" on another model after a usage limit. */
  event("step.retried", { step, cause: z.enum(["outage", "limit"]) }),
  /** Something in the step was refused (see DenialSchema). The step itself may still go on; its end is its own event. */
  event("step.denied", { step, denial: DenialSchema }),
  /** A person approved the approval step. */
  event("step.approved", { step, by: ActorSchema }),
  /** The visit ended without success. */
  event("step.failed", stepEnd),
  /** The visit ended with success. `commit` and `pullRequest` are set when the step made them. */
  event("step.completed", { ...stepEnd, commit: GitIdentitySchema.optional(), pullRequest: PullRequestIdentitySchema.optional() }),

  /** A policy pack decided at a boundary of the run. `step` is set exactly for the boundaries that are about a step (for `repository.access` it is absent when the question is about the run's workspace). */
  event("policy.decided", { decision: PolicyDecisionSchema, step: step.optional() }),
]);

const uniquePaths = (refs: { path: string }[], ctx: z.RefinementCtx, at: PropertyKey[]) => {
  const seen = new Set<string>();
  refs.forEach((r, i) => {
    if (seen.has(r.path)) ctx.addIssue({ code: "custom", path: [...at, i, "path"], message: "the same file is named twice" });
    seen.add(r.path);
  });
};

export const EvidenceEventSchema = EventUnion.superRefine((e, ctx) => {
  if ((e.hash === undefined) !== (e.prevHash === undefined)) {
    ctx.addIssue({ code: "custom", path: [e.hash === undefined ? "hash" : "prevHash"], message: "hash and prevHash come together: both or neither" });
  } else if (e.hash !== undefined && (e.prevHash === null) !== (e.seq === 0)) {
    ctx.addIssue({ code: "custom", path: ["prevHash"], message: "prevHash is null for the first event (seq 0) and only then" });
  }
  if (e.type === "step.failed" || e.type === "step.completed") uniquePaths(e.artifacts, ctx, ["artifacts"]);
  if (e.type === "policy.decided") {
    const runWide = e.decision.boundary === "run.start" || e.decision.boundary === "run.complete";
    if (runWide && e.step) ctx.addIssue({ code: "custom", path: ["step"], message: `is not allowed for the boundary ${e.decision.boundary}` });
    // access to the repository is also asked for the run itself, before any step (the workspace is made)
    if (!runWide && !e.step && e.decision.boundary !== "repository.access") ctx.addIssue({ code: "custom", path: ["step"], message: `is missing: the boundary ${e.decision.boundary} is about a step` });
  }
  if (e.type === "step.approved" && e.step.type !== "approval") ctx.addIssue({ code: "custom", path: ["step", "type"], message: "only an approval step can be approved" });
  if (e.type === "step.denied" && e.denial.kind === "approval" && e.step.type !== "approval") {
    ctx.addIssue({ code: "custom", path: ["step", "type"], message: "only an approval step can be rejected" });
  }
});
export type EvidenceEvent = z.infer<typeof EvidenceEventSchema>;
export type EvidenceEventType = EvidenceEvent["type"];

export const RUN_EVENT_TYPES = ["run.created", "run.queued", "run.started", "run.stopped", "run.resumed", "run.cancelled", "run.failed", "run.completed"] as const satisfies readonly EvidenceEventType[];
export const STEP_EVENT_TYPES = ["step.started", "step.routed", "step.retried", "step.denied", "step.approved", "step.failed", "step.completed"] as const satisfies readonly EvidenceEventType[];
export const POLICY_EVENT_TYPES = ["policy.decided"] as const satisfies readonly EvidenceEventType[];
export const EVIDENCE_EVENT_TYPES: readonly EvidenceEventType[] = [...RUN_EVENT_TYPES, ...STEP_EVENT_TYPES, ...POLICY_EVENT_TYPES];
/** The events after which a run is over; exactly one of them ends a finished stream. */
export const TERMINAL_EVENT_TYPES = ["run.cancelled", "run.failed", "run.completed"] as const satisfies readonly EvidenceEventType[];

/** The states a run can end in. `stopped` and `waiting` are not ends: such a run has no manifest yet. */
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "cancelled"] as const;

/**
 * The manifest of a finished run. Everything in it follows from the event stream and the files of the run, except
 * `finalizedAt`, the one field that depends on when the manifest was made.
 */
export const RunEvidenceSchema = z
  .object({
    version: z.literal(RUN_EVIDENCE_VERSION),
    runId: RunIdSchema,
    status: z.enum(TERMINAL_RUN_STATUSES),
    startedAt: TimeSchema,
    finishedAt: TimeSchema,
    /** When this manifest was written. Time-dependent: not part of what a second finalization must reproduce. */
    finalizedAt: TimeSchema,
    /** The flow, and the SHA-256 of the flow definition that is stored with the run. */
    flow: z.object({ ...FlowIdentitySchema.shape, sha256: Sha256Schema }).strict(),
    /** The event stream: its file, how many events it has, and the `hash` of its last event. */
    events: z.object({ path: z.literal(EVIDENCE_EVENTS_FILE), count: z.number().int().min(1), terminalHash: Sha256Schema }).strict(),
    /** Where the work happened. `base`: the commit the workspace started from; `final`: the last commit of the run. */
    git: z.object({ repository: RepositorySchema.optional(), branch: GitIdentitySchema.shape.branch, base: CommitSchema.optional(), final: CommitSchema.optional() }).strict(),
    /** Every model a step ran on, each once. */
    models: z.array(ModelIdentitySchema),
    /** Every policy version that decided something in the run, each once. */
    policies: z.array(PolicyIdentitySchema),
    /** Every decision at an approval step, oldest first. */
    approvals: z.array(z.object({ step: StepIdentitySchema, time: TimeSchema, ...ApprovalSchema.shape }).strict()),
    /** Every test run, oldest first. */
    tests: z.array(z.object({ step: StepIdentitySchema, result: TestResultSchema }).strict()),
    /** Every file the events refer to (logs, transcripts, reports), each path once. */
    artifacts: z.array(ArtifactRefSchema),
    /** The stored diff of the whole run, when one was made. */
    diff: ArtifactRefSchema.optional(),
    pullRequest: PullRequestIdentitySchema.optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (Date.parse(m.finishedAt) < Date.parse(m.startedAt)) ctx.addIssue({ code: "custom", path: ["finishedAt"], message: "is before startedAt" });
    if (Date.parse(m.finalizedAt) < Date.parse(m.finishedAt)) ctx.addIssue({ code: "custom", path: ["finalizedAt"], message: "is before finishedAt" });
    if (m.diff && m.diff.kind !== "diff") ctx.addIssue({ code: "custom", path: ["diff", "kind"], message: 'must be "diff"' });
    uniquePaths(m.artifacts, ctx, ["artifacts"]);
    m.approvals.forEach((a, i) => {
      if (a.step.type !== "approval") ctx.addIssue({ code: "custom", path: ["approvals", i, "step", "type"], message: "only an approval step can be decided" });
    });
  });
export type RunEvidence = z.infer<typeof RunEvidenceSchema>;
