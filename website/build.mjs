#!/usr/bin/env node
// Builds the website (spaghetti-code-foundry.com) from docs/ and website/content/ into website/dist/.
//   node website/build.mjs [--out <folder>]
// No network, no dependencies beyond the repository's own (`yaml`). The same input always gives the same output,
// except the build date in the sitemap when a file has no git history.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { escapeHtml as e, frontMatter, inline, plainText, render } from "./lib/markdown.mjs";
import { splitDocument, summary } from "./lib/docs.mjs";
import { NAV, SITE, page } from "./lib/layout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DOCS = join(ROOT, "docs");
const CONTENT = join(HERE, "content");

/** Reference documents that become one page each. */
const REFERENCE = [
  { file: "FLOW_AUTHORING.md", url: "/flow-format/", title: "Flow format reference", crumb: "Flow format" },
  { file: "DESIGN.md", url: "/design/", title: "How the Foundry is built", crumb: "Design" },
  { file: "THREAT_MODEL.md", url: "/security/", title: "Security and threat model", crumb: "Security" },
  { file: "LESSONS_LEARNED.md", url: "/lessons-learned/", title: "Lessons learned building an AI coding factory", crumb: "Lessons learned" },
];
const DOC_URLS = { "USER_GUIDE.md": "/guide/", ...Object.fromEntries(REFERENCE.map((r) => [r.file, r.url])) };
const HOWTO_GROUPS = ["Get started", "Daily work", "Configure and extend"];

