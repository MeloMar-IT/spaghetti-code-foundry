import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let shell: any;
let ia: any;
const doc = () => (globalThis as any).document;
let nav: FakeElement[];

beforeAll(async () => {
  restore = installFakeDom();
  shell = await import("../ui/shell.js" as string);
  ia = await import("../ui/ia.js" as string);
});
afterAll(() => restore());

beforeEach(() => {
  nav = ["home", "runs", "repos", "flows", "administration", "start"].map((id) => {
    const a = new FakeElement("a");
    a.setAttribute("data-nav", id);
    return a;
  });
  doc().querySelectorAll = () => nav;
  for (const id of ["subnav", "crumbs"]) {
    const el = doc().getElementById(id);
    el.replaceChildren();
    el.hidden = true;
  }
  doc().title = "";
  shell.setCount(0);
  shell.showPage("admin", ia.resolve("admin", "#/home"));
});

const active = () => nav.filter((a) => a.classList.contains("active")).map((a) => a.attrs["data-nav"]);

describe("ui/index.html", () => {
  it("has the place for the repository switcher first in the sidebar, in both pages", () => {
    for (const file of ["ui/index.html", "ui/user/index.html"]) {
      const html = readFileSync(file, "utf8");
      expect(html, file).toMatch(/<button type="button" id="side-close" class="side-close">Close menu<\/button>\s*<span id="context" class="context"><\/span>\s*<a /);
      expect(html.indexOf('id="context"'), file).toBeGreaterThan(html.indexOf('<nav id="side"'));
      expect(html.slice(html.indexOf('<header class="top"'), html.indexOf("</header>")), file).not.toContain('id="context"');
    }
  });
});

describe("titleText", () => {
  it("builds the tab title", () => {
    expect(shell.titleText("", 0)).toBe("Spaghetti Code Foundry");
    expect(shell.titleText("", 3)).toBe("(3) Foundry");
    expect(shell.titleText("Runs", 0)).toBe("Runs · Spaghetti Code Foundry");
    expect(shell.titleText("Runs", 2)).toBe("(2) Runs · Foundry");
  });
});

describe("showPage sets data-area on <html>", () => {
  it("uses the area of the page and removes it for a page without one", () => {
    const root = doc().documentElement as FakeElement;
    shell.showPage("admin", ia.resolve("admin", "#/users"));
    expect(root.attrs["data-area"]).toBe("administration");
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    expect(root.attrs["data-area"]).toBe("runs");
    const to = ia.resolve("admin", "#/runs");
    shell.showPage("admin", { ...to, page: { ...to.page, area: undefined } });
    expect(root.attrs["data-area"]).toBeUndefined();
  });
});

