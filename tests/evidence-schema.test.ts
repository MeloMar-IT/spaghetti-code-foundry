import { describe, expect, it } from "vitest";
import {
  ArtifactRefSchema, artifactRef, isPlainHttpsUrl, isSafeRelativePath, ModelIdentitySchema, modelIdentityOf, PullRequestIdentitySchema, sha256Hex,
  STEP_TYPES, ToolIdentitySchema,
} from "../src/evidence/identity.js";
import { parseEvidenceEvent, parseEvidenceEventLine, parseRunEvidence, readRunEvidence } from "../src/evidence/parse.js";
import { EVIDENCE_EVENT_TYPES, EvidenceEventSchema, RunEvidenceSchema, TERMINAL_EVENT_TYPES, type EvidenceEvent, type EvidenceEventType, type RunEvidence } from "../src/evidence/schema.js";
import { EVIDENCE_EVENT_VERSION, EVIDENCE_EVENTS_FILE, EVIDENCE_MANIFEST_FILE, EvidenceSchemaError, RUN_EVIDENCE_VERSION, upgradeEvidence } from "../src/evidence/version.js";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const C1 = "a".repeat(40);
const C2 = "b".repeat(40);
const USER = "0b8f6a0e-5a52-4a4e-9a57-0f2f3f1f7c11";
const T = "2026-01-31T12:00:00.000Z";

const base = { version: EVIDENCE_EVENT_VERSION, id: "e0001", seq: 1, runId: "20260131-120000-abc", time: T } as const;
const shell = { id: "test", visit: 1, type: "shell" } as const;
const agent = { id: "code", visit: 2, type: "claude", parent: "build/inner" } as const;
const gate = { id: "approve", visit: 1, type: "approval" } as const;
const model = { agent: "codex", provider: "openai", model: "gpt-5" } as const;
const log = { kind: "log", path: "steps/test-1.log", sha256: H1, bytes: 120, required: true } as const;
const pr = { repository: "acme/shop", number: 7, url: "https://github.com/acme/shop/pull/7", head: C2 } as const;
const user = { kind: "user", id: USER } as const;

const DECISION = {
  version: 1,
  policy: { id: "baseline", version: "2026.1" },
  packSha256: H1,
  mode: "observe",
  boundary: "step.before",
  inputSha256: H2,
  outcome: "allow",
  reasonCode: "timeout.exceeded",
  rule: "r1",
  evaluatedAt: T,
} as const;

