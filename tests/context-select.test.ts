import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/evidence/identity.js";
import { hashContextBundle, hashContextSources, isSourceText, parseContextBundle, serializeContextBundle } from "../src/context/bundle.js";
import { compilePattern, hasGeneratedHeader, parseGeneratedAttributes, parseOwnership } from "../src/context/patterns.js";
import { API_SCHEMA_NAMES, CONTEXT_RULES, ContextSelectError, selectContext, type ContextSelection } from "../src/context/select.js";
import { CONTEXT_MAX_ENTRIES } from "../src/context/schema.js";
import { ContextSchemaError } from "../src/context/version.js";
import { BUDGET, COMMIT, EXPECTED_OMITTED, EXPECTED_SOURCES, FILES, NOW, SESSION, TASK, input, memorySnapshot, type FixtureFiles } from "./helpers/context-fixture.js";

const rows = (s: ContextSelection) => s.bundle.sources.map((x) => [x.uri, x.selection.rule, x.selection.reason, x.owners]);
const left = (s: ContextSelection) => s.bundle.omitted.map((x) => [x.uri, x.selection.rule, x.reason]);
const uris = (s: ContextSelection) => s.bundle.sources.map((x) => x.uri);
const omittedAs = (s: ContextSelection, uri: string) => s.bundle.omitted.find((o) => o.uri === uri)?.reason;
const textOf = (s: ContextSelection, uri: string) => Buffer.from(s.texts.get(s.bundle.sources.find((x) => x.uri === uri)!.content.path)!).toString("utf8");
/** A selection over just these files, with a task that names `paths`. */
const pick = (files: FixtureFiles, paths: string[] = [], more: Record<string, unknown> = {}) => selectContext(input({ snapshot: memorySnapshot(files), task: { paths }, ...more }));

describe("the context selector: what it picks", () => {
  const sel = selectContext(input());

  it("picks the issue, its comments, the notes, instructions, the ownership file, API schemas and named files, each with its rule", () => {
    expect(rows(sel)).toEqual(EXPECTED_SOURCES);
    for (const kind of ["issue", "issue-comment", "refinement-notes", "repository-file"]) expect(sel.bundle.sources.some((s) => s.kind === kind), kind).toBe(true);
    for (const reason of ["task", "refinement", "instructions", "ownership", "api-schema", "discovery"]) expect(sel.bundle.sources.some((s) => s.selection.reason === reason), reason).toBe(true);
  });

  it("records every expected source that is left out, with the reason", () => {
    expect(left(sel)).toEqual(EXPECTED_OMITTED);
  });

  it("names the policy profile by id and version, and never as a source", () => {
    expect(sel.bundle.policies).toEqual([{ id: "baseline", version: "2026.1" }]);
    expect(JSON.stringify(sel.bundle.sources)).not.toContain("baseline");
    const two = selectContext(input({ policies: [{ id: "zeta", version: "1" }, { id: "alpha", version: "2" }] }));
    expect(two.bundle.policies.map((p) => p.id)).toEqual(["alpha", "zeta"]);
    expect(() => selectContext(input({ policies: [{ id: "a", version: "1" }, { id: "a", version: "2" }] }))).toThrow(ContextSchemaError);
  });

  it("gives a valid bundle about the one commit, and the exact text of every source", () => {
    expect(parseContextBundle(JSON.parse(serializeContextBundle(sel.bundle)))).toEqual(sel.bundle);
    expect(sel.bundle.repository).toEqual({ repository: "acme/shop", commit: COMMIT });
    expect(sel.bundle.createdAt).toBe(NOW);
    expect(sel.texts.size).toBe(sel.bundle.sources.length);
    for (const s of sel.bundle.sources) {
      expect(isSourceText(s, sel.texts.get(s.content.path)!), s.uri).toBe(true);
      expect(s.content.path).toBe(`context/${s.id}`);
      if (s.kind === "repository-file") expect(s.revision).toEqual({ commit: COMMIT });
      expect(s.retrievedAt).toBe(NOW);
    }
    expect(textOf(sel, "repo:AGENTS.md")).toBe(FILES["AGENTS.md"]);
    expect(textOf(sel, "issue:12")).toBe(TASK.issue!.text);
    expect(textOf(sel, `refinement:${SESSION}`)).toBe("Accepted: round half up.");
    expect(sel.bundle.sources.find((s) => s.uri === "issue:12")!.revision).toEqual({ version: "2026-01-30T09:00:00Z" });
  });

  it("says what it could not write into the bundle, without the text", () => {
    expect(sel.diagnostics).toEqual([{ code: "unsafe-task-path", count: 2 }, { code: "owner-not-a-handle", count: 1, uri: "repo:.github/CODEOWNERS" }]);
    expect(JSON.stringify(sel.bundle) + JSON.stringify(sel.diagnostics)).not.toContain("example.com");
  });
});

