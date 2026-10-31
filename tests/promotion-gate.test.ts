import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { ConfigSchema } from "../src/config.js";
import { expectedResultKeys, homeInputs, type EvalInputs } from "../src/eval-inputs.js";
import { LOCAL_TEST_LINE, PROMOTION_REFUSED } from "../src/engine/state.js";
import { runFlow } from "../src/engine/runner.js";
import { loadSuite, SAFETY_DIR } from "../src/evals.js";
import { FACTORY_HOME, parseFlow } from "../src/flow/load.js";
import { describeSettings } from "../src/settings/describe.js";
import { flowFileId, Scheduler, type Job } from "../src/queue/scheduler.js";
import { displayId, findingLine, promotionGate, runComponents, type GateInput } from "../src/promotion/gate.js";
import { componentBlock, currentSuiteInputs, suiteVerdict } from "../src/promotion/promote.js";
import { modelRoutesSha256 } from "../src/promotion/components.js";
import { SAFETY_CATALOGUE } from "../src/promotion/required-suites.js";
import { recordVersions } from "../src/promotion/versions.js";
import { coverPack } from "./fixtures/policy-pack.js";

const shell = (name: string, run = "true", extra = "") => `name: ${name}\nworkspace: empty\n${extra}steps:\n  - {id: a, type: shell, run: "${run}"}\n`;
const child = (name: string, ref: string) => `name: ${name}\nworkspace: empty\nsteps:\n  - {id: a, type: flow, flow: ${ref}}\n`;
const STAMP = "2026-01-01T00-00-00-000Z";
const open = { dataClassification: "internal", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none" };
const profile = (id: string) => ({ version: 1, profile: { id, version: "1" }, grants: [{ kind: "files", operations: ["read"], targets: ["src/*"], ...open }] });

let base: string;
let home: string;
let repo: string;
let evals: string;
let safety: string;

const put = (rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const putRepoFlow = (name: string, text: string) => {
  mkdirSync(join(repo, ".claude-factory", "flows"), { recursive: true });
  writeFileSync(join(repo, ".claude-factory", "flows", `${name}.yaml`), text);
};
const config = (enforce?: "off" | "warn" | "on") => ConfigSchema.parse(enforce ? { promotion: { enforce } } : {});

/** Reports as `runEval` writes them, for the state of the folders now. */
function reportAll(): void {
  for (const name of SAFETY_CATALOGUE) {
    const suitePath = join(safety, name, "suite.yaml");
    const suite = loadSuite(suitePath);
    const inputs: EvalInputs = { version: 1, live: false, ...currentSuiteInputs(suitePath, suite), components: homeInputs(home) };
    const results = expectedResultKeys(suite, inputs).map((k) => {
      const [variant, c, attempt] = k.split("|");
      return { variant, case: c, attempt: Number(attempt), passed: true };
    });
    mkdirSync(evals, { recursive: true });
    writeFileSync(join(evals, `${name}-${STAMP}.json`), JSON.stringify({ suite: name, startedAt: "x", finishedAt: "y", inputs, results, summary: [] }));
  }
}
const recordRoutes = () => recordVersions([{ kind: "model-routes", id: "default", sha256: modelRoutesSha256(config().router) }]);

const input = (flowText: string, flowId: string, extra: Partial<GateInput> = {}): GateInput => ({
  flow: parseFlow(flowText),
  flowId,
  repo,
  vars: {},
  config: config(),
  ...extra,
});
const gate = (i: GateInput) => promotionGate(i, { home, evalsDir: evals, safetyDir: safety });
const codes = (r: { findings: { kind: string; id: string; code: string }[] }) => r.findings.map((f) => `${f.kind} ${f.id} ${f.code}`);

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "gate-test-"));
  home = FACTORY_HOME; // the flow folders read this constant: the folder tests/setup.ts made
  repo = join(base, "repo");
  evals = join(home, "evals");
  safety = join(base, "safety");
  mkdirSync(repo);
  cpSync(SAFETY_DIR, safety, { recursive: true });
  put("flows/deploy.yaml", shell("Deploy application"));
});
afterEach(() => {
  for (const d of ["flows", "policies", "tool-profiles", "evals", "promotions", "config.yaml"]) rmSync(join(home, d), { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

describe("suiteVerdict and componentBlock", () => {
  it("answers suite-missing with no report, without loading the suite file", () => {
    writeFileSync(join(safety, "timeout", "suite.yaml"), "this: [is not: valid");
    expect(suiteVerdict("timeout", { live: false, evalsDir: evals, safetyDir: safety })).toEqual({ block: { code: "suite-missing" } });
    expect(suiteVerdict("timeout", { live: false, evalsDir: evals, safetyDir: join(base, "none") })).toEqual({ block: { code: "suite-missing", detail: "suite file" } });
  });

  it("reports a stale component for a missing kind, id or another hash", () => {
    reportAll();
    const v = suiteVerdict("timeout", { live: false, evalsDir: evals, safetyDir: safety });
    expect(v.block).toBeUndefined();
    const flow = homeInputs(home).find((c) => c.kind === "flow" && c.id === "deploy")!;
    expect(componentBlock({ kind: "flow", id: "deploy", sha256: flow.sha256 }, v)).toBeUndefined();
    expect(componentBlock({ kind: "flow", id: "deploy", sha256: "0".repeat(64) }, v)).toEqual({ code: "report-stale", detail: "flow deploy" });
    expect(componentBlock({ kind: "flow", id: "nope", sha256: flow.sha256 }, v)?.code).toBe("report-stale");
  });
});

describe("promotionGate", () => {
  it("finds an unpromoted custom flow and unrecorded model routes when nothing was reported", () => {
    const r = gate(input(shell("Deploy application"), "deploy"));
    expect(r.promoted).toBe(false);
    expect(codes(r)).toEqual(["flow deploy suite-missing", "model-routes default unrecorded"]);
    expect(r.findings.map(findingLine)).toEqual([
      "! flow deploy v0 is not promoted: approval-bypass (suite-missing) — scf eval safety",
      "! model-routes default v- is not promoted: (unrecorded) — scf components record model-routes",
    ]);
  });

  it("is promoted when every suite passed and the version book holds the routes", () => {
    recordRoutes();
    reportAll();
    const r = gate(input(shell("Deploy application"), "deploy"));
    expect(r).toMatchObject({ promoted: true, findings: [] });
    expect(r.components.map((c) => `${c.kind} ${c.id} v${c.version}`)).toEqual(["flow deploy v0", "model-routes default v1"]);
  });

  it("names the file, not the flow's name; the wrong id is stale", () => {
    recordRoutes();
    reportAll();
    expect(codes(gate(input(shell("Deploy application"), "Deploy application")))).toEqual(["flow Deploy_application report-stale"]);
  });

  it("gives no ref for an unchanged built-in flow or the baseline pack", () => {
    const text = readFileSync(resolve("flows", readdirSync(resolve("flows")).find((f) => f.endsWith(".yaml"))!), "utf8");
    const { refs } = runComponents(input(text, "x"), { home });
    expect(refs.map((r) => r.kind)).toEqual(["model-routes"]);
  });

  it("checks the packs of the run's repository only; a missing pack is a problem", () => {
    put("policies/cover.json", JSON.stringify(coverPack("cover", "1.4.0")));
    const cfg = ConfigSchema.parse({ policy: { repositories: { "acme/app": ["cover"], "acme/other": ["gone"] } } });
    const at = (repoName: string) => runComponents(input(shell("x"), "x", { config: cfg, vars: { github_repo: repoName } }), { home });
    expect(at("acme/app").refs.map((r) => `${r.kind} ${r.id} v${r.version}`)).toContain("policy-pack cover v1.4.0");
    expect(at("acme/none").refs.map((r) => r.kind)).not.toContain("policy-pack");
    expect(at("acme/other").problems.map((p) => `${p.kind} ${p.id} ${p.code}`)).toEqual(["policy-pack gone problem"]);
  });

  it("reports a flow edited after the reports", () => {
    recordRoutes();
    reportAll();
    expect(codes(gate(input(shell("Deploy application", "echo changed"), "deploy")))).toEqual(["flow deploy report-stale"]);
  });

  it("reports a changed child alone, a child that cannot load, and survives a self-reference", () => {
    put("flows/parent.yaml", child("parent", "kid"));
    put("flows/kid.yaml", shell("kid"));
    putRepoFlow("kid", shell("kid"));
    recordRoutes();
    reportAll();
    const parent = child("parent", "kid");
    // the folder's flow shadows the home flow: it is a different, unpromoted definition
    putRepoFlow("kid", shell("kid", "echo changed"));
    expect(codes(gate(input(parent, "parent")))).toEqual(["flow kid report-stale"]);
    expect(codes(gate(input(child("parent", "gone/../x"), "parent")))).toContain("flow gone_.._x not-found");
    putRepoFlow("self", child("self", "self"));
    expect(() => gate(input(child("self", "self"), "self"))).not.toThrow();
  });

  it("reports the child of a flow reached by a deep and a shallow route", () => {
    putRepoFlow("d", child("d", "leaf"));
    putRepoFlow("leaf", shell("leaf", "echo leaf"));
    putRepoFlow("mid", child("mid", "d"));
    putRepoFlow("top", `name: top\nworkspace: empty\nsteps:\n  - {id: a, type: flow, flow: mid}\n  - {id: b, type: flow, flow: d}\n`);
    const r = runComponents(input(child("root", "top"), "root"), { home });
    expect(r.refs.filter((x) => x.kind === "flow").map((x) => x.id)).toEqual(["root", "top", "mid", "d", "leaf"]);
  });

  it("shows only sanitized ids and never a path", () => {
    expect(displayId("../../etc/x\nINJECT")).toBe(".._.._etc_x_INJECT");
    expect(displayId("")).toBe("(unnamed)");
    expect(displayId("a".repeat(100))).toHaveLength(60);
    const r = gate(input(shell("../../etc/x\\nINJECT"), "../../etc/x\nINJECT"));
    for (const f of r.findings) {
      const line = findingLine(f);
      expect(line).not.toContain("\n");
      expect(line).not.toContain(base);
      expect(line).not.toContain("/etc");
    }
  });

  it("checks a declared tool profile; a null snapshot is a problem", () => {
    put("tool-profiles/good.yaml", stringify(profile("good")));
    const p = profile("good");
    expect(runComponents(input(shell("x"), "x", { toolProfile: p }), { home }).refs.map((r) => `${r.kind} ${r.id}`)).toContain("tool-profile good");
    recordVersions([{ kind: "tool-profile", id: "good", sha256: runComponents(input(shell("x"), "x", { toolProfile: p }), { home }).refs.find((r) => r.kind === "tool-profile")!.sha256 }]);
    recordRoutes();
    reportAll();
    expect(codes(gate(input(shell("Deploy application"), "deploy", { toolProfile: p })))).toEqual([]);
    expect(codes(gate(input(shell("Deploy application"), "deploy", { toolProfile: { broken: true } })))).toEqual(["tool-profile (declared) problem"]);
  });

  it("blocks counted components when versions.json is invalid", () => {
    put("promotions/versions.json", "not json");
    expect(codes(gate(input(shell("Deploy application"), "deploy")))).toContain("model-routes default versions-invalid");
  });

  it("never throws: a config without router gives one problem finding", () => {
    const r = gate(input(shell("x"), "x", { config: {} as never }));
    expect(codes(r)).toEqual(["flow x problem"]);
    expect(findingLine(r.findings[0]!)).toBe("! flow x v- is not promoted: (problem) — scf components flow");
  });
});

describe("runFlow", () => {
  const marker = () => join(base, "ran");
  const flowText = () => shell("Deploy application", `touch ${marker()}`);
  const start = async (enforce: "off" | "warn" | "on", extra: { localTest?: boolean } = {}) => {
    const lines: string[] = [];
    const summary = await runFlow(parseFlow(flowText()), { task: "t", repo, runsDir: join(base, "runs"), config: config(enforce), flowId: "deploy", log: (m) => lines.push(m), ...extra });
    return { summary, lines, saved: JSON.parse(readFileSync(join(summary.runDir, "run.json"), "utf8")) };
  };

  it("off: no lines and no promotion key", async () => {
    const r = await start("off");
    expect(r.summary.status).toBe("succeeded");
    expect(r.lines.some((l) => l.includes("is not promoted"))).toBe(false);
    expect(r.saved.promotion).toBeUndefined();
    expect(r.saved.localTest).toBeUndefined();
  });

  it("warn: logs the findings, saves them and goes on", async () => {
    const r = await start("warn");
    expect(r.summary.status).toBe("succeeded");
    expect(r.lines).toContain("! flow deploy v0 is not promoted: approval-bypass (suite-missing) — scf eval safety");
    expect(r.saved.promotion).toMatchObject({ enforce: "warn", promoted: false });
    expect(existsSync(marker())).toBe(true);
  });

  it("on: ends failed before a workspace is made, naming --local-test", async () => {
    const r = await start("on");
    expect(r.summary).toMatchObject({ status: "failed", reason: PROMOTION_REFUSED });
    expect(PROMOTION_REFUSED).toContain("--local-test");
    expect(r.summary.workdir).toBeUndefined();
    expect(existsSync(marker())).toBe(false);
  });

  it("on with a local test: allowed, saved and logged once", async () => {
    const r = await start("on", { localTest: true });
    expect(r.summary.status).toBe("succeeded");
    expect(r.saved.localTest).toBe(true);
    expect(r.saved.promotion).toBeUndefined();
    expect(r.lines.filter((l) => l === LOCAL_TEST_LINE)).toHaveLength(1);
  });
});

describe("Scheduler", () => {
  const job = (): Job => ({ kind: "run", flow: parseFlow(shell("Deploy application", "true")), task: "t", repo, vars: {} });
  const finish = async (s: Scheduler, j: Job) => {
    const id = s.submit(j, { source: "ui" });
    await s.idle();
    return JSON.parse(readFileSync(join(base, "runs", id, "run.json"), "utf8"));
  };
  const make = (enforce: "off" | "warn" | "on", localTest?: boolean) =>
    new Scheduler({ runsDir: join(base, "runs"), queueFile: join(base, "queue.json"), config: () => config(enforce), ...(localTest ? { localTest } : {}) });

  it("the constructor option makes runs local tests", async () => {
    const saved = await finish(make("on", true), job());
    expect(saved).toMatchObject({ status: "succeeded", localTest: true });
  });

  it("a localTest key in the job or its meta is ignored", async () => {
    const j = { ...job(), localTest: true } as Job;
    const s = make("on");
    const id = s.submit(j, { source: "ui", localTest: true } as never);
    await s.idle();
    const saved = JSON.parse(readFileSync(join(base, "runs", id, "run.json"), "utf8"));
    expect(saved.localTest).toBeUndefined();
    expect(saved).toMatchObject({ status: "failed", reason: PROMOTION_REFUSED });
  });

  it("checks a file of the data folder as its file name", async () => {
    const saved = await finish(make("warn"), { ...job(), flow: parseFlow(shell("Deploy application")) });
    expect(saved.promotion.findings[0]).toMatchObject({ kind: "flow", id: "deploy" });
  });

  it("flowFileId finds the file by content, skips broken files and is stable", () => {
    expect(flowFileId(parseFlow(shell("Deploy application")), repo)).toBe("deploy");
    expect(flowFileId(parseFlow(shell("elsewhere")), repo)).toBeUndefined();
    putRepoFlow("b-copy", shell("copy"));
    putRepoFlow("a-copy", shell("copy"));
    putRepoFlow("broken", "steps: [");
    expect(flowFileId(parseFlow(shell("copy")), repo)).toBe("a-copy");
    // a file edited after the job was built no longer matches: the id falls back to the flow's name
    putRepoFlow("a-copy", shell("copy", "echo edited"));
    putRepoFlow("b-copy", shell("copy", "echo edited"));
    expect(flowFileId(parseFlow(shell("copy")), repo)).toBeUndefined();
  });

  it("skips a FIFO and an oversized file: neither blocks the lookup nor matches", () => {
    // a FIFO named like a flow would block a plain read until a writer appears; the lookup must go on past it
    mkdirSync(join(home, "flows"), { recursive: true });
    expect(spawnSync("mkfifo", [join(home, "flows", "a.yaml")]).status).toBe(0);
    // the same content as the flow below, but over the size limit: sorted first, so it would win if it were read
    writeFileSync(join(home, "flows", "b.yaml"), `# ${"x".repeat(2 << 20)}\n${shell("copy")}`);
    putRepoFlow("c", shell("copy"));
    expect(flowFileId(parseFlow(shell("copy")), repo)).toBe("c");
  });

  it("keeps the id of a job that waits while its file is edited", async () => {
    recordRoutes();
    reportAll();
    const queueFile = join(base, "queue-wait.json");
    const s = new Scheduler({ runsDir: join(base, "runs"), queueFile, config: () => config("on") });
    s.drain();
    const id = s.submit({ kind: "run", flow: parseFlow(shell("Deploy application")), task: "t", repo, vars: {} }, { source: "ui" });
    expect(JSON.parse(readFileSync(queueFile, "utf8"))[0].flowId).toBe("deploy");
    // the promoted definition is still the one the job holds; the file now says something else
    put("flows/deploy.yaml", shell("Deploy application", "echo changed"));
    s.resume();
    await s.idle();
    const saved = JSON.parse(readFileSync(join(base, "runs", id, "run.json"), "utf8"));
    expect(saved).toMatchObject({ status: "succeeded", promotion: { promoted: true } });
  });

  it("only evals.ts and skill-eval/run.ts set the option", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts") && /new Scheduler\([^)]*localTest/.test(readFileSync(p, "utf8"))) hits.push(p.slice(resolve("src").length + 1));
      }
    };
    walk(resolve("src"));
    expect(hits.sort()).toEqual(["evals.ts", join("skill-eval", "run.ts")]);
  });
});

describe("settings and CLI", () => {
  it("describes promotion.enforce with default warn and effect new-runs", () => {
    expect(describeSettings().find((s) => s.key === "promotion.enforce")).toMatchObject({ default: "warn", effect: "new-runs", control: "generated" });
    expect(ConfigSchema.parse({}).promotion.enforce).toBe("warn");
    expect(() => ConfigSchema.parse({ promotion: { enforce: "maybe" } })).toThrow();
  });

  it("scf run refuses under on and --local-test allows it", () => {
    const flowFile = join(base, "plain.yaml");
    writeFileSync(flowFile, shell("plain"));
    writeFileSync(join(home, "config.yaml"), "promotion:\n  enforce: on\n");
    const cli = resolve("dist/cli.js");
    const run = (extra: string[]) => spawnSync(process.execPath, [cli, "run", flowFile, "--repo", repo, "--runs-dir", join(base, "cli-runs"), ...extra], { encoding: "utf8", env: { ...process.env, FACTORY_HOME: home } });
    const refused = run([]);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain("--local-test");
    const ok = run(["--local-test"]);
    expect(ok.status).toBe(0);
    const id = readdirSync(join(base, "cli-runs")).find((d) => JSON.parse(readFileSync(join(base, "cli-runs", d, "run.json"), "utf8")).status === "succeeded")!;
    expect(JSON.parse(readFileSync(join(base, "cli-runs", id, "run.json"), "utf8")).localTest).toBe(true);
  });
});
