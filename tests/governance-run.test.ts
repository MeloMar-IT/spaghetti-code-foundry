import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { resumeRun, runFlow } from "../src/engine/runner.js";
import { loadRun } from "../src/engine/state.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import { FACTORY_HOME, parseFlow } from "../src/flow/load.js";
import { contextSelectorSha256, flowSha256, modelRoutesSha256 } from "../src/promotion/components.js";
import { governanceGate, governedComponents, runComponents, type GateInput } from "../src/promotion/gate.js";
import { readHomeComponents } from "../src/promotion/home.js";
import { contextSelectorInput } from "../src/context/settings.js";
import { Scheduler, type Job } from "../src/queue/scheduler.js";
import { recordVersions } from "../src/promotion/versions.js";
import { fakeGithub } from "./helpers/fake-github.js";

const shell = (name: string, run: string, extra = "") => `name: ${name}\nworkspace: empty\n${extra}steps:\n  - {id: a, type: shell, run: ${JSON.stringify(run)}}\n`;
const config = (over: object = {}) => ConfigSchema.parse({ promotion: { enforce: "off" }, ...over });
const NOW = new Date("2026-11-01T00:00:00Z");

let base: string;
let home: string;
let gh: ReturnType<typeof fakeGithub>;
const put = (rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const gov = (components: object) => put("promotions/governance.yaml", JSON.stringify({ version: 1, components }));
const events = (runDir: string) => readFileSync(join(runDir, "evidence.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => parseEvidenceEventLine(l));
const decided = (runDir: string) => events(runDir).filter((e) => e.type === "governance.decided");

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "governance-run-"));
  home = FACTORY_HOME;
  gh = fakeGithub();
});
afterEach(() => {
  gh.restore();
  vi.doUnmock("../src/promotion/gate.js");
  vi.resetModules();
  for (const d of ["flows", "policies", "promotions", "context-selectors"]) rmSync(join(home, d), { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe("collecting the components of a run", () => {
  const input = (over: Partial<GateInput> = {}): GateInput => ({ flow: parseFlow(shell("Deploy", "true")), flowId: "deploy", repo: base, vars: { github_repo: "acme/app" }, config: config(), ...over });

  it("lists a shipped flow, the baseline, the model routes and the context selector too", () => {
    const shipped = parseFlow(readFileSync(join(process.cwd(), "flows", "issue-gitflow.yaml"), "utf8"));
    const kinds = runComponents(input({ flow: shipped, flowId: "issue-gitflow" }), { home, everything: true }).refs.map((r) => `${r.kind}/${r.id}`);
    expect(kinds).toEqual(expect.arrayContaining(["flow/issue-gitflow", "policy-pack/foundry.baseline", "model-routes/default", "context-selector/default"]));
    const plain = runComponents(input({ flow: shipped, flowId: "issue-gitflow" }), { home }).refs.map((r) => `${r.kind}/${r.id}`);
    expect(plain).toEqual(["model-routes/default"]);
  });

  it("takes counted versions from versions.json and leaves unrecorded ones unset", () => {
    expect(governedComponents(input(), { home }).find((c) => c.kind === "model-routes")).not.toHaveProperty("version");
    recordVersions([{ kind: "model-routes", id: "default", sha256: modelRoutesSha256(config().router) }]);
    expect(governedComponents(input(), { home }).find((c) => c.kind === "model-routes")?.version).toBe("1");
    put("promotions/versions.json", "{ not json");
    expect(governedComponents(input(), { home }).find((c) => c.kind === "model-routes")).not.toHaveProperty("version");
  });

  it("keeps the raw id of a pack that cannot load, and refuses on its retired record", () => {
    const id = "p".repeat(80);
    const cfg = config({ policy: { packs: [id] } });
    const parts = governedComponents(input({ config: cfg }), { home });
    const unloaded = parts.find((c) => c.kind === "policy-pack" && c.id === id);
    expect(unloaded).toMatchObject({ show: "p".repeat(60) });
    expect(unloaded).not.toHaveProperty("version");
    gov({ [`policy-pack/${id}`]: { lifecycle: "retired" } });
    const d = governanceGate(input({ config: cfg }), { home, now: NOW });
    expect(d.outcome).toBe("refused");
    expect(d.reason).toContain(`policy-pack ${"p".repeat(60)} is retired`);
  });

  it("collects a sub-flow, and keeps the id of a missing one", () => {
    put("flows/child.yaml", shell("Child", "true"));
    const parent = (ref: string) => parseFlow(`name: Parent\nworkspace: empty\nsteps:\n  - {id: a, type: flow, flow: ${ref}}\n`);
    expect(runComponents(input({ flow: parent("child") }), { home, everything: true }).refs.map((r) => r.id)).toContain("child");
    const missing = runComponents(input({ flow: parent("nothing-here") }), { home, everything: true });
    expect(missing.unloaded).toEqual([{ kind: "flow", id: "nothing-here", show: "nothing-here" }]);
  });

  it("gives the context selector the hash of a file with the same settings", () => {
    const cfg = config();
    put("context-selectors/default.yaml", JSON.stringify(contextSelectorInput(cfg.context)));
    const fromFile = readHomeComponents(home).found.find((c) => c.kind === "context-selector" && c.id === "default");
    const ref = runComponents(input({ config: cfg }), { home, everything: true }).refs.find((r) => r.kind === "context-selector");
    expect(ref?.sha256).toBe(contextSelectorSha256(contextSelectorInput(cfg.context)));
    if (fromFile) expect(fromFile.sha256).toBe(ref?.sha256);
  });

  it("refuses a retired generated tool profile when the run has no declared profile", () => {
    const agent = parseFlow("name: Agent\nworkspace: empty\nsteps:\n  - {id: a, type: claude, prompt: hi}\n");
    const parts = governedComponents(input({ flow: agent }), { home });
    expect(parts.find((c) => c.kind === "tool-profile")).toMatchObject({ id: "generated.flow-settings", show: "generated.flow-settings" });
    gov({ "tool-profile/generated.flow-settings": { lifecycle: "retired" } });
    const d = governanceGate(input({ flow: agent }), { home, now: NOW });
    expect(d.outcome).toBe("refused");
    expect(d.reason).toBe("refused: tool-profile generated.flow-settings is retired; stop using it, or change its lifecycle in promotions/governance.yaml");
    // a declared profile replaces the generated ones: they are not collected
    expect(governedComponents(input({ flow: agent, toolProfile: { version: 1 } }), { home }).some((c) => c.kind === "tool-profile" && c.id === "generated.flow-settings")).toBe(false);
  });

  it("refuses a bad governance file without listing components", () => {
    put("promotions/governance.yaml", "components: [SECRET\n");
    const d = governanceGate(input(), { home, now: NOW });
    expect(d).toMatchObject({ outcome: "refused", failure: "book-unreadable", components: [] });
    expect(JSON.stringify(d)).not.toContain("SECRET");
  });
});

describe("runFlow", () => {
  const PROBE = 'git clone -q "$FAKE_GH_REMOTE" w && cd w && git checkout -q -b probe && git commit --allow-empty -qm probe && git push -q origin probe';
  const remoteBranches = () => execFileSync("git", ["-C", gh.remote, "branch", "--list", "probe"], { encoding: "utf8" }).trim();
  const start = (vars: Record<string, string> | undefined, extra: { localTest?: boolean; flowId?: string } = {}, run = PROBE) =>
    runFlow(parseFlow(shell("Deploy", run)), { task: "t", repo: base, runsDir: join(base, "runs"), config: config(), vars, frozenVars: true, flowId: "deploy", ...extra });
  const lines = (summary: { runDir: string }) => readFileSync(join(summary.runDir, "live.log"), "utf8");

  it("allows a production run and records the decision", async () => {
    const s = await start({ github_repo: "acme/app" });
    expect(s.status).toBe("succeeded");
    expect(remoteBranches()).toContain("probe");
    const d = decided(s.runDir);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ outcome: "allowed" });
    expect(d[0]!.components.map((c) => c.kind)).toEqual(expect.arrayContaining(["flow", "policy-pack", "model-routes", "context-selector"]));
  });

  it("refuses a retired component before a workspace exists, with no file content", async () => {
    gov({ "flow/deploy": { lifecycle: "retired", owner: "SECRET-OWNER" } });
    const s = await start({ github_repo: "acme/app" });
    expect(s).toMatchObject({ status: "failed", reason: "refused: flow deploy is retired; stop using it, or change its lifecycle in promotions/governance.yaml" });
    expect(s.workdir).toBeUndefined();
    expect(remoteBranches()).toBe("");
    expect(gh.ghLog()).not.toContain("pr create");
    const d = decided(s.runDir);
    expect(d[0]).toMatchObject({ outcome: "refused", components: expect.arrayContaining([{ kind: "flow", id: "deploy", version: "0", status: "retired", refused: true }]) });
    const text = readFileSync(join(s.runDir, "evidence.jsonl"), "utf8") + lines(s);
    expect(text).not.toContain("SECRET-OWNER");
    expect(lines(s)).toContain("! governance: flow deploy is retired");
  });

  it("refuses a high-risk component that is not approved, and a shipped component through its record", async () => {
    gov({ "model-routes/default": { risk: "high", approved_version: "9" } });
    const s = await start({ github_repo: "acme/app" });
    expect(s.status).toBe("failed");
    expect(s.reason).toMatch(/^refused: model-routes default is high risk and has no recorded version; run scf components record model-routes/);
    gov({ "policy-pack/foundry.baseline": { lifecycle: "retired" } });
    expect((await start({ github_repo: "acme/app" })).reason).toContain("policy-pack foundry.baseline is retired");
  });

  it("refuses a production run on a broken governance file, but leaves a development run alone", async () => {
    put("promotions/governance.yaml", "components: [SECRET\n");
    const s = await start({ github_repo: "acme/app" });
    expect(s.status).toBe("failed");
    expect(s.reason).toMatch(/^refused: the governance file cannot be used/);
    expect(decided(s.runDir)[0]).toMatchObject({ outcome: "refused", failure: "book-unreadable", components: [] });
    const dev = await start(undefined, {}, "true");
    expect(dev.status).toBe("succeeded");
    expect(decided(dev.runDir)).toEqual([]);
    expect(lines(dev)).not.toMatch(/[!·] governance:/);
    const placeholder = await start({ github_repo: "owner/repo" }, {}, "true");
    expect(placeholder.status).toBe("succeeded");
  });

  it("still refuses a local test that can reach a repository", async () => {
    gov({ "flow/deploy": { lifecycle: "retired" } });
    const s = await start({ github_repo: "acme/app" }, { localTest: true });
    expect(s.status).toBe("failed");
    expect(s.reason).toContain("flow deploy is retired");
  });

  it("refuses a production run when the gate cannot be loaded", async () => {
    vi.resetModules();
    vi.doMock("../src/promotion/gate.js", () => {
      throw new Error("no gate");
    });
    const runner = await import("../src/engine/runner.js");
    const s = await runner.runFlow(parseFlow(shell("Deploy", "true")), { task: "t", repo: base, runsDir: join(base, "runs"), config: config(), vars: { github_repo: "acme/app" }, frozenVars: true });
    expect(s).toMatchObject({ status: "failed", reason: "refused: the governance check could not run; check promotions/governance.yaml with scf components, then start the run again" });
    expect(decided(s.runDir)[0]).toMatchObject({ outcome: "refused", failure: "check-failed" });
  });

  it("resumes a run saved without its id under the file id, not the display name", async () => {
    // the file is deploy.yaml, the flow's name is Deploy: a run saved before flowId existed must still be checked as flow deploy
    const text = "name: Deploy\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: \"false\"}\n";
    put("flows/deploy.yaml", text);
    const runsDir = join(base, "runs");
    const first = await runFlow(parseFlow(text), { task: "t", repo: base, runsDir, config: config(), vars: { github_repo: "acme/app" }, frozenVars: true });
    expect(first.status).toBe("failed");
    const file = join(first.runDir, "run.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved.flowId).toBe("deploy");
    delete saved.flowId;
    writeFileSync(file, JSON.stringify(saved));
    gov({ "flow/deploy": { lifecycle: "retired" } });
    const refused = await resumeRun({ runsDir, runId: first.runId, config: config(), from: "a" });
    expect(refused).toMatchObject({ status: "failed", flowId: "deploy" });
    expect(refused.reason).toBe("refused: flow deploy is retired; stop using it, or change its lifecycle in promotions/governance.yaml");
  });

  it("refuses a resume when a component became retired, and goes on once the record is fixed", async () => {
    const runsDir = join(base, "runs");
    const flow = parseFlow(`name: Deploy\nworkspace: empty\nsteps:\n  - {id: a, type: shell, run: "false"}\n  - {id: b, type: shell, run: "touch ${join(base, "second")}"}\n`);
    const first = await runFlow(flow, { task: "t", repo: base, runsDir, config: config(), vars: { github_repo: "acme/app" }, frozenVars: true, flowId: "deploy" });
    expect(first.status).toBe("failed");
    expect(loadRun(runsDir, first.runId)?.flowId).toBe("deploy");
    gov({ "flow/deploy": { lifecycle: "retired" } });
    const refused = await resumeRun({ runsDir, runId: first.runId, config: config(), from: "b" });
    expect(refused).toMatchObject({ status: "failed" });
    expect(refused.reason).toContain("flow deploy is retired");
    expect(existsSync(join(base, "second"))).toBe(false);
    expect(refused.state.next).toBe(first.state.next);
    gov({});
    const ok = await resumeRun({ runsDir, runId: first.runId, config: config(), from: "b" });
    expect(ok.status).toBe("succeeded");
    expect(existsSync(join(base, "second"))).toBe(true);
    expect(decided(ok.runDir).map((e) => e.outcome)).toEqual(["allowed", "refused", "allowed"]);
  });
});

describe("Scheduler", () => {
  const job = (vars: Record<string, string> = { github_repo: "acme/app" }): Job => ({ kind: "run", flow: parseFlow(shell("Deploy", "true")), task: "t", repo: base, vars, frozenVars: true });
  const make = (opts: { localTest?: boolean; enforce?: "off" | "warn" | "on" } = {}) =>
    new Scheduler({ runsDir: join(base, "runs"), queueFile: join(base, "queue.json"), config: () => config({ promotion: { enforce: opts.enforce ?? "off" } }), ...(opts.localTest ? { localTest: true } : {}) });
  const saved = (id: string) => JSON.parse(readFileSync(join(base, "runs", id, "run.json"), "utf8"));

  it("exempts runs of the eval option, also on resume", async () => {
    gov({ "model-routes/default": { lifecycle: "retired" } });
    const s = make({ localTest: true });
    const id = s.submit(job(), { source: "ui" });
    await s.idle();
    expect(saved(id)).toMatchObject({ status: "succeeded", localTest: true });
    expect(decided(join(base, "runs", id))).toEqual([]);
    s.submit({ kind: "resume", runId: id, from: "a" }, { source: "ui" });
    await s.idle();
    expect(saved(id).status).toBe("succeeded");
    expect(decided(join(base, "runs", id))).toEqual([]);
  });

  it("ignores an evalRun or localTest key in a job or its meta", async () => {
    gov({ "model-routes/default": { lifecycle: "retired" } });
    const s = make();
    const id = s.submit({ ...job(), evalRun: true, localTest: true } as Job, { source: "ui", evalRun: true, localTest: true } as never);
    await s.idle();
    expect(saved(id)).toMatchObject({ status: "failed" });
    expect(saved(id).reason).toContain("model-routes default is retired");
  });

  it("checks a custom flow under its file id even with promotion.enforce off", async () => {
    put("flows/deploy.yaml", shell("Deploy", "true"));
    gov({ "flow/deploy": { lifecycle: "retired" } });
    const s = make({ enforce: "off" });
    const id = s.submit(job(), { source: "ui" });
    await s.idle();
    expect(saved(id)).toMatchObject({ status: "failed", flowId: "deploy" });
    expect(saved(id).reason).toContain("flow deploy is retired");
  });
});

describe("flow hashing stays stable", () => {
  it("does not change the flow hash with a record", () => {
    const f = parseFlow(shell("Deploy", "true"));
    const before = flowSha256(f);
    gov({ "flow/deploy": { lifecycle: "retired" } });
    expect(flowSha256(f)).toBe(before);
  });
});
