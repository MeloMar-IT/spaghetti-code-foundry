import { execFile, execFileSync } from "node:child_process";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliveryCommand } from "../src/delivery/cli.js";
import { buildDeliveryContract, deliveryContractText, signDeliveryContract, verifyDeliveryContract } from "../src/delivery/contract.js";
import { publicKeyLine } from "../src/delivery/sshsig.js";
import { canonicalJson, eventHash } from "../src/evidence/canonical.js";
import { readEvidenceChain } from "../src/evidence/chain.js";
import { ARTIFACT_KINDS, STEP_TYPES, TestResultSchema } from "../src/evidence/identity.js";
import { EVENT_MIGRATIONS } from "../src/evidence/parse.js";
import { DenialSchema, EVIDENCE_EVENT_TYPES, EvidenceEventSchema } from "../src/evidence/schema.js";
import { EVIDENCE_EVENT_VERSION } from "../src/evidence/version.js";
import { CONTEXT_OMISSION_REASONS } from "../src/context/schema.js";
import { CONTEXT_OUTCOMES } from "../src/evidence/schema.js";
import { COMPONENT_KINDS, GOVERNANCE_FAILURES, GOVERNANCE_OUTCOMES, GOVERNANCE_STATUSES, MAX_GOVERNED_COMPONENTS } from "../src/promotion/components.js";
import { RUN_CONTEXT_CODES } from "../src/engine/run-context.js";
import { AUTONOMY_LEVELS } from "../src/governance/autonomy.js";
import { REPO_EVIDENCE_OPERATIONS, REPO_OUTCOMES, REPO_REFUSALS } from "../src/engine/repo-request.js";
import { AGENTS } from "../src/flow/schema.js";
import { BOUNDARIES, CREDENTIALS, DENY_ONLY_REASONS, MODES, NO_PACK_REASONS, NO_RULE_REASONS, OUTCOMES } from "../src/policy/schema.js";
import { REASON_CODES } from "../src/policy/reasons.js";
import { EXCESS_FIELDS } from "../src/tool-profile/resolve.js";
import { OPERATIONS, TOOL_KINDS } from "../src/tool-profile/schema.js";
import { FIT_OUTCOMES, FIT_RESTRICTIONS, HELD_BY, PROFILE_SOURCES, UNREADABLE } from "../src/tool-profile/session.js";

const execFileAsync = promisify(execFile);
const SCRIPT = resolve("tools/delivery-validate/validate.mjs");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
const keyOf = (n: number): KeyObject => createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, n)]), format: "der", type: "pkcs8" });
const K1 = keyOf(1);
const K2 = keyOf(2);
const KEY1 = publicKeyLine(K1);
const KEY2 = publicKeyLine(K2);
const H = (c: string): string => c.repeat(64);
const T = "2026-01-31T12:00:00.000Z";
const C1 = "a".repeat(40);
const USER = "0b8f6a0e-5a52-4a4e-9a57-0f2f3f1f7c11";

type Rec = Record<string, any>;
interface Run {
  code: number;
  stdout: string;
  stderr: string;
}
const run = async (args: string[]): Promise<Run> => {
  try {
    const r = await execFileAsync(process.execPath, [SCRIPT, ...args], { maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
};

let root: string;
let repo: string;
let head: string;
let counter = 0;
const folder = (): string => {
  const d = join(root, `case-${counter++}`);
  mkdirSync(d);
  return d;
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "delivery-events-"));
  repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# readme\n");
  const id = ["-c", "user.email=t@example.com", "-c", "user.name=t"];
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, ...id, "commit", "-q", "-m", "base"]);
  head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The contract text for these evidence facts, and its signature. */
const contractFor = (count: number, terminalHash: string, runId = "run-1"): { text: string; sig: string } => {
  const c = buildDeliveryContract({
    runId,
    sequence: 1,
    repository: "acme/app",
    pullRequest: { repository: "acme/app", number: 7, url: "https://github.com/acme/app/pull/7", head },
    commit: { sha: head, branch: "feature/x" },
    dependencyLocks: [],
    ciWorkflows: [],
    requiredChecks: [],
    evidence: { count, terminalHash },
    artifacts: [],
    provenance: { required: false },
  });
  const text = deliveryContractText(c);
  return { text, sig: signDeliveryContract(text, K1) };
};

/** The lines of a chain. `mutate` changes an event before it is hashed (return false to leave it without a hash). */
function chain(bodies: Rec[], opts: { runId?: string; mutate?: (e: Rec, i: number) => boolean | void } = {}): string[] {
  const lines: string[] = [];
  let prev: string | null = null;
  bodies.forEach((body, i) => {
    const e: Rec = { version: EVIDENCE_EVENT_VERSION, id: `ev-${i}`, seq: i, runId: opts.runId ?? "run-1", time: T, prevHash: prev, ...structuredClone(body) };
    const keep = opts.mutate?.(e, i);
    if (keep !== false) e.hash = eventHash(e);
    lines.push(canonicalJson(e));
    prev = e.hash ?? null;
  });
  return lines;
}
const hashOf = (line: string | undefined): string => (line === undefined ? H("0") : (JSON.parse(line).hash ?? H("0")));

