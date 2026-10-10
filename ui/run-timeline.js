import { api } from "./api.js";
import { glyph, h, mount } from "./dom.js";
import { transcriptView } from "./run-output.js";
import { loadInto } from "./run-states.js";
import { noStepsText, secs, timeText } from "./run-tabs.js";
import { STEP_TYPES } from "./step-types.js";

const cost = (n) => (n ? `$${n.toFixed(4)}` : "—");

/** The step that explains a failed run: the last failed one that is not a sub-flow or parallel step (else the last failed one). -1 if none. */
export function failedStepIndex(s) {
  const h2 = s.history ?? [];
  let last = -1;
  for (let i = h2.length - 1; i >= 0; i--) {
    if (h2[i].ok) continue;
    if (last < 0) last = i;
    if (h2[i].type !== "flow" && h2[i].type !== "parallel") return i;
  }
  return last;
}

/** A plain label for a step: what it does when the flow says so, else "<id> — <kind of step>". Never the id alone. */
export function stepLabel(s, id, type) {
  const step = s?.flowDef?.steps?.find((st) => st.id === id);
  if (step?.description) return step.description;
  const t = type ?? step?.type;
  const kind = t === "agent" || t === "claude" ? "Agent" : STEP_TYPES[t]?.label ?? t ?? "step";
  return `${id} — ${kind}`;
}

const END = { succeeded: "Run finished", failed: "Run failed", stopped: "Run stopped", cancelled: "Run cancelled" };

/** Sort time of an entry: its own, else that of the entry before it in natural order. */
function ordered(s) {
  const items = [];
  let last = 0;
  const add = (kind, i, at, extra) => {
    const t = Date.parse(at ?? "");
    const eff = Number.isNaN(t) ? last : t;
    last = eff;
    items.push({ kind, i, eff, ...extra });
  };
  (s.history ?? []).forEach((rec, i) => add("step", i, rec.startedAt, {}));
  (Array.isArray(s.answers) ? s.answers : []).forEach((a, j) => add("answer", j, a?.at, {}));
  items.forEach((it, n) => { it.n = n; });
  items.sort((x, y) => x.eff - y.eff || x.n - y.n);
  // A sub-flow is recorded after its steps but starts before them: on equal times its occurrence goes above its children.
  const hist = s.history ?? [];
  const byId = new Map();
  hist.forEach((rec, i) => { if (!byId.has(rec.id)) byId.set(rec.id, []); byId.get(rec.id).push(i); });
  for (let p = 0; p < items.length; p++) {
    const it = items[p];
    if (it.kind !== "step" || !hist[it.i].parent) continue;
    // The engine records the full path as the id ("a/b/c") and the parent's full id as `parent` ("a/b").
    const j = (byId.get(String(hist[it.i].parent)) ?? []).find((k) => k > it.i);
    if (j === undefined) continue;
    const at = items.findIndex((x) => x.kind === "step" && x.i === j);
    if (at > p && items[at].eff === it.eff) {
      items.splice(p, 0, items.splice(at, 1)[0]);
      p--; // the moved parent may itself have a parent to move above
    }
  }
  return items;
}

/** The milestones of a run in time order. Pure. `key` is `step:<index>` for a history entry, so a second visit is its own entry. */
export function milestones(s) {
  if (!s) return [];
  const out = [{ key: "start", kind: "start", at: s.startedAt, label: "Run started", depth: 0 }];
  const hist = s.history ?? [];
  const answers = Array.isArray(s.answers) ? s.answers : [];
  for (const it of ordered(s)) {
    if (it.kind === "step") {
      const rec = hist[it.i];
      out.push({ key: `step:${it.i}`, kind: "step", at: rec.startedAt, label: stepLabel(s, rec.id, rec.type), ok: !!rec.ok, index: it.i, depth: rec.parent ? String(rec.parent).split("/").length : 0 });
    } else {
      const a = answers[it.i];
      out.push({ key: `answer:${it.i}`, kind: "answer", at: a?.at, label: "Answer given", text: String(a?.text ?? ""), depth: 0 });
    }
  }
  if (s.status === "waiting" && s.waiting) out.push({ key: "waiting", kind: "waiting", at: s.waiting.since, label: "Waiting for approval", text: String(s.waiting.message ?? ""), depth: 0 });
  if (s.status === "running" && s.state?.next) out.push({ key: "current", kind: "current", at: s.stepStartedAt, label: `Running ${stepLabel(s, s.state.next)}`, depth: 0 });
  if (s.status !== "running" && s.status !== "waiting") {
    out.push({ key: "end", kind: "end", at: s.finishedAt, label: END[s.status] ?? `Run ended (${s.status})`, ok: s.status === "succeeded", depth: 0 });
  }
  return out;
}

/** The mark of a finished step: the glyph for the eye, a word for screen readers. */
const stepMark = (ok) => h("span", { class: `pill ${ok ? "ok" : "fail"}` }, glyph(ok ? "✔" : "✘"), h("span", { class: "sr-only" }, ok ? "Succeeded" : "Failed"));

