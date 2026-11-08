import { describe, expect, it } from "vitest";
import type { ArchitectView } from "../src/refinement/architect.js";
import { STUCK_FAILED, STUCK_PAUSED, cardInput, cardsOf, changeView, nextStep, parseAnswers, retryAsk } from "../src/refinement/change-request.js";
import { planOf } from "../src/refinement/publish.js";
import type { Session } from "../src/refinement/store.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const AT = "2026-01-01T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const draft = (n: number, o: Record<string, unknown> = {}): any => ({ id: uuid(n), title: { text: `Card ${n}`, from: "typed" }, criteria: [{ id: uuid(100 + n), text: "It works.", from: "typed" }], dependsOn: [], understood: { summary: `This is what I understood: ${n}` }, ...o });
const question = (n: number, answered = false): any => ({ id: uuid(200 + n), view: "need", text: `Q${n}`, why: "Why", options: [{ text: "A", tradeoff: "a" }, { text: "B", tradeoff: "b" }], recommended: 1, ...(answered ? { answer: { at: AT, option: 1 } } : {}) });
const round = (questions: any[]): any => ({ runId: "r1", at: AT, questions });
const talk = (rounds: any[]): any => ({ rounds, proposals: [], asked: [], map: { rules: [], examples: [], open: [] } });
function session(o: Record<string, unknown> = {}): Session {
  return { id: uuid(1), owner: uuid(2), repo: "acme/app", title: "T", idea: "Export it", state: "exploring", drafts: [], changeRequest: {}, log: [], created: AT, updated: AT, ...o } as unknown as Session;
}
const brief = { text: "brief", at: AT, runId: "b1" };
const arch = (state: ArchitectView["state"], kind?: ArchitectView["kind"]): ArchitectView => ({ state, ...(kind ? { kind } : {}) });
const failedAt = (kind: string) => ({ runId: "x", at: AT, kind, failed: "boom" });

describe("nextStep", () => {
  it("is nothing for a session that is not a change request, or is dropped or published", () => {
    expect(nextStep(session({ changeRequest: undefined }))).toBeUndefined();
    expect(nextStep(session({ state: "dropped" }))).toBeUndefined();
    expect(nextStep(session({ state: "published" }))).toBeUndefined();
  });
  it("goes brief, round (simple words), understand (simple words), then nothing", () => {
    expect(nextStep(session())).toEqual({ kind: "brief" });
    expect(nextStep(session({ brief }))).toEqual({ kind: "round", words: "simple" });
    expect(nextStep(session({ brief, talk: talk([round([])]) }))).toEqual({ kind: "understand", words: "simple" });
    expect(nextStep(session({ brief, talk: talk([round([question(1, true)])]) }))).toEqual({ kind: "understand", words: "simple" });
    expect(nextStep(session({ brief, talk: talk([round([question(1)])]) }))).toBeUndefined();
    expect(nextStep(session({ brief, talk: talk([round([])]), drafts: [draft(3)] }))).toBeUndefined();
  });
  it("waits for a run that is there, unless asked to look past it", () => {
    const s = session({ architect: failedAt("round") });
    expect(nextStep(s)).toBeUndefined();
    expect(nextStep(s, true)).toEqual({ kind: "brief" });
  });
});

