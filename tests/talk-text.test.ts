import { describe, expect, it } from "vitest";
import { emptyTalk, type Talk } from "../src/refinement/talk.js";
import { QUESTION_HEADING, TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength, cutBytes, questionOf, talkText } from "../src/refinement/talk-text.js";

const AT = "2026-01-01T00:00:00.000Z";
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

type Q = Talk["rounds"][number]["questions"][number];
const question = (text: string, answer?: Q["answer"], pad = ""): Q => ({
  id: uuid(),
  view: "need",
  text: text + pad,
  why: "It matters.",
  options: [
    { text: "One", tradeoff: "Cheap" },
    { text: "Two", tradeoff: "Dear" },
  ],
  recommended: 2,
  ...(answer ? { answer } : {}),
});
const round = (i: number, questions: Q[], done?: string): Talk["rounds"][number] => ({ runId: `run-${i}`, at: AT, questions, ...(done ? { done } : {}) });
const talkOf = (rounds: Talk["rounds"]): Talk => ({ ...emptyTalk(), rounds });
const bytes = (t: string) => Buffer.byteLength(t, "utf8");

describe("talkText", () => {
  it("starts with the line of the kind and has every part in order, with (none) for the empty ones", () => {
    const t = talkText({ kind: "round", idea: "An idea", talk: emptyTalk() });
    expect(t.split("\n")[0]).toBe(TALK_FIRST_LINE.round);
    expect(talkText({ kind: "question", idea: "x", talk: emptyTalk(), question: "Why?" }).split("\n")[0]).toBe(TALK_FIRST_LINE.question);
    const at = ["## The idea", "## The context brief\n(none)", "## The map of the story so far", "### Rules\n(none)", "### Examples\n(none)", "### Open questions\n(none)", "## The rounds so far\n(none)", "## The entries the person rejected\n(none)"].map((p) => t.indexOf(p));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(t).not.toContain("## Left out");
    expect(t).not.toContain(QUESTION_HEADING);
  });

  it("writes the three answer forms, the recommended option and the done line", () => {
    const talk = talkOf([
      round(1, [question("A", { at: AT, option: 1 }), question("B", { at: AT, text: "My words" }), question("C", { at: AT, unknown: true })], "Nothing is left."),
    ]);
    const t = talkText({ kind: "round", idea: "i", brief: "The brief", talk, rejected: [{ list: "rule", text: "No way" }] });
    expect(t).toContain("Option 2 (recommended): Two — Dear");
    expect(t).toContain("Option 1: One — Cheap");
    expect(t).toContain("New answer: option 1: One");
    expect(t).toContain("New answer: my own answer: My words");
    expect(t).toContain("New answer: I don't know yet");
    expect(t).toContain("Done: Nothing is left.");
    expect(t).toContain("## The context brief\nThe brief");
    expect(t).toContain("- rule: No way");
  });

  it("marks only answered questions of the last round as new", () => {
    const talk = talkOf([round(1, [question("Old", { at: AT, option: 1 })]), round(2, [question("Fresh", { at: AT, option: 2 }), question("Open")])]);
    const t = talkText({ kind: "question", idea: "i", talk, question: "Why?" });
    expect(t).toContain("\nAnswer: option 1: One");
    expect(t.match(/New answer: /g)).toHaveLength(1);
    expect(t).toContain("New answer: option 2: Two");
    expect(t).toContain("Answer: (no answer yet)");
    expect(t).not.toContain("New answer: (no answer yet)");
  });

  it("puts the question part last, only for kind question", () => {
    const q = talkText({ kind: "question", idea: "i", talk: emptyTalk(), question: "Is it so?\nSecond line" });
    expect(q.endsWith(`${QUESTION_HEADING} (21 characters)\nIs it so?\nSecond line`)).toBe(true);
    expect(talkText({ kind: "round", idea: "i", talk: emptyTalk(), question: "ignored" })).not.toContain("ignored");
  });

  it("leaves out the oldest rounds first and the brief last", () => {
    const pad = "x".repeat(20_000);
    const rounds = [1, 2, 3, 4].map((i) => round(i, [question(`R${i}`, { at: AT, option: 1 }, pad)]));
    const brief = "b".repeat(39_990) + "THE-END";
    const t = talkText({ kind: "round", idea: "i", brief, talk: talkOf(rounds) });
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).not.toContain("### Round 1");
    expect(t).toContain("### Round 3");
    expect(t).toContain("### Round 4");
    expect(t).toContain("The oldest 2 rounds of the talk were left out.");
    expect(t).toContain("THE-END");
    expect(t).not.toContain("brief was cut");
  });

  it("cuts the brief when every older round is gone, and says both", () => {
    const rounds = [1, 2, 3].map((i) => round(i, [question(`R${i}`, { at: AT, option: 1 })]));
    rounds.push(round(4, [question("R4", { at: AT, option: 1 }, "y".repeat(40_000))]));
    const t = talkText({ kind: "round", idea: "i", brief: "b".repeat(60_000), talk: talkOf(rounds) });
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    for (const i of [1, 2, 3]) expect(t).not.toContain(`### Round ${i}\n`);
    expect(t).toContain("### Round 4");
    expect(t).toContain("y".repeat(40_000));
    expect(t.indexOf("The oldest 3 rounds")).toBeGreaterThan(0);
    expect(t.indexOf("The context brief was cut")).toBeGreaterThan(t.indexOf("The oldest 3 rounds"));
  });

  it("cuts a brief of 3-byte characters on a whole character", () => {
    const talk = talkOf([round(1, [question("Q")])]);
    const t = talkText({ kind: "round", idea: "i", brief: "€".repeat(60_000), talk });
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).toContain("The context brief was cut");
    expect(t).not.toContain("�");
    expect(t).toContain("### Round 1");
  });

  it("cuts the end when the map alone is too big, and keeps the question whole", () => {
    const talk = emptyTalk();
    talk.map.rules = Array.from({ length: 300 }, () => ({ id: uuid(), text: "😀".repeat(500), at: AT }));
    const t = talkText({ kind: "question", idea: "i", talk, question: "Is this 😀 so?" });
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).toContain("The end of the talk was cut");
    expect(t.endsWith(`${QUESTION_HEADING} (13 characters)\nIs this 😀 so?`)).toBe(true);
    expect(t).not.toContain("�");
  });

  it("names every omitted part in one notice that survives the cut of the end", () => {
    const pad = "z".repeat(20_000);
    const rounds = [1, 2, 3].map((i) => round(i, [question(`R${i}`, { at: AT, option: 1 }, pad)]));
    const talk = talkOf(rounds);
    talk.map.rules = Array.from({ length: 300 }, () => ({ id: uuid(), text: "😀".repeat(500), at: AT }));
    const t = talkText({ kind: "question", idea: "i", brief: "brief text", talk, question: "Is it so?" });
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    const notice = t.slice(t.lastIndexOf("## Left out"));
    expect(notice).toContain("The oldest 2 rounds of the talk were left out.");
    expect(notice).toContain("The context brief was left out.");
    expect(notice).toContain("The end of the talk was cut");
    expect(t.endsWith("Is it so?")).toBe(true);
  });
});

