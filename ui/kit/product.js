// Product components: pageHeader, statusSummary, nextAction, filters, entityLink and confirmDestructive.
// Built only from the kit primitives. Styles are in product.css.
import { h } from "../dom.js";
import { button, link } from "./actions.js";
import { cx, nextId, oneOf, rest } from "./core.js";
import { badge, banner, card } from "./display.js";
import { checkbox, field, select, textInput } from "./forms.js";
import { dialog } from "./overlays.js";

const TONES = ["neutral", "ok", "fail", "run", "warn", "accent"];
const blank = (s) => typeof s !== "string" || s.trim() === "";
const NEW_TAB = " (opens a new tab)";

/**
 * { href, external } for a link we are willing to draw: http(s):// (external) or a path, "?query" or "#hash" without a
 * scheme. Anything else (javascript:, data:, "//host", control characters) gives undefined and is shown as text.
 */
function target(href) {
  if (typeof href !== "string") return undefined;
  const v = href.trim();
  if (v === "" || /[\u0000-\u001f\\]/.test(v) || v.startsWith("//")) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!scheme) return { href: v, external: false };
  return /^https?:\/\//i.test(v) ? { href: v, external: true } : undefined;
}

/** The same check for the `where` of a server record (the NextStep shape { label, url }): http(s):// or "#/…" only. */
function recordTarget(url) {
  if (typeof url !== "string") return undefined;
  if (/^https?:\/\//i.test(url)) return { href: url, external: true };
  if (url.startsWith("#/")) return { href: url, external: false };
  return undefined;
}

const hiddenNote = () => h("span", { class: "scf-visually-hidden" }, NEW_TAB);
const errorText = (e) => (e instanceof TypeError ? "Could not reach the server." : e?.message || "Something went wrong.");

// ---- pageHeader ----

/** `pageHeader({ title, back: { label, href }, meta, actions })`: a `<header>` with the page's one `<h1>`. */
export function pageHeader({ title, back, meta, actions, class: cls, ...more } = {}) {
  rest(more);
  if (blank(title)) throw new Error("a page header needs a title");
  let backLink = null;
  if (back != null) {
    if (blank(back.label)) throw new Error("a back link needs a label");
    const t = target(back.href);
    if (!t) throw new Error("a back link needs a safe href");
    backLink = link({ href: t.href, external: t.external, class: "scf-page-header__back" }, back.label, t.external ? hiddenNote() : null);
  }
  return h("header", { ...more, class: cx("scf-page-header", cls) },
    backLink,
    h("div", { class: "scf-page-header__main" },
      h("h1", { class: "scf-page-header__title" }, title),
      meta ? h("div", { class: "scf-page-header__meta" }, meta) : null),
    actions ? h("div", { class: "scf-page-header__actions" }, actions) : null);
}

// ---- statusSummary ----

/** `statusSummary({ items: [{ label, value, tone, href }], label })`: a `<dl>`. A `tone` draws the value as a badge; an `href` makes it a link. */
export function statusSummary({ items, label, class: cls, ...more } = {}) {
  rest(more);
  if (!Array.isArray(items)) throw new Error("a status summary needs an items array");
  const rows = items.map((item) => {
    if (blank(item?.label)) throw new Error("a status item needs a label");
    const v = item.value;
    const isNode = v != null && typeof v === "object";
    if (v == null || v === "" || v === false || (typeof v === "string" && v.trim() === "")) throw new Error("a status item needs a value");
    if (item.tone != null) {
      oneOf("status tone", item.tone, TONES);
      if (isNode) throw new Error("a status item with a tone needs a text or number value");
    }
    const shown = item.tone != null ? badge({ tone: item.tone, label: String(v) }) : isNode ? v : String(v);
    const t = target(item.href);
    return h("div", { class: "scf-status-summary__item" },
      h("dt", { class: "scf-status-summary__label" }, item.label),
      h("dd", { class: "scf-status-summary__value" }, t ? link({ href: t.href, external: t.external }, shown, t.external ? hiddenNote() : null) : shown));
  });
  return h("dl", { ...more, "aria-label": blank(label) ? undefined : label, class: cx("scf-status-summary", cls) }, rows);
}

// ---- nextAction ----

/**
 * `nextAction({ who, text, where: { label, url }, action: { label, onClick }, tone, heading, level })`. Shows a server
 * record as given: who must act, what, and where. At most one primary button. It works out nothing itself.
 */
export function nextAction({ who, text, where, action, tone = "neutral", heading = "What happens next", level = 2, class: cls, ...more } = {}) {
  rest(more);
  if (blank(who)) throw new Error("a next action needs who");
  if (blank(text)) throw new Error("a next action needs text");
  oneOf("next action tone", tone, TONES);
  if (action != null && (blank(action.label) || typeof action.onClick !== "function")) throw new Error("an action needs a label and an onClick");
  let whereNode = null;
  if (where != null && !blank(where.label)) {
    const t = recordTarget(where.url);
    whereNode = h("p", { class: "scf-next-action__where" }, "Where: ",
      t ? link({ href: t.href, external: t.external }, where.label, t.external ? hiddenNote() : null) : where.label);
  }
  return card({ ...more, title: heading, level, tone, class: cx("scf-next-action", cls) },
    badge({ tone, label: who }),
    h("p", { class: "scf-next-action__text" }, text),
    whereNode,
    action ? h("div", { class: "scf-next-action__action" }, button({ variant: "primary", onClick: action.onClick }, action.label)) : null);
}

// ---- filters ----

const FILTER_TYPES = ["text", "select", "checkbox"];
const emptyOf = (type) => (type === "checkbox" ? false : "");

/**
 * `filters({ label, fields: [{ name, label, type, options, placeholder, emptyLabel, error }], value, onChange, onClear })`.
 * A search form. It keeps its own values; `onChange(values, name)` reports each change. Clear shows only when a filter is set.
 */
export function filters({ label, fields, value = {}, onChange, onClear, clearLabel = "Clear", class: cls, ...more } = {}) {
  rest(more);
  if (blank(label)) throw new Error("filters need a label");
  if (!Array.isArray(fields) || fields.length === 0) throw new Error("filters need a fields array");
  if (typeof onChange !== "function") throw new Error("filters need an onChange function");
  if (onClear != null && typeof onClear !== "function") throw new Error("onClear must be a function");
  if (blank(clearLabel)) throw new Error("filters need a clear label");
  const names = new Set();
  for (const f of fields) {
    if (blank(f?.name) || blank(f?.label)) throw new Error("a filter field needs a name and a label");
    if (names.has(f.name)) throw new Error(`duplicate filter field "${f.name}"`);
    names.add(f.name);
    oneOf("filter type", f.type ?? "text", FILTER_TYPES);
  }
  const state = {};
  for (const f of fields) {
    const v = value?.[f.name];
    state[f.name] = f.type === "checkbox" ? v === true : typeof v === "string" ? v : emptyOf(f.type);
  }
  const isSet = () => fields.some((f) => (f.type === "checkbox" ? state[f.name] === true : String(state[f.name]).trim() !== ""));
  const clearBtn = button({ variant: "ghost", class: "scf-filters__clear", onClick: () => clear() }, clearLabel);
  const controls = {};
  const sync = () => { clearBtn.hidden = !isSet(); };
  const changed = (name) => { onChange({ ...state }, name); sync(); };

  const nodes = fields.map((f) => {
    const type = f.type ?? "text";
    const cls = "scf-filters__field";
    if (type === "checkbox") {
      const box = checkbox({ label: f.label, checked: state[f.name], onChange: () => { state[f.name] = input.checked === true; changed(f.name); } });
      const input = box.querySelector("input");
      controls[f.name] = input;
      if (blank(f.error)) return h("div", { class: cls }, box);
      const errorId = nextId("scf-filter-error");
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorId);
      return h("div", { class: cls }, box, h("div", { class: "scf-field__error", role: "alert", id: errorId }, f.error));
    }
    let control;
    if (type === "select") {
      control = select({ options: f.options ?? [], emptyLabel: f.emptyLabel ?? "Any", value: state[f.name], onChange: () => { state[f.name] = control.value; changed(f.name); } });
      control.value = state[f.name];
    } else {
      control = textInput({ type: "search", value: state[f.name], placeholder: f.placeholder, onInput: () => { state[f.name] = control.value; changed(f.name); } });
    }
    controls[f.name] = control;
    return field({ label: f.label, error: blank(f.error) ? undefined : f.error, class: cls }, control);
  });

  function clear() {
    for (const f of fields) {
      state[f.name] = emptyOf(f.type);
      const c = controls[f.name];
      if (f.type === "checkbox") c.checked = false; else c.value = "";
    }
    sync();
    controls[fields[0].name].focus();
    if (onClear) onClear(); else onChange({ ...state });
  }
  sync();
  return h("form", { ...more, role: "search", "aria-label": label, class: cx("scf-filters", cls), onSubmit: (e) => e?.preventDefault?.() },
    h("div", { class: "scf-filters__fields" }, nodes), clearBtn);
}

