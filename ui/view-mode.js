// The view switch (Simple, Advanced, Admin): the rules, the checks for typed work and the widgets.
// A view changes only what the display shows; the server still decides every call by role.
// This module must not import ./auth.js statically: the draft modules reached with import() below import it.
import { api } from "./api.js";
import { confirmDialog, h, mount, toast } from "./dom.js";
import { resolve, splitHash } from "./ia.js";

export const VIEW_LABELS = { simple: "Simple", advanced: "Advanced", admin: "Admin" };
/** The pages of the Simple view (the first part of the hash path). Later parts of the Easy epic may change this. */
export const SIMPLE_SECTIONS = ["home", "start", "runs", "repos"];

export const UNSAVED_TEXT = "You have unsaved changes. Save them first, then switch view.";
export const UNSENT_TEXT = "You have text that is not sent. It is kept only on this page and is lost when you switch view.";
export const UNSURE_TEXT = "The server did not answer, so your view may have changed. Reload the page to see it.";

const ALL_VIEWS = ["simple", "advanced", "admin"];

/** The views the account may choose. */
export function viewsOf(user) {
  if (Array.isArray(user?.views)) return user.views;
  return user?.role === "admin" ? ALL_VIEWS : ["simple", "advanced"];
}

/** The view in effect: the one the server sent when it is open to the account, else the default of the role. */
export function viewOf(user) {
  if (viewsOf(user).includes(user?.view)) return user.view;
  return user?.role === "admin" ? "admin" : "advanced";
}

/** The display of a view: "admin" is the page at /, the others are the page at /user/. */
export const displayOf = (view) => (view === "admin" ? "admin" : "user");
export const displayPath = (view) => (view === "admin" ? "/" : "/user/");

const noHash = (hash) => !hash || hash === "#" || hash === "#/";

/** True when the view has a page for the hash. */
export function inView(view, hash) {
  const role = view === "admin" ? "admin" : "user";
  const r = resolve(role, hash);
  if (r.reason !== null && r.reason !== "alias") return false;
  if (view !== "simple") return true;
  return SIMPLE_SECTIONS.includes(splitHash(hash).path.split("/")[1]);
}

/** The view to offer for an address the current view does not have: "advanced", "admin" or null. */
export function offerFor(view, role, hash) {
  if (noHash(hash) || inView(view, hash)) return null;
  if (view === "simple" && inView("advanced", hash)) return "advanced";
  if (role === "admin" && inView("admin", hash)) return "admin";
  return null;
}

/** Text boxes that hold typed work. A short search box is a filter, not work. */
const TEXT_TYPES = ["", "text", "url", "email", "tel", "number"];
const isTextBox = (el) => el?.localName === "textarea" || (el?.localName === "input" && TEXT_TYPES.includes(el.type ?? el.getAttribute?.("type") ?? ""));

/**
 * True when a page listener answers a cancelable `beforeunload`: text the page guards (a flow draft, refinement text).
 * The listeners of the pages have no side effects; a new one must keep it that way.
 */
let answering = false;
export function unsavedWork(target = window) {
  const e = new Event("beforeunload", { cancelable: true });
  answering = true; // the guard of guardEdits stays silent for this question
  try {
    target.dispatchEvent(e);
  } finally {
    answering = false;
  }
  return e.defaultPrevented;
}

const typed = new Set();
let tracking = false;
/** Remembers the text boxes a person typed in. Called once; pages need no change for it. */
export function trackTyping(doc = document) {
  if (tracking) return;
  tracking = true;
  doc.addEventListener("input", (e) => { if (isTextBox(e.target)) typed.add(e.target); });
}

/** True when a text box on the page holds typed text. A box that left the page is forgotten. */
export function typedText() {
  for (const el of typed) {
    if (el.isConnected === false) typed.delete(el);
    else if (String(el.value ?? "").trim()) return true;
  }
  return false;
}

/** True when typed text has no `beforeunload` guard: a Start work draft, a closed New refinement form, a text box. */
export async function unsentText() {
  const [{ readDraft }, { keptSession }] = await Promise.all([import("./user/start-draft.js"), import("./refinement-new.js")]);
  const kept = keptSession();
  return readDraft() !== null || [kept?.title, kept?.idea, kept?.issue].some((v) => String(v ?? "").trim() !== "") || typedText();
}

const askUnsent = () => confirmDialog({ title: "Switch view?", text: UNSENT_TEXT, confirm: "Switch view" });

/** The page takes no input until the returned function is called: text typed during the call would be lost. */
export function freezePage(body = document.body) {
  const back = document.activeElement;
  body.setAttribute("inert", "");
  let done = false;
  return () => {
    if (done) return;
    done = true;
    body.removeAttribute("inert");
    back?.focus?.();
  };
}

