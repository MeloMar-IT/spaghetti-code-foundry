import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  IMPORT_DIGEST_HEADER, IMPORT_LIMITS, SkillImportError, boundReasons, byteCmp, importDigest, planImport, prepareImport,
  type TreeEntry,
} from "../src/skills/import-plan.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

const COMMIT = "a".repeat(40);
const TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
const md = (name: string, extra = "") => `---\nname: ${name}\ndescription: A skill called ${name}.\n${extra}---\n\nBody.\n`;

type Spec = string | Uint8Array | { kind: TreeEntry["kind"]; size?: number };
interface Tree {
  list: (p: string) => TreeEntry[];
  read: (e: readonly TreeEntry[]) => Uint8Array[];
  reads: string[][];
}
function tree(files: Record<string, Spec>, o: { extra?: TreeEntry[]; order?: (a: TreeEntry[]) => TreeEntry[] } = {}): Tree {
  const content = new Map<string, Uint8Array>();
  const all: TreeEntry[] = Object.entries(files).map(([path, v]) => {
    if (typeof v === "string" || v instanceof Uint8Array) {
      const b = typeof v === "string" ? Buffer.from(v) : v;
      content.set(path, b);
      return { path, kind: "file" as const, size: b.byteLength, id: "id:" + path };
    }
    return { path, kind: v.kind, ...(v.size === undefined ? {} : { size: v.size }), id: "id:" + path };
  });
  const reads: string[][] = [];
  return {
    reads,
    list: (p) => {
      const mine = all.filter((e) => p === "." || e.path === p || e.path.startsWith(p + "/"));
      return (o.order ?? ((a) => a))([...mine, ...(o.extra ?? [])]);
    },
    read: (entries) => {
      reads.push(entries.map((e) => e.path));
      return entries.map((e) => content.get(e.path) ?? new Uint8Array(e.size ?? 0));
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
const plan = (t: Tree, paths = ["skills"]) => planImport(paths, t.list);
const roots = (r: ReturnType<typeof planImport>) => r.skills.map((s) => s.root);
const reasonsOf = (r: ReturnType<typeof planImport>, root: string) => r.rejected.find((x) => x.root === root)?.reasons ?? [];
const good = { "skills/good/SKILL.md": md("good") };

describe("planImport: discovery", () => {
  it("plans nested files of every skill and skips .DS_Store", () => {
    const t = tree({
      "skills/a/SKILL.md": md("a"), "skills/a/references/a/b.md": "x", "skills/a/scripts/x.sh": "x", "skills/a/assets/i.png": "x", "skills/a/.DS_Store": "x",
      "skills/b/SKILL.md": md("b"),
    });
    const r = plan(t);
    expect(roots(r)).toEqual(["skills/a", "skills/b"]);
    expect(r.skills[0]!.files.map((f) => f.path)).toEqual(["skills/a/SKILL.md", "skills/a/assets/i.png", "skills/a/references/a/b.md", "skills/a/scripts/x.sh"]);
    expect(r.rejected).toEqual([]);
    expect(t.reads).toEqual([]);
  });
  it("a nested SKILL.md rejects the outer root only", () => {
    const r = plan(tree({ "skills/a/SKILL.md": md("a"), "skills/a/sub/SKILL.md": md("b"), ...good }));
    expect(roots(r)).toEqual(["skills/good"]);
    expect(reasonsOf(r, "skills/a")).toEqual(["sub/SKILL.md: a second SKILL.md inside the skill"]);
  });
  it("lists a declared path without SKILL.md as rejected", () => {
    const r = plan(tree({ "skills/x.txt": "x", "docs/SKILL.md": md("d") }), ["skills", "docs"]);
    expect(reasonsOf(r, "skills")).toEqual(["no SKILL.md below this path"]);
    expect(roots(r)).toEqual(["docs"]);
  });
  it("a SKILL.md that is a symlink makes no root", () => {
    expect(plan(tree({ "skills/a/SKILL.md": { kind: "symlink" } })).rejected[0]!.reasons).toEqual(["no SKILL.md below this path"]);
  });
  it("root \".\": a nested skill gives its own root", () => {
    expect(roots(plan(tree({ "x/SKILL.md": md("x") }), ["."]))).toEqual(["x"]);
  });
  it("root \".\": a top-level SKILL.md owns every file", () => {
    const files = { "SKILL.md": md("top"), "references/a.md": "a", "scripts/x.sh": "x" };
    const r = plan(tree(files), ["."]);
    expect(r.skills[0]!.root).toBe(".");
    expect(r.skills[0]!.files.map((f) => f.path)).toEqual(["SKILL.md", "references/a.md", "scripts/x.sh"]);
    const p = prepareImport(source({ paths: ["."] }), tree(files));
    expect([...p.files.keys()]).toEqual(["SKILL.md", "references/a.md", "scripts/x.sh"]);
    expect(p.record.skills[0]!.root).toBe(".");
  });
  it("root \".\": a second SKILL.md rejects the root", () => {
    const r = plan(tree({ "SKILL.md": md("top"), "sub/SKILL.md": md("s") }), ["."]);
    expect(r.skills).toEqual([]);
    expect(reasonsOf(r, ".")).toEqual(["sub/SKILL.md: a second SKILL.md inside the skill"]);
  });
});

describe("planImport: path rules", () => {
  const bad = (path: string, spec: Spec): [string, Spec] => [path, spec];
  it.each([
    bad("symlink", { kind: "symlink", size: 1 }),
    bad("submodule", { kind: "submodule" }),
    bad("other", { kind: "other", size: 1 }),
  ])("rejects a %s entry only", (_n, spec) => {
    const r = plan(tree({ "skills/bad/SKILL.md": md("bad"), "skills/bad/x.md": spec, ...good }));
    expect(roots(r)).toEqual(["skills/good"]);
    expect(r.rejected[0]!.root).toBe("skills/bad");
  });
  it.each(["a/../b.md", "a\\b.md", "a:b.md", ".GIT/config", "a‮b.md", "a\x07b.md"])("rejects the path %j only", (p) => {
    const r = plan(tree({ "skills/bad/SKILL.md": md("bad"), [`skills/bad/${p}`]: "x", ...good }));
    expect(roots(r)).toEqual(["skills/good"]);
    expect(r.rejected.map((x) => x.root)).toEqual(["skills/bad"]);
  });
  it("a leading / gives a rejected root and nothing throws", () => {
    const extra: TreeEntry[] = [{ path: "/skills/bad/SKILL.md", kind: "file", size: 5, id: "x" }];
    const r = plan(tree(good, { extra }));
    expect(roots(r)).toEqual(["skills/good"]);
    expect(r.rejected.map((x) => x.root)).toEqual(["/skills/bad"]);
  });
  it("a malformed ./SKILL.md does not swallow a valid sibling", () => {
    const extra: TreeEntry[] = [{ path: "./SKILL.md", kind: "file", size: 5, id: "x" }];
    const r = planImport(["."], tree(good, { extra }).list);
    expect(roots(r)).toEqual(["skills/good"]);
    expect(r.rejected.map((x) => x.root)).toEqual(["."]);
    expect(prepareImport(source({ paths: ["."] }), tree(good, { extra })).record.skills.map((s) => s.root)).toEqual(["skills/good"]);
  });
  it("an entry outside the listed path is a broken tree", () => {
    const extra: TreeEntry[] = [{ path: "other/x/SKILL.md", kind: "file", size: 5, id: "x" }];
    expect(() => plan(tree(good, { extra }))).toThrowError(expect.objectContaining({ code: "not-usable" }));
  });
});

describe("planImport: collisions inside one skill", () => {
  it.each([
    ["case of a file", { "skills/bad/Readme.md": "a", "skills/bad/README.md": "b" }],
    ["case of a folder", { "skills/bad/references/A/x.md": "a", "skills/bad/references/a/y.md": "b" }],
    ["unicode form", { "skills/bad/references/é/x.md": "a", "skills/bad/references/é/y.md": "b" }],
    ["file and folder", { "skills/bad/a": "a", "skills/bad/a/b.md": "b" }],
  ])("%s rejects that skill only", (_n, files) => {
    const r = plan(tree({ "skills/bad/SKILL.md": md("bad"), ...files, ...good }));
    expect(roots(r)).toEqual(["skills/good"]);
    expect(reasonsOf(r, "skills/bad")[0]).toContain("case-insensitive");
  });
  it("the same path twice is listed twice", () => {
    const extra: TreeEntry[] = [{ path: "skills/bad/SKILL.md", kind: "file", size: 5, id: "other" }];
    const r = plan(tree({ ...good, "skills/bad/SKILL.md": md("bad") }, { extra }));
    expect(roots(r)).toEqual(["skills/good"]);
    expect(reasonsOf(r, "skills/bad")).toEqual(["SKILL.md: is listed twice"]);
  });
});

describe("planImport: limits and reasons", () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`skills/bad/f${i}`, { kind: "file" as const, size: 1 }]));
  it.each([
    ["201 files", { "skills/bad/SKILL.md": md("bad"), ...many(200) }, "more than 200 files"],
    ["big SKILL.md", { "skills/bad/SKILL.md": { kind: "file", size: 65537 } }, "is larger than 65536 bytes"],
    ["big file", { "skills/bad/SKILL.md": md("bad"), "skills/bad/f": { kind: "file", size: 262145 } }, "is larger than 262144 bytes"],
    ["big total", { "skills/bad/SKILL.md": md("bad"), ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`skills/bad/f${i}`, { kind: "file", size: 262144 }])) }, "larger than 2097152 bytes in total"],
    ["long path", { "skills/bad/SKILL.md": md("bad"), ["skills/bad/" + "a".repeat(190)]: { kind: "file", size: 1 } }, "path is longer than 200 bytes"],
    ["deep path", { "skills/bad/SKILL.md": md("bad"), "skills/bad/a/b/c/d/e/f/g": { kind: "file", size: 1 } }, "path is deeper than 6 folders"],
    ["no size", { "skills/bad/SKILL.md": md("bad"), "skills/bad/f": { kind: "file" } }, "has no size"],
  ] as [string, Record<string, Spec>, string][])("%s rejects the skill without reading it", (_n, files, text) => {
    const t = tree({ ...files, ...good });
    const r = plan(t);
    expect(roots(r)).toEqual(["skills/good"]);
    expect(reasonsOf(r, "skills/bad").join("\n")).toContain(text);
    prepareImport(source(), t);
    expect(t.reads.flat().some((p) => p.startsWith("skills/bad/"))).toBe(false);
  });
  it("201 files and other bad files show the count first", () => {
    const r = plan(tree({ "skills/bad/SKILL.md": md("bad"), ...many(200), "skills/bad/s": { kind: "symlink" } }));
    expect(reasonsOf(r, "skills/bad")[0]).toBe("more than 200 files");
  });
  it("10 bad files give 3 reasons plus a count, the first in byte order", () => {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`skills/bad/l${9 - i}`, { kind: "symlink" as const }]));
    const r = plan(tree({ "skills/bad/SKILL.md": md("bad"), ...files }));
    expect(reasonsOf(r, "skills/bad")).toEqual(["l0: a symbolic link", "l1: a symbolic link", "l2: a symbolic link", "and 7 more"]);
  });
  it("boundReasons cuts long reasons", () => {
    const out = boundReasons(["x".repeat(300)]);
    expect(out[0]!.length).toBe(IMPORT_LIMITS.reasonChars);
  });
  it("a credential-like path is hidden", () => {
    const r = plan(tree({ "skills/bad/SKILL.md": md("bad"), [`skills/bad/${TOKEN}/x.md`]: { kind: "symlink" } }));
    const text = reasonsOf(r, "skills/bad").join("\n");
    expect(text).toContain("(hidden)");
    expect(text).not.toContain(TOKEN);
  });
  it("501 roots, 20001 entries", () => {
    const files = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`skills/s${i}/SKILL.md`, { kind: "file" as const, size: 1 }]));
    expect(() => plan(tree(files))).toThrowError(expect.objectContaining({ code: "too-many-skills" }));
    const e = (i: number): TreeEntry => ({ path: `skills/a/f${i}`, kind: "file", size: 1, id: String(i) });
    expect(() => planImport(["skills"], () => Array.from({ length: 20001 }, (_, i) => e(i)))).toThrowError(expect.objectContaining({ code: "too-many-entries" }));
  });
  it("planned bytes over the limit give too-large without a read", () => {
    const files: Record<string, Spec> = {};
    for (let i = 0; i < 42; i++) {
      files[`skills/s${i}/SKILL.md`] = { kind: "file", size: 65536 };
      for (let j = 0; j < 6; j++) files[`skills/s${i}/f${j}`] = { kind: "file", size: 262144 };
    }
    const t = tree(files);
    expect(() => prepareImport(source(), t)).toThrowError(expect.objectContaining({ code: "too-large" }));
    expect(t.reads).toEqual([]);
  });
});

