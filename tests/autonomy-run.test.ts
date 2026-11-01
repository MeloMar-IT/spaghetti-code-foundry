import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addRepo } from "../src/auth/repos.js";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow, type RunSummary } from "../src/engine/runner.js";
import { loadRun } from "../src/engine/state.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import { verifyRunEvidence } from "../src/evidence/verify.js";
import { parseFlow } from "../src/flow/load.js";
import { setLevel } from "../src/governance/autonomy-store.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const events = (s: Pick<RunSummary, "runDir">) => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));

describe("the autonomy level of a run", { timeout: 60_000 }, () => {
  let home: string;
  let repo: string;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FACTORY_HOME;
    home = mkdtempSync(join(tmpdir(), "autonomy-run-"));
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

  const flow = () => parseFlow(`name: au\nworkspace: inplace\nsteps:\n  - id: a\n    type: shell\n    run: "echo A"\n  - id: b\n    type: shell\n    run: "echo B"\n`);
  const config = () => ConfigSchema.parse({ protected_branches: [], promotion: { enforce: "off" } });

  it("records the lower level once, and a resume does not record it again", async () => {
    const other = randomUUID(); // another account than the run's
    const id = addRepo(other, "https://github.com/acme/app", { ownerOk: () => true }).id;
    setLevel("repos", id, "guarded-write", "system:connect");
    setLevel("flows", "au", "plan-only", other);
    const runsDir = join(home, "runs");
    const s = await runFlow(flow(), { task: "t", repo, runsDir, claudeBin, vars: { github_repo: "acme/app" }, config: config() });
    expect(s.status).toBe("succeeded");
    expect(loadRun(runsDir, s.runId)!.autonomy).toEqual({ level: "plan-only", repository: "guarded-write", flow: "plan-only" });
    expect(readFileSync(join(s.runDir, "live.log"), "utf8")).toContain("autonomy: plan-only (repository guarded-write, flow plan-only)");
    const all = events(s);
    expect(all[0]!.type).toBe("run.created");
    expect(all[1]).toMatchObject({ type: "run.autonomy", level: "plan-only", repository: "guarded-write", flow: "plan-only" });
    expect(all.filter((e) => e.type === "run.autonomy")).toHaveLength(1);
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");

    setLevel("flows", "au", "observe", other);
    await resumeRun({ runsDir, runId: s.runId, from: "b", claudeBin, config: config() });
    expect(loadRun(runsDir, s.runId)!.autonomy?.level).toBe("plan-only");
    expect(events(s).filter((e) => e.type === "run.autonomy")).toHaveLength(1);
  });
});
