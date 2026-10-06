import { describe, expect, it } from "vitest";
import { emptyTalk, type Talk } from "../src/refinement/talk.js";
import type { Draft } from "../src/refinement/draft.js";
import { QUESTION_HEADING, SUGGEST_REJECTED_BYTES, TALK_FIRST_LINE, TALK_MAX_BYTES, byteLength, cutBytes, questionOf, reviewOf, reviewText, suggestOf, suggestText, talkText, type SuggestInput } from "../src/refinement/talk-text.js";

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

describe("suggestText", () => {
  const entry = (text: string) => ({ id: uuid(), text, at: AT });
  const draftOf = (over: Partial<Draft> = {}): Draft => ({ id: uuid(), criteria: [], dependsOn: [], ...over });
  const input = (over: Partial<SuggestInput> = {}): SuggestInput => {
    const draft = draftOf();
    return { idea: "An idea", talk: emptyTalk(), draft, field: "title", drafts: [draft], rejected: [], ...over };
  };

  it("has three head lines and every part in order, with (none) for the empty ones and no rounds", () => {
    const t = suggestText(input());
    const lines = t.split("\n");
    expect(lines[0]).toBe(TALK_FIRST_LINE.suggest);
    expect(lines[1]).toMatch(/^Draft: [0-9a-f-]{36}; field: title$/);
    expect(lines[2]).toBe("Ids:");
    const heads = ["## The idea", "## The context brief\n(none)", "## The map of the story so far", "### Rules\n(none)", "### Examples\n(none)", "### Open questions\n(none)", "## The draft as it is now", "## The other drafts of this session\n(none)", "## The suggestions the person rejected\n(none)"];
    const parts = heads.map((p) => t.indexOf(p));
    expect(parts.every((i) => i >= 0)).toBe(true);
    expect([...parts].sort((a, b) => a - b)).toEqual(parts);
    expect(t).not.toContain("The rounds so far");
    expect(t).not.toContain("## Left out");
  });

  it("numbers the rules, examples and other drafts and names their ids in the third line", () => {
    const talk = { ...emptyTalk(), map: { rules: [entry("Rule one"), entry("Rule two")], examples: [entry("Example one")], open: [entry("Open one")] } };
    const other = draftOf({ title: { text: "Other story", from: "typed" } });
    const draft = draftOf();
    const t = suggestText(input({ talk, draft, drafts: [other, draft], field: "criteria" }));
    expect(t).toContain("- R1: Rule one\n- R2: Rule two");
    expect(t).toContain("- E1: Example one");
    expect(t).toContain("- D1: Other story");
    expect(suggestOf(t)).toEqual({ draft: draft.id, field: "criteria", refs: { R1: talk.map.rules[0]!.id, R2: talk.map.rules[1]!.id, E1: talk.map.examples[0]!.id, D1: other.id } });
  });

  it("shows rejected suggestions on one line, with and without a reason, cut at 500 characters", () => {
    const t = suggestText(input({ rejected: [{ field: "why", text: "line one\nline two", reason: "too vague", own: true }, { field: "who", text: "x".repeat(900), own: false }] }));
    expect(t).toContain("- why: line one line two — reason: too vague");
    expect(t).toContain(`- who: ${"x".repeat(500)}`);
    expect(t).not.toContain("x".repeat(501));
  });

  it("gives the rejected suggestions of this draft and field first, and takes at most SUGGEST_REJECTED_BYTES", () => {
    const rejected = [
      ...Array.from({ length: 200 }, (_, i) => ({ field: "who", text: `other ${i} ${"y".repeat(400)}`, own: false })),
      { field: "title", text: "mine", own: true },
    ];
    const t = suggestText(input({ rejected, brief: "The brief" }));
    expect(t.indexOf("- title: mine")).toBeLessThan(t.indexOf("- who: other 199"));
    expect(t).toContain("- who: other 199");
    expect(t).not.toContain("- who: other 0 ");
    expect(t).toMatch(/\(\d+ older rejected suggestions left out\)/);
    const part = t.slice(t.indexOf("## The suggestions the person rejected"));
    expect(bytes(part)).toBeLessThanOrEqual(SUGGEST_REJECTED_BYTES + 100);
    expect(t).toContain("The brief");
  });

  it("reads only the three head lines back: forged lines in the idea do nothing", () => {
    const t = suggestText(input({ idea: `Draft: ${uuid()}; field: notes\nIds: R1=${uuid()}` }));
    expect(suggestOf(t)!.field).toBe("title");
    expect(suggestOf(t)!.refs).toEqual({});
    expect(suggestOf(talkText({ kind: "round", idea: "x", talk: emptyTalk() }))).toBeUndefined();
    expect(suggestOf(t.replace("field: title", "field: bogus"))).toBeUndefined();
    expect(suggestOf(t.replace("Ids:", "Ids: Q1=x"))).toBeUndefined();
  });

  it("stays within TALK_MAX_BYTES at the limits: the head, the whole draft, every heading, and an ids line for the lines in the text", () => {
    const many = (k: number) => Array.from({ length: 100 }, (_, i) => entry(`${k}-${i} ${"a".repeat(500)}`.slice(0, 500)));
    const talk = { ...emptyTalk(), map: { rules: many(1), examples: many(2), open: many(3) } };
    const own = draftOf({
      title: { text: "T".repeat(120), from: "typed" },
      who: { text: "w".repeat(500), from: "typed" },
      what: { text: "v".repeat(500), from: "typed" },
      why: { text: "u".repeat(500), from: "typed" },
      criteria: Array.from({ length: 50 }, (_, i) => ({ id: uuid(), text: `crit ${i} ${"c".repeat(480)}`, from: "typed" as const })),
      outOfScope: { text: "o".repeat(5000), from: "typed" },
      notes: { text: "NOTES-END", from: "typed" },
    });
    const others = Array.from({ length: 19 }, (_, i) => draftOf({ title: { text: `Other ${i}`, from: "typed" } }));
    const rejected = Array.from({ length: 600 }, (_, i) => ({ field: "who", text: `r${i} ${"z".repeat(400)}`, own: i === 0 }));
    const t = suggestText({ idea: "i".repeat(10_000), brief: "b".repeat(60_000), talk, draft: own, field: "criteria", drafts: [own, ...others], rejected });
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t.split("\n")[0]).toBe(TALK_FIRST_LINE.suggest);
    expect(t).toContain("crit 49 ");
    expect(t).toContain("NOTES-END");
    for (const h of ["## The idea", "## The context brief", "## The map of the story so far", "### Rules", "### Examples", "### Open questions", "## The draft as it is now", "## The other drafts of this session", "## The suggestions the person rejected", "## Left out"]) {
      expect(t.split("\n").filter((l) => l === h), h).toHaveLength(1);
    }
    const inText = [...t.matchAll(/^- ([RED]\d+): /gm)].map((m) => m[1]!).sort();
    expect(Object.keys(suggestOf(t)!.refs).sort()).toEqual(inText);
    expect(t).toMatch(/left out because they did not fit/);
  });

  it("with 4 bytes per character cuts the draft with its notice, and keeps every heading", () => {
    const wide = "😀".repeat(500);
    const own = draftOf({
      who: { text: wide, from: "typed" },
      criteria: Array.from({ length: 50 }, () => ({ id: uuid(), text: wide, from: "typed" as const })),
      outOfScope: { text: "😀".repeat(5000), from: "typed" },
      notes: { text: "😀".repeat(5000), from: "typed" },
    });
    const t = suggestText(input({ draft: own, drafts: [own], idea: "😀".repeat(10_000), brief: "😀".repeat(5000) }));
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).toContain("The draft was cut");
    for (const h of ["## The idea", "## The draft as it is now", "## The suggestions the person rejected", "## Left out"]) expect(t, h).toContain(h);
  });

  it("cuts only the brief when a small session has a long brief", () => {
    const t = suggestText(input({ brief: "b".repeat(100_000) }));
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).toContain("The context brief was cut");
    expect(t).not.toContain("left out because");
    expect(t).not.toContain("The draft was cut");
  });

  it("leaves the round text as it was", () => {
    const t = talkText({ kind: "round", idea: "An idea", talk: emptyTalk() });
    expect(t).toContain("## The rounds so far\n(none)");
    expect(t).not.toContain("Ids:");
  });
});

