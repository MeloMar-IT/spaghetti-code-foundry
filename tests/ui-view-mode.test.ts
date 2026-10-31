import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let vm: any;
let draft: any;
let refinement: any;
let apiMod: any;
const g = globalThis as any;
const doc = () => g.document;
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const byId = (id: string) => doc().getElementById(id) as FakeElement;
/** An `input` event as a browser sends it to the page listeners. */
const typeIn = (el: any, value: string) => {
  el.value = value;
  (doc().listeners.input ?? []).forEach((fn: any) => fn({ target: el }));
};
const box = (tag: string, props: Record<string, string> = {}) => {
  const e = new FakeElement(tag);
  for (const [k, v] of Object.entries(props)) e.setAttribute(k, v);
  return e;
};

beforeAll(async () => {
  restore = installFakeDom();
  vm = await import("../ui/view-mode.js" as string);
  draft = await import("../ui/user/start-draft.js" as string);
  refinement = await import("../ui/refinement-new.js" as string);
  apiMod = await import("../ui/api.js" as string);
  vm.trackTyping();
});
afterAll(() => restore());
beforeEach(() => {
  doc().body.removeAttribute("inert");
  doc().activeElement = null;
  doc().listeners.keydown = [];
  byId("modal-root").replaceChildren();
  draft.clearDraft();
  refinement.clearKeptSession();
});

describe("the rules", () => {
  it("picks the view in effect and the views of an account", () => {
    expect(vm.viewOf({ role: "user" })).toBe("advanced");
    expect(vm.viewOf({ role: "admin" })).toBe("admin");
    expect(vm.viewOf({ role: "user", view: "admin" })).toBe("advanced");
    expect(vm.viewOf({ role: "admin", view: "simple", views: ["simple", "advanced", "admin"] })).toBe("simple");
    expect(vm.viewsOf({ role: "user" })).toEqual(["simple", "advanced"]);
    expect(vm.viewsOf({ role: "admin" })).toEqual(["simple", "advanced", "admin"]);
    expect(vm.viewsOf(undefined)).toEqual(["simple", "advanced"]);
    expect(vm.displayOf("admin")).toBe("admin");
    expect(vm.displayOf("simple")).toBe("user");
    expect(vm.displayPath("admin")).toBe("/");
    expect(vm.displayPath("advanced")).toBe("/user/");
  });

  it("offerFor names the view that has the page", () => {
    const o = vm.offerFor;
    expect(o("simple", "user", "#/epics")).toBe("advanced");
    expect(o("simple", "user", "#/refinement/backlog")).toBe("advanced");
    expect(o("simple", "user", "#/runs?repo=a/b")).toBeNull();
    expect(o("simple", "user", "#/runs/abc")).toBeNull();
    expect(o("simple", "admin", "#/settings")).toBe("admin");
    expect(o("advanced", "admin", "#/settings")).toBe("admin");
    expect(o("advanced", "user", "#/settings")).toBeNull();
    expect(o("admin", "admin", "#/settings")).toBeNull();
    expect(o("advanced", "admin", "#/your-turn")).toBe("admin");
    expect(o("simple", "user", "")).toBeNull();
    expect(o("simple", "user", "#/")).toBeNull();
  });
});

describe("unsavedWork", () => {
  it("is true only when a listener cancels the event", () => {
    const t = new EventTarget();
    expect(vm.unsavedWork(t)).toBe(false);
    t.addEventListener("beforeunload", () => {});
    expect(vm.unsavedWork(t)).toBe(false);
    t.addEventListener("beforeunload", (e) => e.preventDefault());
    expect(vm.unsavedWork(t)).toBe(true);
  });
});

