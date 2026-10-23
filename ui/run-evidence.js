// The Evidence record section of a run page. It draws the answer of GET /api/runs/:id/evidence (see
// src/server/evidence-view.ts) and decides nothing. Every value goes in as text, never as HTML. A user's display shows
// file kinds and counts, never paths, and no link leads to the content of a file. Relative imports, so a test can load it.
import { h, mount } from "./dom.js";
import { errorState, explainError } from "./states.js";
import { timeText } from "./run-tabs.js";

export const RECORD_TITLE = "Evidence record";
export const VERIFY_LABELS = { verified: "Verified", failed: "Not verified", "not-finalized": "Not finished", absent: "No record" };
export const RESULT_LABELS = { succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled" };
export const FILE_STATE_LABELS = { ok: "unchanged", changed: "changed", missing: "missing", unreadable: "not readable" };
export const KIND_LABELS = { log: "a step log", transcript: "a step transcript", diff: "the stored changes", flow: "the flow definition", "skill-lock": "the skill lock", "test-report": "a test report", other: "a file of the run" };
export const ACTOR_LABELS = { user: "a signed-in user", cli: "the command line", watcher: "a watcher", system: "the Foundry" };
export const NO_TESTS = "No test results recorded";
export const NO_POLICIES = "No policy denials recorded";
export const NO_DECISIONS = "No policy decisions recorded";
export const OUTCOME_LABELS = { allow: "Allowed", warn: "Warning", require_approval: "Needs approval", deny: "Denied" };
export const MODE_LABELS = { observe: "observe only", enforce: "enforced" };

const LIVE = ["queued", "running", "waiting", "stopped"];
const TONES = { verified: "ok", failed: "fail", "not-finalized": "warn", absent: "neutral" };
const PILL = { ok: "ok", fail: "fail", warn: "sem-warning", neutral: "sem-neutral" };
const WHAT = {
  "file-changed": "was changed after the run ended",
  "file-missing": "is gone, and the record needs it",
  "file-unreadable": "is no longer a plain file of the run",
  "chain-unsupported-version": "was written by a newer version of the Foundry",
  "events-added": "has more events than the manifest",
  "events-removed": "has fewer events than the manifest",
  "terminal-hash": "was written again",
  "events-cut": "ends in a line that was cut off",
  "events-missing": "is gone",
  "events-unreadable": "cannot be read",
  "manifest-changed": "does not say what the events say",
  "manifest-run": "belongs to another run",
  "manifest-unreadable": "cannot be read",
  "manifest-version": "was written by a newer version of the Foundry",
  incomplete: "stopped while the run was going",
  "flow-missing": "cannot be read",
  "flow-changed": "was changed after the run ended",
};
// Codes where the record does not match what was written: the only ones that point to a change after the run.
const CHANGED = new Set(["file-changed", "flow-changed", "manifest-changed", "terminal-hash", "events-added", "events-removed", "events-cut"]);

const short = (c) => String(c ?? "").slice(0, 7);
const list = (v) => (Array.isArray(v) ? v : []);
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const safeName = (id) => String(id ?? "").replace(/[^\w-]/g, "_");

function failureGroup(code) {
  if (code === "incomplete") return "incomplete";
  if (code === "manifest-version" || code === "chain-unsupported-version") return "update";
  if (code === "not-finalized") return "not-finalized";
  if (CHANGED.has(code) || (typeof code === "string" && code.startsWith("chain-"))) return "changed";
  return "other";
}

function failureWhere(f, view, admin) {
  if (f.line != null) return admin ? `evidence.jsonl, line ${f.line}` : `Event ${f.line} of the event record`;
  if (f.path != null) {
    if (admin) return String(f.path);
    if (f.path === "run.json") return "The flow definition stored with the run";
    const a = list(view?.artifacts).find((x) => x?.path === f.path);
    return a && KIND_LABELS[a.kind] ? cap(KIND_LABELS[a.kind]) : "A file of the run";
  }
  if (f.check === "manifest" || f.check === "content") return admin ? "evidence.json" : "The manifest";
  return admin ? "evidence.jsonl" : "The event record";
}

function failureWhat(f, admin) {
  if (admin) return String(f.message ?? "");
  const code = String(f.code ?? "");
  if (WHAT[code]) return WHAT[code];
  return code.startsWith("chain-") ? "does not match its hash or its place in the chain" : "does not verify";
}

function failureNext(code, admin, runId) {
  const g = failureGroup(code);
  if (g === "incomplete") {
    const base = "The run itself is not affected, but this record cannot be verified.";
    return admin ? `${base} Look in the run's log for the line that starts with "! evidence:".` : `${base} Ask an administrator if you need a verified record.`;
  }
  if (g === "update") return "Update the Foundry, then press Check again.";
  if (g === "not-finalized") return admin ? 'Look in the run\'s log for "! evidence: no manifest was written".' : "Ask an administrator why the record could not be finished.";
  if (g === "changed") {
    return admin
      ? `Compare the file with a backup of the run folder, or check it again on the server with "scf evidence verify ${runId}".`
      : "Export the evidence to keep this result, and tell an administrator that the record does not match what was written when the run ended.";
  }
  return admin
    ? `Look at the run folder for the file named above, or check it again on the server with "scf evidence verify ${runId}".`
    : "Export the evidence to keep this result, and tell an administrator that the record does not verify.";
}

function fileLines(view, admin) {
  const arts = list(view?.artifacts);
  if (admin) {
    return arts.map((a) => `${a.kind} ${a.path} — ${FILE_STATE_LABELS[a.state] ?? "not checked"}${a.required === false ? " (optional)" : ""}`);
  }
  if (!arts.length) return ["None"];
  const counts = new Map();
  for (const a of arts) {
    const k = FILE_STATE_LABELS[a?.state] ?? "not checked";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const n = arts.length;
  const parts = counts.size === 1 && counts.has("unchanged") ? "all unchanged" : [...counts].map(([k, c]) => `${c} ${k}`).join(", ");
  return [`${n} ${n === 1 ? "file" : "files"}: ${parts}`];
}

/** The policy decisions of the view as lines of text. A user never gets the rule or the pack hash, even if the view has them. */
function decisionsOf(view, admin) {
  const pd = view?.policyDecisions;
  const out = { decisions: [], decisionsNote: "" };
  if (!pd || typeof pd !== "object") return out;
  out.decisions = list(pd.groups).map((g) => {
    const mode = g.reasonCode === "policy.break-glass" ? "break-glass" : (MODE_LABELS[g.mode] ?? String(g.mode ?? ""));
    const outcome = OUTCOME_LABELS[g.outcome] ?? String(g.outcome ?? "");
    const at = (t) => timeText(t) || String(t ?? "");
    const n = Number(g.count) || 0;
    const steps = list(g.steps);
    const more = Number(g.moreSteps) || 0;
    const stepText = steps.length ? ` · Steps: ${steps.join(", ")}${more ? ` and ${more} more` : ""}` : "";
    const when = `${n <= 1 ? `Once, ${at(g.firstAt)}` : `${n} times, ${at(g.firstAt)} to ${at(g.lastAt)}`}${stepText}`;
    const extra = admin && (g.rule || g.packSha256) ? [g.rule && `Rule ${g.rule}`, g.packSha256 && `pack ${String(g.packSha256).slice(0, 12)}`].filter(Boolean).join(" · ") : "";
    return {
      head: `${outcome} (${mode}) at ${g.boundary} · ${g.policy?.id} ${g.policy?.version} · ${g.reasonCode}`,
      why: String(g.reason ?? ""),
      next: `What to do: ${g.next ?? ""}`,
      when,
      ...(extra ? { extra } : {}),
    };
  });
  const notes = [];
  if (Number(pd.omittedGroups) > 0) notes.push(`${pd.omittedGroups} more kinds of decisions are not shown; the run's log has every one.`);
  if (pd.complete === false) notes.push("The event record is not whole, so this list may be short.");
  out.decisionsNote = notes.join(" ");
  return out;
}

/**
 * Pure. view: the answer of GET /api/runs/:id/evidence (or undefined). ended: false while the run is queued, running,
 * waiting or stopped. A user never gets models, policies, paths or account ids, even if the view has them.
 */
export function evidenceRecordModel(view, { admin = false, ended = true, runId = view?.runId ?? "" } = {}) {
  const v = view?.verification;
  const status = v && VERIFY_LABELS[v.status] ? v.status : "absent";
  const model = { tone: TONES[status], label: VERIFY_LABELS[status], text: "", rows: [], failure: null, ...decisionsOf(view, admin) };
  const f = v?.failure;
  if (status === "verified") {
    const n = list(v.missingOptional).length;
    model.text = admin ? String(v.explanation ?? "") : `The record of this run is whole and unchanged.${n ? ` ${n} optional ${n === 1 ? "file is" : "files are"} no longer there; that is allowed.` : ""}`;
  } else if (status === "failed") {
    model.text = "The record of this run does not verify. See below.";
    if (f) model.failure = { where: failureWhere(f, view, admin), what: failureWhat(f, admin), next: failureNext(f.code, admin, runId) };
  } else if (status === "not-finalized") {
    if (!ended) model.text = "The record is finished when the run ends.";
    else {
      model.text = "The run ended, but its record could not be finished.";
      model.failure = { where: "The record", what: "was not finished", next: failureNext("not-finalized", admin, runId) };
    }
  } else {
    model.text = "This run has no evidence record. It was made before evidence existed, or a clean-up removed it.";
  }
  const m = view?.manifest;
  if (view?.state !== "available" || !m) return model;

  const rows = model.rows;
  const row = (label, lines, href) => rows.push({ label, lines, ...(href ? { href } : {}) });
  row("Result", [RESULT_LABELS[m.status] ?? String(m.status ?? "")]);
  row("Flow", [String(m.flow?.name ?? "")]);
  row("Flow version", [m.flow?.version != null ? String(m.flow.version) : "Not published"]);
  const g = m.git ?? {};
  const commits = [g.repository && `Repository ${g.repository}`, g.branch && `Branch ${g.branch}`, g.base && `Started from ${short(g.base)}`, g.final && `Ended at ${short(g.final)}`].filter(Boolean);
  row("Commits", commits.length ? commits : ["None recorded"]);
  if (admin && Array.isArray(m.models)) {
    row("Models", m.models.length ? m.models.map((x) => `${x.agent} · ${x.provider} · ${x.model}${x.effort ? ` · ${x.effort} effort` : ""}`) : ["None"]);
  }
  const approvals = list(m.approvals).map((a) => {
    const who = ACTOR_LABELS[a.by?.kind] ?? "someone";
    const id = admin && a.by?.id ? ` (${a.by.id})` : "";
    return `${a.decision === "rejected" ? "Rejected" : "Approved"} at ${a.step?.id ?? ""} by ${who}${id}${timeText(a.time) ? ` · ${timeText(a.time)}` : ""}`;
  });
  row("Approvals", approvals.length ? approvals : ["None"]);
  const tests = list(m.tests).map((t) => {
    const r = t.result ?? {};
    const counts = [["passed", r.passed], ["failed", r.failed], ["skipped", r.skipped]].filter(([, n]) => typeof n === "number").map(([k, n]) => `${n} ${k}`);
    return `${r.suite ?? ""}: ${r.outcome === "failed" ? "failed" : "passed"}${counts.length ? ` (${counts.join(", ")})` : ""}`;
  });
  row("Tests", tests.length ? tests : [NO_TESTS]);
  if (admin && Array.isArray(m.policies)) {
    row("Recorded policy denials", m.policies.length ? m.policies.map((p) => `Denied by ${p.id} version ${p.version}`) : [NO_POLICIES]);
  }
  const pr = m.pullRequest;
  if (pr) row("Pull request", [`#${pr.number} in ${pr.repository}`], pr.url);
  else row("Pull request", ["None"]);
  row("Files", fileLines(view, admin));
  return model;
}

/** The file of Export evidence: exactly the API answer, pretty-printed. */
export function evidenceExport(view, runId) {
  return { name: `evidence-${safeName(runId)}.json`, text: `${JSON.stringify(view, null, 2)}\n` };
}

/** The browser download. Not unit-tested: the section takes it as `save`. */
export function saveFile(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = h("a", { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

let counter = 0;

function rowNodes(r, admin) {
  const files = admin && r.label === "Files" && r.lines.length > 0 && r.lines[0] !== "None";
  let dd;
  if (r.href) dd = h("a", { href: r.href, target: "_blank", rel: "noopener", class: "wrap-anywhere" }, r.lines[0]);
  else if (files) dd = h("details", {}, h("summary", {}, `Files (${r.lines.length})`), h("ul", { class: "flush" }, r.lines.map((l) => h("li", { class: "mono wrap-anywhere" }, l))));
  else dd = r.lines.map((l, i) => [i ? h("br") : null, l]);
  return [h("dt", {}, r.label), h("dd", { class: "wrap-anywhere" }, dd)];
}

/**
 * The section placed by evidencePanel({ record }). load: () => Promise<view>. It loads when built, on Check again, when
 * the run finishes, and again when a finished run is resumed (the old record is dropped at once).
 */
export function evidenceRecordSection({ load, admin = false, runId, save = saveFile }) {
  const uid = `ev${++counter}`;
  const statusEl = h("p", { role: "status" });
  const body = h("div");
  const alertEl = h("p", { class: "status bad", role: "alert" });
  const refresh = h("button", { type: "button", "data-focus": "evidence-refresh", onClick: () => reload().catch(() => {}) }, "Check again");
  const exportBtn = h("button", { type: "button", "data-focus": "evidence-export", onClick: () => doExport().catch(() => {}) }, "Export evidence");
  let seq = 0;
  let view;
  let loaded = false;
  let ended = true;
  let key = null;
  let bodyKey = null;

  function draw(error) {
    const m = evidenceRecordModel(view, { admin, ended, runId });
    const sKey = JSON.stringify([loaded, m.tone, m.label, m.text]);
    if (sKey !== key) {
      key = sKey;
      mount(statusEl, loaded ? [h("span", { class: `pill ${PILL[m.tone]}` }, m.label), " ", m.text] : "");
    }
    const bKey = error ? `error:${error.what}` : loaded ? JSON.stringify([m.rows, m.failure, m.decisions, m.decisionsNote]) : "loading";
    if (bKey === bodyKey) return;
    bodyKey = bKey;
    if (error) mount(body, errorState(error, { onRetry: () => reload().catch(() => {}), focus: "evidence-retry" }));
    else if (!loaded) mount(body, h("p", { class: "muted" }, "Loading the evidence record…"));
    else {
      mount(body, [
        m.rows.length ? h("dl", { class: "meta" }, m.rows.map((r) => rowNodes(r, admin))) : null,
        m.failure ? h("div", { class: "card", role: "group", "aria-labelledby": `${uid}-f` },
          h("h4", { id: `${uid}-f` }, "Verification failed"),
          h("p", { class: "wrap-anywhere" }, `${m.failure.where} ${m.failure.what}.`),
          h("p", { class: "wrap-anywhere" }, h("b", {}, "What to do: "), m.failure.next)) : null,
        h("h4", {}, "Policy decisions"),
        m.decisions.length
          ? h("ul", { class: "flush" }, m.decisions.map((d) => h("li", { class: "wrap-anywhere" }, h("b", {}, d.head), h("br"), d.why, h("br"), d.next, h("br"), d.when, d.extra ? [h("br"), d.extra] : null)))
          : h("p", { class: "muted" }, NO_DECISIONS),
        m.decisionsNote ? h("p", { class: "muted" }, m.decisionsNote) : null,
      ]);
    }
  }

  async function reload() {
    const mine = ++seq;
    refresh.disabled = true;
    try {
      const v = await load();
      if (mine !== seq) return;
      view = v;
      loaded = true;
      refresh.disabled = false;
      draw();
    } catch (e) {
      if (mine !== seq) return;
      loaded = false;
      view = undefined;
      refresh.disabled = false;
      draw(explainError(e, { what: "Could not load the evidence record." }));
    }
  }

  async function doExport() {
    exportBtn.disabled = true;
    try {
      const f = evidenceExport(await load(), runId);
      save(f.name, f.text);
      alertEl.textContent = "";
    } catch (e) {
      alertEl.textContent = explainError(e, { what: "Could not export the evidence." }).what;
    } finally {
      exportBtn.disabled = false;
    }
  }

  return {
    build() {
      draw();
      reload().catch(() => {});
      return h("section", { class: "mb-16", "aria-labelledby": `${uid}-h` },
        h("h3", { id: `${uid}-h` }, RECORD_TITLE), statusEl, body, h("div", { class: "row" }, refresh, exportBtn), alertEl);
    },
    update(s, prev) {
      const now = !LIVE.includes(s?.status);
      const changed = now !== ended;
      ended = now;
      // a waiting or stopped run already has a finishedAt: cancelling it changes that, or moves the status to a terminal one
      const finished = s?.finishedAt && (prev?.finishedAt !== s.finishedAt || (prev && LIVE.includes(prev.status) && now));
      if (prev && finished) reload().catch(() => {});
      else if (prev?.finishedAt && !s?.finishedAt) {
        // resumed: the old record is gone from the server; drop it and any answer still on its way
        view = undefined;
        loaded = false;
        reload().catch(() => {});
        draw();
      } else if (changed) draw();
    },
  };
}
