import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ask: any;
let model: any;
beforeAll(async () => {
  restore = installFakeDom();
  ask = await import("../ui/ask.js" as string);
  model = await import("../ui/ask-model.js" as string);
});
afterAll(() => restore());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const doc = () => (globalThis as any).document;
const key = (k: string) => {
  const e = { key: k, shiftKey: false, preventDefault() {} };
  for (const fn of [...(doc().listeners.keydown ?? [])]) fn(e);
};
const walk = (root: FakeElement): FakeElement[] => root.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const byClass = (root: FakeElement, cls: string) => walk(root).filter((e) => e.classList.contains(cls));
const modalRoot = () => doc().getElementById("modal-root") as FakeElement;

const state = { id: "state-run-1", kind: "state", title: "Run r1 failed", ref: "#/runs/r1", observedAt: "2026-10-12T10:00:00.000Z" };
const action = (id = "resume-run") => ({ id, title: id === "resume-run" ? "Resume the run" : "Cancel the run", impact: "The run changes.", source: "state-run-1", about: { kind: "run", id: "r1" } });
const reply = (actions: any[]) => ({ type: "status", summary: "It failed.", explanation: "", certainty: "confirmed", evidence: [state], recommendations: [], links: [], drafts: [], actions, offers: [] });
const q = { id: "q1", role: "user", status: "done", text: "Why?" };
const a = (over: any = {}) => ({ id: "a1", role: "assistant", status: "done", text: "", replyTo: "q1", tries: 1, reply: reply([action()]), ...over });
const conv = (messages: any[]) => ({ id: "c1", state: "active", title: "t", messages });
const outcome = (over: any = {}) => ({ action: "resume-run", about: { kind: "run", id: "r1" }, result: "done", words: "The run goes on.", recovery: "Watch it on its page.", at: "2026-10-12T10:05:00.000Z", ...over });
const preview = (over: any = {}) => ({ action: "resume-run", title: "Resume the run", about: { kind: "run", id: "r1" }, now: "It failed.", changes: "It is started again.", impact: "The run goes on.", impactLevel: "reversible", undo: "Stop it.", undoable: true, who: "The owner.", ...over });
const refused = (status: number, message = "x") => Object.assign(new Error(message), { status });

const open: any[] = [];
async function shown(over: any = {}) {
  const slot = new FakeElement("span");
  const host = new FakeElement("body");
  const win = { addEventListener() {}, removeEventListener() {} };
  const api = {
    helpConversations: vi.fn(async () => ({ enabled: true, conversations: [] })),
    helpConversation: vi.fn(async () => conv([q, a()])),
    prepareHelpAction: vi.fn(async () => ({ token: "t1", expiresAt: "x", preview: preview() })),
    confirmHelpAction: vi.fn(async () => ({ outcome: outcome(), stored: true })),
    cancelHelpAction: vi.fn(async () => ({ cancelled: true })),
    askHelp: vi.fn(async () => conv([q, a(), { ...q, id: "q2", text: "More?" }, { id: "a2", role: "assistant", status: "pending", text: "", replyTo: "q2", tries: 1 }])),
    ...over.api,
  };
  const review = vi.fn(async () => true);
  const d = ask.createAsk("user", { slot, host, win, api, hash: () => "#/runs", confirmer: async () => true, review, ...over.deps });
  open.push(d);
  d.open();
  await d.openConversation("c1");
  return { d, api, review };
}
afterEach(() => { for (const d of open.splice(0)) d.stop(); modalRoot().replaceChildren(); });

