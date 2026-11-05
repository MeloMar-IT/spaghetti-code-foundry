import { describe, expect, it } from "vitest";
import { autoSkillVersion, bumpMinor, bumpPatch } from "../src/skills/auto-version.js";

// The version rules of an automatic release (#799), pure.

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const base = (version: string, paths = ["SKILL.md", "skill.yaml"]) => ({ version, digest: D1, paths });
/** The digest the package has at a version: `same` is the base digest at the base version only. */
const digestAt = (sameAt?: string) => (v: string) => (v === sameAt ? D1 : D2);

describe("autoSkillVersion", () => {
  it("starts at 1.0.0 without a base, or at the declared version when it is higher", () => {
    expect(autoSkillVersion({ digestAt: digestAt(), paths: ["SKILL.md"] })).toBe("1.0.0");
    expect(autoSkillVersion({ declared: "2.1.0", digestAt: digestAt(), paths: ["SKILL.md"] })).toBe("2.1.0");
    expect(autoSkillVersion({ declared: "0.9.0", digestAt: digestAt(), paths: ["SKILL.md"] })).toBe("1.0.0");
  });

  it("keeps the base version when the digest is the same, even if upstream declares a higher one", () => {
    expect(autoSkillVersion({ base: base("1.2.3"), digestAt: digestAt("1.2.3"), paths: ["SKILL.md", "skill.yaml"] })).toBe("1.2.3");
    expect(autoSkillVersion({ base: base("1.2.3"), declared: "9.0.0", digestAt: digestAt("1.2.3"), paths: ["SKILL.md", "skill.yaml"] })).toBe("1.2.3");
  });

  it("uses a declared version that is higher than the base when the content changed", () => {
    expect(autoSkillVersion({ base: base("1.2.3"), declared: "2.0.0", digestAt: digestAt(), paths: ["SKILL.md", "skill.yaml"] })).toBe("2.0.0");
  });

  it("makes a patch bump for a text change, also when the declared version is not higher", () => {
    expect(autoSkillVersion({ base: base("1.2.3"), digestAt: digestAt(), paths: ["SKILL.md", "skill.yaml"] })).toBe("1.2.4");
    expect(autoSkillVersion({ base: base("1.2.3"), declared: "1.2.3", digestAt: digestAt(), paths: ["SKILL.md", "skill.yaml"] })).toBe("1.2.4");
    expect(autoSkillVersion({ base: base("1.2.3"), declared: "1.0.0", digestAt: digestAt(), paths: ["SKILL.md", "skill.yaml"] })).toBe("1.2.4");
  });

  it("makes a minor bump when a file was added or removed", () => {
    expect(autoSkillVersion({ base: base("1.2.3"), digestAt: digestAt(), paths: ["SKILL.md", "skill.yaml", "references/a.md"] })).toBe("1.3.0");
    expect(autoSkillVersion({ base: base("1.2.3"), digestAt: digestAt(), paths: ["SKILL.md"] })).toBe("1.3.0");
  });

  it("bumps the core numbers of a base with a prerelease", () => {
    expect(bumpPatch("1.2.3-rc.1")).toBe("1.2.4");
    expect(bumpMinor("1.2.3-rc.1")).toBe("1.3.0");
    expect(autoSkillVersion({ base: base("1.2.3-rc.1"), digestAt: digestAt(), paths: ["SKILL.md", "skill.yaml"] })).toBe("1.2.4");
  });
});
