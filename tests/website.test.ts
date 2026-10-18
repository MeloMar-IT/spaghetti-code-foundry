import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error plain ES modules of the website, without types
import { build } from "../website/build.mjs";
// @ts-expect-error plain ES modules of the website, without types
import { githubSlug, inline, makeSlugger, render } from "../website/lib/markdown.mjs";
// @ts-expect-error plain ES modules of the website, without types
import { splitDocument, summary } from "../website/lib/docs.mjs";

type Page = { url: string; html: string; title: string; description: string; noSitemap?: boolean };

describe("website Markdown", () => {
  it("makes GitHub's heading anchors, numbering duplicates", () => {
    expect(githubSlug("6. Automate with watchers")).toBe("6-automate-with-watchers");
    expect(githubSlug("The label pipeline: one label → plan + code → one pull request")).toBe("the-label-pipeline-one-label--plan--code--one-pull-request");
    expect(githubSlug("Self-repair (for admins)")).toBe("self-repair-for-admins");
    const slug = makeSlugger();
    expect([slug("Setup"), slug("Setup"), slug("Setup")]).toEqual(["setup", "setup-1", "setup-2"]);
  });

  it("escapes HTML and keeps code literal", () => {
    expect(inline("<script>alert(1)</script> and `<b>`")).toBe("&lt;script&gt;alert(1)&lt;/script&gt; and <code>&lt;b&gt;</code>");
    expect(render("```html\n<b>x</b>\n```")).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(inline("[x](javascript:alert(1))")).toContain('href="#"');
  });

  it("renders nested lists, tables and links with a rewritten target", () => {
    const html = render("- a\n  - b\n- c\n\n| A | B |\n|---|---|\n| `x\\|y` | [l](DESIGN.md) |", { href: (u: string) => (u === "DESIGN.md" ? "/design/" : u) });
    expect(html).toMatch(/<li>a\n<ul>\n<li>b<\/li>\n<\/ul><\/li>/);
    expect(html).toContain('<th scope="col">A</th>');
    expect(html).toContain('<a href="/design/">l</a>');
  });

  it("splits a document by chapter and keeps every anchor", () => {
    const doc = "# T\n\nIntro.\n\n## 1. One\n\nText.\n\n### Part\n\n```\n## not a heading\n```\n\n## 2. Two\n\nMore.";
    const { pages, anchors } = splitDocument(doc, { base: "/g/" });
    expect(pages.map((p: { url: string }) => p.url)).toEqual(["/g/", "/g/1-one/", "/g/2-two/"]);
    expect(anchors.get("part")).toBe("/g/1-one/#part");
    expect(anchors.get("2-two")).toBe("/g/2-two/");
    expect(anchors.has("not-a-heading")).toBe(false);
  });

  it("summarises the first real paragraph within the limit", () => {
    const s = summary(`# T\n\n- list\n\n${"word ".repeat(60)}`);
    expect(s.length).toBeLessThanOrEqual(155);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("website build", () => {
  let out: string;
  let pages: Page[];
  let problems: string[];
  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "scf-site-"));
    ({ pages, problems } = build({ out, quiet: true, gitDates: false }));
  });
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("builds without a broken link, anchor, image or front matter", () => {
    expect(problems).toEqual([]);
  });

  it("has the home page, the how-to section, every guide chapter and the reference pages", () => {
    const urls = pages.map((p) => p.url);
    for (const u of ["/", "/features/", "/how-to/", "/how-to/install/", "/guide/", "/guide/1-start/", "/guide/14-ask-scf/", "/flow-format/", "/design/", "/security/", "/lessons-learned/", "/404.html"]) expect(urls).toContain(u);
    expect(urls.filter((u) => u.startsWith("/how-to/") && u !== "/how-to/").length).toBeGreaterThanOrEqual(20);
    const guide = readFileSync(join(process.cwd(), "docs/USER_GUIDE.md"), "utf8");
    const chapters = [...guide.matchAll(/^## (\d+\..*)$/gm)].map((m) => `/guide/${githubSlug(m[1])}/`);
    for (const c of chapters) expect(urls).toContain(c);
  });

  it("gives every page a unique title, a description of at most 160 characters, a canonical URL and social tags", () => {
    const titles = new Set<string>();
    for (const p of pages) {
      const title = /<title>(.*?)<\/title>/.exec(p.html)?.[1] ?? "";
      expect(titles.has(title), `${p.url} repeats the title ${title}`).toBe(false);
      titles.add(title);
      const desc = /<meta name="description" content="([^"]*)">/.exec(p.html)?.[1].replace(/&[a-z#0-9]+;/g, "x") ?? "";
      expect(desc.length, p.url).toBeGreaterThan(50);
      expect(desc.length, p.url).toBeLessThanOrEqual(160);
      expect(p.html).toContain(`<link rel="canonical" href="https://spaghetti-code-foundry.com${p.url}">`);
      expect(p.html).toContain('<meta property="og:image"');
      expect(p.html.match(/<h1[\s>]/g)?.length, `${p.url} has one h1`).toBe(1);
    }
  });

  it("writes valid structured data: HowTo steps for the how-to guides, FAQ and software on the home page", () => {
    const ld = (p: Page) => [...p.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
    const home = ld(pages.find((p) => p.url === "/")!);
    expect(home.map((o) => o["@type"])).toEqual(expect.arrayContaining(["WebSite", "SoftwareApplication", "FAQPage"]));
    const install = ld(pages.find((p) => p.url === "/how-to/install/")!).find((o) => o["@type"] === "HowTo");
    expect(install.step.length).toBeGreaterThanOrEqual(3);
    expect(ld(pages.find((p) => p.url === "/guide/1-start/")!).map((o) => o["@type"])).toContain("BreadcrumbList");
  });

  it("writes the sitemap, robots.txt, the search index, llms.txt and the domain file", () => {
    const sitemap = readFileSync(join(out, "sitemap.xml"), "utf8");
    for (const p of pages.filter((x) => !x.noSitemap)) expect(sitemap).toContain(`<loc>https://spaghetti-code-foundry.com${p.url}</loc>`);
    expect(sitemap).not.toContain("404");
    expect(readFileSync(join(out, "robots.txt"), "utf8")).toContain("Sitemap: https://spaghetti-code-foundry.com/sitemap.xml");
    expect(readFileSync(join(out, "CNAME"), "utf8").trim()).toBe("spaghetti-code-foundry.com");
    const index = JSON.parse(readFileSync(join(out, "search-index.json"), "utf8"));
    expect(index.some((e: { u: string }) => e.u === "/how-to/install/")).toBe(true);
    expect(readFileSync(join(out, "llms.txt"), "utf8")).toContain("/guide/");
    expect(readdirSync(join(out, "images"))).toContain("home.png");
    expect(readFileSync(join(out, "404.html"), "utf8")).toContain('content="noindex"');
  });
});
