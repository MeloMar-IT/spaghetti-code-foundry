import { h } from "./dom.js";
import { phaseStrip } from "./kit/product.js";
import { PHASES } from "./phases.js";
import { DEFAULTS, LOOKS } from "./prefs.js";
import { HOME } from "./simple-words.js";
import { SHOWN, actionNode, attentionCard, buildingItem, causeDetails, summaryLine } from "./today.js";

// The Simple home is drawn by a layout picked from the person's look. Every layout draws the same model (`homeModel` in
// ./simple-model.js): a layout only arranges it and adds or drops nothing.

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

// Parts the layouts share, so the same items and buttons are drawn by construction.
const counterLink = (c, focus, cls = "today-counter") =>
  h("a", { class: cls, href: c.href, "data-focus": `${focus}-count-${c.key}` }, h("span", { class: "today-count" }, String(c.count)), " ", h("span", {}, c.label));

const startLink = (focus) => h("a", { class: "btn primary simple-big", href: "#/start", "data-focus": `${focus}-start` }, HOME.start);

const listItems = (model, focus) => (model.lists[model.list].length
  ? h("ul", {}, model.lists[model.list].map((i) => h("li", {}, h("a", { href: i.href, "data-focus": `${focus}-list-${i.id ?? "x"}` }, i.title))))
  : h("p", { class: "muted" }, HOME.nothingInList));

const backLink = (focus) => h("p", {}, h("a", { href: "#/home", "data-focus": `${focus}-list-back` }, HOME.back));

const needsCards = (model, focus) => h("ul", { class: "today-cards" }, model.attention.slice(0, SHOWN).map((c) => attentionCard(c, focus)));

const runningItems = (model, focus) => (model.building.length
  ? h("ul", {}, model.building.slice(0, SHOWN).map((b) => buildingItem(b, focus)))
  : h("p", { class: "muted" }, HOME.nothingRunning));

const projectParts = (project, focus) => [
  h("h2", {}, HOME.projectTitle),
  h("h3", {}, h("a", { href: project.href, "data-focus": `${focus}-project-${project.id}` }, project.name)),
  h("p", { class: "simple-state" }, project.state),
  project.lastGood ? h("p", { class: "simple-last-good" }, project.lastGood) : null,
  phaseStrip({ label: `${HOME.steps}: ${project.name}`, phases: PHASES.map((p) => p.word), current: project.phase }),
  project.line ? h("p", { class: "muted" }, project.line) : null,
];

const countersNav = (model, focus) => h("nav", { class: "today-counters", "aria-label": HOME.countersLabel },
  h("ul", {}, model.counters.map((c) => h("li", {}, counterLink(c, focus)))));

const openList = (model, focus) => (model.list
  ? h("section", { class: "today-list" }, h("h2", {}, model.listTitle), listItems(model, focus), backLink(focus))
  : null);

const buildBox = (focus) => h("section", { class: "simple-card simple-home-build" },
  h("h2", {}, HOME.buildTitle),
  h("p", {}, HOME.buildText),
  startLink(focus));

const projectSection = (project, focus) => (project ? h("section", { class: "simple-card simple-home-project" }, ...projectParts(project, focus)) : null);

/** The cards layout: the build box, the counters, the list a counter opened, Needs you, Running now and the current project. */
export function cardsLayout(model, { focus = "simple-today" } = {}) {
  const [check, building] = model.counters;
  return [
    h("h1", { class: "today-greeting" }, model.greeting),
    h("p", { class: "today-summary" }, model.summary),
    buildBox(focus),
    countersNav(model, focus),
    openList(model, focus),
    model.attention.length
      ? h("section", { class: "today-attention" },
        h("h2", {}, HOME.needsTitle),
        needsCards(model, focus),
        more(model.attention.length - SHOWN, check.href, `${focus}-more-needs`))
      : null,
    h("section", { class: "today-building" },
      h("h2", {}, HOME.runningTitle),
      runningItems(model, focus),
      more(model.building.length - SHOWN, building.href, `${focus}-more-building`)),
    projectSection(model.project, focus),
  ];
}

/** Filled part of the thin bar: the phase index + 1 (1-5); 0 when there is no phase. */
export const barValue = (phase) => (Number.isInteger(phase?.index) && phase.index >= 0 ? Math.min(phase.index + 1, PHASES.length) : 0);
export const TAG_TONE = { question: "info", check: "accent", stuck: "danger", todo: "warning" };

const row = (c, i, focus) => h("li", { class: "simple-row" },
  h("span", { class: "simple-row-num", "aria-hidden": "true" }, String(i + 1).padStart(2, "0")),
  h("div", { class: "simple-row-main" }, h("h3", {}, c.title), h("p", {}, c.sentence)),
  c.tag ? h("span", { class: `pill sem-${TAG_TONE[c.tag] ?? "neutral"} simple-row-tag` }, HOME.tags[c.tag] ?? HOME.tags.todo) : null,
  actionNode(c, focus),
  causeDetails(c, focus));

