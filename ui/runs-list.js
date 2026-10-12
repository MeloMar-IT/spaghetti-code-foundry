// The sections of the runs lists (admin Runs and user My runs): Needs you, Running, Queued, Failed, Completed.
// The section of a run comes from the server's record only. `renderSections` updates the list row by row, so a
// refresh keeps the focus, the scroll and the open sections. Relative imports, so a test can load them.
import { h, timeAgo } from "./dom.js";
import { nextStatus, whenParts, whereLink, whoClass } from "./next.js";
import { firstLine, workText } from "./run-header.js";
// This module and ./runs.js import each other: neither uses the other at the top level, only inside functions.
import { aheadText, money, ownerLabel, refinementMark } from "./runs.js";

export const SECTIONS = [
  { id: "needs", title: "Needs you", tone: "strong" },
  { id: "running", title: "Running", tone: "strong" },
  { id: "queued", title: "Queued", tone: "strong" },
  { id: "failed", title: "Failed", tone: "" },
  { id: "completed", title: "Completed", tone: "quiet" },
];
export const COMPLETED_SHOWN = 10;

const startedMs = (r) => Date.parse(r?.startedAt ?? "") || 0;
const when = (e) => (e.run ? startedMs(e.run) : Date.parse(e.job?.enqueuedAt ?? "") || 0);
const isYou = (e) => e.run?.next?.who === "You" || e.job?.next?.who === "You";

/**
 * What the list shows: { run, job } entries, newest first (by start, or by queue time for a job with no run of its own),
 * with the ones that need the user on top. A job whose run is listed is attached to that run.
 */
export function myRunsEntries(runs, pending) {
  const jobs = new Map((Array.isArray(pending) ? pending : []).map((p) => [p.runId, p]));
  const listed = new Set();
  const byRun = [...(Array.isArray(runs) ? runs : [])].sort((a, b) => startedMs(b) - startedMs(a)).map((run) => {
    listed.add(run.runId);
    return { run, job: jobs.get(run.runId) ?? null };
  });
  const alone = [...jobs.values()].filter((p) => !listed.has(p.runId)).map((job) => ({ run: null, job }));
  const all = [...byRun, ...alone].sort((x, y) => when(y) - when(x));
  return [...all.filter(isYou), ...all.filter((e) => !isYou(e))];
}

/** The id of the section of an entry: only `next.who`, the queue and the status of the server's record decide. */
export function sectionOf({ run, job }) {
  if ((run?.next ?? job?.next)?.who === "You") return "needs";
  if (job) return "queued";
  if (run?.status === "running" || run?.status === "waiting") return "running";
  if (run?.status === "failed") return "failed";
  return "completed";
}

/**
 * The sections with entries, in display order: [{ id, title, entries }]. `keep` filters the entries; a queued entry
 * carries `place` ({ n, of }), its position in the whole queue, whatever the filter leaves.
 */
export function runSections(runs, pending, keep = () => true) {
  const queue = Array.isArray(pending) ? pending : [];
  const at = new Map(queue.map((p, i) => [p.runId, i + 1]));
  const by = new Map(SECTIONS.map((s) => [s.id, []]));
  for (const e of myRunsEntries(runs, queue)) {
    if (!keep(e)) continue;
    const entry = e.job ? { ...e, place: { n: at.get(e.job.runId) ?? 0, of: queue.length } } : e;
    by.get(sectionOf(e)).push(entry);
  }
  by.get("queued").sort((a, b) => a.place.n - b.place.n);
  return SECTIONS.map((s) => ({ id: s.id, title: s.title, entries: by.get(s.id) })).filter((s) => s.entries.length);
}

/** When a run last did something, from the timestamps the list answer has: the newest of them. */
export function activityAt(run) {
  const times = [run?.updatedAt, run?.finishedAt, run?.startedAt, run?.waiting?.since];
  for (const a of run?.answers ?? []) times.push(a?.at);
  for (const r of run?.resumeLog ?? []) times.push(r?.at);
  for (const s of run?.history ?? []) {
    const t = Date.parse(s?.startedAt ?? "");
    if (t) times.push(new Date(t + (Number(s.durationMs) || 0)).toISOString());
  }
  let best = "";
  let bestMs = 0;
  for (const t of times) {
    const ms = Date.parse(t ?? "");
    if (ms > bestMs) { bestMs = ms; best = t; }
  }
  return best;
}

