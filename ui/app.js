import { api } from "./api.js";
import { initAsk } from "./ask.js";
import { enterDisplay, linkToken } from "./auth.js";
import { h, mount } from "./dom.js";
import { createFlowPage } from "./flow-page.js";
import { resolve, splitHash } from "./ia.js";
import { initContext } from "./context.js";
import { initPalette } from "./palette.js";
import { initShell, namePage, showPage } from "./shell.js";
import { errorState, explainError } from "./states.js";
import { renderLibrary } from "./library.js";
import { renderSettings } from "./admin.js";
import { renderWatchers, renderWatcherDetail } from "./watchers.js";
import { renderMaintenance } from "./maintenance.js";
import { refreshModelLists, renderModelDetail, renderModels } from "./models.js";
import { renderDashboard } from "./dashboard.js";
import { renderProblems, renderProblemDetail } from "./problems.js";
import { renderRunDetail, renderRunsList } from "./runs.js";
import { allAttention, renderAllRepos } from "./admin-repos.js";
import { adminSections, adminSource } from "./repo-admin-sections.js";
import { renderCredentials } from "./admin-credentials.js";
import { renderOperations } from "./operations.js";
import { renderEpic } from "./epic-page.js";
import { renderEpics } from "./epics.js";
import { renderRefinement } from "./refinement.js";
import { SECTIONS, renderRepo } from "./repo-view.js";
import { renderRepos } from "./repos.js";
import { renderUsers } from "./users.js";
import { renderUserDetail } from "./user-detail.js";
import { renderStart } from "./user/start.js";
import { renderAudit } from "./audit.js";
import { renderBoard } from "./board.js";
import { renderWork } from "./work.js";
import { loadHealth, startHealth } from "./health.js";
import { startSince } from "./since.js";
import { renderAdminHome } from "./home-admin.js";
import { parseFilter } from "./runs-filter.js";
import { startBadge, startHash } from "./turn.js";
import { BREAKPOINTS, levelNotice, mediaFor, supportLevel } from "./viewport.js";

const sidebar = document.getElementById("sidebar");
const main = document.getElementById("main");
const healthEl = document.getElementById("health");
const levelNote = document.getElementById("level-note");

// Pages not wired to the support level yet: they keep their controls and get no notice.
const NOT_YET = new Set(["all-repos", "models", "model", "problems", "problem", "maintenance"]);
const levelOf = (id) => (NOT_YET.has(id) ? "full" : supportLevel(id, globalThis.innerWidth));
// The flow pages are view-and-run below 1024 px; asked at the moment of every draw and every change.
const flowsReadOnly = () => supportLevel("flow", globalThis.innerWidth) === "read-only";
let drawn = null; // { id, level, dest } of the page route() drew last
let sideLocked = null; // whether the flow list in the sidebar was drawn without create buttons
let missed = false; // the width crossed a breakpoint while a dialog was open

/**
 * cur: the flow being edited.
 * { name: saved name | null, scope, saveScope, yaml, obj, mode: "visual"|"yaml", dirty, selected, validation }
 */
const S = { info: null, flows: [], flowsLoaded: false, cur: null, cleanup: null, lastHash: "", me: "" };

// The flow page changes the address through this: "go" is a navigation, the others only write the address.
const flowPage = createFlowPage({ main, sidebar, state: S, api, isReadOnly: flowsReadOnly, onNavigate(hash, how) {
  if (how === "go") { location.hash = hash; return; }
  if (how === "push") {
    history.pushState(null, "", hash);
    S.lastHash = hash;
    loadHealth(healthEl); // pushState fires no hashchange
    markDrawn(resolve("admin", hash)); // the flow page now shows: its level and notice follow it
    return;
  }
  history.replaceState(null, "", hash);
  S.lastHash = hash;
} });

// ── routing ──

/** Records the page now on screen with its support level, and shows or hides the notice. Returns true when the page is read-only. */
function markDrawn(to) {
  const level = levelOf(to.page.id);
  drawn = { id: to.page.id, level, dest: to.dest };
  sideLocked = flowsReadOnly();
  const readOnly = level === "read-only";
  const note = readOnly ? levelNotice(to.page.id, { dirty: !!S.cur?.dirty }) : null;
  levelNote.textContent = note ?? "";
  levelNote.hidden = !note;
  return readOnly;
}

function welcome(readOnly) {
  mount(main, h("div", { class: "empty" },
    h("h1", { class: "mb-8" }, "Welcome to Spaghetti Code Foundry"),
    readOnly
      ? h("p", {}, "Pick a flow from the list to read it or to start a test run. Creating and editing flows needs a wider screen.")
      : h("p", {}, "Build your own coding flows: pick a flow on the left, start from a blank one, or describe what you want and let Claude draft it."),
    readOnly ? null : h("div", { class: "row center mt-16" },
      h("button", { class: "primary", onClick: () => flowPage.generateDialog(false) }, "✨ Draft flow with Claude"),
      h("button", { onClick: () => flowPage.newBlank() }, "+ Blank flow"))));
}

