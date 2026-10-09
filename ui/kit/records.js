// Record components: evidence, timelineEntry, timeline, logView and diffView. They show what a run did and draw
// with missing data. Log and diff text is untrusted step output: it is added as text, never as HTML. Styles are in records.css.
import { h } from "../dom.js";
import { cx, oneOf, rest } from "./core.js";

const TONES = ["neutral", "ok", "fail", "run", "warn", "accent"];
const LOG_TONES = ["ok", "fail", "step", "dim"];
const blank = (s) => typeof s !== "string" || s.trim() === "";
const renderable = (children) => children.flat(Infinity).some((c) => c != null && c !== false && c !== "");
// Only web, site-relative and in-page links; never javascript: or data:.
const safeHref = (href) => typeof href === "string" && /^(https?:\/\/\S|\/(?!\/)\S*|#\S*)/i.test(href.trim());

/** A `<details>` that names its source. `href` (http(s), `/` or `#` only) adds an "Open source" link in the body. */
export function evidence({ title, source, href, open = false, class: cls, ...more } = {}, ...children) {
  rest(more);
  if (blank(title)) throw new Error("evidence needs a title");
  const named = !blank(source);
  return h("details", { ...more, open: open === true, class: cx("scf-evidence", cls) },
    h("summary", { class: "scf-evidence__summary" },
      h("span", { class: "scf-evidence__head" },
        h("span", { class: "scf-evidence__title" }, title),
        h("span", { class: "scf-evidence__source" }, named ? `Source: ${source}` : "Source not recorded"))),
    h("div", { class: "scf-evidence__body" },
      named && safeHref(href) ? h("a", { class: "scf-evidence__link", href: href.trim() }, `Open source: ${source}`) : null,
      children));
}

function dateOf(time) {
  if (time == null || time === "" || (typeof time !== "string" && typeof time !== "number" && !(time instanceof Date))) return null;
  const d = new Date(time);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** An `<li>` for a timeline. `time` (ISO text, number or Date) adds a `<time datetime>`; a missing or bad time adds none. */
export function timelineEntry({ title, time, tone = "neutral", actor, class: cls, ...more } = {}, ...children) {
  rest(more);
  oneOf("timeline tone", tone, TONES);
  if (blank(title)) throw new Error("a timeline entry needs a title");
  const when = dateOf(time);
  return h("li", { ...more, class: cx("scf-timeline__entry", `scf-timeline__entry--${tone}`, cls) },
    h("div", { class: "scf-timeline__head" },
      h("span", { class: "scf-timeline__title" }, title),
      blank(actor) ? null : h("span", { class: "scf-timeline__actor" }, actor),
      when ? h("time", { class: "scf-timeline__time", datetime: when.toISOString() }, when.toLocaleString()) : null),
    renderable(children) ? h("div", { class: "scf-timeline__body" }, children) : null);
}

/** An `<ol>` with a name. `entries` are `timelineEntry` nodes; none: one "Nothing recorded." item. */
export function timeline({ label, empty = "Nothing recorded.", class: cls, ...more } = {}, entries) {
  rest(more);
  if (blank(label)) throw new Error("a timeline needs a label");
  if (entries != null && !Array.isArray(entries)) throw new Error("timeline entries must be an array");
  const shown = (entries ?? []).filter((e) => e != null && e !== false);
  return h("ol", { ...more, role: "list", "aria-label": label, class: cx("scf-timeline", cls) },
    shown.length ? shown : h("li", { class: "scf-timeline__empty" }, empty));
}

/**
 * A scroll region with `role="log"`. `lines`: [{ text, tone? }] or strings; tones: ok, fail, step, dim. It draws every
 * line it gets. `follow` keeps the newest line in view (CSS only).
 */
export function logView({ label, lines, follow = false, empty = "No log lines.", class: cls, ...more } = {}) {
  rest(more);
  if (blank(label)) throw new Error("a log needs a label");
  if (lines != null && !Array.isArray(lines)) throw new Error("log lines must be an array");
  const items = (lines ?? []).filter((l) => l != null && l !== false).map((l) => (typeof l === "object" ? l : { text: l }));
  items.forEach((l) => l.tone != null && oneOf("log tone", l.tone, LOG_TONES));
  return h("div", { ...more, role: "log", "aria-label": label, tabindex: "0", class: cx("scf-log", follow && "scf-log--follow", cls) },
    items.length
      ? h("div", { class: "scf-log__lines" }, items.map((l) => h("div", { class: cx("scf-log__line", l.tone && `scf-log__line--${l.tone}`) }, l.text == null ? "" : String(l.text))))
      : h("p", { class: "scf-log__empty" }, empty));
}

/**
 * The kind of each line of a patch: "file", "hunk", "add", "del" or null. The counts in each `@@` header say how many
 * lines the hunk holds, so `--- a comment` inside a hunk is a removed line and a second file's headers are still headers.
 */
function diffLineKinds(lines) {
  let oldLeft = 0;
  let newLeft = 0;
  let loose = false; // a hunk header with no counts: stay in the hunk until the next "diff " line
  return lines.map((line) => {
    const inHunk = oldLeft > 0 || newLeft > 0 || loose;
    if (inHunk && !(loose && line.startsWith("diff "))) {
      if (line.startsWith("+")) { newLeft--; return "add"; }
      if (line.startsWith("-")) { oldLeft--; return "del"; }
      if (line.startsWith("\\")) return null;
      oldLeft--; newLeft--;
      return null;
    }
    loose = false;
    oldLeft = newLeft = 0;
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (m) {
      oldLeft = m[1] == null ? 1 : Number(m[1]);
      newLeft = m[2] == null ? 1 : Number(m[2]);
      return "hunk";
    }
    if (line.startsWith("@@")) { loose = true; return "hunk"; }
    if (/^(diff |index |--- |\+\+\+ |similarity |rename |new file|deleted file|old mode|new mode|Binary files)/.test(line)) return "file";
    return null;
  });
}

/** A diff from `api.diff`: `{ stat, patch, truncated }`. Lines keep their `+` and `-`; the kit draws all it gets. */
export function diffView({ stat, patch, truncated = false, none = "No changes.", label = "Diff", class: cls, ...more } = {}) {
  rest(more);
  const text = typeof patch === "string" && patch.trim() !== "" ? patch : "";
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  const kinds = diffLineKinds(lines);
  return h("div", { ...more, class: cx("scf-diff", cls) },
    blank(stat) ? null : h("pre", { class: "scf-diff__stat" }, stat),
    truncated ? h("p", { role: "status", class: "scf-diff__truncated" }, "Diff truncated (very large).") : null,
    lines.length
      ? h("pre", { role: "region", "aria-label": label, tabindex: "0", class: "scf-diff__patch" },
        lines.map((line, i) => h("span", { class: cx("scf-diff__line", kinds[i] && `scf-diff__line--${kinds[i]}`) }, `${line}\n`)))
      : h("p", { class: "scf-diff__none" }, none));
}
