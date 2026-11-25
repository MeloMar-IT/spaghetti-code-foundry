import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module of the website, without types
import { page } from "../website/lib/layout.mjs";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const DIAMOND = "◆";
const TOUCH_LINK = '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';

/** Width, height and colour type from the PNG header bytes; undefined when it is not a PNG with an IHDR chunk first. */
export function pngSize(buf: Buffer): { width: number; height: number; colourType: number } | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 26 || sig.some((b, i) => buf[i] !== b) || buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colourType: buf[25] };
}

/** The text of every element whose class list has the token `logo` (HTML or h("span", {class}, …) calls). */
export function logoGlyphProblems(text: string): string[] {
  const out: string[] = [];
  const html = /<(\w+)\b[^>]*\bclass="(?:[^"]*\s)?logo(?:\s[^"]*)?"[^>]*>([^<]*)</g;
  for (const m of text.matchAll(html)) if (/◆|&#9670;|&#x25c6;/i.test(m[2])) out.push(m[0]);
  const call = /h\(\s*"\w+"\s*,\s*\{[^}]*\bclass:\s*"(?:[^"]*\s)?logo(?:\s[^"]*)?"[^}]*\}\s*,\s*"([^"]*)"/g;
  for (const m of text.matchAll(call)) if (/◆|&#9670;|&#x25c6;/i.test(m[1])) out.push(m[0]);
  return out;
}

/** True when four points form the old diamond: a rhombus with diagonals that cross at their middles,
 *  perpendicular, and with no edge parallel to an axis (a rectangle or square fails one of these). */
function isDiamondPoints(pts: number[][]): boolean {
  if (pts.length !== 4) return false;
  const eps = 1e-6;
  const [a, b, c, d] = pts;
  const mid = (p: number[], q: number[]) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const [m1, m2] = [mid(a, c), mid(b, d)];
  if (Math.abs(m1[0] - m2[0]) > eps || Math.abs(m1[1] - m2[1]) > eps) return false;
  const [d1, d2] = [[c[0] - a[0], c[1] - a[1]], [d[0] - b[0], d[1] - b[1]]];
  if (Math.abs(d1[0] * d2[0] + d1[1] * d2[1]) > eps) return false;
  const edges = [[b, a], [c, b], [d, c], [a, d]];
  return edges.every(([p, q]) => Math.abs(p[0] - q[0]) > eps && Math.abs(p[1] - q[1]) > eps);
}

/** True for a path or polygon that is only straight lines and forms the old diamond. */
export function isDiamondShape(svg: string): boolean {
  const nums = (s: string) => (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  for (const m of svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)) {
    const d = m[1];
    if (/[^MLZmlz\s,\d.-]/.test(d)) continue; // curves and arcs are never the old diamond
    const cmds = d.match(/[A-Za-z]/g) ?? [];
    if (cmds.some((c) => !"MLZ".includes(c))) continue;
    const n = nums(d);
    if (n.length % 2 !== 0) continue;
    const pts: number[][] = [];
    for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    if (isDiamondPoints(pts)) return true;
  }
  for (const m of svg.matchAll(/<polygon\b[^>]*\bpoints="([^"]*)"/g)) {
    const n = nums(m[1]);
    const pts: number[][] = [];
    for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
    if (isDiamondPoints(pts)) return true;
  }
  return false;
}

export const pathsOf = (svg: string): string[] => [...svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].map((m) => m[1]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(html|js|mjs|svg)$/.test(name)) out.push(p);
  }
  return out;
}

const markOf = (html: string) => html.match(/<svg class="mark".*?<\/svg>/s)?.[0] ?? "";

describe("logo glyph check", () => {
  it("finds a diamond in a logo element", () => {
    expect(logoGlyphProblems('<span class="logo" aria-hidden="true">◆</span>')).toHaveLength(1);
    expect(logoGlyphProblems('<span class="brand logo">◆</span>')).toHaveLength(1);
    expect(logoGlyphProblems('h("span", { class: "logo" }, "◆")')).toHaveLength(1);
    expect(logoGlyphProblems('<span class="logo">&#9670;</span>')).toHaveLength(1);
    expect(logoGlyphProblems('<span class="logo">&#x25C6;</span>')).toHaveLength(1);
  });
  it("leaves the step icon and the new mark alone", () => {
    expect(logoGlyphProblems('const ICON = { claude: "◆" }')).toEqual([]);
    expect(logoGlyphProblems('<span class="logo-x">◆</span>')).toEqual([]);
    expect(logoGlyphProblems('<span class="logo"><svg class="mark"><path d="M1 1"></path></svg></span>')).toEqual([]);
  });
  it("detects the old diamond shape only", () => {
    expect(isDiamondShape('<path d="M32 9 55 32 32 55 9 32Z"/>')).toBe(true);
    expect(isDiamondShape('<path d="M32 9L55 32L32 55L9 32Z"/>')).toBe(true);
    expect(isDiamondShape('<polygon points="32,9 55,32 32,55 9,32">')).toBe(true);
    expect(isDiamondShape('<path d="M0 0 64 0 64 64 0 64Z"/>')).toBe(false);
    expect(isDiamondShape('<path d="M0 0 64 0 64 64 0 64 10 10Z"/>')).toBe(false);
    expect(isDiamondShape('<path d="M0 0 64 0 0 64Z"/>')).toBe(false);
    expect(isDiamondShape('<path d="M0 0 60 0 60 60 0 60Z"/>')).toBe(false);
    expect(isDiamondShape('<path d="M0 0C1 1 2 2 3 3 4 4 5 5Z"/>')).toBe(false);
  });
});

