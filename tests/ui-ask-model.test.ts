import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CERTAINTY_WORDS, NAV_PAGES, PART_RULES, QUESTION_RULES, checkReply, navPage, type HelpRole } from "../src/help/contract.js";
import { FEEDBACK_REASONS, QUESTION_MAX as SERVER_MAX, checkContext } from "../src/help/store.js";
import { REFUSAL_WORDS } from "../src/help/turn.js";
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
    expect(Object.keys(m.CONSEQUENCES).sort()).toEqual(["archive", "fresh", "remove", "restore", "retry", "solved", "stop"]);
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

// ---- #236: a reply by its parts ---------------------------------------------------------------------

const SEEN = "2026-10-12T10:00:00.000Z";
const docSrc = (over: any = {}) => ({ id: "d1", kind: "doc", title: "User guide: Runs", ref: "docs/USER_GUIDE.md#runs", ...over });
const stateSrc = (over: any = {}) => ({ id: "s1", kind: "state", title: "Run r-1 waits for your answer", ref: "#/runs/r-1", observedAt: SEEN, ...over });
const reply = (over: any = {}) => ({ type: "product-help", summary: "A run is one start of a flow.", explanation: "", certainty: "confirmed", evidence: [docSrc()], recommendations: [], links: [], drafts: [], actions: [], ...over });

describe("links", () => {
  it("takes every page the contract allows, for the roles that have it, and no other role", () => {
    for (const role of ["admin", "user"] as HelpRole[]) {
      for (const page of NAV_PAGES) {
        const link = m.pageLink(role, page.to, { fixed: true });
        if (navPage(role, page.to)) expect(link, `${role} ${page.to}`).toMatchObject({ href: page.to });
        else expect(link, `${role} ${page.to}`).toBeNull();
      }
    }
  });

  it("takes nothing that is not a page of this interface", () => {
    const bad = ["https://evil.example/#/runs", "//evil.example", "javascript:alert(1)", "data:text/html,x", "/api/users", "#/runs?repo=a%2Fb", "#/nowhere", "#/your-turn", "#/runs/a/b/c", " #/runs", "#/runs ", "", null, undefined, 7, {}, "#/<img src=x>"];
    for (const to of bad) {
      expect(m.pageLink("admin", to), String(to)).toBeNull();
      expect(m.pageLink("admin", to, { fixed: true }), String(to)).toBeNull();
    }
  });

  it("a reply links to fixed pages only; a source may point at one run or one repository", () => {
    expect(m.pageLink("user", "#/runs/r-1", { fixed: true })).toBeNull();
    expect(m.pageLink("user", "#/repos/acme%2Fapp", { fixed: true })).toBeNull();
    expect(m.pageLink("user", "#/runs/r-1")).toEqual({ href: "#/runs/r-1", title: "Run r-1" });
    expect(m.pageLink("admin", "#/problems/p-1")).toMatchObject({ href: "#/problems/p-1" });
    expect(m.pageLink("user", "#/problems/p-1")).toBeNull();
    expect(m.pageLink("user", "#/refinement/backlog", { fixed: true })).toMatchObject({ href: "#/refinement/backlog" });
    // the name of the link is the page's own, not a text of the reply
    expect(m.pageLink("user", "#/runs", { fixed: true })!.title).toBe("My runs");
  });
});

