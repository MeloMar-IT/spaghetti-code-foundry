import { describe, expect, it } from "vitest";
import { parseSources } from "../src/skills/sources.js";

// The optional source fields `access` and `exclude`.

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const valid = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "example-skills",
  repository: "https://github.com/example/skills",
  status: "enabled",
  ref: { track: "main", approved: COMMIT },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "first-party",
  licence: { allow: ["MIT"] },
  update: { cadence: "weekly" },
  owner: "@octocat",
  ...o,
});
const check = (entry: Record<string, unknown>) => parseSources({ schema: 1, sources: [entry] });

describe("access and exclude", () => {
  it("keeps a valid access and exclude", () => {
    const r = check(valid({ access: { repo: "Example/Skills.git" }, exclude: ["skills/example-skill"] }));
    expect(r.problems).toEqual([]);
    expect(r.manifest!.sources[0]!.access).toEqual({ repo: "Example/Skills.git" });
    expect(r.manifest!.sources[0]!.exclude).toEqual(["skills/example-skill"]);
  });

  it("has neither field when the file has none", () => {
    const s = check(valid()).manifest!.sources[0]!;
    expect("access" in s).toBe(false);
    expect("exclude" in s).toBe(false);
  });

  it.each([
    ["verified trust", valid({ trust: "verified", access: { repo: "example/skills" } })],
    ["community trust", valid({ trust: "community", access: { repo: "example/skills" } })],
    ["a bad name", valid({ access: { repo: "bad name" } })],
    ["a placeholder name", valid({ access: { repo: "owner/repo" } })],
    ["another repository", valid({ access: { repo: "example/other" } })],
    ["an unknown key", valid({ access: { repo: "example/skills", extra: 1 } })],
    ["no repo", valid({ access: {} })],
    ["a list", valid({ access: ["example/skills"] })],
  ])("refuses access with %s", (_n, entry) => {
    const ps = check(entry).problems;
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.some((p) => p.where.endsWith("access"))).toBe(true);
  });

  it.each([
    ["outside the paths", ["other/x"]],
    ["equal to a path", ["skills"]],
    ["a glob", ["skills/*"]],
    ["a duplicate", ["skills/a", "skills/a"]],
    ["a parent path", ["skills/../x"]],
    ["an empty list", []],
    ["the root", ["."]],
    ["not text", [1]],
  ])("refuses exclude %s", (_n, list) => {
    const ps = check(valid({ exclude: list })).problems;
    expect(ps.length).toBeGreaterThan(0);
    expect(ps.every((p) => p.where.includes("exclude"))).toBe(true);
  });

  it("allows exclude on any trust tier", () => {
    expect(check(valid({ trust: "verified", exclude: ["skills/x"] })).problems).toEqual([]);
  });
});
