import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { runFlow, type RunSummary } from "../src/engine/runner.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import { verifyRunEvidence } from "../src/evidence/verify.js";
import { parseFlow } from "../src/flow/load.js";
import type { AutonomyLevel } from "../src/governance/autonomy.js";
import { setLevel } from "../src/governance/autonomy-store.js";
import { claudeBin, fakeGithub } from "./helpers/fake-github.js";

const SENTENCE = (level: string, what: string) => `autonomy ${level} does not allow ${what}; next step: promote the repository or flow`;

let gh: ReturnType<typeof fakeGithub>;
let work: string;
let savedHome: string | undefined;
let n = 0;

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe", encoding: "utf8" });
const remoteBranches = () => git(gh.remote, "for-each-ref", "--format=%(refname)").split("\n").filter(Boolean).sort();

beforeEach(() => {
  savedHome = process.env.FACTORY_HOME;
  gh = fakeGithub();
  process.env.FACTORY_HOME = join(gh.tmp, "home");
  mkdirSync(process.env.FACTORY_HOME, { recursive: true });
  work = join(gh.tmp, "work");
  git(gh.tmp, "clone", "-q", gh.remote, work);
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = savedHome;
  delete process.env.FACTORY_NO_PUSH;
  gh.restore();
});

const config = (extra: Record<string, unknown> = {}) => ConfigSchema.parse({ protected_branches: [], secret_scan: false, promotion: { enforce: "off" }, ...extra });
const shell = (id: string, run: string, extra = "") => `  - id: ${id}\n    type: shell\n${extra}    run: ${JSON.stringify(run)}\n`;
const agent = (id: string, prompt: string, extra = "") => `  - id: ${id}\n    type: claude\n${extra}    prompt: ${JSON.stringify(prompt)}\n`;

/** Runs the steps in a clone of the fake remote, at the given level (set on the flow; the repository has no entry). */
async function go(level: AutonomyLevel, steps: string, cfg = config()): Promise<RunSummary> {
  const name = `au-enforce-${++n}`;
  setLevel("flows", name, level, "system:admin");
  rmSync(work, { recursive: true, force: true });
  git(gh.tmp, "clone", "-q", gh.remote, work);
  const flow = parseFlow(`name: ${name}\nworkspace: inplace\nvars: { github_repo: acme/app, issue: "5" }\nsteps:\n${steps}`, `${name}.yaml`);
  return runFlow(flow, { task: "t", repo: work, runsDir: join(gh.tmp, "runs"), claudeBin, vars: { github_repo: "acme/app", issue: "5" }, config: cfg });
}
const rec = (s: RunSummary, id: string) => s.history.find((h) => h.id === id)!;
const events = (s: RunSummary) => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
const denials = (s: RunSummary) => events(s).filter((e) => e.type === "step.denied");
const PUSH = "git checkout -q -b feat && git commit -q --allow-empty -m x && git push origin feat";

describe("observe", () => {
  it("runs a read-only agent step, refuses a writing one before the agent starts, and refuses repo_access", { timeout: 60_000 }, async () => {
    const read = await go("observe", agent("look", "SAY looking", "    permission_mode: plan\n"));
    expect(rec(read, "look").ok).toBe(true);
    expect(events(read).filter((e) => e.type === "step.routed")).toHaveLength(1);

    const write = await go("observe", agent("write", "WRITE wrote.txt hi"));
    expect(rec(write, "write").error).toBe(SENTENCE("observe", "a writing agent step"));
    expect(existsSync(join(work, "wrote.txt"))).toBe(false);
    expect(events(write).filter((e) => e.type === "step.routed")).toEqual([]);

    const repo = await go("observe", shell("repo", 'echo hello | node "$FACTORY_TOOLS/story" comment', "    repo_access: true\n"));
    expect(rec(repo, "repo").error).toBe(SENTENCE("observe", "a repo_access shell step"));
    expect(gh.comments()).toEqual([]);
  });
});

describe("plan-only", () => {
  it("lets a repo_access step comment, and refuses a writing agent and a push", { timeout: 60_000 }, async () => {
    const comment = await go("plan-only", shell("comment", 'echo hello | node "$FACTORY_TOOLS/story" comment', "    repo_access: true\n"));
    expect(rec(comment, "comment").ok).toBe(true);
    expect(gh.comments().map((c) => c.body)).toContain("hello");
    const write = await go("plan-only", agent("write", "WRITE wrote.txt hi"));
    expect(rec(write, "write").error).toBe(SENTENCE("plan-only", "a writing agent step"));
    const push = await go("plan-only", shell("push", PUSH));
    expect(rec(push, "push").error).toBe(SENTENCE("plan-only", "a push"));
    expect(remoteBranches()).toEqual(["refs/heads/main"]);
  });
});