function entry(runId, s, i, { label, depth = 0, admin = true, a = api } = {}) {
  const name = label ?? stepLabel(null, s.id, s.type);
  const cls = `tl${depth > 0 ? ` depth-${Math.min(depth, 3)}` : ""}`;
  const title = [h("b", { class: "tl-label" }, name), name.startsWith(s.id) ? null : h("span", { class: "mono muted" }, s.id)];
  const visit = s.visit > 1 ? h("span", { class: "pill" }, `visit ${s.visit}`) : null;
  // A user's view has no output: a plain row that cannot be opened and never asks for a transcript.
  if (!admin || !("output" in s)) {
    return { el: h("div", { class: cls },
      h("div", { class: "row" }, stepMark(s.ok), title, visit, h("span", { class: "spacer" }), h("span", { class: "muted mono" }, secs(s.durationMs))),
      s.error ? h("p", { class: "muted mt-4 mb-4 mx-12" }, s.error) : null) };
  }
  const body = h("div");
  let loaded = false;
  // The error and the output are built when the entry is first opened, not before.
  const load = async () => {
    if (loaded) return;
    loaded = true;
    const out = h("div");
    mount(body, [s.error ? h("pre", { class: "mono" }, h("b", {}, "Details"), "\n", s.error) : null, out]);
    if (s.type !== "claude") return mount(out, h("pre", {}, s.output || "(no output)"));
    await loadInto(out, { loading: h("p", { class: "muted px-12" }, "Loading transcript…"), load: () => a.transcript(runId, i), draw: (t) => transcriptView(t.events), what: "Could not load the transcript.", focus: `step-${i}-retry` });
  };
  const el = h("details", { class: cls, onToggle: (e) => { if (e.target.open) load(); } },
    h("summary", { "data-focus": `step-${i}` },
      stepMark(s.ok), title, visit,
      h("span", { class: "muted" }, s.agent ? s.agent : s.type),
      h("span", { class: "spacer" }),
      h("span", { class: "muted mono" }, secs(s.durationMs)),
      s.costUsd ? h("span", { class: "muted mono" }, cost(s.costUsd)) : s.tokens ? h("span", { class: "muted mono", title: "no per-token cost (local model or subscription)" }, `${Math.round((s.tokens.input + s.tokens.output) / 1000)}k tok`) : null),
    body);
  return { el, open: () => { el.setAttribute("open", ""); return load(); } };
}

/** One finished step: summary line, and when opened the raw error under "Details" and the output or transcript. `open`: shown opened. */
export function stepEntry(runId, s, i, { open = false, label, depth = 0, admin = true, a = api } = {}) {
  const e = entry(runId, s, i, { label, depth, admin, a });
  if (open) e.open?.();
  return e.el;
}

function markRow(m) {
  const time = timeText(m.at);
  return h("div", { class: "tl tl-mark" },
    h("div", { class: "row" }, m.kind === "end" ? stepMark(m.ok) : null, h("b", {}, m.label), h("span", { class: "spacer" }), time ? h("span", { class: "muted" }, time) : null),
    m.text ? h("p", { class: "muted mt-4 mb-4 mx-12 pre-wrap" }, m.text) : null);
}

const sigOf = (m, rec) => JSON.stringify([m.kind, m.label, m.text, m.at, m.ok, m.depth, rec?.id, rec?.visit, rec?.durationMs]);

/**
 * The Steps tab: a keyed timeline of the milestones of a run. `update(s)` keeps every node whose key and signature are
 * unchanged, so open entries, loaded transcripts, scroll and focus stay. `open(index)` opens a step and scrolls to it.
 * `admin: false` always draws plain rows.
 */
export function createTimeline({ runId, admin = false, a = api } = {}) {
  const emptyNote = h("p", { class: "muted" });
  const list = h("div", { class: "timeline" });
  const el = h("div", {}, emptyNote, list);
  const entries = new Map(); // key -> { el, sig, open? }
  let lastSigs = "";
  let failedShown = null;
  let pending = null;

  const openEntry = (index, scroll) => {
    const e = entries.get(`step:${index}`);
    if (!e) { pending = index; return; }
    pending = null;
    e.open?.();
    if (scroll) e.el.scrollIntoView?.({ block: "nearest" });
  };

  function update(s) {
    const hist = s?.history ?? [];
    const text = noStepsText(s);
    if (emptyNote.textContent !== text) emptyNote.textContent = text;
    if (emptyNote.hidden !== hist.length > 0) emptyNote.hidden = hist.length > 0;
    const want = milestones(s).map((m) => {
      const rec = m.index !== undefined ? hist[m.index] : null;
      return { m, rec, sig: sigOf(m, rec) };
    });
    const sigs = want.map((w) => `${w.m.key}${w.sig}`).join("\n");
    if (sigs !== lastSigs) {
      lastSigs = sigs;
      const nodes = want.map(({ m, rec, sig }) => {
        const old = entries.get(m.key);
        if (old && old.sig === sig) return old.el;
        const made = rec ? entry(runId, rec, m.index, { label: m.label, depth: m.depth, admin, a }) : { el: markRow(m) };
        entries.set(m.key, { el: made.el, sig, open: made.open });
        return made.el;
      });
      const keys = new Set(want.map((w) => w.m.key));
      for (const k of [...entries.keys()]) if (!keys.has(k)) entries.delete(k);
      for (const c of [...list.children]) if (!nodes.includes(c)) c.remove();
      nodes.forEach((n, i) => { if (list.children[i] !== n) list.insertBefore(n, list.children[i] ?? null); });
    }
    if (s?.status === "failed") {
      const idx = failedStepIndex(s);
      const k = idx >= 0 ? `step:${idx}` : null;
      if (k && k !== failedShown) {
        failedShown = k;
        entries.get(k)?.open?.();
      }
    }
    if (pending !== null && entries.has(`step:${pending}`)) openEntry(pending, true);
  }

  return { el, update, open: (index) => openEntry(index, true) };
}