describe("the context selector: the same input gives the same result", () => {
  it("gives the same bundle, the same hashes and the same texts when run twice", () => {
    const a = selectContext(input());
    const b = selectContext(input());
    expect(serializeContextBundle(a.bundle)).toBe(serializeContextBundle(b.bundle));
    expect(hashContextBundle(a.bundle)).toBe(hashContextBundle(b.bundle));
    expect([...a.texts.entries()].map(([k, v]) => [k, sha256Hex(v)])).toEqual([...b.texts.entries()].map(([k, v]) => [k, sha256Hex(v)]));
  });

  it("has one pinned result for the fixture: this hash changes only when a rule or the fixture changes", () => {
    const sel = selectContext(input());
    expect(sel.bundle.sources.find((s) => s.uri === "repo:AGENTS.md")!.content).toEqual({ path: "context/s-00e013152dd222bc", sha256: sha256Hex("# Rules\nRun the tests.\n"), bytes: 23 });
    expect(hashContextSources(sel.bundle)).toBe("e4d57bab565324e47deed6bdfc02e9c254b7189f03c3bd56494abad61fc255d7");
  });

  it("does not depend on the run, the time, the order of the inputs or the order of the files", () => {
    const base = hashContextSources(selectContext(input()).bundle);
    const shuffled: FixtureFiles = Object.fromEntries(Object.entries(FILES).reverse());
    const task = { ...TASK, issue: { ...TASK.issue!, comments: [...TASK.issue!.comments!].reverse() }, paths: [...TASK.paths!].reverse() };
    const other = selectContext(input({ runId: "another-run", now: "2026-02-01T00:00:00.000Z", snapshot: memorySnapshot(shuffled), task, rules: CONTEXT_RULES.map((r) => r.id).reverse() }));
    expect(hashContextSources(other.bundle)).toBe(base);
    expect(left(other)).toEqual(EXPECTED_OMITTED);
    // and it does change with the commit, a file and the task
    expect(hashContextSources(selectContext(input({ snapshot: memorySnapshot(FILES, "d".repeat(40)) })).bundle)).not.toBe(base);
    expect(hashContextSources(selectContext(input({ snapshot: memorySnapshot({ ...FILES, "AGENTS.md": "# Rules\n" }) })).bundle)).not.toBe(base);
    expect(hashContextSources(selectContext(input({ task: { ...TASK, issue: { ...TASK.issue!, text: "Other" } } })).bundle)).not.toBe(base);
  });
});

