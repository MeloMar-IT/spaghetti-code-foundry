// A small Markdown renderer for the website: the subset of GitHub-flavoured Markdown the docs use. No dependencies.
// Block: ATX headings, fenced code, block quotes, tables, ordered and unordered lists (nested by indentation), rules,
// paragraphs. Inline: code spans, images, links, autolinks, bold, italic, strike-through, hard line breaks.
// Every piece of text is escaped; raw HTML in the source is shown as text, never rendered.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/** The plain text of an inline Markdown string: formatting, links and images removed. */
export function plainText(md) {
  return String(md)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:[^>\s]+)>/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .trim();
}

/** GitHub's heading slug: lower case, punctuation removed (letters, numbers, `_`, `-` and spaces kept), spaces to `-`. */
export function githubSlug(text) {
  return plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
}

/** A slugger that numbers duplicates the way GitHub does (`x`, `x-1`, `x-2`). */
export function makeSlugger() {
  const seen = new Map();
  return (text) => {
    const base = githubSlug(text);
    if (!seen.has(base)) {
      seen.set(base, 0);
      return base;
    }
    let n = seen.get(base);
    let id;
    do id = `${base}-${++n}`;
    while (seen.has(id));
    seen.set(base, n);
    seen.set(id, 0);
    return id;
  };
}

const safeUrl = (url) => {
  const u = String(url).trim();
  if (/^(javascript|data|vbscript):/i.test(u)) return "#";
  return u;
};

/**
 * Inline Markdown to HTML. `opts.href(url)` may rewrite link targets, `opts.src(url)` image sources,
 * `opts.image(src, alt)` may return the full <img> markup.
 */
export function inline(md, opts = {}) {
  const href = opts.href ?? ((u) => u);
  const src = opts.src ?? ((u) => u);
  const tokens = [];
  const stash = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let s = String(md);
  // code spans first: their content is literal
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => stash(`<code>${escapeHtml(code.replace(/^ (.*) $/, "$1"))}</code>`));
  // images and links (one level of brackets inside the text)
  s = s.replace(/!\[((?:[^\]\\]|\\.)*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, alt, url, title) => {
    const a = plainText(alt);
    if (opts.image) return stash(opts.image(src(url), a, title));
    return stash(`<img src="${escapeHtml(safeUrl(src(url)))}" alt="${escapeHtml(a)}" loading="lazy">`);
  });
  s = s.replace(/\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*<?([^)\s>]+)>?(?:\s+"([^"]*)")?\s*\)/g, (_, text, url, title) => {
    const target = safeUrl(href(url));
    const ext = /^https?:\/\//.test(target);
    const t = title ? ` title="${escapeHtml(title)}"` : "";
    return stash(`<a href="${escapeHtml(target)}"${t}${ext ? ' rel="noopener"' : ""}>${inline(text, opts)}</a>`);
  });
  s = s.replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => stash(`<a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(url)}</a>`));
  s = escapeHtml(s);
  s = s
    .replace(/\\([\\`*_{}\[\]()#+\-.!|~&gt;&lt;])/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/ {2,}\n/g, "<br>\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => tokens[Number(i)]);
}

const isFence = (line) => /^\s{0,3}(```|~~~)/.exec(line);
const listItem = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const splitRow = (line) => {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "`") inCode = !inCode;
    if (c === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (c === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
};

/**
 * Block Markdown to HTML. Options as for inline(), plus `opts.heading(level, text)` which returns
 * `{ id, html? }` for every heading (the caller collects the outline) and `opts.headingShift` to demote headings.
 */
export function render(md, opts = {}) {
  const lines = String(md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  const slug = opts.slugger ?? makeSlugger();
  const shift = opts.headingShift ?? 0;
  let i = 0;

  const para = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join("\n"), opts)}</p>`);
    para.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];
    const fence = isFence(line);
    if (fence) {
      flushPara();
      const mark = fence[1];
      const lang = line.trim().slice(3).trim().split(/\s+/)[0] || "";
      const indent = /^\s*/.exec(line)[0].length;
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(mark)) {
        code.push(lines[i].slice(Math.min(indent, /^\s*/.exec(lines[i])[0].length)));
        i++;
      }
      i++;
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code${cls}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      const level = Math.max(2, Math.min(6, h[1].length + shift));
      const text = h[2];
      const info = opts.heading?.(level, text, slug) ?? { id: slug(text) };
      const id = info.id;
      out.push(`<h${level} id="${escapeHtml(id)}">${inline(text, opts)}<a class="anchor" href="#${escapeHtml(id)}" aria-label="Link to this section">#</a></h${level}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) && !para.length) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flushPara();
      const quote = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s{0,3}> ?/, ""));
        i++;
      }
      out.push(`<blockquote>${render(quote.join("\n"), { ...opts, slugger: slug })}</blockquote>`);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]) && !para.length) {
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      const al = (j) => (aligns[j] ? ` style="text-align:${aligns[j]}"` : "");
      const thead = `<tr>${head.map((c, j) => `<th scope="col"${al(j)}>${inline(c, opts)}</th>`).join("")}</tr>`;
      const tbody = rows.map((r) => `<tr>${head.map((_, j) => `<td${al(j)}>${inline(r[j] ?? "", opts)}</td>`).join("")}</tr>`).join("\n");
      out.push(`<div class="table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`);
      continue;
    }
    const li = listItem.exec(line);
    // a bullet list (or an ordered one starting at 1) may interrupt a paragraph, as in GitHub's renderer
    if (li && (!para.length || /^\s*$/.test(lines[i - 1] ?? "") || /^[-*+]$/.test(li[2]) || /^1[.)]$/.test(li[2]))) {
      flushPara();
      const [html, next] = renderList(lines, i, opts, slug);
      out.push(html);
      i = next;
      continue;
    }
    para.push(line.replace(/^\s+/, ""));
    i++;
  }
  flushPara();
  return out.join("\n");
}

