import { h, mount } from "./dom.js";
import { subnavFor } from "./ia.js";

// The frame around a page: which top link is on, the secondary row, the breadcrumb line and the tab title.

export const TITLE = "Spaghetti Code Foundry";

let pageTitle = "";
let waiting = 0;

/** The tab title. With no page it is the plain name, or "(n) Foundry" when items wait. */
export function titleText(page, count) {
  if (!page) return count > 0 ? `(${count}) Foundry` : TITLE;
  return count > 0 ? `(${count}) ${page} · Foundry` : `${page} · ${TITLE}`;
}

/** Remembers the count of waiting items and writes the tab title. */
export function setCount(count) {
  waiting = count;
  document.title = titleText(pageTitle, waiting);
}

function hide(el, list) {
  el.hidden = list.length === 0;
}

/** Draws the frame for `to`, the result of resolve(). */
export function showPage(role, to) {
  const key = to.dest ?? to.page.id;
  for (const a of document.querySelectorAll("[data-nav]")) {
    if (a.getAttribute("data-nav") === key) {
      a.classList.add("active");
      a.setAttribute("aria-current", "page");
    } else {
      a.classList.remove("active");
      a.removeAttribute("aria-current");
    }
  }
  const subnav = document.getElementById("subnav");
  if (subnav) {
    const links = to.dest ? subnavFor(role, to.dest) : [];
    const own = to.page.nav === "detail" ? to.page.parent : to.page.id;
    mount(subnav, links.map((l) => h("a", { href: l.href, class: l.id === own ? "active" : null, "aria-current": l.id === own ? "page" : null }, l.label)));
    hide(subnav, links);
  }
  const crumbs = document.getElementById("crumbs");
  if (crumbs) {
    mount(crumbs, to.crumbs.flatMap((c, i) => [
      i ? h("span", { "aria-hidden": "true" }, " › ") : null,
      c.href ? h("a", { href: c.href }, c.label) : h("span", { "aria-current": "page" }, c.label),
    ]));
    hide(crumbs, to.crumbs);
  }
  pageTitle = to.title;
  document.title = titleText(pageTitle, waiting);
}
