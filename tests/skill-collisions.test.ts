import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COLLISION_CLASSES, COLLISION_REASONS, type CollisionReason } from "../src/skills/collision-rules.js";
import {
  classifySkillCollisions, collisionCandidate, dedupeOffered, plannerPackages,
  type CollisionCandidate, type CollisionResult,
} from "../src/skills/collisions.js";
import { normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";
import type { SkillLibrarySource } from "../src/skills/sources.js";

type F = { path: string; content: Uint8Array };
const A: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) };
const B: NormalizeOrigin = { source: "mir", repository: "https://github.com/other/skills", repositoryKey: "github.com/other/skills", commit: "b".repeat(40) };
const C: NormalizeOrigin = { source: "third", repository: "https://github.com/third/skills", repositoryKey: "github.com/third/skills", commit: "c".repeat(40) };

const f = (path: string, text: string): F => ({ path, content: new Uint8Array(Buffer.from(text)) });
const doc = (name: string, extra = "", body = "\nDo the work.\n") => [f("SKILL.md", `---\nname: ${name}\ndescription: About ${name}.\n${extra}---\n${body}`)];
function readDir(dir: string, base = ""): F[] {
  return readdirSync(dir).sort().flatMap((n) => {
    const rel = base ? `${base}/${n}` : n;
    return statSync(join(dir, n)).isDirectory() ? readDir(join(dir, n), rel) : [{ path: rel, content: new Uint8Array(readFileSync(join(dir, n))) }];
  });
}
const FIX = "tests/fixtures/skill-identity";
const overlay = (base: F[], variant: F[]): F[] => [...base.filter((b) => !variant.some((v) => v.path === b.path)), ...variant];
const original = () => readDir(join(FIX, "original"));
const variant = (name: string) => overlay(original(), readDir(join(FIX, name)));
const skillMd = (files: F[]) => Buffer.from(files.find((x) => x.path === "SKILL.md")?.content ?? new Uint8Array()).toString();
const edit = (files: F[], from: string, to: string) => overlay(files, [f("SKILL.md", skillMd(files).replace(from, to))]);
const withYaml = (files: F[], yaml: string) => overlay(files, [f("skill.yaml", yaml)]);