let routeGen = 0;
let context = null;
// Routing starts when startAdmin() draws the first page; a navigation before that is drawn by it.
let booted = false;
// The switcher changes the address through this: a navigation, or only the address (drawn again or not).
const contextGo = (hash, { replace = false, draw = true } = {}) => {
  if (!replace) {
    if (hash !== location.hash) location.hash = hash;
    return;
  }
  history.replaceState(null, "", hash);
  S.lastHash = hash;
  if (draw) void route();
};
// The "since you last looked" box: Home places it; it stays hidden until there is something to say.
const sinceEl = h("div", { class: "since" });
sinceEl.hidden = true;

/** Draws a page into a box of its own: once the person leaves, a late answer lands in a box that is no longer on the page. */
async function renderInBox(render) {
  const box = h("div", {});
  mount(main, box);
  await render(box);
}

async function route() {
  if (!booted) return;
  // While a dialog is open (the discard question included) the address is put back: the dialog is not replaced and a busy one is not bypassed.
  // This sits before the generation is counted, or the navigation the person confirms would be dropped as stale.
  if (flowPage.dialogOpen() && S.lastHash) {
    if (location.hash !== S.lastHash) history.replaceState(null, "", S.lastHash);
    return;
  }
  const mine = ++routeGen;
  // A set-password link is only for the sign-in page: load it again to show that page.
  if (linkToken(location.hash)) return location.reload();
  let to = resolve("admin", location.hash);
  if (to.hash !== location.hash) history.replaceState(null, "", to.hash);
  const scoped = to.redirected ? null : context?.scoped(to.hash);
  if (scoped) { history.replaceState(null, "", scoped); to = resolve("admin", scoped); }
  const hash = to.hash;
  const { path } = splitHash(hash);
  const [, section, arg] = path.split("/").map(decodeURIComponent);
  const leavingDraft = S.cur?.dirty && (section !== "flows" || arg !== S.cur.name) && path !== "#/new";
  // Filters change the address without a navigation; the page keeps the address in step.
  // With a repository context, clearing the repository filter writes repo=all (context.keep), so the context does not come back.
  const go = (next) => { const kept = context ? context.keep(next) : next; history.replaceState(null, "", kept); S.lastHash = kept; };
  // Only warn when opening a *different* flow; other pages keep the draft in memory.
  if (leavingDraft && section === "flows" && arg) {
    history.replaceState(null, "", S.lastHash);
    if (!(await flowPage.confirmDiscard())) return;
    history.replaceState(null, "", hash);
  }
  S.lastHash = hash;
  S.cleanup?.();
  S.cleanup = null;
  const readOnly = markDrawn(to);
  showPage("admin", to);
  document.body.classList.toggle("no-side", to.dest !== "flows");
  try {
    if (section === "home") {
      // Draws into its own box, so a slow load that ends after a hash change leaves nothing running.
      const box = h("div", {});
      mount(main, box);
      const done = await renderAdminHome(box, { since: sinceEl });
      if (mine !== routeGen) done?.();
      else S.cleanup = done;
    }
    else if (section === "board") S.cleanup = S.info.redesign ? renderWork(main, arg, { user: S.me, query: to.query, go }) : renderBoard(main, arg, { query: to.query, go });
    else if (section === "library") await renderLibrary(main);
    // These four draw into their own box, so a slow answer that comes after a hash change cannot touch the next page.
    else if (section === "dashboard") await renderInBox(renderDashboard);
    else if (section === "watchers") await renderInBox(arg ? (box) => renderWatcherDetail(box, arg, { readOnly }) : (box) => renderWatchers(box, { readOnly }));
    else if (section === "problems") await renderInBox(arg ? (box) => renderProblemDetail(box, arg) : renderProblems);
    else if (section === "settings") {
      const box = h("div", {});
      mount(main, box);
      const off = await renderSettings(box, { readOnly });
      if (mine === routeGen) S.cleanup = off;
      else off?.(); // the person went on to another page meanwhile
    }
    else if (section === "maintenance") await renderMaintenance(main);
    else if (section === "models") await (arg ? renderModelDetail(main, arg) : renderModels(main));
    else if (section === "all-repos") {
      const off = await renderAllRepos(main, { query: to.query, go });
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "credentials") {
      const off = await renderCredentials(main);
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "operations") {
      const off = await renderOperations(main, { readOnly });
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "epics" && arg) {
      const box = h("div", {});
      mount(main, box);
      const off = await renderEpic(box, { id: arg, admin: true, me: S.me, query: to.query, onName: (n) => { if (mine === routeGen) namePage(n); } });
      if (mine === routeGen) S.cleanup = off;
      else off();
    }
    else if (section === "epics") {
      const box = h("div", {});
      mount(main, box);
      const off = await renderEpics(box, { admin: true, me: S.me, query: to.query, go });
      if (mine === routeGen) S.cleanup = off;
      else off();
    }
    else if (section === "refinement") S.cleanup = await renderRefinement(main, { admin: true, id: arg, query: to.query, go });
    else if (section === "repos" && arg) {
      // Own box: the list's page check is also true on this address, so a late list answer must not draw over the view.
      const box = h("div", {});
      mount(main, box);
      const off = await renderRepo(box, { id: arg, admin: true, sections: adminSections(SECTIONS), source: adminSource(S.me), attention: allAttention, onName: (n) => { if (mine === routeGen) namePage(n); } });
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "repos") {
      const box = h("div", {});
      mount(main, box);
      const off = await renderRepos(box, { admin: true, switcher: true, query: to.query, go });
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "users" && arg) {
      const off = await renderUserDetail(main, arg, { me: S.me, readOnly, onName: (n) => { if (mine === routeGen) namePage(n); } });
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "users") {
      const off = await renderUsers(main, { me: S.me, readOnly });
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "audit") S.cleanup = await renderAudit(main);
    else if (section === "start") {
      // The page draws into its own box, so a slow load that ends after a hash change cannot touch the page that took over.
      const box = h("div", {});
      mount(main, box);
      const done = await renderStart(box, { admin: true });
      if (mine !== routeGen) done?.();
      else S.cleanup = done;
    }
    else if (section === "runs" && arg) S.cleanup = renderRunDetail(main, arg, { admin: true });
    else if (section === "runs") {
      // The list draws into its own box, so a slow answer that comes after a hash change cannot touch the next page.
      const box = h("div", {});
      mount(main, box);
      const done = await renderRunsList(box, { admin: true, query: to.query, go, filter: parseFilter(hash), alive: () => mine === routeGen });
      if (mine !== routeGen) done?.();
      else S.cleanup = done;
    }
    else if (section === "new") {
      if (S.cur && !S.cur.name) flowPage.renderFlowView();
      else if (readOnly) mount(main, h("div", { class: "empty" },
        h("p", {}, `A new flow needs a wider screen (${BREAKPOINTS.medium + 1} px or more).`),
        h("p", {}, h("a", { href: "#/flows" }, "Back to flows"))));
      else flowPage.openNew();
    }
    else if (section === "flows" && arg) await flowPage.openFlow(arg, () => mine === routeGen);
    else welcome(readOnly);
  } catch (e) {
    if (mine !== routeGen) return; // a late error must not replace the page that is shown now
    mount(main, errorState(explainError(e, { what: "This page could not be loaded." }), { onRetry: route }));
  }
  sideLocked = flowsReadOnly();
  flowPage.renderSidebar();
}