describe("how sure a reply is", () => {
  const trust = (r: any, role = "user") => m.replyLayout(r, role).trust;

  it("uses the server's fixed sentences and its rule for the source a question needs", () => {
    expect(m.CERTAINTY_WORDS).toEqual(CERTAINTY_WORDS);
    expect(m.NEEDS).toEqual(Object.fromEntries(Object.entries(QUESTION_RULES).map(([k, v]) => [k, v.evidence])));
  });

  it("has five states that differ in name, sign and class", () => {
    const states = [
      trust(reply()),
      trust(reply({ certainty: "likely" })),
      trust(reply({ certainty: "unverified", evidence: [] })),
      trust(reply({ type: "status", evidence: [stateSrc(), stateSrc({ id: "s2", title: "Run r-1 is done" })] })),
      trust(reply({ limit: { code: "secret", limitation: "x", nextStep: "y" }, evidence: [] })),
    ];
    expect(states.map((t: any) => t.state)).toEqual(["confirmed", "low", "missing", "conflict", "limit"]);
    for (const key of ["state", "glyph", "label"]) expect(new Set(states.map((t: any) => t[key])).size, key).toBe(5);
    for (const t of states) expect(t.text).toMatch(/\.$/);
  });

  it("low confidence: likely, or unsure although it has sources", () => {
    expect(trust(reply({ certainty: "likely" }))).toMatchObject({ state: "low", label: "Not fully confirmed", text: CERTAINTY_WORDS.likely });
    expect(trust(reply({ certainty: "unverified" }))).toMatchObject({ state: "low", text: "Ask SCF has the sources below but is not sure of this. Treat it as a guess." });
  });

  it("missing evidence: no source of the kind the question needs, whatever the reply claims", () => {
    expect(trust(reply({ evidence: [], certainty: "unverified" }))).toMatchObject({ state: "missing", label: "Not checked: no source", text: CERTAINTY_WORDS.unverified });
    // a claim about the current state with only documentation behind it
    const status = trust(reply({ type: "status", certainty: "confirmed", evidence: [docSrc()] }));
    expect(status.state).toBe("missing");
    expect(status.text).toBe(`No source shows the current state of your work. ${CERTAINTY_WORDS.unverified}`);
    // a reply that says "confirmed" without any source is not shown as confirmed
    expect(trust(reply({ evidence: [], certainty: "confirmed" })).state).toBe("missing");
    expect(trust(reply({ evidence: "x", certainty: "confirmed" })).state).toBe("missing");
  });

  it("contradictory evidence: two sources about one place that differ, and it wins over the claimed level", () => {
    const two = [stateSrc(), stateSrc({ id: "s2", title: "Run r-1 is done" })];
    expect(trust(reply({ type: "status", certainty: "confirmed", evidence: two }))).toMatchObject({ state: "conflict", label: "The sources do not agree" });
    // the same source twice, or two places, is no contradiction
    expect(trust(reply({ type: "status", evidence: [stateSrc(), stateSrc({ id: "s2" })] })).state).toBe("confirmed");
    expect(trust(reply({ type: "status", evidence: [stateSrc(), stateSrc({ id: "s2", ref: "#/runs/r-2", title: "Run r-2 is done" })] })).state).toBe("confirmed");
    expect(m.sourcesDisagree([])).toBe(false);
  });
});

describe("sources and assumptions", () => {
  it("lists each source with its kind, its place and when the state was read", () => {
    const layout = m.replyLayout(reply({ type: "status", evidence: [stateSrc(), docSrc()] }), "user");
    expect(layout.sources).toEqual([
      { id: "s1", kind: "state", what: "Current state", title: "Run r-1 waits for your answer", ref: "#/runs/r-1", href: "#/runs/r-1", observedAt: SEEN },
      { id: "d1", kind: "doc", what: "Documentation", title: "User guide: Runs", ref: "docs/USER_GUIDE.md#runs", href: null, observedAt: null },
    ]);
    // a statement about the current state is traced to the state sources, next to the answer
    expect(layout.basis).toEqual({ needs: "state", sources: [layout.sources[0]] });
    expect(m.replyLayout(reply(), "user").basis).toMatchObject({ needs: "doc", sources: [{ id: "d1" }] });
  });

  it("links a source only to a page of the role, and never to another site", () => {
    const of = (ref: string, role = "user") => m.sourcesOf({ evidence: [stateSrc({ ref })] }, role)[0].href;
    expect(of("#/runs/r-1")).toBe("#/runs/r-1");
    expect(of("#/problems/p-1")).toBeNull();
    expect(of("#/problems/p-1", "admin")).toBe("#/problems/p-1");
    expect(of("https://evil.example")).toBeNull();
    expect(of("javascript:alert(1)")).toBeNull();
    expect(m.sourcesOf({ evidence: [null, {}, { title: "" }, stateSrc({ observedAt: "not a time" })] }, "user")).toMatchObject([{ observedAt: null }]);
    expect(m.sourcesOf(undefined, "user")).toEqual([]);
  });

  it("says what the reply takes for granted", () => {
    const of = (r: any) => m.replyLayout(r, "user").assumptions;
    expect(of(reply())).toEqual(["The documentation of this Foundry was used as it is installed here.", "Ask SCF sees only what your own account can see."]);
    expect(of(reply({ type: "status", evidence: [stateSrc()] }))[0]).toBe("The current state was read at the times shown. It can have changed since.");
    expect(of(reply({ evidence: [] }))).toContain("Nothing was checked against the documentation or the current state.");
    expect(of(reply({ certainty: "likely" }))).toContain("The sources do not fully confirm the answer.");
    expect(of(reply({ type: "status", evidence: [stateSrc(), stateSrc({ id: "s2", title: "Other" })] }))).toContain("The answer may rest on the wrong one of two sources.");
    expect(of(reply({ limit: { code: "secret" }, evidence: [] }))).toEqual([]);
  });
});

