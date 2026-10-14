import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LICENCE_RECORD_BYTES, prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { prepareImport, SkillImportError, type SourceTree, type TreeEntry } from "../src/skills/import-plan.js";
import { importStoreSettings, publishImport, readStagedImport, readStagedLicence, stageImport } from "../src/skills/import-stage.js";
import { collectLicenceEvidence, evaluateLicence } from "../src/skills/licence.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const isRoot = process.getuid?.() === 0;
const COMMIT = "a".repeat(40);
const COMMIT2 = "b".repeat(40);
const MIT = "MIT License\n\nCopyright (c) 2024 Example Author\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the \"Software\"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n";
const md = (name: string) => `---\nname: ${name}\ndescription: A skill called ${name}.\n---\n\nBody.\n`;
const FILES: Record<string, string> = { "skills/a/SKILL.md": md("a"), "skills/b/SKILL.md": md("b"), LICENSE: MIT, "skills/a/NOTICE": "notice a", "other/LICENSE": "not for us" };

function tree(files: Record<string, string> = FILES, extra: TreeEntry[] = []): SourceTree {
  const all: TreeEntry[] = [...Object.entries(files).map(([path, v]): TreeEntry => ({ path, kind: "file", size: Buffer.byteLength(v), id: "id:" + path })), ...extra];
  return {
    list: (p) => all.filter((e) => p === "." || e.path.startsWith(p + "/")),
    read: (entries) => entries.map((e) => Buffer.from(files[e.path]!)),
  };
}
const source = (): SkillLibrarySource => ({
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
});