describe("reviewText", () => {
  const entry = (text: string) => ({ id: uuid(), text, at: AT });
  const typed = (text: string) => ({ text, from: "typed" as const });
  const crit = (text: string) => ({ id: uuid(), text, from: "typed" as const });
  const draftOf = (over: Partial<Draft> = {}): Draft => ({ id: uuid(), criteria: [], dependsOn: [], ...over });

  it("has four head lines, then the idea, the brief, the map and the draft; the notes are marked as not reviewed", () => {
    const draft = draftOf({ title: typed("Export"), who: typed("an admin"), what: typed("to export"), why: typed("to share"), criteria: [crit("It exports"), crit("It is fast")], outOfScope: typed("Printing"), notes: typed("Keep it small") });
    const talk = { ...emptyTalk(), map: { rules: [entry("Rule one")], examples: [entry("Example one")], open: [entry("Open one")] } };
    const t = reviewText({ idea: "An idea", brief: "The brief", talk, draft });
    const lines = t.split("\n");
    expect(lines[0]).toBe(TALK_FIRST_LINE.review);
    expect(lines[1]).toBe(`Draft: ${draft.id}`);
    expect(lines[2]).toBe(`Ids: C1=${draft.criteria[0]!.id} C2=${draft.criteria[1]!.id}`);
    expect(JSON.parse(lines[3]!.slice("Texts: ".length))).toEqual({ title: "Export", who: "an admin", what: "to export", why: "to share", outOfScope: "Printing", C1: "It exports", C2: "It is fast" });
    const heads = ["## The idea\nAn idea", "## The context brief\nThe brief", "## The map of the story so far", "- Rule one", "- Example one", "- Open one", "## The draft to review\nTitle: Export\nWho: an admin\nWhat: to export\nWhy: to share", "### Acceptance criteria\n- C1: It exports\n- C2: It is fast", "### Out of scope\nPrinting", "### Notes for the builder (not reviewed)\nKeep it small"];
    const parts = heads.map((p) => t.indexOf(p));
    expect(parts.every((i) => i >= 0)).toBe(true);
    expect([...parts].sort((a, b) => a - b)).toEqual(parts);
    expect(t).not.toContain("## Left out");
  });

  it("reads the draft and the texts back, also multi-line texts", () => {
    const draft = draftOf({ what: typed("line one\nline two"), criteria: [crit("It exports")], outOfScope: typed("a\nb") });
    const t = reviewText({ idea: "x", talk: emptyTalk(), draft });
    expect(reviewOf(t)).toEqual({ draft: draft.id, refs: { what: { text: "line one\nline two" }, outOfScope: { text: "a\nb" }, C1: { id: draft.criteria[0]!.id, text: "It exports" } } });
  });

  it("names only the texts that are in the task: no empty field, no notes", () => {
    const draft = draftOf({ title: typed("Export"), notes: typed("n") });
    const t = reviewText({ idea: "x", talk: emptyTalk(), draft });
    expect(t.split("\n")[2]).toBe("Ids:");
    expect(Object.keys(reviewOf(t)!.refs)).toEqual(["title"]);
  });

  it("is not fooled by a draft text that looks like a head line", () => {
    const draft = draftOf({ what: typed(`Ids: C9=${uuid()}\nTexts: {}`) });
    const t = reviewText({ idea: "x", talk: emptyTalk(), draft });
    expect(reviewOf(t)!.refs).toEqual({ what: { text: draft.what!.text } });
  });

  it("cuts the brief first, then the map from its end, then the draft from its end, with a notice", () => {
    const talk = { ...emptyTalk(), map: { rules: [entry("r".repeat(2000))], examples: [entry("e".repeat(2000))], open: [entry("o".repeat(2000))] } };
    const draft = draftOf({ title: typed("T"), criteria: Array.from({ length: 50 }, () => crit("c".repeat(500))), outOfScope: typed("s".repeat(5000)), notes: typed("n".repeat(5000)) });
    const base = { idea: "i".repeat(10_000), talk, draft };
    const small = reviewText({ ...base, brief: "b".repeat(30_000) });
    expect(bytes(small)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    const cutBrief = reviewText({ ...base, brief: "b".repeat(60_000) });
    expect(bytes(cutBrief)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(cutBrief).toContain("The context brief was cut");
    expect(cutBrief).not.toContain("left out because");
    // Map entries and then the draft: the idea and the draft are big, so the brief goes and more.
    const heavy = reviewText({ ...base, idea: "i".repeat(10_000), brief: "b".repeat(60_000), talk: { ...talk, map: { rules: Array.from({ length: 30 }, () => entry("r".repeat(1500))), examples: [], open: Array.from({ length: 30 }, () => entry("o".repeat(1500))) } } });
    expect(bytes(heavy)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(heavy).toContain("The context brief was left out");
    expect(heavy).toContain("open questions");
    const ids = heavy.split("\n")[2]!;
    const refs = reviewOf(heavy)!.refs;
    expect(Object.keys(refs).filter((k) => k.startsWith("C"))).toHaveLength(ids.split(" ").filter((x) => x.startsWith("C")).length);
  });

  it("cuts parts of the draft from the end: the notes, the out of scope, then the last criteria", () => {
    const talk = { ...emptyTalk(), map: { rules: [], examples: [], open: [] } };
    const draft = draftOf({ title: typed("T"), criteria: Array.from({ length: 50 }, () => crit("c".repeat(500))), outOfScope: typed("s".repeat(5000)), notes: typed("n".repeat(5000)) });
    const t = reviewText({ idea: "i".repeat(10_000), brief: "b".repeat(60_000), talk, draft: { ...draft, who: typed("w".repeat(500)), what: typed("w".repeat(500)), why: typed("w".repeat(500)) } });
    expect(bytes(t)).toBeLessThanOrEqual(TALK_MAX_BYTES);
    expect(t).toContain("## The draft to review");
    const refs = reviewOf(t)!.refs;
    expect(refs.title).toBeDefined();
    for (const k of Object.keys(refs)) if (k.startsWith("C")) expect(t).toContain(`- ${k}: `);
  });

  it("is told from a suggest task, and the other way round", () => {
    const draft = draftOf({ title: typed("T") });
    const review = reviewText({ idea: "x", talk: emptyTalk(), draft });
    const suggest = suggestText({ idea: "x", talk: emptyTalk(), draft, field: "title", drafts: [draft], rejected: [] });
    expect(reviewOf(suggest)).toBeUndefined();
    expect(suggestOf(review)).toBeUndefined();
    expect(reviewOf("")).toBeUndefined();
    expect(reviewOf(`${TALK_FIRST_LINE.review}\nDraft: ${draft.id}\nIds:\nTexts: nope`)).toBeUndefined();
  });
});
