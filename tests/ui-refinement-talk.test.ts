import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let talk: any;
let api: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/refinement.js" as string);
  talk = await import("../ui/refinement-talk.js" as string);
  api = (await import("../ui/api.js" as string)).api;
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
const realConfirm = (globalThis as any).confirm;
let page: any;
let gets: string[];
let sent: { method: string; url: string; body: any }[];
let postAnswer: any;
let postMode: "ok" | "hold" | "throw" | number;
let postHold: (() => void) | undefined;
let getMode: "ok" | "hold";
let getHold: (() => void) | undefined;
let confirmAnswer: boolean;

const BRIEF = { text: "## A\nB", at: "2026-03-01T10:20:00.000Z", branch: "develop", runId: "run-old" };
const question = (n: number, over: object = {}) => ({
  id: `q${n}`, view: n === 1 ? "need" : "test", text: `Question ${n}?`, why: `Reason ${n}`,
  options: [{ text: `Option one of ${n}`, tradeoff: "Fast" }, { text: `Option two of ${n}`, tradeoff: "Safe" }], recommended: 2, ...over,
});
const mkTalk = (over: object = {}) => ({
  rounds: [{ runId: "r1", at: "x", questions: [question(1), question(2)] }],
  proposals: [{ id: "p1", list: "rule", text: "A rule" }, { id: "p2", list: "example", text: "An example" }, { id: "p3", list: "open", text: "Something open" }],
  map: { rules: [{ id: "e1", text: "Old rule", at: "x" }], examples: [], open: [] },
  asked: [], ...over,
});
const session = (over: object = {}) => ({
  id: "s1", repo: "acme/app", repoAvailable: true, title: "My idea", idea: "An idea", state: "exploring", drafts: [], brief: BRIEF,
  architect: { state: "idle" }, talk: mkTalk(),
  log: [{ at: new Date().toISOString(), what: "created", who: "Ann" }], created: "x", updated: "x", mine: true, ...over,
});

