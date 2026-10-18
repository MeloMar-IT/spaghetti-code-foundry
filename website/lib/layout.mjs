// The HTML around every page: head with SEO and social tags, structured data, header, navigation, footer.
import { escapeHtml as e } from "./markdown.mjs";

export const SITE = {
  name: "Spaghetti Code Foundry",
  short: "SCF",
  url: "https://spaghetti-code-foundry.com",
  repo: "https://github.com/MeloMar-IT/spaghetti-code-foundry",
  tagline: "Your own AI coding factory: from GitHub issue to merged code, on your own machine",
  image: "/images/home.png",
  imageWidth: 1440,
  imageHeight: 900,
};

export const NAV = [
  { url: "/features/", label: "Features" },
  { url: "/how-to/", label: "How-to" },
  { url: "/guide/", label: "User guide" },
  { url: "/flow-format/", label: "Flow format" },
];

const abs = (url) => (/^https?:/.test(url) ? url : `${SITE.url}${url}`);
const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

/** Breadcrumb list as structured data. */
export function breadcrumbLd(crumbs) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.name, item: abs(c.url) })),
  };
}

function header(current) {
  const nav = NAV.map((n) => `<a href="${n.url}"${current.startsWith(n.url) ? ' aria-current="page"' : ""}>${e(n.label)}</a>`).join("");
  return `<a class="skip" href="#main">Skip to content</a>
<header class="site-header">
  <div class="wrap header-row">
    <a class="brand" href="/" aria-label="${e(SITE.name)} home"><span class="logo" aria-hidden="true">◆</span><span class="brand-full">${e(SITE.name)}</span><span class="brand-short">SCF</span></a>
    <button class="menu-toggle" type="button" aria-expanded="false" aria-controls="site-nav">Menu</button>
    <nav id="site-nav" class="site-nav" aria-label="Main">${nav}<a href="${SITE.repo}" rel="noopener" class="nav-gh">GitHub</a></nav>
    <div class="search" role="search">
      <label class="sr-only" for="q">Search the documentation</label>
      <input id="q" type="search" placeholder="Search the docs" autocomplete="off" aria-controls="search-results" aria-expanded="false">
      <div id="search-results" class="search-results" hidden></div>
    </div>
    <button class="theme-toggle" type="button" aria-label="Switch between light and dark">◐</button>
  </div>
</header>`;
}

function footer() {
  return `<footer class="site-footer">
  <div class="wrap footer-grid">
    <div><a class="brand" href="/"><span class="logo" aria-hidden="true">◆</span> ${e(SITE.name)}</a>
      <p>An open-source AI coding factory that runs on your own machine. MIT licence.</p></div>
    <div><h2>Learn</h2><a href="/how-to/install/">Install</a><a href="/how-to/">How-to guides</a><a href="/guide/">User guide</a><a href="/flow-format/">Flow format</a></div>
    <div><h2>Inside</h2><a href="/features/">Features</a><a href="/design/">Design</a><a href="/security/">Security</a><a href="/lessons-learned/">Lessons learned</a></div>
    <div><h2>Project</h2><a href="${SITE.repo}" rel="noopener">GitHub</a><a href="${SITE.repo}/issues" rel="noopener">Issues</a><a href="${SITE.repo}/blob/main/docs/CHANGELOG.md" rel="noopener">Changelog</a><a href="${SITE.repo}/blob/main/LICENSE" rel="noopener">MIT licence</a></div>
  </div>
</footer>`;
}

function crumbsHtml(crumbs) {
  if (!crumbs || crumbs.length < 2) return "";
  const items = crumbs.map((c, i) => (i === crumbs.length - 1 ? `<li aria-current="page">${e(c.name)}</li>` : `<li><a href="${c.url}">${e(c.name)}</a></li>`)).join("");
  return `<nav class="crumbs" aria-label="Breadcrumb"><ol>${items}</ol></nav>`;
}

function tocHtml(toc) {
  const items = (toc ?? []).filter((t) => t.level === 2 || t.level === 3);
  if (items.length < 3) return "";
  return `<nav class="toc" aria-label="On this page"><h2>On this page</h2><ol>${items
    .map((t) => `<li class="toc-${t.level}"><a href="#${e(t.id)}">${e(t.text)}</a></li>`)
    .join("")}</ol></nav>`;
}

