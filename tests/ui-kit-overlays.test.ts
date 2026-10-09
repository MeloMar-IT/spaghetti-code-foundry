import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { kitCssProblems, kitSourceProblems, tokenNames } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ov: any;
let dom: any;

beforeAll(async () => {
  restore = installFakeDom();
  ov = await import("../ui/kit/overlays.js" as string);
  dom = await import("../ui/dom.js" as string);
});
afterAll(() => restore());

const doc = () => document as any;
const rootEl = () => document.getElementById("modal-root") as unknown as FakeElement;
const body = () => document.body as unknown as FakeElement;
const active = () => doc().activeElement as FakeElement | null;
const count = (type: string) => (doc().listeners[type] ?? []).length;
const keydown = (key: string, shiftKey = false) => {
  const e = { key, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  for (const fn of [...(doc().listeners.keydown ?? [])]) fn(e);
  return e;
};
const docMousedown = (target: unknown) => {
  for (const fn of [...(doc().listeners.mousedown ?? [])]) fn({ target });
};
const key = (el: FakeElement, k: string) => {
  const e = { key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  el.fire("keydown", e);
  return e;
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const btn = (text = "x") => dom.h("button", {}, text) as FakeElement;
/** A button in the page that has the focus, like the control a person pressed. */
const opener = (text = "open") => {
  const b = btn(text);
  body().append(b);
  b.focus();
  return b;
};
const btns = (el: FakeElement, label?: string) => el.all("button").filter((b) => label === undefined || b.textContent === label || b.getAttribute("aria-label") === label);
const closeButton = (el: FakeElement) => btns(el, "Close")[0]!;

afterEach(() => {
  for (let i = 0; i < 10 && count("keydown"); i++) keydown("Escape");
  rootEl().replaceChildren();
  body().replaceChildren();
  doc().activeElement = null;
  expect(count("keydown")).toBe(0);
  expect(count("mousedown")).toBe(0);
  vi.useRealTimers();
});

describe("tabs", () => {
  const make = (extra: Record<string, unknown> = {}) => {
    const builds = [vi.fn(() => dom.h("p", {}, "A")), vi.fn(() => dom.h("p", {}, "B")), vi.fn(() => dom.h("p", {}, "C"))];
    const onSelect = vi.fn();
    const el = ov.tabs({ label: "Things", tabs: ["a", "b", "c"].map((id, i) => ({ id, label: id.toUpperCase(), build: builds[i] })), onSelect, ...extra }) as FakeElement;
    return { el, builds, onSelect, tabs: btns(el), panels: el.all("div").filter((d) => d.getAttribute("role") === "tabpanel") };
  };

  it("has roles, a name, aria-selected and aria-controls that point at a panel", () => {
    const { el, tabs, panels } = make();
    const list = el.all("div").find((d) => d.getAttribute("role") === "tablist")!;
    expect(list.getAttribute("aria-label")).toBe("Things");
    expect(tabs.map((t) => t.getAttribute("role"))).toEqual(["tab", "tab", "tab"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    tabs.forEach((t, i) => {
      expect(panels[i]!.getAttribute("id")).toBe(t.getAttribute("aria-controls"));
      expect(panels[i]!.getAttribute("aria-labelledby")).toBe(t.getAttribute("id"));
    });
  });

  it("uses a roving tabindex and starts at `selected` or the first tab", () => {
    expect(make().tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1"]);
    const { tabs } = make({ selected: "c" });
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);
  });

  it("shows only the selected panel and builds each panel once, when first shown", () => {
    const { tabs, panels, builds, onSelect } = make();
    expect(panels.map((p) => p.hidden)).toEqual([false, true, true]);
    expect(builds.map((b) => b.mock.calls.length)).toEqual([1, 0, 0]);
    tabs[1]!.click();
    tabs[0]!.click();
    tabs[1]!.click();
    expect(panels.map((p) => p.hidden)).toEqual([true, false, true]);
    expect(builds.map((b) => b.mock.calls.length)).toEqual([1, 1, 0]);
    expect(onSelect.mock.calls).toEqual([["b"], ["a"], ["b"]]);
  });

  it("calls onSelect only when the tab changes", () => {
    const { tabs, onSelect } = make();
    expect(onSelect).not.toHaveBeenCalled();
    tabs[0]!.click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("moves with the arrow keys, wraps, and jumps with Home and End", () => {
    const { tabs, onSelect } = make();
    const step = (from: number, k: string, to: number) => {
      const e = key(tabs[from]!, k);
      expect(e.preventDefault, `${k} from ${from}`).toHaveBeenCalled();
      expect(active(), `${k} from ${from}`).toBe(tabs[to]);
      expect(tabs[to]!.getAttribute("aria-selected")).toBe("true");
    };
    step(0, "ArrowLeft", 2);
    step(2, "ArrowRight", 0);
    step(0, "ArrowRight", 1);
    step(1, "End", 2);
    step(2, "Home", 0);
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual(["c", "a", "b", "c", "a"]);
    const other = key(tabs[0]!, "a");
    expect(other.preventDefault).not.toHaveBeenCalled();
  });

  it("throws on bad input", () => {
    const ok = [{ id: "a", label: "A", build: () => dom.h("p") }];
    expect(() => ov.tabs({ label: " ", tabs: ok })).toThrow(/label/);
    expect(() => ov.tabs({ label: "x", tabs: [] })).toThrow(/at least one/);
    expect(() => ov.tabs({ label: "x", tabs: [...ok, ...ok] })).toThrow(/duplicate/);
    expect(() => ov.tabs({ label: "x", tabs: ok, selected: "z" })).toThrow(/unknown tab/);
    expect(() => ov.tabs({ label: "x", tabs: [{ id: "a", label: "A" }] })).toThrow(/build/);
    expect(() => ov.tabs({ label: "x", tabs: ok, style: {} })).toThrow(/style/);
  });
});

describe("menu", () => {
  const make = (extra: Record<string, unknown> = {}) => {
    const onSelect = vi.fn();
    const m = ov.menu({ label: "Actions", trigger: "Actions", items: [{ label: "One", onSelect }, { label: "Two", disabled: true }, { label: "Three", danger: true, onSelect }, { label: "Four" }], ...extra }) as FakeElement;
    body().append(m);
    const trigger = m.children[0] as FakeElement;
    const list = m.children[1] as FakeElement;
    return { m, trigger, list, items: list.children as FakeElement[], onSelect };
  };

  it("starts closed with the right attributes", () => {
    const { trigger, list, items } = make();
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBeNull();
    expect(list.hidden).toBe(true);
    expect(list.getAttribute("role")).toBe("menu");
    expect(items.map((i) => i.getAttribute("role"))).toEqual(Array(4).fill("menuitem"));
    expect(count("mousedown")).toBe(0);
  });

  it("opens on a click with focus on the first item, and closes on a second click", () => {
    const { trigger, list, items } = make();
    trigger.click();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(list.hidden).toBe(false);
    expect(active()).toBe(items[0]);
    trigger.click();
    expect(list.hidden).toBe(true);
    expect(active()).toBe(trigger);
  });

  it("opens on ArrowDown (first item) and ArrowUp (last item)", () => {
    const { trigger, items, list } = make();
    const e = key(trigger, "ArrowDown");
    expect(e.preventDefault).toHaveBeenCalled();
    expect(active()).toBe(items[0]);
    key(list, "Escape");
    key(trigger, "ArrowUp");
    expect(active()).toBe(items[3]);
    key(list, "Escape");
  });

  it("moves with Up and Down, wraps, jumps with Home and End, and skips a disabled item", () => {
    const { trigger, list, items } = make();
    trigger.click();
    key(list, "ArrowDown");
    expect(active()).toBe(items[2]);
    key(list, "ArrowDown");
    key(list, "ArrowDown");
    expect(active()).toBe(items[0]);
    key(list, "ArrowUp");
    expect(active()).toBe(items[3]);
    key(list, "ArrowUp");
    expect(active()).toBe(items[2]);
    key(list, "Home");
    expect(active()).toBe(items[0]);
    key(list, "End");
    expect(active()).toBe(items[3]);
    key(list, "Escape");
  });

  it("skips a disabled first item when it opens, and ignores a click on a disabled item", () => {
    const onSelect = vi.fn();
    const { trigger, list, items } = make({ items: [{ label: "Off", disabled: true, onSelect }, { label: "On" }] });
    trigger.click();
    expect(active()).toBe(items[1]);
    items[0]!.click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(list.hidden).toBe(false);
    key(list, "Escape");
  });

  it("Escape closes, focuses the trigger and stops the event", () => {
    const { trigger, list } = make();
    trigger.click();
    const e = key(list, "Escape");
    expect(e.stopPropagation).toHaveBeenCalled();
    expect(list.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(active()).toBe(trigger);
  });

  it("Tab closes it and does not prevent the default", () => {
    const { trigger, list } = make();
    trigger.click();
    const e = key(list, "Tab");
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(list.hidden).toBe(true);
    expect(active()).toBe(trigger);
  });

  it("an item click closes first, then calls onSelect", () => {
    const seen: unknown[] = [];
    const { trigger, items } = make({ items: [{ label: "One", onSelect: () => seen.push([trigger.getAttribute("aria-expanded"), active()]) }] });
    trigger.click();
    items[0]!.click();
    expect(seen).toEqual([["false", trigger]]);
  });

  it("closes on a mousedown outside without moving focus, and stays open on one inside", () => {
    const { m, trigger, list, items } = make();
    const outside = opener("outside");
    trigger.click();
    docMousedown(items[0]);
    expect(list.hidden).toBe(false);
    docMousedown(trigger);
    expect(list.hidden).toBe(false);
    outside.focus();
    docMousedown(outside);
    expect(list.hidden).toBe(true);
    expect(active()).toBe(outside);
    expect(count("mousedown")).toBe(0);
    expect(m.contains(outside)).toBe(false);
  });

  it("has a document listener only while open", () => {
    const { trigger, list } = make();
    expect(count("mousedown")).toBe(0);
    trigger.click();
    expect(count("mousedown")).toBe(1);
    key(list, "Escape");
    expect(count("mousedown")).toBe(0);
  });

  it("an empty menu has a disabled trigger and never opens", () => {
    const { trigger, list } = make({ items: [] });
    expect(trigger.getAttribute("disabled")).not.toBeNull();
    trigger.click();
    key(trigger, "ArrowDown");
    expect(list.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(count("mousedown")).toBe(0);
  });

  it("with every item disabled, it opens with the focus on the list", () => {
    const { trigger, list } = make({ items: [{ label: "A", disabled: true }, { label: "B", disabled: true }] });
    trigger.click();
    expect(active()).toBe(list);
    key(list, "ArrowDown");
    key(list, "End");
    expect(active()).toBe(list);
    key(list, "Escape");
  });

  it("uses classes for placement, alignment and danger", () => {
    const { m, items } = make({ placement: "above", align: "end" });
    expect(m.getAttribute("class")).toContain("scf-menu--above");
    expect(m.getAttribute("class")).toContain("scf-menu--end");
    expect(items[2]!.getAttribute("class")).toContain("scf-menu__item--danger");
    expect(make().m.getAttribute("class")).not.toContain("--above");
  });

  it("names a node trigger with the label", () => {
    const { trigger } = make({ trigger: dom.h("span", {}, "…") });
    expect(trigger.getAttribute("aria-label")).toBe("Actions");
  });

  it("throws on bad input", () => {
    expect(() => ov.menu({ label: "", trigger: "x", items: [] })).toThrow(/label/);
    expect(() => ov.menu({ label: "x", trigger: "x" })).toThrow(/items/);
    expect(() => ov.menu({ label: "x", trigger: "x", items: [], placement: "left" })).toThrow(/placement/);
    expect(() => ov.menu({ label: "x", trigger: "x", items: [], style: {} })).toThrow(/style/);
  });

  it("passes the accessibility check when open", () => {
    const { m, trigger, list } = make();
    trigger.click();
    expect(audit(m)).toEqual([]);
    key(list, "Escape");
  });
});

describe("tooltip", () => {
  const make = (extra: Record<string, unknown> = {}, target = btn("Save")) => {
    const t = ov.tooltip({ text: "Saves it", ...extra }, target) as FakeElement;
    body().append(t);
    return { t, target, bubble: t.children[1] as FakeElement };
  };

  it("has a hidden bubble linked with aria-describedby, keeping an existing value", () => {
    const target = btn();
    target.setAttribute("aria-describedby", "other");
    const { bubble } = make({}, target);
    expect(bubble.getAttribute("role")).toBe("tooltip");
    expect(bubble.hidden).toBe(true);
    expect(target.getAttribute("aria-describedby")).toBe(`other ${bubble.getAttribute("id")}`);
    expect(count("keydown")).toBe(0);
  });

  it("shows on hover and focus and hides on leave and blur", () => {
    const { t, bubble } = make();
    t.fire("mouseenter");
    expect(bubble.hidden).toBe(false);
    t.fire("mouseleave");
    expect(bubble.hidden).toBe(true);
    t.fire("focusin");
    expect(bubble.hidden).toBe(false);
    t.fire("focusout");
    expect(bubble.hidden).toBe(true);
  });

  it("stays shown while it is hovered or focused", () => {
    const { t, bubble } = make();
    t.fire("mouseenter");
    t.fire("focusin");
    t.fire("mouseleave");
    expect(bubble.hidden).toBe(false);
    t.fire("focusout");
    expect(bubble.hidden).toBe(true);
    expect(count("keydown")).toBe(0);
  });

  it("hides on Escape and then has no document listener", () => {
    const { t, bubble } = make();
    t.fire("focusin");
    expect(count("keydown")).toBe(1);
    keydown("Escape");
    expect(bubble.hidden).toBe(true);
    expect(count("keydown")).toBe(0);
  });

  it("inside a dialog, Escape hides the tooltip first and the dialog next; Tab still wraps", async () => {
    const o = opener();
    let tip!: FakeElement;
    const done = ov.dialog({ title: "T", build: () => { tip = make().t; return tip; } });
    tip.fire("focusin");
    const bubble = tip.children[1] as FakeElement;
    expect(bubble.hidden).toBe(false);
    const target = tip.children[0] as FakeElement;
    const stops = [closeButton(rootEl()), target];
    stops[1]!.focus();
    const tab = keydown("Tab");
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(active()).toBe(stops[0]);
    keydown("Escape");
    expect(bubble.hidden).toBe(true);
    expect(rootEl().children.length).toBe(1);
    keydown("Escape");
    await expect(done).resolves.toBeUndefined();
    expect(rootEl().children.length).toBe(0);
    expect(active()).toBe(o);
  });

  it("a tooltip behind the top layer does not take Escape", async () => {
    opener();
    const outer = make().t;
    outer.fire("mouseenter");
    const done = ov.dialog({ title: "T", build: () => dom.h("p") });
    keydown("Escape");
    await done;
    expect(rootEl().children.length).toBe(0);
    expect((outer.children[1] as FakeElement).hidden).toBe(false);
    keydown("Escape");
    expect((outer.children[1] as FakeElement).hidden).toBe(true);
  });

  it("closing a dialog hides a tooltip inside it, so no listener is left", async () => {
    opener();
    let tip!: FakeElement;
    const done = ov.dialog({ title: "T", build: (close: () => void) => { tip = make().t; setTimeout(close, 0); return tip; } });
    tip.fire("mouseenter");
    expect(count("keydown")).toBe(1);
    await done;
    expect(count("keydown")).toBe(0);
    expect((tip.children[1] as FakeElement).hidden).toBe(true);
  });

  it("throws on bad input", () => {
    expect(() => ov.tooltip({ text: " " }, btn())).toThrow(/text/);
    expect(() => ov.tooltip({ text: "x" })).toThrow(/target/);
    expect(() => ov.tooltip({ text: "x", placement: "left" }, btn())).toThrow(/placement/);
  });
});

describe("dialog", () => {
  it("has dialog attributes, a name from its heading, and passes the accessibility check", () => {
    opener();
    const a = ov.dialog({ title: "First", build: () => dom.h("p", {}, "x") });
    const box = rootEl().all("div").find((d) => d.getAttribute("role") === "dialog")!;
    expect(box.getAttribute("aria-modal")).toBe("true");
    expect(box.getAttribute("tabindex")).toBe("-1");
    const id = box.getAttribute("aria-labelledby")!;
    expect(box.all("h2")[0]!.getAttribute("id")).toBe(id);
    expect(box.all("h2")[0]!.textContent).toBe("First");
    expect(audit(rootEl())).toEqual([]);
    const b = ov.dialog({ title: "Second", build: () => dom.h("p") });
    const ids = rootEl().all("h2").map((h) => h.getAttribute("id"));
    expect(new Set(ids).size).toBe(2);
    keydown("Escape");
    keydown("Escape");
    return Promise.all([a, b]);
  });

  it("focuses the first input, or the box without one", async () => {
    opener();
    const input = dom.h("input", {});
    const a = ov.dialog({ title: "A", build: () => input });
    expect(active()).toBe(input);
    keydown("Escape");
    await a;
    const b = ov.dialog({ title: "B", build: () => dom.h("p") });
    expect(active()?.getAttribute("role")).toBe("dialog");
    keydown("Escape");
    await b;
  });

  it("skips a disabled or hidden first input and focuses the next usable one", async () => {
    opener();
    const off = dom.h("input", {});
    off.disabled = true;
    const hidden = dom.h("input", { type: "hidden" });
    const good = dom.h("input", {});
    const a = ov.dialog({ title: "A", build: () => [off, hidden, good] });
    expect(active()).toBe(good);
    keydown("Escape");
    await a;
    const b = ov.dialog({ title: "B", build: () => off });
    expect(active()?.getAttribute("role")).toBe("dialog");
    keydown("Escape");
    await b;
  });

  it("traps Tab and Shift+Tab and leaves the middle alone", async () => {
    opener();
    const mid = btn("mid");
    const done = ov.dialog({ title: "A", build: () => mid });
    const first = closeButton(rootEl());
    mid.focus();
    expect(keydown("Tab").preventDefault).toHaveBeenCalled();
    expect(active()).toBe(first);
    expect(keydown("Tab", true).preventDefault).toHaveBeenCalled();
    expect(active()).toBe(mid);
    first.focus();
    mid.focus();
    first.focus();
    expect(keydown("Tab").preventDefault).not.toHaveBeenCalled();
    keydown("Escape");
    await done;
  });

  it("Escape resolves undefined, removes the layer and listener, and returns focus to the opener", async () => {
    const o = opener();
    const done = ov.dialog({ title: "A", build: () => dom.h("p") });
    expect(count("keydown")).toBe(1);
    keydown("Escape");
    await expect(done).resolves.toBeUndefined();
    expect(rootEl().children.length).toBe(0);
    expect(count("keydown")).toBe(0);
    expect(active()).toBe(o);
  });

  it("close(7) resolves 7, and a second close changes nothing", async () => {
    const o = opener();
    let close!: (v?: unknown) => void;
    const first = ov.dialog({ title: "A", build: (c: any) => { close = c; return dom.h("p"); } });
    close(7);
    await expect(first).resolves.toBe(7);
    const other = opener("other");
    const second = ov.dialog({ title: "B", build: () => dom.h("p") });
    const inside = active();
    close("x");
    expect(rootEl().children.length).toBe(1);
    expect(active()).toBe(inside);
    expect(o).not.toBe(other);
    keydown("Escape");
    await second;
    await expect(first).resolves.toBe(7);
  });

  it("does nothing on Escape, ✕ or the backdrop while busy", async () => {
    let busy = true;
    opener();
    const done = ov.dialog({ title: "A", busy: () => busy, build: () => dom.h("p") });
    keydown("Escape");
    closeButton(rootEl()).click();
    rootEl().children[0]!.fire("mousedown", { target: rootEl().children[0], currentTarget: rootEl().children[0] });
    expect(rootEl().children.length).toBe(1);
    busy = false;
    keydown("Escape");
    await done;
    expect(rootEl().children.length).toBe(0);
  });

  it("closes on a backdrop mousedown by default, not on the box, and not with dismissOnBackdrop false", async () => {
    opener();
    const a = ov.dialog({ title: "A", build: () => dom.h("p") });
    const overlay = rootEl().children[0] as FakeElement;
    const box = overlay.children[0] as FakeElement;
    overlay.fire("mousedown", { target: box, currentTarget: overlay });
    expect(rootEl().children.length).toBe(1);
    overlay.fire("mousedown", { target: overlay, currentTarget: overlay });
    await a;
    expect(rootEl().children.length).toBe(0);
    const b = ov.dialog({ title: "B", dismissOnBackdrop: false, build: () => dom.h("p") });
    const o2 = rootEl().children[0] as FakeElement;
    o2.fire("mousedown", { target: o2, currentTarget: o2 });
    expect(rootEl().children.length).toBe(1);
    keydown("Escape");
    await b;
  });

  it("stacks: Escape closes the top layer only and focus walks back down", async () => {
    const o = opener();
    const inA = btn("in A");
    const a = ov.dialog({ title: "A", build: () => inA });
    inA.focus();
    const b = ov.dialog({ title: "B", build: () => dom.h("p") });
    expect(rootEl().children.length).toBe(2);
    expect(count("keydown")).toBe(1);
    expect((rootEl().children[0] as FakeElement).getAttribute("inert")).toBe("");
    expect((rootEl().children[1] as FakeElement).getAttribute("inert")).toBeNull();
    keydown("Escape");
    await b;
    expect(rootEl().children.length).toBe(1);
    expect(active()).toBe(inA);
    expect((rootEl().children[0] as FakeElement).getAttribute("inert")).toBeNull();
    keydown("Escape");
    await a;
    expect(active()).toBe(o);
  });

  it("the Tab trap uses the top layer only", async () => {
    opener();
    const a = ov.dialog({ title: "A", build: () => btn("a-only") });
    const b = ov.dialog({ title: "B", build: () => btn("b-only") });
    const topStops = dom.tabStops(rootEl().children[1]);
    topStops.at(-1).focus();
    keydown("Tab");
    expect(active()).toBe(topStops[0]);
    keydown("Escape");
    keydown("Escape");
    await Promise.all([a, b]);
  });

  it("closing the lower layer first removes only it, keeps focus, and the upper one returns to the first opener", async () => {
    const o = opener();
    let closeA!: () => void;
    const inA = btn("in A");
    const a = ov.dialog({ title: "A", build: (c: any) => { closeA = c; return inA; } });
    inA.focus();
    const b = ov.dialog({ title: "B", build: () => dom.h("p") });
    const focused = active();
    closeA();
    await a;
    expect(rootEl().children.length).toBe(1);
    expect(active()).toBe(focused);
    expect(count("keydown")).toBe(1);
    keydown("Escape");
    await b;
    expect(active()).toBe(o);
    expect(count("keydown")).toBe(0);
  });

  it("closing a dialog closes the menu inside it, so no document listener is left", async () => {
    opener();
    let m!: FakeElement;
    let close!: () => void;
    const done = ov.dialog({ title: "A", build: (c: any) => { close = c; m = ov.menu({ label: "M", trigger: "M", items: [{ label: "One" }] }); return m; } });
    (m.children[0] as FakeElement).click();
    expect(count("mousedown")).toBe(1);
    close();
    await done;
    expect(count("mousedown")).toBe(0);
    expect((m.children[1] as FakeElement).hidden).toBe(true);
  });

  it("rejects when build throws, leaving nothing behind", async () => {
    opener();
    await expect(ov.dialog({ title: "A", build: () => { throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(rootEl().children.length).toBe(0);
    expect(count("keydown")).toBe(0);
  });

  it("mounts nothing when close is called inside build", async () => {
    opener();
    await expect(ov.dialog({ title: "A", build: (close: (v: unknown) => void) => { close("early"); return dom.h("p"); } })).resolves.toBe("early");
    expect(rootEl().children.length).toBe(0);
    expect(count("keydown")).toBe(0);
  });

  it("throws on a blank title or a missing build", () => {
    expect(() => ov.dialog({ title: " ", build: () => dom.h("p") })).toThrow(/title/);
    expect(() => ov.dialog({ title: "A" })).toThrow(/build/);
  });
});

describe("drawer", () => {
  it("is drawn as a side panel on the end or the start", async () => {
    opener();
    const a = ov.drawer({ title: "A", build: () => dom.h("p") });
    const overlay = rootEl().children[0] as FakeElement;
    expect(overlay.getAttribute("class")).toContain("scf-overlay--drawer");
    expect(overlay.getAttribute("class")).not.toContain("scf-overlay--start");
    expect((overlay.children[0] as FakeElement).getAttribute("class")).toBe("scf-drawer");
    keydown("Escape");
    await a;
    const b = ov.drawer({ title: "B", side: "start", build: () => dom.h("p") });
    const o2 = rootEl().children[0] as FakeElement;
    expect(o2.getAttribute("class")).toContain("scf-overlay--start");
    expect((o2.children[0] as FakeElement).getAttribute("class")).toContain("scf-drawer--start");
    expect(audit(rootEl())).toEqual([]);
    keydown("Escape");
    await b;
    expect(() => ov.drawer({ title: "C", side: "top", build: () => dom.h("p") })).toThrow(/side/);
  });

  it("has the dialog contract: Escape, busy, trap and focus return", async () => {
    const o = opener();
    let busy = true;
    const mid = btn("mid");
    const done = ov.drawer({ title: "A", busy: () => busy, build: () => mid });
    keydown("Escape");
    expect(rootEl().children.length).toBe(1);
    mid.focus();
    keydown("Tab");
    expect(active()).toBe(closeButton(rootEl()));
    busy = false;
    keydown("Escape");
    await expect(done).resolves.toBeUndefined();
    expect(active()).toBe(o);
  });

  it("ignores a backdrop mousedown by default and closes on it with dismissOnBackdrop", async () => {
    opener();
    const a = ov.drawer({ title: "A", build: () => dom.h("p") });
    const overlay = rootEl().children[0] as FakeElement;
    overlay.fire("mousedown", { target: overlay, currentTarget: overlay });
    expect(rootEl().children.length).toBe(1);
    keydown("Escape");
    await a;
    const b = ov.drawer({ title: "B", dismissOnBackdrop: true, build: () => dom.h("p") });
    const o2 = rootEl().children[0] as FakeElement;
    o2.fire("mousedown", { target: o2, currentTarget: o2 });
    await b;
    expect(rootEl().children.length).toBe(0);
  });

  it("a dialog on top of a drawer: Escape closes the dialog only", async () => {
    opener();
    const d = ov.drawer({ title: "D", build: () => dom.h("p") });
    const x = ov.dialog({ title: "X", build: () => dom.h("p") });
    keydown("Escape");
    await x;
    expect(rootEl().children.length).toBe(1);
    keydown("Escape");
    await d;
  });
});

describe("toast", () => {
  const list = () => body().children.find((c) => c instanceof FakeElement && c.getAttribute("class") === "scf-toasts") as FakeElement;

  it("creates its container on first use, reuses it, and leaves #toast alone", () => {
    vi.useFakeTimers();
    ov.toast("one");
    const first = list();
    ov.toast("two");
    expect(list()).toBe(first);
    expect(first.children.length).toBe(2);
    expect(document.getElementById("toast")).toBeTruthy();
    expect((document.getElementById("toast") as unknown as FakeElement).children.length).toBe(0);
  });

  it("makes a new container when the old one was taken out of the page", () => {
    vi.useFakeTimers();
    ov.toast("one");
    const first = list();
    body().replaceChildren();
    ov.toast("two");
    expect(list()).not.toBe(first);
    expect(list().children.length).toBe(1);
  });

  it("uses role status, or alert for fail, and a tone class", () => {
    vi.useFakeTimers();
    for (const tone of ["info", "ok", "warn", "fail"]) ov.toast(`a ${tone}`, { tone });
    const els = list().children as FakeElement[];
    expect(els.map((e) => e.getAttribute("role"))).toEqual(["status", "status", "status", "alert"]);
    expect(els.map((e) => e.getAttribute("class"))).toEqual(["info", "ok", "warn", "fail"].map((t) => `scf-toast scf-toast--${t}`));
  });

  it("stacks toasts in order", () => {
    vi.useFakeTimers();
    ov.toast("a");
    ov.toast("b");
    ov.toast("c");
    expect((list().children as FakeElement[]).map((e) => e.all("span")[0]!.textContent)).toEqual(["a", "b", "c"]);
  });

  it("goes away after 3500 ms, after a custom timeout, and stays with timeout 0", () => {
    vi.useFakeTimers();
    ov.toast("a");
    ov.toast("b", { timeout: 100 });
    ov.toast("c", { timeout: 0 });
    vi.advanceTimersByTime(100);
    expect(list().children.length).toBe(2);
    vi.advanceTimersByTime(3400);
    expect(list().children.length).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(list().children.length).toBe(1);
  });

  it("keeps a fail toast until it is dismissed, whatever the timeout", () => {
    vi.useFakeTimers();
    ov.toast("bad", { tone: "fail", timeout: 10 });
    vi.advanceTimersByTime(60_000);
    expect(list().children.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Dismiss removes only its toast; the returned function is idempotent and clears the timer", () => {
    vi.useFakeTimers();
    const dismiss = ov.toast("a");
    ov.toast("b", { tone: "fail" });
    expect(vi.getTimerCount()).toBe(1);
    dismiss();
    dismiss();
    expect(vi.getTimerCount()).toBe(0);
    expect(list().children.length).toBe(1);
    btns(list().children[0] as FakeElement, "Dismiss")[0]!.click();
    expect(list().children.length).toBe(0);
  });

  it("throws on an unknown tone or a blank message", () => {
    expect(() => ov.toast("x", { tone: "loud" })).toThrow(/tone/);
    expect(() => ov.toast(" ")).toThrow(/message/);
  });
});

describe("the module, its CSS and the pages", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("exports exactly the six functions", () => {
    expect(Object.keys(ov).filter((k) => typeof ov[k] === "function").sort()).toEqual(["dialog", "drawer", "menu", "tabs", "toast", "tooltip"]);
  });

  it("reuses tabStops and trapTarget from dom.js and uses no inline style", () => {
    const src = read("ui/kit/overlays.js");
    expect(kitSourceProblems(src)).toEqual([]);
    expect(src).not.toContain("function tabStops");
    expect(src).not.toContain("function trapTarget");
    expect(src).toMatch(/import \{[^}]*tabStops[^}]*\} from "\.\.\/dom\.js"/);
    expect(src).toMatch(/import \{[^}]*trapTarget[^}]*\} from "\.\.\/dom\.js"/);
  });

  it("overlays.css has only kit selectors, tokens and no colour literals", () => {
    expect(kitCssProblems(read("ui/kit/overlays.css"), tokenNames())).toEqual([]);
  });

  it("overlays.css has the hidden rules, the narrow drawer and layer tokens for every z-index", () => {
    const css = read("ui/kit/overlays.css");
    for (const sel of [".scf-menu__list[hidden]", ".scf-tooltip__bubble[hidden]", ".scf-tabs__panel[hidden]"]) expect(css, sel).toContain(sel);
    expect(css).toMatch(/@media \(max-width: 760px\) \{[^@]*\.scf-drawer \{ width: 100%; \}/);
    for (const m of css.matchAll(/z-index:\s*([^;]+);/g)) expect(m[1], m[0]).toMatch(/^var\(--layer-/);
    expect(css).toMatch(/\.scf-tooltip__bubble \{[^}]*overflow-wrap: anywhere/);
  });

  it("all three pages have #modal-root, and the gallery one is outside the frame", () => {
    for (const p of ["ui/index.html", "ui/user/index.html", "ui/gallery/index.html"]) expect(read(p), p).toContain('id="modal-root"');
  });

  it("old modal and toast in dom.js still work", async () => {
    const o = opener();
    const done = dom.modal("Old", () => dom.h("p", {}, "x"));
    expect(rootEl().children.length).toBe(1);
    keydown("Escape");
    await done;
    expect(active()).toBe(o);
    dom.toast("hello");
    expect((document.getElementById("toast") as unknown as FakeElement).textContent).toBe("hello");
    await flush();
  });
});
