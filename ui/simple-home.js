import { h } from "./dom.js";
import { phaseStrip } from "./kit/product.js";
import { PHASES } from "./phases.js";
import { DEFAULTS, LOOKS } from "./prefs.js";
import { HOME } from "./simple-words.js";
import { SHOWN, attentionCard, buildingItem } from "./today.js";

// The Simple home is drawn by a layout picked from the person's look. Every layout draws the same model (`homeModel` in
// ./simple-model.js): a layout only arranges it and adds or drops nothing. `list` and `tiles` have no view yet (parts C2 and C3
// add one entry each to VIEWS); until then they draw the cards layout.

export const LAYOUTS = ["cards", "list", "tiles"];
export const LAYOUT_OF_LOOK = { calm: "cards", friendly: "cards", midnight: "list", editorial: "list", bento: "tiles" };

/** The layout of a look; an unknown or missing look (also an inherited name such as "constructor") gives "cards". */
export const layoutOf = (look) => (typeof look === "string" && Object.hasOwn(LAYOUT_OF_LOOK, look) ? LAYOUT_OF_LOOK[look] : "cards");

/** The look on the page (`data-look` of <html>, set by prefs.js); the default look when there is none or it is not a look. */
export function currentLook(root = globalThis.document?.documentElement) {
  try {
    const look = root?.getAttribute?.("data-look");
    return LOOKS.includes(look) ? look : DEFAULTS.look;
  } catch {
    return DEFAULTS.look;
  }
}

const more = (n, href, focus) => (n > 0 ? h("p", {}, h("a", { href, "data-focus": focus }, HOME.more(n))) : null);

/** The cards layout: the build box, the counters, the list a counter opened, Needs you, Running now and the current project. */
export function cardsLayout(model, { focus = "simple-today" } = {}) {
  const [check, building] = model.counters;
  const { project, list } = model;
  return [
    h("h1", { class: "today-greeting" }, model.greeting),
    h("p", { class: "today-summary" }, model.summary),
    h("section", { class: "simple-card simple-home-build" },
      h("h2", {}, HOME.buildTitle),
      h("p", {}, HOME.buildText),
      h("a", { class: "btn primary simple-big", href: "#/start", "data-focus": `${focus}-start` }, HOME.start)),
    h("nav", { class: "today-counters", "aria-label": HOME.countersLabel },
      h("ul", {}, model.counters.map((c) => h("li", {},
        h("a", { class: "today-counter", href: c.href, "data-focus": `${focus}-count-${c.key}` },
          h("span", { class: "today-count" }, String(c.count)), " ", h("span", {}, c.label)))))),
    list
      ? h("section", { class: "today-list" },
        h("h2", {}, model.listTitle),
        model.lists[list].length
          ? h("ul", {}, model.lists[list].map((i) => h("li", {}, h("a", { href: i.href, "data-focus": `${focus}-list-${i.id ?? "x"}` }, i.title))))
          : h("p", { class: "muted" }, HOME.nothingInList),
        h("p", {}, h("a", { href: "#/home", "data-focus": `${focus}-list-back` }, HOME.back)))
      : null,
    model.attention.length
      ? h("section", { class: "today-attention" },
        h("h2", {}, HOME.needsTitle),
        h("ul", { class: "today-cards" }, model.attention.slice(0, SHOWN).map((c) => attentionCard(c, focus))),
        more(model.attention.length - SHOWN, check.href, `${focus}-more-needs`))
      : null,
    h("section", { class: "today-building" },
      h("h2", {}, HOME.runningTitle),
      model.building.length
        ? h("ul", {}, model.building.slice(0, SHOWN).map((b) => buildingItem(b, focus)))
        : h("p", { class: "muted" }, HOME.nothingRunning),
      more(model.building.length - SHOWN, building.href, `${focus}-more-building`)),
    project
      ? h("section", { class: "simple-card simple-home-project" },
        h("h2", {}, HOME.projectTitle),
        h("h3", {}, h("a", { href: project.href, "data-focus": `${focus}-project-${project.id}` }, project.name)),
        h("p", { class: "simple-state" }, project.state),
        project.lastGood ? h("p", { class: "simple-last-good" }, project.lastGood) : null,
        phaseStrip({ label: `${HOME.steps}: ${project.name}`, phases: PHASES.map((p) => p.word), current: project.phase }),
        project.line ? h("p", { class: "muted" }, project.line) : null)
      : null,
  ];
}

/** The layout views by name. Parts C2 and C3 add `list` and `tiles`. */
export const VIEWS = { cards: cardsLayout };

/** Draws the model in the layout called `layout`; a layout without a view yet draws cards. The wrapper says which was drawn. */
export function drawLayout(model, layout, opts) {
  const drawn = typeof layout === "string" && Object.hasOwn(VIEWS, layout) ? layout : "cards";
  return [h("div", { class: "simple-home", "data-layout": drawn }, ...VIEWS[drawn](model, opts))];
}

/** The Simple home in the layout of `look`. */
export const homeLayout = (model, look, opts) => drawLayout(model, layoutOf(look), opts);
