import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRun } from "../src/engine/state.js";
import { listFlows, parseFlow } from "../src/flow/load.js";
import { loadSkillPackage, parseSkillPackage, SKILL_DIGEST_HEADER, SkillPackageError, skillDigest, splitFrontmatter, type SkillEntry } from "../src/skills/package.js";
import { SKILL_DIGEST_RE, SKILL_LIMITS } from "../src/skills/schema.js";

const enc = (s: string) => new TextEncoder().encode(s);
const MD = "---\nname: minimal\ndescription: A tiny example skill used only in tests.\n---\n\n# Minimal\n\nKeep changes small.\n";
const YAML = "id: minimal\nversion: 0.1.0\n";
const file = (path: string, text = "x"): SkillEntry => ({ path, content: enc(text) });
const base = (): SkillEntry[] => [file("SKILL.md", MD), file("skill.yaml", YAML)];
const withEntries = (...extra: SkillEntry[]) => [...base(), ...extra];
const replace = (path: string, text: string) => base().map((e) => (e.path === path ? file(path, text) : e));

function failure(fn: () => unknown): SkillPackageError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SkillPackageError);
    return e as SkillPackageError;
  }
  throw new Error("expected an error");
}
const issues = (entries: readonly SkillEntry[], dirName?: string) => failure(() => parseSkillPackage(entries, "src", dirName)).issues;
const has = (list: { path: string; reason: string }[], path: string, reason: string) =>
  expect(list.some((i) => i.path === path && i.reason.includes(reason)), JSON.stringify(list)).toBe(true);

const tmps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "skill-"));
  tmps.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const emptyFiles = { references: [], scripts: [], assets: [], evals: [] };

describe("parseSkillPackage: success", () => {
  it("parses a minimal package", () => {
    expect(parseSkillPackage(base())).toEqual({
      id: "minimal",
      version: "0.1.0",
      category: "general",
      capabilities: [],
      detectors: [],
      roles: [],
      dependencies: [],
      conflicts: [],
      connectors: [],
      tool_profile: { shell: false, network: false, filesystem: "read" },
      risk: "low",
      description: "A tiny example skill used only in tests.",
      instructions: "# Minimal\n\nKeep changes small.",
      digest: skillDigest(base().map((e) => ({ path: e.path, content: e.content! }))),
      files: emptyFiles,
    });
  });

  it("normalizes a full package and keeps file bytes", () => {
    const yaml = "id: minimal\nversion: 1.0.0\ncapabilities: [b, a]\nroles: [tester, coder]\nconflicts: [z, y]\ndependencies: [{id: q}, {id: p}]\nrisk: medium\n";
    const p = parseSkillPackage([
      ...replace("skill.yaml", yaml),
      file("references/b.md", "B"),
      file("references/a.md", "A"),
      file("evals/e.yaml"),
      file("scripts/s.sh"),
      file("assets/l.txt"),
      file(".DS_Store"),
    ]);
    expect(p.capabilities).toEqual(["a", "b"]);
    expect(p.roles).toEqual(["coder", "tester"]);
    expect(p.conflicts).toEqual(["y", "z"]);
    expect(p.dependencies.map((d) => d.id)).toEqual(["p", "q"]);
    expect(p.files.references.map((f) => f.path)).toEqual(["references/a.md", "references/b.md"]);
    expect(new TextDecoder().decode(p.files.references[0]!.content)).toBe("A");
    expect(p.files.references[0]!.size).toBe(1);
    expect(p.files.scripts).toHaveLength(1);
    expect(p.instructions).not.toContain("---");
  });

  it("accepts CRLF, a BOM and empty supported folders", () => {
    const md = "\uFEFF" + MD.replace(/\n/g, "\r\n");
    const p = parseSkillPackage([...replace("SKILL.md", md), { path: "references", kind: "directory" }]);
    expect(p.instructions).toBe("# Minimal\n\nKeep changes small.");
  });

  it("passes the standard frontmatter fields through", () => {
    const md = "---\nname: minimal\ndescription: d\nlicense: MIT\ncompatibility: c\nmetadata:\n  a: b\nallowed-tools: Read\n---\nbody";
    expect(parseSkillPackage(replace("SKILL.md", md))).toMatchObject({ license: "MIT", compatibility: "c", metadata: { a: "b" }, allowedTools: "Read" });
  });
});

