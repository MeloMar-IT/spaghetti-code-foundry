import { describe, expect, it } from "vitest";
import { ACTIONS_FILE_MAX, actionsSummary, commitFromGh, parseWorkflows, readActionsFile, releaseFromGh } from "../src/deps/actions.js";
import {
  depsGoEnv, depsPipEnv, depsToolEnv, gradleFromRun, goFromRun, parseGoModules, parseGradleReport, parsePipOutdated, pep440Compare, pipClass, pipFromRun,
  splitJsonStream,
} from "../src/deps/ecosystems.js";
import { OSV_TOOLS, osvFromRun, osvKey, parseOsvReport } from "../src/deps/osv.js";

const gradleReport = (deps: unknown[], unresolved = 0) => JSON.stringify({ outdated: { dependencies: deps }, unresolved: { count: unresolved } });
const dep = (group: string, name: string, version: string, available: Record<string, string | null>) => ({ group, name, version, available });

describe("parseGradleReport", () => {
  it("reads the outdated dependencies", () => {
    const p = parseGradleReport(gradleReport([
      dep("com.google.guava", "guava", "30.0-jre", { release: "33.0.0-jre", milestone: null }),
      dep("org.x", "y", "1.2.0", { release: null, milestone: "1.2.5" }),
      dep("org.x", "y", "1.2.0", { release: null, milestone: "1.2.5" }),
      dep("a;rm", "evil", "1.0", { release: "2.0" }),
      dep("org.z", "none", "1.0", {}),
    ], 2));
    expect(p).toEqual({
      ok: true, incomplete: 2,
      found: [{ name: "com.google.guava:guava", current: "30.0-jre", latest: "33.0.0-jre" }, { name: "org.x:y", current: "1.2.0", latest: "1.2.5" }],
    });
  });
  it("fails on text that is not a report", () => {
    expect(parseGradleReport("nope").ok).toBe(false);
    expect(parseGradleReport("[]").ok).toBe(false);
    expect(parseGradleReport("{}")).toEqual({ ok: true, found: [], incomplete: 0 });
  });
});

describe("gradleFromRun", () => {
  const ok = { status: 0, stdout: "" };
  it("uses the report", () => {
    const r = gradleFromRun(ok, "gradle", gradleReport([dep("g", "a", "1.0", { release: "1.1" })]));
    expect(r).toMatchObject({ ok: true, found: [{ name: "g:a" }] });
  });
  it("says what the missing plugin means", () => {
    const r = gradleFromRun({ status: 1, stderr: "* What went wrong:\nTask 'dependencyUpdates' not found in root project 'x'." }, "./gradlew");
    expect(r).toMatchObject({ ok: false, note: "the Gradle versions plugin (com.github.ben-manes.versions) is not applied; Gradle was skipped" });
  });
  it("turns every other failure into a note", () => {
    expect(gradleFromRun({ error: { code: "ENOENT" } }, "gradle").note).toBe("gradle was not found");
    expect(gradleFromRun({ error: { code: "ETIMEDOUT" } }, "gradle").note).toBe("gradle did not finish in 20 min");
    expect(gradleFromRun({ status: 1 }, "gradle").note).toMatch(/exit code 1/);
    expect(gradleFromRun(ok, "gradle").note).toBe("Gradle wrote no report");
    expect(gradleFromRun(ok, "gradle", "not json")).toMatchObject({ ok: false, note: "the Gradle report is not JSON" });
  });
});

describe("PEP 440", () => {
  it.each([
    ["1.0.post2", "1.0.post10", -1], ["2.0rc2", "2.0rc10", -1], ["2.0rc1", "2.0", -1], ["1.0", "1.0.0", 0], ["1!1.0", "2.0", 1],
    ["1.0.dev1", "1.0a1", -1], ["1.0", "1.0.post1", -1], ["1.0.post1.dev1", "1.0.post1", -1], ["2.0b1", "2.0a9", 1], ["1.0+local", "1.0", 0], ["v1.2", "1.10", -1],
  ])("%s vs %s is %i", (a, b, want) => {
    expect(pep440Compare(a, b)).toBe(want);
  });
  it("gives undefined for a version that does not parse", () => {
    expect(pep440Compare("1.0-foo", "1.0")).toBeUndefined();
    expect(pep440Compare("", "1.0")).toBeUndefined();
  });
  it.each([
    ["1.0.post2", "1.0.post10", "patch"], ["2.0rc1", "2.0", "patch"], ["1.2", "1.3", "minor"], ["1.2.3", "2.0", "major"],
    ["1.0", "1!0.5", "major"], ["1.0", "1.0.0", undefined], ["2.0", "1.9", undefined],
  ])("class of %s → %s is %s", (a, b, want) => {
    expect(pipClass(a, b)).toBe(want);
  });
});

