import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SKILL_RELATIONS, buildSkillIdentity, relateSkills, skillFingerprint, upstreamIdentity,
  type SkillIdentity, type SkillRelation,
} from "../src/skills/identity.js";
import { normalizeSkill, type NormalizeOrigin } from "../src/skills/normalize.js";
import { skillDigest } from "../src/skills/package.js";

type F = { path: string; content: Uint8Array };
const COMMIT = "a".repeat(40);
const ORIGIN: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: COMMIT };
const md = (extra = "", body = "\nWrite notes.\n") => `---\nname: notes\ndescription: Keeps notes.\n${extra}---\n${body}`;
const f = (path: string, text: string | Uint8Array): F => ({ path, content: typeof text === "string" ? Buffer.from(text) : text });
const fp = (files: F[]) => skillFingerprint(files);
const crlf = (s: string) => s.replace(/\n/g, "\r\n");
const same = (a: F[], b: F[]) => expect(fp(a)).toBe(fp(b));
const differ = (a: F[], b: F[]) => expect(fp(a)).not.toBe(fp(b));

function readDir(dir: string, base = ""): F[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const full = join(dir, n);
    const rel = base ? `${base}/${n}` : n;
    return statSync(full).isDirectory() ? readDir(full, rel) : [{ path: rel, content: readFileSync(full) }];
  });
}
const PINNED = "sha256:11f4462f66c97102d214e6f28532cdeb4d63e9886f0a5fd3ba6188a01be599ad";
const FIX ="tests/fixtures/skill-identity";
const original = () => readDir(join(FIX, "original"));
const overlay = (base: F[], variant: F[]): F[] => [...base.filter((b) => !variant.some((v) => v.path === b.path)), ...variant];
const withVariant = (name: string) => overlay(original(), readDir(join(FIX, name)));
const text = (files: F[], path: string) => Buffer.from(files.find((x) => x.path === path)!.content).toString();
const replace = (files: F[], path: string, content: string | Uint8Array) => overlay(files, [f(path, content)]);

