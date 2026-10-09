// The header both run pages share: title, status, facts, one main button, and what happens next. It builds its nodes once
// and `update` changes only what differs, so a focused button, an open "?" note and the page position survive a stream update.
import { h, mount, timeAgo } from "./dom.js";
import { nextBlock, nextStatus } from "./next.js";
// This module and ./runs.js import each other: neither uses the other at the top level, only inside functions.
import { aheadText, failedStepIndex, failureCard, money, ownerText, refinementMark, retiredLine, stepRow, versionRow } from "./runs.js";

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
  if (["failed", "stopped", "cancelled"].includes(s.status) && own && s.state?.next) out.push("retry");
  if (s.status === "running" || s.status === "waiting") out.push("cancel");
  return out;
}

/** The title of a run: the first line of the task, else the flow. */
export const runTitle = (s) => firstLine(s?.task) || s?.flow || "Run";

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
  if (s?.flow) out.push({ key: "flow", label: "Flow", text: s.flow });
  if (admin) {
    const owner = ownerText(s?.owner, names);
    if (owner) out.push({ key: "owner", label: "Owner", text: owner });
    out.push({ key: "cost", label: "Cost", text: money(s?.totalCostUsd) });
    if (s?.workdir) out.push({ key: "workspace", label: "Workspace", text: s.workdir });
  }
  return out;
}

const KINDS = { "act-approve": "approve", "act-reject": "reject", "act-resume": "retry", "act-cancel": "cancel" };
const BASE = { approve: "", reject: "danger", retry: "", cancel: "danger" };
const TEXT = { approve: "Approve", reject: "Reject", retry: RETRY_LABEL, cancel: "Cancel" };

const mainFirst = (list) => list.sort((a, b) => Number(b.cls === "primary") - Number(a.cls === "primary"));

/**
 * The header of a run page. `onAction(kind)` makes the user buttons (Approve, Reject, Retry, Cancel); `actions(s)` gives
 * the administrator's DOM buttons instead. `onFailedStep(index)` makes "Show the failed step".
 */
export function createRunHeader({ admin = false, onAction = null, actions = null, onFailedStep = null, backLabel = "Back to Runs" } = {}) {
  const title = h("h1", {}, "Run");
  const pillBox = h("span");
  const helpBox = h("span");
  const refBox = h("span");
  const facts = h("dl", { class: "meta" });
  const box = h("div", { class: "run-actions" });
  box.hidden = true;
  const belowBody = h("div");
  const below = h("section", { class: "run-now", "aria-label": "Now" }, h("h2", {}, "Now"), belowBody);
  const el = h("div", { class: "run-header" },
    h("div", { class: "toolbar" }, h("a", { class: "btn ghost", href: "#/runs", "data-focus": "back", "aria-label": backLabel }, "←"), title, pillBox, helpBox, refBox),
    facts, box, below);

  let statusKey = null;
  let helpEl = null;
  let refKey = null;
  let belowKey = null;
  const rows = new Map();
  const entries = new Map();

  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

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
    const key = JSON.stringify([s?.status, next, admin ? s?.reason : null, job?.ahead ?? 0, s?.state?.next, step, s?.flowDef?.publish]);
    if (key === belowKey) return;
    belowKey = key;
    const idx = s ? failedStepIndex(s) : -1;
    const card = s?.status === "failed" && s.next?.failure
      ? failureCard({ next: s.next, reason: admin ? s.reason : undefined }, idx >= 0 && onFailedStep ? { onStep: () => onFailedStep(idx) } : {})
      : next ? nextBlock(next) : null;
    const meta = s && (stepRow(s) || versionRow(s)) ? h("dl", { class: "meta" }, stepRow(s), versionRow(s)) : null;
    const nodes = [card, s ? retiredLine(s) : null, job?.ahead > 0 ? h("p", { class: "muted" }, aheadText(job.ahead)) : null, meta];
    mount(belowBody, ...nodes);
    below.hidden = !nodes.some(Boolean);
  }

  function update(s, { job = null, names = null, busy = false } = {}) {
    if (!s && !job) return;
    if (s) {
      setText(title, runTitle(s));
      setStatus(s.next, s.status ?? MISSING);
      const ref = s.refinement ?? "";
      if (ref !== refKey) {
        refKey = ref;
        mount(refBox, ref ? refinementMark(ref, "refinement") : null);
      }
      setFacts(headerFacts(s, { admin, names }));
      setActions(actions ? adminActions(s) : userActions(s, job), busy);
    } else {
      setText(title, "Queued run");
      setStatus(job.next, "queued");
      if (refKey !== "") { refKey = ""; mount(refBox, null); }
      const f = [];
      if (job.flow) f.push({ key: "flow", label: "Flow", text: job.flow });
      const work = workText(job.githubRepo, job.issue);
      if (work) f.push({ key: "work", label: "Repository", text: work });
      setFacts(f);
      setActions(actions ? [] : userActions(null, job), busy);
    }
    setBelow(s, job);
  }

  return { el, update };
}