const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, statusText: "x", json: async () => body });
beforeEach(() => {
  vi.useFakeTimers();
  page = session();
  gets = [];
  sent = [];
  postAnswer = session();
  postMode = "ok";
  postHold = undefined;
  getMode = "ok";
  getHold = undefined;
  confirmAnswer = true;
  talk.drafts.clear();
  (document as any).getElementById("modal-root").replaceChildren();
  (document as any).listeners.keydown = []; // dialogs of an earlier test
  (document as any).getElementById("toast").textContent = "";
  (globalThis as any).location = { hash: "#/refinement/s1" };
  (globalThis as any).confirm = () => confirmAnswer;
  (globalThis as any).fetch = async (url: string, init: { method: string; body?: string }) => {
    if (init.method === "GET") {
      gets.push(url);
      if (getMode === "hold") {
        const snapshot = page;
        await new Promise<void>((r) => (getHold = r));
        return reply(snapshot);
      }
      return reply(page);
    }
    sent.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (postMode === "hold") await new Promise<void>((r) => (postHold = r));
    if (postMode === "throw") throw new TypeError("fetch failed");
    if (typeof postMode === "number") return reply({ error: "Answer every question first." }, postMode);
    return reply(postAnswer, 200);
  };
});
afterEach(() => {
  cleanup?.();
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  (globalThis as any).confirm = realConfirm;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const buttons = (root: FakeElement = main()) => walk(root).filter((e) => e.tag === "button");
const button = (t: string, root: FakeElement = main()) => buttons(root).find((e) => e.textContent === t);
const press = async (el: FakeElement | undefined) => {
  expect(el, "control").toBeDefined();
  el!.click();
  await flush();
};
const text = () => main().textContent;
const toastText = () => (document as any).getElementById("toast").textContent as string;
const talks = () => walk(main()).filter((e) => e.attrs.class === "talk");
const byFocus = (name: string) => walk(main()).find((e) => e.attrs["data-focus"] === name);
let cleanup: (() => void) | undefined;
const show = async (admin = false) => {
  cleanup = await ui.renderRefinement(main(), { admin, id: "s1" });
};
const card = (qid: string) => walk(main()).find((e) => e.attrs.class === "card" && walk(e).some((x) => x.attrs["data-focus"] === `own-${qid}` || x.attrs["data-focus"] === `opt-${qid}-1`) );
const type = (el: FakeElement, v: string) => {
  el.value = v;
  el.fire("input");
};

describe("pure functions", () => {
  it("kindOf and mayChange", () => {
    expect(talk.kindOf(undefined)).toBe("brief");
    expect(talk.kindOf({ kind: "round" })).toBe("round");
    expect(talk.kindOf({ kind: "question" })).toBe("question");
    expect(talk.kindOf({ kind: "suggest" })).toBe("suggest");
    expect(talk.kindOf({ kind: "review" })).toBe("review");
    expect(talk.roundLabel(session({ architect: { state: "paused", kind: "review" } }))).toBe("");
    expect(talk.canAsk(session({ architect: { state: "paused", kind: "review" } }))).toBe(false);
    const review = talk.talkSection(session({ architect: { state: "running", kind: "review" } }), { send: () => {}, errorText: String, line: null });
    expect(review.map((p: any) => p.textContent).join(" ")).not.toContain("The architect is");
    expect(talk.kindOf({ kind: "other" })).toBe("brief");
    // a suggestion run is no round: no round button, no ask field; a failed one gives the normal buttons
    expect(talk.roundLabel(session({ architect: { state: "paused", kind: "suggest" } }))).toBe("");
    expect(talk.canAsk(session({ architect: { state: "paused", kind: "suggest" } }))).toBe(false);
    expect(talk.roundLabel(session({ architect: { state: "failed", kind: "suggest" }, talk: mkTalk({ rounds: [] }) }))).toBe(talk.ASK_ROUND);
    const parts = talk.talkSection(session({ architect: { state: "running", kind: "suggest" } }), { send: () => {}, errorText: String, line: null });
    expect(parts.map((p: any) => p.textContent).join(" ")).not.toContain("The architect is");
    expect(talk.mayChange(session())).toBe(true);
    expect(talk.mayChange(session({ mine: false }))).toBe(false);
    expect(talk.mayChange(session({ state: "dropped" }))).toBe(false);
    expect(talk.mayChange(session({ repoAvailable: false }))).toBe(false);
    expect(talk.mayChange(session({ talkHidden: true }))).toBe(false);
  });
  it("answerText, openLine and doneText", () => {
    const q = question(1);
    expect(talk.answerText({ ...q, answer: { option: 2 } })).toBe("Option 2: Option two of 1");
    expect(talk.answerText({ ...q, answer: { text: "Mine" } })).toBe("Mine");
    expect(talk.answerText({ ...q, answer: { unknown: true } })).toBe("I don't know yet");
    expect(talk.answerText(q)).toBe("");
    expect(talk.openLine(0)).toBe("");
    expect(talk.openLine(1)).toBe("1 open question — a story with open questions is not ready");
    expect(talk.openLine(2)).toBe("2 open questions — a story with open questions is not ready");
    expect(talk.doneText("All clear.")).toBe("All clear.");
    expect(talk.doneText("")).toBe("The architect has nothing important left to ask");
  });
  it("roundLabel", () => {
    const answered = mkTalk({ rounds: [{ runId: "r", at: "x", questions: [question(1, { answer: { option: 1 } })] }] });
    const L = (over: object) => talk.roundLabel(session(over));
    expect(L({ brief: undefined, talk: mkTalk({ rounds: [] }) })).toBe("");
    expect(L({ talk: mkTalk({ rounds: [] }) })).toBe(talk.ASK_ROUND);
    expect(L({})).toBe("");
    expect(L({ talk: answered })).toBe(talk.ANOTHER_ROUND);
    expect(L({ talk: answered, architect: { state: "queued", kind: "round" } })).toBe("");
    expect(L({ talk: answered, architect: { state: "running", kind: "round" } })).toBe("");
    expect(L({ talk: answered, architect: { state: "paused", kind: "round" } })).toBe("Ask again");
    expect(L({ talk: answered, architect: { state: "paused", kind: "brief" } })).toBe("");
    expect(L({ talk: answered, architect: { state: "failed", kind: "round" } })).toBe("Try again");
    expect(L({ talk: answered, architect: { state: "failed", kind: "question" } })).toBe(talk.ANOTHER_ROUND);
    expect(L({ talk: answered, mine: false })).toBe("");
    expect(L({ talk: answered, state: "dropped" })).toBe("");
    expect(L({ talk: answered, repoAvailable: false })).toBe("");
  });
  it("pendingQuestion, againLabel and canAsk follow the permission", () => {
    const withLog = (architect: object, over: object = {}) =>
      session({ architect, log: [{ at: "x", what: "asked", detail: "Why?" }], ...over });
    expect(talk.pendingQuestion(withLog({ state: "paused", kind: "question" }))).toBe("Why?");
    expect(talk.pendingQuestion(session())).toBe("");
    expect(talk.againLabel(withLog({ state: "paused", kind: "question" }))).toBe("Ask again");
    expect(talk.againLabel(withLog({ state: "failed", kind: "question" }))).toBe("Try again");
    expect(talk.againLabel(session({ architect: { state: "failed", kind: "question" } }))).toBe("");
    expect(talk.againLabel(withLog({ state: "running", kind: "question" }))).toBe("");
    for (const state of ["paused", "failed"]) {
      expect(talk.againLabel(withLog({ state, kind: "question" }, { mine: false }))).toBe("");
      expect(talk.againLabel(withLog({ state, kind: "question" }, { state: "dropped" }))).toBe("");
    }
    expect(talk.canAsk(session())).toBe(true);
    expect(talk.canAsk(session({ architect: { state: "failed", kind: "question" } }))).toBe(true);
    expect(talk.canAsk(session({ architect: { state: "paused", kind: "round" } }))).toBe(false);
    expect(talk.canAsk(session({ architect: { state: "queued", kind: "question" } }))).toBe(false);
    expect(talk.canAsk(session({ mine: false }))).toBe(false);
  });
  it("talkLogText says every kind in words and never shows a run id", () => {
    const say = (what: string, detail?: string, list?: string) => talk.talkLogText({ what, who: "Ann", detail, list });
    expect(say("question", "Why?")).toBe("The architect asked: Why?");
    expect(say("question")).toBe("The architect asked");
    expect(say("answered", "Option 1")).toBe("Ann answered: Option 1");
    expect(say("open-added", "Later?")).toBe("An open question was added: Later?");
    expect(say("entry-accepted", "T", "rule")).toBe("Ann accepted a rule for the map: T");
    expect(say("entry-rejected", "T", "example")).toBe("Ann rejected a proposed example: T");
    expect(say("entry-changed", "T", "open")).toBe("Ann changed an open question: T");
    expect(say("entry-removed", "T", "rule")).toBe("Ann removed a rule from the map: T");
    expect(say("asked", "Q")).toBe("Ann asked the architect: Q");
    expect(say("architect-answered", "A")).toBe("The architect answered: A");
    expect(say("round-done", "Done")).toBe("The architect has nothing important left to ask: Done");
    expect(say("proposals-left-out", "1")).toBe("1 proposed entry was left out: too many are waiting");
    expect(say("proposals-left-out", "3")).toBe("3 proposed entries were left out: too many are waiting");
    expect(say("proposals-left-out")).toBe("Some proposed entries were left out: too many are waiting");
    expect(say("round-started", "run-secret-1")).not.toContain("run-secret-1");
    expect(say("architect-round", "run-secret-1")).not.toContain("run-secret-1");
    expect(say("created")).toBe("");
    expect(ui.logText({ what: "question", detail: "Why?" })).toBe("The architect asked: Why?");
    expect(ui.logText({ what: "architect-brief" })).toBe("The architect wrote the context brief");
    expect(ui.logText({ what: "round-started", who: "Ann", detail: "run-secret-1" })).not.toContain("run-secret-1");
  });
  it("architectStatus and activityText by kind", () => {
    expect(ui.architectStatus({ state: "queued", kind: "round" }).detail).toBe("Then it writes its questions.");
    expect(ui.architectStatus({ state: "queued", kind: "question" }).detail).toBe("Then it answers your question.");
    expect(ui.architectStatus({ state: "queued" }).detail).toBe("Then it reads the code.");
    expect(ui.architectStatus({ state: "running", kind: "round", doing: "Clone the repository into repo/" })).toMatchObject({ text: "The architect is writing its questions.", detail: "Getting the code." });
    expect(ui.architectStatus({ state: "running", kind: "question" }).text).toBe("The architect is answering your question.");
    const flow = readFileSync("flows/refine-round.yaml", "utf8");
    const steps = [...flow.matchAll(/^ {4}description: (.+)$/gm)].map((m) => m[1]!);
    expect(steps.length).toBeGreaterThan(2);
    for (const d of steps) {
      for (const kind of ["round", "question"]) expect(ui.activityText(d, kind)).not.toMatch(/repo\/|\.json|\.md/);
    }
    expect(ui.activityText("The architect reads the code and asks the questions", "round")).toBe("Reading the code.");
    expect(ui.activityText("Check the form of the architect's answer", "question")).toBe("Checking the answer.");
    expect(ui.activityText("Writing repo/notes.md", "round")).toBe("");
  });
  it("askLabel leaves a round or a question to the talk", () => {
    expect(ui.askLabel(session({ architect: { state: "paused", kind: "round" } }))).toBe("");
    expect(ui.askLabel(session({ architect: { state: "failed", kind: "round" } }))).toBe("Refresh");
    expect(ui.askLabel(session({ brief: undefined, architect: { state: "failed", kind: "round" } }))).toBe("Ask the architect to look at the code");
    expect(ui.askLabel(session({ architect: { state: "failed" } }))).toBe("Try again");
  });
});

describe("the api calls", () => {
  it("send the right request", async () => {
    await api.askRound("a b");
    await api.askOwnQuestion("s1", "Why?");
    await api.answerQuestion("s1", "q1", { option: 2 });
    await api.acceptProposal("s1", "p1");
    await api.rejectProposal("s1", "p1");
    await api.changeMapEntry("s1", "e1", "New");
    await api.removeMapEntry("s1", "e1");
    expect(sent).toEqual([
      { method: "POST", url: "/api/refinement/a%20b/round", body: {} },
      { method: "POST", url: "/api/refinement/s1/ask", body: { question: "Why?" } },
      { method: "POST", url: "/api/refinement/s1/questions/q1/answer", body: { option: 2 } },
      { method: "POST", url: "/api/refinement/s1/proposals/p1/accept", body: {} },
      { method: "POST", url: "/api/refinement/s1/proposals/p1/reject", body: {} },
      { method: "PUT", url: "/api/refinement/s1/map/e1", body: { text: "New" } },
      { method: "DELETE", url: "/api/refinement/s1/map/e1", body: undefined },
    ]);
  });
  it("is wired into the page and the style sheet", () => {
    expect(readFileSync("ui/refinement.js", "utf8")).toContain('from "./refinement-talk.js"');
    const css = readFileSync("ui/style.css", "utf8");
    expect(css).toMatch(/\.talk \{[^}]*min-width: 0/);
    expect(css).toContain("overflow-wrap: anywhere");
  });
});

describe("a round on the page", () => {
  it("shows the questions, options and trade-offs, with one recommended option each", async () => {
    await show();
    const t = text();
    for (const s of ["Round 1", "The user's need", "The test", "Question 1?", "Why it matters: Reason 1", "Option one of 1", "Trade-off: Safe"]) expect(t).toContain(s);
    expect(walk(main()).filter((e) => e.textContent === "Recommended")).toHaveLength(2);
    expect(button("I don't know yet", card("q1")!)).toBeDefined();
    expect(byFocus("own-q1")).toBeDefined();
    expect(button(talk.ANOTHER_ROUND)).toBeUndefined();
    expect(text()).toContain(talk.ROUND_WAIT);
  });
  it("asks for the first round with a brief, and says to look at the code without one", async () => {
    page = session({ talk: mkTalk({ rounds: [] }) });
    await show();
    await press(button(talk.ASK_ROUND));
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/round", body: {} }]);
    cleanup!();
    page = session({ brief: undefined, talk: mkTalk({ rounds: [] }) });
    await show();
    expect(text()).toContain(talk.NO_BRIEF);
    expect(button(talk.ASK_ROUND)).toBeUndefined();
    expect(byFocus("ask")).toBeDefined();
    cleanup!();
    page = session({ brief: undefined, mine: false, talk: mkTalk({ rounds: [] }) });
    await show(true);
    expect(text()).toContain(talk.NO_BRIEF);
  });
  it("offers another round only when every question is answered, with its note", async () => {
    page = session({ talk: mkTalk({ rounds: [{ runId: "r", at: "x", questions: [question(1, { answer: { option: 1 } }), question(2)] }] }) });
    await show();
    expect(button(talk.ANOTHER_ROUND)).toBeUndefined();
    cleanup!();
    page = session({ talk: mkTalk({ rounds: [{ runId: "r", at: "x", questions: [question(1, { answer: { option: 1 } }), question(2, { answer: { unknown: true } })] }] }) });
    await show();
    expect(text()).toContain(talk.ROUND_NOTE);
    postAnswer = session({ architect: { state: "queued", kind: "round", runId: "r2" } });
    await press(button(talk.ANOTHER_ROUND));
    expect(sent[0]).toEqual({ method: "POST", url: "/api/refinement/s1/round", body: {} });
    expect(text()).toContain("waiting for its turn");
    expect(text()).toContain("Then it writes its questions.");
    expect(button(talk.ANOTHER_ROUND)).toBeUndefined();
    expect(byFocus("ask")).toBeUndefined();
    expect(button("Refresh")).toBeUndefined();
  });
  it("says that the architect has nothing important left to ask", async () => {
    page = session({ talk: mkTalk({ rounds: [{ runId: "r", at: "x", questions: [], done: "Nothing else matters now." }] }) });
    await show();
    expect(text()).toContain("Nothing else matters now.");
    expect(button(talk.ANOTHER_ROUND)).toBeDefined();
  });
});

describe("answers", () => {
  it("picks an option", async () => {
    postAnswer = session({ talk: mkTalk({ rounds: [{ runId: "r1", at: "x", questions: [question(1, { answer: { option: 2 } }), question(2)] }] }) });
    await show();
    await press(byFocus("opt-q1-2"));
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/questions/q1/answer", body: { option: 2 } }]);
    expect(gets).toHaveLength(1);
    const c = card("q2")!;
    expect(c).toBeDefined();
    const done = walk(main()).find((e) => e.attrs.class === "card" && e.textContent.includes("Question 1?"))!;
    expect(done.textContent).toContain("Answer: Option 2: Option two of 1");
    expect(buttons(done)).toEqual([]);
    expect(walk(done).some((e) => e.tag === "textarea")).toBe(false);
  });
  it("sends an own answer, trimmed, and nothing when it is blank", async () => {
    await show();
    await press(byFocus("own-send-q1"));
    expect(sent).toEqual([]);
    expect(toastText()).toBe("Write your answer first.");
    type(byFocus("own-q1")!, "  My idea  ");
    await press(byFocus("own-send-q1"));
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/questions/q1/answer", body: { text: "My idea" } }]);
    expect(talk.drafts.size).toBe(0);
  });
  it("sends I don't know yet, and the open-questions line follows the map", async () => {
    await show();
    expect(text()).not.toContain("open question");
    await press(button("I don't know yet", card("q1")!));
    expect(sent[0]!.body).toEqual({ unknown: true });
    for (const [n, line] of [[1, "1 open question — a story with open questions is not ready"], [2, "2 open questions — a story with open questions is not ready"]] as const) {
      const open = Array.from({ length: n }, (_, i) => ({ id: `o${i}`, text: `Open ${i}`, at: "x" }));
      postAnswer = session({ talk: mkTalk({ map: { rules: [], examples: [], open } }) });
      await press(byFocus("unknown-q2"));
      expect(text()).toContain(line);
    }
  });
});

describe("the map", () => {
  it("shows three lists with proposals under their list", async () => {
    await show();
    const heads = walk(main()).filter((e) => e.tag === "h3").map((e) => e.textContent);
    expect(heads).toEqual(expect.arrayContaining(["Rules", "Examples", "Open questions"]));
    const sections = talks();
    const map = sections.find((s) => walk(s).some((e) => e.tag === "h2" && e.textContent === "Map"))!;
    expect(map.textContent).toContain("Old rule");
    expect(map.textContent).toContain("Proposed");
    expect(button("Accept", map)).toBeDefined();
  });
  it("accepts and rejects a proposal", async () => {
    await show();
    await press(byFocus("accept-p1"));
    await press(byFocus("reject-p2"));
    expect(sent).toEqual([
      { method: "POST", url: "/api/refinement/s1/proposals/p1/accept", body: {} },
      { method: "POST", url: "/api/refinement/s1/proposals/p2/reject", body: {} },
    ]);
    expect(button("Edit")).toBeDefined();
  });
  it("edits an entry: prefilled, blank, same text, a failure and a success", async () => {
    await show();
    await press(byFocus("edit-e1"));
    const root = (document as any).getElementById("modal-root") as FakeElement;
    const area = walk(root).find((e) => e.tag === "textarea")!;
    expect(area.value).toBe("Old rule");
    type(area, "   ");
    await press(button("Save", root));
    expect(root.textContent).toContain("Write the entry.");
    type(area, "Old rule");
    await press(button("Save", root));
    expect(sent).toEqual([]);
    expect(walk(root).length).toBe(0);
    await press(byFocus("edit-e1"));
    const root2 = (document as any).getElementById("modal-root") as FakeElement;
    const area2 = walk(root2).find((e) => e.tag === "textarea")!;
    type(area2, "New rule");
    postMode = 400;
    await press(button("Save", root2));
    expect(toastText()).toBe("Answer every question first.");
    expect(walk(root2).length).toBe(0); // the dialog closed
    expect(gets).toHaveLength(2); // the page reloaded
    postMode = "ok";
    postAnswer = session({ talk: mkTalk({ map: { rules: [{ id: "e1", text: "New rule", at: "x" }], examples: [], open: [] } }) });
    await press(byFocus("edit-e1"));
    const root3 = (document as any).getElementById("modal-root") as FakeElement;
    type(walk(root3).find((e) => e.tag === "textarea")!, "New rule");
    await press(button("Save", root3));
    expect(sent.at(-1)).toEqual({ method: "PUT", url: "/api/refinement/s1/map/e1", body: { text: "New rule" } });
    expect(walk(root3).length).toBe(0);
    expect(text()).toContain("New rule");
  });
  it("does not close the edit dialog while the change is sent", async () => {
    await show();
    await press(byFocus("edit-e1"));
    const root = (document as any).getElementById("modal-root") as FakeElement;
    type(walk(root).find((e) => e.tag === "textarea")!, "Longer rule");
    postMode = "hold";
    await press(button("Save", root));
    const esc = (document as any).listeners.keydown ?? [];
    for (const fn of esc) fn({ key: "Escape", preventDefault() {} });
    expect(walk(root).length).toBeGreaterThan(0);
    postMode = "ok";
    postHold!();
    await flush();
    expect(walk(root).length).toBe(0);
  });
  it("removes an entry only after the person agrees", async () => {
    await show();
    confirmAnswer = false;
    await press(byFocus("remove-e1"));
    expect(sent).toEqual([]);
    confirmAnswer = true;
    await press(byFocus("remove-e1"));
    expect(sent).toEqual([{ method: "DELETE", url: "/api/refinement/s1/map/e1", body: undefined }]);
  });
});

describe("own questions and the states of the architect", () => {
  it("sends a question of my own and shows the waiting question, then the answer", async () => {
    await show();
    await press(byFocus("ask-send"));
    expect(sent).toEqual([]);
    expect(toastText()).toBe("Write your question first.");
    type(byFocus("ask")!, " How does it work? ");
    postAnswer = session({ architect: { state: "queued", kind: "question", runId: "r9" }, log: [{ at: "x", what: "asked", detail: "How does it work?" }] });
    await press(byFocus("ask-send"));
    expect(sent).toEqual([{ method: "POST", url: "/api/refinement/s1/ask", body: { question: "How does it work?" } }]);
    expect(text()).toContain("Question: How does it work?");
    expect(text()).toContain("Then it answers your question.");
    expect(byFocus("ask")).toBeUndefined();
    page = session({ talk: mkTalk({ asked: [{ runId: "r9", at: "x", question: "How does it work?", answer: "Like this." }] }) });
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(text()).toContain("The architect: Like this.");
    expect(byFocus("ask")).toBeDefined();
  });
  it.each(["round", "question"])("shows the states of a %s run in the talk, not in the brief", async (kind) => {
    const log = [{ at: "x", what: "asked", detail: "My question" }];
    const brief = () => walk(main()).filter((e) => e.tag === "p").map((e) => e.textContent).join("|");
    const mk = (a: object) => session({ architect: { kind, runId: "r", ...a }, log, talk: mkTalk({ rounds: [] }) });
    const work = kind === "round" ? "writing its questions" : "answering your question";
    page = mk({ state: "running", doing: "Clone the repository into repo/" });
    await show();
    expect(text()).toContain(work);
    expect(text()).toContain("Getting the code.");
    expect(text()).not.toContain("repo/");
    expect(brief()).not.toContain("The architect is at work");
    expect(byFocus("round")).toBeUndefined();
    expect(byFocus("ask")).toBeUndefined();
    // polling while busy
    const before = gets.length;
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(gets.length).toBe(before + 1);
    page = mk({ state: "paused", reason: "The usage limit is reached" });
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(text()).toContain("The architect paused.");
    expect(button("Refresh")).toBeUndefined();
    expect(byFocus("ask")).toBeUndefined();
    const stopped = gets.length;
    await vi.advanceTimersByTimeAsync(ui.POLL_MS * 3);
    expect(gets.length).toBe(stopped);
    const again = kind === "round" ? byFocus("round") : byFocus("again");
    expect(again!.textContent).toBe("Ask again");
    await press(again);
    expect(sent.at(-1)).toEqual(kind === "round"
      ? { method: "POST", url: "/api/refinement/s1/round", body: {} }
      : { method: "POST", url: "/api/refinement/s1/ask", body: { question: "My question" } });
    cleanup!();
    page = mk({ state: "failed", reason: "It broke" });
    await show();
    expect(text()).toContain("The architect could not finish.");
    const retry = kind === "round" ? byFocus("round") : byFocus("again");
    expect(retry!.textContent).toBe("Try again");
    if (kind === "round") expect(button("Refresh")).toBeDefined();
    else expect(byFocus("ask")).toBeDefined();
  });
  it("does not offer Ask again or Try again for a read-only view", async () => {
    for (const state of ["paused", "failed"]) {
      for (const over of [{ state: "dropped" }, { mine: false }]) {
        page = session({ ...over, architect: { state, kind: "question", runId: "r", reason: "x" }, log: [{ at: "x", what: "asked", detail: "Q" }] });
        await show(true);
        expect(byFocus("again")).toBeUndefined();
        cleanup!();
      }
    }
  });
});

describe("hidden and read-only talk", () => {
  it("says the talk is not shown and draws no control", async () => {
    page = session({ repoAvailable: false, talk: undefined, talkHidden: true });
    await show();
    expect(text()).toContain(talk.TALK_HIDDEN);
    expect(walk(main()).some((e) => e.tag === "h2" && e.textContent === "Map")).toBe(false);
    for (const t of talks()) expect(walk(t).some((e) => e.tag === "button" || e.tag === "textarea")).toBe(false);
  });
  it.each(["round", "question"])("still shows the states of a %s run while the talk is hidden", async (kind) => {
    for (const state of ["queued", "running", "paused", "failed"]) {
      page = session({ repoAvailable: false, talk: undefined, talkHidden: true, architect: { state, kind, runId: "r", reason: "Stopped" } });
      await show();
      expect(text()).toContain(talk.TALK_HIDDEN);
      expect(text()).toMatch(state === "queued" ? /waiting for its turn/ : state === "running" ? /is (writing|answering)/ : state === "paused" ? /paused/ : /could not finish/);
      for (const t of talks()) expect(walk(t).some((e) => e.tag === "button" || e.tag === "textarea")).toBe(false);
      cleanup!();
    }
  });
  it.each([
    ["dropped", { state: "dropped", removedOn: "2026-05-01T00:00:00.000Z" }, false],
    ["not mine", { mine: false }, true],
    ["repository gone", { repoAvailable: false, talk: mkTalk() }, false],
  ])("shows the texts without controls: %s", async (_n, over, admin) => {
    page = session(over);
    await show(admin as boolean);
    expect(text()).toContain("Question 1?");
    expect(text()).toContain("Old rule");
    expect(text()).not.toContain(talk.TALK_HIDDEN);
    expect(talks().length).toBeGreaterThan(0);
    for (const t of talks()) expect(walk(t).some((e) => e.tag === "button" || e.tag === "textarea")).toBe(false);
  });
});

describe("failed calls, one at a time, drafts and races", () => {
  it("shows the server's sentence and reloads once", async () => {
    await show();
    postMode = 409;
    await press(byFocus("opt-q1-1"));
    expect(toastText()).toBe("Answer every question first.");
    expect(gets).toHaveLength(2);
    postMode = "throw";
    await press(byFocus("opt-q1-1"));
    expect(toastText()).toBe("Could not reach the server.");
  });
  it("sends one request when pressed twice, and nothing from another button while one is held", async () => {
    await show();
    postMode = "hold";
    const a = byFocus("opt-q1-1")!;
    a.click();
    a.click();
    await flush();
    byFocus("unknown-q2")!.click();
    await flush();
    expect(sent).toHaveLength(1);
    postMode = "ok";
    postHold!();
    await flush();
  });
  it("keeps typed text over a redraw and drops it after a send", async () => {
    await show();
    type(byFocus("own-q1")!, "Typed");
    postMode = 409;
    await press(byFocus("opt-q2-1"));
    expect(byFocus("own-q1")!.value).toBe("Typed");
    page = session({ updated: "later" });
    postMode = "ok";
    await press(byFocus("opt-q2-1"));
    expect(byFocus("own-q1")!.value).toBe("Typed");
  });
  it("keeps the focus on the field over a redraw", async () => {
    page = session({ architect: { state: "running", kind: "round", runId: "r" } });
    await show();
    const old = byFocus("own-q1")!;
    old.focus();
    page = session({ architect: { state: "running", kind: "round", runId: "r", doing: "Reading the code" } });
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    const now = byFocus("own-q1")!;
    expect(now).not.toBe(old);
    expect((document as any).activeElement).toBe(now);
  });
  it("does not let an old poll undo an answer", async () => {
    page = session({ architect: { state: "running", kind: "round", runId: "r", doing: "x" } });
    await show();
    getMode = "hold";
    await vi.advanceTimersByTimeAsync(ui.POLL_MS);
    expect(getHold).toBeDefined();
    postAnswer = session({ architect: { state: "idle" }, talk: mkTalk({ rounds: [{ runId: "r1", at: "x", questions: [question(1, { answer: { option: 1 } }), question(2)] }] }) });
    // the old poll is held; a change is shown meanwhile
    postMode = "ok";
    await press(byFocus("opt-q1-1") ?? button("Choose"));
    getHold!();
    await flush();
    expect(text()).toContain("Answer: Option 1: Option one of 1");
  });
});

describe("text, tab and displays", () => {
  const BAD = "<img src=x onerror=alert(1)><script>boom()</script>";
  it("shows texts as text, never as HTML", async () => {
    page = session({
      talk: mkTalk({
        rounds: [{ runId: "r", at: "x", questions: [question(1, { text: BAD, why: BAD, options: [{ text: BAD, tradeoff: BAD }, { text: "B", tradeoff: "C" }] })], done: BAD }],
        proposals: [{ id: "p1", list: "rule", text: BAD }],
        map: { rules: [{ id: "e1", text: BAD, at: "x" }], examples: [], open: [] },
        asked: [{ runId: "x", at: "x", question: BAD, answer: BAD }],
      }),
      log: [{ at: new Date().toISOString(), what: "question", who: "Ann", detail: BAD }],
    });
    await show();
    expect(text()).toContain(BAD);
    expect(walk(main()).some((e) => e.tag === "img" || e.tag === "script")).toBe(false);
  });
  it("has no tabindex and offers the same controls on both displays", async () => {
    await show(true);
    const admin = buttons().map((b) => b.textContent);
    expect(walk(main()).some((e) => "tabindex" in e.attrs)).toBe(false);
    cleanup!();
    await show(false);
    expect(buttons().map((b) => b.textContent)).toEqual(admin);
    expect(admin).toContain("Choose");
  });
});
