import { api } from "./api.js";
import { h, mount, timeAgo, toast } from "./dom.js";
import { defaultGo, filterBar, filterEmpty, sameRepo } from "./filters.js";
import { pageViews } from "./views.js";
import { nextStatus, whenParts, whereLink, whoClass } from "./next.js";
import { STEP_TYPES } from "./step-types.js";
// This module and ./run-header.js import each other: neither uses the other at the top level, only inside functions.
import { createRunHeader } from "./run-header.js";
import { createLog, diffView } from "./run-output.js";
import { evidenceRecordSection } from "./run-evidence.js";
import { skillsCard } from "./run-skills.js";
import { dialogOpen, keepScroll, poller } from "./live.js";
import { adminRunActions } from "./run-dialogs.js";
import { isRun, noRuns, part, partNote, runLoadKind, runLoadState, runStream, runsLiveStates } from "./run-states.js";
import { changesPanel, createTabs, evidencePanel, overviewPanel, showFailedOnce } from "./run-tabs.js";
import { createTimeline } from "./run-timeline.js";
import { collectionPage, detailPage } from "./templates.js";
import { archivedSections, readDensity, renderSections, runSections, sectionOf, writeDensity } from "./runs-list.js";
import { bulkArchive, bulkBar, bulkText, noMatch, runsBar } from "./runs-bar.js";
// This module and ./user/runs.js import each other: neither uses the other at the top level, only inside functions.
import { confirmDialog } from "./user/runs.js";
import { canonRepos, countText, emptyFilter, filterHash, filterOf, filterQuery, isActive, isServerActive, jobMatches, serverKey } from "./runs-filter.js";

export { diffView, logLine, transcriptView } from "./run-output.js";
export { failedStepIndex, stepEntry } from "./run-timeline.js";

export const money =(n) => (n ? `$${n.toFixed(4)}` : "—");
const what = (r) => (r.vars?.issue ? `${r.vars.github_repo}#${r.vars.issue}` : r.vars?.pr ? `${r.vars.github_repo} PR #${r.vars.pr}` : "");

const REFRESH_MS = 30_000;
const CLOCK_MS = 60_000;
/** The server sends at most this many runs, so a repository filter searches only those. */
export const RUNS_CAP = 200;
export const CAP_NOTE = "Only the newest 200 runs are searched.";
export const MATCH_NOTE = "Only the newest 200 matches are shown.";
const GONE = "deleted user";
/** The server's owner name as the list shows it: "deleted user" for an account that is gone, "" for no owner. */
export const ownerLabel = (name) => (name === "deleted account" ? GONE : name ?? "");
/** Account names by id from the answer of GET /api/users; null when it is not a list. */
export const ownerNames = (users) => (Array.isArray(users) ? new Map(users.map((u) => [u.id, u.name])) : null);
/** The account's name, "deleted user" when it is gone, "" for no owner or while the names are not known. */
export const ownerText = (owner, names) => (!owner || !names ? "" : names.get(owner) ?? GONE);
/** The Owner row of the run page, or null. */
export const ownerRow = (s, names) => {
  const t = ownerText(s.owner, names);
  return t ? [h("dt", {}, "Owner"), h("dd", {}, t)] : null;
};

/** The mark of an architect run: a pill that opens its refinement session, not the run. */
export const refinementMark = (id, focus) => h("a", { class: "pill refinement", href: `#/refinement/${encodeURIComponent(id)}`, title: "Open the refinement session", "data-focus": focus, onClick: (e) => e.stopPropagation() }, "refinement");

/** True when a select or a text field inside `box` has the focus: a page that redraws itself must not take it away. */
export function fieldFocused(box) {
  const el = document.activeElement;
  if (!el || !box.contains(el)) return false;
  if (el.localName === "select" || el.localName === "textarea") return true;
  return el.localName === "input" && !["checkbox", "radio", "button", "submit"].includes(el.getAttribute("type"));
}

