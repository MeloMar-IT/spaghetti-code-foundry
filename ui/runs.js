import { api } from "./api.js";
import { glyph, h, mount, timeAgo, toast } from "./dom.js";
import { defaultGo, filterBar, filterEmpty, sameRepo, withQuery, without } from "./filters.js";
import { needsYou, nextBlock, nextStatus, whenParts, whereLink, whoClass } from "./next.js";
import { STEP_TYPES } from "./step-types.js";
import { createLog, diffView, transcriptView } from "./run-output.js";
import { skillsCard } from "./run-skills.js";
import { dialogOpen, keepScroll, poller } from "./live.js";
import { noRuns, part, partNote, runsLiveStates } from "./run-states.js";

export { diffView, logLine, transcriptView } from "./run-output.js";

const money = (n) => (n ? `$${n.toFixed(4)}` : "—");
const secs = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);
const what = (r) => (r.vars?.issue ? `${r.vars.github_repo}#${r.vars.issue}` : r.vars?.pr ? `${r.vars.github_repo} PR #${r.vars.pr}` : "");

const REFRESH_MS = 30_000;
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
    // A select or text field has the focus, or a dialog is open: the answer waits. The owner change the reader just made is drawn at once.
    hold: () => !forcing && (fieldFocused(main) || dialogOpen()),
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

function stepsView(runId, summary, open = -1) {
  if (!summary.history.length) return h("p", { class: "muted" }, "No steps finished yet.");
  return h("div", { class: "timeline" }, summary.history.map((s, i) => stepEntry(runId, s, i, { open: i === open })));
}

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

/** The mark of a finished step: the glyph for the eye, a word for screen readers. */
const stepMark = (ok) => h("span", { class: `pill ${ok ? "ok" : "fail"}` }, glyph(ok ? "✔" : "✘"), h("span", { class: "sr-only" }, ok ? "Succeeded" : "Failed"));

/** One finished step: summary line, the raw error under "Details", and the output or transcript when opened. `open`: shown opened. */
export function stepEntry(runId, s, i, { open = false } = {}) {
  // A user's view has no output: a plain row that cannot be opened and never asks for a transcript.
  if (!("output" in s)) {
    return h("div", { class: "tl" },
      h("div", { class: "row" },
        stepMark(s.ok),
        h("b", { class: "mono" }, s.id),
        s.visit > 1 ? h("span", { class: "pill" }, `visit ${s.visit}`) : null,
        h("span", { class: "muted" }, s.type === "agent" ? "Agent" : s.type),
        h("span", { class: "spacer" }),
        h("span", { class: "muted mono" }, secs(s.durationMs))),
      s.error ? h("p", { class: "muted mt-4 mb-4 mx-12" }, s.error) : null);
  }
  const body = h("div");
  let loaded = false;
  const load = async () => {
    if (loaded) return;
    loaded = true;
    if (s.type !== "claude") return mount(body, h("pre", {}, s.output || "(no output)"));
    mount(body, h("p", { class: "muted px-12" }, "Loading transcript…"));
    const t = await api.transcript(runId, i).catch((err) => ({ events: [{ kind: "raw", text: err.message }] }));
    mount(body, transcriptView(t.events));
  };
  if (open) load();
  return h("details", {
    class: "tl",
    open: open || null,
    onToggle: (e) => { if (e.target.open) load(); },
  },
    h("summary", { "data-focus": `step-${i}` },
      stepMark(s.ok),
      h("b", { class: "mono" }, s.id),
      s.visit > 1 ? h("span", { class: "pill" }, `visit ${s.visit}`) : null,
      h("span", { class: "muted" }, s.agent ? s.agent : s.type),
      h("span", { class: "spacer" }),
      h("span", { class: "muted mono" }, secs(s.durationMs)),
      s.costUsd ? h("span", { class: "muted mono" }, money(s.costUsd)) : s.tokens ? h("span", { class: "muted mono", title: "no per-token cost (local model or subscription)" }, `${Math.round((s.tokens.input + s.tokens.output) / 1000)}k tok`) : null),
    s.error ? h("pre", { class: "mono" }, h("b", {}, "Details"), "\n", s.error) : null,
    body);
}

