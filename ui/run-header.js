// The header both run pages share: title, status, facts, one main button, and what happens next. It builds its nodes once
// and `update` changes only what differs, so a focused button, an open "?" note and the page position survive a stream update.
import { h, mount, timeAgo } from "./dom.js";
import { pageHeader, phaseStrip } from "./kit/product.js";
import { nextBlock, nextStatus } from "./next.js";
import { PHASES, stepPhase } from "./phases.js";
import { stepCountText, withQuestions } from "./run-tabs.js";
// This module and ./runs.js import each other: neither uses the other at the top level, only inside functions.
import { aheadText, failedStepIndex, failureCard, money, ownerText, refinementMark, retiredLine } from "./runs.js";
import { STEP_TYPES } from "./step-types.js";

export const RETRY_LABEL = "Retry from the failing step";
const MISSING = "—";

/** The first line of a task. */
export const firstLine = (text) => String(text ?? "").split(/\r?\n/)[0].trim();

/** "owner/name#7", "owner/name", or "" when there is no repository. */
export const workText = (repo, issue) => (repo ? (issue ? `${repo}#${issue}` : repo) : "");

/** The buttons of a run page, in order: "approve", "reject", "retry", "cancel". A refinement run is continued from its session. */
export function runActions(s, queued = false) {
  const out = [];
  const own = !s.refinement && s.next?.kind !== "issue_closed" && !s.next?.retired;
  // A run that is queued again can only be cancelled: the server refuses the rest.
  if (queued || s.status === "queued") return ["cancel"];
  if (s.status === "waiting" && own) out.push("approve", "reject");
  // Retry needs a step to continue at.
  if (["failed", "stopped", "cancelled"].includes(s.status) && own && s.state?.next && !s.next?.splitMade) out.push("retry");
  // A stopped run can be cancelled: nothing continues it then (a refinement run is not cancelled this way).
  if (s.status === "running" || s.status === "waiting" || (s.status === "stopped" && !s.refinement)) out.push("cancel");
  return out;
}

/** The title of a change: the issue title, else the first line of the task, else "Issue #N", else "Change". Never the flow or the run ID. */
export const runTitle = (s) => firstLine(s?.issueTitle) || firstLine(s?.task) || (s?.vars?.issue ? `Issue #${s.vars.issue}` : "") || "Change";

/** One plain sentence per state of a change. A running change says what its phase is doing instead. */
export const NOW_TEXT = {
  queued: "Waiting in the queue. It starts when there is room.",
  waiting: "Waiting for a person to approve or reject.",
  questions: "It stopped and has questions for you.",
  stopped: "It stopped and needs attention.",
  failed: "It failed. See the failed step below.",
  cancelled: "It was stopped. Nothing more happens.",
  succeeded: "Done. Nothing more happens.",
};
const RUNNING_TEXT = "Working on it.";

const lastSeg = (id) => String(id ?? "").split("/").at(-1);

/**
 * The step a run is at, by its status. A stopped run's `state.next` is where it resumes, which can be an earlier step than
 * the one it stopped at, so a stopped run reads the step from its reason, and a failed one from its failed record.
 */
function stepAt(s) {
  const hist = s.history ?? [];
  const lastTop = hist.filter((r) => !r.parent).at(-1)?.id;
  if (s.status === "stopped") return /stopped at step "([^"]+)"/.exec(s.reason ?? "")?.[1] ?? lastTop ?? s.state?.next;
  if (s.status === "failed") {
    const i = failedStepIndex(s);
    return (i >= 0 ? hist[i].id : undefined) ?? lastTop ?? s.state?.next;
  }
  if (s.status === "waiting") return s.waiting?.stepId ?? s.state?.next ?? lastTop;
  if (s.status === "cancelled") return lastTop ?? s.state?.next;
  return s.state?.next ?? lastTop;
}

/**
 * The phase strip of a run: { current (0–4 or null), complete }. A run that waits in the queue again (`job`), or has not
 * started, marks nothing; a succeeded run marks every phase done.
 */
export function runPhase(s, job = null) {
  if (job || !s || s.status === "queued") return { current: null, complete: false };
  if (s.status === "succeeded") return { current: null, complete: true };
  const id = stepAt(s);
  if (!id) return { current: null, complete: false };
  const steps = s.flowDef?.steps ?? [];
  const index = steps.findIndex((st) => st.id === String(id).split("/")[0]);
  return { current: stepPhase(lastSeg(id), index >= 0 ? { index, total: steps.length } : undefined).index, complete: false };
}

