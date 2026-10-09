import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { kitCssProblems, kitSourceProblems, tokenNames } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let kit: any;
let h: any;

beforeAll(async () => {
  restore = installFakeDom();
  kit = await import("../ui/kit/display.js" as string);
  h = (await import("../ui/dom.js" as string)).h;
});
afterAll(() => restore());

const TONES = ["neutral", "ok", "fail", "run", "warn", "accent"];
const cls = (e: FakeElement) => e.getAttribute("class");
function* walk(el: FakeElement): Generator<FakeElement> {
  yield el;
  for (const c of el.children) if (c instanceof FakeElement) yield* walk(c);
}
const all = (el: FakeElement) => [...walk(el)];
const byClass = (el: FakeElement, c: string) => all(el).filter((e) => (cls(e) ?? "").split(" ").includes(c));
const COLS = [{ key: "name", label: "Name" }, { key: "n", label: "Count", align: "end" }];
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Row ${i + 1}`, n: i }));
const bodyRows = (t: FakeElement) => t.all("tbody")[0]!.all("tr");

describe("exports", () => {
  it("are exactly the seven components", () => {
    expect(Object.keys(kit).filter((k) => typeof kit[k] === "function").sort()).toEqual(["badge", "banner", "card", "emptyState", "list", "skeleton", "table"]);
  });
  it("every component refuses inline styles and puts the caller class last", () => {
    const make: Record<string, (p: any) => FakeElement> = {
      card: (p) => kit.card({ title: "T", ...p }, "x"),
      table: (p) => kit.table({ caption: "C", columns: COLS, rows: rows(1), ...p }),
      list: (p) => kit.list({ items: ["a"], ...p }),
      badge: (p) => kit.badge({ label: "L", ...p }),
      banner: (p) => kit.banner({ title: "T", ...p }),
      skeleton: (p) => kit.skeleton(p),
      emptyState: (p) => kit.emptyState({ title: "T", ...p }),
    };
    for (const [name, build] of Object.entries(make)) {
      expect(() => build({ style: {} }), name).toThrow();
      expect(cls(build({ class: "mine" }))!.endsWith(" mine"), name).toBe(true);
    }
  });
  it("audit finds nothing in a representative tree", () => {
    const tree = h("div", {},
      kit.card({ title: "Card", actions: h("button", { type: "button" }, "Go") }, kit.badge({ label: "Done" })),
      kit.table({ caption: "T", columns: COLS, rows: [{ name: "", n: 1 }, ...rows(2)], onRowOpen: () => {} }),
      kit.banner({ tone: "fail", title: "Oops", onDismiss: () => {} }),
      kit.skeleton({}), kit.emptyState({ title: "None" }), kit.list({ items: ["a"] }));
    expect(audit(tree)).toEqual([]);
  });
});

describe("card", () => {
  it("is a section with a heading named by aria-labelledby", () => {
    const c = kit.card({ title: "Hello" }, "body") as FakeElement;
    expect(c.tag).toBe("section");
    expect(cls(c)).toBe("scf-card scf-card--neutral");
    const head = c.all("h2")[0]!;
    expect(head.textContent).toBe("Hello");
    expect(c.getAttribute("aria-labelledby")).toBe(head.getAttribute("id"));
    expect(kit.card({ title: "T", level: 3 }).all("h3").length).toBe(1);
    expect(() => kit.card({ title: "T", level: 7 })).toThrow();
  });
  it("has no heading without a title and passes aria-label", () => {
    const c = kit.card({ "aria-label": "Plain" }, "x") as FakeElement;
    expect(c.all("h2").length).toBe(0);
    expect(c.getAttribute("aria-labelledby")).toBeNull();
    expect(c.getAttribute("aria-label")).toBe("Plain");
  });
  it("keeps a given id and derives the title id from it", () => {
    const c = kit.card({ id: "mine", title: "T" }) as FakeElement;
    expect(c.getAttribute("id")).toBe("mine");
    expect(c.all("h2")[0]!.getAttribute("id")).toBe("mine-title");
  });
  it("puts actions and children in their boxes", () => {
    const act = h("button", {}, "A");
    const c = kit.card({ title: "T", actions: act }, "child") as FakeElement;
    expect(byClass(c, "scf-card__actions")[0]!.children).toContain(act);
    expect(byClass(c, "scf-card__body")[0]!.textContent).toBe("child");
  });
  it("rejects an unknown tone", () => {
    expect(() => kit.card({ tone: "x" })).toThrow('unknown card tone "x"');
  });
});

describe("table", () => {
  it("is a focusable region with a caption and column headers", () => {
    const t = kit.table({ caption: "People", columns: COLS, rows: rows(2) }) as FakeElement;
    expect(t.tag).toBe("div");
    expect(cls(t)).toBe("scf-table-box");
    expect(t.getAttribute("role")).toBe("region");
    expect(t.getAttribute("tabindex")).toBe("0");
    const cap = t.all("caption")[0]!;
    expect(cap.textContent).toBe("People");
    expect(t.getAttribute("aria-labelledby")).toBe(cap.getAttribute("id"));
    expect(t.all("table").length).toBe(1);
    const ths = t.all("th");
    expect(ths.map((x) => x.getAttribute("scope"))).toEqual(["col", "col"]);
    expect(ths.map((x) => x.textContent)).toEqual(["Name", "Count"]);
  });
  it("can hide the caption visually and keeps it", () => {
    const cap = kit.table({ caption: "C", columns: COLS, rows: [], hideCaption: true }).all("caption")[0] as FakeElement;
    expect(cls(cap)).toContain("scf-visually-hidden");
  });
  it("reads cells from the key or from cell(row, index)", () => {
    const cell = vi.fn((r: any, i: number) => `${r.name}#${i}`);
    const t = kit.table({ caption: "C", columns: [{ key: "name", label: "A", cell }, { key: "missing", label: "B" }], rows: rows(2) }) as FakeElement;
    const tds = bodyRows(t)[1]!.all("td");
    expect(tds[0]!.textContent).toBe("Row 2#1");
    expect(tds[1]!.textContent).toBe("");
    expect(cell).toHaveBeenCalledWith({ name: "Row 2", n: 1 }, 1);
  });
  it("aligns to the end and rejects an unknown align", () => {
    const t = kit.table({ caption: "C", columns: COLS, rows: rows(1) }) as FakeElement;
    expect(cls(t.all("th")[1]!)).toContain("scf-table__th--end");
    expect(cls(t.all("td")[1]!)).toContain("scf-table__td--end");
    expect(cls(t.all("td")[0]!)).not.toContain("--end");
    expect(() => kit.table({ caption: "C", columns: [{ key: "a", label: "A", align: "middle" }], rows: [] })).toThrow();
  });
  it("has no button and no row listener without onRowOpen", () => {
    const t = kit.table({ caption: "C", columns: COLS, rows: rows(2) }) as FakeElement;
    expect(t.all("button").length).toBe(0);
    for (const tr of bodyRows(t)) expect(tr.listeners.click).toBeUndefined();
  });
  it("opens a row from a real button in the first cell, once", () => {
    const onRowOpen = vi.fn();
    const t = kit.table({ caption: "C", columns: COLS, rows: rows(3), onRowOpen }) as FakeElement;
    for (const tr of bodyRows(t)) {
      expect(tr.all("td")[0]!.all("button").length).toBe(1);
      expect(tr.all("td")[1]!.all("button").length).toBe(0);
      expect(tr.listeners.click).toBeUndefined();
    }
    const b = bodyRows(t)[1]!.all("button")[0]!;
    expect(b.getAttribute("type")).toBe("button");
    expect(cls(b)).toBe("scf-table__open");
    expect(b.textContent).toBe("Row 2");
    b.click();
    expect(onRowOpen).toHaveBeenCalledTimes(1);
    expect(onRowOpen).toHaveBeenCalledWith({ name: "Row 2", n: 1 }, 1);
  });
  it("names the opener when the cell is empty, and flattens node content to text", () => {
    const t = kit.table({
      caption: "C", onRowOpen: () => {},
      columns: [{ key: "name", label: "Name", cell: (r: any) => (r.name === "link" ? h("a", { href: "#x" }, "Linked") : r.name) }, { key: "n", label: "N" }],
      rows: [{ name: "" }, { name: "link" }],
    }) as FakeElement;
    const buttons = t.all("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Open row 1", "Linked"]);
    expect(t.all("a").length).toBe(0);
    expect(audit(t)).toEqual([]);
  });
  it("shows the headers and the empty text when there are no rows", () => {
    const t = kit.table({ caption: "Cap", columns: COLS, rows: [] }) as FakeElement;
    expect(t.all("th").length).toBe(2);
    expect(bodyRows(t).length).toBe(0);
    const p = byClass(t, "scf-table__empty")[0]!;
    expect(p.tag).toBe("p");
    expect(p.textContent).toBe("Nothing to show.");
    expect(kit.table({ caption: "C", columns: COLS, rows: [], empty: "None" }).all("p")[0].textContent).toBe("None");
    const node = h("div", {}, "mine");
    expect(kit.table({ caption: "C", columns: COLS, rows: [], empty: node }).children).toContain(node);
    expect(byClass(kit.table({ caption: "C", columns: COLS, rows: rows(1) }), "scf-table__empty").length).toBe(0);
  });
  it("throws on bad input", () => {
    const ok = { caption: "C", columns: COLS, rows: [] };
    expect(() => kit.table({ ...ok, caption: "" })).toThrow();
    expect(() => kit.table({ ...ok, columns: "x" })).toThrow();
    expect(() => kit.table({ ...ok, columns: [] })).toThrow();
    expect(() => kit.table({ ...ok, columns: [{ key: "a" }] })).toThrow();
    expect(() => kit.table({ ...ok, rows: null })).toThrow();
    expect(() => kit.table({ ...ok, onRowOpen: "x" })).toThrow();
  });
  it("draws 40 rows", () => {
    expect(bodyRows(kit.table({ caption: "C", columns: COLS, rows: rows(40) })).length).toBe(40);
  });
});

