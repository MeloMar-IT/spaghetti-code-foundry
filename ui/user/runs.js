// My runs and the run page of a user. The server decides what a user sees and may do; these pages draw its cut-down
// answers and show its sentences when it refuses. Relative imports, so a test can load them.
import { api } from "../api.js";
import { errorText } from "../auth.js";
import { h, modal, mount, toast } from "../dom.js";
import { answerable, createRunHeader, firstLine, runActions, workText } from "../run-header.js";
import { filterBar, filterEmpty, defaultGo, sameRepo, withQuery } from "../filters.js";
import { pageViews } from "../views.js";
import { createLog } from "../run-output.js";
import { skillsCard } from "../run-skills.js";
import { dialogOpen, keepScroll, poller } from "../live.js";
import { decisionDialog } from "../run-dialogs.js";
import { noRuns, part, partNote, runLoadKind, runLoadState, runStream, runsLiveStates } from "../run-states.js";
import { changesPanel, createTabs, evidencePanel, overviewPanel, showFailedOnce } from "../run-tabs.js";
import { createTimeline } from "../run-timeline.js";
import { CAP_NOTE, RUNS_CAP, diffView, statusAnnouncer } from "../runs.js";
import { listRow, myRunsEntries, renderSections, runSections } from "../runs-list.js";

export { NO_RUNS, NOT_FOUND } from "../run-states.js";
export { NO_STEPS } from "../run-tabs.js";
export const NO_CHANGES = "No changes yet.";
const REFRESH_MS = 30_000;
export const NO_ANSWER = "Write your answer first.";
export const ANSWER_SENT = "Answer sent — continuing";
const NOT_CANCELLED = "The run could not be cancelled. It may have just finished.";

// The header of the run page lives in ui/run-header.js; the admin page shares it.
export { firstLine, workText, runActions };
// The Approve and Reject dialog lives in ui/run-dialogs.js: the administrator's run page uses it too.
export { decisionDialog };

export { myRunsEntries };

/** One card of the list (the shared row of ui/runs-list.js): a link to the run, its status, what happens next, and Remove for a queued run. */
export const runCard = (entry, onRemove) => listRow(entry, { onRemove });

/** A yes/no dialog. Resolves true for the yes button, false for the other, Close, Escape or the backdrop. */
export async function confirmDialog(title, text, yes = "Yes", no = "No") {
  const answer = await modal(title, (close) => h("div", { class: "run-dialog" },
    h("p", { class: "flush" }, text),
    h("div", { class: "row" },
      h("button", { type: "button", class: "danger", onClick: () => close(true) }, yes),
      h("button", { type: "button", onClick: () => close(false) }, no))));
  return answer === true;
}

// ── My runs ──