describe("parseSkillPackage: missing and malformed", () => {
  it("reports missing files and empty instructions", () => {
    has(issues([file("skill.yaml", YAML)]), "SKILL.md", "missing");
    has(issues([file("SKILL.md", MD)]), "skill.yaml", "missing");
    has(issues(replace("SKILL.md", "---\nname: minimal\ndescription: d\n---\n  \n")), "SKILL.md", "no instructions");
  });
  it("reports malformed SKILL.md", () => {
    has(issues(replace("SKILL.md", "hello")), "SKILL.md", "`---` frontmatter");
    has(issues(replace("SKILL.md", "---\nname: x\n")), "SKILL.md", "not closed");
    has(issues(replace("SKILL.md", "---\n- a\n---\nbody")), "SKILL.md", "map");
    has(issues(replace("SKILL.md", "---\nname: minimal\n---\nbody")), "SKILL.md: description", "");
  });
  it("reports malformed skill.yaml", () => {
    has(issues(replace("skill.yaml", "a: [")), "skill.yaml", "invalid YAML");
    has(issues(replace("skill.yaml", "just text")), "skill.yaml", "map");
    has(issues(replace("skill.yaml", "id: minimal\nversion: 1.2\n")), "skill.yaml: version", "");
  });
  it("reports a name that differs from the id or the folder", () => {
    has(issues(replace("skill.yaml", "id: other\nversion: 1.0.0\n")), "SKILL.md: name", "must equal the id");
    has(issues(base(), "elsewhere"), "SKILL.md: name", "folder name");
  });
  it("rejects invalid UTF-8", () => {
    has(issues([{ path: "SKILL.md", content: new Uint8Array([0xff, 0xfe]) }, file("skill.yaml", YAML)]), "SKILL.md", "UTF-8");
  });
});

describe("parseSkillPackage: duplicates, traversal, unsupported", () => {
  it("reports duplicates, also by case", () => {
    has(issues(withEntries(file("references/a.md"), file("references/a.md"))), "references/a.md", "duplicate entry (same as references/a.md)");
    has(issues(withEntries(file("references/A.md"), file("references/a.md"))), "references/a.md", "same as references/A.md");
  });
  it("reports a duplicate YAML key", () => {
    has(issues(replace("skill.yaml", "id: minimal\nid: minimal\nversion: 1.0.0\n")), "skill.yaml", "invalid YAML");
  });
  it("rejects traversal and odd paths", () => {
    for (const p of ["../x.md", "references/../../x", "/etc/passwd", "references\\a.md", "references//a.md", "references/./a.md", "C:/x"]) {
      has(issues(withEntries(file(p))), p, "not a plain relative path");
    }
  });
  it("rejects unsupported entries", () => {
    for (const p of ["README.md", "docs/a.md", ".git/config"]) has(issues(withEntries(file(p))), p, "unsupported entry");
    has(issues(withEntries({ path: "docs", kind: "directory" })), "docs", "unsupported entry");
    has(issues(withEntries({ path: ".git", kind: "directory" })), ".git", "unsupported entry");
    has(issues(withEntries({ path: "references/x", kind: "other" })), "references/x", "unsupported entry");
    has(issues(withEntries({ path: "references/l", kind: "symlink" })), "references/l", "symbolic link");
    has(issues(withEntries(file("references"))), "references", "unsupported entry");
  });
  it("accepts other files inside the supported folders", () => {
    const p = parseSkillPackage(withEntries(file("references/x.pdf"), file("assets/LICENSE.txt")));
    expect(p.files.references).toHaveLength(1);
    expect(p.files.assets).toHaveLength(1);
  });
});

