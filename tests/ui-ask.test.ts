import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { parseCss, readUiCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ask: any;
beforeAll(async () => {
  restore = installFakeDom();
  ask = await import("../ui/ask.js" as string);
});
afterAll(() => restore());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const doc = () => (globalThis as any).document;
const key = (k: string, over: any = {}) => {
  const e = { key: k, shiftKey: false, prevented: false, preventDefault() { this.prevented = true; }, ...over };
  for (const fn of [...(doc().listeners.keydown ?? [])]) fn(e);
  return e;
};
const walk = (root: FakeElement): FakeElement[] => root.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const texts = (root: FakeElement, cls: string) => walk(root).filter((e) => e.classList.contains(cls)).map((e) => e.textContent);

const q = (text: string, id = "q1") => ({ id, role: "user", status: "done", text });
const a = (status: string, over: any = {}) => ({ id: "a1", role: "assistant", status, text: "", replyTo: "q1", tries: 1, ...over });
const conv = (messages: any[], over: any = {}) => ({ id: "c1", state: "active", title: "t", messages, ...over });

const open: any[] = [];
function make(over: any = {}) {
  const slot = new FakeElement("span");
  slot.hidden = true;
  const host = new FakeElement("body");
  const win = { listeners: {} as Record<string, any[]>, addEventListener(t: string, fn: any) { (this.listeners[t] ??= []).push(fn); }, removeEventListener(t: string, fn: any) { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== fn); } };
  const api = {
    helpConversations: vi.fn(async () => ({ enabled: true, conversations: [] })),
    helpConversation: vi.fn(async () => conv([q("Why?"), a("done", { text: "Because." })])),
    askHelp: vi.fn(async (_id: any, body: any) => conv([q(body.question), a("pending")])),
    ...over.api,
  };
  let hash = over.hash ?? "#/runs";
  const d = ask.createAsk(over.role ?? "user", { slot, host, win, api, hash: () => hash, confirmer: async () => true, ...over.deps });
  open.push(d);
  return { d, slot, host, win, api, setHash: (h: string) => { hash = h; for (const fn of win.listeners.hashchange ?? []) fn(); } };
}
afterEach(() => { for (const d of open.splice(0)) d.stop(); doc().getElementById("modal-root").replaceChildren(); doc().body.classList.remove("drawer-open"); });

describe("switched off", () => {
  it("offers nothing when Ask SCF is off, and nothing when the answer does not come", async () => {
    const slot = doc().getElementById("ask-scf");
    slot.hidden = true;
    expect(await ask.initAsk("user", { api: { helpConversations: async () => ({ enabled: false, conversations: [] }) }, host: new FakeElement("body"), win: {} })).toBeNull();
    expect(await ask.initAsk("user", { api: { helpConversations: async () => { throw Object.assign(new Error("no"), { status: 403 }); } }, host: new FakeElement("body"), win: {} })).toBeNull();
    expect(await ask.initAsk("user", { api: { helpConversations: async () => ({}) }, host: new FakeElement("body"), win: {} })).toBeNull();
    expect(slot.hidden).toBe(true);
    expect(slot.children).toEqual([]);
  });

  it("puts the button in the top bar when it is on, and takes it away again", async () => {
    const slot = doc().getElementById("ask-scf");
    const host = new FakeElement("body");
    const d = await ask.initAsk("admin", { api: { helpConversations: async () => ({ enabled: true, conversations: [] }) }, host, win: {} });
    expect(slot.hidden).toBe(false);
    expect((slot.children[0] as FakeElement).textContent).toBe("Ask SCF");
    expect(host.children).toHaveLength(2);
    d.stop();
    expect(slot.hidden).toBe(true);
    expect(host.children).toEqual([]);
  });
});

describe("both displays use the one drawer", () => {
  it("is mounted by ui/app.js and ui/user/app.js, and built nowhere else", () => {
    const admin = readFileSync("ui/app.js", "utf8");
    const user = readFileSync("ui/user/app.js", "utf8");
    expect(admin).toContain('import { initAsk } from "./ask.js";');
    expect(admin).toContain('void initAsk("admin");');
    expect(user).toContain('import { initAsk } from "/ask.js";');
    // never in a preview of another person's display: the server shows no conversations there
    expect(user).toContain('if (view.ready && !view.readOnly) void initAsk("user");');
    for (const src of [admin, user]) expect(src).not.toMatch(/ask-drawer|askFrame|createAsk/);
    for (const html of ["ui/index.html", "ui/user/index.html"]) expect(readFileSync(html, "utf8"), html).toContain('<span id="ask-scf" class="ask-scf" hidden></span>');
  });

  it("works the same for both roles", () => {
    for (const role of ["admin", "user"]) {
      const { d, slot } = make({ role });
      expect(slot.hidden).toBe(false);
      d.open();
      expect(d.ui.drawer.hidden).toBe(false);
    }
  });
});

describe("names for a screen reader", () => {
  it("names the button, the dialog and every control in it", () => {
    const { d } = make();
    expect(d.button.attrs).toMatchObject({ type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "ask-drawer" });
    expect(d.button.textContent).toBe("Ask SCF");
    expect(d.ui.drawer.attrs).toMatchObject({ id: "ask-drawer", role: "dialog", "aria-modal": "true", "aria-labelledby": "ask-title" });
    const all = walk(d.ui.drawer);
    expect(all.find((e) => e.attrs.id === "ask-title")!.textContent).toBe("Ask SCF");
    expect(d.ui.close.attrs["aria-label"]).toBe("Close Ask SCF");
    const labels = all.filter((e) => e.tag === "label");
    expect(labels.map((l) => l.attrs.for)).toEqual(["ask-question", "ask-attach"]);
    expect(labels[0]!.textContent).toBe("Your question");
    expect(labels[1]!.textContent.trim()).toBe("Send the page I am on with my question");
    expect(d.ui.question.attrs).toMatchObject({ id: "ask-question", maxlength: "4000", "aria-describedby": "ask-context ask-error" });
    expect(d.ui.status.attrs).toMatchObject({ role: "status", "aria-live": "polite" });
    expect(d.ui.error.attrs.role).toBe("alert");
    d.open();
    // every button has text or a label
    for (const b of walk(d.ui.drawer).filter((e) => e.tag === "button")) expect(b.attrs["aria-label"] ?? b.textContent, b.attrs.class).toMatch(/\S/);
  });
});

describe("opening and closing", () => {
  it("opens without any call and without sending the page", () => {
    const { d, api } = make();
    d.button.click();
    expect(d.state.open).toBe(true);
    expect(d.ui.drawer.hidden).toBe(false);
    expect(d.ui.scrim.hidden).toBe(false);
    expect(d.button.attrs["aria-expanded"]).toBe("true");
    expect(api.askHelp).not.toHaveBeenCalled();
    expect(api.helpConversation).not.toHaveBeenCalled();
    expect(api.helpConversations).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes the focus into the question box and gives it back to where it was", () => {
    const { d } = make();
    const field = new FakeElement("input");
    field.focus();
    d.open();
    expect(doc().activeElement).toBe(d.ui.question);
    key("Escape");
    expect(d.state.open).toBe(false);
    expect(d.ui.drawer.hidden).toBe(true);
    expect(d.ui.scrim.hidden).toBe(true);
    expect(doc().activeElement).toBe(field);
    expect(d.button.attrs["aria-expanded"]).toBe("false");
  });

  it("gives the focus to the button when the old control is gone, and closes on the ✕ and the backdrop", () => {
    const { d } = make();
    const gone = new FakeElement("button");
    (gone as any).isConnected = false;
    gone.focus();
    d.open();
    d.ui.close.click();
    expect(doc().activeElement).toBe(d.button);
    d.button.click();
    expect(d.state.open).toBe(true);
    d.ui.scrim.fire("mousedown");
    expect(d.state.open).toBe(false);
    // the button closes an open drawer too
    d.open();
    d.button.click();
    expect(d.state.open).toBe(false);
  });

  it("keeps Tab inside the drawer, both ways", () => {
    const { d } = make();
    d.open();
    const stops = walk(d.ui.drawer).filter((e) => ["button", "textarea", "input"].includes(e.tag));
    const first = stops[0]!;
    const last = d.ui.send;
    expect(first).toBe(d.ui.fresh);
    // the list of conversations is not shown: its controls are no Tab stops
    expect(stops.at(-1)).toBe(d.ui.archivedBtn);
    last.focus();
    expect(key("Tab").prevented).toBe(true);
    expect(doc().activeElement).toBe(first);
    expect(key("Tab", { shiftKey: true }).prevented).toBe(true);
    expect(doc().activeElement).toBe(last);
    // in the middle the browser moves the focus itself
    d.ui.question.focus();
    expect(key("Tab").prevented).toBe(false);
    // a focus that got out comes back in
    new FakeElement("a").focus();
    key("Tab");
    expect(doc().activeElement).toBe(first);
  });

  it("makes the page behind inert while open and leaves the menu's own lock alone", () => {
    const { d } = make();
    const behind = ["top", "skip", "content"].map((id) => doc().getElementById(id));
    d.open();
    for (const b of behind) expect("inert" in b.attrs).toBe(true);
    d.close();
    for (const b of behind) expect("inert" in b.attrs).toBe(false);
    d.open();
    doc().body.classList.add("drawer-open");
    d.close();
    for (const b of behind) expect("inert" in b.attrs).toBe(true);
    for (const b of behind) b.removeAttribute("inert");
  });

  it("leaves the keys to a dialog that lies over it, and ignores them when closed", () => {
    const { d } = make();
    expect(key("Escape").prevented).toBe(false);
    d.open();
    doc().getElementById("modal-root").append(new FakeElement("div"));
    key("Escape");
    expect(d.state.open).toBe(true);
    d.ui.send.focus();
    expect(key("Tab").prevented).toBe(false);
  });

  it("does not touch the page: what was typed there and in the question box stays", () => {
    const { d } = make();
    const main = doc().getElementById("main");
    const typed = new FakeElement("input");
    typed.value = "half a sentence";
    main.replaceChildren(typed);
    d.open();
    d.ui.question.value = "My half question";
    d.close();
    d.open();
    expect(main.children).toEqual([typed]);
    expect(typed.value).toBe("half a sentence");
    expect(d.ui.question.value).toBe("My half question");
    main.replaceChildren();
  });
});

