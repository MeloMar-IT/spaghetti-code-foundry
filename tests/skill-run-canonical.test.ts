import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigSchema } from "../src/config.js";
import { canonicalFromRegistered } from "../src/skills/canonical-facts.js";
import type { CanonicalResolution } from "../src/skills/canonical.js";
import { choiceStop } from "../src/skills/choices.js";
import type { ProjectPinsRead } from "../src/skills/project-pins.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { resolveSkills } from "../src/skills/resolve.js";
import {
  CANONICAL_UNCHECKED, canonicalRecord, canonicalResolve, liveCanonicalDeps, lockCanonical, startChoices, usableFor, type CanonicalDeps,
} from "../src/skills/run-canonical.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "run-canonical-"));
  dirs.push(d);
  return d;
};

function sk(id: string, o: { source?: string; caps?: string[]; deps?: string[]; text?: string; needs?: boolean; composable?: string[] } = {}): RegisteredSkill {
  return {
    key: `${id}@1.0.0`, id, version: "1.0.0", source: o.source ?? "admin", label: "data folder", dir: "/d", active: true, trust: "approved", pin: "pinned",
    digest: `sha256:${"a".repeat(64)}`,
    pkg: {
      id, version: "1.0.0", description: `About ${id}.`, instructions: o.text ?? "Do it.", roles: [], dependencies: (o.deps ?? []).map((d) => ({ id: d })), conflicts: [],
      capabilities: o.caps ?? ["cap"], composable: o.composable ?? [], category: "general", risk: "low", ...(o.needs ? { tool_profile: { shell: true } } : {}),
    },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] });
const config = (selection: Record<string, unknown> = {}, rest: Record<string, unknown> = {}) => ConfigSchema.parse({ skills: { selection, ...rest } });
const deps = (o: Partial<CanonicalDeps> = {}, highRisk: string[] = []): CanonicalDeps => ({ policy: { exclusive: ["cap"], highRisk }, candidate: (s) => canonicalFromRegistered(s), ...o });
const opts = { role: "coder" as const };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const pins = (target: string): ProjectPinsRead => ({
  state: "ok", items: [{ capability: "cap", target, by: "@o", reason: "r", from: "2026-01-01T00:00:00Z", expires: "2027-01-01T00:00:00Z" }], source: { commit: "c".repeat(40), blob: "d".repeat(40) },
});

describe("liveCanonicalDeps", () => {
  it("is undefined without exclusive capabilities, and reads nothing", () => {
    const readPins = vi.fn();
    expect(liveCanonicalDeps({ config: config(), workdir: "/w", home: tmp() }, { readPins })).toBeUndefined();
    expect(readPins).not.toHaveBeenCalled();
  });

  it("builds the policy and the candidate from the config", () => {
    const c = config({ exclusive: ["cap"] }, { unresolved: { high_risk: ["cap", "x"] }, tools: { shell: false } });
    const d = liveCanonicalDeps({ config: c, home: tmp() })!;
    expect(d.policy).toEqual({ exclusive: ["cap"], highRisk: ["cap", "x"] });
    const s = sk("a", { needs: true });
    expect(d.candidate(s)).toEqual(canonicalFromRegistered(s, { tools: c.skills.tools }));
    expect(d.candidate(s)!.failed).toEqual(["tools"]);
  });

  it("reads the overrides file: missing is none, a valid file gives items, a broken file is flagged", () => {
    const c = config({ exclusive: ["cap"] });
    const home = tmp();
    expect(liveCanonicalDeps({ config: c, home })!.choices).toEqual({});
    writeFileSync(
      join(home, "skill-overrides.yaml"),
      'schema: 1\noverrides:\n  - capability: cap\n    target: a@1.0.0\n    by: "@o"\n    reason: r\n    from: 2026-01-01T00:00:00Z\n    expires: 2027-01-01T00:00:00Z\n    scope: all\n',
    );
    expect(liveCanonicalDeps({ config: c, home })!.choices?.overrides).toHaveLength(1);
    writeFileSync(join(home, "skill-overrides.yaml"), "not: [valid");
    const bad = liveCanonicalDeps({ config: c, home })!;
    expect(bad.choices).toEqual({ overridesInvalid: true });
    const stop = choiceStop(startChoices(bad).known)!;
    expect(stop).toContain("skill-overrides.yaml");
    expect(stop).not.toContain(".claude-factory/skill-pins.yaml");
  });

  it("passes the work tree, repository and time on; without a work tree there are no pins", () => {
    const c = config({ exclusive: ["cap"] });
    const result = pins("a@1.0.0");
    const readPins = vi.fn(() => result);
    const d = liveCanonicalDeps({ config: c, workdir: "/w", home: tmp(), repository: "o/r", now: NOW }, { readPins })!;
    expect(readPins).toHaveBeenCalledWith("/w");
    expect(d.choices).toMatchObject({ pins: result, repository: "o/r", now: NOW });
    expect(liveCanonicalDeps({ config: c, home: tmp() }, { readPins })!.choices).not.toHaveProperty("pins");
  });
});