window.addEventListener("beforeunload", (e) => S.cur?.dirty && e.preventDefault());
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s" && S.cur && (splitHash(location.hash).path.startsWith("#/flows/") || splitHash(location.hash).path === "#/new")) {
    e.preventDefault();
    flowPage.save();
  }
});

// A user never gets past this line: enterDisplay sends that account to /user/ and does not return.
const me = await enterDisplay("admin");
S.me = me.id;
initShell("admin", { user: me });
// Ask SCF: its button and drawer appear only when it is switched on. The pages do not wait for it.
void initAsk("admin");
initPalette({ role: "admin", user: me });
context = initContext("admin", me, { go: contextGo });
// Only now: before the role is known, a hash change must not draw a page.
window.addEventListener("hashchange", route);

/** The width crossed a breakpoint: redraw only when the level of the drawn page changed; wait for an open dialog. */
function onWidth() {
  // The flow list in the sidebar follows the 1024 px limit by itself, also next to a page that stays as it is (the Library).
  const locked = flowsReadOnly();
  if (drawn?.dest === "flows" && locked !== sideLocked) { sideLocked = locked; flowPage.renderSidebar(); }
  if (!drawn || levelOf(drawn.id) === drawn.level) { missed = false; return; }
  if (flowPage.dialogOpen()) { missed = true; return; }
  missed = false;
  route();
}
for (const name of ["compact", "wide"]) mediaFor(name)?.addEventListener?.("change", onWidth);
// The dialog empties #modal-root before its promise settles, so the redraw waits one task: the action that opened the
// dialog finishes its own follow-up (back to the list after a delete, a reload) before the page is drawn again.
if (typeof MutationObserver === "function") {
  new MutationObserver(() => { if (missed && !flowPage.dialogOpen()) setTimeout(onWidth, 0); })
    .observe(document.getElementById("modal-root"), { childList: true });
}
await startAdmin();

async function startAdmin() {
  startHealth(healthEl);
  S.info = await api.info();
  document.getElementById("repo").textContent = S.info.repo;
  void flowPage.refreshFlows(); // the sidebar draws its own loading and failure; the pages do not wait for it
  void refreshModelLists();
  // When something waits for the owner, the app opens on the Your turn page.
  const to = startHash(location.hash, await startBadge());
  if (to) history.replaceState(null, "", to);
  await context.ready;
  booted = true;
  route();
  startSince(sinceEl);
}
