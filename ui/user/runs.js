// My runs and the run page of a user. The server decides what a user sees and may do; these pages draw its cut-down
// answers and show its sentences when it refuses. Relative imports, so a test can load them.
import { api } from "../api.js";
import { errorText } from "../auth.js";
import { aiProps, h, modal, mount, timeAgo, toast } from "../dom.js";
import { nextBlock, nextStatus, whenParts, whoClass } from "../next.js";
import { aheadText, diffView, failedStepIndex, failureCard, logBox, logLine, refinementMark, retiredLine, statusAnnouncer, stepEntry, stepRow, versionRow } from "../runs.js";

export const NO_RUNS = "No runs yet. Start work to begin.";
export const NOT_FOUND = "This run was not found. It may have been removed.";
export const NO_STEPS = "No steps finished yet.";
export const NO_CHANGES = "No changes yet.";
const REFRESH_MS = 30_000;
export const NO_ANSWER = "Write your answer first.";
export const ANSWER_SENT = "Answer sent — continuing";
const NOT_CANCELLED = "The run could not be cancelled. It may have just finished.";

/** The first line of a task. */
export const firstLine = (text) => String(text ?? "").split(/\r?\n/)[0].trim();

/** "owner/name#7", "owner/name", or "" when there is no repository. */
export const workText = (repo, issue) => (repo ? (issue ? `${repo}#${issue}` : repo) : "");

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

/** The buttons of a run page, in order: "approve", "reject", "retry", "cancel". A refinement run is continued from its session. */
export function runActions(s, queued = false) {
  const out = [];
  const own = !s.refinement && s.next?.kind !== "issue_closed" && !s.next?.retired;
  // A run that is queued again can only be cancelled: the server refuses the rest.
  if (queued || s.status === "queued") return ["cancel"];
  if (s.status === "waiting" && own) out.push("approve", "reject");
  if (["failed", "stopped", "cancelled"].includes(s.status) && own) out.push("retry");
  if (s.status === "running" || s.status === "waiting") out.push("cancel");
  return out;
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

/**
 * The Approve and Reject dialog with an optional note. `send(note)` makes the call. A refusal shows its sentence in the
 * dialog, which stays open with the note kept. Nothing closes the dialog while the call is out. Resolves true once sent.
 */
export async function decisionDialog(kind, send) {
  const approve = kind === "approve";
  let busy = false;
  const answer = await modal(approve ? "Approve" : "Reject", (close) => {
    const note = h("textarea", { name: "note", rows: 4, "aria-label": approve ? "Note (optional)" : "Why reject? (optional)" });
    const err = h("p", { class: "status bad flush", role: "alert" });
    const submitBtn = h("button", { type: "submit", class: approve ? "primary" : "danger" }, approve ? "Approve" : "Reject");
    const closeBtn = h("button", { type: "button", onClick: () => { if (!busy) close(false); } }, "Not now");
    const submit = async (e) => {
      e?.preventDefault?.();
      if (busy) return;
      busy = true;
      submitBtn.disabled = true;
      err.textContent = "";
      try {
        await send(note.value.trim());
        busy = false;
        close(true);
      } catch (ex) {
        busy = false;
        submitBtn.disabled = false;
        err.textContent = errorText(ex);
      }
    };
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault?.();
        submit();
      }
    });
    return h("form", { class: "run-dialog", onSubmit: submit },
      h("label", { class: "field" }, h("span", {}, approve ? "Note (optional)" : "Why reject? (optional)"), note),
      err,
      h("div", { class: "row" }, submitBtn, closeBtn));
  }, { busy: () => busy });
  return answer === true;
}

// ── My runs ──

