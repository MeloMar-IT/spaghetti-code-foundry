// The Skills card of a run page: what the plan asked for and what the run locked. It draws the answer of the server
// (see src/server/skill-view.ts) and decides nothing. Every value goes in as text, never as HTML.
import { h } from "./dom.js";

export const REQUESTED_LABELS = { selected: "Selected", missing: "Missing", conflicting: "Conflicting", "not-approved": "Not approved", "too-large": "Too large", "not-checked": "Not checked" };
export const CONTEXT_LABELS = { loaded: "Loaded", reloaded: "Reloaded", reused: "Reused", omitted: "Left out (over budget)" };
export const INTEGRITY_LABELS = {
  verified: "Verified", changed: "Changed", missing: "Missing", unpinned: "No longer pinned", unapproved: "Not approved",
  unverified: "Cannot be verified", "not-checked": "Not checked", "not-locked": "Not locked yet",
};

const DASH = "—";
const label = (labels, v) => (typeof v === "string" ? labels[v] ?? v : DASH);
const REQUESTED_FAIL = new Set(["missing", "conflicting", "not-approved", "too-large"]);
const INTEGRITY_FAIL = new Set(["changed", "missing", "unpinned", "unapproved"]);
const requestedClass = (state) => (state === "selected" ? "ok" : REQUESTED_FAIL.has(state) ? "fail" : "");
const integrityClass = (state) => (state === "verified" ? "ok" : INTEGRITY_FAIL.has(state) ? "fail" : "locked");

/** One evidence entry: a path as plain mono text, an issue as a link when the repository is owner/name, else text. */
export function evidenceItem(e, repo) {
  const text = typeof e?.text === "string" ? e.text : DASH;
  if (e?.kind === "issue" && /^\d{1,9}$/.test(text) && /^[\w.-]+\/[\w.-]+$/.test(repo ?? "") && !repo.split("/").some((p) => p === "." || p === "..")) {
    return h("a", { href: `https://github.com/${repo}/issues/${text}`, target: "_blank", rel: "noopener", class: "mono", "data-focus": `skill-issue-${text}` }, `issue #${text}`);
  }
  const shown = e?.kind === "issue" ? (/^\d+$/.test(text) ? `issue #${text}` : `issue ${text}`) : `${typeof e?.kind === "string" ? e.kind : "evidence"} ${text}`;
  return h("span", { class: "mono" }, shown);
}

const evidenceLine = (list, repo) => (Array.isArray(list) && list.length ? h("span", { class: "muted" }, "Evidence: ", list.map((e, i) => [i ? ", " : null, evidenceItem(e, repo)])) : null);

const status = (view) => {
  if (view.lock === "missing" || view.lock === "changed") return "The skill lock of this run is missing or was changed.";
  if (view.planChanged) return "The run planned again. New skills are locked at the next agent step.";
  if (view.action === "stop") return "The run stopped because a skill cannot be used.";
  return null;
};

export const PLAN_RECORD_NOTES = {
  none: "No plan record was found for this issue on this Foundry.",
  "record-purged": "The plan record was cleaned up.",
  "comment-missing": "The plan comment is gone.",
  "comment-changed": "The plan comment was edited.",
  "newer-plan": "A newer plan has no record on this Foundry.",
  "check-unreadable": "The plan comments could not be read.",
  invalid: "The plan records of this issue are not valid.",
  failed: "The plan record could not be checked.",
  record: "The skills come from the plan record of this issue.",
};
const CHANGE_NOTES = new Set(["comments", "code", "technology"]);

/** One plain sentence for what the plan check of a coding run found; null for an unknown outcome. */
export function planRecordNote(view) {
  const rec = view?.planRecord;
  const base = typeof rec?.outcome === "string" && Object.hasOwn(PLAN_RECORD_NOTES, rec.outcome) ? PLAN_RECORD_NOTES[rec.outcome] : null;
  if (!base) return null;
  if (rec.outcome === "record") {
    const changes = Array.isArray(rec.changes) ? rec.changes.filter((c) => CHANGE_NOTES.has(c)) : [];
    return changes.length ? `${base} Changed since the plan: ${changes.join(", ")}.` : base;
  }
  if (rec.outcome === "none") return `${base} The run codes without the plan's skills.`;
  if (rec.outcome === "check-unreadable" && rec.stopped) return `${base} The run could not code. Make sure the comments can be read, then resume to check again.`;
  return `${base} ${rec.stopped ? "Plan the issue again, then resume." : "The run goes on without the plan's skills."}`;
}