// ---- one valid body per event type (the envelope is added by chain) ----
const shell = { id: "test", visit: 1, type: "shell" };
const agent = { id: "code", visit: 2, type: "claude", parent: "build/inner" };
const gate = { id: "approve", visit: 1, type: "approval" };
const model = { agent: "codex", provider: "openai", model: "gpt-5" };
const log = { kind: "log", path: "steps/test-1.log", sha256: H("1"), bytes: 120, required: true };
const pr = { repository: "acme/shop", number: 7, url: "https://github.com/acme/shop/pull/7", head: C1 };
const user = { kind: "user", id: USER };
const DECISION = {
  version: 1,
  policy: { id: "baseline", version: "2026.1" },
  packSha256: H("1"),
  mode: "observe",
  boundary: "step.before",
  inputSha256: H("2"),
  outcome: "allow",
  reasonCode: "timeout.exceeded",
  rule: "r1",
  evaluatedAt: T,
};
const PROFILED = {
  type: "step.profiled",
  step: agent,
  agent: "codex",
  source: "declared",
  profile: { id: "reviewer", version: "1", sha256: H("1") },
  outcome: "partial",
  gaps: [],
  excess: [],
  unmappedRules: 0,
  personalSetup: false,
};
const REPO_OP = { type: "repo.operation", step: shell, operation: "push", credential: "repository", outcome: "done" };
const CTX_WRITTEN: Rec = {
  type: "context.bundled",
  outcome: "written",
  bundle: { kind: "other", path: "context.json", sha256: H("1"), bytes: 900, required: true },
  sourcesSha256: H("2"),
  limits: { maxSources: 50, maxSourceBytes: 20000, maxTotalBytes: 200000 },
  sources: 3,
  bytes: 1200,
  omitted: Object.fromEntries(CONTEXT_OMISSION_REASONS.map((r, i) => [r, i])),
};
const BASE: Record<string, Rec> = {
  "run.created": { type: "run.created", flow: { name: "issue-gitflow", version: 3 }, by: { kind: "watcher", id: "main-issues" } },
  "run.queued": { type: "run.queued" },
  "run.started": { type: "run.started", base: { commit: C1, branch: "feature/7-shop", repository: "acme/shop" } },
  "run.stopped": { type: "run.stopped", at: "test" },
  "run.resumed": { type: "run.resumed", from: "test", by: { kind: "cli" } },
  "run.cancelled": { type: "run.cancelled", by: user },
  "run.failed": { type: "run.failed", step: shell },
  "run.completed": { type: "run.completed", final: { commit: C1 }, pullRequest: pr },
  "step.started": { type: "step.started", step: agent },
  "step.routed": { type: "step.routed", step: agent, model, fallbackFrom: { agent: "claude", provider: "anthropic", model: "opus", effort: "high" } },
  "step.profiled": { ...PROFILED, gaps: [{ kind: "files", restriction: "data-class" }, { kind: "shell", restriction: "sandbox-network", heldBy: "codex-sandbox" }], excess: [{ kind: "shell", operation: "run", field: "targets" }] },
  "step.retried": { type: "step.retried", step: agent, cause: "limit" },
  "step.denied": { type: "step.denied", step: agent, denial: { kind: "policy", policy: { id: "baseline", version: "2026.1" }, reasonCode: "network.blocked", tool: { name: "Bash" } } },
  "step.approved": { type: "step.approved", step: gate, by: user },
  "step.failed": { type: "step.failed", step: shell, exitCode: 1, durationMs: 900, artifacts: [log], test: { suite: "test", outcome: "failed", passed: 10, failed: 2, skipped: 0 } },
  "step.completed": { type: "step.completed", step: agent, model, durationMs: 5000, artifacts: [log, { ...log, kind: "transcript", path: "steps/code-2.transcript.md", required: false }], commit: { commit: C1 }, pullRequest: pr },
  "policy.decided": { type: "policy.decided", decision: DECISION, step: shell },
  "repo.operation": { ...REPO_OP, repository: "own/repo", branch: "feat/x", policy: "allow" },
  "context.bundled": CTX_WRITTEN,
  "run.autonomy": { type: "run.autonomy", level: "plan-only", repository: "guarded-write", flow: "plan-only" },
  "governance.decided": { type: "governance.decided", outcome: "refused", components: [{ kind: "flow", id: "deploy", version: "3", status: "retired", refused: true }] },
};

// ---- bodies built from the library's lists (the drift guard) ----
const decision = (reasonCode: string, over: Rec = {}): Rec => ({
  ...DECISION,
  reasonCode,
  rule: (NO_RULE_REASONS as readonly string[]).includes(reasonCode) ? undefined : "r1",
  packSha256: (NO_PACK_REASONS as readonly string[]).includes(reasonCode) ? undefined : H("1"),
  outcome: reasonCode === "policy.break-glass" ? "warn" : (DENY_ONLY_REASONS as readonly string[]).includes(reasonCode) ? "deny" : "allow",
  mode: reasonCode === "policy.break-glass" ? "enforce" : "observe",
  ...over,
});
const decided = (d: Rec, s: Rec | null = shell): Rec => ({ type: "policy.decided", decision: d, ...(s ? { step: s } : {}) });
const RUN_WIDE = ["run.start", "run.complete", "context.select"];
const restrictionGaps = FIT_RESTRICTIONS.map((restriction) => ({ kind: "files", restriction }));
const excessOps = TOOL_KINDS.flatMap((kind) => OPERATIONS[kind].map((operation) => ({ kind, operation, field: "operation" })));