function skill(files: F[], origin: NormalizeOrigin = A, root = "skills/notes"): NormalizedSkill {
  const r = normalizeSkill(origin, { root, files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
}
interface Opts { origin?: NormalizeOrigin; root?: string; approved?: boolean; forkOf?: string; evaluation?: "passed" | "failed" }
function cand(files: F[], o: Opts = {}): CollisionCandidate {
  return {
    skill: skill(files, o.origin, o.root), approved: o.approved ?? true, trust: "verified", licencesAllowed: ["MIT"],
    ...(o.forkOf !== undefined ? { forkOf: o.forkOf } : {}), ...(o.evaluation !== undefined ? { evaluation: o.evaluation } : {}),
  };
}
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};
const only = (r: CollisionResult) => {
  expect(r.report.collisions).toHaveLength(1);
  return must(r.report.collisions[0]);
};

// One scenario for each reason. The tests below and the coverage test use the same list.
const SCENARIOS: Record<CollisionReason, () => CollisionCandidate[]> = {
  "mirror.settings-differ": () => [cand(withYaml(original(), "capabilities: [one]\n")), cand(withYaml(original(), "capabilities: [two]\n"), { origin: B })],
  "mirror.same-artifact": () => [cand(original()), cand(original(), { origin: { ...A, source: "lib2" } })],
  "mirror.same-content": () => [cand(original()), cand(variant("mirror"), { origin: B })],
  "version.reused": () => [cand(original()), cand(variant("reused-version"))],
  "id.other-version": () => [cand(original()), cand(edit(variant("fork-changed"), "1.2.0", "2.0.0"))],
  "id.other-upstream": () => {
    const x = cand(original());
    const y = cand(variant("fork-changed"), { origin: B });
    const other = { ...y.skill, identity: { ...y.skill.identity, id: x.skill.identity.id } };
    return [x, { ...y, skill: other }];
  },
  "fork.declared-upstream": () => [cand(original()), cand(doc("renamed", "version: 1.0.0\n", "\nOther.\n"), { origin: B, forkOf: A.repositoryKey })],
  "fork.same-name": () => [cand(original()), cand(variant("fork-changed"), { origin: B })],
  "capability.shared": () => [cand(doc("one", "capabilities: [shared-cap, only-one]\n")), cand(doc("two", "capabilities: [shared-cap, only-two]\n", "\nOther.\n"), { origin: B })],
};

describe("collisions: control and classes", () => {
  it("finds no collision between different skills", () => {
    const r = classifySkillCollisions([cand(doc("alpha")), cand(doc("beta", "", "\nOther work.\n"), { origin: B })]);
    expect(r.report.collisions).toEqual([]);
    expect(r.entries).toHaveLength(2);
    expect(plannerPackages(r)).toHaveLength(2);
    expect(r.report).toMatchObject({ schema: 1, candidates: 2, entries: 2 });
  });

  it("mirror.same-artifact: one repository through two source records is one entry with two provenance records", () => {
    const r = classifySkillCollisions(SCENARIOS["mirror.same-artifact"]());
    expect(only(r)).toMatchObject({ class: "exact-mirror", reason: "mirror.same-artifact", blocking: false });
    expect(r.entries).toHaveLength(1);
    expect(must(r.entries[0]).provenance).toHaveLength(2);
    expect(plannerPackages(r)).toHaveLength(1);
  });

  it("mirror.same-content: other repository is one entry; three mirrors are one collision", () => {
    const r = classifySkillCollisions(SCENARIOS["mirror.same-content"]());
    expect(only(r).reason).toBe("mirror.same-content");
    expect(r.entries).toHaveLength(1);
    const three = classifySkillCollisions([cand(original()), cand(variant("mirror"), { origin: B }), cand(original(), { origin: C })]);
    expect(only(three).members).toHaveLength(3);
    expect(three.entries).toHaveLength(1);
    expect(must(three.entries[0]).provenance).toHaveLength(3);
  });

  describe("mirror.settings-differ", () => {
    const cases: [string, string, string][] = [
      ["capabilities", "capabilities: [one]\n", "capabilities: [two]\n"],
      ["dependencies", "dependencies: [x-dep]\n", "dependencies: [y-dep]\n"],
      ["tool profile", "tool_profile: { shell: true, network: false, filesystem: read }\n", "tool_profile: { shell: false, network: false, filesystem: read }\n"],
      ["technologies", "technologies: [node]\n", "technologies: [bun]\n"],
      ["tools that give the same profile", "tools: [Read]\n", "tools: [Glob]\n"],
    ];
    for (const [label, one, two] of cases) {
      it(`holds back mirrors that differ in ${label}`, () => {
        const a = cand(withYaml(original(), one));
        const b = cand(withYaml(original(), two), { origin: B });
        expect(a.skill.identity.fingerprint).toBe(b.skill.identity.fingerprint);
        const r = classifySkillCollisions([a, b]);
        expect(only(r)).toMatchObject({ reason: "mirror.settings-differ", blocking: true });
        expect(r.entries).toHaveLength(1);
        expect(must(r.entries[0]).settings).toBe("differ");
        expect(plannerPackages(r)).toEqual([]);
        expect(only(r).members.map((m) => m.settings)).toHaveLength(2);
        expect(only(r).members.map((m) => m.capabilities)).toHaveLength(2);
        // An unapproved member that differs does not count.
        const quiet = classifySkillCollisions([a, { ...b, approved: false }]);
        expect(must(quiet.entries[0]).settings).toBe("same");
        expect(only(quiet).reason).not.toBe("mirror.settings-differ");
        expect(plannerPackages(quiet)).toHaveLength(1);
      });
    }
    it("compares what a dependency points to when it is known", () => {
      const files = withYaml(original(), "dependencies: [helper]\n");
      const a = cand(files);
      const b = cand(files, { origin: B });
      const dep = (c: CollisionCandidate, fp: string): CollisionCandidate => {
        const id = must(c.skill.package.dependencies[0]).id;
        return { ...c, dependencyFingerprints: { [id]: fp } };
      };
      expect(must(classifySkillCollisions([a, b]).entries[0]).settings).toBe("same");
      expect(must(classifySkillCollisions([dep(a, "sha256:1"), dep(b, "sha256:1")]).entries[0]).settings).toBe("same");
      const r = classifySkillCollisions([dep(a, "sha256:1"), dep(b, "sha256:2")]);
      expect(must(r.entries[0]).settings).toBe("differ");
      expect(plannerPackages(r)).toEqual([]);
    });
    it("reports each member's capabilities and settings", () => {
      const m = only(classifySkillCollisions(SCENARIOS["mirror.settings-differ"]())).members;
      expect(m.map((x) => x.capabilities).sort()).toEqual([["one"], ["two"]]);
      expect(m.every((x) => x.settings.toolProfile.filesystem === "read")).toBe(true);
    });
    it("does not count undeclared versions as differing settings", () => {
      const files = doc("plain");
      const r = classifySkillCollisions([cand(files), cand(files, { origin: { ...A, commit: "c".repeat(40) }, approved: true })]);
      expect(must(r.entries[0]).settings).toBe("same");
      expect(plannerPackages(r)).toHaveLength(1);
    });
  });

  it("version.reused holds back both sides when both are approved", () => {
    const r = classifySkillCollisions(SCENARIOS["version.reused"]());
    expect(only(r)).toMatchObject({ class: "version-reuse", reason: "version.reused", blocking: true });
    expect(r.entries).toHaveLength(2);
    expect(plannerPackages(r)).toEqual([]);
    const [x, y] = SCENARIOS["version.reused"]();
    const half = classifySkillCollisions([x!, { ...must(y), approved: false }]);
    expect(only(half).blocking).toBe(false);
    expect(plannerPackages(half)).toHaveLength(1);
  });

  it("id.other-version blocks only when both are approved", () => {
    const [x, y] = SCENARIOS["id.other-version"]();
    const r = classifySkillCollisions([must(x), must(y)]);
    expect(only(r)).toMatchObject({ class: "id-conflict", reason: "id.other-version", blocking: true });
    expect(plannerPackages(r)).toEqual([]);
    const pending = classifySkillCollisions([must(x), { ...must(y), approved: false }]);
    expect(only(pending).blocking).toBe(false);
    expect(plannerPackages(pending)).toHaveLength(1);
  });

  it("id.other-upstream: the same id from another repository", () => {
    expect(only(classifySkillCollisions(SCENARIOS["id.other-upstream"]()))).toMatchObject({ class: "id-conflict", reason: "id.other-upstream", blocking: true });
  });

  it("fork.same-name keeps both offered", () => {
    const r = classifySkillCollisions(SCENARIOS["fork.same-name"]());
    expect(only(r)).toMatchObject({ class: "fork", reason: "fork.same-name", blocking: false });
    expect(plannerPackages(r)).toHaveLength(2);
  });

  it("fork.declared-upstream wins over fork.same-name", () => {
    expect(only(classifySkillCollisions(SCENARIOS["fork.declared-upstream"]())).reason).toBe("fork.declared-upstream");
    const both = [cand(original()), cand(variant("fork-changed"), { origin: B, forkOf: A.repositoryKey })];
    expect(only(classifySkillCollisions(both)).reason).toBe("fork.declared-upstream");
    const reverse = [cand(original(), { forkOf: B.repositoryKey }), cand(variant("fork-changed"), { origin: B })];
    expect(only(classifySkillCollisions(reverse)).reason).toBe("fork.declared-upstream");
  });

  it("capability.shared lists the shared slugs", () => {
    const c = only(classifySkillCollisions(SCENARIOS["capability.shared"]()));
    expect(c).toMatchObject({ class: "capability-overlap", reason: "capability.shared", shared: ["shared-cap"], blocking: false });
  });

  it("gives one collision per pair, by precedence", () => {
    const caps = edit(original(), "version: 1.2.0", "version: 1.2.0\ncapabilities: [shared]");
    const r = classifySkillCollisions([cand(caps), cand(overlay(caps, readDir(join(FIX, "reused-version"))))]);
    expect(only(r).class).toBe("version-reuse");

    const other = edit(variant("fork-changed"), "1.2.0", "1.3.0");
    const mixed = classifySkillCollisions([cand(original()), cand(variant("mirror"), { origin: B }), cand(other, { origin: B })]);
    const kinds = mixed.report.collisions.map((c) => c.reason);
    expect(kinds).toContain("id.other-version");
    expect(kinds.filter((k) => k.startsWith("fork."))).toEqual([]);
  });

  it("does not let an unapproved copy hold back an approved skill", () => {
    const x = cand(original());
    const y = cand(variant("mirror"), { origin: B, approved: false });
    const z = cand(variant("reused-version"), { origin: B });
    const r = classifySkillCollisions([x, y, z]);
    const reused = r.report.collisions.find((c) => c.reason === "version.reused");
    expect(reused).toMatchObject({ blocking: false });
    expect(r.entries.every((e) => e.blockedBy.length === 0)).toBe(true);
    expect(plannerPackages(r)).toHaveLength(2);
  });
});

describe("collisions: merging", () => {
  it("keeps only approved provenance and counts the others", () => {
    const r = classifySkillCollisions([cand(original()), cand(variant("mirror"), { origin: B, approved: false })]);
    const e = must(r.entries[0]);
    expect(e.provenance.map((p) => p.source)).toEqual(["lib"]);
    expect(e).toMatchObject({ unapproved: 1, approved: true });
    expect(e.skill.provenance.source).toBe("lib");
    const none = classifySkillCollisions([cand(original(), { approved: false }), cand(original(), { origin: B, approved: false })]);
    expect(none.entries).toHaveLength(1);
    expect(none.entries[0]).toMatchObject({ approved: false, provenance: [] });
    expect(plannerPackages(none)).toEqual([]);
  });

  it("chooses the representative whatever the input order", () => {
    const x = cand(original(), { approved: false });
    const y = cand(original(), { origin: B, approved: false });
    expect(must(classifySkillCollisions([x, y]).entries[0]).skill).toBe(must(classifySkillCollisions([y, x]).entries[0]).skill);
    const early = cand(original());
    const late = cand(original(), { origin: { ...A, commit: "d".repeat(40) } });
    for (const order of [[early, late], [late, early]]) expect(must(classifySkillCollisions(order).entries[0]).skill).toBe(early.skill);
    const first = cand(original(), { root: "skills/notes" });
    const second = cand(original(), { root: "skills/other" });
    for (const order of [[first, second], [second, first]]) expect(must(classifySkillCollisions(order).entries[0]).skill).toBe(first.skill);
  });

  it("keeps the representative as it was given, with its extra files", () => {
    const files = [...original(), f("LICENSE.txt", "MIT\n"), f("NOTES.md", "notes\n")];
    const lone = classifySkillCollisions([cand(files)]);
    expect(must(lone.entries[0]).skill.extraFiles.map((x) => x.path)).toEqual(["LICENSE.txt", "NOTES.md"]);
    const pair = classifySkillCollisions([cand(files), cand(files, { origin: B })]);
    const e = must(pair.entries[0]);
    expect(e.skill.extraFiles.map((x) => x.path)).toEqual(["LICENSE.txt", "NOTES.md"]);
  });

  it("never mixes different content and does not change its input", () => {
    const input = [...SCENARIOS["version.reused"](), ...SCENARIOS["mirror.same-content"](), ...SCENARIOS["capability.shared"]()];
    const before = structuredClone(input);
    const r = classifySkillCollisions(input);
    expect(input).toEqual(before);
    const digests = r.entries.map((e) => e.skill.package.digest);
    expect(new Set(digests).size).toBe(r.entries.length);
    for (const e of r.entries) {
      const src = input.find((c) => c.skill === e.skill);
      expect(src?.skill.package.instructions).toBe(e.skill.package.instructions);
    }
  });
});

describe("collisions: ids, order, closed lists", () => {
  const mixed = (): CollisionCandidate[] => [
    ...SCENARIOS["mirror.same-content"](), ...SCENARIOS["version.reused"](), ...SCENARIOS["fork.same-name"](), ...SCENARIOS["capability.shared"](),
    ...SCENARIOS["id.other-version"](), ...SCENARIOS["mirror.settings-differ"](),
  ];
  it("gives the same result for any input order", () => {
    const base = classifySkillCollisions(mixed());
    const list = mixed();
    expect(classifySkillCollisions([...list].reverse())).toEqual(base);
    for (let k = 1; k < list.length; k += 3) expect(classifySkillCollisions([...list.slice(k), ...list.slice(0, k)])).toEqual(base);
    for (const c of base.report.collisions) expect(c.id).toMatch(/^col-[0-9a-f]{16}$/);
  });

  it("pins one id", () => {
    expect(only(classifySkillCollisions(SCENARIOS["fork.same-name"]())).id).toBe("col-962dcaaa56aa832c");
  });

  it("uses only the closed lists, and the scenarios cover them all", () => {
    const classes = new Set<string>();
    const reasons = new Set<string>();
    for (const [reason, build] of Object.entries(SCENARIOS)) {
      for (const c of classifySkillCollisions(build()).report.collisions) {
        expect(COLLISION_CLASSES).toContain(c.class);
        expect(Object.keys(COLLISION_REASONS)).toContain(c.reason);
        classes.add(c.class);
        reasons.add(c.reason);
      }
      expect(reasons.has(reason)).toBe(true);
    }
    expect(classes.size).toBe(5);
    expect(reasons.size).toBe(9);
  });
});

describe("collisions: report", () => {
  it("lists the evidence of each member", () => {
    const c = cand(edit(original(), "license: MIT", "license: MIT\ncompatibility: Node 20"), { evaluation: "passed" });
    const [x, y] = [c, cand(variant("mirror"), { origin: B })];
    const m = must(only(classifySkillCollisions([x, y])).members.find((v) => v.source === "lib"));
    expect(m).toMatchObject({
      source: "lib", repository: A.repository, repositoryKey: A.repositoryKey, upstream: "github.com/example/skills#notes", version: "1.2.0",
      commit: A.commit, licence: "MIT", licencesAllowed: ["MIT"], trust: "verified", approved: true, compatibility: "Node 20",
      evaluation: { files: 0, result: "passed" },
    });
    expect(m.fingerprint).toMatch(/^sha256:/);
    expect(m.digest).toMatch(/^sha256:/);
  });

  it("escapes control characters and hides credential-like values", () => {
    const base = cand(original());
    const token = "ghp_" + "a1B2c3D4e5".repeat(4);
    const odd = { ...base, skill: { ...base.skill, package: { ...base.skill.package, license: "MIT\u0007x" } } };
    const copy = cand(original(), { origin: B });
    const secret = { ...copy, skill: { ...copy.skill, package: { ...copy.skill.package, license: token } } };
    const m = classifySkillCollisions([odd, secret]);
    const licences = m.report.collisions.flatMap((c) => c.members.map((v) => v.licence));
    expect(licences.join("|")).not.toContain("\u0007");
    expect(licences.join("|")).not.toContain(token);
    expect(licences).toContain("(hidden)");
  });
});

describe("collisions: edges", () => {
  it("handles empty input, repeated candidates and too many candidates", () => {
    expect(classifySkillCollisions([])).toEqual({ entries: [], report: { schema: 1, candidates: 0, entries: 0, collisions: [] } });
    const c = cand(original());
    const r = classifySkillCollisions([c, c]);
    expect(r.report.collisions).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ unapproved: 0 });
    const again = classifySkillCollisions([c, { ...c, evaluation: "failed" }]);
    expect(again.report.collisions).toEqual([]);
    expect(again.entries).toHaveLength(1);
    expect(classifySkillCollisions([{ ...c, evaluation: "failed" }, c])).toEqual(again);
    expect(() => classifySkillCollisions(Array.from({ length: 1001 }, () => c))).toThrow(RangeError);
    expect(classifySkillCollisions(Array.from({ length: 1000 }, () => c)).entries).toHaveLength(1);
  });
});

