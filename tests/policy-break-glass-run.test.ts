import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditPath } from "../src/auth/audit.js";
import { ConfigSchema, type Config } from "../src/config.js";
import { breakGlassFile } from "../src/engine/policy-break-glass.js";
import { deniedReason } from "../src/engine/policy-hooks.js";
import { runFlow, type RunSummary } from "../src/engine/runner.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { verifyRunEvidence } from "../src/evidence/verify.js";
import { parseFlow } from "../src/flow/load.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
let tmp: string;
let repo: string;
let runsDir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });
const cfg = (): Config => ConfigSchema.parse({ protected_branches: [], policy: { mandatory: ["org"] } });
const SHELL = `
name: one
workspace: inplace
steps:
  - {id: a, type: shell, run: "echo A > ran.txt", on_failure: b}
  - {id: b, type: shell, run: "echo B > b.txt"}
`;

beforeAll(() => {
  delete process.env.CODEX_API_KEY;
});
const clean = () => {
  const h = process.env.FACTORY_HOME!;
  rmSync(join(h, "policies"), { recursive: true, force: true });
  rmSync(breakGlassFile(h), { force: true });
  rmSync(auditPath(), { force: true });
};
beforeEach(() => {
  clean();
  tmp = mkdtempSync(join(tmpdir(), "bg-run-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clean();
});

const start = () => runFlow(parseFlow(SHELL), { task: "the task", repo, runsDir, claudeBin, config: cfg() });
const events = (s: Pick<RunSummary, "runDir">): EvidenceEvent[] => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
const live = (s: Pick<RunSummary, "runDir">) => readFileSync(join(s.runDir, "live.log"), "utf8");
const record = (startMs: number, endMs: number) => ({
  version: 1,
  reason: "outage",
  startedAt: new Date(Date.now() + startMs).toISOString(),
  expiresAt: new Date(Date.now() + endMs).toISOString(),
  actor: { kind: "cli", osUser: "admin" },
});

describe("break-glass in a run with a missing mandatory pack", { timeout: 60_000 }, () => {
  it("lets the step go on, recorded and verifiable", async () => {
    writeFileSync(breakGlassFile(), JSON.stringify(record(-60_000, 3_600_000)));
    const s = await start();
    expect(s.status).toBe("succeeded");
    expect(existsSync(join(repo, "ran.txt"))).toBe(true);
    const ev = events(s);
    const glass = ev.filter((e) => e.type === "policy.decided" && e.decision.policy.id === "org" && e.decision.reasonCode === "policy.break-glass");
    expect(glass.length).toBeGreaterThan(0);
    expect(glass[0]).toMatchObject({ decision: { outcome: "warn", mode: "enforce" } });
    expect(ev.some((e) => e.type === "step.denied")).toBe(false);
    expect(verifyRunEvidence(s.runDir, s.runId).status).toBe("verified");
    expect(live(s)).toContain("! policy: break-glass active until");
    expect(live(s)).toContain("— break-glass: the step goes on");
  });

  it("denies when the break-glass has expired, and writes the end line", async () => {
    writeFileSync(breakGlassFile(), JSON.stringify(record(-10 * 60_000, -60_000)));
    const s = await start();
    expect(s.status).toBe("failed");
    expect(s.history[0]).toMatchObject({ accessFailed: true, error: deniedReason("org", "policy.unavailable", "repository.access") });
    const lines = readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.filter((l) => l.action === "policy-break-glass-end")).toHaveLength(1);
    expect(lines.find((l) => l.action === "policy-break-glass-end")).toMatchObject({ detail: "expired" });
    expect(existsSync(breakGlassFile())).toBe(false);
  });

  it("denies when the file is not valid", async () => {
    writeFileSync(breakGlassFile(), "{ nope");
    const s = await start();
    expect(s.status).toBe("failed");
    expect(s.history[0]).toMatchObject({ accessFailed: true, error: deniedReason("org", "policy.unavailable", "repository.access") });
    expect(live(s)).not.toContain("break-glass");
  });
});