const guarded = new WeakSet();
/**
 * After a switch went through: gives the page back. The browser then asks before the page leaves while typed text is on
 * it. The guard reads the page at each question, so text that is saved or cleared is no longer guarded. There is no timer:
 * if the navigation is slow or stopped, the page works and the guard still holds.
 */
export function guardEdits(thaw, target = window) {
  thaw();
  if (guarded.has(target)) return;
  guarded.add(target);
  target.addEventListener("beforeunload", (e) => { if (!answering && typedText()) e.preventDefault(); });
}

/** Opens the address. The same page needs a reload: a change of the hash alone would keep the old view drawn. */
export function goTo(to) {
  if (to.split("#")[0] === location.pathname) {
    history.replaceState(null, "", to);
    location.reload();
  } else location.assign(to);
}

const problemText = (e) => (e instanceof TypeError || e?.name === "TimeoutError" || e?.name === "AbortError" ? "Could not reach the server." : e?.message || "Something went wrong.");

/**
 * Switches the view. Resolves "" when done, the text of a problem, or null when the person cancelled.
 * Every check runs before the call, so a stop changes nothing. The call is bounded by a timeout; when it ends without an
 * answer the stored view is read back, because the server may have kept it.
 */
export async function chooseView(next, { a = api, go = goTo, hash = () => location.hash, unsaved = unsavedWork, unsent = unsentText, ask = askUnsent, freeze = freezePage, later = guardEdits } = {}) {
  if (unsaved()) return UNSAVED_TEXT;
  let pending;
  try {
    pending = await unsent();
  } catch (e) {
    return problemText(e); // the check could not run (for example a module did not load): nothing changed
  }
  if (pending && !(await ask())) return null;
  const thaw = freeze();
  try {
    await a.setView(next);
  } catch (e) {
    if (e?.status === undefined) {
      // no answer: the outcome is not known
      let stored = null;
      try {
        stored = (await a.myView())?.view ?? null;
      } catch {
        thaw();
        return `${problemText(e)} ${UNSURE_TEXT}`;
      }
      if (stored !== next) {
        thaw();
        return problemText(e);
      }
    } else {
      thaw();
      return problemText(e);
    }
  }
  const at = hash();
  go(displayPath(next) + (inView(next, at) ? at : ""));
  later(thaw);
  return "";
}

/**
 * Fills the switch boxes (the top bar and the menu); CSS shows one of them. All boxes share one state.
 * `opts` go to chooseView.
 */
export function mountViewSwitch(user, { ids = ["view-switch", "view-switch-menu"], ...opts } = {}) {
  trackTyping();
  let shown = viewOf(user);
  let busy = false;
  const selects = [];
  for (const id of ids) {
    const box = document.getElementById(id);
    if (!box) continue;
    const select = h("select", { name: "view" }, viewsOf(user).map((v) => h("option", { value: v }, VIEW_LABELS[v] ?? v)));
    select.value = shown;
    select.addEventListener("change", async () => {
      const next = select.value;
      if (busy || next === shown) {
        select.value = shown;
        return;
      }
      busy = true;
      let problem;
      try {
        problem = await chooseView(next, opts);
      } finally {
        busy = false;
      }
      if (problem === "") shown = next; // the page goes away; if the browser keeps it, the switch still works
      for (const s of selects) s.value = shown;
      if (problem) toast(problem, "error");
    });
    selects.push(select);
    mount(box, h("label", {}, "View", select));
    box.hidden = false;
  }
  return selects;
}

/** The card for an address the current view does not have: it names the view that has it and switches to it. */
export function offerCard(box, offer, view, opts = {}) {
  let busy = false;
  const error = h("p", { class: "status bad", role: "alert" });
  const button = h("button", {
    type: "button",
    class: "primary",
    onClick: async () => {
      if (busy) return;
      busy = true;
      error.textContent = "";
      let problem;
      try {
        problem = await chooseView(offer, opts);
      } finally {
        busy = false;
      }
      error.textContent = problem ?? "";
    },
  }, `Open this in the ${VIEW_LABELS[offer]} view`);
  mount(box, h("div", { class: "empty" },
    h("p", {}, `This page is not in the ${VIEW_LABELS[view]} view.`),
    error,
    button,
    h("p", { class: "muted" }, "This switches your view. You can switch back with View in the top bar or the menu.")));
}

/** Simple hides the links of the pages it does not have. */
export function showViewNav(view, side = document.getElementById("side")) {
  if (!side) return;
  for (const a of side.querySelectorAll("a[data-nav]")) a.hidden = view === "simple" && !SIMPLE_SECTIONS.includes(a.getAttribute("data-nav"));
}
