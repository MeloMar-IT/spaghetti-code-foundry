import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig, saveConfig } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { outputEnvName, render } from "../src/engine/template.js";

const minimal = (steps: string) => `name: t\nsteps:\n${steps}`;

describe("repo_access", () => {
  const shell = (extra: string) => minimal(`  - {id: a, type: shell, run: x${extra}}`);
  it("is optional on a shell step and keeps its value", () => {
    expect(parseFlow(shell(", repo_access: true")).steps[0]).toMatchObject({ repo_access: true });
    expect(parseFlow(shell(", repo_access: false")).steps[0]).toMatchObject({ repo_access: false });
    expect("repo_access" in parseFlow(shell("")).steps[0]!).toBe(false);
    expect(() => parseFlow(shell(", repo_access: maybe"))).toThrow(/repo_access/);
  });

  it("is rejected on other step types", () => {
    for (const step of [
      "{id: a, type: claude, prompt: x, repo_access: true}",
      "{id: a, type: approval, message: x, repo_access: true}",
      "{id: a, type: parallel, steps: [b, c], repo_access: true}",
      "{id: a, type: flow, flow: other, repo_access: true}",
    ]) {
      expect(() => parseFlow(minimal(`  - ${step}\n  - {id: b, type: shell, run: x}\n  - {id: c, type: shell, run: x}`))).toThrow(/repo_access/);
    }
  });

  it("cannot be combined with sandbox: true", () => {
    expect(() => parseFlow(shell(", repo_access: true, sandbox: true"))).toThrow(/steps\.0\.repo_access: a step with repo_access cannot also have sandbox: true/);
    expect(parseFlow(shell(", repo_access: false, sandbox: true")).steps).toHaveLength(1);
    expect(parseFlow(shell(", repo_access: true, sandbox: false")).steps).toHaveLength(1);
  });

  it("cannot be listed in a parallel step", () => {
    const flow = (flag: string) => minimal(`  - {id: p, type: parallel, steps: [a, b]}\n  - {id: a, type: shell, run: x, repo_access: ${flag}}\n  - {id: b, type: shell, run: x}`);
    expect(() => parseFlow(flow("true"))).toThrow(/steps\.0\.steps\.0: "a" has repo_access, so it cannot be listed in a parallel step/);
    expect(parseFlow(flow("false")).steps).toHaveLength(3);
  });
});

describe("flow schema", () => {
  it("parses the built-in flows", () => {
    const shipped = readdirSync("flows").filter((f) => f.endsWith(".yaml")).map((f) => f.replace(/\.yaml$/, ""));
    expect(shipped.sort()).toEqual(["daily-pr", "epic-questions", "issue-code-daily", "issue-gitflow", "issue-plan", "refine-brief", "refine-round", "release-daily"]);
    for (const f of shipped) {
      const flow = parseFlow(readFileSync(`flows/${f}.yaml`, "utf8"), f);
      expect(flow.name).toBe(f);
    }
  });

  it("applies defaults", () => {
    const flow = parseFlow(minimal("  - {id: a, type: shell, run: echo}"));
    expect(flow.workspace).toBe("worktree");
    expect(flow.vars).toEqual({});
  });

  it("rejects unknown jump targets", () => {
    expect(() => parseFlow(minimal("  - {id: a, type: shell, run: x, on_failure: nope}"))).toThrow(/unknown step "nope"/);
  });

  it("rejects duplicate ids and reserved ids", () => {
    expect(() => parseFlow(minimal("  - {id: a, type: shell, run: x}\n  - {id: a, type: shell, run: y}"))).toThrow(/duplicate/);
    expect(() => parseFlow(minimal("  - {id: end, type: shell, run: x}"))).toThrow(/reserved/);
  });

  it("rejects resume pointing at a non-claude step", () => {
    const y = minimal("  - {id: a, type: shell, run: x}\n  - {id: b, type: claude, prompt: hi, resume: a}");
    expect(() => parseFlow(y)).toThrow(/resume must reference a claude step/);
  });

  it("rejects unknown fields and bad regex", () => {
    expect(() => parseFlow(minimal("  - {id: a, type: shell, run: x, bogus: 1}"))).toThrow(/invalid flow/);
    expect(() => parseFlow(minimal("  - {id: a, type: shell, run: x, pass_if: '('}"))).toThrow(/invalid regex/);
  });
});

describe("template", () => {
  const ctx = { task: "do it", vars: { a: "1" }, steps: { x: { output: "out" } } };

  it("renders values and blanks steps that have not run", () => {
    expect(render("{{task}} {{vars.a}} {{steps.x.output}} [{{steps.y.output}}]", ctx)).toBe("do it 1 out []");
  });

  it("throws on unknown variables", () => {
    expect(() => render("{{vars.missing}}", ctx)).toThrow(/unknown template variable/);
  });

  it("enforces allowed roots", () => {
    expect(() => render("echo {{task}}", ctx, ["vars"])).toThrow(/not allowed/);
    expect(render("echo {{vars.a}}", ctx, ["vars"])).toBe("echo 1");
  });

  it("builds env names", () => {
    expect(outputEnvName("run-tests")).toBe("FACTORY_OUT_RUN_TESTS");
  });
});