/** One valid event of every type. */
const WRITTEN = {
  outcome: "written",
  bundle: { kind: "other", path: "context.json", sha256: H1, bytes: 900, required: true },
  sourcesSha256: H2,
  limits: { maxSources: 50, maxSourceBytes: 20000, maxTotalBytes: 200000 },
  sources: 3,
  bytes: 1200,
  omitted: { missing: 0, stale: 0, ambiguous: 0, "over-budget": 2, classification: 0, generated: 1, unsupported: 0 },
};
const EVENTS: Record<EvidenceEventType, Record<string, unknown>> = {
  "run.created": { ...base, type: "run.created", flow: { name: "issue-gitflow", version: 3 }, by: { kind: "watcher", id: "main-issues" } },
  "run.queued": { ...base, type: "run.queued" },
  "run.started": { ...base, type: "run.started", base: { commit: C1, branch: "feature/7-shop", repository: "acme/shop" } },
  "run.stopped": { ...base, type: "run.stopped", at: "test" },
  "run.resumed": { ...base, type: "run.resumed", from: "test", by: { kind: "cli" } },
  "run.cancelled": { ...base, type: "run.cancelled", by: user },
  "run.failed": { ...base, type: "run.failed", step: shell },
  "run.completed": { ...base, type: "run.completed", final: { commit: C2 }, pullRequest: pr },
  "step.started": { ...base, type: "step.started", step: agent },
  "step.routed": { ...base, type: "step.routed", step: agent, model, fallbackFrom: { agent: "claude", provider: "anthropic", model: "opus", effort: "high" } },
  "step.profiled": {
    ...base,
    type: "step.profiled",
    step: agent,
    agent: "codex",
    source: "declared",
    profile: { id: "reviewer", version: "1", sha256: H1 },
    outcome: "refused",
    gaps: [{ kind: "files", restriction: "data-class" }, { kind: "shell", restriction: "sandbox-network", heldBy: "codex-sandbox" }],
    excess: [{ kind: "shell", operation: "run", field: "targets" }],
    unmappedRules: 1,
    personalSetup: false,
  },
  "step.retried": { ...base, type: "step.retried", step: agent, cause: "limit" },
  "step.denied": { ...base, type: "step.denied", step: agent, denial: { kind: "policy", policy: { id: "baseline", version: "2026.1" }, reasonCode: "network.blocked", tool: { name: "Bash" } } },
  "step.approved": { ...base, type: "step.approved", step: gate, by: user },
  "step.failed": { ...base, type: "step.failed", step: shell, exitCode: 1, durationMs: 900, artifacts: [log], test: { suite: "test", outcome: "failed", passed: 10, failed: 2, skipped: 0 } },
  "step.completed": { ...base, type: "step.completed", step: agent, model, durationMs: 5000, artifacts: [log, { ...log, kind: "transcript", path: "steps/code-2.transcript.md", required: false }], commit: { commit: C2 }, pullRequest: pr },
  "policy.decided": { ...base, type: "policy.decided", decision: DECISION, step: shell },
  "repo.operation": { ...base, type: "repo.operation", step: shell, operation: "push", repository: "own/repo", branch: "feat/x", credential: "repository", policy: "allow", outcome: "done" },
  "context.bundled": { ...base, type: "context.bundled", ...WRITTEN },
};

const manifest = (): Record<string, unknown> => ({
  version: 1,
  runId: "20260131-120000-abc",
  status: "succeeded",
  startedAt: T,
  finishedAt: "2026-01-31T12:30:00Z",
  finalizedAt: "2026-01-31T12:30:01.500Z",
  flow: { name: "issue-gitflow", version: 3, sha256: H2 },
  events: { path: "evidence.jsonl", count: 12, terminalHash: H1 },
  git: { repository: "acme/shop", branch: "feature/7-shop", base: C1, final: C2 },
  models: [model],
  policies: [{ id: "baseline", version: "2026.1" }],
  approvals: [{ step: gate, time: T, decision: "approved", by: user }],
  tests: [{ step: shell, result: { suite: "test", outcome: "passed", passed: 12, report: { ...log, kind: "test-report", path: "reports/test.xml" } } }],
  artifacts: [log],
  diff: { kind: "diff", path: "run.diff", sha256: H2, bytes: 4096, required: true },
  pullRequest: pr,
});

const problems = (fn: () => unknown): EvidenceSchemaError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof EvidenceSchemaError) return e;
    throw e;
  }
  throw new Error("expected an EvidenceSchemaError");
};