describe("proposals as cards", () => {
  const cards = (r: any, role = "user") => m.replyLayout(r, role).cards;

  it("marks every card as read-only or as changing state, as the contract does for its part", () => {
    const all = cards(reply({ recommendations: ["Open the run."], links: [{ label: "Runs", to: "#/runs" }], drafts: [{ title: "Comment", text: "Hello" }], actions: [{ id: "x", title: "Cancel run r-1", impact: "The run stops." }] }));
    expect(all.map((c: any) => [c.kind, c.effect])).toEqual([["recommendation", "read-only"], ["navigation", "read-only"], ["draft", "read-only"], ["action", "changes-state"]]);
    for (const c of all) expect(c.effect === "changes-state", c.kind).toBe(PART_RULES[c.kind as keyof typeof PART_RULES].changesState);
    expect(Object.keys(m.EFFECT_WORDS)).toEqual(["read-only", "changes-state"]);
    for (const c of all) expect(c.note, c.kind).toMatch(/\.$/);
  });

  it("shows an action as a suggestion that Ask SCF does not do", () => {
    const [card] = cards(reply({ actions: [{ id: "cancel-run", title: "Cancel run r-1", impact: "The run stops." }] }));
    expect(card).toEqual({ kind: "action", effect: "changes-state", title: "Suggested change: Cancel run r-1", text: "The run stops.", note: "Ask SCF does not do this. Nothing happens here. If you want it, do it yourself on the page where it belongs." });
    expect(card.link).toBeUndefined();
  });

  it("makes a link only of a fixed page of the role; any other address stays text", () => {
    const [ok, id, site, script] = cards(reply({ links: [{ label: "Click here to win", to: "#/runs" }, { label: "One run", to: "#/runs/r-1" }, { label: "Docs", to: "https://evil.example" }, { label: "x", to: "javascript:alert(1)" }] }));
    expect(ok).toMatchObject({ kind: "navigation", title: "A page you can open", link: { href: "#/runs", title: "My runs" }, text: "" });
    for (const c of [id, site, script]) {
      expect(c.link).toBeUndefined();
      expect(c.title).toBe("An address that is not a page here");
    }
    expect(site.text).toBe("Docs: https://evil.example");
    expect(cards(reply({ links: [{ label: "Settings", to: "#/settings" }] }))[0].link).toBeUndefined();
    expect(cards(reply({ links: [{ label: "Settings", to: "#/settings" }] }), "admin")[0].link).toEqual({ href: "#/settings", title: "Settings" });
  });

  it("leaves out empty parts and survives a reply that is not one", () => {
    expect(cards(reply({ recommendations: ["", 7, null], links: [null, {}], drafts: [{ title: "x" }], actions: [{ id: "x" }] }))).toEqual([]);
    for (const bad of [null, undefined, "text", 7, {}, { summary: "" }, []]) expect(m.replyLayout(bad, "user"), String(bad)).toBeNull();
    expect(m.replyLayout({ summary: "Only this." }, "user")).toMatchObject({ summary: "Only this.", explanation: "", cards: [], sources: [], trust: { state: "missing" } });
  });

  it("lays out a request that is not served: the fixed words, what to do, and no sources", () => {
    const checked = checkReply({ limit: "secret", summary: "ignored" }, { role: "user" })!.reply;
    const layout = m.replyLayout(checked, "user");
    expect(layout.trust.state).toBe("limit");
    expect(layout.summary).toBe(checked.summary);
    expect(layout.sources).toEqual([]);
    expect(layout.cards.map((c: any) => [c.kind, c.title])).toEqual([["recommendation", "What you can do"], ["navigation", "A page you can open"]]);
    expect(layout.cards[1].link).toEqual({ href: "#/repos", title: "My repositories" });
  });
});

