import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { WatcherConfig } from "../config.js";
import {
  ActorSchema, GitIdentitySchema, ModelIdentitySchema, PolicyIdentitySchema, ReasonCodeSchema, RepositorySchema, RunIdSchema, StepIdentitySchema, TimeSchema, ToolIdentitySchema,
} from "../evidence/identity.js";
import { FlowIdentitySchema, RUN_EVENT_TYPES, type EvidenceEvent } from "../evidence/schema.js";
import { evidenceEventId, type EvidenceEventBody } from "../evidence/stream.js";
import { repoToolOf } from "../engine/repo-request.js";
import { BOUNDARIES, MODES, OUTCOMES } from "../policy/schema.js";
import { toolNameOf } from "../tool-profile/resolve.js";

/**
 * The telemetry event: one lifecycle fact as one line, with labels, numbers and ids only. There is no free-text
 * field, and every object refuses unknown fields, so a prompt, an output, tool arguments or an error text cannot be
 * put in by mistake. A new field is a new version.
 */

export const TELEMETRY_VERSION = 2;

export const TELEMETRY_NAMES = {
  run: [...RUN_EVENT_TYPES, "run.measured", "context.bundled", "governance.decided"],
  step: ["step.started", "step.profiled", "step.retried", "step.denied", "step.approved", "step.failed", "step.completed"],
  model: ["model.routed"],
  policy: ["policy.decided"],
  tool: ["tool.called"],
  delivery: ["delivery.push_attempted"],
  pull_request: ["pull_request.delivered", "pull_request.feedback"],
  watcher: ["watcher.checked", "watcher.failed", "watcher.queued"],
} as const;
export type TelemetryKind = keyof typeof TELEMETRY_NAMES;
export const TELEMETRY_KINDS = Object.keys(TELEMETRY_NAMES) as [TelemetryKind, ...TelemetryKind[]];
export const TELEMETRY_EVENT_NAMES: readonly string[] = Object.values(TELEMETRY_NAMES).flat();
const NAMES = TELEMETRY_EVENT_NAMES as [string, ...string[]];

export const TELEMETRY_OUTCOMES = ["ok", "failed", "denied", "cancelled", "stopped"] as const;
export const TELEMETRY_CAUSES = ["outage", "limit", "approval", "tool", "policy"] as const;
export const WATCHER_SOURCES = ["issues", "pr-feedback", "ci-failures", "schedule", "monitor"] as const;
// Fails the build when a watcher gets a source this list does not have.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const watcherSourcesMatchTheConfig: Same<(typeof WATCHER_SOURCES)[number], WatcherConfig["source"]> = true;
void watcherSourcesMatchTheConfig;

/** The fields that carry a label of the run and are checked for private data one by one. */
export const REDACTABLE_FIELDS = ["flow", "repository", "branch", "step", "pullRequest", "model", "fallbackFrom", "tool", "actor", "watcher", "decision"] as const;
export type RedactableField = (typeof REDACTABLE_FIELDS)[number];

export const TelemetryIdSchema = z.string().regex(/^(?:ev:[\w-]{1,128}:ev-\d{6,}(?::pr)?|tm:[0-9a-f]{32})$/, "must be a telemetry id: ev:<run>:<evidence id> or tm:<32 hex>");

const count = z.number().int().min(0).optional();

/** The decision measures of one ended run: numbers only, every field optional (a measure without a source is left out). */
export const TelemetryMeasuresSchema = z
  .object({
    steps: count,
    stepMs: count,
    queueMs: count,
    retries: count,
    tokensIn: count,
    tokensOut: count,
    costUsd: z.number().finite().min(0).optional(),
    denials: count,
    contextTokensMax: count,
    toolCalls: count,
    toolMs: count,
    toolMaxMs: count,
    stops: count,
    resumes: count,
    approvals: count,
    approvalMs: count,
    approvalMaxMs: count,
    approvalsCancelled: count,
    policyAllow: count,
    policyWarn: count,
    policyRequireApproval: count,
    policyDeny: count,
    policyUnavailable: count,
    pullRequestDelivered: z.number().int().min(0).max(1).optional(),
  })
  .strict();
export type TelemetryMeasures = z.infer<typeof TelemetryMeasuresSchema>;

const WatcherRefSchema = z.object({ id: z.string().regex(/^[\w-]{1,128}$/), source: z.enum(WATCHER_SOURCES) }).strict();

