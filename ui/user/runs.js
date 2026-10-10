// My runs and the run page of a user. The server decides what a user sees and may do; these pages draw its cut-down
// answers and show its sentences when it refuses. Relative imports, so a test can load them.
import { api } from "../api.js";
import { errorText } from "../auth.js";
import { aiProps, h, modal, mount, timeAgo, toast } from "../dom.js";
import { nextStatus, whenParts, whoClass } from "../next.js";
import { answerable, createRunHeader, firstLine, runActions, workText } from "../run-header.js";
import { filterBar, filterEmpty, defaultGo, sameRepo, withQuery } from "../filters.js";
import { createLog } from "../run-output.js";
import { skillsCard } from "../run-skills.js";
import { dialogOpen, keepScroll, poller } from "../live.js";
import { decisionDialog } from "../run-dialogs.js";
import { loadInto, noRuns, part, partNote, runLoadKind, runLoadState, runStream, runsLiveStates } from "../run-states.js";
import { CAP_NOTE, RUNS_CAP, aheadText, diffView, refinementMark, statusAnnouncer, stepEntry } from "../runs.js";

export { NO_RUNS, NOT_FOUND } from "../run-states.js";
export const NO_STEPS = "No steps finished yet.";
export const NO_CHANGES = "No changes yet.";
const REFRESH_MS = 30_000;
export const NO_ANSWER = "Write your answer first.";
export const ANSWER_SENT = "Answer sent — continuing";
const NOT_CANCELLED = "The run could not be cancelled. It may have just finished.";

// The header of the run page lives in ui/run-header.js; the admin page shares it.
export { firstLine, workText, runActions };
// The Approve and Reject dialog lives in ui/run-dialogs.js: the administrator's run page uses it too.
export { decisionDialog };

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

