// The filter bar of the admin Runs list: search box, selects, "Only what needs me", the Show buttons and Clear filters.
// The bar is built once and never re-mounted, so the search box keeps its node, text and focus over every redraw.
// It owns the 300 ms timer of the search box and the text typed but not yet committed (the draft).
import { h } from "./dom.js";
import { SEARCH_MAX, STATUSES, emptyFilter, isActive } from "./runs-filter.js";

export const SEARCH_MS = 300;
export const NO_MATCH = "No runs match your search and filters.";

const STATUS_LABEL = { running: "Running", waiting: "Waiting", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", stopped: "Stopped" };
const TIME_OPTIONS = [["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]];
const SHOW = [["", "All", "all"], ["needs", "Needs you", "needs"], ["running", "Running", "running"], ["queued", "Queued", "queued"], ["failed", "Failed", "failed"], ["completed", "Completed", "completed"]];
// As ownerLabel in ./runs.js (which this module does not import): the server's "deleted account" is shown as "deleted user".
const ownerName = (name) => (name === "deleted account" ? "deleted user" : name ?? "");
const list = (v) => (Array.isArray(v) ? v : []);

/** The state of the bar's draft: `onChange(nextFilter)` is called with the whole new filter. */
export function runsBar({ admin = true, onChange } = {}) {
  let current = emptyFilter();
  let draft = null; // text typed and not committed yet
  let timer;
  let stopped = false;
  const keys = new Map(); // per select: the JSON of the options drawn

  const emit = (next) => { if (!stopped) onChange?.(next); };
  const stopTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const cut = (t) => [...t.trim()].slice(0, SEARCH_MAX).join("");
  // Takes the pending text into the filter the next change is built on.
  const take = () => {
    stopTimer();
    if (draft === null) return current.q;
    const q = cut(draft);
    draft = null;
    return q;
  };

  const search = h("input", {
    type: "search", class: "runs-search", maxlength: String(SEARCH_MAX), placeholder: "Run id, #7 or text",
    "aria-label": "Search runs", "data-focus": "runs-search",
    onInput: (e) => {
      draft = e?.target?.value ?? search.value;
      stopTimer();
      timer = setTimeout(() => {
        timer = undefined;
        const q = take();
        if (q !== current.q) emit({ ...current, q });
      }, SEARCH_MS);
    },
  });

  const select = (key, label, focus, first) => {
    const el = h("select", { class: "small-select", "aria-label": label, "data-focus": focus, onChange: (e) => emit({ ...current, q: take(), [key]: e?.target?.value ?? el.value }) },
      h("option", { value: "" }, first));
    return el;
  };
  const repo = select("repo", "Repository", "runs-repo", "All repositories");
  const flow = select("flow", "Flow", "runs-flow", "All flows");
  const status = select("status", "Status", "runs-status", "Any status");
  const time = select("time", "Time", "runs-time", "Any time");
  const owner = admin ? select("owner", "Owner", "owner-filter", "All owners") : null;
  if (owner) owner.hidden = true;
  for (const s of STATUSES) status.append(h("option", { value: s }, STATUS_LABEL[s]));
  for (const [v, t] of TIME_OPTIONS) time.append(h("option", { value: v }, t));

  const needs = h("input", { type: "checkbox", "data-focus": "runs-needs", onChange: (e) => emit({ ...current, q: take(), needs: e?.target?.checked ?? needs.checked }) });
  const needsLabel = h("label", {}, needs, "Only what needs me");

  const shows = SHOW.map(([view, text, id]) => h("button", { type: "button", "data-focus": `runs-view-${id}`, "aria-pressed": "false", onClick: () => emit({ ...current, q: take(), view }) }, text));
  const seg = h("div", { class: "seg", role: "group", "aria-label": "Show" }, shows);

  const clear = h("button", { type: "button", "data-focus": "runs-clear", onClick: () => { stopTimer(); draft = null; emit(emptyFilter()); } }, "Clear filters");
  clear.hidden = true;
  const status$ = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });

  const el = h("div", { class: "runs-bar", role: "group", "aria-label": "Filter runs" }, search, repo, flow, status, time, owner, needsLabel, seg, clear, status$);

  // Options of a select change only when its list does; the node stays. A value the list lacks is added.
  // `anyCase`: a repository written in another letter case selects the name of the list.
  const fill = (sel, name, first, items, wanted, anyCase = false) => {
    const same = (v) => (anyCase ? v.toLowerCase() === wanted.toLowerCase() : v === wanted);
    const hit = items.find(([v]) => v === wanted) ?? items.find(([v]) => same(v));
    const value = hit ? hit[0] : wanted;
    const all = value && !hit ? [...items, [value, value]] : items;
    const key = JSON.stringify(all);
    if (keys.get(name) !== key) {
      keys.set(name, key);
      sel.replaceChildren(h("option", { value: "" }, first), ...all.map(([v, t]) => h("option", { value: v }, t)));
    }
    sel.value = value;
  };
  let values = { repos: [], flows: [], owners: null };

  const sync = (filter) => {
    current = { ...emptyFilter(), ...filter };
    if (draft === null && search.value.trim() !== current.q) search.value = current.q;
    fill(repo, "repo", "All repositories", list(values.repos).map((r) => [r, r]), current.repo, true);
    fill(flow, "flow", "All flows", list(values.flows).map((f) => [f, f]), current.flow);
    status.value = current.status;
    time.value = current.time;
    if (owner) {
      owner.hidden = !Array.isArray(values.owners);
      fill(owner, "owner", "All owners", list(values.owners).map((o) => [o.id, `${ownerName(o.name)} (${o.runs})`]), current.owner);
    }
    needs.checked = current.needs === true;
    shows.forEach((b, i) => {
      const on = SHOW[i][0] === current.view;
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("class", on ? "on" : "");
    });
    clear.hidden = !isActive(current);
  };

  return {
    el,
    search,
    sync,
    setValues(v) {
      values = { repos: v?.repos, flows: v?.flows, owners: v?.owners };
      sync(current);
    },
    say(text) { if (status$.textContent !== text) status$.textContent = text; },
    stop() {
      stopTimer();
      stopped = true;
    },
  };
}

/** The empty state of a filtered list that matched nothing: the sentence, an optional note and Clear filters. */
export function noMatch({ onClear, note } = {}) {
  return h("div", { class: "empty" },
    h("p", {}, NO_MATCH),
    note ? h("p", { class: "muted" }, note) : null,
    h("button", { type: "button", "data-focus": "runs-empty-clear", onClick: onClear }, "Clear filters"));
}
