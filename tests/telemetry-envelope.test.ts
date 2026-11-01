import { afterEach, describe, expect, it } from "vitest";
import { EVIDENCE_EVENT_TYPES, type EvidenceEvent, type EvidenceEventType } from "../src/evidence/schema.js";
import type { EvidenceEventBody } from "../src/evidence/stream.js";
import { TELEMETRY_NAMES, TelemetryEventSchema, telemetryFromEvidence, watcherRef, type TelemetryKind } from "../src/telemetry/envelope.js";
import { resetTelemetry } from "../src/telemetry/telemetry.js";

afterEach(() => resetTelemetry());

const TIME = "2026-03-01T10:00:00.000Z";
const sha = "a".repeat(64);
const commit = "b".repeat(40);
const step = { id: "build", visit: 1, type: "claude" } as const;
const approval = { id: "ok", visit: 1, type: "approval" } as const;
const model = { agent: "claude", provider: "anthropic", model: "sonnet" } as const;
const by = { kind: "cli" } as const;
const decision = {
  version: 1, policy: { id: "cover", version: "1" }, packSha256: sha, mode: "observe", boundary: "step.before", inputSha256: sha,
  outcome: "warn", reasonCode: "output.limit-exceeded", rule: "r1", evaluatedAt: TIME,
} as const;
const end = { step, model, exitCode: 0, durationMs: 12, artifacts: [] };

const SAMPLES: Record<EvidenceEventType, unknown> = {
  "run.created": { type: "run.created", flow: { name: "f", version: 2 }, by },
  "run.queued": { type: "run.queued" },
  "run.started": { type: "run.started", base: { commit, branch: "main", repository: "own/repo" } },
  "run.stopped": { type: "run.stopped" },
  "run.resumed": { type: "run.resumed", from: "build", by },
  "run.cancelled": { type: "run.cancelled", by },
  "run.failed": { type: "run.failed", step },
  "run.completed": { type: "run.completed", final: { commit, branch: "feat" } },
  "step.started": { type: "step.started", step },
  "step.routed": { type: "step.routed", step, model, fallbackFrom: { ...model, model: "opus" } },
  "step.profiled": { type: "step.profiled", step, agent: "claude", source: "generated", profile: { id: "generated.flow-settings", version: "1", sha256: "a".repeat(64) }, outcome: "enforced", gaps: [], excess: [], unmappedRules: 0, personalSetup: false },
  "step.retried": { type: "step.retried", step, cause: "limit" },
  "step.denied": { type: "step.denied", step, denial: { kind: "tool", tool: { name: "Bash" } } },
  "step.approved": { type: "step.approved", step: approval, by },
  "step.failed": { type: "step.failed", ...end },
  "step.completed": { type: "step.completed", ...end },
  "policy.decided": { type: "policy.decided", decision, step },
  "repo.operation": { type: "repo.operation", step, operation: "push", repository: "own/repo", branch: "feat", credential: "repository", policy: "allow", outcome: "done" },
  "context.bundled": { type: "context.bundled", outcome: "failed", failure: "internal" },
  "governance.decided": { type: "governance.decided", outcome: "refused", components: [{ kind: "flow", id: "deploy", version: "3", status: "retired", refused: true }] },
};
const NAME_OF: Partial<Record<EvidenceEventType, string>> = { "step.routed": "model.routed", "repo.operation": "tool.called" };
const made = (type: EvidenceEventType, written?: Pick<EvidenceEvent, "id" | "seq">, repo?: string) =>
  telemetryFromEvidence("r1", SAMPLES[type] as EvidenceEventBody, written as EvidenceEvent | undefined, TIME, repo);

const valid = {
  version: 2, id: "ev:r1:ev-000003", time: TIME, kind: "step", name: "step.started", runId: "r1", evidence: { id: "ev-000003", seq: 3 },
};