export const TelemetryEventSchema = z
  .object({
    version: z.literal(TELEMETRY_VERSION),
    id: TelemetryIdSchema,
    time: TimeSchema,
    kind: z.enum(TELEMETRY_KINDS),
    name: z.enum(NAMES),
    runId: RunIdSchema.optional(),
    evidence: z.object({ id: z.string().regex(/^ev-\d{6,}$/), seq: z.number().int().min(0) }).strict().optional(),
    step: StepIdentitySchema.optional(),
    flow: FlowIdentitySchema.optional(),
    repository: RepositorySchema.optional(),
    branch: GitIdentitySchema.shape.branch,
    pullRequest: z.object({ repository: RepositorySchema, number: z.number().int().min(1) }).strict().optional(),
    model: ModelIdentitySchema.optional(),
    fallbackFrom: ModelIdentitySchema.optional(),
    tool: ToolIdentitySchema.optional(),
    actor: ActorSchema.optional(),
    watcher: WatcherRefSchema.optional(),
    outcome: z.enum(TELEMETRY_OUTCOMES).optional(),
    /** Only on run.measured. */
    measures: TelemetryMeasuresSchema.optional(),
    durationMs: z.number().int().min(0).optional(),
    exitCode: z.number().int().optional(),
    cause: z.enum(TELEMETRY_CAUSES).optional(),
    decision: z
      .object({ policy: PolicyIdentitySchema, boundary: z.enum(BOUNDARIES), mode: z.enum(MODES), outcome: z.enum(OUTCOMES), reasonCode: ReasonCodeSchema })
      .strict()
      .optional(),
    /** The fields that were dropped because they looked private. */
    redacted: z.array(z.enum(REDACTABLE_FIELDS)).min(1).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!(TELEMETRY_NAMES[e.kind] as readonly string[]).includes(e.name)) add("name", `is not a name of the kind ${e.kind}`);
    const ev = /^ev:([\w-]{1,128}):(ev-\d{6,})(:pr)?$/.exec(e.id);
    if (ev) {
      if (e.runId !== ev[1]) add("runId", "must be the run of the id");
      if (!e.evidence) add("evidence", "is missing: an ev: id names an evidence event");
      else if (e.evidence.id !== ev[2] || e.evidence.id !== evidenceEventId(e.evidence.seq)) add("evidence", "does not match the id");
    } else if (e.evidence) add("evidence", "is not allowed with a tm: id");
    if ((e.measures !== undefined) !== (e.name === "run.measured")) add("measures", "is present exactly for run.measured");
    if (e.id.endsWith(":pr") && e.name !== "pull_request.delivered") add("id", "the :pr suffix is only for pull_request.delivered");
    if (e.redacted) {
      if (new Set(e.redacted).size !== e.redacted.length) add("redacted", "names a field twice");
      if (e.redacted.some((f) => (e as Record<string, unknown>)[f] !== undefined)) add("redacted", "names a field that is present");
    }
  });
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** The reference to a watcher, or undefined when the id or the source is not valid. */
export function watcherRef(id: unknown, source: unknown): { id: string; source: (typeof WATCHER_SOURCES)[number] } | undefined {
  const r = WatcherRefSchema.safeParse({ id, source });
  return r.success ? r.data : undefined;
}

export const tmId =(): string => `tm:${randomBytes(16).toString("hex")}`;

type Draft = Partial<TelemetryEvent>;

/** The repository of a commit identity, when it is one telemetry can hold. */
const repoOf = (g: { repository?: string } | undefined): string | undefined => {
  const r = RepositorySchema.safeParse(g?.repository);
  return r.success ? r.data : undefined;
};