describe("the question", () => {
  it("shows what is attached before Send, follows the checkbox and the page behind", () => {
    const { d, setHash } = make({ hash: "#/runs/r-1?repo=a%2Fb" });
    d.open();
    expect(d.ui.context.textContent).toBe("Sent with your question: the page you are on (Run r-1, #/runs/r-1). Nothing else of the page is sent.");
    d.ui.attach.fire("change", { target: { checked: false } });
    expect(d.ui.context.textContent).toBe("Nothing about this page is sent with your question.");
    d.ui.attach.fire("change", { target: { checked: true } });
    setHash("#/repos");
    expect(d.ui.context.textContent).toContain("#/repos");
    expect(walk(d.ui.suggest)[0]!.textContent).toBe("How do I connect a repository?");
  });

  it("a suggestion fills the box and sends nothing", () => {
    const { d, api } = make();
    d.open();
    const first = walk(d.ui.suggest)[0]!;
    expect(first.textContent).toBe("What do the statuses of a run mean?");
    first.click();
    expect(d.ui.question.value).toBe("What do the statuses of a run mean?");
    expect(doc().activeElement).toBe(d.ui.question);
    expect(api.askHelp).not.toHaveBeenCalled();
  });

  it("sends the question with the page that was shown, once", async () => {
    const { d, api } = make();
    d.open();
    d.ui.question.value = " Why does it wait? ";
    const form = walk(d.ui.drawer).find((e) => e.tag === "form")!;
    form.fire("submit", { preventDefault() {} });
    form.fire("submit", { preventDefault() {} });
    expect(d.ui.send.attrs["aria-disabled"]).toBe("true");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.askHelp).toHaveBeenCalledTimes(1);
    expect(api.askHelp).toHaveBeenCalledWith(null, { question: "Why does it wait?", context: { page: "#/runs" } });
    expect(d.ui.question.value).toBe("");
    expect(texts(d.ui.thread, "ask-entry")).toEqual(["YouWhy does it wait?", "Ask SCF Ask SCF is working on your answer."]);
    expect(d.ui.status.textContent).toBe("Ask SCF is working on your answer.");
    // while the answer is written, Send says why it does nothing
    d.ui.question.value = "And now?";
    expect(await d.send()).toBe(false);
    expect(d.ui.error.textContent).toBe("Ask SCF is still answering. Wait for the answer first.");
    expect(api.askHelp).toHaveBeenCalledTimes(1);
  });

  it("sends no page when the box is off, and sends on Ctrl+Enter", async () => {
    const { d, api } = make();
    d.open();
    d.ui.attach.fire("change", { target: { checked: false } });
    d.ui.question.value = "Why?";
    const plain = { key: "Enter", ctrlKey: false, metaKey: false, preventDefault: vi.fn() };
    d.ui.question.fire("keydown", plain);
    expect(plain.preventDefault).not.toHaveBeenCalled();
    d.ui.question.fire("keydown", { key: "Enter", ctrlKey: true, preventDefault() {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.askHelp).toHaveBeenCalledWith(null, { question: "Why?" });
  });

  it("says why an empty question is not sent and keeps the focus in the box", async () => {
    const { d, api } = make();
    d.open();
    d.ui.send.focus();
    expect(await d.send()).toBe(false);
    expect(d.ui.error.textContent).toBe("Type your question first.");
    expect(doc().activeElement).toBe(d.ui.question);
    expect(api.askHelp).not.toHaveBeenCalled();
  });

  it("keeps the typed question when the server refuses it, and says why", async () => {
    const { d } = make({ api: { askHelp: vi.fn(async () => { throw Object.assign(new Error("Ask SCF is switched off on this Foundry. An administrator can switch it on."), { status: 503 }); }) } });
    d.open();
    d.ui.question.value = "Why?";
    expect(await d.send()).toBe(false);
    expect(d.ui.question.value).toBe("Why?");
    expect(d.ui.error.textContent).toBe("Ask SCF is switched off on this Foundry. An administrator can switch it on.");
    expect(d.ui.send.attrs["aria-disabled"]).toBeUndefined();
    expect(d.state.busy).toBe(false);
  });
});

describe("the answer", () => {
  it("is read until it is there, announced once, and put in as text", async () => {
    const reads = [conv([q("Why?"), a("pending")]), conv([q("Why?"), a("done", { text: "<img src=x onerror=alert(1)> Because." })])];
    const { d, api } = make({ api: { helpConversation: vi.fn(async () => reads.shift()) } });
    d.open();
    d.ui.question.value = "Why?";
    await d.send();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.helpConversation).toHaveBeenCalledTimes(1);
    expect(api.helpConversation).toHaveBeenCalledWith("c1");
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.helpConversation).toHaveBeenCalledTimes(2);
    expect(d.ui.status.textContent).toBe("Ask SCF answered. The answer is below your question.");
    const answer = walk(d.ui.thread).filter((e) => e.classList.contains("ask-answer"))[0]!;
    expect(answer.children.filter((c) => typeof c === "string").at(-1)).toBe("<img src=x onerror=alert(1)> Because.");
    expect(walk(d.ui.thread).some((e) => e.tag === "img")).toBe(false);
    // nothing is read after the answer
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.helpConversation).toHaveBeenCalledTimes(2);
    expect(d.ui.send.attrs["aria-disabled"]).toBeUndefined();
  });

  it("stops reading while the drawer is closed and reads once when it opens again", async () => {
    const { d, api } = make({ api: { helpConversation: vi.fn(async () => conv([q("Why?"), a("pending")])) } });
    d.open();
    d.ui.question.value = "Why?";
    await d.send();
    d.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.helpConversation).not.toHaveBeenCalled();
    d.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.helpConversation).toHaveBeenCalledTimes(1);
    expect(api.askHelp).toHaveBeenCalledTimes(1);
  });

  it("shows a failure in the server's fixed words", async () => {
    const { d } = make({ api: { helpConversation: vi.fn(async () => conv([q("Why?"), a("failed", { text: "The AI service did not answer. You can try again in a moment.", failure: { code: "provider", retry: true } })], { state: "failed" })) } });
    d.open();
    d.ui.question.value = "Why?";
    await d.send();
    await vi.advanceTimersByTimeAsync(1500);
    expect(d.ui.status.textContent).toBe("The AI service did not answer. You can try again in a moment.");
    expect(texts(d.ui.thread, "ask-failed")).toEqual(["Ask SCFThe AI service did not answer. You can try again in a moment."]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives up reading after four failures in a row and says so", async () => {
    const { d, api } = make({ api: { helpConversation: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) } });
    d.open();
    d.ui.question.value = "Why?";
    await d.send();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.helpConversation).toHaveBeenCalledTimes(4);
    expect(d.ui.error.textContent).toBe("The Foundry could not be reached. Check your connection, then try again.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops at once when the conversation is gone", async () => {
    const { d, api } = make({ api: { helpConversation: vi.fn(async () => { throw Object.assign(new Error("gone"), { status: 410 }); }) } });
    d.open();
    d.ui.question.value = "Why?";
    await d.send();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.helpConversation).toHaveBeenCalledTimes(1);
    expect(d.ui.error.textContent).toBe("This conversation is gone. Ask your question in a new one.");
  });
});