describe("cutBytes", () => {
  it("never splits an emoji", () => {
    expect(cutBytes("a😀b", 4)).toBe("a");
    expect(cutBytes("a😀b", 5)).toBe("a😀");
    expect(cutBytes("abc", 10)).toBe("abc");
    expect(cutBytes("abc", 0)).toBe("");
    expect(byteLength(cutBytes("😀".repeat(10), 21))).toBe(20);
  });
});

describe("questionOf", () => {
  const read = (q: string, extra: Partial<Parameters<typeof talkText>[0]> = {}) => questionOf(talkText({ kind: "question", idea: "idea", talk: emptyTalk(), question: q, ...extra }));
  it("gives the question back", () => {
    expect(read("One line?")).toBe("One line?");
    expect(read("Line one\nline two\n\nline four")).toBe("Line one\nline two\n\nline four");
    expect(read("Emoji 😀?")).toBe("Emoji 😀?");
  });
  it("gives back a question that holds the heading and a blank line", () => {
    const tricky = `Why?\n\n${QUESTION_HEADING} (4 characters)\nreal\n\n${QUESTION_HEADING}\nmore`;
    expect(read(tricky)).toBe(tricky);
    expect(read(`${QUESTION_HEADING}\nonly`)).toBe(`${QUESTION_HEADING}\nonly`);
  });
  it("gives it back from a capped text", () => {
    expect(read("Still here?", { brief: "b".repeat(200_000) })).toBe("Still here?");
  });
  it("is undefined for a round text", () => {
    expect(questionOf(talkText({ kind: "round", idea: "i", talk: emptyTalk() }))).toBeUndefined();
  });
});