describe("typedText", () => {
  it("sees typed text in a text area and in a single-line field", () => {
    const area = box("textarea");
    typeIn(area, "my answer");
    expect(vm.typedText()).toBe(true);
    typeIn(area, "   ");
    expect(vm.typedText()).toBe(false);
    const model = box("input", { type: "text", name: "default_model" });
    typeIn(model, "opus");
    expect(vm.typedText()).toBe(true);
    typeIn(model, "");
    expect(vm.typedText()).toBe(false);
  });

  it("forgets a box that left the page, and ignores a search box, a select and a checkbox", () => {
    const gone: any = box("textarea");
    typeIn(gone, "text");
    gone.isConnected = false;
    expect(vm.typedText()).toBe(false);
    gone.isConnected = true;
    expect(vm.typedText()).toBe(false);
    for (const el of [box("input", { type: "search" }), box("select"), box("input", { type: "checkbox" })]) {
      typeIn(el, "x");
      expect(vm.typedText()).toBe(false);
    }
  });
});

describe("unsentText", () => {
  it("is true for a Start work draft until it is cleared", async () => {
    expect(await vm.unsentText()).toBe(false);
    draft.writeDraft({ flow: "f", task: "t", values: {} });
    expect(await vm.unsentText()).toBe(true);
    draft.clearDraft();
    expect(await vm.unsentText()).toBe(false);
  });

  it("is true for the text kept from a closed New refinement dialog, and not for a repository alone", async () => {
    const field = (name: string) => walk(byId("modal-root")).find((e) => e.attrs.name === name)!;
    const escape = () => doc().listeners.keydown.forEach((f: any) => f({ key: "Escape" }));
    void refinement.newSessionDialog(["a/b"]);
    field("repo").value = "a/b";
    field("repo").fire("change");
    escape();
    expect(refinement.keptSession()).not.toBeNull();
    expect(await vm.unsentText()).toBe(false);
    byId("modal-root").replaceChildren();
    void refinement.newSessionDialog(["a/b"]);
    field("idea").value = "an idea";
    field("idea").fire("input");
    escape();
    expect(await vm.unsentText()).toBe(true);
    refinement.clearKeptSession();
    expect(await vm.unsentText()).toBe(false);
  });

  it("is true for a typed run answer, and false once it is emptied", async () => {
    const answer = box("textarea", { name: "answer" });
    typeIn(answer, "use B");
    expect(await vm.unsentText()).toBe(true);
    typeIn(answer, "");
    expect(await vm.unsentText()).toBe(false);
  });

  it("is true for an edited single-line field such as a model name", async () => {
    const model = box("input", { type: "text", name: "fallback_models" });
    typeIn(model, "sonnet");
    expect(await vm.unsentText()).toBe(true);
    typeIn(model, "");
    expect(await vm.unsentText()).toBe(false);
  });
});