/** The raw reason of a run, shown as a detail under the plain text. */
/** The published version of the flow a run started with; null for a flow that is not published. */
export const versionRow = (s) => (s.flowDef?.publish?.enabled ? [h("dt", {}, "Flow version"), h("dd", {}, String(s.flowDef.publish.version))] : null);

export const detailsRow =(s) => (s.reason ? [h("dt", {}, "Details"), h("dd", { class: "pre-wrap" }, s.reason)] : null);

// ── actions ──

async function act(fn, ok) {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(e.message, "error");
  }
}

/** The line a run page shows when the flow of the run is retired. */
export const FLOW_RETIRED = "This run's flow is retired — it cannot be resumed.";
export const retiredLine = (s) => (s?.next?.retired ? h("p", { class: "muted flow-retired" }, FLOW_RETIRED) : null);

export function actions(s) {
  const b = [];
  // A closed issue or a retired flow: the server refuses Approve, Reject, Resume and Retry.
  const closed = s.next?.kind === "issue_closed" || s.next?.retired === true;
  if (s.status === "waiting" && !closed) {
    b.push(h("button", { class: "primary", "data-focus": "act-approve", onClick: () => { const note = prompt("Approve — note (optional)"); if (note !== null) act(() => api.approveRun(s.runId, note), "Approved — continuing"); } }, "✔ Approve"));
    b.push(h("button", { class: "danger", "data-focus": "act-reject", onClick: () => { const note = prompt("Why reject? (optional)"); if (note !== null) act(() => api.rejectRun(s.runId, note), "Rejected"); } }, "✘ Reject"));
  }
  if (["stopped", "failed", "cancelled"].includes(s.status) && s.state?.next && !closed) {
    b.push(h("button", { class: "primary", "data-focus": "act-resume", onClick: () => act(() => api.resumeRun(s.runId), "Resuming") }, `↻ Resume at ${s.state.next}`));
  }
  if (s.status !== "running" && s.status !== "waiting" && s.flowDef?.steps?.length && !closed) {
    b.push(h("select", { class: "small-select", title: "Re-run from a step", "aria-label": "Re-run from a step", "data-focus": "act-retry-from", onChange: (e) => {
      const from = e.target.value;
      e.target.value = "";
      if (from && confirm(`Re-run this run from "${from}"? Earlier step outputs are kept.`)) act(() => api.resumeRun(s.runId, from), `Re-running from ${from}`);
    } }, h("option", { value: "" }, "Retry from step…"), s.flowDef.steps.map((st) => h("option", { value: st.id }, st.id))));
  }
  if (["running", "waiting"].includes(s.status)) {
    b.push(h("button", { class: "danger", "data-focus": "act-cancel", onClick: () => confirm("Cancel this run? You can resume it later.") && act(() => api.cancelRun(s.runId)) }, "■ Cancel"));
  }
  return b;
}

