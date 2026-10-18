// Splits a long Markdown document into website pages and keeps every GitHub-style anchor working.
// The user guide becomes one page per chapter (`## …`); a long chapter becomes one page per section (`### …`).
// Heading ids are made with one slugger over the whole document, in order, so they equal the anchors GitHub shows.
import { makeSlugger, plainText } from "./markdown.mjs";

/** Lines with their heading level (0 = not a heading), ignoring anything inside fenced code. */
export function scanHeadings(md) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let fence = null;
  lines.forEach((line, n) => {
    const f = /^\s{0,3}(```|~~~)/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      out.push({ n, line, level: 0 });
      return;
    }
    const h = !fence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    out.push(h ? { n, line, level: h[1].length, text: h[2] } : { n, line, level: 0 });
  });
  return out;
}

const SPLIT_LINES = 900; // a chapter longer than this becomes several pages
const MIN_SECTION_LINES = 80; // a shorter section stays on the page before it
const stripNumber = (t) => plainText(t).replace(/^\d+\.\s*/, "");

/**
 * Pages of a document. `base` is the URL of the first page (for example `/guide/`).
 * Returns { pages: [{ key, url, title, heading, level, md, ids }], anchors: Map(id → url), title }.
 * Each page's `ids` are the heading ids of its own headings, in order, for the renderer.
 */
export function splitDocument(md, { base, split = true }) {
  const scanned = scanHeadings(md);
  const slug = makeSlugger();
  const lines = scanned.map((s) => s.line);
  const heads = scanned.filter((s) => s.level > 0).map((s) => ({ ...s, id: slug(s.text) }));
  const h1 = heads.find((h) => h.level === 1);
  const chapters = heads.filter((h) => h.level === 2);
  const pages = [];
  const anchors = new Map();
  const end = lines.length;

  const firstChapter = split && chapters.length ? chapters[0].n : end;
  const intro = { key: "index", url: base, title: h1 ? plainText(h1.text) : "", heading: h1, level: 1, from: 0, to: firstChapter };
  pages.push(intro);

  if (split) {
    chapters.forEach((ch, k) => {
      const to = k + 1 < chapters.length ? chapters[k + 1].n : end;
      const url = `${base}${ch.id}/`;
      const sections = heads.filter((h) => h.level === 3 && h.n > ch.n && h.n < to);
      if (to - ch.n > SPLIT_LINES && sections.length >= 3) {
        const parent = { key: ch.id, url, title: stripNumber(ch.text), heading: ch, level: 2, from: ch.n, to, children: [] };
        pages.push(parent);
        let current = parent;
        sections.forEach((sec, j) => {
          const sTo = j + 1 < sections.length ? sections[j + 1].n : to;
          if (sTo - sec.n < MIN_SECTION_LINES) {
            current.to = sTo; // short: stays on the page before it
            return;
          }
          current.to = sec.n;
          const child = { key: `${ch.id}/${sec.id}`, url: `${url}${sec.id}/`, title: plainText(sec.text), heading: sec, level: 3, from: sec.n, to: sTo, parent: ch.id, chapterTitle: stripNumber(ch.text) };
          parent.children.push(child);
          pages.push(child);
          current = child;
        });
      } else {
        pages.push({ key: ch.id, url, title: stripNumber(ch.text), heading: ch, level: 2, from: ch.n, to });
      }
    });
  }

  for (const p of pages) {
    p.md = lines.slice(p.from, p.to).join("\n");
    p.heads = heads.filter((h) => h.n >= p.from && h.n < p.to);
    p.ids = p.heads.map((h) => h.id);
    for (const h of p.heads) anchors.set(h.id, h === p.heading ? p.url : `${p.url}#${h.id}`);
  }
  return { pages, anchors, title: h1 ? plainText(h1.text) : "" };
}

/** The first paragraph of Markdown as plain text, cut at a word boundary to at most `max` characters. */
export function summary(md, max = 155) {
  const blocks = String(md).split(/\n\s*\n/);
  for (const b of blocks) {
    const t = b.trim();
    if (!t || /^(#|```|~~~|\||!\[|<|>|[-*+]\s|\d+\.\s|---)/.test(t)) continue;
    const text = plainText(t.replace(/\n/g, " ")).replace(/\s+/g, " ");
    if (text.length < 40) continue;
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.\s]+$/, "")}…`;
  }
  return "";
}
