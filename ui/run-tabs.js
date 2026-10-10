// The tab set of a run page, shared by the administrator page (ui/runs.js) and the user page (ui/user/runs.js), and the
// panels it holds. A panel is built once and then hidden or shown: a stream update changes only what moved inside it,
// and never the selected tab. Relative imports, so a test can load it.
import { aiProps, h, mount } from "./dom.js";
import { whereTarget } from "./next.js";
import { errorState, explainError } from "./states.js";

export const NO_STEPS = "No steps finished yet.";
export const NO_STEPS_OLD = "No steps recorded.";
export const NO_EVIDENCE = "No evidence recorded yet.";
const QUESTION_STEPS = ["send_back", "ask_for_info"];
const MAX_QUESTIONS = 4000;

export const secs = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const firstOf = (t) => String(t ?? "").split(/\r?\n/)[0].trim();
const failedWithRecord = (s) => s?.status === "failed" && !!s.next?.failure;

/** The text of "no steps": a run that is still going has none yet; a finished run without steps is an old run. */
export const noStepsText = (s) => (s?.status === "running" || s?.status === "waiting" || s?.status === "queued" ? NO_STEPS : NO_STEPS_OLD);

/**
 * The summary with `questions` filled in. A user's summary has them; an administrator's does not, so they are read from
 * the step that asked them, by the same rule as the server (a stopped run, the step named in its reason).
 */
export function withQuestions(s) {
  if (!s || typeof s.questions === "string") return s;
  const last = (r) => String(r.id).split("/").at(-1);
  let name;
  if (s.status === "stopped") {
    const m = /stopped at step "(?:[\w-]+\/)*([\w-]+)"/.exec(s.reason ?? "");
    if (m && QUESTION_STEPS.includes(m[1])) name = m[1];
  } else if (Array.isArray(s.answers) && s.answers.length) {
    // The run went on after it was answered: the questions are what the last asking step wrote.
    name = [...(s.history ?? [])].reverse().map(last).find((n) => QUESTION_STEPS.includes(n));
  }
  if (!name) return s;
  const step = [...(s.history ?? [])].reverse().find((r) => last(r) === name);
  const text = typeof step?.output === "string" ? step.output.trim() : "";
  return text ? { ...s, questions: text.slice(0, MAX_QUESTIONS) } : s;
}

/** "3 of 5 steps done, 1 failed"; "" when the run has neither a flow nor steps. */
export function stepCountText(s) {
  const last = new Map();
  for (const r of s?.history ?? []) if (!r.parent) last.set(r.id, r.ok);
  const planned = (s?.flowDef?.steps ?? []).length;
  const total = Math.max(planned, last.size);
  if (!total) return "";
  const done = [...last.values()].filter(Boolean).length;
  const failed = last.size - done;
  return `${done} of ${total} ${total === 1 ? "step" : "steps"} done${failed ? `, ${failed} failed` : ""}`;
}

/**
 * What the run already has as evidence, in order: the questions, the answers, the result of each shell or approval
 * step, the link of the next-step record, and what was already tried. Pure; reads no output, cost, tokens or agent.
 */
export function evidenceItems(s) {
  const out = [];
  if (!s) return out;
  if (typeof s.questions === "string" && s.questions.trim()) out.push({ kind: "question", text: s.questions });
  for (const a of Array.isArray(s.answers) ? s.answers : []) out.push({ kind: "answer", text: String(a?.text ?? ""), at: a?.at });
  for (const r of s.history ?? []) {
    if (r.type !== "shell" && r.type !== "approval") continue;
    out.push({ kind: "check", id: r.id, type: r.type, ok: !!r.ok, durationMs: r.durationMs, ...(r.error ? { error: firstOf(r.error) } : {}) });
  }
  const t = whereTarget(s.next?.where);
  if (t?.external) out.push({ kind: "link", label: s.next.where.label ?? "", href: t.href });
  if (s.status === "failed" && typeof s.next?.failure?.tried === "string" && s.next.failure.tried) out.push({ kind: "tried", text: s.next.failure.tried });
  return out;
}

