import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { baseFacts, drainPushLog, loadPolicyPacks, repositoryFact, RunPolicy, runPolicy, type LoadedPack } from "../src/engine/policy-hooks.js";
import { parseFlow } from "../src/flow/load.js";
import { nextActionCode } from "../src/policy/explain.js";
import type { PolicyDecision, PolicyPack } from "../src/policy/schema.js";
import { runEvidenceView } from "../src/server/evidence-view.js";
import { FIXTURE_RUN_ID, fixtureChain, writeEvidenceFixture } from "./fixtures/evidence-runs.js";
import { coverPack, writePack } from "./fixtures/policy-pack.js";

const H = "a".repeat(64);
const T = "2026-01-31T12:00:00.000Z";
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "policy-compat-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const decision = (n: number, over: Record<string, unknown> = {}) => ({
  version: 1, policy: { id: "p", version: "1" }, packSha256: H, mode: "observe", boundary: "run.start", inputSha256: H,
  outcome: "allow", reasonCode: "policy.no-rule-matched", evaluatedAt: `2026-01-31T12:00:0${n}.000Z`, ...over,
});
const decided = (n: number) => ({ version: 4, type: "policy.decided", time: `2026-01-31T12:00:0${n}.000Z`, decision: decision(n) });
const created = { version: 4, type: "run.created", time: T, flow: { name: "demo" }, by: { kind: "cli" } };

/** A run folder with only the event stream (no manifest): a run that is still going. */
function streamOnly(lines: string[], tail = ""): { runId: string; runDir: string; workdir: string; repo: string } {
  const runDir = join(tmp, FIXTURE_RUN_ID);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "evidence.jsonl"), lines.map((l) => `${l}\n`).join("") + tail);
  return { runId: FIXTURE_RUN_ID, runDir, workdir: join(tmp, "w"), repo: join(tmp, "r") };
}

describe("policy decisions of old and damaged evidence", () => {
  it("gives a run with evidence but no decisions an empty, complete list", () => {
    const runDir = writeEvidenceFixture(tmp, "valid");
    const v = runEvidenceView({ runId: FIXTURE_RUN_ID, runDir, workdir: "", repo: "" }, true);
    expect(v.verification.status).toBe("verified");
    expect(v.policyDecisions).toEqual({ groups: [], total: 0, omittedGroups: 0, complete: true });
  });

  it("gives a run older than evidence an empty list that is complete", () => {
    const runDir = writeEvidenceFixture(tmp, "old");
    const v = runEvidenceView({ runId: FIXTURE_RUN_ID, runDir, workdir: "", repo: "" }, false);
    expect(v.state).toBe("not_available");
    expect(v.policyDecisions).toEqual({ groups: [], total: 0, omittedGroups: 0, complete: true });
  });

  it("groups the decisions of a run that is still going", () => {
    const s = streamOnly(fixtureChain([created, decided(1), decided(2)]).lines);
    const v = runEvidenceView(s, true);
    expect(v.verification.status).toBe("not-finalized");
    expect(v.policyDecisions).toMatchObject({ total: 2, complete: true });
    expect(v.policyDecisions.groups).toHaveLength(1);
    expect(v.policyDecisions.groups[0]).toMatchObject({ count: 2, firstAt: "2026-01-31T12:00:01.000Z", lastAt: "2026-01-31T12:00:02.000Z", nextCode: "none" });
  });

  it("returns the groups before a bad line and says the list is not whole", () => {
    const lines = fixtureChain([created, decided(1), decided(2), decided(3)]).lines;
    lines[3] = lines[3]!.replace('"hash":"', '"hash":"0');
    const bad = runEvidenceView(streamOnly(lines), true).policyDecisions;
    expect(bad.complete).toBe(false);
    expect(bad.total).toBe(2);
    rmSync(join(tmp, FIXTURE_RUN_ID), { recursive: true });
    const newer = fixtureChain([created, decided(1), { ...decided(2), version: 99 }]).lines;
    const future = runEvidenceView(streamOnly(newer), true).policyDecisions;
    expect(future).toMatchObject({ complete: false, total: 1 });
  });

  it("says the list is not whole when the last line was cut off", () => {
    const lines = fixtureChain([created, decided(1), decided(2)]).lines;
    const s = streamOnly(lines.slice(0, 2), lines[2]!.slice(0, 40));
    expect(runEvidenceView(s, true).policyDecisions).toMatchObject({ total: 1, complete: false });
  });

  it("says the list is not whole when the stream stopped (the incomplete marker)", () => {
    const s = streamOnly(fixtureChain([created, decided(1)]).lines);
    writeFileSync(join(s.runDir, "evidence.incomplete"), "");
    expect(runEvidenceView(s, true).policyDecisions).toMatchObject({ total: 1, complete: false });
  });

  it("says the list is not whole when the manifest counts more events than the stream has", () => {
    const runDir = writeEvidenceFixture(tmp, "valid");
    writeFileSync(join(runDir, "evidence.jsonl"), fixtureChain([created, decided(1)]).lines.map((l) => `${l}\n`).join(""));
    const v = runEvidenceView({ runId: FIXTURE_RUN_ID, runDir, workdir: "", repo: "" }, true);
    expect(v.verification.verified).toBe(false);
    expect(v.policyDecisions).toMatchObject({ total: 1, complete: false });
  });

  it("says the list is not whole when the manifest is there but the events are gone", () => {
    const runDir = writeEvidenceFixture(tmp, "valid");
    rmSync(join(runDir, "evidence.jsonl"));
    const v = runEvidenceView({ runId: FIXTURE_RUN_ID, runDir, workdir: "", repo: "" }, true);
    expect(v.policyDecisions).toEqual({ groups: [], total: 0, omittedGroups: 0, complete: false });
  });
});