/**
 * A row of the Runs list: the status name of the record (a link to the run, so the keyboard can open it) with its "?",
 * then flow, task, steps, cost, start. The row click is a pointer shortcut. `scope` keeps the focus names of a run
 * unique when a page shows it twice.
 */
export const runRow = (r, { owner = false, cost = true, scope = "run" } = {}) => {
  const [pill, help] = r.next ? nextStatus(r.next, `${scope}-help-${r.runId}`) : [];
  return h("tr", { class: "link", onClick: () => (location.hash = `#/runs/${r.runId}`) },
  h("td", {},
    h("a", { href: `#/runs/${r.runId}`, "data-focus": `${scope}-${r.runId}`, "aria-label": `${r.next?.status ?? "Open"} — open run ${r.flow}`, onClick: (e) => e.stopPropagation() }, pill ?? "Open"),
    help),
  h("td", {}, h("b", {}, r.flow), r.refinement ? [" ", refinementMark(r.refinement, `${scope}-ref-${r.runId}`)] : null, what(r) ? h("div", { class: "muted mono text-2xs" }, what(r)) : null),
  h("td", { class: "task", title: r.task }, r.task || h("span", { class: "muted" }, "—"),
    r.next ? h("div", { class: "muted", title: r.next.text }, r.next.text) : null,
    r.next && whenParts(r.next).length ? h("div", { class: "next-parts timing" }, whenParts(r.next)) : null),
  owner ? h("td", {}, ownerLabel(r.ownerName)) : null,
  h("td", { class: "mono" }, r.history?.length ?? 0),
  cost ? h("td", { class: "mono" }, money(r.totalCostUsd)) : null,
  h("td", { class: "muted" }, timeAgo(r.startedAt)));
};

/** "2 runs ahead of you": other accounts' queued runs in front of a user's own. */
export const aheadText = (n) => `${n} ${n === 1 ? "run" : "runs"} ahead of you`;

/** A queued job: its status with "?", id, details, link and a Remove button. */
export const queueRow = (p, onRemove) => h("div", { class: "row" },
  p.next ? nextStatus(p.next, `queue-help-${p.runId}`) : null, p.priority ? h("span", { class: "pill first" }, "goes first") : null, p.refinement ? refinementMark(p.refinement, `queue-ref-${p.runId}`) : null, h("span", { class: "mono" }, p.runId), h("span", { class: "muted" }, [p.kind, p.source, p.next?.text].filter(Boolean).join(" · ")),
  p.ahead ? h("span", { class: "muted" }, aheadText(p.ahead)) : null,
  ownerLabel(p.ownerName) ? h("span", { class: "muted", title: "Owner" }, ownerLabel(p.ownerName)) : null,
  ...(p.next ? whenParts(p.next) : []),
  p.next ? whereLink(p.next.where, `queue-where-${p.runId}`) : null,
  h("span", { class: "spacer" }),
  h("button", { class: "small", "data-focus": `queue-remove-${p.runId}`, onClick: onRemove }, "Remove"));

/** The step row of the run page: the step the run is at (or resumes at) and what that step is. Never the id alone. */
export function stepRow(s) {
  const id = s.state?.next;
  if (!id || s.status === "succeeded") return null;
  const step = s.flowDef?.steps?.find((st) => st.id === id);
  const about = step?.description || (step?.type === "agent" ? "Agent" : STEP_TYPES[step?.type]?.label) || "what this step does is not saved with this run";
  return [h("dt", {}, s.status === "running" ? "Current step" : "Resumes at step"), h("dd", {}, id, h("span", { class: "muted" }, ` — ${about}`))];
}

/** True when a select has the focus inside `box`: the page does not redraw under the reader's hands. */
const selectFocused = (box) => {
  const el = document.activeElement;
  return Boolean(el && box.contains(el) && el.localName === "select");
};

/**
 * Asks the runs of a filter. The server matches a repository by its exact spelling: every spelling in `names` (see
 * canonRepos) is asked and the answers are merged (newest first, at most RUNS_CAP). `ask` takes the query and returns the runs.
 */
