import { h } from "./dom.js";
import { filterFlows } from "./flow-state.js";
import { flowNameMark } from "./icons.js";

const VALIDATION_CLASS = { valid: "ok", problems: "bad", checking: "" };

/**
 * The editor header: the name line with the actions, then the state line.
 * `st` comes from editorState(). Returns the two elements.
 */
export function renderHeader(st, { mode, overviewOpen, moreOpen = false, saveScope, canDelete, onMode, onSave, onRun, onOverview, onProblems, onAsk, onScope, onDelete }) {
  const seg = (m, label) => h("button", { class: mode === m ? "on" : null, onClick: () => onMode?.(m) }, label);
  // A menu button closes the menu first, then does its work.
  const item = (label, fn, props = {}) => h("button", { ...props, onClick: (e) => {
    const d = e?.currentTarget?.closest?.("details");
    if (d) { d.open = false; d.removeAttribute("open"); }
    fn?.();
  } }, label);
  const more = h("details", { class: "flow-more", open: moreOpen, onKeydown: (e) => {
    if (e.key !== "Escape") return;
    more.open = false;
    more.removeAttribute("open");
    more.querySelector("summary")?.focus();
  } },
  h("summary", { "data-focus": "flow-more" }, "More"),
  h("div", { class: "flow-more-items" },
    item("✨ Ask Claude", onAsk, { title: "Describe a change and let Claude edit this flow" }),
    h("label", { class: "field" }, h("span", {}, "Save to"),
      h("select", { class: "fit", onChange: (e) => onScope?.(e.target.value) },
        h("option", { value: "repo", selected: saveScope !== "global" }, "this repo"),
        h("option", { value: "global", selected: saveScope === "global" }, "global"))),
    canDelete ? item("Delete flow", onDelete) : null));
  const save = h("button", { class: st.primary === "save" ? "primary" : null, "data-focus": "flow-save", title: "⌘S", onClick: () => onSave?.() }, "Save");
  const run = h("button", { class: st.primary === "run" ? "primary" : null, "data-focus": "flow-run", onClick: () => onRun?.() }, "Test run");
  const actions = st.primary === "save" ? [run, save] : [save, run];
  const head = h("div", { class: "toolbar flow-head" },
    h("h1", {}, st.title),
    h("span", { class: st.scopeLabel === "not saved yet" ? "pill claude" : "pill" }, st.scopeLabel),
    h("span", { class: "seg" }, seg("visual", "Visual"), seg("yaml", "YAML")),
    h("span", { class: "spacer" }),
    h("button", { class: "overview-toggle", "data-focus": "flow-overview", "aria-expanded": overviewOpen ? "true" : "false", "aria-controls": "flow-overview", onClick: () => onOverview?.() }, "Overview"),
    actions,
    more);
  const state = h("div", { class: "flow-state" },
    h("span", { class: "flow-dirty" }, st.dirtyLabel),
    h("button", { class: `flow-validation status ${VALIDATION_CLASS[st.validation.kind] ?? ""}`.trim(), "data-focus": "flow-validation", onClick: () => onProblems?.() }, st.validation.label),
    h("span", { class: "muted flow-target" }, st.saveLabel));
  return [head, state];
}

/** The left list: the two start buttons, the search box and the flows. */
export function renderNavigator({ flows, current, query, onQuery, onDraft, onBlank }) {
  const shown = filterFlows(flows, query);
  // The open flow stays listed, even when the search does not match it.
  const open = current?.name ? flows.find((f) => f.name === current.name) : null;
  const list = open && !shown.includes(open) ? [open, ...shown] : shown;
  return [
    h("div", { class: "side-actions" },
      h("button", { class: current ? null : "primary", onClick: () => onDraft?.() }, "✨ Draft flow with Claude"),
      h("button", { onClick: () => onBlank?.() }, "+ Blank flow")),
    h("h3", {}, "Flows"),
    h("input", { type: "search", class: "flow-search", "aria-label": "Search flows", placeholder: "Search flows", value: query ?? "", "data-focus": "flow-search", onInput: (e) => onQuery?.(e.target.value) }),
    h("ul", { class: "flow-list" },
      current && !current.name ? h("li", {}, h("a", { href: "#/new", class: "active" }, h("span", { class: "n" }, current.obj?.name ?? "new flow", h("span", { class: "pill claude" }, "unsaved")))) : null,
      list.map((f) => h("li", { class: f.error ? "bad" : null },
        h("a", { href: `#/flows/${f.name}`, class: current?.name === f.name ? "active" : null },
          h("span", { class: "n" }, h("span", {}, flowNameMark(f), current?.name === f.name && current.dirty ? " •" : ""), f.published ? h("span", { class: "pill ok" }, "published") : null, h("span", { class: "pill" }, f.scope)),
          h("span", { class: "d" }, f.error ? "invalid flow" : f.description ?? ""))))),
    String(query ?? "").trim() && !list.length ? h("p", { class: "muted" }, "No flow matches.") : null,
  ];
}
