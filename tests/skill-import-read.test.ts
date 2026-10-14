import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachLicenceEvidence, collectImportEvidence } from "../src/skills/import-evidence.js";
import { collectLicenceEvidence, evaluateLicence } from "../src/skills/licence.js";
import { LICENCE_LIMITS } from "../src/skills/licence-rules.js";
import { IMPORT_LIMITS, importDigest, parseImportRecord, prepareImport, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { publishImport, readStagedImport } from "../src/skills/import-stage.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const isRoot = process.getuid?.() === 0;
const COMMIT = "a".repeat(40);
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
const FILES: Record<string, string> = { "skills/a/SKILL.md": md("a"), "skills/a/references/x/y.md": "yy", "skills/b/SKILL.md": md("b") };
function tree(files: Record<string, string> = FILES): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return { list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")), read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)) };
}
const source = (paths = ["skills"]): SkillLibrarySource => ({
  id: "lib",
  repository: "https://github.com/example/skills",
  repositoryKey: "github.com/example/skills",
  status: "enabled",
  ref: { approved: COMMIT },
  paths,
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "manual" },
  owner: "@example",
});

const made: string[] = [];
let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skillread-")));
  made.push(home);
});
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const stage = (files = FILES, paths = ["skills"]) => publishImport(prepareImport(source(paths), tree(files)), { home });
const read = () => readStagedImport("lib", COMMIT, { home });
const invalid = (): string => {
  const r = read();
  if (r.state !== "invalid") throw new Error("expected invalid, got " + r.state);
  return r.problem;
};