/** Build the site; returns { pages, problems, out }. */
export function build({ out = join(HERE, "dist"), quiet = false, gitDates = true } = {}) {
  const problems = [];
  const pages = []; // { url, html, title, description, sections, source, sitemap }
  const imageSizes = new Map();

  // ---------- links ----------
  const guideMd = readFileSync(join(DOCS, "USER_GUIDE.md"), "utf8");
  const guide = splitDocument(guideMd, { base: "/guide/" });
  const refs = REFERENCE.map((r) => ({ ...r, doc: splitDocument(readFileSync(join(DOCS, r.file), "utf8"), { base: r.url, split: false }) }));
  const anchorsOf = { "/guide/": guide.anchors, ...Object.fromEntries(refs.map((r) => [r.url, r.doc.anchors])) };

  const imageSize = (file) => {
    if (!imageSizes.has(file)) {
      try {
        const b = readFileSync(file);
        imageSizes.set(file, b.readUInt32BE(0) === 0x89504e47 ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null);
      } catch {
        imageSizes.set(file, null);
      }
    }
    return imageSizes.get(file);
  };

  /** A link target in a source file (`fromFile` relative to the repository) as a URL of the site or of GitHub. */
  const resolveHref = (raw, ctx) => {
    const href = raw.trim();
    if (/^(https?:|mailto:)/.test(href)) return href;
    const [path, hash] = href.split("#");
    const anchor = (base, id) => {
      if (!id) return base;
      const hit = anchorsOf[base]?.get(id);
      if (!hit) problems.push(`${ctx.source}: no heading "${id}" in ${base}`);
      return hit ?? `${base}#${id}`;
    };
    if (!path) return ctx.base ? anchor(ctx.base, hash) : `#${hash}`;
    if (path.startsWith("/")) {
      if (anchorsOf[path] && hash) return anchor(path, hash);
      return href;
    }
    const repoPath = posix.normalize(posix.join(posix.dirname(ctx.source), path));
    const name = posix.basename(repoPath);
    if (repoPath.startsWith("docs/") && DOC_URLS[name] && !repoPath.slice(5).includes("/")) return anchor(DOC_URLS[name], hash);
    if (repoPath.startsWith("docs/images/")) return `/images/${name}`;
    if (repoPath.startsWith("..")) {
      problems.push(`${ctx.source}: link outside the repository: ${href}`);
      return SITE.repo;
    }
    return `${SITE.repo}/blob/main/${repoPath}${hash ? `#${hash}` : ""}`;
  };

  const imageHtml = (srcUrl, alt) => {
    const file = srcUrl.startsWith("/images/") ? join(DOCS, "images", posix.basename(srcUrl)) : null;
    const size = file ? imageSize(file) : null;
    if (file && !size) problems.push(`missing image ${srcUrl}`);
    const wh = size ? ` width="${size[0]}" height="${size[1]}"` : "";
    return `<img src="${e(srcUrl)}" alt="${e(alt)}"${wh} loading="lazy" decoding="async">`;
  };

  /** Render Markdown of a source file; headings get the given ids in order. */
  const md = (text, ctx, { ids = null, shift = 0 } = {}) => {
    const toc = [];
    let k = 0;
    const html = render(text, {
      headingShift: shift,
      href: (u) => resolveHref(u, ctx),
      src: (u) => resolveHref(u, ctx),
      image: (src, alt) => imageHtml(src, alt),
      heading: (level, raw, slug) => {
        const id = ids ? (ids[k++] ?? slug(raw)) : slug(raw);
        toc.push({ level, id, text: plainText(raw) });
        return { id };
      },
    });
    return { html, toc };
  };

  const add = (p) => {
    if (pages.some((x) => x.url === p.url)) problems.push(`two pages for ${p.url}`);
    if (!p.description) problems.push(`${p.url}: no description`);
    pages.push({ ...p, html: page(p) });
  };

  // ---------- user guide ----------
  const guideSide = {
    label: "User guide",
    groups: [{ title: "User guide", items: guide.pages.filter((p) => p.level <= 2).map((p) => ({ url: p.url, title: p.key === "index" ? "Overview" : p.heading.text.replace(/^(\d+)\.\s*/, "$1. "), children: (p.children ?? []).map((c) => ({ url: c.url, title: c.title })) })) }],
  };
  const guideDescriptions = parseYaml(readFileSync(join(CONTENT, "guide-descriptions.yaml"), "utf8")) ?? {};
  for (const [k, v] of Object.entries(guideDescriptions)) {
    if (!guide.pages.some((p) => p.url === `/guide/${k}/`)) problems.push(`website/content/guide-descriptions.yaml: no guide page "${k}"`);
    if (String(v).length > 155) problems.push(`website/content/guide-descriptions.yaml: "${k}" is longer than 155 characters`);
  }
  const order = guide.pages;
  order.forEach((gp, i) => {
    const ctx = { source: "docs/USER_GUIDE.md", base: "/guide/" };
    const lines = gp.md.split("\n");
    // the page's own heading becomes the H1 of the layout
    const body = gp.heading && lines[0] === gp.heading.line ? lines.slice(1).join("\n") : gp.md;
    const ids = gp.heading && lines[0] === gp.heading.line ? gp.ids.slice(1) : gp.ids;
    const shift = gp.level === 1 ? 0 : 1 - gp.level + 1 - 1; // ## on a chapter page and ### on a section page become h2
    const { html, toc } = md(body, ctx, { ids, shift: gp.level === 1 ? 0 : gp.level === 2 ? -1 : -2 });
    void shift;
    const isIndex = gp.key === "index";
    const chapter = gp.level === 3 ? guide.pages.find((p) => p.key === gp.parent) : null;
    const title = isIndex ? "User guide" : gp.level === 3 ? `${gp.title} (${gp.chapterTitle})` : gp.title;
    const crumbs = [{ name: "Home", url: "/" }, { name: "User guide", url: "/guide/" }];
    if (chapter) crumbs.push({ name: chapter.title, url: chapter.url });
    if (!isIndex) crumbs.push({ name: gp.title, url: gp.url });
    const description = isIndex
      ? "The complete Spaghetti Code Foundry user guide: running flows, watchers and labels, models and routing, safety, costs, refinement and the command line."
      : guideDescriptions[gp.url.slice("/guide/".length, -1)] || summary(body) || `${gp.title}: part of the Spaghetti Code Foundry user guide.`;
    const childList = gp.children?.length
      ? `<h2 id="in-this-chapter">More in this chapter</h2><ul class="cards">${gp.children.map((c) => `<li><a href="${c.url}">${e(c.title)}</a></li>`).join("")}</ul>`
      : "";
    const chapterList = isIndex
      ? `<h2 id="chapters">Chapters</h2><ol class="chapter-list">${guide.pages
          .filter((p) => p.level === 2)
          .map((p) => `<li><a href="${p.url}">${e(p.title)}</a><span>${e(summary(p.md.split("\n").slice(1).join("\n"), 140))}</span></li>`)
          .join("")}</ol>`
      : "";
    add({
      url: gp.url,
      title,
      fullTitle: isIndex ? `User guide | ${SITE.name}` : `${title} | SCF user guide`,
      h1: isIndex ? "Spaghetti Code Foundry user guide" : gp.level === 2 ? gp.heading.text.replace(/^(\d+)\.\s*/, "$1. ") : gp.title,
      description,
      body: isIndex ? html.replace(/<ul>[\s\S]*?<\/ul>\s*<hr>\s*$/, "") + chapterList : html + childList,
      toc,
      side: guideSide,
      crumbs,
      prev: i > 0 ? { url: order[i - 1].url, title: order[i - 1].key === "index" ? "User guide" : order[i - 1].title } : null,
      next: i + 1 < order.length ? { url: order[i + 1].url, title: order[i + 1].title } : null,
      jsonld: [{ "@context": "https://schema.org", "@type": "TechArticle", headline: title, description, url: `${SITE.url}${gp.url}`, isPartOf: { "@type": "WebSite", name: SITE.name, url: SITE.url }, inLanguage: "en" }],
      editPath: "docs/USER_GUIDE.md",
      source: "docs/USER_GUIDE.md",
      sections: toc,
      text: plainText(body),
    });
  });

  // ---------- reference documents ----------
  for (const r of refs) {
    const [only] = r.doc.pages;
    const ctx = { source: `docs/${r.file}`, base: r.url };
    const lines = only.md.split("\n");
    const hasH1 = only.heading && lines[0] === only.heading.line;
    const body = hasH1 ? lines.slice(1).join("\n") : only.md;
    const { html, toc } = md(body, ctx, { ids: hasH1 ? only.ids.slice(1) : only.ids });
    const description = summary(body) || `${r.title}: Spaghetti Code Foundry documentation.`;
    add({
      url: r.url,
      title: r.title,
      h1: r.title,
      description,
      body: html,
      toc,
      crumbs: [{ name: "Home", url: "/" }, { name: r.crumb, url: r.url }],
      jsonld: [{ "@context": "https://schema.org", "@type": "TechArticle", headline: r.title, description, url: `${SITE.url}${r.url}`, inLanguage: "en" }],
      editPath: `docs/${r.file}`,
      source: `docs/${r.file}`,
      sections: toc,
      text: plainText(body),
    });
  }

  // ---------- how-to guides ----------
  const howDir = join(CONTENT, "how-to");
  const howtos = (existsSync(howDir) ? readdirSync(howDir) : [])
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const { data, body } = frontMatter(readFileSync(join(howDir, f), "utf8"), parseYaml);
      if (!data.title || !data.description || !data.slug || !data.group) problems.push(`website/content/how-to/${f}: front matter needs title, description, slug and group`);
      if (data.slug && `${data.slug}.md` !== f) problems.push(`website/content/how-to/${f}: slug "${data.slug}" does not match the file name`);
      return { ...data, body, file: f };
    })
    .sort((a, b) => HOWTO_GROUPS.indexOf(a.group) - HOWTO_GROUPS.indexOf(b.group) || (a.order ?? 99) - (b.order ?? 99));
  const howSide = {
    label: "How-to guides",
    groups: HOWTO_GROUPS.map((g) => ({ title: g, items: howtos.filter((h) => h.group === g).map((h) => ({ url: `/how-to/${h.slug}/`, title: h.title.replace(/^How to /, "").replace(/^./, (c) => c.toUpperCase()) })) })),
  };
  howtos.forEach((h, i) => {
    const url = `/how-to/${h.slug}/`;
    const ctx = { source: `website/content/how-to/${h.file}`, base: null };
    const { html, toc } = md(h.body, ctx);
    // HowTo structured data: the steps are the ### headings under "## Steps"
    const steps = [];
    const stepRe = /^###\s+\d+\.\s+(.+)$/gm;
    const stepsPart = /## Steps\n([\s\S]*?)(\n## |$)/.exec(h.body)?.[1] ?? "";
    let m;
    while ((m = stepRe.exec(stepsPart))) {
      const after = stepsPart.slice(m.index + m[0].length).split(/\n###\s/)[0];
      const text = summary(after, 300) || plainText(m[1]);
      const id = toc.find((t) => t.text === plainText(`${/^\d+\./.exec(m[0].replace(/^###\s+/, ""))?.[0] ?? ""} ${m[1]}`.trim()))?.id;
      steps.push({ "@type": "HowToStep", name: plainText(m[1]), text, ...(id ? { url: `${SITE.url}${url}#${id}` } : {}) });
    }
    add({
      url,
      title: h.title,
      fullTitle: `${h.title} | ${SITE.name}`,
      h1: h.title,
      description: h.description,
      body: html,
      toc,
      side: howSide,
      crumbs: [{ name: "Home", url: "/" }, { name: "How-to guides", url: "/how-to/" }, { name: h.title.replace(/^How to /, "").replace(/^./, (c) => c.toUpperCase()), url }],
      prev: i > 0 ? { url: `/how-to/${howtos[i - 1].slug}/`, title: howtos[i - 1].title } : null,
      next: i + 1 < howtos.length ? { url: `/how-to/${howtos[i + 1].slug}/`, title: howtos[i + 1].title } : null,
      jsonld: steps.length
        ? [{ "@context": "https://schema.org", "@type": "HowTo", name: h.title, description: h.description, ...(h.time ? { totalTime: h.time } : {}), step: steps }]
        : [{ "@context": "https://schema.org", "@type": "TechArticle", headline: h.title, description: h.description }],
      editPath: `website/content/how-to/${h.file}`,
      source: `website/content/how-to/${h.file}`,
      sections: toc,
      text: plainText(h.body),
    });
  });
  const howIndex = HOWTO_GROUPS.map((g) => {
    const items = howtos.filter((h) => h.group === g);
    if (!items.length) return "";
    const id = g.toLowerCase().replace(/\s+/g, "-");
    return `<h2 id="${id}">${e(g)}</h2><ul class="cards howto-cards">${items
      .map((h) => `<li><a href="/how-to/${h.slug}/"><strong>${e(h.title)}</strong><span>${e(h.description)}</span></a></li>`)
      .join("")}</ul>`;
  }).join("");
  add({
    url: "/how-to/",
    title: "How-to guides",
    fullTitle: `How-to guides | ${SITE.name}`,
    h1: "How-to guides",
    lead: "Short, step-by-step guides for the things you do most: installing the Foundry, letting it build your GitHub issues, approving plans, writing flows and keeping it all safe.",
    description: "Step-by-step guides for Spaghetti Code Foundry: install it, let it build GitHub issues, approve plans, write flows, choose models and stay safe.",
    body: howIndex,
    toc: HOWTO_GROUPS.map((g) => ({ level: 2, id: g.toLowerCase().replace(/\s+/g, "-"), text: g })),
    side: howSide,
    crumbs: [{ name: "Home", url: "/" }, { name: "How-to guides", url: "/how-to/" }],
    jsonld: [{ "@context": "https://schema.org", "@type": "CollectionPage", name: "How-to guides", url: `${SITE.url}/how-to/` }],
    source: "website/content/how-to",
    sections: [],
    text: howtos.map((h) => `${h.title} ${h.description}`).join(" "),
  });

  // ---------- features ----------
  {
    const { data, body } = frontMatter(readFileSync(join(CONTENT, "features.md"), "utf8"), parseYaml);
    const { html, toc } = md(body, { source: "website/content/features.md", base: null });
    add({
      url: "/features/",
      title: data.title,
      fullTitle: `${data.title} | ${SITE.name}`,
      h1: data.title,
      lead: data.lead,
      description: data.description,
      body: html,
      toc,
      crumbs: [{ name: "Home", url: "/" }, { name: "Features", url: "/features/" }],
      jsonld: [],
      editPath: "website/content/features.md",
      source: "website/content/features.md",
      sections: toc,
      text: plainText(body),
    });
  }

  // ---------- home ----------
  {
    const faq = parseYaml(readFileSync(join(CONTENT, "faq.yaml"), "utf8"));
    const faqHtml = faq
      .map((f, i) => `<details${i === 0 ? " open" : ""}><summary>${e(f.q)}</summary><div>${render(f.a, { href: (u) => resolveHref(u, { source: "website/content/faq.yaml" }) })}</div></details>`)
      .join("\n");
    const howCards = howtos
      .filter((h) => h.group === "Get started")
      .slice(0, 6)
      .map((h) => `<li><a href="/how-to/${h.slug}/"><strong>${e(h.title)}</strong><span>${e(h.description)}</span></a></li>`)
      .join("");
    const tpl = readFileSync(join(CONTENT, "home.html"), "utf8");
    const body = tpl.replace("{{faq}}", faqHtml).replace("{{howto}}", howCards).replace(/{{repo}}/g, SITE.repo);
    const description = "Spaghetti Code Foundry is an open-source AI coding factory on your own machine: label a GitHub issue and it plans, codes, tests, reviews and merges.";
    add({
      url: "/",
      kind: "home",
      title: SITE.name,
      fullTitle: `${SITE.name}: your own AI coding factory, from GitHub issue to merged code`,
      description,
      body,
      ogType: "website",
      jsonld: [
        { "@context": "https://schema.org", "@type": "WebSite", name: SITE.name, alternateName: "SCF", url: `${SITE.url}/`, inLanguage: "en" },
        {
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: SITE.name,
          alternateName: "SCF",
          applicationCategory: "DeveloperApplication",
          operatingSystem: "macOS",
          description,
          url: `${SITE.url}/`,
          downloadUrl: SITE.repo,
          license: "https://opensource.org/licenses/MIT",
          isAccessibleForFree: true,
          offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
          screenshot: `${SITE.url}${SITE.image}`,
        },
        { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: plainText(f.a.replace(/\n/g, " ")) } })) },
      ],
      source: "website/content/home.html",
      sections: [],
      text: plainText(body.replace(/<[^>]+>/g, " ")),
    });
  }

  // ---------- 404 ----------
  pages.push({
    url: "/404.html",
    noSitemap: true,
    html: page({
      url: "/404.html",
      kind: "plain",
      noindex: true,
      title: "Page not found",
      description: "This page does not exist. Search the documentation or start from the home page.",
      body: `<div class="wrap narrow"><h1>Page not found</h1><p>This page does not exist, or it moved. Try the search above, or go to the <a href="/">home page</a>, the <a href="/how-to/">how-to guides</a> or the <a href="/guide/">user guide</a>.</p></div>`,
    }),
  });

  // ---------- link check over the generated pages ----------
  const urls = new Set(pages.map((p) => p.url));
  const idsOf = new Map(pages.map((p) => [p.url, new Set([...p.html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))]));
  for (const p of pages) {
    for (const m of p.html.matchAll(/\shref="(\/[^"]*)"/g)) {
      const [path, hash] = m[1].replace(/&amp;/g, "&").split("#");
      if (/^\/(assets|images)\//.test(path) || ["/favicon.svg", "/sitemap.xml"].includes(path)) continue;
      if (!urls.has(path)) problems.push(`${p.url}: link to a page that does not exist: ${m[1]}`);
      else if (hash && !idsOf.get(path).has(hash)) problems.push(`${p.url}: link to a missing anchor: ${m[1]}`);
    }
  }

  // ---------- write ----------
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const p of pages) {
    const file = p.url.endsWith("/") ? join(out, p.url, "index.html") : join(out, p.url);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, p.html);
  }
  cpSync(join(HERE, "assets"), join(out, "assets"), { recursive: true });
  cpSync(join(DOCS, "images"), join(out, "images"), { recursive: true });
  for (const f of ["favicon.svg", "CNAME"]) cpSync(join(HERE, "static", f), join(out, f));

  const lastmod = (source) => {
    if (!gitDates) return null;
    try {
      return execFileSync("git", ["log", "-1", "--format=%cs", "--", source], { cwd: ROOT, encoding: "utf8" }).trim() || null;
    } catch {
      return null;
    }
  };
  const dates = new Map();
  const listed = pages.filter((p) => !p.noSitemap);
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${listed
  .map((p) => {
    if (!dates.has(p.source)) dates.set(p.source, lastmod(p.source));
    const d = dates.get(p.source);
    return `  <url><loc>${SITE.url}${p.url}</loc>${d ? `<lastmod>${d}</lastmod>` : ""}</url>`;
  })
  .join("\n")}