describe("showPage", () => {
  it("marks one link active and clears the previous one", () => {
    expect(active()).toEqual(["home"]);
    shell.showPage("admin", ia.resolve("admin", "#/runs/r1"));
    expect(active()).toEqual(["runs"]);
    expect(nav[1]!.attrs["aria-current"]).toBe("true");
    expect(nav[0]!.attrs["aria-current"]).toBeUndefined();
    shell.showPage("admin", ia.resolve("admin", "#/start"));
    expect(active()).toEqual(["start"]);
  });

  it("draws and hides the secondary row", () => {
    const sub = doc().getElementById("subnav") as FakeElement;
    expect(sub.hidden).toBe(true);
    shell.showPage("admin", ia.resolve("admin", "#/users"));
    expect(sub.hidden).toBe(false);
    expect(sub.all("a").length).toBe(12);
    expect(sub.all("a").filter((a) => a.attrs.class === "active").map((a) => a.textContent)).toEqual(["Users"]);
    const heads = sub.all("span").filter((s) => s.attrs.class === "subnav-head");
    expect(heads.map((s) => s.textContent)).toEqual(["Operations", "People and access", "System"]);
    for (const label of ["Overview", "Users", "Settings"]) {
      const i = sub.children.findIndex((c) => c.tag === "a" && c.textContent === label);
      expect((sub.children[i - 1] as FakeElement).attrs.class).toBe("subnav-head");
    }
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    expect(sub.hidden).toBe(true);
  });

  it("namePage puts the name in the last crumb, the title and the labels", () => {
    shell.showPage("admin", ia.resolve("admin", "#/users/u1"));
    const crumbs = doc().getElementById("crumbs") as FakeElement;
    expect(crumbs.textContent).toContain("u1");
    shell.namePage("Ann");
    expect(crumbs.all("span").filter((s) => s.attrs["aria-current"] === "page").map((s) => s.textContent)).toEqual(["Ann"]);
    expect(crumbs.textContent).not.toContain("u1");
    expect(doc().getElementById("page-title").textContent).toBe("Ann");
    expect(doc().getElementById("main").attrs["aria-label"]).toBe("Ann");
    expect(doc().title).toBe("Ann · Spaghetti Code Foundry");
    shell.namePage("");
    expect(doc().getElementById("page-title").textContent).toBe("Ann");
  });

  it("namePage does not fail on a page without crumbs", () => {
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    expect(() => shell.namePage("Ann")).not.toThrow();
  });

  it("highlights Administration and All repositories on #/all-repos", () => {
    shell.showPage("admin", ia.resolve("admin", "#/all-repos"));
    expect(active()).toEqual(["administration"]);
    const sub = doc().getElementById("subnav") as FakeElement;
    expect(sub.all("a").filter((a) => a.attrs.class === "active").map((a) => a.textContent)).toEqual(["All repositories"]);
  });

  it("keeps Flows flat and hides the row on Repositories", () => {
    shell.showPage("admin", ia.resolve("admin", "#/flows"));
    const sub = doc().getElementById("subnav") as FakeElement;
    expect(sub.all("a").length).toBe(2);
    expect(sub.all("span").filter((s) => s.attrs.class === "subnav-head")).toHaveLength(0);
    shell.showPage("admin", ia.resolve("admin", "#/repos"));
    expect(sub.hidden).toBe(true);
  });

  it("marks the parent in the secondary row on a detail page", () => {
    shell.showPage("admin", ia.resolve("admin", "#/flows/x"));
    const sub = doc().getElementById("subnav") as FakeElement;
    expect(sub.all("a").filter((a) => a.attrs.class === "active").map((a) => a.textContent)).toEqual(["Flows"]);
  });

  it("draws crumbs with no link on the last one", () => {
    const crumbs = doc().getElementById("crumbs") as FakeElement;
    shell.showPage("admin", ia.resolve("admin", "#/runs/r1"));
    expect(crumbs.hidden).toBe(false);
    expect(crumbs.all("a").map((a) => a.attrs.href)).toEqual(["#/runs"]);
    const last = crumbs.children.at(-1) as FakeElement;
    expect(last.textContent).toBe("Change");
    expect(last.attrs["aria-current"]).toBe("page");
    // The run ID is not in the page name; the run page names the page after the change.
    expect((doc().getElementById("page-title") as FakeElement).textContent).toBe("Change");
    expect((doc().getElementById("main") as FakeElement).attrs["aria-label"]).toBe("Change");
    shell.namePage("Fix login");
    expect((doc().getElementById("page-title") as FakeElement).textContent).toBe("Fix login");
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    expect(crumbs.hidden).toBe(true);
  });

  it("works on a page without those elements", () => {
    const real = doc().getElementById;
    doc().getElementById = () => null;
    try {
      expect(() => shell.showPage("user", ia.resolve("user", "#/runs/a"))).not.toThrow();
    } finally {
      doc().getElementById = real;
    }
  });
});

