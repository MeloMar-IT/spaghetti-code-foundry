import { api } from "./api.js";
import { enterDisplay, linkToken } from "./auth.js";
import { h, mount } from "./dom.js";
import { createFlowPage } from "./flow-page.js";
import { parseQuery, resolve, splitHash } from "./ia.js";
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
import { renderAllRepos } from "./admin-repos.js";
import { renderCredentials } from "./admin-credentials.js";
import { renderOperations } from "./operations.js";
import { renderRefinement } from "./refinement.js";
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
import { startBadge, startHash } from "./turn.js";
import { levelNotice, mediaFor, supportLevel } from "./viewport.js";

const sidebar = document.getElementById("sidebar");
const main = document.getElementById("main");
const healthEl = document.getElementById("health");
const levelNote = document.getElementById("level-note");

// Pages not wired to the support level yet: they keep their controls and get no notice.
const NOT_YET = new Set(["flows", "flow", "new-flow", "all-repos", "models", "model", "problems", "problem", "maintenance"]);
const levelOf = (id) => (NOT_YET.has(id) ? "full" : supportLevel(id, globalThis.innerWidth));
let drawn = null; // { id, level } of the page route() drew last
let missed = false; // the width crossed a breakpoint while a dialog was open

/**
 * cur: the flow being edited.
 * { name: saved name | null, scope, saveScope, yaml, obj, mode: "visual"|"yaml", dirty, selected, validation }
 */
const S = { info: null, flows: [], flowsLoaded: false, cur: null, cleanup: null, lastHash: "", me: "" };

// The flow page changes the address through this: "go" is a navigation, the others only write the address.
const flowPage = createFlowPage({ main, sidebar, state: S, api, onNavigate(hash, how) {
  if (how === "go") { location.hash = hash; return; }
  if (how === "push") {
    history.pushState(null, "", hash);
    S.lastHash = hash;
    loadHealth(healthEl); // pushState fires no hashchange
    return;
  }
  history.replaceState(null, "", hash);
  S.lastHash = hash;
} });

// ── routing ──

function welcome() {
  mount(main, h("div", { class: "empty" },
    h("h1", { class: "mb-8" }, "Welcome to Spaghetti Code Foundry"),
    h("p", {}, "Build your own coding flows: pick a flow on the left, start from a blank one, or describe what you want and let Claude draft it."),
    h("div", { class: "row center mt-16" },
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
  const level = levelOf(to.page.id);
  drawn = { id: to.page.id, level };
  const readOnly = level === "read-only";
  const note = readOnly ? levelNotice(to.page.id, { dirty: !!S.cur?.dirty }) : null;
  levelNote.textContent = note ?? "";
  levelNote.hidden = !note;
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
    else if (section === "board") S.cleanup = S.info.redesign ? renderWork(main, arg, { user: S.me, go, query: { ...to.query, ...(parseQuery(splitHash(hash).query).repo === "all" ? { repo: "all" } : {}) } }) : renderBoard(main, arg, { query: to.query, go });
    else if (section === "library") await renderLibrary(main);
    // These four draw into their own box, so a slow answer that comes after a hash change cannot touch the next page.
    else if (section === "dashboard") await renderInBox(renderDashboard);
    else if (section === "watchers") await renderInBox(arg ? (box) => renderWatcherDetail(box, arg, { readOnly }) : (box) => renderWatchers(box, { readOnly }));
    else if (section === "problems") await renderInBox(arg ? (box) => renderProblemDetail(box, arg) : renderProblems);
    else if (section === "settings") await renderInBox((box) => renderSettings(box, { readOnly }));
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
    else if (section === "refinement") S.cleanup = await renderRefinement(main, { admin: true, id: arg, query: to.query, go });
    else if (section === "repos") {
      const off = await renderRepos(main, { admin: true, query: to.query, go });
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
      const done = await renderRunsList(box, { admin: true, query: to.query, go });
      if (mine !== routeGen) done?.();
      else S.cleanup = done;
    }
    else if (section === "new") S.cur && !S.cur.name ? flowPage.renderFlowView() : flowPage.openNew();
    else if (section === "flows" && arg) await flowPage.openFlow(arg, () => mine === routeGen);
    else welcome();
  } catch (e) {
    if (mine !== routeGen) return; // a late error must not replace the page that is shown now
    mount(main, errorState(explainError(e, { what: "This page could not be loaded." }), { onRetry: route }));
  }
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
initPalette({ role: "admin", user: me });
context = initContext("admin", me, { go: contextGo });
// Only now: before the role is known, a hash change must not draw a page.
window.addEventListener("hashchange", route);

/** The width crossed a breakpoint: redraw only when the level of the drawn page changed; wait for an open dialog. */
function onWidth() {
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
