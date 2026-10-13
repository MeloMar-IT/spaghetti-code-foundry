import { describe, expect, it } from "vitest";
import type { CanonicalCandidate } from "../src/skills/canonical.js";
import type { CanonicalTier } from "../src/skills/canonical-rules.js";
import { evaluateImport, evaluationAreas, type ImportedCandidate } from "../src/skills/import-evaluation.js";
import type { LicenceStatus } from "../src/skills/licence.js";
import { normalizeSkill, type NormalizeOrigin, type NormalizedSkill } from "../src/skills/normalize.js";
import type { SourceTrustTier } from "../src/skills/sources.js";

type F = { path: string; content: Uint8Array };
const A: NormalizeOrigin = { source: "lib", repository: "https://github.com/example/skills", repositoryKey: "github.com/example/skills", commit: "a".repeat(40) };
const B: NormalizeOrigin = { source: "mir", repository: "https://github.com/other/skills", repositoryKey: "github.com/other/skills", commit: "b".repeat(40) };
const f = (path: string, text: string): F => ({ path, content: new Uint8Array(Buffer.from(text)) });
const doc = (name: string, extra = "", body = "Body.") => f("SKILL.md", `---\nname: ${name}\ndescription: About ${name}.\n${extra}---\n\n${body}\n`);
const yaml = (text: string) => f("skill.yaml", text);

function skill(files: F[], origin: NormalizeOrigin = A): NormalizedSkill {
  const r = normalizeSkill(origin, { root: "skills/x", files });
  if (!r.ok) throw new Error(r.reasons.join("; "));
  return r.skill;
}
interface Opts { origin?: NormalizeOrigin; approved?: boolean; trust?: SourceTrustTier; licence?: LicenceStatus; safety?: boolean }
function imp(files: F[], o: Opts = {}): ImportedCandidate {
  return {
    candidate: { skill: skill(files, o.origin), approved: o.approved ?? true, trust: o.trust ?? "community", licencesAllowed: ["MIT"] },
    licence: o.licence ?? "allowed",
    safety: o.safety ?? true,
  };
}
function existing(id: string, caps: string[], tier: CanonicalTier = "scf-curated", status: CanonicalCandidate["status"] = "approved"): CanonicalCandidate {
  return { id, version: "1.0.0", fingerprint: "sha256:" + id, capabilities: caps, category: "general", risk: "low", tier, status, failed: [], compatibility: "generic" };
}
const shared = (extra = "") => [doc("notes"), yaml(`capabilities: [shared]\n${extra}`)];
const winners = (e: ReturnType<typeof evaluateImport>) => e.canonical.resolutions.map((r) => r.winner?.id);
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};
const permutations = <T>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])));

describe("evaluationAreas", () => {
  const areas = (name: string, extra = "") => evaluationAreas(skill([doc(name, extra)]));
  it("names the areas by name, category and capabilities", () => {
    expect(areas("code-review")).toEqual(["code-review"]);
    expect(areas("docs-writer", "tags: [documentation]\n")).toEqual(["documentation"]);
    expect(areas("git-workflow")).toEqual(["development-workflow"]);
    expect(areas("pdf-tool")).toEqual([]);
  });
  it("does not match a word part of a longer word", () => {
    expect(areas("preview")).toEqual([]);
  });
});