const repoOf = (run, job) => (run ? run.vars?.github_repo : job?.githubRepo);
const workOf = (run, job) => {
  const repo = repoOf(run, job);
  if (!run) return workText(repo, job?.issue);
  return !run.vars?.issue && run.vars?.pr && repo ? `${repo} PR #${run.vars.pr}` : workText(repo, run.vars?.issue);
};

const field = (label, text, cls = "") => h("div", { class: `run-field ${cls}`.trim(), "data-label": label }, text);

/** A row and its time text node. `place` (from runSections) is the position in the queue. */
function buildRow({ run, job, place }, { admin = false, onRemove = null } = {}) {
  const id = run?.runId ?? job.runId;
  const n = run?.next ?? job?.next;
  const task = firstLine(run?.task ?? job?.task);
  const work = workOf(run, job);
  const iso = run ? activityAt(run) : job?.enqueuedAt;
  const timeEl = iso ? h("span", { class: "muted run-when" }, `Updated ${timeAgo(iso)}`) : null;
  const el = h("li", { class: `run-card${n?.who === "You" ? ` ${whoClass(n)}` : ""}` },
    h("div", { class: "row" },
      n ? nextStatus(n, `help-${id}`) : null,
      job?.priority ? h("span", { class: "pill first" }, "goes first") : null,
      h("a", { class: "run-link", href: `#/runs/${encodeURIComponent(id)}`, "data-focus": `open-${id}` }, h("b", {}, run?.flow ?? job?.flow ?? "Queued run")),
      run?.refinement ?? job?.refinement ? refinementMark(run?.refinement ?? job?.refinement, `ref-${id}`) : null),
    n ? h("p", { class: "run-next muted", "data-label": "What happens next" }, n.text) : null,
    n && whenParts(n).length ? h("div", { class: "next-parts timing" }, whenParts(n)) : null,
    admin && job && n ? whereLink(n.where, `where-${id}`) : null,
    task ? h("div", { "data-label": "Task" }, task) : null,
    work ? h("div", { class: "muted mono", "data-label": "Repository" }, work) : null,
    job ? h("div", { class: "muted run-queue" }, h("span", {}, `${place?.n ?? "?"} of ${place?.of ?? "?"}${admin ? "" : " of your queued runs"}`), job.ahead > 0 ? h("span", {}, aheadText(job.ahead)) : null) : null,
    timeEl,
    admin ? field("Owner", ownerLabel(run?.ownerName ?? job?.ownerName)) : null,
    admin && run ? field("Steps", run.history?.length ?? 0, "mono") : null,
    admin && run ? field("Cost", money(run.totalCostUsd), "mono") : null,
    job && onRemove ? h("button", { type: "button", class: "small", "data-focus": `remove-${id}`, "aria-label": "Remove this run from the queue", onClick: () => onRemove(job) }, "Remove") : null);
  return { el, timeEl, iso };
}

/** One row of the list: a link to the run, its status, what happens next, and Remove for a queued run with `onRemove`. */
export const listRow = (entry, opts) => buildRow(entry, opts).el;

// ── the keyed view ──

const states = new WeakMap(); // box → what it shows

const hiddenInside = (el, box) => {
  for (let x = el; x && x !== box; x = x.parentNode) if (x.hidden) return true;
  return false;
};

function stateOf(box) {
  let st = states.get(box);
  if (!st) {
    st = { rows: new Map(), secs: new Map(), closed: new Set(), showAll: false, last: null };
    states.set(box, st);
  }
  return st;
}

function sectionView(st, box, def) {
  let v = st.secs.get(def.id);
  if (v) return v;
  const bodyId = `run-sec-${def.id}`;
  v = { def, countText: null, noteText: "", shown: 0 };
  v.toggle = h("button", { type: "button", class: "run-section-toggle", "data-focus": `sec-${def.id}`, "aria-expanded": "true", "aria-controls": bodyId, onClick: () => {
    if (st.closed.has(def.id)) st.closed.delete(def.id);
    else st.closed.add(def.id);
    v.body.hidden = st.closed.has(def.id);
    v.toggle.setAttribute("aria-expanded", String(!v.body.hidden));
  } });
  v.note = h("span", { class: "muted" });
  v.ul = h("ul", { class: "run-cards" });
  v.body = h("div", { id: bodyId }, v.ul);
  v.more = h("button", { type: "button", class: "small", "data-focus": "more-completed", onClick: () => showAll(box) }, "Show all");
  v.el = h("section", { class: `run-section${def.tone ? ` ${def.tone}` : ""}` },
    h("div", { class: "run-section-head" }, h("h2", {}, v.toggle), v.note), v.body);
  st.secs.set(def.id, v);
  return v;
}