describe("the context selector: instructions, ownership, documentation", () => {
  it("records both instruction files as missing when the root has neither, and the README and the ownership file too", () => {
    const sel = pick({ "src/a.ts": "a\n" });
    expect(left(sel)).toEqual([
      ["repo:.github/CODEOWNERS", "ownership-file", "missing"],
      ["repo:AGENTS.md", "root-instructions", "missing"],
      ["repo:CLAUDE.md", "root-instructions", "missing"],
      ["repo:README.md", "root-readme", "missing"],
    ]);
    expect(sel.bundle.sources).toEqual([]);
  });

  it("is content with one instruction file, and picks the README when there is one", () => {
    const sel = pick({ "CLAUDE.md": "c\n", "README.md": "r\n", CODEOWNERS: "* @a\n" });
    expect(rows(sel)).toEqual([["repo:CLAUDE.md", "root-instructions", "instructions", ["@a"]], ["repo:CODEOWNERS", "ownership-file", "ownership", ["@a"]], ["repo:README.md", "root-readme", "discovery", ["@a"]]]);
    expect(sel.bundle.omitted).toEqual([]);
  });

  it("finds nested instructions only above the paths the task names: a file, a folder, or a file that does not exist yet", () => {
    const files = { "AGENTS.md": "r\n", "a/AGENTS.md": "a\n", "a/b/CLAUDE.md": "b\n", "a/b/c/AGENTS.md": "c\n", "a/b/c/x.ts": "x\n", "z/AGENTS.md": "z\n", "README.md": "r\n", CODEOWNERS: "" };
    const nested = (paths: string[]) => rows(pick(files, paths)).filter((r) => r[1] === "nested-instructions").map((r) => r[0]);
    expect(nested([])).toEqual([]);
    expect(nested(["a/b/c/x.ts"])).toEqual(["repo:a/AGENTS.md", "repo:a/b/CLAUDE.md", "repo:a/b/c/AGENTS.md"]);
    expect(nested(["a/b"])).toEqual(["repo:a/AGENTS.md", "repo:a/b/CLAUDE.md"]);
    expect(nested(["a/b/new.ts"])).toEqual(["repo:a/AGENTS.md", "repo:a/b/CLAUDE.md"]);
    expect(nested(["a/b/c/x.ts", "z"])).toContain("repo:z/AGENTS.md");
    // a named folder is a scope, not an expected file
    expect(pick(files, ["a/b"]).bundle.omitted).toEqual([]);
  });

  it("uses the first ownership file in the order of the host, and takes owners only from a file that is in the bundle", () => {
    expect(uris(pick({ CODEOWNERS: "* @root\n", "docs/CODEOWNERS": "* @docs\n", "AGENTS.md": "x\n", "README.md": "r\n" }))).toEqual(["repo:AGENTS.md", "repo:CODEOWNERS", "repo:README.md"]);
    expect(rows(pick({ "docs/CODEOWNERS": "* @docs\n", "AGENTS.md": "x\n" }))[0]).toEqual(["repo:AGENTS.md", "root-instructions", "instructions", ["@docs"]]);
    const tooBig = pick({ CODEOWNERS: `* @root\n${"#".repeat(200)}\n`, "AGENTS.md": "x\n" }, [], { budget: { maxSources: 5, maxSourceBytes: 100, maxTotalBytes: 500 } });
    expect(omittedAs(tooBig, "repo:CODEOWNERS")).toBe("over-budget");
    expect(tooBig.bundle.sources.map((s) => s.owners)).toEqual([[]]);
    const link = pick({ ".github/CODEOWNERS": { link: "../CODEOWNERS" }, CODEOWNERS: "* @root\n", "AGENTS.md": "x\n" });
    expect(omittedAs(link, "repo:.github/CODEOWNERS")).toBe("unsupported");
    expect(uris(link)).toEqual(["repo:AGENTS.md"]);
  });

  it("finds API schemas by name, nearest to the root first, and not in copies of other projects", () => {
    const files: FixtureFiles = { "AGENTS.md": "x\n", "README.md": "r\n", CODEOWNERS: "" };
    for (const n of API_SCHEMA_NAMES) files[`api/${n}`] = "x\n";
    Object.assign(files, { "a.proto": "p\n", "deep/er/b.avsc": "{}\n", "x/pay.openapi.yml": "o\n", "x/q.graphqls": "q\n", "vendor/v.proto": "v\n", "x/target/t.proto": "t\n", ".git-hooks/h.proto": "h\n", "x/.proto": "n\n", "x/openapi.yaml.bak": "n\n", "x/proto": "n\n" });
    const found = rows(pick(files)).filter((r) => r[1] === "api-schema-files").map((r) => r[0]);
    expect(found).toEqual(["repo:a.proto", ...[...API_SCHEMA_NAMES].sort().map((n) => `repo:api/${n}`), "repo:deep/er/b.avsc", "repo:x/pay.openapi.yml", "repo:x/q.graphqls"]);
    // with room for two sources after the instructions and the ownership file, the two nearest to the root win
    const few = pick(files, [], { budget: { maxSources: 4, maxSourceBytes: 100, maxTotalBytes: 500 } });
    expect(uris(few).filter((u) => /proto|api\//.test(u))).toEqual(["repo:a.proto", "repo:api/asyncapi.json"]);
  });
});

describe("the context selector: generated files, links and files that are not text", () => {
  it("leaves out a file marked linguist-generated, where the nearest .gitattributes decides", () => {
    const files = { ".gitattributes": "gen/** linguist-generated\n*.lock linguist-generated=true\nkeep.lock -linguist-generated\n", "gen/a.ts": "a\n", "gen/sub/.gitattributes": "*.ts linguist-generated=false\n", "gen/sub/b.ts": "b\n", "gen/sub/c.js": "c\n", "x/y.lock": "l\n", "keep.lock": "k\n", "plain.ts": "p\n" };
    const sel = pick(files, ["gen/a.ts", "gen/sub/b.ts", "gen/sub/c.js", "x/y.lock", "keep.lock", "plain.ts"]);
    const named = (reason: string) => left(sel).filter((r) => r[1] === "named-in-task" && r[2] === reason).map((r) => r[0]);
    expect(named("generated")).toEqual(["repo:gen/a.ts", "repo:gen/sub/c.js", "repo:x/y.lock"]);
    expect(uris(sel)).toEqual(["repo:gen/sub/b.ts", "repo:keep.lock", "repo:plain.ts"]);
    // a marked file is never read
    const snapshot = memorySnapshot(files);
    selectContext(input({ snapshot, task: { paths: ["gen/a.ts"] } }));
    expect(snapshot.reads).not.toContain("gen/a.ts");
  });

  it("leaves out a file with a generated header, also as an instruction file", () => {
    const sel = pick({ "AGENTS.md": "<!-- Generated by tool. Do not edit. -->\n# Rules\n", "a.go": "// Code generated by protoc-gen-go. DO NOT EDIT.\npackage a\n", "b.md": "# Guide\nThis page is generated by hand.\n" }, ["a.go", "b.md"]);
    expect(omittedAs(sel, "repo:AGENTS.md")).toBe("generated");
    expect(omittedAs(sel, "repo:a.go")).toBe("generated");
    expect(uris(sel)).toEqual(["repo:b.md"]);
  });

  it("says a .gitattributes file it cannot read was not read, and goes on", () => {
    const sel = pick({ ".gitattributes": new Uint8Array([0xff, 0xfe, 0x00]), "a.ts": "a\n" }, ["a.ts"]);
    expect(uris(sel)).toEqual(["repo:a.ts"]);
    expect(sel.diagnostics).toContainEqual({ code: "attributes-not-read", count: 1, uri: "repo:.gitattributes" });
    const big = pick({ ".gitattributes": `${"#".repeat(300_000)}\n* linguist-generated\n`, "a.ts": "a\n" }, ["a.ts"], { budget: { maxSources: 5, maxSourceBytes: 500_000, maxTotalBytes: 500_000 } });
    expect(big.diagnostics).toContainEqual({ code: "attributes-not-read", count: 1, uri: "repo:.gitattributes" });
  });

  it("never reads a link or a submodule, and leaves out a file that is not UTF-8 text", () => {
    const files: FixtureFiles = { link: { link: "/etc/passwd" }, sub: { submodule: true }, "bin.dat": new Uint8Array([1, 0, 2]), "latin.txt": new Uint8Array([0x63, 0x61, 0x66, 0xe9]), "ok.txt": "café\n" };
    const snapshot = memorySnapshot(files);
    const sel = selectContext(input({ snapshot, task: { paths: Object.keys(files) } }));
    expect(left(sel).filter((r) => r[1] === "named-in-task")).toEqual([["repo:bin.dat", "named-in-task", "unsupported"], ["repo:latin.txt", "named-in-task", "unsupported"], ["repo:link", "named-in-task", "unsupported"], ["repo:sub", "named-in-task", "unsupported"]]);
    expect(uris(sel)).toEqual(["repo:ok.txt"]);
    expect(snapshot.reads).not.toContain("link");
    expect(snapshot.reads).not.toContain("sub");
  });
});

describe("the context selector: the budget", () => {
  const files = { "AGENTS.md": "a".repeat(40), CODEOWNERS: "* @o\n", "README.md": "r".repeat(40), "big.ts": "b".repeat(101), "one.ts": "1".repeat(60), "two.ts": "2".repeat(60), "tiny.ts": "t" };
  const task = { issue: { number: 1, text: "i".repeat(50), version: "v1", comments: [{ id: 1, text: "c".repeat(50), version: "v1" }, { id: 2, text: "d".repeat(50), version: "v1" }] }, paths: ["big.ts", "one.ts", "two.ts", "tiny.ts"] };

  it("leaves out a file above the size of one source without reading it", () => {
    const snapshot = memorySnapshot(files);
    const sel = selectContext(input({ snapshot, task, budget: { maxSources: 50, maxSourceBytes: 100, maxTotalBytes: 10_000 } }));
    expect(omittedAs(sel, "repo:big.ts")).toBe("over-budget");
    expect(snapshot.reads).not.toContain("big.ts");
    expect(sel.bundle.omitted).toHaveLength(1);
  });

  it("fills the total in the order of the rules: what a later rule found is left out first, and a smaller one may still fit", () => {
    // issue 50 + AGENTS 40 + CODEOWNERS 5 + comment 50 = 145; the second comment (50) does not fit in 190, one.ts (60) and two.ts do not, tiny.ts (1) does, README (40) does
    const sel = selectContext(input({ snapshot: memorySnapshot(files), task, budget: { maxSources: 50, maxSourceBytes: 100, maxTotalBytes: 190 } }));
    expect(uris(sel)).toEqual(["issue:1", "issue:1/comment/1", "repo:AGENTS.md", "repo:CODEOWNERS", "repo:README.md", "repo:tiny.ts"]);
    expect(left(sel)).toEqual([["issue:1/comment/2", "task-comments", "over-budget"], ["repo:big.ts", "named-in-task", "over-budget"], ["repo:one.ts", "named-in-task", "over-budget"], ["repo:two.ts", "named-in-task", "over-budget"]]);
    expect(sel.bundle.sources.reduce((n, s) => n + s.content.bytes, 0)).toBeLessThanOrEqual(190);
  });

  it("stops at the number of sources, most important first", () => {
    const sel = selectContext(input({ snapshot: memorySnapshot(files), task, budget: { maxSources: 3, maxSourceBytes: 100, maxTotalBytes: 10_000 } }));
    expect(uris(sel)).toEqual(["issue:1", "repo:AGENTS.md", "repo:CODEOWNERS"]);
    expect(new Set(sel.bundle.omitted.map((o) => o.reason))).toEqual(new Set(["over-budget"]));
    expect(sel.bundle.omitted).toHaveLength(7);
  });

  it("lists at most the omissions a bundle can hold, and says how many it dropped", () => {
    const many: FixtureFiles = { "AGENTS.md": "a\n", "README.md": "r\n", CODEOWNERS: "" };
    for (let i = 0; i < CONTEXT_MAX_ENTRIES + 5; i++) many[`p/f${String(i).padStart(4, "0")}.proto`] = "x\n";
    const sel = pick(many, [], { budget: { maxSources: 3, maxSourceBytes: 100, maxTotalBytes: 1000 } });
    expect(sel.bundle.omitted).toHaveLength(CONTEXT_MAX_ENTRIES);
    expect(sel.diagnostics).toEqual([{ code: "omissions-truncated", count: 5 }]);
    // the first schema still fitted; of the 1004 others and the README, the last five (the least important) are not listed
    expect(uris(sel)).toContain("repo:p/f0000.proto");
    expect(omittedAs(sel, "repo:p/f0001.proto")).toBe("over-budget");
    expect(omittedAs(sel, "repo:p/f1000.proto")).toBe("over-budget");
    expect(omittedAs(sel, "repo:p/f1001.proto")).toBeUndefined();
    expect(omittedAs(sel, "repo:README.md")).toBeUndefined();
  });
});

describe("the context selector: classification, freshness, consumers, rules", () => {
  it("leaves out what is more private than the run may be given", () => {
    const sel = selectContext(input({ classification: "confidential", maxClassification: "internal", task: { ...TASK, issue: { ...TASK.issue!, classification: "public" } } }));
    expect(uris(sel)).toEqual(["issue:12"]);
    expect(omittedAs(sel, "repo:AGENTS.md")).toBe("classification");
    expect(omittedAs(sel, "issue:12/comment/20")).toBe("classification");
    expect(omittedAs(sel, "repo:README.md")).toBe("missing");
    expect((sel.bundle.sources[0] as { classification: string }).classification).toBe("public");
  });

  it("leaves out a fetched input that is too old, and never a repository file", () => {
    const task = { ...TASK, issue: { ...TASK.issue!, retrievedAt: "2026-01-31T10:00:00.000Z" } };
    const sel = selectContext(input({ task, taskMaxAgeSeconds: 3600 }));
    expect(omittedAs(sel, "issue:12")).toBe("stale");
    expect(uris(sel)).toContain("issue:12/comment/20");
    expect(sel.bundle.sources.find((s) => s.uri === "issue:12/comment/20")!.freshness).toEqual({ maxAgeSeconds: 3600 });
    expect(sel.bundle.sources.find((s) => s.uri === "repo:AGENTS.md")!.freshness).toEqual({ maxAgeSeconds: null });
    const fresh = selectContext(input({ task: { ...TASK, issue: { ...TASK.issue!, retrievedAt: "2026-01-31T11:00:00.000Z" } }, taskMaxAgeSeconds: 3600 }));
    expect(fresh.bundle.sources.find((s) => s.uri === "issue:12")!.retrievedAt).toBe("2026-01-31T11:00:00.000Z");
  });

  it("gives every source the consumers asked for, in the fixed order", () => {
    expect(selectContext(input()).bundle.sources[0]!.consumers).toEqual(["planner", "coder", "reviewer", "tester"]);
    expect(selectContext(input({ consumers: ["tester", "planner", "tester"] })).bundle.sources[0]!.consumers).toEqual(["planner", "tester"]);
  });

  it("runs only the rules asked for, and an address is decided by the first rule that finds it", () => {
    const only = selectContext(input({ rules: ["task-issue", "ownership-file"] }));
    expect(uris(only)).toEqual(["issue:12", "repo:.github/CODEOWNERS"]);
    expect(only.bundle.omitted).toEqual([]);
    const twice = pick({ "AGENTS.md": "x\n", "a.proto": "p\n", "README.md": "r\n", CODEOWNERS: "" }, ["AGENTS.md", "a.proto", "README.md"]);
    expect(rows(twice).map((r) => [r[0], r[1]])).toEqual([["repo:AGENTS.md", "root-instructions"], ["repo:CODEOWNERS", "ownership-file"], ["repo:README.md", "named-in-task"], ["repo:a.proto", "named-in-task"]]);
  });

  it("has rule ids that a bundle accepts, each once", () => {
    const ids = CONTEXT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9][a-z0-9._-]{0,99}$/);
  });
});