const GEN: Rec[] = [
  ...Object.values(BASE),
  ...STEP_TYPES.map((type) => ({ type: "step.started", step: { id: "s", visit: 1, type } })),
  ...AGENTS.map((a) => ({ type: "step.routed", step: shell, model: { agent: a, provider: "p", model: "m" } })),
  { type: "step.completed", step: shell, durationMs: 0, artifacts: ARTIFACT_KINDS.map((kind) => ({ ...log, kind, path: `steps/${kind}.log` })) },
  { type: "step.failed", step: shell, exitCode: -1, durationMs: 1, artifacts: [], test: { suite: "t", outcome: "passed", report: log } },
  { type: "step.retried", step: shell, cause: "outage" },
  { type: "step.retried", step: shell, cause: "limit" },
  { type: "step.denied", step: gate, denial: { kind: "approval", by: user } },
  { type: "step.denied", step: shell, denial: { kind: "tool", tool: { name: "mcp__server__tool" } } },
  { type: "step.denied", step: shell, denial: { kind: "policy", policy: { id: "p", version: "1" }, reasonCode: "x.y" } },
  { type: "step.denied", step: shell, denial: { kind: "policy", policy: { id: "p", version: "1" }, packSha256: H("1"), reasonCode: "x.y" } },
  { type: "step.denied", denial: { kind: "policy", policy: { id: "p", version: "1" }, packSha256: H("1"), reasonCode: "x.y", tool: { name: "Bash" } } },
  ...REASON_CODES.map((r) => decided(decision(r))),
  ...OUTCOMES.map((outcome) => decided(decision("timeout.exceeded", { outcome }))),
  ...MODES.map((mode) => decided(decision("timeout.exceeded", { mode }))),
  ...BOUNDARIES.map((boundary) => decided(decision("timeout.exceeded", { boundary }), RUN_WIDE.includes(boundary) ? null : shell)),
  decided(decision("timeout.exceeded", { boundary: "repository.access" }), null),
  { ...PROFILED, source: "generated", agent: "claude", outcome: "enforced" },
  ...PROFILE_SOURCES.map((source) => ({ ...PROFILED, source, outcome: "enforced" })),
  ...FIT_OUTCOMES.map((outcome) => ({ ...PROFILED, outcome })),
  ...UNREADABLE.map((unreadable) => ({ ...PROFILED, profile: undefined, unreadable, outcome: "refused" })),
  { ...PROFILED, agent: undefined, outcome: "refused", profile: undefined, unreadable: "error" },
  { ...PROFILED, gaps: restrictionGaps },
  { ...PROFILED, gaps: TOOL_KINDS.map((kind) => ({ kind, restriction: "timeout" })) },
  { ...PROFILED, gaps: HELD_BY.map((heldBy) => ({ kind: "shell", restriction: "sandbox-filesystem", heldBy })) },
  { ...PROFILED, excess: excessOps },
  { ...PROFILED, excess: EXCESS_FIELDS.map((field) => ({ kind: "shell", operation: "run", field })) },
  ...REPO_EVIDENCE_OPERATIONS.map((operation) => (operation === "unknown" ? { ...REPO_OP, operation, outcome: "refused", refusal: "invalid-request" } : { ...REPO_OP, operation })),
  ...REPO_REFUSALS.map((refusal) => ({ ...REPO_OP, outcome: "refused", refusal })),
  ...REPO_OUTCOMES.filter((o) => o !== "refused").map((outcome) => ({ ...REPO_OP, outcome })),
  ...CREDENTIALS.map((credential) => ({ ...REPO_OP, credential })),
  ...OUTCOMES.map((policy) => ({ ...REPO_OP, policy })),
  { ...REPO_OP, operation: "pull-request", pullRequest: pr },
  ...["user", "cli", "watcher", "system"].map((kind) => ({ type: "run.cancelled", by: { kind, ...(kind === "user" ? { id: USER } : kind === "watcher" ? { id: "w-1" } : {}) } })),
  // edge values the library accepts
  ...["2024-02-29T00:00:00Z", "2000-02-29T00:00:00Z", "2026-01-31T12:00:59.123456789Z"].map((time) => ({ type: "run.queued", time })),
  ...["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", USER.toUpperCase(), "0b8f6a0e-5a52-8a4e-ba57-0f2f3f1f7c11"].map((id) => ({ type: "run.cancelled", by: { kind: "user", id } })),
  ...GOVERNANCE_FAILURES.map((failure) => ({ type: "governance.decided", outcome: "refused", failure, components: [] })),
  ...GOVERNANCE_STATUSES.map((status) => ({ type: "governance.decided", outcome: "allowed", components: [{ kind: "flow", id: "a.b_c-(d)", status, refused: false }] })),
  ...COMPONENT_KINDS.map((kind) => ({ type: "governance.decided", outcome: "allowed", components: [{ kind, id: "x", version: "1.0.0", status: "ok", refused: false }] })),
  { type: "governance.decided", outcome: "allowed", components: [] },
  ...AUTONOMY_LEVELS.map((level) => ({ type: "run.autonomy", level, flow: "plan-only" })),
  ...AUTONOMY_LEVELS.map((level) => ({ type: "run.autonomy", level, repository: level, flow: level })),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((version) => ({ type: "run.queued", version })),
  ...RUN_CONTEXT_CODES.map((failure) => ({ type: "context.bundled", outcome: "failed", failure })),
  ...CONTEXT_OMISSION_REASONS.map((reason) => ({ ...CTX_WRITTEN, omitted: { ...(CTX_WRITTEN.omitted as object), [reason]: 7 } })),
];

