import { api } from "./api.js";
import { actorText, timeText } from "./audit.js";
import { errorText } from "./auth.js";
import { confirmDialog, h, modal, mount, table } from "./dom.js";
import { outcomeValueText } from "./outcomes.js";
import { banner, emptyState, errorState, explainError, loadingState } from "./states.js";

// The Autonomy page (#648): the level of every repository and flow, its gate, waiting requests and the history of changes.
// The server decides who may do what; this page only hides the controls that would be refused.

const SHARES = new Set(["evidence_completeness", "eval_pass_rate"]);
const ACTION_TEXT = { "autonomy-promote-request": "Promotion requested", "autonomy-promote": "Promoted", "autonomy-demote": "Demoted" };
const REASON_MAX = 200;

/** A check's value or threshold: shares as %, no value as "—", "none" as "None allowed", other text as it is. */
export function gateValueText(check, value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return SHARES.has(check?.id) ? outcomeValueText({ unit: "share" }, value) : String(value);
  return value === "none" ? "None allowed" : String(value);
}

/** The result of a check: the approval check is always pending (a person decides it), the others pass or fail. */
export function checkResult(check) {
  if (check?.id === "approval") return { label: "Pending", tone: "locked" };
  return check?.passed ? { label: "Passed", tone: "ok" } : { label: "Failed", tone: "fail" };
}

/** One line on the gate: the approval check does not count. */
export function gateText(gate) {
  const checks = (Array.isArray(gate?.checks) ? gate.checks : []).filter((c) => c.id !== "approval");
  if (gate?.passed) return "The gate passes";
  const failing = checks.filter((c) => !c.passed).length;
  return `The gate does not pass: ${failing} of ${checks.length} checks fail`;
}

const waits = (c) => c.request?.state === "pending";

/** Promote: there is a next level, the gate passes, no request waits and the levels could be read. */
export const canPromote = (c, status) => !status?.problem && !!c.next && c.gate?.passed === true && !waits(c);
/** Approve: a request waits and the server says this person may approve it. */
export const canApprove = (c, status) => !status?.problem && waits(c) && c.approval?.mayApprove === true;
/** The levels below `level`, lowest first. */
export function lowerLevels(levels, level) {
  const i = Array.isArray(levels) ? levels.indexOf(level) : -1;
  return i > 0 ? levels.slice(0, i) : [];
}
/** Demote: there is a lower level and the levels could be read. */
export const canDemote = (c, status) => !status?.problem && lowerLevels(status?.levels, c.level).length > 0;

/** The history lines grouped by what they are about (`repos:<id>` or `flows:<name>`), newest first as given. */
export function historyByTarget(entries) {
  const map = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const key = e?.target?.type === "text" ? e.target.text : undefined;
    if (typeof key !== "string") continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(e);
  }
  return map;
}

/** Who made a change; a line with no account (an automatic change) is the Foundry's. */
export const historyWho = (entry) => actorText(entry?.actor) || "the Foundry";
/** What a line says; an action this page does not know is shown as it is. */
export const actionText = (action) => ACTION_TEXT[action] ?? String(action ?? "");

const keyOf = (c) => `${c.kind}:${c.id}`;
const safeId = (c) => keyOf(c).replace(/[^\w-]/g, "-");

/**
 * The dialog of a change with a reason. `levels`: the levels to choose (one level is shown as text). `send({ to, reason })`
 * makes the call; a refusal shows its sentence in the dialog, which stays open. Resolves true once sent.
 */
