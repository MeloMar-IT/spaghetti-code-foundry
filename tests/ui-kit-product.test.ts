import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { kitCssImports, kitCssProblems, kitSourceProblems, tokenNames } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let p: any;
let dom: any;

beforeAll(async () => {
  restore = installFakeDom();
  p = await import("../ui/kit/product.js" as string);
  dom = await import("../ui/dom.js" as string);
});
afterAll(() => restore());

const doc = () => document as any;
const rootEl = () => document.getElementById("modal-root") as unknown as FakeElement;
const body = () => document.body as unknown as FakeElement;
const active = () => doc().activeElement as FakeElement | null;
const count = (type: string) => (doc().listeners[type] ?? []).length;
const keydown = (key: string) => {
  const e = { key, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  for (const fn of [...(doc().listeners.keydown ?? [])]) fn(e);
  return e;
};
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const opener = (text = "open") => {
  const b = dom.h("button", {}, text) as FakeElement;
  body().append(b);
  b.focus();
  return b;
};
const btns = (el: FakeElement, label?: string) => el.all("button").filter((b) => label === undefined || b.textContent === label || b.getAttribute("aria-label") === label);
const closeButton = (el: FakeElement) => btns(el, "Close")[0]!;
const classOf = (el: FakeElement) => (el.getAttribute("class") ?? "").split(" ");
const walk = (el: FakeElement): FakeElement[] => [el, ...el.children.flatMap((c) => (c instanceof FakeElement ? walk(c) : []))];
const byClass = (el: FakeElement, cls: string) => walk(el).filter((e) => classOf(e).includes(cls));
const deferred = () => {
  let resolve!: (v?: unknown) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

afterEach(() => {
  for (let i = 0; i < 10 && count("keydown"); i++) keydown("Escape");
  rootEl().replaceChildren();
  body().replaceChildren();
  doc().activeElement = null;
  expect(count("keydown")).toBe(0);
  expect(count("mousedown")).toBe(0);
});

describe("pageHeader", () => {
  it("is a header with one h1 and nothing else when only a title is given", () => {
    const el = p.pageHeader({ title: "Runs" }) as FakeElement;
    expect(el.tag).toBe("header");
    expect(el.all("h1").map((x) => x.textContent)).toEqual(["Runs"]);
    expect(el.all("a")).toEqual([]);
    expect(byClass(el, "scf-page-header__actions")).toEqual([]);
  });
  it("puts the back link first and fills meta and actions", () => {
    const meta = dom.h("span", {}, "meta");
    const act = dom.h("button", {}, "Go");
    const el = p.pageHeader({ title: "Run", back: { label: "Back", href: "#/runs" }, meta, actions: act }) as FakeElement;
    const first = el.children[0] as FakeElement;
    expect(first.tag).toBe("a");
    expect(first.getAttribute("href")).toBe("#/runs");
    expect(first.textContent).toBe("Back");
    expect(byClass(el, "scf-page-header__meta")[0]!.children).toContain(meta);
    expect(byClass(el, "scf-page-header__actions")[0]!.children).toContain(act);
    expect(audit(el)).toEqual([]);
  });
  it("throws on bad input", () => {
    expect(() => p.pageHeader({ title: " " })).toThrow();
    expect(() => p.pageHeader({ title: "x", back: { href: "#/a" } })).toThrow();
    expect(() => p.pageHeader({ title: "x", back: { label: "Back", href: "javascript:alert(1)" } })).toThrow();
    expect(() => p.pageHeader({ title: "x", style: {} })).toThrow();
  });
});

describe("statusSummary", () => {
  const dds = (el: FakeElement) => el.all("dd");
  it("is a dl with matching dt and dd, and shows 0", () => {
    const el = p.statusSummary({ items: [{ label: "A", value: "one" }, { label: "B", value: 0 }] }) as FakeElement;
    expect(el.tag).toBe("dl");
    expect(el.all("dt").map((x) => x.textContent)).toEqual(["A", "B"]);
    expect(dds(el).map((x) => x.textContent)).toEqual(["one", "0"]);
    expect((p.statusSummary({ items: [] }) as FakeElement).children).toEqual([]);
  });
  it("makes an item with href a link, and one without a plain value", () => {
    const el = p.statusSummary({ items: [{ label: "A", value: "x", href: "#/a" }, { label: "B", value: "y" }, { label: "C", value: "z", href: "runs/1?x=1" }] }) as FakeElement;
    expect(dds(el)[0]!.all("a")[0]!.getAttribute("href")).toBe("#/a");
    expect(dds(el)[1]!.all("a")).toEqual([]);
    expect(dds(el)[2]!.all("a").length).toBe(1);
  });
  it("draws a tone as a badge, inside the link when there is one", () => {
    const el = p.statusSummary({ items: [{ label: "A", value: "bad", tone: "fail" }, { label: "B", value: "bad", tone: "fail", href: "#/b" }] }) as FakeElement;
    expect(byClass(dds(el)[0]!, "scf-badge--fail").length).toBe(1);
    expect(byClass(dds(el)[1]!.all("a")[0]!, "scf-badge--fail").length).toBe(1);
  });
  it("marks an external link and drops an unsafe one", () => {
    const el = p.statusSummary({ items: [{ label: "A", value: "x", href: "https://example.test/" }, { label: "B", value: "y", href: "javascript:alert(1)" }, { label: "C", value: "z", href: "HTTPS://example.test/" }] }) as FakeElement;
    const a = dds(el)[0]!.all("a")[0]!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.textContent).toContain("(opens a new tab)");
    expect(dds(el)[1]!.all("a")).toEqual([]);
    expect(dds(el)[2]!.all("a").length).toBe(1);
  });
  it("throws on bad input", () => {
    expect(() => p.statusSummary({ items: "x" })).toThrow();
    expect(() => p.statusSummary({ items: [{ label: " ", value: "x" }] })).toThrow();
    expect(() => p.statusSummary({ items: [{ label: "A" }] })).toThrow();
    expect(() => p.statusSummary({ items: [{ label: "A", value: "x", tone: "loud" }] })).toThrow();
  });
});

describe("nextAction", () => {
  it("is a section with the default heading, who and text", () => {
    const el = p.nextAction({ who: "You", text: "Do it." }) as FakeElement;
    expect(el.tag).toBe("section");
    expect(el.all("h2").map((x) => x.textContent)).toEqual(["What happens next"]);
    expect(byClass(el, "scf-badge")[0]!.textContent).toBe("You");
    expect(el.textContent).toContain("Do it.");
    expect(el.all("button")).toEqual([]);
    const h3 = p.nextAction({ who: "You", text: "x", heading: "Next", level: 3 }) as FakeElement;
    expect(h3.all("h3").map((x) => x.textContent)).toEqual(["Next"]);
  });
  it("has at most one primary button that calls onClick", () => {
    const onClick = vi.fn();
    const el = p.nextAction({ who: "You", text: "x", action: { label: "Approve", onClick } }) as FakeElement;
    expect(el.all("button").length).toBe(1);
    expect(classOf(el.all("button")[0]!)).toContain("scf-btn--primary");
    el.all("button")[0]!.click();
    expect(onClick).toHaveBeenCalledOnce();
  });
  it("takes `where` in the server shape { label, url }", () => {
    const linked = p.nextAction({ who: "You", text: "x", where: { label: "Plan", url: "#/runs/1" } }) as FakeElement;
    expect(linked.all("a")[0]!.getAttribute("href")).toBe("#/runs/1");
    const ext = p.nextAction({ who: "You", text: "x", where: { label: "PR", url: "https://example.test/pr" } }) as FakeElement;
    expect(ext.all("a")[0]!.getAttribute("target")).toBe("_blank");
    for (const where of [{ label: "Here" }, { label: "Here", url: "javascript:alert(1)" }, { label: "Here", url: "runs/1" }]) {
      const el = p.nextAction({ who: "You", text: "x", where }) as FakeElement;
      expect(el.all("a")).toEqual([]);
      expect(el.textContent).toContain("Here");
    }
  });
  it("tones the card and the badge", () => {
    const el = p.nextAction({ who: "Something is wrong", text: "x", tone: "fail" }) as FakeElement;
    expect(byClass(el, "scf-card--fail").length + (classOf(el).includes("scf-card--fail") ? 1 : 0)).toBeGreaterThan(0);
    expect(byClass(el, "scf-badge--fail").length).toBe(1);
  });
  it("throws on bad input", () => {
    expect(() => p.nextAction({ who: " ", text: "x" })).toThrow();
    expect(() => p.nextAction({ who: "You", text: "" })).toThrow();
    expect(() => p.nextAction({ who: "You", text: "x", action: { label: "Go" } })).toThrow();
    expect(() => p.nextAction({ who: "You", text: "x", tone: "loud" })).toThrow();
  });
  it("does not use ui/next.js", () => {
    expect(readFileSync("ui/kit/product.js", "utf8")).not.toContain("next.js");
  });
});

describe("filters", () => {
  const FIELDS = [
    { name: "q", label: "Search" },
    { name: "state", label: "State", type: "select", options: ["open", "closed"] },
    { name: "mine", label: "Only mine", type: "checkbox" },
  ];
  const make = (extra: Record<string, unknown> = {}) => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    const el = p.filters({ label: "Filter runs", fields: FIELDS, onChange, onClear, ...extra }) as FakeElement;
    return { el, onChange, onClear, input: el.all("input").find((i) => i.getAttribute("type") === "search")!, sel: el.all("select")[0]!, check: el.all("input").find((i) => i.getAttribute("type") === "checkbox")!, clear: byClass(el, "scf-filters__clear")[0]! };
  };

  it("is a named search form with a labelled control per field", () => {
    const { el } = make();
    expect(el.tag).toBe("form");
    expect(el.getAttribute("role")).toBe("search");
    expect(el.getAttribute("aria-label")).toBe("Filter runs");
    expect(el.all("input").length + el.all("select").length).toBe(3);
    // The text input and the select are labelled with for/id; the checkbox sits inside its label.
    const labels = el.all("label");
    for (const c of [...el.all("input").filter((i) => i.getAttribute("type") !== "checkbox"), ...el.all("select")]) {
      const id = c.getAttribute("id");
      expect(id).toBeTruthy();
      expect(labels.some((l) => l.getAttribute("for") === id)).toBe(true);
    }
    expect(audit(el).filter((v) => v.rule !== "field-label")).toEqual([]);
  });
  it("hides Clear when nothing is set", () => {
    expect(make().clear.hidden).toBe(true);
    expect(make({ value: { q: "  ", mine: false } }).clear.hidden).toBe(true);
  });
  it("shows Clear and the value when a filter is set", () => {
    const { clear, input } = make({ value: { q: "abc" } });
    expect(clear.hidden).toBe(false);
    expect(input.value).toBe("abc");
  });
  it("reports typing, select and checkbox changes", () => {
    const { input, sel, check, clear, onChange } = make();
    input.value = "x";
    input.fire("input");
    expect(onChange).toHaveBeenLastCalledWith({ q: "x", state: "", mine: false }, "q");
    expect(clear.hidden).toBe(false);
    sel.value = "open";
    sel.fire("change");
    expect(onChange).toHaveBeenLastCalledWith({ q: "x", state: "open", mine: false }, "state");
    check.checked = true;
    check.fire("change");
    expect(onChange).toHaveBeenLastCalledWith({ q: "x", state: "open", mine: true }, "mine");
  });
  it("Clear resets the controls, calls onClear only and focuses the first control", () => {
    const { input, sel, check, clear, onChange, onClear } = make({ value: { q: "abc", state: "open", mine: true } });
    clear.click();
    expect([input.value, sel.value, check.checked]).toEqual(["", "", false]);
    expect(clear.hidden).toBe(true);
    expect(onClear).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(active()).toBe(input);
  });
  it("without onClear, Clear reports the empty value through onChange", () => {
    const { clear, onChange } = make({ value: { q: "abc" }, onClear: undefined });
    clear.click();
    expect(onChange).toHaveBeenCalledWith({ q: "", state: "", mine: false });
  });
  it("stops a submit and shows a field error", () => {
    const { el } = make({ fields: [{ name: "q", label: "Search", error: "Too short." }] });
    const e = { preventDefault: vi.fn() };
    el.fire("submit", e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(el.all("div").find((d) => d.getAttribute("role") === "alert")!.textContent).toBe("Too short.");
  });
  it("ties a checkbox error to the checkbox", () => {
    const { el, check } = make({ fields: [{ name: "mine", label: "Only mine", type: "checkbox", error: "Not allowed." }] });
    const alert = el.all("div").find((d) => d.getAttribute("role") === "alert")!;
    expect(check.getAttribute("aria-invalid")).toBe("true");
    expect(check.getAttribute("aria-describedby")).toBe(alert.getAttribute("id"));
    expect(alert.getAttribute("id")).toBeTruthy();
  });
  it("uses only standard DOM calls on its elements (no test-only helpers)", () => {
    expect(readFileSync("ui/kit/product.js", "utf8")).not.toMatch(/\.all\(/);
  });
  it("throws on bad input", () => {
    const ok = () => undefined;
    expect(() => p.filters({ label: " ", fields: FIELDS, onChange: ok })).toThrow();
    expect(() => p.filters({ label: "F", fields: [], onChange: ok })).toThrow();
    expect(() => p.filters({ label: "F", fields: [FIELDS[0], FIELDS[0]], onChange: ok })).toThrow();
    expect(() => p.filters({ label: "F", fields: [{ name: "a", label: "A", type: "date" }], onChange: ok })).toThrow();
    expect(() => p.filters({ label: "F", fields: FIELDS, onChange: "x" })).toThrow();
  });
});

describe("entityLink", () => {
  const TEXT: Record<string, string> = { run: "Run", repo: "Repository", issue: "Issue", pr: "Pull request", flow: "Flow", user: "User" };
  it("is a link with the kind as visually hidden text, for every kind", () => {
    for (const [kind, text] of Object.entries(TEXT)) {
      const el = p.entityLink({ kind, id: "5", label: "Thing", href: "#/x" }) as FakeElement;
      expect(el.tag).toBe("a");
      expect(el.getAttribute("href")).toBe("#/x");
      expect(byClass(el, "scf-visually-hidden")[0]!.textContent).toBe(text);
    }
  });
  it("shows the kind when asked", () => {
    const el = p.entityLink({ kind: "pr", id: "5", href: "#/x", showKind: true }) as FakeElement;
    expect(byClass(el, "scf-entity-link__kind")[0]!.textContent).toBe("Pull request");
    expect(byClass(el, "scf-visually-hidden")).toEqual([]);
  });
  it("is plain text without an href or with an unsafe one", () => {
    for (const href of [undefined, "", "javascript:alert(1)", "//evil.test"]) {
      const el = p.entityLink({ kind: "repo", label: "Secret", href }) as FakeElement;
      expect(el.tag).toBe("span");
      expect(walk(el).some((e) => e.tag === "a")).toBe(false);
      expect(classOf(el)).toContain("scf-entity-link--plain");
      expect(el.textContent).toContain("Repository");
      expect(el.textContent).toContain("Secret");
    }
  });
  it("opens an external link in a new tab safely", () => {
    const el = p.entityLink({ kind: "pr", id: "1", href: "https://example.test/1" }) as FakeElement;
    expect(el.getAttribute("target")).toBe("_blank");
    expect(el.getAttribute("rel")).toBe("noopener noreferrer");
  });
  it("takes an id, a label or both, with the id first", () => {
    expect((p.entityLink({ kind: "run", id: 7 }) as FakeElement).textContent).toContain("7");
    expect((p.entityLink({ kind: "run", label: "Name" }) as FakeElement).textContent).toContain("Name");
    const both = (p.entityLink({ kind: "run", id: "7", label: "Name" }) as FakeElement).textContent;
    expect(both.indexOf("7")).toBeLessThan(both.indexOf("Name"));
  });
  it("throws on an unknown kind and on nothing to show", () => {
    expect(() => p.entityLink({ kind: "team", id: "1" })).toThrow();
    expect(() => p.entityLink({ kind: "run" })).toThrow();
  });
});

describe("confirmDestructive", () => {
  const open = (extra: Record<string, unknown> = {}) => {
    const send = vi.fn(() => Promise.resolve());
    const o = opener();
    const result = p.confirmDestructive({ title: "Delete it?", text: "No undo.", send, ...extra }) as Promise<boolean>;
    const root = rootEl();
    return {
      o, send, result, root,
      cancel: () => btns(root, "Cancel")[0]!,
      danger: () => btns(root, "Delete")[0]!,
      form: () => root.all("form")[0]!,
      input: () => root.all("input")[0]!,
    };
  };
  const state = (promise: Promise<unknown>) => Promise.race([promise.then((v) => `done:${v}`), flush().then(() => "pending")]);

  it("opens an accessible dialog with the title, text and default labels", () => {
    const t = open();
    const dlg = t.root.all("div").find((d) => d.getAttribute("role") === "dialog")!;
    expect(dlg).toBeTruthy();
    expect(dlg.textContent).toContain("Delete it?");
    expect(dlg.textContent).toContain("No undo.");
    expect(t.cancel()).toBeTruthy();
    expect(t.danger()).toBeTruthy();
    expect(audit(t.root).filter((v) => v.rule !== "field-label")).toEqual([]);
    t.cancel().click();
  });
  it("starts with the focus on Cancel, also with typeToConfirm, without focusing anything else first", () => {
    const seen: unknown[] = [];
    const orig = FakeElement.prototype.focus;
    FakeElement.prototype.focus = function (this: FakeElement) { seen.push(this); orig.call(this); };
    try {
      for (const typeToConfirm of [undefined, "name"]) {
        seen.length = 0;
        const t = open({ typeToConfirm });
        expect(active()).toBe(t.cancel());
        expect(seen.filter((x) => x !== t.o)).toEqual([t.cancel()]);
        t.cancel().click();
      }
    } finally {
      FakeElement.prototype.focus = orig;
    }
  });
  it("Cancel and Escape resolve false without calling send", async () => {
    const a = open();
    a.cancel().click();
    expect(await a.result).toBe(false);
    const b = open();
    keydown("Escape");
    expect(await b.result).toBe(false);
    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).not.toHaveBeenCalled();
  });
  it("resolves true after a successful send and removes the dialog; focus returns to the opener", async () => {
    const t = open();
    t.form().fire("submit", {});
    expect(await t.result).toBe(true);
    expect(t.send).toHaveBeenCalledOnce();
    expect(t.root.children).toEqual([]);
    expect(active()).toBe(t.o);
  });
  it("keeps the danger button off until typeToConfirm matches", async () => {
    const t = open({ typeToConfirm: "my-repo" });
    expect(t.danger().disabled).toBe(true);
    t.input().value = "my-rep";
    t.input().fire("input");
    expect(t.danger().disabled).toBe(true);
    t.form().fire("submit", {});
    expect(t.send).not.toHaveBeenCalled();
    t.input().value = "my-repo";
    t.input().fire("input");
    expect(t.danger().disabled).toBe(false);
    t.input().value = "my-repox";
    t.input().fire("input");
    expect(t.danger().disabled).toBe(true);
    for (const wrong of [" my-repo", "my-repo ", " my-repo "]) {
      t.input().value = wrong;
      t.input().fire("input");
      expect(t.danger().disabled, wrong).toBe(true);
    }
    t.input().value = "my-repo";
    t.input().fire("input");
    t.form().fire("submit", {});
    expect(await t.result).toBe(true);
  });
  it("shows a refused send in the dialog, stays open, and a retry clears the error", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("Refused.")).mockResolvedValue(undefined);
    const t = open({ send });
    t.form().fire("submit", {});
    expect(await state(t.result)).toBe("pending");
    expect(t.root.children.length).toBe(1);
    const alert = () => t.root.all("div").filter((d) => d.getAttribute("role") === "alert");
    expect(alert()[0]!.textContent).toContain("Refused.");
    for (const b of [t.cancel(), t.danger()]) expect(b.getAttribute("aria-disabled")).toBeNull();
    t.form().fire("submit", {});
    expect(alert()).toEqual([]);
    expect(await t.result).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("says it could not reach the server for a TypeError", async () => {
    const t = open({ send: () => Promise.reject(new TypeError("fetch failed")) });
    t.form().fire("submit", {});
    await flush();
    expect(t.root.textContent).toContain("Could not reach the server.");
    t.cancel().click();
    await t.result;
  });
  it("cannot be closed or submitted again while the call is out", async () => {
    const d = deferred();
    const send = vi.fn(() => d.promise);
    const t = open({ send });
    t.form().fire("submit", {});
    keydown("Escape");
    closeButton(t.root).click();
    t.root.children[0]!.fire("mousedown", { target: t.root.children[0], currentTarget: t.root.children[0] });
    t.cancel().click();
    t.form().fire("submit", {});
    expect(await state(t.result)).toBe("pending");
    expect(t.root.children.length).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(t.cancel().getAttribute("aria-disabled")).toBe("true");
    expect(t.danger().getAttribute("aria-disabled")).toBe("true");
    expect(t.danger().getAttribute("aria-busy")).toBe("true");
    d.resolve();
    expect(await t.result).toBe(true);
    expect(t.root.children).toEqual([]);
    expect(count("keydown")).toBe(0);
  });
  it("throws on bad input", () => {
    expect(() => p.confirmDestructive({ title: "x" })).toThrow();
    expect(() => p.confirmDestructive({ title: " ", send: () => undefined })).toThrow();
    expect(() => p.confirmDestructive({ title: "x", send: () => undefined, typeToConfirm: "" })).toThrow();
  });
});

describe("the module and its CSS", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("exports exactly the six components", () => {
    expect(Object.keys(p).sort()).toEqual(["confirmDestructive", "entityLink", "filters", "nextAction", "pageHeader", "statusSummary"]);
  });
  it("has no inline styles and imports only the dom helper and kit modules", () => {
    const src = read("ui/kit/product.js");
    expect(kitSourceProblems(src)).toEqual([]);
    const imports = [...src.matchAll(/import[^;]*?from "([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i).toMatch(/^\.\.\/dom\.js$|^\.\/(actions|display|forms|overlays|core)\.js$/);
  });
  it("product.css passes the selector and colour test, and is imported by kit.css", () => {
    const css = read("ui/kit/product.css");
    expect(kitCssProblems(css, tokenNames())).toEqual([]);
    expect(css.startsWith("/* ui/kit/product.css")).toBe(true);
    expect(css).toContain(".scf-filters__clear[hidden]");
    expect(kitCssImports()).toContain("/kit/product.css");
  });
});