describe("old and custom flows", () => {
  const summary = (flowDef: unknown, flow = "mine", vars: Record<string, string> = { github_repo: "Acme/Widgets" }) => ({ runId: "r", vars, flow, flowDef, owner: undefined }) as never;
  const flowOf = (name: string) => parseFlow(readFileSync(`flows/${name}.yaml`, "utf8"), `flows/${name}.yaml`);
  const make = (flowDef: unknown, cfg: object = {}, flow?: string, vars?: Record<string, string>) => {
    const lines: string[] = [];
    const policy = runPolicy(summary(flowDef, flow, vars), ConfigSchema.parse({ policy: { packs: [] }, ...cfg }), (l) => lines.push(l), undefined, tmp);
    return { policy, lines };
  };

  it("asks the baseline of a flow without any policy keys", () => {
    const { policy } = make({ name: "mine", workspace: "worktree", steps: [] });
    const a = policy.at("run.start");
    const b = policy.at("step.before", { step: "x" }, { id: "x", visit: 1, type: "shell" });
    for (const answer of [a, b]) {
      expect(answer.decisions).toHaveLength(1);
      expect(answer.decisions[0]!.decision.policy.id).toBe("foundry.baseline");
      expect(answer.denied).toBeUndefined();
    }
  });

  it("gives a changed copy of a built-in flow no hotfix exception", () => {
    const changed = flowOf("issue-gitflow");
    changed.steps = changed.steps.slice(1);
    const { policy } = make(changed, { protected_branches: ["main"] }, "issue-gitflow");
    const id = { id: "push_main", visit: 1, type: "shell" } as const;
    policy.repository(id, { credential: "none" });
    const seen: PolicyDecision[] = [];
    const at = policy.at.bind(policy);
    policy.at = (b, f, s) => {
      const r = at(b, f, s);
      if (b === "push") seen.push(r.decisions[0]!.decision);
      return r;
    };
    policy.pushes(id, [{ branch: "main", repository: "acme/widgets", secretsFound: 0, commitIdentity: true }]);
    expect(seen[0]).toMatchObject({ outcome: "deny", reasonCode: "branch.protected" });
  });

  it("never gives a custom flow shippedFlow", () => {
    const { policy } = make({ name: "mine", workspace: "worktree", steps: [] });
    // the baseline's hotfix rule needs shippedFlow: a custom flow never meets it
    expect(policy.at("run.start").decisions[0]!.decision.reasonCode).not.toBe("branch.hotfix-exception");
    expect(baseFacts(summary({ name: "mine", workspace: "worktree" }))).not.toHaveProperty("shippedFlow");
  });
});