export async function changeDialog({ title, levels, confirm, danger = false, send }) {
  let busy = false;
  const answer = await modal(title, (close) => {
    const err = h("p", { class: "status bad flush", role: "alert" });
    const reason = h("textarea", { name: "reason", rows: 3, maxlength: REASON_MAX, "aria-label": "Reason" });
    const level = levels.length > 1 ? h("select", { name: "to", "aria-label": "New level" }, levels.map((l) => h("option", { value: l }, l))) : null;
    const submitBtn = h("button", { type: "submit", class: danger ? "danger" : "primary" }, confirm);
    const closeBtn = h("button", { type: "button", onClick: () => { if (!busy) close(false); } }, "Not now");
    const submit = async (e) => {
      e?.preventDefault?.();
      if (busy) return;
      const text = reason.value.trim();
      if (!text) {
        err.textContent = "Give a reason.";
        reason.setAttribute("aria-invalid", "true");
        reason.focus();
        return;
      }
      reason.removeAttribute("aria-invalid");
      busy = true;
      submitBtn.disabled = true;
      err.textContent = "";
      try {
        await send({ to: level ? level.value : levels[0], reason: text });
        busy = false;
        close(true);
      } catch (ex) {
        busy = false;
        submitBtn.disabled = false;
        err.textContent = errorText(ex);
      }
    };
    return h("form", { class: "run-dialog", onSubmit: submit },
      level ? h("label", { class: "field" }, h("span", {}, "New level"), level) : h("p", {}, "New level: ", h("span", { class: "mono" }, levels[0])),
      h("label", { class: "field" }, h("span", {}, `Reason (up to ${REASON_MAX} characters)`), reason),
      err,
      h("div", { class: "row" }, submitBtn, closeBtn));
  }, { busy: () => busy });
  return answer === true;
}

const defaultNote = (what, error, onRetry) =>
  errorState(explainError(error, { what: `Could not load ${what}.`, safe: "Nothing was changed." }), { onRetry });

/** A table in a named region that Tab reaches, so a wide table scrolls in its own box. */
function region(headers, rows, label) {
  const box = table(headers, rows, { cards: true, caption: label });
  box.setAttribute("role", "region");
  box.setAttribute("tabindex", "0");
  box.setAttribute("aria-label", label);
  return box;
}

const settle = (fn) => {
  try {
    return Promise.resolve(fn()).then((value) => ({ value }), (error) => ({ error }));
  } catch (error) {
    return Promise.resolve({ error });
  }
};

/**
 * The Autonomy section. `load()` and `history(target?)` fetch the two answers, `calls` has `promote`, `approve` and `demote`,
 * `note(what, error, retry)` draws a failure. `readOnly` draws no change control. Returns `el` and `ready`, the promise of the
 * latest load (it never rejects), and `stop()`, which drops the answers still on the way.
 */
