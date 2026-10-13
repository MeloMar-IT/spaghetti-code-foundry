import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialProblem } from "../src/skills/credential-scan.js";
import { parseEvaluationRecord } from "../src/skills/evaluation.js";
import { EVALUATION_SUITE_LIMITS } from "../src/skills/evaluation-rules.js";
import { evaluationSuiteDigest, parseEvaluationSuite, readEvaluationSuite, suiteScenarios } from "../src/skills/evaluation-suite.js";
import { buildRepoProfile, type RepoProfile } from "../src/skills/repo-profile.js";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "skillsuite-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const good = () => ({
  schema: 1,
  selection: [
    { id: "sel-b", repo: "fixtures/b", task: "Do the thing", modules: ["z", "a"], expect: "not-offered" },
    { id: "sel-a", repo: "fixtures/a", task: "Add a retry.", expect: "offered" },
  ],
  conflicts: [{ id: "conf", with: "all" }],
  context: [{ id: "ctx", max_instruction_tokens: 3000, max_description_chars: 160 }],
  tools: [{ id: "tool", policy: { shell: false, network: false, filesystem: "read" } }],
});
type Doc = ReturnType<typeof good>;
const mutate = (f: (d: Record<string, any>) => void): unknown => {
  const d = good() as Record<string, any>;
  f(d);
  return d;
};
const problems = (raw: unknown) => parseEvaluationSuite(raw).problems;
const profile = (files: Record<string, string>): RepoProfile => {
  const root = tmp();
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return buildRepoProfile(root);
};
const pkgJson = (dep: string) => JSON.stringify({ name: "x", version: "1.0.0", dependencies: { [dep]: "1" } });

