import { describe, expect, it } from "vitest";
import { countQuestions, DECIDED_HEADING as TS_HEADING } from "../src/next-step.js";
// @ts-expect-error a plain ES module of the tools folder, without types
import { DECIDED_HEADING, LIMITS, decideQuestions, readQuestions } from "../tools/decide-questions.mjs";

const tech = (n: number, rec = "**Recommendation:** pg — simple") => `**Q${n}. Which db ${n}?**\n**Kind:** technical\nOptions: pg or sqlite.\n${rec}`;
const kindOf = (k: string) => readQuestions(`**Q1. A?**\n${k}\nx`).questions[0].kind;

describe("decide-questions", () => {
  it("mirrors the heading and the limits", () => {
    expect(DECIDED_HEADING).toBe(TS_HEADING);
    expect(LIMITS).toEqual({ decided: 20, title: 300, text: 4000, decision: 1000, rounds: 500, bytes: 1048576 });
  });

  it("reads the kind in any spelling, and defaults to product", () => {
    expect(kindOf("**Kind:** technical")).toBe("technical");
    expect(kindOf("**Kind**: Technical")).toBe("technical");
    expect(kindOf("**Kind:** owner action")).toBe("owner_action");
    expect(kindOf("**Kind:** Owner-Action")).toBe("owner_action");
    expect(kindOf("**Kind:** OWNER_ACTION")).toBe("owner_action");
    expect(kindOf("**Kind:** `policy`")).toBe("policy");
    expect(kindOf("")).toBe("product");
    expect(kindOf("**Kind:** banana")).toBe("product");
    expect(kindOf("**Kind:** technical | product | policy | owner_action")).toBe("product");
  });

  it("keeps the whole recommendation, qualifications included", () => {
    const body = `${tech(1, "**Recommendation:** (a) pg\n\nOnly if X; otherwise sqlite.\n- note")}\n**Q2. Next?**`;
    const q = readQuestions(body).questions;
    expect(q[0].recommendation).toBe("(a) pg\n\nOnly if X; otherwise sqlite.\n- note");
    expect(q[1].recommendation).toBeUndefined();
    expect(decideQuestions(body).decided[0].decision).toContain("Only if X; otherwise sqlite.");
  });

  it("finds an inline recommendation marker", () => {
    const q = readQuestions("**Q1. A?**\n**Kind:** technical\nOptions: A or B. **Recommendation:** A, because x").questions[0];
    expect(q.recommendation).toBe("A, because x");
  });

  it("treats none as no recommendation", () => {
    for (const none of ["none", "None — owner must choose"]) {
      const r = decideQuestions(tech(1, `**Recommendation:** ${none}`));
      expect(r.decided).toEqual([]);
      expect(r.left).toBe(1);
    }
  });

  it("treats none with Markdown marks or an explanation on the next lines as no recommendation", () => {
    for (const rec of ["`none`", "**none**", "none\n\nThe owner must choose the store.", "`none`\n\nNeeds a product call."]) {
      const r = decideQuestions(tech(1, `**Recommendation:** ${rec}`));
      expect(r.decided, rec).toEqual([]);
      expect(r.left, rec).toBe(1);
    }
  });

  it("does not swallow **Q100. into **Q1.", () => {
    const r = decideQuestions(`${tech(1)}\n**Q100. Other?**\nplain`);
    expect(r.decided.map((d: { n: number }) => d.n)).toEqual([1]);
    expect(r.body).toContain("**Q100. Other?**");
    expect(r.left).toBe(1);
  });

  it("decides nothing on a duplicate number", () => {
    const body = `${tech(1)}\n${tech(1)}`;
    expect(readQuestions(body).questions[1].dup).toBe(true);
    expect(decideQuestions(body)).toEqual({ body, decided: [], left: 1 });
  });

  it.each(["**Questions below**", "**Q 2. x**", "**Qx. y**", "see **Q3. z** here"])("decides nothing with %s", (line) => {
    const body = `${tech(1)}\n${line}`;
    expect(readQuestions(body).ambiguous).toBeDefined();
    expect(decideQuestions(body).decided).toEqual([]);
  });

  it("counts left like countQuestions when the input is ambiguous", () => {
    const body = `see **Q1. inline** here\n${tech(2)}`;
    const r = decideQuestions(body);
    expect(r.body).toBe(body);
    expect(r.left).toBe(countQuestions(body));
    expect(r.left).toBe(2);
    const zero = "**Q01. A?**\n**Q1. B?**";
    expect(decideQuestions(zero).left).toBe(countQuestions(zero));
  });

  it("decides nothing with a second marker or a kind after the recommendation", () => {
    for (const b of [`${tech(1)}\n**Recommendation:** other`, `${tech(1)}\n**Kind:** product`, "**Q1. A?**\n**Recommendation:** x\n**Kind:** technical"]) {
      expect(readQuestions(b).ambiguous, b).toBeDefined();
      expect(decideQuestions(b).decided, b).toEqual([]);
    }
  });

  it("reads nothing after the decided heading, and appends to an old section", () => {
    const old = `**Q1. Ship?**\n\n${DECIDED_HEADING}\n\n> **Q9. Old?**\n\n**Decision:** x`;
    expect(readQuestions(old).questions.map((q: { n: number }) => q.n)).toEqual([1]);
    const r = decideQuestions(`${tech(2)}\n\n${DECIDED_HEADING}\n\n> **Q9. Old?**\n\n**Decision:** x`);
    expect(r.body.split(DECIDED_HEADING)).toHaveLength(2);
    expect(r.body).toContain("> **Q9. Old?**");
    expect(r.body).toContain("> **Q2. Which db 2?**");
  });

  it("removes QUESTIONS lines and handles CRLF", () => {
    const body = `Intro\n\n${tech(1)}\n**Q2. Open?**\nQUESTIONS: 2`;
    const lf = decideQuestions(body);
    expect(lf.body).not.toContain("QUESTIONS:");
    expect(decideQuestions(body.replace(/\n/g, "\r\n"))).toEqual(lf);
  });

  it("splits a mixed body", () => {
    const body = `Intro\n\n**Q1. Who pays?**\n**Kind:** policy\n**Recommendation:** us\n\n${tech(2, "**Recommendation:** pg\n\nunless X")}\n\n**Q3. Look?**\nplain`;
    const r = decideQuestions(body);
    expect(r.body).toBe([
      "Intro",
      "**Q1. Who pays?**\n**Kind:** policy\n**Recommendation:** us",
      "**Q3. Look?**\nplain",
      DECIDED_HEADING,
      "> **Q2. Which db 2?**\n> **Kind:** technical\n> Options: pg or sqlite.\n> **Recommendation:** pg\n>\n> unless X\n\n**Decision:** pg\n\nunless X",
    ].join("\n\n"));
    expect(r.decided).toEqual([{ n: 2, title: "Which db 2?", text: expect.stringContaining("**Q2."), decision: "pg\n\nunless X" }]);
    expect(r.left).toBe(2);
    expect(r.left).toBe(countQuestions(r.body));
  });

  it("decides at most 20 per round", () => {
    const r = decideQuestions(Array.from({ length: 21 }, (_, i) => tech(i + 1)).join("\n"));
    expect(r.decided).toHaveLength(20);
    expect(r.left).toBe(1);
  });

  it("asks when a title, text or decision is too long", () => {
    const withTitle = (len: number) => `**Q1. ${"t".repeat(len)}**\n**Kind:** technical\n**Recommendation:** x`;
    expect(decideQuestions(withTitle(LIMITS.title + 1)).decided).toHaveLength(0);
    expect(decideQuestions(withTitle(LIMITS.title)).decided).toHaveLength(1);
    const withText = (len: number) => { const h = "**Q1. A?**\n**Kind:** technical\n"; const t = "\n**Recommendation:** x"; return `${h}${"y".repeat(len - h.length - t.length)}${t}`; };
    expect(decideQuestions(withText(LIMITS.text + 1)).decided).toHaveLength(0);
    expect(decideQuestions(withText(LIMITS.text)).decided).toHaveLength(1);
    const withDecision = (len: number) => `**Q1. A?**\n**Kind:** technical\n**Recommendation:** ${"d".repeat(len)}`;
    expect(decideQuestions(withDecision(LIMITS.decision + 1)).decided).toHaveLength(0);
    expect(decideQuestions(withDecision(LIMITS.decision)).decided).toHaveLength(1);
  });

  it("returns a body without technical questions unchanged", () => {
    const body = "**Q1. A?**\n**Kind:** product\n**Recommendation:** x";
    expect(decideQuestions(body)).toEqual({ body, decided: [], left: 1 });
  });
});
