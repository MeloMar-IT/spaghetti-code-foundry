import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { expectedResultKeys, homeInputs, type EvalInputs } from "../src/eval-inputs.js";
import { loadSuite, safetySuites, SAFETY_DIR } from "../src/evals.js";
import { PROMOTE_USAGE, promoteCommand } from "../src/promotion/cli.js";
import { currentSuiteInputs, MAX_REPORT_BYTES, newestReport, promoteCheck } from "../src/promotion/promote.js";
import { REQUIRED_SUITES, SAFETY_CATALOGUE } from "../src/promotion/required-suites.js";
import { COMPONENT_KINDS } from "../src/promotion/components.js";

const FLOW = "name: demo\nsteps:\n  - id: one\n    type: shell\n    run: echo one\n";
const open = { dataClassification: "internal", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none" };
const profile = (id: string) => ({ version: 1, profile: { id, version: "1" }, grants: [{ kind: "files", operations: ["read"], targets: ["src/*"], ...open }] });
const STAMP = "2026-01-01T00-00-00-000Z";

let base: string;
let home: string;
let evals: string;
let safety: string;
let builtin: string;
let saved: string | undefined;

const put = (rel: string, text: string) => {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), text);
};
const tree = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? [d.name + "/", ...tree(join(dir, d.name)).map((x) => `${d.name}/${x}`)] : [d.name]));

/** A report as `runEval` would have written it, for the state of the folders now. */
function report(name: string, o: { stamp?: string; live?: boolean; passed?: boolean; mutate?: (r: Record<string, unknown>) => void } = {}): string {
  const suitePath = join(safety, name, "suite.yaml");
  const suite = loadSuite(suitePath);
  const inputs: EvalInputs = { version: 1, live: o.live ?? false, ...currentSuiteInputs(suitePath, suite), components: homeInputs(home) };
  const results = expectedResultKeys(suite, inputs).map((k) => {
    const [variant, c, attempt] = k.split("|");
    return { variant, case: c, attempt: Number(attempt), passed: o.passed ?? true };
  });
  const r: Record<string, unknown> = { suite: name, startedAt: "x", finishedAt: "y", inputs, results, summary: [] };
  o.mutate?.(r);
  mkdirSync(evals, { recursive: true });
  const file = `${name}-${o.stamp ?? STAMP}.json`;
  writeFileSync(join(evals, file), JSON.stringify(r));
  return file;
}
const reportAll = () => SAFETY_CATALOGUE.forEach((n) => report(n));
const check = (kind: (typeof COMPONENT_KINDS)[number] = "flow", id = "my-flow", live = false) =>
  promoteCheck(kind, id, { live, home, evalsDir: evals, safetyDir: safety, builtinFlowsDir: builtin });
const blockedFor = (r: { lines: string[] }, suite: string) => r.lines.filter((l) => l.startsWith("BLOCKED") && l.includes(` ${suite} (`));

beforeEach(() => {
  saved = process.env.FACTORY_HOME;
  base = mkdtempSync(join(tmpdir(), "promote-test-"));
  home = join(base, "home");
  evals = join(home, "evals");
  safety = join(base, "safety");
  builtin = join(base, "builtin");
  mkdirSync(home);
  mkdirSync(builtin);
  writeFileSync(join(builtin, "base.yaml"), FLOW.replace("demo", "base"));
  cpSync(SAFETY_DIR, safety, { recursive: true });
  process.env.FACTORY_HOME = home;
  put("flows/my-flow.yaml", FLOW.replace("demo", "my-flow"));
  put("flows/other.yaml", FLOW.replace("demo", "other"));
});
afterEach(() => {
  process.env.FACTORY_HOME = saved;
  rmSync(base, { recursive: true, force: true });
});

describe("required suites", () => {
  it("are the safety folders, every one with a fake claude", () => {
    const folders = safetySuites().map((s) => s.split("/").slice(-2)[0]!);
    for (const kind of COMPONENT_KINDS) expect([...REQUIRED_SUITES[kind]].sort()).toEqual(folders);
    for (const s of safetySuites()) expect(loadSuite(s).programs?.claude, s).toBeTruthy();
  });
});