describe("a reply as the server checked it", () => {
  it("is laid out from its parts, and what the server let through is checked again", () => {
    const offered = [{ id: "s1", kind: "state" as const, title: "Run r-1 waits for your answer", ref: "#/runs/r-1", observedAt: SEEN }];
    const raw = { type: "status", summary: "Your run waits for an answer. <script>alert(1)</script>", explanation: "See https://evil.example/now", certainty: "confirmed", evidence: ["s1", "made-up"], recommendations: ["Answer the question on the run page."], links: [{ label: "Win", to: "https://evil.example" }, { label: "x", to: "#/runs" }], drafts: [], actions: [{ id: "rm -rf", title: "Delete all", impact: "x" }] };
    const checked = checkReply(raw, { role: "user", offered })!.reply;
    const layout = m.replyLayout(checked, "user");
    expect(layout.summary).toBe("Your run waits for an answer. <script>alert(1)</script>");
    expect(layout.explanation).toBe("See https://evil.example/now");
    expect(layout.trust.state).toBe("confirmed");
    expect(layout.basis.sources).toMatchObject([{ id: "s1", href: "#/runs/r-1", observedAt: SEEN }]);
    expect(layout.cards.map((c: any) => c.kind)).toEqual(["recommendation", "navigation"]);
    expect(layout.cards[1].link).toEqual({ href: "#/runs", title: "My runs" });
    // the message carries the layout; its plain text is not shown a second time
    const entry = m.entryOf({ id: "a1", role: "assistant", status: "done", text: "plain", reply: checked, tries: 1 }, { role: "user" });
    expect(entry).toMatchObject({ kind: "answer", text: "", layout: { summary: layout.summary } });
    expect(m.entryOf({ id: "a1", role: "assistant", status: "done", text: "plain", tries: 1 })).toEqual({ id: "a1", kind: "answer", who: "Ask SCF", text: "plain", note: "", rateable: true, feedback: { vote: null, reasons: [] } });
  });
});

describe("rating an answer and the pause", () => {
  it("has the reasons and the pause sentence of the server", () => {
    expect(Object.keys(m.REASON_WORDS).sort()).toEqual([...FEEDBACK_REASONS].sort());
    expect(m.PAUSED_WORDS).toBe(REFUSAL_WORDS.paused);
  });

  it("shows the vote and the reasons of a finished reply, and nothing else", () => {
    const done = (feedback: any) => m.entryOf(a("done", { text: "ok", feedback }));
    expect(done(undefined)).toMatchObject({ rateable: true, feedback: { vote: null, reasons: [] } });
    expect(done({ vote: "helpful", reasons: [] }).feedback).toEqual({ vote: "helpful", reasons: [] });
    expect(done({ vote: "not-helpful", reasons: ["unclear", "made-up"] }).feedback).toEqual({ vote: "not-helpful", reasons: ["unclear"] });
    expect(done({ vote: "loved", reasons: [] }).feedback.vote).toBeNull();
    for (const status of ["pending", "failed", "cancelled"]) expect(m.entryOf(a(status)).rateable).toBeUndefined();
    expect(m.entryOf(q()).rateable).toBeUndefined();
  });

  it("toggles a vote, and sends reasons only with not-helpful", () => {
    expect(m.feedbackPlan("a1", "helpful", ["unclear"])).toEqual({ message: "a1", vote: "helpful", reasons: [] });
    expect(m.feedbackPlan("a1", "helpful", [], "helpful")).toEqual({ message: "a1", vote: null, reasons: [] });
    expect(m.feedbackPlan("a1", "not-helpful", ["unclear", "unclear", "x"], null)).toEqual({ message: "a1", vote: "not-helpful", reasons: ["unclear"] });
    expect(m.feedbackPlan("a1", "not-helpful", ["unclear"], "not-helpful")).toEqual({ message: "a1", vote: null, reasons: [] });
    expect(m.feedbackPlan("a1", "bogus")).toEqual({ message: "a1", vote: null, reasons: [] });
    expect(m.voteNote("helpful")).toContain("helped");
    expect(m.voteNote("not-helpful")).toContain("did not help");
    expect(m.voteNote(null)).toContain("taken back");
  });

  it("takes no question and no retry while paused", () => {
    expect(m.sendPlan({ draft: "Why?", paused: true })).toEqual({ ok: false, reason: m.PAUSED_WORDS });
    expect(m.sendPlan({ draft: "Why?", paused: false }).ok).toBe(true);
    const failed = conv([q(), a("failed", { failure: { code: "provider", retry: true } })], "failed");
    expect(m.controlsFor(failed, { busy: false, paused: false }).retry).toBe(true);
    expect(m.controlsFor(failed, { busy: false, paused: true })).toMatchObject({ retry: false, archive: true, remove: true });
  });

  it("knows a paused refusal from another 503", () => {
    expect(m.isPausedError({ status: 503, message: REFUSAL_WORDS.paused })).toBe(true);
    for (const e of [{ status: 503, message: REFUSAL_WORDS.off }, { status: 503, message: REFUSAL_WORDS.unsafe }, { status: 409, message: REFUSAL_WORDS.paused }, null, {}]) expect(m.isPausedError(e)).toBe(false);
  });

  it("offers 'This solved my problem' for an open conversation with a finished answer only", () => {
    expect(m.solveOffered(conv([q(), a("done")]))).toBe(true);
    expect(m.solveOffered(conv([q(), a("done")]), { busy: true })).toBe(false);
    for (const state of ["completed", "archived", "failed", "cancelled"]) expect(m.solveOffered(conv([q(), a("done")], state)), state).toBe(false);
    expect(m.solveOffered(conv([q(), a("pending")]))).toBe(false);
    expect(m.solveOffered(null)).toBe(false);
  });
});

