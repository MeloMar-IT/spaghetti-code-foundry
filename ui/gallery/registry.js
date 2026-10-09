// The gallery registry: one section per exported function of the kit modules (ui/kit/*.js).
//
// To add a section, add one object to `sections`: { id, title, component, examples: [{ name, build }] }.
//   component  the export name of the kit function (tests/ui-gallery.test.ts fails when one has no section)
//   build      returns one Node; use made-up text and call no API
// Every section needs an example for each variant, and these reserved names: `Long content`, `Disabled`
// (only where the component has a disabled state), `Error` (where it has an error state) and `Notes`
// (where the component has keyboard behaviour: its keys, long content and the narrow layout).
import { h } from "../dom.js";
import { button, iconButton, link } from "../kit/actions.js";
import { checkbox, field, select, textArea, textInput } from "../kit/forms.js";
import { dialog, drawer, menu, tabs, toast, tooltip } from "../kit/overlays.js";

export const LONG = "This made-up sentence is much longer than any real label should be, so that it has to wrap or be cut inside a narrow box, and it ends with Supercalifragilisticexpialidocious_Unbroken_Word_Without_Any_Spaces_At_All.";

const row = (...nodes) => h("div", { class: "gallery-row" }, nodes);
const VARIANTS = ["default", "primary", "danger", "ghost"];
const ICONS = [["ghost", "x"], ["default", "check"], ["primary", "info"], ["danger", "ban"]];
const notes = (keyboard, long, narrow) => h("ul", {}, h("li", {}, "Keyboard: ", keyboard), h("li", {}, "Long content: ", long), h("li", {}, "Narrow layout: ", narrow));
const NARROW = "Overlays cover the browser window, not the gallery frame. Make the window 760 px or narrower: the drawer takes the full width.";
const TABS = [
  { id: "one", label: "First", build: () => h("p", {}, "First panel.") },
  { id: "two", label: "Second", build: () => h("p", {}, "Second panel.") },
  { id: "three", label: "Third", build: () => h("p", {}, "Third panel.") },
];
const ITEMS = [{ label: "Open" }, { label: "Rename" }, { label: "Delete", danger: true }];
const OPTIONS =[["a", "First option"], ["b", "Second option"], ["c", "Third option"]];

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
    id: "tabs", title: "Tabs", component: "tabs",
    examples: [
      { name: "Default", build: () => tabs({ label: "Example tabs", tabs: TABS }) },
      { name: "Selected", build: () => tabs({ label: "Example tabs", tabs: TABS, selected: "two" }) },
      { name: "Long content", build: () => tabs({ label: "Long tabs", tabs: [{ id: "long", label: LONG, build: () => h("p", {}, LONG) }, ...TABS] }) },
      { name: "Notes", build: () => notes("Tab reaches the selected tab; Left and Right move and wrap; Home and End jump.", "a long label wraps inside the tab list.", "the tabs wrap onto more lines.") },
    ],
  },
  {
    id: "menu", title: "Menu", component: "menu",
    examples: [
      { name: "Default", build: () => menu({ label: "Actions", trigger: "Actions", items: ITEMS }) },
      { name: "Above, end aligned", build: () => menu({ label: "Actions", trigger: "Actions", items: ITEMS, placement: "above", align: "end" }) },
      { name: "Danger item", build: () => menu({ label: "Danger actions", trigger: "Danger", items: [{ label: "Rename" }, { label: "Delete", danger: true }] }) },
      { name: "Long content", build: () => menu({ label: "Long menu", trigger: "Long", items: [{ label: LONG }, ...ITEMS] }) },
      { name: "Disabled", build: () => row(menu({ label: "With a disabled item", trigger: "One off", items: [{ label: "Open" }, { label: "Delete", disabled: true }] }), menu({ label: "Empty", trigger: "Empty", items: [] })) },
      { name: "Notes", build: () => notes("Enter, Space or Down opens it; Up and Down move; Home and End jump; Escape closes.", "a long item wraps.", "the list is at most 90% of the window wide.") },
    ],
  },
  {
    id: "tooltip", title: "Tooltip", component: "tooltip",
    examples: [
      { name: "On a button", build: () => tooltip({ text: "Saves your changes" }, button({}, "Save")) },
      { name: "Below, end aligned", build: () => tooltip({ text: "Saves your changes", placement: "below", align: "end" }, button({}, "Save")) },
      { name: "Long content", build: () => tooltip({ text: LONG }, button({}, "Hover or focus me")) },
      { name: "Notes", build: () => notes("it shows on hover and on focus, and Escape hides it. It never holds the only copy of needed information.", "a long text wraps inside the bubble.", "the bubble is at most 90% of the window wide.") },
    ],
  },
  {
    id: "dialog", title: "Dialog", component: "dialog",
    examples: [
      { name: "Open", build: () => button({ onClick: () => dialog({ title: "Example dialog", build: (close) => h("div", {}, h("p", {}, "A made-up dialog."), button({ variant: "primary", onClick: () => close("done") }, "Done")) }) }, "Open dialog") },
      { name: "Stacked", build: () => button({ onClick: () => dialog({ title: "First dialog", build: () => button({ onClick: () => dialog({ title: "Second dialog", build: (close) => button({ onClick: () => close() }, "Close second") }) }, "Open second") }) }, "Open stacked dialogs") },
      { name: "Busy", build: () => button({ onClick: () => dialog({ title: "Busy dialog", busy: () => true, build: (close) => h("div", {}, h("p", {}, "Escape and the backdrop do nothing here."), button({ onClick: () => close() }, "Finish")) }) }, "Open busy dialog") },
      { name: "Long content", build: () => button({ onClick: () => dialog({ title: LONG, build: () => h("p", {}, LONG) }) }, "Open long dialog") },
      { name: "Notes", build: () => notes("focus stays inside; Tab and Shift+Tab wrap; Escape closes unless it is busy; focus returns to the button.", "a long title and body wrap.", NARROW) },
    ],
  },
  {
    id: "drawer", title: "Drawer", component: "drawer",
    examples: [
      { name: "End side", build: () => button({ onClick: () => drawer({ title: "End drawer", build: () => h("p", {}, "A made-up side panel.") }) }, "Open end drawer") },
      { name: "Start side", build: () => button({ onClick: () => drawer({ title: "Start drawer", side: "start", build: () => h("p", {}, "A made-up side panel.") }) }, "Open start drawer") },
      { name: "With a form", build: () => button({ onClick: () => drawer({ title: "Form drawer", build: (close) => h("div", {}, field({ label: "Name" }, textInput({})), button({ variant: "primary", onClick: () => close("saved") }, "Save")) }) }, "Open form drawer") },
      { name: "Long content", build: () => button({ onClick: () => drawer({ title: LONG, build: () => h("p", {}, LONG) }) }, "Open long drawer") },
      { name: "Notes", build: () => notes("the same keys as the dialog. A backdrop click does not close a drawer by default.", "a long title and body wrap.", NARROW) },
    ],
  },
  {
    id: "toast", title: "Toast", component: "toast",
    examples: [
      { name: "Tones", build: () => row(...["info", "ok", "warn", "fail"].map((tone) => button({ onClick: () => toast(`A ${tone} message`, { tone }) }, tone))) },
      { name: "Stays until dismissed", build: () => button({ onClick: () => toast("This stays until you dismiss it", { tone: "fail" }) }, "Show failure") },
      { name: "Long content", build: () => button({ onClick: () => toast(LONG, { tone: "fail" }) }, "Show long toast") },
      { name: "Notes", build: () => notes("each toast has a Dismiss button; a failure toast stays until dismissed, the others go after a few seconds.", "a long message wraps.", "toasts stack at the bottom and stay inside the window.") },
    ],
  },
];