describe("evidence events", () => {
  it("has a valid example of every event type, and reads each back unchanged", () => {
    expect(Object.keys(EVENTS).sort()).toEqual([...EVIDENCE_EVENT_TYPES].sort());
    for (const [type, raw] of Object.entries(EVENTS)) {
      const e = parseEvidenceEvent(raw);
      expect(e.type).toBe(type);
      expect(e).toEqual(raw);
      expect(parseEvidenceEventLine(JSON.stringify(raw))).toEqual(raw);
    }
  });

  it("holds a refusal exactly when a repository operation is refused, and reads a version 3 line as 4", () => {
    const ok = EVENTS["repo.operation"] as Record<string, unknown>;
    expect(problems(() => parseEvidenceEvent({ ...ok, outcome: "refused" })).issues.map((i) => i.path)).toEqual(["refusal"]);
    expect(problems(() => parseEvidenceEvent({ ...ok, refusal: "policy" })).issues.map((i) => i.path)).toEqual(["refusal"]);
    expect(parseEvidenceEvent({ ...ok, outcome: "refused", refusal: "no-credential", credential: "none", policy: undefined }).type).toBe("repo.operation");
    expect(problems(() => parseEvidenceEvent({ ...ok, operation: "commit", pullRequest: pr })).issues.map((i) => i.path)).toEqual(["pullRequest"]);
    expect(parseEvidenceEvent({ ...EVENTS["run.queued"], version: 3 })).toEqual(EVENTS["run.queued"]);
  });

  it("holds a written context bundle to its fields and a failed one to its code", () => {
    const written = EVENTS["context.bundled"] as Record<string, unknown>;
    const failed = { ...base, type: "context.bundled", outcome: "failed", failure: "repository-timeout" };
    expect(parseEvidenceEvent(failed)).toEqual(failed);
    const bad = (raw: Record<string, unknown>) => EvidenceEventSchema.safeParse(raw).success;
    expect(bad({ ...written, bundle: undefined })).toBe(false);
    expect(bad({ ...written, failure: "internal" })).toBe(false);
    expect(bad({ ...written, bundle: { ...(written.bundle as object), path: "other.json" } })).toBe(false);
    expect(bad({ ...written, bundle: { ...(written.bundle as object), required: false } })).toBe(false);
    expect(bad({ ...written, omitted: { missing: 0 } })).toBe(false);
    expect(bad({ ...written, omitted: { ...(written.omitted as object), extra: 1 } })).toBe(false);
    expect(bad({ ...written, sources: -1 })).toBe(false);
    expect(bad({ ...failed, sources: 1 })).toBe(false);
    expect(bad({ ...failed, failure: undefined })).toBe(false);
    expect(bad({ ...failed, failure: "disk-on-fire" })).toBe(false);
  });

  it("takes a decision at context.select for the run, not for a step, and reads a version 4 line as 5", () => {
    const decided = EVENTS["policy.decided"] as { decision: Record<string, unknown> };
    const at = { ...decided, decision: { ...decided.decision, boundary: "context.select" } };
    expect(EvidenceEventSchema.safeParse({ ...at, step: undefined }).success).toBe(true);
    expect(EvidenceEventSchema.safeParse({ ...at, step: shell }).success).toBe(false);
    expect(parseEvidenceEvent({ ...EVENTS["run.queued"], version: 4 })).toEqual(EVENTS["run.queued"]);
    expect(parseEvidenceEvent({ ...EVENTS["run.queued"], version: 5 })).toEqual(EVENTS["run.queued"]);
  });

  it("names the events that end a run, and the file names", () => {
    expect(TERMINAL_EVENT_TYPES).toEqual(["run.cancelled", "run.failed", "run.completed"]);
    expect([EVIDENCE_EVENTS_FILE, EVIDENCE_MANIFEST_FILE]).toEqual(["evidence.jsonl", "evidence.json"]);
    expect([EVIDENCE_EVENT_VERSION, RUN_EVIDENCE_VERSION]).toEqual([6, 1]);
    expect(STEP_TYPES).toEqual(["claude", "shell", "approval", "parallel", "flow"]);
  });

  it("refuses a field it does not know, at every level, and names it without its value", () => {
    const top = problems(() => parseEvidenceEvent({ ...EVENTS["run.queued"], token: "ghp_secretvalue" }));
    expect(top.code).toBe("invalid");
    expect(top.message).toMatch(/^evidence event: not valid\n {2}- \(root\): .*token/);
    expect(top.message).not.toContain("ghp_secretvalue");
    const inner = problems(() => parseEvidenceEvent({ ...EVENTS["step.started"], step: { ...agent, output: "text of the step" } }));
    expect(inner.issues[0]!.path).toBe("step");
    expect(inner.message).not.toContain("text of the step");
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["step.denied"], denial: { kind: "tool", tool: { name: "Bash", args: "rm -rf" } } }).success).toBe(false);
  });

  it("refuses an unknown type and a missing or wrong field, with the path of the field", () => {
    expect(problems(() => parseEvidenceEvent({ ...base, type: "run.exploded" })).issues[0]!.path).toBe("type");
    expect(problems(() => parseEvidenceEvent({ ...EVENTS["run.created"], by: undefined })).issues[0]!.path).toBe("by");
    expect(problems(() => parseEvidenceEvent({ ...EVENTS["step.failed"], artifacts: [{ ...log, sha256: "ABC" }] })).issues[0]).toEqual({
      path: "artifacts.0.sha256",
      message: "must be a SHA-256: 64 lower-case hex characters",
    });
    for (const bad of [{ seq: -1 }, { seq: 1.5 }, { time: "2026-01-31 12:00" }, { time: "2026-01-31T12:00:00+01:00" }, { runId: "../x" }, { id: "" }, { id: "a b" }]) {
      expect(EvidenceEventSchema.safeParse({ ...EVENTS["run.queued"], ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [{ ...shell, visit: 0 }, { ...shell, type: "magic" }, { ...shell, id: "9lives" }, { ...shell, parent: "a//b" }, { ...shell, parent: "../a" }]) {
      expect(EvidenceEventSchema.safeParse({ ...EVENTS["step.started"], step: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("keeps hash and prevHash together, with null only on the first event", () => {
    const q = EVENTS["run.queued"];
    expect(EvidenceEventSchema.safeParse({ ...q, prevHash: H1, hash: H2 }).success).toBe(true);
    expect(EvidenceEventSchema.safeParse({ ...q, seq: 0, prevHash: null, hash: H2 }).success).toBe(true);
    expect(problems(() => parseEvidenceEvent({ ...q, hash: H2 })).issues[0]!.path).toBe("prevHash");
    expect(problems(() => parseEvidenceEvent({ ...q, prevHash: H1 })).issues[0]!.path).toBe("hash");
    expect(EvidenceEventSchema.safeParse({ ...q, seq: 0, prevHash: H1, hash: H2 }).success).toBe(false);
    expect(EvidenceEventSchema.safeParse({ ...q, seq: 1, prevHash: null, hash: H2 }).success).toBe(false);
  });

  it("checks what belongs together", () => {
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["step.approved"], step: shell }).success).toBe(false);
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["step.denied"], step: shell, denial: { kind: "approval", by: user } }).success).toBe(false);
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["step.denied"], step: gate, denial: { kind: "approval", by: user } }).success).toBe(true);
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["step.denied"], denial: { kind: "tool", tool: { name: "mcp__files__read" } } }).success).toBe(true);
    expect(problems(() => parseEvidenceEvent({ ...EVENTS["step.failed"], artifacts: [log, log] })).issues[0]).toEqual({ path: "artifacts.1.path", message: "the same file is named twice" });
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["step.retried"], cause: "mood" }).success).toBe(false);
    const profiled = EVENTS["step.profiled"]!;
    const ok = (o: Record<string, unknown>) => EvidenceEventSchema.safeParse({ ...profiled, ...o }).success;
    expect(ok({ agent: undefined, outcome: "enforced" })).toBe(false); // no agent: refused before routing
    expect(ok({ agent: undefined, gaps: [] })).toBe(true);
    expect(ok({ source: "generated" })).toBe(false); // a generated profile is never refused
    expect(ok({ source: "generated", outcome: "partial", excess: [] })).toBe(true);
    expect(ok({ profile: undefined })).toBe(false); // an absent profile needs `unreadable`
    expect(ok({ profile: undefined, unreadable: "not-an-object", excess: [], gaps: [] })).toBe(true);
    expect(ok({ unreadable: "invalid" })).toBe(false); // ...and only then
    expect(ok({ excess: [{ kind: "shell", operation: "push", field: "targets" }] })).toBe(false); // not an operation of the kind
    expect(ok({ agent: "claude" })).toBe(false); // only Codex holds a gap with its sandbox
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["step.failed"], durationMs: undefined }).success).toBe(false);
  });
});