export async function askRuns(ask, f, names) {
  const now = Date.now();
  if (!names.length) return ask(filterQuery({ ...f, repo: "" }, now));
  const lists = await Promise.all(names.map((repo) => ask(filterQuery({ ...f, repo }, now))));
  if (lists.length === 1) return lists[0];
  const seen = new Set();
  const merged = lists.flatMap((l) => (Array.isArray(l) ? l : [])).filter((r) => !seen.has(r.runId) && seen.add(r.runId));
  return merged.sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0)).slice(0, RUNS_CAP);
}

/**
 * Runs list; refreshes itself every 30 seconds through the poller and never rejects. Returns a cleanup function that stops that.
 * `filter` is the full filter of the address (see ./runs-filter.js); without it the filter is built from `query`. `go` writes
 * a changed address. `alive` tells whether the page is still the one on screen: no request starts after it says no.
 * `ask(title, text, yes, no)` is the yes/no question of "Archive N runs".
 */
export async function renderRunsList(main, { admin = true, query = {}, filter: start, go = defaultGo, alive = () => true, views = pageViews("runs"), ask = confirmDialog, store } = {}) {
  let closed = false;
  let density = readDensity(store);
  let gen = 0; // every request takes a number; the answer or failure of an older one is dropped
  let forcing = false;
  let data = null;
  let live;
  // A user gets their own runs and queue, filtered by repository only; the filter bar and its options are for admins.
  const first = start ?? filterOf(query);
  let filter = admin ? { ...emptyFilter(), ...first } : { ...emptyFilter(), repo: first.repo ?? "" };
  let shown = null; // { filter, data }: what the page shows now
  const refresh = () => live.refresh();
  const gone = () => closed || !alive();
  const bar = admin ? runsBar({ admin, density, onChange: (next) => apply(next), onDensity: (d) => { density = d; writeDensity(d, store); if (data) render(); } }) : null;

  // The selection: ids of runs ticked in Failed, Completed or Archived. `busy` covers the whole batch, the question included.
  const selected = new Set();
  let busy = false;
  let archivedShown = false;
  const select = {
    has: (id) => selected.has(id),
    toggle: (id, on) => {
      if (on) selected.add(id);
      else selected.delete(id);
      bulk.show(selected.size, archivedShown, busy);
    },
  };
  const bulk = bulkBar({
    onAct: () => act(),
    onClear: () => { selected.clear(); if (data) render(); },
    home: () => {
      const toggle = sections.hidden ? null : [...sections.querySelectorAll("button")].find((b) => b.classList.contains("run-section-toggle"));
      if (toggle) return toggle;
      const heading = main.querySelector("h1");
      heading?.setAttribute("tabindex", "-1");
      return heading;
    },
  });

  const slot = h("div");
  const states = runsLiveStates({
    body: slot,
    label: "Loading runs", rows: 6, shape: "cards", what: "Could not load the runs.", retry: refresh, focus: "runs",
  });
  mount(main, collectionPage({ title: "Runs", list: slot }));
  const sections = h("div", { class: "run-sections" });
  const part1 = () => ({ el: h("div"), key: null });
  const slots = { filter: part1(), owners: part1(), cap: part1(), queue: part1(), empty: part1() };
  const patch = (s, key, make) => {
    if (s.key === key) return;
    s.key = key;
    mount(s.el, make());
  };
  const page = collectionPage({
    title: "Runs",
    actions: [h("span", { class: "spacer" }), states.note, h("button", { "data-focus": "refresh", onClick: refresh }, "↻ Refresh")],
    notices: states.alert,
    filters: [bar?.el, slots.filter.el],
    list: [slots.owners.el, slots.cap.el, slots.queue.el, bulk.el, sections],
    empty: slots.empty.el,
  });

  // Asks the server. Undefined when a newer request started meanwhile or the page was left: nothing is asked then.
  const fetchAll = async () => {
    if (gone()) return undefined;
    const mine = ++gen;
    try {
      if (!admin) {
        const [runs, queue] = await Promise.all([api.runs(), part(api.queue())]);
        return mine === gen && !closed ? { filter, runs, queue, owners: null, values: null, canon: [] } : undefined;
      }
      const [values, owners, queue] = await Promise.all([part(api.runFilters()), part(api.runOwners()), part(api.queue())]);
      if (mine !== gen || gone()) return undefined;
      const f = filter;
      const canon = values.ok ? canonRepos(f.repo, values.value?.repos) : [];
      const runs = await askRuns((q) => api.runs(q), f, canon);
      return mine === gen && !gone() ? { filter, runs, queue, owners, values, canon } : undefined;
    } catch (e) {
      if (mine !== gen || closed) return undefined;
      throw e;
    }
  };
  // The reader changed what the server is asked and the answer is not drawn yet.
  const pending = () => Boolean(shown) && serverKey(filter) !== serverKey(shown.filter);
  const showNow = (d) => {
    forcing = true;
    try { live.show(d); } finally { forcing = false; }
  };
  // If the server cannot answer, the address, the bar and the list go back to the last filter that was drawn. Only the
  // newest request fails (an overtaken one is dropped), so this never goes back to a filter that was never drawn.
  const rollback = (e) => {
    if (closed || !shown || JSON.stringify(filter) === JSON.stringify(shown.filter)) return;
    filter = shown.filter;
    go(filterHash(filter));
    bar?.sync(filter);
    data = shown.data;
    render();
    toast(e?.message || "Could not load the runs.", "error");
  };
  // Every change of the filter: the address and the bar follow at once; a change of what the server is asked loads again.
  const apply = (next) => {
    if (closed || JSON.stringify(next) === JSON.stringify(filter)) return;
    const reload = admin && serverKey(next) !== serverKey(filter);
    const toggled = (next.view === "archived") !== (filter.view === "archived");
    if (toggled) selected.clear();
    filter = next;
    go(filterHash(filter));
    bar?.sync(filter);
    if (!reload) {
      if (!pending() && shown) showNow({ ...shown.data, filter });
      return;
    }
    if (toggled && data) render(); // the boxes and the bar follow the cleared selection at once
    fetchAll().then((d) => { if (!closed && d) showNow(d); }, rollback);
  };
  const clear = () => apply(emptyFilter());

  function render() {
    if (closed) return;
    const { runs } = data;
    const f = data.filter;
    const queue = data.queue.ok ? data.queue.value : null;
    const owners = data.owners?.ok && Array.isArray(data.owners.value) ? data.owners.value : null;
    const ownerName = owners?.find((o) => o.id === f.owner)?.name; // queued jobs carry the name, not the id
    const browserRepo = Boolean(f.repo) && !data.canon?.length; // the server does not know this repository: filter here
    const now = Date.now();
    const arch = f.view === "archived";
    if (arch !== archivedShown) { selected.clear(); archivedShown = arch; }
    const keep = (e) => {
      if (browserRepo && !sameRepo(e.run?.vars?.github_repo ?? e.job?.githubRepo, f.repo)) return false;
      if (admin && !e.run && !jobMatches(e.job, f, { ownerName, now })) return false;
      if (f.needs && sectionOf(e) !== "needs") return false;
      if (arch) return true;
      return !f.view || sectionOf(e) === f.view;
    };
    const labels = { owner: ownerLabel(ownerName) || f.owner };
    const note = runs.length >= RUNS_CAP ? (browserRepo ? CAP_NOTE : isServerActive(f) ? MATCH_NOTE : null) : null;
    // What a saved view stores: repository and owner only.
    const vf = { ...(f.repo ? { repo: f.repo } : {}), ...(f.owner ? { owner: f.owner } : {}) };
    // Saved views: the owner ids come from the owner list the page already loads (unknown when it failed).
    const vp = views?.parts(vf, { owners: owners ? owners.map((o) => o.id) : null, redraw: () => { slots.empty.key = null; if (!closed && data) render(); } }) ?? {};
    const stale = Boolean(vp.stale); // an out-of-date saved view is open: the empty state, even when the server still sent rows
    const secs = stale ? [] : arch ? archivedSections(runs, keep) : runSections(runs, queue?.pending ?? [], keep);
    const found = secs.length > 0;

    // The page is built once; each part changes only when its own content does, so the list keeps its nodes and the focus.
    if (page.parentNode !== main) mount(main, page);
    if (bar) {
      const values = (key) => (data.values?.ok && Array.isArray(data.values.value?.[key]) ? data.values.value[key] : []);
      bar.setValues({ repos: values("repos"), flows: values("flows"), owners });
      bar.sync(filter);
      bar.say(isActive(f) && !stale ? countText(secs.reduce((n, s) => n + s.entries.length, 0)) : "");
    }
    // The bar holds the filters of the admin list; this part keeps the saved views, "Save view" and the context offer.
    mount(slots.filter.el, filterBar(admin ? {} : vf, { labels, onRemove: (key) => apply({ ...filter, [key]: "" }), onClear: clear, row: vp.row, onSave: vp.onSave }));
    patch(slots.owners, JSON.stringify(admin && data.owners && !data.owners.ok ? data.owners : 0), () => (admin && data.owners && !data.owners.ok ? partNote("the owners", data.owners, { onRetry: refresh, focus: "owners-retry", safe: "The runs are shown, without the owner filter." }) : null));
    patch(slots.cap, JSON.stringify([found, note]), () => (note && found ? h("p", { class: "muted" }, note) : null));
    patch(slots.queue, JSON.stringify(data.queue.ok ? 0 : data.queue), () => (data.queue.ok ? null : partNote("the queue", data.queue, { onRetry: refresh, focus: "queue-retry", safe: "The runs are shown, without the queue." })));
    patch(slots.empty, JSON.stringify([f, labels, stale, found, note]), () => (stale ? filterEmpty("runs", vf, { labels, onClear: clear, onDelete: vp.onDelete })
      : found ? null : admin && isActive(f) ? noMatch({ onClear: clear, note }) : !admin && f.repo ? filterEmpty("runs", vf, { labels, note, onClear: clear }) : noRuns()));
    sections.hidden = !found;
    const can = new Set(renderSections(sections, secs, { admin, onRemove, select, density, notes: { queued: admin && queue ? `${queue.active.length}/${queue.concurrency} running` : "" } }));
    for (const id of [...selected]) if (!can.has(id)) selected.delete(id); // a run that is no longer in a selectable section
    bulk.show(selected.size, archivedShown, busy);
  }

  // Archive (or take out of the archive) the ticked runs, one request after the other; nothing is drawn or said after the page was left.
  async function act() {
    if (busy || !selected.size || gone()) return;
    busy = true;
    const ids = [...selected]; // the snapshot, before the question
    const unarchive = archivedShown;
    bulk.show(selected.size, archivedShown, busy);
    let result = null;
    try {
      result = await bulkArchive(ids, { unarchive, a: api, ask, gone: () => closed });
    } finally {
      busy = false;
    }
    if (closed) return;
    if (!result) { if (data) render(); return; }
    selected.clear();
    toast(bulkText(result, unarchive), result.refused.length ? "error" : "info");
    if (data) render(); // the poller does not redraw an unchanged answer
    gen++; // an answer asked before the batch still shows the runs
    refresh();
  }

  // Remove a queued run from its row; nothing is drawn or said after the page was left.
  const onRemove = async (job) => {
    try {
      await api.cancelRun(job.runId);
    } catch (e) {
      if (!closed) toast(e?.message || "Could not remove the run.", "error");
    }
    if (closed) return;
    gen++; // an answer asked before the cancel still shows the job
    refresh();
  };

  // A select has the focus, or a dialog is open: the answer waits. A filter change the reader just made is drawn at once.
  const isHeld = () => !forcing && !pending() && (selectFocused(main) || dialogOpen());
  live = poller({
    load: async () => {
      try {
        return await fetchAll();
      } catch (e) {
        rollback(e);
        throw e;
      }
    },
    draw: (next) => {
      data = serverKey(next.filter) === serverKey(filter) ? { ...next, filter } : next;
      shown = { filter: data.filter, data };
      keepScroll(main, render);
    },
    every: REFRESH_MS,
    onState: states.onState,
    hold: isHeld,
  });
  await live.ready;
  return () => {
    closed = true;
    gen++; // an answer or a second phase still on its way is dropped
    bar?.stop();
    live.stop();
  };
}