function showAll(box) {
  const st = stateOf(box);
  const before = new Set(st.rows.keys());
  st.showAll = true;
  if (st.last) update(box, st.last.sections, st.last.opts);
  const first = [...st.rows.entries()].find(([id]) => !before.has(id));
  first?.[1].el.querySelector("a")?.focus();
}

/** Draws `sections` (from runSections) into `box`, touching only what changed. */
export function renderSections(box, sections, opts = {}) {
  const st = stateOf(box);
  st.last = { sections, opts };
  update(box, sections, opts);
}

function update(box, sections, { admin = false, onRemove = null, notes = {} } = {}) {
  const st = stateOf(box);
  const active = document.activeElement;
  const inside = Boolean(active && box.contains(active));
  const focusName = inside ? active.getAttribute?.("data-focus") : null;
  const focusRow = inside ? [...st.rows.entries()].find(([, r]) => r.el.contains(active))?.[0] : undefined;
  const focusSec = inside ? [...st.secs.values()].find((v) => v.el.contains(active))?.def.id : undefined;

  const where = new Map(); // run id → section id
  const wanted = new Set();
  const order = [];
  for (const sec of sections) {
    const v = sectionView(st, box, SECTIONS.find((s) => s.id === sec.id));
    order.push(v.el);
    const text = `${sec.title} (${sec.entries.length})`;
    if (v.countText !== text) { v.countText = text; v.toggle.textContent = text; }
    const note = notes[sec.id] ?? "";
    if (v.noteText !== note) { v.noteText = note; v.note.textContent = note; }
    v.body.hidden = st.closed.has(sec.id);
    v.toggle.setAttribute("aria-expanded", String(!v.body.hidden));
    const cut = sec.id === "completed" && !st.showAll && sec.entries.length > COMPLETED_SHOWN;
    const shown = cut ? sec.entries.slice(0, COMPLETED_SHOWN) : sec.entries;
    const els = [];
    for (const e of shown) {
      const id = e.run?.runId ?? e.job.runId;
      const key = JSON.stringify([e.run, e.job, e.place, admin]);
      let row = st.rows.get(id);
      if (!row || row.key !== key || row.hasRemove !== Boolean(onRemove)) {
        row = { ...buildRow(e, { admin, onRemove }), key, hasRemove: Boolean(onRemove) };
        st.rows.set(id, row);
      } else if (row.timeEl) {
        const t = `Updated ${timeAgo(row.iso)}`;
        if (row.timeEl.textContent !== t) row.timeEl.textContent = t;
      }
      wanted.add(id);
      where.set(id, sec.id);
      els.push(row.el);
    }
    v.shown = els.length;
    v.rowEls = els;
    v.cut = cut;
  }
  for (const [id, row] of [...st.rows]) {
    if (wanted.has(id)) continue;
    row.el.remove();
    st.rows.delete(id);
  }
  for (const sec of sections) {
    const v = st.secs.get(sec.id);
    const keep = new Set(v.rowEls);
    for (const c of [...v.ul.children]) if (!keep.has(c)) c.remove();
    v.rowEls.forEach((el, i) => { if (v.ul.children[i] !== el) v.ul.insertBefore(el, v.ul.children[i] ?? null); });
    if (v.cut && !v.more.parentNode) v.body.append(v.more);
    else if (!v.cut && v.more.parentNode) v.more.remove();
  }
  const present = new Set(order);
  for (const v of st.secs.values()) if (!present.has(v.el) && v.el.parentNode) v.el.remove();
  order.forEach((el, i) => { if (box.children[i] !== el) box.insertBefore(el, box.children[i] ?? null); });

  if (!inside) return;
  const now = document.activeElement;
  if (now === active && box.contains(active) && !hiddenInside(active, box)) return;
  const visible = (el) => !hiddenInside(el, box);
  const same = focusName ? [...box.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === focusName && visible(el)) : null;
  const toggles = [...st.secs.values()].filter((v) => present.has(v.el));
  const home = [where.get(focusRow), focusSec].map((sid) => st.secs.get(sid)).find((v) => v && present.has(v.el));
  const target = same ?? home?.toggle ?? toggles[0]?.toggle;
  if (target) return target.focus();
  // Nothing is left in the list: the page heading takes the focus, so it never drops to <body>.
  for (let el = box.parentNode; el; el = el.parentNode) {
    const heading = el.querySelector?.("h1");
    if (!heading) continue;
    heading.setAttribute("tabindex", "-1");
    return heading.focus();
  }
}