describe("parseSkillPackage: sizes", () => {
  const big = (path: string, size: number): SkillEntry => ({ path, size });
  it("rejects oversized files", () => {
    has(issues([big("SKILL.md", SKILL_LIMITS.skillMdBytes + 1), file("skill.yaml", YAML)]), "SKILL.md", "larger than");
    has(issues([file("SKILL.md", MD), big("skill.yaml", SKILL_LIMITS.manifestBytes + 1)]), "skill.yaml", "larger than");
    has(issues(withEntries(big("assets/a.bin", SKILL_LIMITS.fileBytes + 1))), "assets/a.bin", "larger than");
    has(issues(withEntries(file("assets/a.bin", "x".repeat(SKILL_LIMITS.fileBytes + 1)))), "assets/a.bin", "larger than");
  });
  it("derives the size from the content, not from a claim", () => {
    const forged = { path: "assets/a.bin", content: enc("x".repeat(SKILL_LIMITS.fileBytes + 1)), size: 1 };
    has(issues(withEntries(forged)), "assets/a.bin", "larger than");
    for (const size of [-1, 1.5, NaN, Infinity]) has(issues(withEntries({ path: "assets/b", size })), "assets/b", "invalid size");
  });
  it("rejects a package that is too large", () => {
    const parts = Array.from({ length: 9 }, (_, i) => big(`assets/${i}.bin`, SKILL_LIMITS.fileBytes));
    has(issues(withEntries(...parts)), "(package)", "package is larger");
  });
  it("does not count ignored entries", () => {
    parseSkillPackage(withEntries(big(".DS_Store", SKILL_LIMITS.totalBytes + 1), big("assets/.DS_Store", SKILL_LIMITS.totalBytes + 1)));
    parseSkillPackage(withEntries(...Array.from({ length: 200 }, () => file(".DS_Store"))));
  });
  it("names every unknown key", () => {
    const list = issues(replace("skill.yaml", "id: minimal\nversion: 1.0.0\nmodel: x\ntool_profile: {foo: 1}\n"));
    has(list, "skill.yaml: model", "unknown key");
    has(list, "skill.yaml: tool_profile.foo", "unknown key");
    has(issues(replace("SKILL.md", "---\nname: minimal\ndescription: d\nfoo: 1\n---\nbody")), "SKILL.md: foo", "unknown key");
  });
  it("rejects too many files, long paths and deep paths", () => {
    has(issues(withEntries(...Array.from({ length: 200 }, (_, i) => file(`assets/${i}`)))), "(package)", "more than 200 files");
    const long = "assets/" + "a".repeat(SKILL_LIMITS.pathChars);
    has(issues(withEntries(file(long))), long, "longer than");
    has(issues(withEntries(file("assets/a/b/c/d/e/f.txt"))), "assets/a/b/c/d/e/f.txt", "more than 6 segments");
  });
});

describe("parseSkillPackage: risk floor", () => {
  it("needs medium risk for shell or scripts", () => {
    has(issues(replace("skill.yaml", "id: minimal\nversion: 1.0.0\ntool_profile: {shell: true}\n")), "skill.yaml: risk", "shell");
    has(issues(withEntries(file("scripts/a.sh"))), "skill.yaml: risk", "scripts");
    parseSkillPackage([...replace("skill.yaml", "id: minimal\nversion: 1.0.0\nrisk: medium\ntool_profile: {shell: true}\n"), file("scripts/a.sh")]);
    parseSkillPackage([...replace("skill.yaml", "id: minimal\nversion: 1.0.0\nrisk: high\n"), file("scripts/a.sh")]);
  });
});

describe("parseSkillPackage: several problems", () => {
  it("collects all issues in one error", () => {
    const err = failure(() =>
      parseSkillPackage([...replace("skill.yaml", "id: Bad\nversion: 1.0.0\n"), file("../x"), { path: "assets/big", size: SKILL_LIMITS.fileBytes + 1 }], "pkg"),
    );
    expect(err.issues.length).toBeGreaterThanOrEqual(3);
    for (const i of err.issues) expect(err.message).toContain(`  - ${i.path}: ${i.reason}`);
    expect(err.message.startsWith("pkg: invalid skill package")).toBe(true);
    expect(err.issues.map((i) => i.path)).toEqual(expect.arrayContaining(["skill.yaml: id", "../x", "assets/big"]));
  });
});

