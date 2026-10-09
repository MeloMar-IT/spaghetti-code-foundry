# UI components (the kit)

The kit is a small set of plain JavaScript modules in `ui/kit/` that build common controls with `h` from `ui/dom.js`. Pages use the kit instead of repeating markup and inline styles. It has actions, form controls and display primitives. No page uses the kit yet.

## Conventions

- **Modules.** `ui/kit/actions.js` (button, iconButton, link), `ui/kit/forms.js` (field, textInput, textArea, select, checkbox), `ui/kit/display.js` (card, table, list, badge, banner, skeleton, emptyState). `ui/kit/core.js` has small shared helpers and is not part of the public kit.
- **Plain functions.** Each component is a function that returns a DOM element. Props are one object; children follow it (`button(props, ...children)`). `class` is added to the kit classes. Other props (for example `id`, `name`, `aria-*`, `data-*`) go to the element.
- **No inline styles.** Kit modules never pass `style` to `h()`. A component throws if the caller passes `style`. Use a class.
- **CSS.** `ui/kit/kit.css` imports `actions.css`, `forms.css` and `display.css`, and is linked from `ui/index.html` and `ui/user/index.html`. Kit CSS uses only `scf-` class selectors (`.scf-btn`, `.scf-btn--primary`, `.scf-field__label`) and token variables from the theme and density tokens. No id selectors, no bare tag selectors, no colour literals. `tests/ui-css.test.ts` reads the files and fails on these.
- **Names.** Block `scf-name`, part `scf-name__part`, variant or state `scf-name--variant`.
- **Global rules.** The global `button` rules in `ui/style.css` stay. Kit classes are written to look right on top of them.
- **Unbound.** Controls take `value` and `onInput`/`onChange` and keep no state. They are not the bound inputs in `ui/fields.js`, which are unchanged.
- **Errors.** A missing required prop (a label, an `href`, `options`) or an unknown variant or size throws an `Error` at once.
- **Tests.** `tests/ui-kit-actions.test.ts`, `tests/ui-kit-forms.test.ts` and `tests/ui-kit-display.test.ts`, with `installFakeDom`.

## Actions

### button

`button({ variant, size, busy, disabled, type, class, onClick, ...attrs }, ...children)`

- `variant`: `default` (default) | `primary` | `danger` | `ghost`. `size`: `default` | `small`. Other values throw.
- `busy`: shows a spinner, sets `aria-busy="true"` and `aria-disabled="true"`, and ignores clicks. The button stays focusable.
- `disabled`: sets the native `disabled` attribute.
- **Element:** `<button type="button">` unless `type` is given (for example `"submit"`). Classes: `scf-btn`, `scf-btn--primary|danger|ghost`, `scf-btn--small`, `scf-btn--busy`.
- **Keyboard:** Tab to focus; Enter and Space activate. A disabled button is skipped by Tab.
- **Accessible name:** the text of the children.

### iconButton

`iconButton({ icon, label, variant, class, ...attrs })`

- `icon`: icon name from `ui/icons.js`. `label` is required and throws if empty. `variant` defaults to `ghost`; the other `button` props work too.
- **Element:** a `button` with class `scf-btn--icon`.
- **Keyboard:** as `button`.
- **Accessible name:** `label`, set as `aria-label` and as `title`.

### link

`link({ href, external, class, ...attrs }, ...children)`

- `href` is required and throws if empty. `external: true` adds `rel="noopener noreferrer"` and `target="_blank"`.
- **Element:** `<a href class="scf-link">`.
- **Keyboard:** Tab to focus; Enter activates.
- **Accessible name:** the text of the children. For an external link, say so in the text.

## Form controls

### field

`field({ label, hint, error, required, class }, control)`

- Wraps a control built by `textInput`, `textArea` or `select`. `label` is required and throws if empty.
- Sets an `id` on the control if it has none, and joins the label with `for`/`id`.
- `hint` and `error` get ids and are added to the control's `aria-describedby` (an existing value is kept).
- `error` sets `aria-invalid="true"` on the control and is drawn in an element with `role="alert"`.
- `required` sets `required` on the control and shows an `*` that is hidden from assistive technology.
- **Element:** `<div class="scf-field">` with a `label`, the control, a `small` hint and a `div` error.
- **Keyboard:** a click on the label focuses the control.
- **Accessible name:** the label text; the hint and error are the description.

### textInput and textArea

`textInput({ value, onInput, onChange, placeholder, mono, disabled, type, class, ...attrs })` and `textArea({ rows, ...same })`

- `type` defaults to `text`; `rows` defaults to 4. `mono` uses the monospace font.
- **Element:** `<input class="scf-input">` and `<textarea class="scf-input scf-input--area">`.
- **Keyboard:** native text editing.
- **Accessible name:** none by itself. Wrap it in `field`, or pass `aria-label`.

### select

`select({ options, value, emptyLabel, onChange, disabled, class, ...attrs })`

- `options`: `[value, label]` pairs or plain strings. `options` is required and must be an array. `emptyLabel` adds an empty first option. The option equal to `value` (compared as strings) is selected.
- **Element:** `<select class="scf-input scf-input--select">` with `<option>`s.
- **Keyboard:** native (arrow keys, type-ahead, Enter or Space to open).
- **Accessible name:** as `textInput`.

### checkbox