// ---- #235: history, progress, stop, retry and coming back -------------------------------------------

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";
const failed = (code: string, retry: boolean, text: string, tries = 1) => conv([q("Why?"), a("failed", { text, failure: { code, retry }, tries })], { state: "failed" });
const PROVIDER = "The AI service did not answer. You can try again in a moment.";
const LIMIT = "The limit for Ask SCF is reached for today. Try again tomorrow, or ask an administrator.";
const row = (id: string, over: any = {}) => ({ id, title: `Title ${id.slice(0, 2)}`, state: "active", messages: 2, waiting: false, updated: "2026-01-01T00:00:00.000Z", ...over });
const actions = (d: any) => walk(d.ui.actions).filter((e) => e.tag === "button").map((e) => e.textContent);
const press = (d: any, label: string) => walk(d.ui.actions).find((e) => e.tag === "button" && e.textContent === label)!.click();
/** A promise the test settles itself: an answer that is still on its way. */
function later<T>() {
  let done!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { done = res; fail = rej; });
  return { promise, done, fail };
}
async function asked(over: any = {}) {
  const made = make(over);
  made.d.open();
  made.d.ui.question.value = "Why?";
  await made.d.send();
  return made;
}

describe("a turn from question to answer", () => {
  it("success: question, progress, answer, and then the next question in the same conversation", async () => {
    const { d, api } = await asked();
    expect(actions(d)).toEqual(["Stop", "Delete"]);
    expect(d.ui.suggestBox.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(texts(d.ui.thread, "ask-answer")).toEqual(["Ask SCFBecause.Continue on another page"]);
    expect(actions(d)).toEqual(["This solved my problem", "Archive", "Delete"]);
    d.ui.question.value = "And then?";
    await d.send();
    expect(api.askHelp).toHaveBeenLastCalledWith("c1", { question: "And then?", context: { page: "#/runs" } });
  });

  it("slow progress: says once that it takes long and points at Stop", async () => {
    let t = 1_000_000;
    const { d } = await asked({ deps: { now: () => t }, api: { helpConversation: vi.fn(async () => conv([q("Why?"), a("pending")])) } });
    expect(texts(d.ui.thread, "ask-waiting")[0]).toContain("Ask SCF is working on your answer.");
    t += 19_000;
    await vi.advanceTimersByTimeAsync(1500);
    expect(d.ui.status.textContent).toBe("Ask SCF is working on your answer.");
    t += 2_000;
    await vi.advanceTimersByTimeAsync(1500);
    const slow = "Ask SCF is still working. This takes longer than usual. You can wait, or stop the answer.";
    expect(d.ui.status.textContent).toBe(slow);
    expect(texts(d.ui.thread, "ask-waiting")[0]).toContain(slow);
    d.ui.status.textContent = "";
    await vi.advanceTimersByTimeAsync(1500);
    expect(d.ui.status.textContent).toBe("");
    expect(actions(d)).toContain("Stop");
  });

  it("stop: one call, the fixed sentence, and Try again is offered", async () => {
    const stopped = conv([q("Why?"), a("cancelled", { text: "You stopped this answer. You can ask again." })], { state: "cancelled" });
    const { d, api } = await asked({ api: { cancelHelp: vi.fn(async () => stopped) } });
    press(d, "Stop");
    // a second press while the first is on its way does nothing
    expect(actions(d)).toEqual([]);
    expect(await d.stopAnswer()).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.cancelHelp).toHaveBeenCalledTimes(1);
    expect(api.cancelHelp).toHaveBeenCalledWith("c1");
    expect(texts(d.ui.thread, "ask-stopped")).toEqual(["Ask SCFYou stopped this answer. You can ask again."]);
    expect(d.ui.status.textContent).toBe("You stopped this answer. You can ask again.");
    expect(actions(d)).toEqual(["Try again", "Archive", "Delete"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(doc().activeElement).toBe(d.ui.question);
  });

  it("provider failure: the fixed sentence and Try again", async () => {
    const { d } = await asked({ api: { helpConversation: vi.fn(async () => failed("provider", true, PROVIDER)) } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(texts(d.ui.thread, "ask-failed")).toEqual([`Ask SCF${PROVIDER}`]);
    expect(d.ui.status.textContent).toBe(PROVIDER);
    expect(actions(d)).toEqual(["Try again", "Archive", "Delete"]);
  });

  it("limit: the fixed sentence and no Try again, for a reply and for a refused question", async () => {
    const { d } = await asked({ api: { helpConversation: vi.fn(async () => failed("limit", false, LIMIT)) } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(texts(d.ui.thread, "ask-limit")).toEqual([`Ask SCF${LIMIT}`]);
    expect(actions(d)).toEqual(["Archive", "Delete"]);
    expect(await d.retry()).toBe(false);
    const words = "You have used all your questions to Ask SCF for today. Try again tomorrow, or ask an administrator.";
    const refused = make({ api: { askHelp: vi.fn(async () => { throw Object.assign(new Error(words), { status: 429 }); }) } });
    refused.d.open();
    refused.d.ui.question.value = "Why?";
    expect(await refused.d.send()).toBe(false);
    expect(refused.d.ui.error.textContent).toBe(words);
    expect(refused.d.ui.question.value).toBe("Why?");
    expect(refused.d.state.conversation).toBeNull();
  });

  it("retry: one call however often it is pressed, the same two messages, and the earlier try is named", async () => {
    const again = later<any>();
    const { d, api } = await asked({ api: { helpConversation: vi.fn(async () => failed("provider", true, PROVIDER)), retryHelp: vi.fn(() => again.promise) } });
    await vi.advanceTimersByTimeAsync(1500);
    press(d, "Try again");
    expect(await d.retry()).toBe(false);
    expect(await d.retry()).toBe(false);
    expect(actions(d)).toEqual([]);
    again.done(conv([q("Why?"), a("pending", { tries: 2 })]));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.retryHelp).toHaveBeenCalledTimes(1);
    expect(api.retryHelp).toHaveBeenCalledWith("c1");
    expect(api.askHelp).toHaveBeenCalledTimes(1);
    expect(texts(d.ui.thread, "ask-entry")).toHaveLength(2);
    expect(texts(d.ui.thread, "ask-note")).toEqual(["This is the second try. The first try gave no answer."]);
    expect(d.ui.status.textContent).toBe("Ask SCF is working on your answer.");
    // the reply is read again
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retry that the server refuses changes nothing on the page", async () => {
    const { d } = await asked({ api: { helpConversation: vi.fn(async () => failed("provider", true, PROVIDER)), retryHelp: vi.fn(async () => { throw Object.assign(new Error("Ask SCF is already answering this question"), { status: 409 }); }) } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await d.retry()).toBe(false);
    expect(d.ui.error.textContent).toBe("Ask SCF is already answering this question.");
    expect(texts(d.ui.thread, "ask-entry")).toHaveLength(2);
    expect(actions(d)).toEqual(["Try again", "Archive", "Delete"]);
  });

  it("says what each control does, for the eye and for a screen reader", async () => {
    const { d } = await asked();
    await vi.advanceTimersByTimeAsync(1500);
    const buttons = walk(d.ui.actions).filter((e) => e.tag === "button");
    for (const b of buttons) {
      expect(b.attrs.title, b.textContent).toMatch(/\.$/);
      const hint = walk(d.ui.actions).find((e) => e.attrs.id === b.attrs["aria-describedby"])!;
      expect(hint.textContent).toBe(b.attrs.title);
    }
    expect(d.ui.actions.attrs).toMatchObject({ role: "group", "aria-label": "This conversation" });
    expect(d.ui.fresh.attrs.title).toBe("Starts an empty conversation. This one stays in your list.");
  });
});

describe("archive and deletion", () => {
  it("archive: moves the conversation away and says where it is", async () => {
    const { d, api } = await asked({ api: { archiveHelp: vi.fn(async () => conv([], { state: "archived" })) } });
    await vi.advanceTimersByTimeAsync(1500);
    press(d, "Archive");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.archiveHelp).toHaveBeenCalledWith("c1");
    expect(d.state.conversation).toBeNull();
    expect(d.ui.thread.hidden).toBe(true);
    expect(d.ui.suggestBox.hidden).toBe(false);
    expect(d.ui.status.textContent).toBe("The conversation is in the archive. Open History and choose Show archived to take it back.");
    expect(actions(d)).toEqual([]);
  });

  it("an archived conversation can be read, taken back or deleted, and asks in a new one", async () => {
    const archived = conv([q("Why?"), a("done", { text: "Because." })], { state: "archived" });
    const { d, api } = make({ api: { helpConversation: vi.fn(async () => archived), restoreHelp: vi.fn(async () => ({ ...archived, state: "active" })) } });
    d.open();
    await d.openConversation("c1");
    expect(actions(d)).toEqual(["Take back from the archive", "Delete"]);
    d.ui.question.value = "And?";
    await d.send();
    expect(api.askHelp).toHaveBeenCalledWith(null, expect.anything());
    await d.openConversation("c1");
    await d.restore();
    expect(api.restoreHelp).toHaveBeenCalledWith("c1");
    expect(d.ui.status.textContent).toBe("The conversation is back in your list.");
    expect(actions(d)).toEqual(["This solved my problem", "Archive", "Delete"]);
  });

  it("deletion: asks first with the consequence, and does nothing on Cancel", async () => {
    const confirmer = vi.fn(async () => false);
    const { d, api } = await asked({ deps: { confirmer }, api: { deleteHelp: vi.fn(async () => ({})) } });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await d.remove()).toBe(false);
    expect(confirmer).toHaveBeenCalledWith({ title: "Delete this conversation?", text: "Removes the questions and answers of this conversation at once. They cannot be brought back. An answer that is still being written is stopped.", confirm: "Delete", danger: true });
    expect(api.deleteHelp).not.toHaveBeenCalled();
    expect(texts(d.ui.thread, "ask-entry")).toHaveLength(2);
  });

  it("deletion: removes the conversation from the drawer, also while a reply is written", async () => {
    const { d, api } = await asked({ api: { deleteHelp: vi.fn(async () => ({})), helpConversation: vi.fn(async () => conv([q("Why?"), a("pending")])) } });
    expect(await d.remove()).toBe(true);
    expect(api.deleteHelp).toHaveBeenCalledWith("c1");
    expect(d.state.conversation).toBeNull();
    expect(d.ui.status.textContent).toBe("The conversation was deleted.");
    expect(d.ui.thread.children).toEqual([]);
    // nothing of it is read any more
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.helpConversation).not.toHaveBeenCalled();
  });

  it("a deletion the server refuses leaves the conversation and says why", async () => {
    const { d } = await asked({ api: { deleteHelp: vi.fn(async () => { throw Object.assign(new Error("x"), { status: 500 }); }) } });
    expect(await d.remove()).toBe(false);
    expect(d.state.conversation.id).toBe("c1");
    expect(d.ui.error.textContent).toBe("Ask SCF is not working now. Try again later.");
  });
});

describe("history and a new conversation", () => {
  it("lists the conversations, names the open one and opens another", async () => {
    const other = conv([q("Other?", "q9"), a("done", { text: "Yes.", replyTo: "q9" })], { id: ID2 });
    const { d, api } = make({ api: { helpConversations: vi.fn(async () => ({ enabled: true, conversations: [row(ID1, { waiting: true }), row(ID2, { state: "failed" })] })), helpConversation: vi.fn(async () => other) } });
    d.open();
    d.ui.historyBtn.click();
    expect(d.ui.talk.hidden).toBe(true);
    expect(d.ui.history.hidden).toBe(false);
    expect(d.ui.historyBtn.attrs["aria-expanded"]).toBe("true");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.helpConversations).toHaveBeenCalledWith(false);
    const rows = walk(d.ui.list).filter((e) => e.tag === "button");
    expect(rows.map((r) => walk(r)[0]!.textContent)).toEqual(["Title 11", "Title 22"]);
    expect(walk(rows[0]!)[1]!.textContent).toMatch(/^Answering · /);
    expect(walk(rows[1]!)[1]!.textContent).toMatch(/^No answer · /);
    expect(d.ui.status.textContent).toBe("2 conversations.");
    rows[1]!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.helpConversation).toHaveBeenCalledWith(ID2);
    expect(d.ui.history.hidden).toBe(true);
    expect(d.ui.talk.hidden).toBe(false);
    expect(texts(d.ui.thread, "ask-entry")).toEqual(["YouOther?", "Ask SCFYes.Continue on another page"]);
    expect(d.ui.status.textContent).toBe("The conversation is open.");
    expect(doc().activeElement).toBe(d.ui.question);
    // the open one is marked in the list
    d.ui.historyBtn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(walk(d.ui.list).filter((e) => e.tag === "button").map((r) => r.attrs["aria-current"])).toEqual([undefined, "true"]);
  });

  it("shows the archived ones on request, and a sentence when there is none", async () => {
    const { d, api } = make({ api: { helpConversations: vi.fn(async (archived: boolean) => ({ enabled: true, conversations: archived ? [] : [row(ID1)] })) } });
    d.open();
    await d.showHistory();
    d.ui.archivedBtn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.helpConversations).toHaveBeenLastCalledWith(true);
    expect(d.ui.archivedBtn.attrs["aria-pressed"]).toBe("true");
    expect(d.ui.list.textContent).toBe("You have no archived conversations.");
    expect(d.ui.status.textContent).toBe("0 archived conversations.");
    d.ui.historyBtn.click();
    expect(d.ui.history.hidden).toBe(true);
    expect(d.ui.historyBtn.textContent).toBe("History");
  });

  it("goes back to the conversation and says why when the list cannot be read", async () => {
    const { d } = make({ api: { helpConversations: vi.fn(async () => { throw new TypeError("Failed to fetch"); }) } });
    d.open();
    await d.showHistory();
    expect(d.ui.history.hidden).toBe(true);
    expect(d.ui.error.textContent).toBe("The Foundry could not be reached. Check your connection, then try again.");
  });

  it("a new conversation is empty, sends nothing and keeps the typed question", async () => {
    const { d, api } = await asked();
    await vi.advanceTimersByTimeAsync(1500);
    d.ui.question.value = "Half a question";
    d.ui.fresh.click();
    expect(d.state.conversation).toBeNull();
    expect(d.ui.thread.hidden).toBe(true);
    expect(d.ui.suggestBox.hidden).toBe(false);
    expect(d.ui.question.value).toBe("Half a question");
    expect(d.ui.status.textContent).toBe("A new conversation. Your earlier ones are under History.");
    expect(api.askHelp).toHaveBeenCalledTimes(1);
    await d.send();
    expect(api.askHelp).toHaveBeenLastCalledWith(null, { question: "Half a question", context: { page: "#/runs" } });
  });
});

