// "View as user": the bar, the ended card and the start of the read-only preview on the user display.
// The server (see src/server/view-as.ts) is the rule; this page only shows what it answers.
import { api, setViewAs } from "./api.js";
import { errorText, isAdmin } from "./auth.js";
import { h, mount } from "./dom.js";

const KEY = "scf-view-as";

export const viewText = (name) => `You are viewing as ${name || "this user"}. Nothing can be changed here.`;

/** The tab's store, or undefined when there is none or it throws. */
const storage = () => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
};

/** Keeps the answer of the start call ({ id, name }) so the page that opens next can name the user. Never throws. */
export function rememberView(view, store = storage()) {
  try {
    if (view?.id && view?.name) store?.setItem(KEY, JSON.stringify({ id: view.id, name: view.name }));
  } catch {
    // no store: the preview asks to be started again
  }
}

/** The kept name when it belongs to this id, else "". Never throws. */
export function viewName(id, store = storage()) {
  try {
    const v = JSON.parse(store?.getItem(KEY) ?? "null");
    return v && v.id === id && typeof v.name === "string" ? v.name : "";
  } catch {
    return "";
  }
}

/** Ends the view on the server (a failure does not matter: it ends by itself) and goes to the Users page. */
export async function leaveView({ a = api, go = (to) => location.assign(to) } = {}) {
  await a.stopViewAs().catch(() => {});
  go("/#/users");
}

/** The bar at the top of the preview. */
export function viewBar(box, id, opts = {}) {
  mount(box,
    h("span", {}, viewText(viewName(id, opts.store))),
    h("button", { class: "small", type: "button", onClick: () => leaveView(opts) }, "Back to the admin display"));
  box.hidden = false;
}

/**
 * The card that replaces the page when the view is over (or cannot be shown without a name): View again starts a new
 * view (a new audit line) and loads the page again; Back leaves. It never shows the admin's own data.
 */
export function viewEndedCard(main, id, { a = api, go, reload = () => location.reload(), text = "The view has ended. Nothing is shown." } = {}) {
  const err = h("p", { class: "status bad" });
  const again = h("button", {
    class: "primary",
    type: "button",
    onClick: async () => {
      again.disabled = true;
      err.textContent = "";
      try {
        rememberView(await a.startViewAs(id));
        reload();
      } catch (e) {
        err.textContent = errorText(e);
        again.disabled = false;
      }
    },
  }, "View again");
  mount(main, h("div", { class: "empty" },
    h("p", { role: "alert" }, text),
    err,
    h("div", { class: "row" }, again, h("button", { type: "button", onClick: () => leaveView({ a, go }) }, "Back to the admin display"))));
}

/**
 * Sets up the preview when an admin opened the user display with `as`. Returns { readOnly, ready }:
 * `readOnly` hides the buttons that change things; `ready` is always true here (the page may draw).
 * `onEnded` runs once when the server ends the view.
 * Nothing is requested here; a user (or no `as`) gets { readOnly: false, ready: true } and the parameter is ignored.
 */
export function beginView(as, me, { box, main, body = document.body, onEnded, ...opts } = {}) {
  if (!as || !isAdmin(me)) return { readOnly: false, ready: true };
  setViewAs(as, () => {
    box.hidden = true;
    mount(box);
    onEnded?.();
    viewEndedCard(main, as, opts);
  });
  body.classList.add("view-as");
  // No kept name (another tab, no storage) is not an ended view: the bar says "this user".
  viewBar(box, as, opts);
  return { readOnly: true, ready: true };
}