describe("splitFrontmatter", () => {
  it("splits at the markers", () => {
    expect(splitFrontmatter("---\na: 1\n---\nbody\n")).toEqual({ data: { a: 1 }, body: "body\n" });
  });
  it("explains failures", () => {
    expect(() => splitFrontmatter("x")).toThrow("must start with");
    expect(() => splitFrontmatter("---\na: 1")).toThrow("not closed");
    expect(() => splitFrontmatter("---\na: [\n---\n")).toThrow("invalid YAML");
  });
});

describe("loadSkillPackage", () => {
  function make(name = "minimal") {
    const dir = join(tmp(), name);
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), MD);
    writeFileSync(join(dir, "skill.yaml"), YAML);
    return dir;
  }
  it("loads the minimal fixture and matches the in-memory result", () => {
    expect(loadSkillPackage("tests/fixtures/skills/minimal")).toEqual(parseSkillPackage(base(), "x", "minimal"));
  });
  it("loads the full fixture with all four folders", () => {
    const p = loadSkillPackage("tests/fixtures/skills/full");
    expect(p.id).toBe("full");
    expect(p.version).toBe("1.2.0-rc.1");
    expect(p.roles).toEqual(["coder", "tester"]);
    expect(p.detectors).toHaveLength(2);
    expect(p.license).toBe("MIT");
    for (const f of ["references", "scripts", "assets", "evals"] as const) expect(p.files[f]).toHaveLength(1);
    expect(new TextDecoder().decode(p.files.evals[0]!.content)).toContain("basic");
  });
  it("fails for a missing folder", () => {
    expect(() => loadSkillPackage(join(tmp(), "nope"))).toThrow("(package): not a folder");
  });
  it("ignores .DS_Store and rejects other dot entries and unsupported folders", () => {
    const dir = make();
    writeFileSync(join(dir, ".DS_Store"), "x");
    expect(loadSkillPackage(dir).id).toBe("minimal");
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "docs"));
    const err = failure(() => loadSkillPackage(dir));
    has(err.issues, ".git", "unsupported entry");
    has(err.issues, "docs", "unsupported entry");
  });
  it("rejects a folder name that differs from the skill name", () => {
    has(failure(() => loadSkillPackage(make("other"))).issues, "SKILL.md: name", "folder name");
  });
  it("never follows symlinks", () => {
    const dir = make();
    const outside = join(tmp(), "secret.txt");
    writeFileSync(outside, "secret");
    mkdirSync(join(dir, "references"));
    symlinkSync(outside, join(dir, "references", "link.md"));
    symlinkSync(outside, join(dir, "top-link"));
    const err = failure(() => loadSkillPackage(dir));
    has(err.issues, "references/link.md", "unsupported entry (symbolic link)");
    has(err.issues, "top-link", "symbolic link");
    expect(err.message).not.toContain("secret");
  });
  it("rejects a SKILL.md that is a symlink", () => {
    const dir = make();
    const real = join(tmp(), "real.md");
    writeFileSync(real, MD);
    rmSync(join(dir, "SKILL.md"));
    symlinkSync(real, join(dir, "SKILL.md"));
    has(failure(() => loadSkillPackage(dir)).issues, "SKILL.md", "symbolic link");
  });
  it("reports too many files, not a missing skill.yaml, and counts folders apart from files", () => {
    const dir = make();
    mkdirSync(join(dir, "assets"));
    for (let i = 0; i < 201; i++) writeFileSync(join(dir, "assets", `f${i}`), "x");
    const err = failure(() => loadSkillPackage(dir));
    has(err.issues, "(package)", "more than 200 files");
    expect(err.issues.some((i) => i.reason === "missing")).toBe(false);

    const dir2 = make();
    mkdirSync(join(dir2, "assets"));
    for (let i = 0; i < 150; i++) mkdirSync(join(dir2, "assets", `d${i}`));
    expect(loadSkillPackage(dir2).id).toBe("minimal");
  });
  it("does not accept an oversized file", () => {
    const dir = make();
    writeFileSync(join(dir, "SKILL.md"), "x".repeat(SKILL_LIMITS.skillMdBytes + 1));
    has(failure(() => loadSkillPackage(dir)).issues, "SKILL.md", "larger than");
  });
});

