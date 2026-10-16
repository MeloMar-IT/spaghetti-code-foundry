import { describe, expect, it } from "vitest";
import { skillSelectionView } from "../src/server/skill-selection-view.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const D = `sha256:${"a".repeat(64)}`;
const H = "b".repeat(40);
const step = (cat: any, over: any = {}) => ({ id: "plan", skillCatalogue: cat, ...over });
const run = (cat: any, sel?: any): any => ({ history: [step(cat)], ...(sel ? { skillSelection: sel } : {}) });
const rec = (over: any = {}) => ({ capability: "x", outcome: "selected", winner: "a@1.0.0", decidedBy: "trust-tier", companions: ["b@2.0.0"], rejected: [{ skill: "c@1.0.0", code: "outranked", level: "evaluation" }], ...over });
const choice = (over: any = {}) => ({ level: "project-pin", capability: "x", target: "a@1.0.0", by: "@octocat", scope: "all", from: "abc", reviewDue: true, digest: D, effect: "selected", ...over });
const keys = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keys(x, out); }
  return out;
};
const user = { admin: false };
const admin = { admin: true };

describe("skillSelectionView", () => {
  it("gives undefined when there is nothing to explain", () => {
    expect(skillSelectionView({ history: [] } as any, user)).toBeUndefined();
    expect(skillSelectionView({ history: [{ id: "a" }] } as any, user)).toBeUndefined();
    expect(skillSelectionView(run({ entries: 3, omitted: 0, estimatedTokens: 9 }), user)).toBeUndefined();
    expect(skillSelectionView(run([]), user)).toBeUndefined();
    expect(skillSelectionView(run("x"), user)).toBeUndefined();
    expect(skillSelectionView({ history: [null, 4, "x"] } as any, user)).toBeUndefined();
  });

  it("builds a capability with companions, rejections and the count of the rest", () => {
    const v = skillSelectionView(run({ canonical: [rec({ rejectedOmitted: 3 })] }), user)!;
    expect(v.capabilities).toEqual([{ capability: "x", outcome: "selected", winner: "a@1.0.0", decidedBy: "trust-tier", companions: ["b@2.0.0"], rejected: [{ skill: "c@1.0.0", code: "outranked", level: "evaluation" }], more: 3 }]);
    expect(v.counts).toEqual({ capabilities: 1, mirrorGroups: 0, collapsed: 0, choices: 0 });
  });

  it("shows 5 rejected and counts the rest", () => {
    const rejected = Array.from({ length: 7 }, (_, i) => ({ skill: `r${i}@1.0.0`, code: "tied" }));
    const v = skillSelectionView(run({ canonical: [rec({ rejected, rejectedOmitted: 2 })] }), user)!;
    expect(v.capabilities[0]!.rejected).toHaveLength(5);
    expect(v.capabilities[0]!.more).toBe(4);
  });

  it("counts collapsed copies including the omitted ones", () => {
    const v = skillSelectionView(run({ mirrors: [{ kept: "a@1.0.0", collapsed: ["b@1.0.0"] }], mirrorsOmitted: 4 }), user)!;
    expect(v.mirrors).toEqual([{ kept: "a@1.0.0", collapsed: ["b@1.0.0"] }]);
    expect(v.counts.collapsed).toBe(5);
  });

  it("keeps every recorded copy of one group", () => {
    const collapsed = Array.from({ length: 40 }, (_, i) => `c${i}@1.0.0`);
    const v = skillSelectionView(run({ mirrors: [{ kept: "a@1.0.0", collapsed }] }), user)!;
    expect(v.mirrors[0]!.collapsed).toHaveLength(40);
    expect(v.counts.collapsed).toBe(40);
  });

  it("shows choices; author, digest and source only to an administrator", () => {
    const cat = { choices: [choice()], choicesSource: { pins: { commit: H, blob: H } } };
    const u = skillSelectionView(run(cat), user)!;
    expect(u.choices).toEqual([{ level: "project-pin", capability: "x", target: "a@1.0.0", effect: "selected", reviewDue: true }]);
    expect(u.choicesSource).toBeUndefined();
    const a = skillSelectionView(run(cat), admin)!;
    expect(a.choices[0]).toMatchObject({ by: "@octocat", digest: D });
    expect(a.choicesSource).toEqual({ pins: { commit: H, blob: H } });
  });

  it("never gives a user a private key", () => {
    const cat = { canonical: [rec()], mirrors: [{ kept: "a@1.0.0", collapsed: ["b@1.0.0"] }], choices: [choice({ expires: "2030-01-01" })], choicesSource: { pins: { commit: H, blob: H } } };
    const k = keys(skillSelectionView(run(cat), user));
    for (const bad of ["digest", "by", "choicesSource", "commit", "blob", "from", "expires", "scope"]) expect(k.has(bad)).toBe(false);
  });

  it("caps capabilities and mirror groups at 20", () => {
    const canonical = Array.from({ length: 25 }, (_, i) => rec({ capability: `cap${i}` }));
    const mirrors = Array.from({ length: 25 }, (_, i) => ({ kept: `k${i}@1.0.0`, collapsed: [`m${i}@1.0.0`] }));
    const v = skillSelectionView(run({ canonical, mirrors }), user)!;
    expect(v.capabilities).toHaveLength(20);
    expect(v.mirrors).toHaveLength(20);
    expect(v.counts).toMatchObject({ capabilities: 25, mirrorGroups: 25, collapsed: 25 });
  });

  it("drops malformed fields and entries", () => {
    const cat = {
      canonical: [
        rec({ capability: "Bad Slug!" }), rec({ capability: "w", winner: "nover" }), rec({ capability: "d", decidedBy: "magic" }),
        rec({ capability: "r", rejected: [{ skill: "c@1.0.0", code: "nope" }, { skill: "e@1.0.0", code: "tied" }], rejectedOmitted: -1 }),
        rec({ capability: "s", companions: "b@1.0.0", rejectedOmitted: "3" }), 5, null,
      ],
      choices: [choice({ effect: "other" }), choice({ level: "other" }), choice({ by: "x; rm", digest: "sha256:zz" })],
      choicesSource: { pins: { commit: "../x", blob: H } },
    };
    const v = skillSelectionView(run(cat), admin)!;
    const by = (c: string) => v.capabilities.find((x) => x.capability === c);
    expect(by("Bad Slug!")).toBeUndefined();
    expect(by("w")!.winner).toBeUndefined();
    expect(by("d")!.decidedBy).toBeUndefined();
    expect(by("r")!.rejected).toEqual([{ skill: "e@1.0.0", code: "tied" }]);
    expect(by("r")!.more).toBeUndefined();
    expect(by("s")!.companions).toBeUndefined();
    expect(by("s")!.more).toBeUndefined();
    expect(v.choices).toHaveLength(1);
    expect(v.choices[0]!.by).toBeUndefined();
    expect(v.choices[0]!.digest).toBeUndefined();
    expect(v.choicesSource).toBeUndefined();
  });

  it("keeps a conflict without a winner", () => {
    const v = skillSelectionView(run({ canonical: [{ capability: "x", outcome: "conflict", rejected: [] }] }), user)!;
    expect(v.capabilities[0]).toEqual({ capability: "x", outcome: "conflict", rejected: [] });
  });

  describe("source of the decision", () => {
    const cat = { canonical: [rec()] };
    const lockRec = { capability: "x", outcome: "selected", winner: "a@1.0.0", decidedBy: "only-candidate", rejected: [] };
    it("keeps the catalogue reasons when the lock picked the same winner", () => {
      const v = skillSelectionView(run(cat, { planHash: "h1", canonical: [lockRec] }), { ...user, lockPlanHash: "h1" })!;
      expect(v.capabilities[0]).toMatchObject({ winner: "a@1.0.0", decidedBy: "trust-tier", rejected: [{ skill: "c@1.0.0", code: "outranked", level: "evaluation" }] });
    });
    it("uses the lock decision when the winner differs", () => {
      const other = { ...lockRec, winner: "z@1.0.0" };
      const v = skillSelectionView(run(cat, { planHash: "h1", canonical: [other] }), { ...user, lockPlanHash: "h1" })!;
      expect(v.capabilities).toHaveLength(1);
      expect(v.capabilities[0]!.winner).toBe("z@1.0.0");
      expect(v.capabilities[0]!.decidedBy).toBe("only-candidate");
      expect(v.counts.capabilities).toBe(1);
    });
    it("does not list a catalogue companion the lock did not load", () => {
      const v = skillSelectionView(run(cat, { planHash: "h1", canonical: [lockRec] }), { ...user, lockPlanHash: "h1" })!;
      expect(cat.canonical[0]!.companions).toEqual(["b@2.0.0"]);
      expect(v.capabilities[0]!.companions).toBeUndefined();
    });
    it("ignores the selection of another plan", () => {
      const other = { ...lockRec, winner: "z@1.0.0" };
      const v = skillSelectionView(run(cat, { planHash: "h2", canonical: [other] }), { ...user, lockPlanHash: "h1" })!;
      expect(v.capabilities[0]!.winner).toBe("a@1.0.0");
    });
    it("uses the selection when there is no lock hash", () => {
      const v = skillSelectionView({ history: [], skillSelection: { planHash: "h2", canonical: [lockRec] } } as any, user)!;
      expect(v.capabilities[0]!.winner).toBe("a@1.0.0");
    });
    it("takes the latest catalogue of the run, not of a sub-flow", () => {
      const s: any = { history: [step({ canonical: [rec({ winner: "old@1.0.0" })] }), step({ canonical: [rec({ winner: "new@1.0.0" })] }), step({ canonical: [rec({ winner: "sub@1.0.0" })] }, { parent: "sub" })] };
      expect(skillSelectionView(s, user)!.capabilities[0]!.winner).toBe("new@1.0.0");
    });
    it("leaves the catalogue out when the run planned again, keeping the locked decision", () => {
      const sel = { planHash: "h1", canonical: [lockRec] };
      const v = skillSelectionView(run({ canonical: [rec({ winner: "n@1.0.0" })], mirrors: [{ kept: "a@1.0.0", collapsed: ["b@1.0.0"] }], choices: [choice()] }, sel), { ...user, lockPlanHash: "h1", catalogueCurrent: false })!;
      expect(v.capabilities.map((c) => c.winner)).toEqual(["a@1.0.0"]);
      expect(v.mirrors).toEqual([]);
      expect(v.choices).toEqual([]);
    });
  });

  it("never throws", () => {
    const bad: any = { get history() { throw new Error("x"); } };
    expect(skillSelectionView(bad, user)).toBeUndefined();
  });
});
