import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addLicenceEvidence } from "../src/skills/import-evidence.js";
import { prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { importDigest, parseImportRecord, prepareImport, SkillImportError, type PreparedImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport, readStagedImport, stageImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence } from "../src/skills/licence.js";
import { LICENCE_LIMITS } from "../src/skills/licence-rules.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const isRoot = process.getuid?.() === 0;
const COMMIT = "a".repeat(40);
const T1 = "2026-01-02T03:04:05Z";
const T2 = "2027-01-02T03:04:05Z";
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
const FILES: Record<string, string> = { "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b") };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function tree(files: Record<string, string> = FILES, links: string[] = []): SourceTree {
  const all: TreeEntry[] = [
    ...Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path })),
    ...links.map((path): TreeEntry => ({ path, kind: "symlink", size: 1, id: "link:" + path })),
  ];
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}
const source: SkillLibrarySource = {
  id: "lib",
  repository: "https://github.com/example/skills",
  repositoryKey: "github.com/example/skills",
  status: "enabled",
  ref: { approved: COMMIT },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "manual" },
  owner: "@example",
};

const made: string[] = [];
let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skillevidence-")));
  made.push(home);
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const WITH: Record<string, string> = { ...FILES, LICENSE: "root licence", "skills/a/LICENSE": "a licence", "skills/a/NOTICE": "a notice", "docs/LICENSE": "unrelated" };
const stage = (files = WITH, links: string[] = [], retrievedAt: string | null = T1) => stageImport(source, tree(files, links), { home, retrievedAt: retrievedAt ?? undefined });
const read = () => readStagedImport("lib", COMMIT, { home });
const invalid = (): string => {
  const r = read();
  if (r.state !== "invalid") throw new Error("expected invalid, got " + r.state);
  return r.problem;
};
const mode = (p: string) => statSync(p).mode & 0o777;
const withLicence = (prep: PreparedImport, t: SourceTree, at: string): PreparedImport =>
  addLicenceEvidence(prep, prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t)), at);

describe("parseImportRecord with licence evidence", () => {
  const base = () => withLicence(prepareImport(source, tree(WITH)), tree(WITH), T1).record;
  const text = (r: unknown) => JSON.stringify(r, null, 2) + "\n";
  const lf = (r: ReturnType<typeof base>) => r.licenceFiles!;

  it("round-trips a record with both fields", () => {
    const r = base();
    expect(parseImportRecord(text(r))).toEqual({ record: r });
    expect(lf(r).map((f) => f.path)).toEqual(["LICENSE", "skills/a/LICENSE", "skills/a/NOTICE"]);
  });
  it("still parses a record without the fields, in its old written form", () => {
    const { record, recordText } = prepareImport(source, tree());
    expect(Object.keys(record)).not.toContain("licenceFiles");
    expect(parseImportRecord(recordText)).toEqual({ record });
  });
  it("refuses one field without the other, and a bad time", () => {
    const { retrievedAt, ...noTime } = base();
    void retrievedAt;
    expect(parseImportRecord(text(noTime))).toEqual({ problem: "import.json: retrievedAt and licenceFiles must come together" });
    const { licenceFiles, ...noList } = base();
    void licenceFiles;
    expect(parseImportRecord(text(noList))).toEqual({ problem: "import.json: retrievedAt and licenceFiles must come together" });
    expect(parseImportRecord(text({ ...base(), retrievedAt: "yesterday" }))).toEqual({ problem: "import.json: retrievedAt is not a UTC time" });
  });
  it("refuses unsorted, duplicate, misnamed and malformed entries", () => {
    const r = base();
    const files = lf(r);
    const bad = (list: unknown[]) => {
      const x = parseImportRecord(text({ ...r, licenceFiles: list }));
      expect("problem" in x).toBe(true);
    };
    bad([files[1], files[0]]);
    bad([files[0], files[0]]);
    bad([{ path: "README", sha256: sha("x"), bytes: 1 }]);
    bad([{ ...files[0], problem: "both" }]);
    bad([{ path: "LICENSE" }]);
    bad([{ path: "LICENSE", sha256: sha("x"), bytes: LICENCE_LIMITS.fileBytes + 1 }]);
    bad(Array.from({ length: LICENCE_LIMITS.files + 1 }, (_v, i) => ({ path: `d${String(i).padStart(4, "0")}/LICENSE`, problem: "x" })));
    bad([{ path: "LICENSE", sha256: "zz", bytes: 1 }]);
  });
  it("accepts a problem entry", () => {
    const r = { ...base(), licenceFiles: [{ path: "skills/LICENSE", problem: "a symbolic link" }] };
    expect(parseImportRecord(text(r))).toEqual({ record: r });
  });
});