/** The My runs page; refreshes every 30 seconds through the poller and never rejects. Returns a cleanup. */
export async function renderMyRuns(main, { a = api, ask = confirmDialog, readOnly = false, query = {}, go = defaultGo, views = pageViews("runs") } = {}) {
  let gen = 0; // every request takes a number; the answer or failure of an older one is dropped
  let data = null;
  let asking = false; // the Remove dialog remembers its button: the list is not drawn again until it is closed
  let live;
  // Only the repository filter counts here: a user never filters by owner.
  let filters = query.repo ? { repo: query.repo } : {};
  const alertEl = h("p", { class: "status bad", role: "alert" });
  const list = h("div");
  const sections = h("div", { class: "run-sections" });
  const slot = () => ({ el: h("div"), key: null });
  const slots = { filter: slot(), queue: slot(), cap: slot(), empty: slot() };
  const patch = (s, key, make) => {
    if (s.key === key) return;
    s.key = key;
    mount(s.el, make());
  };
  let closed = false;
  const refresh = () => live.refresh();
  mount(main, h("div", { class: "toolbar" }, h("h1", {}, "My runs"), h("span", { class: "spacer" }), h("a", { class: "btn", href: "#/start" }, "Start work")), alertEl, list);
  const states = runsLiveStates({ body: list, label: "Loading your runs", rows: 4, shape: "cards", what: "Could not load your runs.", denied: "You are not allowed to see your runs.", retry: refresh, focus: "my-runs" });

  const setFilters = (next) => {
    filters = next;
    go(withQuery("#/runs", filters));
    render();
  };
  const clear = () => setFilters({});
  const render = () => {
    if (closed || asking || !data) return;
    const { runs, queue } = data;
    const keep = (e) => !filters.repo || sameRepo(e.run?.vars?.github_repo ?? e.job?.githubRepo, filters.repo);
    // Saved views: a user filters by repository only, so no owner list is known.
    const vp = views?.parts(filters, { redraw: () => { slots.empty.key = slots.queue.key = null; render(); } }) ?? {};
    const secs = vp.stale ? [] : runSections(runs, queue.ok ? queue.value?.pending : [], keep);
    const found = secs.length > 0;
    const note = filters.repo && Array.isArray(runs) && runs.length >= RUNS_CAP ? CAP_NOTE : null;
    // The page is drawn once; each part below changes only when its own content does, so the list keeps its nodes and the focus.
    if (sections.parentNode !== list) mount(list, states.alert, slots.filter.el, slots.queue.el, sections, slots.cap.el, slots.empty.el, states.note);
    mount(slots.filter.el, filterBar(filters, { onRemove: () => setFilters({}), onClear: clear, row: vp.row, onSave: vp.onSave }));
    patch(slots.queue, JSON.stringify(queue.ok ? 1 : queue), () => (queue.ok ? null : partNote("the queue", queue, { onRetry: refresh, focus: "queue-retry", safe: "Your runs are shown. Queued runs may be missing." })));
    patch(slots.cap, JSON.stringify([found, note]), () => (found && note ? h("p", { class: "muted" }, note) : null));
    patch(slots.empty, JSON.stringify([filters, vp.stale, found, note]), () => (vp.stale ? filterEmpty("runs", filters, { onClear: clear, onDelete: vp.onDelete })
      : found ? null : filters.repo ? filterEmpty("runs", filters, { note, onClear: clear }) : noRuns()));
    sections.hidden = !found;
    renderSections(sections, secs, { onRemove: readOnly ? null : remove });
  };
  async function remove(job) {
    alertEl.textContent = "";
    asking = true;
    let yes;
    try { yes = await ask("Remove this run", "Remove this run? It leaves the queue and does not start.", "Remove the run", "Keep it"); } finally { asking = false; }
    if (closed) return;
    if (!yes) return render(); // an answer that came while the dialog was open is drawn by the poller
    try {
      const r = await a.cancelRun(job.runId);
      if (closed) return;
      if (r?.cancelled === false) alertEl.textContent = NOT_CANCELLED;
      else toast("Removed");
    } catch (e) {
      if (closed) return;
      alertEl.textContent = errorText(e);
      return render();
    }
    gen++; // an answer asked before the cancel still shows the job
    await refresh();
  }

  live = poller({
    load: async () => {
      const mine = ++gen;
      const [runs, queue] = await Promise.all([a.runs(), part(a.queue())]).catch((e) => { if (mine === gen) throw e; return []; });
      return mine === gen ? { runs, queue } : undefined;
    },
    draw: (next) => { data = next; keepScroll(list, render); },
    every: REFRESH_MS,
    onState: states.onState,
    hold: () => asking || dialogOpen(),
  });
  await live.ready;
  return () => {
    closed = true;
    live.stop();
  };
}

// ── The run page ──

/** A step as the user page draws it: no output, never a model name. */
const plain = (s) => ({ id: s.id, visit: s.visit, ok: s.ok, durationMs: s.durationMs, error: s.error, startedAt: s.startedAt, parent: s.parent, type: s.type === "claude" ? "agent" : s.type });

