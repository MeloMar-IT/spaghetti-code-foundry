import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { redactedJson, resetRedactCache } from "../src/credentials/redact.js";
import { addCredential } from "../src/credentials/store.js";
import { runFlow, type RunSummary } from "../src/engine/runner.js";
import { parseFlow } from "../src/flow/load.js";
import { runEvidenceView } from "../src/server/evidence-view.js";
import { findRule } from "../src/server/permissions.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";

const SECRET = "tok-Hq4zNw8rTb6yUc1e";
let home: string;
let saved: string | undefined;
let kc: FakeKeychain;
let repo: string;
let runsDir: string;

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  home = mkdtempSync(join(tmpdir(), "evidence-api-"));
  process.env.FACTORY_HOME = home;
  kc = fakeKeychain();
  resetRedactCache();
  repo = join(home, "repo");
  runsDir = join(home, "runs");
  mkdirSync(repo);
});
afterEach(() => {
  kc.remove();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  resetRedactCache();
  rmSync(home, { recursive: true, force: true });
});

const config = ConfigSchema.parse({ protected_branches: [] });
const run = (yaml: string, task = "") => runFlow(parseFlow(yaml), { task, repo, runsDir, config });
const DONE = `name: done\nworkspace: inplace\nsteps:\n  - {id: a, type: shell, run: "echo ${SECRET}"}\n  - {id: ok, type: approval, message: "go?"}\n`;
const PLAIN = `name: plain\nworkspace: inplace\nsteps:\n  - {id: run_tests, type: shell, run: "echo fine"}\n`;
const EVIDENCE = ["evidence.json", "evidence.jsonl", "evidence.diff", "evidence.incomplete"];
/** What the route sends: the view as JSON, through the same filter as every answer of the API. */
const sent = (s: RunSummary, admin: boolean) => redactedJson(runEvidenceView(s, admin))!;

