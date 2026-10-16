import { describe, expect, it } from "vitest";
import {
  CHECK_FRESH_MS, CheckSchema, EFFECT_KINDS, OFFERS, OFFER_TYPES, OfferCallSchema, OfferSchema, READ_CALLS, SUBJECT_KINDS, callOf, checkOf, checkSourceId, checkSources, checkText, cutText, offerCall, offerDef, subjectPage,
  type Check, type CheckInput,
} from "../src/help/actions.js";
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
      if (o.effect === "navigation") expect(o.to!({ kind: o.subjects[0]!, id: "x" }).startsWith("#/")).toBe(true);
      else expect(o.to).toBeUndefined();
    }
  });

  it("matches the table of the issue, and every call has a rule", () => {
    const rows = OFFERS.map((o) => [o.type, [...o.roles], [...o.subjects], o.effect, o.call === "read" ? "read" : `${o.call.method} ${o.call.path}`]);
    expect(rows).toEqual([
      ["open-run", ["admin", "user"], ["run"], "navigation", "GET runs/:id"],
      ["open-repository", ["admin", "user"], ["repository"], "navigation", "GET repos"],
      ["open-turn-item", ["admin"], ["run", "issue"], "navigation", "GET your-turn"],
      ["refresh-evidence", ["admin", "user"], [...SUBJECT_KINDS], "check", "read"],
      ["test-repository", ["admin", "user"], ["repository"], "check", "POST repos/:id/test"],
    ]);
    for (const o of OFFERS) {
      for (const kind of o.subjects) {
        const s = { kind, id: "x" };
        const want = callOf(o, s);
        const rule = findRule(want.method, offerCall(o, s));
        expect(rule ? `${rule.method} ${rule.path}` : undefined, `${o.type} ${kind}`).toBe(`${want.method} ${want.path}`);
      }
    }
  });

  it("checks a read against the call the snapshot adapter follows, for every kind", () => {
    expect(Object.keys(READ_CALLS).sort()).toEqual([...SUBJECT_KINDS].sort());
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

const NOW = "2026-01-01T12:00:00.000Z";
const input = (over: Partial<CheckInput> = {}): CheckInput => ({ type: "refresh-evidence", offer: 0, scope: "user", kind: "run", id: "run-1", label: "a run", observedAt: NOW, fields: { status: "failed" }, unavailable: [], stale: [], ...over });
const validCheck = (over: Partial<Check> = {}): Check => ({ type: "refresh-evidence", offer: 0, subject: { kind: "run", id: "run-1" }, scope: "user", title: "A run", outcome: "read", lines: ["status: failed"], observedAt: NOW, ...over });

describe("the schema of a check", () => {
  it("accepts a valid check and refuses extra keys, unknown values and too long text", () => {
    expect(CheckSchema.safeParse(validCheck()).success).toBe(true);
    const bad: unknown[] = [
      { ...validCheck(), extra: 1 },
      validCheck({ type: "open-run" as never }),
      validCheck({ outcome: "ok" as never }),
      validCheck({ scope: "root" as never }),
      validCheck({ lines: ["x".repeat(301)] }),
      validCheck({ lines: Array.from({ length: 31 }, () => "x") }),
      validCheck({ title: "t".repeat(501) }),
      validCheck({ offer: 3 }),
    ];
    for (const b of bad) expect(CheckSchema.safeParse(b).success, JSON.stringify(b).slice(0, 80)).toBe(false);
  });

  it("has an authorization shape for each type: refresh for every kind, test for repositories", () => {
    const refresh = OFFERS.find((o) => o.type === "refresh-evidence")!;
    const test = OFFERS.find((o) => o.type === "test-repository")!;
    expect([...refresh.subjects]).toEqual([...SUBJECT_KINDS]);
    expect([...test.subjects]).toEqual(["repository"]);
    expect(offerDef("user", "refresh-evidence")?.effect).toBe("check");
    expect(offerDef("user", "test-repository")?.effect).toBe("check");
    expect(callOf(refresh, { kind: "issue", id: "x" })).toEqual({ method: "GET", path: "board" });
  });
});

describe("checkOf", () => {
  it("cuts a value of 302 characters to at most 300, ending in the marker", () => {
    const c = checkOf(input({ fields: { error: `${"e".repeat(300)} …` } }), "read");
    expect(c.lines[0]!.length).toBeLessThanOrEqual(300);
    expect(c.lines[0]!.endsWith(" …")).toBe(true);
    expect(cutText("a".repeat(10), 300)).toBe("a".repeat(10));
  });

  it("keeps at most 30 lines and keeps the special lines", () => {
    const fields = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i}`, "v"]));
    const c = checkOf(input({ fields, unavailable: ["a", "b"], stale: ["f1"] }), "failed", ["clone: no", "push: no", "github-api: no"]);
    expect(c.lines.length).toBeLessThanOrEqual(30);
    expect(c.lines.some((l) => l.startsWith("Not available now"))).toBe(true);
    expect(c.lines.some((l) => l.startsWith("May be out of date"))).toBe(true);
    expect(c.lines.filter((l) => l.startsWith("Failed:")).length).toBe(3);
    expect(c.uncertain).toBe(true);
  });

  it("cuts a long title", () => {
    expect(checkOf(input({ label: "x".repeat(900) }), "read").title.length).toBeLessThanOrEqual(500);
  });
});

describe("checkSources", () => {
  const msg = (id: string, check: Check) => ({ id, role: "check", check });
  const all = () => true;

  it("gives the newest two, with a stable id", () => {
    const history = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"].map((id) => msg(id, validCheck()));
    const out = checkSources(history, "user", all, new Date(NOW));
    expect(out.length).toBe(2);
    expect(out[0]!.id).toMatch(/^check-[0-9a-f]{16}$/);
    expect(out[0]!.id).toBe(checkSourceId(history[2]!.id));
    expect(out.every((s) => s.kind === "state")).toBe(true);
  });

  it("drops a check about something that is not visible now", () => {
    expect(checkSources([msg("a", validCheck())], "user", () => false, new Date(NOW))).toEqual([]);
  });

  it("drops an admin check for a user and keeps it for an admin; a user check stays for both", () => {
    const admin = msg("a", validCheck({ scope: "admin" }));
    expect(checkSources([admin], "user", all, new Date(NOW))).toEqual([]);
    expect(checkSources([admin], "admin", all, new Date(NOW)).length).toBe(1);
    expect(checkSources([msg("b", validCheck({ scope: "user" }))], "admin", all, new Date(NOW)).length).toBe(1);
  });

  it("marks a check older than 15 minutes as uncertain", () => {
    const later = new Date(Date.parse(NOW) + CHECK_FRESH_MS + 60_000);
    const [old] = checkSources([msg("a", validCheck())], "user", all, later);
    expect(old!.uncertain).toBe(true);
    expect(old!.excerpt).toContain("older than 15 minutes");
    const [fresh] = checkSources([msg("a", validCheck())], "user", all, new Date(NOW));
    expect(fresh!.uncertain).toBeUndefined();
    expect(checkText.outcome.read).toBe("Read again");
  });
});
