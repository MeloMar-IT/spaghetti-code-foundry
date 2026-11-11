// The checks of a change that waits for a person: what to try and what to expect, with a mark per check
// (Works / Not quite) and a count of how many are done. The rows are built once and updated in place, so a focused
// button keeps its focus when the page gets a new update. Not quite asks what the person saw and sends the change back;
// "+ Add a check" lets the person write one of their own.
import { errorText } from "./auth.js";
import { h } from "./dom.js";

export const CHECK_WORDS = {
  title: "Checks to try", try: "Try", expect: "Expect", works: "Works", notQuite: "Not quite", open: "Not tried yet", done: (d, t) => `${d} of ${t} done`,
  saw: "What did you see?", sendBack: "Send back", cancel: "Cancel", needsSaw: "Write what you saw first.", sendFailed: "It could not be sent back. Try again.",
  add: "+ Add a check", addTry: "What to try", addExpect: "What you expect", addSave: "Add", needsBoth: "Write what to try and what to expect.",
  yours: "Your check", before: "Worked before — try it again",
};

const MARKS = ["works", "not-quite"];
const isText = (x) => typeof x === "string" && x !== "";
const PART_MAX = 300;

/** The rows of a waiting change: [{ id, try, expect, mark, rev, source, worked }]; mark is "works", "not-quite" or null. [] when there is nothing to try. */
export function personChecks(s) {
  if (s?.status !== "waiting" || !Array.isArray(s.checks) || s.checks.length === 0) return [];
  const marks = s.checkMarks && typeof s.checkMarks === "object" ? s.checkMarks : {};
  const rev = typeof s.checksRev === "string" ? s.checksRev : undefined;
  return s.checks
    .filter((c) => c && isText(c.id) && isText(c.try) && isText(c.expect))
    .map((c) => {
      const m = Object.hasOwn(marks, c.id) ? marks[c.id]?.mark : null;
      return { id: c.id, try: c.try, expect: c.expect, mark: MARKS.includes(m) ? m : null, rev, source: c.source === "person" ? "person" : "plan", worked: isText(c.worked) ? c.worked : null };
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
const oneLine = (t) => String(t ?? "").replace(/\s+/g, " ").trim();

/** The reason of the send-back, one line: the check and what the person saw (cut to 300 characters). */
export function notQuiteNote(c, said) {
  const saw = Array.from(oneLine(said));
  const sentence = saw.length > PART_MAX ? `${saw.slice(0, PART_MAX - 1).join("")}…` : saw.join("");
  return `Not quite — Try: ${oneLine(c?.try)} — Expect: ${oneLine(c?.expect)} — What I saw: ${sentence}`;
}

/**
 * The section "Checks to try". `onMark(id, mark, rev)` (mark: "works", "not-quite" or null) makes the buttons; without it the marks are only shown.
 * `onSendBack(note)` lets Not quite ask "What did you see?" and send the change back; it answers `false` when nothing was sent (or throws).
 * `onAdd(try, expect, rev)` makes "+ Add a check"; it answers `{ checks, checksRev, checkMarks }`. A waiting change shows the section for it even without checks.
 */
export function createCheckList({ onMark = null, onSendBack = null, onAdd = null } = {}) {
  const title = h("h2", {}, CHECK_WORDS.title);
  const count = h("p", { class: "muted", "aria-live": "polite" });
  const list = h("ol", { class: "flush" });
  const alert = h("p", { class: "status bad", role: "alert" });
  const addBox = h("div", { class: "run-check-add" });
  const el = h("section", { class: "card run-checks", "aria-label": CHECK_WORDS.title }, title, count, list, addBox);
  el.hidden = true;
  // The alert is in the page only while it has a text.
  const showError = (text) => {
    alert.textContent = text;
    if (text && !el.contains(alert)) el.append(alert);
    else if (!text && el.contains(alert)) alert.remove();
  };

  let rows = new Map(); // id -> { li, works, notQuite, word, busy, mark, rev, form, saw }
  let shapeKey = null;
  let current = [];
  let lastRev;
  let busy = false; // one send-back or add at a time

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
    setText(count, current.length ? CHECK_WORDS.done(done, current.length) : "");
    count.hidden = current.length === 0;
  }

  function takeMarks(r) {
    const marks = r?.checkMarks;
    if (marks && typeof marks === "object") {
      for (const [id, x] of rows) x.mark = MARKS.includes(marks[id]?.mark) ? marks[id].mark : null;
      for (const x of rows.values()) paintRow(x);
      paintCount();
    }
  }

  async function click(c, value) {
    const row = rows.get(c.id);
    if (!row || row.busy || !onMark) return;
    // Not quite on an unmarked check asks what the person saw first; on a marked one it takes the mark back.
    if (value === "not-quite" && onSendBack && row.mark !== "not-quite") {
      showError("");
      row.form.hidden = false;
      row.saw.focus?.();
      return;
    }
    row.busy = true;
    showError("");
    paintRow(row);
    try {
      takeMarks(await onMark(c.id, row.mark === value ? null : value, row.rev));
    } catch (e) {
      showError(errorText(e));
    } finally {
      row.busy = false;
      paintRow(row);
    }
  }

  async function sendBack(c) {
    const row = rows.get(c.id);
    if (!row || busy || !onSendBack || !onMark) return;
    const said = oneLine(row.saw.value);
    if (!said) {
      showError(CHECK_WORDS.needsSaw);
      return;
    }
    busy = true;
    showError("");
    try {
      // The mark first (once: a retry after a failed send-back finds it already set), then the change goes back.
      if (row.mark !== "not-quite") takeMarks(await onMark(c.id, "not-quite", row.rev));
      const sent = await onSendBack(notQuiteNote(c, said));
      if (sent === false) throw new Error(CHECK_WORDS.sendFailed);
      row.saw.value = "";
      row.form.hidden = true;
    } catch (e) {
      showError(errorText(e));
    } finally {
      busy = false;
    }
  }

  function build(c) {
    const row = { li: null, works: null, notQuite: null, word: null, busy: false, mark: c.mark, rev: c.rev, form: null, saw: null };
    const parts = [
      h("p", {}, h("b", {}, CHECK_WORDS.try), `: ${c.try}`),
      h("p", {}, h("b", {}, CHECK_WORDS.expect), `: ${c.expect}`),
    ];
    if (c.source === "person") parts.push(h("p", { class: "muted" }, CHECK_WORDS.yours));
    if (c.worked) parts.push(h("p", { class: "muted" }, CHECK_WORDS.before));
    if (onMark) {
      row.works = h("button", { type: "button", class: "small", "data-focus": `check-works-${c.id}`, onClick: () => click(c, "works") }, CHECK_WORDS.works);
      row.notQuite = h("button", { type: "button", class: "small", "data-focus": `check-not-quite-${c.id}`, onClick: () => click(c, "not-quite") }, CHECK_WORDS.notQuite);
      parts.push(h("div", { class: "row" }, row.works, row.notQuite));
      if (onSendBack) {
        row.saw = h("input", { type: "text", "data-focus": `check-saw-${c.id}`, "aria-label": CHECK_WORDS.saw });
        row.form = h("div", { class: "run-check-saw", "data-part": `check-saw-${c.id}` },
          h("label", {}, CHECK_WORDS.saw, " ", row.saw),
          h("div", { class: "row" },
            h("button", { type: "button", class: "small", "data-focus": `check-send-back-${c.id}`, onClick: () => sendBack(c) }, CHECK_WORDS.sendBack),
            h("button", { type: "button", class: "small", "data-focus": `check-cancel-${c.id}`, onClick: () => { showError(""); row.form.hidden = true; } }, CHECK_WORDS.cancel)));
        row.form.hidden = true;
        parts.push(row.form);
      }
    } else {
      row.word = h("p", { class: "muted" });
      parts.push(row.word);
    }
    row.li = h("li", { "data-check": c.id }, ...parts);
    paintRow(row);
    return row;
  }

  // "+ Add a check": two lines (what to try, what you expect), kept for the next round.
  const addTry = h("input", { type: "text", maxlength: PART_MAX, "data-focus": "check-add-try", "aria-label": CHECK_WORDS.addTry });
  const addExpect = h("input", { type: "text", maxlength: PART_MAX, "data-focus": "check-add-expect", "aria-label": CHECK_WORDS.addExpect });
  const addForm = h("div", { class: "run-check-add-form", "data-part": "check-add" },
    h("label", {}, CHECK_WORDS.addTry, " ", addTry),
    h("label", {}, CHECK_WORDS.addExpect, " ", addExpect),
    h("div", { class: "row" },
      h("button", { type: "button", class: "small", "data-focus": "check-add-save", onClick: () => add() }, CHECK_WORDS.addSave),
      h("button", { type: "button", class: "small", "data-focus": "check-add-cancel", onClick: () => { showError(""); addForm.hidden = true; addOpen.hidden = false; } }, CHECK_WORDS.cancel)));
  const addOpen = h("button", { type: "button", class: "small", "data-focus": "check-add", onClick: () => { showError(""); addForm.hidden = false; addOpen.hidden = true; addTry.focus?.(); } }, CHECK_WORDS.add);
  addForm.hidden = true;
  addBox.hidden = true;
  if (onAdd) addBox.append(addOpen, addForm);

  async function add() {
    if (busy || !onAdd) return;
    const t = oneLine(addTry.value);
    const e = oneLine(addExpect.value);
    if (!t || !e) {
      showError(CHECK_WORDS.needsBoth);
      return;
    }
    busy = true;
    showError("");
    try {
      const r = await onAdd(t, e, lastRev);
      addTry.value = "";
      addExpect.value = "";
      addForm.hidden = true;
      addOpen.hidden = false;
      if (r && Array.isArray(r.checks)) update({ status: "waiting", checks: r.checks, checksRev: r.checksRev, checkMarks: r.checkMarks });
    } catch (err) {
      showError(errorText(err));
    } finally {
      busy = false;
    }
  }

  function update(s) {
    current = personChecks(s);
    lastRev = typeof s?.checksRev === "string" ? s.checksRev : undefined;
    const canAdd = !!onAdd && s?.status === "waiting";
    addBox.hidden = !canAdd;
    if (current.length === 0 && !canAdd) {
      el.hidden = true;
      return;
    }
    const key = JSON.stringify(current.map((c) => [c.id, c.try, c.expect, c.source, c.worked]));
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