const column = (b, focus) => h("li", { class: "simple-column" },
  h("h3", {}, h("a", { href: b.href, "data-focus": `${focus}-building-${b.id ?? "x"}` }, b.title)),
  h("progress", { class: "simple-bar", max: PHASES.length, value: barValue(b.phase), "aria-label": `${HOME.progress}: ${b.title}` }),
  b.line ? h("p", { class: "muted" }, b.line) : null);

/** The list layout: count heading, numbered rows, counters, the open list, Building now in three columns, the project, the build box. */
export function listLayout(model, { focus = "simple-today" } = {}) {
  const [check, building] = model.counters;
  return [
    h("h1", { class: "simple-home-headline" }, summaryLine({ check: model.attention.length })),
    model.attention.length
      ? h("section", { class: "simple-home-rows" },
        h("h2", { class: "scf-visually-hidden" }, HOME.needsTitle),
        h("ol", { class: "simple-rows" }, model.attention.slice(0, SHOWN).map((c, i) => row(c, i, focus))),
        more(model.attention.length - SHOWN, check.href, `${focus}-more-needs`))
      : null,
    countersNav(model, focus),
    openList(model, focus),
    h("section", { class: "today-building" },
      h("h2", {}, HOME.buildingTitle),
      model.building.length
        ? h("ul", { class: "simple-columns" }, model.building.slice(0, SHOWN).map((x) => column(x, focus)))
        : h("p", { class: "muted" }, HOME.nothingRunning),
      more(model.building.length - SHOWN, building.href, `${focus}-more-building`)),
    projectSection(model.project, focus),
    buildBox(focus),
  ];
}

/** The tiles layout: a grid of tiles with the same items and actions as cards (a hero with the Start box, Needs you, four small tiles, Running now, the project). */
export function tilesLayout(model, { focus = "simple-today" } = {}) {
  const byKey = Object.fromEntries(model.counters.map((c) => [c.key, c]));
  const link = (key) => counterLink(byKey[key], focus, "today-counter simple-tile-link");
  const { project, list, safePoint } = model;
  return [
    h("section", { class: "simple-tile simple-tile-large simple-tile-dark" },
      h("h1", { class: "today-greeting" }, model.greeting),
      h("p", { class: "today-summary" }, model.summary),
      h("h2", {}, HOME.buildTitle),
      h("p", {}, HOME.buildText),
      startLink(focus)),
    h("section", { class: "simple-tile simple-tile-large simple-tile-needs" },
      h("h2", {}, HOME.needsTitle),
      h("p", { class: "simple-tile-counts" }, link("check"), link("ready")),
      model.attention.length ? needsCards(model, focus) : h("p", { class: "muted" }, HOME.needsNone),
      more(model.attention.length - SHOWN, byKey.check.href, `${focus}-more-needs`)),
    h("div", { class: "simple-tile simple-tile-small" }, link("building")),
    h("div", { class: "simple-tile simple-tile-small" }, link("published-week")),
    h("section", { class: "simple-tile simple-tile-small" },
      h("h2", {}, HOME.safeTitle),
      h("p", { class: "simple-state" }, safePoint ? safePoint.title : HOME.safeNone),
      safePoint ? h("p", { class: "muted" }, safePoint.line) : null),
    h("section", { class: "simple-tile simple-tile-small" },
      h("h2", {}, HOME.limitTitle),
      h("p", {}, model.limitReached ? HOME.limitReached : HOME.limitNormal)),
    list
      ? h("section", { class: "simple-tile simple-tile-wide" }, h("h2", {}, model.listTitle), listItems(model, focus), backLink(focus))
      : null,
    h("section", { class: "simple-tile simple-tile-wide" },
      h("h2", {}, HOME.runningTitle),
      runningItems(model, focus),
      more(model.building.length - SHOWN, byKey.building.href, `${focus}-more-building`)),
    project ? h("section", { class: "simple-tile simple-tile-wide" }, ...projectParts(project, focus)) : null,
  ];
}

/** The layout views by name. */
export const VIEWS = { cards: cardsLayout, list: listLayout, tiles: tilesLayout };

/** Draws the model in the layout called `layout`; a layout without a view yet draws cards. The wrapper says which was drawn. */
export function drawLayout(model, layout, opts) {
  const drawn = typeof layout === "string" && Object.hasOwn(VIEWS, layout) ? layout : "cards";
  return [h("div", { class: "simple-home", "data-layout": drawn }, ...VIEWS[drawn](model, opts))];
}

/** The Simple home in the layout of `look`. */
export const homeLayout = (model, look, opts) => drawLayout(model, layoutOf(look), opts);
