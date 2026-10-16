import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ask: any;
let mod: any;
let view: any;
let wishes: any;
beforeAll(async () => {
  restore = installFakeDom();
  ask = await import("../ui/ask.js" as string);
  mod = await import("../ui/ask-handoff.js" as string);
  view = await import("../ui/ask-view.js" as string);
  wishes = await import("../ui/palette-data.js" as string);
});
afterAll(() => restore());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const CONV = "11111111-1111-4111-8111-111111111111";
const doc = () => (globalThis as any).document;
const walk = (root: FakeElement): FakeElement[] => root.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const fill = (over: any = {}) => ({ title: "Why does it wait?", text: "Question:\nWhy?", fromHelp: CONV, ...over });
const offer = (over: any = {}) => ({ key: "refinement", where: "refinement", title: "Refinement: a new session from this answer", page: "#/refinement", fill: fill(), ...over });

describe("offersOf", () => {
  it("keeps good offers and drops an unknown target, an external page, admin-only targets for a user and a bad fill", () => {
    const raw = [
      offer(),
      offer({ key: "x", where: "delete-everything" }),
      offer({ key: "e", page: "https://evil.example/#/refinement" }),
      offer({ key: "q", page: "#/refinement?x=1" }),
      { key: "problems", where: "problems", title: "Problems", page: "#/problems" },
      { key: "your-turn", where: "your-turn", title: "Home", page: "#/home" },
      offer({ key: "u", fill: fill({ fromHelp: "not-a-uuid" }) }),
      offer({ key: "l", fill: fill({ text: "x".repeat(10_001) }) }),
      offer({ key: "t", fill: fill({ title: "t".repeat(121) }) }),
      offer({ key: "n", fill: "text" }),
      null,
      { where: "run", page: "#/runs/r1" },
    ];
    expect(mod.offersOf(raw, "user").map((o: any) => o.key)).toEqual(["refinement"]);
    expect(mod.offersOf(raw, "admin").map((o: any) => o.key)).toEqual(["refinement", "problems", "your-turn"]);
    expect(mod.offersOf(undefined, "user")).toEqual([]);
  });
});

describe("previewOf", () => {
  it("shows exactly what the fill holds, with the link back", () => {
    const p = mod.previewOf(offer({ fill: fill({ repo: "acme/app" }) }), "My conversation");
    expect(p.nothing).toBe(false);
    expect(p.rows).toEqual([
      { label: "Title", text: "Why does it wait?" },
      { label: "Text", text: "Question:\nWhy?" },
      { label: "Repository (chosen in the form; you can change it)", text: "acme/app" },
      { label: "Link back (saved in the session; only you can see it)", text: "This Ask SCF conversation: My conversation" },
    ]);
    expect(p.note).toContain("Start session");
    expect(p.note).toContain("Administrators");
  });

  it("has no repository row without one, and nothing for a navigation", () => {
    expect(mod.previewOf(offer(), "T").rows.map((r: any) => r.label)).toEqual(["Title", "Text", "Link back (saved in the session; only you can see it)"]);
    const nav = mod.previewOf({ key: "run", where: "run", title: "Run details", page: "#/runs/r1" }, "T");
    expect(nav).toMatchObject({ nothing: true, rows: [] });
    expect(nav.note).toContain("Nothing is copied");
  });
});

describe("wishOf and recordsOf", () => {
  it("makes a wish only for a fill", () => {
    expect(mod.wishOf(offer())).toEqual({ page: "refinement", wish: { fill: fill() } });
    expect(mod.wishOf({ key: "run", where: "run", page: "#/runs/r1" })).toBeNull();
    expect(mod.wishOf(undefined)).toBeNull();
  });

  it("lists the records of one answer, with a link only for a page of the role", () => {
    const c = { handoffs: [
      { message: "a1", where: "run", page: "#/runs/r1", copied: [], at: "2026-01-01T00:00:00.000Z" },
      { message: "a1", where: "problems", page: "#/problems", copied: [], at: "2026-01-01T00:00:00.000Z" },
      { message: "other", where: "run", page: "#/runs/r1", copied: [], at: "2026-01-01T00:00:00.000Z" },
    ] };
    expect(mod.recordsOf(c, "a1", "admin").map((r: any) => [r.text, r.href])).toEqual([["You took this answer to Run details", "#/runs/r1"], ["You took this answer to Problems", "#/problems"]]);
    expect(mod.recordsOf(c, "a1", "user").map((r: any) => [r.text, r.href])).toEqual([["You took this answer to Run details", "#/runs/r1"], ["You took this answer to Problems", null]]);
    expect(mod.recordsOf(null, "a1", "user")).toEqual([]);
  });

  it("knows the shape of a conversation id", () => {
    expect(mod.isConversationId(CONV)).toBe(true);
    for (const bad of ["", "c1", 5, null, `${CONV}x`]) expect(mod.isConversationId(bad)).toBe(false);
  });
});