describe("list", () => {
  it("is a ul, or an ol when ordered, with one li per item", () => {
    const u = kit.list({ items: ["a", "b"] }) as FakeElement;
    expect(u.tag).toBe("ul");
    expect(u.all("li").length).toBe(2);
    expect(cls(u.all("li")[0]!)).toBe("scf-list__item");
    expect(kit.list({ items: ["a"], ordered: true }).tag).toBe("ol");
  });
  it("takes strings, nodes and arrays", () => {
    const node = h("b", {}, "n");
    const l = kit.list({ items: ["s", node, ["x", "y"]] }) as FakeElement;
    const li = l.all("li");
    expect(li[0]!.textContent).toBe("s");
    expect(li[1]!.children).toContain(node);
    expect(li[2]!.textContent).toBe("xy");
  });
  it("allows no items and needs the array", () => {
    expect(kit.list({ items: [] }).all("li").length).toBe(0);
    expect(() => kit.list({})).toThrow();
  });
});

describe("badge", () => {
  it.each(TONES)("tone %s", (tone) => {
    const b = kit.badge({ tone, label: "Word" }) as FakeElement;
    expect(cls(b)).toBe(`scf-badge scf-badge--${tone}`);
    expect(b.textContent).toBe("Word");
  });
  it("throws on an unknown tone or a bad label", () => {
    expect(() => kit.badge({ tone: "x", label: "L" })).toThrow();
    for (const label of [undefined, "", "  ", 3]) expect(() => kit.badge({ label })).toThrow();
  });
});

