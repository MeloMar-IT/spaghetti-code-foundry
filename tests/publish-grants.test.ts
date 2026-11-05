import { describe, expect, it } from "vitest";
import { PUBLISH_TTL_MS, PUBLISH_WORDS, PublishGrants, type PublishBinding, fingerprint, refusalText } from "../src/repos/publish-grants.js";

const B: PublishBinding = { owner: "ann", repoId: "r1", kind: "move", request: "{}" };
const clock = () => {
  let t = 1_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

describe("PublishGrants", () => {
  it("a token works once, for exactly its binding", () => {
    const g = new PublishGrants();
    const { token } = g.issue(B, "w1");
    const t = g.take(token, B);
    expect(t).toMatchObject({ ok: true, grant: { what: "w1", owner: "ann" } });
    expect(g.take(token, B)).toEqual({ ok: false, reason: "used" });
  });

  it("expires after the time limit", () => {
    const c = clock();
    const g = new PublishGrants({ now: c.now });
    const { token, expiresAt } = g.issue(B, "w");
    expect(expiresAt).toBe(c.now() + PUBLISH_TTL_MS);
    c.advance(PUBLISH_TTL_MS);
    expect(g.take(token, B)).toEqual({ ok: false, reason: "used" });
  });

  it("a token that does not fit (owner, project, kind, request) is burned", () => {
    const g = new PublishGrants();
    for (const other of [{ owner: "bob" }, { repoId: "r2" }, { kind: "push-remote" as const }, { request: "{\"a\":1}" }]) {
      const { token } = g.issue(B, "w");
      expect(g.take(token, { ...B, ...other })).toEqual({ ok: false, reason: "mismatch" });
      expect(g.take(token, B)).toEqual({ ok: false, reason: "used" });
    }
  });

  it("refuses a missing or odd token as needed", () => {
    const g = new PublishGrants();
    for (const t of [undefined, null, 5, "", "short"]) expect(g.take(t, B)).toEqual({ ok: false, reason: "needed" });
  });

  it("a newer check replaces the older one of the same account, project and kind only", () => {
    const g = new PublishGrants();
    const a = g.issue(B, "w");
    const other = g.issue({ ...B, kind: "push-remote" }, "w");
    const b = g.issue(B, "w2");
    expect(g.take(a.token, B)).toEqual({ ok: false, reason: "used" });
    expect(g.take(b.token, B)).toMatchObject({ ok: true });
    expect(g.take(other.token, { ...B, kind: "push-remote" })).toMatchObject({ ok: true });
  });

  it("limits the tokens per account and in all", () => {
    const g = new PublishGrants({ perOwner: 2, max: 3 });
    const t = [1, 2, 3].map((i) => g.issue({ ...B, repoId: `r${i}` }, "w").token);
    expect(g.size).toBe(2);
    expect(g.take(t[0], { ...B, repoId: "r1" })).toMatchObject({ ok: false });
    for (const o of ["x", "y", "z"]) g.issue({ ...B, owner: o }, "w");
    expect(g.size).toBeLessThanOrEqual(3);
  });

  it("keeps no raw token", () => {
    const g = new PublishGrants();
    const { token } = g.issue(B, "w");
    expect(JSON.stringify([...(g as unknown as { grants: Map<string, unknown> }).grants])).not.toContain(token);
  });
});

describe("fingerprint and words", () => {
  it("is stable and sensitive", () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint("x")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("every refusal says that nothing was published", () => {
    for (const w of Object.values(PUBLISH_WORDS)) expect(w).toMatch(/^Nothing was published/);
    expect(refusalText("mismatch")).toBe(PUBLISH_WORDS.mismatch);
  });
});