describe("scf promote", () => {
  it("prints PASSED for every suite and PROMOTABLE, and writes nothing", () => {
    reportAll();
    const before = tree(home);
    const r = check();
    expect(r.ok).toBe(true);
    expect(r.lines.filter((l) => l.startsWith("PASSED "))).toHaveLength(9);
    expect(r.lines.at(-1)).toMatch(/^PROMOTABLE flow my-flow v0 sha256:[0-9a-f]{64}$/);
    expect(tree(home)).toEqual(before);
  });

  it("blocks every suite without a report, also when the report has no inputs", () => {
    let r = check();
    expect(r.ok).toBe(false);
    expect(r.lines).toHaveLength(9);
    for (const n of SAFETY_CATALOGUE) expect(r.lines).toContain(`BLOCKED flow my-flow: ${n} (suite-missing) — scf eval safety`);
    reportAll();
    report("timeout", { mutate: (x) => void delete x.inputs });
    r = check();
    expect(blockedFor(r, "timeout")).toEqual(["BLOCKED flow my-flow: timeout (suite-missing) — scf eval safety"]);
  });

  it("lets the newest report decide", () => {
    reportAll();
    report("timeout", { stamp: "2026-02-01T00-00-00-000Z", passed: false });
    expect(blockedFor(check(), "timeout")[0]).toContain("(suite-failed)");
    // an older failure does not block a newer pass
    report("timeout", { stamp: "2026-03-01T00-00-00-000Z" });
    expect(check().ok).toBe(true);
  });

  it("is not taken over by an older report when the newest file is bad", () => {
    reportAll();
    const bad = (file: string, text: string) => writeFileSync(join(evals, file), text);
    bad("timeout-2026-02-01T00-00-00-000Z.json", "{ not json");
    expect(blockedFor(check(), "timeout")[0]).toContain("(report-invalid: the file is not valid JSON)");
    bad("timeout-2026-02-01T00-00-00-000Z.json", " ".repeat(MAX_REPORT_BYTES + 1));
    expect(blockedFor(check(), "timeout")[0]).toContain("(report-invalid: the file is too large)");
    rmSync(join(evals, "timeout-2026-02-01T00-00-00-000Z.json"));
    bad("timeout-latest.json", "{}");
    expect(blockedFor(check(), "timeout")[0]).toContain("(report-invalid: the file name has no timestamp)");
  });

  it("needs a complete result set", () => {
    reportAll();
    const cases: [string, (r: Record<string, unknown>) => void][] = [
      ["none", (r) => void (r.results = [])],
      ["short", (r) => void (r.results = (r.results as unknown[]).slice(1))],
      ["double", (r) => void (r.results = [...(r.results as unknown[]), (r.results as unknown[])[0]])],
      ["extra case", (r) => void (r.results = [...(r.results as unknown[]), { variant: "x", case: "zzz", attempt: 1, passed: true }])],
      ["not boolean", (r) => void ((r.results as { passed: unknown }[])[0]!.passed = "true")],
    ];
    for (const [label, mutate] of cases) {
      report("injected-instructions", { mutate });
      expect(blockedFor(check(), "injected-instructions")[0], label).toContain("(report-invalid: results)");
    }
  });

  it("goes stale when the component, the suite, a fixture or a suite flow changes, but not for another component", () => {
    reportAll();
    put("flows/other.yaml", FLOW.replace("demo", "other").replace("echo one", "echo two"));
    expect(check().ok).toBe(true);

    appendFileSync(join(safety, "timeout", "suite.yaml"), "# comment\n");
    expect(check().ok).toBe(true); // comments do not count
    const file = join(safety, "timeout", "suite.yaml");
    writeFileSync(file, stringify({ ...loadSuite(file), description: "changed" }));
    expect(blockedFor(check(), "timeout")[0]).toContain("(report-stale: suite)");
    cpSync(join(SAFETY_DIR, "timeout", "suite.yaml"), file);

    writeFileSync(join(safety, "injected-instructions", "fixture", "extra.txt"), "x");
    expect(blockedFor(check(), "injected-instructions")[0]).toContain("(report-stale: fixture fixture)");
    rmSync(join(safety, "injected-instructions", "fixture", "extra.txt"));

    appendFileSync(join(safety, "timeout", "flow.yaml"), "# note\n");
    expect(check().ok).toBe(true);
    const flow = join(safety, "timeout", "flow.yaml");
    writeFileSync(flow, readFlowWithTimeout(flow));
    expect(blockedFor(check(), "timeout")[0]).toMatch(/\(report-stale: flow \S+\)/);
    cpSync(join(SAFETY_DIR, "timeout", "flow.yaml"), flow);

    put("flows/my-flow.yaml", FLOW.replace("demo", "my-flow").replace("echo one", "echo changed"));
    const r = check();
    expect(r.lines.filter((l) => l.includes("(report-stale: flow my-flow)"))).toHaveLength(9);
  });

  it("goes stale when the component was not in the home folder at eval time", () => {
    reportAll();
    put("flows/late.yaml", FLOW.replace("demo", "late"));
    const r = check("flow", "late");
    expect(r.ok).toBe(false);
    expect(r.lines.filter((l) => l.includes("(report-stale: flow late)"))).toHaveLength(9);
  });

  it("is blocked by a broken home flow that shadows a valid built-in flow", () => {
    reportAll();
    put("flows/base.yaml", "name: base\nsteps: nope\n");
    const r = check("flow", "base");
    expect(r.lines).toEqual(["BLOCKED flow base: (problem) — scf components flow"]);
  });

  it("blocks a live report without --live and counts it with --live", () => {
    reportAll();
    report("timeout", { live: true });
    expect(blockedFor(check(), "timeout")[0]).toContain("(report-invalid: live)");
    expect(check("flow", "my-flow", true).ok).toBe(true);
  });

  it("blocks a partial report", () => {
    reportAll();
    report("injected-instructions", { mutate: (r) => void ((r.inputs as EvalInputs).cases = (r.inputs as EvalInputs).cases.slice(0, 1)) });
    expect(blockedFor(check(), "injected-instructions")[0]).toContain("(report-invalid: partial)");
  });

  it("blocks an unknown component and a bad one", () => {
    reportAll();
    expect(check("flow", "nope").lines).toEqual(["BLOCKED flow nope: (not-found) — scf components flow"]);
    put("tool-profiles/bad.yaml", "grants: [");
    expect(check("tool-profile", "bad").lines).toEqual(["BLOCKED tool-profile bad: (problem) — scf components tool-profile"]);
  });

  it("blocks a counted component without a recorded version, and never writes versions.json", () => {
    put("tool-profiles/tp.yaml", stringify(profile("tp")));
    reportAll();
    const r = check("tool-profile", "tp");
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toBe("BLOCKED tool-profile tp: (unrecorded) — scf components record tool-profile");
    expect(r.lines.filter((l) => l.startsWith("PASSED "))).toHaveLength(9);
    expect(existsSync(join(home, "promotions"))).toBe(false);

    mkdirSync(join(home, "promotions"));
    const hash = homeInputs(home).find((c) => c.kind === "tool-profile")!.sha256;
    writeFileSync(join(home, "promotions", "versions.json"), JSON.stringify({ version: 1, components: { "tool-profile/tp": [hash] } }));
    reportAll();
    const ok = check("tool-profile", "tp");
    expect(ok.ok).toBe(true);
    expect(ok.lines.at(-1)).toMatch(/^PROMOTABLE tool-profile tp v1 sha256:/);
  });

  it("blocks when versions.json is not valid", () => {
    put("tool-profiles/tp.yaml", stringify(profile("tp")));
    put("promotions/versions.json", "{ nope");
    reportAll();
    expect(check("tool-profile", "tp").lines[0]).toBe("BLOCKED tool-profile tp: (versions-invalid) — fix or restore promotions/versions.json");
  });

  it("does not mix up a suite whose name starts with another suite's name", () => {
    reportAll();
    // a report of `timeout-extra` (a suite name of its own): malformed, and newer than the timeout reports
    writeFileSync(join(evals, "timeout-extra-2026-05-01T00-00-00-000Z.json"), "{ bad");
    writeFileSync(join(evals, "timeout-extra-2026-05-02T00-00-00-000Z.json"), JSON.stringify({ suite: "timeout-extra" }));
    expect(newestReport("timeout", evals)).toMatchObject({ file: `timeout-${STAMP}.json` });
    expect(blockedFor(check(), "timeout")).toEqual([]);
    expect(check().lines).toContain(`PASSED timeout timeout-${STAMP}.json`);
    // and a newer genuine timeout report still counts for `timeout`
    report("timeout", { stamp: "2026-06-01T00-00-00-000Z" });
    expect(newestReport("timeout", evals)).toMatchObject({ file: "timeout-2026-06-01T00-00-00-000Z.json" });
  });

  it("finds the newest report by file name and reads only that one", () => {
    mkdirSync(evals, { recursive: true });
    writeFileSync(join(evals, "timeout-2026-01-01T00-00-00-000Z.json"), "{}");
    writeFileSync(join(evals, "timeout-2026-01-02T00-00-00-000Z.json"), "{ bad");
    expect(newestReport("timeout", evals)).toMatchObject({ file: "timeout-2026-01-02T00-00-00-000Z.json", problem: "the file is not valid JSON" });
    expect(newestReport("approval-bypass", evals)).toBeUndefined();
  });
});

/** A real change of the definition (a comment is not one). */
function readFlowWithTimeout(path: string): string {
  return readFileSync(path, "utf8").replace("sleep 5", "sleep 6");
}

describe("promoteCommand", () => {
  it("refuses a wrong kind, a missing id and extra arguments", () => {
    for (const args of [[], ["flow"], ["nope", "x"], ["flow", "x", "y"]]) expect(() => promoteCommand(args, {}, () => {})).toThrow(PROMOTE_USAGE);
  });

  it("prints the lines and returns 1 when blocked", () => {
    const lines: string[] = [];
    expect(promoteCommand(["flow", "nothing-here"], {}, (l) => void lines.push(l))).toBe(1);
    expect(lines).toEqual(["BLOCKED flow nothing-here: (not-found) — scf components flow"]);
  });
});
