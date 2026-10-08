// The gallery registry: one section per exported function of the kit modules (ui/kit/*.js).
//
// To add a section, add one object to `sections`: { id, title, component, examples: [{ name, build }] }.
//   component  the export name of the kit function (tests/ui-gallery.test.ts fails when one has no section)
//   build      returns one Node; use made-up text and call no API
// Every section needs an example for each variant, and these reserved names: `Long content`, `Disabled`
// (where the component has a disabled state) and `Error` (where it has an error state).
import { h } from "../dom.js";
import { button, iconButton, link } from "../kit/actions.js";
import { badge, banner, card, emptyState, list, skeleton, table } from "../kit/display.js";
import { checkbox, field, select, textArea, textInput } from "../kit/forms.js";

export const LONG = "This made-up sentence is much longer than any real label should be, so that it has to wrap or be cut inside a narrow box, and it ends with Supercalifragilisticexpialidocious_Unbroken_Word_Without_Any_Spaces_At_All.";

const TONES = ["neutral", "ok", "fail", "run", "warn", "accent"];
const COLS = [{ key: "name", label: "Name" }, { key: "role", label: "Role" }, { key: "count", label: "Count", align: "end" }];
const people = (n) => Array.from({ length: n }, (_, i) => ({ n: i + 1, name: `Person ${i + 1}`, role: ["Maker", "Tester", "Reviewer"][i % 3], count: i * 7 }));
const WIDE_COLS = Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `Column ${i + 1}`, cell: (r) => `Value ${r.n}.${i + 1}` }));
const row = (...nodes) => h("div", { class: "gallery-row" }, nodes);
const VARIANTS = ["default", "primary", "danger", "ghost"];
const ICONS = [["ghost", "x"], ["default", "check"], ["primary", "info"], ["danger", "ban"]];
const OPTIONS = [["a", "First option"], ["b", "Second option"], ["c", "Third option"]];

