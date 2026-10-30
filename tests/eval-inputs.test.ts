import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareInputs, evalLive, expectedResultKeys, folderSha256, homeInputs, suiteInputs, type SuiteInputs } from "../src/eval-inputs.js";
import { SuiteSchema } from "../src/evals.js";
import { parseFlow } from "../src/flow/load.js";
import { stringify } from "yaml";

const FLOW = "name: demo\nsteps:\n  - id: one\n    type: shell\n    run: echo one\n";
const flow = parseFlow(FLOW, "f.yaml");
const mkSuite = (o: Record<string, unknown> = {}) =>
  SuiteSchema.parse({ name: "s", flows: ["f.yaml"], cases: [{ name: "a", repo: "fx" }, { name: "b", repo: "fx" }, { name: "c", repo: "https://example.com/x.git" }], ...o });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "eval-inputs-"));
  mkdirSync(join(dir, "fx"));
  writeFileSync(join(dir, "fx", "a.txt"), "a");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("folderSha256", () => {
  it("is stable, and changes with content and names", () => {
    const h = folderSha256(join(dir, "fx"))!;
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(folderSha256(join(dir, "fx"))).toBe(h);
    writeFileSync(join(dir, "fx", "a.txt"), "b");
    const h2 = folderSha256(join(dir, "fx"));
    expect(h2).not.toBe(h);
    renameSync(join(dir, "fx", "a.txt"), join(dir, "fx", "z.txt"));
    expect(folderSha256(join(dir, "fx"))).not.toBe(h2);
  });

  it("ignores .git and .DS_Store, and gives undefined for a missing folder or a file", () => {
    const h = folderSha256(join(dir, "fx"));
    mkdirSync(join(dir, "fx", ".git"));
    writeFileSync(join(dir, "fx", ".git", "HEAD"), "x");
    writeFileSync(join(dir, "fx", ".DS_Store"), "x");
    expect(folderSha256(join(dir, "fx"))).toBe(h);
    expect(folderSha256(join(dir, "missing"))).toBeUndefined();
    expect(folderSha256(join(dir, "fx", "a.txt"))).toBeUndefined();
  });
});

describe("suiteInputs", () => {
  const inputs = (suite = mkSuite(), cases = ["a", "b", "c"], models?: string[]) => suiteInputs(suite, dir, [{ entry: "f.yaml", flow }], cases, models);

  it("hashes the parsed suite, so key order does not count", () => {
    const a = inputs();
    const b = inputs(SuiteSchema.parse({ cases: mkSuite().cases, flows: ["f.yaml"], name: "s" }));
    expect(a.suite.sha256).toBe(b.suite.sha256);
    expect(inputs(mkSuite({ description: "x" })).suite.sha256).not.toBe(a.suite.sha256);
  });

  it("lists each fixture once, in case order; a URL is not hashed", () => {
    const i = inputs();
    expect(i.fixtures).toEqual([{ repo: "fx", sha256: folderSha256(join(dir, "fx")) }, { repo: "https://example.com/x.git", sha256: null }]);
    expect(inputs(mkSuite(), ["b"]).fixtures).toHaveLength(1);
  });

  it("records flows, cases and models", () => {
    const i = inputs(mkSuite(), ["a"], ["haiku"]);
    expect(i.flows).toEqual([{ entry: "f.yaml", kind: "flow", id: "demo", version: "0", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
    expect(i.cases).toEqual(["a"]);
    expect(i.models).toEqual(["haiku"]);
    expect("models" in inputs()).toBe(false);
  });
});

describe("evalLive", () => {
  it("is true only without a fake claude", () => {
    expect(evalLive({})).toBe(true);
    expect(evalLive({ programs: { claude: "x" } })).toBe(false);
    expect(evalLive({}, "/bin/fake")).toBe(false);
    expect(evalLive({ programs: { gh: "x" } })).toBe(true);
  });
});

describe("compareInputs", () => {
  const rec = (): SuiteInputs => suiteInputs(mkSuite(), dir, [{ entry: "f.yaml", flow }], ["a", "b", "c"]);
  const clone = (i: SuiteInputs) => structuredClone(i);

  it("finds no difference in equal inputs", () => {
    expect(compareInputs(rec(), rec())).toBeUndefined();
  });

  it("reports a changed suite, fixture and flow as stale", () => {
    const base = rec();
    expect(compareInputs(base, suiteInputs(mkSuite({ description: "d" }), dir, [{ entry: "f.yaml", flow }], ["a", "b", "c"]))).toEqual({ code: "report-stale", detail: "suite" });
    writeFileSync(join(dir, "fx", "a.txt"), "changed");
    expect(compareInputs(base, rec())).toEqual({ code: "report-stale", detail: "fixture fx" });
    const other = parseFlow(FLOW.replace("echo one", "echo two"), "f.yaml");
    expect(compareInputs(rec(), suiteInputs(mkSuite(), dir, [{ entry: "f.yaml", flow: other }], ["a", "b", "c"]))).toEqual({ code: "report-stale", detail: "flow demo" });
  });

  it("reports fewer cases, another flow entry and other models as partial", () => {
    const cur = rec();
    const fewer = clone(cur);
    fewer.cases = ["a"];
    expect(compareInputs(fewer, cur)).toEqual({ code: "report-invalid", detail: "partial" });
    const entry = clone(cur);
    entry.flows[0]!.entry = "g.yaml";
    expect(compareInputs(entry, cur)).toEqual({ code: "report-invalid", detail: "partial" });
    const models = clone(cur);
    models.models = ["opus"];
    expect(compareInputs(models, cur)).toEqual({ code: "report-invalid", detail: "partial" });
  });
});

describe("expectedResultKeys", () => {
  it("covers flows × models × cases × repeat", () => {
    const i = suiteInputs(mkSuite(), dir, [{ entry: "f.yaml", flow }], ["a", "b"], ["m1", "m2"]);
    const keys = expectedResultKeys({ repeat: 2 }, i);
    expect(keys).toHaveLength(8);
    expect(keys).toContain("demo@m2|b|2");
    expect(expectedResultKeys({ repeat: 1 }, suiteInputs(mkSuite(), dir, [{ entry: "f.yaml", flow }], ["a"]))).toEqual(["demo|a|1"]);
  });
});

describe("homeInputs", () => {
  it("lists the baseline pack, and gives a counted component a version only when it is recorded", () => {
    const home = join(dir, "home");
    mkdirSync(join(home, "tool-profiles"), { recursive: true });
    const open = { dataClassification: "internal", credential: "none", timeoutMs: null, maxConcurrent: null, outputCapBytes: null, approval: "none" };
    writeFileSync(join(home, "tool-profiles", "tp.yaml"), stringify({ version: 1, profile: { id: "tp", version: "1" }, grants: [{ kind: "files", operations: ["read"], targets: ["src/*"], ...open }] }));
    const list = homeInputs(home);
    expect(list.find((c) => c.kind === "policy-pack" && c.id === "foundry.baseline")).toMatchObject({ builtin: true });
    const tp = list.find((c) => c.kind === "tool-profile")!;
    expect(tp.version).toBeUndefined();
    mkdirSync(join(home, "promotions"));
    writeFileSync(join(home, "promotions", "versions.json"), JSON.stringify({ version: 1, components: { "tool-profile/tp": [tp.sha256] } }));
    expect(homeInputs(home).find((c) => c.kind === "tool-profile")!.version).toBe("1");
  });
});
