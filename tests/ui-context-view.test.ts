import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let v: any;
const doc = () => (globalThis as any).document;

beforeAll(async () => {
  restore = installFakeDom();
  v = await import("../ui/context-view.js" as string);
});
afterAll(() => restore());
beforeEach(() => {
  doc().listeners.keydown = [];
  doc().listeners.mousedown = [];
  doc().getElementById("modal-root").replaceChildren();
});

const handlers = () => ({ onToggle: vi.fn(), onClose: vi.fn(), onChoose: vi.fn(), onStar: vi.fn(), onSearch: vi.fn(), onRetry: vi.fn() });
const row = (group: string, name: string, extra: Record<string, unknown> = {}) => ({ group, name, label: name || "All repositories", own: true, favourite: group === "favourite", current: false, ...extra });
const sections = () => [
  { title: null, rows: [row("all", "", { current: true })] },
  { title: "Favourites", rows: [row("favourite", "a/b")] },
  { title: "Repositories", rows: [row("rest", "c/d")] },
];
const base = (extra: Record<string, unknown> = {}) => ({ state: "many", label: "All repositories", open: false, search: false, text: "", sections: [], ...extra });
const focusOf = (node: FakeElement, name: string) => node.querySelectorAll("[data-focus]").find((e) => e.getAttribute("data-focus") === name) as FakeElement;
const ids = (node: FakeElement) => node.querySelectorAll("[id]").map((e) => e.attrs.id);