describe("parseEvaluationSuite", () => {
  it("accepts a full suite and sorts scenarios by id", () => {
    const r = parseEvaluationSuite(good());
    expect(r.problems).toEqual([]);
    expect(r.suite!.selection.map((s) => s.id)).toEqual(["sel-a", "sel-b"]);
    expect(r.suite!.selection[0]!.modules).toEqual([]);
    expect(r.suite!.selection[1]!.modules).toEqual(["a", "z"]);
    expect(r.suite!.tools[0]!.policy).toEqual({ shell: false, network: false, filesystem: "read" });
  });

  const long = (n: number) => "a".repeat(n);
  const many = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));
  const refusals: [string, unknown, string, string][] = [
    ["not a map", [], "file", "must be a map"],
    ["unknown top-level key", mutate((d) => (d.extra = 1)), "file", "unknown key"],
    ["wrong schema", mutate((d) => (d.schema = 2)), "schema", "schema must be 1"],
    ["dimension missing", mutate((d) => delete d.tools), "tools", "is required"],
    ["dimension not a list", mutate((d) => (d.tools = {})), "tools", "must be a list"],
    ["dimension empty", mutate((d) => (d.conflicts = [])), "conflicts", "at least one"],
    ["51 scenarios", mutate((d) => (d.conflicts = many(51, (i) => ({ id: `c-${i}`, with: "all" })))), "conflicts", "at most 50"],
    [
      "more than 100 in all",
      mutate((d) => {
        d.conflicts = many(50, (i) => ({ id: `c-${i}`, with: "all" }));
        d.context = many(50, (i) => ({ id: `x-${i}`, max_description_chars: 5 }));
      }),
      "file", "at most 100",
    ],
    ["id not a slug", mutate((d) => (d.conflicts[0].id = "Not A Slug")), "conflicts[0] id", "lower-case slug"],
    ["same id twice", mutate((d) => (d.tools[0].id = "conf")), "tools[0] (conf) id", "already used by conflicts[0]"],
    ["repo with ..", mutate((d) => (d.selection[0].repo = "../x")), "selection[0] (sel-b) repo", "relative"],
    ["absolute repo", mutate((d) => (d.selection[0].repo = "/x")), "selection[0] (sel-b) repo", ""],
    ["repo with backslash", mutate((d) => (d.selection[0].repo = "a\\b")), "selection[0] (sel-b) repo", ""],
    ["repo with comma", mutate((d) => (d.selection[0].repo = "a,b")), "selection[0] (sel-b) repo", "comma"],
    ["repo too long", mutate((d) => (d.selection[0].repo = long(201))), "selection[0] (sel-b) repo", "at most 200"],
    ["module too long", mutate((d) => (d.selection[0].modules = [long(201)])), "selection[0] (sel-b) modules[0]", "at most 200"],
    ["21 modules", mutate((d) => (d.selection[0].modules = many(21, (i) => `m${i}`))), "selection[0] (sel-b) modules", "at most 20"],
    [
      "modules over 2000 together",
      mutate((d) => (d.selection[0].modules = many(20, (i) => `${String.fromCharCode(97 + i)}${long(149)}`))),
      "selection[0] (sel-b) modules", "2000 characters together",
    ],
    ["empty task", mutate((d) => (d.selection[0].task = "  ")), "selection[0] (sel-b) task", "1 to 2000"],
    ["long task", mutate((d) => (d.selection[0].task = long(2001))), "selection[0] (sel-b) task", "1 to 2000"],
    ["control character", mutate((d) => (d.selection[0].task = "a\u0007b")), "selection[0] (sel-b) task", "control"],
    ["expect maybe", mutate((d) => (d.selection[0].expect = "maybe")), "selection[0] (sel-b) expect", "offered"],
    ["only positive", mutate((d) => (d.selection[0].expect = "offered")), "selection", "not-offered"],
    ["with empty", mutate((d) => (d.conflicts[0].with = [])), "conflicts[0] (conf) with", "list of skill ids"],
    ["with everything", mutate((d) => (d.conflicts[0].with = "everything")), "conflicts[0] (conf) with", "list of skill ids"],
    ["with bad id", mutate((d) => (d.conflicts[0].with = ["ok", "Bad Id"])), "conflicts[0] (conf) with[1]", "skill id"],
    ["with 31 ids", mutate((d) => (d.conflicts[0].with = many(31, (i) => `s-${i}`) as unknown as string[])), "conflicts[0] (conf) with", "at most 30"],
    ["context without a limit", mutate((d) => (d.context[0] = { id: "ctx" })), "context[0] (ctx)", "needs max_instruction_tokens"],
    ["limit 0", mutate((d) => (d.context[0].max_instruction_tokens = 0)), "context[0] (ctx) max_instruction_tokens", "between 1 and 20000"],
    ["limit 1.5", mutate((d) => (d.context[0].max_instruction_tokens = 1.5)), "context[0] (ctx) max_instruction_tokens", "whole number"],
    ["limit as text", mutate((d) => (d.context[0].max_description_chars = "100")), "context[0] (ctx) max_description_chars", "whole number"],
    ["limit 20001", mutate((d) => (d.context[0].max_instruction_tokens = 20001)), "context[0] (ctx) max_instruction_tokens", "between 1 and 20000"],
    ["policy key missing", mutate((d) => delete d.tools[0].policy.network), "tools[0] (tool) policy.network", "is required"],
    ["policy filesystem none", mutate((d) => (d.tools[0].policy.filesystem = "none")), "tools[0] (tool) policy.filesystem", "read"],
    ["policy extra key", mutate((d) => (d.tools[0].policy.missing = "stop")), "tools[0] (tool) policy", "unknown key"],
    ["quoted boolean", mutate((d) => (d.tools[0].policy.shell = "false")), "tools[0] (tool) policy.shell", "true or false"],
    ["unknown scenario key", mutate((d) => (d.tools[0].extra = 1)), "tools[0] (tool)", "unknown key"],
  ];
  it.each(refusals)("refuses: %s", (_name, raw, where, message) => {
    const r = parseEvaluationSuite(raw);
    expect(r.suite).toBeUndefined();
    expect(r.problems.some((p) => p.where === where && p.message.includes(message))).toBe(true);
  });

  it("refuses a YAML alias value through plainProblem", () => {
    const shared = { a: 1 };
    const r = parseEvaluationSuite({ schema: 1, selection: shared, again: shared });
    expect(r.suite).toBeUndefined();
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it("refuses credential-like text without repeating it", () => {
    const token = "ghp_" + "a1B2c3D4e5".repeat(4);
    const r = parseEvaluationSuite(mutate((d) => (d.selection[0].task = `use ${token}`)));
    expect(r.suite).toBeUndefined();
    expect(r.problems.some((p) => p.where === "selection[0] (sel-b) task" && p.message.includes("credential"))).toBe(true);
    expect(JSON.stringify(r.problems)).not.toContain(token);
  });

  it("never shows an id that looks like a credential", () => {
    const id = "sk-" + "a1b2c3d4e5".repeat(4);
    expect(credentialProblem(id)).toBeDefined();
    const r = parseEvaluationSuite(mutate((d) => (d.selection[0] = { id, repo: "../x", task: "", expect: "offered" })));
    expect(r.problems.length).toBeGreaterThan(1);
    for (const p of r.problems) {
      expect(p.where).not.toContain(id);
      expect(p.message).not.toContain(id);
    }
  });

  it("reports all problems together", () => {
    const r = problems(mutate((d) => {
      d.selection[0].task = "";
      d.tools[0].policy.network = 3;
    }));
    expect(r).toHaveLength(2);
  });
});