/** The run page. Returns a cleanup that stops the stream and the timer. */
export function renderMyRun(main, runId, { a = api, ask = confirmDialog, decide = decisionDialog, go = (hash) => { location.hash = hash; }, readOnly = false } = {}) {
  let summary = null;
  let job = null;
  let runError = null;
  let queueError = null;
  let starting = false; // the queue lists the run as active: it has no record yet, the stream sends it
  let gone = false;
  let busy = false;
  let acting = false;
  let dialogOpen = false;
  let drawn = null; // the summary the tabs last saw
  let runSeq = 0;
  let queueSeq = 0;

  const head = h("div");
  // The header is built once; its buttons carry aria-disabled, not disabled, so a button keeps the focus while a call is out.
  const header = createRunHeader({ admin: false, onAction: readOnly ? null : onAction, onFailedStep: (i) => { tabs.show("steps", { byUser: true }); timeline.open(i); }, backLabel: "Back to My runs" });
  const taskBox = h("div");
  const skillsBox = h("div");
  let mode = null; // what `head` holds: "state" (loading, not found, error) or "header"
  let stateKey = null; // the state drawn in `head`: an unchanged one is not drawn again
  const alertEl = h("p", { class: "status bad", role: "alert" });
  const log = createLog();
  const status = statusAnnouncer();
  const tabsBox = h("div");

  const setAlert = (text) => { alertEl.textContent = text; };

  // The answer form is built once and lives outside `head`, so a redraw keeps the text, the caret and the focus.
  let sending = false;
  let expectAnswers = 0;
  const answerInput = h("textarea", { name: "answer", rows: 4, "data-focus": "answer-text" });
  const answerErr = h("p", { class: "status bad flush", role: "alert" });
  const answerBtn = h("button", { type: "submit", class: "primary" }, "Send answer");
  const answerForm = h("form", { class: "run-answer", onSubmit: sendAnswer },
    h("label", { class: "field" }, h("span", {}, "Your answer"), answerInput),
    answerErr,
    h("div", { class: "row" }, answerBtn));
  answerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault?.();
      sendAnswer();
    }
  });
  const givenBox = h("div");
  const answerBox = h("div", {}, givenBox, answerForm);
  answerForm.hidden = true;
  const timeline = createTimeline({ runId, admin: false, a });
  const tabs = createTabs([
    { id: "overview", label: "Overview", ...overviewPanel({ admin: false, extra: answerBox }) },
    { id: "steps", label: "Steps", build: () => timeline.el, update: (s) => timeline.update({ ...s, history: (s.history ?? []).map(plain) }) },
    { id: "diff", label: "Changes", ...changesPanel({ view: diffView, none: NO_CHANGES, load: () => a.diff(runId) }) },
    { id: "evidence", label: "Evidence", ...evidencePanel() },
    { id: "log", label: "Logs", build: () => log.el, onShow: () => log.restore() },
  ], { initial: "overview" });
  mount(tabsBox, tabs.el);
  // The stream is made here, started below. A closed stream asks the server: a refusal or a missing run ends the view.
  const stream = runStream({
    open: () => a.events(runId),
    on: {
      update: (e) => {
        let s;
        try {
          s = JSON.parse(e.data).summary;
        } catch {
          return;
        }
        if (!s || typeof s !== "object") return;
        if (staleAfterSend(s)) return;
        runSeq++;
        summary = s;
        runError = null;
        draw();
        if (job !== null) refresh();
      },
      log: (e) => {
        let line;
        try {
          line = JSON.parse(e.data).line;
        } catch {
          return;
        }
        log.add(String(line ?? ""));
      },
    },
    onLost: () => refresh(),
    onReopen: () => log.clear(),
  });
  mount(main, head, stream.el, alertEl, status.el, tabsBox);

  /** A summary older than an answer sent here: it asks questions with fewer answers than the run now has (answers only grow). */
  const staleAfterSend = (s) => expectAnswers > 0 && !!s?.questions && (Array.isArray(s.answers) ? s.answers.length : 0) < expectAnswers;


  function draw() {
    if (dialogOpen) return;
    status.say(summary ?? (job ? { next: job.next } : null));
    drawHead();
    drawAnswer();
    if (summary && summary !== drawn) {
      const prev = drawn;
      drawn = summary;
      showFailedOnce(tabs, summary, prev);
      tabs.update(summary, prev);
    }
  }

  function drawAnswer() {
    const s = summary;
    const given = Array.isArray(s?.answers) ? s.answers : [];
    mount(givenBox, given.length
      ? h("section", { class: "card run-answers", "aria-label": "Answers given" }, h("h2", {}, "Answers given"), h("ol", {}, given.map((x) => h("li", {}, String(x?.text ?? "")))))
      : null);
    const show = !readOnly && answerable(s, job);
    if (answerForm.hidden === !show) return;
    answerForm.hidden = !show;
    if (!show) answerErr.textContent = "";
  }

  async function sendAnswer(e) {
    e?.preventDefault?.();
    if (readOnly || sending) return;
    const text = answerInput.value.trim();
    if (!text) { answerErr.textContent = NO_ANSWER; return; }
    sending = true;
    // Counted before the call: a stream update can bring the stored answer while the POST is still out.
    const had = Array.isArray(summary?.answers) ? summary.answers.length : 0;
    answerBtn.disabled = true;
    answerErr.textContent = "";
    try {
      await a.answerRun(runId, text);
    } catch (ex) {
      if (!gone) answerErr.textContent = errorText(ex);
      sending = false;
      answerBtn.disabled = false;
      return;
    }
    sending = false;
    answerBtn.disabled = false;
    if (gone) return;
    answerInput.value = "";
    // The form goes away at once; an older summary must not bring it back before the run has moved on.
    expectAnswers = Math.max(expectAnswers, had + 1);
    if (summary) summary = { ...summary, canAnswer: undefined };
    toast(ANSWER_SENT);
    draw();
    await refresh();
  }

  function drawHead() {
    const hasTabs = !!summary;
    tabsBox.hidden = !hasTabs;
    if (!summary && !job) {
      // The error to show: none while nothing failed; a 404 of the run alone is "not found"; else the queue's failure comes first.
      const starts = starting && runError?.status === 404; // no record yet: keep the skeleton until the stream sends the summary
      const err = starts ? null : runError?.status === 403 || (runError?.status === 404 && !queueError) ? runError : queueError || runError;
      mode = "state";
      stream.el.hidden = true;
      const key = `${runLoadKind(err)}|${err?.message ?? ""}`;
      if (key !== stateKey) {
        stateKey = key;
        mount(head, runLoadState(err, { back: { href: "#/runs", label: "My runs", focus: "my-runs" }, onRetry: refresh }));
      }
      return;
    }
    stateKey = null;
    stream.el.hidden = false;
    // `head` is mounted again only when it changes from one mode to the other, so the header nodes stay in the page.
    if (mode !== "header") {
      mode = "header";
      mount(head, header.el, taskBox, skillsBox);
    }
    header.update(summary, { job, busy });
    // With a run, the task and the questions are in the Overview tab; a queued job has only its task.
    mount(taskBox, summary || !job.task?.trim() ? null : h("div", { class: "card mb-16" }, h("p", { class: "flush pre-wrap" }, job.task)));
    mount(skillsBox, skillsCard(summary?.skillView, { repo: summary?.vars?.github_repo }));
  }

  async function refresh() {
    const mineRun = ++runSeq;
    const mineQueue = ++queueSeq;
    const [runP, queueP] = await Promise.allSettled([a.run(runId), a.queue()]);
    if (gone) return;
    let lostRun = false;
    let denied = false;
    if (mineRun === runSeq) {
      if (runP.status === "fulfilled" && staleAfterSend(runP.value)) {
        // older than the answer just sent: keep what we have
      } else if (runP.status === "fulfilled") {
        summary = runP.value;
        runError = null;
      } else {
        runError = runP.reason;
        const status = Number(runError?.status) || 0;
        // A refusal is the answer: the run is not shown any more (a 404 only when the stream was lost, as a queued run has no record).
        if (status === 403) { summary = null; job = null; denied = true; }
        else if (status === 404 && stream.down()) lostRun = true;
      }
    }
    if (mineQueue === queueSeq) {
      if (queueP.status === "fulfilled") {
        job = (queueP.value?.pending ?? []).find((p) => p.runId === runId) ?? null;
        starting = (queueP.value?.active ?? []).some((p) => p?.runId === runId);
        queueError = null;
      } else {
        queueError = queueP.reason;
      }
    }
    if (denied && mineRun === runSeq) { summary = null; job = null; }
    else if (lostRun && !job && !queueError && !starting) summary = null;
    draw();
  }

  async function withDialog(fn) {
    dialogOpen = true;
    try {
      return await fn();
    } finally {
      dialogOpen = false;
      draw();
    }
  }

  async function onAction(kind) {
    if (readOnly || busy || acting) return;
    acting = true;
    setAlert("");
    try {
      if (kind === "approve" || kind === "reject") {
        const sent = await withDialog(() => decide(kind, (note) => (kind === "approve" ? a.approveRun(runId, note) : a.rejectRun(runId, note))));
        if (sent) toast(kind === "approve" ? "Approved — continuing" : "Rejected");
      } else if (kind === "retry") {
        busy = true;
        draw();
        try {
          await a.resumeRun(runId);
          toast("Retrying");
        } catch (e) {
          setAlert(errorText(e));
        }
      } else {
        const yes = await withDialog(() => ask("Cancel this run", job ? "Cancel this run? It leaves the queue and does not start." : "Cancel this run? You can retry it later.", "Cancel the run", "Keep it"));
        if (!yes) return;
        busy = true;
        draw();
        try {
          const r = await a.cancelRun(runId);
          if (r?.cancelled === false) setAlert(NOT_CANCELLED);
          else toast("Cancelled");
        } catch (e) {
          setAlert(errorText(e));
        }
        if (!summary && !alertEl.textContent) return go("#/runs");
      }
      await refresh();
    } finally {
      acting = false;
      busy = false;
      if (!gone) draw();
    }
  }

  draw();
  stream.start();
  refresh();
  const timer = setInterval(() => { if (job) refresh(); }, REFRESH_MS);
  // The times in the header move on even when the stream sends only pings.
  const clock = setInterval(() => { if (mode === "header" && !dialogOpen) header.update(summary, { job, busy }); }, 60_000);
  return () => {
    gone = true;
    clearInterval(timer);
    clearInterval(clock);
    stream.close();
  };
}
