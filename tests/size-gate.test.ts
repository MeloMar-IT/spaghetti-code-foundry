import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseFlow } from "../src/flow/load.js";
import { flowPath } from "./helpers/fake-github.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "size-gate-"));
  mkdirSync(join(home, "bin"));
  symlinkSync(resolve("tests/fixtures/fake-gh.sh"), join(home, "bin", "gh"));
  chmodSync(resolve("tests/fixtures/fake-gh.sh"), 0o755);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const flow = () => parseFlow(readFileSync(flowPath("issue-gitflow"), "utf8"), flowPath("issue-gitflow"));
const stepOf = (id: string) => {
  const s = flow().steps.find((x) => x.id === id);
  if (!s) throw new Error(id);
  return s;
};
const runOf = (id: string) => {
  const s = stepOf(id);
  if (s.type !== "shell") throw new Error(id);
  return s.run;
};
const promptOf = (id: string, flowName = "issue-gitflow") => {
  const s = parseFlow(readFileSync(flowPath(flowName), "utf8"), flowPath(flowName)).steps.find((x) => x.id === id);
  if (!s || s.type !== "claude") throw new Error(id);
  return s.prompt;
};

const exec = (id: string, env: Record<string, string>) => {
  const log = join(home, "gh.log");
  const r = spawnSync("sh", ["-c", runOf(id)], {
    encoding: "utf8",
    env: {
      PATH: `${join(home, "bin")}:${process.env.PATH}`, FAKE_GH_LOG: log, FACTORY_VAR_MAX_FILES: "15", FACTORY_VAR_MAX_CODE_LINES: "800",
      FACTORY_VAR_ISSUE: "5", FACTORY_VAR_GITHUB_REPO: "acme/app", FACTORY_TOOLS: resolve("tools"), FACTORY_RAN_PLAN: "1", FACTORY_RUN_ID: "r-1", ...env,
    },
  });
  let ghLog = "";
  try {
    ghLog = readFileSync(log, "utf8");
  } catch {
    // gh was never called
  }
  return { status: r.status, stdout: r.stdout, ghLog };
};

const OVER = "SIZE: 40 files, 3000 lines";
const plan = (...lines: string[]) => ["## Goal", "x", ...lines, "PLAN_STATUS: READY"].join("\n");
const size = (out: string, env: Record<string, string> = {}) => exec("size_gate", { FACTORY_OUT_PLAN: out, ...env });
const OWNER = "MECHANICAL: yes — owner's exception: the issue asks for one change";

