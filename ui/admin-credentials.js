import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { loadFailed } from "./repos.js";
import { emptyState, loadingState } from "./states.js";

/** A time as the page shows it; "never" for none. */
export const whenText = (iso) => (iso ? new Date(iso).toLocaleString() : "never");

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent(location.hash.split("?")[0].split("/")[1] ?? "") === "credentials";
  } catch {
    return false;
  }
};

/** The admin page with the stored credentials of all accounts: only to look at. Returns a cleanup. */
export async function renderCredentials(main) {
  const mine = ++generation;
  const head = () => h("div", { class: "toolbar" }, h("h1", {}, "Credentials"), h("span", { class: "muted" }, "The stored credentials of all accounts. Secrets are never shown."));
  const load = async () => {
    mount(main, head(), loadingState("Loading the credentials", { rows: 3, shape: "table" }));
    let list;
    try {
      list = await api.allCredentials();
    } catch (e) {
      if (mine !== generation || !onPage()) return;
      return mount(main, head(), loadFailed(e, {
        what: "The credentials could not be loaded.", denied: "Only an admin can see the stored credentials.",
        back: { href: "#/repos", label: "My repositories" }, onRetry: () => { mine === generation && load(); },
      }));
    }
    if (mine === generation && onPage()) draw(list);
  };
  const row = (c) => h("tr", {},
    h("td", {}, c.ownerName),
    h("td", { class: "mono" }, c.name),
    h("td", {}, c.type),
    h("td", { class: "mono" }, c.fingerprint),
    h("td", { class: "muted", title: c.created }, whenText(c.created)),
    h("td", { class: "muted" }, whenText(c.lastUsed)));
  const draw = (list) => mount(main,
    head(),
    list.length
      ? h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Owner", "Name", "Type", "Fingerprint", "Created", "Last used"].map((t) => h("th", {}, t)))),
        h("tbody", {}, list.map(row)))
      : emptyState("No stored credentials yet."));
  await load();
  return () => {
    if (generation === mine) generation++;
  };
}
