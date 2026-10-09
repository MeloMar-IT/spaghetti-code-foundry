import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let dom: any;

beforeAll(async () => {
  restore = installFakeDom();
  dom = await import("../ui/dom.js" as string);
});
afterAll(() => restore());

const doc = () => document as any;
const el = (id: string) => document.getElementById(id) as unknown as FakeElement;
const keydown = (key: string, shiftKey = false) => {
  const e = { key, shiftKey, preventDefault: vi.fn() };
  for (const fn of [...(doc().listeners.keydown ?? [])]) fn(e);
  return e;
};

beforeEach(() => {
  restore();
  restore = installFakeDom();
});

describe("trapTarget", () => {
  const [a, b, c] = ["a", "b", "c"].map((t) => ({ t }));
  it("wraps from the last stop to the first, and from the first back to the last", () => {
    expect(dom.trapTarget([a, b, c], c, false)).toBe(a);
    expect(dom.trapTarget([a, b, c], a, true)).toBe(c);
  });
  it("leaves the middle to the browser", () => {
    expect(dom.trapTarget([a, b, c], b, false)).toBeNull();
    expect(dom.trapTarget([a, b, c], b, true)).toBeNull();
    expect(dom.trapTarget([a, b, c], a, false)).toBeNull();
    expect(dom.trapTarget([a, b, c], c, true)).toBeNull();
  });
  it("brings the focus in when it is outside", () => {
    expect(dom.trapTarget([a, b, c], { t: "x" }, false)).toBe(a);
    expect(dom.trapTarget([a, b, c], { t: "x" }, true)).toBe(c);
    expect(dom.trapTarget([a, b, c], null, false)).toBe(a);
  });
  it("is null without stops", () => {
    expect(dom.trapTarget([], null, false)).toBeNull();
  });
});

describe("tabStops", () => {
  it("leaves out a disabled control and tabindex -1, and keeps page order", () => {
    const off = dom.h("button", {}, "off");
    off.disabled = true;
    const box = dom.h("div", {}, dom.h("a", { href: "#/x" }, "link"), off, dom.h("input", {}), dom.h("button", { tabindex: "-1" }, "skip"), dom.h("div", { tabindex: "0" }), dom.h("button", {}, "last"));
    expect(dom.tabStops(box).map((e: FakeElement) => e.tag)).toEqual(["a", "input", "div", "button"]);
  });
  it("leaves out an anchor without href", () => {
    const box = dom.h("div", {}, dom.h("a", {}, "no"), dom.h("button", {}, "yes"));
    expect(dom.tabStops(box).map((e: FakeElement) => e.tag)).toEqual(["button"]);
  });
});

