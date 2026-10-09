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
import { badge, banner, card, emptyState, list, skeleton, table } from "../kit/display.js";
import { checkbox, field, select, textArea, textInput } from "../kit/forms.js";
import { dialog, drawer, menu, tabs, toast, tooltip } from "../kit/overlays.js";
import { diffView, evidence, logView, timeline, timelineEntry } from "../kit/records.js";

export const LONG = "This made-up sentence is much longer than any real label should be, so that it has to wrap or be cut inside a narrow box, and it ends with Supercalifragilisticexpialidocious_Unbroken_Word_Without_Any_Spaces_At_All.";

const TONES = ["neutral", "ok", "fail", "run", "warn", "accent"];
const COLS = [{ key: "name", label: "Name" }, { key: "role", label: "Role" }, { key: "count", label: "Count", align: "end" }];
const people = (n) => Array.from({ length: n }, (_, i) => ({ n: i + 1, name: `Person ${i + 1}`, role: ["Maker", "Tester", "Reviewer"][i % 3], count: i * 7 }));
const WIDE_COLS = Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `Column ${i + 1}`, cell: (r) => `Value ${r.n}.${i + 1}` }));
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
const LOG_TONES = ["ok", "fail", "step", "dim"];
const logLines = (n) => Array.from({ length: n }, (_, i) => {
  const tone = i % 5 === 4 ? undefined : LOG_TONES[i % 5];
  const mark = { ok: "✔ ", fail: "✘ ", step: "▶ ", dim: "  " }[tone] ?? "  ";
  return { text: `${mark}line ${i + 1}: made-up output of a step`, tone };
});
const PATCH = [
  "diff --git a/old.txt b/new.txt", "similarity index 80%", "rename from old.txt", "rename to new.txt", "index 1a2b3c..4d5e6f 100644",
  "--- a/old.txt", "+++ b/new.txt", "@@ -1,3 +1,3 @@", " first line", "-second line", "+second line, changed", " third line",
  "diff --git a/extra.txt b/extra.txt", "--- a/extra.txt", "+++ b/extra.txt", "@@ -1,1 +1,3 @@", " keep", "+added one", "+added two",
].join("\n");
const bigPatch = (files, linesPerFile) => Array.from({ length: files }, (_, f) => {
  const body = Array.from({ length: linesPerFile }, (_, i) => [` context ${i}`, `-old ${i}`, `+new ${i}`][i % 3]);
  const count = (...marks) => body.filter((l) => marks.includes(l[0])).length;
  return [
    `diff --git a/file${f}.txt b/file${f}.txt`, `--- a/file${f}.txt`, `+++ b/file${f}.txt`, `@@ -1,${count(" ", "-")} +1,${count(" ", "+")} @@`, ...body,
  ].join("\n");
}).join("\n");
const HEADER_ONLY = "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt";
const STAT = " old.txt => new.txt | 2 +-\n extra.txt          | 2 ++\n 2 files changed, 3 insertions(+), 1 deletion(-)";
const ENTRY_TIME = "2026-10-01T10:00:00Z";

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
  {
    id: "evidence", title: "Evidence", component: "evidence",
    examples: [
      { name: "Closed", build: () => evidence({ title: "Tests passed", source: "step build" }, "42 tests ran with no failures.") },
      { name: "Open", build: () => evidence({ title: "Review notes", source: "step review", open: true }, "Two findings:", list({ items: ["Rename the helper.", "Add a test."] })) },
      { name: "With link", build: () => evidence({ title: "Build log", source: "step build", href: "#evidence" }, "The full log is in the run.") },
      { name: "No source", build: () => evidence({ title: "Old run note" }, "This run did not record where this came from.") },
      { name: "With a log", build: () => evidence({ title: "Output", source: "step test", open: true }, logView({ label: "Test output", lines: logLines(6) })) },
      { name: "Long content", build: () => evidence({ title: LONG, source: LONG, open: true }, LONG) },
      { name: "Notes", build: () => notes("Tab to the summary; Enter or Space opens and closes it.", "a long title wraps.", "the summary wraps; nothing is cut.") },
    ],
  },
  {
    id: "timelineEntry", title: "Timeline entry", component: "timelineEntry",
    examples: [
      { name: "Tones", build: () => timeline({ label: "Entry tones" }, TONES.map((tone) => timelineEntry({ title: `Tone ${tone}`, tone }, `A ${tone} entry.`))) },
      { name: "Time and actor", build: () => timeline({ label: "Entry with time" }, [timelineEntry({ title: "Build finished", time: ENTRY_TIME, actor: "Maker", tone: "ok" }, "All checks passed.")]) },
      { name: "Missing data", build: () => timeline({ label: "Old run" }, [timelineEntry({ title: "Step ran" })]) },
      { name: "Long content", build: () => timeline({ label: "Long entry" }, [timelineEntry({ title: LONG, actor: LONG, time: ENTRY_TIME }, LONG)]) },
      { name: "Notes", build: () => notes("no keys of its own; controls inside an entry are reached with Tab.", "long titles wrap.", "the time and the actor move under the title.") },
    ],
  },
  {
    id: "timeline", title: "Timeline", component: "timeline",
    examples: [
      { name: "Default", build: () => timeline({ label: "Steps" }, [
        timelineEntry({ title: "Run started", time: ENTRY_TIME, actor: "Foundry", tone: "run" }),
        timelineEntry({ title: "Plan written", time: "2026-10-01T10:05:00Z", actor: "Planner", tone: "ok" }, "Three files change."),
        timelineEntry({ title: "Build failed", time: "2026-10-01T10:20:00Z", actor: "Maker", tone: "fail" }, evidence({ title: "Compiler output", source: "step build" }, "Type error in one file.")),
        timelineEntry({ title: "Waiting for review", tone: "warn" }),
      ]) },
      { name: "Empty", build: () => timeline({ label: "Steps" }, []) },
      { name: "Long content", build: () => timeline({ label: LONG }, [timelineEntry({ title: LONG }, LONG)]) },
      { name: "Notes", build: () => notes("no keys of its own; controls inside an entry are reached with Tab.", "long titles wrap.", "the time and the actor move under the title.") },
    ],
  },
  {
    id: "logView", title: "Log view", component: "logView",
    examples: [
      { name: "Default", build: () => logView({ label: "Step log", lines: logLines(12) }) },
      { name: "Tones", build: () => logView({ label: "Log tones", lines: [{ text: "plain line" }, ...LOG_TONES.map((tone) => ({ text: `a ${tone} line`, tone }))] }) },
      { name: "500 lines", build: () => logView({ label: "Long log", lines: logLines(500) }) },
      { name: "Follow", build: () => logView({ label: "Followed log", lines: logLines(200), follow: true }) },
      { name: "Long content", build: () => logView({ label: "Long lines", lines: [{ text: LONG }, { text: "x".repeat(400), tone: "dim" }, { text: "<b>not bold</b> <script>nothing()</script>" }] }) },
      { name: "Empty", build: () => logView({ label: "Empty log", lines: [] }) },
      { name: "Notes", build: () => notes("Tab to the log, then the arrow keys, Page Up and Page Down scroll it.", "long lines wrap inside the box.", "the box keeps the frame width and scrolls up and down.") },
    ],
  },
  {
    id: "diffView", title: "Diff view", component: "diffView",
    examples: [
      { name: "Default", build: () => diffView({ stat: STAT, patch: PATCH }) },
      { name: "Large diff", build: () => diffView({ patch: bigPatch(40, 12) }) },
      { name: "Header only", build: () => diffView({ patch: HEADER_ONLY }) },
      { name: "Truncated", build: () => diffView({ stat: STAT, patch: PATCH, truncated: true }) },
      { name: "Empty", build: () => diffView({ stat: "", patch: "" }) },
      { name: "Long content", build: () => diffView({ patch: `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+${LONG}` }) },
      { name: "Notes", build: () => notes("Tab to the diff, then the arrow keys scroll both ways.", "long lines do not wrap; the box scrolls sideways.", "the page does not scroll sideways, only the box.") },
    ],
  },
];
