import { api } from "./api.js";
import { errorText } from "./auth.js";
import { h, mount, toast } from "./dom.js";
import { card } from "./kit/display.js";
import { pageHeader, statusSummary } from "./kit/product.js";
import { loadingState, staleNote } from "./states.js";
import { DIALOGS, LABELS, actionsFor, browserPage, cancelledText, cancelledTotal, lastSignInText, limitsCell, loadUsers, pillClass, statusText } from "./users.js";
import { rememberView } from "./view-as.js";

export const NO_ACCOUNT = "This account does not exist.";

// The buttons of an account in three groups. Every kind of `actionsFor` is in exactly one of them.
const GROUPS = [
  { id: "routine", label: "Actions", kinds: ["edit", "limits", "app", "link", "view"] },
  { id: "security", label: "Security", kinds: ["reset", "unlock", "block", "unblock"] },
  { id: "danger", label: "Danger", kinds: ["delete"] },
];

/** The groups of buttons for an account, in order: `[{ id, label, kinds }]`. A group with no kinds is left out. */
export function groupsFor(u, now = Date.now()) {
  const all = actionsFor(u, now);
  return GROUPS.map((g) => ({ ...g, kinds: g.kinds.filter((k) => all.includes(k)) })).filter((g) => g.kinds.length);
}

// Each render gets a number; an answer for an older render, or that arrives after the person left the page, is dropped.
let generation = 0;
let reloads = 0; // the newest reload wins

const onAccount = (id) => {
  if (typeof location === "undefined") return true;
  try {
    const parts = location.hash.split("?")[0].split("/");
    return parts.length === 3 && parts[1] === "users" && decodeURIComponent(parts[2] ?? "") === id;
  } catch {
    return false;
  }
};

const noticeLine = (notice) => (notice ? h("p", { class: "status ok", role: "status" }, notice.text) : null);

/**
 * The page of one account (`#/users/:id`): its facts and all its actions. `me` is the signed-in account's id; `onName` gets the
 * name once the account is loaded; `notice` ({ text }) is a line kept from the last block; `data` is `[users, limits]` already loaded.
 * Returns a cleanup.
 */
export async function renderUserDetail(main, id, { me = "", page = browserPage, onName, notice, data } = {}) {
  const mine = ++generation;
  const live = () => mine === generation && onAccount(id);
  if (!data && live()) mount(main, loadingState("Loading the account…", { rows: 4, shape: "detail" }));
  const [users, limits] = data ?? await loadUsers();
  if (!live()) return () => {};
  const u = users.find((x) => x.id === id);
  const stop = () => {
    generation++;
  };
  if (!u) {
    mount(main, h("div", { class: "empty" }, h("p", {}, NO_ACCOUNT), h("a", { href: "#/users" }, "Back to Users")));
    return stop;
  }
  onName?.(u.name);
  const at = Date.now();
  const note = h("div", {}, noticeLine(notice));
  // The page stays when the reload fails: a note says how old it is, and the notice of the last action is kept.
  const reload = async (next) => {
    const my = ++reloads;
    let fresh;
    try {
      fresh = await loadUsers();
    } catch {
      if (my === reloads && live()) mount(note, noticeLine(next), staleNote(at, { failed: true, onRetry: () => reload(next) }));
      return;
    }
    if (my === reloads && live()) await renderUserDetail(main, id, { me, page, onName, notice: next, data: fresh });
  };

  const act = async (kind) => {
    let loaded = {};
    if (kind === "app") {
      try {
        loaded = await api.userAppRepos(u.id);
      } catch (e) {
        if (!live()) return;
        return toast(errorText(e), "error");
      }
      if (!live()) return;
    }
    const answer = await DIALOGS[kind](u, { me, page, limits, repos: loaded.repos ?? [] });
    if (answer && u.id === me && ["edit", "block", "delete"].includes(kind)) return page.reload();
    let next;
    if (answer && kind === "block") next = { text: cancelledText(u.name, cancelledTotal(answer.cancelled)) };
    else if (answer && (kind === "edit" || kind === "limits" || kind === "app")) toast("Saved");
    else if (answer && kind === "unlock") toast(`${u.name} is unlocked`);
    else if (answer && kind === "unblock") toast(`${u.name} is unblocked`);
    else if (answer && kind === "delete") {
      toast(`${u.name} was deleted`);
      return live() ? page.go("#/users") : undefined; // the account is gone: back to the list
    }
    return reload(next);
  };
  // Starts the read-only preview (an audit line on the server) and opens it in this tab; the name is kept for the bar.
  const view = async () => {
    try {
      const v = await api.startViewAs(u.id);
      rememberView(v);
      page.go(`/user/?as=${encodeURIComponent(v.id)}`);
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const button = (k) => h("button", { class: k === "delete" ? "danger" : null, disabled: k === "limits" && limits === null, onClick: () => (k === "view" ? view() : act(k)) }, LABELS[k]);
  const items = [
    { label: "E-mail", value: u.email || "—" },
    { label: "Role", value: u.role },
    { label: "Status", value: h("span", { class: pillClass(u) }, statusText(u)) },
    { label: "Last sign-in", value: lastSignInText(u) },
    { label: "Runs", value: String(u.runs ?? 0) },
    { label: "Limits", value: h("span", {}, limitsCell(limits, u.id)) },
    { label: "Id", value: h("span", { class: "mono" }, u.id) },
  ];
  mount(main,
    pageHeader({ title: u.name, back: { label: "Users", href: "#/users" }, meta: [h("span", { class: pillClass(u) }, statusText(u)), u.id === me ? h("span", { class: "muted" }, " (you)") : null] }),
    note,
    card({ title: "Account" }, statusSummary({ label: "Account", items })),
    groupsFor(u).map((g) => card({ title: g.label, tone: g.id === "danger" ? "fail" : "neutral" }, h("div", { class: "row" }, g.kinds.map(button)))));
  return stop;
}