describe("skill digest", () => {
  const dg = (entries: SkillEntry[]) => parseSkillPackage(entries).digest;
  const e = (path: string, text: string) => ({ path, content: enc(text) });
  it("does not depend on the order of the entries and matches the format", () => {
    const list = withEntries(file("references/a.md", "a"), file("references/b.md", "b"));
    const a = dg(list);
    expect(dg([...list].reverse())).toBe(a);
    expect(a).toMatch(SKILL_DIGEST_RE);
    expect(loadSkillPackage("tests/fixtures/skills/full").digest).toBe(loadSkillPackage("tests/fixtures/skills/full").digest);
  });
  it("hashes the documented bytes", () => {
    const u32 = (n: number) => Buffer.from([0, 0, 0, n]);
    const bytes = Buffer.concat([Buffer.from(SKILL_DIGEST_HEADER), u32(1), Buffer.from("a"), u32(1), Buffer.from("x")]);
    expect(skillDigest([e("a", "x")])).toBe("sha256:" + createHash("sha256").update(bytes).digest("hex"));
    expect(SKILL_DIGEST_HEADER).toBe("scf-skill-package-v1\n");
  });
  it("changes with any byte, name or split between path and content", () => {
    const start = withEntries(file("references/a.md", "a"));
    const d0 = dg(start);
    const changed = (list: SkillEntry[]) => expect(dg(list)).not.toBe(d0);
    changed(start.map((x) => (x.path === "SKILL.md" ? file("SKILL.md", MD + " ") : x)));
    changed(start.map((x) => (x.path === "skill.yaml" ? file("skill.yaml", YAML + "category: other\n") : x)));
    changed(start.map((x) => (x.path === "references/a.md" ? file("references/a.md", "b") : x)));
    changed(withEntries(file("references/a.md", "a"), file("references/b.md", "b")));
    changed(base());
    changed(start.map((x) => (x.path === "references/a.md" ? file("references/c.md", "a") : x)));
    changed(start.map((x) => (x.path === "SKILL.md" ? file("SKILL.md", MD.replace("name: minimal", "name:  minimal")) : x)));
    expect(skillDigest([e("a", "bc")])).not.toBe(skillDigest([e("ab", "c")]));
    expect(dg([...start, file("references/.DS_Store", "junk")])).toBe(d0);
  });
  it("on disk: ignores siblings, refuses links, refuses a bad path", () => {
    const parent = tmp();
    const dir = join(parent, "minimal");
    mkdirSync(dir);
    writeFileSync(join(dir, "SKILL.md"), MD);
    writeFileSync(join(dir, "skill.yaml"), YAML);
    const d0 = loadSkillPackage(dir).digest;
    writeFileSync(join(parent, "sibling.md"), "x");
    expect(loadSkillPackage(dir).digest).toBe(d0);
    mkdirSync(join(dir, "references"));
    symlinkSync(join(parent, "sibling.md"), join(dir, "references", "l.md"));
    expect(() => loadSkillPackage(dir)).toThrow(SkillPackageError);
    expect(() => parseSkillPackage(withEntries(file("../x")))).toThrow(SkillPackageError);
  });
});

describe("compatibility", () => {
  it("lists flows and parses a flow without any skill configuration", () => {
    expect(listFlows("/nonexistent").filter((f) => "error" in f && (f as { error?: string }).error)).toEqual([]);
    expect(parseFlow(readFileSync("tests/fixtures/flows/feature.yaml", "utf8")).steps.length).toBeGreaterThan(0);
  });
  it("loads an older run.json without any skill field", () => {
    const runs = tmp();
    mkdirSync(join(runs, "old-run"));
    const run = { runId: "old-run", flow: "quick", status: "succeeded", startedAt: "2026-01-01T00:00:00.000Z", totalCostUsd: 0, steps: [] };
    writeFileSync(join(runs, "old-run", "run.json"), JSON.stringify(run));
    expect(loadRun(runs, "old-run")).toMatchObject({ runId: "old-run", status: "succeeded" });
  });
});
