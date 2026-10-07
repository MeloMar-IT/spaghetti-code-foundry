import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe("titleText", () => {
  it("builds the tab title", () => {
    expect(shell.titleText("", 0)).toBe("Spaghetti Code Foundry");
    expect(shell.titleText("", 3)).toBe("(3) Foundry");
    expect(shell.titleText("Runs", 0)).toBe("Runs · Spaghetti Code Foundry");
    expect(shell.titleText("Runs", 2)).toBe("(2) Runs · Foundry");
  });
});

describe("showPage", () => {
  it("marks one link active and clears the previous one", () => {
    expect(active()).toEqual(["home"]);
    shell.showPage("admin", ia.resolve("admin", "#/runs/r1"));
    expect(active()).toEqual(["runs"]);
    expect(nav[1]!.attrs["aria-current"]).toBe("page");
    expect(nav[0]!.attrs["aria-current"]).toBeUndefined();
    shell.showPage("admin", ia.resolve("admin", "#/start"));
    expect(active()).toEqual(["start"]);
  });

  it("draws and hides the secondary row", () => {
    const sub = doc().getElementById("subnav") as FakeElement;
    expect(sub.hidden).toBe(true);
    shell.showPage("admin", ia.resolve("admin", "#/users"));
    expect(sub.hidden).toBe(false);
    expect(sub.all("a").length).toBe(7);
    expect(sub.all("a").filter((a) => a.attrs.class === "active").map((a) => a.textContent)).toEqual(["Users"]);
    shell.showPage("admin", ia.resolve("admin", "#/runs"));
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
    expect(last.textContent).toBe("Run r1");
    expect(last.attrs["aria-current"]).toBe("page");
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
});