describe("stageImport with licence evidence", () => {
  it("stages exactly the applicable files, private, and lists them", () => {
    const { dir, record } = stage();
    expect(record.retrievedAt).toBe(T1);
    expect(record.licenceFiles).toEqual([
      { path: "LICENSE", sha256: sha("root licence"), bytes: 12 },
      { path: "skills/a/LICENSE", sha256: sha("a licence"), bytes: 9 },
      { path: "skills/a/NOTICE", sha256: sha("a notice"), bytes: 8 },
    ]);
    expect(readFileSync(join(dir, "licence", "skills", "a", "LICENSE"), "utf8")).toBe("a licence");
    expect(existsSync(join(dir, "licence", "docs"))).toBe(false);
    if (!isRoot) {
      expect(mode(join(dir, "licence"))).toBe(0o700);
      expect(mode(join(dir, "licence", "skills"))).toBe(0o700);
      expect(mode(join(dir, "licence", "LICENSE"))).toBe(0o600);
    }
  });
  it("records a link as a problem and does not write it", () => {
    const { dir, record } = stage({ ...FILES }, ["skills/LICENSE"]);
    expect(record.licenceFiles).toEqual([{ path: "skills/LICENSE", problem: "a symbolic link" }]);
    expect(existsSync(join(dir, "licence", "skills", "LICENSE"))).toBe(false);
    expect(read().state).toBe("ok");
  });
  it("records a path that clashes on a case-insensitive disk", () => {
    const { record } = stage({ ...FILES, LICENSE: "x", license: "y" });
    expect(record.licenceFiles).toEqual([
      { path: "LICENSE", sha256: sha("x"), bytes: 1 },
      { path: "license", problem: "collides with another path on a case-insensitive disk" },
    ]);
  });
  it("lists no licence files when there are none", () => {
    const { record } = stage(FILES);
    expect(record.licenceFiles).toEqual([]);
    const r = read();
    expect(r.state === "ok" && r.licence?.files.length).toBe(0);
  });
  it("is unchanged the second time, with the first retrievedAt kept", () => {
    const a = stage();
    const b = stage(WITH, [], T2);
    expect(b.state).toBe("unchanged");
    expect(b.record.retrievedAt).toBe(T1);
    expect(JSON.parse(readFileSync(join(a.dir, "import.json"), "utf8")).retrievedAt).toBe(T1);
  });
  it("is a conflict when a licence byte differs", () => {
    stage();
    expect(() => stage({ ...WITH, LICENSE: "root licencf" }, [], T2)).toThrow(SkillImportError);
  });
  it("replaces an import that was staged without retrievedAt", () => {
    stage(WITH, [], null);
    const again = stage();
    expect(again.state).toBe("staged");
    expect(again.record.retrievedAt).toBe(T1);
    expect(read().state).toBe("ok");
  });
  it("writes the form without retrievedAt and licenceFiles when no time is given", () => {
    const { dir, record } = stage(WITH, [], null);
    expect(record.licenceFiles).toBeUndefined();
    expect(existsSync(join(dir, "licence.json"))).toBe(true);
  });
  it("throws too-many-entries for too many licence files and stages nothing", () => {
    const many: Record<string, string> = { ...FILES };
    for (let i = 0; i <= LICENCE_LIMITS.files; i++) {
      many[`skills/d${i}/LICENSE`] = "x";
      many[`skills/d${i}/SKILL.md`] = md(`d${i}`);
    }
    expect(() => stage(many)).toThrowError(expect.objectContaining({ code: "too-many-entries" }));
    expect(existsSync(join(home, "skill-quarantine"))).toBe(false);
  });
  it("rejects a retrievedAt that is not a UTC time", () => {
    expect(() => stage(WITH, [], "now")).toThrowError(/retrievedAt/);
  });
});

