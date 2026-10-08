import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SeedData } from "./browser/seed.js";
import {
  BASELINE_PLATFORM, EXTRA_WIDTHS, FULL_WIDTH, noBaselinesMessage, PAGES, skipVisual, visualCases,
} from "./browser/visual-matrix.js";
import { WIDTHS } from "./browser/widths.js";

const seed = { runs: { failed: "ui-failed" }, sessionId: "sess-123" } as unknown as SeedData;
const cases = visualCases();

describe("visual matrix", () => {
  it("has the 12 pages", () => {
    expect(PAGES.map((p) => p.id)).toEqual([
      "gallery", "signin", "admin-home", "admin-board", "admin-runs", "admin-run-failed", "admin-repos", "admin-users",
      "user-home", "user-runs", "user-run", "user-refinement-session",
    ]);
  });
  it("has 7 cases per page, no duplicate names, safe file names", () => {
    expect(cases).toHaveLength(PAGES.length * 7);
    const names = cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9-]+$/);
  });
  it("gives every page theme × density at 1440 and light/default at each extra width", () => {
    for (const p of PAGES) {
      const mine = cases.filter((c) => c.page === p);
      for (const theme of ["light", "dark"] as const) for (const density of ["default", "compact"] as const) {
        expect(mine.some((c) => c.theme === theme && c.density === density && c.width === FULL_WIDTH), `${p.id} ${theme} ${density}`).toBe(true);
      }
      for (const w of EXTRA_WIDTHS) expect(mine.some((c) => c.theme === "light" && c.density === "default" && c.width === w), `${p.id} ${w}`).toBe(true);
      for (const c of mine.filter((m) => m.width !== FULL_WIDTH)) expect([c.theme, c.density]).toEqual(["light", "default"]);
    }
  });
  it("uses only known widths", () => {
    for (const c of cases) expect(WIDTHS).toContain(c.width);
  });
  it("takes the role from the page", () => {
    for (const p of PAGES) {
      if (p.kind === "display") expect(p.role).not.toBeNull();
      else expect(p.role).toBeNull();
      if (p.role === "admin") expect(p.masks(seed)).toContain("#repo");
    }
  });
  it("uses the seed in hashes and masks the changing session id", () => {
    const byId = (id: string) => PAGES.find((p) => p.id === id)!;
    expect(byId("admin-run-failed").hash(seed)).toBe("#/runs/ui-failed");
    expect(byId("user-refinement-session").hash(seed)).toContain("sess-123");
    expect(byId("user-refinement-session").masks(seed)).toContain("#page-title");
  });
  it("skips unless on the baseline platform with baselines or updating", () => {
    expect(skipVisual("darwin", false, "none")).toBe(true);
    expect(skipVisual("darwin", false, "missing")).toBe(true);
    expect(skipVisual("darwin", false, "all")).toBe(false);
    expect(skipVisual("darwin", false, "changed")).toBe(false);
    expect(skipVisual("darwin", true, "none")).toBe(false);
    // other platforms never run, not even when updating
    expect(skipVisual("linux", true, "none")).toBe(true);
    expect(skipVisual("linux", false, "all")).toBe(true);
  });
  it("names the platform and the update command in the skip message", () => {
    expect(noBaselinesMessage("linux")).toContain("linux");
    expect(noBaselinesMessage("darwin")).toContain("--update-snapshots");
  });
  it("accepts only the darwin baseline folder, with exactly the case names", () => {
    const root = fileURLToPath(new URL("./browser/__screenshots__", import.meta.url));
    expect(existsSync(join(root, BASELINE_PLATFORM)), "make baselines with: npm run test:ui -- --update-snapshots").toBe(true);
    expect(readdirSync(root).filter((f) => !f.startsWith("."))).toEqual([BASELINE_PLATFORM]);
    const want = cases.map((c) => `${c.name}.png`).sort();
    expect(readdirSync(join(root, BASELINE_PLATFORM)).sort()).toEqual(want);
  });
  it("keeps one threshold constant in the config and a platform path template", () => {
    const text = readFileSync(new URL("./browser/playwright.config.ts", import.meta.url), "utf8");
    expect(text).toMatch(/snapshotPathTemplate:[^\n]*\{platform\}/);
    expect(text.match(/maxDiffPixelRatio:/g)).toHaveLength(1);
    expect(text).toMatch(/maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO/);
  });
});
