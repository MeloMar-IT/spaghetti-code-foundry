import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { parseCss } from "./helpers/ui-css.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let t: any;
let dom: any;
beforeAll(async () => {
  restore = installFakeDom();
  t = await import("../ui/templates.js" as string);
  dom = await import("../ui/dom.js" as string);
});
afterAll(() => restore());

const cls = (el: any) => (el as FakeElement).getAttribute("class");
const kids = (el: FakeElement) => el.children.map(cls);
const node = (text: string) => dom.h("span", {}, text);
const walk = (el: FakeElement): FakeElement[] => [el, ...el.children.flatMap((c) => (c instanceof FakeElement ? walk(c) : []))];

const NAMES: Record<string, string> = {
  overviewPage: "overview", collectionPage: "collection", boardPage: "board", masterDetailPage: "master-detail",
  editorPage: "editor", settingsPage: "settings", conversationPage: "conversation", detailPage: "detail",
};
const SLOTS: Record<string, string[]> = {
  overviewPage: ["summary", "sections"], settingsPage: ["sections"], collectionPage: ["filters", "list", "empty"], boardPage: ["filters", "columns"],
  masterDetailPage: ["master", "detail"], editorPage: ["main", "side"], conversationPage: ["thread", "composer", "side"], detailPage: ["meta", "sections", "side"],
};
const EXPECTED: Record<string, any[]> = {
  overviewPage: ["page-summary", "page-sections"],
  settingsPage: ["page-sections"],
  collectionPage: ["page-filters", "page-list", "page-empty"],
  boardPage: ["page-filters", "page-columns"],
  masterDetailPage: [["page-body", ["page-side", "page-main"]]],
  editorPage: [["editor page-body", ["page-side", "page-main"]]],
  conversationPage: ["page-thread", "page-composer", "page-side"],
  detailPage: ["page-meta", ["page-body with-side", ["page-sections", "page-side"]]],
};
const shape = (el: FakeElement): any => el.children.map((c) => {
  const ch = c as FakeElement;
  return ch.children.length && ch.children.every((g) => g instanceof FakeElement && /^page-/.test(cls(g) ?? "")) && /page-body/.test(cls(ch) ?? "")
    ? [cls(ch), shape(ch)] : cls(ch);
});
const full = (name: string) => {
  const slots = Object.fromEntries(SLOTS[name]!.map((s) => [s, node(s)]));
  return t[name]({ title: "T", back: { label: "Back", href: "#/x" }, status: node("st"), actions: [node("ac")], notices: node("no"), ...slots }) as FakeElement;
};

describe("the templates", () => {
  it("export exactly the eight", () => {
    expect(Object.keys(t).sort()).toEqual(Object.keys(NAMES).sort());
  });

  for (const [name, root] of Object.entries(NAMES)) {
    describe(name, () => {
      it("returns div.page.page-<name> with one h1 and the toolbar head first", () => {
        const el = full(name);
        expect(el.tag).toBe("div");
        expect(cls(el)).toBe(`page page-${root}`);
        expect(el.all("h1")).toHaveLength(1);
        expect(cls(el.children[0])).toBe("toolbar page-head");
        expect(cls(el.children[1])).toBe("page-notices");
      });

      it("draws its regions in the fixed order", () => {
        const el = full(name);
        expect(shape({ children: el.children.slice(2) } as any)).toEqual(EXPECTED[name]);
      });

      it("draws no region for an empty slot", () => {
        for (const empty of [null, false, [], [null, false]]) {
          const slots = Object.fromEntries([...SLOTS[name]!, "notices"].map((s) => [s, empty]));
          const el = t[name]({ title: "T", ...slots }) as FakeElement;
          expect(el.children, JSON.stringify(empty)).toHaveLength(1);
        }
        expect((t[name]({ title: "T" }) as FakeElement).children).toHaveLength(1);
      });

      it("takes a ready head node: first child, no h1, notices right after", () => {
        const head = dom.h("div", { class: "mine" }, "head");
        const el = t[name]({ head, notices: node("no") }) as FakeElement;
        expect(el.children[0]).toBe(head);
        expect(el.all("h1")).toEqual([]);
        expect(cls(el.children[1])).toBe("page-notices");
      });

      it("throws on head with a header option, on no head and no title, and on an unknown option", () => {
        const head = dom.h("div", {});
        expect(() => t[name]({ head, title: "T" })).toThrow();
        expect(() => t[name]({ head, actions: node("a") })).toThrow();
        expect(() => t[name]({})).toThrow();
        expect(() => t[name]({ title: "T", typo: node("x") })).toThrow(/unknown option/);
      });
    });
  }

  it("puts status and actions as direct children of the toolbar", () => {
    const st = node("st");
    const ac = node("ac");
    const el = t.overviewPage({ title: "T", status: st, actions: [ac] }) as FakeElement;
    const bar = el.children[0] as FakeElement;
    expect(bar.children).toContain(st);
    expect(bar.children).toContain(ac);
  });

  it("detailPage adds with-side only when side is filled", () => {
    const without = t.detailPage({ title: "T", sections: node("s") }) as FakeElement;
    expect(cls(without.children[1])).toBe("page-body");
    const withSide = t.detailPage({ title: "T", sections: node("s"), side: node("x") }) as FakeElement;
    expect(cls(withSide.children[1])).toBe("page-body with-side");
  });

  it("editorPage puts the side before the main", () => {
    const el = t.editorPage({ title: "T", main: node("m"), side: node("s") }) as FakeElement;
    const body = el.children[1] as FakeElement;
    expect(cls(body)).toBe("editor page-body");
    expect(kids(body)).toEqual(["page-side", "page-main"]);
  });

  it("draws no page-body when its slots are empty", () => {
    expect((t.masterDetailPage({ title: "T" }) as FakeElement).children).toHaveLength(1);
    expect(walk(t.editorPage({ title: "T", main: [] })).filter((e) => /page-body/.test(cls(e) ?? ""))).toEqual([]);
  });
});

describe("the board grid", () => {
  it("is scoped to .page-board in templates.css and gone from pages/board.css", () => {
    const own = parseCss(readFileSync("ui/css/templates.css", "utf8")).filter((r) => r.selector === ".page-board .board");
    expect(own).toHaveLength(1);
    expect(own[0]!.context).toBe("");
    expect(own[0]!.declarations).toEqual([
      "display: grid", "grid-auto-flow: column", "grid-auto-columns: minmax(210px, 1fr)", "gap: 12px", "overflow-x: auto", "align-items: start",
    ]);
    expect(parseCss(readFileSync("ui/css/pages/board.css", "utf8")).filter((r) => r.selector === ".board")).toEqual([]);
  });
});

describe("ui/templates.js source", () => {
  const src = readFileSync("ui/templates.js", "utf8");
  it("imports only ./dom.js and ./kit/product.js", () => {
    expect([...src.matchAll(/^import .* from "([^"]+)";/gm)].map((m) => m[1])).toEqual(["./dom.js", "./kit/product.js"]);
  });
  it("has no api, fetch( or style", () => {
    expect(src).not.toMatch(/\bapi\b/);
    expect(src).not.toContain("fetch(");
    expect(src).not.toMatch(/style/);
  });
  it("exports the eight names", () => {
    expect([...src.matchAll(/^export const (\w+)/gm)].map((m) => m[1]!).sort()).toEqual(Object.keys(NAMES).sort());
  });
});