describe("changeView", () => {
  const withCards = (o: Record<string, unknown> = {}) => session({ brief, talk: talk([round([])]), drafts: [draft(3), draft(4)], ...o });
  it("is thinking while a run is queued or running", () => {
    expect(changeView(session(), arch("queued", "brief")).state).toBe("thinking");
    expect(changeView(session({ brief }), arch("running", "round")).state).toBe("thinking");
  });
  it("shows the open questions with their options", () => {
    const v = changeView(session({ brief, talk: talk([round([question(1), question(2, true)])]) }), arch("idle"));
    expect(v.state).toBe("questions");
    expect(v.questions).toEqual([{ id: uuid(201), text: "Q1", why: "Why", options: ["A", "B"], recommended: 1 }]);
  });
  it("shows the cards, without a split original and without an untitled draft", () => {
    const split = draft(5, { splitInto: [uuid(6)] });
    const v = changeView(withCards({ drafts: [draft(3), split, draft(6), draft(7, { title: undefined })] }), arch("idle"));
    expect(v.state).toBe("cards");
    expect(v.cards?.map((c) => c.title)).toEqual(["Card 3", "Card 6"]);
    expect(v.cards?.[0]).toEqual({ id: uuid(3), title: "Card 3", understood: "This is what I understood: 3", criteria: ["It works."] });
  });
  it("is planned once every card is published, with whether a build was asked for", () => {
    const published = { issue: 4, url: "https://github.com/acme/app/issues/4", at: AT };
    const drafts = [draft(3, { published }), draft(4, { published })];
    expect(changeView(withCards({ drafts }), arch("idle"))).toMatchObject({ state: "planned", building: false });
    expect(changeView(withCards({ drafts, changeRequest: { build: true } }), arch("idle"))).toMatchObject({ state: "planned", building: true });
  });
  it("is stuck, with a fixed sentence, when a step failed or paused", () => {
    const failed = changeView(session({ brief, architect: failedAt("round") }), arch("failed", "round"));
    expect(failed).toMatchObject({ state: "stuck", reason: STUCK_FAILED });
    expect(changeView(session({ brief }), arch("paused", "round"))).toMatchObject({ state: "stuck", reason: STUCK_PAUSED });
    // a step is due and nothing runs
    expect(changeView(session(), arch("idle"))).toMatchObject({ state: "stuck", reason: STUCK_FAILED });
  });
  it("is thinking while a failed run is not settled yet", () => {
    expect(changeView(session({ brief, architect: { runId: "x", at: AT, kind: "round" } }), arch("failed", "round")).state).toBe("thinking");
  });
  it("shows no run id, cost, model or label", () => {
    const states = [
      changeView(session({ architect: failedAt("brief") }), { state: "failed", kind: "brief", runId: "run-9", reason: "cost $1 model x" }),
      changeView(withCards(), { ...arch("idle"), runId: "run-9" }),
      changeView(session({ brief, talk: talk([round([question(1)])]) }), arch("idle")),
    ];
    for (const v of states) {
      const t = JSON.stringify(v);
      for (const bad of ["runId", "run-9", "cost", "model", "labels", "Factory_go"]) expect(t).not.toContain(bad);
    }
  });
});

describe("retryAsk", () => {
  it("starts the step that is due", () => {
    expect(retryAsk(session({ brief, architect: failedAt("round") }), arch("failed", "round"))).toEqual({ kind: "round", words: "simple" });
    expect(retryAsk(session({ architect: failedAt("brief") }), arch("failed", "brief"))).toEqual({ kind: "brief" });
  });
  it("resumes a paused step of the chain, and refuses a paused step of another kind", () => {
    expect(retryAsk(session({ brief }), arch("paused", "understand"))).toEqual({ kind: "understand", words: "simple" });
    expect(retryAsk(session({ brief }), arch("paused", "brief"))).toEqual({ kind: "brief" });
    expect(() => retryAsk(session({ brief }), arch("paused", "split"))).toThrow(/Advanced view/);
  });
  it("throws when nothing is due", () => {
    const s = session({ brief, talk: talk([round([])]), drafts: [draft(3)] });
    expect(() => retryAsk(s, arch("idle"))).toThrow(/nothing to try again/);
  });
});

