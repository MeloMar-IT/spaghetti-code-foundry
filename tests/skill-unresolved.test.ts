import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { resolveOptionsFrom, resolveSkills, type SkillResolution } from "../src/skills/resolve.js";
import { RESOLVE_REJECT_CODES, UNRESOLVED_KIND, UNRESOLVED_KINDS } from "../src/skills/resolve-rules.js";
import { assessSkills, skillRisk, unresolvedMessage, type UnresolvedSkill } from "../src/skills/unresolved.js";

interface Over {
  version?: string;
  roles?: string[];
  dependencies?: { id: string; min_version?: string }[];
  conflicts?: string[];
  trust?: string;
  pin?: string;
  instructions?: string;
  category?: string;
  capabilities?: string[];
  risk?: string;
  digest?: string;
}
function sk(id: string, o: Over = {}): RegisteredSkill {
  const version = o.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: "admin", label: "x", dir: "/secret/dir", active: true,
    trust: o.trust ?? "approved", pin: o.pin ?? "pinned", digest: o.digest ?? `sha256:${"a".repeat(64)}`,
    pkg: {
      id, version, description: `Description of ${id}.`, instructions: o.instructions ?? "Do the thing.",
      roles: o.roles ?? [], dependencies: o.dependencies ?? [], conflicts: o.conflicts ?? [],
      category: o.category ?? "general", capabilities: o.capabilities ?? [], risk: o.risk ?? "low",
    },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] });
const policy = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ skills: { unresolved: over } }).skills.unresolved;
const allWarn = { unknown: "warn", missing: "warn", untrusted: "warn", conflict: "warn", oversized: "warn" };
const plan = (r: ReturnType<typeof reg>, ids: string[], pol = policy(), opts: Parameters<typeof resolveSkills>[2] = {}) =>
  assessSkills(resolveSkills(r, ids, opts), r, pol);
const big = "x".repeat(4000);

describe("messages", () => {
  const res = resolveSkills(reg(sk("a")), ["a"]);
  it.each(RESOLVE_REJECT_CODES)("code %s has a kind and a short message without pause words", (code) => {
    expect(UNRESOLVED_KINDS).toContain(UNRESOLVED_KIND[code]);
    const message = unresolvedMessage(
      { id: "a", version: "1.0.0", outcome: "rejected", code, mandatory: false, via: "b" },
      { limits: res.limits, role: "coder", key: "a@1.0.0", digest: `sha256:${"a".repeat(64)}` },
    );
    expect(message.length).toBeGreaterThan(10);
    expect(message.length).toBeLessThanOrEqual(400);
    expect(message).not.toMatch(/daily budget|usage limit reached|signed out/);
  });
  it("tells how to pin an unpinned skill", () => {
    const p = plan(reg(sk("a", { pin: "unpinned" })), ["a"]);
    expect(p.unresolved[0]!.message).toContain(`scf skills pin a@1.0.0 sha256:${"a".repeat(64)}`);
  });
  it("gives each dependency failure its own remedy", () => {
    const want: [string, Over | undefined, RegExp][] = [
      ["unknown", undefined, /is installed\. Put it in the skills folder/],
      ["excluded", undefined, /skills\.selection\.exclude/],
      ["unapproved", { trust: "unapproved", pin: "unpinned" }, /repository and cannot be used\. Copy it/],
      ["unpinned", { pin: "unpinned" }, /scf skills pin d@1\.0\.0 sha256:/],
      ["mismatch", { pin: "mismatch" }, /changed since it was pinned/],
      ["unverified", { pin: "unverified" }, /skill lock cannot be read/],
      ["role", { roles: ["tester"] }, /not allowed for the coder role/],
      ["too-large", { instructions: big }, /max_skill_tokens \(1000\)/],
    ];
    for (const [cause, over, text] of want) {
      const skills = cause === "unknown" ? [sk("a", { dependencies: [{ id: "d" }] })] : [sk("a", { dependencies: [{ id: "d" }] }), sk("d", over)];
      const r = reg(...skills);
      const o: Parameters<typeof resolveSkills>[2] = cause === "excluded" ? { exclude: ["d"] } : cause === "too-large" ? { limits: { maxSkillTokens: 1000 } } : {};
      const p = plan(r, ["a"], policy(), o);
      expect(p.unresolved[0], cause).toMatchObject({ id: "a", code: "dependency-unavailable", cause, via: "d", kind: cause === "unknown" ? "missing" : cause === "too-large" ? "oversized" : "untrusted", action: "stop" });
      expect(p.unresolved[0]!.message, cause).toMatch(text);
    }
  });
  it("tells a too-deep chain, a cycle and an old dependency apart", () => {
    const chain = Array.from({ length: 40 }, (_, i) => sk(`s${i}`, { dependencies: i < 39 ? [{ id: `s${i + 1}` }] : [] }));
    expect(plan(reg(...chain), ["s0"]).unresolved[0]!.message).toContain("nested too deeply");
    const cyc = plan(reg(sk("a", { dependencies: [{ id: "b" }] }), sk("b", { dependencies: [{ id: "a" }] })), ["a"]);
    expect(cyc.unresolved[0]).toMatchObject({ code: "dependency-cycle" });
    expect(cyc.unresolved[0]!.message).toContain("Remove the cycle");
    const old = plan(reg(sk("a", { dependencies: [{ id: "d", min_version: "2.0.0" }] }), sk("d")), ["a"]);
    expect(old.unresolved[0]).toMatchObject({ code: "dependency-version" });
    expect(old.unresolved[0]!.message).toContain("Install a newer version");
  });
});