describe("setCount", () => {
  it("keeps the page name in the title", () => {
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    expect(doc().title).toBe("Runs · Spaghetti Code Foundry");
    shell.setCount(2);
    expect(doc().title).toBe("(2) Runs · Foundry");
  });

  it("writes the count on the menu button", () => {
    shell.setCount(3);
    expect(byId("menu-count").textContent).toBe("3");
    expect(byId("menu-count").hidden).toBe(false);
    expect(byId("menu-btn").attrs["aria-label"]).toBe("Menu, 3 waiting");
    shell.setCount(0);
    expect(byId("menu-count").hidden).toBe(true);
    expect(byId("menu-btn").attrs["aria-label"]).toBe("Menu");
  });
});

const byId = (id: string) => doc().getElementById(id) as FakeElement;
const press = (key: string, extra: object = {}) => {
  let prevented = false;
  for (const f of doc().listeners.keydown ?? []) f({ key, preventDefault: () => { prevented = true; }, ...extra });
  return prevented;
};
const mkMedia = (matches: boolean) => Object.assign(new FakeElement("media"), { matches });
const mkStore = (value: string | null) => {
  const saved: Record<string, string> = {};
  return { saved, getItem: () => value, setItem: (k: string, v: string) => { saved[k] = v; } };
};
let stop: (() => void) | undefined;
let side: FakeElement;
let links: FakeElement[];

beforeEach(() => {
  stop?.();
  stop = undefined;
  doc().body.classList.names.clear();
  for (const id of ["menu-btn", "scrim", "side", "main", "modal-root", "route-status", "account", "page-title", "content"]) {
    const e = byId(id);
    e.attrs = {};
    e.listeners = {};
    e.hidden = false;
    e.replaceChildren();
  }
  links = ["#/home", "#/runs", "#/repos"].map((href) => {
    const a = new FakeElement("a");
    a.setAttribute("href", href);
    return a;
  });
  side = byId("side");
  side.append(...links);
  doc().activeElement = null;
});

describe("sideState", () => {
  it("is always open when wide and follows the drawer when narrow", () => {
    expect(shell.sideState({ narrow: false, drawer: false })).toEqual({ open: true, modal: false });
    expect(shell.sideState({ narrow: false, collapsed: true, drawer: false })).toEqual({ open: true, modal: false });
    expect(shell.sideState({ narrow: false, drawer: true })).toEqual({ open: true, modal: false });
    expect(shell.sideState({ narrow: true, drawer: false })).toEqual({ open: false, modal: false });
    expect(shell.sideState({ narrow: true, drawer: true })).toEqual({ open: true, modal: true });
  });
});

describe("initShell, wide", () => {
  it("always shows the sidebar: the menu button changes nothing and nothing is stored", () => {
    const store = mkStore("closed"); // an old "closed" value is ignored
    stop = shell.initShell("admin", { store, media: mkMedia(false), user: { name: "Ann" } });
    expect(byId("account-name").textContent).toBe("Ann");
    expect(byId("account-summary").attrs["aria-label"]).toBe("Account for Ann");
    expect(doc().body.classList.contains("side-closed")).toBe(false);
    expect(byId("menu-btn").attrs["aria-expanded"]).toBe("true");
    byId("menu-btn").click();
    expect(doc().body.classList.contains("side-closed")).toBe(false);
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    expect(byId("menu-btn").attrs["aria-expanded"]).toBe("true");
    expect(byId("scrim").hidden).toBe(true);
    expect(store.saved).toEqual({});
  });

  it("asks for the compact layout from ui/viewport.js by default", () => {
    const g = globalThis as any;
    const had = Object.getOwnPropertyDescriptor(g, "matchMedia");
    const asked: string[] = [];
    g.matchMedia = (q: string) => { asked.push(q); return mkMedia(false); };
    try {
      stop = shell.initShell("admin", { store: mkStore(null) });
    } finally {
      if (had) Object.defineProperty(g, "matchMedia", had); else delete g.matchMedia;
    }
    expect(asked).toEqual(["(max-width: 767px)"]);
  });

  it("works with no matchMedia and with every element missing", () => {
    const real = doc().getElementById;
    doc().getElementById = () => null;
    try {
      expect(() => { stop = shell.initShell("user", { store: mkStore(null), media: undefined }); }).not.toThrow();
    } finally {
      doc().getElementById = real;
    }
  });

  it("the skip button focuses the main area", () => {
    stop = shell.initShell("admin", { store: mkStore(null), media: mkMedia(false) });
    byId("skip").click();
    expect(doc().activeElement).toBe(byId("main"));
  });

  it("stop removes the listeners; a second init starts fresh", () => {
    stop = shell.initShell("admin", { store: mkStore(null), media: mkMedia(false) });
    expect(byId("menu-btn").listeners.click).toHaveLength(1);
    stop!();
    expect(byId("menu-btn").listeners.click).toHaveLength(0);
    expect((doc().listeners.keydown ?? []).length).toBe(0);
    stop = shell.initShell("admin", { store: mkStore("closed"), media: mkMedia(false) });
    expect(byId("menu-btn").listeners.click).toHaveLength(1);
    expect(doc().body.classList.contains("side-closed")).toBe(false);
  });
});