describe("modal", () => {
  it("focuses the first input and has the dialog attributes", async () => {
    const input = dom.h("input", {});
    void dom.modal("Title", () => dom.h("form", {}, input));
    expect(doc().activeElement).toBe(input);
    const box = el("modal-root").querySelector("div[role]") as FakeElement;
    expect(box.attrs.role).toBe("dialog");
    expect(box.attrs["aria-modal"]).toBe("true");
    expect(box.attrs.tabindex).toBe("-1");
    expect(box.attrs["aria-label"]).toBeUndefined();
    const h2 = el("modal-root").querySelector("h2") as FakeElement;
    expect(h2.textContent).toBe("Title");
    expect(h2.attrs.id).toBeTruthy();
    expect(box.attrs["aria-labelledby"]).toBe(h2.attrs.id);
  });

  it("gives each dialog its own title id", () => {
    void dom.modal("Title", () => dom.h("p", {}, "x"));
    const first = (el("modal-root").querySelector("div[role]") as FakeElement).attrs["aria-labelledby"];
    keydown("Escape");
    void dom.modal("Title", () => dom.h("p", {}, "x"));
    const second = (el("modal-root").querySelector("div[role]") as FakeElement).attrs["aria-labelledby"];
    expect(first).toBeTruthy();
    expect(second).not.toBe(first);
  });

  describe("busy", () => {
    const open = (busy: () => boolean) => {
      const opener = dom.h("button", {}, "open");
      opener.focus();
      let done = false;
      void dom.modal("Title", () => dom.h("p", {}, "x"), { busy }).then(() => (done = true));
      const backdrop = el("modal-root").children[0] as FakeElement;
      const closeBtn = el("modal-root").querySelector("button") as FakeElement;
      return { opener, backdrop, closeBtn, isDone: () => done };
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const mousedown = (b: FakeElement) => b.fire("mousedown", { target: b, currentTarget: b });

    it("Escape, the close button and the backdrop do nothing while busy", async () => {
      let busy = true;
      const { backdrop, closeBtn, isDone } = open(() => busy);
      keydown("Escape");
      closeBtn.click();
      mousedown(backdrop);
      await flush();
      expect(isDone()).toBe(false);
      expect(el("modal-root").children).toHaveLength(1);
      busy = false;
      keydown("Escape");
      await flush();
      expect(isDone()).toBe(true);
    });

    it("the close button and the backdrop close it when not busy, and the focus returns to the opener", async () => {
      const a = open(() => false);
      a.closeBtn.click();
      await flush();
      expect(a.isDone()).toBe(true);
      expect(doc().activeElement).toBe(a.opener);
      const b = open(() => false);
      mousedown(b.backdrop);
      await flush();
      expect(b.isDone()).toBe(true);
      expect(doc().activeElement).toBe(b.opener);
    });
  });

  it("focuses the box when there is no input", () => {
    void dom.modal("Title", () => dom.h("p", {}, "text"));
    expect(doc().activeElement.attrs.role).toBe("dialog");
  });

  describe("Tab", () => {
    const open = () => {
      const buttons = [dom.h("button", {}, "one"), dom.h("button", {}, "two"), dom.h("button", {}, "three")];
      void dom.modal("Title", () => dom.h("div", {}, buttons));
      return [el("modal-root").querySelector("button") as FakeElement, ...buttons] as FakeElement[];
    };
    it("moves from the last stop to the first", () => {
      const [closeBtn, , , last] = open();
      last!.focus();
      const e = keydown("Tab");
      expect(e.preventDefault).toHaveBeenCalled();
      expect(doc().activeElement).toBe(closeBtn);
    });
    it("moves from the first stop to the last with Shift", () => {
      const [first, , , last] = open();
      first!.focus();
      const e = keydown("Tab", true);
      expect(e.preventDefault).toHaveBeenCalled();
      expect(doc().activeElement).toBe(last);
    });
    it("does nothing in the middle", () => {
      const [, , mid] = open();
      mid!.focus();
      const e = keydown("Tab");
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(doc().activeElement).toBe(mid);
    });
  });

  it("Escape resolves undefined, empties the root, removes the listener and focuses the opener", async () => {
    const opener = dom.h("button", {}, "open");
    opener.focus();
    const p = dom.modal("Title", () => dom.h("p", {}, "x"));
    expect(doc().listeners.keydown).toHaveLength(1);
    keydown("Escape");
    await expect(p).resolves.toBeUndefined();
    expect(el("modal-root").children).toHaveLength(0);
    expect(doc().listeners.keydown).toHaveLength(0);
    expect(doc().activeElement).toBe(opener);
  });

  it("close(value) resolves the value and focuses the opener", async () => {
    const opener = dom.h("button", {}, "open");
    opener.focus();
    let closeFn: (v: unknown) => void = () => {};
    const p = dom.modal("Title", (close: (v: unknown) => void) => {
      closeFn = close;
      return dom.h("p", {}, "x");
    });
    closeFn(7);
    await expect(p).resolves.toBe(7);
    expect(doc().activeElement).toBe(opener);
  });

  it("a late close after Escape does not touch a newer dialog or the focus", async () => {
    const opener = dom.h("button", {}, "open");
    opener.focus();
    let late: (v: unknown) => void = () => {};
    const first = dom.modal("One", (close: (v: unknown) => void) => {
      late = close;
      return dom.h("p", {}, "one");
    });
    keydown("Escape");
    await first;
    const other = dom.h("button", {}, "other");
    other.focus();
    const second = dom.modal("Two", () => dom.h("p", {}, "two"));
    late("x");
    expect(el("modal-root").children).toHaveLength(1);
    expect(doc().activeElement).not.toBe(opener);
    void second;
  });
});

describe("mount", () => {
  const draw = (name: string | null) => dom.h("div", {}, dom.h("button", name ? { "data-focus": name } : {}, "b"));
  it("keeps the focus on the control with the same name", () => {
    const target = dom.h("div", {});
    dom.mount(target, draw("add"));
    (target.querySelector("button") as FakeElement).focus();
    dom.mount(target, draw("add"));
    expect(doc().activeElement).toBe(target.querySelector("button"));
  });
  it("moves the focus to the first heading of the target when the control is gone", () => {
    const target = dom.h("div", {});
    dom.mount(target, dom.h("h2", {}, "Part"), draw("add"));
    (target.querySelector("button") as FakeElement).focus();
    dom.mount(target, dom.h("h2", {}, "Part"), draw("other"));
    const heading = target.querySelector("h2") as FakeElement;
    expect(doc().activeElement).toBe(heading);
    expect(heading.attrs.tabindex).toBe("-1");
  });
  it("uses a heading of the parent, else the target itself, when the target has none", () => {
    const parent = dom.h("section", {}, dom.h("h1", {}, "Page"));
    const target = dom.h("div", {});
    parent.append(target);
    dom.mount(target, draw("add"));
    (target.querySelector("button") as FakeElement).focus();
    dom.mount(target, draw("other"));
    expect(doc().activeElement).toBe(parent.querySelector("h1"));

    const alone = dom.h("div", {});
    dom.mount(alone, draw("add"));
    (alone.querySelector("button") as FakeElement).focus();
    dom.mount(alone, draw("other"));
    expect(doc().activeElement).toBe(alone);
    expect(alone.attrs.tabindex).toBe("-1");
  });
  it("does nothing when the focus was outside, or the control has no name", () => {
    const target = dom.h("div", {});
    dom.mount(target, draw("add"));
    const outside = dom.h("button", {});
    outside.focus();
    dom.mount(target, draw("add"));
    expect(doc().activeElement).toBe(outside);

    dom.mount(target, draw(null));
    (target.querySelector("button") as FakeElement).focus();
    const unnamed = doc().activeElement;
    dom.mount(target, draw(null));
    expect(doc().activeElement).toBe(unnamed);
  });
});

describe("toast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sets the text, and role alert for an error", () => {
    dom.toast("x", "error");
    expect(el("toast").textContent).toBe("x");
    expect(el("toast").attrs.role).toBe("alert");
  });
  it("uses role status for other kinds", () => {
    dom.toast("x");
    expect(el("toast").attrs.role).toBe("status");
    dom.toast("x", "ok");
    expect(el("toast").attrs.role).toBe("status");
  });
  it("an error followed by an info ends on status", () => {
    dom.toast("bad", "error");
    dom.toast("fine");
    expect(el("toast").attrs.role).toBe("status");
    expect(el("toast").textContent).toBe("fine");
  });
  it("an info toast shows for 3.5 s", () => {
    dom.toast("x");
    expect((el("toast") as any).className).toBe("show info");
    vi.advanceTimersByTime(3499);
    expect((el("toast") as any).className).toBe("show info");
    vi.advanceTimersByTime(1);
    expect((el("toast") as any).className).toBe("");
  });
  it("an error toast stays, has one Dismiss button without text, and the button hides it", () => {
    dom.toast("bad", "error");
    vi.advanceTimersByTime(60000);
    expect((el("toast") as any).className).toBe("show error");
    expect(el("toast").all("button")).toHaveLength(1);
    expect(el("toast").all("button")[0].attrs["aria-label"]).toBe("Dismiss");
    expect(el("toast").textContent).toBe("bad");
    expect(el("toast").attrs["aria-live"]).toBe("assertive");
    el("toast").all("button")[0].click();
    expect((el("toast") as any).className).toBe("");
    expect(el("toast").all("button")).toHaveLength(0);
  });
  it("sticky keeps an info toast but not its role", () => {
    dom.toast("keep", "info", { sticky: true });
    vi.advanceTimersByTime(60000);
    expect((el("toast") as any).className).toBe("show info");
    expect(el("toast").attrs.role).toBe("status");
    expect(el("toast").attrs["aria-live"]).toBe("polite");
  });
  it("a new toast replaces the old one and resets the timer", () => {
    dom.toast("a");
    vi.advanceTimersByTime(3000);
    dom.toast("b");
    vi.advanceTimersByTime(3000);
    expect((el("toast") as any).className).toBe("show info");
    vi.advanceTimersByTime(500);
    expect((el("toast") as any).className).toBe("");
    dom.toast("bad", "error");
    dom.toast("fine");
    vi.advanceTimersByTime(3500);
    expect((el("toast") as any).className).toBe("");
  });
  it("the same text within 5 s of its last call keeps the message node", () => {
    const opts = { sticky: true }; // stays open, so only the 5 s window decides
    dom.toast("x", "info", opts);
    const first = el("toast").children[0];
    vi.advanceTimersByTime(4000);
    dom.toast("x", "info", opts);
    expect(el("toast").children[0]).toBe(first);
    vi.advanceTimersByTime(4000); // 8 s after the first, 4 s after the last
    dom.toast("x", "info", opts);
    expect(el("toast").children[0]).toBe(first);
    vi.advanceTimersByTime(5000);
    dom.toast("x", "info", opts);
    expect(el("toast").children[0]).not.toBe(first);
  });
  it("a closed toast is empty, so nothing is left for a screen reader", () => {
    dom.toast("x");
    vi.advanceTimersByTime(3500);
    expect(el("toast").children).toHaveLength(0);
    expect(el("toast").textContent).toBe("");
  });
  it("the same text with other options keeps the node but updates the controls", () => {
    dom.toast("x");
    const first = el("toast").children[0];
    dom.toast("x", "error");
    expect(el("toast").children[0]).toBe(first);
    expect(el("toast").all("button")).toHaveLength(1);
    expect(el("toast").attrs.role).toBe("alert");
  });
  it("another text, or a toast cleared from outside, writes again", () => {
    dom.toast("x");
    const first = el("toast").children[0];
    dom.toast("y");
    expect(el("toast").children[0]).not.toBe(first);
    el("toast").textContent = "";
    dom.toast("y");
    expect(el("toast").textContent).toBe("y");
  });

  describe("action", () => {
    const button = () => el("toast").all("button")[0];
    it("draws the label, runs once, closes the toast and removes the button", async () => {
      const run = vi.fn();
      dom.toast("done", "info", { action: { label: "Undo", run } });
      expect(button().textContent).toBe("Undo");
      const b = button();
      b.click();
      b.click();
      await Promise.resolve();
      expect(run).toHaveBeenCalledTimes(1);
      expect((el("toast") as any).className).toBe("");
      expect(el("toast").all("button")).toHaveLength(0);
    });
    it("a repeated toast runs the newest action", async () => {
      const [a, b] = [vi.fn(), vi.fn()];
      dom.toast("done", "info", { action: { label: "Undo", run: a } });
      dom.toast("done", "info", { action: { label: "Undo", run: b } });
      button().click();
      await Promise.resolve();
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledTimes(1);
    });
    it("a failing action shows an error toast with its message", async () => {
      dom.toast("done", "info", { action: { label: "Undo", run: async () => { throw new Error("nope"); } } });
      button().click();
      await vi.advanceTimersByTimeAsync(0);
      expect(el("toast").textContent).toBe("nope");
      expect((el("toast") as any).className).toBe("show error");
    });
    it("gives the focus back to the opener, or to main when the action replaced it", async () => {
      const opener = dom.h("button", {}, "open");
      opener.focus();
      dom.toast("done", "info", { action: { label: "Undo", run: vi.fn() } });
      button().focus();
      button().click();
      await vi.advanceTimersByTimeAsync(0);
      expect(doc().activeElement).toBe(opener);

      opener.focus();
      dom.toast("done 2", "info", { action: { label: "Undo", run: async () => { (opener as any).isConnected = false; } } });
      button().focus();
      button().click();
      await vi.advanceTimersByTimeAsync(0);
      expect(doc().activeElement).toBe(document.getElementById("main"));
    });
  });
});