describe("banner", () => {
  it("is an alert for fail and a status for the others", () => {
    expect(kit.banner({ tone: "fail", title: "T" }).getAttribute("role")).toBe("alert");
    for (const tone of TONES.filter((t) => t !== "fail")) expect(kit.banner({ tone, title: "T" }).getAttribute("role"), tone).toBe("status");
    expect(kit.banner({ tone: "ok", title: "T", role: "alert" }).getAttribute("role")).toBe("status");
  });
  it("puts the title in a strong and children in the body", () => {
    const b = kit.banner({ title: "Title" }, "text") as FakeElement;
    expect(b.all("strong")[0]!.textContent).toBe("Title");
    expect(byClass(b, "scf-banner__body")[0]!.textContent).toBe("text");
  });
  it("has a Dismiss icon button only with onDismiss, and does not remove itself", () => {
    expect(kit.banner({ title: "T" }).all("button").length).toBe(0);
    const onDismiss = vi.fn();
    const parent = new FakeElement("div");
    const b = kit.banner({ title: "T", onDismiss }) as FakeElement;
    parent.append(b);
    b.parent = parent;
    const btn = b.all("button")[0]!;
    expect(btn.getAttribute("aria-label")).toBe("Dismiss");
    expect(btn.getAttribute("title")).toBe("Dismiss");
    expect(cls(btn)).toContain("scf-btn--icon");
    btn.click();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(b.parent).toBe(parent);
  });
  it("needs a title or renderable content, and a known tone", () => {
    expect(() => kit.banner({})).toThrow();
    expect(() => kit.banner({}, null, false, [null, []])).toThrow();
    expect(() => kit.banner({ tone: "x", title: "T" })).toThrow();
    expect(kit.banner({}, "text").all("strong").length).toBe(0);
  });
});

