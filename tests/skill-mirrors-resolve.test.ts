import { describe, expect, it } from "vitest";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { resolveSkills, type ResolveOptions, type SkillResolution } from "../src/skills/resolve.js";

const big = "x".repeat(4000); // about 1000 tokens
function sk(id: string, o: { instructions?: string; trust?: string; deps?: string[] } = {}): RegisteredSkill {
  return {
    key: `${id}@1.0.0`, id, version: "1.0.0", source: "admin", label: "x", dir: "/d", active: true,
    trust: o.trust ?? "approved", pin: "pinned", digest: `sha256:${"a".repeat(64)}`,
    pkg: { id, version: "1.0.0", description: "Same.", instructions: o.instructions ?? big, roles: [], dependencies: (o.deps ?? []).map((d) => ({ id: d })), conflicts: [] },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] });
const dec = (r: SkillResolution, id: string) => r.decisions.find((d) => d.id === id)!;
const cost = (r: SkillResolution, id: string) => r.selected.find((s) => s.id === id)!.estimatedTokens;
const cap = (o: ResolveOptions = {}) => resolveSkills(reg(sk("a")), ["a"], o).estimatedTokens;

describe("mirrors in resolveSkills", () => {
  it("charges a copy 0 tokens, so it cannot cause over-budget", () => {
    const max = cap();
    const r = resolveSkills(reg(sk("a"), sk("b")), ["a", "b"], { limits: { maxTokens: max } });
    expect(r.ok).toBe(true);
    expect(r.selected.map((s) => [s.id, s.estimatedTokens])).toEqual([["a", max], ["b", 0]]);
    expect(r.estimatedTokens).toBe(max);
    expect(dec(r, "b")).toMatchObject({ outcome: "selected", estimatedTokens: 0 });
  });
  it("charges a copy that is a dependency of another root 0", () => {
    const r = resolveSkills(reg(sk("a"), sk("b", { instructions: "Other." }), sk("c", { deps: ["b"] })), ["a", "c"]);
    expect(r.ok).toBe(true);
    const same = resolveSkills(reg(sk("a"), sk("b"), sk("c", { instructions: "Other.", deps: ["b"] })), ["a", "c"]);
    expect(cost(same, "b")).toBe(0);
    expect(cost(same, "a")).toBeGreaterThan(0);
  });
  it("still refuses one different character as over-budget", () => {
    const r = resolveSkills(reg(sk("a"), sk("b", { instructions: `${big}y` })), ["a", "b"], { limits: { maxTokens: cap() } });
    expect(dec(r, "b")).toMatchObject({ outcome: "rejected", code: "over-budget" });
  });
  it("does not depend on the request order", () => {
    expect(resolveSkills(reg(sk("a"), sk("b")), ["b", "a"])).toEqual(resolveSkills(reg(sk("a"), sk("b")), ["a", "b"]));
  });
  it("does not block a mandatory copy next to a requested original", () => {
    const r = resolveSkills(reg(sk("a"), sk("b")), ["a"], { include: ["b"], limits: { maxTokens: cap() } });
    expect(r.ok).toBe(true);
    expect(r.selected.map((s) => s.id)).toEqual(["b", "a"]);
  });
  it("charges a copy in full when the original is rejected", () => {
    const r = resolveSkills(reg(sk("a", { trust: "unapproved" }), sk("b")), ["a", "b"]);
    expect(dec(r, "a").outcome).toBe("rejected");
    expect(cost(r, "b")).toBeGreaterThan(0);
  });
});
