import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { selectSkill, type RegisteredSkill } from "../src/skills/registry.js";
import { resolveOptionsFrom, resolveSkills, SkillResolutionSchema, type ResolveOptions, type SkillResolution } from "../src/skills/resolve.js";

interface Over {
  version?: string;
  roles?: string[];
  dependencies?: { id: string; min_version?: string }[];
  conflicts?: string[];
  trust?: string;
  pin?: string;
  active?: boolean;
  instructions?: string;
}
function sk(id: string, o: Over = {}): RegisteredSkill {
  const version = o.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: "admin", label: "x", dir: "/secret/dir", active: o.active ?? true,
    trust: o.trust ?? "approved", pin: o.pin ?? "pinned", digest: `sha256:${"a".repeat(64)}`,
    pkg: {
      id, version, description: `Description of ${id}.`, instructions: o.instructions ?? "Do the thing.",
      roles: o.roles ?? [], dependencies: o.dependencies ?? [], conflicts: o.conflicts ?? [],
    },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] });
const ids = (r: SkillResolution) => r.selected.map((s) => s.id);
const dec = (r: SkillResolution, id: string) => r.decisions.find((d) => d.id === id)!;
const dep = (id: string, min_version?: string) => ({ id, ...(min_version ? { min_version } : {}) });
const big = "x".repeat(4000); // about 1000 tokens

/** The "selected" decisions are exactly the selected list. */
const consistent = (r: SkillResolution) =>
  expect(r.decisions.filter((d) => d.outcome === "selected").map((d) => d.id).sort()).toEqual(ids(r).sort());

describe("approval", () => {
  it("selects pinned approved and built-in skills with the registry's version and digest", () => {
    const r = resolveSkills(reg(sk("a"), sk("b", { trust: "builtin", version: "2.1.0" })), ["a", "b"]);
    expect(r.ok).toBe(true);
    expect(r.selected.map((s) => [s.id, s.version, s.reason])).toEqual([["a", "1.0.0", "requested"], ["b", "2.1.0", "requested"]]);
    expect(r.selected[0]!.digest).toMatch(/^sha256:/);
  });
  it.each([
    ["unknown", undefined, "nope"],
    ["unapproved", { trust: "unapproved", pin: "unpinned" }, "a"],
    ["unpinned", { pin: "unpinned" }, "a"],
    ["mismatch", { pin: "mismatch" }, "a"],
    ["unverified", { pin: "unverified" }, "a"],
  ])("rejects %s", (code, over, id) => {
    const r = resolveSkills(reg(sk("a", over)), [id]);
    expect(r.ok).toBe(true);
    expect(r.selected).toEqual([]);
    expect(dec(r, id)).toMatchObject({ outcome: "rejected", code });
  });
  it("does not use a shadowed pinned version when the active one is unpinned", () => {
    const r = resolveSkills(reg(sk("a", { version: "2.0.0", pin: "unpinned" }), sk("a", { version: "1.0.0", active: false })), ["a"]);
    expect(r.selected).toEqual([]);
    expect(dec(r, "a")).toMatchObject({ code: "unpinned", version: "2.0.0" });
  });
  it("only returns entries that pass selectSkill", () => {
    const registry = reg(sk("a", { dependencies: [dep("b")] }), sk("b"));
    for (const s of resolveSkills(registry, ["a"]).selected) expect(selectSkill(registry, s.id, s.version).digest).toBe(s.digest);
  });
  it("is pure", () => {
    expect(readFileSync("src/skills/resolve.ts", "utf8")).not.toMatch(/from "node:/);
  });
});

describe("dependencies", () => {
  it("lists a transitive chain dependencies first", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("b")] }), sk("b", { dependencies: [dep("c")] }), sk("c")), ["a"]);
    expect(ids(r)).toEqual(["c", "b", "a"]);
    expect(r.selected.map((s) => s.reason)).toEqual(["dependency", "dependency", "requested"]);
    expect(r.selected.map((s) => s.requiredBy)).toEqual([["b"], ["a"], []]);
    expect(r.decisions.map((d) => [d.id, d.code])).toEqual([["a", "requested"], ["b", "dependency"], ["c", "dependency"]]);
    consistent(r);
  });
  it("counts a shared dependency once", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("c")] }), sk("b", { dependencies: [dep("c")] }), sk("c")), ["a", "b"]);
    expect(ids(r)).toEqual(["c", "a", "b"]);
    expect(r.selected[0]!.requiredBy).toEqual(["a", "b"]);
  });
  it("gives a dependency that is also requested the reason requested", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("b")] }), sk("b")), ["a", "b"]);
    expect(ids(r)).toEqual(["b", "a"]);
    expect(r.selected[0]!.reason).toBe("requested");
    expect(r.decisions.map((d) => d.id)).toEqual(["a", "b"]);
  });
  it("checks min_version, including prereleases", () => {
    const ok = resolveSkills(reg(sk("a", { dependencies: [dep("b", "1.0.0")] }), sk("b", { version: "1.2.0" })), ["a"]);
    expect(ids(ok)).toEqual(["b", "a"]);
    const low = resolveSkills(reg(sk("a", { dependencies: [dep("b", "1.0.0")] }), sk("b", { version: "1.0.0-rc.1" })), ["a"]);
    expect(dec(low, "a")).toMatchObject({ outcome: "rejected", code: "dependency-version", via: "b" });
    expect(low.selected).toEqual([]);
  });
  it.each([
    ["missing", [sk("a", { dependencies: [dep("b")] })], undefined],
    ["unpinned", [sk("a", { dependencies: [dep("b")] }), sk("b", { pin: "unpinned" })], undefined],
    ["excluded", [sk("a", { dependencies: [dep("b")] }), sk("b")], { exclude: ["b"] }],
  ])("a %s dependency gives dependency-unavailable", (_n, skills, opts) => {
    const r = resolveSkills(reg(...skills), ["a"], opts as ResolveOptions | undefined);
    expect(dec(r, "a")).toMatchObject({ code: "dependency-unavailable", via: "b" });
    expect(r.selected).toEqual([]);
  });
  it("a rejected skill's private dependencies are not selected", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("b"), dep("z")] }), sk("b")), ["a"]);
    expect(r.selected).toEqual([]);
    expect(r.estimatedTokens).toBe(0);
    consistent(r);
  });
});

