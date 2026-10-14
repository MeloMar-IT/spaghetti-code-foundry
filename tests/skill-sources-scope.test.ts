import { describe, expect, it } from "vitest";
import { parseSources } from "../src/skills/sources.js";

// Token-like samples are built from pieces so that tools/secret-scan finds nothing in this file.
const TOKEN = "sk-" + "ant-" + "abcdefghijklmnopqrst";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

const valid = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "example-skills",
  repository: "https://github.com/example/skills",
  status: "enabled",
  ref: { track: "main", approved: COMMIT },
  paths: ["skills"],
  adapter: "agent-skills",
  trust: "community",
  licence: { allow: ["MIT"] },
  update: { cadence: "weekly" },
  owner: "@octocat",
  review: { by: "@octocat", on: "2026-01-01", commit: COMMIT, licence: "MIT" },
  ...o,
});
const file = (...sources: Record<string, unknown>[]) => ({ schema: 1, sources });
const check = (...sources: Record<string, unknown>[]) => parseSources(file(...sources)).problems;
const text = (ps: { where: string; message: string }[]) => ps.map((p) => `${p.where}: ${p.message}`).join("\n");
const scoped = (scope: unknown) => check(valid({ scope }));

describe("parseSources scope", () => {
  it("round-trips a valid scope sorted, and leaves it out when absent", () => {
    const r = parseSources(file(valid({ scope: { capabilities: ["sql", "oracle"], technologies: { oracle: ">=19", java: "^21.0" } } })));
    expect(r.problems).toEqual([]);
    expect(r.manifest!.sources[0]!.scope).toEqual({
      capabilities: ["oracle", "sql"],
      technologies: [{ name: "java", version: "^21.0" }, { name: "oracle", version: ">=19" }],
    });
    expect("scope" in parseSources(file(valid())).manifest!.sources[0]!).toBe(false);
  });
  it("accepts only capabilities, or only technologies", () => {
    expect(scoped({ capabilities: ["oracle"] })).toEqual([]);
    expect(scoped({ technologies: { oracle: ">=19" } })).toEqual([]);
  });
  it("refuses a scope that is not usable", () => {
    expect(text(scoped("oracle"))).toContain("scope: must be a map");
    expect(text(scoped({}))).toContain("must name capabilities or technologies");
    expect(text(scoped({ other: 1, capabilities: ["a"] }))).toContain('unknown key "other"');
    expect(text(scoped({ capabilities: Array.from({ length: 9 }, (_, i) => `c${i}`) }))).toContain("1 to 8");
    expect(text(scoped({ capabilities: ["a", "a"] }))).toContain("is listed twice");
    expect(text(scoped({ capabilities: ["Not Slug"] }))).toContain("lower-case slug");
    expect(text(scoped({ technologies: { "Not Slug": ">=1" } }))).toContain("lower-case slug");
    expect(text(scoped({ technologies: { oracle: 19 } }))).toContain("put it in quotes");
    expect(text(scoped({ technologies: { oracle: "19c or later" } }))).toContain('is not a version range like ">=19"');
    expect(text(scoped({ technologies: { oracle: ">=1 ".repeat(40) } }))).toContain("is not a version range");
  });
  it("reports a credential-like value by rule name only", () => {
    const t = text(scoped({ technologies: { oracle: TOKEN } }));
    expect(t).toContain("credential");
    expect(t).not.toContain(TOKEN);
  });
});
