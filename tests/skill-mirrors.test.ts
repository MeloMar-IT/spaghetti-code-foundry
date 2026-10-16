import { describe, expect, it } from "vitest";
import type { CanonicalCandidate } from "../src/skills/canonical.js";
import { collapseMirrors, compareMirrors, instructionKey, reviewKey, safetyProfile, type MirrorRank } from "../src/skills/mirrors.js";

const pkg = (description: string, instructions: string) => ({ description, instructions });

describe("instructionKey", () => {
  it("is sha256 of the rendered text and ignores everything else", () => {
    const a = { id: "a", version: "1.0.0", ...pkg("About it.", "Do it.") };
    const b = { id: "b", version: "2.0.0", digest: "x", ...pkg("About it.", "Do it.") };
    expect(instructionKey(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(instructionKey(a)).toBe(instructionKey(b));
  });
  it("ignores CRLF, outer whitespace and whitespace runs in the description", () => {
    expect(instructionKey(pkg("About   it.\n", "Line 1\r\nLine 2\r\n\r\n"))).toBe(instructionKey(pkg(" About it.", "\nLine 1\nLine 2")));
  });
  it("sees one different character and the description", () => {
    expect(instructionKey(pkg("d", "Do it."))).not.toBe(instructionKey(pkg("d", "Do it!")));
    expect(instructionKey(pkg("d", "Do it."))).not.toBe(instructionKey(pkg("e", "Do it.")));
  });
  it("keeps the reviewer key apart", () => {
    expect(reviewKey({ description: "d", review: "x" })).toBe(instructionKey(pkg("d", "x")));
    expect(reviewKey({ description: "d", review: "x" })).not.toBe(reviewKey({ description: "d", review: "y" }));
  });
});

const rank = (id: string, version: string, tier: MirrorRank["tier"] = "scf-curated"): MirrorRank => ({ id, version, tier });

describe("compareMirrors and collapseMirrors", () => {
  it("orders by tier, then id, then version in byte order", () => {
    const sorted = [rank("b", "1.0.0"), rank("a", "9.0.0"), rank("a", "10.0.0"), rank("z", "1.0.0", "local")].sort(compareMirrors);
    expect(sorted.map((r) => `${r.id}@${r.version}`)).toEqual(["z@1.0.0", "a@10.0.0", "a@9.0.0", "b@1.0.0"]);
  });
  it("gives the same result for any input order", () => {
    const items = [rank("c", "1.0.0"), rank("a", "1.0.0"), rank("b", "1.0.0", "local"), rank("d", "1.0.0")];
    const key = (r: MirrorRank) => (r.id === "d" ? "other" : "same");
    const one = collapseMirrors(items, key, (r) => r);
    const two = collapseMirrors([...items].reverse(), key, (r) => r);
    expect(one.groups).toEqual(two.groups);
    expect(one.groups[0]!.kept.id).toBe("b");
    expect(one.groups[0]!.collapsed.map((r) => r.id)).toEqual(["a", "c"]);
    expect(one.kept.map((r) => r.id)).toEqual(["b", "d"]);
  });
});

describe("safetyProfile", () => {
  const cand = (o: Partial<CanonicalCandidate> = {}): CanonicalCandidate => ({
    id: "a", version: "1.0.0", fingerprint: "f", capabilities: ["x", "y"], category: "c", risk: "low", tier: "scf-curated", status: "approved",
    failed: [], compatibility: "generic", ...o,
  });
  it("ignores id, version, tier and approval time", () => {
    expect(safetyProfile(cand(), false)).toBe(safetyProfile(cand({ id: "b", version: "2.0.0", fingerprint: "g", tier: "local", approvedAt: "2026-01-01T00:00:00Z", capabilities: ["y", "x"] }), false));
  });
  it("differs for gates, status, compatibility, evaluation and withhold", () => {
    const base = safetyProfile(cand(), false);
    for (const other of [cand({ failed: ["safety"] }), cand({ status: "revoked" }), cand({ compatibility: "incompatible" }), cand({ evaluation: "failed" })])
      expect(safetyProfile(other, false)).not.toBe(base);
    expect(safetyProfile(cand(), true)).not.toBe(base);
  });
});