/**
 * A polite status region for a run page: `say(summary)` reads the new status of the run out, once. The first status is
 * only remembered (the page was just opened), and the same status again says nothing.
 */
export function statusAnnouncer() {
  const el = h("div", { class: "sr-only", role: "status", "aria-live": "polite" });
  let last = null;
  return {
    el,
    say(summary) {
      const t = summary?.next?.status ?? summary?.status;
      if (!t || t === last) return;
      const first = last === null;
      last = t;
      if (!first) el.textContent = `Run status: ${t}`;
    },
  };
}

/**
 * The card of a failed run: who, the kind of problem, what failed, why, what was tried, what to do first and the four
 * options. The raw reason is one click away under "Raw details" (an administrator only). Null when the run has no explanation.
 */
export function failureCard(s, { onStep } = {}) {
  const n = s.next;
  const f = n?.failure;
  if (!f) return null;
  const row = (k, v) => [h("dt", {}, k), h("dd", {}, v)];
  return h("div", { class: `card next-step failure ${whoClass(n)}` },
    h("div", { class: "next-parts" }, h("b", {}, "This run failed"), h("span", { class: `pill ${whoClass(n)}` }, n.who), h("span", { class: `pill kind-${f.cause}` }, f.kind)),
    h("dl", { class: "meta" },
      row("What happened", f.what),
      row("Why", f.byModel ? [f.why, h("div", { class: "muted" }, "A model read the output of the failing step to write this sentence. It can be wrong.")] : f.why),
      row("Already tried", f.tried),
      n.action ? row("Do first", n.action) : null),
    h("b", {}, "Your options"),
    h("ul", { class: "options" }, f.options.map((o) => h("li", {}, o))),
    onStep ? h("button", { class: "small", "data-focus": "failed-step", onClick: onStep }, "Show the failed step") : null,
    s.reason ? h("details", { class: "raw" }, h("summary", { "data-focus": "raw-details" }, "Raw details"), h("pre", { class: "mono pre-wrap" }, s.reason)) : null);
}