describe("parsePipOutdated and pipFromRun", () => {
  it("reads the entries and drops what it cannot use", () => {
    const text = JSON.stringify([
      { name: "requests", version: "2.0.0", latest_version: "2.31.0" },
      { name: "requests", version: "2.0.0", latest_version: "2.31.0" },
      { name: "bad;name", version: "1.0", latest_version: "2.0" },
      { name: "odd", version: "1.0-foo", latest_version: "2.0" },
    ]);
    expect(parsePipOutdated(text)).toEqual({ ok: true, incomplete: 1, found: [{ name: "requests", current: "2.0.0", latest: "2.31.0" }] });
  });
  it("fails on text that is not a list", () => {
    expect(parsePipOutdated("{}").ok).toBe(false);
    expect(parsePipOutdated("oops").ok).toBe(false);
    expect(parsePipOutdated("")).toEqual({ ok: true, found: [], incomplete: 0 });
  });
  it("turns failures into notes", () => {
    expect(pipFromRun({ error: { code: "ENOENT" } }, "pip").note).toBe("pip was not found");
    expect(pipFromRun({ status: 1 }, "pip").note).toMatch(/exit code 1/);
    expect(pipFromRun({ status: 0, stdout: "[]" }, "pip").ok).toBe(true);
  });
});

describe("splitJsonStream", () => {
  it("splits objects with and without separators", () => {
    expect(splitJsonStream('{"a":1}{"b":2}').items).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitJsonStream('{"a":{"x":1}}\n{"b":2}\n').items).toEqual(['{"a":{"x":1}}', '{"b":2}']);
  });
  it("ignores braces and quotes inside strings", () => {
    const text = '{"a":"}{ \\" }"}{"b":1}';
    expect(splitJsonStream(text)).toEqual({ items: ['{"a":"}{ \\" }"}', '{"b":1}'], truncated: false });
  });
  it("sees cut-off input", () => {
    expect(splitJsonStream('{"a":1}{"b":').truncated).toBe(true);
    expect(splitJsonStream('{"a":"x').truncated).toBe(true);
    expect(splitJsonStream("")).toEqual({ items: [], truncated: false });
  });
});

describe("parseGoModules and goFromRun", () => {
  const mods = [
    { Path: "example.com/app", Main: true, Version: "" },
    { Path: "github.com/a/direct", Version: "v1.2.0", Update: { Path: "github.com/a/direct", Version: "v1.3.0" } },
    { Path: "github.com/a/indirect", Version: "v1.0.0", Indirect: true, Update: { Version: "v2.0.0" } },
    { Path: "github.com/a/replaced", Version: "v1.0.0", Replace: { Path: "../x" }, Update: { Version: "v2.0.0" } },
    { Path: "github.com/a/current", Version: "v1.0.0" },
    { Path: "github.com/a/pseudo", Version: "v0.0.0-20200101000000-abcdef123456", Update: { Version: "v0.1.0" } },
    { Path: "github.com/a/inc", Version: "v2.0.0+incompatible", Update: { Version: "v2.1.0+incompatible" } },
    { Path: "github.com/a/broken", Version: "v1.0.0", Error: { Err: "no" } },
  ];
  const stream = mods.map((m) => JSON.stringify(m, null, 2)).join("\n");
  it("lists direct modules with an update", () => {
    const p = parseGoModules(stream);
    expect(p).toMatchObject({ ok: true, incomplete: 1 });
    if (!p.ok) return;
    expect(p.found.map((f) => `${f.name} ${f.current} ${f.latest}`)).toEqual([
      "github.com/a/direct v1.2.0 v1.3.0", "github.com/a/pseudo v0.0.0-20200101000000-abcdef123456 v0.1.0", "github.com/a/inc v2.0.0 v2.1.0",
    ]);
  });
  it("fails on cut-off or broken output", () => {
    expect(parseGoModules('{"Path":"a"').ok).toBe(false);
    expect(parseGoModules("{not json}").ok).toBe(false);
  });
  it("turns failures into notes", () => {
    expect(goFromRun({ error: { code: "ENOENT" } }, "go").note).toBe("go was not found");
    expect(goFromRun({ status: 1 }, "go").note).toMatch(/exit code 1/);
    expect(goFromRun({ status: 0, stdout: stream }, "go").ok).toBe(true);
  });
});

