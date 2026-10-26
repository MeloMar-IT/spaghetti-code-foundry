import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, type Config } from "../src/config.js";
import { resumeRun, runFlow, type RunSummary } from "../src/engine/runner.js";
import { shellSandboxed } from "../src/engine/step-facts.js";
import { parseEvidenceEventLine } from "../src/evidence/parse.js";
import type { EvidenceEvent } from "../src/evidence/schema.js";
import { parseFlow } from "../src/flow/load.js";
import { BASELINE_POLICY_ID } from "../src/policy/baseline.js";

const claudeBin = resolve("tests/fixtures/fake-claude.mjs");
const config = (): Config => ConfigSchema.parse({ protected_branches: [] });
let tmp: string;
let repo: string;
let runsDir: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "ignore" });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "paths-run-"));
  repo = join(tmp, "repo");
  runsDir = join(tmp, "runs");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "first");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const flowYaml = (workspace: string, steps: string) => `name: pf\nworkspace: ${workspace}\nvars: { forbidden_paths: "" }\nsteps:\n${steps}`;
const sh = (id: string, run: string) => `  - {id: ${id}, type: shell, run: ${JSON.stringify(run)}}\n`;
const start = (yaml: string, forbidden?: string, extra: Record<string, unknown> = {}) =>
  runFlow(parseFlow(yaml), { task: "t", repo, runsDir, claudeBin, config: config(), ...(forbidden !== undefined ? { vars: { forbidden_paths: forbidden } } : {}), ...extra });