describe("identities keep secrets and this machine out", () => {
  it("takes only a relative path inside the run folder", () => {
    for (const ok of ["run.diff", "steps/code-2.log", "a/b/c.d-e_f"]) expect(isSafeRelativePath(ok), ok).toBe(true);
    for (const bad of ["", "/etc/passwd", "../other-run/run.json", "a/../b", "./a", "a//b", "a/", "C:/x", "a\\b", "a\nb", " a", "x".repeat(1025)]) {
      expect(isSafeRelativePath(bad), JSON.stringify(bad)).toBe(false);
      expect(ArtifactRefSchema.safeParse({ ...log, path: bad }).success).toBe(false);
    }
  });

  it("names a file by path, size and SHA-256, never by its contents", () => {
    const ref = artifactRef("transcript", "steps/code-1.transcript.md", "héllo", false);
    expect(ref).toEqual({ kind: "transcript", path: "steps/code-1.transcript.md", sha256: sha256Hex(Buffer.from("héllo", "utf8")), bytes: 6, required: false });
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(artifactRef("log", "a.log", new Uint8Array([1, 2, 3]), true).bytes).toBe(3);
    expect(() => artifactRef("log", "/tmp/a.log", "", true)).toThrow();
    expect(ArtifactRefSchema.safeParse({ ...log, contents: "the log text" }).success).toBe(false);
    expect(ArtifactRefSchema.safeParse({ ...log, required: undefined }).success).toBe(false);
    expect(ArtifactRefSchema.safeParse({ ...log, kind: "secret" }).success).toBe(false);
  });

  it("takes a pull-request address only without sign-in data, query or fragment", () => {
    expect(isPlainHttpsUrl("https://github.com/acme/shop/pull/7")).toBe(true);
    for (const bad of ["http://github.com/acme/shop/pull/7", "https://user:token@github.com/acme/shop/pull/7", "https://token@github.com/a/b/pull/7", "https://github.com/a/b/pull/7?access_token=x", "https://github.com/a/b/pull/7#x", "https://github.com:8443/a/b/pull/7", "github.com/a/b/pull/7", "https://github.com/a b"]) {
      expect(isPlainHttpsUrl(bad), bad).toBe(false);
      expect(PullRequestIdentitySchema.safeParse({ ...pr, url: bad }).success).toBe(false);
    }
    expect(PullRequestIdentitySchema.safeParse({ ...pr, repository: "/home/someone/shop" }).success).toBe(false);
    expect(PullRequestIdentitySchema.safeParse({ ...pr, head: "abc1234" }).success).toBe(false);
  });

  it("reads a model from an agent target and refuses anything else", () => {
    expect(modelIdentityOf("codex:openai:gpt-5")).toEqual(model);
    expect(modelIdentityOf("claude:local:llama3:8b", "high")).toEqual({ agent: "claude", provider: "local", model: "llama3:8b", effort: "high" });
    for (const bad of ["gpt-5", "codex:openai", "robot:openai:gpt-5", "codex::gpt-5", "codex:openai:", undefined, 7]) expect(modelIdentityOf(bad), String(bad)).toBeUndefined();
    expect(ModelIdentitySchema.safeParse({ ...model, apiKey: "sk-x" }).success).toBe(false);
    expect(ModelIdentitySchema.safeParse({ ...model, model: "a\nb" }).success).toBe(false);
  });

  it("names a tool without its arguments, and an account only by its id", () => {
    expect(ToolIdentitySchema.safeParse({ name: "Bash" }).success).toBe(true);
    expect(ToolIdentitySchema.safeParse({ name: "Bash: mkdir out" }).success).toBe(false);
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["run.cancelled"], by: { kind: "user", id: "someone@example.com" } }).success).toBe(false);
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["run.cancelled"], by: { kind: "user", id: USER, name: "Someone" } }).success).toBe(false);
    expect(EvidenceEventSchema.safeParse({ ...EVENTS["run.cancelled"], by: { kind: "system" } }).success).toBe(true);
  });
});