describe("listing order", () => {
  const files: Record<string, Spec> = {
    ...good,
    "skills/sym/SKILL.md": md("sym"),
    "skills/case/SKILL.md": md("case"), "skills/case/Readme.md": "a", "skills/case/README.md": "b",
    "skills/Foo/SKILL.md": md("foo-a"), "skills/foo/SKILL.md": md("foo-b"),
    ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`skills/sym/x${i}`, { kind: (["symlink", "submodule", "other"] as const)[i % 3]!, size: 1 }])),
  };
  const extra: TreeEntry[] = [{ path: "skills/good/dup", kind: "file", size: 1, id: "1" }, { path: "skills/good/dup", kind: "symlink", id: "2" }];
  const orders: [string, (a: TreeEntry[]) => TreeEntry[]][] = [
    ["same", (a) => a],
    ["reverse", (a) => [...a].reverse()],
    ["rotate", (a) => [...a.slice(3), ...a.slice(0, 3)]],
    ["odd-even", (a) => [...a.filter((_, i) => i % 2), ...a.filter((_, i) => !(i % 2))]],
  ];
  it("gives the same plan and the same record text for every order", () => {
    const base = tree(files, { extra });
    const want = plan(base);
    const wantText = prepareImport(source(), base).recordText;
    for (const [, order] of orders) {
      const t = tree(files, { extra, order });
      expect(plan(t)).toEqual(want);
      expect(prepareImport(source(), t).recordText).toBe(wantText);
    }
    expect(roots(want)).toContain("skills/Foo");
  });
  it("the same skill of a colliding pair is rejected", () => {
    for (const [, order] of orders) {
      const p = prepareImport(source(), tree(files, { extra, order }));
      expect(p.record.skills.map((s) => s.root)).toContain("skills/Foo");
      expect(p.record.rejected.map((s) => s.root)).toContain("skills/foo");
    }
  });
});