describe("size_gate", () => {
  it("lets a plan within the limit through, with or without a MECHANICAL line", () => {
    expect(size(plan("SIZE: 3 files, 100 lines")).stdout).toContain("SIZE: ok");
    expect(size(plan("SIZE: 3 files, 100 lines", "MECHANICAL: yes — moves")).stdout).toContain("SIZE: ok");
  });

  it("sends a plan over the limit without the line to force_split", () => {
    expect(size(plan(OVER)).stdout).toContain("SIZE: over");
  });

  it("builds a mechanical plan over the limit as one change", () => {
    const r = size(plan(OVER, "MECHANICAL: yes — only moves files and changes imports"));
    expect(r.stdout).toContain("over the size limit, but mechanical — built as one change: only moves files and changes imports");
    expect(r.stdout).toContain("SIZE: mechanical");
  });

  it("ignores lines that are not MECHANICAL: yes", () => {
    for (const l of ["MECHANICAL: no", "MECHANICAL: yesterday", " MECHANICAL: yes — x"]) expect(size(plan(OVER, l)).stdout).toContain("SIZE: over");
  });

  it("uses only a fresh revision", () => {
    const draft = plan(OVER, "MECHANICAL: yes — moves files");
    const revised = plan(OVER);
    expect(size(draft, { FACTORY_OUT_REVISE_PLAN: revised, FACTORY_RAN_REVISE_PLAN: "3" }).stdout).toContain("SIZE: over");
    expect(size(draft, { FACTORY_OUT_REVISE_PLAN: revised, FACTORY_RAN_REVISE_PLAN: "0" }).stdout).toContain("SIZE: mechanical");
  });

  it("accepts an owner's exception when the author has write access", () => {
    expect(size(plan(OVER, OWNER), { FAKE_GH_ISSUE_AUTHOR: "alice" }).stdout).toContain("SIZE: mechanical");
  });

  it("rejects it when the author has only read access", () => {
    const r = size(plan(OVER, OWNER), { FAKE_GH_ISSUE_AUTHOR: "alice", FAKE_GH_READONLY: "alice" });
    expect(r.stdout).toContain("the owner's exception does not count");
    expect(r.stdout).toContain("SIZE: over");
  });

  it("accepts it when the last editor has write access", () => {
    const r = size(plan(OVER, OWNER), { FAKE_GH_ISSUE_AUTHOR: "alice", FAKE_GH_READONLY: "alice", FAKE_GH_ISSUE_EDITOR: "bob" });
    expect(r.stdout).toContain("SIZE: mechanical");
  });

  it("rejects it when a lookup fails or the login is invalid", () => {
    expect(size(plan(OVER, OWNER), { FAKE_GH_PERMISSION: "fail" }).stdout).toContain("SIZE: over");
    const graphql = size(plan(OVER, OWNER), { FAKE_GH_ISSUE_AUTHOR: "fail" });
    expect(graphql.stdout).toContain("the owner's exception does not count");
    expect(graphql.stdout).toContain("SIZE: over");
    expect(size(plan(OVER, OWNER), { FAKE_GH_ISSUE_AUTHOR: "app/bot" }).stdout).toContain("SIZE: over");
  });

  it("does not treat an ordinary mechanical reason with owner, exception or change words as an owner's exception", () => {
    const r = size(plan(OVER, "MECHANICAL: yes — moves exception classes and updates imports in the owner module"), { FAKE_GH_ISSUE_AUTHOR: "alice", FAKE_GH_READONLY: "alice" });
    expect(r.stdout).toContain("SIZE: mechanical");
    expect(r.stdout).not.toContain("does not count");
  });

  it("checks other wording that mentions one change", () => {
    const r = size(plan(OVER, "MECHANICAL: yes — the issue asks to build this as one change"), { FAKE_GH_ISSUE_AUTHOR: "alice", FAKE_GH_READONLY: "alice" });
    expect(r.stdout).toContain("SIZE: over");
  });
});

describe("risk_gate and the size exception", () => {
  const MECH = "over the size limit, but mechanical — built as one change: only moves files\nSIZE: mechanical";
  const risk = (env: Record<string, string>) =>
    exec("risk_gate", { FACTORY_OUT_PLAN: plan("RISK_SCORE: 10", "RISK_REASON: low", "MECHANICAL: yes — only moves files"), FACTORY_VAR_RISK_THRESHOLD: "75", ...env });

  it("records the mechanical line and keeps MECHANICAL lines out of the output", () => {
    const r = risk({
      FACTORY_OUT_SIZE_GATE: MECH, FACTORY_RAN_PLAN_REVIEW: "2", FACTORY_OUT_PLAN_REVIEW: "VERDICT: ok\nMECHANICAL: yes — note\nfix a thing",
    });
    expect(r.ghLog).toContain("**Size:** over the size limit, but mechanical");
    expect(r.stdout).not.toContain("MECHANICAL:");
    expect(r.ghLog).not.toContain("MECHANICAL:");
    expect(r.stdout).toContain("GATE: no");
  });

  it("adds no size line without the size gate output", () => {
    const r = risk({});
    expect(r.ghLog).not.toContain("**Size:**");
    expect(r.stdout).toContain("GATE: no");
  });

  it("asks a human when the owner's exception did not count", () => {
    const r = risk({ FACTORY_OUT_SIZE_GATE: "the owner's exception does not count: nobody (x)\nSIZE: over" });
    expect(r.stdout).toContain("GATE: yes");
    expect(r.ghLog).toContain("owner's exception did not count");
  });
});

describe("the prompts", () => {
  it("tell the planner about the exception", () => {
    const p = promptOf("plan");
    expect(p).toContain("MECHANICAL: yes —");
    expect(p).toContain("owner's exception");
    expect(promptOf("revise_plan")).toContain("MECHANICAL");
    expect(promptOf("force_split")).toContain("did not accept it");
    expect(promptOf("force_split")).toContain("{{steps.implement.too_big}}");
    expect(promptOf("plan", "issue-plan")).not.toContain("MECHANICAL");
  });
});