describe("the module", () => {
  it("imports only glyph, h and mount from dom.js", () => {
    const src = readFileSync("ui/context-view.js", "utf8");
    expect([...src.matchAll(/^import (.*) from "([^"]+)";/gm)].map((m) => [m[1], m[2]])).toEqual([["{ glyph, h, mount }", "./dom.js"]]);
  });
});

describe("switcherView states", () => {
  it("failed: text and Retry", () => {
    const hs = handlers();
    const view = v.switcherView(base({ state: "failed" }), hs);
    expect(view.node.textContent).toContain("Repositories could not be loaded.");
    focusOf(view.node, "context-retry").click();
    expect(hs.onRetry).toHaveBeenCalledTimes(1);
    expect(doc().listeners.keydown).toHaveLength(0);
  });
  it("none: the text and a link to #/repos", () => {
    const view = v.switcherView(base({ state: "none" }), handlers());
    expect(view.node.textContent).toContain("No repository yet.");
    const a = focusOf(view.node, "context-add");
    expect(a.tag).toBe("a");
    expect(a.attrs.href).toBe("#/repos");
    expect(a.textContent).toBe("Add one");
  });
  it("one: a label and no button", () => {
    const view = v.switcherView(base({ state: "one", label: "a/b" }), handlers());
    expect(view.node.querySelectorAll("button")).toHaveLength(0);
    expect(view.node.textContent).toBe("a/b");
  });
});

describe("switcherView, many", () => {
  it("closed: a trigger, no panel, no listeners", () => {
    const hs = handlers();
    const view = v.switcherView(base({ label: "a/b" }), hs);
    const btn = focusOf(view.node, "context-btn");
    expect(btn.attrs["aria-haspopup"]).toBe("true");
    expect(btn.attrs["aria-expanded"]).toBe("false");
    expect(btn.textContent).toContain("Repository: ");
    expect(btn.textContent).toContain("a/b");
    expect(ids(view.node)).not.toContain("context-panel");
    expect(doc().listeners.keydown).toHaveLength(0);
    expect(doc().listeners.mousedown).toHaveLength(0);
    btn.click();
    expect(hs.onToggle).toHaveBeenCalledTimes(1);
  });
  it("open: rows, stars, current and clicks", () => {
    const hs = handlers();
    const view = v.switcherView(base({ open: true, sections: sections() }), hs);
    const panel = view.node.querySelector("div[id]") as FakeElement;
    expect(panel.attrs.id).toBe("context-panel");
    expect(panel.attrs.role).toBe("group");
    expect(panel.attrs["aria-label"]).toBe("Repositories");
    expect(focusOf(view.node, "context-btn").attrs["aria-expanded"]).toBe("true");
    expect(focusOf(view.node, "context-item-all").attrs["aria-current"]).toBe("true");
    expect(focusOf(view.node, "context-item-a/b").attrs["aria-current"]).toBeUndefined();
    expect(focusOf(view.node, "context-star-undefined")).toBeUndefined();
    expect(view.node.querySelectorAll("[data-focus]").filter((e) => e.attrs["data-focus"].startsWith("context-star-"))).toHaveLength(2);
    const star = focusOf(view.node, "context-star-a/b");
    expect(star.attrs["aria-pressed"]).toBe("true");
    expect(star.attrs["aria-label"]).toBe("Favourite a/b");
    expect(focusOf(view.node, "context-star-c/d").attrs["aria-pressed"]).toBe("false");
    focusOf(view.node, "context-item-all").click();
    expect(hs.onChoose).toHaveBeenCalledWith("");
    focusOf(view.node, "context-item-c/d").click();
    expect(hs.onChoose).toHaveBeenCalledWith("c/d");
    star.click();
    expect(hs.onStar).toHaveBeenCalledWith("a/b");
  });
  it("search: only when asked, and it reports the text", () => {
    const hs = handlers();
    expect(focusOf(v.switcherView(base({ open: true, sections: sections() }), hs).node, "context-search")).toBeUndefined();
    const view = v.switcherView(base({ open: true, search: true, text: "q", sections: sections() }), hs);
    const input = focusOf(view.node, "context-search");
    expect(input.attrs["aria-label"]).toBe("Find a repository");
    expect(input.attrs.type).toBe("search");
    expect(input.value).toBe("q");
    input.value = "x";
    input.fire("input");
    expect(hs.onSearch).toHaveBeenCalledWith("x");
  });
  it("update remounts the list only, keeps the input and the focus on the star", () => {
    const view = v.switcherView(base({ open: true, search: true, sections: sections() }), handlers());
    const input = focusOf(view.node, "context-search");
    focusOf(view.node, "context-star-c/d").focus();
    const next = sections();
    next[2].rows[0] = row("rest", "c/d", { favourite: true });
    view.update(base({ open: true, search: true, sections: next }));
    expect(focusOf(view.node, "context-search")).toBe(input);
    expect(doc().activeElement).toBe(focusOf(view.node, "context-star-c/d"));
    expect(doc().activeElement.attrs["aria-pressed"]).toBe("true");
    view.update(base({ open: true, search: true, sections: [] }));
    expect(view.node.textContent).toContain("No repository matches.");
    expect(focusOf(view.node, "context-search")).toBe(input);
  });
});

describe("switcherView compact placement", () => {
  const stubWindow = (compact: boolean) => {
    const frames = new Map<number, () => void>();
    const win = {
      matchMedia: () => ({ matches: compact }),
      requestAnimationFrame: (fn: () => void) => { frames.set(frames.size + 1, fn); return frames.size; },
      cancelAnimationFrame: vi.fn((id: number) => frames.delete(id)),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("window", win);
    return { win, frames };
  };
  afterEach(() => vi.unstubAllGlobals());

  it("puts the panel under the wrapped header without a resize, once it is mounted", () => {
    const { frames } = stubWindow(true);
    const header = new FakeElement("header");
    (header as any).getBoundingClientRect = () => ({ bottom: 90.4 });
    const view = v.switcherView(base({ open: true, sections: sections() }), handlers());
    const panel = view.node.querySelector("div[id]") as FakeElement;
    header.append(view.node); // mounted after the view was built
    expect(panel.style.top).toBeUndefined();
    frames.forEach((f) => f());
    expect(panel.style.top).toBe("90px");
  });
  it("leaves the top alone on a wide screen, and cleanup cancels the frame and the listeners", () => {
    const { win, frames } = stubWindow(false);
    const header = new FakeElement("header");
    (header as any).getBoundingClientRect = () => ({ bottom: 90 });
    const view = v.switcherView(base({ open: true, sections: sections() }), handlers());
    header.append(view.node);
    frames.forEach((f) => f());
    expect((view.node.querySelector("div[id]") as FakeElement).style.top).toBe("");
    view.cleanup();
    expect(win.cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(win.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(win.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
});

describe("switcherView listeners", () => {
  const open = (hs = handlers()) => ({ hs, view: v.switcherView(base({ open: true, sections: sections() }), hs) });
  it("Escape closes with focus, unless a dialog is open; other keys do nothing", () => {
    const { hs } = open();
    const key = (k: string) => doc().listeners.keydown.forEach((f: any) => f({ key: k }));
    key("a");
    expect(hs.onClose).not.toHaveBeenCalled();
    key("Escape");
    expect(hs.onClose).toHaveBeenCalledWith({ focus: true });
    hs.onClose.mockClear();
    doc().getElementById("modal-root").append(new FakeElement("div"));
    key("Escape");
    expect(hs.onClose).not.toHaveBeenCalled();
  });
  it("a mousedown outside closes without focus; inside does nothing", () => {
    const { hs, view } = open();
    const down = (target: unknown) => doc().listeners.mousedown.forEach((f: any) => f({ target }));
    down(focusOf(view.node, "context-item-all"));
    expect(hs.onClose).not.toHaveBeenCalled();
    down(new FakeElement("div"));
    expect(hs.onClose).toHaveBeenCalledWith({ focus: false });
  });
  it("cleanup removes both, twice is fine", () => {
    const { view } = open();
    expect(doc().listeners.keydown).toHaveLength(1);
    expect(doc().listeners.mousedown).toHaveLength(1);
    view.cleanup();
    view.cleanup();
    expect(doc().listeners.keydown).toHaveLength(0);
    expect(doc().listeners.mousedown).toHaveLength(0);
  });
});