describe("initShell, narrow", () => {
  const start = (store = mkStore("open")) => {
    const media = mkMedia(true);
    stop = shell.initShell("admin", { store, media });
    return media;
  };

  it("starts closed, opens the drawer and focuses the first link", () => {
    start();
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    expect(byId("scrim").hidden).toBe(true);
    byId("menu-btn").click();
    expect(doc().body.classList.contains("drawer-open")).toBe(true);
    expect(byId("scrim").hidden).toBe(false);
    expect(byId("content").attrs.inert).toBe("");
    expect(doc().activeElement).toBe(links[0]);
  });

  it("Escape closes it and focuses the menu button, unless a dialog is open", () => {
    start();
    byId("menu-btn").click();
    byId("modal-root").append(new FakeElement("div"));
    press("Escape");
    expect(doc().body.classList.contains("drawer-open")).toBe(true);
    byId("modal-root").replaceChildren();
    press("Escape");
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    expect(doc().activeElement).toBe(byId("menu-btn"));
    expect(byId("content").attrs.inert).toBeUndefined();
  });

  it("Tab stays inside the drawer", () => {
    start();
    byId("menu-btn").click();
    links[2]!.focus();
    expect(press("Tab")).toBe(true);
    expect(doc().activeElement).toBe(links[0]);
    expect(press("Tab", { shiftKey: true })).toBe(true);
    expect(doc().activeElement).toBe(links[2]);
    links[1]!.focus();
    expect(press("Tab")).toBe(false);
  });

  it("a scrim click or any sidebar link closes it, also the link of the open page", () => {
    start();
    byId("menu-btn").click();
    byId("scrim").fire("mousedown");
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    byId("menu-btn").click();
    links[1]!.click();
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    expect(doc().activeElement).toBe(byId("main"));
  });

  it("also makes the header and skip button inert, and a nested target in a link closes it", () => {
    start();
    byId("menu-btn").click();
    for (const id of ["top", "skip", "content"]) expect(byId(id).attrs.inert, id).toBe("");
    const count = new FakeElement("span");
    links[0]!.append(count);
    count.click();
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    for (const id of ["top", "skip", "content"]) expect(byId(id).attrs.inert, id).toBeUndefined();
  });

  it("the close button in the drawer closes it and Tab reaches it", () => {
    const close = byId("side-close");
    close.tag = "button";
    close.listeners = {};
    side.replaceChildren(close, ...links);
    start();
    byId("menu-btn").click();
    links[2]!.focus();
    press("Tab");
    expect(doc().activeElement).toBe(close);
    close.click();
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
  });

  it("Tab reaches the project switcher at the top of the drawer, its search box too, and Shift+Tab goes back to it", () => {
    const button = new FakeElement("button");
    const search = new FakeElement("input");
    const result = new FakeElement("button");
    side.replaceChildren(button, search, result, ...links);
    start();
    byId("menu-btn").click();
    // the search box is a stop: Tab moves on to the results, not out of the drawer
    search.focus();
    expect(press("Tab")).toBe(false);
    result.focus();
    expect(press("Tab", { shiftKey: true })).toBe(false);
    // the ends of the drawer wrap
    links[2]!.focus();
    expect(press("Tab")).toBe(true);
    expect(doc().activeElement).toBe(button);
    expect(press("Tab", { shiftKey: true })).toBe(true);
    expect(doc().activeElement).toBe(links[2]);
  });

  it("Escape with the project switcher open closes the switcher first, not the drawer", () => {
    const context = byId("context");
    const toggle = new FakeElement("button");
    toggle.setAttribute("aria-haspopup", "true");
    toggle.setAttribute("aria-expanded", "true");
    context.replaceChildren(toggle);
    start();
    byId("menu-btn").click();
    press("Escape");
    expect(doc().body.classList.contains("drawer-open")).toBe(true);
    toggle.setAttribute("aria-expanded", "false");
    press("Escape");
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    context.replaceChildren();
  });

  it("a change to a wide screen clears the drawer", () => {
    const media = start();
    byId("menu-btn").click();
    media.fire("change", { matches: false });
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    byId("menu-btn").click();
    expect(doc().body.classList.contains("side-closed")).toBe(false);
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
  });
});