describe("canonicalRecord", () => {
  const ref = (id: string) => ({ id, version: "1.0.0", fingerprint: "fp", tier: "local" as const });
  const res = (o: Partial<CanonicalResolution>): CanonicalResolution => ({ capability: "cap", outcome: "selected", highRisk: false, companions: [], rejected: [], ignored: [], ...o });

  it("keeps five rejected entries and counts the rest", () => {
    const rejected = Array.from({ length: 7 }, (_, i) => ({ ...ref(`r${i}`), code: "outranked" as const, level: "trust-tier" as const }));
    const [r] = canonicalRecord([res({ winner: ref("w"), decidedBy: "trust-tier", rejected })]);
    expect(r!.winner).toBe("w@1.0.0");
    expect(r!.rejected).toHaveLength(5);
    expect(r!.rejected[0]).toEqual({ skill: "r0@1.0.0", code: "outranked", level: "trust-tier" });
    expect(r!.rejectedOmitted).toBe(2);
  });

  it("lists companions as id@version, and only when there are some", () => {
    const [r] = canonicalRecord([res({ winner: ref("w"), companions: [ref("c1"), ref("c2")] })]);
    expect(r!.companions).toEqual(["c1@1.0.0", "c2@1.0.0"]);
    const [plain] = canonicalRecord([res({ winner: ref("w") })]);
    expect(plain).not.toHaveProperty("companions");
  });

  it("leaves out a capability with nothing to say, keeps ignored choices, and holds no free text", () => {
    const ignored = [{ level: "owner-override" as const, value: "x@1.0.0", reason: "not-a-candidate" as const }];
    const out = canonicalRecord({ resolutions: [res({ outcome: "none" }), res({ capability: "other", outcome: "none", ignored, message: "free text", rejected: [{ ...ref("q"), code: "outranked" }] })] } as never);
    expect(out.map((r) => r.capability)).toEqual(["other"]);
    expect(out[0]!.ignored).toEqual(ignored);
    expect(JSON.stringify(out)).not.toMatch(/message|fingerprint|free text/);
  });
});

