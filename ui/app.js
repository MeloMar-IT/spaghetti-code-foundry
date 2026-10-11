import { api } from "./api.js";
import { enterDisplay, linkToken } from "./auth.js";
import { h, mount } from "./dom.js";
import { createFlowPage } from "./flow-page.js";
import { resolve, splitHash } from "./ia.js";
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

const sidebar = document.getElementById("sidebar");
const main = document.getElementById("main");
const healthEl = document.getElementById("health");

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
  // While a dialog is open (the discard question included) the address is put back: the dialog is not replaced and a busy one is not bypassed.
  // This sits before the generation is counted, or the navigation the person confirms would be dropped as stale.
  if (flowPage.dialogOpen() && S.lastHash) {
    if (location.hash !== S.lastHash) history.replaceState(null, "", S.lastHash);
    return;
  }
  const mine = ++routeGen;
  // A set-password link is only for the sign-in page: load it again to show that page.
  if (linkToken(location.hash)) return location.reload();
  const to = resolve("admin", location.hash);
  if (to.hash !== location.hash) history.replaceState(null, "", to.hash);
  const hash = to.hash;
  const { path } = splitHash(hash);
  const [, section, arg] = path.split("/").map(decodeURIComponent);
  const leavingDraft = S.cur?.dirty && (section !== "flows" || arg !== S.cur.name) && path !== "#/new";
  // Filters change the address without a navigation; the page keeps the address in step.
  const go = (next) => { history.replaceState(null, "", next); S.lastHash = next; };
  // Only warn when opening a *different* flow; other pages keep the draft in memory.
  if (leavingDraft && section === "flows" && arg) {
    history.replaceState(null, "", S.lastHash);
    if (!(await flowPage.confirmDiscard())) return;
    history.replaceState(null, "", hash);
  }
  S.lastHash = hash;
  S.cleanup?.();
  S.cleanup = null;
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
    else if (section === "board") S.cleanup = S.info.redesign ? renderWork(main, arg, { user: S.me }) : renderBoard(main, arg, { query: to.query, go });
    else if (section === "library") await renderLibrary(main);
    // These four draw into their own box, so a slow answer that comes after a hash change cannot touch the next page.
    else if (section === "dashboard") await renderInBox(renderDashboard);
    else if (section === "watchers") await renderInBox(arg ? (box) => renderWatcherDetail(box, arg) : renderWatchers);
    else if (section === "problems") await renderInBox(arg ? (box) => renderProblemDetail(box, arg) : renderProblems);
    else if (section === "settings") await renderInBox(renderSettings);
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
      const off = await renderOperations(main);
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
      const off = await renderUserDetail(main, arg, { me: S.me, onName: (n) => { if (mine === routeGen) namePage(n); } });
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "users") {
      const off = await renderUsers(main, { me: S.me });
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
// Only now: before the role is known, a hash change must not draw a page.
window.addEventListener("hashchange", route);
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
  route();
  startSince(sinceEl);
}