describe("the context selector: input it refuses", () => {
  const bad = (more: Record<string, unknown>) => () => selectContext(input(more as never));

  it("refuses input that is not valid, naming the field and never the value", () => {
    expect(bad({ runId: "../x" })).toThrow(/runId/);
    expect(bad({ now: "yesterday" })).toThrow(/now/);
    expect(bad({ budget: { ...BUDGET, maxSources: 0 } })).toThrow(/budget\.maxSources/);
    expect(bad({ budget: { maxSources: 1, maxSourceBytes: 10, maxTotalBytes: 5 } })).toThrow(/budget\.maxSourceBytes/);
    expect(bad({ rules: ["no-such-rule"] })).toThrow(/rules/);
    expect(bad({ extra: 1 })).toThrow(ContextSelectError);
    expect(bad({ task: { issue: { number: 0, text: "", version: "v" } } })).toThrow(/task\.issue\.number/);
    expect(bad({ task: { issue: { number: 1, text: "t", version: "has a space" } } })).toThrow(/task\.issue\.version/);
    expect(bad({ task: { issue: { number: 1, text: "t", version: "v", comments: [{ id: 2, text: "a", version: "v" }, { id: 2, text: "b", version: "v" }] } } })).toThrow(/same id twice/);
    expect(bad({ task: { refinement: { sessionId: "not-a-uuid", text: "t", version: "v" } } })).toThrow(/task\.refinement\.sessionId/);
    expect(bad({ task: { issue: { number: 1, text: "t", version: "v", retrievedAt: "2026-01-31T12:00:00.001Z" } } })).toThrow(/retrievedAt is after now/);
    expect(bad({ repository: "/home/someone/repo" })).toThrow(ContextSchemaError);
    try {
      bad({ runId: "secret value" })();
    } catch (e) {
      expect((e as Error).message).not.toContain("secret value");
    }
  });

  it("does not trust the snapshot: an unsafe path is never looked at, a path twice or a wrong size is refused", () => {
    const base = memorySnapshot({ "AGENTS.md": "x\n", "README.md": "r\n", CODEOWNERS: "" });
    const unsafe = { ...base, entries: [...base.entries, { path: "../outside.proto", kind: "file" as const, bytes: 1 }, { path: "a//b.proto", kind: "file" as const, bytes: 1 }], unlisted: 2 };
    const sel = selectContext(input({ snapshot: unsafe, task: {} }));
    expect(uris(sel)).toEqual(["repo:AGENTS.md", "repo:CODEOWNERS", "repo:README.md"]);
    expect(sel.diagnostics).toEqual([{ code: "unlisted-entries", count: 4 }]);
    expect(bad({ snapshot: { ...base, entries: [...base.entries, base.entries[0]] } })).toThrow(/twice/);
    expect(bad({ snapshot: { ...base, read: () => new Uint8Array(3) }, task: {} })).toThrow(/another size/);
  });
});