/** Live run page. Returns a cleanup function that closes the event stream. */
export function renderRunDetail(main, runId, { admin = true } = {}) {
  const log = createLog();
  const status = statusAnnouncer();
  const head = h("div");
  const tabBody = h("div");
  let summary;
  let held = null; // an update that came while a field of the head had the focus: drawn when the focus leaves
  let tab = "log";
  let names = null;
  let open = true;

  // The reader picked a tab: the page does not move it any more (a failed run opens on Steps until then).
  let picked = false;
  const tabButtons = [];
  const showTab = async (t, open = -1) => {
    tab = t;
    for (const [k, b] of tabButtons) b.setAttribute("class", k === t ? "on" : "");
    if (t === "log") return mount(tabBody, log.el);
    if (t === "steps") return mount(tabBody, summary ? stepsView(runId, summary, open) : null);
    mount(tabBody, h("p", { class: "muted" }, "Computing diff…"));
    mount(tabBody, diffView(await api.diff(runId).catch((e) => ({ patch: "", stat: e.message }))));
  };

  const tabs = h("div", { class: "seg tabs mb-12" },
    [["log", "Live log"], ["steps", admin ? "Steps & transcripts" : "Steps"], ["diff", "Changes"]].map(([k, l]) => {
      const b = h("button", { "data-tab": k, class: k === tab ? "on" : null, onClick: () => { picked = true; showTab(k); } }, l);
      tabButtons.push([k, b]);
      return b;
    }));

  mount(main, head, status.el, tabs, tabBody);
  mount(tabBody, log.el);

  // The select of "Retry from step…" must not be replaced under the reader's hands. The timeout lets the next control take the focus first.
  head.addEventListener("focusout", () => setTimeout(() => {
    if (!open || !held || fieldFocused(head)) return;
    const s = held;
    held = null;
    draw(s);
  }, 0));

  const draw = (s) => {
    status.say(s);
    if (fieldFocused(head)) { held = s; return; }
    held = null;
    const prev = summary;
    summary = s;
    const failedIdx = s.status === "failed" ? failedStepIndex(s) : -1;
    const card = s.status === "failed" ? failureCard(s, failedIdx >= 0 ? { onStep: () => { picked = true; showTab("steps", failedIdx); } } : {}) : null;
    mount(head,
      h("div", { class: "toolbar" },
        h("a", { href: "#/runs", class: "btn ghost", "data-focus": "back", "aria-label": "Back to Runs" }, "←"),
        h("h1", {}, s.flow),
        s.next ? nextStatus(s.next, "status-help") : null,
        admin ? h("span", { class: "muted mono" }, money(s.totalCostUsd)) : null,
        s.resumes ? h("span", { class: "muted" }, `resumed ${s.resumes}×`) : null,
        h("span", { class: "spacer" }),
        ...actions(s),
        admin ? h("a", { class: "btn", "data-focus": "open-flow", href: `#/flows/${encodeURIComponent(s.flow)}` }, "Open flow") : null),
      card ?? (s.next ? nextBlock(s.next) : null),
      retiredLine(s),
      h("div", { class: "card mb-16" },
        s.task ? h("p", { class: "flush pre-wrap" }, s.task) : null,
        s.questions ? h("pre", { class: "mono pre-wrap" }, h("b", {}, "Questions"), "\n", s.questions) : null,
        h("dl", { class: "meta" },
          what(s) ? [h("dt", {}, "Ticket"), h("dd", {}, what(s))] : null,
          h("dt", {}, "Run"), h("dd", {}, s.runId),
          admin ? ownerRow(s, names) : null,
          s.branch ? [h("dt", {}, "Branch"), h("dd", {}, s.branch)] : null,
          s.workdir ? [h("dt", {}, "Workspace"), h("dd", {}, s.workdir)] : null,
          versionRow(s),
          stepRow(s),
          card ? null : detailsRow(s))),
      skillsCard(s.skillView, { admin, repo: s.vars?.github_repo }));
    // A failed run opens on its steps, once, unless the reader already chose a tab.
    if (card && !picked && !(prev && prev.status === "failed" && prev.next?.failure)) return showTab("steps");
    if (tab === "steps" && (!prev || prev.history.length !== s.history.length)) showTab("steps");
  };

  if (admin) api.users().then((list) => { names = ownerNames(list); if (open && (held ?? summary)) draw(held ?? summary); }).catch(() => {});

  const es = api.events(runId);
  es.addEventListener("update", (e) => {
    const { summary: s } = JSON.parse(e.data);
    draw(s);
  });
  es.addEventListener("log", (e) => {
    log.add(JSON.parse(e.data).line);
  });
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) toast("Lost connection to the run stream", "error");
  };
  return () => {
    open = false;
    es.close();
  };
}