describe("the run manifest", () => {
  it("reads a full manifest and a smallest one", () => {
    expect(parseRunEvidence(manifest())).toEqual(manifest());
    const small = { ...manifest(), git: {}, models: [], policies: [], approvals: [], tests: [], artifacts: [], flow: { name: "f", sha256: H1 } };
    delete (small as Record<string, unknown>).diff;
    delete (small as Record<string, unknown>).pullRequest;
    expect(parseRunEvidence(small)).toEqual(small);
  });

  it("refuses what does not fit, with the path", () => {
    const bad = (change: Record<string, unknown>) => problems(() => parseRunEvidence({ ...manifest(), ...change })).issues.map((i) => i.path);
    expect(bad({ status: "stopped" })).toEqual(["status"]);
    expect(bad({ status: "running" })).toEqual(["status"]);
    expect(bad({ finishedAt: "2026-01-31T11:00:00Z" })).toEqual(["finishedAt"]);
    expect(bad({ finalizedAt: "2026-01-31T12:29:59.999Z" })).toEqual(["finalizedAt"]);
    expect(bad({ events: { path: "other.jsonl", count: 12, terminalHash: H1 } })).toEqual(["events.path"]);
    expect(bad({ events: { path: "evidence.jsonl", count: 0, terminalHash: H1 } })).toEqual(["events.count"]);
    expect(bad({ diff: log })).toEqual(["diff.kind"]);
    expect(bad({ artifacts: [log, { ...log, kind: "transcript" }] })).toEqual(["artifacts.1.path"]);
    expect(bad({ approvals: [{ step: shell, time: T, decision: "approved", by: user }] })).toEqual(["approvals.0.step.type"]);
    expect(bad({ git: { base: "main" } })).toEqual(["git.base"]);
    expect(bad({ flow: { name: "f" } })).toEqual(["flow.sha256"]);
    expect(bad({ task: "the task text" })).toEqual(["(root)"]);
    expect(bad({ models: undefined })).toEqual(["models"]);
  });

  it("orders times by the moment, not by their text", () => {
    expect(RunEvidenceSchema.safeParse({ ...manifest(), finishedAt: "2026-01-31T12:30:00.500Z", finalizedAt: "2026-01-31T12:30:01Z" }).success).toBe(true);
    expect(RunEvidenceSchema.safeParse({ ...manifest(), finishedAt: "2026-01-31T12:30:00.500Z", finalizedAt: "2026-01-31T12:30:00Z" }).success).toBe(false);
  });

  it("says absent for a run without a manifest, and never throws on a broken one", () => {
    expect(readRunEvidence(undefined)).toEqual({ state: "absent" });
    const ok = readRunEvidence(JSON.stringify(manifest()));
    expect(ok.state === "ok" && ok.evidence.runId).toBe("20260131-120000-abc");
    expect(readRunEvidence("{ not json")).toEqual({ state: "unreadable", code: "invalid", reason: "evidence manifest: not valid JSON" });
    expect(readRunEvidence("[]")).toEqual({ state: "unreadable", code: "not-an-object", reason: "evidence manifest: not a JSON object" });
    const newer = readRunEvidence(JSON.stringify({ ...manifest(), version: 2 }));
    expect(newer).toEqual({ state: "unreadable", code: "unsupported-version", reason: "evidence manifest: version 2 is not supported; this Foundry reads version 1. It was written by a newer Foundry: update to read it" });
  });

  it("is an extra file: a run.json of an older version is not an evidence record and is not needed to be one", () => {
    const oldRun = { runId: "20250101-000000-old", flow: "simple", status: "succeeded", startedAt: T, totalCostUsd: 0, history: [], state: { next: null, steps: {}, visits: {} } };
    expect(problems(() => parseRunEvidence(oldRun)).code).toBe("no-version");
    expect(readRunEvidence(undefined).state).toBe("absent");
  });
});