describe("a plan", () => {
  const step = (over: any = {}) => ({ kind: "reversible", title: "Make a copy", evidence: [], expected: "A copy.", failure: "Empty.", fallback: "Stop.", ...over });
  const planned = (plan: any[], over: any = {}) => reply({ type: "guided-resolution", plan, ...over });

  it("has the labels of the server's six kinds of step", async () => {
    const { STEP_RULES } = await import("../src/help/plan.js");
    expect(Object.fromEntries(Object.entries(STEP_RULES).map(([k, v]) => [k, v.label]))).toEqual(m.STEP_WORDS);
  });

  it("is null without steps and for a limit reply", () => {
    expect(m.planOf(reply(), "user")).toBeNull();
    expect(m.planOf(planned([step()], { limit: { code: "changes-state" } }), "user")).toBeNull();
    expect(m.replyLayout(reply(), "user").plan).toBeNull();
    expect(m.replyLayout(planned([step()]), "user").plan.steps).toHaveLength(1);
  });

  it("marks danger for a high-impact step and for one that would be, and counts them", () => {
    const p = m.planOf(planned([step(), step({ kind: "high-impact" }), { kind: "check", title: "Check first", wouldBe: "high-impact", proposal: "Delete it" }, { kind: "check", title: "Check first", wouldBe: "reversible", proposal: "Copy it" }]), "user");
    expect(p.steps.map((s: any) => s.danger)).toEqual([false, true, true, false]);
    expect(p.highImpact).toBe(2);
    expect(p.header).toBe("4 steps, 2 are high-impact changes. Nothing is done until you do it.");
    expect(p.steps[2]).toMatchObject({ wouldBeLabel: "Would be a high-impact change", proposal: "Delete it" });
    expect(p.steps[3]).toMatchObject({ wouldBeLabel: "Would be a change" });
    expect(p.steps[0].label).toBe("Reversible change");
  });

  it("makes the first step that is not marked the current one, and says that a mark is not a check", () => {
    const p = m.planOf(planned([step(), step(), step()]), "user", [0, 2]);
    expect(p.steps.map((s: any) => s.current)).toEqual([false, true, false]);
    expect(p.steps.map((s: any) => s.note)).toEqual(["You marked this. Ask SCF has not checked the result.", "", "You marked this. Ask SCF has not checked the result."]);
    expect(m.planOf(planned([step()]), "user", [0]).steps[0].current).toBe(false);
  });

  it("links only to a page of the role", () => {
    const p = m.planOf(planned([step({ to: "#/runs" }), step({ to: "#/settings" }), step({ to: "https://evil.example" })]), "user");
    expect(p.steps.map((s: any) => s.link?.href ?? null)).toEqual(["#/runs", null, null]);
  });

  it("keeps the marks of a message under a key that holds only its id", () => {
    expect(m.planKey("a1")).toBe("scf-ask-plan-a1");
    expect(m.planKey("a/../1")).toBe("scf-ask-plan-a1");
  });

  it("passes the marks of each message on to its layout", () => {
    const msg = { id: "a1", role: "assistant", status: "done", text: "", reply: planned([step(), step()]) };
    expect(m.entryOf(msg, { planDone: (id: string) => (id === "a1" ? [0] : []) }).layout.plan.steps.map((s: any) => s.done)).toEqual([true, false]);
    expect(m.entryOf(msg).layout.plan.steps.map((s: any) => s.done)).toEqual([false, false]);
  });
});