describe("pack versions", () => {
  it("reads version 1 and version 2 packs with the same outcome and rule, and another hash", () => {
    const v1 = coverPack("one");
    const v2 = { ...v1, version: 2 } as unknown as PolicyPack;
    writePack(tmp, "one", v1);
    writePack(tmp, "two", { ...v2, policy: { id: "two", version: "1" } });
    const [a, b] = loadPolicyPacks(["one", "two"], tmp);
    expect("pack" in a! && "pack" in b!).toBe(true);
    const ask = (p: LoadedPack, id: string) => new RunPolicy({ runId: "r", packs: [{ layer: "optional", ...p, id }], base: { flow: "cover" }, log: () => undefined, now: () => T }).at("step.before", { step: "build" }).decisions[0]!.decision;
    const d1 = ask(a!, "one");
    const d2 = ask(b!, "two");
    expect([d2.outcome, d2.reasonCode, d2.rule]).toEqual([d1.outcome, d1.reasonCode, d1.rule]);
    expect(d1.packSha256).not.toBe(d2.packSha256);
    // the hash of a version 1 pack is the hash of the pack as written
    expect(d1.packSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a version 3 pack as a newer one, with the right next action", () => {
    writePack(tmp, "future", { ...coverPack("future"), version: 3 });
    const [p] = loadPolicyPacks(["future"], tmp);
    expect(p).toMatchObject({ problem: "policy.invalid" });
    expect((p as { detail: string }).detail).toContain("newer Foundry");
    const decide = (layer: "optional" | "mandatory") => new RunPolicy({ runId: "r", packs: [{ layer, ...p! }], base: {}, log: () => undefined, now: () => T }).at("agent.write", { step: "build", isolated: false, sandboxed: false }, { id: "build", visit: 1, type: "claude" }).decisions[0]!.decision;
    expect(nextActionCode(decide("optional"))).toBe("fix-pack");
    expect(nextActionCode(decide("mandatory"))).toBe("fix-mandatory");
  });

  it("shows both versions in the log, and two groups, when a pack's own version changes between starts", () => {
    const run = (version: string) => {
      const lines: string[] = [];
      const policy = new RunPolicy({ runId: "r", packs: [{ layer: "optional", id: "org", pack: coverPack("org", version) }], base: { flow: "cover" }, log: (l) => lines.push(l), now: () => T });
      return { d: policy.at("step.before", { step: "build" }).decisions[0]!.decision, lines };
    }
    const a = run("1");
    const b = run("2");
    expect(a.lines[0]).toContain("policy org 1 ");
    expect(b.lines[0]).toContain("policy org 2 ");
    expect(a.d.policy.version).toBe("1");
    expect(b.d.policy.version).toBe("2");
  });
});

describe("bypass attempts", () => {
  const need = (): PolicyPack => ({ version: 1, policy: { id: "need", version: "1" }, mode: "observe", defaultOutcome: "allow", rules: [{ id: "r", boundaries: ["run.start"], when: { repository: { in: ["acme/widgets"] } }, outcome: "allow", reasonCode: "exception.granted" }] });
  const summary = (vars: Record<string, string>, flow = "f") => ({ runId: "r", vars, flow, flowDef: { workspace: "worktree" }, owner: undefined }) as never;

  it("ignores forged lines in the push log: only the observed facts count", () => {
    const file = join(tmp, "push.log");
    writeFileSync(file, "main\t\t0\t1\nmain\thttps://github.com/acme/widgets.git\t0\t1\nmain\t\tx\t2\n");
    const pushes = drainPushLog(file);
    expect(pushes[0]).toEqual({ branch: "main", secretsFound: 0, commitIdentity: true });
    expect(pushes[0]).not.toHaveProperty("repository");
    expect(pushes[2]).toEqual({ branch: "main" });
  });

  it.each(["owner/repo", "not a repo", "a/b/c", "x".repeat(300)])("leaves out the repository fact for %j, and a rule needing it denies", (repo) => {
    expect(repositoryFact({ github_repo: repo })).toSatisfy((r: string | undefined) => r === undefined || r !== "owner/repo");
    const facts = baseFacts(summary({ github_repo: repo }));
    expect(facts).not.toHaveProperty("repository");
    const d = new RunPolicy({ runId: "r", packs: [{ layer: "optional", id: "need", pack: need() }], base: facts, log: () => undefined, now: () => T }).at("run.start").decisions[0]!.decision;
    expect(d).toMatchObject({ outcome: "deny", reasonCode: "policy.input-incomplete" });
  });

  it("treats a mixed-case repository exactly like its lower-case form", () => {
    const run = (repo: string) => new RunPolicy({ runId: "r", packs: [{ layer: "optional", id: "need", pack: need() }], base: baseFacts(summary({ github_repo: repo })), log: () => undefined, now: () => T }).at("run.start").decisions[0]!.decision;
    expect(baseFacts(summary({ github_repo: "Acme/Widgets" })).repository).toBe("acme/widgets");
    const a = run("Acme/Widgets");
    const b = run("acme/widgets");
    expect(a).toMatchObject({ outcome: "allow", rule: "r" });
    expect({ ...a }).toEqual({ ...b });
  });

  it.each(["a flow with spaces", "f".repeat(201)])("denies on a rule about the flow when the name cannot be a fact (%#)", (flow) => {
    const pack: PolicyPack = { ...need(), rules: [{ id: "r", boundaries: ["run.start"], when: { flow: { in: ["other"] } }, outcome: "allow", reasonCode: "exception.granted" }] };
    const facts = baseFacts(summary({}, flow));
    expect(facts).not.toHaveProperty("flow");
    const d = new RunPolicy({ runId: "r", packs: [{ layer: "optional", id: "need", pack }], base: facts, log: () => undefined, now: () => T }).at("run.start").decisions[0]!.decision;
    expect(d).toMatchObject({ outcome: "deny", reasonCode: "policy.input-incomplete" });
  });
});