describe("chooseView", () => {
  const make = (over: Record<string, any> = {}) => {
    const a = { setView: vi.fn(async () => ({})), myView: vi.fn(async () => ({ view: "advanced" })) };
    const opts = {
      a, go: vi.fn(), hash: () => "#/runs", unsaved: () => false, unsent: async () => false, ask: vi.fn(async () => true),
      freeze: vi.fn(() => vi.fn()), later: vi.fn(), ...over,
    };
    return { a, opts };
  };

  it("stores the view, then opens the display with the address when it has the page", async () => {
    const { a, opts } = make();
    expect(await vm.chooseView("simple", opts)).toBe("");
    expect(a.setView).toHaveBeenCalledWith("simple");
    expect(opts.go).toHaveBeenCalledWith("/user/#/runs");
    expect(opts.later).toHaveBeenCalledTimes(1);
    const b = make({ hash: () => "#/settings" });
    await vm.chooseView("simple", b.opts);
    expect(b.opts.go).toHaveBeenCalledWith("/user/");
    const c = make({ hash: () => "#/settings" });
    await vm.chooseView("admin", c.opts);
    expect(c.opts.go).toHaveBeenCalledWith("/#/settings");
  });

  it("returns the message of a refusal, and one for a network failure, without opening anything", async () => {
    const refused = make();
    refused.a.setView.mockRejectedValue(Object.assign(new Error("this view is not open to your role"), { status: 403 }));
    expect(await vm.chooseView("admin", refused.opts)).toBe("this view is not open to your role");
    expect(refused.opts.go).not.toHaveBeenCalled();
    const thaw = vi.fn();
    const down = make({ freeze: () => thaw });
    down.a.setView.mockRejectedValue(new TypeError("Failed to fetch"));
    down.a.myView.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await vm.chooseView("simple", down.opts)).toContain("Could not reach the server.");
    expect(thaw).toHaveBeenCalled();
    expect(down.opts.go).not.toHaveBeenCalled();
  });

  it("stops for text a page guards: no call, no question, no freeze", async () => {
    const { a, opts } = make({ unsaved: () => true });
    expect(await vm.chooseView("simple", opts)).toBe(vm.UNSAVED_TEXT);
    expect(a.setView).not.toHaveBeenCalled();
    expect(opts.ask).not.toHaveBeenCalled();
    expect(opts.freeze).not.toHaveBeenCalled();
    expect(opts.go).not.toHaveBeenCalled();
  });

  it("asks about unsent text: Cancel changes nothing, confirming goes on", async () => {
    const no = make({ unsent: async () => true, ask: vi.fn(async () => false) });
    expect(await vm.chooseView("simple", no.opts)).toBeNull();
    expect(no.a.setView).not.toHaveBeenCalled();
    expect(no.opts.go).not.toHaveBeenCalled();
    expect(no.opts.freeze).not.toHaveBeenCalled();
    const yes = make({ unsent: async () => true });
    expect(await vm.chooseView("simple", yes.opts)).toBe("");
    expect(yes.a.setView).toHaveBeenCalled();
    expect(yes.opts.go).toHaveBeenCalled();
  });

  it("asks for a typed answer, a model field and a closed dialog's text (real check)", async () => {
    const answer = box("textarea", { name: "answer" });
    const model = box("input", { type: "text", name: "default_model" });
    const cases = [
      { prepare: () => typeIn(answer, "x"), undo: () => typeIn(answer, "") },
      { prepare: () => typeIn(model, "x"), undo: () => typeIn(model, "") },
      { prepare: () => draft.writeDraft({ flow: "f", task: "t", values: {} }), undo: () => draft.clearDraft() },
    ];
    for (const { prepare, undo } of cases) {
      prepare();
      const no = make({ unsent: vm.unsentText, ask: vi.fn(async () => false) });
      expect(await vm.chooseView("simple", no.opts)).toBeNull();
      expect(no.a.setView).not.toHaveBeenCalled();
      const yes = make({ unsent: vm.unsentText });
      expect(await vm.chooseView("simple", yes.opts)).toBe("");
      expect(yes.opts.go).toHaveBeenCalled();
      undo();
    }
  });

  it("freezes before the call and after the dialog, and gives the page back when the call fails", async () => {
    const order: string[] = [];
    let fail!: (e: unknown) => void;
    const a = {
      setView: vi.fn(() => { order.push(`put inert=${doc().body.getAttribute("inert")}`); return new Promise((_r, rej) => { fail = rej; }); }),
      myView: vi.fn(async () => ({ view: "advanced" })),
    };
    const field = box("textarea");
    field.focus();
    const done = vm.chooseView("simple", {
      a, go: vi.fn(), hash: () => "", unsaved: () => false, unsent: async () => true, ask: async () => { order.push("ask"); return true; },
    });
    await flush();
    expect(order).toEqual(["ask", "put inert="]);
    expect(doc().body.getAttribute("inert")).toBe("");
    fail(Object.assign(new Error("nope"), { status: 500 }));
    expect(await done).toBe("nope");
    expect(doc().body.getAttribute("inert")).toBeNull();
    expect(doc().activeElement).toBe(field);
  });

  it("keeps the view when the call timed out but the server had stored it", async () => {
    const { a, opts } = make();
    a.setView.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    a.myView.mockResolvedValue({ view: "simple" });
    expect(await vm.chooseView("simple", opts)).toBe("");
    expect(opts.go).toHaveBeenCalledWith("/user/#/runs");
  });

  it("gives the page back and says so when a timed-out call did not store the view", async () => {
    const thaw = vi.fn();
    const { a, opts } = make({ freeze: () => thaw });
    a.setView.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    a.myView.mockResolvedValue({ view: "advanced" });
    expect(await vm.chooseView("simple", opts)).toBe("Could not reach the server.");
    expect(thaw).toHaveBeenCalled();
    expect(opts.go).not.toHaveBeenCalled();
  });

  it("says the outcome is unknown when the stored view cannot be read either", async () => {
    const { a, opts } = make();
    a.setView.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    a.myView.mockRejectedValue(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    expect(await vm.chooseView("simple", opts)).toBe(`Could not reach the server. ${vm.UNSURE_TEXT}`);
    expect(opts.go).not.toHaveBeenCalled();
  });
});

