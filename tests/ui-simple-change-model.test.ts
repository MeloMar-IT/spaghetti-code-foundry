import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
let words: any;
beforeAll(async () => {
  restore = installFakeDom();
  words = await import("../ui/simple-words.js" as string);
  m = await import("../ui/simple-change-model.js" as string);
});
afterAll(() => restore());

const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();
const card = (id: string, over: any = {}) => ({ id, title: `Card ${id}`, understood: "This is what I understood: it shows the weather.", criteria: ["Shows a city"], ...over });

describe("changeRepoOf, changesOf and openChangeOf", () => {
  it("names a GitHub project, a local project, and neither", () => {
    expect(m.changeRepoOf({ github: "o/app", localName: "local:x" })).toBe("o/app");
    expect(m.changeRepoOf({ localName: "local:demo-0123abcd" })).toBe("local:demo-0123abcd");
    expect(m.changeRepoOf({ github: "" })).toBeNull();
    expect(m.changeRepoOf(null)).toBeNull();
  });

  it("reads the list from { changes } and from a plain list, and nothing else", () => {
    expect(m.changesOf({ changes: [{ id: "a" }] })).toEqual([{ id: "a" }]);
    expect(m.changesOf([{ id: "a" }, null])).toEqual([{ id: "a" }]);
    expect(m.changesOf({ changes: "x" })).toEqual([]);
    expect(m.changesOf(undefined)).toEqual([]);
  });

  it("picks the newest open request and skips planned ones", () => {
    const list = [
      { id: "old", state: "cards", updated: at(30), created: at(30) },
      { id: "new", state: "questions", updated: at(5), created: at(40) },
      { id: "done", state: "planned", updated: at(1), created: at(1) },
    ];
    expect(m.openChangeOf(list).id).toBe("new");
    expect(m.openChangeOf({ changes: list }).id).toBe("new");
    expect(m.openChangeOf([{ id: "p", state: "planned" }])).toBeNull();
    expect(m.openChangeOf([])).toBeNull();
  });

  it("knows the phase of each state, and write for none or an unknown one", () => {
    for (const s of ["thinking", "questions", "cards", "planned", "stuck"]) expect(m.phaseOf({ state: s })).toBe(s);
    expect(m.phaseOf(null)).toBe("write");
    expect(m.phaseOf({ state: "odd" })).toBe("write");
  });
});