/** The My runs page; refreshes every 30 seconds. Returns a cleanup. */
export async function renderMyRuns(main, { a = api, ask = confirmDialog, readOnly = false } = {}) {
  let gone = false;
  let entries = [];
  let seq = 0;
  const alertEl = h("p", { class: "status bad", role: "alert" });
  const list = h("div");
  let dialogOpen = false; // the Remove dialog remembers its button: the list is not drawn again until it is closed

  const draw = () => {
    if (dialogOpen) return;
    mount(list, entries.length
      ? h("ul", { class: "run-cards" }, entries.map((e) => runCard(e, readOnly ? null : remove)))
      : h("div", { class: "empty" }, h("p", {}, NO_RUNS), h("a", { class: "btn primary", "data-focus": "start", href: "#/start" }, "Start work")));
  };
  async function load() {
    const mine = ++seq;
    const [runs, queue] = await Promise.all([a.runs(), a.queue()]);
    if (gone || mine !== seq) return;
    entries = myRunsEntries(runs, queue?.pending);
    draw();
  }
  async function remove(job) {
    alertEl.textContent = "";
    dialogOpen = true;
    let yes;
    try {
      yes = await ask("Remove this run", "Remove this run? It leaves the queue and does not start.", "Remove the run", "Keep it");
    } finally {
      dialogOpen = false;
    }
    if (!yes) return draw(); // the newest answer that came while the dialog was open
    try {
      const r = await a.cancelRun(job.runId);
      if (r?.cancelled === false) alertEl.textContent = NOT_CANCELLED;
      else toast("Removed");
    } catch (e) {
      alertEl.textContent = errorText(e);
      return draw();
    }
    await load().catch((e) => { alertEl.textContent = errorText(e); });
  }

  mount(main, h("div", { class: "toolbar" }, h("h1", {}, "My runs"), h("span", { class: "spacer" }), h("a", { class: "btn", href: "#/start" }, "Start work")), alertEl, list);
  await load();
  const timer = setInterval(() => load().catch(() => {}), REFRESH_MS);
  return () => {
    gone = true;
    clearInterval(timer);
  };
}

// ── The run page ──

/** A step as the user page draws it: no output, never a model name. */
const plain = (s) => ({ id: s.id, visit: s.visit, ok: s.ok, durationMs: s.durationMs, error: s.error, type: s.type === "claude" ? "agent" : s.type });

const LABELS = {
  approve: { text: "Approve", cls: "primary" },
  reject: { text: "Reject", cls: "danger" },
  retry: { text: "Retry", cls: "primary", title: "Continue at the step where it stopped" },
  cancel: { text: "Cancel", cls: "danger" },
};