describe("confirmDialog", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const buttons = () => el("modal-root").all("button");
  const open = (opts: any = { title: "Delete it?", text: "Sure?" }) => {
    const opener = dom.h("button", {}, "open");
    opener.focus();
    return { opener, answer: dom.confirmDialog(opts) as Promise<boolean> };
  };
  it("starts on Cancel, with the default Delete button as danger", () => {
    open();
    const [, cancel, confirm] = buttons();
    expect(doc().activeElement).toBe(cancel);
    expect(cancel.textContent).toBe("Cancel");
    expect(confirm.textContent).toBe("Delete");
    expect(confirm.attrs.class).toBe("danger");
    expect(el("modal-root").all("h2")[0].textContent).toBe("Delete it?");
  });
  it("the confirm button resolves true and the focus returns", async () => {
    const { opener, answer } = open();
    buttons()[2].click();
    expect(await answer).toBe(true);
    expect(doc().activeElement).toBe(opener);
  });
  it("Cancel, Escape, the ✕ and the backdrop resolve false", async () => {
    let o = open();
    buttons()[1].click();
    expect(await o.answer).toBe(false);
    expect(doc().activeElement).toBe(o.opener);
    o = open();
    keydown("Escape");
    expect(await o.answer).toBe(false);
    o = open();
    buttons()[0].click();
    expect(await o.answer).toBe(false);
    o = open();
    const backdrop = el("modal-root").children[0] as FakeElement;
    backdrop.fire("mousedown", { target: backdrop, currentTarget: backdrop });
    expect(await o.answer).toBe(false);
    await flush();
  });
  it("takes the labels and a non-danger look", () => {
    open({ title: "t", text: "x", confirm: "Stop", cancel: "Keep it", danger: false });
    const [, cancel, confirm] = buttons();
    expect(cancel.textContent).toBe("Keep it");
    expect(confirm.textContent).toBe("Stop");
    expect(confirm.attrs.class).toBe("primary");
  });
});