describe("environments", () => {
  const src = { PATH: "/bin", HOME: "/h", GH_TOKEN: "x", MY_SECRET: "y", PIP_INDEX_URL: "https://evil.example", AWS_AUTH: "z", npm_config_foo: "1" };
  it("drops what looks like a credential and keeps PATH", () => {
    expect(depsToolEnv(src)).toEqual({ PATH: "/bin", HOME: "/h", PIP_INDEX_URL: "https://evil.example" });
  });
  it("keeps pip away from its config and index settings", () => {
    const e = depsPipEnv(src);
    expect(e.PATH).toBe("/bin");
    expect(e.PIP_INDEX_URL).toBeUndefined();
    expect(e).toMatchObject({ PIP_CONFIG_FILE: "/dev/null", PIP_DISABLE_PIP_VERSION_CHECK: "1" });
    expect(e.GH_TOKEN).toBeUndefined();
  });
  it("pins Go to the local toolchain", () => {
    expect(depsGoEnv(src)).toMatchObject({ GOTOOLCHAIN: "local", PATH: "/bin" });
    expect(depsGoEnv(src).GH_TOKEN).toBeUndefined();
  });
});

describe("OSV", () => {
  const report = JSON.stringify({
    results: [{ source: { path: "go.mod" }, packages: [
      { package: { name: "github.com/a/direct", version: "1.2.0", ecosystem: "Go" }, vulnerabilities: [{ id: "GO-1" }] },
      { package: { name: "clean", version: "1.0", ecosystem: "Go" }, vulnerabilities: [] },
      { package: { name: "Flask_X", version: "1.0", ecosystem: "PyPI" }, vulnerabilities: [{ id: "PYSEC-1" }] },
      { package: { name: "debian-pkg", version: "1", ecosystem: "Debian:11" }, vulnerabilities: [{ id: "D" }] },
    ] }],
  });
  it("lists the packages with a vulnerability", () => {
    expect(parseOsvReport(report)).toEqual([
      { ecosystem: "Go", name: "github.com/a/direct", version: "1.2.0" }, { ecosystem: "PyPI", name: "Flask_X", version: "1.0" },
      { ecosystem: "Debian", name: "debian-pkg", version: "1" },
    ]);
    expect(parseOsvReport("nope")).toBeUndefined();
    expect(parseOsvReport("")).toEqual([]);
  });
  it("matches pip names by PEP 503 and ignores a leading v", () => {
    expect(osvKey("pip", "Flask_X", "1.0")).toBe(osvKey("pip", "flask-x", "1.0"));
    expect(osvKey("go", "m", "v1.2.0")).toBe(osvKey("go", "m", "1.2.0"));
    expect(OSV_TOOLS.Maven).toEqual(["maven", "gradle"]);
  });
  it("treats exit 0 and 1 as normal, 128 as nothing to scan, and the rest as failures", () => {
    expect(osvFromRun({ status: 1, stdout: report })).toMatchObject({ installed: true, ok: true });
    expect(osvFromRun({ status: 0, stdout: "{}" })).toEqual({ installed: true, ok: true, findings: [] });
    expect(osvFromRun({ status: 128, stdout: "" })).toEqual({ installed: true, ok: true, findings: [] });
    expect(osvFromRun({ error: { code: "ENOENT" } })).toMatchObject({ installed: false });
    expect(osvFromRun({ status: 127 })).toMatchObject({ installed: true, ok: false, note: "osv-scanner failed with exit code 127" });
    expect(osvFromRun({ status: 0, stdout: "oops" })).toMatchObject({ ok: false });
    expect(osvFromRun({ error: { code: "ETIMEDOUT" } })).toMatchObject({ ok: false, note: "osv-scanner did not finish in 5 min" });
  });
});