`checkbox({ label, checked, onChange, disabled, class, ...attrs })`

- `label` is required and throws if empty.
- **Element:** `<label class="scf-checkbox">` holding a native `<input type="checkbox">` and a `span` with the label text.
- **Keyboard:** Tab to focus; Space toggles.
- **Accessible name:** the label text.

## Display

Tones for `card`, `badge` and `banner`: `neutral` | `ok` | `fail` | `run` | `warn` | `accent`. Any other tone throws. The meaning is always in the text, never in colour only. All tones use theme tokens. The old `.card`, `.table`, `.table-box`, `.pill`, `.badge` and `.empty` classes in `ui/style.css` stay for the existing pages; the kit uses `scf-` classes. `.scf-visually-hidden` hides text on screen but keeps it for screen readers.

### card

`card({ title, actions, tone, level, id, class, ...attrs }, ...children)`

- **Element:** `<section class="scf-card scf-card--<tone>">`. With `title` it holds a heading (`h2` by default; `level` 2–6) and the section has `aria-labelledby` pointing at it. Without a title, pass your own `aria-label`. `actions` is a node shown next to the heading.
- **Accessible name:** the title.

### table

`table({ caption, columns, rows, onRowOpen, empty, hideCaption, id, class })`

- `columns`: `[{ key, label, align?, cell?(row, index) }]`. `align` is `start` (default) or `end`. `cell` returns text or a node; without it the cell shows `row[key]`.
- `caption` and at least one column are required and throw if missing. `hideCaption: true` hides the caption visually; it stays for screen readers.
- **Element:** a real `<table>` with `<caption>` and `<th scope="col">`, inside a scroll box (`div.scf-table-box`, `role="region"`, `tabindex="0"`, named by the caption). A wide table scrolls inside the box, not the page. This answers finding F14 in `docs/ui-redesign/findings.md`.
- **Row open:** with `onRowOpen(row, index)` the first cell holds a `<button>` named by the cell text, so a row opens by mouse and keyboard.
- **No rows:** shows `empty` (a string or a node, default "Nothing to show.") under the headers.
- **Keyboard:** Tab to the scroll box and use the arrow keys to scroll; Tab to a row button and press Enter or Space.

### list

`list({ items, ordered, class, ...attrs })`

- `items` is an array of strings, nodes or arrays of them (required). **Element:** `<ul>`, or `<ol>` with `ordered: true`, with one `<li>` per item.

### badge

`badge({ tone, label, class, ...attrs })`

- `label` is required. **Element:** `<span class="scf-badge scf-badge--<tone>">`. Use words such as "Failed" or "Running", not only a colour.

### banner

`banner({ tone, title, actions, onDismiss, class, ...attrs }, ...children)`

- Needs a `title` or content. **Element:** `<div>` with `role="alert"` for `fail` and `role="status"` for the other tones.
- `onDismiss` adds an `iconButton` labelled "Dismiss". The banner does not remove itself; your handler does.
- **Keyboard:** the dismiss button and any `actions` are reached with Tab.

### skeleton

`skeleton({ lines, label, class, ...attrs })`

- `lines`: a whole number from 1 to 20 (default 3). `label` defaults to "Loading…".
- **Element:** a container with `aria-busy="true"` and a visually hidden label. The grey lines are `aria-hidden`. Replace the skeleton with the content when it has loaded.

### emptyState

`emptyState({ title, text, action, level, class, ...attrs })`

- `title` is required. **Element:** a heading (`h3` by default; `level` 2–6), optional text, and an optional `action` node (for example a `button`).

## The gallery

The gallery shows every kit component with made-up data. It is a development aid and is off by default.

**Open it.** Start the server with the switch, then open `/gallery/`:

```bash
scf ui --dev       # or: scf serve --dev
# http://localhost:4777/gallery/
```

Without `--dev`, every path under `/gallery` answers 404. The files ship in the package (`ui/` is in `files`); the switch keeps the gallery out of normal installs. Static files need no sign-in, so do not leave `--dev` on a shared server. The gallery holds no data and makes no API call.

**Control bar.** Theme (`light`, `dark`), density (`comfortable`, `compact`) and width (`wide`, `narrow`, a 390 px frame). The choice is kept in the address query, for example `/gallery/?theme=dark&density=compact&width=narrow`. Theme and density are the `data-theme` and `data-density` attributes on the root element.

**Files.** `ui/gallery/index.html` (no inline script or style), `gallery.js` (entry), `view.js` (query, bar, drawing), `registry.js` (the sections).

**Add a section.** When you add an exported function to a `ui/kit/*.js` module, add one object to `sections` in `ui/gallery/registry.js`:

```js
{ id: "button", title: "Button", component: "button",
  examples: [{ name: "Variants", build: () => button({ variant: "primary" }, "Save") }] }
```

- `component` is the export name. `build` returns one node and uses made-up text.
- Give an example for each variant, plus `Long content`, `Disabled` (where the component has it) and `Error` (where it has it).
- `tests/ui-gallery.test.ts` fails when a kit export has no section, and builds every example in both themes and both densities on the fake DOM. `tests/ui-gallery-server.test.ts` checks that `/gallery/` is served with `dev` and answers 404 without it.
- The tests check structure, not looks. Open the gallery in a browser to check variants, long content, errors, keyboard focus and the narrow frame.
