import { api } from "./api.js";
import { h, mount, timeAgo, toast } from "./dom.js";
import { defaultGo, filterBar, filterEmpty, sameRepo, withQuery, without } from "./filters.js";
import { needsYou, nextStatus, whenParts, whereLink, whoClass } from "./next.js";
import { STEP_TYPES } from "./step-types.js";
// This module and ./run-header.js import each other: neither uses the other at the top level, only inside functions.
import { createRunHeader } from "./run-header.js";
import { createLog, diffView } from "./run-output.js";
import { skillsCard } from "./run-skills.js";
import { dialogOpen, keepScroll, poller } from "./live.js";
import { adminRunActions } from "./run-dialogs.js";
import { isRun, noRuns, part, partNote, runLoadKind, runLoadState, runStream, runsLiveStates } from "./run-states.js";
import { changesPanel, createTabs, evidencePanel, overviewPanel, showFailedOnce } from "./run-tabs.js";
import { createTimeline } from "./run-timeline.js";

export { diffView, logLine, transcriptView } from "./run-output.js";
export { failedStepIndex, stepEntry } from "./run-timeline.js";

export const money =(n) => (n ? `$${n.toFixed(4)}` : "—");
const what = (r) => (r.vars?.issue ? `${r.vars.github_repo}#${r.vars.issue}` : r.vars?.pr ? `${r.vars.github_repo} PR #${r.vars.pr}` : "");

const REFRESH_MS = 30_000;
const CLOCK_MS = 60_000;
/** The server sends at most this many runs, so a repository filter searches only those. */
export const RUNS_CAP = 200;
export const CAP_NOTE = "Only the newest 200 runs are searched.";
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