describe("evaluateImport", () => {
  it("reports a skill without overlap as new", () => {
    const e = evaluateImport({ imported: [imp([doc("code-review")])], existing: [existing("nodejs", ["node-service"])] });
    expect(e.skills.map((s) => s.outcome)).toEqual(["new"]);
    expect(e.skills[0]!.areas).toEqual(["code-review"]);
    expect(e.canonical.resolutions).toEqual([]);
  });

  it("lets an existing curated skill win over a community import", () => {
    const e = evaluateImport({ imported: [imp(shared())], existing: [existing("builtin-one", ["shared"])] });
    const s = must(e.skills[0]);
    expect(s.outcome).toBe("duplicate");
    expect(s.overlaps).toEqual([{ capability: "shared", existing: ["builtin-one"], winner: "builtin-one" }]);
    const res = must(e.canonical.resolutions[0]);
    expect(res.rejected[0]).toMatchObject({ code: "outranked", level: "trust-tier" });
  });

  it("merges the same content from two source records into one entry", () => {
    const e = evaluateImport({ imported: [imp(shared()), imp(shared(), { origin: B })], existing: [] });
    expect(e.skills).toHaveLength(1);
    expect(e.collisions.collisions.map((c) => c.class)).toEqual(["exact-mirror"]);
  });

  it("never lets a rejected licence or a failed safety check win", () => {
    for (const bad of [{ licence: "rejected" as const }, { safety: false }]) {
      const e = evaluateImport({ imported: [imp(shared(), bad)], existing: [existing("weak", ["shared"], "discovery-only", "discovery")] });
      expect(winners(e)).toEqual([undefined]);
    }
  });

  it("keeps the facts with their copy, for every order", () => {
    const good = imp(shared());
    const bad = imp(shared(), { origin: B, licence: "rejected", trust: "first-party" });
    const weak = existing("weak", ["shared"], "discovery-only", "discovery");
    const results = permutations([good, bad]).map((imported) => evaluateImport({ imported, existing: [weak] }));
    for (const r of results) expect(r).toEqual(results[0]);
    expect(winners(results[0]!)).toEqual([good.candidate.skill.identity.id]);
    const failed = results[0]!.canonical.resolutions[0]!.rejected.find((x) => x.id === bad.candidate.skill.identity.id);
    expect(failed?.code).toBe("licence");
  });

  it("marks copies with one key and different facts as ambiguous", () => {
    const one = imp(shared());
    const two = { ...imp(shared()), licence: "rejected" as const };
    const e = evaluateImport({ imported: [one, two], existing: [existing("weak", ["shared"], "discovery-only", "discovery")] });
    expect(winners(e)).toEqual([undefined]);
    expect(e.canonical.resolutions[0]!.rejected.map((x) => x.code)).toContain("ambiguous-record");
  });

  describe("blocked entries", () => {
    const weak = existing("weak", ["shared"], "discovery-only", "discovery");
    const blockedCases: Record<string, ImportedCandidate[]> = {
      "mirror.settings-differ": [imp(shared()), imp(shared("tool_profile: { shell: true, network: false, filesystem: read }\n"), { origin: B })],
      "version reuse": [imp([doc("notes", "version: 1.0.0\n"), yaml("capabilities: [shared]\n")]), imp([doc("notes", "version: 1.0.0\n", "Other body."), yaml("capabilities: [shared]\n")])],
      "id conflict": [imp([doc("notes", "version: 1.0.0\n"), yaml("capabilities: [shared]\n")]), imp([doc("notes", "version: 2.0.0\n", "Other body."), yaml("capabilities: [shared]\n")])],
    };
    for (const [label, imported] of Object.entries(blockedCases)) {
      it(`${label} is reported as blocked and never wins`, () => {
        const e = evaluateImport({ imported, existing: [weak] });
        expect(e.skills.length).toBeGreaterThan(0);
        for (const s of e.skills) {
          expect(s.outcome).toBe("blocked");
          expect(s.blockedBy.length).toBeGreaterThan(0);
          expect(s.overlaps.every((o) => o.winner === undefined)).toBe(true);
        }
        expect(e.canonical.selected).toEqual([]);
        expect(winners(e).filter(Boolean)).toEqual([]);
      });
    }
  });

  it("does not let an unapproved copy block an approved one, and it never wins", () => {
    const a = imp(shared());
    const b = imp(shared("tool_profile: { shell: true, network: false, filesystem: read }\n"), { origin: B, approved: false });
    const e = evaluateImport({ imported: [a, b], existing: [existing("weak", ["shared"], "discovery-only", "discovery")] });
    expect(e.skills[0]!.outcome).not.toBe("blocked");
    expect(winners(e)).toEqual([a.candidate.skill.identity.id]);
  });

  it("gives the same result for any input order", () => {
    const list = [imp(shared()), imp([doc("other"), yaml("capabilities: [shared]\n")], { origin: B }), imp([doc("third")])];
    const ex = [existing("builtin-one", ["shared"], "official-vendor")];
    const results = permutations(list).map((imported) => evaluateImport({ imported, existing: ex }));
    for (const r of results) expect(r).toEqual(results[0]);
  });
});