/** One card of the list: a link to the run, its status, what happens next, and Remove for a queued run. */
export function runCard({ run, job }, onRemove) {
  const r = run;
  const n = r?.next ?? job?.next;
  const id = r?.runId ?? job.runId;
  const task = firstLine(r?.task ?? job?.task);
  const work = r ? workText(r.vars?.github_repo, r.vars?.issue) : workText(job?.githubRepo, job?.issue);
  const when = r ? ["Started", r.startedAt] : ["Queued", job?.enqueuedAt];
  return h("li", { class: `run-card${n?.who === "You" ? ` ${whoClass(n)}` : ""}` },
    h("div", { class: "row" },
      n ? nextStatus(n, `help-${id}`) : null,
      h("a", { class: "run-link", href: `#/runs/${encodeURIComponent(id)}`, "data-focus": `open-${id}` }, h("b", {}, r?.flow ?? job?.flow ?? "Queued run")),
      r?.refinement ? refinementMark(r.refinement, `ref-${id}`) : null),
    task ? h("div", {}, task) : null,
    work ? h("div", { class: "muted mono" }, work) : null,
    n ? h("p", { class: "run-next muted" }, n.text) : null,
    n && whenParts(n).length ? h("div", { class: "next-parts timing" }, whenParts(n)) : null,
    job && job.ahead > 0 ? h("div", { class: "muted" }, aheadText(job.ahead)) : null,
    h("div", { class: "row" },
      when[1] ? h("span", { class: "muted" }, `${when[0]} ${timeAgo(when[1])}`) : null,
      h("span", { class: "spacer" }),
      job && onRemove ? h("button", { type: "button", class: "small", "data-focus": `remove-${id}`, "aria-label": "Remove this run from the queue", onClick: () => onRemove(job) }, "Remove") : null));
}

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
export async function renderMyRuns(main, { a = api, ask = confirmDialog, readOnly = false, query = {}, go = defaultGo } = {}) {
  let gen = 0; // every request takes a number; the answer or failure of an older one is dropped
  let data = null;
  let asking = false; // the Remove dialog remembers its button: the list is not drawn again until it is closed
  let live;
  // Only the repository filter counts here: a user never filters by owner.
  let filters = query.repo ? { repo: query.repo } : {};
  const alertEl = h("p", { class: "status bad", role: "alert" });
  const list = h("div");
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
    if (asking || !data) return;
    const { runs, queue } = data;
    const entries = myRunsEntries(runs, queue.ok ? queue.value?.pending : []);
    const shown = filters.repo ? entries.filter((e) => sameRepo(e.run?.vars?.github_repo ?? e.job?.githubRepo, filters.repo)) : entries;
    const note = filters.repo && Array.isArray(runs) && runs.length >= RUNS_CAP ? CAP_NOTE : null;
    mount(list,
      states.alert,
      filterBar(filters, { onRemove: () => setFilters({}), onClear: clear }),
      queue.ok ? null : partNote("the queue", queue, { onRetry: refresh, focus: "queue-retry", safe: "Your runs are shown. Queued runs may be missing." }),
      shown.length
        ? [h("ul", { class: "run-cards" }, shown.map((e) => runCard(e, readOnly ? null : remove))), note ? h("p", { class: "muted" }, note) : null]
        : filters.repo ? filterEmpty("runs", filters, { note, onClear: clear }) : noRuns(),
      states.note);
  };
  async function remove(job) {
    alertEl.textContent = "";
    asking = true;
    let yes;
    try { yes = await ask("Remove this run", "Remove this run? It leaves the queue and does not start.", "Remove the run", "Keep it"); } finally { asking = false; }
    if (!yes) return render(); // an answer that came while the dialog was open is drawn by the poller
    try {
      const r = await a.cancelRun(job.runId);
      if (r?.cancelled === false) alertEl.textContent = NOT_CANCELLED;
      else toast("Removed");
    } catch (e) {
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
  return () => live.stop();
}

// ── The run page ──

/** A step as the user page draws it: no output, never a model name. */
const plain = (s) => ({ id: s.id, visit: s.visit, ok: s.ok, durationMs: s.durationMs, error: s.error, type: s.type === "claude" ? "agent" : s.type });

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
  let tab = "log";
  let runSeq = 0;
  let queueSeq = 0;
  let tabSeq = 0;

  const head = h("div");
  // The header is built once; its buttons carry aria-disabled, not disabled, so a button keeps the focus while a call is out.
  const header = createRunHeader({ admin: false, onAction: readOnly ? null : onAction, onFailedStep: () => showTab("steps"), backLabel: "Back to My runs" });
  const taskBox = h("div");
  const skillsBox = h("div");
  let mode = null; // what `head` holds: "state" (loading, not found, error) or "header"
  let stateKey = null; // the state drawn in `head`: an unchanged one is not drawn again
  const alertEl = h("p", { class: "status bad", role: "alert" });
  const log = createLog();
  const status = statusAnnouncer();
  const tabBody = h("div");
  const tabButtons = [];
  const tabsBox = h("div");

  const setAlert = (text) => { alertEl.textContent = text; };

  async function showTab(t) {
    tab = t;
    const mine = ++tabSeq;
    for (const [k, b] of tabButtons) b.setAttribute("class", k === t ? "on" : "");
    if (t === "log") return mount(tabBody, log.el);
    if (t === "steps") {
      const steps = summary?.history ?? [];
      return mount(tabBody, steps.length ? h("div", { class: "timeline" }, steps.map((s, i) => stepEntry(runId, plain(s), i))) : h("p", { class: "muted" }, NO_STEPS));
    }
    if (!summary) return mount(tabBody, h("p", { class: "muted" }, NO_CHANGES));
    await loadInto(tabBody, { loading: "Loading the changes…", load: () => a.diff(runId), draw: (d) => diffView(d, { none: NO_CHANGES }), what: "Could not load the changes.", focus: "diff-retry", current: () => !gone && tab === t && mine === tabSeq });
  }

  for (const [k, label] of [["log", "Log"], ["steps", "Steps"], ["diff", "Changes"]]) {
    const b = h("button", { type: "button", "data-tab": k, class: k === tab ? "on" : null, onClick: () => showTab(k) }, label);
    tabButtons.push([k, b]);
  }
  mount(tabsBox, h("div", { class: "seg tabs mb-12" }, tabButtons.map(([, b]) => b)), tabBody);
  mount(tabBody, log.el);

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
        const had = summary?.history?.length;
        summary = s;
        runError = null;
        draw();
        if (tab === "steps" && had !== s.history?.length) showTab("steps");
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
  mount(main, head, stream.el, alertEl, status.el, answerBox, tabsBox);

  /** A summary older than an answer sent here: it asks questions with fewer answers than the run now has (answers only grow). */
  const staleAfterSend = (s) => expectAnswers > 0 && !!s?.questions && (Array.isArray(s.answers) ? s.answers.length : 0) < expectAnswers;


  function draw() {
    if (dialogOpen) return;
    status.say(summary ?? (job ? { next: job.next } : null));
    drawHead();
    drawAnswer();
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
    const task = summary ? summary.task : job.task;
    const questions = summary?.questions;
    // The title is the first line of the task, so the full task is shown only when it is more than that (or has no title, as a queued run).
    const showTask = !!task?.trim() && (!summary || task.trim() !== firstLine(task));
    mount(taskBox, showTask || questions
      ? h("div", { class: "card mb-16" },
        showTask ? h("p", { class: "flush pre-wrap" }, task) : null,
        questions ? h("pre", { class: "mono pre-wrap wrap-anywhere", ...aiProps("questions") }, h("b", {}, "Questions"), "\n", questions) : null)
      : null);
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
        const had = summary?.history?.length;
        summary = runP.value;
        runError = null;
        if (tab === "steps" && had !== summary?.history?.length) showTab("steps");
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