describe("cycles", () => {
  it("rejects A<->B and still selects the others", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("b")] }), sk("b", { dependencies: [dep("a")] }), sk("c")), ["a", "b", "c"]);
    expect(ids(r)).toEqual(["c"]);
    expect(dec(r, "a").code).toBe("dependency-cycle");
    expect(dec(r, "b").code).toBe("dependency-cycle");
  });
  it("rejects a three-skill cycle reached from outside", () => {
    const r = resolveSkills(
      reg(sk("r", { dependencies: [dep("x")] }), sk("x", { dependencies: [dep("y")] }), sk("y", { dependencies: [dep("z")] }), sk("z", { dependencies: [dep("x")] })),
      ["r"],
    );
    expect(dec(r, "r")).toMatchObject({ code: "dependency-cycle", via: "x" });
    expect(r.selected).toEqual([]);
  });
  it("stops at the depth limit", () => {
    const name = (i: number) => `s${String(i).padStart(2, "0")}`;
    const chain = Array.from({ length: 40 }, (_, i) => sk(name(i), { dependencies: i < 39 ? [dep(name(i + 1))] : [] }));
    const r = resolveSkills(reg(...chain), [name(0)], { limits: { maxSkills: 20 } });
    expect(dec(r, name(0)).code).toBe("dependency-unavailable");
  });
});

