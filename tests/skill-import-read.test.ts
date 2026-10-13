import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