type Type = EvidenceEvent["type"];
function parts(body: EvidenceEventBody): { kind: TelemetryKind; name: string; fields: Draft; repository?: string } {
  const type = body.type as Type;
  switch (body.type) {
    case "run.created":
      return { kind: "run", name: type, fields: { flow: body.flow, actor: body.by } };
    case "run.autonomy":
      return { kind: "run", name: type, fields: {} };
    case "run.queued":
      return { kind: "run", name: type, fields: {} };
    case "run.started":
      return { kind: "run", name: type, fields: body.base?.branch ? { branch: body.base.branch } : {}, repository: repoOf(body.base) };
    case "run.stopped":
      return { kind: "run", name: type, fields: { outcome: "stopped" } };
    case "run.resumed":
      return { kind: "run", name: type, fields: { actor: body.by } };
    case "run.cancelled":
      return { kind: "run", name: type, fields: { outcome: "cancelled", actor: body.by } };
    case "run.failed":
      return { kind: "run", name: type, fields: { outcome: "failed", ...(body.step ? { step: body.step } : {}) } };
    case "run.completed":
      return { kind: "run", name: type, fields: { outcome: "ok", ...(body.final?.branch ? { branch: body.final.branch } : {}) }, repository: repoOf(body.final) };
    case "step.started":
      return { kind: "step", name: type, fields: { step: body.step } };
    case "step.routed":
      return { kind: "model", name: "model.routed", fields: { step: body.step, model: body.model, ...(body.fallbackFrom ? { fallbackFrom: body.fallbackFrom } : {}) } };
    case "step.profiled": {
      const refused = body.outcome === "refused";
      return { kind: "step", name: type, fields: { step: body.step, outcome: refused ? "denied" : "ok", ...(refused ? { cause: "tool" as const } : {}) } };
    }
    case "step.retried":
      return { kind: "step", name: type, fields: { step: body.step, cause: body.cause } };
    case "step.denied": {
      const d = body.denial;
      const fields: Draft = { ...(body.step ? { step: body.step } : {}), outcome: "denied", cause: d.kind };
      if (d.kind === "approval") fields.actor = d.by;
      else if (d.tool) fields.tool = d.tool;
      return { kind: "step", name: type, fields };
    }
    case "step.approved":
      return { kind: "step", name: type, fields: { step: body.step, actor: body.by, outcome: "ok" } };
    case "step.failed":
    case "step.completed":
      return {
        kind: "step",
        name: type,
        fields: {
          step: body.step,
          ...(body.model ? { model: body.model } : {}),
          durationMs: body.durationMs,
          ...(body.exitCode !== undefined ? { exitCode: body.exitCode } : {}),
          outcome: body.type === "step.failed" ? "failed" : "ok",
        },
      };
    case "policy.decided": {
      const { policy, boundary, mode, outcome, reasonCode } = body.decision;
      return { kind: "policy", name: type, fields: { ...(body.step ? { step: body.step } : {}), decision: { policy, boundary, mode, outcome, reasonCode } } };
    }
    case "repo.operation": {
      const tool = body.operation === "unknown" ? undefined : repoToolOf(body.operation);
      const fields: Draft = {
        step: body.step,
        tool: { name: tool ? toolNameOf(tool.kind, tool.operation) : "repo.unknown" },
        outcome: body.outcome === "done" ? "ok" : body.outcome === "failed" ? "failed" : "denied",
        ...(body.refusal ? { cause: body.refusal === "policy" ? ("policy" as const) : ("tool" as const) } : {}),
        ...(body.branch ? { branch: body.branch } : {}),
        ...(body.pullRequest ? { pullRequest: { repository: body.pullRequest.repository, number: body.pullRequest.number } } : {}),
      };
      return { kind: "tool", name: "tool.called", fields, repository: repoOf({ repository: body.repository }) };
    }
    case "context.bundled":
      return { kind: "run", name: type, fields: { outcome: body.outcome === "written" ? "ok" : "failed" } };
    case "governance.decided":
      return { kind: "run", name: type, fields: { outcome: body.outcome === "allowed" ? "ok" : "denied" } };
    default: {
      const never: never = body;
      void never;
      return { kind: "run", name: "", fields: {} };
    }
  }
}

/**
 * The telemetry events for one evidence event, following the event table of the design. `written` is the evidence
 * line when one was written; without it the id is a random `tm:` id and there is no `evidence`. Never throws and
 * does not validate: `emitTelemetry` does.
 */
export function telemetryFromEvidence(runId: string, body: EvidenceEventBody, written: EvidenceEvent | undefined, time: string, repository?: string): TelemetryEvent[] {
  try {
    const p = parts(body);
    if (!p.name) return [];
    const repo = RepositorySchema.safeParse(repository).success ? repository : p.repository;
    const base = written ? `ev:${runId}:${written.id}` : undefined;
    const common = (id: string): Draft => ({
      version: TELEMETRY_VERSION,
      id,
      time,
      ...(written ? { runId, evidence: { id: written.id, seq: written.seq } } : {}),
      ...(!written ? { runId } : {}),
      ...(repo ? { repository: repo } : {}),
    });
    const out: Draft[] = [{ ...common(base ?? tmId()), kind: p.kind, name: p.name, ...p.fields } as Draft];
    if (body.type === "run.completed" && body.pullRequest) {
      out.push({
        ...common(base ? `${base}:pr` : tmId()),
        kind: "pull_request",
        name: "pull_request.delivered",
        pullRequest: { repository: body.pullRequest.repository, number: body.pullRequest.number },
        outcome: "ok",
      } as Draft);
    }
    if (body.type === "repo.operation" && body.operation === "push" && body.outcome === "done") {
      // a tm: id carries no `evidence` field
      const { evidence: _evidence, ...plain } = common(tmId());
      out.push({ ...plain, runId, kind: "delivery", name: "delivery.push_attempted", step: body.step, ...(body.branch ? { branch: body.branch } : {}) } as Draft);
    }
    return out as TelemetryEvent[];
  } catch {
    return [];
  }
}
