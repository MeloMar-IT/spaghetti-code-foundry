import { api } from "./api.js";
import { h, modal, mount } from "./dom.js";
import { durationText } from "./epic-page-model.js";
import { errorState, explainError, loadingState } from "./states.js";

// The What is shared dialog (#888): the report the next push would send, as readable groups with the raw JSON under a
// disclosure, and the last report that was sent with its time and the receiver's answer. It reads
// GET /api/account/metrics-sharing/preview; the server decides every number. Opened from Today and Account settings.

export const SHARED = {
  title: "What is shared",
  never: "Never sent: repositories, branches, issues, titles, files, prompts, step outputs, account names, e-mail addresses and IP addresses. The report has only numbers and the names of built-in flows, steps and models, and the receiver keeps no IP address.",
  noneYet: "No report has been sent yet.",
  notKept: "A report was sent, but its copy is not available.",
  unreadable: "A report was sent, but its copy cannot be read.",
  stateUnreadable: "The push state cannot be read, so this is today's report so far.",
  install: "The install id is shown as zeros: it is the key to this install's data at the receiver.",
  hiddenLast: "The last report has the numbers of every account that shares; only an admin sees it in full.",
  provisional: "No earlier day is waiting, so this is today's report so far.",
  off: "An admin does not allow sharing: nothing is sent.",
  notSharing: "You do not share the metrics of your runs: your runs are not in the report that is sent.",
  unasked: "You have not answered yet: your runs are not sent until you say yes.",
  own: "This is the report of your own runs.",
  installScope: "This is the report of the runs of every account that shares.",
  raw: "The report as it is sent (JSON)",
  next: "Next report",
  last: "Last sent",
  failed: "The report could not be loaded.",
  loading: "Loading the report",
  notKnown: "not known",
  none: "none",
};

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const count = (v) => (num(v) === undefined ? SHARED.notKnown : String(v));
const usd = (v) => (num(v) === undefined ? SHARED.notKnown : `$${v.toFixed(2)}`);
const histN = (h) => (isObj(h) && Array.isArray(h.counts) ? h.counts.reduce((a, b) => a + (num(b) ?? 0), 0) : undefined);

/** A time histogram: "3, on average 12 min"; "none" when empty. */
function timeText(h) {
  const n = histN(h);
  if (n === undefined) return SHARED.notKnown;
  return n ? `${n}, on average ${durationText((num(h.sum) ?? 0) / n)}` : SHARED.none;
}

/** A count histogram (parts per split): "2, on average 3.5 parts". Never a duration. */
function partsText(h) {
  const n = histN(h);
  if (n === undefined) return SHARED.notKnown;
  return n ? `${n}, on average ${((num(h.sum) ?? 0) / n).toFixed(1)} parts` : SHARED.none;
}

const ofText = (o, a, b) => (isObj(o) ? `${count(o[a])} of ${count(o[b])}` : SHARED.notKnown);

function tokensText(t) {
  if (!isObj(t)) return SHARED.notKnown;
  const base = `${count(t.tokensIn)} in, ${count(t.tokensOut)} out`;
  return num(t.costUsd) === undefined ? base : `${base}, ${usd(t.costUsd)}`;
}

/** One row per key of a map, or one "none" row. */
function mapRows(label, m, text) {
  const keys = isObj(m) ? Object.keys(m).sort() : [];
  if (!isObj(m)) return [[label, SHARED.notKnown]];
  if (!keys.length) return [[label, SHARED.none]];
  return keys.map((k) => [`${label}: ${k}`, text(m[k])]);
}