describe("guarded-write", () => {
  it("lets an agent write; refuses a push even with no guards and even when the step swallows the exit code", { timeout: 60_000 }, async () => {
    const written = await go("guarded-write", agent("write", "WRITE wrote.txt hi"));
    expect(rec(written, "write").ok).toBe(true);
    expect(readFileSync(join(work, "wrote.txt"), "utf8")).toBe("hi");
    const push = await go("guarded-write", shell("push", PUSH));
    expect(rec(push, "push").error).toBe(SENTENCE("guarded-write", "a push"));
    const swallow = await go("guarded-write", shell("swallow", `${PUSH} || true`));
    expect(rec(swallow, "swallow").ok).toBe(false);
    expect(rec(swallow, "swallow").error).toBe(SENTENCE("guarded-write", "a push"));
    expect(remoteBranches()).toEqual(["refs/heads/main"]);
  });

  it("follows on_failure after a refusal, and fails the run without one", { timeout: 60_000 }, async () => {
    const withRescue = await go("guarded-write", shell("push", PUSH, "    on_failure: rescue\n") + shell("rescue", "echo rescued", "    jump_only: true\n"));
    expect(rec(withRescue, "rescue").output.trim()).toBe("rescued");
    const without = await go("guarded-write", shell("push", PUSH));
    expect(without.status).toBe("failed");
    expect(without.reason).toContain(SENTENCE("guarded-write", "a push"));
  });

  it("refuses to open a pull request, and records it", { timeout: 60_000 }, async () => {
    const s = await go("guarded-write", shell("open_pr", 'echo body | node "$FACTORY_TOOLS/story" pr-open --head feat --title T', "    repo_access: true\n"));
    expect(rec(s, "open_pr").error).toBe(SENTENCE("guarded-write", "a pull request"));
    expect(gh.ghLog()).not.toContain("pr create");
    expect(denials(s)).toHaveLength(1);
  });

  it("refuses daily-branch open-pr", { timeout: 60_000 }, async () => {
    const s = await go("guarded-write", shell("daily", 'node "$FACTORY_TOOLS/daily-branch" open-pr feat', "    repo_access: true\n"));
    expect(rec(s, "daily").ok).toBe(false);
    expect(gh.ghLog()).not.toContain("pr create");
  });

  it("leaves the remote unchanged for a push from a Docker step, and forwards the hook into the container", { timeout: 60_000 }, async () => {
    writeFileSync(join(gh.tmp, "bin", "docker"), '#!/bin/sh\nfor a in "$@"; do echo "arg:$a"; cmd=$a; done\nexec sh -c "$cmd"\n', { mode: 0o755 });
    const s = await go("guarded-write", shell("box", PUSH, "    sandbox: true\n"), config({ sandbox: { docker_image: "img" } }));
    const box = rec(s, "box");
    expect(box.error).toBe(SENTENCE("guarded-write", "a push"));
    for (const name of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "FACTORY_NO_PUSH", "FACTORY_PUSH_LOG"]) expect(box.output).toContain(`arg:${name}\n`);
    expect(box.output).toMatch(/arg:.*\/hooks:.*\/hooks:ro\n/);
    expect(box.output).toMatch(/arg:.*\/pushes:.*\/pushes:rw\n/);
    expect(remoteBranches()).toEqual(["refs/heads/main"]);
  });

  it("records the denial in verified evidence", { timeout: 60_000 }, async () => {
    const s = await go("guarded-write", shell("push", PUSH));
    expect(denials(s)).toMatchObject([{ type: "step.denied", denial: { kind: "policy", policy: { id: "foundry.autonomy", version: "1" }, reasonCode: "autonomy.denied" } }]);
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
  });
});

describe("a read-only Codex session below delivery-handoff", () => {
  // Codex's read-only sandbox has no folder for the push log: its own command results carry the refusal to the engine.
  const codex = (id: string, prompt: string, extra = "") => agent(id, prompt, `    agent: codex\n    permission_mode: plan\n${extra}`);
  it("fails the step with the sentence, records the denial, and runs on_failure", { timeout: 60_000 }, async () => {
    process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
    try {
      const s = await go("guarded-write", codex("pr", "REFUSED a pull request", "    on_failure: rescue\n") + shell("rescue", "echo rescued", "    jump_only: true\n"));
      expect(rec(s, "pr").ok).toBe(false);
      expect(rec(s, "pr").error).toBe(SENTENCE("guarded-write", "a pull request"));
      expect(rec(s, "rescue").output.trim()).toBe("rescued");
      expect(denials(s)).toMatchObject([{ denial: { kind: "policy", reasonCode: "autonomy.denied" } }]);
      expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
    } finally {
      delete process.env.FACTORY_CODEX_BIN;
    }
  });

  it("is not stopped by a refusal it reads at delivery-handoff", { timeout: 60_000 }, async () => {
    process.env.FACTORY_CODEX_BIN = resolve("tests/fixtures/fake-codex.mjs");
    try {
      const s = await go("delivery-handoff", codex("pr", "REFUSED a push"));
      expect(rec(s, "pr").ok).toBe(true);
      expect(denials(s)).toEqual([]);
    } finally {
      delete process.env.FACTORY_CODEX_BIN;
    }
  });
});

describe("delivery-handoff", () => {
  it("writes, pushes and opens a pull request with no denial, also when the server's own environment has FACTORY_NO_PUSH", { timeout: 60_000 }, async () => {
    process.env.FACTORY_NO_PUSH = "observe";
    const s = await go(
      "delivery-handoff",
      agent("write", "WRITE wrote.txt hi") + shell("push", PUSH) + shell("open_pr", 'echo body | node "$FACTORY_TOOLS/story" pr-open --head feat --title T', "    repo_access: true\n"),
    );
    expect(s.status).toBe("succeeded");
    expect(remoteBranches()).toContain("refs/heads/feat");
    expect(gh.ghLog()).toContain("pr create");
    expect(denials(s)).toEqual([]);
  });
});
