import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { deniedReason } from "../src/engine/policy-hooks.js";
import { resumeRun, runFlow, type RunSummary } from "../src/engine/runner.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { verifyRunEvidence } from "../src/evidence/verify.js";
import { parseFlow } from "../src/flow/load.js";
import { runEvidenceView } from "../src/server/evidence-view.js";
import { coverPack, linkPack, writePack } from "./fixtures/policy-pack.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
let tmp: string;
let repo: string;
let runsDir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const cfg = (policy: Record<string, unknown>, extra: Record<string, unknown> = {}): Config => ConfigSchema.parse({ protected_branches: [], policy, ...extra });

beforeAll(() => {
  delete process.env.CODEX_API_KEY;
});
beforeEach(() => {
  rmSync(join(process.env.FACTORY_HOME!, "policies"), { recursive: true, force: true });
  tmp = mkdtempSync(join(tmpdir(), "fail-closed-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(process.env.FACTORY_HOME!, "policies"), { recursive: true, force: true });
});

const start = (yaml: string, config: Config, vars?: Record<string, string>) => runFlow(parseFlow(yaml), { task: "the task", repo, runsDir, claudeBin, config, ...(vars ? { vars } : {}) });
const events = (s: Pick<RunSummary, "runDir">): EvidenceEvent[] => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
type Decided = Extract<EvidenceEvent, { type: "policy.decided" }>;
const orgDecisions = (s: Pick<RunSummary, "runDir">): Decided[] => events(s).filter((e): e is Decided => e.type === "policy.decided" && e.decision.policy.id === "org");
const denied = (s: Pick<RunSummary, "runDir">) => events(s).filter((e): e is Extract<EvidenceEvent, { type: "step.denied" }> => e.type === "step.denied");
const live = (s: Pick<RunSummary, "runDir">) => readFileSync(join(s.runDir, "live.log"), "utf8");

const FAILURES: Array<[string, "policy.unavailable" | "policy.invalid", (id: string) => void]> = [
  ["missing", "policy.unavailable", () => {}],
  ["bad json", "policy.invalid", (id) => writePack(process.env.FACTORY_HOME!, id, "{ nope")],
  ["wrong id", "policy.invalid", (id) => writePack(process.env.FACTORY_HOME!, id, coverPack("other"))],
  ["a link", "policy.unavailable", (id) => linkPack(process.env.FACTORY_HOME!, id, join(tmp, "target.json"))],
];
const SHELL = `
name: one
workspace: inplace
steps:
  - {id: a, type: shell, run: "echo A > ran.txt", on_failure: b}
  - {id: b, type: shell, run: "echo B > b.txt"}
`;
const AGENT = `
name: one
workspace: inplace
steps:
  - {id: a, type: claude, prompt: "WRITE out.txt hi", on_failure: b}
  - {id: b, type: shell, run: "echo B > b.txt"}
`;
const STEPS: Array<[string, string, string]> = [["shell", SHELL, "ran.txt"], ["agent", AGENT, "out.txt"]];

describe("a mandatory policy that cannot be used", () => {
  for (const [what, code, setup] of FAILURES) {
    it.each(STEPS)(`${what}: denies the %s step`, async (kind, yaml, effect) => {
      // an agent step has no sign-in of its own, so it is stopped where it would write
      const boundary = kind === "agent" ? "agent.write" : "repository.access";
      setup("org");
      const s = await start(yaml, cfg({ mandatory: ["org"] }));
      const reason = deniedReason("org", code, boundary);
      expect(s.status).toBe("failed");
      expect(existsSync(join(repo, effect))).toBe(false);
      expect(existsSync(join(repo, "b.txt"))).toBe(false);
      expect(s.history.map((h) => h.id)).toEqual(["a"]);
      expect(s.history[0]).toMatchObject({ accessFailed: true, error: reason });
      expect(live(s)).toContain(`    ! ${reason}`);
      expect(live(s)).toMatch(/— enforced: the step is stopped$/m);
      const d = denied(s);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ step: { id: "a" }, denial: { kind: "policy", policy: { id: "org", version: "unknown" }, reasonCode: code } });
      const at = orgDecisions(s);
      expect(at.find((e) => e.decision.boundary === "run.start")?.decision.mode).toBe("observe");
      expect(at.find((e) => e.decision.boundary === boundary && e.step?.id === "a")?.decision).toMatchObject({ mode: "enforce", outcome: "deny", reasonCode: code });
      expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
    });
  }

  it("denies an agent step that is a child of a parallel step, and explains it in the evidence view", async () => {
    const s = await start(`
name: par
workspace: inplace
steps:
  - {id: both, type: parallel, steps: [w, other], on_failure: after}
  - {id: w, type: claude, prompt: "WRITE out.txt hi", jump_only: true}
  - {id: other, type: shell, run: "echo O > other.txt", jump_only: true}
  - {id: after, type: shell, run: "echo A > after.txt"}
`, cfg({ mandatory: ["org"] }));
    expect(s.status).toBe("failed");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
    expect(existsSync(join(repo, "after.txt"))).toBe(false);
    expect(denied(s).some((e) => e.step.id === "w")).toBe(true);
    const view = runEvidenceView(s, false).policyDecisions;
    expect(view.complete).toBe(true);
    expect(view.groups.some((g) => g.outcome === "deny" && g.mode === "enforce" && g.nextCode === "fix-mandatory" && g.policy.id === "org")).toBe(true);
    expect(JSON.stringify(view)).not.toContain("packSha256");
  });

  it("denies an agent step in a sub-flow", async () => {
    mkdirSync(join(repo, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(repo, ".claude-factory", "flows", "inner.yaml"), 'name: inner\nsteps:\n  - {id: w, type: claude, prompt: "WRITE out.txt hi"}\n');
    const s = await start("name: outer\nworkspace: inplace\nsteps:\n  - {id: build, type: flow, flow: inner}\n", cfg({ mandatory: ["org"] }));
    expect(s.status).toBe("failed");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
    expect(denied(s).some((e) => e.step.id === "w")).toBe(true);
  });

  it.each(STEPS)("fetches no bot token before the denial: %s", async (kind, yaml) => {
    delete process.env.FACTORY_TEST_NO_SUCH_TOKEN;
    const s = await start(yaml, cfg({ mandatory: ["org"] }, { bot: { gh_token_env: "FACTORY_TEST_NO_SUCH_TOKEN" } }));
    expect(s.status).toBe("failed");
    expect(s.history[0]).toMatchObject({ id: "a", accessFailed: true, error: deniedReason("org", "policy.unavailable", kind === "agent" ? "agent.write" : "repository.access") });
    expect(denied(s)).toHaveLength(1);
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
  });

  it("still fails before any step with a broken bot setup when every mandatory pack loads", async () => {
    delete process.env.FACTORY_TEST_NO_SUCH_TOKEN;
    const s = await start(SHELL, cfg({}, { bot: { gh_token_env: "FACTORY_TEST_NO_SUCH_TOKEN" } }));
    expect(s.status).toBe("failed");
    expect(s.history).toHaveLength(0);
  });

  it.each([["repositories"], ["packs"]])("never denies for the same failures in %s", async (where) => {
    const ids = FAILURES.map(([what, , setup], i) => {
      const id = `p${i}`;
      setup(id);
      return id;
    });
    const policy = where === "packs" ? { packs: ids } : { repositories: { "acme/app": ids } };
    const s = await start(SHELL, cfg(policy), where === "packs" ? undefined : { github_repo: "acme/app" });
    expect(s.status).toBe("succeeded");
    expect(existsSync(join(repo, "ran.txt"))).toBe(true);
    expect(denied(s)).toHaveLength(0);
  });

  it("asks the workspace and run start in observe, and denies the first credentialed step", async () => {
    const s = await start(`
name: wt
workspace: worktree
steps:
  - {id: a, type: shell, run: "echo A > ran.txt"}
`, cfg({ mandatory: ["org"] }));
    expect(s.status).toBe("failed");
    const at = orgDecisions(s);
    const modes = at.map((e) => `${e.decision.boundary}${e.step ? `:${e.step.id}` : ""}=${e.decision.mode}`);
    expect(modes).toContain("run.start=observe");
    expect(modes).toContain("repository.access=observe");
    expect(modes).toContain("repository.access:a=enforce");
    expect(s.history[0]).toMatchObject({ id: "a", accessFailed: true });
  });

  it("denies the use of an approval: no step.approved, and the next step does not run", async () => {
    const config = cfg({ mandatory: ["org"] });
    const flow = `
name: appr
workspace: inplace
steps:
  - {id: ok, type: approval, message: "go?"}
  - {id: after, type: shell, run: "echo X > after.txt"}
`;
    const w = await start(flow, config);
    expect(w.status).toBe("waiting");
    const r = await resumeRun({ runId: w.runId, runsDir, claudeBin, config, decision: { approved: true, by: "someone" } });
    expect(r.status).toBe("failed");
    expect(existsSync(join(repo, "after.txt"))).toBe(false);
    expect(r.history.map((h) => h.id)).not.toContain("after");
    expect(r.history.find((h) => h.id === "ok")?.error).toBe(deniedReason("org", "policy.unavailable", "approval.consume"));
    expect(events(r).some((e) => e.type === "step.approved")).toBe(false);
    expect(denied(r).filter((e) => e.denial.kind === "approval")).toHaveLength(0);
    const d = denied(r).filter((e) => e.denial.kind === "policy");
    expect(d).toHaveLength(1);
    expect(d[0]!.step.id).toBe("ok");
    expect(orgDecisions(r).find((e) => e.decision.boundary === "approval.consume")?.decision.mode).toBe("enforce");
    expect(verifyRunEvidence(r.runDir, r.runId).status).toBe("verified");
  });
});
