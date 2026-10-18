import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { resumeRun, runFlow, type RunSummary } from "../src/engine/runner.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { verifyRunEvidence } from "../src/evidence/verify.js";
import { loadFlow, parseFlow } from "../src/flow/load.js";
import { BOUNDARIES, type Boundary } from "../src/policy/schema.js";
import { checkRule, coverPack, okRule, writePack } from "./fixtures/policy-pack.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (packs: string[] = ["cover"]): Config => ConfigSchema.parse({ protected_branches: [], policy: { packs } });
let tmp: string;
let repo: string;
let runsDir: string;
let remote: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeAll(() => {
  process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
  delete process.env.CODEX_API_KEY;
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hooks-run-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first");
  remote = join(tmp, "remote.git");
  git(tmp, "init", "-q", "--bare", remote);
  writePack(process.env.FACTORY_HOME!, "cover", coverPack());
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const start = (yaml: string, config: Config = cfg()) => runFlow(parseFlow(yaml), { task: "the task", repo, runsDir, claudeBin, config });
const events = (s: Pick<RunSummary, "runDir">): EvidenceEvent[] => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
const decided = (s: Pick<RunSummary, "runDir">) => events(s).filter((e): e is Extract<EvidenceEvent, { type: "policy.decided" }> => e.type === "policy.decided");
const live = (s: Pick<RunSummary, "runDir">) => readFileSync(join(s.runDir, "live.log"), "utf8");
/** "step.before:a" for a decision about a step, "run.start" for one about the run. */
const at = (s: Pick<RunSummary, "runDir">) => decided(s).map((e) => e.decision.boundary + (e.step ? `:${e.step.id}` : ""));

const SHELL = `
name: one
workspace: inplace
steps:
  - {id: a, type: shell, run: echo A}
`;

/** A step that pushes HEAD to each of the branches, to the local bare remote. */
const pushes = (...branches: string[]) => branches.map((b) => `git push -q '${remote}' HEAD:refs/heads/${b}`).join(" && ");
const COVER = () => `
name: cover
workspace: inplace
steps:
  - {id: write, type: claude, prompt: "WRITE out.txt hello"}
  - {id: ok, type: approval, message: "go on?"}
  - {id: check, type: shell, run: "grep -q hello out.txt && ${pushes("feat")}"}
`;

describe("policy hooks at the boundaries of a run", () => {
  it("asks at every boundary, with the facts promised there, over a start and a resume", async () => {
    const s = await start(COVER());
    expect(s.status).toBe("waiting");
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: cfg(), decision: { approved: true, by: "someone" } });
    expect(r.status).toBe("succeeded");
    const all = decided(r);
    expect(new Set(all.map((e) => e.decision.boundary))).toEqual(new Set(BOUNDARIES));
    for (const b of BOUNDARIES) {
      const of = all.filter((e) => e.decision.boundary === b);
      expect(of.length, b).toBeGreaterThan(0);
      // every promised fact was there (the check rule would say input-incomplete) and the values held (the ok rule decided)
      for (const e of of) expect([e.decision.rule, e.decision.reasonCode, e.decision.outcome], b).toEqual([okRule(b), "output.limit-exceeded", "warn"]);
      expect(of.some((e) => e.decision.rule === checkRule(b))).toBe(false);
    }
    expect(at(r)).toEqual([
      "run.start", "repository.access", "step.before:write", "repository.access:write", "agent.write:write", "step.after:write",
      "run.start", "step.before:ok", "approval.consume:ok", "step.after:ok",
      "step.before:check", "repository.access:check", "push:check", "step.after:check", "run.complete",
    ]);
    // the identity is the one of the step's own events
    for (const e of all.filter((d) => d.step)) {
      expect(events(r).some((x) => x.type === "step.started" && JSON.stringify(x.step) === JSON.stringify(e.step)), `${e.decision.boundary} ${e.step!.id}`).toBe(true);
    }
    expect(verifyRunEvidence(r.runDir, r.runId).status).toBe("verified");
    expect(live(r).match(/^· policy cover 1 · /gm)).toHaveLength(all.length);
  });

  it.each(BOUNDARIES)("has a decision at %s", async (b: Boundary) => {
    // one run per boundary would be slow: the shared run above holds each of them; a single shell step that does not push holds all but three
    const s = await start(SHELL);
    const present = new Set(decided(s).map((e) => e.decision.boundary));
    const only: Boundary[] = ["agent.write", "approval.consume", "push"];
    expect(present.has(b), b).toBe(!only.includes(b));
  });

  it("keeps the order of the events around a step", async () => {
    const s = await start(SHELL);
    expect(events(s).map((e) => (e.type === "policy.decided" ? `policy:${e.decision.boundary}` : e.type))).toEqual([
      "run.created", "policy:run.start", "policy:repository.access", "run.started", "step.started", "policy:step.before", "policy:repository.access", "step.completed", "policy:step.after", "policy:run.complete", "run.completed",
    ]);
  });

  it("asks push for each push a step makes, with its own branch, and not for a step that never pushes", async () => {
    const s = await start(`
name: pushy
workspace: inplace
steps:
  - {id: quiet, type: shell, run: echo no push}
  - {id: two, type: shell, run: "${pushes("feat-a", "feat-b")}"}
  - {id: again, type: shell, run: "${pushes("feat-c")}"}
`);
    expect(s.status).toBe("succeeded");
    expect(at(s).filter((b) => b.startsWith("push"))).toEqual(["push:two", "push:two", "push:again"]);
    // the decision is made from the branch the hook saw; the repository of a local remote is not known, and is not the run's own
    const inputs = decided(s).filter((e) => e.decision.boundary === "push");
    expect(new Set(inputs.map((e) => e.decision.inputSha256)).size).toBe(3);
    expect(inputs.map((e) => e.decision.reasonCode)).toEqual(["output.limit-exceeded", "output.limit-exceeded", "output.limit-exceeded"]);
    // after the push decisions of a step, the end of the step
    const kinds = events(s).map((e) => (e.type === "policy.decided" ? e.decision.boundary : e.type));
    const i = kinds.indexOf("push");
    expect(kinds.slice(i - 2, i + 3)).toEqual(["repository.access", "step.completed", "push", "push", "step.after"].slice(0, 5));
  });

  it("asks push with the branch and no repository for a push, whatever the run's repository", async () => {
    writePack(process.env.FACTORY_HOME!, "branches", {
      version: 1, policy: { id: "branches", version: "1" }, mode: "observe", defaultOutcome: "allow",
      rules: [{ id: "feat-a-only", boundaries: ["push"], when: { branch: { in: ["feat-a"] } }, outcome: "deny", reasonCode: "branch.protected" }],
    });
    const s = await runFlow(parseFlow(`
name: pushy
workspace: inplace
steps:
  - {id: two, type: shell, run: "${pushes("feat-a", "feat-b")}"}
`), { task: "t", repo, runsDir, claudeBin, config: cfg(["branches"]), vars: { github_repo: "acme/widgets" } });
    expect(s.status).toBe("succeeded");
    expect(decided(s).filter((e) => e.decision.boundary === "push").map((e) => [e.decision.outcome, e.decision.reasonCode])).toEqual([
      ["deny", "branch.protected"],
      ["allow", "policy.no-rule-matched"],
    ]);
  });

  it("asks run.start and repository.access before a worktree is made, and records both when making it fails", async () => {
    const ok = await start(`
name: wt
workspace: worktree
steps:
  - {id: a, type: shell, run: echo A}
`);
    expect(ok.status).toBe("succeeded");
    const kinds = events(ok).map((e) => (e.type === "policy.decided" ? e.decision.boundary : e.type));
    expect(kinds.slice(0, 4)).toEqual(["run.created", "run.start", "repository.access", "run.started"]);
    expect(decided(ok)[1]!.step).toBeUndefined();

    const notRepo = join(tmp, "plain");
    mkdirSync(notRepo);
    const failed = await runFlow(parseFlow("name: wt\nworkspace: worktree\nsteps:\n  - {id: a, type: shell, run: echo A}\n"), { task: "t", repo: notRepo, runsDir, claudeBin, config: cfg() });
    expect(failed.status).toBe("failed");
    expect(at(failed)).toEqual(["run.start", "repository.access"]);
    expect(events(failed).at(-1)).toMatchObject({ type: "run.failed" });
  });

  it("changes nothing in the run, even when every decision is deny", async () => {
    writePack(process.env.FACTORY_HOME!, "strict", { version: 1, policy: { id: "strict", version: "1" }, mode: "observe", defaultOutcome: "deny", rules: [] });
    const flow = `
name: two
workspace: inplace
steps:
  - {id: write, type: claude, prompt: "WRITE out.txt hello"}
  - {id: check, type: shell, run: "grep -q hello out.txt && echo found"}
`;
    const without = await start(flow, cfg([]));
    const withPack = await start(flow, cfg(["strict"]));
    expect(withPack.status).toBe(without.status);
    expect(withPack.history.map((h) => [h.id, h.ok])).toEqual(without.history.map((h) => [h.id, h.ok]));
    const kinds = (s: RunSummary) => events(s).filter((e) => e.type !== "policy.decided").map((e) => e.type);
    expect(kinds(withPack)).toEqual(kinds(without));
    const all = decided(withPack);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((e) => e.decision.outcome === "deny" && e.decision.mode === "observe")).toBe(true);
    expect(live(withPack).match(/^· policy strict /gm)).toHaveLength(all.length);
  });

  it("has no policy lines and events without packs", async () => {
    const s = await start(SHELL, cfg([]));
    expect(s.status).toBe("succeeded");
    expect(decided(s)).toEqual([]);
    expect(live(s)).not.toMatch(/policy/);
  });

  it("does not ask for agent.write at a read-only agent step", async () => {
    const s = await start(`
name: ro
workspace: inplace
steps:
  - {id: look, type: claude, prompt: "hello", permission_mode: plan}
`);
    expect(s.status).toBe("succeeded");
    const t = at(s);
    expect(t).toContain("step.before:look");
    expect(t).not.toContain("agent.write:look");
  });

  it("asks for the children of a parallel step and the steps of a sub-flow, with the identity of their events", async () => {
    mkdirSync(join(repo, ".claude-factory", "flows"), { recursive: true });
    writeFileSync(join(repo, ".claude-factory", "flows", "inner.yaml"), "name: inner\nsteps:\n  - {id: x, type: shell, run: echo X}\n");
    const s = await start(`
name: outer
workspace: inplace
steps:
  - {id: all, type: parallel, steps: [p, q]}
  - {id: p, type: shell, run: echo P, jump_only: true}
  - {id: q, type: shell, run: echo Q, jump_only: true}
  - {id: build, type: flow, flow: inner}
`);
    expect(s.status).toBe("succeeded");
    const all = decided(s);
    for (const id of ["all", "p", "q", "build", "x"]) {
      for (const b of ["step.before", "step.after"]) expect(all.filter((e) => e.decision.boundary === b && e.step?.id === id), `${b} ${id}`).toHaveLength(1);
    }
    for (const e of all.filter((d) => d.step)) {
      const started = events(s).find((x) => x.type === "step.started" && x.step.id === e.step!.id);
      expect(e.step, e.step!.id).toEqual((started as Extract<EvidenceEvent, { type: "step.started" }>).step);
    }
    expect(all.find((e) => e.step?.id === "x")!.step).toMatchObject({ parent: "build" });
    expect(all.find((e) => e.step?.id === "p")!.step).not.toHaveProperty("parent");
  });

  it("reports a pack that is missing, and goes on as without it", async () => {
    const s = await start(SHELL, cfg(["missing"]));
    const plain = await start(SHELL, cfg([]));
    expect(s.status).toBe(plain.status);
    expect(live(s).match(/^! policy missing: no file policies\/missing\.json — recorded as policy\.unavailable; the run goes on$/gm)).toHaveLength(1);
    const all = decided(s);
    expect(new Set(all.map((e) => e.decision.boundary))).toEqual(new Set(["run.start", "step.before", "repository.access", "step.after", "run.complete"]));
    for (const e of all) {
      expect(e.decision).toMatchObject({ policy: { id: "missing", version: "unknown" }, mode: "observe", outcome: "deny", reasonCode: "policy.unavailable" });
      expect(e.decision).not.toHaveProperty("packSha256");
    }
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
  });

  it("reports an enforce pack as invalid and goes on", async () => {
    writePack(process.env.FACTORY_HOME!, "hard", { ...coverPack("hard"), mode: "enforce" });
    const s = await start(SHELL, cfg(["hard"]));
    expect(s.status).toBe("succeeded");
    expect(live(s)).toContain("! policy hard: mode enforce is not supported yet: set mode to observe — recorded as policy.invalid; the run goes on");
    expect(decided(s).every((e) => e.decision.reasonCode === "policy.invalid")).toBe(true);
  });

  it("asks for a built-in flow too", async () => {
    // a `gh` that fails: the clone step ends the run, and the hooks have been called before it
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${path}`;
    try {
      const s = await runFlow(loadFlow("daily-pr", repo).flow, { task: "", repo, runsDir, claudeBin, config: cfg(), vars: { github_repo: "Acme/Widgets" } });
      expect(s.status).toBe("failed");
      const t = at(s);
      expect(t.slice(0, 4)).toEqual(["run.start", "step.before:clone", "repository.access:clone", "step.after:clone"]);
      expect(decided(s)[0]!.decision).toMatchObject({ boundary: "run.start", mode: "observe" });
    } finally {
      process.env.PATH = path;
    }
  });
});