describe("late answers are dropped", () => {
  it("of the conversation that was left for a new one", async () => {
    const slow = later<any>();
    const { d } = await asked({ api: { helpConversation: vi.fn(() => slow.promise) } });
    await vi.advanceTimersByTimeAsync(1500);
    d.fresh();
    slow.done(conv([q("Why?"), a("done", { text: "Too late." })]));
    await vi.advanceTimersByTimeAsync(0);
    expect(d.state.conversation).toBeNull();
    expect(d.ui.thread.children).toEqual([]);
    expect(d.ui.status.textContent).toBe("A new conversation. Your earlier ones are under History.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("of the first of two conversations opened one after the other", async () => {
    const first = later<any>();
    const second = later<any>();
    const { d } = make({ api: { helpConversation: vi.fn((id: string) => (id === ID1 ? first.promise : second.promise)) } });
    d.open();
    const one = d.openConversation(ID1);
    const two = d.openConversation(ID2);
    second.done(conv([q("Second?")], { id: ID2 }));
    first.done(conv([q("First?")], { id: ID1 }));
    expect(await one).toBe(false);
    expect(await two).toBe(true);
    expect(d.state.conversation.id).toBe(ID2);
    expect(texts(d.ui.thread, "ask-entry")).toEqual(["YouSecond?"]);
  });

  it("of a question that was sent before the person went on", async () => {
    const sent = later<any>();
    const { d } = make({ api: { askHelp: vi.fn(() => sent.promise) } });
    d.open();
    d.ui.question.value = "Why?";
    const sending = d.send();
    d.fresh();
    sent.done(conv([q("Why?"), a("pending")]));
    await sending;
    expect(d.state.conversation).toBeNull();
    expect(d.state.busy).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("of a list that was asked for before the other list", async () => {
    const current = later<any>();
    const { d } = make({ api: { helpConversations: vi.fn((archived: boolean) => (archived ? Promise.resolve({ conversations: [] }) : current.promise)) } });
    d.open();
    const one = d.showHistory();
    d.ui.archivedBtn.click();
    await vi.advanceTimersByTimeAsync(0);
    current.done({ conversations: [row(ID1)] });
    await one;
    expect(d.ui.list.textContent).toBe("You have no archived conversations.");
  });

  it("a change of the page behind keeps the conversation and its reading", async () => {
    const { d, setHash, api } = await asked();
    setHash("#/repos");
    expect(d.state.conversation.id).toBe("c1");
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.helpConversation).toHaveBeenCalledTimes(1);
    expect(texts(d.ui.thread, "ask-answer")).toEqual(["Ask SCFBecause.Continue on another page"]);
  });
});

describe("after a reload", () => {
  const memory = (start: string | null = null) => { let v = start; return { get: () => v, set: (x: string) => { v = x || null; } }; };

  it("remembers only the id of the open conversation, and forgets it with the conversation", async () => {
    const store = memory();
    const { d } = await asked({ deps: { store } });
    expect(store.get()).toBe("c1");
    d.fresh();
    expect(store.get()).toBeNull();
  });

  it("shows the conversation that was open again, with a read and no question", async () => {
    const back = conv([q("Why?"), a("pending")], { id: ID1 });
    const { d, api } = make({ deps: { store: memory(ID1), list: [row(ID1, { waiting: true }), row(ID2)] }, api: { helpConversation: vi.fn(async () => back) } });
    expect(api.helpConversation).not.toHaveBeenCalled();
    d.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.helpConversation).toHaveBeenCalledWith(ID1);
    expect(api.askHelp).not.toHaveBeenCalled();
    expect(texts(d.ui.thread, "ask-entry")).toHaveLength(2);
    expect(actions(d)).toEqual(["Stop", "Delete"]);
    // the reply that was being written is followed again
    expect(vi.getTimerCount()).toBe(1);
    // and a second Send still starts no second turn
    d.ui.question.value = "Again?";
    expect(await d.send()).toBe(false);
  });

  it("reads nothing for an id the server does not list, and starts empty when the conversation is gone", async () => {
    const unknown = make({ deps: { store: memory(ID2), list: [row(ID1)] } });
    unknown.d.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(unknown.api.helpConversation).not.toHaveBeenCalled();
    const store = memory(ID1);
    const gone = make({ deps: { store, list: [row(ID1)] }, api: { helpConversation: vi.fn(async () => { throw Object.assign(new Error("gone"), { status: 410 }); }) } });
    gone.d.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(gone.d.state.conversation).toBeNull();
    expect(gone.d.ui.error.textContent).toBe("");
    expect(store.get()).toBeNull();
    expect(gone.d.ui.suggestBox.hidden).toBe(false);
  });

  it("works without a store of the tab", () => {
    const { d } = make({ deps: { store: undefined } });
    d.open();
    expect(d.state.restore).toBeNull();
  });
});

// ---- #236: evidence, uncertainty, links and suggested actions ----------------------------------------

describe("a reply by its parts", () => {
  const SEEN = "2026-10-12T10:00:00.000Z";
  const state = (over: any = {}) => ({ id: "s1", kind: "state", title: "Run r-1 waits for your answer", ref: "#/runs/r-1", observedAt: SEEN, ...over });
  const reply = (over: any = {}) => ({ type: "status", summary: "Your run waits.", explanation: "It asked a question.", certainty: "confirmed", evidence: [state()], recommendations: [], links: [], drafts: [], actions: [], ...over });
  async function shown(r: any, over: any = {}) {
    const made = make({ ...over, deps: { now: () => Date.parse(SEEN) + 5 * 60_000, ...over.deps }, api: { helpConversation: vi.fn(async () => conv([q("Why?"), a("done", { text: "plain text of the server", reply: r })])) } });
    made.d.open();
    await made.d.openConversation("c1");
    const answer = walk(made.d.ui.thread).find((e) => e.classList.contains("ask-answer"))!;
    return { ...made, answer, all: walk(answer) };
  }
  const byClass = (all: FakeElement[], cls: string) => all.filter((e) => e.classList.contains(cls));

  it("shows the short answer first, then how sure it is, then what it rests on", async () => {
    const { all, answer } = await shown(reply());
    const order = all.filter((e) => e.parent === answer).map((e) => e.attrs.class);
    expect(order).toEqual(["ask-who", "ask-summary", "ask-explain", "ask-trust ask-trust-confirmed", "ask-basis", "ask-sources", "small"]);
    expect(byClass(all, "ask-summary")[0]!.textContent).toBe("Your run waits.");
    expect(byClass(all, "ask-trust")[0]!.textContent).toBe("✓ Checked against its sources. This rests on the sources listed below.");
    // the sign is for the eye; the words say the same
    expect(walk(byClass(all, "ask-trust")[0]!)[0]!.attrs["aria-hidden"]).toBe("true");
    const basis = byClass(all, "ask-basis")[0]!;
    expect(basis.attrs["aria-label"]).toBe("The current state this answer rests on");
    expect(basis.textContent).toBe("Current state: Run r-1 waits for your answer (#/runs/r-1) seen 5m ago");
    expect(answer.textContent).not.toContain("plain text of the server");
  });

  it("gives each state of trust its own class and words", async () => {
    const cases: [any, string, string][] = [
      [reply(), "ask-trust-confirmed", "Checked against its sources"],
      [reply({ certainty: "likely" }), "ask-trust-low", "Not fully confirmed"],
      [reply({ evidence: [], certainty: "unverified" }), "ask-trust-missing", "Not checked: no source"],
      [reply({ evidence: [state(), state({ id: "s2", title: "Run r-1 is done" })] }), "ask-trust-conflict", "The sources do not agree"],
    ];
    const seen = new Set<string>();
    for (const [r, cls, label] of cases) {
      const { all } = await shown(r);
      const trust = byClass(all, "ask-trust")[0]!;
      expect(trust.classList.contains(cls), cls).toBe(true);
      expect(walk(trust).find((e) => e.tag === "strong")!.textContent).toBe(label);
      seen.add(walk(trust)[0]!.textContent);
    }
    expect(seen.size).toBe(4);
    const css = readFileSync("ui/css/pages/ask.css", "utf8");
    const styles = ["confirmed", "low", "missing", "conflict", "limit"].map((s) => new RegExp(`\\.ask-trust-${s} \\{([^}]*)\\}`).exec(css)?.[1]);
    expect(new Set(styles).size).toBe(5);
    for (const s of styles) expect(s).toBeTruthy();
  });

  it("puts sources and assumptions in a part that unfolds, with the sources as links only where they are pages", async () => {
    const { all } = await shown(reply({ evidence: [state(), { id: "d1", kind: "doc", title: "User guide: Runs", ref: "https://evil.example/guide" }] }));
    const details = all.find((e) => e.tag === "details")!;
    expect(walk(details).find((e) => e.tag === "summary")!.textContent).toBe("Sources and assumptions (2 sources)");
    expect(walk(details).filter((e) => e.tag === "h4").map((e) => e.textContent)).toEqual(["Sources", "Assumptions"]);
    const links = walk(details).filter((e) => e.tag === "a");
    expect(links.map((l) => [l.attrs.href, l.textContent])).toEqual([["#/runs/r-1", "#/runs/r-1"]]);
    expect(details.textContent).toContain("Documentation: User guide: Runs (https://evil.example/guide)");
    expect(details.textContent).toContain("The current state was read at the times shown. It can have changed since.");
    const none = await shown(reply({ evidence: [] }));
    expect(none.all.find((e) => e.tag === "details")!.textContent).toContain("This answer names no source.");
    expect(byClass(none.all, "ask-basis")).toEqual([]);
  });

  it("keeps HTML and addresses in the text of a reply as text", async () => {
    const evil = '<img src=x onerror=alert(1)> <a href="https://evil.example">click</a> https://evil.example javascript:alert(1) #/settings';
    const { all, answer } = await shown(reply({ summary: evil, explanation: evil, recommendations: [evil], drafts: [{ title: evil, text: evil }], evidence: [state({ title: evil, ref: evil })] }));
    // the one control is the hand-off button of the answer
    expect(all.filter((e) => ["img", "script", "iframe", "a", "button", "form", "input"].includes(e.tag) && e.attrs["data-handoff"] === undefined)).toEqual([]);
    expect(byClass(all, "ask-summary")[0]!.children).toEqual([evil]);
    expect(byClass(all, "ask-explain")[0]!.children).toEqual([evil]);
    expect(answer.textContent.split(evil).length - 1).toBeGreaterThanOrEqual(6);
    for (const e of all) for (const k of Object.keys(e.attrs)) expect(k.startsWith("on"), k).toBe(false);
  });

  it("shows proposals as cards that say what they do, with no control that does anything", async () => {
    const { all } = await shown(reply({ recommendations: ["Answer the question on the run page."], links: [{ label: "Totally safe", to: "#/runs" }, { label: "Win", to: "https://evil.example" }], drafts: [{ title: "Comment", text: "Line 1\nLine 2" }], actions: [{ id: "cancel", title: "Cancel run r-1", impact: "The run stops." }] }));
    const cards = byClass(all, "ask-card");
    expect(cards.map((c) => c.attrs["aria-label"])).toEqual([
      "What you could do. Read-only",
      "A page you can open. Read-only",
      "An address that is not a page here. Read-only",
      "Draft: Comment. Read-only",
      "Suggested change: Cancel run r-1. Changes state",
    ]);
    expect(cards.map((c) => walk(c).find((e) => e.classList.contains("pill"))!.textContent)).toEqual(["Read-only", "Read-only", "Read-only", "Read-only", "Changes state"]);
    expect(walk(cards[4]!).find((e) => e.classList.contains("pill"))!.classList.contains("sem-warning")).toBe(true);
    // one link in all cards: the fixed page, named by the page itself
    const links = cards.flatMap((c) => walk(c).filter((e) => e.tag === "a"));
    expect(links.map((l) => [l.attrs.href, l.textContent])).toEqual([["#/runs", "My runs"]]);
    expect(cards[2]!.textContent).toContain("Win: https://evil.example");
    expect(walk(cards[3]!).find((e) => e.tag === "pre")!.textContent).toBe("Line 1\nLine 2");
    // nothing in a reply can be pressed to do something
    expect(all.filter((e) => (e.tag === "button" && e.attrs["data-handoff"] === undefined) || e.tag === "form" || e.tag === "input")).toEqual([]);
    expect(cards[4]!.textContent).toContain("Ask SCF does not do this. Nothing happens here.");
    for (const c of cards) expect(Object.keys(c.listeners)).toEqual([]);
  });

  it("following a link closes the drawer, makes no call and leaves the focus to the page", async () => {
    const { d, all, api } = await shown(reply({ links: [{ label: "Runs", to: "#/runs" }] }));
    const calls = api.askHelp.mock.calls.length + api.helpConversation.mock.calls.length;
    all.find((e) => e.tag === "a" && e.attrs.href === "#/runs")!.click();
    expect(d.state.open).toBe(false);
    expect(doc().activeElement).toBe(doc().getElementById("main"));
    expect(api.askHelp.mock.calls.length + api.helpConversation.mock.calls.length).toBe(calls);
    expect(d.state.conversation.id).toBe("c1");
  });

  it("shows a request that is not served with its fixed words and no sources", async () => {
    const { all } = await shown({ type: "product-help", summary: "Ask SCF never shows a password, a token or a key, and it never needs one from you.", explanation: "", certainty: "confirmed", evidence: [], recommendations: ["Do not type a secret into a question."], links: [{ label: "My repositories", to: "#/repos" }], drafts: [], actions: [], limit: { code: "secret", limitation: "x", nextStep: "y" } });
    expect(byClass(all, "ask-trust")[0]!.classList.contains("ask-trust-limit")).toBe(true);
    expect(all.find((e) => e.tag === "details")).toBeUndefined();
    expect(byClass(all, "ask-card").map((c) => c.attrs["aria-label"])).toEqual(["What you can do. Read-only", "A page you can open. Read-only"]);
  });

  it("an admin page is a link for an admin and text for a user", async () => {
    const r = reply({ links: [{ label: "Settings", to: "#/settings" }] });
    const user = await shown(r);
    expect(user.all.filter((e) => e.tag === "a" && e.attrs.href === "#/settings")).toEqual([]);
    const admin = await shown(r, { role: "admin" });
    expect(admin.all.filter((e) => e.tag === "a" && e.attrs.href === "#/settings")).toHaveLength(1);
  });
});

describe("the drawer is not caught by the rules of the page's side bar", () => {
  // The drawer is an <aside>. A rule for every aside (`.no-side aside { display: none }`) hid it on every page but Flows:
  // the backdrop showed and the drawer did not.
  it("every rule outside ask.css that names an aside names the side bar of the layout only", () => {
    const rules = parseCss(readUiCss()).filter((r) => /(^|[\s>+~,(])aside\b/.test(r.selector));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      for (const part of r.selector.split(",")) {
        if (!/(^|[\s>+~(])aside\b/.test(part.trim())) continue;
        expect(part.trim(), r.selector).toMatch(/\.layout > aside\b|aside\.ask-drawer|\.ask-drawer/);
      }
    }
  });
});

describe("narrow screens and reduced motion (ui/css/pages/ask.css)", () => {
  const css = readFileSync("ui/css/pages/ask.css", "utf8");
  const rules = parseCss(css);
  const decl = (selector: string, context = "") => rules.find((r) => r.selector === selector && r.context === context)?.declarations.join("; ") ?? "";

  it("takes the whole width at 767 px and below, and never more than the screen", () => {
    expect(decl(".ask-drawer")).toContain("width: min(440px, 100vw)");
    expect(decl(".ask-drawer")).toContain("overflow-y: auto");
    expect(decl(".ask-drawer", "@media (max-width: 767px)")).toContain("width: 100vw");
    expect(decl(".ask-entry")).toContain("overflow-wrap: anywhere");
    expect(decl(".ask-suggest")).toContain("flex-wrap: wrap");
  });

  it("has no motion at all, so there is nothing to reduce", () => {
    expect(css).not.toMatch(/\b(?:transition|animation|transform|scroll-behavior)\b/);
    expect(css).not.toContain("@keyframes");
  });

  it("lies over the page and under a dialog, with class names of its own", () => {
    expect(decl(".ask-scrim")).toContain("z-index: var(--layer-menu)");
    expect(decl(".ask-drawer")).toContain("z-index: calc(var(--layer-menu) + 1)");
    for (const r of rules) expect(r.selector, r.selector).toMatch(/^\.ask-/);
  });
});

describe("a plan in the drawer", () => {
  const SEEN = "2026-10-12T10:00:00.000Z";
  const state = { id: "s1", kind: "state", title: "Run r-1 failed", ref: "#/runs/r-1", observedAt: SEEN };
  const signals = { expected: "You see a copy.", failure: "It is empty.", fallback: "Stop." };
  const plan = [
    { kind: "reversible", title: "Save a copy of the log", evidence: ["s1"], ...signals },
    { kind: "check", title: "Check first. Change nothing yet.", instructions: "Look at the page.", to: "#/runs", evidence: [], wouldBe: "high-impact", proposal: "Delete the run", ...signals },
    { kind: "input", title: "Pick a branch", evidence: [] },
  ];
  const reply = { type: "guided-resolution", summary: "Steps.", explanation: "", certainty: "confirmed", evidence: [state], recommendations: [], links: [], drafts: [], actions: [], plan };
  const memory = () => { const m = new Map<string, number[]>(); return { get: (id: string) => m.get(id) ?? [], set: (id: string, v: number[]) => void m.set(id, v) }; };
  async function shown(over: any = {}) {
    const made = make({ ...over, api: { helpConversation: vi.fn(async () => conv([q("How?"), a("done", { reply })])) } });
    made.d.open();
    await made.d.openConversation("c1");
    return made;
  }
  const cards =(d: any) => walk(d.ui.thread).filter((e) => e.classList.contains("ask-step"));
  const buttons = (d: any) => walk(d.ui.thread).filter((e) => e.attrs["data-step"] !== undefined);

  it("is an ordered list with one card per step, a danger pill on a step that would be high impact, and the proposal", async () => {
    const { d } = await shown({ deps: { progress: memory() } });
    const list = walk(d.ui.thread).find((e) => e.classList.contains("ask-plan"))!;
    expect(list.tag).toBe("ol");
    expect(cards(d)).toHaveLength(3);
    const second = cards(d)[1]!;
    const pills = walk(second).filter((e) => e.classList.contains("pill")).map((e) => `${e.attrs.class}: ${e.textContent}`);
    expect(pills).toEqual(["pill sem-neutral: Read-only check", "pill sem-danger: Would be a high-impact change"]);
    expect(second.classList.contains("ask-step-danger")).toBe(true);
    expect(second.textContent).toContain("Proposed, not confirmed: Delete the run");
    expect(second.textContent).toContain("What you should see");
    expect(second.textContent).toContain("If it fails");
    expect(cards(d)[0]!.attrs["aria-current"]).toBe("step");
    expect(walk(d.ui.thread).find((e) => e.classList.contains("ask-plan-head"))!.textContent).toContain("1 is a high-impact change");
  });

  it("marks a step as done by the person's click, moves the current step, and says nothing was checked", async () => {
    const progress = memory();
    const { d } = await shown({ deps: { progress } });
    buttons(d)[0]!.click();
    expect(progress.get("a1")).toEqual([0]);
    expect(buttons(d)[0]!.attrs["aria-pressed"]).toBe("true");
    expect(cards(d)[0]!.attrs["aria-current"]).toBeUndefined();
    expect(cards(d)[1]!.attrs["aria-current"]).toBe("step");
    expect(cards(d)[0]!.textContent).toContain("You marked this. Ask SCF has not checked the result.");
    expect(d.ui.thread.textContent).not.toMatch(/succeeded|worked/i);
    buttons(d)[0]!.click();
    expect(progress.get("a1")).toEqual([]);
  });

  it("reads the marks back after a redraw", async () => {
    const progress = memory();
    progress.set("a1", [1]);
    const { d } = await shown({ deps: { progress } });
    expect(buttons(d).map((b) => b.attrs["aria-pressed"])).toEqual(["false", "true", "false"]);
    expect(cards(d)[0]!.attrs["aria-current"]).toBe("step");
  });

  it("keeps the marks in the tab and does not break when the tab has no storage", async () => {
    const tab = new Map<string, string>();
    (globalThis as any).sessionStorage = { getItem: (k: string) => tab.get(k) ?? null, setItem: (k: string, v: string) => void tab.set(k, v), removeItem: (k: string) => void tab.delete(k) };
    try {
      const { d } = await shown();
      buttons(d)[2]!.click();
      expect([...tab.entries()].filter(([k]) => k.startsWith("scf-ask-plan-"))).toEqual([["scf-ask-plan-a1", "[2]"]]);
      (globalThis as any).sessionStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
      buttons(d)[0]!.click();
      expect(buttons(d)[0]!.attrs["aria-pressed"]).toBe("true");
    } finally {
      delete (globalThis as any).sessionStorage;
    }
  });

  it("shows a reply without a plan as before", async () => {
    const made = make({ api: { helpConversation: vi.fn(async () => conv([q("How?"), a("done", { reply: { ...reply, plan: undefined } })])) } });
    made.d.open();
    await made.d.openConversation("c1");
    expect(cards(made.d)).toEqual([]);
  });
});

describe("rating an answer", () => {
  const A1 = "a1";
  const rated = (feedback?: any) => conv([q("Why?"), a("done", { id: A1, text: "Because.", ...(feedback ? { feedback } : {}) })]);
  const buttons = (d: any) => walk(d.ui.thread).filter((e) => e.tag === "button" && e.attrs["data-handoff"] === undefined);
  const byFocus = (d: any, name: string) => walk(d.ui.thread).find((e) => e.attrs["data-focus"] === name)!;
  const rateApi = (current: () => any) => vi.fn(async (_id: any, body: any) => {
    const next = body.vote === null ? rated() : rated({ vote: body.vote, reasons: body.reasons, at: "2026-03-01T10:00:00.000Z" });
    current();
    return next;
  });

  async function opened(feedback?: any, over: any = {}) {
    const made = make({ ...over, api: { helpConversation: vi.fn(async () => rated(feedback)), rateHelp: rateApi(() => {}), ...over.api } });
    made.d.open();
    await made.d.openConversation("c1");
    return made;
  }

  it("offers two buttons that say whether they are pressed, and saves a vote", async () => {
    const { d, api } = await opened();
    const group = walk(d.ui.thread).find((e) => e.attrs.role === "group" && e.attrs["aria-label"] === "Was this answer helpful?")!;
    expect(group).toBeTruthy();
    expect(buttons(d).map((b) => [b.textContent, b.attrs["aria-pressed"]])).toEqual([["Helpful", "false"], ["Not helpful", "false"]]);
    byFocus(d, "ask-rate-a1-helpful").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.rateHelp).toHaveBeenCalledWith("c1", { message: A1, vote: "helpful", reasons: [] });
    expect(d.ui.status.textContent).toBe("Saved: this answer helped.");
    expect(buttons(d).map((b) => b.attrs["aria-pressed"])).toEqual(["true", "false"]);
    // pressing it again takes the vote back
    byFocus(d, "ask-rate-a1-helpful").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.rateHelp).toHaveBeenLastCalledWith("c1", { message: A1, vote: null, reasons: [] });
    expect(d.ui.status.textContent).toBe("Your vote was taken back.");
  });

  it("has no rating on a question, a waiting reply or a failed one", async () => {
    const { d } = await asked();
    expect(buttons(d).filter((b) => b.attrs["data-focus"]?.startsWith("ask-rate"))).toEqual([]);
    const f = make({ api: { helpConversation: vi.fn(async () => failed("provider", true, PROVIDER)) } });
    f.d.open();
    await f.d.openConversation("c1");
    expect(walk(f.d.ui.thread).filter((e) => e.attrs["data-focus"]?.startsWith("ask-rate"))).toEqual([]);
  });

  it("asks for reasons after Not helpful, from a fixed list, and saves the ones ticked", async () => {
    const { d, api } = await opened({ vote: "not-helpful", reasons: [], at: "2026-03-01T10:00:00.000Z" });
    const fieldset = walk(d.ui.thread).find((e) => e.tag === "fieldset")!;
    expect(walk(fieldset).find((e) => e.tag === "legend")!.textContent).toContain("What was wrong?");
    const boxes = walk(fieldset).filter((e) => e.tag === "input");
    expect(boxes.map((b) => b.attrs.type)).toEqual(Array(6).fill("checkbox"));
    expect(walk(fieldset).filter((e) => e.tag === "textarea")).toEqual([]);
    for (const reason of ["outdated", "unclear"]) {
      const box = byFocus(d, `ask-reason-a1-${reason}`);
      box.checked = true;
      box.fire("change", { target: box });
    }
    byFocus(d, "ask-reasons-save-a1").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.rateHelp).toHaveBeenCalledWith("c1", { message: A1, vote: "not-helpful", reasons: ["outdated", "unclear"] });
  });

  it("keeps the focus and the ticked reasons when the drawer is drawn again", async () => {
    const { d, setHash } = await opened({ vote: "not-helpful", reasons: [], at: "2026-03-01T10:00:00.000Z" });
    const box = byFocus(d, "ask-reason-a1-incorrect");
    box.checked = true;
    box.fire("change", { target: box });
    box.focus();
    setHash("#/repos");
    const again = byFocus(d, "ask-reason-a1-incorrect");
    expect(again).not.toBe(box);
    expect(again.checked).toBe(true);
    expect(byFocus(d, "ask-reason-a1-unclear").checked).toBe(false);
    expect(doc().activeElement).toBe(again);
    // pressing a vote with the keyboard keeps the focus on that button after the call
    const vote = byFocus(d, "ask-rate-a1-not-helpful");
    vote.focus();
    vote.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(doc().activeElement?.attrs["data-focus"]).toBe("ask-rate-a1-not-helpful");
    expect(walk(d.ui.thread)).toContain(doc().activeElement);
  });

  it("keeps ticked reasons while a later answer is waited for", async () => {
    const first = [q("Why?"), a("done", { id: A1, text: "Because.", feedback: { vote: "not-helpful", reasons: [], at: "2026-03-01T10:00:00.000Z" } })];
    const waiting = conv([...first, q("And?", "q2"), a("pending", { id: "a2", replyTo: "q2" })]);
    const { d, api } = make({ api: { helpConversation: vi.fn(async () => waiting) } });
    d.open();
    await d.openConversation("c1");
    const box = byFocus(d, "ask-reason-a1-unclear");
    box.checked = true;
    box.fire("change", { target: box });
    box.focus();
    api.helpConversation.mockClear();
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.helpConversation).toHaveBeenCalled();
    const again = byFocus(d, "ask-reason-a1-unclear");
    expect(again.checked).toBe(true);
    expect(doc().activeElement).toBe(again);
  });

  it("closes a conversation as solved only through its own button", async () => {
    const closed = { ...rated(), state: "completed" };
    const solveHelp = vi.fn(async () => closed);
    const { d } = await opened(undefined, { api: { solveHelp } });
    press(d, "This solved my problem");
    await vi.advanceTimersByTimeAsync(0);
    expect(solveHelp).toHaveBeenCalledWith("c1");
    expect(d.state.conversation.state).toBe("completed");
    expect(actions(d)).not.toContain("This solved my problem");
  });
});

