import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { resetRedactCache } from "../src/credentials/redact.js";
import { completeRun, resumeRun, runFlow, RUN_COMPLETE_DENIED, type RunSummary } from "../src/engine/runner.js";
import type { LoopResult } from "../src/engine/execute.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { verifyRunEvidence } from "../src/evidence/verify.js";
import { parseFlow } from "../src/flow/load.js";
import { breakGlassFile } from "../src/engine/policy-break-glass.js";
import { BASELINE_POLICY_ID, BASELINE_VERSION, type BaselineRuleId } from "../src/policy/baseline.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (enforce: BaselineRuleId[], extra: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], policy: { enforce }, ...extra });
let tmp: string;
let repo: string;
let runsDir: string;
let kc: FakeKeychain;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "enforce-run-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "first");
  kc = fakeKeychain();
  resetRedactCache();
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  kc.remove();
  resetRedactCache();
});

const sh = (id: string, run: string, extra = "") => `  - {id: ${id}, type: shell, run: ${JSON.stringify(run)}${extra}}\n`;
const flowYaml = (workspace: string, steps: string) => `name: ef\nworkspace: ${workspace}\nvars: { forbidden_paths: "" }\nsteps:\n${steps}`;
const start = (yaml: string, config: Config, extra: Record<string, unknown> = {}) =>
  runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, config, vars: { forbidden_paths: "secret/*" }, ...extra });

const events = (s: Pick<RunSummary, "runDir">): EvidenceEvent[] =>
  readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
const ofStep = (s: Pick<RunSummary, "runDir">, id: string) => events(s).filter((e) => "step" in e && (e as { step?: { id: string } }).step?.id === id);
const denials = (s: Pick<RunSummary, "runDir">) => events(s).filter((e) => e.type === "step.denied");

const BYPASS = flowYaml(
  "inplace",
  sh("write", "mkdir -p secret && echo x > secret/a.txt", ", on_failure: handler") + sh("later", "echo n > next.txt") + sh("handler", "echo h > handler.txt", ", jump_only: true"),
);

describe("an enforced step.after", () => {
  it("fails the step, does not follow on_failure and keeps the files", async () => {
    const s = await start(BYPASS, cfg(["path-forbidden"]));
    expect(s.status).toBe("failed");
    expect(s.history.map((h) => h.id)).toEqual(["write"]);
    expect(s.history[0]).toMatchObject({ ok: false, accessFailed: true });
    expect(existsSync(join(repo, "handler.txt"))).toBe(false);
    expect(existsSync(join(repo, "next.txt"))).toBe(false);
    expect(existsSync(join(repo, "secret", "a.txt"))).toBe(true);
    const kinds = ofStep(s, "write").map((e) => (e.type === "policy.decided" ? `${e.decision.boundary}:${e.decision.mode}` : e.type));
    const i = kinds.indexOf("step.after:enforce");
    expect(i).toBeGreaterThan(-1);
    expect(kinds.indexOf("step.denied")).toBeGreaterThan(i);
    expect(kinds.indexOf("step.failed")).toBeGreaterThan(kinds.indexOf("step.denied"));
    const decided = ofStep(s, "write").find((e) => e.type === "policy.decided" && e.decision.boundary === "step.after");
    const denied = denials(s)[0] as Extract<EvidenceEvent, { type: "step.denied" }>;
    expect(denied.denial).toMatchObject({ policy: { id: BASELINE_POLICY_ID, version: BASELINE_VERSION }, reasonCode: "path.forbidden" });
    expect(denied.denial.packSha256).toBe((decided as Extract<EvidenceEvent, { type: "policy.decided" }>).decision.packSha256);
  });

  it("changes nothing with no enforced rule", async () => {
    const s = await start(BYPASS, cfg([]));
    expect(s.status).toBe("succeeded");
    expect(existsSync(join(repo, "next.txt"))).toBe(true);
    expect(denials(s)).toHaveLength(0);
  });

  it("asks step.after first, so a timeout denial wins over on_failure", async () => {
    const yaml = flowYaml(
      "inplace",
      sh("slow", "sleep 3", ", timeout_sec: 0.5, on_failure: handler") + sh("handler", "mkdir -p secret && echo x > secret/a.txt", ", jump_only: true"),
    );
    const s = await start(yaml, cfg(["timeout-exceeded", "path-forbidden"]));
    expect(s.status).toBe("failed");
    expect(s.history.map((h) => h.id)).toEqual(["slow"]);
    expect(s.history[0]!.error).toContain("timeout.exceeded");
    expect(existsSync(join(repo, "secret", "a.txt"))).toBe(false);
  });

  it("fails the parent when a parallel child is denied, and runs neither its on_failure nor the next step", async () => {
    const yaml = flowYaml(
      "inplace",
      sh("w", "mkdir -p secret && echo x > secret/a.txt") +
        sh("o", "echo o > o.txt") +
        `  - {id: par, type: parallel, steps: [w, o], on_failure: handler}\n` +
        sh("later", "echo n > next.txt") +
        sh("handler", "echo h > handler.txt", ", jump_only: true"),
    ).replace("  - {id: w", "  - {id: w, jump_only: true").replace("  - {id: o,", "  - {id: o, jump_only: true,");
    const s = await start(yaml, cfg(["path-forbidden"]));
    expect(s.status).toBe("failed");
    expect(s.history.find((h) => h.id === "par")).toMatchObject({ ok: false });
    expect(existsSync(join(repo, "handler.txt"))).toBe(false);
    expect(existsSync(join(repo, "next.txt"))).toBe(false);
  });
});