describe("questionItems and cardItems", () => {
  it("marks the suggested option, counts from 1 and hides a question with a forbidden term", () => {
    const items = m.questionItems({ questions: [
      { id: "q1", text: "Which city?", why: "It sets the weather.", options: ["Paris", "Rome"], recommended: 2 },
      { id: "q2", text: "Use which label for issue #12?", why: "", options: ["A", ""], recommended: 1 },
    ] });
    expect(items[0].n).toBe(1);
    expect(items[0].options.map((o: any) => [o.n, o.recommended])).toEqual([[1, false], [2, true]]);
    expect(items[1].text).toBe(words.ANSWER.noPlain);
    expect(items[1].options[1].text).toBe(words.CHANGE.option(2));
  });

  it("makes card text plain, does not say the prefix twice, falls back to the title and keeps three cards", () => {
    const [a, b, c] = m.cardItems({ cards: [
      card("1", { title: "Fix issue #12 label", criteria: ["Works", "Costs $3", "A label"] }),
      card("2", { understood: "" }),
      card("3", { understood: "Shows it" }),
    ] });
    expect(a.title).not.toMatch(/#12|label|issue/i);
    expect(a.criteria).toEqual(["Works"]);
    expect(a.understood.match(/This is what I understood/g)).toHaveLength(1);
    expect(a.understood).toBe("This is what I understood: it shows the weather.");
    expect(b.understood).toBe("This is what I understood: Card 2");
    expect(c.understood).toBe("This is what I understood: Shows it");
  });
});

describe("answersBody", () => {
  const qs = [{ id: "a", options: ["x", "y"] }, { id: "b", options: ["x", "y", "z"] }];
  it("sends the option, and typed text wins", () => {
    expect(m.answersBody(qs, { a: { option: 2 }, b: { option: 1, text: "  mine " } })).toEqual({ body: { answers: [{ question: "a", option: 2 }, { question: "b", text: "mine" }] } });
  });
  it("names the first question without an answer, and an option out of range", () => {
    expect(m.answersBody(qs, { a: { option: 1 } })).toEqual({ missing: 2 });
    expect(m.answersBody(qs, { a: { option: 3 }, b: { option: 1 } })).toEqual({ missing: 1 });
  });
  it("refuses a text over 2000 characters instead of cutting it, and takes exactly 2000", () => {
    expect(m.answersBody(qs, { a: { text: "x".repeat(2001) }, b: { option: 1 } })).toEqual({ tooLong: 1 });
    expect(m.answersBody([qs[0]], { a: { text: "x".repeat(2000) } }).body.answers[0].text).toHaveLength(2000);
  });
});

describe("cardEdit and cardBody", () => {
  const raw = card("1", { title: "Show weather (#12)", criteria: ["Line one\nline two", "Second", "A label here"] });
  it("shows filtered text, and sends nothing when nothing changed (multi-line criteria stay whole)", () => {
    const edit = m.cardEdit(raw);
    expect(edit.title).toBe("Show weather");
    expect(edit.slots.map((s: any) => s.shown)).toEqual(["Line one line two", "Second", ""]);
    expect(m.cardBody(edit, { title: edit.title, criteria: ["Line one line two", "Second"], added: "" })).toEqual({ unchanged: true });
  });
  it("sends only the title when only the title changed, and the criteria as separate entries when one changed", () => {
    const edit = m.cardEdit(raw);
    expect(m.cardBody(edit, { title: "New title", criteria: ["Line one line two", "Second"], added: "" })).toEqual({ body: { title: "New title" } });
    const r = m.cardBody(edit, { title: edit.title, criteria: ["Line one line two", "Changed"], added: " extra " });
    // untouched entries keep the server's text; the hidden one is kept as it is
    expect(r).toEqual({ body: { criteria: ["Line one\nline two", "Changed", "A label here", "extra"] } });
  });
  it("removes an emptied point and refuses a bad title or an over-long text with a plain message", () => {
    const edit = m.cardEdit(raw);
    expect(m.cardBody(edit, { title: edit.title, criteria: ["", "Second"], added: "" }).body.criteria).toEqual(["Second", "A label here"]);
    expect(m.cardBody(edit, { title: "  ", criteria: [], added: "" })).toEqual({ problem: words.CHANGE.titleNeeded });
    expect(m.cardBody(edit, { title: "x".repeat(121), criteria: [], added: "" })).toEqual({ problem: words.CHANGE.titleTooLong });
    expect(m.cardBody(edit, { title: "x".repeat(120), criteria: ["Line one line two", "Second"], added: "" }).body.title).toHaveLength(120);
    expect(m.cardBody(edit, { title: edit.title, criteria: ["y".repeat(501), "Second"], added: "" }).problem).toBe(words.CHANGE.criterionTooLong(1));
    expect(m.cardBody(edit, { title: edit.title, criteria: ["y".repeat(500), "Second"], added: "" }).body).toBeDefined();
    const many = m.cardEdit({ id: "9", title: "T", criteria: Array.from({ length: 50 }, (_, i) => `c${i}`) });
    expect(m.cardBody(many, { title: "T", criteria: many.slots.map((s: any) => s.shown), added: "one more" })).toEqual({ problem: words.CHANGE.tooManyCriteria });
  });
});

describe("plannedCards", () => {
  it("lists only planned requests that were kept, newest first, with the parts sentence for a split", () => {
    const list = [
      { id: "a", state: "planned", building: false, cards: [card("1")], updated: at(20) },
      { id: "b", state: "planned", building: true, cards: [card("1")], updated: at(1) },
      { id: "c", state: "planned", cards: [card("1", { title: "Fix issue #12" }), card("2"), card("3")], updated: at(5) },
      { id: "d", state: "cards", cards: [card("1")], updated: at(0) },
    ];
    const out = m.plannedCards({ changes: list });
    expect(out.map((c: any) => c.build)).toEqual(["c", "a"]);
    expect(out[0]).toMatchObject({ id: "change-c", sentence: words.CHANGE.parts(3), line: words.CHANGE.keptLine });
    expect(out[0].title).not.toMatch(/#12|issue/i);
    expect(out[1].sentence).toBe("");
  });
});

describe("the draft", () => {
  it("is unsent while text, a typed answer or a changed edit is there, and not after it is cleared", () => {
    expect(m.hasUnsentChange()).toBe(false);
    const d = m.changeDraft("p1");
    d.text = "hello";
    expect(m.hasUnsentChange()).toBe(true);
    m.clearChangeDraft("p1", "text");
    expect(m.hasUnsentChange()).toBe(false);
    d.answers = { q: { option: 1 } };
    expect(m.hasUnsentChange()).toBe(false); // a chosen option is not typed text
    d.answers = { q: { text: "mine" } };
    expect(m.hasUnsentChange()).toBe(true);
    m.clearChangeDraft("p1", "answers");
    d.edit = { did: "1", values: null, dirty: false };
    expect(m.hasUnsentChange()).toBe(false);
    d.edit.dirty = true;
    expect(m.hasUnsentChange()).toBe(true);
    m.clearChangeDraft("p1");
    expect(m.hasUnsentChange()).toBe(false);
  });
});

describe("the words", () => {
  it("has no forbidden term in any CHANGE text", () => {
    const all = Object.values<any>(words.CHANGE).flatMap((v) => (typeof v === "function" ? [v(3), v(1)] : [v]));
    expect(all.length).toBeGreaterThan(30);
    for (const t of all) expect(words.forbiddenIn(t), t).toEqual([]);
    expect(words.CHANGE.title).toBe(words.WORDS.actions.change);
  });
});