describe("the pause", () => {
  const PAUSED = "Ask SCF is paused by an administrator for now. You can still read, export and delete your conversations.";
  const refuse = (message: string) => vi.fn(async () => { throw Object.assign(new Error(message), { status: 503 }); });

  it("shows a notice, refuses Send and Try again, and still reads the history", async () => {
    const { d, api } = make({ deps: { paused: true }, api: { helpConversation: vi.fn(async () => failed("provider", true, PROVIDER)), helpConversations: vi.fn(async () => ({ enabled: true, paused: true, conversations: [] })) } });
    d.open();
    expect(d.ui.paused.hidden).toBe(false);
    expect(d.ui.paused.textContent).toBe(PAUSED);
    expect(d.ui.send.attrs["aria-disabled"]).toBe("true");
    await d.openConversation("c1");
    expect(texts(d.ui.thread, "ask-failed")).toEqual([`Ask SCF${PROVIDER}`]);
    expect(actions(d)).toEqual(["Archive", "Delete"]);
    expect(await d.retry()).toBe(false);
    d.ui.question.value = "Why?";
    expect(await d.send()).toBe(false);
    expect(d.ui.error.textContent).toBe(PAUSED);
    expect(api.askHelp).not.toHaveBeenCalled();
    expect(api.retryHelp).toBeUndefined();
  });

  it("learns of a pause from the server's sentence, and not from another 503", async () => {
    const off = "Ask SCF cannot check your question for secrets right now, so it does not keep it. Ask an administrator of this Foundry.";
    const { d } = make({ api: { askHelp: refuse(off) } });
    d.open();
    d.ui.question.value = "Why?";
    await d.send();
    expect(d.state.paused).toBe(false);
    expect(d.ui.paused.hidden).toBe(true);
    expect(d.ui.send.attrs["aria-disabled"]).toBeUndefined();
    expect(d.ui.error.textContent).toBe(off);

    const paused = make({ api: { askHelp: refuse(PAUSED) } });
    paused.d.open();
    paused.d.ui.question.value = "Why?";
    await paused.d.send();
    expect(paused.d.state.paused).toBe(true);
    expect(paused.d.ui.paused.hidden).toBe(false);
    expect(paused.d.ui.send.attrs["aria-disabled"]).toBe("true");
  });

  it("asks the server again when it was paused, so an unpaused Ask SCF works without a reload", async () => {
    const { d, api } = make({ deps: { paused: true }, api: { helpConversations: vi.fn(async () => ({ enabled: true, paused: false, conversations: [] })) } });
    d.open();
    d.ui.question.value = "Why?";
    await d.send();
    expect(api.helpConversations).toHaveBeenCalledTimes(1);
    expect(api.askHelp).toHaveBeenCalledTimes(1);
    expect(d.state.paused).toBe(false);
    expect(d.ui.paused.hidden).toBe(true);
  });

  it("is taken from the list of conversations", async () => {
    const { d } = make({ api: { helpConversations: vi.fn(async () => ({ enabled: true, paused: true, conversations: [] })) } });
    d.open();
    await d.showHistory();
    expect(d.state.paused).toBe(true);
    expect(d.ui.paused.hidden).toBe(false);
  });

  it("is passed on by the start of the drawer", async () => {
    const d = await ask.initAsk("user", { api: { helpConversations: async () => ({ enabled: true, paused: true, conversations: [] }) }, host: new FakeElement("body"), win: {} });
    expect(d.state.paused).toBe(true);
    d.stop();
  });
});