/** The raw reason of a run, shown as a detail under the plain text. */
/** The published version of the flow a run started with; null for a flow that is not published. */
export const versionRow = (s) => (s.flowDef?.publish?.enabled ? [h("dt", {}, "Flow version"), h("dd", {}, String(s.flowDef.publish.version))] : null);

export function detailsRow(s) { return s.reason ? [h("dt", {}, "Details"), h("dd", { class: "pre-wrap" }, s.reason)] : null; }

// ── actions ──

/** The line a run page shows when the flow of the run is retired. */
export const FLOW_RETIRED = "This run's flow is retired — it cannot be resumed.";
export const retiredLine = (s) => (s?.next?.retired ? h("p", { class: "muted flow-retired" }, FLOW_RETIRED) : null);

/** The buttons of a run page; each calls `run(kind, from)` (see adminRunActions in ui/run-dialogs.js). */
export function actions(s, run = () => {}) {
  const b = [];
  // A closed issue or a retired flow: the server refuses Approve, Reject, Resume and Retry.
  const closed = s.next?.kind === "issue_closed" || s.next?.retired === true;
  if (s.status === "waiting" && !closed) {
    b.push(h("button", { "data-focus": "act-approve", onClick: () => run("approve") }, "✔ Approve"));
    b.push(h("button", { class: "danger", "data-focus": "act-reject", onClick: () => run("reject") }, "✘ Reject"));
  }
  if (["stopped", "failed", "cancelled"].includes(s.status) && s.state?.next && !closed) {
    b.push(h("button", { "data-focus": "act-resume", title: `Continue at step "${s.state.next}"`, onClick: () => run("resume") }, "Retry from the failing step"));
  }
  if (s.status !== "running" && s.status !== "waiting" && s.flowDef?.steps?.length && !closed) {
    b.push(h("select", { class: "small-select", title: "Re-run from a step", "aria-label": "Re-run from a step", "data-focus": "act-retry-from", onChange: async (e) => {
      const sel = e.target;
      const from = sel.value;
      if (!from) return;
      try { await run("rerun", from); } finally { sel.value = ""; }
    } }, h("option", { value: "" }, "Retry from step…"), s.flowDef.steps.map((st) => h("option", { value: st.id }, st.id))));
  }
  if (["running", "waiting"].includes(s.status) || (s.status === "stopped" && !s.refinement)) {
    b.push(h("button", { class: "danger", "data-focus": "act-cancel", onClick: () => run("cancel") }, "■ Cancel"));
  }
  return b;
}

