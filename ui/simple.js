import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { withActive } from "./home.js";
import { keepScroll, liveStates, poller } from "./live.js";
import { projectsModel } from "./simple-model.js";
import { WORDS } from "./simple-words.js";

// The Simple view: My projects (#/home) and the project page (#/repos/<id>). All text comes from the word list.

const REFRESH_MS = 30_000;
const DONE_SHOWN = 5;
const GROUPS = [["planned", WORDS.planned], ["building", WORDS.building], ["check", WORDS.check], ["done", WORDS.done]];

/** A link or button of the pages: big, a real `a[href]`. External links open in a new tab and say so. */
function linkNode(l, cls, focus) {
  if (!l.external) return h("a", { class: cls, href: l.href, "data-focus": focus }, l.label);
  return h("a", { class: cls, href: l.href, target: "_blank", rel: "noopener noreferrer", "data-focus": focus }, l.label, h("span", { class: "sr-only" }, WORDS.newTab));
}

/** My projects: one card per project with its state line and one big button. */
export function projectsView(projects) {
  const body = projects.length
    ? h("ul", { class: "simple-projects" }, projects.map((p) => h("li", { class: "simple-card" },
      h("h2", {}, h("a", { href: `#/repos/${encodeURIComponent(p.id)}`, "data-focus": `simple-project-${p.id}` }, p.name)),
      h("p", { class: "simple-state" }, p.state),
      linkNode(p.next, "btn primary simple-big", `simple-next-${p.id}`))))
    : h("p", { class: "simple-empty" }, WORDS.empty);
  return [h("h1", {}, WORDS.myProjects), body];
}

function cardView(c) {
  return h("li", { class: "simple-card" },
    h("h4", {}, c.title),
    c.sentence ? h("p", {}, c.sentence) : null,
    c.line ? h("p", { class: "muted" }, c.line) : null,
    c.progress ? h("p", { class: "simple-progress" }, c.progress) : null);
}

function groupView(key, title, cards, { doneOpen, onToggle }) {
  const shown = key === "done" ? cards.slice(0, DONE_SHOWN) : cards;
  const rest = key === "done" ? cards.slice(DONE_SHOWN) : [];
  return h("section", { class: "simple-group" },
    h("h3", {}, title),
    shown.length ? h("ul", { class: "simple-list" }, shown.map(cardView)) : h("p", { class: "muted" }, WORDS.nothingInGroup),
    rest.length
      ? h("details", { open: doneOpen, onToggle: (e) => onToggle?.(e?.target?.open ?? !doneOpen) },
        h("summary", { "data-focus": "simple-done-summary" }, WORDS.showAllDone(cards.length)),
        h("ul", { class: "simple-list" }, rest.map(cardView)))
      : null);
}

/**
 * The project page. `actions`: the action row, [{ id: "change" | "tryIt" | "final", href?, onClick? }]; nothing is drawn
 * without actions. `doneOpen` and `onToggle` keep the "Show all done" box open across a refresh.
 */
export function projectView(model, { actions = [], doneOpen = false, onToggle } = {}) {
  return [
    h("a", { class: "simple-back", href: "#/home", "data-focus": "simple-back" }, WORDS.back),
    h("h1", {}, model.name),
    h("section", { class: "simple-todo" },
      h("h2", {}, WORDS.todo),
      model.todo.length
        ? h("ul", { class: "simple-list" }, model.todo.map((c) => h("li", { class: "simple-card" },
          h("strong", {}, c.title),
          c.line ? h("p", { class: "muted" }, c.line) : null,
          c.link ? linkNode({ ...c.link, label: c.todo }, "btn primary simple-big", `simple-todo-${c.id}`) : null)))
        : h("p", {}, WORDS.nothingTodo)),
    h("section", { class: "simple-making" },
      h("h2", {}, WORDS.making),
      GROUPS.map(([key, title]) => groupView(key, title, model.groups[key], { doneOpen, onToggle }))),
    actions.length
      ? h("div", { class: "simple-actions" }, actions.filter((x) => WORDS.actions[x.id]).map((x) => x.href
        ? h("a", { class: "btn simple-big", href: x.href, "data-focus": `simple-action-${x.id}` }, WORDS.actions[x.id])
        : h("button", { type: "button", class: "simple-big", "data-focus": `simple-action-${x.id}`, onClick: x.onClick }, WORDS.actions[x.id])))
      : null,
  ];
}

/** Loads the three lists and polls them; `draw(projects)` gets the projects. Returns a cleanup. */
async function live(main, { a, draw }) {
  const box = h("div", { class: "simple" });
  mount(main, box);
  let poll;
  const states = liveStates({
    body: box,
    heading: () => h("h1", {}, WORDS.myProjects),
    label: WORDS.loading,
    what: WORDS.loadFailed,
    retry: () => poll.refresh(),
    focus: "simple",
  });
  poll = poller({
    load: async () => {
      const [repos, runs, queue] = await Promise.all([a.repos(), a.runs(), a.queue()]);
      return { repos, runs: await withActive(a, runs, queue), pending: queue?.pending };
    },
    draw: ({ repos, runs, pending }) => {
      const nodes = draw(projectsModel(repos, runs, pending));
      keepScroll(box, () => mount(box, ...nodes, states.alert, states.note));
    },
    every: REFRESH_MS,
    onState: states.onState,
  });
  await poll.ready;
  return () => poll.stop();
}

/** My projects; never rejects; returns a cleanup. */
export function renderSimpleHome(main, { a = api } = {}) {
  return live(main, { a, draw: projectsView });
}

/** The project page for repository `id`. */
export function renderSimpleProject(main, { id, a = api, onName, actions = [] } = {}) {
  let doneOpen = false;
  return live(main, {
    a,
    draw: (projects) => {
      const p = projects.find((x) => String(x.id) === String(id));
      if (!p) return [h("a", { class: "simple-back", href: "#/home" }, WORDS.back), h("p", {}, WORDS.notFound)];
      onName?.(p.name);
      return projectView(p, { actions, doneOpen, onToggle: (open) => { doneOpen = open; } });
    },
  });
}