export function autonomySection({ load, history, calls, note = defaultNote, readOnly = false, dialog = changeDialog, ask = confirmDialog }) {
  let loads = 0;
  let latest = Promise.resolve();
  let acting = false;
  let status;
  let past = { entries: [], more: false };
  let failed = {};
  const open = new Set(); // the components that are open, by `kind:id`
  const full = new Map(); // the whole history of a component, when the shared page was cut
  const alert = h("p", { class: "status bad flush", role: "alert" });
  const message = h("p", { class: "status ok", role: "status" });
  const body = h("div", { class: "stack" });
  const el = h("div", { class: "autonomy stack" }, alert, message, body);

  const say = (text, bad = false) => {
    alert.textContent = bad ? text : "";
    message.textContent = bad ? "" : text;
  };

  // One action at a time; the section loads its two answers again afterwards and nothing else is redrawn.
  async function act(run) {
    if (acting) return;
    acting = true;
    say("");
    try {
      const done = await run();
      if (done) await reload(false);
    } finally {
      acting = false;
    }
  }

  const promote = (c) => act(async () => {
    const ok = await dialog({ title: `Promote ${c.name}`, levels: [c.next], confirm: "Ask for approval", send: ({ to, reason }) => calls.promote({ kind: c.kind, id: c.id, to, reason }) });
    if (ok) say(`Promotion of ${c.name} to ${c.next} requested. The owner approves it.`);
    return ok;
  });
  const demote = (c) => act(async () => {
    const ok = await dialog({ title: `Demote ${c.name}`, levels: lowerLevels(status.levels, c.level), confirm: "Demote", danger: true, send: ({ to, reason }) => calls.demote({ kind: c.kind, id: c.id, to, reason }) });
    if (ok) say(`${c.name} was demoted.`);
    return ok;
  });
  const approve = (c) => act(async () => {
    const yes = await ask({ title: `Approve ${c.name}`, text: `Move ${c.name} from ${c.level} to ${c.request.to}?`, confirm: "Approve", danger: false });
    if (!yes) return false;
    try {
      await calls.approve({ kind: c.kind, id: c.id, to: c.request.to, token: c.request.token });
    } catch (e) {
      say(errorText(e), true);
      return false;
    }
    say(`${c.name} is now at ${c.request.to}.`);
    return true;
  });

  const button = (text, focus, onClick, cls) => h("button", { type: "button", class: cls, "data-focus": focus, onClick }, text);

  function waitingBlock(list) {
    if (!list.length) return null;
    const rows = list.map((c) => {
      const ap = c.approval;
      const who = ap
        ? ap.approvers.length ? ap.approvers.map((a) => (a.selfApproved ? `${a.name} (self-approval)` : a.name)).join(", ") : "Nobody can approve it now"
        : "—";
      return h("tr", {},
        h("td", {}, c.name),
        h("td", { class: "mono" }, `${c.level} → ${c.request.to}`),
        h("td", {}, ap?.requester?.name ?? "—"),
        h("td", {}, who),
        h("td", {}, c.request.reason),
        readOnly ? null : h("td", {}, canApprove(c, status) ? button("Approve", `approve-${safeId(c)}`, () => approve(c)) : null));
    });
    return h("section", { class: "stack" }, h("h2", {}, "Waiting for approval"),
      region(["Component", "Change", "Asked by", "May approve", "Reason", readOnly ? null : "Action"], rows, "Promotion requests that wait for approval"));
  }

  function checksTable(c) {
    const rows = c.gate.checks.map((k) => {
      const r = checkResult(k);
      return h("tr", {},
        h("td", {}, k.label),
        h("td", {}, h("span", { class: `pill ${r.tone}` }, r.label)),
        h("td", { class: "mono" }, gateValueText(k, k.value)),
        h("td", { class: "mono" }, gateValueText(k, k.threshold)),
        h("td", {}, k.detail));
    });
    return region(["Check", "Result", "Value", "Threshold", "Detail"], rows, `Gate checks of ${c.name}`);
  }

  // `cut`: the server has older lines of this component than the answer holds (it returns the newest 500).
  function historyBlock(c, lines, cut, read) {
    const key = keyOf(c);
    const rows = lines.map((e) => h("tr", {},
      h("td", { class: "muted", title: e.time }, timeText(e.time)),
      h("td", {}, historyWho(e)),
      h("td", {}, actionText(e.action)),
      h("td", {}, h("span", { class: e.result === "failed" ? "pill fail" : "pill ok" }, e.result)),
      h("td", {}, e.detail ?? "")));
    return h("div", { class: "stack" }, h("h4", {}, "History"),
      failed.history ? h("p", { class: "muted" }, "The history is not available now.")
        : lines.length ? region(["When", "Who", "What", "Result", "Detail"], rows, `Changes of ${c.name}`) : h("p", { class: "muted" }, cut ? "No change of this component in the newest lines." : "No changes yet."),
      cut && read && !failed.history ? h("p", { class: "status" }, `Only the newest ${lines.length} changes of this component are shown. Older ones are not on this page.`) : null,
      cut && !read && !failed.history ? button("Show the changes of this component", `history-${safeId(c)}`, () => showAll(c)) : null);
  }

  function newestText(c) {
    if (status.runsProblem) return "Not known";
    if (!c.newestRun) return "No runs yet";
    return h("a", { href: `#/runs/${encodeURIComponent(c.newestRun.runId)}` }, c.newestRun.level);
  }

  function component(c, grouped) {
    const key = keyOf(c);
    const got = full.get(key);
    const lines = got ? got.entries : grouped.get(key) ?? [];
    const cut = got ? got.more : past.more;
    const d = h("details", { class: "stack", open: open.has(key) },
      h("summary", {}, h("strong", {}, c.name), " ", h("span", { class: "pill mono" }, c.level), " ",
        h("span", { class: "muted" }, gateText(c.gate))),
      h("p", {}, "Newest run: ", newestText(c), c.next ? ` · Next level: ${c.next}` : " · At the top level"),
      checksTable(c),
      readOnly ? null : h("div", { class: "row" },
        canPromote(c, status) ? button("Promote", `promote-${safeId(c)}`, () => promote(c), "primary") : null,
        canApprove(c, status) ? button("Approve", `approve-${safeId(c)}`, () => approve(c)) : null,
        canDemote(c, status) ? button("Demote", `demote-${safeId(c)}`, () => demote(c), "danger") : null),
      historyBlock(c, lines, cut, !!got));
    d.addEventListener("toggle", () => {
      if (d.open === true || d.getAttribute("open") !== null) open.add(key);
      else open.delete(key);
    });
    return d;
  }

  async function showAll(c) {
    const key = keyOf(c);
    try {
      const r = await history(key);
      full.set(key, { entries: Array.isArray(r?.entries) ? r.entries : [], more: r?.more === true });
      say("");
    } catch (e) {
      say(errorText(e), true);
    }
    draw();
  }

  function group(title, list, grouped) {
    return h("section", { class: "stack" }, h("h2", {}, title), list.length ? list.map((c) => component(c, grouped)) : emptyState(`No ${title.toLowerCase()}.`));
  }

  function draw() {
    if (!status) return;
    const list = Array.isArray(status.components) ? status.components : [];
    const grouped = historyByTarget(past.entries);
    const owner = status.ownerName ? `Accountable owner: ${status.ownerName}.` : "";
    mount(body,
      status.problem ? banner("error", status.problem, [{ label: "Retry", onClick: () => reload(false), focus: "problem-retry" }]) : null,
      status.runsProblem ? banner("warn", status.runsProblem, [{ label: "Retry", onClick: () => reload(false), focus: "runs-retry" }]) : null,
      failed.history ? note("the history", failed.history, () => reload(false)) : null,
      past.more && !failed.history ? h("p", { class: "status" }, `Showing the newest ${past.entries.length} changes of all components. Older ones are not on this page; a component's own changes can be read with its button.`) : null,
      owner || status.owner?.problem ? h("p", { class: "muted" }, owner, status.owner?.problem ? ` ${status.owner.problem}.` : "") : null,
      waitingBlock(list.filter(waits)),
      group("Repositories", list.filter((c) => c.kind === "repos"), grouped),
      group("Flows", list.filter((c) => c.kind === "flows"), grouped));
  }

  // `skeleton`: draw the loading state first. After an action the old page stays until both answers have come.
  function reload(skeleton = true) {
    const my = ++loads;
    if (skeleton) mount(body, loadingState("Loading the autonomy levels…", { rows: 5, shape: "list" }));
    const answers = Promise.all([settle(load), settle(history)]);
    latest = answers.then(([s, hist]) => {
      if (my !== loads) return;
      if (s.error !== undefined || !s.value || typeof s.value !== "object") {
        status = undefined;
        mount(body, note("the autonomy levels", s.error ?? new Error("The answer was empty."), () => reload(true)));
        return;
      }
      status = s.value;
      failed = hist.error !== undefined ? { history: hist.error } : {};
      past = hist.error === undefined && hist.value && Array.isArray(hist.value.entries) ? { entries: hist.value.entries, more: hist.value.more === true } : { entries: [], more: false };
      full.clear();
      draw();
    });
    return latest;
  }

  reload(true);
  return { el, get ready() { return latest; }, stop: () => { loads++; } };
}

/** The Autonomy page. Returns a function that drops the answers still on the way. */
export function renderAutonomy(main, { readOnly = false } = {}) {
  const section = autonomySection({
    load: () => api.autonomy(),
    history: (target) => api.autonomyHistory(target),
    calls: { promote: api.promoteAutonomy, approve: api.approveAutonomy, demote: api.demoteAutonomy },
    readOnly,
  });
  mount(main,
    h("div", { class: "toolbar page-head" }, h("h1", {}, "Autonomy"), h("span", { class: "muted" }, "How much each repository and flow may do on its own")),
    h("p", { class: "muted" }, "A level is earned: ask for the next one when the gate passes, and the owner approves it. A demotion takes effect at once."),
    section.el);
  return () => section.stop();
}