describe("reviewing a change in the drawer", () => {
  it("shows the button and the note on a bound action, and no button otherwise", async () => {
    const { d } = await shown();
    const buttons = walk(d.ui.thread).filter((e) => e.attrs["data-act"] !== undefined);
    expect(buttons.map((b) => [b.attrs["data-act"], b.textContent])).toEqual([["0", "Review the change"]]);
    expect(d.ui.thread.textContent).toContain("Nothing happens until you review the change and confirm it.");
    const plain = await shown({ api: { helpConversation: vi.fn(async () => conv([q, a({ reply: reply([{ id: "x", title: "Other", impact: "i" }]) })])) } });
    expect(walk(plain.d.ui.thread).filter((e) => e.attrs["data-act"] !== undefined)).toEqual([]);
  });

  it("no longer says that it changes nothing", async () => {
    const { d } = await shown();
    expect(d.ui.drawer.textContent).not.toContain("It changes nothing");
    expect(d.ui.drawer.textContent).toContain("Nothing changes unless you review and confirm an action");
  });

  it("drops the token on Cancel, changes nothing and gives the controls back", async () => {
    const { d, api, review } = await shown({ deps: { review: vi.fn(async () => false) } });
    void review;
    expect(await d.reviewAction("a1", 0)).toBe(false);
    expect(api.prepareHelpAction).toHaveBeenCalledWith("c1", { message: "a1", index: 0 });
    expect(api.cancelHelpAction).toHaveBeenCalledWith("c1", "t1");
    expect(api.confirmHelpAction).not.toHaveBeenCalled();
    expect(d.ui.status.textContent).toBe("Nothing was changed.");
    expect(d.state.busy).toBe(false);
    expect(d.ui.send.attrs["aria-disabled"]).toBeUndefined();
    expect(walk(d.ui.actions).length).toBeGreaterThan(0);
  });

  it("hands six rows to the dialog, and a danger flag only for high impact", async () => {
    const { d, review } = await shown();
    await d.reviewAction("a1", 0);
    const arg = (review.mock.calls[0] as any[])[0];
    expect(arg.rows).toHaveLength(6);
    expect(arg.danger).toBe(false);
    const high = await shown({ api: { prepareHelpAction: vi.fn(async () => ({ token: "t2", preview: preview({ impactLevel: "high" }) })) } });
    await high.d.reviewAction("a1", 0);
    expect(((high.review.mock.calls[0] as any[])[0]).danger).toBe(true);
  });

  it("confirms, draws the outcome and says it", async () => {
    const stored = conv([q, a({ outcomes: [outcome()] })]);
    const { d, api } = await shown();
    api.helpConversation.mockResolvedValueOnce(stored as any);
    expect(await d.reviewAction("a1", 0)).toBe(true);
    expect(api.confirmHelpAction).toHaveBeenCalledWith("c1", { token: "t1", message: "a1", index: 0 });
    const cards = byClass(d.ui.thread, "ask-card-outcome");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Done");
    expect(cards[0]!.textContent).toContain("The run goes on.");
    expect(cards[0]!.textContent).toContain("Watch it on its page.");
    expect(d.ui.status.textContent).toMatch(/^Done\./);
  });

  it("still shows the outcome when it was not stored, or the read fails", async () => {
    for (const fail of [false, true]) {
      const { d, api } = await shown();
      api.confirmHelpAction.mockResolvedValueOnce({ outcome: outcome({ result: "queued" }), stored: false } as any);
      if (fail) api.helpConversation.mockRejectedValueOnce(refused(500));
      await d.reviewAction("a1", 0);
      expect(byClass(d.ui.thread, "ask-card-outcome")).toHaveLength(1);
      expect(d.ui.status.textContent).toContain(model.NOT_STORED_NOTE);
      expect(d.ui.status.textContent).toMatch(/^Queued\./);
    }
  });

  it("draws the words of the server as text", async () => {
    const { d, api } = await shown();
    api.confirmHelpAction.mockResolvedValueOnce({ outcome: outcome({ words: "<img src=x>", recovery: "<b>x</b>" }), stored: true } as any);
    await d.reviewAction("a1", 0);
    expect(walk(d.ui.thread).filter((e) => e.tag === "img")).toEqual([]);
    expect(byClass(d.ui.thread, "ask-card-outcome")[0]!.textContent).toContain("<img src=x>");
  });

  it("ignores a preview that comes after the person left, and drops its token", async () => {
    let release: (v: any) => void = () => {};
    const { d, api, review } = await shown({ api: { prepareHelpAction: vi.fn(() => new Promise((r) => { release = r; })) } });
    const run = d.reviewAction("a1", 0);
    d.fresh();
    release({ token: "late", preview: preview() });
    expect(await run).toBe(false);
    expect(review).not.toHaveBeenCalled();
    expect(api.cancelHelpAction).toHaveBeenCalledWith("c1", "late");
  });

  it("ignores a confirm that comes after the person opened another conversation", async () => {
    let release: (v: any) => void = () => {};
    const { d, api } = await shown({ api: { confirmHelpAction: vi.fn(() => new Promise((r) => { release = r; })) } });
    const run = d.reviewAction("a1", 0);
    await vi.waitFor(() => expect(api.confirmHelpAction).toHaveBeenCalled());
    api.helpConversation.mockResolvedValueOnce({ id: "c2", state: "active", title: "o", messages: [q, a()] } as any);
    await d.openConversation("c2");
    release({ outcome: outcome(), stored: true });
    expect(await run).toBe(false);
    expect(byClass(d.ui.thread, "ask-card-outcome")).toEqual([]);
    expect(d.ui.status.textContent).toBe("The conversation is open.");
  });

  it("does not let a late read hide a question sent meanwhile", async () => {
    let release: (v: any) => void = () => {};
    const { d, api } = await shown();
    api.helpConversation.mockImplementationOnce(() => new Promise((r) => { release = r; }) as any);
    const run = d.reviewAction("a1", 0);
    await vi.waitFor(() => expect(api.confirmHelpAction).toHaveBeenCalled());
    await vi.waitFor(() => expect(api.helpConversation).toHaveBeenCalledTimes(2));
    d.ui.question.value = "More?";
    await d.send();
    expect(d.state.conversation.messages).toHaveLength(4);
    release(conv([q, a({ outcomes: [outcome()] })]));
    await run;
    expect(d.state.conversation.messages).toHaveLength(4);
    expect(byClass(d.ui.thread, "ask-card-outcome")).toHaveLength(1);
  });

  it("forgets an unsaved outcome when the person goes to another conversation and back", async () => {
    const { d, api } = await shown();
    api.confirmHelpAction.mockResolvedValueOnce({ outcome: outcome(), stored: false } as any);
    await d.reviewAction("a1", 0);
    expect(byClass(d.ui.thread, "ask-card-outcome")).toHaveLength(1);
    api.helpConversation.mockResolvedValueOnce({ id: "c2", state: "active", title: "o", messages: [q] } as any);
    await d.openConversation("c2");
    await d.openConversation("c1");
    expect(byClass(d.ui.thread, "ask-card-outcome")).toEqual([]);
  });

  it("shows a 409 under the question box and draws no outcome", async () => {
    const text = "this confirmation does not work: it was used, has expired or was dropped; ask for a new preview";
    const { d } = await shown({ api: { confirmHelpAction: vi.fn(async () => { throw refused(409, text); }) } });
    expect(await d.reviewAction("a1", 0)).toBe(false);
    expect(d.ui.error.textContent).toBe(`This ${text.slice(5)}.`);
    expect(byClass(d.ui.thread, "ask-card-outcome")).toEqual([]);
  });

  it("says the action sentence for a 404 of prepare, and never opens the dialog", async () => {
    const { d, review } = await shown({ api: { prepareHelpAction: vi.fn(async () => { throw refused(404); }) } });
    expect(await d.reviewAction("a1", 0)).toBe(false);
    expect(d.ui.error.textContent).toBe("This run or this answer is not there any more, or you can no longer change it.");
    expect(review).not.toHaveBeenCalled();
  });

  it("sends one prepare call for two presses", async () => {
    let release: (v: any) => void = () => {};
    const { d, api } = await shown({ api: { prepareHelpAction: vi.fn(() => new Promise((r) => { release = r; })) } });
    const first = d.reviewAction("a1", 0);
    expect(await d.reviewAction("a1", 0)).toBe(false);
    release({ token: "t1", preview: preview() });
    await first;
    expect(api.prepareHelpAction).toHaveBeenCalledTimes(1);
  });
});