describe("byte order", () => {
  const A = "～";
  const B = "\u{1f600}";
  it("sorts by UTF-8 bytes", () => {
    expect(byteCmp(A, B)).toBeLessThan(0);
    const p = prepareImport(source(), tree({ [`skills/${B}/SKILL.md`]: md("b"), [`skills/${A}/SKILL.md`]: md("a") }));
    expect(p.record.skills.map((s) => s.root)).toEqual([`skills/${A}`, `skills/${B}`]);
    const r = plan(tree({ "skills/s/SKILL.md": md("s"), [`skills/s/${B}`]: "x", [`skills/s/${A}`]: "x" }));
    expect(r.skills[0]!.files.map((f) => f.path).slice(-2)).toEqual([`skills/s/${A}`, `skills/s/${B}`]);
  });
  it("importDigest hashes the header and the lines in byte order", () => {
    const pair = [{ root: B, digest: "d2" }, { root: A, digest: "d1" }];
    const h = createHash("sha256");
    h.update(IMPORT_DIGEST_HEADER + `${A}\td1\n${B}\td2\n`);
    const want = "sha256:" + h.digest("hex");
    expect(importDigest(pair)).toBe(want);
    expect(importDigest([...pair].reverse())).toBe(want);
  });
});

describe("prepareImport: collisions between skills", () => {
  const read = (t: Tree, root: string) => t.reads.flat().some((p) => p.startsWith(root + "/"));
  it.each([
    ["case", "skills/Foo", "skills/foo"],
    ["unicode form", "skills/é", "skills/é"],
  ])("%s: the first is staged, the second never read", (_n, a, b) => {
    const t = tree({ [`${a}/SKILL.md`]: md("one"), [`${b}/SKILL.md`]: md("two"), ...good });
    const p = prepareImport(source(), t);
    expect(p.record.skills.map((s) => s.root)).toEqual([a, "skills/good"].sort(byteCmp));
    expect(p.record.rejected[0]!.root).toBe(b);
    expect(read(t, b)).toBe(false);
  });
  it("a shared folder collides", () => {
    const t = tree({ "skills/Foo/one/SKILL.md": md("one"), "skills/foo/two/SKILL.md": md("two"), ...good });
    const p = prepareImport(source(), t);
    expect(p.record.skills.map((s) => s.root)).toEqual(["skills/Foo/one", "skills/good"]);
    expect(p.record.rejected.map((s) => s.root)).toEqual(["skills/foo/two"]);
  });
  it("two declared paths that differ in case collide", () => {
    const t = tree({ "Skills/a/SKILL.md": md("a"), "skills/a/SKILL.md": md("b") });
    const p = prepareImport(source({ paths: ["Skills", "skills"] }), t);
    expect(p.record.skills.map((s) => s.root)).toEqual(["Skills/a"]);
    expect(p.record.rejected.map((s) => s.root)).toEqual(["skills/a"]);
  });
  it("a file against a folder collides", () => {
    const t = tree({ "skills/x/A/SKILL.md": md("one"), "skills/x/A/notes": "n", "skills/x/a/notes/SKILL.md": md("two") });
    const p = prepareImport(source(), t);
    expect(p.record.skills.map((s) => s.root)).toEqual(["skills/x/A"]);
    expect(p.record.rejected.map((s) => s.root)).toEqual(["skills/x/a/notes"]);
  });
  it("a rejected skill takes no names", () => {
    const t = tree({ "skills/Foo/SKILL.md": "no frontmatter", "skills/foo/SKILL.md": md("foo"), ...good });
    const p = prepareImport(source(), t);
    expect(p.record.skills.map((s) => s.root)).toEqual(["skills/foo", "skills/good"]);
    expect(p.record.rejected.map((s) => s.root)).toEqual(["skills/Foo"]);
  });
});

