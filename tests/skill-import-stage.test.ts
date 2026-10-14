import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FACTORY_HOME } from "../src/flow/load.js";
import { homePaths, migrateDataHome, setFactoryHome } from "../src/home.js";
import { acquireLock, jsonFiles, lockPath, releaseLock, VERBATIM_DIRS } from "../src/home-migrate.js";
import { prepareImport, SkillImportError, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { IMPORT_RECORD_FILE, QUARANTINE_DIR, importStoreSettings, publishImport, quarantineDir, quarantinePath, stageImport } from "../src/skills/import-stage.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const isRoot = process.getuid?.() === 0;
const COMMIT = "a".repeat(40);
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
const DEFAULT_FILES: Record<string, string> = { "skills/a/SKILL.md": md("a"), "skills/a/references/x/y.md": "yy", "skills/a/assets/data.json": '{"k":1}', "skills/b/SKILL.md": md("b") };

function tree(files: Record<string, string> = DEFAULT_FILES, onRead?: () => void): SourceTree {
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path }));
  return {
    list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")),
    read: (entries) => {
      onRead?.();
      return entries.map((e) => Buffer.from(files[e.path]!));
    },
  };
}
const source = (over: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
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
  ...over,
});

const saved = { ...importStoreSettings };
const made: string[] = [];
let home: string;
const fresh = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "skillimport-")));
  made.push(d);
  return d;
};
beforeEach(() => {
  home = fresh();
});
afterEach(() => {
  Object.assign(importStoreSettings, saved);
  for (const d of made.splice(0)) {
    try {
      chmodAll(d);
    } catch {
      // best effort
    }
    rmSync(d, { recursive: true, force: true });
  }
});
function chmodAll(p: string) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(p, 0o700);
    for (const n of readdirSync(p)) chmodAll(join(p, n));
  }
}

