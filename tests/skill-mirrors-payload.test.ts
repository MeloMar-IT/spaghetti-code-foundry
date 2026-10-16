import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/skills/catalogue.js";
import { renderReviewPayload, renderSkillPayload, type PayloadSkill, type ReviewSkill } from "../src/skills/payload.js";

const sk = (id: string, o: Partial<PayloadSkill> = {}): PayloadSkill => ({
  id, version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, selection: "requested", requiredBy: [],
  description: "Same.", instructions: "word ".repeat(300), ...o,
});
const tokens = (s: PayloadSkill[]) => estimateTokens(renderSkillPayload(s, { maxTokens: 100000 }).text);

describe("mirrors in renderSkillPayload", () => {
  it("renders the text once and keeps both attributed when only one copy fits", () => {
    const one = renderSkillPayload([sk("a")], { maxTokens: 100000 });
    const cap = one.estimatedTokens; // exactly the single-copy budget
    const p = renderSkillPayload([sk("a"), sk("b")], { maxTokens: cap });
    expect(p.loaded).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(p.omitted).toEqual([]);
    expect(p.collapsed).toEqual([{ key: "b@1.0.0", into: "a@1.0.0" }]);
    expect(p.text).toContain('count="1"');
    expect(p.text).toContain(`digest="sha256:${"a".repeat(64)}" also="b@1.0.0">`);
    expect(p.text.match(/Same\./g)).toHaveLength(1);
    expect(p.text.match(/<foundry-skill /g)).toHaveLength(1);
  });

  it("does not block a mandatory copy at exactly the single-copy budget", () => {
    const cap = renderSkillPayload([sk("a", { selection: "mandatory" })], { maxTokens: 100000 }).estimatedTokens;
    const p = renderSkillPayload([sk("a", { selection: "mandatory" }), sk("b", { selection: "mandatory" })], { maxTokens: cap });
    expect(p.blocked).toBeUndefined();
    expect(p.omitted).toEqual([]);
    expect(p.collapsed).toEqual([{ key: "b@1.0.0", into: "a@1.0.0" }]);
  });

  it("does not collapse a one-character difference", () => {
    const p = renderSkillPayload([sk("a"), sk("b", { instructions: `${"word ".repeat(300)}x` })], { maxTokens: 100000 });
    expect(p.text).toContain('count="2"');
    expect(p.collapsed).toBeUndefined();
    expect(p.text).not.toContain("also=");
  });

  it("keeps the first in load order and sorts also", () => {
    const p = renderSkillPayload([sk("c"), sk("b"), sk("a")], { maxTokens: 100000 });
    expect(p.text).toContain(`<foundry-skill id="c" version="1.0.0" digest="sha256:${"a".repeat(64)}" also="a@1.0.0,b@1.0.0">`);
    expect(p.collapsed).toEqual([{ key: "b@1.0.0", into: "c@1.0.0" }, { key: "a@1.0.0", into: "c@1.0.0" }]);
  });

  it("has no collapsed field without copies", () => {
    expect(renderSkillPayload([sk("a"), sk("b", { description: "Other." })], { maxTokens: 100000 })).not.toHaveProperty("collapsed");
  });

  it("does not block a mandatory copy after a requested original", () => {
    const list = [sk("a"), sk("b", { selection: "mandatory" })];
    const p = renderSkillPayload(list, { maxTokens: tokens(list) });
    expect(p.blocked).toBeUndefined();
    expect(p.loaded).toEqual(["a@1.0.0", "b@1.0.0"]);
  });

  it("keeps a later mandatory skill and the copy when the budget is exactly the distinct texts", () => {
    const m = sk("m", { selection: "mandatory", description: "Other.", instructions: "word ".repeat(40) });
    const p = renderSkillPayload([sk("a"), sk("b"), m], { maxTokens: tokens([sk("a"), m]) });
    expect(p.blocked).toBeUndefined();
    expect(p.omitted).toEqual([]);
    expect(p.loaded).toEqual(["a@1.0.0", "b@1.0.0", "m@1.0.0"]);
  });

  it("does not let a copy's dependency block anything else", () => {
    const a = sk("a", { selection: "mandatory" });
    const c = sk("c", { selection: "dependency", requiredBy: ["b"], description: "Other.", instructions: "word ".repeat(2000) });
    const p = renderSkillPayload([a, sk("b"), c], { maxTokens: tokens([a]) + 40 });
    expect(p.blocked).toBeUndefined();
    expect(p.loaded).toEqual(["a@1.0.0"]);
    expect(p.omitted).toEqual(["b@1.0.0", "c@1.0.0"]);
  });

  it("omits every copy, and blocks the mandatory one, when the text itself does not fit", () => {
    const p = renderSkillPayload([sk("a"), sk("b", { selection: "mandatory" })], { maxTokens: 50 });
    expect(p.loaded).toEqual([]);
    expect(p.omitted).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(p.blocked).toBe("b@1.0.0");
  });
});

describe("mirrors in renderReviewPayload", () => {
  const rv = (id: string, o: Partial<ReviewSkill> = {}): ReviewSkill => ({ id, version: "1.0.0", digest: `sha256:${"b".repeat(64)}`, description: "Same.", review: "Check it.", ...o });
  const limits = { maxTokens: 100000, maxSkillTokens: 100000 };

  it("collapses the same description and REVIEW.md", () => {
    const p = renderReviewPayload([rv("a"), rv("b")], limits);
    expect(p.loaded).toEqual(["a@1.0.0", "b@1.0.0"]);
    expect(p.collapsed).toEqual([{ key: "b@1.0.0", into: "a@1.0.0" }]);
    expect(p.text).toContain('count="1" role="reviewer"');
    expect(p.text).toContain('also="b@1.0.0"');
  });
  it("does not collapse a different REVIEW.md", () => {
    const p = renderReviewPayload([rv("a"), rv("b", { review: "Check it!" })], limits);
    expect(p.text).toContain('count="2"');
    expect(p.collapsed).toBeUndefined();
  });
  it("never omits a copy, and never lets it push out a distinct later skill, at the exact budget", () => {
    const other = rv("c", { review: "Another check." });
    const cap = estimateTokens(renderReviewPayload([rv("a"), other], limits).text);
    const p = renderReviewPayload([rv("a"), rv("b"), other], { ...limits, maxTokens: cap });
    expect(p.loaded).toEqual(["a@1.0.0", "b@1.0.0", "c@1.0.0"]);
    expect(p.omitted).toEqual([]);
    expect(p.collapsed).toEqual([{ key: "b@1.0.0", into: "a@1.0.0" }]);
  });
});