/** Runs list; refreshes itself every 30 seconds through the poller and never rejects. Returns a cleanup function that stops that. `query` holds the filters of the address; `go` writes a changed address. */
export async function renderRunsList(main, { admin = true, query = {}, go = defaultGo } = {}) {
  let closed = false;
  let gen = 0; // every request takes a number; the answer or failure of an older one is dropped
  let forcing = false;
  let data = null;
  let live;
  // A user gets their own runs and queue; the owner filter and its options are for admins.
  let filters = { ...(query.repo ? { repo: query.repo } : {}), ...(admin && query.owner ? { owner: query.owner } : {}) };
  const wanted = () => (admin ? filters.owner ?? "" : "");
  const refresh = () => live.refresh();

  const states = runsLiveStates({
    body: main, heading: () => h("div", { class: "toolbar" }, h("h1", {}, "Runs")),
    label: "Loading runs", rows: 6, shape: "table", what: "Could not load the runs.", retry: refresh, focus: "runs",
  });

  // Asks the server (owner filter included). Undefined when a newer request started meanwhile: that one is the answer.
  const fetchAll = async () => {
    const mine = ++gen;
    const owner = wanted();
    try {
      const [runs, queue, owners] = await Promise.all([api.runs(owner), part(api.queue()), admin ? part(api.runOwners()) : null]);
      return mine === gen ? { runs, queue, owners } : undefined;
    } catch (e) {
      if (mine !== gen) return undefined;
      throw e;
    }
  };
  let switching = null; // an owner change whose answer has not been drawn yet
  const rollback = (e) => {
    const s = switching;
    switching = null;
    if (closed || !s || filters !== s.next) return;
    filters = s.before;
    go(withQuery("#/runs", filters));
    if (data) render();
    toast(e?.message || "Could not load the runs.", "error");
  };
  // A change of the repository only filters what is here; a change of the owner asks the server again and draws at once.
  const setFilters = (next) => {
    const reload = (next.owner ?? "") !== (filters.owner ?? "");
    const before = filters;
    filters = next;
    go(withQuery("#/runs", filters));
    if (!reload) return render();
    // If the server cannot answer, the address and the filters go back to what the page still shows. A request that a
    // newer one overtook (a tick) hands this over: that request's failure rolls back too.
    switching = { before, next };
    fetchAll().then((d) => {
      if (closed || !d) return;
      switching = null;
      forcing = true;
      try { live.show(d); } finally { forcing = false; }
    }, rollback);
  };
  const clear = () => setFilters({});

  const render = () => {
    const { runs } = data;
    const queue = data.queue.ok ? data.queue.value : null;
    const owners = data.owners?.ok ? data.owners.value : null;
    const shown = filters.repo ? runs.filter((r) => sameRepo(r.vars?.github_repo, filters.repo)) : runs;
    const pending = filters.repo ? (queue?.pending ?? []).filter((p) => sameRepo(p.githubRepo, filters.repo)) : queue?.pending ?? [];
    const yours = needsYou(shown);
    const cols = ["Status", "Flow", "Task / what happens next", ...(admin ? ["Owner"] : []), "Steps", ...(admin ? ["Cost"] : []), "Started"];
    const table = (list, scope) => h("div", { class: "table-box" }, h("table", { class: "table" },
      h("thead", {}, h("tr", {}, cols.map((t) => h("th", {}, t)))),
      h("tbody", {}, list.map((r) => runRow(r, { owner: admin, cost: admin, scope })))));
    const filter = admin && owners ? h("select", { class: "small-select", title: "Show the runs of one account", "aria-label": "Show the runs of one account", "data-focus": "owner-filter", onChange: (e) => setFilters(e.target.value ? { ...filters, owner: e.target.value } : without(filters, "owner")) },
      h("option", { value: "" }, "All owners"),
      owners.map((o) => h("option", { value: o.id, selected: o.id === filters.owner }, `${ownerLabel(o.name)} (${o.runs})`))) : null;
    const labels = { owner: ownerLabel(owners?.find((o) => o.id === filters.owner)?.name) || filters.owner };
    const note = filters.repo && runs.length >= RUNS_CAP ? CAP_NOTE : null;
    const active = Boolean(filters.repo || filters.owner);
    // A queued job that matches is a result too.
    const found = shown.length > 0 || (filters.repo && pending.length > 0);

    mount(main,
      h("div", { class: "toolbar" }, h("h1", {}, "Runs"),
        admin && queue ? h("span", { class: "muted" }, `${queue.active.length}/${queue.concurrency} running · ${queue.pending.length} queued`) : null,
        filter,
        h("span", { class: "spacer" }),
        states.note,
        h("button", { "data-focus": "refresh", onClick: refresh }, "↻ Refresh")),
      states.alert,
      filterBar(filters, { labels, onRemove: (key) => setFilters(without(filters, key)), onClear: clear }),
      admin && data.owners && !data.owners.ok ? partNote("the owners", data.owners, { onRetry: refresh, focus: "owners-retry", safe: "The runs are shown, without the owner filter." }) : null,
      note && found ? h("p", { class: "muted" }, note) : null,
      !data.queue.ok ? partNote("the queue", data.queue, { onRetry: refresh, focus: "queue-retry", safe: "The runs are shown, without the queue." })
        : pending.length ? h("div", { class: "card mb-16" },
          h("h3", {}, "Queue"),
          pending.map((p) => queueRow(p, async () => {
            await api.cancelRun(p.runId);
            gen++; // an answer asked before the cancel still shows the job
            refresh();
          }))) : null,
      yours.length ? h("div", { class: "mb-16" }, h("h3", { class: "mb-8" }, `Needs you (${yours.length})`), table(yours, "needs")) : null,
      shown.length ? table(shown, "run")
        : active ? (found ? null : filterEmpty("runs", filters, { labels, note, onClear: clear }))
          : noRuns());
  };

  // A select or text field has the focus, or a dialog is open: the answer waits. The owner change the reader just made is drawn at once.
  const isHeld = () => !forcing && (fieldFocused(main) || dialogOpen());
  live = poller({
    load: async () => {
      try {
        const d = await fetchAll();
        if (d) switching = null;
        return d;
      } catch (e) {
        rollback(e);
        throw e;
      }
    },
    draw: (next) => { data = next; keepScroll(main, render); },
    every: REFRESH_MS,
    onState: states.onState,
    hold: isHeld,
  });
  await live.ready;
  return () => {
    closed = true;
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
  if (["running", "waiting"].includes(s.status)) {
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
    { id: "evidence", label: "Evidence", ...evidencePanel() },
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
  mount(main, head, stream.el, alertEl, status.el, tabsBox);

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
