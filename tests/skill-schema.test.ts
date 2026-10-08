import { describe, expect, it } from "vitest";
import {
  SkillFrontmatterSchema,
  SkillIdSchema,
  SkillManifestSchema,
  SkillVersionSchema,
  compareSkillVersions,
  relativePathProblem,
} from "../src/skills/schema.js";

const paths = (input: unknown) => {
  const r = SkillManifestSchema.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
};
const base = { id: "sql", version: "1.0.0" };

describe("skill id and version", () => {
  it("accepts good ids", () => {
    for (const id of ["sql", "react-18", "a", "a".repeat(64)]) expect(SkillIdSchema.safeParse(id).success).toBe(true);
  });
  it("rejects bad ids", () => {
    for (const id of ["React", "-a", "a-", "a--b", "a_b", "", "a".repeat(65), "a/b"]) {
      expect(SkillIdSchema.safeParse(id).success, id).toBe(false);
    }
  });
  it("accepts good versions", () => {
    for (const v of ["0.1.0", "1.2.3", "1.0.0-rc.1", "1.0.0-0", "1.0.0-alpha-1.x"]) expect(SkillVersionSchema.safeParse(v).success, v).toBe(true);
  });
  it("rejects bad versions", () => {
    for (const v of ["1.2", "v1.2.3", "01.2.3", "1.2.3+build", "1.2.3-", "latest", "1.0.0-01", "1.0.0-a..b", "1.0.0-" + "a".repeat(64)]) {
      expect(SkillVersionSchema.safeParse(v).success, v).toBe(false);
    }
  });
});

describe("relative paths", () => {
  it("accepts plain relative paths and rejects the rest", () => {
    expect(relativePathProblem("a/b/*.ts")).toBeUndefined();
    for (const p of ["", "../x", "/abs", "./x", "a//b", "a\\b", "C:/x", "a\0b", "a/./b", "a/.."]) {
      expect(relativePathProblem(p), JSON.stringify(p)).toBeDefined();
    }
  });
});

describe("SkillManifestSchema", () => {
  it("applies defaults", () => {
    expect(SkillManifestSchema.parse(base)).toEqual({
      ...base,
      category: "general",
      capabilities: [],
      detectors: [],
      roles: [],
      dependencies: [],
      conflicts: [],
      tool_profile: { shell: false, network: false, filesystem: "read" },
      risk: "low",
    });
  });
  it("rejects unknown keys", () => {
    for (const k of ["description", "model", "allowed_tools"]) expect(paths({ ...base, [k]: "x" })).toEqual([""]);
  });
  it("rejects an unknown role", () => expect(paths({ ...base, roles: ["boss"] })).toEqual(["roles.0"]));
  it("reports duplicates at the second occurrence", () => {
    expect(paths({ ...base, capabilities: ["a", "b", "a"] })).toEqual(["capabilities.2"]);
    expect(paths({ ...base, roles: ["coder", "coder"] })).toEqual(["roles.1"]);
    expect(paths({ ...base, conflicts: ["x", "x"] })).toEqual(["conflicts.1"]);
    expect(paths({ ...base, dependencies: [{ id: "x" }, { id: "x" }] })).toEqual(["dependencies.1"]);
    const d = { type: "content", glob: "a", contains: "b" };
    expect(paths({ ...base, detectors: [d, { type: "file", glob: "a" }, { ...d }] })).toEqual(["detectors.2"]);
  });
  it("rejects self references and dependency/conflict overlap", () => {
    expect(paths({ ...base, dependencies: [{ id: "sql" }] })).toEqual(["dependencies.0.id"]);
    expect(paths({ ...base, conflicts: ["sql"] })).toEqual(["conflicts.0"]);
    expect(paths({ ...base, dependencies: [{ id: "x" }], conflicts: ["x"] })).toEqual(["dependencies.0.id"]);
  });
  it("rejects bad detectors", () => {
    expect(paths({ ...base, detectors: [{ type: "magic", glob: "a" }] })).toEqual(["detectors.0.type"]);
    expect(paths({ ...base, detectors: [{ type: "content", glob: "a" }] })).toEqual(["detectors.0.contains"]);
    for (const glob of ["../x", "/abs", "./x", "a//b", "a\\b", "C:/x", "a/./b"]) {
      expect(paths({ ...base, detectors: [{ type: "file", glob }] }), glob).toEqual(["detectors.0.glob"]);
    }
  });
  it("rejects bad values", () => {
    expect(paths({ ...base, dependencies: [{ id: "x", min_version: "1" }] })).toEqual(["dependencies.0.min_version"]);
    expect(paths({ ...base, tool_profile: { filesystem: "all" } })).toEqual(["tool_profile.filesystem"]);
    expect(paths({ ...base, capabilities: Array.from({ length: 33 }, (_, i) => `c${i}`) })).toEqual(["capabilities"]);
  });
});

describe("SkillFrontmatterSchema", () => {
  const ok = { name: "sql", description: "Helps with SQL." };
  it("accepts the standard fields, including angle brackets", () => {
    expect(
      SkillFrontmatterSchema.safeParse({ ...ok, description: "Use <b> tags", license: "MIT", compatibility: "x", metadata: { a: "b" }, "allowed-tools": "Read" }).success,
    ).toBe(true);
  });
  it("rejects bad frontmatter", () => {
    for (const bad of [
      { description: "x" },
      { name: "sql" },
      { ...ok, description: "  " },
      { ...ok, description: "x".repeat(1025) },
      { ...ok, extra: 1 },
      { ...ok, name: "Sql" },
    ]) expect(SkillFrontmatterSchema.safeParse(bad).success).toBe(false);
  });
});

describe("compareSkillVersions", () => {
  const ordered = (list: string[]) => {
    for (let i = 0; i + 1 < list.length; i++) {
      expect(compareSkillVersions(list[i]!, list[i + 1]!)).toBeLessThan(0);
      expect(compareSkillVersions(list[i + 1]!, list[i]!)).toBeGreaterThan(0);
    }
  };
  it("orders major, minor and patch numerically", () => ordered(["1.0.0", "1.0.1", "1.1.0", "2.0.0", "10.0.0"]));
  it("puts a prerelease below its release and compares identifiers one by one", () =>
    ordered(["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-rc.1", "1.0.0"]));
  it("compares numeric identifiers as numbers", () => ordered(["1.0.0-2", "1.0.0-10"]));
  it("compares numbers above the safe integer exactly", () => {
    ordered(["9007199254740993.0.0", "9007199254740994.0.0"]);
    ordered(["1.0.0-9007199254740993", "1.0.0-9007199254740994"]);
    expect(compareSkillVersions("1.0.9007199254740993", "1.0.9007199254740992")).toBeGreaterThan(0);
  });
  it("gives 0 for equal versions", () => expect(compareSkillVersions("1.2.3-rc.1", "1.2.3-rc.1")).toBe(0));
});