/** Live run page. Returns a cleanup function that closes the event stream. */
export function renderRunDetail(main, runId, { admin = true } = {}) {
  const log = createLog();
  const status = statusAnnouncer();
  const head = h("div");
  let summary;
  let job = null; // a queued run: it has no record yet, the queue knows it
  let mode = "state"; // what the page shows: "state" (loading, not found, error), "queued" or "page"
  let stateKey = null;
  let loadSeq = 0;
  let updates = 0; // every event of the stream counts: an answer asked before it is older than the stream
  const BACK = { href: "#/runs", label: "Runs", focus: "back-runs" };
  let held = null; // an update that came while a field of the head had the focus or a dialog was open: drawn when that ends
  let heldView = null; // the same for a 404, 403 or queued answer: the newest one wins over a held update
  let released = false; // after an action the head is drawn although the select still has the focus, until the focus leaves
  let recheckTimer;
  const alertEl = h("p", { class: "status bad", role: "alert" });
  let names = null;
  let open = true;

  const timeline = createTimeline({ runId, admin });
  // The reader's tab is never moved by an update; a failed run opens on Steps once (see showFailedOnce).
  const tabs = createTabs([
    { id: "overview", label: "Overview", ...overviewPanel({ admin }) },
    { id: "steps", label: "Steps", build: () => timeline.el, update: (s) => timeline.update(s) },
    { id: "diff", label: "Changes", ...changesPanel({ view: diffView, loading: "Computing diff…", load: () => api.diff(runId) }) },
    { id: "evidence", label: "Evidence", ...evidencePanel({ record: evidenceRecordSection({ load: () => api.evidence(runId), admin, runId }) }) },
    { id: "log", label: "Logs", build: () => log.el, onShow: () => log.restore() },
  ], { initial: "overview" });
  const tabsBox = tabs.el;

  const header = createRunHeader({ admin, actions: (s) => actions(s, run), onFailedStep: (i) => { tabs.show("steps", { byUser: true }); timeline.open(i); }, backLabel: "Back to Runs" });
  const skillsBox = h("div");
  let load;
  const stream = runStream({
    open: () => api.events(runId),
    on: {
      update: (e) => { updates++; draw(JSON.parse(e.data).summary); },
      log: (e) => { updates++; log.add(JSON.parse(e.data).line); },
    },
    onLost: () => load(),
    onReopen: () => log.clear(),
  });
  mount(main, detailPage({ head, sections: [stream.el, alertEl, status.el, tabsBox] }));

  const showState = (error) => {
    const key = `${runLoadKind(error)}|${error?.message ?? ""}`;
    if (mode === "state" && key === stateKey) return;
    if (dialogOpen()) { held = null; heldView = () => showState(error); arm(); return; }
    heldView = null;
    mode = "state";
    stateKey = key;
    alertEl.textContent = "";
    summary = held = job = null;
    tabsBox.hidden = true;
    stream.el.hidden = true;
    mount(head, runLoadState(error, { back: BACK, onRetry: load }));
  };

  // A queued run: a small head from the job, no actions.
  const showQueued = (found) => {
    if (dialogOpen()) { held = null; heldView = () => showQueued(found); arm(); return; }
    heldView = null;
    if (mode === "state") mount(head, header.el, skillsBox);
    mode = "queued";
    job = found;
    stateKey = null;
    mount(skillsBox);
    header.update(null, { job });
    tabsBox.hidden = true;
    stream.el.hidden = false;
  };

  // The head is not replaced while a dialog is open or a field of it has the focus (the select of "Retry from step…" must
  // not be replaced under the reader's hands). The newest update is drawn when that ends.
  const paused = () => dialogOpen() || (!released && fieldFocused(head));
  const release = () => {
    if (!open || paused()) return;
    if (heldView) {
      const v = heldView;
      heldView = null;
      v();
    } else if (held) {
      const s = held;
      held = null;
      draw(s);
    }
  };
  // A dialog that this page did not open (Change password) does not tell the page when it closes: look again.
  function arm() {
    if (recheckTimer !== undefined) return;
    recheckTimer = setTimeout(() => {
      recheckTimer = undefined;
      if (!open) return;
      if (dialogOpen()) { if (held || heldView) arm(); } else release();
    }, 250);
  }
  // The timeout lets the next control take the focus first.
  head.addEventListener("focusout", () => {
    released = false;
    setTimeout(release, 0);
  });

  const draw = (s) => {
    status.say(s);
    if (paused()) {
      held = s;
      heldView = null;
      if (dialogOpen()) arm();
      return;
    }
    held = null;
    heldView = null;
    if (mode !== "page") {
      if (mode === "state") mount(head, header.el, skillsBox);
      mode = "page";
      job = null;
      stateKey = null;
      tabsBox.hidden = false;
      stream.el.hidden = false;
    }
    const prev = summary;
    summary = s;
    header.update(s, { names });
    mount(skillsBox, skillsCard(s.skillView, { admin, repo: s.vars?.github_repo }));
    showFailedOnce(tabs, s, prev);
    tabs.update(s, prev);
  };

  if (admin) api.users().then((list) => { names = ownerNames(list); if (open && (held ?? summary)) draw(held ?? summary); }).catch(() => {});

  // The times in the header move on even when the stream sends only pings.
  const clock = setInterval(() => { if (summary && !paused()) header.update(summary, { names }); }, CLOCK_MS);

  load = async () => {
    const mine = ++loadSeq, seen = updates;
    const stale = () => !open || mine !== loadSeq || seen !== updates;
    let s, err = null;
    try { s = await api.run(runId); } catch (e) { err = e; }
    if (stale()) return;
    if (!err) { if (isRun(s)) draw(s); return; }
    const status = Number(err.status) || 0;
    if (status === 404) {
      // A queued run has no record yet: the queue knows it. A run that just started is in the active list.
      let q;
      try { q = await api.queue(); } catch (e) { if (!stale() && mode === "state") showState(e); return; }
      if (stale()) return;
      const found = (q?.pending ?? []).find((p) => p.runId === runId);
      if (found) return showQueued(found);
      if ((q?.active ?? []).some((p) => p?.runId === runId)) return mode === "state" ? showState(null) : undefined; // starting: the stream sends the summary
      return showState(err);
    }
    if (status === 403) return showState(err);
    if (mode === "state") showState(err); // with content on the page the content stays; the banner tells
  };

  const run = adminRunActions(runId, {
    setAlert: (t) => { alertEl.textContent = t; },
    // The closing dialog gives the focus back to the select, which would keep the held update away: release it once anyway.
    onDialogClosed: () => { released = true; release(); },
    onDone: () => { released = true; release(); load(); },
  });

  showState(null);
  stream.start();
  load();
  return () => {
    open = false;
    clearInterval(clock);
    clearTimeout(recheckTimer);
    stream.close();
  };
}
