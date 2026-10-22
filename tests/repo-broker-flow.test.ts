import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { createUser } from "../src/auth/users.js";
import { ConfigSchema } from "../src/config.js";
import { deniedReason } from "../src/engine/policy-hooks.js";
import { runFlow, type RunSummary } from "../src/engine/runner.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { verifyRunEvidence } from "../src/evidence/verify.js";
import { parseFlow } from "../src/flow/load.js";
import { fakeGithub } from "./helpers/fake-github.js";
import { fakeKeychain, type FakeKeychain } from "./helpers/keychain.js";
import { TEST_PASSWORD } from "./helpers/session.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const TOKEN = ["github", "pat", ""].join("_") + "Zx9".repeat(12);

const events = (s: Pick<RunSummary, "runDir">): EvidenceEvent[] => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
type RepoOp = Extract<EvidenceEvent, { type: "repo.operation" }>;
const repoOps = (s: Pick<RunSummary, "runDir">) => events(s).filter((e): e is RepoOp => e.type === "repo.operation");
const denied = (s: Pick<RunSummary, "runDir">) => events(s).filter((e) => e.type === "step.denied");
const agent = (id: string, prompt: string, extra = "") => `  - id: ${id}\n    type: claude\n${extra}    prompt: ${JSON.stringify(prompt)}\n`;
const sh = (id: string, run: string) => `  - id: ${id}\n    type: shell\n    run: ${JSON.stringify(run)}\n`;
const lines = (...l: string[]) => l.join("\n");

describe("repo_ops in an admin run", { timeout: 60_000 }, () => {
  let home: string;
  let repo: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    home = mkdtempSync(join(tmpdir(), "repo-broker-flow-"));
    process.env.FACTORY_HOME = join(home, "home");
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
    repo = join(home, "repo");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "start");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FACTORY_HOME;
    else process.env.FACTORY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  const run = (steps: string) =>
    runFlow(parseFlow(`name: rb\nworkspace: inplace\nvars: { github_repo: acme/app }\nsteps:\n${steps}`), {
      task: "t",
      repo,
      runsDir: join(home, "runs"),
      claudeBin,
      vars: { github_repo: "acme/app" },
      config: ConfigSchema.parse({ protected_branches: [], bot: { name: "Bot", email: "bot@example.com" } }),
    });
  const log = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  const live = (s: RunSummary) => readFileSync(join(s.runDir, "live.log"), "utf8");

  it("carries out a commit and a status request", async () => {
    const s = await run(agent("a", lines("WRITE out.txt hi", 'REQUEST {"op":"commit","message":"agent work"}', 'REQUEST {"op":"status"}'), "    repo_ops: [commit, status]\n"));
    expect(s.status).toBe("succeeded");
    expect(log("log", "-1", "--format=%s%n%an")).toBe("agent work\nBot");
    const out = s.history[0]!.output;
    expect(out).toContain("## Repository operations");
    expect(out.indexOf("- commit: done")).toBeGreaterThan(-1);
    expect(out.indexOf("- commit: done")).toBeLessThan(out.indexOf("- status: done"));
    expect(live(s)).toContain("· repo commit: done");
    expect(existsSync(join(s.runDir, "repo-requests", "a-1.jsonl"))).toBe(false);
    expect(repoOps(s).map((e) => [e.operation, e.outcome, e.credential, e.step.id])).toEqual([
      ["commit", "done", "none", "a"],
      ["status", "done", "none", "a"],
    ]);
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
  });

  it("gives a step without repo_ops no request file and ignores any request", async () => {
    const s = await run(agent("a", lines("SHOWVARS FACTORY_REPO_REQUESTS SCF_REPO_REQUESTS", 'REQUEST {"op":"commit","message":"x"}')));
    expect(s.status).toBe("succeeded");
    expect(s.history[0]!.output).toContain("FACTORY_REPO_REQUESTS=(unset)");
    expect(s.history[0]!.output).toContain("SCF_REPO_REQUESTS=(unset)");
    expect(s.history[0]!.output).not.toContain("## Repository operations");
    expect(repoOps(s)).toHaveLength(0);
  });

  it("refuses an operation that is not listed, fails the step and follows on_failure", async () => {
    const s = await run(
      agent("a", lines("WRITE out.txt hi", 'REQUEST {"op":"commit","message":"x"}', 'REQUEST {"op":"status"}'), "    repo_ops: [status]\n    on_failure: b\n") + sh("b", "echo recovered"),
    );
    expect(s.history.map((h) => h.id)).toEqual(["a", "b"]);
    expect(s.history[0]).toMatchObject({ ok: false });
    expect(s.history[0]!.accessFailed).not.toBe(true);
    expect(repoOps(s).map((e) => [e.operation, e.outcome, e.refusal])).toEqual([["commit", "refused", "not-in-profile"]]);
    expect(denied(s)).toHaveLength(1);
    expect(log("log", "--format=%s")).toBe("start");
  });

  it("carries out nothing when pass_if fails", async () => {
    const s = await run(agent("a", lines("WRITE out.txt hi", 'REQUEST {"op":"commit","message":"x"}'), "    repo_ops: [commit]\n    pass_if: ^ALL GOOD$\n"));
    expect(s.history[0]).toMatchObject({ ok: false });
    expect(s.history[0]!.error).toMatch(/pass_if/);
    expect(repoOps(s)).toHaveLength(0);
    expect(log("log", "--format=%s")).toBe("start");
    expect(existsSync(join(s.runDir, "repo-requests", "a-1.jsonl"))).toBe(false);
  });
});

describe("a policy denial of a repository request", { timeout: 60_000 }, () => {
  let gh: ReturnType<typeof fakeGithub>;
  let kc: FakeKeychain;
  beforeEach(async () => {
    gh = fakeGithub();
    process.env.FACTORY_HOME = join(gh.tmp, "home");
    mkdirSync(process.env.FACTORY_HOME, { recursive: true });
    kc = fakeKeychain();
  });
  afterEach(() => {
    kc.remove();
    gh.restore();
  });

  it("ends the run", async () => {
    const user = await createUser({ name: "User", email: "user@example.com", password: TEST_PASSWORD, role: "user" });
    addRepo(user.id, { url: "acme/app", method: "github-token", token: TOKEN });
    writeFileSync(join(gh.tmp, ".keep"), "");
    const flow = parseFlow(
      `name: pd\nworkspace: empty\nvars: { github_repo: acme/app }\nsteps:\n${sh("s", "git init -q")}${agent("a", 'REQUEST {"op":"fetch"}', "    permission_mode: plan\n    repo_ops: [fetch]\n    on_failure: b\n")}${sh("b", "echo no")}`,
      "pd.yaml",
    );
    const s = await runFlow(flow, {
      task: "idea",
      repo: gh.tmp,
      runsDir: join(gh.tmp, "runs"),
      claudeBin,
      vars: { github_repo: "acme/app" },
      config: ConfigSchema.parse({ protected_branches: [], policy: { mandatory: ["org"] } }),
      owner: user.id,
    });
    expect(s.status).toBe("failed");
    expect(s.history.map((h) => h.id)).toEqual(["s", "a"]);
    expect(s.history[1]).toMatchObject({ accessFailed: true, error: deniedReason("org", "policy.unavailable", "repository.access") });
    expect(repoOps(s).map((e) => [e.operation, e.outcome, e.refusal, e.credential])).toEqual([["fetch", "refused", "policy", "repository"]]);
    expect(denied(s)).toHaveLength(1);
    expect(JSON.stringify(s.history)).not.toContain(TOKEN);
  });
});