/** The one sentence on what happens now. A queued retry (`job`) is queued, whatever the run did before. */
export function nowText(s, job = null) {
  if (job || !s) return NOW_TEXT.queued;
  if (s.status === "running") {
    const { current } = runPhase(s);
    return current === null ? RUNNING_TEXT : PHASES[current].line;
  }
  // The questions of an answered run stay in its summary: only a run that is stopped now is asking.
  if (s.status === "stopped" && withQuestions(s).questions) return NOW_TEXT.questions;
  return NOW_TEXT[s.status] ?? "";
}

/** The rows of "Technical details" as [{ key, label, text }]: what a person rarely needs, and what support asks for. */
export function techRows(s, { admin = false, job = null } = {}) {
  const out = [];
  const add = (key, label, text) => { if (text) out.push({ key, label, text }); };
  add("runId", "Run ID", s?.runId ?? job?.runId);
  add("flow", "Flow", s?.flow ?? job?.flow);
  add("version", "Flow version", s?.flowDef?.publish?.enabled ? String(s.flowDef.publish.version) : "");
  if (s) {
    add("steps", "Steps", stepCountText(s));
    const id = s.state?.next;
    if (id && s.status !== "succeeded") {
      const step = s.flowDef?.steps?.find((st) => st.id === id);
      const about = step?.description || (step?.type === "agent" ? "Agent" : STEP_TYPES[step?.type]?.label) || "";
      add("step", s.status === "running" ? "Current step" : "Resumes at step", about ? `${id} — ${about}` : id);
    }
    if (admin) add("workspace", "Workspace", s.workdir);
    add("reason", "Reason", s.reason && !(s.status === "failed" && s.next?.failure) ? s.reason : "");
  }
  return out;
}

/** True when the user page shows the answer form for this run (the page adds "not read-only"). */
export const answerable = (s, job = null) => !!s?.questions && s.canAnswer === true && job === null && s.status !== "queued";

/** The kind to fill: Approve, else Retry, else none. Cancel is never filled. */
export const mainAction = (kinds) => ["approve", "retry"].find((k) => kinds.includes(k)) ?? null;

const span = (ms) => {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const hours = Math.floor(m / 60);
  return hours < 24 ? `${hours}h ${m % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

function timing(s, now) {
  const start = Date.parse(s?.startedAt ?? "");
  if (Number.isNaN(start)) return { started: MISSING, duration: MISSING, live: false };
  const started = timeAgo(s.startedAt, now);
  let end = Date.parse(s.finishedAt ?? "");
  if (s.status === "running" || (Number.isNaN(end) && (s.status === "waiting" || s.status === "queued"))) end = now;
  const live = end === now;
  if (Number.isNaN(end) || end < start) return { started, duration: MISSING, live: false };
  const progress = live ? s.next?.timing?.progress : "";
  return { started, duration: `${span(end - start)}${progress ? ` · ${progress}` : ""}`, live };
}

/** { started, duration } of a run, from `startedAt`, `finishedAt` and `next.timing`. "—" for what is missing. */
export function runTiming(s, now = Date.now()) {
  const { started, duration } = timing(s, now);
  return { started, duration };
}

const RETRY_OUTCOMES = { finished: "it finished", split: "it was split", failed: "it failed", cancelled: "it was cancelled", open: "it is still open" };

/** The sentence about automatic retries after a time limit, from `retries` as the server works it out. */
export function retryText(r) {
  const n = Number(r?.started) || 0;
  if (!n) return "An automatic retry after a time limit is waiting";
  const count = `${n} automatic ${n === 1 ? "retry" : "retries"} after a time limit`;
  return `${count} — ${r.waiting ? "the next one is waiting" : (RETRY_OUTCOMES[r.outcome] ?? RETRY_OUTCOMES.open)}`;
}

/** The facts of the header as [{ key, label, text }]. Cost, owner and workspace are read for an administrator only. */
export function headerFacts(s, { admin = false, names = null, now = Date.now() } = {}) {
  const repo = s?.vars?.github_repo;
  const work = repo ? (s.vars.issue ? `${repo}#${s.vars.issue}` : s.vars.pr ? `${repo} PR #${s.vars.pr}` : repo) : "";
  const t = timing(s, now);
  const out = [
    { key: "work", label: "Repository", text: work || MISSING },
    { key: "branch", label: "Branch", text: s?.branch || MISSING },
    { key: "started", label: "Started", text: t.started },
    { key: "duration", label: t.live ? "Running for" : "Ran for", text: t.duration },
  ];
  if (s?.resumes) out.push({ key: "resumes", label: "", text: `resumed ${s.resumes}×` });
  if (s?.retries) out.push({ key: "retries", label: "", text: retryText(s.retries) });
  if (admin) {
    const owner = ownerText(s?.owner, names);
    if (owner) out.push({ key: "owner", label: "Owner", text: owner });
    out.push({ key: "cost", label: "Cost", text: money(s?.totalCostUsd) });
  }
  return out;
}