describe("the dialog", () => {
  const root = () => doc().getElementById("modal-root") as FakeElement;
  const press = (label: string) => walk(root()).find((e) => e.tag === "button" && e.textContent === label)!.click();
  afterEach(() => root().replaceChildren());

  it("resolves with the offer on confirm and null on Cancel and Escape; with several offers the person picks first", async () => {
    let p = view.handoffDialog({ offers: [offer()], conversationTitle: "T" });
    expect(root().textContent).toContain("Link back");
    press("Open Refinement");
    expect(await p).toMatchObject({ key: "refinement" });
    p = view.handoffDialog({ offers: [offer()], conversationTitle: "T" });
    press("Cancel");
    expect(await p).toBeNull();
    p = view.handoffDialog({ offers: [offer()], conversationTitle: "T" });
    (doc().listeners.keydown ?? []).forEach((f: any) => f({ key: "Escape" }));
    expect(await p).toBeNull();
    const run = { key: "run", where: "run", title: "Run details", page: "#/runs/r1" };
    p = view.handoffDialog({ offers: [run, offer()], conversationTitle: "T" });
    expect(walk(root()).filter((e) => e.attrs["data-handoff-pick"] !== undefined)).toHaveLength(2);
    walk(root()).find((e) => e.attrs["data-handoff-pick"] === "run")!.click();
    expect(root().textContent).toContain("Nothing is copied. The page opens.");
    press("Open run details");
    expect(await p).toMatchObject({ key: "run" });
  });
});

