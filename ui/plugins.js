// Pages, menu links and settings cards that plugins add (#787). The server lists only what the signed-in role may see.
import { api } from "./api.js";
import { generatedSection } from "./admin-sections.js";
import { h, mount } from "./dom.js";
import { hasPluginPage, pluginPageId, setPluginPages } from "./ia.js";
import * as actions from "./kit/actions.js";
import * as display from "./kit/display.js";
import * as forms from "./kit/forms.js";
import * as overlays from "./kit/overlays.js";
import * as records from "./kit/records.js";

/** The UI kit a plugin page gets as `ctx.kit`. */
export const KIT = Object.freeze({ actions, forms, display, overlays, records });

let menuNodes = [];

/** Asks the server for the plugin pages of this role and tells the page list. A failure leaves no plugin pages: the app works as before. */
export async function loadPluginUi({ load = () => api.pluginUi() } = {}) {
  let view = null;
  try {
    view = await load();
  } catch {
    view = null;
  }
  setPluginPages(view?.pages);
  return { menu: Array.isArray(view?.menu) ? view.menu : [] };
}

/** Puts the plugin links under a "Plugins" heading in the sidebar (and removes the ones from an earlier call). `known(plugin, page)` says whether the page is registered. */
export function addPluginMenu(menu, { side = document.getElementById("side"), known = hasPluginPage } = {}) {
  for (const n of menuNodes) n.remove();
  menuNodes = [];
  const items = (Array.isArray(menu) ? menu : []).filter((m) => m && typeof m.label === "string" && m.label.trim() !== "" && known(m.plugin, m.page));
  if (!side || !items.length) return;
  const nodes = [
    h("span", { class: "side-head" }, "Plugins"),
    ...items.map((m) => h("a", { href: `#/plugins/${m.plugin}/${m.page}`, "data-nav": pluginPageId(m.plugin, m.page) }, m.label)),
  ];
  const before = document.getElementById("repo");
  for (const n of nodes) {
    if (before?.parentNode === side) side.insertBefore(n, before);
    else side.append(n);
  }
  menuNodes = nodes;
}

/**
 * Draws a plugin page into `box`: loads its module, calls render(box, ctx) and returns the cleanup function it gives back (or nothing).
 * `load(url)` is the import; tests replace it.
 */
export async function renderPluginPage(box, page, { user, readOnly = false, load = (url) => import(url) } = {}) {
  let mod;
  try {
    mod = await load(page.module);
  } catch {
    throw new Error(`The page "${page.title}" of the plugin "${page.plugin}" could not be loaded.`);
  }
  if (typeof mod?.render !== "function") throw new Error(`The page "${page.title}" of the plugin "${page.plugin}" has no render(box, ctx) function.`);
  const ctx = Object.freeze({
    kit: KIT, h, mount, role: user?.role, readOnly, plugin: page.plugin,
    user: Object.freeze({ id: user?.id, name: user?.name, role: user?.role }),
  });
  const done = await mod.render(box, ctx);
  return typeof done === "function" ? done : undefined;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One generated card per plugin settings section of GET /api/settings. A control starts from the effective value (the default
 * when nothing is stored). `value()` is the `plugin_settings` to save: a key is written when it is stored already or when the
 * person changed it, so an untouched default stays out of config.yaml.
 */
export function pluginSettingCards(config, sections, { section, readOnly = false } = {}) {
  const stored = config?.plugin_settings && typeof config.plugin_settings === "object" ? config.plugin_settings : {};
  const list = (Array.isArray(sections) ? sections : []).map((s) => {
    const values = s.values && typeof s.values === "object" ? s.values : {};
    const seeded = { plugin_settings: { [s.plugin]: { ...values } } };
    const gen = generatedSection(s.title, `plugin_settings.${s.plugin}.`, seeded, s.fields, { section, readOnly });
    return { plugin: s.plugin, values, own: stored[s.plugin] ?? {}, gen };
  });
  return {
    active: list.length > 0,
    cards: list.map((c) => c.gen.card).filter(Boolean),
    check: () => list.map((c) => c.gen.check()).find(Boolean),
    restore: () => list.forEach((c) => c.gen.restore()),
    inputs: () => Object.assign({}, ...list.map((c) => c.gen.inputs())),
    value() {
      const out = { ...stored };
      for (const c of list) {
        const kept = Object.fromEntries(Object.entries(c.gen.values()).filter(([k, v]) => Object.hasOwn(c.own, k) || !same(v, c.values[k])));
        if (Object.keys(kept).length) out[c.plugin] = kept;
        else delete out[c.plugin];
      }
      return out;
    },
  };
}