describe("the real review dialog", () => {
  async function pending(over: any = {}) {
    const made = await shown({ ...over, deps: { review: undefined } });
    const run = made.d.reviewAction("a1", 0);
    await vi.waitFor(() => expect(modalRoot().children.length).toBe(1));
    return { ...made, run };
  }
  const confirmButton = () => walk(modalRoot()).find((e) => e.tag === "button" && /Confirm the change/.test(e.textContent))!;

  it("shows six rows and a primary confirm for a reversible change", async () => {
    const { run } = await pending();
    const rows = walk(modalRoot()).filter((e) => e.tag === "strong").map((e) => e.textContent);
    expect(rows).toEqual(["Action: ", "Now: ", "What changes: ", "Impact: ", "Undo: ", "Who may do this: "]);
    expect(confirmButton().classList.contains("primary")).toBe(true);
    key("Escape");
    await run;
  });

  it("makes the confirm button a danger button for high impact", async () => {
    const { run } = await pending({ api: { prepareHelpAction: vi.fn(async () => ({ token: "t1", preview: preview({ impactLevel: "high" }) })) } });
    expect(confirmButton().classList.contains("danger")).toBe(true);
    key("Escape");
    await run;
  });

  it("cancels on Escape and keeps the drawer open", async () => {
    const { d, api, run } = await pending();
    key("Escape");
    expect(await run).toBe(false);
    expect(api.cancelHelpAction).toHaveBeenCalledWith("c1", "t1");
    expect(api.confirmHelpAction).not.toHaveBeenCalled();
    expect(d.state.open).toBe(true);
    expect(modalRoot().children.length).toBe(0);
  });

  it("confirms with the button", async () => {
    const { api, run } = await pending();
    confirmButton().click();
    expect(await run).toBe(true);
    expect(api.confirmHelpAction).toHaveBeenCalled();
  });
});
