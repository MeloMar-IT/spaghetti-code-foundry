import { initAsk } from "/ask.js";
import { initContext } from "/context.js";
import { enterDisplay, isNoHash, linkToken, userPage } from "/auth.js";
import { h, mount } from "/dom.js";
import { resolve } from "/ia.js";
import { parseFilter } from "/runs-filter.js";
import { renderRefinement } from "/refinement.js";
import { renderRepo } from "/repo-view.js";
import { renderRepos } from "/repos.js";
import { renderMyRun, renderMyRuns } from "/user/runs.js";
import { renderHome } from "/home.js";
import { renderStart } from "/user/start.js";
import { initPalette } from "/palette.js";
import { initShell, namePage, showPage } from "/shell.js";
import { errorState, explainError } from "/states.js";
import { beginView } from "/view-as.js";

const main = document.getElementById("main");
let cleanup = null;
let generation = 0;
// Set after sign-in: an admin who opened /user/?as=<id> sees a read-only preview of that user.
let readOnly = false;
// Nothing is drawn when the view has ended, or when it cannot be named: the card on the page says so.
let stopped = false;
// Stops the search dialog when the view ends.
let stopPalette = null;
// The repository switcher; null while the view cannot be shown.
let context = null;

// The switcher changes the address through this: a navigation, or only the address (drawn again or not).
function contextGo(hash, { replace = false, draw = true } = {}) {
  if (!replace) {
    if (hash !== location.hash) location.hash = hash;
    return;
  }
  history.replaceState(null, "", hash);
  if (draw) void route();
}

async function route() {
  // A set-password link is only for the sign-in page: load it again to show that page.
  if (linkToken(location.hash)) return location.reload();
  if (stopped) return;
  const mine = ++generation;
  let hash = location.hash;
  if (isNoHash(hash)) hash = "#/home";
  const page = userPage(hash);
  // A hash without a page here is never drawn: the address bar goes to the Runs list.
  if (page.hash !== location.hash) history.replaceState(null, "", page.hash);
  cleanup?.();
  cleanup = null;
  let to = resolve("user", page.hash);
  // A bare page that follows the repository context gets it in the address; an address that was replaced does not.
  const scoped = to.redirected || page.hash !== hash ? null : context?.scoped(to.hash);
  if (scoped) { history.replaceState(null, "", scoped); to = resolve("user", scoped); }
  showPage("user", to);
  // Filters change the address without a navigation; with a repository context, clearing the repository writes repo=all.
  const go = (next) => history.replaceState(null, "", context ? context.keep(next) : next);
  // Each call draws into its own box, so a slow page that finishes after a hash change cannot touch the current one.
  const box = h("div", {});
  mount(main, box);
  let done = null;
  try {
    if (page.section === "home") done = await renderHome(box, { readOnly });
    else if (page.section === "start") done = await renderStart(box, { readOnly });
    else if (page.section === "refinement") done = await renderRefinement(box, { admin: false, id: page.id, readOnly, query: to.query, go });
    else if (page.section === "repos" && page.id) done = await renderRepo(box, { id: page.id, admin: false, readOnly, onName: (n) => { if (mine === generation) namePage(n); } });
    else if (page.section === "repos") done = await renderRepos(box, { admin: false, readOnly, query: to.query, go });
    else if (page.id) done = renderMyRun(box, page.id, { readOnly });
    else done = await renderMyRuns(box, { readOnly, query: to.query, go, filter: parseFilter(to.hash), alive: () => mine === generation && !stopped });
  } catch (e) {
    if (mine === generation && !stopped) mount(box, errorState(explainError(e, { what: "This page could not be loaded." }), { onRetry: route }));
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
    stopPalette?.();
    stopPalette = null;
    context?.stop();
    generation++;
    cleanup?.();
    cleanup = null;
  },
});
readOnly = view.readOnly;
stopped = !view.ready;
if (view.ready) stopPalette = initPalette({ role: "user", user: me, preview: view.readOnly });
if (view.ready) context = initContext("user", me, { readOnly, go: contextGo });
// Ask SCF: only for the person's own display (a preview shows no conversations), and only when it is switched on.
if (view.ready && !view.readOnly) void initAsk("user");
// Only now: before the role is known or the context has loaded, a hash change must not draw a page.
// The first draw below uses the latest address.
await context?.ready;
window.addEventListener("hashchange", route);
await route();