describe("skeleton", () => {
  it("is busy, with a hidden label first and three hidden lines", () => {
    const s = kit.skeleton({}) as FakeElement;
    expect(s.getAttribute("aria-busy")).toBe("true");
    const first = s.children[0] as FakeElement;
    expect(first.tag).toBe("span");
    expect(cls(first)).toBe("scf-visually-hidden");
    expect(first.textContent).toBe("Loading…");
    const lines = byClass(s, "scf-skeleton__lines")[0]!;
    expect(lines.getAttribute("aria-hidden")).toBe("true");
    expect(lines.children.length).toBe(3);
    expect(byClass(kit.skeleton({ lines: 5 }), "scf-skeleton__line").length).toBe(5);
    expect(kit.skeleton({ label: "Wait" }).children[0].textContent).toBe("Wait");
  });
  it("throws on bad lines or label", () => {
    for (const lines of [0, 21, 1.5, "3"]) expect(() => kit.skeleton({ lines }), String(lines)).toThrow();
    expect(() => kit.skeleton({ label: " " })).toThrow();
  });
});

describe("emptyState", () => {
  it("has a title heading, and optional text and action", () => {
    const e = kit.emptyState({ title: "None" }) as FakeElement;
    expect(e.all("h3")[0]!.textContent).toBe("None");
    expect(e.all("p").length).toBe(0);
    expect(byClass(e, "scf-empty__action").length).toBe(0);
    expect(kit.emptyState({ title: "None", level: 2 }).all("h2").length).toBe(1);
    const action = h("button", {}, "Add");
    const f = kit.emptyState({ title: "None", text: "Some text", action }) as FakeElement;
    expect(f.all("p")[0]!.textContent).toBe("Some text");
    expect(byClass(f, "scf-empty__action")[0]!.children).toContain(action);
  });
  it("needs a title", () => {
    expect(() => kit.emptyState({})).toThrow();
  });
});

describe("display.css and display.js", () => {
  const css = readFileSync("ui/kit/display.css", "utf8");
  it("passes the kit selector and colour check", () => {
    expect(kitCssProblems(css, tokenNames())).toEqual([]);
  });
  it("starts with the Belongs here comment", () => {
    expect(css.startsWith("/* ui/kit/display.css")).toBe(true);
    expect(css).toContain("Belongs here:");
    expect(css).toContain("Does not belong here:");
  });
  it("has the scroll box, the tone rules and the helpers", () => {
    expect(css).toMatch(/\.scf-table-box \{[^}]*overflow-x: auto/);
    for (const t of TONES) {
      expect(css).toContain(`.scf-badge--${t} {`);
      expect(css).toContain(`.scf-banner--${t} {`);
    }
    expect(css).toMatch(/\.scf-badge--warn \{[^}]*var\(--color-warning\)[^}]*\}/);
    expect(css).toMatch(/\.scf-badge--warn \{[^}]*var\(--color-warning-soft\)/);
    expect(css).toContain(".scf-visually-hidden");
    expect(css).toContain(".scf-table__open:hover");
  });
  it("uses a warning token that has a light and a dark value", () => {
    const names = tokenNames();
    expect(names.has("--color-warning")).toBe(true);
    expect(names.has("--color-warning-soft")).toBe(true);
    const tokens = readFileSync("ui/tokens.css", "utf8");
    for (const line of tokens.split("\n").filter((l) => /--color-warning(-soft)?:/.test(l))) expect(line).toContain("light-dark(");
  });
  it("kit.css imports display.css", () => {
    expect(readFileSync("ui/kit/kit.css", "utf8")).toContain('@import url("/kit/display.css");');
  });
  it("display.js passes the source check", () => {
    expect(kitSourceProblems(readFileSync("ui/kit/display.js", "utf8"))).toEqual([]);
  });
});