describe("brand files", () => {
  it("has no diamond logo or favicon in ui/ or website/", () => {
    const files = [...walk(join(ROOT, "ui")), ...walk(join(ROOT, "website"))];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const name = relative(ROOT, f);
      expect(logoGlyphProblems(text), name).toEqual([]);
      if (/favicon[^/]*\.svg$/.test(f)) {
        expect(text, name).not.toContain(DIAMOND);
        expect(isDiamondShape(text), name).toBe(false);
      }
    }
    for (const f of ["ui/graph.js", "ui/step-types.js", "ui/library.js"]) {
      expect(files).toContain(join(ROOT, f));
      expect(read(f), f).toContain(DIAMOND);
    }
  });

  it("has the two marks with the same drawing and only the colour different", () => {
    const dark = read("docs/brand/mark-on-dark.svg");
    const light = read("docs/brand/mark-on-light.svg");
    expect(pathsOf(dark).length).toBeGreaterThan(3);
    expect(pathsOf(light)).toEqual(pathsOf(dark));
    expect(light.replaceAll("#c2410c", "#f08a50")).toBe(dark);
    for (const s of [dark, light]) for (const bad of ["<text", "<image", "style="]) expect(s).not.toContain(bad);
  });

  it("uses the same inline mark in both app pages and the website header and footer", () => {
    const dark = pathsOf(read("docs/brand/mark-on-dark.svg"));
    const a = read("ui/index.html");
    const b = read("ui/user/index.html");
    const mark = markOf(a);
    expect(mark).toContain('stroke="currentColor"');
    expect(mark).not.toContain("#");
    expect(pathsOf(mark)).toEqual(dark);
    expect(markOf(b)).toBe(mark);
    for (const html of [a, b]) {
      expect(html).toContain(`<span class="logo" aria-hidden="true">${mark}</span>`);
      expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml">');
      expect(html).toContain(TOUCH_LINK);
      expect(html).toContain('<span class="brand-full">Spaghetti Code Foundry</span>');
    }
    const site: string = page({ url: "/", title: "T", description: "d", kind: "plain", body: "" });
    expect(site.slice(0, site.indexOf("</head>"))).toContain(TOUCH_LINK);
    const header = site.slice(site.indexOf("<header"), site.indexOf("</header>"));
    const footer = site.slice(site.indexOf("<footer"), site.indexOf("</footer>"));
    for (const part of [header, footer]) {
      expect(part).toContain(`<span class="logo" aria-hidden="true">${mark}</span>`);
      expect(part).not.toContain(DIAMOND);
    }
  });

  it("has the same flame favicon for the website and the app", () => {
    const w = read("website/static/favicon.svg");
    expect(read("ui/favicon.svg")).toBe(w);
    expect(w).not.toContain("<text");
    expect(w).toContain("#f08a50");
  });

  it("has the Apple touch icon for the website and the app", () => {
    const file = readFileSync(join(ROOT, "website/static/apple-touch-icon.png"));
    expect(pngSize(file)).toEqual({ width: 180, height: 180, colourType: 2 });
    expect(file.length).toBeLessThanOrEqual(150 * 1024);
    expect(readFileSync(join(ROOT, "ui/apple-touch-icon.png")).equals(file)).toBe(true);
  });

  it("links the Apple touch icon from every shipped app page", () => {
    for (const f of ["ui/index.html", "ui/user/index.html", "ui/privacy.html", "ui/accessibility.html"]) {
      expect(read(f), f).toContain(TOUCH_LINK);
    }
  });

  it("reads the size of a PNG from its header only", () => {
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(180, 16);
    png.writeUInt32BE(120, 20);
    png[25] = 2;
    expect(pngSize(png)).toEqual({ width: 180, height: 120, colourType: 2 });
    expect(pngSize(Buffer.from([0xff, 0xd8, 0xff, ...Array(30).fill(0)]))).toBeUndefined();
    expect(pngSize(png.subarray(0, 10))).toBeUndefined();
    const other = Buffer.from(png);
    other.write("IDAT", 12, "ascii");
    expect(pngSize(other)).toBeUndefined();
  });

  it("has the source images", () => {
    for (const f of ["logo.jpg", "mascot.jpg"]) {
      const p = join(ROOT, "docs/brand/source", f);
      expect(existsSync(p), f).toBe(true);
      expect([...readFileSync(p).subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    }
  });
});
