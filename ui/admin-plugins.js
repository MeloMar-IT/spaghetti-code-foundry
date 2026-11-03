import { api } from "./api.js";
import { h, mount, table } from "./dom.js";
import { errorState, explainError } from "./states.js";

// The "Plugins" card of Settings: read-only. Plugins are set in config.yaml only.

/** What a plugin registered, as one line. */
export const registeredText = (p) =>
  Array.isArray(p?.registered) && p.registered.length ? p.registered.map((x) => `${x.point} ${x.name}`).join(", ") : "Nothing yet";

const COLUMNS = ["Plugin", "Version", "Module", "Registered"];

function rowOf(p) {
  return h("tr", {}, h("td", {}, p.label), h("td", {}, p.version), h("td", { class: "mono" }, p.module), h("td", {}, registeredText(p)));
}

/** The "Plugins" card. It loads by itself and drops an answer that a newer load has replaced. */
export function pluginsPanel() {
  const body = h("div", {});
  let loads = 0;
  const load = async () => {
    const my = ++loads;
    mount(body, h("p", { class: "muted", role: "status" }, "Loading plugins…"));
    let r;
    try {
      r = await api.plugins();
    } catch (e) {
      if (my === loads) mount(body, errorState(explainError(e, { what: "The plugins could not be loaded." }), { onRetry: load }));
      return;
    }
    if (my !== loads) return;
    const rows = Array.isArray(r?.plugins) ? r.plugins : [];
    const notes = (Array.isArray(r?.problems) ? r.problems : []).map((p) => h("p", { class: "status bad", role: "alert" }, `${p.plugin}: ${p.reason}`));
    const box = rows.length ? table(COLUMNS, rows.map(rowOf), { cards: true, caption: "Plugins" }) : h("p", { class: "muted" }, "No plugins.");
    if (rows.length) {
      box.setAttribute("tabindex", "0");
      box.setAttribute("role", "region");
      box.setAttribute("aria-label", "Plugins");
    }
    mount(body, notes, box);
  };
  void load();
  return h("div", { class: "card mb-14" }, h("h3", {}, "Plugins"),
    h("p", { class: "muted flush" }, "Code that runs inside the server. Set in config.yaml only; changes apply after a restart."), body);
}