function sideNavHtml(side, current) {
  if (!side) return "";
  const groups = side.groups
    .map((g) => {
      const links = g.items
        .map((it) => {
          const sub = it.children?.length
            ? `<ol>${it.children.map((c) => `<li><a href="${c.url}"${c.url === current ? ' aria-current="page"' : ""}>${e(c.title)}</a></li>`).join("")}</ol>`
            : "";
          return `<li><a href="${it.url}"${it.url === current ? ' aria-current="page"' : ""}>${e(it.title)}</a>${sub}</li>`;
        })
        .join("");
      return `${g.title ? `<h2>${e(g.title)}</h2>` : ""}<ol>${links}</ol>`;
    })
    .join("");
  return `<details class="side-wrap" open><summary>${e(side.label)}: contents</summary><nav class="side-nav" aria-label="${e(side.label)}">${groups}</nav></details>`;
}

function pagerHtml(prev, next) {
  if (!prev && !next) return "";
  return `<nav class="pager" aria-label="Previous and next">${prev ? `<a class="prev" href="${prev.url}"><span>Previous</span>${e(prev.title)}</a>` : "<span></span>"}${
    next ? `<a class="next" href="${next.url}"><span>Next</span>${e(next.title)}</a>` : ""
  }</nav>`;
}

/**
 * A complete page. p: { url, title, fullTitle?, description, h1?, body, lead?, crumbs, toc, side, prev, next, jsonld[],
 * ogType, kind ('home'|'doc'|'plain'), editPath? }.
 */
export function page(p) {
  const title = p.fullTitle ?? `${p.title} | ${SITE.name}`;
  const canonical = abs(p.url);
  const ld = [...(p.jsonld ?? []), ...(p.crumbs?.length > 1 ? [breadcrumbLd(p.crumbs)] : [])];
  const edit = p.editPath ? `<p class="edit"><a href="${SITE.repo}/edit/main/${p.editPath}" rel="noopener">Improve this page on GitHub</a></p>` : "";
  const main =
    p.kind === "home" || p.kind === "plain"
      ? `<main id="main" tabindex="-1">${p.body}</main>`
      : `<div class="wrap doc-layout${p.side ? "" : " no-side"}">
  ${sideNavHtml(p.side, p.url)}
  <main id="main" tabindex="-1" class="doc">
    ${crumbsHtml(p.crumbs)}
    <article>
      <h1>${e(p.h1 ?? p.title)}</h1>
      ${p.lead ? `<p class="lead">${e(p.lead)}</p>` : ""}
      ${p.body}
    </article>
    ${edit}
    ${pagerHtml(p.prev, p.next)}
  </main>
  ${tocHtml(p.toc)}
</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<meta name="description" content="${e(p.description)}">
<link rel="canonical" href="${e(canonical)}">
<meta name="robots" content="${p.noindex ? "noindex" : "index, follow"}">
<meta name="theme-color" content="#c2410c">
<meta name="color-scheme" content="light dark">
<meta property="og:site_name" content="${e(SITE.name)}">
<meta property="og:type" content="${e(p.ogType ?? "article")}">
<meta property="og:title" content="${e(p.title)}">
<meta property="og:description" content="${e(p.description)}">
<meta property="og:url" content="${e(canonical)}">
<meta property="og:image" content="${e(abs(SITE.image))}">
<meta property="og:image:width" content="${SITE.imageWidth}">
<meta property="og:image:height" content="${SITE.imageHeight}">
<meta property="og:image:alt" content="The Spaghetti Code Foundry home screen: what needs you, what is running, what finished">
<meta property="og:locale" content="en_GB">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${e(p.title)}">
<meta name="twitter:description" content="${e(p.description)}">
<meta name="twitter:image" content="${e(abs(SITE.image))}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="sitemap" type="application/xml" href="/sitemap.xml">
<link rel="stylesheet" href="/assets/style.css">
<script>try{var t=localStorage.getItem("scf-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
${ld.map((o) => `<script type="application/ld+json">${json(o)}</script>`).join("\n")}
</head>
<body class="kind-${e(p.kind ?? "doc")}">
${header(p.url)}
${main}
${footer()}
<script src="/assets/site.js" defer></script>
</body>
</html>
`;
}
