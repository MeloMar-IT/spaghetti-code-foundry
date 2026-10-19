import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { runFlow, type RunSummary } from "../src/engine/runner.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import { parseFlow } from "../src/flow/load.js";
import { TelemetryEventSchema, type TelemetryEvent } from "../src/telemetry/envelope.js";
import { flushTelemetry, resetTelemetry } from "../src/telemetry/telemetry.js";
import { coverPack, writePack } from "./fixtures/policy-pack.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (telemetry: object = {}, packs: string[] = []): Config => ConfigSchema.parse({ protected_branches: [], telemetry, policy: { packs } });
let tmp: string;
let home: string;
let saved: string | undefined;
let repo: string;
let runsDir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "ignore" });

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  tmp = mkdtempSync(join(tmpdir(), "telemetry-run-"));
  home = join(tmp, "home");
  mkdirSync(home);
  process.env.FACTORY_HOME = home;
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "first");
});
afterEach(() => {
  resetTelemetry();
  if (saved === undefined) delete process.env.FACTORY_HOME;
  else process.env.FACTORY_HOME = saved;
  rmSync(tmp, { recursive: true, force: true });
});

const FLOW = `
name: tele
workspace: inplace
vars: {github_repo: owner/name}
steps:
  - {id: write, type: claude, prompt: "WRITE out.txt hello"}
  - {id: check, type: shell, run: "grep -q hello out.txt"}
`;
const start = (config: Config, runId?: string) => runFlow(parseFlow(FLOW), { task: "the task", repo, runsDir, claudeBin, config, ...(runId ? { runId } : {}) });
const telemetryFiles = () => (existsSync(join(home, "telemetry")) ? readdirSync(join(home, "telemetry")) : []);
const lines = (s: Pick<RunSummary, "runId">): TelemetryEvent[] => {
  flushTelemetry();
  return telemetryFiles()
    .flatMap((f) => readFileSync(join(home, "telemetry", f), "utf8").split("\n").filter(Boolean))
    .map((l) => TelemetryEventSchema.parse(JSON.parse(l)))
    .filter((e) => e.runId === s.runId);
};
const evidence = (s: Pick<RunSummary, "runDir">) => readFileSync(join(s.runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));

describe("telemetry of a run", () => {
  it("mirrors the evidence of a run, in order, with its ids", async () => {
    const s = await start(cfg());
    expect(s.status).toBe("succeeded");
    const t = lines(s);
    expect(t.filter((e) => e.name !== "policy.decided").map((e) => e.name)).toEqual(["run.created", "run.started", "step.started", "model.routed", "step.profiled", "step.completed", "step.started", "step.completed", "run.completed"]);
    expect(t.every((e) => e.repository === "owner/name")).toBe(true);
    const ev = evidence(s);
    expect(t).toHaveLength(ev.length);
    t.forEach((e, i) => {
      expect(e.evidence).toEqual({ id: ev[i]!.id, seq: ev[i]!.seq });
      expect(e.id).toBe(`ev:${s.runId}:${ev[i]!.id}`);
    });
  });

  it("writes no folder with local: false", async () => {
    const s = await start(cfg({ local: false }));
    expect(s.status).toBe("succeeded");
    expect(existsSync(join(home, "telemetry"))).toBe(false);
  });

  it("still gives telemetry, without evidence, when the evidence stream has stopped", async () => {
    const runId = "run-stopped-evidence";
    mkdirSync(join(runsDir, runId, "evidence.jsonl"), { recursive: true });
    const s = await start(cfg(), runId);
    expect(s.status).toBe("succeeded");
    const t = lines(s);
    expect(t.filter((e) => e.name !== "policy.decided").map((e) => e.name)).toEqual(["run.created", "run.started", "step.started", "model.routed", "step.profiled", "step.completed", "step.started", "step.completed", "run.completed"]);
    expect(t.every((e) => e.id.startsWith("tm:") && e.evidence === undefined)).toBe(true);
  });

  it("gives policy decisions the time of the evidence", async () => {
    writePack(home, "cover", coverPack());
    const s = await start(cfg({}, ["cover"]));
    const t = lines(s).filter((e) => e.name === "policy.decided");
    const ev = evidence(s).filter((e) => e.type === "policy.decided");
    expect(t.length).toBeGreaterThan(0);
    expect(t).toHaveLength(ev.length);
    t.forEach((e, i) => {
      expect(e.decision?.boundary).toBeDefined();
      expect(e.decision?.reasonCode).toBeDefined();
      expect(e.time).toBe(ev[i]!.time);
    });
  });
});