describe("markInvalid, showError and fieldFor", () => {
  const field = () => new FakeElement("input");
  it("markInvalid marks one field and clears the others", () => {
    const [a, b] = [field(), field()];
    dom.markInvalid([a, b], a);
    expect(a.attrs["aria-invalid"]).toBe("true");
    expect(doc().activeElement).toBe(a);
    dom.markInvalid([a, b], b);
    expect(a.attrs["aria-invalid"]).toBeUndefined();
    expect(b.attrs["aria-invalid"]).toBe("true");
  });
  it("markInvalid without a field only clears, and keeps the focus", () => {
    const [a, b] = [field(), field()];
    dom.markInvalid([a, b], a);
    b.focus();
    dom.markInvalid([a, b]);
    expect(a.attrs["aria-invalid"]).toBeUndefined();
    expect(doc().activeElement).toBe(b);
    dom.markInvalid([a, undefined, null]);
  });
  it("showError writes the text and marks the field; an empty message clears both", () => {
    const [line, a] = [new FakeElement("p"), field()];
    dom.showError(line, "bad", { fields: [a], field: a });
    expect(line.textContent).toBe("bad");
    expect(a.attrs["aria-invalid"]).toBe("true");
    dom.showError(line, "", { fields: [a], field: a });
    expect(line.textContent).toBe("");
    expect(a.attrs["aria-invalid"]).toBeUndefined();
    dom.showError(line, "no field");
    expect(line.textContent).toBe("no field");
  });
  it("fieldFor returns the key of the first match, or undefined", () => {
    const pairs = [[/^a/, "first"], [/b/, "second"]];
    expect(dom.fieldFor("abc", pairs)).toBe("first");
    expect(dom.fieldFor("xbx", pairs)).toBe("second");
    expect(dom.fieldFor("zzz", pairs)).toBeUndefined();
    expect(dom.fieldFor(undefined, pairs)).toBeUndefined();
  });
});