// ---- running a case on both sides ----
interface Case {
  name: string;
  lines: string[];
  count?: number;
  tail?: string;
  terminalHash?: string;
  runId?: string;
  eventsText?: string;
  /** What the library must say. A case that is not what it says it is would test nothing. */
  ok: boolean;
  /** The fault both sides must report when `ok` is false (default: evidence-head-mismatch). */
  fault?: string;
}
const eventsOf = (c: Case): string => c.eventsText ?? c.lines.map((l) => `${l}\n`).join("") + (c.tail ?? "");

async function compare(c: Case): Promise<void> {
  const count = c.count ?? c.lines.length;
  const { text, sig } = contractFor(count, c.terminalHash ?? hashOf(c.lines[count - 1]));
  const events = eventsOf(c);
  const lib = verifyDeliveryContract(text, sig, KEY1, events);
  const d = folder();
  writeFileSync(join(d, "contract.json"), text);
  writeFileSync(join(d, "contract.sig"), sig);
  writeFileSync(join(d, "events.jsonl"), events);
  const r = await run(["--contract", join(d, "contract.json"), "--signature", join(d, "contract.sig"), "--public-key", KEY1, "--repo", repo, "--events", join(d, "events.jsonl"), "--json"]);
  const got = JSON.parse(r.stdout).checks.find((x: Rec) => x.check === "evidence");
  expect(lib.ok, `${c.name}: library`).toBe(c.ok);
  if (lib.ok) {
    expect(got, c.name).toEqual({ check: "evidence", status: "ok" });
    expect(r.code, c.name).toBe(0);
  } else {
    expect(lib.fault, c.name).toBe(c.fault ?? "evidence-head-mismatch");
    expect(got, c.name).toEqual({ check: "evidence", status: "stop", condition: "evidence-unverified", fault: lib.fault, reason: lib.message });
    expect(r.code, c.name).toBe(1);
  }
}
/** Runs the cases in groups, so a few dozen processes are not started at once. */
async function all(cases: Case[]): Promise<void> {
  for (let i = 0; i < cases.length; i += 16) await Promise.all(cases.slice(i, i + 16).map(compare));
}

describe("drift guard: the copied lists and the event schema", () => {
  const source = readFileSync(SCRIPT, "utf8");
  const fromScript = (name: string): unknown => {
    const m = new RegExp(`\\nconst ${name} = ([\\s\\S]*?);\\n`).exec(source);
    expect(m, `${name} is in the script`).not.toBeNull();
    return new Function(`return ${m![1]}`)();
  };
  const inline = (): { retry: string[]; test: string[]; denial: string[] } => {
    const retry = (EvidenceEventSchema as any).options.find((o: any) => o.shape.type.value === "step.retried");
    return { retry: retry.shape.cause.options, test: TestResultSchema.shape.outcome.options as string[], denial: DenialSchema.options.map((o) => o.shape.kind.value) };
  };

  it("copies every list of the library, value for value", () => {
    const lists: Record<string, unknown> = {
      ARTIFACT_KINDS, STEP_TYPES, AGENTS, OUTCOMES, MODES, BOUNDARIES, CREDENTIALS, REASON_CODES, NO_RULE_REASONS, NO_PACK_REASONS, DENY_ONLY_REASONS,
      TOOL_KINDS, OPERATIONS, PROFILE_SOURCES, FIT_OUTCOMES, FIT_RESTRICTIONS, HELD_BY, UNREADABLE, EXCESS_FIELDS, REPO_EVIDENCE_OPERATIONS, REPO_OUTCOMES, REPO_REFUSALS,
      CONTEXT_OUTCOMES, CONTEXT_OMISSION_REASONS, RUN_CONTEXT_CODES,
      COMPONENT_KINDS, GOVERNANCE_STATUSES, GOVERNANCE_OUTCOMES, GOVERNANCE_FAILURES, MAX_GOVERNED_COMPONENTS,
      RETRY_CAUSES: inline().retry, TEST_OUTCOMES: inline().test,
    };
    for (const [name, list] of Object.entries(lists)) expect(fromScript(name), name).toEqual(list);
    expect(inline().denial).toEqual(["approval", "tool", "policy"]);
    expect(source).toContain(`const EVIDENCE_EVENT_VERSION = ${EVIDENCE_EVENT_VERSION};`);
  });
  it("has a body for every event type, and the migrations only set the version", () => {
    expect(Object.keys(BASE).sort()).toEqual([...EVIDENCE_EVENT_TYPES].sort());
    expect(Object.keys(EVENT_MIGRATIONS).map(Number)).toEqual(Array.from({ length: EVIDENCE_EVENT_VERSION - 1 }, (_, i) => i + 1));
    for (let v = 1; v < EVIDENCE_EVENT_VERSION; v++) expect(EVENT_MIGRATIONS[v]!({ version: v, x: 1 })).toEqual({ version: v + 1, x: 1 });
  });
  it("accepts one valid event of every type and of every enum value, as the library does", async () => {
    const lines = chain(GEN);
    expect(readEvidenceChain(lines, "run-1")).toMatchObject({ ok: true });
    await compare({ name: "every value", lines, ok: true });
  });
  it("refuses a version above its own, as the library does", async () => {
    await compare({ name: "version + 1", lines: chain([{ type: "run.queued", version: EVIDENCE_EVENT_VERSION + 1 }]), ok: false });
  });
});