function requestedItem(r, repo) {
  const by = r.by === "administrator" ? "always included by the administrator" : "asked for by the plan";
  return h("li", {},
    h("b", { class: "mono" }, r.version ? `${r.id}@${r.version}` : String(r.id)),
    h("span", { class: `pill ${requestedClass(r.state)}`.trim() }, label(REQUESTED_LABELS, r.state)),
    h("span", { class: "muted" }, by),
    r.reason ? h("span", {}, r.reason) : null,
    evidenceLine(r.evidence, repo),
    r.message ? h("span", { class: "muted" }, r.message) : null);
}

function why(r, repo) {
  const needed = r.selection === "dependency" && Array.isArray(r.requiredBy) && r.requiredBy.length ? `Needed by ${r.requiredBy.join(", ")}` : null;
  const first = needed ?? (r.selection ? label({ mandatory: "Always included", requested: "Asked for by the plan", dependency: "Dependency" }, r.selection) : DASH);
  return [first, r.reason || r.evidence?.length ? h("div", { class: "muted" }, r.reason ?? null, r.reason && r.evidence?.length ? " " : null, evidenceLine(r.evidence, repo)) : null];
}

const session = (r) => [
  r.context ? `${label(CONTEXT_LABELS, r.context)}${typeof r.contextStep === "string" ? ` at ${r.contextStep}` : ""}` : DASH,
  r.review ? h("div", { class: "muted" }, "Review checks given") : null,
];

function resolvedRow(r, admin, repo) {
  return h("tr", {},
    h("td", { class: "mono" }, `${r.id}@${r.version}`),
    h("td", {}, typeof r.category === "string" ? r.category : DASH),
    h("td", {}, why(r, repo)),
    h("td", {}, typeof r.estimatedTokens === "number" ? `about ${r.estimatedTokens} tokens` : DASH),
    h("td", {}, h("span", { class: `pill ${integrityClass(r.integrity)}` }, label(INTEGRITY_LABELS, r.integrity))),
    h("td", {}, session(r)),
    admin ? h("td", {}, r.source === "builtin" ? "built-in" : r.source === "admin" ? "administrator folder" : DASH) : null,
    admin ? h("td", typeof r.digest === "string" ? { class: "mono", title: r.digest } : {}, typeof r.digest === "string" ? r.digest.slice(0, 19) : DASH) : null);
}

/** The Skills card of a run page, or null when the run has no skill information. */
export function skillsCard(view, { admin = false, repo = "" } = {}) {
  if (!view || typeof view !== "object") return null;
  const requested = Array.isArray(view.requested) ? view.requested : [];
  const resolved = Array.isArray(view.resolved) ? view.resolved : [];
  const note = status(view);
  const recordNote = planRecordNote(view);
  const checked = typeof view.checkedAt === "string" ? `Integrity checked ${view.checkedAt}.` : null;
  const heads = ["Skill", "Category", "Why", "Context estimate", "Integrity", "In the session", ...(admin ? ["Source", "Digest"] : [])];
  return h("section", { class: "card mb-16", "aria-label": "Skills" },
    h("h2", {}, "Skills"),
    note ? h("p", { class: "muted" }, note) : null,
    recordNote ? h("p", { class: "muted" }, recordNote) : null,
    typeof view.estimatedTokens === "number" && resolved.length ? h("p", { class: "muted" }, `About ${view.estimatedTokens} tokens of skill context.`) : null,
    checked ? h("p", { class: "muted" }, checked) : null,
    h("h3", {}, "Requested"),
    requested.length ? h("ul", { class: "holds" }, requested.map((r) => requestedItem(r, repo))) : h("p", { class: "muted" }, "None."),
    h("h3", {}, "Resolved"),
    resolved.length
      ? h("div", { class: "table-box" }, h("table", { class: "table" },
          h("thead", {}, h("tr", {}, heads.map((t) => h("th", {}, t)))),
          h("tbody", {}, resolved.map((r) => resolvedRow(r, admin, repo)))))
      : h("p", { class: "muted" }, "No skills are used."));
}
