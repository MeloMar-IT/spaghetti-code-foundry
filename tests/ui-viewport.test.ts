import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript module without types
import { BREAKPOINTS, STACKED_MAX, mediaFor, queryFor } from "../ui/viewport.js";
import { readUiCss } from "./helpers/ui-css.js";
import { usesDrawer } from "./browser/widths.js";

// One list of breakpoints (ui/viewport.js): every width in the CSS and the JavaScript must be one of them.

const MAX = new Set<number>([BREAKPOINTS.compact, BREAKPOINTS.medium, STACKED_MAX]);
const MIN = new Set<number>([BREAKPOINTS.compact + 1, BREAKPOINTS.medium + 1]);
const read = (f: string) => readFileSync(f, "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
const widthsIn = (text: string) => [...text.matchAll(/\((max|min)-width:\s*(\d+)px\)/g)].map((m) => ({ kind: m[1], px: Number(m[2]) }));
const allowed = (w: { kind: string; px: number }) => (w.kind === "max" ? MAX : MIN).has(w.px);

describe("ui/viewport.js", () => {
  it("names the breakpoints", () => {
    expect(BREAKPOINTS).toEqual({ compact: 767, medium: 1023 });
    expect(Object.isFrozen(BREAKPOINTS)).toBe(true);
    expect(STACKED_MAX).toBe(1100);
  });

  it("builds the media queries and rejects unknown names", () => {
    expect(queryFor("compact")).toBe("(max-width: 767px)");
    expect(queryFor("medium")).toBe("(min-width: 768px) and (max-width: 1023px)");
    expect(queryFor("wide")).toBe("(min-width: 1024px)");
    expect(queryFor("stacked")).toBe("(max-width: 1100px)");
    expect(() => queryFor("nope")).toThrow();
  });

  it("asks matchMedia, and is undefined where there is none", () => {
    expect(mediaFor("compact", { matchMedia: (q: string) => ({ q }) })).toEqual({ q: "(max-width: 767px)" });
    expect(mediaFor("compact", {})).toBeUndefined();
  });

  it("is the drawer width of the browser tests", () => {
    expect(usesDrawer(767)).toBe(true);
    expect(usesDrawer(768)).toBe(false);
  });
});

describe("widths in the UI files", () => {
  const cssFiles = walk("ui").filter((f) => f.endsWith(".css"));
  const jsFiles = walk("ui").filter((f) => f.endsWith(".js"));

  it("uses only the documented widths in CSS", () => {
    expect(widthsIn(readUiCss()).length).toBeGreaterThan(0);
    for (const f of cssFiles) for (const w of widthsIn(read(f))) expect(allowed(w), `${f}: ${w.kind}-width ${w.px}`).toBe(true);
  });

  it("uses only the documented widths in JavaScript", () => {
    for (const f of jsFiles) for (const w of widthsIn(read(f))) expect(allowed(w), `${f}: ${w.kind}-width ${w.px}`).toBe(true);
  });

  it("no longer mentions 760px", () => {
    for (const f of [...cssFiles, ...jsFiles, "ui/index.html", "ui/user/index.html"]) expect(read(f), f).not.toContain("760px");
  });
});

describe("touch targets and sheets", () => {
  const css = readUiCss();
  const tokens = read("ui/tokens.css");
  const block = (prelude: string) => css.slice(css.indexOf(prelude));

  it("has the size tokens", () => {
    expect(tokens).toContain("--size-touch: 44px;");
    expect(tokens).toContain("--size-touch-min: 24px;");
  });

  it("sizes the coarse-pointer controls with the token", () => {
    const coarse = block("@media (pointer: coarse) {\n  :is(button");
    const first = coarse.split("\n")[1];
    for (const sel of ["button", ".btn", "select", "summary", ".side a", ".subnav a", ".table a", 'input:not([type="checkbox"]):not([type="radio"])']) expect(first, sel).toContain(sel);
    expect(first).toContain("min-height: var(--size-touch)");
    expect(first).toContain("min-width: var(--size-touch)");
  });

  it("turns the dialog into a bottom sheet below 768 px", () => {
    const compact = block("@media (max-width: 767px) {\n  .backdrop");
    expect(compact).toContain(".backdrop { place-items: end stretch; padding: 0; }");
    expect(compact).toMatch(/\.modal, \.modal:has\(\.block-grid\) \{[^}]*width: 100%;[^}]*max-height: 90vh/);
    expect(compact).toMatch(/\.modal-head \{[^}]*position: sticky/);
    expect(compact).toMatch(/\.toolbar > h1 \{[^}]*flex: 1 1 100%/);
  });
});