const three = (): string[] => chain([BASE["run.created"]!, BASE["run.queued"]!, BASE["run.started"]!]);

describe("parity: the chain", () => {
  it("gives the verdict of the library for the basic cases", async () => {
    const g = three();
    const five = chain([BASE["run.created"]!, BASE["run.queued"]!, BASE["run.started"]!, BASE["run.queued"]!, BASE["run.queued"]!]);
    const crooked = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(g[1]!)).reverse()));
    const suffix = `${"\n".repeat(8 * 1024 * 1024)}garbage`;
    const deep = `{"x":${"[".repeat(100000)}${"]".repeat(100000)}}`;
    await all([
      { name: "exactly count", lines: g, ok: true },
      { name: "more events", lines: five, count: 3, ok: true },
      { name: "a trailing partial line", lines: g, tail: '{"partial', ok: true },
      { name: "count lines without the last line end", lines: g.slice(0, 2), tail: g[2], count: 3, terminalHash: hashOf(g[2]), ok: false },
      { name: "fewer events", lines: g.slice(0, 2), count: 3, terminalHash: hashOf(g[2]), ok: false },
      { name: "an empty file", lines: [], count: 1, terminalHash: H("0"), ok: false },
      { name: "a changed body", lines: [g[0]!, g[1]!.replace("ev-1", "ev-9"), g[2]!], ok: false },
      { name: "another run's chain", lines: chain([BASE["run.created"]!, BASE["run.queued"]!, BASE["run.started"]!], { runId: "run-2" }), ok: false },
      { name: "a reordered pair", lines: [g[0]!, g[2]!, g[1]!], terminalHash: hashOf(g[1]), ok: false },
      { name: "a non-canonical line", lines: [g[0]!, crooked, g[2]!], ok: false },
      { name: "CRLF line ends", lines: g, eventsText: g.join("\r\n") + "\r\n", ok: false },
      { name: "a line that is not JSON", lines: [g[0]!, "nope", g[2]!], ok: false },
      { name: "a JSON array line", lines: [g[0]!, "[]", g[2]!], ok: false },
      { name: "a deeply nested line", lines: [g[0]!, deep, g[2]!], ok: false },
      { name: "a too-high version", lines: chain([{ type: "run.queued", version: EVIDENCE_EVENT_VERSION + 1 }]), ok: false },
      { name: "an unchained event", lines: chain([BASE["run.queued"]!], { mutate: (e) => (delete e.prevHash, false) }), terminalHash: H("0"), ok: false },
      { name: "a duplicate id", lines: chain([BASE["run.queued"]!, BASE["run.queued"]!], { mutate: (e, i) => void (i === 1 && (e.id = "ev-0")) }), ok: false },
      { name: "a gap in seq", lines: chain([BASE["run.queued"]!, BASE["run.queued"]!], { mutate: (e, i) => void (i === 1 && (e.seq = 5)) }), ok: false },
      { name: "a terminalHash from another index", lines: g, terminalHash: hashOf(g[1]), ok: false },
      { name: "a large ignored suffix", lines: g, eventsText: g.map((l) => `${l}\n`).join("") + suffix, ok: true },
    ]);
  });
});

