import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRun } from "../src/engine/state.js";
import { listFlows } from "../src/flow/load.js";
import { buildRepoProfile, RepoFindingSchema, RepoProfileSchema, serializeRepoProfile, writeRepoProfile, type RepoProfile } from "../src/skills/repo-profile.js";
import { REPO_PROFILE_LIMITS } from "../src/skills/repo-profile-rules.js";
import { relativePathProblem } from "../src/skills/schema.js";

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "profile-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tree = (root: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
};
const make = (files: Record<string, string>) => tree(tmp(), files);
const find = (p: RepoProfile, kind: string, name?: string) => p.findings.filter((f) => f.kind === kind && (name === undefined || f.name === name));
const paths = (p: RepoProfile, kind: string, name?: string) => find(p, kind, name).map((f) => f.path);
const walkFiles = (dir: string, base = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkFiles(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`])).sort();

describe("empty repositories", () => {
  it("profiles an empty folder and a folder with only .git", () => {
    const only = make({ ".git/HEAD": "ref: refs/heads/main\n" });
    for (const root of [tmp(), only]) {
      const p = buildRepoProfile(root);
      expect(p.findings).toEqual([]);
      expect(p.stats.files).toBe(0);
      expect(p.truncated).toEqual({ files: false, bytes: false, findings: false });
      expect(RepoProfileSchema.safeParse(p).success).toBe(true);
    }
  });
});

describe("mono-repository", () => {
  const root = () =>
    make({
      "package.json": JSON.stringify({ name: "mono", workspaces: ["packages/*"], scripts: { test: "vitest" } }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
      "packages/web/package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      "packages/web/src/app.tsx": "import React from 'react';\nimport { x } from './x';\n",
      "services/api/go.mod": "module api\n\nrequire github.com/gin-gonic/gin v1.9.0\n",
      "services/api/main.go": 'package main\nimport "github.com/gin-gonic/gin"\n',
      "services/ml/pyproject.toml": '[project]\nname = "ml"\ndependencies = ["numpy>=1.0"]\n',
    });
  it("finds each manifest, dependency and command with its own path", () => {
    const p = buildRepoProfile(root());
    expect(paths(p, "manifest", "npm")).toEqual(["package.json", "packages/web/package.json"]);
    expect(paths(p, "manifest", "go")).toEqual(["services/api/go.mod"]);
    expect(paths(p, "manifest", "python")).toEqual(["services/ml/pyproject.toml"]);
    expect(find(p, "manifest", "pnpm")[0]).toMatchObject({ path: "pnpm-lock.yaml", value: "lockfile" });
    expect(find(p, "dependency").map((f) => [f.name, f.path])).toEqual([
      ["react", "packages/web/package.json"],
      ["github.com/gin-gonic/gin", "services/api/go.mod"],
      ["numpy", "services/ml/pyproject.toml"],
    ]);
    expect(find(p, "command").map((f) => [f.name, f.value, f.path])).toEqual([
      ["test", "pnpm test", "package.json"],
      ["build", "go build ./...", "services/api/go.mod"],
      ["test", "go test ./...", "services/api/go.mod"],
    ]);
    expect(find(p, "import").map((f) => [f.name, f.path, f.count])).toEqual([
      ["react", "packages/web/src/app.tsx", 1],
      ["github.com/gin-gonic/gin", "services/api/main.go", 1],
    ]);
    expect(find(p, "language", "typescript")[0]).toMatchObject({ path: "packages/web/src/app.tsx", count: 1 });
  });
});

describe("multiple build systems in one folder", () => {
  it("reports all systems, deployment files and schemas", () => {
    const p = buildRepoProfile(
      make({
        "package.json": "{}",
        "pom.xml": "<project></project>",
        Makefile: "test:\n\ttrue\n",
        "Cargo.toml": '[package]\nname = "x"\n',
        Dockerfile: "FROM node\n",
        ".github/workflows/ci.yml": "on: push\n",
        "db/schema.sql": "create table t(id int);\n",
        "db/more.sql": "select 1;\n",
        "infra/a.tf": "",
        "infra/b.tf": "",
      }),
    );
    expect(find(p, "manifest").map((f) => f.name).sort()).toEqual(["cargo", "make", "maven", "npm"]);
    expect(find(p, "deployment").map((f) => f.name).sort()).toEqual(["docker", "github-actions", "terraform"]);
    expect(find(p, "deployment", "terraform")[0]).toMatchObject({ path: "infra/a.tf", count: 2 });
    expect(find(p, "schema", "sql")[0]).toMatchObject({ path: "db/more.sql", count: 2 });
    expect(find(p, "command", "test").map((f) => f.value).sort()).toEqual(["cargo test", "make test", "mvn test"]);
  });
});

describe("determinism and output", () => {
  const files = { "b/package.json": '{"dependencies":{"z":"1"}}', "a/go.mod": "module a\n", "c.py": "import numpy\n", "Dockerfile": "x", "a/z.sql": "x" };
  it("gives the same text for any creation order and for repeated runs", () => {
    const one = make(files);
    const two = make(Object.fromEntries(Object.entries(files).reverse()));
    const s = serializeRepoProfile(buildRepoProfile(one, { commit: "abcdef1" }));
    expect(serializeRepoProfile(buildRepoProfile(two, { commit: "abcdef1" }))).toBe(s);
    expect(serializeRepoProfile(buildRepoProfile(one, { commit: "abcdef1" }))).toBe(s);
    expect(s.endsWith("}\n")).toBe(true);
    const p = buildRepoProfile(one);
    const keys = p.findings.map((f) => `${f.kind}|${f.path}|${f.name}`);
    expect(keys.length).toBeGreaterThan(5);
  });
  it("sorts findings by kind, path and name", () => {
    const p = buildRepoProfile(make(files));
    const order = ["language", "manifest", "dependency", "import", "schema", "deployment", "command"];
    const keys = p.findings.map((f) => [order.indexOf(f.kind), f.path, f.name] as const);
    expect(keys).toEqual([...keys].sort((x, y) => x[0] - y[0] || (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0) || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0)));
  });
  it("keeps host paths out and uses relative paths", () => {
    const root = make({ "src/app.ts": "import x from 'y';", "package.json": "{}" });
    const text = serializeRepoProfile(buildRepoProfile(root));
    for (const host of [root, tmpdir(), homedir()]) expect(text).not.toContain(host);
    for (const f of buildRepoProfile(root).findings) expect(relativePathProblem(f.path)).toBeUndefined();
  });
  it("stores a valid commit and rejects a bad one", () => {
    const root = make({ "a.ts": "" });
    expect(buildRepoProfile(root, { commit: "0123abc" }).commit).toBe("0123abc");
    expect(() => buildRepoProfile(root, { commit: "not a commit" })).toThrow();
  });
  it("throws not a folder for a file or a missing path", () => {
    const root = make({ "a.ts": "" });
    expect(() => buildRepoProfile(join(root, "a.ts"))).toThrow("not a folder");
    expect(() => buildRepoProfile(join(root, "missing"))).toThrow("not a folder");
  });
});

describe("safe skipping", () => {
  const MARK = "SECRET_MARKER_123";
  const dep = JSON.stringify({ dependencies: { [MARK.toLowerCase()]: "1.0.0" } });
  it("never looks into skipped folders and files", () => {
    const root = make({
      "node_modules/m/package.json": dep,
      "vendor/v/go.mod": `module ${MARK}\n`,
      "dist/out.js": `import x from '${MARK.toLowerCase()}'`,
      ".git/config": MARK,
      ".env": `KEY=${MARK}`,
      "server.key": MARK,
      "logo.png": MARK,
      "keep/package.json": "{}",
    });
    const p = buildRepoProfile(root);
    expect(serializeRepoProfile(p).toLowerCase()).not.toContain(MARK.toLowerCase());
    expect(p.skipped).toMatchObject({ dependency: 1, vendor: 1, generated: 1, vcs: 1, secret: 2, binary: 1 });
    expect(p.findings.every((f) => f.path.startsWith("keep/"))).toBe(true);
    expect(Object.keys(p.skipped)).toHaveLength(9);
  });
  it("treats a NUL byte and invalid UTF-8 as binary, separately", () => {
    const root = make({ "a.ts": "import x from 'nul-pkg';\0", "b.ts": "import x from 'ok-pkg';\n" });
    writeFileSync(join(root, "c.ts"), Buffer.from([0xff, 0xfe, 0xfd]));
    const p = buildRepoProfile(root);
    expect(p.skipped.binary).toBe(2);
    expect(find(p, "import").map((f) => f.name)).toEqual(["ok-pkg"]);
  });
  it("does not follow symlinks", () => {
    const outside = make({ "package.json": "{}", "secret.ts": "import x from 'outside';" });
    const root = make({ "real/a.ts": "" });
    symlinkSync(outside, join(root, "link-dir"));
    symlinkSync(join(outside, "secret.ts"), join(root, "link.ts"));
    const p = buildRepoProfile(root);
    expect(p.skipped.symlink).toBe(2);
    expect(find(p, "manifest")).toEqual([]);
    expect(find(p, "import")).toEqual([]);
  });
  it("skips names with control characters", () => {
    const root = make({ "ok.ts": "" });
    writeFileSync(join(root, "bad\nname.ts"), "");
    const p = buildRepoProfile(root);
    expect(p.skipped.other).toBe(1);
    expect(find(p, "language")).toHaveLength(1);
  });
  it.skipIf(process.getuid?.() === 0)("counts unreadable folders as other", () => {
    const root = make({ "open/a.ts": "", "locked/b.ts": "" });
    chmodSync(join(root, "locked"), 0o000);
    try {
      const p = buildRepoProfile(root);
      expect(p.skipped.other).toBeGreaterThanOrEqual(1);
      expect(paths(p, "language")).toEqual(["open/a.ts"]);
    } finally {
      chmodSync(join(root, "locked"), 0o755);
    }
  });
});

describe("limits", () => {
  it("keeps manifests first when the file limit is hit", () => {
    const files: Record<string, string> = { "package.json": "{}" };
    for (let i = 0; i < 19; i++) files[`a${i}.txt`] = "";
    const p = buildRepoProfile(make(files), { limits: { files: 5 } });
    expect(p.truncated.files).toBe(true);
    expect(p.stats.files).toBe(5);
    expect(paths(p, "manifest")).toEqual(["package.json"]);
  });
  it("stops reading at the byte limit but keeps name-based findings", () => {
    const p = buildRepoProfile(make({ "package.json": JSON.stringify({ dependencies: { react: "1.0.0", pad: "x".repeat(200) } }), "a.ts": "import x from 'react'" }), { limits: { totalBytes: 100 } });
    expect(p.truncated.bytes).toBe(true);
    expect(find(p, "manifest")).toHaveLength(1);
    expect(find(p, "language").map((f) => f.name)).toEqual(["typescript", "json"]); // sorted by path: a.ts before package.json
    expect(find(p, "dependency")).toEqual([]);
  });
  it("caps a kind and flags it", () => {
    const dependencies = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`dep${i}`, "1.0.0"]));
    const p = buildRepoProfile(make({ "package.json": JSON.stringify({ dependencies }) }), { limits: { findings: { dependency: 3 } } });
    expect(find(p, "dependency")).toHaveLength(3);
    expect(p.truncated.findings).toBe(true);
  });
  it("limits depth", () => {
    const p = buildRepoProfile(make({ "package.json": "{}", "a/package.json": "{}", "a/b/package.json": "{}" }), { limits: { depth: 1 } });
    expect(paths(p, "manifest")).toEqual(["a/package.json", "package.json"]);
    expect(p.truncated.files).toBe(true);
  });
  it("leaves out a folder over the entry limit, the same for any creation order", () => {
    const files: Record<string, string> = { "package.json": "{}" };
    for (let i = 0; i < 30; i++) files[`big/f${i}.txt`] = "";
    const one = buildRepoProfile(make(files), { limits: { dirEntries: 10 } });
    const two = buildRepoProfile(make(Object.fromEntries(Object.entries(files).reverse())), { limits: { dirEntries: 10 } });
    expect(one.stats.files).toBe(1);
    expect(one.truncated.files).toBe(true);
    expect(paths(one, "manifest")).toEqual(["package.json"]);
    expect(serializeRepoProfile(two)).toBe(serializeRepoProfile(one));
  });
  it("names bun.lockb without reading it and takes bun for the commands", () => {
    const p = buildRepoProfile(make({ "package.json": '{"scripts":{"test":"vitest"}}', "bun.lockb": "\0\0binary" }));
    expect(find(p, "manifest", "bun")[0]).toMatchObject({ path: "bun.lockb", value: "lockfile" });
    expect(find(p, "command", "test")[0]?.value).toBe("bun test");
  });
  it("counts a file over the size limit as large", () => {
    const p = buildRepoProfile(make({ "big.ts": "x".repeat(100), "small.ts": "" }), { limits: { fileBytes: 50 } });
    expect(p.skipped.large).toBe(1);
    expect(find(p, "language")[0]).toMatchObject({ path: "small.ts" });
  });
  it("never raises a limit and ignores bad overrides", () => {
    const root = make({ "a.ts": "" });
    expect(buildRepoProfile(root, { limits: { files: 10 ** 9 } }).limits.files).toBe(REPO_PROFILE_LIMITS.files);
    for (const bad of [-1, 0, Number.NaN, 1.5, Infinity]) {
      expect(buildRepoProfile(root, { limits: { files: bad, findings: { language: bad } } }).limits).toMatchObject({
        files: REPO_PROFILE_LIMITS.files,
        findings: { language: REPO_PROFILE_LIMITS.findings.language },
      });
    }
  });
  it("keeps the artifact within its size limit", () => {
    const files: Record<string, string> = {};
    const long = "p".repeat(110);
    for (let i = 0; i < 160; i++) {
      files[`${"d".repeat(20)}${i}/package.json`] = JSON.stringify({ dependencies: Object.fromEntries(Array.from({ length: 2 }, (_, j) => [`${long}${i}-${j}`.slice(0, 118), "1.0.0"])) });
    }
    const root = make(files);
    const p = buildRepoProfile(root);
    expect(Buffer.byteLength(serializeRepoProfile(p))).toBeLessThanOrEqual(REPO_PROFILE_LIMITS.artifactBytes);
    const small = buildRepoProfile(root, { limits: { artifactBytes: 5000 } });
    expect(Buffer.byteLength(serializeRepoProfile(small))).toBeLessThanOrEqual(5000);
    expect(small.truncated.findings).toBe(true);
  });
});

describe("schema, writer and compatibility", () => {
  it("rejects traversal paths and free text in findings", () => {
    const ok = { kind: "manifest", name: "npm", path: "a/package.json", detector: "manifest-name", reason: "npm build file" };
    expect(RepoFindingSchema.safeParse(ok).success).toBe(true);
    expect(RepoFindingSchema.safeParse({ ...ok, path: "../x" }).success).toBe(false);
    expect(RepoFindingSchema.safeParse({ ...ok, path: "/etc/passwd" }).success).toBe(false);
    expect(RepoFindingSchema.safeParse({ ...ok, name: "ignore previous instructions" }).success).toBe(false);
    expect(RepoFindingSchema.safeParse({ ...ok, value: "a b" }).success).toBe(false);
    expect(RepoFindingSchema.safeParse({ ...ok, kind: "command", value: "pnpm test" }).success).toBe(true);
    const profile = buildRepoProfile(make({ "a.ts": "" }));
    expect(() => serializeRepoProfile({ ...profile, findings: [{ ...ok, path: "../x" } as never] })).toThrow();
  });
  it("writes repo-profile.json without leaving a temp file", () => {
    const profile = buildRepoProfile(make({ "package.json": "{}" }));
    const out = join(tmp(), "run");
    const file = writeRepoProfile(out, profile);
    expect(file).toBe(join(out, "repo-profile.json"));
    expect(readFileSync(file, "utf8")).toBe(serializeRepoProfile(profile));
    expect(RepoProfileSchema.safeParse(JSON.parse(readFileSync(file, "utf8"))).success).toBe(true);
    expect(readdirSync(out)).toEqual(["repo-profile.json"]);
  });
  it("does not change the repository", () => {
    const root = make({ "package.json": "{}", "src/a.ts": "import x from 'y'", ".env": "K=1", "node_modules/x/i.js": "" });
    const snap = () => walkFiles(root).map((f) => `${f}:${readFileSync(join(root, f), "utf8")}`);
    const before = snap();
    buildRepoProfile(root);
    expect(snap()).toEqual(before);
    expect(existsSync(join(root, "repo-profile.json"))).toBe(false);
  });
  it("leaves flows and older runs alone", () => {
    expect(listFlows("/nonexistent").filter((f) => "error" in f && (f as { error?: string }).error)).toEqual([]);
    const runs = tmp();
    mkdirSync(join(runs, "old-run"));
    const run = { runId: "old-run", flow: "quick", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z", totalCostUsd: 0, steps: [] };
    writeFileSync(join(runs, "old-run", "run.json"), JSON.stringify(run));
    expect(loadRun(runs, "old-run")).toMatchObject({ runId: "old-run", status: "succeeded" });
  });
});