export const sections = [
  {
    id: "button", title: "Button", component: "button",
    examples: [
      { name: "Variants", build: () => row(...VARIANTS.map((variant) => button({ variant }, variant))) },
      { name: "Sizes", build: () => row(button({}, "Default size"), button({ size: "small" }, "Small size")) },
      { name: "Busy", build: () => row(button({ busy: true }, "Saving"), button({ variant: "primary", busy: true }, "Saving")) },
      { name: "Long content", build: () => button({}, LONG) },
      { name: "Disabled", build: () => row(...VARIANTS.map((variant) => button({ variant, disabled: true }, variant))) },
    ],
  },
  {
    id: "iconButton", title: "Icon button", component: "iconButton",
    examples: [
      { name: "Variants", build: () => row(...ICONS.map(([variant, icon]) => iconButton({ icon, variant, label: `${variant} ${icon}` }))) },
      { name: "Busy", build: () => row(iconButton({ icon: "check", label: "Busy", busy: true })) },
      { name: "Long content", build: () => iconButton({ icon: "info", label: LONG }) },
      { name: "Disabled", build: () => row(...ICONS.map(([variant, icon]) => iconButton({ icon, variant, label: `Disabled ${variant}`, disabled: true }))) },
    ],
  },
  {
    id: "link", title: "Link", component: "link",
    examples: [
      { name: "Internal", build: () => link({ href: "#button" }, "Back to the button section") },
      { name: "External", build: () => link({ href: "https://example.test/", external: true }, "Example page (opens a new tab)") },
      { name: "Long content", build: () => link({ href: "#button" }, LONG) },
      { name: "Disabled", build: () => link({ href: "#button", disabled: true }, "A link that is off") },
    ],
  },
  {
    id: "field", title: "Field", component: "field",
    examples: [
      { name: "Label only", build: () => field({ label: "Name" }, textInput({ value: "Ada" })) },
      { name: "Hint", build: () => field({ label: "Name", hint: "As shown on the board." }, textInput({})) },
      { name: "Required", build: () => field({ label: "Name", required: true }, textInput({})) },
      { name: "Error", build: () => field({ label: "Name", error: "Enter a name." }, textInput({})) },
      { name: "Hint and error", build: () => field({ label: "Name", hint: "As shown on the board.", error: "Enter a name." }, textInput({})) },
      { name: "With select", build: () => field({ label: "Choice" }, select({ options: OPTIONS })) },
      { name: "With text area", build: () => field({ label: "Notes" }, textArea({})) },
      { name: "Long content", build: () => field({ label: LONG, hint: LONG, error: LONG }, textInput({ value: "x" })) },
      { name: "Disabled", build: () => field({ label: "Name" }, textInput({ disabled: true, value: "Ada" })) },
    ],
  },
  {
    id: "textInput", title: "Text input", component: "textInput",
    examples: [
      { name: "Default", build: () => textInput({ value: "Some text", "aria-label": "Default" }) },
      { name: "Placeholder", build: () => textInput({ placeholder: "Type here", "aria-label": "Placeholder" }) },
      { name: "Mono", build: () => textInput({ mono: true, value: "feature/12-example", "aria-label": "Mono" }) },
      { name: "Types", build: () => row(textInput({ type: "number", value: "42", "aria-label": "Number" }), textInput({ type: "password", value: "secret", "aria-label": "Password" })) },
      { name: "Long content", build: () => textInput({ value: LONG, "aria-label": "Long content" }) },
      { name: "Disabled", build: () => textInput({ value: "Off", disabled: true, "aria-label": "Disabled" }) },
    ],
  },
  {
    id: "textArea", title: "Text area", component: "textArea",
    examples: [
      { name: "Default", build: () => textArea({ value: "Some text", "aria-label": "Default" }) },
      { name: "Rows", build: () => row(textArea({ rows: 2, "aria-label": "Two rows" }), textArea({ rows: 8, "aria-label": "Eight rows" })) },
      { name: "Mono", build: () => textArea({ mono: true, value: "line one\nline two", "aria-label": "Mono" }) },
      { name: "Long content", build: () => textArea({ value: LONG, "aria-label": "Long content" }) },
      { name: "Disabled", build: () => textArea({ value: "Off", disabled: true, "aria-label": "Disabled" }) },
    ],
  },
  {
    id: "select", title: "Select", component: "select",
    examples: [
      { name: "Pairs and strings", build: () => row(select({ options: OPTIONS, "aria-label": "Pairs" }), select({ options: ["one", "two"], "aria-label": "Strings" })) },
      { name: "Empty label", build: () => select({ options: OPTIONS, emptyLabel: "Choose one", "aria-label": "Empty label" }) },
      { name: "Selected value", build: () => select({ options: OPTIONS, value: "b", "aria-label": "Selected" }) },
      { name: "Long content", build: () => select({ options: [["a", LONG], ["b", "Short"]], "aria-label": "Long content" }) },
      { name: "Disabled", build: () => select({ options: OPTIONS, disabled: true, "aria-label": "Disabled" }) },
    ],
  },
  {
    id: "checkbox", title: "Checkbox", component: "checkbox",
    examples: [
      { name: "Unchecked", build: () => checkbox({ label: "Send me a summary" }) },
      { name: "Checked", build: () => checkbox({ label: "Send me a summary", checked: true }) },
      { name: "Long content", build: () => checkbox({ label: LONG }) },
      { name: "Disabled", build: () => row(checkbox({ label: "Off, unchecked", disabled: true }), checkbox({ label: "Off, checked", checked: true, disabled: true })) },
    ],
  },
  {
    id: "card", title: "Card", component: "card",
    examples: [
      { name: "Title and actions", build: () => card({ title: "Build results", actions: button({ size: "small" }, "Refresh") }, "Three checks passed.", "One check was skipped.") },
      { name: "Tones", build: () => h("div", { class: "gallery-stack" }, TONES.map((tone) => card({ title: `Tone ${tone}`, tone }, `A ${tone} card.`))) },
      { name: "No title", build: () => card({ "aria-label": "Plain card" }, "A card with no heading.") },
      { name: "Long content", build: () => card({ title: LONG, actions: [button({ size: "small" }, "First action"), button({ size: "small" }, "Second action")] }, LONG) },
    ],
  },
  {
    id: "table", title: "Table", component: "table",
    examples: [
      { name: "Default", build: () => table({ caption: "People", columns: COLS, rows: people(4) }) },
      { name: "Hidden caption", build: () => table({ caption: "People (caption hidden)", hideCaption: true, columns: COLS, rows: people(3) }) },
      { name: "Row open", build: () => table({ caption: "Open a person", columns: COLS, rows: people(4), onRowOpen: () => {} }) },
      { name: "Custom cells", build: () => table({ caption: "Status", columns: [COLS[0], { key: "state", label: "State", cell: (r) => badge({ tone: r.n % 2 ? "ok" : "warn", label: r.n % 2 ? "Done" : "Waiting" }) }], rows: people(4) }) },
      { name: "Empty", build: () => table({ caption: "Nobody here", columns: COLS, rows: [], empty: "No people yet." }) },
      { name: "Empty with empty state", build: () => table({ caption: "Nobody here", columns: COLS, rows: [], empty: emptyState({ title: "No people", text: "Add one to begin." }) }) },
      { name: "40 rows", build: () => table({ caption: "Forty people", columns: COLS, rows: people(40) }) },
      { name: "Wide", build: () => table({ caption: "Twelve columns", columns: WIDE_COLS, rows: people(3) }) },
      { name: "Long content", build: () => table({ caption: "Long cell", columns: COLS, rows: [{ name: LONG, role: LONG, count: 1 }] }) },
    ],
  },
  {
    id: "list", title: "List", component: "list",
    examples: [
      { name: "Unordered", build: () => list({ items: ["First", "Second", "Third"] }) },
      { name: "Ordered", build: () => list({ ordered: true, items: ["First", "Second", "Third"] }) },
      { name: "Node items", build: () => list({ items: [[link({ href: "#list" }, "A link"), " ", badge({ tone: "ok", label: "Done" })], badge({ tone: "run", label: "Running" })] }) },
      { name: "Long content", build: () => list({ items: [LONG, "Short"] }) },
    ],
  },
  {
    id: "badge", title: "Badge", component: "badge",
    examples: [
      { name: "Tones", build: () => row(...TONES.map((tone, i) => badge({ tone, label: ["Draft", "Done", "Failed", "Running", "Waiting", "New"][i] }))) },
      { name: "Long content", build: () => badge({ tone: "warn", label: LONG }) },
    ],
  },
  {
    id: "banner", title: "Banner", component: "banner",
    examples: [
      { name: "Tones", build: () => h("div", { class: "gallery-stack" }, TONES.map((tone) => banner({ tone, title: `Tone ${tone}` }, `A ${tone} message.`))) },
      { name: "Title only", build: () => banner({ tone: "ok", title: "Saved" }) },
      { name: "Text only", build: () => banner({ tone: "run" }, "The run has started.") },
      { name: "With actions", build: () => banner({ tone: "warn", title: "Check this", actions: button({ size: "small" }, "Review") }, "Something needs a look.") },
      { name: "Dismiss", build: () => banner({ tone: "fail", title: "Failed", onDismiss: () => {} }, "The step did not finish.") },
      { name: "Long content", build: () => banner({ tone: "fail", title: LONG, actions: button({ size: "small" }, LONG), onDismiss: () => {} }, LONG) },
    ],
  },
  {
    id: "skeleton", title: "Skeleton", component: "skeleton",
    examples: [
      { name: "Default", build: () => skeleton({}) },
      { name: "One line", build: () => skeleton({ lines: 1 }) },
      { name: "Many lines", build: () => skeleton({ lines: 12 }) },
      { name: "In a card", build: () => card({ title: "Loading card" }, skeleton({ lines: 4 })) },
      { name: "Long content", build: () => skeleton({ label: LONG }) },
    ],
  },
  {
    id: "emptyState", title: "Empty state", component: "emptyState",
    examples: [
      { name: "Title only", build: () => emptyState({ title: "Nothing here" }) },
      { name: "With text", build: () => emptyState({ title: "Nothing here", text: "Items you add will show up in this place." }) },
      { name: "With action", build: () => emptyState({ title: "No items", text: "Add the first one.", action: button({ variant: "primary" }, "Add item") }) },
      { name: "Long content", build: () => emptyState({ title: LONG, text: LONG, action: button({}, LONG) }) },
    ],
  },
];
