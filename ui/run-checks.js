// The checks of a change that waits for a person: what to try and what to expect, with a mark per check
// (Works / Not quite) and a count of how many are done. The rows are built once and updated in place, so a focused
// button keeps its focus when the page gets a new update.
import { errorText } from "./auth.js";
import { h } from "./dom.js";

export const CHECK_WORDS = { title: "Checks to try", try: "Try", expect: "Expect", works: "Works", notQuite: "Not quite", open: "Not tried yet", done: (d, t) => `${d} of ${t} done` };

const MARKS = ["works", "not-quite"];
const isText = (x) => typeof x === "string" && x !== "";

/** The rows of a waiting change: [{ id, try, expect, mark, rev }]; mark is "works", "not-quite" or null. [] when there is nothing to try. */
export function personChecks(s) {
  if (s?.status !== "waiting" || !Array.isArray(s.checks) || s.checks.length === 0) return [];
  const marks = s.checkMarks && typeof s.checkMarks === "object" ? s.checkMarks : {};
  const rev = typeof s.checksRev === "string" ? s.checksRev : undefined;
  return s.checks
    .filter((c) => c && isText(c.id) && isText(c.try) && isText(c.expect))
    .map((c) => {
      const m = Object.hasOwn(marks, c.id) ? marks[c.id]?.mark : null;
      return { id: c.id, try: c.try, expect: c.expect, mark: MARKS.includes(m) ? m : null, rev };
    });
}

/** How many checks are not marked yet. */
export const openChecks = (s) => personChecks(s).filter((c) => c.mark === null).length;

/** "Approve", or "Approve — 2 checks not marked yet". The button is never blocked. */
export function approveLabel(s, base = "Approve") {
  const n = openChecks(s);
  return n === 0 ? base : `${base} — ${n} ${n === 1 ? "check" : "checks"} not marked yet`;
}

const markWord = (mark) => (mark === "works" ? CHECK_WORDS.works : mark === "not-quite" ? CHECK_WORDS.notQuite : CHECK_WORDS.open);

/** The section "Checks to try". `onMark(id, mark, rev)` (mark: "works", "not-quite" or null) makes the buttons; without it the marks are only shown. */
export function createCheckList({ onMark = null } = {}) {
  const title = h("h2", {}, CHECK_WORDS.title);
  const count = h("p", { class: "muted", "aria-live": "polite" });
  const list = h("ol", { class: "flush" });
  const alert = h("p", { class: "status bad", role: "alert" });
  const el = h("section", { class: "card run-checks", "aria-label": CHECK_WORDS.title }, title, count, list);
  el.hidden = true;
  // The alert is in the page only while it has a text.
  const showError = (text) => {
    alert.textContent = text;
    if (text && !el.contains(alert)) el.append(alert);
    else if (!text && el.contains(alert)) alert.remove();
  };

  let rows = new Map(); // id -> { li, works, notQuite, word, busy, mark, rev }
  let shapeKey = null;
  let current = [];

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  const setAttr = (node, name, value) => { if (node.getAttribute(name) !== value) { if (value === null) node.removeAttribute(name); else node.setAttribute(name, value); } };

  function paintRow(row) {
    if (row.works) {
      for (const [btn, value, word] of [[row.works, "works", CHECK_WORDS.works], [row.notQuite, "not-quite", CHECK_WORDS.notQuite]]) {
        const pressed = row.mark === value;
        setText(btn, pressed ? `✓ ${word}` : word);
        setAttr(btn, "aria-pressed", pressed ? "true" : "false");
        setAttr(btn, "aria-disabled", row.busy ? "true" : null);
      }
    } else if (row.word) {
      setText(row.word, markWord(row.mark));
    }
  }

  function paintCount() {
    const done = current.filter((c) => rows.get(c.id)?.mark).length;
    setText(count, CHECK_WORDS.done(done, current.length));
  }

  async function click(c, value) {
    const row = rows.get(c.id);
    if (!row || row.busy || !onMark) return;
    row.busy = true;
    showError("");
    paintRow(row);
    try {
      const r = await onMark(c.id, row.mark === value ? null : value, row.rev);
      const marks = r?.checkMarks;
      if (marks && typeof marks === "object") {
        for (const [id, x] of rows) x.mark = MARKS.includes(marks[id]?.mark) ? marks[id].mark : null;
        for (const x of rows.values()) paintRow(x);
        paintCount();
      }
    } catch (e) {
      showError(errorText(e));
    } finally {
      row.busy = false;
      paintRow(row);
    }
  }

  function build(c) {
    const row = { li: null, works: null, notQuite: null, word: null, busy: false, mark: c.mark, rev: c.rev };
    const parts = [
      h("p", {}, h("b", {}, CHECK_WORDS.try), `: ${c.try}`),
      h("p", {}, h("b", {}, CHECK_WORDS.expect), `: ${c.expect}`),
    ];
    if (onMark) {
      row.works = h("button", { type: "button", class: "small", "data-focus": `check-works-${c.id}`, onClick: () => click(c, "works") }, CHECK_WORDS.works);
      row.notQuite = h("button", { type: "button", class: "small", "data-focus": `check-not-quite-${c.id}`, onClick: () => click(c, "not-quite") }, CHECK_WORDS.notQuite);
      parts.push(h("div", { class: "row" }, row.works, row.notQuite));
    } else {
      row.word = h("p", { class: "muted" });
      parts.push(row.word);
    }
    row.li = h("li", { "data-check": c.id }, ...parts);
    paintRow(row);
    return row;
  }

  function update(s) {
    current = personChecks(s);
    if (current.length === 0) {
      el.hidden = true;
      return;
    }
    const key = JSON.stringify(current.map((c) => [c.id, c.try, c.expect]));
    if (key !== shapeKey) {
      shapeKey = key;
      rows = new Map(current.map((c) => [c.id, build(c)]));
      list.replaceChildren(...[...rows.values()].map((r) => r.li));
      showError("");
    }
    for (const c of current) {
      const row = rows.get(c.id);
      row.mark = c.mark;
      row.rev = c.rev;
      paintRow(row);
    }
    paintCount();
    el.hidden = false;
  }

  return { el, update };
}
