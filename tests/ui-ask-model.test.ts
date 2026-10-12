import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QUESTION_MAX as SERVER_MAX, checkContext } from "../src/help/store.js";
import { installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let m: any;
beforeAll(async () => {
  restore = installFakeDom();
  m = await import("../ui/ask-model.js" as string);
});
afterAll(() => restore());

const q = (text = "Why?") => ({ id: "q1", role: "user", status: "done", text });
const a = (status: string, over: any = {}) => ({ id: "a1", role: "assistant", status, text: "", replyTo: "q1", tries: 1, ...over });
const conv = (messages: any[], state = "active") => ({ id: "c1", state, title: "Why?", messages });

describe("the page that goes with a question", () => {
  it("is the address without its query, and only a form the server takes", () => {
    expect(m.pageOf("#/runs?repo=acme%2Fapp&owner=u1")).toBe("#/runs");
    expect(m.pageOf("#/runs/abc-1")).toBe("#/runs/abc-1");
    for (const bad of ["", "#", "runs", "#/a b", "#/<script>", `#/${"x".repeat(200)}`, undefined, null, 7]) expect(m.pageOf(bad), String(bad)).toBeNull();
  });

  it("is accepted by the server's own check, for every page of both roles", () => {
    for (const role of ["admin", "user"]) {
      for (const hash of ["#/home", "#/runs", "#/runs/r-1", "#/repos/acme%2Fapp", "#/refinement/backlog", "#/start"]) {
        const { context } = m.contextFor(m.whereOf(role, hash), true);
        expect(checkContext(context), hash).toEqual({ page: hash });
      }
    }
  });

  it("names the page of the role, and sends nothing for an address that is not one", () => {
    expect(m.whereOf("user", "#/runs")).toEqual({ id: "runs", area: "runs", title: "My runs", page: "#/runs" });
    expect(m.whereOf("admin", "#/runs").title).toBe("Runs");
    expect(m.whereOf("admin", "#/settings?x=1")).toMatchObject({ id: "settings", area: "administration", page: "#/settings" });
    // a user has no Settings page: the address falls back, and no page is sent
    expect(m.whereOf("user", "#/settings").page).toBeNull();
    expect(m.whereOf("user", "").page).toBeNull();
  });

  it("says before Send what is attached: the page only, or nothing", () => {
    const where = m.whereOf("admin", "#/runs/r-1?repo=a%2Fb");
    const on = m.contextFor(where, true);
    expect(on.context).toEqual({ page: "#/runs/r-1" });
    expect(Object.keys(on.context)).toEqual(["page"]);
    expect(on.text).toContain("#/runs/r-1");
    expect(on.text).toContain("Sent with your question");
    const off = m.contextFor(where, false);
    expect(off.context).toBeUndefined();
    expect(off.text).toBe("Nothing about this page is sent with your question.");
    expect(m.contextFor(m.whereOf("user", "#/nowhere"), true).context).toBeUndefined();
    expect(m.contextFor(null, true).context).toBeUndefined();
  });
});

describe("suggested questions", () => {
  it("fit the page and always leave a general one", () => {
    const of = (role: string, hash: string) => m.suggestionsFor(m.whereOf(role, hash));
    expect(of("user", "#/runs")[0]).toBe("What do the statuses of a run mean?");
    expect(of("user", "#/runs/r-1")[0]).toBe("How do I read the steps of a run?");
    expect(of("admin", "#/settings")[0]).toBe("What does this page set?");
    expect(of("admin", "#/refinement")[0]).toBe("How does Refinement work?");
    expect(of("admin", "#/flows")[0]).toBe("What is a flow?");
    for (const hash of ["#/home", "#/runs", "#/start", "#/repos", "#/board", "#/problems", "#/library", "#/audit"]) {
      const list = of("admin", hash);
      expect(list.length, hash).toBeGreaterThanOrEqual(2);
      expect(list.length, hash).toBeLessThanOrEqual(4);
      expect(new Set(list).size, hash).toBe(list.length);
      expect(list, hash).toContain("What can Ask SCF help me with?");
      for (const s of list) expect(s, s).toMatch(/^[A-Z].*\?$/);
    }
    expect(m.suggestionsFor(null)).toEqual(["What can Ask SCF help me with?", "Where do I start work on an issue?"]);
  });
});

describe("sending", () => {
  it("keeps the same limit as the server", () => {
    expect(m.QUESTION_MAX).toBe(SERVER_MAX);
  });

  it("refuses an empty or too long question with a reason", () => {
    expect(m.sendPlan({ draft: "  \n " })).toEqual({ ok: false, reason: "Type your question first." });
    expect(m.sendPlan({})).toMatchObject({ ok: false });
    const long = m.sendPlan({ draft: "x".repeat(m.QUESTION_MAX + 1) });
    expect(long.ok).toBe(false);
    expect(long.reason).toContain(String(m.QUESTION_MAX + 1));
    expect(m.sendPlan({ draft: "x".repeat(m.QUESTION_MAX) }).ok).toBe(true);
  });

  it("sends nothing a second time while a request is on its way or a reply is being written", () => {
    expect(m.sendPlan({ draft: "Why?", busy: true })).toMatchObject({ ok: false });
    expect(m.sendPlan({ draft: "Why?", conversation: conv([q(), a("pending")]) })).toEqual({ ok: false, reason: "Ask SCF is still answering. Wait for the answer first." });
  });

  it("sends the trimmed question, with the page only when it is attached", () => {
    const where = m.whereOf("user", "#/runs");
    expect(m.sendPlan({ draft: "  Why?\r\nReally? ", where, attach: true })).toEqual({ ok: true, to: null, body: { question: "Why?\nReally?", context: { page: "#/runs" } } });
    expect(m.sendPlan({ draft: "Why?", where, attach: false })).toEqual({ ok: true, to: null, body: { question: "Why?" } });
    expect(m.sendPlan({ draft: "Why?" })).toEqual({ ok: true, to: null, body: { question: "Why?" } });
  });

  it("goes on in an open conversation and starts a new one after a closed one", () => {
    for (const state of ["active", "failed", "cancelled"]) expect(m.sendPlan({ draft: "And?", conversation: conv([q(), a("done")], state) }).to, state).toBe("c1");
    for (const state of ["completed", "archived", "deleted"]) expect(m.sendPlan({ draft: "And?", conversation: conv([q(), a("done")], state) }).to, state).toBeNull();
  });
});

describe("reading the answer", () => {
  it("reads again only while the drawer is open and a reply is waited for, and slows down", () => {
    const waiting = conv([q(), a("pending")]);
    expect(m.pollDelay({ open: true, conversation: waiting, polls: 0 })).toBe(1500);
    expect(m.pollDelay({ open: true, conversation: waiting, polls: 10 })).toBe(4000);
    expect(m.pollDelay({ open: false, conversation: waiting })).toBeNull();
    expect(m.pollDelay({ open: true, conversation: conv([q(), a("done")]) })).toBeNull();
    expect(m.pollDelay({ open: true, conversation: null })).toBeNull();
    expect(m.pollDelay()).toBeNull();
    expect(m.isWaiting(conv([q()]))).toBe(false);
  });

  it("shows each message as what it is", () => {
    const kinds = (c: any) => m.threadOf(c).map((e: any) => e.kind);
    expect(kinds(conv([q(), a("pending")]))).toEqual(["question", "waiting"]);
    expect(kinds(conv([q(), a("done", { text: "Because." })]))).toEqual(["question", "answer"]);
    expect(kinds(conv([q(), a("failed", { text: "The AI service did not answer." })]))).toEqual(["question", "failed"]);
    expect(kinds(conv([q(), a("cancelled")]))).toEqual(["question", "stopped"]);
    expect(m.threadOf(null)).toEqual([]);
    expect(m.entryOf(q("<b>Why?</b>"))).toEqual({ id: "q1", kind: "question", who: "You", text: "<b>Why?</b>", note: "" });
    // a failure that trying again cannot solve is its own kind
    expect(m.entryOf(a("failed", { failure: { code: "limit", retry: false } })).kind).toBe("limit");
    expect(m.entryOf(a("failed", { failure: { code: "provider", retry: true } })).kind).toBe("failed");
    expect(m.entryOf(a("failed")).text).toBe("Ask SCF could not answer.");
    expect(m.entryOf(a("done", { text: 7 })).text).toBe("");
  });

  it("announces the start of the wait and the result once", () => {
    const waiting = conv([q(), a("pending")]);
    expect(m.announce(null, waiting)).toBe("Ask SCF is working on your answer.");
    expect(m.announce(waiting, waiting)).toBe("");
    expect(m.announce(waiting, conv([q(), a("done", { text: "Because." })]))).toBe("Ask SCF answered. The answer is below your question.");
    expect(m.announce(waiting, conv([q(), a("failed", { text: "The AI service did not answer. You can try again in a moment." })]))).toBe("The AI service did not answer. You can try again in a moment.");
    expect(m.announce(waiting, conv([q(), a("cancelled", { text: "You stopped this answer. You can ask again." })]))).toBe("You stopped this answer. You can ask again.");
    // the same reply tried again is a new wait
    expect(m.announce(conv([q(), a("failed")]), conv([q(), a("pending", { tries: 2 })]))).toBe("Ask SCF is working on your answer.");
    expect(m.announce(null, conv([q()]))).toBe("");
    expect(m.announce(null, null)).toBe("");
  });
});

describe("a failed call", () => {
  it("is said in plain words, and a text of the server only where it is a fixed one", () => {
    expect(m.explainAskError(new TypeError("Failed to fetch"))).toBe("The Foundry could not be reached. Check your connection, then try again.");
    expect(m.explainAskError({ status: 503, message: "Ask SCF is switched off on this Foundry. An administrator can switch it on." })).toBe("Ask SCF is switched off on this Foundry. An administrator can switch it on.");
    expect(m.explainAskError({ status: 400, message: "type your question" })).toBe("Type your question.");
    expect(m.explainAskError({ status: 429, message: "You have used all your questions to Ask SCF for today. Try again tomorrow, or ask an administrator." })).toContain("for today");
    expect(m.explainAskError({ status: 404, message: "not found" })).toBe("This conversation is gone. Ask your question in a new one.");
    expect(m.explainAskError({ status: 410 })).toBe("This conversation is gone. Ask your question in a new one.");
    expect(m.explainAskError({ status: 401 })).toBe("Your session has ended. Sign in again.");
    expect(m.explainAskError({ status: 500, message: "stack trace at /srv/x" })).toBe("Ask SCF is not working now. Try again later.");
    expect(m.explainAskError({ status: 409, message: "" })).toBe("Ask SCF is not working now. Try again later.");
  });
});

describe("keys", () => {
  it("Escape closes the drawer, but not under a dialog", () => {
    expect(m.closesOn({ key: "Escape" })).toBe(true);
    expect(m.closesOn({ key: "Escape" }, { dialogOnTop: true })).toBe(false);
    expect(m.closesOn({ key: "Enter" })).toBe(false);
    expect(m.closesOn(undefined)).toBe(false);
  });
});

describe("progress", () => {
  it("says after 20 seconds that it takes long, and points at Stop", () => {
    expect(m.waitNote(0)).toEqual({ slow: false, text: "Ask SCF is working on your answer." });
    expect(m.waitNote(m.SLOW_AFTER_MS - 1).slow).toBe(false);
    expect(m.waitNote(m.SLOW_AFTER_MS)).toEqual({ slow: true, text: "Ask SCF is still working. This takes longer than usual. You can wait, or stop the answer." });
    expect(m.waitNote().slow).toBe(false);
    expect(m.entryOf(a("pending"), { elapsedMs: 30_000 }).text).toContain("longer than usual");
    expect(m.threadOf(conv([q(), a("pending")]), { elapsedMs: 30_000 })[1].text).toContain("longer than usual");
  });

  it("keeps the earlier tries as a note on the one reply, not as more messages", () => {
    expect(m.triesNote(a("pending"))).toBe("");
    expect(m.triesNote(a("pending", { tries: 2 }))).toBe("This is the second try. The first try gave no answer.");
    expect(m.triesNote(a("done", { tries: 4 }))).toBe("This is try 4. The 3 tries before it gave no answer.");
    expect(m.triesNote({ role: "user", tries: 3 })).toBe("");
    const again = conv([q(), a("pending", { tries: 2 })]);
    expect(m.threadOf(again)).toHaveLength(2);
    expect(m.threadOf(again)[1].note).toBe("This is the second try. The first try gave no answer.");
  });
});

describe("the controls of a conversation", () => {
  const none = { stop: false, retry: false, archive: false, restore: false, remove: false };
  const of = (c: any, busy = false) => m.controlsFor(c, { busy });

  it("offers nothing without a conversation", () => {
    expect(of(null)).toEqual(none);
    expect(of(conv([], "deleted"))).toEqual(none);
  });

  it("offers Stop only while a reply is written, and no Archive then", () => {
    expect(of(conv([q(), a("pending")]))).toEqual({ ...none, stop: true, remove: true });
    expect(of(conv([q(), a("done")]))).toEqual({ ...none, archive: true, remove: true });
  });

  it("offers Try again after a failure that it can solve and after a stop, not after a limit", () => {
    expect(of(conv([q(), a("failed", { failure: { code: "provider", retry: true } })], "failed")).retry).toBe(true);
    expect(of(conv([q(), a("failed", { failure: { code: "timeout", retry: true } })], "failed")).retry).toBe(true);
    expect(of(conv([q(), a("cancelled")], "cancelled")).retry).toBe(true);
    for (const code of ["limit", "quota", "setup"]) expect(of(conv([q(), a("failed", { failure: { code, retry: false } })], "failed")).retry, code).toBe(false);
    expect(of(conv([q(), a("done")])).retry).toBe(false);
  });

  it("offers nothing while a call is on its way, so no press counts twice", () => {
    expect(of(conv([q(), a("failed", { failure: { code: "provider", retry: true } })], "failed"), true)).toEqual(none);
    expect(of(conv([q(), a("pending")]), true)).toEqual(none);
  });

  it("offers only to take back or delete an archived conversation", () => {
    expect(of(conv([q(), a("failed", { failure: { code: "provider", retry: true } })], "archived"))).toEqual({ ...none, restore: true, remove: true });
  });

  it("says what each control does", () => {
    expect(Object.keys(m.CONSEQUENCES).sort()).toEqual(["archive", "fresh", "remove", "restore", "retry", "stop"]);
    expect(m.CONSEQUENCES.remove).toContain("cannot be brought back");
    expect(m.CONSEQUENCES.retry).toContain("counts as one of your questions of today");
    for (const t of Object.values(m.CONSEQUENCES) as string[]) expect(t).toMatch(/^[A-Z].*\.$/);
  });
});

describe("the list of conversations", () => {
  const row = (id: string, over: any = {}) => ({ id, title: `T ${id}`, state: "active", messages: 2, waiting: false, updated: "2026-01-01T00:00:00.000Z", ...over });

  it("gives every state a word", () => {
    expect(["active", "completed", "failed", "cancelled", "archived"].map((state) => m.stateWord({ state }))).toEqual(["Open", "Closed", "No answer", "Stopped", "Archived"]);
    expect(m.stateWord({ state: "active", waiting: true })).toBe("Answering");
    expect(m.stateWord(conv([q(), a("pending")]))).toBe("Answering");
    expect(m.stateWord({})).toBe("Open");
  });

  it("keeps the order of the server and leaves out what is not a conversation", () => {
    const id1 = "11111111-1111-4111-8111-111111111111";
    const id2 = "22222222-2222-4222-8222-222222222222";
    expect(m.historyRows([row(id1), null, { title: "no id" }, row(id2, { state: "failed", title: "  " }), row("x", { state: "deleted" })])).toEqual([
      { id: id1, title: `T ${id1}`, word: "Open", updated: "2026-01-01T00:00:00.000Z" },
      { id: id2, title: "Question", word: "No answer", updated: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(m.historyRows(undefined)).toEqual([]);
    expect(m.historyRows("x")).toEqual([]);
  });

  it("after a reload shows the conversation that was open, only when the server still lists it", () => {
    const id1 = "11111111-1111-4111-8111-111111111111";
    const id2 = "22222222-2222-4222-8222-222222222222";
    expect(m.restorePick([row(id1), row(id2)], id2)).toBe(id2);
    // an id the server does not list for this account is never read: another account, a deleted one, or made up
    expect(m.restorePick([row(id1)], id2)).toBeNull();
    expect(m.restorePick([row(id1)], "../../users")).toBeNull();
    expect(m.restorePick([row(id1)], null)).toBeNull();
    // nothing remembered: the conversation whose reply is being written
    expect(m.restorePick([row(id1), row(id2, { waiting: true })], null)).toBe(id2);
    expect(m.restorePick([row(id1), row(id2, { waiting: true })], id1)).toBe(id1);
    expect(m.restorePick(undefined, id1)).toBeNull();
  });
});

describe("late answers", () => {
  it("a ticket is good until something is switched", () => {
    const g = m.staleGuard();
    const first = g.ticket();
    expect(first()).toBe(true);
    g.next();
    expect(first()).toBe(false);
    const second = g.ticket();
    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });
});