/** The seven readable groups of a report: [{ title, rows: [[label, text]] }]. Pure. */
export function reportGroups(report) {
  const r = isObj(report) ? report : {};
  const c = isObj(r.changes) ? r.changes : {};
  const s = isObj(r.speed) ? r.speed : {};
  const sp = isObj(r.splits) ? r.splits : {};
  const rw = isObj(r.rework) ? r.rework : {};
  const q = isObj(r.quality) ? r.quality : {};
  const co = isObj(r.cost) ? r.cost : {};
  const u = isObj(r.use) ? r.use : {};
  const ended = isObj(c.runsEnded) ? `${count(c.runsEnded.succeeded)} succeeded, ${count(c.runsEnded.failed)} failed, ${count(c.runsEnded.cancelled)} cancelled` : SHARED.notKnown;
  return [
    { title: "Changes", rows: [
      ["Runs started", count(c.runsStarted)],
      ["Runs ended", ended],
      ["Work items delivered", count(c.workItemsDelivered)],
      ["Pull requests delivered", count(c.pullRequestsDelivered)],
      ["Daily releases", count(c.dailyReleases)],
    ] },
    { title: "Speed", rows: [
      ["Run time", timeText(s.runDuration)],
      ["Time in the queue", timeText(s.queueTime)],
      ["From change to pull request", timeText(s.issueToPullRequest)],
      ["Wait for an approval", timeText(s.approvalLatency)],
      ...mapRows("Step time", s.stepTime, timeText),
    ] },
    { title: "Splits", rows: [
      ["Changes split into parts", count(sp.issuesSplit)],
      ["Parts per split", sp.partsPerSplit === undefined ? SHARED.notKnown : partsText(sp.partsPerSplit)],
    ] },
    { title: "Rework", rows: [
      ["Reworked after delivery", count(rw.reworkedAfterDelivery)],
      ["Resumes", count(rw.resumes)],
      ["Step retries", count(rw.stepRetries)],
      ...mapRows("Repeated step", rw.repeatedSteps, count),
    ] },
    { title: "Quality", rows: [
      ["Tests passed the first time", ofText(q.firstPassTests, "passed", "counted")],
      ["Merged", ofText(q.mergeRate, "delivered", "counted")],
      ["Complete evidence", ofText(q.evidence, "complete", "counted")],
      ["Policy blocks", count(q.policyBlocks)],
      ["Denials", count(q.denials)],
      ["Stopped with questions", count(q.stoppedWithQuestions)],
      ["Questions answered automatically", count(q.questionsAnsweredAutomatically)],
    ] },
    { title: "Cost and models", rows: [
      ["Cost", usd(co.costUsd)],
      ["Model fallbacks", count(co.modelFallbacks)],
      ...mapRows("Model", co.byModel, tokensText),
      ...mapRows("Step", co.byStep, tokensText),
    ] },
    { title: "Use", rows: [
      ["Repositories (a count)", count(u.repositories)],
      ...mapRows("Started by", u.bySource, count),
      ...mapRows("Flow", u.byFlow, count),
    ] },
  ];
}

const groupsView = (report) =>
  h("div", { class: "stack" }, reportGroups(report).map((g) =>
    h("section", { "aria-label": g.title },
      h("h4", {}, g.title),
      h("dl", { class: "pairs" }, g.rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])))));

const rawView = (report) => h("details", {}, h("summary", {}, SHARED.raw), h("pre", {}, JSON.stringify(report, null, 2)));

const answerText = (l) => (num(l.status) !== undefined ? `${l.result} (${l.status})` : String(l.result));
const timeOf = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : String(iso ?? "");
};

function lastView(p) {
  const out = [h("h3", {}, SHARED.last)];
  const l = p.last;
  if (p.lastUnreadable) out.push(h("p", { class: "muted" }, SHARED.unreadable));
  if (!l) {
    if (!p.lastUnreadable) out.push(h("p", {}, SHARED.noneYet));
    return out;
  }
  out.push(h("p", {}, `Day ${l.day}, sent ${timeOf(l.at)}: ${answerText(l)}.`));
  if (!l.reportKept) {
    if (!p.lastUnreadable) out.push(h("p", { class: "muted" }, SHARED.notKept));
  } else if (l.report) {
    out.push(groupsView(l.report), rawView(l.report));
  } else {
    out.push(h("p", { class: "muted" }, SHARED.hiddenLast));
  }
  return out;
}

/** The dialog's content for one answer of the preview route. */
export function sharedView(given) {
  const p = isObj(given) ? given : {};
  const next = isObj(p.next) ? p.next : {};
  const intro = [p.scope === "install" ? SHARED.installScope : SHARED.own, `Day ${next.day}.`];
  const notes = [];
  if (p.stateUnreadable) notes.push(SHARED.stateUnreadable);
  else if (next.sofar) notes.push(SHARED.provisional);
  if (!p.allowed) notes.push(SHARED.off);
  else if (p.answer === "no") notes.push(SHARED.notSharing);
  else if (p.answer === "unasked") notes.push(SHARED.unasked);
  return h("div", { class: "stack metrics-shared" },
    h("h3", {}, SHARED.next),
    h("p", {}, intro.join(" ")),
    notes.map((n) => h("p", { class: "muted" }, n)),
    groupsView(next.report),
    rawView(next.report),
    lastView(p),
    h("p", {}, SHARED.never),
    h("p", { class: "muted" }, SHARED.install));
}

/** Opens the What is shared dialog: loading, then the report or the error. A late answer after it closed changes nothing. */
export function whatIsSharedDialog(a = api) {
  let closed = false;
  const done = modal(SHARED.title, () => {
    const body = h("div", {}, loadingState(SHARED.loading));
    new Promise((resolve) => resolve(a.metricsSharePreview()))
      .then((p) => {
        if (!closed) mount(body, sharedView(p));
      }, (e) => {
        if (!closed) mount(body, errorState(explainError(e, { what: SHARED.failed })));
      });
    return body;
  });
  return done.finally(() => {
    closed = true;
  });
}