describe("parseAnswers", () => {
  const s = session({ brief, talk: talk([round([question(1), question(2)])]) });
  const before = JSON.stringify(s);
  it("takes an option, a text or unknown for every open question", () => {
    const out = parseAnswers(s, { answers: [{ question: uuid(201), option: 2 }, { question: uuid(202), unknown: true }] });
    expect(out).toEqual([{ question: uuid(201), answer: { option: 2 } }, { question: uuid(202), answer: { unknown: true } }]);
    expect(parseAnswers(s, { answers: [{ question: uuid(202), text: "mine" }, { question: uuid(201), option: 1 }] })).toHaveLength(2);
    expect(JSON.stringify(s)).toBe(before);
  });
  it.each([
    ["not an object", "x"],
    ["no list", {}],
    ["an extra key", { answers: [], more: 1 }],
    ["a missing question", { answers: [{ question: uuid(201), option: 1 }] }],
    ["an unknown question", { answers: [{ question: uuid(201), option: 1 }, { question: uuid(299), option: 1 }] }],
    ["a duplicate", { answers: [{ question: uuid(201), option: 1 }, { question: uuid(201), option: 1 }, { question: uuid(202), option: 1 }] }],
    ["a bad option", { answers: [{ question: uuid(201), option: 5 }, { question: uuid(202), option: 1 }] }],
    ["two kinds at once", { answers: [{ question: uuid(201), option: 1, text: "x" }, { question: uuid(202), option: 1 }] }],
    ["an entry that is not an object", { answers: [1] }],
    ["an extra key in an entry", { answers: [{ question: uuid(201), option: 1, x: 1 }, { question: uuid(202), option: 1 }] }],
  ])("refuses %s", (_what, input) => {
    expect(() => parseAnswers(s, input)).toThrow();
    expect(JSON.stringify(s)).toBe(before);
  });
  it("refuses an answer to a question of an earlier round or one that is answered", () => {
    const t = session({ brief, talk: talk([round([question(1, true)]), round([question(2)])]) });
    expect(() => parseAnswers(t, { answers: [{ question: uuid(201), option: 1 }, { question: uuid(202), option: 1 }] })).toThrow();
    expect(parseAnswers(t, { answers: [{ question: uuid(202), option: 1 }] })).toHaveLength(1);
  });
});

describe("cardInput", () => {
  const d = draft(3);
  it("keeps the id of a criterion whose text is the same", () => {
    expect(cardInput(d, { title: "New", criteria: ["It works.", "Another"] })).toEqual({ title: "New", criteria: [{ id: uuid(103), text: "It works." }, { text: "Another" }] });
    expect(cardInput(d, { criteria: ["It works.", "It works."] })).toEqual({ criteria: [{ id: uuid(103), text: "It works." }, { text: "It works." }] });
  });
  it.each([[{}], [null], [{ title: "" }], [{ title: 3 }], [{ criteria: "x" }], [{ criteria: [1] }], [{ title: "x", dependsOn: [] }], [{ criteria: Array(51).fill("x") }]])("refuses %j", (input) => {
    expect(() => cardInput(d, input)).toThrow();
  });
});

describe("cardsOf and publishing every card", () => {
  const list = [{ id: "out-of-scope", text: "it says what is out of scope" }];
  const plan = (drafts: any[], everyCard?: boolean) => planOf({ drafts } as any, { list, onGithub: new Map(), by: "Ann", date: "2026-01-01", ...(everyCard ? { everyCard } : {}) });
  it("offers the titled drafts that are not a split original", () => {
    expect(cardsOf({ drafts: [draft(3), draft(4, { title: undefined }), draft(5, { splitInto: [uuid(6)] }), draft(6)] }).map((d) => d.id)).toEqual([uuid(3), uuid(6)]);
  });
  it("treats a titled draft as ready only for a change request", () => {
    const drafts = [draft(3)];
    expect(plan(drafts).items[0]!.state).toBe("not-ready");
    expect(plan(drafts, true).items[0]!.state).toBe("ready");
  });
  it("does not make an untitled draft ready, and does not stop the titled ones", () => {
    const p = plan([draft(3), draft(4, { title: undefined })], true);
    expect(p.willCreate).toEqual([uuid(3)]);
  });
});