describe("evaluationSuiteDigest", () => {
  const profiles = new Map([["fixtures/a", profile({ "package.json": pkgJson("kafkajs") })], ["fixtures/b", profile({ "package.json": pkgJson("express") })]]);
  const suite = () => parseEvaluationSuite(good()).suite!;
  it("is stable under key order and scenario order", () => {
    const reordered = good();
    reordered.selection.reverse();
    reordered.selection = reordered.selection.map((s) => Object.fromEntries(Object.entries(s).reverse())) as Doc["selection"];
    const other = parseEvaluationSuite(reordered).suite!;
    const d = evaluationSuiteDigest(suite(), profiles);
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(evaluationSuiteDigest(other, profiles)).toBe(d);
  });
  it("changes with a scenario or a fixture profile", () => {
    const base = evaluationSuiteDigest(suite(), profiles);
    const changes: ((d: Record<string, any>) => void)[] = [
      (d) => (d.selection[0].task = "Other task"),
      (d) => (d.selection[0].modules = ["q"]),
      (d) => (d.context[0].max_instruction_tokens = 2999),
      (d) => (d.tools[0].policy.shell = true),
    ];
    for (const c of changes) expect(evaluationSuiteDigest(parseEvaluationSuite(mutate(c)).suite!, profiles)).not.toBe(base);
    const moved = new Map(profiles).set("fixtures/a", profile({ "package.json": pkgJson("pg") }));
    expect(evaluationSuiteDigest(suite(), moved)).not.toBe(base);
  });
  it("throws a TypeError when a profile is missing", () => {
    expect(() => evaluationSuiteDigest(suite(), new Map())).toThrow(TypeError);
  });
});