describe("GET /api/runs/:id/evidence", () => {
  it("has a rule: a user reads the evidence of their own runs only", () => {
    expect(findRule("GET", ["runs", "a", "evidence"])).toMatchObject({ path: "runs/:id/evidence", user: "own" });
    expect(findRule("POST", ["runs", "a", "evidence"])).toBeUndefined();
    expect(findRule("GET", ["runs", "a", "evidence", "evidence.diff"])).toBeUndefined();
  });

  it("answers the manifest, the verification and the file references of a run that ended", async () => {
    const s = await run(PLAIN);
    const v = runEvidenceView(s, true);
    expect(v).toMatchObject({ runId: s.runId, state: "available", verification: { status: "verified", verified: true, missingOptional: [] }, manifest: { version: 1, runId: s.runId, status: "succeeded", flow: { name: "plain" }, events: { path: "evidence.jsonl" } } });
    expect(v.reason).toBeUndefined();
    expect(v.verification.checks.every((c) => c.state === "passed")).toBe(true);
    expect(v.artifacts.length).toBeGreaterThan(0);
    for (const a of v.artifacts) {
      expect(Object.keys(a).sort()).toEqual(["bytes", "kind", "path", "required", "sha256", "state"]);
      expect(a.state).toBe("ok");
      expect(a.path.startsWith("/")).toBe(false);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(Object.keys(v).sort()).toEqual(["artifacts", "manifest", "policyDecisions", "runId", "state", "verification"]);
  });

  it("gives a user no models, no policies, no account ids and no folder of the machine", async () => {
    const s = await run(PLAIN);
    // a manifest as a run with an agent step and an approval has it
    const file = join(s.runDir, "evidence.json");
    const account = randomUUID();
    const m = JSON.parse(readFileSync(file, "utf8"));
    m.models = [{ agent: "claude", provider: "anthropic", model: "some-model" }];
    m.approvals = [{ step: { id: "ok", visit: 1, type: "approval" }, time: m.finishedAt, decision: "approved", by: { kind: "user", id: account } }];
    writeFileSync(file, JSON.stringify(m));
    const admin = runEvidenceView(s, true);
    expect(admin.state).toBe("available");
    expect(admin.manifest?.models).toHaveLength(1);
    expect(admin.manifest?.approvals[0]?.by).toEqual({ kind: "user", id: account });
    const user = runEvidenceView(s, false);
    expect(user.state).toBe("available");
    expect(user.manifest).not.toHaveProperty("models");
    expect(user.manifest).not.toHaveProperty("policies");
    expect(user.manifest?.approvals).toEqual([{ step: { id: "ok", visit: 1, type: "approval" }, time: m.finishedAt, decision: "approved", by: { kind: "user" } }]);
    const text = sent(s, false);
    for (const hidden of [account, "some-model", home, s.runDir, repo]) expect(text).not.toContain(hidden);
  });

  it("lists the policy decisions as groups: admins get the rule and the pack hash, users do not", async () => {
    const s = await run(PLAIN);
    const admin = runEvidenceView(s, true).policyDecisions;
    const user = runEvidenceView(s, false).policyDecisions;
    expect(admin.complete).toBe(true);
    expect(admin.total).toBeGreaterThan(0);
    expect(admin.groups.length).toBeGreaterThan(0);
    expect(admin.groups.every((g) => g.policy.id === "foundry.baseline" && g.packSha256 !== undefined)).toBe(true);
    expect(admin.groups.reduce((n, g) => n + g.count, 0) + admin.omittedGroups).toBeGreaterThanOrEqual(admin.total);
    expect(user.total).toBe(admin.total);
    expect(user.groups.length).toBeLessThanOrEqual(admin.groups.length);
    for (const g of user.groups) {
      expect(g).not.toHaveProperty("rule");
      expect(g).not.toHaveProperty("packSha256");
      expect(g.reason.length).toBeGreaterThan(0);
      expect(g.next.length).toBeGreaterThan(0);
    }
    expect(sent(s, false)).not.toContain('"rule"');
    expect(sent(s, false)).not.toContain("packSha256");
  });

  it("answers an empty, complete list for a run older than evidence, and an incomplete one when the events are gone", async () => {
    const old = await run(PLAIN);
    for (const n of EVIDENCE) rmSync(join(old.runDir, n), { force: true });
    expect(runEvidenceView(old, true).policyDecisions).toEqual({ groups: [], total: 0, omittedGroups: 0, complete: true });
    const lost = await run(PLAIN);
    rmSync(join(lost.runDir, "evidence.jsonl"));
    expect(runEvidenceView(lost, true).policyDecisions).toEqual({ groups: [], total: 0, omittedGroups: 0, complete: false });
  });

  it("never holds a stored secret, the task or the output of a step", async () => {
    addCredential({ userId: randomUUID(), type: "token", name: "t", secret: SECRET }, { ownerOk: () => true });
    resetRedactCache();
    const s = await run(PLAIN.replace("echo fine", `echo out-${SECRET}`), `the task ${SECRET}`);
    for (const admin of [true, false]) {
      const text = sent(s, admin);
      expect(text).toContain('"state":"available"');
      for (const hidden of [SECRET, "the task", "out-"]) expect(text).not.toContain(hidden);
    }
  });

  it("says not_available for a run made before evidence existed, with a reason, and does not fail", async () => {
    const s = await run(PLAIN);
    for (const n of EVIDENCE) rmSync(join(s.runDir, n), { force: true });
    for (const admin of [true, false]) {
      const v = runEvidenceView(s, admin);
      expect(v).toMatchObject({ runId: s.runId, state: "not_available", verification: { status: "absent", verified: false }, artifacts: [] });
      expect(v.reason).toContain("This run has no evidence");
      expect(v.manifest).toBeUndefined();
    }
  });

  it("says not_available for a run that has not ended, for a manifest that cannot be read, and for a folder that is gone", async () => {
    const waiting = await run(DONE);
    expect(waiting.status).toBe("waiting");
    expect(runEvidenceView(waiting, false)).toMatchObject({ state: "not_available", verification: { status: "not-finalized", verified: false } });

    const s = await run(PLAIN);
    writeFileSync(join(s.runDir, "evidence.json"), "{ not a manifest");
    const broken = runEvidenceView(s, false);
    expect(broken).toMatchObject({ state: "not_available", verification: { verified: false } });
    expect(broken.manifest).toBeUndefined();
    expect(JSON.stringify(broken)).not.toContain(home);

    rmSync(s.runDir, { recursive: true, force: true });
    expect(() => runEvidenceView(s, false)).not.toThrow();
    expect(runEvidenceView(s, false).state).toBe("not_available");
  });

  it("does not take the manifest of another run, and reports a changed file as not verified", async () => {
    const a = await run(PLAIN);
    const b = await run(PLAIN);
    writeFileSync(join(b.runDir, "evidence.json"), readFileSync(join(a.runDir, "evidence.json")));
    const copied = runEvidenceView(b, true);
    expect(copied.state).toBe("not_available");
    expect(copied.manifest).toBeUndefined();
    expect(copied.verification.verified).toBe(false);

    const required = runEvidenceView(a, true).artifacts.find((f) => f.required)!;
    writeFileSync(join(a.runDir, required.path), "changed");
    const changed = runEvidenceView(a, true);
    expect(changed).toMatchObject({ state: "available", verification: { status: "failed", verified: false } });
    expect(changed.artifacts.find((f) => f.path === required.path)?.state).toBe("changed");
  });
});