describe("the drawer", () => {
  const q = (text: string, id = "q1") => ({ id, role: "user", status: "done", text });
  const a = (over: any = {}) => ({ id: "a1", role: "assistant", status: "done", text: "Because.", replyTo: "q1", tries: 1, ...over });
  const conv = (over: any = {}) => ({ id: "c1", state: "active", title: "My conversation", messages: [q("Why?"), a()], ...over });
  const open: any[] = [];
  function make(over: any = {}) {
    const slot = new FakeElement("span");
    const host = new FakeElement("body");
    const win = { listeners: {} as Record<string, any[]>, addEventListener(t: string, fn: any) { (this.listeners[t] ??= []).push(fn); }, removeEventListener(t: string, fn: any) { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== fn); } };
    const api = {
      helpConversations: vi.fn(async () => ({ enabled: true, conversations: [] })),
      helpConversation: vi.fn(async () => conv()),
      helpHandoffs: vi.fn(async () => ({ offers: [offer()] })),
      recordHandoff: vi.fn(async (_id: string, body: any) => conv({ handoffs: [{ message: body.message, where: "refinement", page: body.page, copied: ["title", "text", "link"], at: "2026-01-01T00:00:00.000Z" }] }) && ({ conversation: conv({ handoffs: [{ message: body.message, where: "refinement", page: body.page, copied: ["title", "text", "link"], at: "2026-01-01T00:00:00.000Z" }] }), offer: offer() })),
      ...over.api,
    };
    const previewer = vi.fn(async ({ offers }: any) => offers[0]);
    const go = vi.fn();
    const wish = vi.fn();
    const d = ask.createAsk(over.role ?? "user", { slot, host, win, api, hash: () => "#/runs", confirmer: async () => true, previewer, go, wish, ...over.deps });
    open.push(d);
    return { d, api, win, previewer, go, wish };
  }
  afterEach(() => { for (const d of open.splice(0)) d.stop(); wishes.resetWishes(); doc().getElementById("modal-root").replaceChildren(); });

  /** Opens the drawer on conversation c1 with one answer, a1. */
  async function opened(over: any = {}) {
    const m = make(over);
    m.d.open();
    await m.d.openConversation("c1");
    return m;
  }
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const handoffButton = (d: any) => walk(d.ui.thread).find((e) => e.attrs["data-handoff"] === "a1")!;

  it("shows the button under an answer and calls nothing until it is pressed", async () => {
    const { d, api } = await opened();
    expect(handoffButton(d).textContent).toBe("Continue on another page");
    expect(api.helpHandoffs).not.toHaveBeenCalled();
  });

  it("changes nothing when the person cancels the preview", async () => {
    const { d, api, previewer, go, wish } = await opened({ deps: { previewer: vi.fn(async () => null) } });
    handoffButton(d).click();
    await flush();
    expect(api.helpHandoffs).toHaveBeenCalledWith("c1", "a1");
    expect(api.recordHandoff).not.toHaveBeenCalled();
    expect(go).not.toHaveBeenCalled();
    expect(wish).not.toHaveBeenCalled();
    expect(previewer).toBeDefined();
    expect(d.ui.status.textContent).toBe("Nothing was copied.");
    expect(d.state.open).toBe(true);
  });

  it("records the hand-off on confirm, sends the wish, closes the drawer and opens the page", async () => {
    const { d, api, previewer, go, wish } = await opened();
    handoffButton(d).click();
    await flush();
    expect(previewer).toHaveBeenCalledWith({ offers: [offer()], conversationTitle: "My conversation" });
    expect(api.recordHandoff).toHaveBeenCalledWith("c1", { message: "a1", offer: "refinement", page: "#/refinement", fill: fill() });
    expect(wish).toHaveBeenCalledWith("refinement", { fill: fill() });
    expect(d.state.open).toBe(false);
    expect(go).toHaveBeenCalledWith("#/refinement");
    expect(d.state.conversation.handoffs).toHaveLength(1);
  });

  it("sends no wish for a navigation", async () => {
    const run = { key: "run", where: "run", title: "Run details", page: "#/runs/r1" };
    const { d, api, go, wish } = await opened({ api: { helpHandoffs: vi.fn(async () => ({ offers: [run] })), recordHandoff: vi.fn(async () => ({ conversation: conv(), offer: run })) } });
    handoffButton(d).click();
    await flush();
    expect(api.recordHandoff).toHaveBeenCalledWith("c1", { message: "a1", offer: "run", page: "#/runs/r1" });
    expect(wish).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledWith("#/runs/r1");
  });

  it("shows an error and does not navigate when the record is refused", async () => {
    const { d, go, wish } = await opened({ api: { recordHandoff: vi.fn(async () => { throw Object.assign(new Error("changed"), { status: 409 }); }) } });
    handoffButton(d).click();
    await flush();
    expect(d.ui.error.textContent).not.toBe("");
    expect(go).not.toHaveBeenCalled();
    expect(wish).not.toHaveBeenCalled();
    expect(d.state.open).toBe(true);
  });

  it("says so when there is no other page, and when the offers cannot be read", async () => {
    const none = await opened({ api: { helpHandoffs: vi.fn(async () => ({ offers: [] })) } });
    handoffButton(none.d).click();
    await flush();
    expect(none.d.ui.status.textContent).toBe("There is no other page for this answer.");
    expect(none.previewer).not.toHaveBeenCalled();
    const failed = await opened({ api: { helpHandoffs: vi.fn(async () => { throw Object.assign(new Error("x"), { status: 404 }); }) } });
    handoffButton(failed.d).click();
    await flush();
    expect(failed.d.ui.error.textContent).not.toBe("");
    expect(failed.previewer).not.toHaveBeenCalled();
  });

  it("drops the offers of an answer that comes after the person switched conversations", async () => {
    let release: (v: any) => void = () => {};
    const late = new Promise((r) => (release = r));
    const { d, api, previewer } = await opened({ api: { helpHandoffs: vi.fn(() => late) } });
    handoffButton(d).click();
    await flush();
    d.fresh();
    release({ offers: [offer()] });
    await flush();
    expect(previewer).not.toHaveBeenCalled();
    expect(api.recordHandoff).not.toHaveBeenCalled();
  });

  it("opens the drawer on the conversation named by scf-ask-open, ignores a bad id, and stops listening", async () => {
    const { d, api, win } = make();
    const fire = (id: unknown) => (win.listeners["scf-ask-open"] ?? []).forEach((f) => f({ detail: { id } }));
    fire("c1");
    fire(undefined);
    await flush();
    expect(api.helpConversation).not.toHaveBeenCalled();
    expect(d.state.open).toBe(false);
    fire(CONV);
    await flush();
    expect(d.state.open).toBe(true);
    expect(api.helpConversation).toHaveBeenCalledWith(CONV);
    d.stop();
    expect(win.listeners["scf-ask-open"]).toEqual([]);
  });

  it("draws the records under the reply", async () => {
    const records = [{ message: "a1", where: "run", page: "#/runs/r1", copied: [], at: new Date().toISOString() }];
    const { d } = await opened({ api: { helpConversation: vi.fn(async () => conv({ handoffs: records })) } });
    const list = walk(d.ui.thread).find((e) => e.tag === "ul" && e.attrs["aria-label"] === "Where you took this answer")!;
    expect(list.textContent).toContain("You took this answer to Run details");
    const link = walk(list).find((e) => e.tag === "a")!;
    expect(link.attrs.href).toBe("#/runs/r1");
  });
});