describe("readStagedImport licences", () => {
  it("reads back what was staged, and rebuilds the evidence", () => {
    const { record } = stage();
    const r = read();
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.record).toEqual(record);
    const ev = r.licence!;
    expect(ev.files.map((f) => [f.path, f.dir, f.kind])).toEqual([
      ["LICENSE", ".", "licence"],
      ["skills/a/LICENSE", "skills/a", "licence"],
      ["skills/a/NOTICE", "skills/a", "notice"],
    ]);
  });
  it("reads an import staged before this change, with no licence evidence", () => {
    publishImport(prepareImport(source, tree()), { home });
    const r = read();
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.licence).toBeUndefined();
    expect(r.record.licenceFiles).toBeUndefined();
  });
  it("is invalid when licence/ sits next to an old record", () => {
    const { dir } = publishImport(prepareImport(source, tree()), { home });
    mkdirSync(join(dir, "licence"), { mode: 0o700 });
    expect(invalid()).toContain("licence");
  });
  it("is invalid when import.json lists other licence files than licence.json", () => {
    const { dir, record } = stage();
    const other = { ...record, licenceFiles: record.licenceFiles!.slice(1) };
    writeFileSync(join(dir, "import.json"), JSON.stringify(other, null, 2) + "\n");
    expect(invalid()).toContain("lists other licence files");
  });
  it("is invalid when import.json lists licence files and licence.json is missing", () => {
    const { dir } = stage();
    rmSync(join(dir, "licence.json"));
    expect(invalid()).toContain("licence.json");
  });
  it("is invalid when a licence file changed (same size), is removed, or an extra file is there", () => {
    const { dir } = stage();
    const file = join(dir, "licence", "skills", "a", "LICENSE");
    writeFileSync(file, "a licencf");
    expect(invalid()).toContain("skills/a/LICENSE changed");
    rmSync(file);
    expect(invalid()).toContain("skills/a/LICENSE is missing");
    writeFileSync(file, "a licence", { mode: 0o600 });
    expect(read().state).toBe("ok");
    writeFileSync(join(dir, "licence", "EXTRA"), "x", { mode: 0o600 });
    expect(invalid()).toContain("more files than licence.json lists");
  });
  it("is invalid when licence or a licence file is a link", () => {
    const { dir } = stage();
    const file = join(dir, "licence", "LICENSE");
    rmSync(file);
    symlinkSync(join(dir, "import.json"), file);
    expect(invalid()).toContain("is a link");
    rmSync(file);
    writeFileSync(file, "root licence", { mode: 0o600 });
    const moved = join(dir, "moved");
    rmSync(moved, { recursive: true, force: true });
    mkdirSync(moved, { mode: 0o700 });
    rmSync(join(dir, "licence"), { recursive: true });
    symlinkSync(moved, join(dir, "licence"));
    expect(invalid()).toContain("licence is a link");
  });
  it.skipIf(isRoot)("is invalid when a mode is wrong", () => {
    const { dir } = stage();
    chmodSync(join(dir, "licence", "LICENSE"), 0o644);
    expect(invalid()).toContain("has the wrong mode");
  });
  it("keeps importDigest independent of the evidence", () => {
    const old = prepareImport(source, tree()).record;
    const withEv = stage({ ...FILES, LICENSE: "root licence" }).record;
    expect(withEv.digest).toBe(old.digest);
    expect(importDigest(withEv.skills)).toBe(withEv.digest);
  });
});
