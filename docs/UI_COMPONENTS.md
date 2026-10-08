# UI components (the kit)

The kit is a small set of plain JavaScript modules in `ui/kit/` that build common controls with `h` from `ui/dom.js`. Pages use the kit instead of repeating markup and inline styles. This is part 1: actions and form controls. No page uses the kit yet.

## Conventions

- **Modules.** `ui/kit/actions.js` (button, iconButton, link), `ui/kit/forms.js` (field, textInput, textArea, select, checkbox). `ui/kit/core.js` has small shared helpers and is not part of the public kit.
- **Plain functions.** Each component is a function that returns a DOM element. Props are one object; children follow it (`button(props, ...children)`). `class` is added to the kit classes. Other props (for example `id`, `name`, `aria-*`, `data-*`) go to the element.
- **No inline styles.** Kit modules never pass `style` to `h()`. A component throws if the caller passes `style`. Use a class.
- **CSS.** `ui/kit/kit.css` imports `actions.css` and `forms.css`, and is linked from `ui/index.html` and `ui/user/index.html`. Kit CSS uses only `scf-` class selectors (`.scf-btn`, `.scf-btn--primary`, `.scf-field__label`) and token variables from the theme and density tokens. No id selectors, no bare tag selectors, no colour literals. `tests/ui-css.test.ts` reads the files and fails on these.
- **Names.** Block `scf-name`, part `scf-name__part`, variant or state `scf-name--variant`.
- **Global rules.** The global `button` rules in `ui/style.css` stay. Kit classes are written to look right on top of them.
- **Unbound.** Controls take `value` and `onInput`/`onChange` and keep no state. They are not the bound inputs in `ui/fields.js`, which are unchanged.
- **Errors.** A missing required prop (a label, an `href`, `options`) or an unknown variant or size throws an `Error` at once.
- **Tests.** `tests/ui-kit-actions.test.ts` and `tests/ui-kit-forms.test.ts`, with `installFakeDom`.

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