/** Every path below `dir` with its mode, mtime and bytes. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = lstatSync(p);
    out.push(`${p} ${(st.mode & 0o777).toString(8)} ${st.mtimeMs} ${st.isFile() ? readFileSync(p).toString("hex") : ""}`);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  };
  walk(dir);
  return out;
}
const err = (fn: () => unknown): SkillImportError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SkillImportError);
    return e as SkillImportError;
  }
  throw new Error("did not throw");
};
const stage = (t = tree(), o: { home?: string } = {}) => stageImport(source(), t, { home, ...o });
const dest = () => quarantineDir("lib", COMMIT, home);

describe("stageImport: staging", () => {
  it("stages files, record and modes", () => {
    const r = stage();
    expect(r.state).toBe("staged");
    expect(r.dir).toBe(dest());
    expect(readFileSync(join(r.dir, "files/skills/a/references/x/y.md"), "utf8")).toBe("yy");
    expect(readFileSync(join(r.dir, IMPORT_RECORD_FILE), "utf8")).toBe(JSON.stringify(r.record, null, 2) + "\n");
    const walk = (p: string) => {
      const st = lstatSync(p);
      expect(st.mode & 0o777, p).toBe(st.isDirectory() ? 0o700 : 0o600);
      if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n));
    };
    walk(join(home, QUARANTINE_DIR));
  });
  it("stages a repository-root skill at files/SKILL.md", () => {
    const r = stageImport(source({ paths: ["."] }), tree({ "SKILL.md": md("top"), "references/a.md": "a" }), { home });
    expect(readFileSync(join(r.dir, "files/SKILL.md"), "utf8")).toBe(md("top"));
  });
  it("the second call is unchanged and writes nothing", () => {
    stage();
    const before = snapshot(join(home, QUARANTINE_DIR));
    expect(stage().state).toBe("unchanged");
    expect(snapshot(join(home, QUARANTINE_DIR))).toEqual(before);
    expect(readdirSync(join(home, QUARANTINE_DIR, "lib")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });
  it("works when home is a link", () => {
    const link = join(fresh(), "link");
    symlinkSync(home, link);
    const r = stage(tree(), { home: link });
    expect(r.dir.startsWith(home)).toBe(true);
    expect(stage(tree(), { home: link }).state).toBe("unchanged");
  });
  it("a whole-import failure leaves an earlier import byte-identical", () => {
    stage();
    const before = snapshot(dest());
    expect(err(() => stageImport(source({ ref: { approved: "b".repeat(40) } }), tree({ "skills/a/SKILL.md": "x" }), { home })).code).toBe("nothing-staged");
    expect(err(() => stageImport(source(), tree(), { home, limits: { recordBytes: 100 } })).code).toBe("too-large");
    expect(snapshot(dest())).toEqual(before);
  });
  it("a collision does not fail the import", () => {
    const r = stage(tree({ "skills/Foo/one/SKILL.md": md("one"), "skills/foo/two/SKILL.md": md("two") }));
    expect(r.state).toBe("staged");
    expect(r.record.skills).toHaveLength(1);
    expect(readdirSync(join(r.dir, "files/skills"))).toEqual(["Foo"]);
  });
});

describe("stageImport: conflict", () => {
  const cases: [string, () => void][] = [
    ["tampered", () => writeFileSync(join(dest(), "files/skills/b/SKILL.md"), "other", { mode: 0o600 })],
    ["missing", () => rmSync(join(dest(), "files/skills/b/SKILL.md"))],
    ["extra", () => writeFileSync(join(dest(), "files/extra"), "x", { mode: 0o600 })],
    ["a symlink", () => { rmSync(join(dest(), "files/skills/b/SKILL.md")); symlinkSync(join(dest(), IMPORT_RECORD_FILE), join(dest(), "files/skills/b/SKILL.md")); }],
    ["a dangling symlink", () => { rmSync(join(dest(), "files/skills/b/SKILL.md")); symlinkSync(join(home, "nowhere"), join(dest(), "files/skills/b/SKILL.md")); }],
    ["a folder made a file", () => { rmSync(join(dest(), "files/skills/a/references"), { recursive: true }); writeFileSync(join(dest(), "files/skills/a/references"), "x", { mode: 0o600 }); }],
    ["a folder made a dangling link", () => { rmSync(join(dest(), "files/skills/a/references"), { recursive: true }); symlinkSync(join(home, "nowhere"), join(dest(), "files/skills/a/references")); }],
    ["executable", () => chmodSync(join(dest(), "files/skills/b/SKILL.md"), 0o700)],
  ];
  it.each(cases)("%s", (_n, change) => {
    stage();
    change();
    const before = snapshot(dest());
    const e = err(() => stage());
    expect(e.code).toBe("conflict");
    expect(e.message).toContain("Remove that folder");
    expect(snapshot(dest())).toEqual(before);
  });
  it("changed paths for the same commit", () => {
    stage();
    const before = snapshot(dest());
    expect(err(() => stageImport(source({ paths: ["skills", "skills/a"] }), tree(), { home })).code).toBe("conflict");
    expect(snapshot(dest())).toEqual(before);
  });
});

describe("stageImport: bad folders and modes", () => {
  it("quarantine as a link", () => {
    const out = fresh();
    symlinkSync(out, join(home, QUARANTINE_DIR));
    expect(err(() => stage()).code).toBe("cannot-write");
    expect(readdirSync(out)).toEqual([]);
  });
  it("source folder as a link", () => {
    const out = fresh();
    mkdirSync(join(home, QUARANTINE_DIR), { mode: 0o700 });
    symlinkSync(out, join(home, QUARANTINE_DIR, "lib"));
    expect(err(() => stage()).code).toBe("cannot-write");
    expect(readdirSync(out)).toEqual([]);
  });
  it.each(["link", "file"])("destination as a %s", (kind) => {
    const out = fresh();
    mkdirSync(join(home, QUARANTINE_DIR, "lib"), { recursive: true, mode: 0o700 });
    if (kind === "link") symlinkSync(out, dest());
    else writeFileSync(dest(), "x");
    expect(err(() => stage()).code).toBe("cannot-write");
    expect(readdirSync(out)).toEqual([]);
  });
  it.each([["skill-quarantine", 0o755], ["source folder", 0o777]] as const)("a %s with the wrong mode is refused and not changed", (which, mode) => {
    stage();
    const p = which === "source folder" ? join(home, QUARANTINE_DIR, "lib") : join(home, QUARANTINE_DIR);
    chmodSync(p, mode);
    const before = snapshot(dest());
    const e = err(() => stage());
    expect(e.code).toBe("cannot-write");
    expect(e.message).toContain("0700");
    expect(lstatSync(p).mode & 0o777).toBe(mode);
    expect(snapshot(dest())).toEqual(before);
    chmodSync(p, 0o700);
    expect(stage().state).toBe("unchanged");
  });
  it("nothing is created for a wrong mode on a fresh home", () => {
    mkdirSync(join(home, QUARANTINE_DIR), { mode: 0o755 });
    chmodSync(join(home, QUARANTINE_DIR), 0o755);
    expect(err(() => stage()).code).toBe("cannot-write");
    expect(readdirSync(join(home, QUARANTINE_DIR))).toEqual([]);
  });
  it("a swap before the publish is caught and nothing is renamed", () => {
    const out = fresh();
    let renamed = false;
    importStoreSettings.rename = () => { renamed = true; };
    importStoreSettings.realpath = (p) => {
      const sourceDir = join(home, QUARANTINE_DIR, "lib");
      renameSync(sourceDir, join(out, "moved"));
      symlinkSync(join(out, "moved"), sourceDir);
      return realpathSync(p);
    };
    expect(err(() => stage()).code).toBe("cannot-write");
    expect(renamed).toBe(false);
    expect(existsSync(join(out, "moved", COMMIT))).toBe(false);
  });
});

describe("stageImport: locks", () => {
  it("a held lock gives locked and creates nothing", () => {
    const lock = join(home, "skill-quarantine.lock");
    expect(acquireLock(lock)).toBe(true);
    importStoreSettings.waitMs = 50;
    try {
      expect(err(() => stage()).code).toBe("locked");
      expect(existsSync(join(home, QUARANTINE_DIR))).toBe(false);
    } finally {
      releaseLock(lock);
    }
  });
  it("two imports end with one folder", () => {
    let nested: ReturnType<typeof stageImport> | undefined;
    let done = false;
    const outer = stage(tree(DEFAULT_FILES, () => {
      if (done) return;
      done = true;
      nested = stage();
    }));
    expect(nested?.state).toBe("staged");
    expect(outer.state).toBe("unchanged");
    expect(readdirSync(join(home, QUARANTINE_DIR, "lib"))).toEqual([COMMIT]);
  });
});

describe("stageImport: failures", () => {
  const exdev = () => Object.assign(new Error("EXDEV: cross-device link, rename '/marker/path'"), { code: "EXDEV" });
  it("a failed rename leaves nothing and names only the code", () => {
    importStoreSettings.rename = () => { throw exdev(); };
    const e = err(() => stage());
    expect(e.code).toBe("cannot-write");
    expect(e.message).toContain("EXDEV");
    expect(e.message).not.toContain("/marker/path");
    expect(existsSync(dest())).toBe(false);
    expect(readdirSync(join(home, QUARANTINE_DIR, "lib"))).toEqual([]);
    expect(existsSync(join(home, "skill-quarantine.lock"))).toBe(false);
  });
  it("an error without a code gives (error)", () => {
    importStoreSettings.rename = () => { throw new Error("boom"); };
    const e = err(() => stage());
    expect(e.message).toContain("(error)");
    expect(e.message).not.toContain("boom");
  });
  it("removes a stale temp folder on the next run", () => {
    mkdirSync(join(home, QUARANTINE_DIR, "lib", ".tmp-0123456789abcdef"), { recursive: true, mode: 0o700 });
    stage();
    expect(readdirSync(join(home, QUARANTINE_DIR, "lib"))).toEqual([COMMIT]);
  });
  it.skipIf(isRoot)("a home that cannot be written gives EACCES and no lock", () => {
    chmodSync(home, 0o500);
    try {
      const e = err(() => stage());
      expect(e.code).toBe("cannot-write");
      expect(e.message).toContain("EACCES");
      expect(e.message).not.toContain(home);
      expect(existsSync(join(home, QUARANTINE_DIR))).toBe(false);
    } finally {
      chmodSync(home, 0o700);
    }
    expect(existsSync(join(home, "skill-quarantine.lock"))).toBe(false);
  });
  it.skipIf(isRoot)("an unreadable folder or file is cannot-write, not conflict", () => {
    stage();
    const before = snapshot(dest());
    for (const p of [join(dest(), "files"), join(dest(), "files/skills/b/SKILL.md")]) {
      chmodSync(p, 0o000);
      try {
        const e = err(() => stage());
        expect(e.code).toBe("cannot-write");
        expect(e.message).toContain("EACCES");
        expect(e.message).not.toContain(home);
      } finally {
        chmodSync(p, p.endsWith(".md") ? 0o600 : 0o700);
      }
      expect(existsSync(join(home, "skill-quarantine.lock"))).toBe(false);
    }
    expect(snapshot(dest())).toEqual(before);
    expect(stage().state).toBe("unchanged");
  });
  it.skipIf(isRoot)("a failed cleanup still names the first error and is cleaned next time", () => {
    importStoreSettings.rename = (from) => {
      chmodSync(join(from, "files"), 0o500);
      throw exdev();
    };
    expect(err(() => stage()).message).toContain("EXDEV");
    importStoreSettings.rename = saved.rename;
    expect(stage().state).toBe("staged");
    expect(readdirSync(join(home, QUARANTINE_DIR, "lib")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);
  });
});

describe("stageImport: moved data folder", () => {
  let savedEnv: Record<string, string | undefined>;
  let binding: string;
  beforeEach(() => {
    savedEnv = { HOME: process.env.HOME, FACTORY_HOME: process.env.FACTORY_HOME, SCF_HOME: process.env.SCF_HOME };
    binding = FACTORY_HOME;
    process.env.HOME = home;
    delete process.env.FACTORY_HOME;
    delete process.env.SCF_HOME;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    setFactoryHome(binding);
  });
  it("refuses to write and releases both locks", () => {
    const { oldHome, newHome } = homePaths();
    mkdirSync(oldHome, { recursive: true });
    setFactoryHome(oldHome);
    const e = err(() => stageImport(source(), tree(DEFAULT_FILES, () => mkdirSync(newHome, { recursive: true }))));
    expect(e.code).toBe("cannot-write");
    expect(e.message).toContain(newHome);
    expect(existsSync(join(oldHome, QUARANTINE_DIR))).toBe(false);
    expect(existsSync(join(newHome, QUARANTINE_DIR))).toBe(false);
    expect(existsSync(join(oldHome, "skill-quarantine.lock"))).toBe(false);
    expect(existsSync(lockPath(newHome))).toBe(false);
  });
  it("the move copies the quarantine unchanged", () => {
    const base = fresh();
    const from = join(base, ".claude-factory");
    const to = join(base, ".spaghetti-code-foundry");
    mkdirSync(from);
    const files = { ...DEFAULT_FILES, "skills/a/assets/data.json": `{"p":"${from}/x"}` };
    stageImport(source(), tree(files), { home: from });
    expect(jsonFiles(from)).toEqual([]);
    const staged = join(quarantineDir("lib", COMMIT, from), "files/skills/a/assets/data.json");
    const bytes = readFileSync(staged);
    const r = migrateDataHome({ from, to, env: {}, freeBytes: () => 1e15, sizeBytes: () => 1000, log: () => {} });
    expect(r.status).toBe("migrated");
    const moved = join(quarantineDir("lib", COMMIT, to), "files/skills/a/assets/data.json");
    expect(readFileSync(moved)).toEqual(bytes);
    expect(statSync(moved).mode & 0o777).toBe(0o600);
    expect(stageImport(source(), tree(files), { home: to }).state).toBe("unchanged");
  });
});

describe("publishImport", () => {
  it("gives the same folder and digest as stageImport", () => {
    const other = fresh();
    const a = stageImport(source(), tree(), { home: other });
    const b = publishImport(prepareImport(source(), tree()), { home });
    expect(b.state).toBe("staged");
    expect(b.record.digest).toBe(a.record.digest);
    expect(b.dir).toBe(dest());
    expect(readFileSync(join(b.dir, IMPORT_RECORD_FILE))).toEqual(readFileSync(join(a.dir, IMPORT_RECORD_FILE)));
  });

  it.each([
    ["source", { source: "../x" }],
    ["commit", { commit: "main" }],
  ])("refuses a record with a bad %s and writes nothing", (_n, over) => {
    const prep = prepareImport(source(), tree());
    const bad = { ...prep, record: { ...prep.record, ...over } };
    expect(err(() => publishImport(bad, { home })).code).toBe("not-usable");
    expect(existsSync(join(home, QUARANTINE_DIR))).toBe(false);
  });
});

describe("quarantine name and path", () => {
  it("the move folder list holds the quarantine", () => {
    expect(VERBATIM_DIRS).toContain(QUARANTINE_DIR);
  });
  it("quarantinePath", () => {
    const q = join(home, QUARANTINE_DIR);
    mkdirSync(join(q, "src"), { recursive: true });
    const other = fresh();
    symlinkSync(join(q, "src"), join(other, "link"));
    expect(quarantinePath(q, home)).toBe(true);
    expect(quarantinePath(join(q, "src", "c"), home)).toBe(true);
    expect(quarantinePath(join(other, "link"), home)).toBe(true);
    expect(quarantinePath(join(home, "Skill-Quarantine"), home)).toBe(true);
    expect(quarantinePath(other, home)).toBe(false);
    expect(quarantinePath(join(home, "skills"), home)).toBe(false);
  });
});

describe("licence evidence", () => {
  const MIT = "MIT License\n\nCopyright (c) 2024 Example\n\nPermission is hereby granted.\n";
  const WITH_LIC = { ...DEFAULT_FILES, LICENSE: MIT, "skills/a/LICENSE.txt": MIT + "a", "skills/NOTICE": "notice", "other/LICENSE": "elsewhere" };
  const stage = (files: Record<string, string>, h = home) => stageImport(source(), tree(files), { home: h });

  it("keeps the licence and notice files that apply, in byte order, with modes", () => {
    const r = stage(WITH_LIC);
    const rec = JSON.parse(readFileSync(join(r.dir, "licences.json"), "utf8"));
    expect(rec.files.map((f: { path: string }) => f.path)).toEqual(["LICENSE", "skills/NOTICE", "skills/a/LICENSE.txt"]);
    expect(rec.files[0]).toMatchObject({ kind: "licence", bytes: Buffer.byteLength(MIT) });
    expect(readFileSync(join(r.dir, "licences/skills/a/LICENSE.txt"), "utf8")).toBe(MIT + "a");
    expect(existsSync(join(r.dir, "licences/other"))).toBe(false);
    expect(statSync(join(r.dir, "licences.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.dir, "licences/skills")).mode & 0o777).toBe(0o700);
  });

  it("writes an empty list and no folder when the source has no licence file", () => {
    const r = stage(DEFAULT_FILES);
    expect(JSON.parse(readFileSync(join(r.dir, "licences.json"), "utf8")).files).toEqual([]);
    expect(existsSync(join(r.dir, "licences"))).toBe(false);
  });

  it("leaves import.json and the digest as they are with and without evidence", () => {
    const prep = prepareImport(source(), tree(WITH_LIC));
    const a = publishImport(prep, { home });
    const b = publishImport({ ...prep, licences: { repositoryKey: "github.com/example/skills", commit: COMMIT, files: [] } }, { home: fresh() });
    expect(readFileSync(join(b.dir, IMPORT_RECORD_FILE))).toEqual(readFileSync(join(a.dir, IMPORT_RECORD_FILE)));
    expect(b.record.digest).toBe(a.record.digest);
  });

  it("is unchanged the second time", () => {
    stage(WITH_LIC);
    expect(stage(WITH_LIC).state).toBe("unchanged");
  });

  it.each([
    ["a changed file", (d: string) => writeFileSync(join(d, "licences/LICENSE"), "x".repeat(Buffer.byteLength(MIT)))],
    ["a missing file", (d: string) => rmSync(join(d, "licences/LICENSE"))],
    ["an extra file", (d: string) => writeFileSync(join(d, "licences/EXTRA"), "x", { mode: 0o600 })],
    [
      "a link",
      (d: string) => {
        rmSync(join(d, "licences/LICENSE"));
        symlinkSync("/etc/hostname", join(d, "licences/LICENSE"));
      },
    ],
    ["an edited licences.json", (d: string) => writeFileSync(join(d, "licences.json"), "{}\n")],
  ])("refuses a folder with %s", (_n, change) => {
    const r = stage(WITH_LIC);
    change(r.dir);
    let err: unknown;
    try {
      stage(WITH_LIC);
    } catch (e) {
      err = e;
    }
    expect((err as SkillImportError).code).toBe("conflict");
    expect((err as Error).message).toContain("Remove that folder");
  });

  it("says so when the folder was staged before evidence was kept, and changes nothing", () => {
    const old = publishImport(prepareImport(source(), tree(WITH_LIC)), { home });
    const before = readdirSync(old.dir, { recursive: true }).sort();
    expect(() => stage(WITH_LIC)).toThrow(/was staged before licence evidence was kept\. Remove that folder, then import again/);
    expect(readdirSync(old.dir, { recursive: true }).sort()).toEqual(before);
    rmSync(old.dir, { recursive: true });
    expect(stage(WITH_LIC).state).toBe("staged");
  });

  it("lists a link as a problem and writes no file for it", () => {
    const t = tree({ ...DEFAULT_FILES, LICENSE: MIT });
    const t2: SourceTree = { list: (p) => t.list(p).map((e) => (e.path === "LICENSE" ? { ...e, kind: "symlink" as const } : e)), read: (es) => t.read(es) };
    const r = stageImport(source(), t2, { home });
    const rec = JSON.parse(readFileSync(join(r.dir, "licences.json"), "utf8"));
    expect(rec.files).toEqual([{ path: "LICENSE", kind: "licence", problem: "a symbolic link" }]);
    expect(existsSync(join(r.dir, "licences"))).toBe(false);
  });

  it("keeps the first of two names that clash on a case-insensitive disk", () => {
    const r = stage({ ...DEFAULT_FILES, "skills/LICENSE": "one", "skills/license": "two" });
    const rec = JSON.parse(readFileSync(join(r.dir, "licences.json"), "utf8"));
    const bad = rec.files.filter((f: { problem?: string }) => f.problem?.startsWith("cannot be kept"));
    expect(bad).toHaveLength(1);
    expect(readdirSync(join(r.dir, "licences/skills"))).toHaveLength(1);
  });

  it("refuses evidence for another commit and writes nothing", () => {
    const prep = prepareImport(source(), tree(DEFAULT_FILES));
    expect(() => publishImport({ ...prep, licences: { repositoryKey: "github.com/example/skills", commit: "b".repeat(40), files: [] } }, { home })).toThrow(/another repository or commit/);
    expect(existsSync(join(home, QUARANTINE_DIR))).toBe(false);
  });

  it("leaves nothing behind when the rename fails", () => {
    importStoreSettings.rename = () => {
      throw new Error("no");
    };
    expect(() => stage(WITH_LIC)).toThrow();
    expect(readdirSync(join(home, QUARANTINE_DIR, "lib"))).toEqual([]);
  });
});