describe("conflicts", () => {
  it("keeps the earlier skill when it lists the later one", () => {
    const r = resolveSkills(reg(sk("a", { conflicts: ["b"] }), sk("b")), ["a", "b"]);
    expect(ids(r)).toEqual(["a"]);
    expect(dec(r, "b")).toMatchObject({ code: "conflict", via: "a" });
  });
  it("is symmetric", () => {
    const r = resolveSkills(reg(sk("a"), sk("b", { conflicts: ["a"] })), ["a", "b"]);
    expect(ids(r)).toEqual(["a"]);
    expect(dec(r, "b")).toMatchObject({ code: "conflict", via: "a" });
  });
  it("conflicts with a dependency of an earlier skill", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("c")] }), sk("b", { conflicts: ["c"] }), sk("c")), ["a", "b"]);
    expect(ids(r)).toEqual(["c", "a"]);
    expect(dec(r, "b")).toMatchObject({ code: "conflict", via: "c" });
  });
  it("refuses a unit whose root conflicts with its own dependency", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("b")], conflicts: ["c"] }), sk("b", { dependencies: [dep("c")] }), sk("c")), ["a"]);
    expect(r.selected).toEqual([]);
    expect(dec(r, "a")).toMatchObject({ code: "conflict", via: "c" });
  });
  it("refuses a unit with a conflict between two of its dependencies", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("b"), dep("c")] }), sk("b", { conflicts: ["c"] }), sk("c")), ["a"]);
    expect(r.selected).toEqual([]);
    expect(dec(r, "a")).toMatchObject({ code: "conflict", via: "b" });
  });
});

describe("exclusions and roles", () => {
  it("rejects an excluded id without a version", () => {
    const r = resolveSkills(reg(sk("a")), ["a"], { exclude: ["a"] });
    expect(dec(r, "a")).toEqual({ id: "a", outcome: "rejected", code: "excluded", mandatory: false });
  });
  it("applies the role", () => {
    const registry = reg(sk("t", { roles: ["tester"] }), sk("any"));
    expect(dec(resolveSkills(registry, ["t"]), "t").code).toBe("role");
    expect(ids(resolveSkills(registry, ["t"], { role: "tester" }))).toEqual(["t"]);
    expect(ids(resolveSkills(registry, ["any"], { role: "reviewer" }))).toEqual(["any"]);
  });
  it("a dependency not allowed for the role gives dependency-unavailable", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("t")] }), sk("t", { roles: ["tester"] })), ["a"]);
    expect(dec(r, "a")).toMatchObject({ code: "dependency-unavailable", via: "t" });
  });
});

describe("budgets", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => sk(`s${i}`));
  it("selects six by default and rejects the last by id with over-count", () => {
    const r = resolveSkills(reg(...many(7)), many(7).map((s) => s.id));
    expect(ids(r)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    expect(dec(r, "s6").code).toBe("over-count");
  });
  it("refuses a unit as a whole and lets a later skill fit", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("b"), dep("c")] }), sk("b"), sk("c"), sk("d")), ["a", "d"], { limits: { maxSkills: 2 } });
    expect(dec(r, "a").code).toBe("over-count");
    expect(ids(r)).toEqual(["d"]);
  });
  it("rejects a skill over maxSkillTokens as too-large", () => {
    const r = resolveSkills(reg(sk("a", { instructions: big.repeat(6) }), sk("b")), ["a", "b"]);
    expect(dec(r, "a").code).toBe("too-large");
    expect(ids(r)).toEqual(["b"]);
  });
  it("rejects over the total budget; the estimate is the sum and within the limit", () => {
    const r = resolveSkills(
      reg(sk("a", { instructions: big.repeat(2) }), sk("b", { instructions: big.repeat(2) }), sk("c", { instructions: big })),
      ["a", "b", "c"],
      { limits: { maxTokens: 4500 } },
    );
    expect(ids(r)).toEqual(["a", "b"]);
    expect(dec(r, "c").code).toBe("over-budget");
    expect(r.estimatedTokens).toBe(r.selected.reduce((n, s) => n + s.estimatedTokens, 0));
    expect(r.estimatedTokens).toBeLessThanOrEqual(4500);
    expect(r.estimatedTokens).toBeGreaterThan(0);
  });
  it("defaults or clamps odd limits", () => {
    const r = resolveSkills(reg(), [], { limits: { maxSkills: NaN, maxSkillTokens: 0, maxTokens: 999999 } });
    expect(r.limits).toEqual({ maxSkills: 6, maxSkillTokens: 100, maxTokens: 100000 });
    expect(resolveSkills(reg(), [], { limits: { maxSkills: 1.5 } }).limits.maxSkills).toBe(6);
  });
});