/** A list starting at line `start`; returns [html, next line]. Items keep their continuation lines and nested lists. */
function renderList(lines, start, opts, slug) {
  const first = listItem.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const m = listItem.exec(lines[i]);
    if (!m || m[1].length !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[1].length + m[2].length + 1;
    const body = [m[3]];
    i++;
    let blank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        blank = true;
        body.push("");
        i++;
        continue;
      }
      const indent = /^\s*/.exec(l)[0].length;
      const sub = listItem.exec(l);
      if (sub && indent === baseIndent) break;
      if (indent < baseIndent + 1 && !sub && blank) break;
      if (indent <= baseIndent && !sub && !blank) {
        // a lazy continuation line of the item's paragraph
        if (isFence(l) || /^#{1,6}\s/.test(l) || /^\s{0,3}>/.test(l)) break;
        body.push(l.trim());
        i++;
        continue;
      }
      if (indent <= baseIndent && blank) break;
      body.push(l.slice(Math.min(indent, contentIndent)));
      if (blank && !sub) loose = true;
      blank = false;
      i++;
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    items.push(body);
    // a blank line between two items makes the list loose
    const nextItem = i < lines.length ? listItem.exec(lines[i]) : null;
    if (lines[i - 1] !== undefined && !lines[i - 1].trim() && nextItem && nextItem[1].length === baseIndent && /\d/.test(nextItem[2]) === ordered) loose = true;
  }
  const htmlItems = items.map((body) => {
    const text = body.join("\n");
    const simple = !loose && !body.some((l, k) => k > 0 && (listItem.test(l) || isFence(l) || l === ""));
    if (simple) return `<li>${inline(text, opts)}</li>`;
    const inner = render(text, { ...opts, slugger: slug });
    return `<li>${loose ? inner : inner.replace(/^<p>([\s\S]*?)<\/p>/, "$1")}</li>`;
  });
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  return [`<${tag}${startAttr}>\n${htmlItems.join("\n")}\n</${tag}>`, i];
}

/** Front matter (`---` YAML block at the top): returns { data, body }. `parseYaml` is the yaml package's parse. */
export function frontMatter(text, parseYaml) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(String(text).replace(/\r\n?/g, "\n"));
  if (!m) return { data: {}, body: text };
  return { data: parseYaml(m[1]) ?? {}, body: text.slice(m[0].length) };
}
