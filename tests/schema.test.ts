import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigSchema, loadConfig, saveConfig, updateEveryMs } from "../src/config.js";
import { parseFlow } from "../src/flow/load.js";
import { varValueProblem } from "../src/flow/schema.js";
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
    expect(shipped.sort()).toEqual(["daily-pr", "epic-questions", "issue-code-daily", "issue-gitflow", "issue-plan", "refine-brief", "refine-round", "release-build", "release-daily"]);
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

describe("varValueProblem", () => {
  const num = { kind: "number", min: 0, max: 100 } as const;
  it("checks a number against its range, and accepts exponent form", () => {
    expect(varValueProblem(num, "abc")).toBe('"abc" is not a number');
    expect(varValueProblem(num, "-1")).toBe("-1 is below min 0");
    expect(varValueProblem(num, "101")).toBe("101 is above max 100");
    expect(varValueProblem(num, "7.5")).toBeUndefined();
    expect(varValueProblem({ kind: "number", max: 1 }, "1e-7")).toBeUndefined();
  });
  it("checks yes_no and choice", () => {
    expect(varValueProblem({ kind: "yes_no" }, "maybe")).toBe('"maybe" must be yes or no');
    expect(varValueProblem({ kind: "yes_no" }, "no")).toBeUndefined();
    expect(varValueProblem({ kind: "choice", choices: ["a", ""] }, "b")).toBe('"b" is not one of the choices');
    expect(varValueProblem({ kind: "choice", choices: ["a", ""] }, "")).toBeUndefined();
  });
  it("accepts any text for text and list", () => {
    expect(varValueProblem({ kind: "text" }, "a\nb")).toBeUndefined();
    expect(varValueProblem({ kind: "list" }, "!!")).toBeUndefined();
  });
});