describe("mandatory skills", () => {
  it("selects an included skill with reason mandatory, also when not requested", () => {
    const r = resolveSkills(reg(sk("a"), sk("b")), ["b"], { include: ["a"] });
    expect(r.selected.map((s) => [s.id, s.reason])).toEqual([["a", "mandatory"], ["b", "requested"]]);
    expect(dec(r, "a")).toMatchObject({ outcome: "selected", code: "mandatory", mandatory: true });
  });
  it("places mandatory skills first, so a conflicting requested skill loses", () => {
    const r = resolveSkills(reg(sk("a"), sk("z", { conflicts: ["a"] })), ["a", "z"], { include: ["z"] });
    expect(ids(r)).toEqual(["z"]);
    expect(dec(r, "a")).toMatchObject({ code: "conflict", via: "z" });
  });
  it.each([
    ["unknown", [], undefined],
    ["unapproved", [sk("m", { trust: "unapproved", pin: "unpinned" })], undefined],
    ["unpinned", [sk("m", { pin: "unpinned" })], undefined],
    ["mismatch", [sk("m", { pin: "mismatch" })], undefined],
    ["unverified", [sk("m", { pin: "unverified" })], undefined],
    ["role", [sk("m", { roles: ["tester"] })], undefined],
    ["too-large", [sk("m", { instructions: big.repeat(6) })], undefined],
    ["excluded", [sk("m")], { exclude: ["m"] }],
    ["dependency-cycle", [sk("m", { dependencies: [dep("x")] }), sk("x", { dependencies: [dep("m")] })], undefined],
    ["dependency-unavailable", [sk("m", { dependencies: [dep("x")] })], undefined],
    ["dependency-version", [sk("m", { dependencies: [dep("x", "2.0.0")] }), sk("x")], undefined],
    ["conflict", [sk("m", { conflicts: ["aok"] })], undefined],
    ["over-count", [sk("m", { dependencies: [dep("x")] }), sk("x"), sk("ok")], { limits: { maxSkills: 2 } }],
    ["over-budget", [sk("m", { instructions: big.repeat(2) }), sk("ok")], { limits: { maxTokens: 1500 } }],
  ])("a mandatory skill that fails with %s blocks the selection", (code, skills, opts) => {
    // "ok" is mandatory and valid, listed first by id order of include; "req" is requested and valid.
    const registry = reg(...skills, sk("aok"), sk("req"));
    const r = resolveSkills(registry, ["req", "aok"], { include: ["aok", "m"], ...(opts as ResolveOptions | undefined) });
    expect(r.ok).toBe(false);
    expect(r.selected).toEqual([]);
    expect(r.estimatedTokens).toBe(0);
    expect(dec(r, "m")).toMatchObject({ outcome: "rejected", code, mandatory: true });
    expect(dec(r, "aok")).toMatchObject({ outcome: "rejected", code: "blocked", mandatory: true });
    expect(dec(r, "req").outcome).toBe("rejected");
    consistent(r);
  });
  it("blocks when two mandatory skills conflict", () => {
    const r = resolveSkills(reg(sk("a", { conflicts: ["b"] }), sk("b")), [], { include: ["a", "b"] });
    expect(r.ok).toBe(false);
    expect(dec(r, "b")).toMatchObject({ code: "conflict", via: "a", mandatory: true });
    consistent(r);
  });
  it.each([
    ["an invalid include id", { include: ["Bad Id"] }],
    ["an invalid exclude id", { exclude: ["Bad Id"] }],
    ["an exclude list over the cap", { exclude: Array.from({ length: 501 }, (_, i) => `x${i}`) }],
    ["an include list over the cap", { include: Array.from({ length: 21 }, (_, i) => `x${i}`) }],
  ])("%s blocks the selection", (_n, opts) => {
    const r = resolveSkills(reg(sk("a")), ["a"], opts);
    expect(r.ok).toBe(false);
    expect(r.selected).toEqual([]);
    expect(r.policyErrors).toBeGreaterThan(0);
    expect(dec(r, "a")).toMatchObject({ outcome: "rejected", code: "blocked" });
    consistent(r);
  });
  it("an id in both include and exclude blocks with excluded", () => {
    const r = resolveSkills(reg(sk("a")), [], { include: ["a"], exclude: ["a"] });
    expect(r.ok).toBe(false);
    expect(dec(r, "a").code).toBe("excluded");
  });
});