describe("readStagedImport", () => {
  it("reads back what was published", () => {
    const pub = publishImport(prepareImport(source(), tree()), { home });
    const r = read();
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.record).toEqual(pub.record);
    expect(r.dir).toBe(pub.dir);
    expect(r.recordText).toBe(readFileSync(join(pub.dir, "import.json"), "utf8"));
    expect([...r.files.keys()]).toEqual(Object.keys(FILES).sort());
  });

  it("reads an import with more folders than files", () => {
    const deep = { "skills/s/SKILL.md": md("s"), "skills/s/a/b/c/d/e/f.md": "x" };
    stage(deep);
    expect(read().state).toBe("ok");
    const root = { "x/y/z/SKILL.md": md("z"), "x/y/z/a/b/c/d/e.md": "x" };
    rmSync(join(home, "skill-quarantine"), { recursive: true, force: true });
    stage(root, ["x"]);
    expect(read().state).toBe("ok");
  });

  it("is none when nothing is staged", () => {
    expect(readStagedImport("lib", COMMIT, { home: join(home, "missing") })).toEqual({ state: "none" });
    expect(read()).toEqual({ state: "none" });
    mkdirSync(join(home, "skill-quarantine"), { mode: 0o700 });
    expect(read()).toEqual({ state: "none" });
    mkdirSync(join(home, "skill-quarantine", "lib"), { mode: 0o700 });
    expect(read()).toEqual({ state: "none" });
  });

  it("refuses a bad source id or commit", () => {
    expect(readStagedImport("../x", COMMIT, { home }).state).toBe("invalid");
    expect(readStagedImport("lib", "main", { home }).state).toBe("invalid");
  });

  it("refuses a changed file, with the same size or another", () => {
    const { dir } = stage();
    const file = join(dir, "files", "skills", "a", "references", "x", "y.md");
    writeFileSync(file, "zz");
    expect(invalid()).toContain("skills/a changed");
    writeFileSync(file, "zzz");
    expect(invalid()).toContain("skills/a changed");
  });

  it("refuses links", () => {
    const { dir } = stage();
    const file = join(dir, "files", "skills", "b", "SKILL.md");
    rmSync(file);
    symlinkSync(join(dir, "import.json"), file);
    expect(invalid()).toContain("is a link");
    rmSync(file);
    writeFileSync(file, md("b"), { mode: 0o600 });
    const sub = join(dir, "files", "skills", "a", "references");
    rmSync(sub, { recursive: true });
    symlinkSync(join(dir, "files"), sub);
    expect(invalid()).toContain("is a link");
  });

  it("refuses a commit folder that is a link", () => {
    const { dir } = stage();
    const moved = dir + "-real";
    rmSync(moved, { recursive: true, force: true });
    writeFileSync(join(home, "marker"), "x");
    mkdirSync(moved, { mode: 0o700 });
    rmSync(dir, { recursive: true });
    symlinkSync(moved, dir);
    expect(invalid()).toContain("is not a plain folder");
  });

  it("refuses extra and missing entries", () => {
    const { dir } = stage();
    writeFileSync(join(dir, "files", "skills", "a", "extra.md"), "x");
    expect(invalid()).toContain("more files than import.json lists");
    rmSync(join(dir, "files", "skills", "a", "extra.md"));
    writeFileSync(join(dir, "files", "other.md"), "x");
    expect(invalid()).toContain("more files than import.json lists");
    // a file outside every skill root, with the file count kept equal
    const gone = join(dir, "files", "skills", "b", "SKILL.md");
    rmSync(gone);
    expect(invalid()).toContain("is not part of the import");
    writeFileSync(gone, md("b"), { mode: 0o600 });
    rmSync(join(dir, "files", "other.md"));
    writeFileSync(join(dir, "note.txt"), "x");
    expect(invalid()).toContain("note.txt is not part of the import");
    rmSync(join(dir, "note.txt"));
    mkdirSync(join(dir, "files", "empty"), { mode: 0o700 });
    expect(invalid()).toContain("empty is not part of the import");
    rmSync(join(dir, "files", "empty"), { recursive: true });
    rmSync(join(dir, "files", "skills", "b", "SKILL.md"));
    expect(invalid()).toContain("skills/b changed");
  });

  it("refuses more folders than the record can have", () => {
    const { dir } = stage({ "skills/s/SKILL.md": md("s") });
    // one skill, one file, root of 2 segments: at most 2 + 5 folders
    let p = join(dir, "files");
    for (let i = 0; i < 8; i++) {
      p = join(p, "d" + i);
      mkdirSync(p, { mode: 0o700 });
    }
    expect(invalid()).toMatch(/more folders|is not part of the import/);
  });

  it.skipIf(isRoot)("refuses wrong modes", () => {
    const { dir } = stage();
    const file = join(dir, "files", "skills", "b", "SKILL.md");
    chmodSync(file, 0o644);
    expect(invalid()).toContain("has the wrong mode");
    chmodSync(file, 0o600);
    chmodSync(join(dir, "files", "skills"), 0o755);
    expect(invalid()).toContain("has the wrong mode");
  });

  it.skipIf(isRoot)("refuses wrong modes of the quarantine and source folders", () => {
    const { dir } = stage();
    for (const folder of [join(home, "skill-quarantine"), join(home, "skill-quarantine", "lib")]) {
      chmodSync(folder, 0o777);
      expect(invalid()).toContain("has the wrong mode");
      chmodSync(folder, 0o700);
      expect(read().state).toBe("ok");
    }
    expect(dir).toContain("lib");
  });

  it("refuses an edited import.json", () => {
    const { dir } = stage();
    const path = join(dir, "import.json");
    const text = readFileSync(path, "utf8");
    const put = (t: string) => writeFileSync(path, t, { mode: 0o600 });
    put(text.replace(/sha256:[0-9a-f]{4}/, "sha256:0000"));
    expect(invalid()).toMatch(/^import\.json/);
    put(text.replace('"schema": 1,', '"schema": 1,\n  "extra": 1,'));
    expect(invalid()).toContain("not in the form scf writes");
    put("{not json");
    expect(invalid()).toBe("import.json is not valid JSON");
    put(text.replace('"source": "lib"', '"source": "other"'));
    expect(invalid()).toContain("another source or commit");
    put(text + " ".repeat(IMPORT_LIMITS.recordBytes));
    expect(invalid()).toContain("too large");
    put(text);
    expect(read().state).toBe("ok");
  });

  it("changes nothing and takes no lock", () => {
    stage();
    const snap = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = join(d, e.name);
        const st = statSync(p);
        return e.isDirectory() ? [`${p} ${st.mode} ${st.mtimeMs}`, ...snap(p)] : [`${p} ${st.mode} ${st.mtimeMs} ${readFileSync(p).toString("hex")}`];
      });
    const before = snap(home);
    expect(read().state).toBe("ok");
    expect(snap(home)).toEqual(before);
    expect(readdirSync(home)).not.toContain("skill-quarantine.lock");
  });
});

