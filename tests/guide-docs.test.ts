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
/** The same, from ui/ia.js. */
const iaNav = (): [string, string][] =>
  ia.primaryFor("admin").map((p: any) => [p.label, ia.subnavFor("admin", p.id).map((s: any) => s.label).join(", ") || "—"]);
/** The names in column 1 that are not a primary place of ui/ia.js. */
const notInNav = (rows: string[][]): string[] => {
  const labels = ia.primaryFor("admin").map((p: any) => p.label);
  return rows.map((r) => bold(r[0]!)).filter((n) => !labels.includes(n));
};
/** The reason and the label of the place an address opens. */
const placeOf = (address: string) => {
  const to = ia.resolve("admin", address);
  return { reason: to.reason, label: ia.primaryFor("admin").find((p: any) => p.id === to.dest)?.label as string | undefined };
};
/** The header line of the first table under a heading. */
const headerOf = (text: string, heading: string): string => {
  const lines = text.split("\n");
  return lines.slice(lines.findIndex((l) => l.trim() === heading) + 1).find((l) => l.startsWith("|")) ?? "";
};
/** A user-display line names the primary places of a user in order, then the Start work button. */
const userDisplayOk = (line: string): boolean => {
  const b = bolds(line);
  const at = b.indexOf(ia.actionsFor("user")[0].label);
  return at > 0 && JSON.stringify(b.slice(0, at)) === JSON.stringify(ia.primaryFor("user").map((p: any) => p.label));
};

describe("navigation names", () => {
  const guide = texts["docs/USER_GUIDE.md"]!;
  const design = texts["docs/DESIGN.md"]!;
  const readme = texts["README.md"]!;
  const rollout = readFileSync("docs/ui-redesign/rollout.md", "utf8");

  it("the guide's page table matches the navigation", () => {
    const rows = tableRows(guide, "## 1. Start");
    expect(headerOf(guide, "## 1. Start")).toBe("| Place | Pages in it | What it is for |");
    expect(tableNav(rows)).toEqual(iaNav());
    expect(notInNav(rows)).toEqual([]);
    expect(rows[0]![2]).toContain("`#/your-turn`");
    for (const r of rows) expect(r[2]!.length, r[0]).toBeGreaterThan(10);
    expect(rows.map((r) => r[2]).join(" ")).not.toContain("Problems:");
  });
  it("the DESIGN table matches the navigation", () => {
    const rows = tableRows(design, "## 15. The web interface");
    expect(headerOf(design, "## 15. The web interface")).toBe("| Place | Pages | Purpose |");
    expect(tableNav(rows)).toEqual(iaNav());
    expect(notInNav(rows)).toEqual([]);
  });
  it("the helper catches old names", () => {
    expect(notInNav([["Your turn", "x"], ["**Watchers**", "x"], ["Dashboard", "x"]])).toEqual(["Your turn", "Watchers", "Dashboard"]);
  });
  it("the user display line of the guide and DESIGN.md names the user's places and Start work", () => {
    const line = guide.split("\n").find((l) => l.includes("works on its own display at `/user/`"))!;
    expect(userDisplayOk(line)).toBe(true);
    const d = design.split("\n").find((l) => l.startsWith("**User display:**"))!;
    expect(userDisplayOk(d.replace("**User display:**", ""))).toBe(true);
    expect(d).toContain("`ui/ia.js`");
  });
  it("README uses the navigation names", () => {
    expect(readme).not.toContain("**Your turn**");
    expect(readme).not.toContain("*Your turn*");
    const chains = [...readme.matchAll(/\*\*([^*]+)\*\*(?: → \*\*[^*]+\*\*)+/g)];
    expect(chains.length).toBeGreaterThan(0);
    const labels = ia.primaryFor("admin").map((p: any) => p.label);
    for (const c of chains) expect(labels, c[0]).toContain(c[1]);
    for (const s of ["**Administration** → **Watchers**", "Then watch **Home**", "*Home* shows first what waits for you", "Home and the board"]) {
      expect(readme).toContain(s);
    }
  });
  it("the guide says Home where it means the page", () => {
    for (const s of ["Open **Home**", "under **Needs you** on Home", "in the app, on Home", "(Administration → Watchers", "(Administration → Dashboard)", "### Your turn"]) {
      expect(guide).toContain(s);
    }
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
    expect(rows).toHaveLength(12);
    for (const r of rows) {
      const address = code(r[2]!);
      expect(address.startsWith("#/"), r[0]).toBe(true);
      const p = placeOf(address);
      expect(["alias", null], address).toContain(p.reason);
      expect(r[1]!.startsWith(p.label!), address).toBe(true);
    }
    expect(placeOf("#/your-turn")).toEqual({ reason: "alias", label: "Home" });
    expect(placeOf("#/nope").reason).toBe("unknown");
  });
  it("the rollout table agrees with the guide", () => {
    const rows = tableRows(rollout, "## What moved where");
    expect(rows).toHaveLength(12);
    for (const r of rows) {
      const p = placeOf(code(r[0]!));
      expect(["alias", null], r[0]).toContain(p.reason);
      expect(r[2]!.startsWith(p.label!), r[0]).toBe(true);
    }
    const mine = rows.map((r) => code(r[0]!)).sort();
    const theirs = tableRows(guide, "### Old and new interface").map((r) => code(r[2]!)).sort();
    expect(mine).toEqual(theirs);
  });
  it("the rollout page says what is not built", () => {
    for (const s of ["tests/ui-rollout.test.ts", "ui.version", "ui-classic/", "Not built"]) expect(rollout).toContain(s);
  });
});
