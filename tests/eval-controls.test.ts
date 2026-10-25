import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { ControlsExpectSchema, evaluateControls, readControlsInput, type ControlsExpect, type ControlsInput } from "../src/eval-controls.js";
import { controlsReportText, loadSuite, summarize, type EvalResult } from "../src/evals.js";
import { stepToolSettings } from "../src/agents/tool-gate.js";
import { loadFlow } from "../src/flow/load.js";
import { FlowSchema } from "../src/flow/schema.js";
import { toolSession } from "../src/tool-profile/session.js";
import { FIXTURE_RUN_ID, fixtureChain, writeEvidenceFixture, type EvidenceFixture } from "./fixtures/evidence-runs.js";

const config = ConfigSchema.parse({ protected_branches: [] });
const parse = (x: unknown): ControlsExpect => ControlsExpectSchema.parse(x);
const input = (o: Partial<ControlsInput> = {}): ControlsInput => ({ stream: { state: "ok", events: [] }, profiles: [], texts: [], unscannable: [], ...o });
const T = "2026-01-31T12:00:00.000Z";
const H = "1".repeat(64);
const step = (id: string, type = "claude") => ({ id, visit: 1, type });
const decided = (boundary: string, outcome: string, reasonCode = "timeout.exceeded") =>
  ({ type: "policy.decided", time: T, step: step("push"), decision: { version: 1, policy: { id: "base", version: "1" }, packSha256: H, mode: "enforce", boundary, inputSha256: H, outcome, reasonCode, evaluatedAt: T, rule: "r1" } });
const repoOp = (operation: string, credential: string, outcome = "done") => ({ type: "repo.operation", time: T, step: step("publish"), operation, credential, outcome, ...(outcome === "refused" ? { refusal: "no-credential" } : {}) });
const events = (bodies: Record<string, unknown>[]) => fixtureChain(bodies, FIXTURE_RUN_ID, 4).lines.map((l) => JSON.parse(l)) as never[];
const withEvents = (bodies: Record<string, unknown>[]): ControlsInput => input({ stream: { state: "ok", events: events(bodies) } });