describe("versions and migration", () => {
  it("refuses a version it does not support, in one clear sentence", () => {
    const e = problems(() => parseEvidenceEvent({ ...EVENTS["run.queued"], version: 7 }));
    expect([e.kind, e.code]).toEqual(["event", "unsupported-version"]);
    expect(e.message).toBe("evidence event: version 7 is not supported; this Foundry reads versions 1 to 6. It was written by a newer Foundry: update to read it");
    expect(problems(() => upgradeEvidence({ version: 9 }, "manifest", 3, {})).message).toContain("this Foundry reads versions 1 to 3");
  });

  it("refuses a record without a usable version before looking at anything else", () => {
    for (const version of [undefined, null, "1", 0, -1, 1.5, Number.NaN]) {
      expect(problems(() => parseEvidenceEvent({ ...EVENTS["run.queued"], version, junk: true })).code, String(version)).toBe("no-version");
    }
    for (const raw of [null, undefined, "text", 7, [], [{ version: 1 }]]) expect(problems(() => parseEvidenceEvent(raw)).code).toBe("not-an-object");
    expect(problems(() => parseEvidenceEventLine("nope")).message).toBe("evidence event: not valid JSON");
  });

  it("brings an older record to the current version step by step, and leaves the input alone", () => {
    const steps = {
      1: (old: Record<string, unknown>) => ({ ...old, version: 2, name: old.title, title: undefined }),
      2: (old: Record<string, unknown>) => ({ ...old, version: 3, tags: [] }),
    };
    const v1 = Object.freeze({ version: 1, title: "x" });
    expect(upgradeEvidence(v1, "event", 3, steps)).toEqual({ version: 3, name: "x", title: undefined, tags: [] });
    expect(v1).toEqual({ version: 1, title: "x" });
    expect(upgradeEvidence({ version: 2, name: "y" }, "event", 3, steps)).toEqual({ version: 3, name: "y", tags: [] });
    const current = { version: 3, name: "z" };
    expect(upgradeEvidence(current, "event", 3, steps)).toBe(current);
  });

  it("refuses an old version that has no step, and a step that gives the wrong version", () => {
    const gap = problems(() => upgradeEvidence({ version: 1 }, "manifest", 3, { 2: (o) => ({ ...o, version: 3 }) }));
    expect([gap.code, gap.message]).toEqual(["unsupported-version", "evidence manifest: version 1 can no longer be read by this Foundry (there is no step to version 2)"]);
    expect(problems(() => upgradeEvidence({ version: 1 }, "event", 2, { 1: (o) => ({ ...o }) })).code).toBe("invalid");
    expect(problems(() => upgradeEvidence({ version: 1 }, "event", 2, { 1: () => null as unknown as Record<string, unknown> })).code).toBe("invalid");
  });

  it("checks a migrated record against the current schema", () => {
    // A version 6 record is current, so the step table is only used for lower versions.
    const typed: EvidenceEvent = parseEvidenceEvent(EVENTS["run.queued"], { 1: () => ({ version: 2 }) });
    expect(typed.version).toBe(6);
    // version 1 and 2 lines of an older Foundry read as version 6 (the real migrations only set the version)
    expect(parseEvidenceEvent({ ...EVENTS["run.queued"], version: 2 })).toEqual(EVENTS["run.queued"]);
    const old = parseEvidenceEvent({ ...EVENTS["run.queued"], version: 1 });
    expect(old).toEqual(EVENTS["run.queued"]);
    const m: RunEvidence = parseRunEvidence(manifest(), {});
    expect(m.version).toBe(1);
  });
});
