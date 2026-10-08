import { enterDisplay, isNoHash, linkToken, userPage } from "/auth.js";
import { h, mount } from "/dom.js";
import { resolve } from "/ia.js";
import { renderRefinement } from "/refinement.js";
import { renderRepos } from "/repos.js";
import { renderMyRun, renderMyRuns } from "/user/runs.js";
import { homeHash, renderStart } from "/user/start.js";
import { initShell, showPage } from "/shell.js";
import { beginView } from "/view-as.js";

const main = document.getElementById("main");
let cleanup = null;
let generation = 0;
// Set after sign-in: an admin who opened /user/?as=<id> sees a read-only preview of that user.
let readOnly = false;
// Nothing is drawn when the view has ended, or when it cannot be named: the card on the page says so.
let stopped = false;

async function route() {
  // A set-password link is only for the sign-in page: load it again to show that page.
  if (linkToken(location.hash)) return location.reload();
  if (stopped) return;
  const mine = ++generation;
  let hash = location.hash;
  if (isNoHash(hash)) {
    hash = await homeHash();
    // A hash change during the lookup has taken over.
    if (mine !== generation) return;
  }
  const page = userPage(hash);
  // A hash without a page here is never drawn: the address bar goes to the Runs list.
  if (page.hash !== location.hash) history.replaceState(null, "", page.hash);
  cleanup?.();
  cleanup = null;
  showPage("user", resolve("user", page.hash));
  // Each call draws into its own box, so a slow page that finishes after a hash change cannot touch the current one.
  const box = h("div", {});
  mount(main, box);
  let done = null;
  try {
    if (page.section === "start") done = await renderStart(box, { readOnly });
    else if (page.section === "refinement") done = await renderRefinement(box, { admin: false, id: page.id, readOnly });
    else if (page.section === "repos") done = await renderRepos(box, { admin: false, readOnly });
    else if (page.id) done = renderMyRun(box, page.id, { readOnly });
    else done = await renderMyRuns(box, { readOnly });
  } catch (e) {
    if (mine === generation && !stopped) mount(box, h("div", { class: "errors" }, e.message));
    return;
  }
  // A newer call has taken over: stop what this one started and keep nothing of it.
  if (mine !== generation) done?.();
  else cleanup = done;
}

// `as` is read before sign-in. An admin without it is sent to / (enterDisplay does not return); with it, the admin stays
// and gets the read-only preview. A user ignores it.
const as = new URLSearchParams(location.search).get("as") || "";
const me = await enterDisplay("user", { viewAs: as });
initShell("user", { user: me });
const view = beginView(as, me, {
  box: document.getElementById("view-as"),
  main,
  onEnded: () => {
    stopped = true;
    generation++;
    cleanup?.();
    cleanup = null;
  },
});
readOnly = view.readOnly;
stopped = !view.ready;
// Only now: before the role is known, a hash change must not draw a page.
window.addEventListener("hashchange", route);
await route();