describe("telemetry envelope", () => {
  it("accepts one sample for every kind and name", () => {
    for (const [kind, names] of Object.entries(TELEMETRY_NAMES)) {
      for (const name of names) expect(TelemetryEventSchema.safeParse({ ...valid, kind, name, ...(name === "run.measured" ? { measures: {} } : {}) }).success, name).toBe(true);
    }
  });

  describe("run.measured", () => {
    const measured = { ...valid, id: `tm:${"0f".repeat(16)}`, evidence: undefined, kind: "run", name: "run.measured", measures: { steps: 2, costUsd: 0.0123, pullRequestDelivered: 1 } };
    const ok = (e: object) => TelemetryEventSchema.safeParse(e).success;

    it("accepts the measures of a run, with a fractional cost", () => {
      expect(ok(measured)).toBe(true);
    });
    it("needs measures exactly for run.measured", () => {
      expect(ok({ ...measured, measures: undefined })).toBe(false);
      expect(ok({ ...valid, measures: {} })).toBe(false);
    });
    it("refuses text, negative numbers, fractional counts, unknown keys and a flag above 1", () => {
      for (const bad of [{ steps: "2" }, { steps: -1 }, { steps: 1.5 }, { costUsd: -0.1 }, { foo: 1 }, { pullRequestDelivered: 2 }]) expect(ok({ ...measured, measures: bad }), JSON.stringify(bad)).toBe(false);
    });
  });

  it("refuses a wrong pair, unknown fields and another version", () => {
    expect(TelemetryEventSchema.safeParse({ ...valid, kind: "run", name: "step.started" }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, kind: "watcher" as TelemetryKind, name: "model.routed" }).success).toBe(false);
    for (const f of ["prompt", "output", "arguments", "error", "foo"]) expect(TelemetryEventSchema.safeParse({ ...valid, [f]: "x" }).success, f).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, version: 1 }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, version: 3 }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, outcome: "skipped" }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, cause: "x" }).success).toBe(false);
  });

  it("keeps the id, run and evidence in agreement", () => {
    expect(TelemetryEventSchema.safeParse(valid).success).toBe(true);
    expect(TelemetryEventSchema.safeParse({ ...valid, runId: "r2" }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, evidence: undefined }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, evidence: { id: "ev-000003", seq: 4 } }).success).toBe(false);
    const tm = { ...valid, id: `tm:${"0f".repeat(16)}`, evidence: undefined };
    expect(TelemetryEventSchema.safeParse(tm).success).toBe(true);
    expect(TelemetryEventSchema.safeParse({ ...tm, evidence: valid.evidence }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...tm, id: `tm:${"0f".repeat(15)}0` }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, kind: "run", name: "run.completed", id: `${valid.id}:pr` }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, kind: "pull_request", name: "pull_request.delivered", id: `${valid.id}:pr` }).success).toBe(true);
  });

  it("refuses a redacted list that is empty or names a field that is present", () => {
    expect(TelemetryEventSchema.safeParse({ ...valid, branch: "main", redacted: ["branch"] }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, redacted: [] }).success).toBe(false);
    expect(TelemetryEventSchema.safeParse({ ...valid, redacted: ["branch"] }).success).toBe(true);
  });

  it("maps every evidence type to valid events", () => {
    for (const type of EVIDENCE_EVENT_TYPES) {
      expect(SAMPLES[type], `a sample for ${type}`).toBeDefined();
      const out = made(type, { id: "ev-000003", seq: 3 });
      expect(out.length, type).toBeGreaterThan(0);
      for (const e of out) TelemetryEventSchema.parse(e);
      expect(out[0]!.name).toBe(NAME_OF[type] ?? type);
    }
  });

  it("gives a pull request event with the :pr id and no url", () => {
    const body = { type: "run.completed", pullRequest: { repository: "own/repo", number: 7, url: "https://github.com/own/repo/pull/7" } } as EvidenceEventBody;
    const out = telemetryFromEvidence("r1", body, { id: "ev-000009", seq: 9 } as EvidenceEvent, TIME);
    expect(out.map((e) => e.name)).toEqual(["run.completed", "pull_request.delivered"]);
    expect(out[1]!.id).toBe(`${out[0]!.id}:pr`);
    expect(out[1]!.pullRequest).toEqual({ repository: "own/repo", number: 7 });
    for (const e of out) TelemetryEventSchema.parse(e);
  });

  it("maps a repository operation to tool.called, and a done push also to delivery.push_attempted", () => {
    const out = made("repo.operation", { id: "ev-000003", seq: 3 });
    expect(out.map((e) => e.name)).toEqual(["tool.called", "delivery.push_attempted"]);
    expect(out[0]).toMatchObject({ kind: "tool", tool: { name: "git.push" }, outcome: "ok", branch: "feat", repository: "own/repo" });
    expect(out[1]).toMatchObject({ kind: "delivery", runId: "r1", branch: "feat", repository: "own/repo" });
    expect(out[1]!.id).toMatch(/^tm:[0-9a-f]{32}$/);
    expect(out[1]!.evidence).toBeUndefined();
    const of = (over: object) => telemetryFromEvidence("r1", { ...(SAMPLES["repo.operation"] as object), ...over } as EvidenceEventBody, undefined, TIME);
    const policy = of({ outcome: "refused", refusal: "policy" });
    expect(policy).toHaveLength(1);
    expect(policy[0]).toMatchObject({ outcome: "denied", cause: "policy" });
    expect(of({ outcome: "refused", refusal: "not-in-profile" })[0]).toMatchObject({ outcome: "denied", cause: "tool" });
    expect(of({ outcome: "failed" })).toHaveLength(1);
    expect(of({ outcome: "failed" })[0]).toMatchObject({ outcome: "failed" });
    expect(of({ operation: "pull-request" })[0]).toMatchObject({ tool: { name: "github.pull-request.write" } });
    for (const e of [...out, ...policy]) TelemetryEventSchema.parse(e);
  });

  it("uses the evidence line for the id, or a random tm: id without one", () => {
    const [a] = made("step.started", { id: "ev-000003", seq: 3 });
    expect(a).toMatchObject({ id: "ev:r1:ev-000003", evidence: { id: "ev-000003", seq: 3 } });
    const [b] = made("step.started");
    const [c] = made("step.started");
    expect(b!.id).toMatch(/^tm:[0-9a-f]{32}$/);
    expect(b!.evidence).toBeUndefined();
    expect(b!.id).not.toBe(c!.id);
    TelemetryEventSchema.parse(b);
  });

  it("carries only the labels of a policy decision and the right fields of a denial", () => {
    const [p] = made("policy.decided");
    expect(p!.decision).toEqual({ policy: { id: "cover", version: "1" }, boundary: "step.before", mode: "observe", outcome: "warn", reasonCode: "output.limit-exceeded" });
    const [d] = made("step.denied");
    expect(d).toMatchObject({ cause: "tool", tool: { name: "Bash" }, outcome: "denied" });
    const [a] = telemetryFromEvidence("r1", { type: "step.denied", step: approval, denial: { kind: "approval", by } }, undefined, TIME);
    expect(a).toMatchObject({ cause: "approval", actor: by });
    const [w] = telemetryFromEvidence("r1", { type: "step.denied", denial: { kind: "policy", policy: { id: "p", version: "1" }, packSha256: "a".repeat(64), reasonCode: "x.y" } }, undefined, TIME);
    expect(w).toMatchObject({ cause: "policy", outcome: "denied" });
    expect(w!.step).toBeUndefined();
    expect(TelemetryEventSchema.safeParse(w).success).toBe(true);
    const [ok] = made("step.profiled");
    expect(ok).toMatchObject({ kind: "step", name: "step.profiled", outcome: "ok" });
    expect(ok!.cause).toBeUndefined();
    const refused = telemetryFromEvidence("r1", { ...(SAMPLES["step.profiled"] as object), outcome: "refused" } as EvidenceEventBody, undefined, TIME);
    expect(refused[0]).toMatchObject({ name: "step.profiled", outcome: "denied", cause: "tool" });
    TelemetryEventSchema.parse(refused[0]);
  });

  it("puts the repository argument on every event", () => {
    for (const type of EVIDENCE_EVENT_TYPES) for (const e of made(type, undefined, "own/repo")) expect(e.repository, type).toBe("own/repo");
    expect(made("run.started")[0]!.repository).toBe("own/repo");
  });

  it("never throws", () => {
    expect(telemetryFromEvidence("r1", { type: "nope" } as unknown as EvidenceEventBody, undefined, TIME)).toEqual([]);
    expect(telemetryFromEvidence("r1", null as unknown as EvidenceEventBody, undefined, TIME)).toEqual([]);
    const bad = { type: "step.started", get step(): never { throw new Error("x"); } } as unknown as EvidenceEventBody;
    expect(telemetryFromEvidence("r1", bad, undefined, TIME)).toEqual([]);
  });

  it("builds a watcher reference only from valid parts", () => {
    expect(watcherRef("w1", "issues")).toEqual({ id: "w1", source: "issues" });
    expect(watcherRef("w 1", "issues")).toBeUndefined();
    expect(watcherRef("w1", "nope")).toBeUndefined();
  });
});