describe("collisionCandidate", () => {
  const source = (o: Partial<SkillLibrarySource> = {}): SkillLibrarySource => ({
    id: "lib", repository: A.repository, repositoryKey: A.repositoryKey, status: "enabled", ref: { approved: A.commit }, paths: ["skills"],
    adapter: "agent-skills", trust: "verified", licence: { allow: ["MIT"] }, update: { cadence: "manual" }, owner: "me", ...o,
  });
  const s = skill(original());
  it("is approved only for an enabled source and its approved commit", () => {
    expect(collisionCandidate(s, source())).toMatchObject({ approved: true, trust: "verified", licencesAllowed: ["MIT"] });
    expect(collisionCandidate(s, source({ status: "disabled" })).approved).toBe(false);
    expect(collisionCandidate(s, source({ ref: { approved: "b".repeat(40) } })).approved).toBe(false);
    expect(collisionCandidate(s, source({ ref: {} })).approved).toBe(false);
    expect(collisionCandidate(s, source(), { forkOf: "x", evaluation: "failed" })).toMatchObject({ forkOf: "x", evaluation: "failed" });
  });
  it("refuses a skill that does not belong to the record", () => {
    expect(() => collisionCandidate(s, source({ id: "other" }))).toThrow(TypeError);
    expect(() => collisionCandidate(s, source({ repositoryKey: "github.com/else/skills" }))).toThrow(TypeError);
  });
});