describe("parseWorkflows", () => {
  const SHA = "a".repeat(40);
  const wf = (steps: string) => `name: ci\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
  it("reads block and flow steps, quotes and version comments", () => {
    const { pins, invalid } = parseWorkflows([wf([
      "      - uses: actions/checkout@v3",
      "      - { uses: actions/setup-go@v5 }",
      '      - uses: "github/codeql-action/init@v3"',
      `      - uses: actions/cache@${SHA} # v4.1.1`,
      `      - uses: actions/upload-artifact@${SHA}`,
    ].join("\n"))]);
    expect(invalid).toBe(0);
    expect(pins).toEqual([
      { name: "actions/checkout", repo: "actions/checkout", ref: "v3" },
      { name: "actions/setup-go", repo: "actions/setup-go", ref: "v5" },
      { name: "github/codeql-action/init", repo: "github/codeql-action", ref: "v3" },
      { name: "actions/cache", repo: "actions/cache", ref: SHA, comment: "v4.1.1" },
      { name: "actions/upload-artifact", repo: "actions/upload-artifact", ref: SHA },
    ]);
  });
  it("ignores run text, local and docker uses, and unsafe values", () => {
    const text = wf([
      "      - run: |",
      "          echo uses: evil/thing@v1",
      "      - uses: ./local",
      "      - uses: docker://alpine:3",
      "      - uses: owner/repo@$REF",
      '      - uses: "owner/repo@v1; rm -rf x"',
      "      - uses: owner/../x@v1",
    ].join("\n"));
    expect(parseWorkflows([text])).toEqual({ pins: [], invalid: 0 });
  });
  it("reads a reusable workflow and keeps each pin once", () => {
    const text = "jobs:\n  call:\n    uses: org/repo/.github/workflows/x.yml@main\n  b:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/checkout@v4\n";
    expect(parseWorkflows([text, text]).pins.map((p) => `${p.name}@${p.ref}`)).toEqual(["org/repo/.github/workflows/x.yml@main", "actions/checkout@v4"]);
  });
  it("counts invalid YAML", () => {
    expect(parseWorkflows(["jobs: [", wf("      - uses: actions/checkout@v4")])).toMatchObject({ invalid: 1, pins: [{ name: "actions/checkout" }] });
  });
});

describe("gh lookups", () => {
  it("reads the release", () => {
    expect(releaseFromGh({ status: 0, stdout: '{"tag_name":"v4.2.0"}' })).toEqual({ kind: "ok", value: "v4.2.0" });
    expect(releaseFromGh({ status: 1, stderr: "gh: Not Found (HTTP 404)" })).toEqual({ kind: "none" });
    expect(releaseFromGh({ status: 1, stderr: "boom" })).toEqual({ kind: "failed" });
    expect(releaseFromGh({ error: { code: "ENOENT" } })).toEqual({ kind: "failed" });
    expect(releaseFromGh({ status: 0, stdout: '{"tag_name":"v1; rm"}' })).toEqual({ kind: "failed" });
    expect(releaseFromGh({ status: 0, stdout: "nope" })).toEqual({ kind: "failed" });
  });
  it("reads the commit", () => {
    expect(commitFromGh({ status: 0, stdout: `${"b".repeat(40)}\n` })).toBe("b".repeat(40));
    expect(commitFromGh({ status: 0, stdout: "abc" })).toBeUndefined();
    expect(commitFromGh({ status: 1, stdout: "b".repeat(40) })).toBeUndefined();
  });
});

describe("readActionsFile", () => {
  const good = { version: 1, workflows: 1, pins: [{ name: "actions/checkout", repo: "actions/checkout", ref: "v3" }], releases: { "actions/checkout": "v4.2.0" }, releaseShas: {}, noRelease: [], failed: [], invalid: 0 };
  it("accepts a file it wrote", () => {
    expect(readActionsFile(JSON.stringify(good))).toEqual(good);
    expect(actionsSummary(good as never)).toContain("1 pin of 1 action in 1 workflow file");
  });
  it.each([
    ["wrong version", { ...good, version: 2 }],
    ["bad repo", { ...good, pins: [{ name: "x y", repo: "x y", ref: "v1" }] }],
    ["bad comment", { ...good, pins: [{ ...good.pins[0], comment: "v1; rm" }] }],
    ["bad tag", { ...good, releases: { "actions/checkout": "v1; rm" } }],
    ["bad sha", { ...good, releaseShas: { "actions/checkout": "zz" } }],
    ["bad list", { ...good, failed: ["../x"] }],
    ["no pins", { ...good, pins: "x" }],
  ])("refuses %s", (_n, v) => {
    expect(readActionsFile(JSON.stringify(v))).toBeUndefined();
  });
  it("refuses text that is not JSON or is too large", () => {
    expect(readActionsFile("nope")).toBeUndefined();
    expect(readActionsFile(" ".repeat(ACTIONS_FILE_MAX + 1))).toBeUndefined();
  });
});
