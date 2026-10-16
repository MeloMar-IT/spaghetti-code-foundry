import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { runSkillCatalogue } from "../src/skills/run-catalogue.js";
import { resolveSkills, type SkillResolution } from "../src/skills/resolve.js";
import { assessSkills } from "../src/skills/unresolved.js";

// How the lifecycle of a skill version changes what a new plan can select (reason code `ineligible`).

const life = (state: string, o: { replacement?: string; reason?: string } = {}) => ({
  state, seq: 1, since: "2026-01-01T00:00:00.000Z", by: "cli", reason: o.reason ?? "r", allowedRuns: [], ...(o.replacement ? { replacement: o.replacement } : {}),
});
function sk(id: string, o: { version?: string; trust?: string; deps?: string[]; state?: string; replacement?: string; reason?: string; active?: boolean } = {}): RegisteredSkill {
  const version = o.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: "admin", label: "x", dir: "/secret/dir", active: o.active ?? true,
    trust: o.trust ?? "approved", pin: "pinned", digest: `sha256:${"a".repeat(64)}`,
    ...(o.state ? { lifecycle: life(o.state, o) } : {}),
    pkg: {
      id, version, description: `About ${id}.`, instructions: "Do it.", roles: [], dependencies: (o.deps ?? []).map((d) => ({ id: d })),
      conflicts: [], category: "general", capabilities: [], risk: "low",
    },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] as { kind: string }[] });
const dec = (r: SkillResolution, id: string) => r.decisions.find((d) => d.id === id)!;
const policy = ConfigSchema.parse({}).skills.unresolved;
const plan = (r: ReturnType<typeof reg>, ids: string[]) => assessSkills(resolveSkills(r as never, ids), r as never, policy);

describe("resolveSkills", () => {
  it("rejects a quarantined, revoked or retired version as ineligible, and selects a deprecated one", () => {
    for (const state of ["quarantined", "revoked", "retired"]) {
      const r = resolveSkills(reg(sk("a", { state })) as never, ["a"]);
      expect(dec(r, "a"), state).toMatchObject({ outcome: "rejected", code: "ineligible", version: "1.0.0" });
    }
    expect(resolveSkills(reg(sk("a", { state: "deprecated" })) as never, ["a"]).selected.map((s) => s.id)).toEqual(["a"]);
  });

  it("makes a dependency ineligible, with the cause", () => {
    const r = resolveSkills(reg(sk("a", { deps: ["b"] }), sk("b", { state: "retired" })) as never, ["a"]);
    expect(dec(r, "a")).toMatchObject({ outcome: "rejected", code: "dependency-unavailable", cause: "ineligible", via: "b" });
  });

  it("makes every approved and built-in id ineligible when the record cannot be read", () => {
    const base = reg(sk("a"), sk("b", { trust: "builtin" }), sk("c", { trust: "unapproved" }));
    const r = resolveSkills({ ...base, problems: [{ kind: "lifecycle" }] } as never, ["a", "b", "c"]);
    expect(dec(r, "a").code).toBe("ineligible");
    expect(dec(r, "b").code).toBe("ineligible");
    expect(dec(r, "c").code).toBe("unapproved");
  });

  it("does not fall back to another version of the same id", () => {
    const r = resolveSkills(reg(sk("a", { version: "2.0.0", state: "retired" }), sk("a", { version: "1.0.0", active: false })) as never, ["a"]);
    expect(dec(r, "a")).toMatchObject({ code: "ineligible", version: "2.0.0" });
    expect(r.selected).toEqual([]);
  });
});

describe("the message", () => {
  it("names the state and the replacement", () => {
    const u = plan(reg(sk("kafka", { state: "retired", replacement: "kafka@2.0.0" })), ["kafka"]).unresolved[0]!;
    expect(u).toMatchObject({ code: "ineligible", kind: "untrusted" });
    expect(u.message).toBe("kafka@1.0.0 is retired (replaced by kafka@2.0.0). Use the replacement or another skill, then plan again.");
  });

  it("names the dependency, not the skill that needs it", () => {
    const u = plan(reg(sk("a", { deps: ["kafka"] }), sk("kafka", { state: "quarantined" })), ["a"]).unresolved[0]!;
    expect(u).toMatchObject({ code: "dependency-unavailable", cause: "ineligible", kind: "untrusted" });
    expect(u.message).toContain("kafka@1.0.0 is quarantined");
  });

  it("never repeats the reason of the administrator", () => {
    const u = plan(reg(sk("kafka", { state: "retired", reason: "daily budget usage limit reached" })), ["kafka"]).unresolved[0]!;
    expect(u.message).not.toMatch(/daily budget|usage limit/i);
  });

  it("says when the record cannot be read", () => {
    const r = { ...reg(sk("kafka")), problems: [{ kind: "lifecycle" }] };
    expect(plan(r, ["kafka"]).unresolved[0]!.message).toBe(
      "kafka@1.0.0 cannot be checked because the skill lifecycle record cannot be read. Fix skill-lifecycle.jsonl, then plan again.",
    );
  });
});

describe("the catalogue", () => {
  const empty = mkdtempSync(join(tmpdir(), "lifecycle-catalogue-"));
  afterAll(() => rmSync(empty, { recursive: true, force: true }));
  it("does not offer a retired skill, does not count it as hidden, and offers a deprecated one", () => {
    const skills = [sk("old", { state: "retired" }), sk("warn", { state: "deprecated" }), sk("fine")];
    const r = runSkillCatalogue({ workdir: "/work", config: ConfigSchema.parse({}), task: "" }, { discover: () => reg(...skills) as never, profile: () => buildRepoProfile(empty) });
    const ids = r.text.split("\n").filter((l) => l.startsWith("{")).map((l) => (JSON.parse(l) as { id: string }).id).sort();
    expect(ids).toEqual(["fine", "warn"]);
    expect(r.record?.hidden).toBeUndefined();
  });
});