describe("config: ui.redesign", () => {
  it("is off by default and strict", () => {
    expect(ConfigSchema.parse({}).ui).toEqual({ redesign: false });
    expect(ConfigSchema.parse({ ui: {} }).ui).toEqual({ redesign: false });
    expect(ConfigSchema.parse({ ui: { redesign: true } }).ui.redesign).toBe(true);
    expect(ConfigSchema.safeParse({ ui: { other: 1 } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ui: { redesign: "yes" } }).success).toBe(false);
  });

  it("loads a config.yaml without the key, without rewriting it", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    try {
      const path = join(dir, "config.yaml");
      writeFileSync(path, "concurrency: 3\n");
      expect(loadConfig(path).ui).toEqual({ redesign: false });
      expect(readFileSync(path, "utf8")).toBe("concurrency: 3\n");
      saveConfig({ ui: { redesign: true } }, path);
      expect(loadConfig(path).ui.redesign).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config: audit.retention_days", () => {
  it("defaults to 180", () => {
    expect(ConfigSchema.parse({}).audit).toEqual({ retention_days: 180 });
    expect(ConfigSchema.parse({ audit: {} }).audit).toEqual({ retention_days: 180 });
  });

  it("accepts 1 to 3650 whole numbers only", () => {
    for (const n of [1, 30, 3650]) expect(ConfigSchema.parse({ audit: { retention_days: n } }).audit.retention_days).toBe(n);
    for (const bad of [0, 3651, 1.5, -1, "30", null]) expect(ConfigSchema.safeParse({ audit: { retention_days: bad } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ audit: { retention_days: 30, extra: 1 } }).success).toBe(false);
  });

  it("loads a config.yaml without the key unchanged, and saves and loads the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    try {
      const path = join(dir, "config.yaml");
      writeFileSync(path, "concurrency: 3\n");
      const c = loadConfig(path);
      expect(c.concurrency).toBe(3);
      expect(c.audit.retention_days).toBe(180);
      expect(readFileSync(path, "utf8")).toBe("concurrency: 3\n");
      saveConfig({ audit: { retention_days: 30 } }, path);
      expect(loadConfig(path).audit.retention_days).toBe(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flow skills syntax", () => {
  const flow = (skills: string, step = "{id: a, type: claude, prompt: x}") => parseFlow(`name: t\n${skills}\nsteps:\n  - ${step}`);
  const ids = (n: number) => `[${Array.from({ length: n }, (_, i) => `s${i}`).join(", ")}]`;

  it("accepts every mode and leaves no field on a flow without skills", () => {
    for (const m of ["planned", "off", "recorded"]) expect(flow(`skills: {mode: ${m}}`).skills).toEqual({ mode: m });
    expect(flow("skills: {mode: explicit, ids: [a, b]}").skills).toEqual({ mode: "explicit", ids: ["a", "b"] });
    const plain = flow("");
    expect(plain).not.toHaveProperty("skills");
    expect(plain.steps[0]).not.toHaveProperty("skills");
    expect(flow(`skills: {mode: explicit, ids: ${ids(20)}}`).skills?.ids).toHaveLength(20);
  });

  it("refuses bad flow skills", () => {
    for (const s of [
      "skills: {mode: auto}", "skills: {}", "skills: {mode: planned, ids: [a]}", "skills: {mode: off, ids: [a]}", "skills: {mode: recorded, ids: [a]}",
      "skills: {mode: explicit}", "skills: {mode: explicit, ids: []}", "skills: {mode: explicit, ids: [Bad_Id]}", "skills: {mode: explicit, ids: [a, a]}",
      `skills: {mode: explicit, ids: ${ids(21)}}`, "skills: {mode: off, extra: 1}",
    ]) expect(() => flow(s), s).toThrow();
  });

  it("allows explicit mode in a flow whose steps are all jump_only", () => {
    expect(flow("skills: {mode: explicit, ids: [a]}", "{id: a, type: shell, run: x, jump_only: true}").skills?.mode).toBe("explicit");
  });

  it("checks the step field", () => {
    const st = (extra: string, defaults = "") => parseFlow(`name: t\n${defaults}steps:\n  - {id: a, type: claude, prompt: x${extra}}`);
    expect(st(", skills: selected").steps[0]).toMatchObject({ skills: "selected" });
    expect(st(", skills: off").steps[0]).toMatchObject({ skills: "off" });
    expect(st(", skills: catalog, permission_mode: plan").steps[0]).toMatchObject({ skills: "catalog" });
    expect(st(", skills: catalog, permission_mode: dontAsk, allowed_tools: [Read, Glob, Grep]").steps[0]).toMatchObject({ skills: "catalog" });
    expect(st(", skills: catalog", "defaults: {permission_mode: plan}\n").steps[0]).toMatchObject({ skills: "catalog" });
    expect(() => st(", skills: catalog")).toThrow(/read-only/);
    expect(() => st(", skills: catalog, permission_mode: acceptEdits")).toThrow(/read-only/);
    expect(() => st(", skills: catalog, permission_mode: dontAsk, allowed_tools: [Bash(ls)]")).toThrow(/read-only/);
    expect(() => st(", skills: nope")).toThrow();
    for (const v of ["off", "selected"]) expect(() => st(`, skills: ${v}, skill_role: reviewer, permission_mode: plan`)).toThrow(/reviewer/);
    expect(() => parseFlow("name: t\nsteps:\n  - {id: a, type: shell, run: x, skills: off}")).toThrow();
  });
});