/** The run page. Returns a cleanup that stops the stream and the timer. */
export function renderMyRun(main, runId, { a = api, ask = confirmDialog, decide = decisionDialog, go = (hash) => { location.hash = hash; }, readOnly = false } = {}) {
  let summary = null;
  let job = null;
  let runError = null;
  let queueError = null;
  let gone = false;
  let busy = false;
  let acting = false;
  let dialogOpen = false;
  let tab = "log";
  let follow = true;
  let runSeq = 0;
  let queueSeq = 0;
  let tabSeq = 0;

  const head = h("div");
  const alertEl = h("p", { class: "status bad", role: "alert" });
  const logEl = logBox();
  const status = statusAnnouncer();
  const tabBody = h("div");
  const tabButtons = [];
  const tabsBox = h("div");
  logEl.addEventListener("scroll", () => {
    follow = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 20;
  });

  const setAlert = (text) => { alertEl.textContent = text; };

  async function showTab(t) {
    tab = t;
    const mine = ++tabSeq;
    for (const [k, b] of tabButtons) b.setAttribute("class", k === t ? "on" : "");
    if (t === "log") return mount(tabBody, logEl);
    if (t === "steps") {
      const steps = summary?.history ?? [];
      return mount(tabBody, steps.length ? h("div", { class: "timeline" }, steps.map((s, i) => stepEntry(runId, plain(s), i))) : h("p", { class: "muted" }, NO_STEPS));
    }
    if (!summary) return mount(tabBody, h("p", { class: "muted" }, NO_CHANGES));
    mount(tabBody, h("p", { class: "muted" }, "Loading the changes…"));
    let view;
    try {
      view = diffView(await a.diff(runId), { none: NO_CHANGES });
    } catch (e) {
      view = h("p", { class: "status bad", role: "alert" }, errorText(e));
    }
    if (!gone && tab === t && mine === tabSeq) mount(tabBody, view);
  }

  for (const [k, label] of [["log", "Log"], ["steps", "Steps"], ["diff", "Changes"]]) {
    const b = h("button", { type: "button", "data-tab": k, class: k === tab ? "on" : null, onClick: () => showTab(k) }, label);
    tabButtons.push([k, b]);
  }
  mount(tabsBox, h("div", { class: "seg tabs mb-12" }, tabButtons.map(([, b]) => b)), tabBody);
  mount(tabBody, logEl);

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
  mount(main, head, alertEl, status.el, answerBox, tabsBox);

  /** A summary older than an answer sent here: it asks questions with fewer answers than the run now has (answers only grow). */
  const staleAfterSend = (s) => expectAnswers > 0 && !!s?.questions && (Array.isArray(s.answers) ? s.answers.length : 0) < expectAnswers;

  const row = (k, v) => [h("dt", {}, k), h("dd", {}, v)];
  const back = () => h("a", { class: "btn ghost", href: "#/runs", "data-focus": "back", "aria-label": "Back to My runs" }, "←");

  function actionButtons(kinds) {
    if (readOnly) return null;
    return h("div", { class: "run-actions" }, kinds.map((k) => {
      const l = LABELS[k];
      const b = h("button", { type: "button", class: l.cls, title: l.title, "data-focus": `act-${k}`, onClick: () => onAction(k) }, l.text);
      // aria-disabled, not disabled: the button keeps the focus while a call is out.
      if (busy) b.setAttribute("aria-disabled", "true");
      return b;
    }));
  }

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
    const show = !readOnly && !!s &&!!s.questions && s.canAnswer === true && job === null && s.status !== "queued";
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
      const missing = runError?.status === 404 && !queueError;
      const err = !missing && (queueError || runError);
      return mount(head, missing
        ? h("div", { class: "empty" }, h("p", {}, NOT_FOUND), h("a", { href: "#/runs", "data-focus": "my-runs" }, "My runs"))
        : err
          ? h("div", { class: "empty" }, h("p", { class: "status bad", role: "alert" }, errorText(err)), h("a", { href: "#/runs", "data-focus": "my-runs" }, "My runs"))
          : h("div", { class: "row" }, h("span", { class: "spinner" }), " Loading…"));
    }
    if (!summary) {
      return mount(head,
        h("div", { class: "toolbar" }, back(), h("h1", {}, "Queued run"), nextStatus(job.next, "status-help")),
        actionButtons(runActions({ status: "queued" }, true)),
        h("section", { class: "run-now", "aria-label": "Now" }, h("h2", {}, "Now"), nextBlock(job.next), job.ahead > 0 ? h("p", { class: "muted" }, aheadText(job.ahead)) : null),
        h("div", { class: "card mb-16" },
          job.task ? h("p", { class: "flush pre-wrap" }, job.task) : null,
          h("dl", { class: "meta" }, job.flow ? row("Flow", job.flow) : null, workText(job.githubRepo, job.issue) ? row("Repository", workText(job.githubRepo, job.issue)) : null)));
    }
    const s = summary;
    const failed = s.status === "failed" && s.next?.failure;
    const queued = s.status === "queued" || job !== null;
    const steprow = stepRow(s);
    const work = workText(s.vars?.github_repo, s.vars?.issue);
    mount(head,
      h("div", { class: "toolbar" }, back(), h("h1", {}, s.flow), s.next ? nextStatus(s.next, "status-help") : null, s.refinement ? refinementMark(s.refinement, "refinement") : null),
      actionButtons(runActions(s, job !== null)),
      h("section", { class: "run-now", "aria-label": "Now" },
        h("h2", {}, "Now"),
        failed ? failureCard({ ...s, reason: undefined }, failedStepIndex(s) >= 0 ? { onStep: () => showTab("steps") } : {}) : s.next ? nextBlock(s.next) : null,
        retiredLine(s),
        queued && job && job.ahead > 0 ? h("p", { class: "muted" }, aheadText(job.ahead)) : null,
        steprow ? h("dl", { class: "meta" }, steprow) : null),
      h("div", { class: "card mb-16" },
        s.task ? h("p", { class: "flush pre-wrap" }, s.task) : null,
        s.questions ? h("pre", { class: "mono pre-wrap wrap-anywhere", ...aiProps("questions") }, h("b", {}, "Questions"), "\n", s.questions) : null,
        h("dl", { class: "meta" },
          work ? row("Repository", work) : null,
          s.branch ? row("Branch", s.branch) : null,
          versionRow(s))));
  }

  async function refresh() {
    const mineRun = ++runSeq;
    const mineQueue = ++queueSeq;
    const [runP, queueP] = await Promise.allSettled([a.run(runId), a.queue()]);
    if (gone) return;
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
      }
    }
    if (mineQueue === queueSeq) {
      if (queueP.status === "fulfilled") {
        job = (queueP.value?.pending ?? []).find((p) => p.runId === runId) ?? null;
        queueError = null;
      } else {
        queueError = queueP.reason;
      }
    }
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

  const es = a.events(runId);
  es.addEventListener("update", (e) => {
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
  });
  es.addEventListener("log", (e) => {
    let line;
    try {
      line = JSON.parse(e.data).line;
    } catch {
      return;
    }
    logEl.append(logLine(String(line ?? "")));
    if (follow) logEl.scrollTop = logEl.scrollHeight;
  });
  es.onerror = () => {
    // A stream is not a fetch: in a preview a closed stream is checked with a GET, which shows a 403 when the view has ended.
    if (es.readyState === 2 && readOnly) return void refresh();
    if (es.readyState === 2 && summary) toast("Lost connection to the run stream", "error");
  };

  draw();
  refresh();
  const timer = setInterval(() => { if (job) refresh(); }, REFRESH_MS);
  return () => {
    gone = true;
    clearInterval(timer);
    es.close();
  };
}
