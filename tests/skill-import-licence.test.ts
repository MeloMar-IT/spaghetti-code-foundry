import { describe, expect, it } from "vitest";
import { evidenceFromRecord, LICENCE_RECORD_BYTES, parseLicenceRecord, prepareLicenceEvidence } from "../src/skills/import-licence.js";
import { SkillImportError } from "../src/skills/import-plan.js";
import type { LicenceEvidence, LicenceEvidenceFile } from "../src/skills/licence.js";
import { LICENCE_LIMITS } from "../src/skills/licence-rules.js";

const COMMIT = "a".repeat(40);
const KEY = "github.com/example/skills";
const file = (path: string, text = "text", over: Partial<LicenceEvidenceFile> = {}): LicenceEvidenceFile => ({
  path,
  dir: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".",
  kind: /notice/i.test(path.slice(path.lastIndexOf("/") + 1)) ? "notice" : "licence",
  content: Buffer.from(text),
  ...over,
});
const ev = (files: LicenceEvidenceFile[]): LicenceEvidence => ({ repositoryKey: KEY, commit: COMMIT, files });
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return (e as SkillImportError).code;
  }
  return undefined;
};
const hex = (e: LicenceEvidence) => e.files.map((f) => ({ ...f, content: f.content ? Buffer.from(f.content).toString("hex") : undefined }));

describe("prepareLicenceEvidence", () => {
  it("sorts entries, records size and digest, and parses back", () => {
    const p = prepareLicenceEvidence(ev([file("z/LICENSE", "zz"), file("LICENSE", "abc"), file("NOTICE", "n")]));
    expect(p.record.files.map((f) => f.path)).toEqual(["LICENSE", "NOTICE", "z/LICENSE"]);
    expect(p.record.files[0]).toEqual({ path: "LICENSE", kind: "licence", bytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect(p.files.get("z/LICENSE")).toEqual(Buffer.from("zz"));
    const parsed = parseLicenceRecord(p.recordText);
    expect("record" in parsed && parsed.record).toEqual(p.record);
  });

  it("keeps a problem and stores no bytes", () => {
    const p = prepareLicenceEvidence(ev([file("LICENSE", "", { content: undefined, problem: "a symbolic link" })]));
    expect(p.record.files).toEqual([{ path: "LICENSE", kind: "licence", problem: "a symbolic link" }]);
    expect(p.files.size).toBe(0);
  });

  it.each(["folder/a:b/LICENSE", ".git/LICENSE", "x/.GIT/NOTICE", "d/" + "x".repeat(200) + "/LICENSE"])("does not store %s", (path) => {
    const p = prepareLicenceEvidence(ev([file(path)]));
    expect(p.record.files[0]!.problem).toBe("path cannot be stored");
    expect(p.files.size).toBe(0);
  });

  it.each(["a:b/LICENSE", "a/../LICENSE", "a/LIC\u0007ENSE"])("refuses %s", (path) => {
    expect(code(() => prepareLicenceEvidence(ev([file(path)])))).toBe("not-usable");
  });

  it("refuses a bad commit", () => {
    expect(code(() => prepareLicenceEvidence({ ...ev([]), commit: "main" }))).toBe("not-usable");
  });

  it("marks a case collision", () => {
    const p = prepareLicenceEvidence(ev([file("d/LICENSE"), file("d/license")]));
    expect(p.record.files.map((f) => f.problem)).toEqual([undefined, "collides with another path on a case-insensitive disk"]);
    expect([...p.files.keys()]).toEqual(["d/LICENSE"]);
  });

  it("lists a duplicate path once", () => {
    const p = prepareLicenceEvidence(ev([file("LICENSE"), file("LICENSE")]));
    expect(p.record.files).toEqual([{ path: "LICENSE", kind: "licence", problem: "is listed twice" }]);
  });

  it("holds the limits", () => {
    const many = Array.from({ length: LICENCE_LIMITS.files + 1 }, (_, i) => file(`d${i}/LICENSE`));
    expect(code(() => prepareLicenceEvidence(ev(many)))).toBe("too-many-entries");
    const big = "x".repeat(LICENCE_LIMITS.fileBytes);
    const over = Array.from({ length: 17 }, (_, i) => file(`d${i}/LICENSE`, big));
    expect(code(() => prepareLicenceEvidence(ev(over)))).toBe("too-large");
    expect(prepareLicenceEvidence(ev([file("LICENSE", big + "x")])).record.files[0]!.problem).toContain("is larger than");
    expect(LICENCE_RECORD_BYTES).toBeGreaterThan(0);
  });
});

describe("parseLicenceRecord", () => {
  const good = () => prepareLicenceEvidence(ev([file("LICENSE", "abc"), file("a/NOTICE", "n")]));
  const edit = (f: (r: any) => void, indent = 2) => {
    const r = JSON.parse(good().recordText);
    f(r);
    return JSON.stringify(r, null, indent) + "\n";
  };
  const problem = (t: string) => ("problem" in parseLicenceRecord(t) ? (parseLicenceRecord(t) as { problem: string }).problem : undefined);

  it("accepts what scf writes", () => expect("record" in parseLicenceRecord(good().recordText)).toBe(true));

  it.each<[string, string]>([
    ["not JSON", "{"],
    ["schema 2", edit((r) => (r.schema = 2))],
    ["bad commit", edit((r) => (r.commit = "main"))],
    ["unsorted", edit((r) => r.files.reverse())],
    ["duplicate", edit((r) => r.files.push({ ...r.files[1] }))],
    ["wrong kind", edit((r) => (r.files[0].kind = "notice"))],
    ["sha256 and problem", edit((r) => (r.files[0].problem = "x"))],
    ["neither", edit((r) => delete r.files[0].sha256)],
    ["bytes over limit", edit((r) => (r.files[0].bytes = LICENCE_LIMITS.fileBytes + 1))],
    ["stored path with a colon", edit((r) => (r.files = [{ path: "f/a:b/LICENSE", kind: "licence", bytes: 1, sha256: "0".repeat(64) }]))],
    ["drive-like path", edit((r) => (r.files = [{ path: "a:b/LICENSE", kind: "licence", problem: "x" }]))],
    ["re-indented", edit(() => undefined, 4)],
    ["extra key", edit((r) => (r.extra = 1))],
  ])("refuses %s", (_n, text) => expect(problem(text)).toMatch(/^licence\.json/));

  it("refuses a total over the limit", () => {
    const t = edit((r) => {
      r.files = Array.from({ length: 17 }, (_, i) => ({ path: `d${String(i).padStart(2, "0")}/LICENSE`, kind: "licence", bytes: LICENCE_LIMITS.fileBytes, sha256: "0".repeat(64) }));
    });
    expect(problem(t)).toContain("more bytes");
  });
});

describe("evidenceFromRecord", () => {
  it("rebuilds the collected evidence", () => {
    const e = ev([file("LICENSE", "abc"), file("a/NOTICE", "n"), file("b/LICENSE", "", { content: undefined, problem: "a symbolic link" })]);
    const p = prepareLicenceEvidence(e);
    const back = evidenceFromRecord(p.record, p.files);
    expect(hex(back)).toEqual(hex({ ...e, files: [...e.files].sort((a, b) => (a.path < b.path ? -1 : 1)) }));
  });
});
