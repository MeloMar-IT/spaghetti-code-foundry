import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config.js";
import type { CanonicalCandidate, CanonicalPolicy } from "../src/skills/canonical.js";
import type { RegisteredSkill } from "../src/skills/registry.js";
import { buildRepoProfile } from "../src/skills/repo-profile.js";
import { runSkillCatalogue } from "../src/skills/run-catalogue.js";

const digest = `sha256:${"a".repeat(64)}`;
function sk(id: string, o: { source?: string; version?: string; instructions?: string; description?: string } = {}): RegisteredSkill {
  const version = o.version ?? "1.0.0";
  return {
    key: `${id}@${version}`, id, version, source: o.source ?? "admin", label: "x", dir: "/d", active: true, trust: "approved", pin: "pinned", digest,
    pkg: {
      id, version, description: o.description ?? "Same.", instructions: o.instructions ?? "Same instructions.",
      roles: [], dependencies: [], conflicts: [], capabilities: [],
    },
  } as unknown as RegisteredSkill;
}
const reg = (...skills: RegisteredSkill[]) => ({ skills, byKey: new Map(skills.map((s) => [s.key, s])), problems: [] });
const empty = mkdtempSync(join(tmpdir(), "mirrors-catalogue-"));
afterAll(() => rmSync(empty, { recursive: true, force: true }));
const profile = () => buildRepoProfile(empty);
const cfg = (skills: Record<string, unknown> = {}) => ConfigSchema.parse({ skills });
const run = (skills: RegisteredSkill[], config = cfg()) =>
  runSkillCatalogue({ workdir: "/work/repo", config, task: "" }, { discover: () => reg(...skills), profile: () => profile() });
const ids = (text: string) => text.split("\n").filter((l) => l.startsWith("{")).map((l) => (JSON.parse(l) as { id: string }).id).sort();

describe("mirrors in the catalogue", () => {
  it("offers one entry for the same text and records the copy", () => {
    const r = run([sk("a"), sk("b")]);
    expect(ids(r.text)).toEqual(["a"]);
    expect(r.log).toContain("; 1 mirror collapsed");
    expect(r.record?.mirrors).toEqual([{ kept: "a@1.0.0", collapsed: ["b@1.0.0"] }]);
    expect(r.record?.mirrorsOmitted).toBeUndefined();
  });
  it("keeps the better tier, then the lower id, then the lower version", () => {
    expect(ids(run([sk("a", { source: "builtin" }), sk("z", { source: "admin" })]).text)).toEqual(["z"]);
  });
  it("does not depend on the discover order", () => {
    const skills = [sk("c"), sk("a", { source: "builtin" }), sk("b"), sk("d", { source: "builtin" })];
    const one = run(skills);
    const two = run([...skills].reverse());
    expect(two.text).toBe(one.text);
    expect(two.record).toEqual(one.record);
    expect(two.log).toBe(one.log);
  });
  it("does not collapse one different character", () => {
    const r = run([sk("a"), sk("b", { instructions: "Same instructions!" })]);
    expect(ids(r.text)).toEqual(["a", "b"]);
    expect(r.record).not.toHaveProperty("mirrors");
    expect(r.log).not.toContain("mirror");
  });
  it("records at most 50 collapsed ids and counts the rest", () => {
    const skills = Array.from({ length: 53 }, (_, n) => sk(`s${String(n).padStart(2, "0")}`));
    const r = run(skills, cfg({ selection: { max_skills: 1 } }));
    expect(r.record?.mirrors).toHaveLength(1);
    expect(r.record?.mirrors?.[0]?.collapsed).toHaveLength(50);
    expect(r.record?.mirrorsOmitted).toBe(2);
    expect(r.log).toContain("; 52 mirrors collapsed");
  });
  it("lets an excluded better copy take no part", () => {
    expect(ids(run([sk("a"), sk("b")], cfg({ catalogue: { exclude: ["a"] } })).text)).toEqual(["b"]);
  });
  it("moves an include of a copy to its representative", () => {
    const r = run([sk("a"), sk("b"), sk("c", { description: "Other.", instructions: "Other." })], cfg({ catalogue: { include: ["b"], max_candidates: 1 } }));
    expect(ids(r.text)).toEqual(["a"]);
  });
});

describe("mirrors with canonical selection", () => {
  const cc = (id: string, o: Partial<CanonicalCandidate> = {}): CanonicalCandidate => ({
    id, version: "1.0.0", fingerprint: `fp-${id}`, capabilities: ["cap"], category: "general", risk: "low", tier: "scf-curated",
    status: "approved", failed: [], compatibility: "generic", ...o,
  });
  const canon = (skills: RegisteredSkill[], cands: Record<string, CanonicalCandidate>, policy: Partial<CanonicalPolicy> = {}, config = cfg()) =>
    runSkillCatalogue(
      { workdir: "/work/repo", config, task: "" },
      {
        discover: () => reg(...skills),
        profile: () => profile(),
        canonical: { policy: { exclusive: ["cap"], highRisk: [], ...policy }, candidate: (s) => cands[s.id], withhold: (c) => c.failed.length > 0 },
      },
    );
  const other = sk("c", { description: "Other.", instructions: "Other." });

  it("does not let identical copies tie in a high-risk capability", () => {
    const r = canon([sk("a"), sk("b")], { a: cc("a"), b: cc("b") }, { highRisk: ["cap"] });
    expect(r.blocked).toBeUndefined();
    expect(r.canonical?.selected).toEqual(["a@1.0.0 fp-a"]);
    expect(ids(r.text)).toEqual(["a"]);
  });
  it("applies a pin that names a copy to its representative", () => {
    const cands = { a: cc("a"), b: cc("b"), c: cc("c", { tier: "local" }) };
    for (const pin of ["b@1.0.0", "b"]) {
      const r = canon([sk("a"), sk("b"), other], cands, { pins: { cap: pin } });
      expect(r.blocked).toBeUndefined();
      expect(r.canonical?.resolutions[0]?.ignored).toEqual([]);
      expect(r.canonical?.selected).toEqual(["a@1.0.0 fp-a"]);
    }
  });
  it("does not block a mandatory copy whose representative is offered", () => {
    const r = canon([sk("a"), sk("b")], { a: cc("a"), b: cc("b") }, {}, cfg({ selection: { include: ["b"] } }));
    expect(r.blocked).toBeUndefined();
    expect(ids(r.text)).toEqual(["a"]);
  });
  it("stops for a mandatory copy that fails a gate, even when its twin is healthy", () => {
    const r = canon([sk("a"), sk("b")], { a: cc("a"), b: cc("b", { failed: ["licence"] }) }, {}, cfg({ selection: { include: ["b"] } }));
    expect(r.blocked).toContain("always loaded");
  });
  it("does not merge copies with a different safety profile", () => {
    const r = canon([sk("a"), sk("b")], { a: cc("a", { compatibility: "incompatible" }), b: cc("b") });
    expect(r.canonical?.selected).toEqual(["b@1.0.0 fp-b"]);
    expect(r.record?.mirrors).toBeUndefined();
  });
});