describe("prepareImport: refusals", () => {
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      expect(e).toBeInstanceOf(SkillImportError);
      return (e as SkillImportError).code;
    }
    return "none";
  };
  const t = () => tree(good);
  it("refuses a source that cannot be imported", () => {
    expect(code(() => prepareImport(source({ status: "disabled" }), t()))).toBe("not-usable");
    expect(code(() => prepareImport(source({ ref: {} }), t()))).toBe("not-usable");
    expect(code(() => prepareImport(source({ ref: { approved: "main" } }), t()))).toBe("not-usable");
    expect(code(() => prepareImport(source({ id: "Bad Id" }), t()))).toBe("not-usable");
    expect(code(() => prepareImport(source({ adapter: "other" as never }), t()))).toBe("not-usable");
  });
  it("rejects content that does not match the listing", () => {
    const short = { read: () => [new Uint8Array(1)], list: t().list };
    expect(code(() => prepareImport(source(), short))).toBe("nothing-staged");
    const none = { read: () => [], list: t().list };
    expect(code(() => prepareImport(source(), none))).toBe("nothing-staged");
  });
  it.each([
    ["not UTF-8", new Uint8Array([0x2d, 0x2d, 0x2d, 0xff, 0xfe]), "SKILL.md: is not UTF-8"],
    ["no frontmatter", "hello", "SKILL.md: has no valid frontmatter"],
    ["bad name", md("Bad Name"), "SKILL.md: name must be a lower-case slug of 1–64 characters"],
    ["empty description", "---\nname: bad\ndescription: \"\"\n---\n", "SKILL.md: description must be 1 to 1024 characters"],
    ["long description", `---\nname: bad\ndescription: ${"x".repeat(1025)}\n---\n`, "SKILL.md: description must be 1 to 1024 characters"],
    ["name 123", "---\nname: 123\ndescription: d\n---\n", "SKILL.md: name must be a lower-case slug of 1–64 characters"],
    ["name true", "---\nname: true\ndescription: d\n---\n", "SKILL.md: name must be a lower-case slug of 1–64 characters"],
    ["name null", "---\nname: null\ndescription: d\n---\n", "SKILL.md: name must be a lower-case slug of 1–64 characters"],
    ["name empty", "---\nname:\ndescription: d\n---\n", "SKILL.md: name must be a lower-case slug of 1–64 characters"],
    ["name list", "---\nname: [a]\ndescription: d\n---\n", "SKILL.md: name must be a lower-case slug of 1–64 characters"],
    ["no name", "---\ndescription: d\n---\n", "SKILL.md: name must be a lower-case slug of 1–64 characters"],
    ["description 5", "---\nname: bad\ndescription: 5\n---\n", "SKILL.md: description must be 1 to 1024 characters"],
    ["description true", "---\nname: bad\ndescription: true\n---\n", "SKILL.md: description must be 1 to 1024 characters"],
    ["no description", "---\nname: bad\n---\n", "SKILL.md: description must be 1 to 1024 characters"],
  ] as [string, Spec, string][])("rejects only the skill with %s", (_n, content, reason) => {
    const p = prepareImport(source(), tree({ "skills/bad/SKILL.md": content, ...good }));
    expect(p.record.skills.map((s) => s.root)).toEqual(["skills/good"]);
    expect(p.record.rejected).toEqual([{ root: "skills/bad", reasons: [reason] }]);
  });
  it("accepts unknown keys and a quoted numeric name", () => {
    const p = prepareImport(source(), tree({ "skills/a/SKILL.md": md("a", "extra: 1\n"), "skills/b/SKILL.md": '---\nname: "123"\ndescription: d\n---\n' }));
    expect(p.record.skills.map((s) => s.name)).toEqual(["a", "123"]);
  });
  it("gives nothing-staged with the rejected list, and too-large for a small record limit", () => {
    try {
      prepareImport(source(), tree({ "skills/bad/SKILL.md": "x" }));
      expect.unreachable();
    } catch (e) {
      expect((e as SkillImportError).code).toBe("nothing-staged");
      expect((e as SkillImportError).rejected).toHaveLength(1);
    }
    expect(code(() => prepareImport(source(), t(), { limits: { recordBytes: 200 } }))).toBe("too-large");
  });
  it.each([
    ["an alias", `---\nname: *${TOKEN}\ndescription: d\n---\n`],
    ["a broken mapping", "---\nname: [a\nbell: \x07\n---\n"],
  ])("never repeats frontmatter text: %s", (_n, content) => {
    const p = prepareImport(source(), tree({ "skills/bad/SKILL.md": content, ...good }));
    expect(p.record.rejected).toEqual([{ root: "skills/bad", reasons: ["SKILL.md: has no valid frontmatter"] }]);
    expect(p.recordText).not.toContain(TOKEN);
    expect(p.recordText).not.toContain("\x07");
  });
});

describe("prepareImport: output", () => {
  const files = { "skills/a/SKILL.md": md("a"), "skills/a/references/x.md": "xyz", "skills/b/SKILL.md": md("b") };
  it("is the same every time and has the specified shape", () => {
    const one = prepareImport(source(), tree(files));
    const two = prepareImport(source(), tree(files));
    expect(two.recordText).toBe(one.recordText);
    expect(two.record.digest).toBe(one.record.digest);
    expect(Object.keys(one.record)).toEqual(["schema", "source", "repository", "repositoryKey", "commit", "paths", "adapter", "digest", "skills", "rejected"]);
    expect(one.record.skills[0]).toMatchObject({ root: "skills/a", name: "a", files: 2, bytes: md("a").length + 3 });
    expect(Object.keys(one.record.skills[0]!)).toEqual(["root", "name", "digest", "files", "bytes"]);
    expect(one.recordText.endsWith("\n")).toBe(true);
    expect(one.recordText).not.toMatch(/"(at|time|date|created)\w*"/i);
    expect(one.record.digest).toBe(importDigest(one.record.skills));
    expect([...one.files.keys()]).toEqual(["skills/a/SKILL.md", "skills/a/references/x.md", "skills/b/SKILL.md"].sort(byteCmp));
  });
});