describe("the page lock", () => {
  it("freezePage sets inert and the returned function removes it once and refocuses", () => {
    const control = box("select");
    control.focus();
    const thaw = vm.freezePage();
    expect(doc().body.getAttribute("inert")).toBe("");
    doc().activeElement = null;
    thaw();
    expect(doc().body.getAttribute("inert")).toBeNull();
    expect(doc().activeElement).toBe(control);
    doc().body.setAttribute("inert", "");
    thaw();
    expect(doc().body.getAttribute("inert")).toBe("");
    doc().body.removeAttribute("inert");
  });

  it("guardEdits gives the page back at once, and the guard asks only while typed text is on the page", () => {
    // the browser's own question when the page is left: a trusted event is not a switch check
    const leaving = (t: EventTarget) => {
      const e = new Event("beforeunload", { cancelable: true });
      t.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const target = new EventTarget();
    const thaw = vi.fn();
    vm.guardEdits(thaw, target);
    expect(thaw).toHaveBeenCalledTimes(1);
    expect(leaving(target)).toBe(false);
    const area = box("textarea");
    typeIn(area, "a draft");
    expect(leaving(target)).toBe(true);
    typeIn(area, "");
    expect(leaving(target)).toBe(false);
    // a later switch and new typing: the guard still asks, and not again after the text is cleared
    vm.guardEdits(vi.fn(), target);
    typeIn(area, "again");
    expect(leaving(target)).toBe(true);
    typeIn(area, "");
    expect(leaving(target)).toBe(false);
    // a switch check does not count the guard itself
    typeIn(area, "again");
    expect(vm.unsavedWork(target)).toBe(false);
    typeIn(area, "");
  });

  it("uses no timer to give the page back", () => {
    vi.useFakeTimers();
    try {
      const thaw = vi.fn();
      vm.guardEdits(thaw, new EventTarget());
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed check before a switch is reported, and the next try works", async () => {
    const a = { setView: vi.fn(async () => ({})), myView: vi.fn(async () => ({ view: "advanced" })) };
    const opts = {
      a, go: vi.fn(), hash: () => "#/runs", unsaved: () => false, freeze: () => () => {}, later: vi.fn(), ask: vi.fn(async () => true),
      unsent: vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module")).mockResolvedValue(false),
    };
    expect(await vm.chooseView("simple", opts)).toBe("Could not reach the server.");
    expect(a.setView).not.toHaveBeenCalled();
    expect(await vm.chooseView("simple", opts)).toBe("");
    expect(a.setView).toHaveBeenCalledWith("simple");
  });
});

describe("api.setView", () => {
  it("is bounded by a timeout signal", async () => {
    const saved = g.fetch;
    let seen: AbortSignal | undefined;
    g.fetch = vi.fn(async (_u: string, init: { signal?: AbortSignal }) => {
      seen = init.signal;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ view: "simple" }) };
    });
    try {
      await apiMod.api.setView("simple");
      expect(seen).toBeInstanceOf(AbortSignal);
      expect(seen!.aborted).toBe(false);
      expect(apiMod.VIEW_TIMEOUT_MS).toBeGreaterThan(0);
      await apiMod.api.myView();
      expect(g.fetch).toHaveBeenCalledTimes(2);
    } finally {
      g.fetch = saved;
    }
  });
});