export const timeText = (at) => {
  const d = new Date(at ?? "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
};

function evidenceNode(it) {
  if (it.kind === "question") return h("li", {}, h("b", {}, "Questions"), h("pre", { class: "mono pre-wrap wrap-anywhere", ...aiProps("questions") }, it.text));
  if (it.kind === "answer") return h("li", {}, h("b", {}, "Answer"), timeText(it.at) ? h("span", { class: "muted" }, ` ${timeText(it.at)}`) : null, h("p", { class: "flush pre-wrap" }, it.text));
  if (it.kind === "check") {
    return h("li", {}, h("span", { class: `pill ${it.ok ? "ok" : "fail"}` }, it.ok ? "Passed" : "Failed"), " ",
      h("b", { class: "mono" }, it.id), " ", h("span", { class: "muted" }, `${it.type === "approval" ? "approval" : "check"} · ${secs(it.durationMs ?? 0)}`),
      it.error ? h("p", { class: "muted flush" }, it.error) : null);
  }
  if (it.kind === "link") return h("li", {}, h("b", {}, "Next step"), " ", h("a", { href: it.href, target: "_blank", rel: "noopener" }, `${it.label || it.href} ↗`));
  return h("li", {}, h("b", {}, "Already tried"), h("p", { class: "flush pre-wrap" }, it.text));
}

/**
 * `createTabs(defs, { initial })`, `defs = [{ id, label, build(), update?(s, prev), onShow?() }]`. `build` runs the first
 * time a tab is shown; `update` runs on every summary, for built panels only (a panel built later gets the last summary
 * once). `picked()` is true once the reader chose a tab by click or key.
 */
export function createTabs(defs, { initial } = {}) {
  const ids = defs.map((d) => d.id);
  let cur = Math.max(0, ids.indexOf(initial));
  let byUser = false;
  let last;
  const built = new Set();
  const uid = `rt${Math.random().toString(36).slice(2, 8)}`;
  const buttons = defs.map((d, i) => h("button", {
    type: "button", role: "tab", "data-tab": d.id, id: `${uid}-tab-${i}`, "aria-controls": `${uid}-panel-${i}`,
    onClick: () => select(i, { byUser: true }),
    onKeydown: (e) => {
      const to = { ArrowRight: (i + 1) % defs.length, ArrowLeft: (i - 1 + defs.length) % defs.length, Home: 0, End: defs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault?.();
      select(to, { byUser: true, focus: true });
    },
  }, d.label));
  const panels = defs.map((d, i) => h("div", { role: "tabpanel", class: "scf-tabs__panel", id: `${uid}-panel-${i}`, "aria-labelledby": `${uid}-tab-${i}`, tabindex: "0" }));
  // The field that had the focus in each panel, with its caret: put back when the panel is shown again.
  const memo = defs.map(() => null);
  const remember = (i, target) => {
    if (!target || target === panels[i] || !panels[i].contains(target)) return;
    memo[i] = { el: target, start: target.selectionStart, end: target.selectionEnd };
  };
  panels.forEach((p, i) => p.addEventListener("focusin", (e) => remember(i, e.target)));
  const list = h("div", { role: "tablist", "aria-label": "Run", class: "scf-tabs__list" }, buttons);
  const el = h("div", { class: "scf-tabs mb-12" }, list, panels);
  for (const p of panels) p.hidden = true;

  function draw(focus) {
    const active = typeof document !== "undefined" ? document.activeElement : null;
    panels.forEach((p, i) => { if (active && p.contains(active)) remember(i, active); });
    const lost = active && panels.some((p, i) => i !== cur && p.contains(active));
    buttons.forEach((b, i) => {
      b.setAttribute("aria-selected", String(i === cur));
      b.setAttribute("tabindex", i === cur ? "0" : "-1");
      b.setAttribute("class", i === cur ? "scf-tabs__tab on" : "scf-tabs__tab");
      panels[i].hidden = i !== cur;
    });
    if (!built.has(cur)) {
      built.add(cur);
      panels[cur].append(defs[cur].build());
      if (last !== undefined) defs[cur].update?.(last, undefined);
    }
    defs[cur].onShow?.();
    const back = memo[cur];
    if (focus) buttons[cur].focus();
    else if (back && back.el.isConnected !== false && panels[cur].contains(back.el)) {
      // Back on a panel where a field had the focus: the field gets it again, with its caret.
      back.el.focus();
      if (typeof back.start === "number" && typeof back.el.setSelectionRange === "function") back.el.setSelectionRange(back.start, back.end);
    } else if (lost) buttons[cur].focus();
  }
  function select(i, { byUser: by = false, focus = false } = {}) {
    if (i < 0 || i >= defs.length) return;
    if (by) byUser = true;
    cur = i;
    draw(focus);
  }
  draw(false);
  return {
    el,
    show: (id, { byUser: by = false } = {}) => select(ids.indexOf(id), { byUser: by }),
    current: () => ids[cur],
    picked: () => byUser,
    update(s, prev) {
      last = s;
      defs.forEach((d, i) => { if (built.has(i)) d.update?.(s, prev); });
    },
  };
}

/** A failed run opens on Steps, once: not again after the reader chose a tab, and not on later failed updates. */
export function showFailedOnce(tabs, s, prev) {
  if (tabs.picked() || !failedWithRecord(s) || failedWithRecord(prev)) return;
  tabs.show("steps");
}

/**
 * The Overview panel: the task, the questions, the step count and the details list. `extra`: a node that is placed once
 * and never touched again (the answer form of the user page). The parts redraw only when their text changed.
 */
export function overviewPanel({ admin = false, extra = null } = {}) {
  const card = h("div", { class: "card mb-16" });
  const count = h("p", { class: "muted" });
  const meta = h("dl", { class: "meta" });
  const keys = { card: null, count: null, meta: null };
  const part = (name, key, box, nodes) => {
    if (keys[name] === key) return;
    keys[name] = key;
    mount(box, [nodes].flat(Infinity));
  };
  return {
    build: () => h("div", {}, card, count, meta, extra),
    update(raw) {
      const s = withQuestions(raw) ?? {};
      const task = s.task?.trim() ? s.task : "";
      const questions = s.questions ?? "";
      part("card", JSON.stringify([task, questions]), card, [
        task ? h("p", { class: "flush pre-wrap" }, task) : null,
        questions ? h("pre", { class: "mono pre-wrap wrap-anywhere", ...aiProps("questions") }, h("b", {}, "Questions"), "\n", questions) : null,
      ]);
      card.hidden = !task && !questions;
      const text = stepCountText(s);
      part("count", text, count, text);
      count.hidden = !text;
      const version = s.flowDef?.publish?.enabled ? String(s.flowDef.publish.version) : "";
      const reason = s.reason && !failedWithRecord(s) ? s.reason : "";
      const row = (k, v, cls) => (v ? [h("dt", {}, k), h("dd", cls ? { class: cls } : {}, v)] : null);
      part("meta", JSON.stringify([s.runId, s.flow, version, admin ? s.workdir : "", reason]), meta, [
        row("Run", s.runId), row("Flow", s.flow), row("Flow version", version), admin ? row("Workspace", s.workdir) : null, row("Details", reason, "pre-wrap"),
      ]);
    },
  };
}

/** The Evidence panel: what the run already has (see `evidenceItems`). Redrawn only when the items changed. */
export function evidencePanel() {
  const box = h("div");
  let key = null;
  return {
    build: () => box,
    update(s) {
      const items = evidenceItems(withQuestions(s));
      const k = JSON.stringify(items);
      if (k === key) return;
      key = k;
      mount(box, items.length ? h("ul", { class: "evidence flush" }, items.map(evidenceNode)) : h("p", { class: "muted" }, NO_EVIDENCE));
    },
  };
}

/**
 * The Changes panel. `load()` gives the diff; `view(d, { none })` draws it (passed in by the page). It loads when first
 * shown, on the Refresh button, and when the run finishes (`finishedAt` appears). Open files stay in between.
 */
export function changesPanel({ load, view, none, loading = "Loading the changes…", onError } = {}) {
  const body = h("div");
  const button = h("button", { type: "button", class: "small", "data-focus": "diff-refresh", onClick: () => reload() }, "Refresh");
  let seq = 0;
  let shown = false;
  async function reload() {
    const mine = ++seq;
    if (!shown) mount(body, h("p", { class: "muted" }, loading));
    else button.disabled = true;
    let node;
    let ok = true;
    try {
      node = view(await load(), none ? { none } : undefined);
    } catch (e) {
      ok = false;
      node = onError ? onError(e) : errorState(explainError(e, { what: "Could not load the changes." }), { onRetry: () => reload().catch(() => {}), focus: "diff-retry" });
    }
    if (mine !== seq) return;
    shown = ok;
    button.disabled = false;
    mount(body, node);
  }
  return {
    build() {
      reload().catch(() => {});
      return h("div", {}, h("div", { class: "row mb-8" }, button), body);
    },
    update(s, prev) {
      if (prev && !prev.finishedAt && s?.finishedAt) reload().catch(() => {});
    },
  };
}
