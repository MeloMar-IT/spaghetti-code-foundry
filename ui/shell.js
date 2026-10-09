import { h, mount } from "./dom.js";
import { splitHash, subnavFor } from "./ia.js";

// The frame around a page: which top link is on, the secondary row, the breadcrumb line and the tab title.

export const TITLE = "Spaghetti Code Foundry";

let pageTitle = "";
let waiting = 0;

/** The tab title. With no page it is the plain name, or "(n) Foundry" when items wait. */
export function titleText(page, count) {
  if (!page) return count > 0 ? `(${count}) Foundry` : TITLE;
  return count > 0 ? `(${count}) ${page} · Foundry` : `${page} · ${TITLE}`;
}

/** Remembers the count of waiting items and writes the tab title and the menu button. */
export function setCount(count) {
  waiting = count;
  document.title = titleText(pageTitle, waiting);
  const n = document.getElementById("menu-count");
  if (n) {
    n.textContent = count > 0 ? String(count) : "";
    n.hidden = !(count > 0);
  }
  document.getElementById("menu-btn")?.setAttribute("aria-label", count > 0 ? `Menu, ${count} waiting` : "Menu");
}

// The sidebar, drawer and menu button. One controller per initShell call; showPage and setCount use the current one.
const fresh = () => ({ collapsed: false, drawer: false, narrow: false, shown: 0, apply: null, closeDrawer: null, announce: 0 });
let shell = fresh();

/** What the sidebar does now. narrow: the drawer rules apply. */
export function sideState({ narrow, collapsed, drawer }) {
  return narrow ? { open: !!drawer, modal: !!drawer } : { open: !collapsed, modal: false };
}

function safeStore() {
  try {
    const s = globalThis.localStorage;
    return {
      getItem: (k) => { try { return s.getItem(k); } catch { return null; } },
      setItem: (k, v) => { try { s.setItem(k, v); } catch { /* storage is off: the choice lasts until reload */ } },
    };
  } catch {
    return { getItem: () => null, setItem: () => {} };
  }
}

/** Sets up the menu button, drawer, skip button and account menu. Call once, after sign-in. Returns a stop function. */
export function initShell(role, { user, store = safeStore(), media = globalThis.matchMedia?.("(max-width: 760px)") } = {}) {
  const ctl = fresh();
  shell = ctl;
  const undo = [];
  const on = (target, type, fn) => {
    if (!target?.addEventListener) return;
    target.addEventListener(type, fn);
    undo.push(() => target.removeEventListener?.(type, fn));
  };
  const el = (id) => document.getElementById(id);
  const name = el("account-name");
  if (name && user?.name) name.textContent = user.name;
  // The visible name must be part of the accessible name of the account button.
  if (user?.name) el("account-summary")?.setAttribute("aria-label", `Account for ${user.name}`);
  try { ctl.collapsed = store.getItem("scf-side") === "closed"; } catch { ctl.collapsed = false; }
  ctl.narrow = !!media?.matches;

  const links = () => [...(el("side")?.querySelectorAll("a[href]") ?? [])];
  ctl.apply = () => {
    const st = sideState(ctl);
    const body = document.body;
    body?.classList?.toggle("side-closed", ctl.collapsed);
    body?.classList?.toggle("drawer-open", ctl.drawer);
    el("menu-btn")?.setAttribute("aria-expanded", String(st.open));
    const scrim = el("scrim");
    if (scrim) scrim.hidden = !st.modal;
    // Everything but the drawer and the scrim: the header, the skip button and the page.
    for (const id of ["top", "skip", "content"]) {
      const behind = el(id);
      if (behind) { if (st.modal) behind.setAttribute("inert", ""); else behind.removeAttribute("inert"); }
    }
  };
  /** Closes the drawer; `to` gets focus afterwards (none: focus stays where it is). */
  ctl.closeDrawer = (to) => {
    if (!ctl.drawer) return;
    ctl.drawer = false;
    ctl.apply();
    to?.focus();
  };
  ctl.apply();

  on(el("menu-btn"), "click", () => {
    if (ctl.narrow) {
      if (ctl.drawer) { ctl.closeDrawer(el("menu-btn")); return; }
      ctl.drawer = true;
      ctl.apply();
      links()[0]?.focus();
      return;
    }
    ctl.collapsed = !ctl.collapsed;
    try { store.setItem("scf-side", ctl.collapsed ? "closed" : "open"); } catch { /* the choice lasts until reload */ }
    ctl.apply();
  });
  on(el("scrim"), "click", () => ctl.closeDrawer(el("menu-btn")));
  // Any link in the sidebar closes the drawer, also the one for the page that is already open (no hash change then).
  on(el("side"), "click", (e) => {
    const t = e?.target;
    const link = t?.closest ? t.closest("a[href]") : t?.getAttribute?.("href") != null ? t : null;
    if (ctl.drawer && link) ctl.closeDrawer(el("main"));
  });
  on(el("side-close"), "click", () => ctl.closeDrawer(el("menu-btn")));
  on(document, "keydown", (e) => {
    if (!ctl.drawer) return;
    if (e.key === "Escape") {
      if (el("modal-root")?.children?.length) return; // the dialog's own Escape wins
      ctl.closeDrawer(el("menu-btn"));
    } else if (e.key === "Tab") {
      // The drawer is modal: Tab stays inside it.
      const list = [...(el("side")?.querySelectorAll("a[href], button") ?? [])];
      if (!list.length) return;
      const at = list.indexOf(document.activeElement);
      const to = at < 0 ? list[0] : e.shiftKey && at === 0 ? list.at(-1) : !e.shiftKey && at === list.length - 1 ? list[0] : null;
      if (to) { e.preventDefault?.(); to.focus(); }
    }
  });
  on(media, "change", (e) => {
    ctl.narrow = !!(e?.matches ?? media.matches);
    ctl.drawer = false;
    ctl.apply();
  });
  on(el("skip"), "click", () => el("main")?.focus());

  return () => {
    for (const f of undo.splice(0)) f();
    if (shell === ctl) shell = fresh();
    document.body?.classList?.remove("side-closed", "drawer-open");
    for (const id of ["top", "skip", "content"]) el(id)?.removeAttribute("inert");
  };
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
      // "page" on the link for this very address; "true" on the link of the area it belongs to.
      a.setAttribute("aria-current", a.getAttribute("href") === splitHash(to.hash).path ? "page" : "true");
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
  // Names the place; a detail page adds its argument, because several routes share one title.
  const where = to.arg && !String(to.title).includes(to.arg) ? `${to.title}: ${to.arg}` : String(to.title);
  const title = document.getElementById("page-title");
  if (title) title.textContent = where;
  const main = document.getElementById("main");
  main?.setAttribute("aria-label", where);
  shell.closeDrawer?.(null);
  document.getElementById("account")?.removeAttribute("open");
  if (shell.shown++ === 0) return;
  if (document.getElementById("modal-root")?.contains?.(document.activeElement)) return;
  main?.focus();
  // Clear first and fill a moment later, so the same text twice in a row is announced again.
  const status = document.getElementById("route-status");
  if (status) {
    status.textContent = "";
    const mine = ++shell.announce;
    setTimeout(() => { if (mine === shell.announce) status.textContent = where; }, 50);
  }
}