describe("goTo", () => {
  afterAll(() => { delete g.location; delete g.history; });
  it("reloads for the same path and assigns another", () => {
    const loc = { pathname: "/user/", hash: "", reload: vi.fn(), assign: vi.fn() };
    g.location = loc;
    g.history = { replaceState: vi.fn() };
    vm.goTo("/user/#/runs");
    expect(g.history.replaceState).toHaveBeenCalledWith(null, "", "/user/#/runs");
    expect(loc.reload).toHaveBeenCalled();
    vm.goTo("/#/settings");
    expect(loc.assign).toHaveBeenCalledWith("/#/settings");
    expect(loc.reload).toHaveBeenCalledTimes(1);
  });
});

describe("mountViewSwitch", () => {
  const ids = ["vs-top", "vs-menu"];
  const selects = () => ids.map((id) => walk(byId(id)).find((e) => e.tag === "select")!);
  const setup = (user: any, over: Record<string, any> = {}) => {
    const a = { setView: vi.fn(async () => ({})), myView: vi.fn(async () => ({})) };
    const go = vi.fn();
    for (const id of ids) { byId(id).hidden = true; byId(id).replaceChildren(); }
    vm.mountViewSwitch(user, { ids, a, go, hash: () => "#/runs", unsaved: () => false, unsent: async () => false, freeze: () => () => {}, later: vi.fn(), ...over });
    return { a, go };
  };
  const choose = async (select: FakeElement, value: string) => { select.value = value; select.fire("change"); await flush(); };

  it("offers two views to a user and three to an admin, selects the current one and shows both boxes", () => {
    setup({ role: "user", view: "simple" });
    for (const s of selects()) {
      expect(walk(s).filter((e) => e.tag === "option")).toHaveLength(2);
      expect(s.value).toBe("simple");
    }
    for (const id of ids) expect(byId(id).hidden).toBe(false);
    setup({ role: "admin" });
    expect(walk(selects()[0]!).filter((e) => e.tag === "option")).toHaveLength(3);
    expect(selects()[1]!.value).toBe("admin");
  });

  it("stores a change and opens the display, and does nothing for the same value", async () => {
    const { a, go } = setup({ role: "user" });
    await choose(selects()[0]!, "advanced");
    expect(a.setView).not.toHaveBeenCalled();
    await choose(selects()[0]!, "simple");
    expect(a.setView).toHaveBeenCalledWith("simple");
    expect(go).toHaveBeenCalledWith("/user/#/runs");
    for (const s of selects()) expect(s.value).toBe("simple");
  });

  it("keeps working when the page stays after a successful switch", async () => {
    const { a } = setup({ role: "user" });
    await choose(selects()[0]!, "simple");
    for (const s of selects()) expect(s.disabled).toBe(false);
    await choose(selects()[1]!, "advanced");
    expect(a.setView).toHaveBeenCalledTimes(2);
    expect(selects()[0]!.value).toBe("advanced");
  });

  it("shows a toast and the old value in both boxes after a failure, and nothing after a cancel", async () => {
    const { a } = setup({ role: "user" });
    a.setView.mockRejectedValue(Object.assign(new Error("refused"), { status: 403 }));
    await choose(selects()[0]!, "simple");
    for (const s of selects()) expect(s.value).toBe("advanced");
    expect(byId("toast").textContent).toContain("refused");
    byId("toast").textContent = "";
    setup({ role: "user" }, { unsent: async () => true, ask: async () => false });
    await choose(selects()[0]!, "simple");
    expect(selects()[0]!.value).toBe("advanced");
    expect(byId("toast").textContent).toBe("");
  });

  it("a failed check does not leave the switch stuck", async () => {
    const unsent = vi.fn().mockRejectedValueOnce(new Error("module failed")).mockResolvedValue(false);
    const { a } = setup({ role: "user" }, { unsent });
    await choose(selects()[0]!, "simple");
    expect(a.setView).not.toHaveBeenCalled();
    expect(byId("toast").textContent).toContain("module failed");
    expect(selects()[0]!.value).toBe("advanced");
    await choose(selects()[0]!, "simple");
    expect(a.setView).toHaveBeenCalledWith("simple");
  });

  it("makes no second call while one runs", async () => {
    let release!: () => void;
    const { a } = setup({ role: "user" });
    a.setView.mockImplementation(() => new Promise((r) => { release = () => r({}); }));
    const [top, menu] = selects();
    top!.value = "simple";
    top!.fire("change");
    await flush();
    menu!.value = "simple";
    menu!.fire("change");
    await flush();
    expect(a.setView).toHaveBeenCalledTimes(1);
    release();
    await flush();
  });
});