describe("determinism and minimality", () => {
  const skills = () => [
    sk("a", { dependencies: [dep("c"), dep("b")] }), sk("b"), sk("c", { dependencies: [dep("d")] }), sk("d"), sk("e", { conflicts: ["d"] }), sk("f"),
  ];
  it("gives equal results for a shuffled request and registry", () => {
    const one = resolveSkills(reg(...skills()), ["a", "e", "f"], { include: ["f"] });
    const two = resolveSkills(reg(...skills().reverse()), ["f", "e", "a"], { include: ["f"] });
    expect(two).toEqual(one);
    expect(ids(one)).toEqual(["f", "b", "d", "c", "a"]);
  });
  it("selects only mandatory, requested or required skills", () => {
    const r = resolveSkills(reg(...skills()), ["a", "e"], { include: ["f"] });
    const all = new Set(r.selected.flatMap((s) => s.requiredBy));
    for (const s of r.selected) expect(s.reason !== "dependency" || s.requiredBy.length > 0).toBe(true);
    for (const id of all) expect(ids(r)).toContain(id);
    consistent(r);
  });
});

describe("safety and edge cases", () => {
  it("leaks no directory, instruction text or description", () => {
    const text = JSON.stringify(resolveSkills(reg(sk("a", { instructions: "SECRET-BODY" })), ["a"]));
    expect(text).not.toContain("/secret/dir");
    expect(text).not.toContain("SECRET-BODY");
    expect(text).not.toContain("Description of");
  });
  it("counts invalid and duplicate ids and ignores them", () => {
    const r = resolveSkills(reg(sk("a")), ["a", "a", "Bad Id", "", "x".repeat(70)]);
    expect(r.invalid).toBe(3);
    expect(ids(r)).toEqual(["a"]);
    expect(r.decisions).toHaveLength(1);
  });
  it("gives ok and nothing for an empty request", () => {
    const r = resolveSkills(reg(sk("a")), []);
    expect(r).toMatchObject({ ok: true, selected: [], estimatedTokens: 0, decisions: [] });
  });
  it("passes its own schema", () => {
    const r = resolveSkills(reg(sk("a", { dependencies: [dep("b")] }), sk("b")), ["a", "zzz"]);
    expect(SkillResolutionSchema.safeParse(r).success).toBe(true);
  });
});

describe("skills.selection config", () => {
  const parse = (skills: unknown) => ConfigSchema.safeParse({ skills });
  it("has defaults and an old config parses", () => {
    const c = ConfigSchema.parse({});
    expect(c.skills.selection).toEqual({ max_skills: 6, max_skill_tokens: 5000, max_tokens: 15000, include: [], exclude: [] });
  });
  it.each([
    ["max_skills 0", { selection: { max_skills: 0 } }],
    ["max_skills 21", { selection: { max_skills: 21 } }],
    ["duplicate include", { selection: { include: ["a", "a"] } }],
    ["duplicate exclude", { selection: { exclude: ["a", "a"] } }],
    ["too many include", { selection: { max_skills: 1, include: ["a", "b"] } }],
    ["both lists", { selection: { include: ["a"], exclude: ["a"] } }],
    ["catalogue exclude", { selection: { include: ["a"] }, catalogue: { exclude: ["a"] } }],
  ])("refuses %s", (_n, skills) => expect(parse(skills).success).toBe(false));
  it("maps all keys", () => {
    const c = ConfigSchema.parse({
      skills: { selection: { max_skills: 3, max_skill_tokens: 200, max_tokens: 900, include: ["a"], exclude: ["x"] }, catalogue: { exclude: ["y", "x"] } },
    });
    const o = resolveOptionsFrom(c.skills);
    expect(o.include).toEqual(["a"]);
    expect([...o.exclude!].sort()).toEqual(["x", "y"]);
    expect(o.limits).toEqual({ maxSkills: 3, maxSkillTokens: 200, maxTokens: 900 });
  });
});
