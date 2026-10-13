import { api } from "./api.js";
import { h, mount, tableBox } from "./dom.js";
import { credentialIntegration, integrationBlock } from "./integration.js";
import { loadFailed, scopeSwitch } from "./repos.js";
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
  const head = () => h("div", { class: "toolbar" }, h("h1", {}, "Credentials"), h("span", { class: "muted" }, "The stored credentials of all accounts. Secrets are never shown."),
    scopeSwitch("credentials"));
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
    // The repositories and the sign-in methods only add detail: when they fail, the integration details are said to be unavailable (null).
    const [repos, options] = await Promise.all([api.allRepos().catch(() => null), api.repoMethods().catch(() => undefined)]);
    if (mine === generation && onPage()) draw(list, repos, options);
  };
  const row = (c, repos, options) => {
    const items = integrationBlock(credentialIntegration(c, repos, options));
    return h("tr", {},
      h("td", {}, c.ownerName),
      h("td", {}, items[0].value),
      h("td", { class: "integration" }, items[1].value),
      h("td", { class: "integration" }, items[2].value),
      h("td", { class: "mono fingerprint" }, c.fingerprint),
      h("td", { class: "muted", title: c.created }, whenText(c.created)),
      h("td", { class: "muted" }, whenText(c.lastUsed)));
  };
  const draw = (list, repos, options) => mount(main,
    head(),
    list.length
      ? tableBox(h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Owner", "Provider", "Identity", "Scope", "Fingerprint", "Created", "Last used"].map((t) => h("th", {}, t)))),
        h("tbody", {}, list.map((c) => row(c, repos, options)))))
      : emptyState("No stored credentials yet."));
  await load();
  return () => {
    if (generation === mine) generation++;
  };
}
