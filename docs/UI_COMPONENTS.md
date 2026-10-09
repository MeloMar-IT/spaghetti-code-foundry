# UI components (the kit)

The kit is a small set of plain JavaScript modules in `ui/kit/` that build common controls with `h` from `ui/dom.js`. Pages use the kit instead of repeating markup and inline styles. So far: actions, form controls, and overlay and navigation primitives. No page uses the kit yet.

## Conventions

- **Modules.** `ui/kit/actions.js` (button, iconButton, link), `ui/kit/forms.js` (field, textInput, textArea, select, checkbox), `ui/kit/overlays.js` (tabs, menu, tooltip, dialog, drawer, toast). `ui/kit/core.js` has small shared helpers and is not part of the public kit.
- **Plain functions.** Each component is a function that returns a DOM element. Props are one object; children follow it (`button(props, ...children)`). `class` is added to the kit classes. Other props (for example `id`, `name`, `aria-*`, `data-*`) go to the element.
- **No inline styles.** Kit modules never pass `style` to `h()`. A component throws if the caller passes `style`. Use a class.
- **CSS.** `ui/kit/kit.css` imports `actions.css`, `forms.css` and `overlays.css`, and is linked from `ui/index.html` and `ui/user/index.html`. Kit CSS uses only `scf-` class selectors (`.scf-btn`, `.scf-btn--primary`, `.scf-field__label`) and token variables from the theme and density tokens. No id selectors, no bare tag selectors, no colour literals. `tests/ui-css.test.ts` reads the files and fails on these.
- **Names.** Block `scf-name`, part `scf-name__part`, variant or state `scf-name--variant`.
- **Global rules.** The global `button` rules in `ui/style.css` stay. Kit classes are written to look right on top of them.
- **Unbound.** Controls take `value` and `onInput`/`onChange` and keep no state. They are not the bound inputs in `ui/fields.js`, which are unchanged.
- **Errors.** A missing required prop (a label, an `href`, `options`) or an unknown variant or size throws an `Error` at once.
- **Tests.** `tests/ui-kit-actions.test.ts`, `tests/ui-kit-forms.test.ts` and `tests/ui-kit-overlays.test.ts`, with `installFakeDom`.

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

## Overlays and navigation

All in `ui/kit/overlays.js`. Keyboard and focus rules are built in, so a page writes none. Menus and tooltips are placed with classes only (below or above the trigger, start or end aligned); there are no computed inline positions.

### tabs

`tabs({ label, tabs: [{ id, label, build }], selected, onSelect, class })`

- `label` and at least one tab are required. Each tab needs a unique `id`, a `label` and a `build` function; `selected` must be a tab id. Otherwise it throws. The first tab is selected by default.
- A panel is built the first time its tab is selected. `onSelect(id)` runs when the selection changes.
- **Element:** `role="tablist"` with `role="tab"` buttons (`aria-selected`, `aria-controls`) and one `role="tabpanel"` per tab (`aria-labelledby`). Roving `tabindex`: only the selected tab is a tab stop.

| Key | Action |
|---|---|
| Tab | Moves into the selected tab, then to the panel |
| Right / Left | Next / previous tab; wraps at the ends |
| Home / End | First / last tab |

### menu

`menu({ label, trigger, items: [{ label, onSelect, danger, disabled }], placement, align, class })`

- `placement`: `below` (default) | `above`. `align`: `start` (default) | `end`. `label` is required and `items` must be an array.
- **Element:** a trigger button with `aria-haspopup="menu"` and `aria-expanded`, and a `role="menu"` list of `role="menuitem"` buttons. A trigger that is not a string gets `aria-label` from `label`. With no items the trigger is disabled. A disabled item has `aria-disabled="true"` and is skipped by the arrow keys.

| Key | Action |
|---|---|
| Enter, Space, Down (on the button) | Open, focus on the first enabled item |
| Up (on the button) | Open, focus on the last enabled item |
| Down / Up (in the menu) | Next / previous enabled item; wraps |
| Home / End | First / last enabled item |
| Enter, Space (on an item) | Run `onSelect`, close, focus back on the button |
| Escape | Close, focus back on the button |
| Tab | Close |

A click outside also closes it.

### tooltip

`tooltip({ text, placement, align, class }, target)`

- `placement`: `above` (default) | `below`. `align`: `start` | `end`. `text` and a DOM `target` are required.
- Returns a wrapper that holds the target and the bubble (`role="tooltip"`). The target gets `aria-describedby` (an existing value is kept).
- Shows on hover and on focus; Escape hides it.
- **Never put the only copy of needed information in a tooltip.** Touch users may not see it.

### dialog

`dialog({ title, build, busy, dismissOnBackdrop })` returns a promise, like `modal` in `ui/dom.js`.

- `build(close)` returns the content; `close(value)` closes the dialog and resolves the promise with `value`. A second `close` call does nothing. A dismissal (Escape, the Close button, a backdrop click) resolves with `undefined`.
- `busy()` returns `true` while work runs. Then Escape, the Close button and the backdrop do not close it.
- `dismissOnBackdrop` defaults to `true`.
- **Element:** mounts into `#modal-root` (in `ui/index.html`, `ui/user/index.html` and the gallery page) with `role="dialog"`, `aria-modal="true"` and `aria-labelledby` pointing at its heading.
- **Focus:** the first text field gets focus, or the box when there is none. Tab and Shift+Tab stay inside (the same `tabStops` and `trapTarget` as `modal`). On close, focus returns to the opener.
- **Stacking:** a dialog or drawer can open on top of another. Only the top layer gets keys; the layers below are `inert`. Closing the top layer returns focus to the layer below.

| Key | Action |
|---|---|
| Escape | Close (not while `busy()`) |
| Tab / Shift+Tab | Next / previous control; wraps inside the dialog |

### drawer

`drawer({ title, side, build, busy, dismissOnBackdrop })`

- The same contract and keys as `dialog`, drawn as a side panel. `side`: `end` (default) | `start`.
- `dismissOnBackdrop` defaults to `false`, so a stray click does not lose what the user typed in a form.
- On a narrow layout it takes the full width.

### toast

`toast(message, { tone, timeout })`

- `tone`: `info` (default) | `ok` | `warn` | `fail`. `timeout` in ms, default 3500; `0` keeps it until dismissed.
- `role="status"`, or `role="alert"` for `fail`. A `fail` toast always stays until dismissed. Several toasts stack.
- Makes its own container on first use, so it does not need the `#toast` element. Returns a function that dismisses the toast; every toast also has a Dismiss button.
- The old `modal` and `toast` in `ui/dom.js` are unchanged.

| Key | Action |
|---|---|
| Tab, then Enter or Space | Focus and press Dismiss |

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