// ---- entityLink ----

const KINDS = { run: "Run", repo: "Repository", issue: "Issue", pr: "Pull request", flow: "Flow", user: "User" };

/**
 * `entityLink({ kind, id, label, href, showKind })`: a link to a run, repository, issue, pull request, flow or user. The
 * kind is read out (or shown with `showKind`). Without `href` (or with an unsafe one) it is plain text: a caller leaves the
 * `href` out for something the user may not open. It checks no permission.
 */
export function entityLink({ kind, id, label, href, showKind = false, class: cls, ...more } = {}) {
  rest(more);
  oneOf("entity kind", kind, Object.keys(KINDS));
  const hasId = !blank(id) || (typeof id === "number" && Number.isFinite(id));
  if (!hasId && blank(label)) throw new Error("an entity link needs an id or a label");
  const kindNode = h("span", { class: showKind ? "scf-entity-link__kind" : "scf-visually-hidden" }, KINDS[kind]);
  const parts = [kindNode, " ", hasId ? h("span", { class: "scf-entity-link__id" }, String(id)) : null, hasId && !blank(label) ? " " : null, blank(label) ? null : label];
  const t = target(href);
  if (!t) return h("span", { ...more, class: cx("scf-entity-link", "scf-entity-link--plain", cls) }, parts);
  return link({ ...more, href: t.href, external: t.external, class: cx("scf-entity-link", cls) }, parts, t.external ? hiddenNote() : null);
}