const KINDS = { "act-approve": "approve", "act-reject": "reject", "act-resume": "retry", "act-cancel": "cancel" };
const BASE = { approve: "", reject: "danger", retry: "", cancel: "danger" };
const TEXT = { approve: "Approve", reject: "Reject", retry: RETRY_LABEL, cancel: "Stop this change…" };

const mainFirst = (list) => list.sort((a, b) => Number(b.cls === "primary") - Number(a.cls === "primary"));

/**
 * The header of a run page. `onAction(kind)` makes the user buttons (Approve, Reject, Retry, Cancel); `actions(s)` gives
 * the administrator's DOM buttons instead. `onFailedStep(index)` makes "Show the failed step".
 */
export function createRunHeader({ admin = false, onAction = null, actions = null, onFailedStep = null, onTitle = null, backLabel = "Back to Runs" } = {}) {
  const pillBox = h("span");
  const helpBox = h("span");
  const refBox = h("span");
  const bar = pageHeader({ layout: "toolbar", title: "Change", back: { label: backLabel, href: "#/runs", focus: "back" }, meta: [pillBox, helpBox, refBox] });
  const title = bar.querySelector("h1");
  const facts = h("dl", { class: "meta" });
  const box = h("div", { class: "run-actions" });
  box.hidden = true;
  const belowBody = h("div");
  const nowLine = h("p", { class: "run-now-line" });
  const below = h("section", { class: "run-now", "aria-label": "Now" }, h("h2", {}, "Now"), nowLine, belowBody);
  const stripBox = h("div", { class: "run-phases" });
  const techBody = h("dl", { class: "meta" });
  const tech = h("details", { class: "run-tech", "data-part": "tech" }, h("summary", { "data-focus": "tech-details" }, "Technical details"), techBody);
  tech.hidden = true;
  const el = h("div", { class: "run-header" }, bar, stripBox, below, box, facts, tech);

  let titleText = null;
  let stripKey = null;
  let techKey = null;
  let statusKey = null;
  let helpEl = null;
  let refKey = null;
  let belowKey = null;
  const rows = new Map();
  const entries = new Map();

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  function setTitle(text) {
    setText(title, text);
    if (text !== titleText) {
      titleText = text;
      onTitle?.(text);
    }
  }

  // The strip is drawn again only when the phase changes.
  function setStrip(s, job) {
    const p = runPhase(s, job);
    const key = `${p.current}|${p.complete}`;
    if (key === stripKey) return;
    stripKey = key;
    stripBox.replaceChildren(phaseStrip({ label: "Progress", phases: PHASES.map((x) => x.word), current: p.current, complete: p.complete }));
  }

  // Only the list inside is drawn again, so a person's open "Technical details" stays open.
  function setTech(s, job) {
    const rows = techRows(s, { admin, job });
    const key = JSON.stringify(rows);
    if (key === techKey) return;
    techKey = key;
    techBody.replaceChildren(...rows.flatMap((r) => [h("dt", {}, r.label), h("dd", { "data-fact": `tech-${r.key}`, class: r.key === "reason" ? "pre-wrap" : null }, r.text)]));
    tech.hidden = rows.length === 0;
  }

  function setStatus(next, fallback) {
    const key = next ? JSON.stringify([next.kind, next.who, next.status]) : `p:${fallback}`;
    if (key !== statusKey) {
      statusKey = key;
      pillBox.replaceChildren(next ? nextStatus(next, "status-help")[0] : h("span", { class: "pill" }, fallback));
    }
    // The "?" is built once; a new text goes into the same note, so an open note stays open.
    const text = next?.help || "";
    if (text && !helpEl) {
      helpEl = nextStatus(next, "status-help")[1];
      helpBox.append(helpEl);
    }
    if (helpEl && text) setText(helpEl.querySelector("[role]"), text);
    if (helpBox.hidden !== !text) helpBox.hidden = !text;
  }

  function setFacts(list) {
    const nodes = [];
    for (const f of list) {
      let r = rows.get(f.key);
      if (!r) rows.set(f.key, r = { dt: h("dt"), dd: h("dd", { "data-fact": f.key }) });
      setText(r.dt, f.label);
      setText(r.dd, f.text);
      nodes.push(r.dt, r.dd);
    }
    const cur = facts.children;
    if (cur.length !== nodes.length || nodes.some((n, i) => cur[i] !== n)) facts.replaceChildren(...nodes);
  }

  /** list: [{ key, sig, node(), cls, user }]. A control whose signature is unchanged is kept, and its focus with it. */
  function setActions(list, busy) {
    const active = document.activeElement;
    const focusKey = active && box.contains(active) ? active.getAttribute("data-focus") : null;
    const want = [];
    for (const d of list) {
      const old = entries.get(d.key);
      const node = old && old.sig === d.sig ? old.el : d.node();
      entries.set(d.key, { el: node, sig: d.sig });
      if ((node.getAttribute("class") ?? "") !== d.cls) {
        if (d.cls) node.setAttribute("class", d.cls);
        else node.removeAttribute("class");
      }
      if (d.user) {
        if (busy) { if (node.getAttribute("aria-disabled") !== "true") node.setAttribute("aria-disabled", "true"); }
        else if (node.getAttribute("aria-disabled") !== null) node.removeAttribute("aria-disabled");
      }
      want.push(node);
    }
    const keys = new Set(list.map((d) => d.key));
    for (const k of [...entries.keys()]) if (!keys.has(k)) entries.delete(k);
    for (const c of [...box.children]) if (!want.includes(c)) c.remove();
    want.forEach((n, i) => { if (box.children[i] !== n) box.insertBefore(n, box.children[i] ?? null); });
    // A control that was replaced gives the focus to its successor.
    if (focusKey && !box.contains(document.activeElement)) entries.get(focusKey)?.el.focus();
    const hide = want.length === 0;
    if (box.hidden !== hide) box.hidden = hide;
  }

  function adminActions(s) {
    const nodes = actions ? actions(s) : [];
    const kinds = nodes.map((n) => KINDS[n.getAttribute("data-focus")]).filter(Boolean);
    const main = mainAction(kinds);
    const list = nodes.map((n) => {
      const key = n.getAttribute("data-focus");
      return { key, sig: `${key}|${n.textContent}|${n.getAttribute("title") ?? ""}`, node: () => n, cls: KINDS[key] && KINDS[key] === main ? "primary" : n.getAttribute("class") ?? "" };
    });
    if (admin && s.flow) {
      const href = `#/flows/${encodeURIComponent(s.flow)}`;
      list.push({ key: "open-flow", sig: href, node: () => h("a", { class: "btn", "data-focus": "open-flow", href }, "Open flow"), cls: "btn" });
    }
    return mainFirst(list);
  }

  function userActions(s, job) {
    if (!onAction) return [];
    const kinds = s ? runActions(s, job !== null) : ["cancel"];
    const main = s && answerable(s, job) ? null : mainAction(kinds);
    return mainFirst(kinds.map((kind) => {
      const title = kind === "retry" ? (s?.state?.next ? `Continue at step "${s.state.next}"` : "Continue at the step where it stopped") : "";
      return {
        key: `act-${kind}`, user: true, cls: kind === main ? "primary" : BASE[kind], sig: `${kind}|${title}`,
        node: () => h("button", { type: "button", "data-focus": `act-${kind}`, title: title || null, onClick: () => onAction(kind) }, TEXT[kind]),
      };
    }));
  }

  function setBelow(s, job) {
    const next = s?.next ?? job?.next;
    const step = s?.flowDef?.steps?.find((st) => st.id === s.state?.next);
    const now = nowText(s, job);
    setText(nowLine, now);
    const key = JSON.stringify([s?.status, next, admin ? s?.reason : null, job?.ahead ?? 0, s?.state?.next, step, s?.flowDef?.publish]);
    if (key === belowKey) return;
    belowKey = key;
    const idx = s ? failedStepIndex(s) : -1;
    const card = s?.status === "failed" && s.next?.failure
      ? failureCard({ next: s.next, reason: admin ? s.reason : undefined }, idx >= 0 && onFailedStep ? { onStep: () => onFailedStep(idx) } : {})
      : next ? nextBlock(next) : null;
    const nodes = [card, s ? retiredLine(s) : null, job?.ahead > 0 ? h("p", { class: "muted" }, aheadText(job.ahead)) : null];
    mount(belowBody, ...nodes);
  }

  function update(s, { job = null, names = null, busy = false } = {}) {
    if (!s && !job) return;
    if (s) {
      setTitle(runTitle(s));
      setStatus(s.next, s.status ?? MISSING);
      const ref = s.refinement ?? "";
      if (ref !== refKey) {
        refKey = ref;
        mount(refBox, ref ? refinementMark(ref, "refinement") : null);
      }
      setFacts(headerFacts(s, { admin, names }));
      setActions(actions ? adminActions(s) : userActions(s, job), busy);
    } else {
      setTitle(firstLine(job.task) || (job.issue ? `Issue #${job.issue}` : "") || "Queued change");
      setStatus(job.next, "queued");
      if (refKey !== "") { refKey = ""; mount(refBox, null); }
      const f = [];
      const work = workText(job.githubRepo, job.issue);
      if (work) f.push({ key: "work", label: "Repository", text: work });
      setFacts(f);
      setActions(actions ? [] : userActions(null, job), busy);
    }
    setStrip(s, job);
    setTech(s, job);
    setBelow(s, job);
  }

  return { el, update };
}
