import { describe, expect, it } from "vitest";
import { ActionGrants, GRANT_TTL_MS, GRANTS_MAX, GRANTS_PER_OWNER, grantsOf, type GrantBinding } from "../src/help/grants.js";

const bind = (over: Partial<GrantBinding> = {}): GrantBinding => ({ owner: "ann", conversation: "c1", message: "m1", index: 0, ...over });
const grant = (over: Partial<GrantBinding> = {}) => ({ ...bind(over), action: "cancel-run", about: { kind: "run" as const, id: "r1" }, version: "v1" });

describe("action grants", () => {
  it("never stores the token", () => {
    const g = new ActionGrants();
    const { token } = g.issue(grant());
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const inner = [...(g as unknown as { grants: Map<string, unknown> }).grants.entries()];
    expect(JSON.stringify(inner)).not.toContain(token);
    expect(JSON.stringify(inner)).not.toContain(token.slice(0, 20));
  });

  it("works for 5 minutes", () => {
    let t = 1000;
    const g = new ActionGrants({ now: () => t });
    const { token, expiresAt } = g.issue(grant());
    expect(expiresAt).toBe(1000 + GRANT_TTL_MS);
    t += GRANT_TTL_MS - 1;
    expect(g.peek(token)).toBeDefined();
    t += 1;
    expect(g.peek(token)).toBeUndefined();
    expect(g.size).toBe(0);
    const again = g.issue(grant());
    t += GRANT_TTL_MS;
    expect(g.take(again.token, bind())).toEqual({ ok: false, reason: "expired" });
  });

  it("keeps 5 per owner and 1000 in total, dropping the oldest", () => {
    const g = new ActionGrants();
    const tokens = Array.from({ length: GRANTS_PER_OWNER + 1 }, (_, i) => g.issue(grant({ message: `m${i}` })).token);
    expect(g.peek(tokens[0]!)).toBeUndefined();
    expect(tokens.slice(1).every((t) => g.peek(t))).toBe(true);
    const small = new ActionGrants({ max: 3, perOwner: 10 });
    const t2 = Array.from({ length: 4 }, (_, i) => small.issue(grant({ owner: `o${i}` })).token);
    expect(small.size).toBe(3);
    expect(small.peek(t2[0]!)).toBeUndefined();
    expect(GRANTS_MAX).toBe(1000);
  });

  it("a new preview for the same reply action replaces the old token", () => {
    const g = new ActionGrants();
    const a = g.issue(grant());
    const b = g.issue(grant());
    expect(g.peek(a.token)).toBeUndefined();
    expect(g.peek(b.token)).toBeDefined();
    expect(g.size).toBe(1);
  });

  it("peek does not burn; take burns on success and on a mismatch", () => {
    const g = new ActionGrants();
    const a = g.issue(grant());
    expect(g.peek(a.token)).toMatchObject({ action: "cancel-run", version: "v1" });
    expect(g.peek(a.token)).toBeDefined();
    expect(g.take(a.token, bind()).ok).toBe(true);
    expect(g.take(a.token, bind())).toEqual({ ok: false, reason: "unknown" });
    for (const other of [{ index: 1 }, { conversation: "c2" }, { owner: "bob" }, { message: "m2" }]) {
      const t = g.issue(grant()).token;
      expect(g.take(t, bind(other))).toEqual({ ok: false, reason: "mismatch" });
      expect(g.take(t, bind())).toEqual({ ok: false, reason: "unknown" });
    }
  });

  it("cancel removes a token only for its owner and conversation", () => {
    const g = new ActionGrants();
    const { token } = g.issue(grant());
    expect(g.cancel(token, "bob", "c1")).toBe(false);
    expect(g.cancel(token, "ann", "c2")).toBe(false);
    expect(g.peek(token)).toBeDefined();
    expect(g.cancel(token, "ann", "c1")).toBe(true);
    expect(g.cancel(token, "ann", "c1")).toBe(false);
  });

  it("grantsOf gives one set per key", () => {
    const k = {};
    expect(grantsOf(k)).toBe(grantsOf(k));
    expect(grantsOf({})).not.toBe(grantsOf(k));
  });
});
