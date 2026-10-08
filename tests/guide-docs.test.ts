import { readFileSync, readdirSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