describe("suiteScenarios", () => {
  const record = (scenarios: { id: string; inputs: Record<string, string> }[]) => ({
    schema: 1,
    candidate: { id: "alpha", version: "1.0.0", digest: "sha256:" + "a".repeat(64), fingerprint: "fp", source: "s", repositoryKey: "github.com/a/b", commit: "1".repeat(40) },
    suite: { digest: "sha256:" + "b".repeat(64), scenarios },
    runtime: { foundry: "0.1.0" },
    evaluatedAt: "2026-10-13T10:00:00Z",
    dimensions: { selection: [1] },
    findings: [],
    evidence: [],
  });
  it("gives inputs a record accepts", () => {
    const list = suiteScenarios(parseEvaluationSuite(good()).suite!);
    expect(list.map((s) => s.id)).toEqual(["conf", "ctx", "sel-a", "sel-b", "tool"]);
    expect("record" in parseEvaluationRecord(record(list))).toBe(true);
  });
  it("holds at the limits", () => {
    const ids = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}${"x".repeat(62)}`);
    const modules = Array.from({ length: 20 }, (_, i) => `${String.fromCharCode(97 + i)}${"m".repeat(98)}`.slice(0, 99));
    // 20 modules of 99 characters and 19 commas is 1999; make it exactly 2000 by lengthening one.
    modules[0] = modules[0] + "m";
    expect(modules.join(",").length).toBe(2000);
    const suite = parseEvaluationSuite(mutate((d) => {
      d.conflicts[0].with = ids;
      d.selection[0].modules = modules;
    }));
    expect(suite.problems).toEqual([]);
    const list = suiteScenarios(suite.suite!);
    expect(list.find((s) => s.id === "conf")!.inputs.with!.length).toBe(30 * 64 + 29);
    expect("record" in parseEvaluationRecord(record(list))).toBe(true);
  });
});

describe("readEvaluationSuite", () => {
  const YAML = [
    "schema: 1",
    "selection:",
    "  - { id: sel-a, repo: fixtures/a, task: Add a retry., expect: offered }",
    "  - { id: sel-b, repo: fixtures/b, task: Do the thing, expect: not-offered }",
    "conflicts:",
    "  - { id: conf, with: all }",
    "context:",
    "  - { id: ctx, max_instruction_tokens: 3000 }",
    "tools:",
    "  - { id: tool, policy: { shell: false, network: false, filesystem: read } }",
    "",
  ].join("\n");
  function setup(extra: (root: string) => void = () => {}) {
    const root = tmp();
    mkdirSync(join(root, "fixtures/a"), { recursive: true });
    mkdirSync(join(root, "fixtures/b"), { recursive: true });
    writeFileSync(join(root, "fixtures/a/package.json"), pkgJson("kafkajs"));
    writeFileSync(join(root, "fixtures/b/package.json"), pkgJson("express"));
    writeFileSync(join(root, "suite.yaml"), YAML);
    extra(root);
    return join(root, "suite.yaml");
  }
  const refused = (path: string) => {
    const r = readEvaluationSuite(path);
    if (r.state !== "invalid") throw new Error(`expected invalid, got ${r.state}`);
    return r.problems;
  };

  it("reads a valid suite, with one profile per repo and a stable digest", () => {
    const path = setup();
    const r = readEvaluationSuite(path);
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect([...r.profiles.keys()].sort()).toEqual(["fixtures/a", "fixtures/b"]);
    const again = readEvaluationSuite(path);
    expect(again.state === "ok" && again.digest).toBe(r.digest);
  });
  it("gives none for a missing file", () => {
    expect(readEvaluationSuite(join(tmp(), "nope.yaml")).state).toBe("none");
  });
  it("refuses a link, a directory and bad YAML", () => {
    const path = setup((root) => {
      symlinkSync(join(root, "suite.yaml"), join(root, "link.yaml"));
      mkdirSync(join(root, "dir.yaml"));
      writeFileSync(join(root, "bad.yaml"), "a: [\n");
    });
    const root = dirname(path);
    expect(refused(join(root, "link.yaml"))[0]!.message).toContain("symbolic link");
    expect(refused(join(root, "dir.yaml"))[0]!.message).toContain("not a readable regular file");
    expect(refused(join(root, "bad.yaml"))[0]!.message).toMatch(/not valid YAML \(.* at line \d+, column \d+\)/);
  });
  it("refuses a fixture folder that is missing or a link", () => {
    const missing = setup((root) => rmSync(join(root, "fixtures/b"), { recursive: true }));
    expect(refused(missing)).toEqual([{ where: "selection (sel-b) repo", message: "is not a folder" }]);
    const linked = setup((root) => {
      rmSync(join(root, "fixtures/b"), { recursive: true });
      symlinkSync(join(root, "fixtures/a"), join(root, "fixtures/b"));
    });
    expect(refused(linked)[0]!.message).toBe("is a symbolic link");
  });
  const limits = "is larger than the fixture limits";
  const big = (n: number) => "x".repeat(n);
  const oversize: [string, (b: string) => void][] = [
    ["a file over the per-file limit", (b) => writeFileSync(join(b, "notes.md"), big(EVALUATION_SUITE_LIMITS.fixtureFileBytes + 1))],
    ["201 files", (b) => { for (let i = 0; i < 201; i++) writeFileSync(join(b, `f${i}.txt`), "x"); }],
    ["a lockfile over the per-file limit", (b) => writeFileSync(join(b, "package-lock.json"), big(EVALUATION_SUITE_LIMITS.fixtureFileBytes + 1))],
    ["twenty files over the total", (b) => { for (let i = 0; i < 20; i++) writeFileSync(join(b, `n${i}.md`), big(60000)); }],
    ["a large file below node_modules", (b) => { mkdirSync(join(b, "node_modules/x"), { recursive: true }); writeFileSync(join(b, "node_modules/x/i.js"), big(EVALUATION_SUITE_LIMITS.fixtureFileBytes + 1)); }],
    ["401 empty folders in one folder", (b) => { for (let i = 0; i < 401; i++) mkdirSync(join(b, `d${i}`)); }],
    ["folders nested too deep", (b) => { mkdirSync(join(b, "a/b/c/d/e/f/g/h/i"), { recursive: true }); }],
  ];
  it.each(oversize)("refuses %s", (_n, make) => {
    const path = setup((root) => make(join(root, "fixtures/b")));
    expect(refused(path)[0]).toMatchObject({ where: "selection (sel-b) repo" });
    expect(refused(path)[0]!.message).toContain(limits);
  });
  it("refuses a fixture that holds a symbolic link", () => {
    const path = setup((root) => symlinkSync(join(root, "fixtures/a"), join(root, "fixtures/b/loop")));
    expect(refused(path)[0]!.message).toBe("holds a symbolic link");
  });
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("refuses a fixture with an unreadable folder", () => {
    let locked = "";
    const path = setup((root) => {
      locked = join(root, "fixtures/b/sub");
      mkdirSync(locked);
      writeFileSync(join(locked, "a.txt"), "x");
      chmodSync(locked, 0o000);
    });
    try {
      expect(refused(path)[0]!.message).toMatch(/^cannot be read \(\w+\)$/);
    } finally {
      chmodSync(locked, 0o755);
    }
  });
  it("shows no path of the machine", () => {
    const path = setup((root) => rmSync(join(root, "fixtures/b"), { recursive: true }));
    expect(JSON.stringify(refused(path))).not.toContain(dirname(path));
  });
});