describe("offers in the drawer", () => {
  const state = { id: "state-run-1", kind: "state", title: "Run r1 waits", ref: "#/runs/r1", observedAt: "2026-10-12T10:00:00.000Z" };
  const reply = { type: "status", summary: "It waits.", explanation: "", certainty: "confirmed", evidence: [state], recommendations: [], links: [], drafts: [], actions: [], offers: [{ type: "open-run", title: "Open this run", evidence: "state-run-1", subject: { kind: "run", id: "r1" } }] };
  async function shown(helpOffer: any, deps: any = {}) {
    const go = vi.fn();
    const made = make({ api: { helpConversation: vi.fn(async () => conv([q("Why?"), a("done", { reply })])), helpOffer }, deps: { go, ...deps } });
    made.d.open();
    await made.d.openConversation("c1");
    return { ...made, go };
  }
  const openButtons = (d: any) => walk(d.ui.thread).filter((e) => e.attrs["data-offer"] !== undefined);
  const refused = (status: number) => vi.fn(async () => { throw Object.assign(new Error("x"), { status }); });

  it("shows a card with an Open button", async () => {
    const { d } = await shown(vi.fn());
    const card = walk(d.ui.thread).find((e) => e.classList.contains("ask-card-offer"))!;
    expect(card.textContent).toContain("Open this run");
    expect(card.textContent).toContain("Opens a page");
    expect(openButtons(d).map((b) => b.textContent)).toEqual(["Open"]);
  });

  it("asks the server, closes the drawer, and then goes to the address the server gave", async () => {
    const helpOffer = vi.fn(async () => ({ type: "open-run", to: "#/runs/r1" }));
    const { d, go } = await shown(helpOffer);
    go.mockImplementation(() => expect(d.state.open).toBe(false));
    openButtons(d)[0]!.click();
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith("#/runs/r1"));
    expect(helpOffer).toHaveBeenCalledWith("c1", { message: "a1", offer: 0 });
    expect(d.state.open).toBe(false);
  });

  it("says its own sentence for 403 and for 404, and does not go anywhere", async () => {
    for (const [status, text] of [[403, "You are not allowed to open this now."], [404, "This is not there any more, or you can no longer see it."], [410, "This is not there any more, or you can no longer see it."]] as const) {
      const { d, go } = await shown(refused(status));
      await d.runOffer("a1", 0);
      expect(d.ui.error.textContent, String(status)).toContain(text);
      expect(go).not.toHaveBeenCalled();
      expect(d.state.open).toBe(true);
    }
  });

  it("does not open an address that is not a page of this interface", async () => {
    for (const to of ["https://evil.example", "javascript:alert(1)", "#/board", undefined]) {
      const { d, go } = await shown(vi.fn(async () => ({ type: "open-run", to })));
      await d.runOffer("a1", 0);
      expect(d.ui.error.textContent, String(to)).toBe("This page cannot be opened here.");
      expect(go).not.toHaveBeenCalled();
    }
  });

  it("sends one call for two clicks while it is on its way", async () => {
    let release: (v: any) => void = () => {};
    const helpOffer = vi.fn(() => new Promise((r) => { release = r; }));
    const { d, go } = await shown(helpOffer);
    const first = d.runOffer("a1", 0);
    expect(await d.runOffer("a1", 0)).toBe(false);
    release({ type: "open-run", to: "#/runs/r1" });
    await first;
    expect(helpOffer).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledTimes(1);
  });
});