const saved = { ...importStoreSettings };
const made: string[] = [];
let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "skilllicence-")));
  made.push(home);
});
afterEach(() => {
  Object.assign(importStoreSettings, saved);
  for (const d of made.splice(0)) {
    chmodAll(d);
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
const src = (commit = COMMIT, files = FILES) => ({ ...source(), ref: { approved: commit } }) as SkillLibrarySource & { ref: { approved: string } };
const lic = (t: SourceTree, prep: ReturnType<typeof prepareImport>) =>
  prepareLicenceEvidence(collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t));
const withLicence = (commit = COMMIT, files = FILES) => {
  const t = tree(files);
  const prep = prepareImport(src(commit), t);
  return { ...prep, licence: lic(t, prep) };
};
const oldForm = (commit = COMMIT) => prepareImport(src(commit), tree());
const dirOf = (commit = COMMIT) => join(home, "skill-quarantine", "lib", commit);
const sourceDir = () => join(home, "skill-quarantine", "lib");
const snapshot = (p: string, times = true): string[] => {
  const st = lstatSync(p);
  const t = times ? st.mtimeMs : 0;
  if (!st.isDirectory()) return [`${p} ${st.mode} ${t} ${readFileSync(p).toString("hex")}`];
  return [`${p} ${st.mode} ${t}`, ...readdirSync(p).sort().flatMap((n) => snapshot(join(p, n), times))];
};
const read = () => readStagedImport("lib", COMMIT, { home });
const lread = () => readStagedLicence("lib", COMMIT, { home });
const problem = (r: { state: string }) => {
  if (r.state !== "invalid") throw new Error("expected invalid, got " + r.state);
  return (r as { problem: string }).problem;
};

describe("publishImport with licence", () => {
  it("writes licence.json and licence/<path> byte for byte with private modes", () => {
    const p = withLicence();
    publishImport(p, { home });
    const d = dirOf();
    expect(readFileSync(join(d, "licence.json"), "utf8")).toBe(p.licence.recordText);
    expect(readFileSync(join(d, "licence", "LICENSE"), "utf8")).toBe(MIT);
    expect(readFileSync(join(d, "licence", "skills/a/NOTICE"), "utf8")).toBe("notice a");
    expect(existsSync(join(d, "licence", "other"))).toBe(false);
    expect(statSync(join(d, "licence.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(d, "licence")).mode & 0o777).toBe(0o700);
    expect(statSync(join(d, "licence", "skills")).mode & 0o777).toBe(0o700);
    expect(statSync(join(d, "licence", "LICENSE")).mode & 0o777).toBe(0o600);
  });

  it("keeps an empty licence folder when there is no evidence", () => {
    const files = { "skills/a/SKILL.md": md("a") };
    const t = tree(files);
    const prep = prepareImport(src(), t);
    publishImport({ ...prep, licence: lic(t, prep) }, { home });
    expect(readdirSync(join(dirOf(), "licence"))).toEqual([]);
    const r = lread();
    expect(r.state === "ok" && r.evidence.files).toEqual([]);
  });

  it("leaves import.json as it was", () => {
    const p = withLicence();
    publishImport(p, { home });
    expect(readFileSync(join(dirOf(), "import.json"), "utf8")).toBe(oldForm().recordText);
  });

  it("is unchanged the second time and does not touch the folder", () => {
    publishImport(withLicence(), { home });
    const before = snapshot(dirOf());
    expect(publishImport(withLicence(), { home }).state).toBe("unchanged");
    expect(snapshot(dirOf())).toEqual(before);
  });

  it("conflicts on other evidence for the same commit, and on a new form without evidence", () => {
    publishImport(withLicence(), { home });
    expect(() => publishImport(withLicence(COMMIT, { ...FILES, LICENSE: MIT + "\nextra" }), { home })).toThrow(/different import/);
    expect(() => publishImport(oldForm(), { home })).toThrow(/different import/);
  });

  it("refuses evidence of another commit", () => {
    const p = withLicence();
    const other = withLicence(COMMIT2).licence;
    expect(() => publishImport({ ...p, licence: other }, { home })).toThrow(SkillImportError);
  });

  it("stageImport stages the evidence too", () => {
    stageImport(src(), tree(), { home });
    expect(lread().state).toBe("ok");
  });
});

describe("replacing an import made before licence.json", () => {
  it("replaces the old form and leaves no .tmp- or .old- folder", () => {
    publishImport(oldForm(), { home });
    expect(lread().state).toBe("none");
    expect(publishImport(withLicence(), { home }).state).toBe("staged");
    expect(lread().state).toBe("ok");
    expect(readdirSync(sourceDir())).toEqual([COMMIT]);
  });

  it("puts the old import back when publication fails once", () => {
    publishImport(oldForm(), { home });
    const before = snapshot(dirOf(), false);
    let n = 0;
    importStoreSettings.rename = (a, b) => {
      if (n++ === 0) throw Object.assign(new Error("boom"), { code: "EIO" });
      renameSync(a, b);
    };
    expect(() => publishImport(withLicence(), { home })).toThrow("(EIO)");
    expect(snapshot(dirOf(), false)).toEqual(before);
    expect(read().state).toBe("ok");
    expect(readdirSync(sourceDir())).toEqual([COMMIT]);
  });

  it("keeps the backup when the rollback fails, and the next import restores it", () => {
    publishImport(oldForm(), { home });
    const before = snapshot(dirOf());
    importStoreSettings.rename = () => {
      throw Object.assign(new Error("boom"), { code: "EIO" });
    };
    expect(() => publishImport(withLicence(), { home })).toThrow(/\.old-a{40}/);
    expect(existsSync(dirOf())).toBe(false);
    const backup = join(sourceDir(), ".old-" + COMMIT);
    expect(snapshot(backup).map((s) => s.replace(backup, "X"))).toEqual(before.map((s) => s.replace(dirOf(), "X")));
    Object.assign(importStoreSettings, saved);
    publishImport(withLicence(COMMIT2), { home });
    const r = read();
    expect(r.state === "ok" && r.licence).toBeUndefined();
    expect(readdirSync(sourceDir()).sort()).toEqual([COMMIT, COMMIT2]);
  });

  it("restores a crashed replacement, removes the .tmp- folder, then stages the same commit", () => {
    publishImport(oldForm(), { home });
    renameSync(dirOf(), join(sourceDir(), ".old-" + COMMIT));
    mkdirSync(join(sourceDir(), ".tmp-" + "0123456789abcdef"), { mode: 0o700 });
    publishImport(withLicence(COMMIT2), { home });
    expect(readdirSync(sourceDir()).sort()).toEqual([COMMIT, COMMIT2]);
    expect(read().state).toBe("ok");
    expect(publishImport(withLicence(), { home }).state).toBe("staged");
    expect(lread().state).toBe("ok");
  });

  it("removes the backup after a crash that came after publication", () => {
    publishImport(withLicence(), { home });
    mkdirSync(join(sourceDir(), ".old-" + COMMIT), { mode: 0o700 });
    expect(publishImport(withLicence(), { home }).state).toBe("unchanged");
    expect(readdirSync(sourceDir())).toEqual([COMMIT]);
  });

  it("deletes neither folder when the import next to a backup is invalid", () => {
    publishImport(withLicence(), { home });
    mkdirSync(join(sourceDir(), ".old-" + COMMIT), { mode: 0o700 });
    writeFileSync(join(dirOf(), "licence", "LICENSE"), "changed", { mode: 0o600 });
    expect(() => publishImport(withLicence(COMMIT2), { home })).not.toThrow();
    expect(readdirSync(sourceDir()).sort()).toEqual([".old-" + COMMIT, COMMIT, COMMIT2]);
  });

  it("refuses when a backup is already in the way", () => {
    publishImport(oldForm(), { home });
    mkdirSync(join(sourceDir(), ".old-" + COMMIT), { mode: 0o700 });
    const before = snapshot(sourceDir(), false);
    expect(() => publishImport(withLicence(), { home })).toThrow(/in the way/);
    expect(snapshot(sourceDir(), false)).toEqual(before);
  });
});

describe("readStagedLicence", () => {
  const stageNew = () => publishImport(withLicence(), { home });
  const licenceDir = () => join(dirOf(), "licence");

  it("returns the evidence of the import", () => {
    stageNew();
    const r = lread();
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const rec = JSON.parse(readFileSync(join(dirOf(), "import.json"), "utf8"));
    expect(r.evidence.repositoryKey).toBe(rec.repositoryKey);
    expect(r.evidence.commit).toBe(rec.commit);
    expect(r.evidence.files.map((f) => f.path)).toEqual(["LICENSE", "skills/a/NOTICE"]);
    expect(Buffer.from(r.evidence.files[0]!.content!).toString()).toBe(MIT);
  });

  it("writes nothing", () => {
    stageNew();
    const before = snapshot(sourceDir());
    lread();
    read();
    expect(snapshot(sourceDir())).toEqual(before);
  });

  const tamper: [string, () => void][] = [
    ["changed byte", () => writeFileSync(join(licenceDir(), "LICENSE"), MIT.replace("MIT", "MIX"), { mode: 0o600 })],
    ["truncated file", () => writeFileSync(join(licenceDir(), "LICENSE"), "x", { mode: 0o600 })],
    ["deleted file", () => rmSync(join(licenceDir(), "LICENSE"))],
    ["extra file", () => writeFileSync(join(licenceDir(), "EXTRA"), "x", { mode: 0o600 })],
    ["extra folder", () => mkdirSync(join(licenceDir(), "extra"), { mode: 0o700 })],
    ["file as a link", () => (rmSync(join(licenceDir(), "LICENSE")), symlinkSync(join(dirOf(), "import.json"), join(licenceDir(), "LICENSE")))],
    ["licence folder as a link", () => {
      const copy = join(home, "copy");
      renameSync(licenceDir(), copy);
      symlinkSync(copy, licenceDir());
    }],
    ["missing licence folder", () => rmSync(licenceDir(), { recursive: true })],
    ["licence folder without licence.json", () => rmSync(join(dirOf(), "licence.json"))],
    ["edited licence.json", () => writeFileSync(join(dirOf(), "licence.json"), readFileSync(join(dirOf(), "licence.json"), "utf8").replace(COMMIT, COMMIT2), { mode: 0o600 })],
    ["re-indented licence.json", () => writeFileSync(join(dirOf(), "licence.json"), JSON.stringify(JSON.parse(readFileSync(join(dirOf(), "licence.json"), "utf8"))), { mode: 0o600 })],
    ["large licence.json", () => writeFileSync(join(dirOf(), "licence.json"), "x".repeat(LICENCE_RECORD_BYTES + 1), { mode: 0o600 })],
  ];
  it.each(tamper)("is invalid for a %s", (_n, f) => {
    stageNew();
    f();
    expect(problem(lread())).toBeTruthy();
    expect(problem(read())).toBeTruthy();
  });

  it.skipIf(isRoot)("is invalid for a file with mode 0644", () => {
    stageNew();
    chmodSync(join(licenceDir(), "LICENSE"), 0o644);
    expect(problem(lread())).toContain("wrong mode");
  });

  it("reads an old-form import and says to import again", () => {
    publishImport(oldForm(), { home });
    const r = read();
    expect(r.state === "ok" && r.licence).toBeUndefined();
    expect(r.state).toBe("ok");
    const l = lread();
    expect(l.state).toBe("none");
    expect(l.state === "none" && l.message).toContain('scf skills import lib" again');
  });

  it("says to import first when nothing is staged", () => {
    const l = lread();
    expect(l.state === "none" && l.message).toContain("first");
  });

  it("ignores a backup folder next to the import", () => {
    stageNew();
    mkdirSync(join(sourceDir(), ".old-" + COMMIT2), { mode: 0o700 });
    expect(lread().state).toBe("ok");
  });
});

describe("stored evidence gives the same verdict", () => {
  const SA = "Business Source License 1.1\n\nLicensed Work: Example\n";
  const cases: [string, Record<string, string>, string][] = [
    ["a root LICENSE only", { "skills/a/SKILL.md": md("a"), LICENSE: MIT }, "allowed"],
    ["a per-folder licence", { "skills/a/SKILL.md": md("a"), LICENSE: MIT, "skills/LICENSE": "Odd licence text" }, "ambiguous"],
    ["a licence inside the skill", { "skills/a/SKILL.md": md("a"), "skills/a/LICENSE": MIT }, "allowed"],
    ["a missing licence", { "skills/a/SKILL.md": md("a") }, "missing"],
    ["a source-available folder", { "skills/a/SKILL.md": md("a"), "skills/a/LICENSE": SA }, "rejected"],
  ];
  it.each(cases)("for %s", (_n, files, status) => {
    const t = tree(files);
    const prep = prepareImport(src(COMMIT, files), t);
    const fetched = collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, prep.record.skills.map((s) => s.root), t);
    publishImport({ ...prep, licence: prepareLicenceEvidence(fetched) }, { home });
    const stored = lread();
    if (stored.state !== "ok") throw new Error("expected ok");
    const hexed = (v: ReturnType<typeof evaluateLicence>) => ({ ...v, attribution: v.attribution.map((a) => ({ path: a.path, hex: Buffer.from(a.content).toString("hex") })) });
    for (const s of prep.record.skills) {
      const input = { root: s.root, allow: ["MIT"] };
      const a = evaluateLicence({ ...input, evidence: fetched });
      const b = evaluateLicence({ ...input, evidence: stored.evidence });
      expect(hexed(b)).toEqual(hexed(a));
      expect(a.status).toBe(status);
    }
  });

  it("gives ambiguous on both sides for a link, and never sees a:b/LICENSE", () => {
    const files = { "skills/a/SKILL.md": md("a"), "skills/a/LICENSE": MIT };
    const t = tree(files, [
      { path: "NOTICE", kind: "symlink", id: "x" },
      { path: "a:b/LICENSE", kind: "file", size: 1, id: "y" },
    ]);
    const prep = prepareImport(src(COMMIT, files), t);
    const fetched = collectLicenceEvidence({ repositoryKey: prep.record.repositoryKey, commit: prep.record.commit }, ["skills/a"], t);
    expect(fetched.files.map((f) => f.path)).toEqual(["NOTICE", "skills/a/LICENSE"]);
    publishImport({ ...prep, licence: prepareLicenceEvidence(fetched) }, { home });
    const stored = lread();
    expect(stored.state === "ok" && stored.evidence.files.map((f) => [f.path, f.problem])).toEqual([["NOTICE", "a symbolic link"], ["skills/a/LICENSE", undefined]]);
  });
});
