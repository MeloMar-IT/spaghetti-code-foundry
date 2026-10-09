import { h } from "./dom.js";
import { GROUPS, ORDERS, PROPS } from "./work-model.js";

// The Display menu of the Work page: what a card or row shows, how the stories are grouped and ordered.
// The choices apply to both layouts. `open` and `onToggle` let the page keep the menu open across a redraw.

const select = (focus, title, value, choices, onPick) =>
  h("select", { class: "small-select", "data-focus": focus, title, "aria-label": title, onChange: (e) => onPick(e.target.value) },
    choices.map((c) => h("option", { value: c.id, selected: c.id === value }, c.label)));

export function displayMenu(prefs, onChange, { open = false, onToggle } = {}) {
  const props = prefs.props ?? [];
  const check = (focus, label, checked, onPick) =>
    h("label", {}, h("input", { type: "checkbox", "data-focus": focus, checked, onChange: (e) => onPick(e.target.checked) }), label);
  return h("details", { class: "work-display", open, onToggle: (e) => onToggle?.(!!e?.target?.open) },
    h("summary", { "data-focus": "work-display", title: "What the stories show, grouping and order" }, "Display"),
    h("div", { class: "work-display-panel" },
      PROPS.map((p) => check(`work-prop-${p.id}`, p.label, props.includes(p.id),
        (on) => onChange({ props: PROPS.map((x) => x.id).filter((id) => (id === p.id ? on : props.includes(id))) }))),
      check("work-compact", "Compact cards", !!prefs.compact, (compact) => onChange({ compact })),
      select("work-group", "Group the stories", prefs.group, GROUPS, (group) => onChange({ group })),
      select("work-order", "Order the stories", prefs.order, ORDERS, (order) => onChange({ order })),
      prefs.layout !== "list" && prefs.group === "none" ? h("p", { class: "muted work-display-note" }, "The board groups by status when no grouping is chosen.") : null));
}