describe("the context selector: the foundry mark on a comment", () => {
  const withFlag = (flag?: unknown) => ({
    issue: { ...TASK.issue!, comments: TASK.issue!.comments!.map((c) => (c.id === 34 ? { ...c, ...(flag === undefined ? {} : { foundry: flag }) } : c)) },
  });
  const run = (flag?: unknown) => selectContext(input({ snapshot: memorySnapshot(), task: withFlag(flag) as never }));

  it("copies foundry: true to that comment's source only", () => {
    expect(run(true).bundle.sources.filter((x) => "foundry" in x).map((x) => x.uri)).toEqual(["issue:12/comment/34"]);
    expect(run().bundle.sources.some((x) => "foundry" in x)).toBe(false);
  });
  it("refuses false, and refuses the field on the issue", () => {
    expect(() => run(false)).toThrow(ContextSelectError);
    expect(() => run(false)).toThrow(/task\.issue\.comments\.\d+\.foundry/);
    expect(() => selectContext(input({ snapshot: memorySnapshot(), task: { issue: { ...TASK.issue!, foundry: true } } as never }))).toThrow(ContextSelectError);
  });
  it("gives the same ids and hashes with and without the flag", () => {
    const pairs = (s: ContextSelection) => s.bundle.sources.map((x) => [x.id, x.content.sha256]);
    expect(pairs(run(true))).toEqual(pairs(run()));
  });
});