describe("ControlsExpectSchema", () => {
  it("accepts a full block", () => {
    const c = parse({
      policy: [{ boundary: "push", outcome: "deny", reason: "branch.protected" }],
      allowed_tools: ["files.read", "shell", "github.pull-request.write"],
      max_privileges: { credential: "repository", sandbox: "required" },
      evidence: { fields: ["tests", "diff"] },
      prohibited_output: ["sk-[A-Za-z0-9]+"],
    });
    expect(c.evidence?.fields).toEqual(["tests", "diff"]);
  });

  it.each([
    ["an unknown key", { extra: 1 }],
    ["boundary pull", { policy: [{ boundary: "pull", outcome: "deny" }] }],
    ["outcome maybe", { policy: [{ boundary: "push", outcome: "maybe" }] }],
    ["tool git.deploy", { allowed_tools: ["git.deploy"] }],
    ["tool teleport", { allowed_tools: ["teleport"] }],
    ["a tool twice", { allowed_tools: ["git", "git"] }],
    ["credential admin", { max_privileges: { credential: "admin" } }],
    ["sandbox optional", { max_privileges: { sandbox: "optional" } }],
    ["field foo", { evidence: { fields: ["foo"] } }],
    ["a bad regex", { prohibited_output: ["("] }],
  ])("rejects %s", (_n, bad) => {
    expect(ControlsExpectSchema.safeParse(bad).success).toBe(false);
  });

  it("is read by loadSuite, and a bad block makes the suite invalid", () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-controls-suite-"));
    try {
      writeFileSync(join(dir, "ok.yaml"), "name: t\nflows: [one]\ncases:\n  - {name: a, repo: r, controls: {evidence: {fields: [tests]}}}\n");
      expect(loadSuite(join(dir, "ok.yaml")).cases[0]!.controls?.evidence?.fields).toEqual(["tests"]);
      writeFileSync(join(dir, "bad.yaml"), "name: t\nflows: [one]\ncases:\n  - {name: a, repo: r, controls: {nope: 1}}\n");
      expect(() => loadSuite(join(dir, "bad.yaml"))).toThrow(/invalid suite/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("policy", () => {
  const i = withEvents([decided("push", "allow"), decided("step.before", "deny")]);
  it("matches on outcome, and on outcome and reason", () => {
    expect(evaluateControls(i, parse({ policy: [{ boundary: "push", outcome: "allow" }] })).ok).toBe(true);
    expect(evaluateControls(i, parse({ policy: [{ boundary: "push", outcome: "allow", reason: "timeout.exceeded" }] })).ok).toBe(true);
  });
  it("names what was expected and seen", () => {
    const r = evaluateControls(i, parse({ policy: [{ boundary: "push", outcome: "deny", reason: "branch.protected" }] }));
    expect(r.ok).toBe(false);
    expect(r.policyOk).toBe(false);
    expect(r.firstMismatch?.message).toBe("policy push: expected deny (branch.protected), saw allow");
  });
  it("fails on a reason that differs and on no decision", () => {
    expect(evaluateControls(i, parse({ policy: [{ boundary: "push", outcome: "allow", reason: "other.reason" }] })).ok).toBe(false);
    expect(evaluateControls(i, parse({ policy: [{ boundary: "run.start", outcome: "deny" }] })).firstMismatch?.message).toBe("policy run.start: expected deny, saw no decision");
  });
  it("fails on the second expectation", () => {
    const r = evaluateControls(i, parse({ policy: [{ boundary: "push", outcome: "allow" }, { boundary: "step.before", outcome: "allow" }] }));
    expect(r.firstMismatch?.message).toBe("policy step.before: expected allow, saw deny");
  });
  it("is ok without a policy block", () => {
    expect(evaluateControls(i, parse({ evidence: {} })).policyOk).toBe(true);
  });
});

describe("tools", () => {
  const profile = (grants: { kind: never; operations: string[] }[], extra = {}) => ({ step: "code", sha12: "a1b2c3d4e5f6", resolved: { grants, sandboxed: true }, ...extra });
  const g = (kind: string, ...operations: string[]) => ({ kind: kind as never, operations });
  it("accepts grants on the list, by kind or by operation", () => {
    const i = input({ profiles: [profile([g("files", "read"), g("shell", "run")])] });
    expect(evaluateControls(i, parse({ allowed_tools: ["files.read", "shell"] })).ok).toBe(true);
  });
  it("fails on a grant outside the list", () => {
    const i = input({ profiles: [profile([g("files", "read", "write")])] });
    expect(evaluateControls(i, parse({ allowed_tools: ["files.read"] })).firstMismatch?.message).toBe("tools: expected only files.read, saw files.write (step code, profile)");
  });
  it("fails on a profile that cannot be resolved", () => {
    const i = input({ profiles: [{ step: "code", sha12: "a1b2c3d4e5f6" }] });
    expect(evaluateControls(i, parse({ allowed_tools: ["files"] })).firstMismatch?.message).toContain("profile a1b2c3d4e5f6 of step code that could not be resolved");
  });
  it("checks done repository operations and ignores refused ones", () => {
    const i = withEvents([repoOp("push", "repository", "refused"), repoOp("commit", "none")]);
    expect(evaluateControls(i, parse({ allowed_tools: ["git.commit"] })).ok).toBe(true);
    const j = withEvents([repoOp("push", "repository")]);
    expect(evaluateControls(j, parse({ allowed_tools: ["git.commit"] })).firstMismatch?.message).toBe("tools: expected only git.commit, saw git.push (step publish, repo.operation)");
    const k = withEvents([repoOp("pull-request", "repository")]);
    expect(evaluateControls(k, parse({ allowed_tools: ["github.pull-request.write"] })).ok).toBe(true);
  });
});

describe("privileges", () => {
  it("compares the credential in order", () => {
    const i = withEvents([repoOp("push", "repository")]);
    expect(evaluateControls(i, parse({ max_privileges: { credential: "repository" } })).ok).toBe(true);
    expect(evaluateControls(i, parse({ max_privileges: { credential: "none" } })).firstMismatch?.message).toBe("privileges: expected credential at most none, saw repository (step publish, push)");
    const m = withEvents([repoOp("push", "machine", "refused")]);
    expect(evaluateControls(m, parse({ max_privileges: { credential: "repository" } })).ok).toBe(false);
  });
  it("needs a sandbox for a shell grant", () => {
    const use = (sandboxed: boolean, kind = "shell") => input({ profiles: [{ step: "code", sha12: "abc", agent: "codex", resolved: { grants: [{ kind: kind as never, operations: ["run"] }], sandboxed } }] });
    const exp = parse({ max_privileges: { sandbox: "required" } });
    expect(evaluateControls(use(true), exp).ok).toBe(true);
    expect(evaluateControls(use(false, "files"), exp).ok).toBe(true);
    expect(evaluateControls(use(false), exp).firstMismatch?.message).toBe("privileges: expected a sandbox, saw shell without one (step code, codex)");
    expect(evaluateControls(input({ profiles: [{ step: "code", sha12: "abc" }] }), exp).ok).toBe(false);
  });
});

describe("evidence and output on typed input", () => {
  it("reports a manifest that did not verify, and an empty field", () => {
    const failed = { status: "failed", verified: false, failure: { code: "file-missing" } } as never;
    expect(evaluateControls(input({ verify: failed }), parse({ evidence: {} })).firstMismatch?.message).toBe("evidence: expected a verified manifest, saw failed (file-missing)");
    const ok = { status: "verified", verified: true } as never;
    const m = { policies: [], tests: [{}] } as never;
    expect(evaluateControls(input({ verify: ok, manifest: m }), parse({ evidence: { fields: ["tests"] } })).ok).toBe(true);
    const r = evaluateControls(input({ verify: ok, manifest: m }), parse({ evidence: { fields: ["tests", "policies"] } }));
    expect(r.evidenceOk).toBe(false);
    expect(r.firstMismatch?.message).toBe("evidence: expected field policies, saw it empty");
  });
  it("matches patterns without printing the match", () => {
    const i = input({ texts: [{ source: "logs/001-code.log", text: "token sk-TEST123" }] });
    expect(evaluateControls(i, parse({ prohibited_output: ["nothing"] })).ok).toBe(true);
    const r = evaluateControls(i, parse({ prohibited_output: ["nothing", "sk-[A-Z]+\\d+"] }));
    expect(r.firstMismatch?.message).toBe("output: expected no match of pattern #2, saw a match in logs/001-code.log");
    expect(JSON.stringify(r)).not.toContain("sk-TEST");
  });
  it("fails on a source that cannot be scanned, before any pattern", () => {
    const i = input({ unscannable: [{ source: "logs/003-big.log", why: "too-big" }] });
    expect(evaluateControls(i, parse({ prohibited_output: ["x"] })).firstMismatch?.message).toBe("output: expected every source scanned, saw logs/003-big.log too-big");
  });
  it("reports the first failing kind in a fixed order", () => {
    const i = input({ texts: [{ source: "diff", text: "bad" }], profiles: [{ step: "code", sha12: "abc" }] });
    const e = parse({ policy: [{ boundary: "push", outcome: "deny" }], allowed_tools: ["files"], prohibited_output: ["bad"] });
    expect(evaluateControls(i, e).firstMismatch?.kind).toBe("policy");
    const { policy: _p, ...rest } = e;
    expect(evaluateControls(i, rest).firstMismatch?.kind).toBe("tools");
  });
});

describe("untrusted", () => {
  const label = (o: Record<string, unknown> = {}) => ({ trust: "untrusted", signals: ["orders"], sha256: H, ...o }) as never;
  const rec = (id: string, l?: unknown, held?: string[]) => ({ id, ...(l ? { label: l as never } : {}), ...(held ? { held } : {}) });
  const check = (expect_: unknown, o: Partial<ControlsInput>) => evaluateControls(input(o), parse({ untrusted: expect_ }));

  it("is read by the schema: signals, sub-flow paths and nothing else", () => {
    expect(() => parse({ untrusted: [{ step: "issue", signals: ["orders"] }, { step: "build/code" }] })).not.toThrow();
    for (const bad of [[], [{ step: "a", signals: ["nope"] }], [{ step: "a b" }], [{ step: "a", extra: 1 }]]) {
      expect(() => parse({ untrusted: bad })).toThrow();
    }
  });
  it("lists the signals of the engine", async () => {
    const { SIGNALS } = await import("../src/engine/untrusted.js");
    const { CONTROL_SIGNALS } = await import("../src/eval-controls.js");
    expect([...CONTROL_SIGNALS]).toEqual([...SIGNALS]);
  });
  it("passes a step labelled untrusted with the signals", () => {
    expect(check([{ step: "issue", signals: ["orders"] }], { records: [rec("issue", label())] }).ok).toBe(true);
  });
  it("names what it saw otherwise", () => {
    const want = "untrusted: expected step issue labelled untrusted (orders) or held, saw ";
    const e = [{ step: "issue", signals: ["orders"] }];
    expect(check(e, { records: [rec("issue", label({ trust: "operator" }))] }).firstMismatch?.message).toBe(`${want}trust operator`);
    expect(check(e, { records: [rec("issue", label({ signals: [] }))] }).firstMismatch?.message).toBe(`${want}signals none`);
    expect(check(e, { records: [rec("other", label())] }).firstMismatch?.message).toBe(`${want}no record of it`);
    expect(check(e, { records: [rec("issue")] }).firstMismatch?.message).toBe(`${want}no label`);
    expect(check(e, {}).ok).toBe(false);
  });
  it("passes held content, from the run or from a record, even with another trust class", () => {
    const l = label({ trust: "operator", signals: [] });
    expect(check([{ step: "issue" }], { records: [rec("issue", l)], heldContent: { step: "issue", sha256: [H] } }).ok).toBe(true);
    expect(check([{ step: "issue" }], { records: [rec("issue", l, [H])] }).ok).toBe(true);
  });
  it("needs every visit of the step to pass", () => {
    expect(check([{ step: "issue" }], { records: [rec("issue", label()), rec("issue", label({ trust: "policy" }))] }).firstMismatch?.message).toContain("trust policy");
  });
  it("comes last in the order of the checks", () => {
    const i = input({ texts: [{ source: "diff", text: "bad" }], records: [rec("issue")] });
    const r = evaluateControls(i, parse({ untrusted: [{ step: "issue" }], prohibited_output: ["bad"] }));
    expect(r.firstMismatch?.kind).toBe("output");
  });
  it("is read from a run only when declared", () => {
    const run = { runId: FIXTURE_RUN_ID, runDir: "/nonexistent", flowDef: FlowSchema.parse({ name: "d", steps: [{ id: "a", type: "shell", run: "true" }] }), outputs: {}, history: [{ id: "sub/issue", parent: "sub", label: label(), held: [H] }] as never, heldContent: { step: "issue", sha256: [H] } };
    const none = readControlsInput(run, parse({ evidence: {} }), config);
    expect(none.records).toBeUndefined();
    expect(none.heldContent).toBeUndefined();
    const some = readControlsInput(run, parse({ untrusted: [{ step: "sub/issue" }] }), config);
    expect(some.records?.[0]).toMatchObject({ id: "sub/issue", held: [H] });
    expect(some.heldContent).toEqual({ step: "issue", sha256: [H] });
  });
});

describe("reading a synthetic run folder", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "factory-controls-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const flow = FlowSchema.parse({ name: "demo", workspace: "inplace", steps: [{ id: "code", type: "claude", prompt: "go", permission_mode: "bypassPermissions", allowed_tools: ["Bash"] }] });
  const run = (kind: EvidenceFixture, outputs: Record<string, string> = {}) => {
    const runDir = writeEvidenceFixture(mkdtempSync(join(dir, "r-")), kind);
    return { runId: FIXTURE_RUN_ID, runDir, flowDef: flow, toolProfile: undefined, outputs, repo: dir, workdir: runDir };
  };
  const writeStream = (runDir: string, bodies: Record<string, unknown>[], tail = "") => writeFileSync(join(runDir, "evidence.jsonl"), fixtureChain(bodies, FIXTURE_RUN_ID, 4).lines.map((l) => `${l}\n`).join("") + tail);
  const created = { type: "run.created", time: T, flow: { name: "demo" }, by: { kind: "cli" } };
  // the workspace is read by the injected reader in these tests; the real git reader has its own test below
  const noWorkspace = () => ({ texts: [], unscannable: [] });
  const read = (r: ReturnType<typeof run>, e: ControlsExpect, o: { maxLogBytes?: number } = {}) => readControlsInput(r, e, config, { readWorkspace: noWorkspace, ...o });

  it("verifies a good manifest and checks fields", () => {
    const r = run("valid");
    const e = parse({ evidence: { fields: ["tests", "diff"] } });
    expect(evaluateControls(read(r, e), e).ok).toBe(true);
    const e2 = parse({ evidence: { fields: ["policies"] } });
    expect(evaluateControls(read(r, e2), e2).firstMismatch?.message).toBe("evidence: expected field policies, saw it empty");
  });
  it("fails when the manifest does not verify or is missing", () => {
    const e = parse({ evidence: {} });
    expect(evaluateControls(read(run("changed-event"), e), e).evidenceOk).toBe(false);
    const gone = run("missing-file");
    expect(evaluateControls(read(gone, e), e).firstMismatch?.message).toContain("file-missing");
    const old = run("old");
    expect(evaluateControls(read(old, e), e).firstMismatch?.message).toContain("absent");
  });

  const pol = parse({ policy: [{ boundary: "push", outcome: "allow" }] });
  it("reads policy decisions from a stream", () => {
    const r = run("old");
    writeStream(r.runDir, [created, decided("push", "allow")]);
    expect(evaluateControls(read(r, pol), pol).ok).toBe(true);
  });
  it.each([
    ["a missing stream", "old", "no evidence events (absent)"],
  ])("fails closed for %s", (_n, kind, text) => {
    const r = run(kind as EvidenceFixture);
    expect(evaluateControls(read(r, pol), pol).firstMismatch?.message).toContain(text);
  });
  it("fails closed for a changed, cut-off and incomplete stream and a manifest that disagrees", () => {
    const r = run("old");
    writeStream(r.runDir, [created, decided("push", "allow")]);
    const text = fixtureChain([created, decided("push", "allow")], FIXTURE_RUN_ID, 4).lines;
    writeFileSync(join(r.runDir, "evidence.jsonl"), `${text[0]}\n${text[1]!.replace("enforce", "observe")}\n`);
    expect(evaluateControls(read(r, pol), pol).firstMismatch?.message).toContain("broken at line 2");
    writeStream(r.runDir, [created, decided("push", "allow")], '{"type":"run.que');
    expect(evaluateControls(read(r, pol), pol).firstMismatch?.message).toContain("cut off");
    writeStream(r.runDir, [created, decided("push", "allow")]);
    writeFileSync(join(r.runDir, "evidence.incomplete"), "");
    expect(evaluateControls(read(r, pol), pol).firstMismatch?.message).toContain("marked incomplete");
    rmSync(join(r.runDir, "evidence.incomplete"));
    const v = run("valid");
    writeStream(v.runDir, [created, decided("push", "allow")]);
    expect(evaluateControls(read(v, pol), pol).firstMismatch?.message).toContain("2 events, manifest says 8");
  });

  it("rebuilds a generated profile from the flow and decides on its sandbox", () => {
    const sha = (boxed: boolean) => toolSession(stepToolSettings(flow.steps[0] as never, { flow }, { config }, { boxed, isolated: false })).ref.sha256;
    const profiled = (agent: string, sha256: string) => ({
      type: "step.profiled", time: T, step: step("code"), agent, source: "generated", profile: { id: "legacy-settings", version: "1", sha256 },
      outcome: "enforced", gaps: [], excess: [], unmappedRules: 0, personalSetup: false,
    });
    const r = run("old");
    const files = parse({ allowed_tools: ["files", "builtin", "shell"] });
    writeStream(r.runDir, [created, profiled("claude", sha(false))]);
    const seen = read(r, files);
    expect(seen.profiles).toHaveLength(1);
    expect(seen.profiles[0]!.resolved).toBeDefined();
    expect(evaluateControls(seen, parse({ allowed_tools: ["files"] })).ok).toBe(false);
    // bypassPermissions without the Claude sandbox: a shell grant that is not sandboxed
    const sb = parse({ max_privileges: { sandbox: "required" } });
    expect(evaluateControls(read(r, sb), sb).firstMismatch?.message).toBe("privileges: expected a sandbox, saw shell without one (step code, claude)");
    // Codex under bypassPermissions without a sandbox runs with full access too
    writeStream(r.runDir, [created, profiled("codex", sha(false))]);
    expect(evaluateControls(read(r, sb), sb).ok).toBe(false);
    // a hash nobody can rebuild
    writeStream(r.runDir, [created, profiled("claude", "f".repeat(64))]);
    const unknown = read(r, files);
    expect(unknown.profiles[0]!.resolved).toBeUndefined();
    expect(evaluateControls(unknown, files).firstMismatch?.message).toContain("could not be resolved");
    // a refused event is ignored
    writeStream(r.runDir, [created, { ...profiled("claude", "f".repeat(64)), outcome: "refused", excess: [{ kind: "shell", operation: "run", field: "targets" }] }]);
    expect(read(r, files).profiles).toHaveLength(0);
  });

  it("treats a sandboxed Claude step as sandboxed", () => {
    const sandboxed = FlowSchema.parse({ name: "demo", workspace: "inplace", steps: [{ id: "code", type: "claude", prompt: "go", permission_mode: "bypassPermissions", allowed_tools: ["Bash"], sandbox: true }] });
    const sha256 = toolSession(stepToolSettings(sandboxed.steps[0] as never, { flow: sandboxed }, { config }, { boxed: false, isolated: false })).ref.sha256;
    const r = { ...run("old"), flowDef: sandboxed };
    writeStream(r.runDir, [created, { type: "step.profiled", time: T, step: step("code"), agent: "claude", source: "generated", profile: { id: "legacy-settings", version: "1", sha256 }, outcome: "enforced", gaps: [], excess: [], unmappedRules: 0, personalSetup: false }]);
    const sb = parse({ max_privileges: { sandbox: "required" } });
    expect(evaluateControls(read(r, sb), sb).ok).toBe(true);
  });

  it("scans logs, outputs and the diff, and never prints the match", () => {
    const r = run("valid", { note: 'say "forbidden"\\', exact: "forbidden" });
    const clean = parse({ prohibited_output: ["NOT_THERE"] });
    expect(evaluateControls(read(r, clean), clean).ok).toBe(true);
    const log = parse({ prohibited_output: ["NOT_THERE", "12 tests"] });
    const l = evaluateControls(read(r, log), log);
    expect(l.firstMismatch?.message).toBe("output: expected no match of pattern #2, saw a match in logs/002-run_tests.log");
    expect(l.firstMismatch?.message).not.toContain("12 tests");
    expect(evaluateControls(read(r, parse({ prohibited_output: ["^forbidden$"] })), parse({ prohibited_output: ["^forbidden$"] })).firstMismatch?.message).toContain("outputs.exact");
    const raw = parse({ prohibited_output: ['"forbidden"\\\\'] });
    expect(evaluateControls(read(r, raw), raw).firstMismatch?.message).toContain("outputs.note");
    const diff = parse({ prohibited_output: ["\\+changed"] });
    expect(evaluateControls(read(r, diff), diff).firstMismatch?.message).toContain("saw a match in diff");
  });
  it("fails on sources it cannot scan", () => {
    const e = parse({ prohibited_output: ["NOT_THERE"] });
    const r = run("valid");
    expect(evaluateControls(read(r, e, { maxLogBytes: 10 }), e).firstMismatch?.message).toBe("output: expected every source scanned, saw logs/001-code.log too-big");

    symlinkSync(join(r.runDir, "evidence.diff"), join(r.runDir, "logs", "003-link.log"));
    expect(evaluateControls(read(r, e), e).firstMismatch?.message).toBe("output: expected every source scanned, saw logs/003-link.log not-a-file");
    rmSync(join(r.runDir, "logs", "003-link.log"));

    const noDiff = run("valid");
    rmSync(join(noDiff.runDir, "evidence.diff"));
    expect(evaluateControls(read(noDiff, e), e).firstMismatch?.message).toBe("output: expected every source scanned, saw diff missing");

    const old = run("old");
    expect(evaluateControls(read(old, e), e).firstMismatch?.message).toBe("output: expected every source scanned, saw manifest missing");

    const asFile = run("valid");
    rmSync(join(asFile.runDir, "logs"), { recursive: true });
    writeFileSync(join(asFile.runDir, "logs"), "not a folder");
    expect(evaluateControls(read(asFile, e), e).firstMismatch?.message).toContain("logs unreadable");
  });
  it.skipIf(process.getuid?.() === 0)("fails on a log it cannot read", () => {
    const e = parse({ prohibited_output: ["NOT_THERE"] });
    const r = run("valid");
    chmodSync(join(r.runDir, "logs", "002-run_tests.log"), 0);
    expect(evaluateControls(read(r, e), e).firstMismatch?.message).toBe("output: expected every source scanned, saw logs/002-run_tests.log unreadable");
  });
  it("fails on a missing diff when the commits differ and the manifest lists none", () => {
    const r = run("valid");
    const path = join(r.runDir, "evidence.json");
    const m = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    delete m.diff;
    writeFileSync(path, JSON.stringify(m));
    const e = parse({ prohibited_output: ["NOT_THERE"] });
    expect(evaluateControls(read(r, e), e).firstMismatch?.message).toBe("output: expected every source scanned, saw diff missing");
  });
});

describe("output sources, sub-flows and empty fields", () => {
  let dir: string;
  const T0 = "2026-01-31T12:00:00.000Z";
  const created = { type: "run.created", time: T0, flow: { name: "demo" }, by: { kind: "cli" } };
  const outer = FlowSchema.parse({ name: "outer", workspace: "inplace", steps: [{ id: "build", type: "flow", flow: "inner" }] });
  const config0 = ConfigSchema.parse({ protected_branches: [] });
  const noWorkspace = () => ({ texts: [], unscannable: [] });
  const mk = (kind: EvidenceFixture, flowDef: unknown = outer) => {
    const runDir = writeEvidenceFixture(mkdtempSync(join(dir, "r-")), kind);
    return { runId: FIXTURE_RUN_ID, runDir, flowDef, toolProfile: undefined, outputs: {}, repo: dir, workdir: runDir } as never as Parameters<typeof readControlsInput>[0];
  };
  const streamOf = (runDir: string, bodies: Record<string, unknown>[]) => writeFileSync(join(runDir, "evidence.jsonl"), fixtureChain(bodies, FIXTURE_RUN_ID, 4).lines.map((l) => `${l}\n`).join(""));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "factory-controls-more-"));
    mkdirSync(join(dir, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(dir, ".claude-factory", "flows", "inner.yaml"), "name: inner\nworkspace: inplace\nsteps:\n  - {id: code, type: claude, prompt: go, allowed_tools: [Read]}\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("resolves a profile of a step inside a sub-flow, and names it with its path", () => {
    const { flow: inner } = loadFlow("inner", dir);
    const sha256 = toolSession(stepToolSettings(inner.steps[0] as never, { flow: inner }, { config: config0 }, { boxed: false, isolated: false })).ref.sha256;
    const r = mk("old");
    streamOf(r.runDir, [created, { type: "step.profiled", time: T0, step: { id: "code", visit: 1, type: "claude", parent: "build" }, agent: "claude", source: "generated", profile: { id: "legacy-settings", version: "1", sha256 }, outcome: "enforced", gaps: [], excess: [], unmappedRules: 0, personalSetup: false }]);
    const ok = parse({ allowed_tools: ["files", "builtin"] });
    const seen = readControlsInput(r, ok, config0, { readWorkspace: noWorkspace });
    expect(seen.profiles.map((p) => p.step)).toEqual(["build/code"]);
    expect(evaluateControls(seen, ok).ok).toBe(true);
    const narrow = parse({ allowed_tools: ["files"] });
    expect(evaluateControls(readControlsInput(r, narrow, config0, { readWorkspace: noWorkspace }), narrow).firstMismatch?.message).toBe("tools: expected only files, saw builtin.call (step build/code, profile)");
  });

  it("scans uncommitted and new files of the workspace, not only the stored diff", () => {
    const ws = mkdtempSync(join(tmpdir(), "factory-controls-ws-"));
    try {
      const git = (...a: string[]) => execFileSync("git", ["-C", ws, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "ignore" });
      git("init", "-q");
      writeFileSync(join(ws, "a.txt"), "clean\n");
      git("add", "-A");
      git("commit", "-qm", "base");
      writeFileSync(join(ws, "a.txt"), "clean\nLEAK_UNCOMMITTED\n");
      writeFileSync(join(ws, "new.txt"), "LEAK_NEW\n");
      const r = { ...mk("valid"), workdir: ws };
      const tracked = parse({ prohibited_output: ["LEAK_UNCOMMITTED"] });
      expect(evaluateControls(readControlsInput(r, tracked, config0), tracked).firstMismatch?.message).toBe("output: expected no match of pattern #1, saw a match in workspace diff");
      const added = parse({ prohibited_output: ["LEAK_NEW"] });
      expect(evaluateControls(readControlsInput(r, added, config0), added).firstMismatch?.message).toBe("output: expected no match of pattern #1, saw a match in workspace/new.txt");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("fails when the workspace is gone", () => {
    const r = { ...mk("valid"), workdir: join(dir, "gone") };
    const e = parse({ prohibited_output: ["NOT_THERE"] });
    expect(evaluateControls(readControlsInput(r, e, config0), e).firstMismatch?.message).toBe("output: expected every source scanned, saw workspace missing");
  });

  it("fails when the logs folder is gone, without an evidence assertion", () => {
    const r = mk("valid");
    rmSync(join(r.runDir, "logs"), { recursive: true });
    const e = parse({ prohibited_output: ["NOT_THERE"] });
    expect(evaluateControls(readControlsInput(r, e, config0, { readWorkspace: noWorkspace }), e).firstMismatch?.message).toBe("output: expected every source scanned, saw logs missing");
  });

  it("fails when a log the manifest records is gone, without an evidence assertion", () => {
    const r = mk("missing-file");
    const e = parse({ prohibited_output: ["NOT_THERE"] });
    expect(evaluateControls(readControlsInput(r, e, config0, { readWorkspace: noWorkspace }), e).firstMismatch?.message).toBe("output: expected every source scanned, saw logs/002-run_tests.log missing");
  });

  it("treats an empty object as an empty field", () => {
    const verified = { status: "verified", verified: true } as never;
    const m = { git: {}, tests: [{}] } as never;
    expect(evaluateControls(input({ verify: verified, manifest: m }), parse({ evidence: { fields: ["git"] } })).firstMismatch?.message).toBe("evidence: expected field git, saw it empty");
    expect(evaluateControls(input({ verify: verified, manifest: m }), parse({ evidence: { fields: ["tests"] } })).ok).toBe(true);
  });
});

describe("summary and report text", () => {
  const res = (variant: string, ok: boolean, controls?: EvalResult["controls"]): EvalResult => ({
    variant, case: "c", attempt: 1, runId: "r", status: "succeeded", passed: ok && (controls?.ok ?? true), quality: ok, ...(controls ? { controls } : {}), costUsd: 0, tokens: 0, minutes: 0, fixLoops: 0,
  });
  const bad = { ok: false, policyOk: false, evidenceOk: true, firstMismatch: { kind: "policy" as const, expected: "deny", seen: "allow", message: "policy push: expected deny, saw allow" } };
  const good = { ok: true, policyOk: true, evidenceOk: true };
  it("has no controls key without controls, and the rates with them", () => {
    expect(summarize([res("a", true)])[0]).not.toHaveProperty("controls");
    const [s] = summarize([res("a", true, good), res("a", true, bad), res("a", true), res("a", true, { ...good, evidenceOk: false, ok: false })]);
    expect(s!.controls).toEqual({ runs: 3, okRate: 0.333, policyConformanceRate: 0.667, evidenceCompletenessRate: 0.667 });
    expect(s!.passRate).toBe(0.5);
    expect(s!.qualityRate).toBe(1);
  });
  it("prints a table and the first mismatch, or nothing", () => {
    const results = [res("a", true, bad)];
    expect(controlsReportText({ results: [res("a", true)], summary: summarize([res("a", true)]) })).toBe("");
    const text = controlsReportText({ results, summary: summarize(results) });
    expect(text).toContain("controls");
    expect(text).toContain("✘ a · c#1 · policy push: expected deny, saw allow");
  });
});
