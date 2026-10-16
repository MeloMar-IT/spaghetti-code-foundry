import { describe, expect, it } from "vitest";
import { EFFECT_KINDS, OFFERS, OFFER_TYPES, OfferCallSchema, OfferSchema, SUBJECT_KINDS, offerCall, offerDef, subjectPage } from "../src/help/actions.js";
import { SNAPSHOT_KINDS } from "../src/server/help-context.js";
import { findRule } from "../src/server/permissions.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("the registry of offers", () => {
  it("is well formed", () => {
    expect(OFFERS.map((o) => o.type)).toEqual([...OFFER_TYPES]);
    expect(new Set(OFFERS.map((o) => o.type)).size).toBe(OFFERS.length);
    for (const o of OFFERS) {
      expect(o.roles.length, o.type).toBeGreaterThan(0);
      for (const r of o.roles) expect(["admin", "user"]).toContain(r);
      for (const s of o.subjects) expect(SUBJECT_KINDS).toContain(s);
      expect(EFFECT_KINDS).toContain(o.effect);
      expect(o.title.length).toBeGreaterThan(0);
      expect(o.to({ kind: o.subjects[0]!, id: "x" }).startsWith("#/")).toBe(true);
    }
  });

  it("matches the table of the issue, and every call has a rule", () => {
    const rows = OFFERS.map((o) => [o.type, [...o.roles], [...o.subjects], o.call.method, o.call.path]);
    expect(rows).toEqual([
      ["open-run", ["admin", "user"], ["run"], "GET", "runs/:id"],
      ["open-repository", ["admin", "user"], ["repository"], "GET", "repos"],
      ["open-turn-item", ["admin"], ["run", "issue"], "GET", "your-turn"],
    ]);
    for (const o of OFFERS) {
      const rule = findRule(o.call.method, offerCall(o, { kind: o.subjects[0]!, id: "x" }));
      expect(rule ? `${rule.method} ${rule.path}` : undefined, o.type).toBe(`${o.call.method} ${o.call.path}`);
    }
  });

  it("has the subject kinds of the snapshots", () => {
    expect([...SUBJECT_KINDS]).toEqual([...SNAPSHOT_KINDS]);
  });

  it("finds an offer only for a role that has it", () => {
    expect(offerDef("user", "open-turn-item")).toBeUndefined();
    expect(offerDef("admin", "open-turn-item")?.type).toBe("open-turn-item");
    expect(offerDef("admin", "x")).toBeUndefined();
    expect(offerDef("user", undefined)).toBeUndefined();
  });
});

describe("subjectPage", () => {
  it("keeps every id inside #/…, encoded", () => {
    const prefixes: Record<string, string> = { run: "#/runs/", repository: "#/repos/", refinement: "#/refinement/", problem: "#/problems/" };
    for (const id of ["https://evil.example", "javascript:alert(1)", "../x", "a/b?c"]) {
      for (const kind of SUBJECT_KINDS) {
        const to = subjectPage(kind, id);
        expect(to.startsWith("#/"), `${kind} ${id}`).toBe(true);
        const prefix = prefixes[kind];
        if (prefix) {
          expect(to).toBe(prefix + encodeURIComponent(id));
          expect(to.slice(prefix.length)).not.toMatch(/[/?:]/);
        } else expect(to).not.toContain(id);
      }
    }
  });
});

describe("the schemas of an offer", () => {
  const ok = { type: "open-run", title: "Open this run", evidence: "state-run-abc", subject: { kind: "run", id: "r1" } };
  it("refuse extra keys, an unknown type and a bad evidence id", () => {
    expect(OfferSchema.safeParse(ok).success).toBe(true);
    for (const extra of [{ to: "#/home" }, { url: "https://x" }, { path: "/x" }, { params: {} }]) expect(OfferSchema.safeParse({ ...ok, ...extra }).success).toBe(false);
    expect(OfferSchema.safeParse({ ...ok, subject: { ...ok.subject, to: "#/x" } }).success).toBe(false);
    expect(OfferSchema.safeParse({ ...ok, type: "open-anything" }).success).toBe(false);
    expect(OfferSchema.safeParse({ ...ok, evidence: "not valid!" }).success).toBe(false);
  });

  it("the body of a click is strict", () => {
    expect(OfferCallSchema.safeParse({ message: UUID, offer: 0 }).success).toBe(true);
    expect(OfferCallSchema.safeParse({ message: UUID, offer: 2 }).success).toBe(true);
    for (const bad of [{ message: UUID, offer: -1 }, { message: UUID, offer: 3 }, { message: UUID, offer: 1.5 }, { message: "x", offer: 0 }, { message: UUID }, { offer: 0 }, { message: UUID, offer: 0, extra: 1 }]) expect(OfferCallSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