describe("policy", () => {
  it.each([
    ["unknown", reg(sk("a")), ["nope"], {}, "unknown"],
    ["unpinned", reg(sk("a", { pin: "unpinned" })), ["a"], {}, "untrusted"],
    ["unapproved", reg(sk("a", { trust: "unapproved", pin: "unpinned" })), ["a"], {}, "untrusted"],
    ["mismatch", reg(sk("a", { pin: "mismatch" })), ["a"], {}, "untrusted"],
    ["conflict", reg(sk("a", { conflicts: ["b"] }), sk("b")), ["a", "b"], {}, "conflict"],
    ["too-large", reg(sk("a", { instructions: big })), ["a"], { limits: { maxSkillTokens: 100 } }, "oversized"],
    ["over-budget", reg(sk("a", { instructions: big }), sk("b", { instructions: big })), ["a", "b"], { limits: { maxTokens: 1500 } }, "oversized"],
    ["excluded", reg(sk("a")), ["a"], { exclude: ["a"] }, "untrusted"],
  ] as const)("%s stops by default", (code, r, ids, opts, kind) => {
    const p = plan(r, [...ids], policy(), opts);
    expect(p.unresolved.at(-1)).toMatchObject({ code, kind, action: "stop" });
    expect(p.action).toBe("stop");
    expect(p.reason).toMatch(/^skills not resolved: 1 skill\(s\) cannot be used — /);
  });

  it("warns for a low-risk unknown id when the policy says so", () => {
    const p = plan(reg(), ["some-style"], policy({ unknown: "warn" }));
    expect(p.action).toBe("warn");
    expect(p.reason).toBeUndefined();
    expect(p.unresolved[0]).toMatchObject({ because: "policy", action: "warn", risk: "low" });
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toMatch(/^skill some-style \[unknown\]: .* Continuing without it \(skills\.unresolved\.unknown: warn\)\.$/);
  });

  it("high risk always stops, even when every kind is set to warn", () => {
    const pol = policy(allWarn);
    const cases: [ReturnType<typeof reg>, string][] = [
      [reg(), "db-migrations"],
      [reg(), "security"],
      [reg(sk("a", { pin: "unpinned", risk: "high" })), "a"],
      [reg(sk("a", { pin: "unpinned", capabilities: ["kafka"] })), "a"],
      [reg(sk("a", { trust: "unapproved", pin: "unpinned", category: "security" })), "a"],
    ];
    for (const [r, id] of cases) {
      const p = plan(r, [id], pol);
      expect(p.action, id).toBe("stop");
      expect(p.unresolved[0], id).toMatchObject({ risk: "high", action: "stop", because: "high-risk" });
    }
  });

  it("medium risk is not warnable either", () => {
    const p = plan(reg(sk("a", { pin: "unpinned", risk: "medium" })), ["a"], policy(allWarn));
    expect(p.action).toBe("stop");
    expect(p.unresolved[0]).toMatchObject({ risk: "medium", action: "stop", because: "high-risk" });
  });

  it("a dependency inherits the higher risk", () => {
    const r = reg(sk("a", { dependencies: [{ id: "db-migrations" }] }));
    const p = plan(r, ["a"], policy(allWarn));
    expect(p.unresolved[0]).toMatchObject({ code: "dependency-unavailable", risk: "high", action: "stop" });
  });

  it("the risk of a whole dependency chain counts, not just its ends", () => {
    const r = reg(
      sk("a", { dependencies: [{ id: "b" }] }),
      sk("b", { category: "security", dependencies: [{ id: "c" }] }),
    );
    const p = plan(r, ["a"], policy({ missing: "warn" }));
    expect(p.unresolved[0]).toMatchObject({ id: "a", code: "dependency-unavailable", via: "c", risk: "high", action: "stop", because: "high-risk" });
  });

  it("a failing dependency follows the policy of its cause, not always 'missing'", () => {
    const dep = (over?: Over) => reg(sk("a", { dependencies: [{ id: "d" }] }), ...(over ? [sk("d", over)] : []));
    const mixed = policy({ missing: "warn", untrusted: "stop", oversized: "stop" });
    const unpinned = plan(dep({ pin: "unpinned" }), ["a"], mixed);
    expect(unpinned.unresolved[0]).toMatchObject({ kind: "untrusted", action: "stop" });
    const large = plan(dep({ instructions: big }), ["a"], mixed, { limits: { maxSkillTokens: 100 } });
    expect(large.unresolved[0]).toMatchObject({ kind: "oversized", action: "stop" });
    const absent = plan(dep(), ["a"], mixed);
    expect(absent.unresolved[0]).toMatchObject({ kind: "missing", action: "warn" });
    expect(absent.action).toBe("warn");
    expect(plan(dep({ pin: "unpinned" }), ["a"], policy({ untrusted: "warn" })).action).toBe("warn");
  });

  it("matches whole words only", () => {
    const hr = policy().high_risk;
    expect(skillRisk("insecurity-notes", reg(), hr)).toBe("low");
    expect(skillRisk("migrationx", reg(), hr)).toBe("low");
    expect(skillRisk("db-migration-guide", reg(), hr)).toBe("high");
  });

  it("uses the configured terms", () => {
    expect(plan(reg(), ["payments-api"], policy({ ...allWarn, high_risk: ["payments"] })).action).toBe("stop");
    const p = plan(reg(), ["security"], policy({ unknown: "warn", high_risk: [] }));
    expect(p.action).toBe("warn");
  });

  it("a refused mandatory skill stops, and the rest is blocked", () => {
    const r = reg(sk("a"), sk("m", { pin: "unpinned" }));
    const p = plan(r, ["a"], policy(allWarn), { include: ["m"] });
    expect(p.action).toBe("stop");
    expect(p.selected).toEqual([]);
    expect(p.unresolved.find((u) => u.id === "m")).toMatchObject({ because: "mandatory", mandatory: true, action: "stop", code: "unpinned" });
    expect(p.unresolved.find((u) => u.id === "a")).toMatchObject({ code: "blocked", action: "stop" });
  });

  it("an invalid include/exclude list stops with its own reason", () => {
    const p = plan(reg(), [], policy(), { include: ["Bad Id"] });
    expect(p).toMatchObject({ action: "stop", reason: "skills not resolved: skills.selection include/exclude is not valid" });
  });

  it("a warn item and a stop item together stop, and the warning stays listed", () => {
    const p = plan(reg(sk("a", { pin: "unpinned" })), ["some-style", "a"], policy({ unknown: "warn" }));
    expect(p.action).toBe("stop");
    expect(p.warnings).toHaveLength(1);
    expect(p.reason).toContain("a [unpinned]");
    expect(p.reason).not.toContain("some-style");
  });

  it("continues when everything resolved", () => {
    const p = plan(reg(sk("a")), ["a"]);
    expect(p).toMatchObject({ action: "continue", unresolved: [], warnings: [] });
    expect(p.reason).toBeUndefined();
    expect(p.selected).toEqual([{ id: "a", version: "1.0.0", digest: `sha256:${"a".repeat(64)}` }]);
  });

  it("lists at most three items in the reason", () => {
    const p = plan(reg(), ["a", "b", "c", "d", "e"]);
    expect(p.reason).toContain("5 skill(s) cannot be used");
    expect(p.reason!.endsWith("(+2 more)")).toBe(true);
    expect(p.reason!.match(/\[unknown\]/g)).toHaveLength(3);
  });

  it("works from the config options of a real resolution", () => {
    const c = ConfigSchema.parse({ skills: { selection: { exclude: ["a"] } } }).skills;
    const r = reg(sk("a"));
    const res: SkillResolution = resolveSkills(r, ["a"], resolveOptionsFrom(c));
    const items: UnresolvedSkill[] = assessSkills(res, r, c.unresolved).unresolved;
    expect(items[0]).toMatchObject({ code: "excluded" });
  });
});

describe("config", () => {
  it("defaults to stop for every kind and the default terms", () => {
    const u = ConfigSchema.parse({}).skills.unresolved;
    for (const k of UNRESOLVED_KINDS) expect(u[k]).toBe("stop");
    expect(u.high_risk).toEqual(expect.arrayContaining(["migrations", "security", "messaging"]));
  });
  it("refuses a bad action, a bad term and an unknown key", () => {
    for (const bad of [{ unknown: "ignore" }, { high_risk: ["Not A Slug"] }, { other: 1 }])
      expect(ConfigSchema.safeParse({ skills: { unresolved: bad } }).success).toBe(false);
  });
});