describe("parity: the local-test marker", () => {
  const marked = { ...BASE["run.created"]!, localTest: true };
  const lt = (name: string, bodies: Rec[], extra: Partial<Case> = {}): Case => ({ name, lines: chain(bodies), ok: false, fault: "local-test", ...extra });
  it("refuses a valid chain with the marker, as the library does", async () => {
    await all([
      lt("the marker alone", [marked]),
      lt("the marker and later events", [marked, BASE["run.queued"]!, BASE["run.stopped"]!, BASE["run.resumed"]!, BASE["step.started"]!]),
      lt("a version 7 line with the marker", [{ ...marked, version: 7 }, BASE["run.queued"]!]),
      // a marker beyond count is not read
      { name: "a marker beyond count", lines: chain([BASE["run.created"]!, BASE["run.queued"]!, { ...BASE["run.created"]!, localTest: true }]), count: 2, ok: true },
    ]);
  });
  it("reports a broken chain that holds the marker as a head mismatch", async () => {
    const g = chain([marked, BASE["run.queued"]!, BASE["run.started"]!]);
    await all([{ name: "a marked chain with a changed body", lines: [g[0]!, g[1]!.replace("ev-1", "ev-9"), g[2]!], ok: false }]);
  });
  it("refuses a marker that is not true on both sides", async () => {
    await all([false, "true", 1, null].map((v) => ({ name: `localTest ${JSON.stringify(v)}`, lines: chain([{ ...BASE["run.created"]!, localTest: v }]), ok: false }) as Case));
  });
  it("shows the reason in the text output", async () => {
    const lines = chain([marked]);
    const { text, sig } = contractFor(1, hashOf(lines[0]));
    const d = folder();
    writeFileSync(join(d, "contract.json"), text);
    writeFileSync(join(d, "contract.sig"), sig);
    writeFileSync(join(d, "events.jsonl"), lines.map((l) => `${l}\n`).join(""));
    const r = await run(["--contract", join(d, "contract.json"), "--signature", join(d, "contract.sig"), "--public-key", KEY1, "--repo", repo, "--events", join(d, "events.jsonl")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("evidence: stop evidence-unverified: the run is a local test, so it is not eligible for delivery");
  });
});

describe("parity: events that are hashed and anchored but break the schema", () => {
  const one = (name: string, fn: (e: Rec) => void, type = "step.started"): Case => ({ name, lines: chain([BASE[type]!], { mutate: (e) => void fn(e) }), ok: false });
  const withBody = (name: string, body: Rec): Case => ({ name, lines: chain([body]), ok: false });
  const second = (name: string, fn: (e: Rec) => boolean | void): Case => ({ name, lines: chain([BASE["run.queued"]!, BASE["run.queued"]!], { mutate: (e, i) => (i === 1 ? fn(e) : undefined) }), ok: false });

  it("refuses the envelope the same way", async () => {
    const times = ["2026-01-31T12:00:00+01:00", "2026-02-30T12:00:00Z", "2100-02-29T00:00:00Z", "2026-01-31T23:59:60Z", "2026-01-31T12:00:00z", "2026-01-31 12:00:00Z", "2026-01-31T12:00Z", ""];
    await all([
      one("missing time", (e) => delete e.time),
      ...times.map((t) => one(`time ${t}`, (e) => (e.time = t))),
      one("unknown top field", (e) => (e.extra = 1)),
      one("unknown field in step", (e) => (e.step.extra = 1)),
      one("__proto__ key", (e) => Object.defineProperty(e, "__proto__", { value: 1, enumerable: true, configurable: true, writable: true })),
      one("unknown event type", (e) => (e.type = "run.unknown")),
      one("no event type", (e) => delete e.type),
      one("a bad event id", (e) => (e.id = "a b")),
      one("version as text", (e) => (e.version = "4")),
      one("version 0", (e) => (e.version = 0)),
      one("version 1.5", (e) => (e.version = 1.5)),
      one("a bad run id", (e) => (e.runId = "a/b")),
    ]);
  });
  it("refuses bad enums, numbers and lengths the same way", async () => {
    const prof = (fn: (e: Rec) => void): ((e: Rec) => void) => fn;
    await all([
      one("bad profiled source", prof((e) => (e.source = "made-up")), "step.profiled"),
      one("bad profiled outcome", prof((e) => (e.outcome = "nope")), "step.profiled"),
      one("bad gap restriction", prof((e) => (e.gaps[0].restriction = "nope")), "step.profiled"),
      one("bad excess field", prof((e) => (e.excess[0].field = "nope")), "step.profiled"),
      one("bad unreadable", prof((e) => ((e.unreadable = "nope"), delete e.profile)), "step.profiled"),
      one("bad repo operation", (e) => (e.operation = "rebase"), "repo.operation"),
      one("bad credential", (e) => (e.credential = "key"), "repo.operation"),
      one("bad repo outcome", (e) => (e.outcome = "ok"), "repo.operation"),
      one("bad boundary", (e) => (e.decision.boundary = "nope"), "policy.decided"),
      one("a reason code that is a slug but unknown", (e) => (e.decision.reasonCode = "made.up"), "policy.decided"),
      one("bad retry cause", (e) => (e.cause = "boom"), "step.retried"),
      one("bad test outcome", (e) => (e.test.outcome = "skipped"), "step.failed"),
      one("bad actor kind", (e) => (e.by.kind = "robot"), "run.cancelled"),
      one("bad denial kind", (e) => (e.denial.kind = "other"), "step.denied"),
      one("bad step type", (e) => (e.step.type = "magic"), "step.started"),
      one("bad artifact kind", (e) => (e.artifacts[0].kind = "video"), "step.failed"),
      one("visit 0", (e) => (e.step.visit = 0)),
      one("durationMs -1", (e) => (e.durationMs = -1), "step.failed"),
      one("durationMs 1.5", (e) => (e.durationMs = 1.5), "step.failed"),
      one("exitCode 1.5", (e) => (e.exitCode = 1.5), "step.failed"),
      one("unmappedRules 2**53", (e) => (e.unmappedRules = 2 ** 53), "step.profiled"),
      one("101 gaps", (e) => (e.gaps = Array.from({ length: 101 }, () => ({ kind: "files", restriction: "timeout" }))), "step.profiled"),
      one("201 excess entries", (e) => (e.excess = Array.from({ length: 201 }, () => ({ kind: "shell", operation: "run", field: "targets" }))), "step.profiled"),
      one("a 41-character operation", (e) => (e.excess[0].operation = "x".repeat(41)), "step.profiled"),
      one("a 33-character effort", (e) => (e.fallbackFrom.effort = "e".repeat(33)), "step.routed"),
      one("a model name with a leading space", (e) => (e.model.model = " gpt"), "step.routed"),
      one("a flow name with a control character", (e) => (e.flow.name = "a\nb"), "run.created"),
      one("an unknown autonomy level", (e) => (e.level = "full"), "run.autonomy"),
      one("a flow version 0",(e) => (e.flow.version = 0), "run.created"),
      one("a parent of a//b", (e) => (e.step.parent = "a//b")),
      one("a step id with a digit first", (e) => (e.step.id = "1a")),
      one("a null where a step is optional", (e) => (e.step = null), "run.failed"),
      one("an unsafe artifact path", (e) => (e.artifacts[0].path = "../x"), "step.failed"),
      one("a bad commit", (e) => (e.final.commit = "abc"), "run.completed"),
    ]);
  });
  it("refuses every cross-field rule the same way", async () => {
    const prof = (fn: (e: Rec) => void): ((e: Rec) => void) => fn;
    const dec = (fn: (d: Rec) => void) => (e: Rec) => fn(e.decision);
    await all([
      second("hash without prevHash", (e) => void delete e.prevHash),
      second("prevHash null at seq 1", (e) => void (e.prevHash = null)),
      one("a hash as prevHash at seq 0", (e) => (e.prevHash = H("1"))),
      one("duplicate artifact paths", (e) => e.artifacts.push({ ...e.artifacts[0] }), "step.failed"),
      one("a step on run.start", (e) => ((e.step = shell), (e.decision.boundary = "run.start")), "policy.decided"),
      one("no step on step.before", (e) => delete e.step, "policy.decided"),
      one("a step on context.select", (e) => ((e.step = shell), (e.decision.boundary = "context.select")), "policy.decided"),
      one("a refused decision with nothing refused", (e) => (e.components[0].refused = false), "governance.decided"),
      one("an allowed decision with a refused component", (e) => (e.outcome = "allowed"), "governance.decided"),
      one("an allowed decision with a failure", (e) => ((e.outcome = "allowed"), (e.components[0].refused = false), (e.failure = "check-failed")), "governance.decided"),
      one("a component id with a space", (e) => (e.components[0].id = "a b"), "governance.decided"),
      one("a written bundle without its file", (e) => delete e.bundle, "context.bundled"),
      one("a written bundle with a failure", (e) => (e.failure = "internal"), "context.bundled"),
      one("a bundle at another path", (e) => (e.bundle.path = "other.json"), "context.bundled"),
      one("a bundle that is not required", (e) => (e.bundle.required = false), "context.bundled"),
      one("an omitted count missing", (e) => delete e.omitted.stale, "context.bundled"),
      one("a failed bundle without a code", (e) => ((e.outcome = "failed"), ["bundle", "sourcesSha256", "limits", "sources", "bytes", "omitted"].forEach((k) => delete e[k])), "context.bundled"),
      one("a failed bundle with counts", (e) => ((e.outcome = "failed"), (e.failure = "internal")), "context.bundled"),
      one("profiled without an agent and not refused", prof((e) => delete e.agent), "step.profiled"),
      one("generated and refused", prof((e) => ((e.source = "generated"), (e.outcome = "refused"))), "step.profiled"),
      one("generated with excess", prof((e) => (e.source = "generated")), "step.profiled"),
      one("generated without a profile", prof((e) => ((e.source = "generated"), (e.excess = []), delete e.profile, (e.unreadable = "error"))), "step.profiled"),
      one("a profile together with unreadable", prof((e) => (e.unreadable = "error")), "step.profiled"),
      one("no profile and not unreadable", prof((e) => delete e.profile), "step.profiled"),
      one("no profile and not refused", prof((e) => (delete e.profile, (e.unreadable = "error"), (e.outcome = "partial"))), "step.profiled"),
      one("an excess operation that is not of its kind", prof((e) => (e.excess[0].operation = "push")), "step.profiled"),
      one("heldBy with claude", prof((e) => (e.agent = "claude")), "step.profiled"),
      one("refused without a refusal", (e) => (e.outcome = "refused"), "repo.operation"),
      one("done with a refusal", (e) => (e.refusal = "policy"), "repo.operation"),
      one("unknown and done", (e) => (e.operation = "unknown"), "repo.operation"),
      one("unknown and refused with another refusal", (e) => ((e.operation = "unknown"), (e.outcome = "refused"), (e.refusal = "policy")), "repo.operation"),
      one("a pull request on push", (e) => (e.pullRequest = pr), "repo.operation"),
      one("a pull request that is not done", (e) => ((e.operation = "pull-request"), (e.outcome = "failed"), (e.pullRequest = pr)), "repo.operation"),
      one("a rule with a no-rule reason", dec((d) => (d.reasonCode = "policy.no-rule-matched")), "policy.decided"),
      one("no rule with a rule reason", dec((d) => delete d.rule), "policy.decided"),
      one("a pack hash with policy.invalid", dec((d) => ((d.reasonCode = "policy.invalid"), delete d.rule, (d.outcome = "deny"))), "policy.decided"),
      one("no pack hash with a rule reason", dec((d) => delete d.packSha256), "policy.decided"),
      one("a deny-only reason that allows", dec((d) => ((d.reasonCode = "policy.input-incomplete"), delete d.rule)), "policy.decided"),
      one("break-glass that denies", dec((d) => ((d.reasonCode = "policy.break-glass"), delete d.rule, delete d.packSha256, (d.mode = "enforce"), (d.outcome = "deny"))), "policy.decided"),
      one("break-glass in observe mode", dec((d) => ((d.reasonCode = "policy.break-glass"), delete d.rule, delete d.packSha256, (d.outcome = "warn"))), "policy.decided"),
      one("no-rule-matched that warns", dec((d) => ((d.reasonCode = "policy.no-rule-matched"), delete d.rule, (d.outcome = "warn"))), "policy.decided"),
      one("a decision with another version", dec((d) => (d.version = 2)), "policy.decided"),
      one("approved on a shell step", (e) => (e.step = shell), "step.approved"),
      withBody("an approval denial on a shell step", { type: "step.denied", step: shell, denial: { kind: "approval", by: user } }),
      withBody("a tool denial without a step", { type: "step.denied", denial: { kind: "tool", tool: { name: "Bash" } } }),
      withBody("an approval denial without a step", { type: "step.denied", denial: { kind: "approval", by: user } }),
      withBody("a bad pack hash on a policy denial", { type: "step.denied", step: shell, denial: { kind: "policy", policy: { id: "p", version: "1" }, packSha256: "ABC", reasonCode: "x.y" } }),
      withBody("a pack hash on a tool denial", { type: "step.denied", step: shell, denial: { kind: "tool", tool: { name: "Bash" }, packSha256: H("1") } }),
    ]);
  });
  it("refuses bad identities the same way", async () => {
    const uuid = (name: string, id: string): Case => withBody(name, { type: "run.cancelled", by: { kind: "user", id } });
    const url = (name: string, u: string): Case => withBody(name, { type: "run.completed", pullRequest: { ...pr, url: u } });
    await all([
      uuid("uuid version digit 0", "0b8f6a0e-5a52-0a4e-9a57-0f2f3f1f7c11"),
      uuid("uuid variant c", "0b8f6a0e-5a52-4a4e-ca57-0f2f3f1f7c11"),
      uuid("uuid FFFF…", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"),
      uuid("uuid without dashes", USER.replaceAll("-", "")),
      uuid("uuid with a trailing newline", `${USER}\n`),
      url("url http", "http://github.com/acme/shop/pull/7"),
      url("url with a query", "https://github.com/acme/shop/pull/7?q=1"),
      url("url with a user part", "https://me@github.com/acme/shop/pull/7"),
      withBody("a watcher id with a space", { type: "run.cancelled", by: { kind: "watcher", id: "a b" } }),
      withBody("a tool name with a space", { type: "step.denied", step: shell, denial: { kind: "tool", tool: { name: "a b" } } }),
    ]);
  });
});

describe("output, errors and the command", () => {
  const args = (count: number, events: string, key = KEY1): string[] => {
    const { text, sig } = contractFor(count, hashOf(chain([BASE["run.queued"]!, BASE["run.queued"]!])[count - 1]));
    const d = folder();
    writeFileSync(join(d, "contract.json"), text);
    writeFileSync(join(d, "contract.sig"), sig);
    return ["--contract", join(d, "contract.json"), "--signature", join(d, "contract.sig"), "--public-key", key, "--repo", repo, "--events", events];
  };
  const eventsFile = (text: string): string => {
    const f = join(folder(), "events.jsonl");
    writeFileSync(f, text);
    return f;
  };
  const good = chain([BASE["run.queued"]!, BASE["run.queued"]!]);

  it("prints ok, and a stop with the line", async () => {
    const ok = await run(args(2, eventsFile(good.join("\n") + "\n")));
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("evidence: ok\n");
    const bad = await run(args(2, eventsFile([good[0], good[1]!.replace("ev-1", "ev-9")].join("\n") + "\n")));
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("evidence: stop evidence-unverified: line 2 of the events is not a chain\n");
  });
  it("skips the check for an untrusted contract", async () => {
    const r = await run(args(2, eventsFile(good.join("\n") + "\n"), KEY2));
    expect(r.stdout).toContain("evidence: skipped (the contract is not trusted)\n");
  });
  it("is a read error (exit 2) for a missing file, a folder and a file that is too large", async () => {
    const big = join(folder(), "big.jsonl");
    writeFileSync(big, "");
    truncateSync(big, 256 * 1024 * 1024 + 1);
    const results = await Promise.all([join(root, "nope"), root, big].map((f) => run(args(2, f))));
    for (const r of results) {
      expect(r.code).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/^delivery-validate: --events /);
    }
  });
  it("never shows the content of a line", async () => {
    const r = await run(args(2, eventsFile('{"secret":"SECRET-XYZ"}\n{"secret":"SECRET-XYZ"}\n')));
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain("SECRET-XYZ");
  });
  it("is passed through by scf delivery validate", async () => {
    const capture = (a: string[]): Run => {
      let stdout = "";
      let stderr = "";
      const code = deliveryCommand(a, { out: (s) => void (stdout += s), err: (s) => void (stderr += s) });
      return { code, stdout, stderr };
    };
    for (const text of [good.join("\n") + "\n", "nope\nnope\n"]) {
      const a = args(2, eventsFile(text));
      expect(capture(["validate", ...a])).toEqual(await run(a));
    }
  });
});