describe("lockCanonical and canonicalResolve", () => {
  const lock = (registry: ReturnType<typeof reg>, ids: string[], d: CanonicalDeps, include: string[] = []) => {
    const o = { ...opts, include };
    return lockCanonical({ reg: registry, resolution: resolveSkills(registry, ids, o), mandatory: include, deps: d, start: startChoices(d), usable: usableFor(registry, o) });
  };
  const a = () => sk("a", { source: "admin" });
  const b = () => sk("b", { source: "builtin" });

  it("drops a requested loser", () => {
    expect(lock(reg(a(), b()), ["a", "b"], deps())).toMatchObject({ drop: ["b"] });
  });

  it("blocks on a dependency loser and names the requiring skill", () => {
    const r = lock(reg(a(), b(), sk("c", { caps: ["other"], deps: ["b"] })), ["a", "c"], deps());
    expect(r).toHaveProperty("blocked");
    expect((r as { blocked: string }).blocked).toContain('"b" is loaded as a dependency of "c"');
  });

  it("keeps one of two merged copies and drops the other", () => {
    const x = sk("x", { text: "Same." });
    const y = { ...sk("y", { text: "Same." }), pkg: { ...sk("y", { text: "Same." }).pkg, description: x.pkg.description } } as RegisteredSkill;
    const r = lock(reg(x, y), ["x", "y"], deps());
    expect(r).toHaveProperty("drop");
    expect((r as { drop: string[] }).drop).toHaveLength(1);
  });

  it("does not let a requested copy stand in for the canonical representative that was chosen by an override", () => {
    const x = sk("a", { text: "Same." });
    const y = { ...sk("b", { text: "Same." }), pkg: { ...sk("b", { text: "Same." }).pkg, description: x.pkg.description } } as RegisteredSkill;
    const override = { capability: "cap", target: "a@1.0.0", by: "@o", reason: "r", from: "2026-01-01T00:00:00Z", expires: "2027-01-01T00:00:00Z", scope: "all" as const };
    const d = deps({ choices: { overrides: [override], now: NOW } });
    expect(lock(reg(x, y), ["b"], d)).toMatchObject({ drop: ["b"] });
    // a mandatory copy cannot be dropped, so it blocks
    const m = lock(reg(x, y), ["b"], d, ["b"]);
    expect(m).toHaveProperty("blocked");
  });

  it("judges a usable pin target that was not requested, and stops on one that is not usable", () => {
    const registry = reg(a(), b());
    const ok = lock(registry, ["b"], deps({ choices: { pins: pins("a@1.0.0"), now: NOW } }));
    expect(ok).toMatchObject({ drop: ["b"] });
    const gone = lock(registry, ["b"], deps({ choices: { pins: pins("zzz@1.0.0"), now: NOW } }));
    expect((gone as { blocked: string }).blocked).toContain("zzz@1.0.0");
  });

  it("is blocked as unchecked when the candidate throws", () => {
    const r = lock(reg(a(), b()), ["a", "b"], deps({ candidate: () => { throw new Error("boom"); } }));
    expect(r).toEqual({ blocked: CANONICAL_UNCHECKED });
  });

  it("keeps the decision that caused a drop, with the rejected skill, after the second round", () => {
    const r = canonicalResolve({ reg: reg(a(), b()), ids: ["a", "b"], opts, deps: deps() });
    if (!("record" in r)) throw new Error("expected a record");
    expect(r.dropped).toEqual(["b"]);
    expect(r.resolution.selected.map((s) => s.id)).toEqual(["a"]);
    expect(r.record[0]).toMatchObject({ winner: "a@1.0.0", decidedBy: "trust-tier", rejected: [{ skill: "b@1.0.0", code: "outranked", level: "trust-tier" }] });
  });

  describe("companions", () => {
    const text = "Long instructions. ".repeat(100);
    // z wins on the tier; "a" sorts first but is a companion and must be loaded after it.
    const win = (composable = true) => sk("z", { source: "admin", text, composable: composable ? ["cap"] : [] });
    const comp = (composable = true) => sk("a", { source: "builtin", text: `${text} More.`, composable: composable ? ["cap"] : [] });
    const resolve = (registry: ReturnType<typeof reg>, ids: string[], limits?: { maxTokens: number }) => {
      const r = canonicalResolve({ reg: registry, ids, opts: { ...opts, ...(limits ? { limits } : {}) }, deps: deps() });
      if (!("record" in r)) throw new Error("expected a record");
      return r;
    };

    it("loads the winner first, then the companion, and records it", () => {
      const r = resolve(reg(comp(), win()), ["a", "z"]);
      expect(r.resolution.selected.map((s) => s.id)).toEqual(["z", "a"]);
      expect(r.dropped).toEqual([]);
      expect(r.record[0]).toMatchObject({ winner: "z@1.0.0", companions: ["a@1.0.0"] });
      expect(r.record[0]!.rejected).toEqual([]);
    });

    it("leaves the companion out as over-budget when only the winner fits, and never the winner", () => {
      const r = resolve(reg(comp(), win()), ["a", "z"], { maxTokens: 700 });
      expect(r.resolution.selected.map((s) => s.id)).toEqual(["z"]);
      expect(r.resolution.decisions.find((d) => d.id === "a")).toMatchObject({ outcome: "rejected", code: "over-budget" });
      expect(r.dropped).toEqual([]);
    });

    it("keeps the winner first when a request needs the companion as a dependency", () => {
      const helper = sk("a-helper", { source: "admin", caps: [], deps: ["a"], text: "x" });
      const r = resolve(reg(helper, comp(), win()), ["a", "a-helper", "z"], { maxTokens: 700 });
      expect(r.resolution.selected.map((s) => s.id)).toEqual(["z"]);
    });

    it("holds back a request that needs the companion only as a dependency", () => {
      const helper = sk("a-helper", { source: "admin", caps: [], deps: ["a"], text: "x" });
      const r = resolve(reg(helper, comp(), win()), ["a-helper", "z"], { maxTokens: 700 });
      expect(r.resolution.selected.map((s) => s.id)).toEqual(["z"]);
      expect(r.record[0]).toMatchObject({ winner: "z@1.0.0" });
      const roomy = resolve(reg(helper, comp(), win()), ["a-helper", "z"]);
      expect(roomy.resolution.selected.map((s) => s.id)).toEqual(["z", "a", "a-helper"]);
    });

    it("orders a companion that wins another capability after the winner it accompanies", () => {
      const both = (): CanonicalDeps => deps({ policy: { exclusive: ["cap", "other"], highRisk: [] } });
      const dual = sk("a", { source: "builtin", caps: ["cap", "other"], text, composable: ["cap"] });
      const run = (limits?: { maxTokens: number }) => {
        const r = canonicalResolve({ reg: reg(dual, win()), ids: ["a", "z"], opts: { ...opts, ...(limits ? { limits } : {}) }, deps: both() });
        if (!("record" in r)) throw new Error("expected a record");
        return r;
      };
      expect(run().resolution.selected.map((s) => s.id)).toEqual(["z", "a"]);
      const tight = run({ maxTokens: 700 });
      expect(tight.resolution.selected.map((s) => s.id)).toEqual(["z"]);
      expect(tight.record.find((x) => x.capability === "cap")).toMatchObject({ winner: "z@1.0.0" });
    });

    it("drops a provider that does not declare it", () => {
      const r = resolve(reg(comp(false), win()), ["a", "z"]);
      expect(r.dropped).toEqual(["a"]);
      expect(r.resolution.selected.map((s) => s.id)).toEqual(["z"]);
      const one = resolve(reg(comp(), win(false)), ["a", "z"]);
      expect(one.dropped).toEqual(["a"]);
    });

    it("tells mirrors apart by what they declare", () => {
      // Same text; one declares composable, one does not: they are not merged, so the companion is judged on its own.
      const x = sk("a", { source: "builtin", text, composable: ["cap"] });
      const y = { ...sk("a2", { source: "builtin", text, composable: [] }), pkg: { ...sk("a2", { text, composable: [] }).pkg, description: x.pkg.description } } as RegisteredSkill;
      const r = resolve(reg(x, y, win()), ["a", "z"]);
      expect(r.resolution.selected.map((s) => s.id)).toEqual(["z", "a"]);
    });
  });

  it("keeps a pin-resolved decision", () => {
    const d = deps({ choices: { pins: pins("b@1.0.0"), now: NOW } }, ["cap"]);
    const r = canonicalResolve({ reg: reg(a(), sk("b", { source: "admin" })), ids: ["a", "b"], opts, deps: d });
    if (!("record" in r)) throw new Error("expected a record");
    expect(r.dropped).toEqual(["a"]);
    expect(r.record[0]).toMatchObject({ winner: "b@1.0.0", decidedBy: "project-pin", rejected: [{ skill: "a@1.0.0" }] });
  });
});
