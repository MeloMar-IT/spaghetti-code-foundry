import { enterDisplay, isNoHash, linkToken, userPage } from "/auth.js";
import { h, mount } from "/dom.js";
import { renderRefinement } from "/refinement.js";
import { renderRepos } from "/repos.js";
import { renderRunDetail, renderRunsList } from "/runs.js";
import { homeHash, renderStart } from "/user/start.js";

const main = document.getElementById("main");
let cleanup = null;
let generation = 0;

async function route() {
  // A set-password link is only for the sign-in page: load it again to show that page.
  if (linkToken(location.hash)) return location.reload();
  const mine = ++generation;
  let hash = location.hash;
  if (isNoHash(hash)) {
    hash = await homeHash();
    // A hash change during the lookup has taken over.
    if (mine !== generation) return;
  }
  const page = userPage(hash);
  // A hash without a page here is never drawn: the address bar goes to the Runs list.
  if (page.hash !== location.hash) history.replaceState(null, "", page.hash);  cleanup?.();
  cleanup = null;
  for (const a of document.querySelectorAll("[data-nav]")) {
    const on = a.dataset.nav === page.section;
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  // Each call draws into its own box, so a slow page that finishes after a hash change cannot touch the current one.
  const box = h("div", {});
  mount(main, box);
  let done = null;
  try {
    if (page.section === "start") done = await renderStart(box);
    else if (page.section === "refinement") done = await renderRefinement(box, { admin: false, id: page.id });
    else if (page.section === "repos") done = await renderRepos(box, { admin: false });
    else if (page.id) done = renderRunDetail(box, page.id, { admin: false });
    else done = await renderRunsList(box, { admin: false });
  } catch (e) {
    if (mine === generation) mount(box, h("div", { class: "errors" }, e.message));
    return;
  }
  // A newer call has taken over: stop what this one started and keep nothing of it.
  if (mine !== generation) done?.();
  else cleanup = done;
}

// An admin never gets past this line: enterDisplay sends that account to / and does not return.
await enterDisplay("user");
// Only now: before the role is known, a hash change must not draw a page.
window.addEventListener("hashchange", route);
await route();