describe("var_info", () => {
  const withInfo = (vars: string, info: string) => `name: t\nvars:\n${vars}\nvar_info:\n${info}\nsteps:\n  - {id: a, type: shell, run: echo}`;
  const parseWith = (vars: string, info: string) => parseFlow(withInfo(vars, info));

  it("is optional and adds no key to a flow without it", () => {
    const flow = parseFlow(minimal("  - {id: a, type: shell, run: echo}"));
    expect("var_info" in flow).toBe(false);
  });

  it("parses an entry of each kind, with kind defaulting to text", () => {
    const flow = parseWith(
      "  n: '5'\n  y: 'yes'\n  t: hi\n  l: 'a,b'\n  c: b\n  d: x",
      "  n: {label: N, kind: number, min: 0, max: 5}\n  y: {kind: yes_no}\n  t: {kind: text}\n  l: {kind: list, separator: space}\n  c: {kind: choice, choices: [a, 1, b]}\n  d: {help: only help}",
    );
    expect(flow.var_info?.n).toMatchObject({ kind: "number", min: 0, max: 5 });
    expect(flow.var_info?.c?.choices).toEqual(["a", "1", "b"]);
    expect(flow.var_info?.d?.kind).toBe("text");
    expect(flow.var_info?.l?.separator).toBe("space");
  });

  it("refuses an entry for a variable that is not in vars, naming it", () => {
    expect(() => parseWith("  a: x", "  nope: {kind: text}")).toThrow(/var_info\.nope: unknown variable "nope"/);
  });

  it.each([
    ["min on text", "t: x", "t: {kind: text, min: 1}", /min is only for kind number/],
    ["max on list", "t: x", "t: {kind: list, max: 1}", /max is only for kind number/],
    ["choices on number", "t: '1'", "t: {kind: number, choices: [a]}", /choices are only for kind choice/],
    ["separator on text", "t: x", "t: {kind: text, separator: comma}", /separator is only for kind list/],
    ["min above max", "t: '1'", "t: {kind: number, min: 5, max: 1}", /min must not be above max/],
    ["choice without choices", "t: a", "t: {kind: choice}", /kind choice needs choices/],
    ["duplicate choices", "t: a", "t: {kind: choice, choices: [a, a]}", /duplicate choice "a"/],
    ["unknown key", "t: x", "t: {foo: 1}", /invalid flow/],
    ["unknown kind", "t: x", "t: {kind: color}", /invalid flow/],
    ["label too long", "t: x", `t: {label: ${"x".repeat(81)}}`, /invalid flow/],
    ["help too long", "t: x", `t: {help: ${"x".repeat(301)}}`, /invalid flow/],
  ])("refuses %s", (_name, vars, info, message) => {
    expect(() => parseWith(`  ${vars}`, `  ${info}`)).toThrow(message);
  });

  it.each([
    ["a text for a number", "'abc'", "{kind: number}", /is not a number/],
    ["an empty number", "''", "{kind: number}", /is not a number/],
    ["an overflowing number", "'1e999'", "{kind: number}", /is not a number/],
    ["a number below min", "'0'", "{kind: number, min: 1}", /below min 1/],
    ["a number above max", "'9'", "{kind: number, max: 5}", /above max 5/],
    ["true for yes_no", "true", "{kind: yes_no}", /must be yes or no/],
    ["maybe for yes_no", "maybe", "{kind: yes_no}", /must be yes or no/],
    ["a default outside the choices", "z", "{kind: choice, choices: [a, b]}", /not one of the choices/],
  ])("refuses %s as a default", (_name, value, info, message) => {
    expect(() => parseWith(`  t: ${value}`, `  t: ${info}`)).toThrow(message);
  });

  it("accepts small and large numbers in exponent form, also as plain YAML numbers", () => {
    expect(() => parseWith("  t: 0.0000001", "  t: {kind: number, min: 0, max: 1}")).not.toThrow();
    expect(() => parseWith("  t: '1.5E3'", "  t: {kind: number, min: 1, max: 2000}")).not.toThrow();
    expect(() => parseWith("  t: 0.0000001", "  t: {kind: number, min: 1}")).toThrow(/below min 1/);
  });

  it("accepts the boundary values and a run-set entry", () => {
    expect(() => parseWith("  t: '1'", "  t: {kind: number, min: 1, max: 5}")).not.toThrow();
    expect(() => parseWith("  t: '5'", "  t: {kind: number, min: 1, max: 5}")).not.toThrow();
    expect(parseWith("  issue: ''", "  issue: {set_by_run: true}").var_info?.issue?.set_by_run).toBe(true);
  });

  it("describes every variable of the shipped flows", () => {
    const issueGitflow = [
      "risk_threshold", "auto_split_max_risk", "revise_above_risk", "review_twice_above_risk", "max_files", "max_code_lines", "test_cmd",
      "quick_test_cmd", "test_slots", "reuse_test_results", "develop_branch", "main_branch", "feature_prefix", "hotfix_prefix", "hotfix_labels",
      "forbidden_paths", "docs_required", "union_merge_files", "agent_env", "review_plan_label", "trigger_label", "delete_merged_branches", "close_when_merged",
    ];
    for (const f of readdirSync("flows").filter((n) => n.endsWith(".yaml"))) {
      const flow = parseFlow(readFileSync(`flows/${f}`, "utf8"), f);
      const info = flow.var_info ?? {};
      expect(Object.keys(info).sort(), f).toEqual(Object.keys(flow.vars).sort());
      for (const [k, v] of Object.entries(info)) {
        if (v.set_by_run) continue;
        expect(v.label, `${f} ${k} label`).toBeTruthy();
        expect(v.help, `${f} ${k} help`).toBeTruthy();
      }
      for (const k of ["github_repo", "issue"]) if (k in info) expect(info[k]?.set_by_run, `${f} ${k}`).toBe(true);
    }
    const gitflow = parseFlow(readFileSync("flows/issue-gitflow.yaml", "utf8")).var_info ?? {};
    for (const k of issueGitflow) {
      expect(gitflow[k], k).toBeDefined();
      expect(gitflow[k]?.set_by_run, k).toBeFalsy();
    }
    expect(gitflow.hotfix_labels).toMatchObject({ kind: "list", separator: "comma" });
    expect(gitflow.forbidden_paths).toMatchObject({ kind: "list", separator: "space" });
    expect(gitflow.agent_env).toMatchObject({ kind: "list", separator: "line" });
    expect(gitflow.review_twice_above_risk?.kind).toBe("text");
    expect(gitflow.test_cmd?.kind).toBe("text");
    expect(gitflow.risk_threshold).toMatchObject({ kind: "number", min: 0, max: 100 });
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

describe("config: skills.update_check", () => {
  const parse = (u: unknown) => ConfigSchema.safeParse({ skills: { update_check: u } });
  const msgs = (u: unknown) => {
    const r = parse(u);
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("is off by default, every 1h", () => {
    for (const c of [{}, { skills: {} }, { skills: { update_check: {} } }]) {
      const u = ConfigSchema.parse(c).skills.update_check;
      expect(u).toEqual({ every: "1h" });
      expect(u.folder).toBeUndefined();
    }
  });

  it("accepts a folder and the intervals", () => {
    for (const every of ["5m", "30m", "1h", "24h", "1440m"]) expect(parse({ folder: "/srv/catalogue", every }).success, every).toBe(true);
    expect(parse({ folder: "/a/.claudex" }).success).toBe(true);
  });

  it("refuses a relative folder", () => {
    for (const folder of ["catalogue", "./x"]) expect(msgs({ folder })).toEqual(["skills.update_check.folder: must be an absolute path"]);
  });

  it("refuses .claude and .codex parts, in any case", () => {
    for (const folder of ["/Users/a/.claude/x", "/Users/a/.codex", "/a/.Claude/b"])
      expect(msgs({ folder }), folder).toEqual(["skills.update_check.folder: personal agent folders (.claude, .codex) cannot be used"]);
  });

  it("refuses a bad interval", () => {
    for (const every of ["1m", "4m", "25h", "1d", "abc", "0m", "05m", "1441m", "", " 1h", "30s"])
      expect(msgs({ every }), every).toEqual(["skills.update_check.every: an interval like 30m or 6h, from 5m to 24h"]);
  });

  it("refuses unknown keys", () => {
    expect(parse({ folder: "/x", extra: 1 }).success).toBe(false);
  });

  it("bounds of updateEveryMs", () => {
    expect(updateEveryMs("5m")).toBe(300_000);
    expect(updateEveryMs("24h")).toBe(86_400_000);
    expect(updateEveryMs("1440m")).toBe(86_400_000);
    expect(updateEveryMs("1h")).toBe(3_600_000);
    for (const bad of ["4m", "1441m", "25h", "9999h", "10000m", "0h", "1d", "1.5h", undefined, 5, null]) expect(updateEveryMs(bad), String(bad)).toBeUndefined();
  });

  it("loads a config.yaml without the key unchanged, and saves and loads the key", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    try {
      const path = join(dir, "config.yaml");
      writeFileSync(path, "concurrency: 3\n");
      expect(loadConfig(path).skills.update_check).toEqual({ every: "1h" });
      expect(readFileSync(path, "utf8")).toBe("concurrency: 3\n");
      saveConfig({ skills: { update_check: { folder: "/srv/catalogue", every: "6h" } } }, path);
      expect(loadConfig(path).skills.update_check).toEqual({ folder: "/srv/catalogue", every: "6h" });
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