describe("path patterns, ownership files and generated marks", () => {
  const owners = (pattern: string, path: string) => compilePattern(pattern, "owners")!(path);
  const attr = (pattern: string, path: string) => compilePattern(pattern, "file")!(path);

  it("matches CODEOWNERS patterns the way the host does", () => {
    const cases: [string, string, boolean][] = [
      ["*", "a/b/c.ts", true], ["*.js", "a/b/c.js", true], ["*.js", "a/b/c.ts", false],
      ["/build/logs/", "build/logs/a/b.txt", true], ["/build/logs/", "x/build/logs/a.txt", false], ["/build/logs/", "build/logs", false],
      ["docs/*", "docs/a.md", true], ["docs/*", "docs/a/b.md", false], ["docs/*", "x/docs/a.md", false],
      ["apps/", "x/apps/a.ts", true], ["apps/", "apps", false], ["/docs/", "docs/a/b.md", true],
      ["/apps/github", "apps/github/a.ts", true], ["/apps/github", "apps/github", true], ["/apps/github", "apps/githubx", false],
      ["**/logs", "a/b/logs/x.txt", true], ["**/logs", "logs/x.txt", true], ["a/**/z.ts", "a/z.ts", true], ["a/**/z.ts", "a/b/c/z.ts", true], ["a/**", "a/b/c", true], ["a/**", "a", false],
      ["f?o.ts", "x/foo.ts", true], ["f?o.ts", "x/fo.ts", false], ["*a*b*c", "xaybzc", true], ["*a*b*c", "xaybz", false],
    ];
    for (const [pattern, path, want] of cases) expect(owners(pattern, path), `${pattern} ~ ${path}`).toBe(want);
  });

  it("matches .gitattributes patterns against the whole path only", () => {
    expect(attr("*.lock", "a/b/c.lock")).toBe(true);
    expect(attr("gen/**", "gen/a/b.ts")).toBe(true);
    expect(attr("gen", "gen/a.ts")).toBe(false);
    expect(attr("/a.ts", "x/a.ts")).toBe(false);
    expect(compilePattern("gen/", "file")).toBeUndefined();
  });

  it("skips a pattern it does not understand, and is not slowed down by a hostile one", () => {
    for (const p of ["", "[a-z].ts", "a\\ b", "!x", '"a b"', "a//b", "../x", "a**b", "x".repeat(600), Array(70).fill("a").join("/")]) expect(compilePattern(p, "owners"), p).toBeUndefined();
    const started = performance.now();
    expect(compilePattern(`${"*a".repeat(200)}*b`, "owners")!("a".repeat(1000))).toBe(false);
    expect(compilePattern(Array(30).fill("**/a").join("/"), "owners")!(`${Array(60).fill("a").join("/")}/b`)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("reads owners: the last matching line decides, handles only, each once and sorted", () => {
    const o = parseOwnership(["# all", "* @z @a @z", "*.md someone@example.com @Org-1/docs.team", "/secret/", "bad[pattern] @x", "  /src/  @dev  # @not-an-owner", "*.txt not-a-handle @"].join("\r\n"));
    expect(o.ownersOf("a.ts")).toEqual(["@a", "@z"]);
    expect(o.ownersOf("x/a.md")).toEqual(["@Org-1/docs.team"]);
    expect(o.ownersOf("secret/a.ts")).toEqual([]);
    expect(o.ownersOf("src/a.ts")).toEqual(["@dev"]);
    expect(o.ownersOf("a.txt")).toEqual([]);
    expect(o.dropped).toBe(3);
    expect(parseOwnership(`* ${Array.from({ length: 25 }, (_, i) => `@u${String(i).padStart(2, "0")}`).join(" ")}\n`).ownersOf("a")).toHaveLength(20);
    expect(parseOwnership("").ownersOf("a")).toEqual([]);
  });

  it("reads linguist-generated in all its spellings", () => {
    const g = parseGeneratedAttributes(["*.a linguist-generated", "*.b linguist-generated=true text", "*.c -linguist-generated", "*.d linguist-generated=false", "*.e !linguist-generated", "*.f text eol=lf", "# *.g linguist-generated", "x.a -linguist-generated"].join("\n"));
    expect(["q.a", "q.b", "q.c", "q.d", "q.e", "q.f", "q.g", "x.a", "d/x.a"].map(g)).toEqual([true, true, false, false, false, undefined, undefined, false, false]);
  });

  it("sees a generated header only in a comment in the first lines", () => {
    for (const t of ["# Generated by scripts/build.mjs\n", "\n// @generated\n", "/* DO NOT EDIT */\n", "-- automatically generated\n", "; auto-generated\n", "a\nb\nc\nd\n# generated by x\n"]) expect(hasGeneratedHeader(t), t).toBe(true);
    for (const t of ["This file is generated by hand.\n", "const s = 'Generated by me';\n", "a\nb\nc\nd\ne\n# Generated by x\n", "# Regenerated bytes\n", ""]) expect(hasGeneratedHeader(t), t).toBe(false);
  });
});