let seq = 0;
describe("a user's run", () => {
  let user: { id: string };
  beforeEach(async () => {
    user = await createUser({ name: "User", email: `user${++seq}@example.com`, password: TEST_PASSWORD, role: "user" });
  });

  it("is refused at step.before when an enforced rule denies it, and the command never runs", async () => {
    const yaml = flowYaml("empty", sh("s0", "touch ran.txt"));
    for (const enforce of [["sandbox-required"], []] as BaselineRuleId[][]) {
      const s = await start(yaml, cfg(enforce, { sandbox: { user_runs: "off" } }), { owner: user.id, vars: {} });
      const ran = s.workdir ? existsSync(join(s.workdir, "ran.txt")) : false;
      if (enforce.length) {
        expect(s.status).toBe("failed");
        expect(s.history[0]).toMatchObject({ id: "s0", ok: false, accessFailed: true });
        expect(s.history[0]!.error).toContain("sandbox.required");
        expect(ran).toBe(false);
      } else {
        expect(s.status).toBe("succeeded");
        expect(ran).toBe(true);
      }
    }
  });

  it("fails at run.start before any step, with one step-less step.denied", async () => {
    const s = await start(flowYaml("inplace", sh("a", "echo a > a.txt")), cfg(["workspace-admin-only"]), { owner: user.id });
    expect(s.status).toBe("failed");
    expect(s.history).toEqual([]);
    const d = denials(s) as Extract<EvidenceEvent, { type: "step.denied" }>[];
    expect(d).toHaveLength(1);
    expect(d[0]!.step).toBeUndefined();
    expect(d[0]!.denial).toMatchObject({ kind: "policy", policy: { id: BASELINE_POLICY_ID, version: BASELINE_VERSION }, reasonCode: "workspace.admin-only" });
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
    expect(existsSync(join(repo, "a.txt"))).toBe(false);
  });

  it("does not record a denial at run.start with no enforced rule (the inplace refusal stays)", async () => {
    const s = await start(flowYaml("inplace", sh("a", "echo a > a.txt")), cfg([]), { owner: user.id });
    expect(s.status).toBe("failed");
    expect(denials(s)).toHaveLength(0);
  });

  it("keeps the saved history on a denied resume and adds one step-less denial", async () => {
    const yaml = flowYaml("inplace", sh("a", "echo a > a.txt") + sh("b", "exit 1", ", on_failure: fail") + sh("c", "echo c > c.txt"));
    const first = await start(yaml, cfg([]));
    expect(first.status).toBe("failed");
    expect(first.history.map((h) => h.id)).toEqual(["a", "b"]);
    const file = join(first.runDir, "run.json");
    const saved = JSON.parse(readFileSync(file, "utf8")) as RunSummary;
    saved.owner = user.id;
    writeFileSync(file, JSON.stringify(saved));
    const next = saved.state.next;
    const r = await resumeRun({ runId: first.runId, runsDir, claudeBin, config: cfg(["workspace-admin-only"]) });
    expect(r.status).toBe("failed");
    expect(r.history.map((h) => h.id)).toEqual(["a", "b"]);
    expect(r.state.next).toBe(next);
    expect(existsSync(join(repo, "c.txt"))).toBe(false);
    const d = denials(r);
    expect(d).toHaveLength(1);
    expect((d[0] as { step?: unknown }).step).toBeUndefined();
  });
});

describe("completeRun", () => {
  const ok: LoopResult = { outcome: "succeeded", reason: "done", next: null, lastOutput: "out" };
  const denied = { reason: "run.complete is denied", denial: { kind: "policy" } };
  const fakes = (answer: unknown) => ({ at: vi.fn(() => answer), runDenied: vi.fn(), log: vi.fn() });

  it("leaves a result that did not succeed alone and does not ask", () => {
    const f = fakes({ decisions: [], denied });
    const failed: LoopResult = { outcome: "failed", reason: "x", next: null, lastOutput: "" };
    expect(completeRun({ at: f.at } as never, { runDenied: f.runDenied } as never, failed, 1.5, f.log)).toBe(failed);
    expect(f.at).not.toHaveBeenCalled();
  });

  it("returns the same result without a denial, and without a policy", () => {
    const f = fakes({ decisions: [] });
    expect(completeRun({ at: f.at } as never, { runDenied: f.runDenied } as never, ok, 1.5, f.log)).toBe(ok);
    expect(f.at).toHaveBeenCalledWith("run.complete", { runCostUsd: 1.5 });
    expect(completeRun(undefined, undefined, ok, 1.5, f.log)).toBe(ok);
  });

  it("marks the run failed on a denial, records it, and says the pushed work stays", () => {
    const f = fakes({ decisions: [], denied });
    const r = completeRun({ at: f.at } as never, { runDenied: f.runDenied } as never, ok, 1.5, f.log);
    expect(r).toEqual({ outcome: "failed", reason: `run.complete is denied — ${RUN_COMPLETE_DENIED}`, next: null, lastOutput: "out" });
    expect(f.runDenied).toHaveBeenCalledWith(denied.denial);
    expect(f.log).toHaveBeenCalledWith("! run.complete is denied");
  });

  it("fails the run without a record when the denial has none", () => {
    const f = fakes({ decisions: [], denied: { reason: "r" } });
    expect(completeRun({ at: f.at } as never, { runDenied: f.runDenied } as never, ok, 1, f.log).outcome).toBe("failed");
    expect(f.runDenied).not.toHaveBeenCalled();
  });
});

