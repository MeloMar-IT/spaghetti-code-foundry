import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { parseCss } from "./helpers/ui-css.js";

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
  const d = ask.createAsk(over.role ?? "user", { slot, host, win, api, hash: () => hash });
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
    const last = stops.at(-1)!;
    expect(first).toBe(d.ui.close);
    expect(last).toBe(d.ui.send);
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
    expect(texts(d.ui.drawer, "small")[0]).toBe("How do I connect a repository?");
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
    expect(answer.children.at(-1)).toBe("<img src=x onerror=alert(1)> Because.");
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