describe("offerCard", () => {
  const card = () => {
    const root = new FakeElement("div");
    return root;
  };
  const press = (root: FakeElement) => walk(root).find((e) => e.tag === "button")!;
  const opts = (over: Record<string, any> = {}) => {
    const a = { setView: vi.fn(async () => ({})), myView: vi.fn(async () => ({})) };
    return { a, go: vi.fn(), hash: () => "#/epics", unsaved: () => false, unsent: async () => false, freeze: () => () => {}, later: vi.fn(), ...over };
  };

  it("names the current view and the view it offers", () => {
    const one = card();
    vm.offerCard(one, "advanced", "simple", opts());
    expect(one.textContent).toContain("This page is not in the Simple view.");
    expect(press(one).textContent).toBe("Open this in the Advanced view");
    const two = card();
    vm.offerCard(two, "admin", "advanced", opts());
    expect(two.textContent).toContain("This page is not in the Advanced view.");
    expect(press(two).textContent).toBe("Open this in the Admin view");
  });

  it("stores the offered view and opens the same address", async () => {
    const o = opts({ hash: () => "#/runs/abc" });
    const root = card();
    vm.offerCard(root, "advanced", "simple", o);
    press(root).click();
    await flush();
    expect(o.a.setView).toHaveBeenCalledWith("advanced");
    expect(o.go).toHaveBeenCalledWith("/user/#/runs/abc");
  });

  it("shows an error and works again after it, and shows none for a cancel", async () => {
    const o = opts();
    o.a.setView.mockRejectedValueOnce(Object.assign(new Error("refused"), { status: 403 }));
    const root = card();
    vm.offerCard(root, "advanced", "simple", o);
    press(root).click();
    await flush();
    const alert = walk(root).find((e) => e.attrs.role === "alert")!;
    expect(alert.textContent).toBe("refused");
    press(root).click();
    await flush();
    expect(o.a.setView).toHaveBeenCalledTimes(2);
    expect(alert.textContent).toBe("");
    const cancelled = opts({ unsent: async () => true, ask: async () => false });
    const other = card();
    vm.offerCard(other, "advanced", "simple", cancelled);
    press(other).click();
    await flush();
    expect(walk(other).find((e) => e.attrs.role === "alert")!.textContent).toBe("");
    expect(cancelled.a.setView).not.toHaveBeenCalled();
  });
});

describe("showViewNav", () => {
  it("hides the links Simple does not have, and nothing for Advanced", () => {
    const side = new FakeElement("nav");
    const links = ["home", "epics", "runs", "repos", "refinement"].map((n) => box("a", { "data-nav": n }));
    side.append(...links);
    vm.showViewNav("simple", side);
    expect(links.filter((l) => l.hidden).map((l) => l.attrs["data-nav"])).toEqual(["epics", "refinement"]);
    vm.showViewNav("advanced", side);
    expect(links.some((l) => l.hidden)).toBe(false);
  });
});

describe("the pages", () => {
  it("both displays have the two switch boxes, and the menu box ends the sidebar", () => {
    for (const file of ["ui/index.html", "ui/user/index.html"]) {
      const html = readFileSync(file, "utf8");
      expect(html, file).toContain('<span id="view-switch" class="view-switch" hidden></span>');
      expect(html, file).toMatch(/<div id="view-switch-menu" class="view-switch-menu" hidden><\/div>\s*<\/nav>/);
    }
  });

  it("the CSS hides the top bar switch below 768 px and shows the menu one", () => {
    const css = readFileSync("ui/css/pages/shell.css", "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 767px)", css.indexOf(".view-switch-menu { display: none; }")));
    expect(narrow).toContain(".view-switch { display: none; }");
    expect(narrow).toContain(".view-switch-menu:not([hidden])");
  });
});