describe("parseImportRecord", () => {
  const prepared = () => prepareImport(source(), tree());
  it("round-trips the text prepareImport wrote", () => {
    const p = prepared();
    expect(parseImportRecord(p.recordText)).toEqual({ record: p.record });
  });
  it("accepts text that was edited but keeps the written form (rejected text is not checked)", () => {
    const p = prepared();
    const text = JSON.stringify({ ...p.record, rejected: [{ root: "x", reasons: ["y"] }] }, null, 2) + "\n";
    expect("record" in parseImportRecord(text)).toBe(true);
  });
  it.each<[string, (r: Record<string, unknown>) => void, string]>([
    ["schema", (r) => (r.schema = 2), "schema is not 1"],
    ["source", (r) => (r.source = "Bad Id"), "source is not a source id"],
    ["commit", (r) => (r.commit = "main"), "commit is not a full commit id"],
    ["adapter", (r) => (r.adapter = "x"), "adapter is not agent-skills"],
    ["repository", (r) => (r.repository = ""), "repository is not usable"],
    ["paths", (r) => (r.paths = []), "paths is not usable"],
    ["digest", (r) => (r.digest = "nope"), "digest is not a digest"],
    ["skills", (r) => (r.skills = []), "skills is not a list"],
    ["rejected", (r) => (r.rejected = "x"), "rejected is not usable"],
  ])("refuses a bad %s", (_n, change, message) => {
    const r = JSON.parse(prepared().recordText) as Record<string, unknown>;
    change(r);
    const got = parseImportRecord(JSON.stringify(r, null, 2) + "\n");
    expect(got).toEqual({ problem: expect.stringContaining(message) });
  });
  it("refuses a bad skill entry and never repeats a value", () => {
    const secret = "ghp_" + "a1B2c3D4e5".repeat(4);
    const r = JSON.parse(prepared().recordText) as { skills: Record<string, unknown>[] };
    r.skills[0]!.digest = secret;
    const got = parseImportRecord(JSON.stringify(r, null, 2) + "\n");
    expect("problem" in got && got.problem).toBe("import.json: skills[0].digest is not a digest");
    r.skills[0]!.root = secret + "\u0007";
    const got2 = parseImportRecord(JSON.stringify(r, null, 2) + "\n");
    expect("problem" in got2 && got2.problem).not.toContain(secret);
  });
  it("refuses a digest that does not match the skills", () => {
    const r = JSON.parse(prepared().recordText) as { digest: string };
    r.digest = "sha256:" + "0".repeat(64);
    expect(parseImportRecord(JSON.stringify(r, null, 2) + "\n")).toEqual({ problem: "import.json: digest does not match the skills" });
  });
  it("accepts exactly the file and byte limits and refuses one more", () => {
    const made = (skills: number, files: number, bytes: number) => {
      const list = Array.from({ length: skills }, (_v, i) => ({ root: `s/${i}`, name: "n" + i, digest: "sha256:" + String(i).padStart(64, "0"), files, bytes }));
      const rec = { ...prepared().record, digest: importDigest(list), skills: list, rejected: [] };
      return parseImportRecord(JSON.stringify(rec, null, 2) + "\n");
    };
    expect("record" in made(100, 200, 0)).toBe(true);
    expect(made(101, 200, 0)).toEqual({ problem: expect.stringContaining("more files") });
    expect("record" in made(32, 1, 2097152)).toBe(true);
    expect(made(33, 1, 2097152)).toEqual({ problem: expect.stringContaining("more bytes") });
  });
});