describe("dedupeOffered", () => {
  type Item = { name: string; c?: CollisionCandidate };
  const run = (items: Item[]) => dedupeOffered(items, (i) => i.c);
  it("keeps items without a candidate, merges mirrors and keeps the order", () => {
    const items: Item[] = [{ name: "legacy" }, { name: "x", c: cand(original()) }, { name: "mid" }, { name: "y", c: cand(variant("mirror"), { origin: B }) }];
    const r = run(items);
    expect(r.merged).toBe(1);
    expect(r.held).toBe(0);
    expect(r.kept.map((i) => i.name)).toHaveLength(3);
    expect(r.kept.filter((i) => !i.c).map((i) => i.name)).toEqual(["legacy", "mid"]);
  });
  it("holds back an unapproved copy of an offered unit", () => {
    const r = run([{ name: "x", c: cand(original()) }, { name: "y", c: cand(variant("mirror"), { origin: B, approved: false }) }]);
    expect(r.kept.map((i) => i.name)).toEqual(["x"]);
    expect(r.heldItems.map((i) => i.name)).toEqual(["y"]);
    expect(r.merged).toBe(0);
  });
  it("drops a blocked pair and an unapproved unit", () => {
    const [x, y] = SCENARIOS["version.reused"]();
    const r = run([{ name: "x", c: x }, { name: "y", c: y }, { name: "z", c: cand(doc("lone"), { approved: false }) }]);
    expect(r.kept).toEqual([]);
    expect(r.held).toBe(3);
    expect(r.heldItems.map((i) => i.name)).toEqual(["x", "y", "z"]);
  });
});