type Decided = Extract<EvidenceEvent, { type: "policy.decided" }>;
const baseline = (s: Pick<RunSummary, "runDir">): Decided[] =>
  readFileSync(join(s.runDir, "evidence.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => parseEvidenceEventLine(l))
    .filter((e): e is Decided => e.type === "policy.decided" && e.decision.policy.id === BASELINE_POLICY_ID);
/** What the baseline said at one boundary for one step (the last visit). */
const said = (s: Pick<RunSummary, "runDir">, boundary: string, step: string) => baseline(s).filter((e) => e.decision.boundary === boundary && e.step?.id === step).at(-1)?.decision;
const runJson = (s: Pick<RunSummary, "runDir">) => JSON.parse(readFileSync(join(s.runDir, "run.json"), "utf8")) as RunSummary;

describe("the path.forbidden rule over a run", () => {
  it("records a changed forbidden file after the step that wrote it, and after the later steps", async () => {
    const s = await start(flowYaml("inplace", sh("say", "echo hi") + sh("edit", "mkdir -p secret && echo x > secret/a.txt") + sh("later", "echo again")), "secret/*");
    expect(s.status).toBe("succeeded");
    expect(said(s, "step.after", "say")?.reasonCode).toBe("policy.no-rule-matched");
    expect(said(s, "step.after", "edit")).toMatchObject({ outcome: "deny", reasonCode: "path.forbidden", mode: "observe" });
    expect(said(s, "step.after", "later")?.reasonCode).toBe("path.forbidden");
    // the first shell step is also asked before it runs, and a step without a sandbox fact is never incomplete
    expect(said(s, "step.before", "say")?.reasonCode).not.toBe("policy.input-incomplete");
  });

  it("finds a change outside the subfolder the run works in", async () => {
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", ".keep"), "");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "sub");
    const s = await start(flowYaml("inplace", sh("edit", "mkdir -p ../secret && echo x > ../secret/a.txt")), "secret/*", { repo: join(repo, "sub") });
    expect(s.status).toBe("succeeded");
    expect(said(s, "step.after", "edit")?.reasonCode).toBe("path.forbidden");
  });

  it("records nothing about paths without the variable", async () => {
    const s = await start(flowYaml("inplace", sh("edit", "mkdir -p secret && echo x > secret/a.txt")));
    expect(s.status).toBe("succeeded");
    for (const e of baseline(s)) {
      expect(e.decision.reasonCode).not.toBe("path.forbidden");
      expect(e.decision.reasonCode).not.toBe("policy.input-incomplete");
    }
  });

  it("is incomplete in an empty workspace until the checkout has a base", async () => {
    const init = "git init -q && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m c";
    const edit = "echo x > secret.txt && git add secret.txt && git -c user.name=t -c user.email=t@example.com commit -q -m s";
    const s = await start(flowYaml("empty", sh("pre", "echo hi") + sh("clone", init) + sh("edit", edit)), "secret.txt");
    expect(s.status).toBe("succeeded");
    expect(said(s, "step.after", "pre")?.reasonCode).toBe("policy.input-incomplete");
    expect(said(s, "step.after", "clone")?.reasonCode).toBe("policy.input-incomplete");
    expect(said(s, "step.after", "edit")?.reasonCode).toBe("path.forbidden");
    const saved = runJson(s);
    expect(saved.pathsTracked).toBe(true);
    expect(saved.pathsBaseSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("stays incomplete after a resume that finds a checkout without a base", async () => {
    const init = "git init -q && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m c";
    const edit = "echo x > secret.txt && git add secret.txt && git -c user.name=t -c user.email=t@example.com commit -q -m s";
    const yaml = flowYaml("empty", sh("clone", init) + sh("edit", edit));
    const s = await start(yaml, "secret.txt");
    const file = join(s.runDir, "run.json");
    // as if the run had stopped after the clone step, before its base was written
    const old = runJson(s);
    delete old.pathsBaseSha;
    old.status = "failed";
    old.state = { ...old.state!, next: "edit" };
    old.history = old.history.slice(0, 1);
    writeFileSync(file, JSON.stringify(old));
    rmSync(join(old.workdir!, "secret.txt"));
    git(old.workdir!, "reset", "-q", "--hard", "HEAD~1");
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: config() });
    expect(r.status).toBe("succeeded");
    expect(said(r, "step.after", "edit")?.reasonCode).toBe("policy.input-incomplete");
    expect(runJson(r).pathsBaseLost).toBe(true);
  });

  it("stays incomplete for a run started before paths were tracked", async () => {
    const yaml = flowYaml("inplace", sh("a", "echo a") + sh("edit", "mkdir -p secret && echo x > secret/a.txt"));
    const s = await start(yaml, "secret/*");
    const old = runJson(s);
    delete old.pathsTracked;
    old.status = "failed";
    old.state = { ...old.state!, next: "edit" };
    old.history = old.history.slice(0, 1);
    writeFileSync(join(s.runDir, "run.json"), JSON.stringify(old));
    const r = await resumeRun({ runId: s.runId, runsDir, claudeBin, config: config() });
    expect(said(r, "step.after", "edit")?.reasonCode).toBe("policy.input-incomplete");
  });

  it("asks the sub steps of a parallel step too", async () => {
    const yaml = flowYaml("inplace", `  - {id: both, type: parallel, steps: [w, o]}\n  - {id: w, type: shell, run: "echo x > secret.txt", jump_only: true}\n  - {id: o, type: shell, run: "echo o", jump_only: true}\n`);
    const s = await start(yaml, "secret.txt");
    expect(s.status).toBe("succeeded");
    expect(said(s, "step.after", "w")?.reasonCode).toBe("path.forbidden");
    expect(said(s, "step.after", "both")?.reasonCode).toBe("path.forbidden");
  });

  it("never records a baseline input-incomplete at step.before for an agent step", async () => {
    const s = await start(flowYaml("inplace", `  - {id: w, type: claude, prompt: "WRITE out.txt hello"}\n` + sh("x", "echo x")), "secret/*");
    expect(said(s, "step.before", "w")?.reasonCode).not.toBe("policy.input-incomplete");
    expect(said(s, "step.before", "x")?.reasonCode).not.toBe("policy.input-incomplete");
  });
});

describe("shellSandboxed", () => {
  const engine = (owner?: string) => ({ summary: { owner }, config: config() }) as never;
  const scope = (image?: string) => ({ flow: { sandbox: { docker_image: image } } }) as never;

  it("is false without the OS sandbox or an image, and true with an image", () => {
    expect(shellSandboxed(engine("user-1"), scope(), { type: "shell" })).toBe(false);
    expect(shellSandboxed(engine(), scope(), { type: "shell" })).toBe(false);
    expect(shellSandboxed(engine("user-1"), scope("img"), { type: "shell", sandbox: true })).toBe(true);
    expect(shellSandboxed(engine("user-1"), scope("img"), { type: "shell" })).toBe(false);
  });

  it("is undefined for a step that is not a shell step", () => {
    expect(shellSandboxed(engine(), scope(), { type: "claude" })).toBeUndefined();
    expect(shellSandboxed(engine(), scope(), { type: "approval" })).toBeUndefined();
  });
});