function identity(files: F[], origin: Partial<NormalizeOrigin> = {}, root = "skills/notes"): SkillIdentity {
  const r = normalizeSkill({ ...ORIGIN, ...origin }, { root, files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill.identity;
}

describe("skillFingerprint: equal", () => {
  const base = [f("SKILL.md", md()), f("references/a.md", "a\nb\n"), f("NOTES.txt", "n\nm\n"), f("scripts/run.sh", "echo\n")];
  it("ignores file order and has the digest shape", () => {
    same(base, [...base].reverse());
    expect(fp(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("pins one value", () => {
    expect(fp([f("SKILL.md", "---\nname: a\n---\nBody\n"), f("x.bin", new Uint8Array([1, 2, 3]))])).toBe(PINNED);
  });
  it("ignores CRLF and a BOM in documents", () => {
    for (const p of ["SKILL.md", "references/a.md", "NOTES.txt"]) {
      const t = text(base, p);
      same(base, replace(base, p, crlf(t)));
      same(base, replace(base, p, "﻿" + t));
    }
  });
  it("ignores frontmatter spelling", () => {
    const a = [f("SKILL.md", md("license: MIT\nversion: 1.0.0\n"))];
    same(a, [f("SKILL.md", `---\n# c\nversion: 1.0.0\nlicense: "MIT"\ndescription: Keeps notes.\nname: notes\n---\n\nWrite notes.\n`)]);
  });
  it("ignores NFD paths, skill.yaml and .DS_Store", () => {
    same([f("references/café.md", "x")], [f("references/café.md", "x")]);
    same(base, [...base, f("skill.yaml", "a: 1\n")]);
    same([...base, f("skill.yaml", "a: 1\n")], [...base, f("skill.yaml", "b: 2\n")]);
    same(base, [...base, f(".DS_Store", "x"), f("references/.DS_Store", "y")]);
  });
});

describe("skillFingerprint: different", () => {
  const base = [
    f("SKILL.md", md("allowed-tools: Read\n")), f("references/guide.md", "guide\n"), f("scripts/run.sh", "echo one\n"),
    f("assets/logo.bin", new Uint8Array([1, 2, 3])), f("assets/a.txt", "a\nb\n"), f("run.sh", "echo\nx\n"), f("evals/run.sh", "echo\nx\n"),
    f("LICENSE", "MIT\nx\n"), f("references/data.json", "{\n}\n"), f("scripts/notes.md", "a\nb\n"), f("assets/readme.txt", "a\nb\n"),
    f("references/A.MD", "a\nb\n"), f("references/skill.yaml", "a: 1\n"),
  ];
  it("sees content changes", () => {
    differ(base, replace(base, "SKILL.md", md("allowed-tools: Read\n", "\nWrite note.\n")));
    differ(base, replace(base, "SKILL.md", md("allowed-tools: Bash\n")));
    differ(base, replace(base, "SKILL.md", md("allowed-tools: Read\n").replace("Keeps notes", "Keeps more")));
    differ(base, replace(base, "scripts/run.sh", "echo two\n"));
    differ(base, replace(base, "references/guide.md", "guidf\n"));
    differ(base, replace(base, "assets/logo.bin", new Uint8Array([1, 2, 4])));
    differ(base, replace(base, "references/skill.yaml", "a: 2\n"));
  });
  it("sees added, removed, renamed and re-cased files", () => {
    differ(base, [...base, f("extra.md", "x")]);
    differ(base, base.slice(1));
    differ(base, base.map((x) => (x.path === "references/guide.md" ? { ...x, path: "references/guide2.md" } : x)));
    differ(base, base.map((x) => (x.path === "references/guide.md" ? { ...x, path: "references/Guide.md" } : x)));
    differ([f("references/x.md", "x")], [f("scripts/x.md", "x")]);
  });
  it("sees body whitespace", () => {
    const a = [f("SKILL.md", md("", "\nrun this\n"))];
    differ(a, [f("SKILL.md", md("", "\n    run this\n"))]);
    differ(a, [f("SKILL.md", md("", "\nrun this\n\n"))]);
    differ(a, [f("SKILL.md", md("", "\n\nrun this\n"))]);
    differ([f("references/a.md", "a\n")], [f("references/a.md", "a \n")]);
  });
  it("keeps line endings and a BOM in non-documents", () => {
    for (const p of ["scripts/run.sh", "assets/a.txt", "run.sh", "evals/run.sh", "LICENSE", "references/data.json", "scripts/notes.md", "assets/readme.txt", "references/A.MD"]) {
      const t = text(base, p);
      differ(base, replace(base, p, crlf(t)));
      differ(base, replace(base, p, "﻿" + t));
    }
  });
});

describe("skillFingerprint: edge cases", () => {
  it("keeps a parsed and a fallback SKILL.md apart", () => {
    differ([f("SKILL.md", "---\nname: notes\ndescription: x\n---\nBody")], [f("SKILL.md", '{"description":"x","name":"notes"}\nBody')]);
  });
  it("does not throw on broken SKILL.md", () => {
    const valid = [f("SKILL.md", md())];
    const broken = ["no frontmatter\n", "---\nname: a\n", "---\na: &x [1]\nb: *x\n---\nx", Buffer.from([0xff, 0xfe, 0x41])];
    for (const b of broken) {
      const files = [f("SKILL.md", b)];
      expect(fp(files)).toBe(fp(files));
      differ(files, valid);
    }
    same([f("SKILL.md", "plain\nbody\n")], [f("SKILL.md", "plain\r\nbody\r\n")]);
  });
  it("hashes a file with a NUL byte raw", () => {
    differ([f("references/a.md", "a\0\nb\n")], [f("references/a.md", "a\0\r\nb\r\n")]);
    differ([f("SKILL.md", md("", "\nBody\0\n"))], [f("SKILL.md", crlf(md("", "\nBody\0\n")))]);
  });
  it("handles nothing and empty files", () => {
    expect(fp([])).toMatch(/^sha256:/);
    expect(fp([f("a.md", "")])).toMatch(/^sha256:/);
  });
  it("frames path and content", () => {
    differ([f("a", "bc")], [f("ab", "c")]);
  });
  it("differs from skillDigest", () => {
    const files = [f("a.md", "x")];
    expect(fp(files)).not.toBe(skillDigest(files));
  });
});

describe("identity and relation", () => {
  const files = [f("SKILL.md", md())];
  const id = (over: Partial<SkillIdentity> = {}): SkillIdentity => ({ ...buildSkillIdentity({ id: "lib/a", source: "lib", repositoryKey: "r/a", name: "notes", version: "1.0.0", versionDeclared: true, digest: "sha256:" + "0".repeat(64), files }), ...over });
  it("builds", () => {
    expect(upstreamIdentity("github.com/example/skills", "notes")).toBe("github.com/example/skills#notes");
    const i = id();
    expect(i).toMatchObject({ schema: 1, id: "lib/a", source: "lib", repositoryKey: "r/a", upstream: "r/a#notes", name: "notes", version: "1.0.0", versionDeclared: true, digest: "sha256:" + "0".repeat(64), fingerprint: fp(files) });
  });
  it("relates, in both orders", () => {
    const other = "sha256:" + "1".repeat(64);
    const cases: [SkillIdentity, SkillIdentity, SkillRelation][] = [
      [id(), id({ id: "lib/b" }), "same-artifact"],
      [id(), id({ upstream: "r/b#notes" }), "same-content"],
      [id(), id({ version: "2.0.0" }), "same-content"],
      [id(), id({ fingerprint: other }), "version-conflict"],
      [id(), id({ fingerprint: other, version: "2.0.0" }), "other-version"],
      [id(), id({ fingerprint: other, upstream: "r/b#notes" }), "distinct"],
    ];
    for (const [a, b, want] of cases) {
      expect(relateSkills(a, b)).toBe(want);
      expect(relateSkills(b, a)).toBe(want);
    }
    expect(new Set(cases.map((c) => c[2]))).toEqual(new Set(SKILL_RELATIONS));
  });
});

describe("fixtures", () => {
  const B = { source: "other", repository: "https://github.com/mirror/skills", repositoryKey: "github.com/mirror/skills", commit: "b".repeat(40) };
  it("matches a mirror", () => {
    const a = identity(original());
    const b = identity(withVariant("mirror"), B);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(b.id).not.toBe(a.id);
    expect(b.upstream).not.toBe(a.upstream);
    expect(b.digest).not.toBe(a.digest);
    expect(relateSkills(a, b)).toBe("same-content");
  });
  it("matches a mirror with CRLF documents, not CRLF scripts", () => {
    const o = original();
    const docs = replace(replace(o, "SKILL.md", crlf(text(o, "SKILL.md"))), "references/guide.md", crlf(text(o, "references/guide.md")));
    same(o, docs);
    differ(o, replace(docs, "scripts/run.sh", crlf(text(o, "scripts/run.sh"))));
  });
  it("relates one repository through two source records", () => {
    const a = identity(original());
    const b = identity(original(), { source: "second" });
    expect(b.upstream).toBe(a.upstream);
    expect(b.id).not.toBe(a.id);
    expect(relateSkills(a, b)).toBe("same-artifact");
  });
  it("relates forks", () => {
    const a = identity(original());
    expect(relateSkills(a, identity(original(), B))).toBe("same-content");
    const changed = identity(withVariant("fork-changed"), B);
    expect(changed.fingerprint).not.toBe(a.fingerprint);
    expect(relateSkills(a, changed)).toBe("distinct");
  });
  it("ignores a renamed folder", () => {
    const a = identity(original());
    const b = identity(original(), {}, "tools/notes-renamed");
    expect(b.id).toBe(a.id);
    expect(b.fingerprint).toBe(a.fingerprint);
    expect(relateSkills(a, b)).toBe("same-artifact");
  });
  it("sees new content with a new version", () => {
    const o = original();
    const next = replace(replace(o, "SKILL.md", text(o, "SKILL.md").replace("1.2.0", "1.3.0")), "references/guide.md", "Other guide\n");
    expect(relateSkills(identity(o), identity(next))).toBe("other-version");
  });
  it("sees a reused version", () => {
    const a = identity(original());
    const b = identity(withVariant("reused-version"));
    expect(b.version).toBe(a.version);
    expect(relateSkills(a, b)).toBe("version-conflict");
  });
  it("does not depend on provenance", () => {
    const a = identity(original());
    expect(identity(original(), { commit: "c".repeat(40) }).fingerprint).toBe(a.fingerprint);
    expect(identity(original(), { source: "x" }).fingerprint).toBe(a.fingerprint);
  });
});
