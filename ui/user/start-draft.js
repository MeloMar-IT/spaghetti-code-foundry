// Start work: the draft kept in page memory (never on disk: task text must not outlive the page or reach another
// account) and the review step shown before a run starts. Pure parts first. Must not import start.js.
import { h } from "../dom.js";
import { connectionStatus } from "../repos.js";

export const REPO_FIELD = "github_repo";
export const DRAFT_LINE = "Your draft from before";
export const REVIEW_TITLE = "Review before start";
export const NO_REPOSITORY = "No repository";
export const SET_BY_FLOW = "set by the flow";
export const EMPTY_VALUE = "(empty)";
export const LIKE_USER_TEXT = "Like a normal user (published flows and your own repositories only)";
export const NOTE_REPO_FAILED = "The last connection test of this repository failed.";
export const NOTE_REPO_UNTESTED = "The connection to this repository is not tested yet.";
export const NOTE_TASK_EMPTY = "The task is empty.";
export const NOTE_SERVER = "The work runs on the server against this repository. You can cancel it from the run page.";
export const NOTE_SERVER_NO_REPO = "The work runs on the server. You can cancel it from the run page.";

let kept = null;
let revision = 0;

const copy = (d) => ({ flow: d.flow, task: d.task, values: Object.fromEntries(Object.entries(d.values ?? {}).map(([k, v]) => [k, { ...v }])) });

/** The kept draft, or null. A copy, so a caller cannot change the kept one. */
export function readDraft() {
  return kept ? copy(kept) : null;
}

/** Keeps a copy of { flow, task, values }. */
export function writeDraft(d) {
  const next = copy(d);
  // a write that changes nothing is not a new revision: a late success can still clear it
  if (kept && JSON.stringify(kept) === JSON.stringify(next)) return;
  kept = next;
  revision += 1;
}

export function clearDraft() {
  kept = null;
  revision += 1;
}

/** Changes with every write and clear: a late answer clears only the draft it was started from. */
export const draftRevision = () => revision;

/** The state the form starts from: { flow, task, values, restored }. */
export function restoreDraft(flows, draft) {
  const values = {};
  for (const f of flows) {
    values[f.name] = Object.fromEntries(f.fields.filter((x) => x.mode === "input").map((x) => [x.name, x.value]));
    const mine = draft?.values?.[f.name];
    if (!mine || typeof mine !== "object") continue;
    for (const name of Object.keys(values[f.name])) if (typeof mine[name] === "string") values[f.name][name] = mine[name];
  }
  return {
    flow: flows.find((f) => f.name === draft?.flow) ?? flows[0],
    task: String(draft?.task ?? ""),
    values,
    restored: Boolean(draft),
  };
}

const repoField = (flow) => (flow.fields ?? []).find((f) => f.name === REPO_FIELD);

/** The repository this start uses: "owner/name", or "" when none. Same rule as the review row. */
function sentRepo(flow, values) {
  const f = repoField(flow);
  if (!f) return "";
  return (f.mode === "input" ? values.vars?.[REPO_FIELD] : f.value) || "";
}

/** [{ name, label, value, fixed }] in the order shown. `values` is the body that is sent. */
export function reviewRows(flow, values, repos) {
  void repos;
  const rows = [{ name: "flow", label: "Flow", value: flow.title, fixed: false }];
  const rf = repoField(flow);
  rows.push({ name: REPO_FIELD, label: "Repository", value: sentRepo(flow, values) || NO_REPOSITORY, fixed: rf ? rf.mode !== "input" : false });
  if (flow.usesTask !== false) rows.push({ name: "task", label: "Task", value: values.task, fixed: false });
  const fields = flow.fields ?? [];
  for (const f of fields) {
    if (f.name !== REPO_FIELD && f.mode === "input" && values.vars && f.name in values.vars) rows.push({ name: f.name, label: f.label, value: values.vars[f.name], fixed: false });
  }
  for (const f of fields) {
    if (f.name !== REPO_FIELD && f.mode !== "input") rows.push({ name: f.name, label: f.label, value: f.value, fixed: true });
  }
  if (values.likeUser) rows.push({ name: "likeUser", label: "Start as", value: LIKE_USER_TEXT, fixed: false });
  return rows;
}

/** string[]: the notes, the fixed sentence last. */
export function safetyNotes(flow, values, repos) {
  const notes = [];
  const sent = sentRepo(flow, values);
  if (sent) {
    const record = (Array.isArray(repos) ? repos : []).find((r) => String(r.github).toLowerCase() === sent.toLowerCase());
    const status = record ? connectionStatus(record) : "";
    if (status === "Failed") notes.push(NOTE_REPO_FAILED);
    else if (status === "Not tested yet") notes.push(NOTE_REPO_UNTESTED);
  }
  if (flow.usesTask !== false && String(values.task ?? "").trim() === "") notes.push(NOTE_TASK_EMPTY);
  notes.push(sent ? NOTE_SERVER : NOTE_SERVER_NO_REPO);
  return notes;
}

/** { node, heading, startBtn, backBtn } */
export function reviewView({ flow, body, repos, onStart, onBack }) {
  const heading = h("h2", { tabindex: "-1" }, REVIEW_TITLE);
  const startBtn = h("button", { class: "primary", type: "button", "data-focus": "start-run", onClick: () => onStart() }, "Start");
  const backBtn = h("button", { type: "button", "data-focus": "start-back", onClick: () => onBack() }, "Back");
  const list = h("dl", { class: "start-main" }, reviewRows(flow, body, repos).map((r) => [
    h("dt", {}, r.label),
    h("dd", { class: "pre-wrap" }, r.value === "" ? EMPTY_VALUE : r.value, r.fixed ? h("small", {}, ` (${SET_BY_FLOW})`) : null),
  ]));
  const notes = h("ul", { class: "start-notes" }, safetyNotes(flow, body, repos).map((n) => h("li", {}, n)));
  const node = h("div", { class: "start-form start-review" }, heading, list, notes, h("div", { class: "row" }, startBtn, backBtn));
  return { node, heading, startBtn, backBtn };
}
