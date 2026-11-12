import { readFileSync, readdirSync, existsSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { SHOTS, imageLinks } from "../scripts/screenshots/shots.js";
import { code, tableRows } from "./helpers/md-table.js";

const GUIDES = ["docs/USER_GUIDE.md", "README.md", "docs/DESIGN.md"];
const names = SHOTS.map((s) => `${s.name}.png`).sort();
const texts = Object.fromEntries(GUIDES.map((g) => [g, readFileSync(g, "utf8")]));
const linked = Object.fromEntries(GUIDES.map((g) => [g, imageLinks(texts[g]!)]));

describe("guide images", () => {
  it("every linked image is a shot and its file exists", () => {
    for (const g of GUIDES) {
      for (const n of linked[g]!) {
        expect(names, `${g} links ${n}`).toContain(n);
        expect(existsSync(`docs/images/${n}`), `${g}: docs/images/${n} is missing`).toBe(true);
      }
    }
  });
  it("every image link in the guides is one the manifest check can read", () => {
    for (const g of GUIDES) {
      expect((texts[g]!.match(/!\[/g) ?? []).length, g).toBe(linked[g]!.length);
    }
  });
  it("every shot is linked from a guide", () => {
    expect([...new Set(Object.values(linked).flat())].sort()).toEqual(names);
  });
  it("docs/images holds exactly the shots", () => {
    expect(readdirSync("docs/images").filter((f) => f.endsWith(".png")).sort()).toEqual(names);
  });
  it("docs/images holds nothing else", () => {
    expect(readdirSync("docs/images").filter((f) => !f.endsWith(".png"))).toEqual([]);
  });
  it("the screenshot table lists exactly the shots", () => {
    const rows = tableRows(readFileSync("docs/ui-redesign/measurement.md", "utf8"), "## Existing screenshots");
    expect(rows.map((r) => code(r[0]!)).sort()).toEqual(names);
    for (const r of rows) expect(r[3], r[0]).toBe("captured from the redesign");
  });
  it("the old image is gone from the guides", () => {
    for (const g of GUIDES) expect(texts[g]!, g).not.toContain("your-turn.png");
  });
});

/* eslint-disable @typescript-eslint/no-explicit-any */
let ia: any;
beforeAll(async () => {
  ia = await import("../ui/ia.js" as string);
});

/** The text of the first **bold** of a cell, or the cell itself. */
const bold = (cell: string): string => /\*\*([^*]+)\*\*/.exec(cell)?.[1] ?? cell;
/** All **bold** names of a text, in order. */
const bolds = (text: string): string[] => [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
/** [place, pages] per row of a page table. */
const tableNav = (rows: string[][]): [string, string][] => rows.map((r) => [bold(r[0]!), r[1]!]);
/** The links of a view's sidebar, the shared places first, then the extra pages (SIDEBAR_MAIN, SIDEBAR_EXTRA). */
const sidebar = (view: string): any[] => {
  const s = ia.sidebarFor(view);
  return [...s.main, ...s.extra];
};
/** [place, pages] of the admin sidebar from ui/ia.js: the secondary pages of a place, or else the name of the page it opens (its title). */
const sidebarNav = (): [string, string][] =>
  sidebar("admin").map((e: any) => [e.label, ia.subnavFor("admin", e.id).map((s: any) => s.label).join(", ") || ia.resolve("admin", e.href).title]);
/** [destination, pages] of the admin display from ui/ia.js (DESTINATIONS, the names of the breadcrumbs). */
const destNav = (): [string, string][] =>
  ia.primaryFor("admin").map((p: any) => [p.label, ia.subnavFor("admin", p.id).map((s: any) => s.label).join(", ") || "—"]);
/** The names in column 1 that are not in `labels`. */
const notIn = (labels: string[]) => (rows: string[][]): string[] => rows.map((r) => bold(r[0]!)).filter((n) => !labels.includes(n));
/** The names in column 1 that are not a place of the admin sidebar. */
const notInNav = (rows: string[][]): string[] => notIn(sidebar("admin").map((e: any) => e.label))(rows);
/** The names in column 1 that are not a destination of ui/ia.js. */
const notInDest = (rows: string[][]): string[] => notIn(ia.primaryFor("admin").map((p: any) => p.label))(rows);
/** The reason and the sidebar name (or, for Start work, the top bar button) of the place an address opens. */
const placeOf = (address: string) => {
  const to = ia.resolve("admin", address);
  if (to.page.id === ia.NEW_CHANGE.id) return { reason: to.reason, label: ia.NEW_CHANGE.label as string };
  const id = to.dest ?? to.page.id;
  return { reason: to.reason, label: sidebar("admin").find((e: any) => e.id === id)?.label as string | undefined };
};
/** A cell without its ** marks. */
const plain = (cell: string): string => cell.replace(/\*\*/g, "");
/** The header line of the first table under a heading. */
const headerOf = (text: string, heading: string): string => {
  const lines = text.split("\n");
  return lines.slice(lines.findIndex((l) => l.trim() === heading) + 1).find((l) => l.startsWith("|")) ?? "";
};
/** A line names `places` in order, then the button `action`. */
const namesInOrder = (line: string, places: string[], action: string): boolean => {
  const b = bolds(line);
  const at = b.indexOf(action);
  return at > 0 && JSON.stringify(b.slice(0, at)) === JSON.stringify(places);
};
/** The guide's user-display line names the sidebar of the Advanced view (the user's default), then + New change. */
const guideUserDisplayOk = (line: string): boolean => namesInOrder(line, sidebar("advanced").map((e: any) => e.label), ia.NEW_CHANGE.label);
/** DESIGN.md's user-display line names the destinations of a user in order, then the Start work action page. */
const designUserDisplayOk = (line: string): boolean =>
  namesInOrder(line, ia.primaryFor("user").map((p: any) => p.label), ia.actionsFor("user")[0].label);

describe("navigation names", () => {
  const guide = texts["docs/USER_GUIDE.md"]!;
  const design = texts["docs/DESIGN.md"]!;
  const readme = texts["README.md"]!;
  const rollout = readFileSync("docs/ui-redesign/rollout.md", "utf8");

  it("the guide's page table matches the navigation", () => {
    // The table sits in "Your first tour", the first part of section 1.
    const tour = "### Your first tour";
    expect(guide.indexOf(tour)).toBeGreaterThan(guide.indexOf("## 1. Start"));
    expect(guide.indexOf(tour)).toBeLessThan(guide.indexOf("## 2. Run a flow"));
    const rows = tableRows(guide, tour);
    expect(headerOf(guide, tour)).toBe("| Place | Pages in it | What it is for |");
    expect(tableNav(rows)).toEqual(sidebarNav());
    expect(notInNav(rows)).toEqual([]);
    expect(rows[0]![2]).toContain("`#/your-turn`");
    for (const r of rows) expect(r[2]!.length, r[0]).toBeGreaterThan(10);
    expect(rows.map((r) => r[2]).join(" ")).not.toContain("Problems:");
  });
  it("the DESIGN table matches the navigation", () => {
    const rows = tableRows(design, "## 15. The web interface");
    expect(headerOf(design, "## 15. The web interface")).toBe("| Place | Pages | Purpose |");
    expect(tableNav(rows)).toEqual(destNav());
    expect(notInDest(rows)).toEqual([]);
  });
  it("the helper catches old names", () => {
    expect(notInNav([["Your turn", "x"], ["**Watchers**", "x"], ["Dashboard", "x"]])).toEqual(["Your turn", "Watchers", "Dashboard"]);
    expect(notInNav([["**Home**", "x"], ["**Runs**", "x"], ["**Today**", "x"]])).toEqual(["Home", "Runs"]);
    expect(notInDest([["Your turn", "x"], ["**Watchers**", "x"], ["Dashboard", "x"]])).toEqual(["Your turn", "Watchers", "Dashboard"]);
  });
  it("the user display line of the guide names the user's sidebar and + New change; DESIGN.md names the destinations and Start work", () => {
    const marker = "works on its own display at `/user/`";
    const line = guide.split("\n").find((l) => l.includes(marker))!;
    expect(guideUserDisplayOk(line.slice(line.indexOf(marker)))).toBe(true);
    expect(guideUserDisplayOk("**Home**, **Epics**, **My runs**, **My repositories**, **Refinement**, **Start work**")).toBe(false);
    const d = design.split("\n").find((l) => l.startsWith("**User display:**"))!;
    expect(designUserDisplayOk(d.replace("**User display:**", ""))).toBe(true);
    expect(d).toContain("`ui/ia.js`");
  });
  it("README uses the navigation names", () => {
    expect(readme).not.toContain("**Your turn**");
    expect(readme).not.toContain("*Your turn*");
    const chains = [...readme.matchAll(/\*\*([^*]+)\*\*(?: → \*\*[^*]+\*\*)+/g)];
    expect(chains.length).toBeGreaterThan(0);
    const labels = sidebar("admin").map((e: any) => e.label);
    for (const c of chains) expect(labels, c[0]).toContain(c[1]);
    const today = ia.SIDEBAR_MAIN.find((e: any) => e.id === "home").label;
    for (const s of ["**Administration** → **Watchers**", `Then watch **${today}**`, `*${today}* shows first what waits for you`, `${today} and the board`]) {
      expect(readme).toContain(s);
    }
    expect(readme).not.toContain("Then watch **Home**");
  });
  it("the guide names the sidebar place where you click and the page where it means the page", () => {
    const today = ia.SIDEBAR_MAIN.find((e: any) => e.id === "home").label;
    for (const s of [`Open **${today}**`, `under **Needs you** on ${today}`, `in the app, on **${today}**`, "(**Administration → Watchers**",
      "(**Administration → Dashboard**)", "### Your turn", `### ${ia.resolve("admin", "#/home").title}`]) {
      expect(guide).toContain(s);
    }
    expect(guide).not.toContain("Open **Home**");
    expect(guide).not.toContain("Open **Your turn**");
    expect(guide).not.toContain("on Your turn |");
    expect(guide).not.toContain("Your turn page");
    expect(guide).toContain("is kept when it is Home, Start work, My runs,");
  });
  it("the part Old and new interface exists and links the rollout page", () => {
    const at = guide.indexOf("### Old and new interface");
    expect(at).toBeGreaterThan(0);
    const end = guide.indexOf("## 2. Run a flow");
    expect(at).toBeLessThan(end);
    expect(guide.slice(at, end)).toContain("](ui-redesign/rollout.md)");
    expect(existsSync("docs/ui-redesign/rollout.md")).toBe(true);
    expect(rollout.split("\n").length).toBeLessThan(60);
    expect(readFileSync("docs/ui-redesign/README.md", "utf8")).toContain("[rollout.md](rollout.md)");
  });
  it("every moved address resolves to the place named in the guide", () => {
    const rows = tableRows(guide, "### Old and new interface");
    expect(rows).toHaveLength(17);
    for (const r of rows) {
      const address = code(r[2]!);
      expect(address.startsWith("#/"), r[0]).toBe(true);
      const p = placeOf(address);
      expect(["alias", null], address).toContain(p.reason);
      expect(p.label, address).toBeTruthy();
      expect(plain(r[1]!).startsWith(p.label!), address).toBe(true);
    }
    // Every shared place whose sidebar name is not the name of its page, and + New change, has a row.
    const renamed = ia.SIDEBAR_MAIN.filter((e: any) => e.label !== ia.resolve("admin", e.href).title).map((e: any) => e.href);
    expect(renamed.length).toBeGreaterThan(0);
    for (const href of [...renamed, ia.NEW_CHANGE.href]) expect(rows.map((r) => code(r[2]!)), href).toContain(href);
    expect(placeOf("#/your-turn")).toEqual({ reason: "alias", label: "Today" });
    expect(placeOf("#/start")).toEqual({ reason: null, label: "+ New change" });
    expect(placeOf("#/nope").reason).toBe("unknown");
  });
  it("the rollout table agrees with the guide", () => {
    const rows = tableRows(rollout, "## What moved where");
    expect(rows).toHaveLength(17);
    for (const r of rows) {
      const p = placeOf(code(r[0]!));
      expect(["alias", null], r[0]).toContain(p.reason);
      expect(p.label, r[0]).toBeTruthy();
      expect(plain(r[2]!).startsWith(p.label!), r[0]).toBe(true);
    }
    const mine = rows.map((r) => code(r[0]!)).sort();
    const theirs = tableRows(guide, "### Old and new interface").map((r) => code(r[2]!)).sort();
    expect(mine).toEqual(theirs);
  });
  it("the rollout page says what is not built", () => {
    for (const s of ["tests/ui-rollout.test.ts", "ui.version", "ui-classic/", "Not built"]) expect(rollout).toContain(s);
  });
});
