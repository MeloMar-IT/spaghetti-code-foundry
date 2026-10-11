import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JavaScript module without types
import { BREAKPOINTS, STACKED_MAX, levelNotice, mediaFor, queryFor, supportLevel } from "../ui/viewport.js";
// @ts-expect-error plain JavaScript module without types
import { PAGES } from "../ui/ia.js";
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

describe("support levels", () => {
  const FLOW = new Set(["flows", "flow", "new-flow"]);
  it("gives every page its level at the edge widths", () => {
    for (const p of PAGES as { id: string; area: string }[]) {
      const admin = p.area === "administration";
      for (const w of [360, 767, 768, 1023, 1024]) {
        const expected = (admin && w <= 767) || (FLOW.has(p.id) && w <= 1023) ? "read-only" : "full";
        expect(supportLevel(p.id, w), `${p.id} at ${w}`).toBe(expected);
      }
    }
    expect(supportLevel("library", 360)).toBe("full");
  });
  it("is full for an unknown id or no usable width", () => {
    expect(supportLevel("nope", 360)).toBe("full");
    expect(supportLevel("users", undefined)).toBe("full");
    expect(supportLevel("users", NaN)).toBe("full");
    expect(supportLevel(undefined, 360)).toBe("full");
  });
  it("words the notice", () => {
    expect(levelNotice("users")).toBe("Editing needs a wider screen (768 px or more).");
    expect(levelNotice("flow")).toContain("1024 px");
    expect(levelNotice("flow")).not.toContain("unsaved");
    expect(levelNotice("flow", { dirty: true })).toContain("unsaved changes are kept");
    for (const id of ["library", "home", "nope"]) expect(levelNotice(id)).toBeNull();
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

describe("tables", () => {
  const css = readUiCss();
  const compact = css.slice(css.indexOf("@media (max-width: 767px) {\n  .table-box > .table.cards"));

  it("turns the critical tables into cards below 768 px", () => {
    expect(compact).toContain(".table-box > .table.cards { display: block");
    expect(compact).toMatch(/\.table\.cards thead \{[^}]*position: absolute/);
    expect(compact).toMatch(/\.table\.cards td\[data-label\]::before \{[^}]*content: attr\(data-label\)/);
    expect(compact).toMatch(/\.table\.cards tbody tr \{[^}]*display: flex/);
    expect(compact).toMatch(/\.table\.cards td\.actions \{[^}]*order: 1/);
    expect(compact).toMatch(/\.table\.cards td \{[^}]*overflow-wrap: anywhere/);
  });

  it("decorates only the body rows, so the clipped header row keeps no box of its own", () => {
    expect(compact).not.toMatch(/\.table\.cards tr \{/);
  });

  it("puts the link of a run card first below 768 px", () => {
    expect(compact).toMatch(/\.run-card \.row > \.run-link \{[^}]*order: -1/);
    expect(compact).toMatch(/\.run-card \.pill \{[^}]*white-space: normal;[^}]*max-width: 100%/);
    expect(compact).toMatch(/\.run-card \[data-label\]::before \{[^}]*content: attr\(data-label\)/);
  });

  it("lets a table box shrink inside a grid card and holds its screen-reader-only text inside", () => {
    expect(css).toMatch(/\.table-box \{[^}]*position: relative;[^}]*overflow-x: auto;[^}]*min-width: 0/);
  });

  it("puts every table of a page in a .table-box", () => {
    // `h("table"` must follow `tableBox(` (or the old `class: "table-box" }, `) directly.
    const bare: string[] = [];
    for (const f of walk("ui").filter((p) => p.endsWith(".js") && !p.includes(join("ui", "kit")))) {
      const text = read(f);
      for (const m of text.matchAll(/h\("table"/g)) {
        const before = text.slice(Math.max(0, m.index! - 40), m.index);
        if (!/tableBox\($|class: "table-box" \}, $/.test(before)) bare.push(`${f}:${text.slice(0, m.index).split("\n").length}`);
      }
    }
    // The table in ui/dom.js is the helper itself; ui/monitor.js boxes its `table` variable on the next lines.
    expect(bare.filter((b) => !b.startsWith(join("ui", "dom.js")) && !b.startsWith(join("ui", "monitor.js")))).toEqual([]);
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