</urlset>
`;
  writeFileSync(join(out, "sitemap.xml"), sitemap);
  writeFileSync(join(out, "robots.txt"), `User-agent: *\nAllow: /\n\nSitemap: ${SITE.url}/sitemap.xml\n`);
  writeFileSync(
    join(out, "llms.txt"),
    `# ${SITE.name}\n\n> ${SITE.tagline}. Open source (MIT), runs on macOS with Claude Code and the Codex CLI.\n\n## Docs\n\n${listed
      .filter((p) => p.url !== "/")
      .map((p) => `- [${p.title}](${SITE.url}${p.url}): ${p.description}`)
      .join("\n")}\n`,
  );
  // search index: one entry per page and per h2/h3 section
  const index = [];
  for (const p of listed) {
    index.push({ t: p.title, u: p.url, d: p.description });
    for (const s of p.sections ?? []) if (s.level <= 3) index.push({ t: s.text, u: `${p.url}#${s.id}`, p: p.title });
  }
  writeFileSync(join(out, "search-index.json"), JSON.stringify(index));

  if (!quiet) {
    console.log(`built ${pages.length} pages into ${out}`);
    for (const pr of problems) console.log(`PROBLEM ${pr}`);
  }
  return { pages, problems, out };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const { problems } = build({ out: i > 0 ? resolve(process.argv[i + 1]) : undefined });
  process.exit(problems.length ? 1 : 0);
}
void NAV;
void inline;