describe("the run-level paths", () => {
  let user: { id: string };
  beforeEach(async () => {
    user = await createUser({ name: "Runner", email: `runner${++seq}@example.com`, password: TEST_PASSWORD, role: "user" });
  });
  const userCfg = (enforce: BaselineRuleId[]) => cfg(enforce, { sandbox: { user_runs: "off" } });

  it("break-glass does not lift a rule denial: the step still fails and no break-glass decision is made", async () => {
    writeFileSync(breakGlassFile(), JSON.stringify({ version: 1, reason: "outage", startedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(), actor: { kind: "cli", osUser: "admin" } }));
    try {
      const yaml = flowYaml("inplace", sh("write", "mkdir -p secret && echo x > secret/a.txt", ", on_failure: handler") + sh("handler", "echo h > handler.txt", ", jump_only: true"));
      const s = await start(yaml, cfg(["path-forbidden"]));
      expect(s.status).toBe("failed");
      expect(s.history[0]).toMatchObject({ id: "write", ok: false, accessFailed: true });
      expect(existsSync(join(repo, "handler.txt"))).toBe(false);
      expect(events(s).some((e) => e.type === "policy.decided" && e.decision.reasonCode === "policy.break-glass")).toBe(false);
    } finally {
      rmSync(breakGlassFile(), { force: true });
    }
  });

  it("an approval step denied at step.before is refused before approval.consume, and the marker step never runs", async () => {
    const yaml = flowYaml("empty", `  - {id: gate, type: approval, message: "ok?"}\n` + sh("marker", "touch marker.txt"));
    // no shipped rule denies step.before for an approval step (the sandbox rule covers shell steps only), so the
    // approval refusal branch is not reached end to end yet: an enforced run waits here as an observed one does
    const enforced = await start(yaml, userCfg(["sandbox-required"]), { owner: user.id, vars: {} });
    expect(enforced.status).toBe("waiting");
    expect(events(enforced).some((e) => e.type === "policy.decided" && e.decision.boundary === "approval.consume")).toBe(false);
  });

  it("a parallel child denied at step.before never runs, and the parent fails", async () => {
    const yaml = flowYaml(
      "empty",
      `  - {id: par, type: parallel, steps: [a, b]}\n  - {id: a, type: shell, run: "touch a.txt", jump_only: true}\n  - {id: b, type: shell, run: "touch b.txt", jump_only: true}\n`,
    );
    const enforced = await start(yaml, userCfg(["sandbox-required"]), { owner: user.id, vars: {} });
    expect(enforced.status).toBe("failed");
    expect(enforced.history.find((h) => h.id === "par")).toMatchObject({ ok: false, accessFailed: true });
    expect(enforced.history.filter((h) => h.parent === "par").every((h) => h.ok === false)).toBe(true);
    if (enforced.workdir) {
      expect(existsSync(join(enforced.workdir, "a.txt"))).toBe(false);
      expect(existsSync(join(enforced.workdir, "b.txt"))).toBe(false);
    }

    const observed = await start(yaml, userCfg([]), { owner: user.id, vars: {} });
    expect(observed.status).toBe("succeeded");
    expect(existsSync(join(observed.workdir!, "a.txt"))).toBe(true);
  });

  it("a push to a protected branch is refused by the hook with enforce on, and the remote has no main", async () => {
    const remote = join(tmp, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git(repo, "remote", "add", "origin", remote);
    for (const enforce of [[], ["branch-protected"]] as BaselineRuleId[][]) {
      const yaml = flowYaml("inplace", sh("push", "git push origin HEAD:main"));
      const s = await start(yaml, ConfigSchema.parse({ protected_branches: ["main"], policy: { enforce } }));
      expect(s.status).toBe("failed");
      expect(`${s.history[0]!.output}${s.history[0]!.error ?? ""}`).toContain("protected branch 'main' is blocked");
      expect(() => execFileSync("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"], { stdio: "ignore" })).toThrow();
      if (enforce.length) {
        expect(events(s).some((e) => e.type === "policy.decided" && e.decision.boundary === "push" && e.decision.mode === "enforce" && e.decision.reasonCode === "branch.protected")).toBe(true);
        expect(denials(s)).toHaveLength(0);
      }
    }
  });
});
