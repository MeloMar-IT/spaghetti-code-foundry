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
import { configureTelemetry, flushTelemetry, resetTelemetry } from "../src/telemetry/telemetry.js";
import { pushLogFor, type Engine, type Scope } from "../src/engine/execute.js";
import { runClaude } from "../src/steps/claude.js";
import { coverPack, writePack } from "./fixtures/policy-pack.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const cfg = (telemetry: object = {}, packs: string[] = [], extra: object = {}): Config => ConfigSchema.parse({ protected_branches: [], telemetry, policy: { packs }, ...extra });
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
    const all = lines(s);
    expect(all.filter((e) => e.name !== "policy.decided").map((e) => e.name)).toEqual(["run.created", "run.started", "step.started", "model.routed", "step.profiled", "tool.called", "step.completed", "step.started", "step.completed", "run.completed"]);
    expect(all.every((e) => e.repository === "owner/name")).toBe(true);
    const t = all.filter((e) => e.evidence);
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
    expect(t.filter((e) => e.name !== "policy.decided").map((e) => e.name)).toEqual(["run.created", "run.started", "step.started", "model.routed", "step.profiled", "tool.called", "step.completed", "step.started", "step.completed", "run.completed"]);
    expect(t.every((e) => e.id.startsWith("tm:") && e.evidence === undefined)).toBe(true);
  });

  it("gives one tool.called with the tool's name only", async () => {
    const s = await start(cfg());
    flushTelemetry();
    const raw = telemetryFiles().map((f) => readFileSync(join(home, "telemetry", f), "utf8")).join("");
    const called = lines(s).filter((e) => e.name === "tool.called");
    expect(called).toHaveLength(1);
    expect(called[0]!.tool).toEqual({ name: "Write" });
    expect(called[0]!.step?.id).toBe("write");
    expect(called[0]!.repository).toBe("owner/name");
    expect(called[0]!.id.startsWith("tm:")).toBe(true);
    const line = raw.split("\n").find((l) => l.includes("tool.called"))!;
    expect(line).not.toContain("out.txt");
    expect(line).not.toContain("hello");
  });

  it("calls onTool for each tool use without onProgress", async () => {
    const names: string[] = [];
    await runClaude({ prompt: "WRITE a.txt x\nWRITE b.txt y", cwd: repo, claudeBin, logFile: join(tmp, "c.log"), onTool: (n) => names.push(n) });
    expect(names).toEqual(["Write", "Write"]);
  });

  describe("push attempts", () => {
    const PUSHES = (to: string): string => `
name: push
workspace: inplace
vars: {github_repo: owner/name}
steps:
  - {id: push, type: shell, run: "${to}"}
`;
    const startPush = (to: string, extra: object) => {
      git(tmp, "init", "--bare", "-q", "remote.git");
      git(repo, "remote", "add", "origin", join(tmp, "remote.git"));
      return runFlow(parseFlow(PUSHES(to)), { task: "t", repo, runsDir, claudeBin, config: cfg({}, [], extra) });
    };

    it("records a push to a bare remote with its branch and no repository", async () => {
      const s = await startPush("git push -q origin HEAD:refs/heads/feature-x", { protected_branches: ["release/*"], secret_scan: false });
      expect(s.status).toBe("succeeded");
      const p = lines(s).filter((e) => e.name === "delivery.push_attempted");
      expect(p).toHaveLength(1);
      expect(p[0]!.branch).toBe("feature-x");
      expect(p[0]!.repository).toBeUndefined();
      expect(p[0]!.step?.id).toBe("push");
      expect(p[0]!.runId).toBe(s.runId);
      expect(p[0]!.id.startsWith("tm:")).toBe(true);
    });

    it("records a push the hook refused", async () => {
      const s = await startPush("git push -q origin HEAD:refs/heads/main || true", { protected_branches: ["main"], secret_scan: false });
      expect(() => execFileSync("git", ["-C", join(tmp, "remote.git"), "rev-parse", "--verify", "-q", "main"], { stdio: "ignore" })).toThrow();
      const p = lines(s).filter((e) => e.name === "delivery.push_attempted");
      expect(p).toHaveLength(1);
      expect(p[0]!.branch).toBe("main");
    });

    it("records nothing without a hook", async () => {
      const s = await startPush("git push -q origin HEAD:refs/heads/feature-x", { protected_branches: [], secret_scan: false });
      expect(s.status).toBe("succeeded");
      expect(lines(s).filter((e) => e.name === "delivery.push_attempted")).toHaveLength(0);
    });
  });

  it("pushLogFor gives a file only when telemetry is on and the hook is installed anyway", () => {
    const engine = (extra: object) => ({ policy: undefined, config: ConfigSchema.parse({ protected_branches: [], secret_scan: false, ...extra }), summary: { runDir: tmp } }) as unknown as Engine;
    const scope = { prefix: "" } as Scope;
    configureTelemetry(cfg());
    expect(pushLogFor(engine({}), scope, { id: "a" }, 1)).toBeUndefined();
    expect(pushLogFor(engine({ protected_branches: ["main"] }), scope, { id: "a" }, 1)).toBe(join(tmp, "pushes", "a-1.log"));
    configureTelemetry(cfg({ local: false }));
    expect(pushLogFor(engine({ protected_branches: ["main"] }), scope, { id: "a" }, 1)).toBeUndefined();
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
