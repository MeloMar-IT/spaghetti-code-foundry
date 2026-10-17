import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTIONS } from "../src/help/contract.js";
import { OUTCOME_RESULTS } from "../src/help/outcome.js";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
beforeAll(async () => {
  restore = installFakeDom();
  m = await import("../ui/ask-model.js" as string);
});
afterAll(() => restore());

const state = { id: "state-run-1", kind: "state", title: "Run r1", ref: "#/runs/r1" };
const reply = (over: any = {}) => ({ type: "status", summary: "s", explanation: "", certainty: "confirmed", evidence: [state], recommendations: [], links: [], drafts: [], actions: [], ...over });
const act = (over: any = {}) => ({ id: "resume-run", title: "Resume the run", impact: "The run goes on.", source: "state-run-1", about: { kind: "run", id: "r1" }, ...over });
const cards = (r: any) => m.cardsOf(r, "user");
const outcome = (over: any = {}) => ({ action: "resume-run", about: { kind: "run", id: "r1" }, result: "done", words: "The run goes on.", recovery: "Nothing to do.", at: "2026-10-12T10:00:00.000Z", ...over });

describe("reviewing a change: the model", () => {
  it("keeps the action titles and the result words equal to the server's", () => {
    expect(m.ACTION_TITLES).toEqual(Object.fromEntries(ACTIONS.map((a) => [a.id, a.title])));
    expect([...Object.keys(m.RESULT_WORDS)].sort()).toEqual([...OUTCOME_RESULTS].sort());
  });

  it("gives a bound action card a review button and the note", () => {
    const [c] = cards(reply({ actions: [act({ id: "cancel-run", title: "Cancel the run" })] }));
    expect(c).toMatchObject({ kind: "action", act: 0, note: m.ACT_NOTE });
    const both = cards(reply({ actions: [{ id: "x", title: "Bad", impact: "i" }, act()] }));
    expect(both[0].act).toBeUndefined();
    expect(both[0].note).toMatch(/does not do this/);
    expect(both[1].act).toBe(1);
  });

  it("gives no button without a run, and none in a limit reply", () => {
    expect(cards(reply({ actions: [act({ about: undefined })] }))[0].act).toBeUndefined();
    expect(cards(reply({ limit: { code: "x" }, actions: [act()] }))[0]?.act).toBeUndefined();
  });

  it("makes six rows of a preview, and six rows of nothing", () => {
    const rows = m.previewRows({ action: "cancel-run", title: "Cancel the run", about: { kind: "run", id: "r9" }, now: "N", changes: "C", impact: "I", impactLevel: "high", undo: "U", undoable: false, who: "W" });
    expect(rows.map((r: any) => r.label)).toEqual(["Action", "Now", "What changes", "Impact", "Undo", "Who may do this"]);
    expect(rows[0].text).toBe("Cancel the run (run r9)");
    expect(rows[3].text).toBe("High impact: I");
    expect(rows[4].text).toBe("Cannot be undone. U");
    for (const bad of [null, {}, 7, { now: 1, changes: {} }]) {
      const r = m.previewRows(bad);
      expect(r).toHaveLength(6);
      expect(r[0].text).toBe("The server did not say.");
      expect(r[1].text).toBe("The server did not say.");
    }
  });

  it("is dangerous only for high impact", () => {
    expect(m.previewDanger({ impactLevel: "high" })).toBe(true);
    for (const p of [{ impactLevel: "reversible" }, { impactLevel: "read-only" }, null, "x"]) expect(m.previewDanger(p)).toBe(false);
  });

  it("gives each result its word, and keeps text as it is", () => {
    for (const [result, [word, pill]] of Object.entries<any>(m.RESULT_WORDS)) expect(m.outcomeOf(outcome({ result })), result).toMatchObject({ word, pill });
    expect(m.outcomeOf(outcome({ result: "new" }))).toMatchObject({ word: "Partly done", pill: "sem-warning" });
    expect(m.outcomeOf(outcome({ words: "<b>x</b>" })).words).toBe("<b>x</b>");
    expect(m.outcomeOf({ result: "done" })).toBeNull();
    expect(m.outcomeOf("x")).toBeNull();
    expect(m.outcomeOf(outcome({ action: "q" })).title).toBe("A change");
  });

  it("merges stored and local outcomes once, in order, the newest 10", () => {
    const o1 = outcome();
    expect(m.outcomesFor({ outcomes: [o1] }, [{ ...o1 }])).toHaveLength(1);
    const early = outcome({ at: "2026-10-12T09:00:00.000Z", result: "queued" });
    expect(m.outcomesFor({ outcomes: [o1] }, [early]).map((o: any) => o.result)).toEqual(["queued", "done"]);
    const many = Array.from({ length: 12 }, (_, i) => outcome({ at: `2026-10-12T10:${String(i).padStart(2, "0")}:00.000Z` }));
    const kept = m.outcomesFor({ outcomes: many });
    expect(kept).toHaveLength(10);
    expect(kept[0].at).toBe(many[2].at);
    expect(m.outcomesFor({})).toEqual([]);
  });

  it("explains the errors of an action", () => {
    expect(m.explainActionError({ preview: true, message: "This is a preview." })).toBe("This is a preview.");
    expect(m.explainActionError({ status: 403 })).toMatch(/may not do this now/);
    expect(m.explainActionError({ status: 404 })).toMatch(/run or this answer is not there/);
    expect(m.explainActionError({ status: 410 })).toBe("This conversation was deleted.");
    expect(m.explainActionError({ status: 409, message: "this confirmation does not work" })).toBe("This confirmation does not work.");
  });

  it("puts the outcomes in the layout of an answer", () => {
    const e = m.entryOf({ id: "a1", role: "assistant", status: "done", text: "", reply: reply() }, { outcomes: () => [outcome()] });
    expect(e.layout.outcomes).toHaveLength(1);
  });
});