describe("licence evidence", () => {
  const ORIGIN = { repositoryKey: "github.com/example/skills", commit: COMMIT };
  const LIC = "MIT License\n\nPermission is hereby granted.\n";
  const LFILES: Record<string, string> = { LICENSE: LIC, "skills/NOTICE": "notice", "skills/a/LICENSE": LIC, ...FILES };
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const attached = (files = LFILES) => {
    const t = tree(files);
    return attachLicenceEvidence(prepareImport(source(), t), collectImportEvidence(ORIGIN, ["skills/a", "skills/b"], t));
  };
  const withEvidence = (evidence: unknown) => {
    const rec = { ...prepareImport(source(), tree()).record, evidence };
    return parseImportRecord(JSON.stringify(rec, null, 2) + "\n");
  };
  const entry = (path: string, over: Record<string, unknown> = {}) => ({ path, kind: "licence", sha256: sha("x"), bytes: 1, ...over });
  const stageNew = (files = LFILES) => publishImport(attached(files), { home });

  it("round-trips a record with evidence and with an empty list, and a record without the key has none", () => {
    const p = attached();
    expect(parseImportRecord(p.recordText)).toEqual({ record: p.record });
    const empty = withEvidence([]);
    expect("record" in empty && empty.record.evidence).toEqual([]);
    const old = parseImportRecord(prepareImport(source(), tree()).recordText);
    expect("record" in old && "evidence" in old.record).toBe(false);
  });

  it.each([
    ["not an array", {}],
    ["too many entries", Array.from({ length: 201 }, (_v, i) => entry(`d/${String(i).padStart(4, "0")}`))],
    ["unsorted paths", [entry("b"), entry("a")]],
    ["a path used twice", [entry("a"), entry("a")]],
    ["a dot path", [entry(".")]],
    ["a path that leaves", [entry("../secret-x")]],
    ["a control character", [entry("a\u0001b")]],
    ["a bad kind", [entry("a", { kind: "other" })]],
    ["a bad sha256", [entry("a", { sha256: "XYZ" })]],
    ["too many bytes", [entry("a", { bytes: LICENCE_LIMITS.fileBytes + 1 })]],
    ["sha256 and problem", [entry("a", { problem: "p" })]],
    ["neither", [{ path: "a", kind: "licence" }]],
    ["a long problem", [{ path: "a", kind: "licence", problem: "p".repeat(201) }]],
    ["one sha256 with two sizes", [entry("a"), entry("b", { bytes: 2 })]],
    ["too many bytes in total", Array.from({ length: 17 }, (_v, i) => entry(`f${String(i).padStart(2, "0")}`, { sha256: sha(String(i)), bytes: LICENCE_LIMITS.fileBytes }))],
  ])("refuses evidence with %s and never repeats a value", (_n, evidence) => {
    const r = withEvidence(evidence);
    expect(r).toEqual({ problem: expect.stringMatching(/^import\.json: evidence/) });
    expect(JSON.stringify(r)).not.toContain("secret-x");
  });

  it("refuses evidence that is not the last key", () => {
    const p = attached();
    const { evidence, rejected, ...rest } = p.record;
    const text = JSON.stringify({ ...rest, evidence, rejected }, null, 2) + "\n";
    expect(parseImportRecord(text)).toEqual({ problem: "import.json: is not in the form scf writes" });
  });

  it("attachLicenceEvidence keeps every digest, stores identical content once and gives a problem no blob", () => {
    const base = prepareImport(source(), tree(LFILES));
    const t = tree({ ...LFILES, "skills/b/LICENSE": "other" });
    const ev = collectImportEvidence(ORIGIN, ["skills/a", "skills/b"], t);
    ev.files.find((f) => f.path === "skills/NOTICE")!.problem = "gone";
    delete ev.files.find((f) => f.path === "skills/NOTICE")!.content;
    const out = attachLicenceEvidence(base, ev);
    expect(out.record.digest).toBe(base.record.digest);
    expect(out.record.skills).toEqual(base.record.skills);
    expect(out.files).toBe(base.files);
    expect(out.evidence!.size).toBe(2);
    expect(out.record.evidence!.find((e) => e.path === "skills/NOTICE")).toEqual({ path: "skills/NOTICE", kind: "notice", problem: "gone" });
  });

  it("attachLicenceEvidence refuses another commit, a repeated path and a record that is too large", () => {
    const base = prepareImport(source(), tree(LFILES));
    const ev = collectImportEvidence(ORIGIN, ["skills/a"], tree(LFILES));
    expect(() => attachLicenceEvidence(base, { ...ev, commit: "b".repeat(40) })).toThrowError(expect.objectContaining({ code: "not-usable" }));
    expect(() => attachLicenceEvidence(base, { ...ev, repositoryKey: "x/y" })).toThrowError(expect.objectContaining({ code: "not-usable" }));
    expect(() => attachLicenceEvidence(base, { ...ev, files: [ev.files[0]!, ev.files[0]!] })).toThrowError(expect.objectContaining({ code: "not-usable" }));
    expect(() => attachLicenceEvidence(base, ev, { limits: { recordBytes: 100 } })).toThrowError(expect.objectContaining({ code: "too-large" }));
  });

  describe("collectImportEvidence", () => {
    const code = (c: string) => Object.assign(new Error("x"), { code: c });
    const recoverable = (e: unknown) => (e as { code?: string }).code === "read-failed";
    const flaky = (c = "read-failed", counts = { reads: 0 }): SourceTree => {
      const t = tree(LFILES);
      return {
        list: t.list,
        read: (entries) => {
          counts.reads++;
          if (entries.length > 1 && entries.some((e) => e.path === "LICENSE")) throw code(c);
          if (entries.some((e) => e.path === "LICENSE")) throw code(c);
          return t.read(entries);
        },
      };
    };

    it("keeps an unreadable file as a problem and the other files with bytes", () => {
      const ev = collectImportEvidence(ORIGIN, ["skills/a"], flaky(), { recoverable });
      const root = ev.files.find((f) => f.path === "LICENSE")!;
      expect(root.problem).toBe("cannot be read");
      expect(root.content).toBeUndefined();
      expect(ev.files.find((f) => f.path === "skills/NOTICE")!.content).toBeDefined();
    });

    it("reads once and equals collectLicenceEvidence when every read works", () => {
      const counts = { reads: 0 };
      const t = tree(LFILES);
      const counted: SourceTree = { list: t.list, read: (e) => (counts.reads++, t.read(e)) };
      expect(collectImportEvidence(ORIGIN, ["skills/a"], counted, { recoverable })).toEqual(collectLicenceEvidence(ORIGIN, ["skills/a"], t));
      expect(counts.reads).toBe(1);
    });

    it("throws without recoverable, for another error and for a listing error", () => {
      expect(() => collectImportEvidence(ORIGIN, ["skills/a"], flaky())).toThrow();
      expect(() => collectImportEvidence(ORIGIN, ["skills/a"], flaky("timeout"), { recoverable })).toThrow();
      const t = tree(LFILES);
      expect(() => collectImportEvidence(ORIGIN, ["skills/a"], { list: () => { throw code("read-failed"); }, read: t.read }, { recoverable: () => true })).toThrow();
    });

    it("throws for more than 200 licence files before any read", () => {
      const many: Record<string, string> = { ...FILES };
      for (let i = 0; i < 201; i++) many[`skills/LICENSE-${i}`] = "x";
      let reads = 0;
      const t = tree(many);
      expect(() => collectImportEvidence(ORIGIN, ["skills/a"], { list: t.list, read: (e) => (reads++, t.read(e)) }, { recoverable })).toThrowError(expect.objectContaining({ code: "too-many-entries" }));
      expect(reads).toBe(0);
    });
  });

  describe("readStagedImport", () => {
    it("returns the evidence of the record's repository and commit, and the skill files are unchanged", () => {
      stageNew();
      const r = readStagedImport("lib", COMMIT, { home });
      if (r.state !== "ok") throw new Error("not ok");
      expect(r.evidence!.repositoryKey).toBe(ORIGIN.repositoryKey);
      expect(r.evidence!.commit).toBe(COMMIT);
      expect(r.evidence!.files.map((f) => [f.path, f.dir, f.kind, Buffer.from(f.content!).toString()])).toEqual([
        ["LICENSE", ".", "licence", LIC],
        ["skills/NOTICE", "skills", "notice", "notice"],
        ["skills/a/LICENSE", "skills/a", "licence", LIC],
      ]);
      expect([...r.files.keys()].some((k) => k.endsWith("NOTICE") || k === "LICENSE")).toBe(false);
      expect(evaluateLicence({ root: "skills/b", allow: ["MIT"], evidence: r.evidence! })).toEqual(
        evaluateLicence({ root: "skills/b", allow: ["MIT"], evidence: collectLicenceEvidence(ORIGIN, ["skills/a", "skills/b"], tree(LFILES)) }),
      );
    });

    it("reads an import staged before evidence was kept, with no evidence and no folder", () => {
      publishImport(prepareImport(source(), tree(LFILES)), { home });
      const r = readStagedImport("lib", COMMIT, { home });
      if (r.state !== "ok") throw new Error("not ok");
      expect(r.evidence).toBeUndefined();
      expect(readdirSync(r.dir).sort()).toEqual(["files", "import.json"]);
    });

    const blob = () => join(home, "skill-quarantine", "lib", COMMIT, "evidence", sha(LIC));
    const folder = () => join(home, "skill-quarantine", "lib", COMMIT, "evidence");
    it.skipIf(isRoot).each([
      ["changed bytes", () => writeFileSync(blob(), "X".repeat(Buffer.byteLength(LIC)), { mode: 0o600 })],
      ["a truncated blob", () => writeFileSync(blob(), "MIT", { mode: 0o600 })],
      ["a removed blob", () => rmSync(blob())],
      ["an extra file", () => writeFileSync(join(folder(), "x"), "x", { mode: 0o600 })],
      ["an extra hash-named file", () => writeFileSync(join(folder(), "a".repeat(64)), "x", { mode: 0o600 })],
      ["a blob that is a link", () => (rmSync(blob()), symlinkSync(join(folder(), "..", "import.json"), blob()))],
      ["a folder that is a link", () => (renameSync(folder(), folder() + "-x"), symlinkSync(folder() + "-x", folder()))],
      ["a folder that is a file", () => (rmSync(folder(), { recursive: true }), writeFileSync(folder(), "x", { mode: 0o600 }))],
      ["a blob with mode 0644", () => chmodSync(blob(), 0o644)],
      ["a folder with mode 0755", () => chmodSync(folder(), 0o755)],
      ["a sub-folder", () => mkdirSync(join(folder(), "sub"), { mode: 0o700 })],
    ])("is invalid with %s", (_n, tamper) => {
      stageNew();
      tamper();
      expect(readStagedImport("lib", COMMIT, { home }).state).toBe("invalid");
    });

    it("is invalid with an evidence folder next to a record without the key", () => {
      publishImport(prepareImport(source(), tree(LFILES)), { home });
      mkdirSync(join(home, "skill-quarantine", "lib", COMMIT, "evidence"), { mode: 0o700 });
      expect(readStagedImport("lib", COMMIT, { home }).state).toBe("invalid");
    });
  });
});