describe("showPage with the shell", () => {
  it("sets aria-current page for the exact address and true for the area", () => {
    const hrefs = ["#/home", "#/runs", "#/repos", "#/flows", "#/users", "#/start"];
    nav.forEach((a, i) => a.setAttribute("href", hrefs[i]!));
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    expect(nav[1]!.attrs["aria-current"]).toBe("page");
    shell.showPage("admin", ia.resolve("admin", "#/runs/r1"));
    expect(nav[1]!.attrs["aria-current"]).toBe("true");
    shell.showPage("admin", ia.resolve("admin", "#/users"));
    expect(nav[4]!.attrs["aria-current"]).toBe("page");
    shell.showPage("admin", ia.resolve("admin", "#/audit"));
    expect(nav[4]!.attrs["aria-current"]).toBe("true");
  });

  it("marks the link of a page whose address has a query", () => {
    const hrefs = ["#/home", "#/runs", "#/repos", "#/flows", "#/users", "#/start"];
    nav.forEach((a, i) => a.setAttribute("href", hrefs[i]!));
    shell.showPage("admin", ia.resolve("admin", "#/runs?owner=u1"));
    expect(nav[1]!.attrs["aria-current"]).toBe("page");
  });

  it("names the page in the title and on the main area; a detail page names its argument", () => {
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    expect(byId("page-title").textContent).toBe("Runs");
    expect(byId("main").attrs["aria-label"]).toBe("Runs");
    shell.showPage("admin", ia.resolve("admin", "#/board/o-a"));
    expect(byId("page-title").textContent).toBe("Board: o-a");
  });

  it("closes the drawer and the account menu", () => {
    stop = shell.initShell("admin", { store: mkStore(null), media: mkMedia(true) });
    byId("menu-btn").click();
    byId("account").setAttribute("open", "");
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
    expect(byId("account").attrs.open).toBeUndefined();
  });

  it("moves focus and announces from the second page on, also for the same title twice", () => {
    vi.useFakeTimers();
    try {
      stop = shell.initShell("admin", { store: mkStore(null), media: mkMedia(false) });
      shell.showPage("admin", ia.resolve("admin", "#/board/a"));
      expect(doc().activeElement).toBeNull();
      expect(byId("route-status").textContent).toBe("");
      shell.showPage("admin", ia.resolve("admin", "#/board"));
      expect(doc().activeElement).toBe(byId("main"));
      expect(byId("route-status").textContent).toBe("");
      vi.advanceTimersByTime(60);
      expect(byId("route-status").textContent).toBe("Board");
      shell.showPage("admin", ia.resolve("admin", "#/board"));
      expect(byId("route-status").textContent).toBe("");
      vi.advanceTimersByTime(60);
      expect(byId("route-status").textContent).toBe("Board");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not take the focus from a dialog", () => {
    stop = shell.initShell("admin", { store: mkStore(null), media: mkMedia(false) });
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
    const field = new FakeElement("input");
    byId("modal-root").append(field);
    field.focus();
    shell.showPage("admin", ia.resolve("admin", "#/flows"));
    expect(doc().activeElement).toBe(field);
  });
});

describe("helpers for the command palette", () => {
  it("announcePage focuses main and announces the open page again, also for the same title", () => {
    vi.useFakeTimers();
    try {
      stop = shell.initShell("admin", { store: mkStore(null), media: mkMedia(false) });
      shell.showPage("admin", ia.resolve("admin", "#/board"));
      shell.showPage("admin", ia.resolve("admin", "#/board"));
      vi.advanceTimersByTime(60);
      doc().activeElement = null;
      shell.announcePage();
      expect(doc().activeElement).toBe(byId("main"));
      expect(byId("route-status").textContent).toBe("");
      vi.advanceTimersByTime(60);
      expect(byId("route-status").textContent).toBe("Board");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closeDrawer closes an open drawer and does nothing otherwise", () => {
    stop = shell.initShell("admin", { store: mkStore(null), media: mkMedia(true) });
    shell.closeDrawer(null);
    byId("menu-btn").click();
    expect(doc().body.classList.contains("drawer-open")).toBe(true);
    shell.closeDrawer(null);
    expect(doc().body.classList.contains("drawer-open")).toBe(false);
  });

  it("Tab stays with a dialog that was opened over the drawer", () => {
    stop = shell.initShell("admin", { store: mkStore(null), media: mkMedia(true) });
    byId("menu-btn").click();
    byId("modal-root").append(new FakeElement("div"));
    links[2]!.focus();
    expect(press("Tab")).toBe(false);
    expect(doc().activeElement).toBe(links[2]);
  });

  it("the CSS shows the menu button only below 768 px, and has no collapsed sidebar", () => {
    const css = readFileSync("ui/css/pages/shell.css", "utf8");
    const narrowAt = css.indexOf("@media (max-width: 767px) {\n  .side { display: none; position: fixed;");
    expect(narrowAt).toBeGreaterThan(-1);
    expect(css.slice(0, narrowAt)).toContain(".menu-btn { display: none;");
    expect(css.slice(narrowAt, css.indexOf("\n}", narrowAt))).toContain(".menu-btn { display: inline-flex; }");
    expect(css).not.toContain("side-closed");
    // the project switcher in the sidebar is drawn in the flow: the scrolling sidebar would clip an absolute panel
    expect(css).toMatch(/\.side \.context-panel \{ position: static;/);
    expect(css).toMatch(/\.side a:focus-visible \{ outline-offset: calc\(var\(--focus-width\) \* -1\); \}/);
  });

  it("safeStore survives a missing or throwing localStorage", () => {
    const g = globalThis as any;
    const saved = g.localStorage;
    try {
      delete g.localStorage;
      const none = shell.safeStore();
      expect(none.getItem("k")).toBeNull();
      expect(() => none.setItem("k", "v")).not.toThrow();
      g.localStorage = { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); } };
      const broken = shell.safeStore();
      expect(broken.getItem("k")).toBeNull();
      expect(() => broken.setItem("k", "v")).not.toThrow();
      const mem: Record<string, string> = {};
      g.localStorage = { getItem: (k: string) => mem[k] ?? null, setItem: (k: string, v: string) => { mem[k] = v; } };
      const ok = shell.safeStore();
      ok.setItem("k", "v");
      expect(ok.getItem("k")).toBe("v");
    } finally {
      if (saved === undefined) delete g.localStorage;
      else g.localStorage = saved;
    }
  });
});