// ---- confirmDestructive ----

/**
 * `confirmDestructive({ title, text, confirmLabel, cancelLabel, typeToConfirm, send })`: resolves true only after `send()`
 * succeeded. Focus starts on Cancel. A failed `send` shows its error and the dialog stays open; nothing closes it while the call is out.
 */
export function confirmDestructive({ title, text, confirmLabel = "Delete", cancelLabel = "Cancel", typeToConfirm, send, ...more } = {}) {
  rest(more);
  if (blank(title)) throw new Error("a confirmation needs a title");
  if (typeof send !== "function") throw new Error("a confirmation needs a send function");
  if (blank(confirmLabel) || blank(cancelLabel)) throw new Error("a confirmation needs button labels");
  if (typeToConfirm !== undefined && blank(typeToConfirm)) throw new Error("typeToConfirm must be a non-empty text");
  let busy = false;
  let cancelBtn;
  return dialog({
    title,
    busy: () => busy,
    initialFocus: () => cancelBtn,
    build(close) {
      const errorSlot = h("div", { class: "scf-confirm__error" });
      const input = typeToConfirm === undefined ? null : textInput({ autocomplete: "off", onInput: () => sync() });
      const matches = () => !input || input.value === typeToConfirm;
      cancelBtn = button({ onClick: () => { if (!busy) close(false); } }, cancelLabel);
      const confirmBtn = button({ variant: "danger", type: "submit" }, confirmLabel);
      const sync = () => { confirmBtn.disabled = !matches(); };
      const setBusy = (on) => {
        busy = on;
        for (const b of [cancelBtn, confirmBtn]) { if (on) b.setAttribute("aria-disabled", "true"); else b.removeAttribute("aria-disabled"); }
        if (on) confirmBtn.setAttribute("aria-busy", "true"); else confirmBtn.removeAttribute("aria-busy");
      };
      const submit = async (e) => {
        e?.preventDefault?.();
        if (busy || !matches()) return;
        setBusy(true);
        errorSlot.replaceChildren();
        try {
          await send();
          setBusy(false);
          close(true);
        } catch (ex) {
          setBusy(false);
          errorSlot.replaceChildren(banner({ tone: "fail" }, errorText(ex)));
        }
      };
      sync();
      return h("form", { class: "scf-confirm", onSubmit: submit },
        blank(text) ? null : h("p", { class: "scf-confirm__text" }, text),
        input ? field({ label: `Type "${typeToConfirm}" to confirm` }, input) : null,
        errorSlot,
        h("div", { class: "scf-confirm__actions" }, cancelBtn, confirmBtn));
    },
  }).then((answer) => answer === true);
}
