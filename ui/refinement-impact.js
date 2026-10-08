import { h } from "./dom.js";
import { isEmpty } from "./refinement-remarks.js";

// The architect's view on the draft page: what the draft touches, depends on, risks and its size. Advice only: nothing here changes a
// field of the draft. Every text is set as text, never as HTML.

export const VIEW_TITLE = "Architect's view";
export const ASK_VIEW = "Ask for the architect's view";
export const ASK_AGAIN = "Ask again";
export const NO_VIEW = "No view yet.";
export const WRITE_FIRST_VIEW = "Write something in the draft first. Then the architect can give its view.";
export const OUT_OF_DATE = "out of date";
export const OUT_OF_DATE_WHY = "The draft changed after this view was written.";
export const BASIS_WORDS = { found: "found in the code", estimate: "estimate" };
export const RISK_WORDS = { data: "Data", security: "Security", compatibility: "Compatibility", users: "Users" };
export const SIZE_WORDS = { small: "Small", medium: "Medium", large: "Large" };
export const OVERLAP_FOUND = "Cannot be built at the same time as this draft.";
export const OVERLAP_ESTIMATE = "May touch the same code — likely cannot be built at the same time.";
export const LABEL_ASK = "Add the review label when this story is published";
export const NOTHING = "Nothing named.";

/** The same rule as `draftTitle` in refinement-draft.js (which imports this file, so it is not imported here). */
const titleOf = (o) => String(o?.preview?.title || o?.title?.text || "Untitled draft");

const basis = (b) => h("span", { class: "pill" }, BASIS_WORDS[b] ?? b);

/** The architect's run when it is an impact run of this draft, else null. */
export const impactRun = (s, did) => {
  const a = s?.architect;
  return a?.kind === "impact" && a.draft === did ? a : null;
};

/** What the box shows: { kind: "line" | "none" | "hint" | "button", again?, text?, label? }. */
export function impactState(s, d) {
  const a = impactRun(s, d.id);
  const st = a?.state;
  if (a && (st === "queued" || st === "running")) return { kind: "line", again: "" };
  if (a && st === "paused") return { kind: "line", again: "Ask again" };
  if (a && st === "failed") return { kind: "line", again: "Try again" };
  const other = s.architect?.state;
  if (other === "queued" || other === "running" || other === "paused") return { kind: "none" };
  if (!s.brief) return { kind: "none" };
  if (isEmpty(d)) return { kind: "hint", text: WRITE_FIRST_VIEW };
  return { kind: "button", label: d.impact ? ASK_AGAIN : ASK_VIEW };
}

export const impactKey = (s, d) => JSON.stringify([
  impactState(s, d), impactRun(s, d.id), d.impact ?? null, d.addReviewLabel === true,
  (s.drafts ?? []).map((o) => [o.id, titleOf(o)]),
]);

/** "Written <date and time>". */
export const impactMeta = (impact) => `Written ${new Date(impact.at).toLocaleString()}`;

const linkList = (items, draftsOf) => (items.length
  ? h("ul", {}, items.map((x) => h("li", {}, h("b", {}, x.issue !== undefined ? `#${x.issue}` : `${draftsOf(x.draft)} (draft)`), basis(x.basis), h("span", { class: "said" }, x.why))))
  : h("p", { class: "muted" }, NOTHING));

/** The nodes of the view alone (no heading; the checkbox only when `act`). [] without a view. */
export function viewNodes(s, d, act) {
  const v = d.impact;
  if (!v) return [];
  const titleById = (id) => titleOf((s.drafts ?? []).find((o) => o.id === id));
  const out = [h("p", { class: "muted" }, impactMeta(v),
    v.outOfDate ? [" ", h("span", { class: "pill" }, OUT_OF_DATE), " ", OUT_OF_DATE_WHY] : null)];

  out.push(h("h4", {}, "Areas"));
  out.push(v.areas.length
    ? h("ul", {}, v.areas.map((a) => h("li", {}, h("b", {}, a.area), basis(a.basis), h("span", { class: "said" }, a.why),
      a.files.length ? h("small", { class: "muted" }, a.files.join(", ")) : null)))
    : h("p", { class: "muted" }, NOTHING));

  out.push(h("h4", {}, "Depends on"), linkList(v.dependsOn, titleById));
  out.push(h("h4", {}, "What depends on it"), linkList(v.dependents, titleById));

  out.push(h("h4", {}, "Risks"));
  out.push(v.risks.length
    ? h("ul", {}, v.risks.map((r) => h("li", {}, h("span", { class: "pill" }, RISK_WORDS[r.kind] ?? r.kind), basis(r.basis), h("span", { class: "said" }, r.text))))
    : h("p", { class: "muted" }, "No risks named."));

  // The size and the fit are the architect's estimate: each statement carries the mark.
  out.push(h("h4", {}, "Size"));
  out.push(h("p", {}, h("b", {}, SIZE_WORDS[v.size.size] ?? v.size.size), ` — about ${v.size.files} files and ${v.size.lines} lines of code`, basis("estimate")));
  out.push(h("p", {}, h("span", { class: "said" }, v.size.why), basis("estimate")));
  out.push(h("p", {}, v.fit.text, basis("estimate")));

  out.push(h("h4", {}, "Other open work on the same code"));
  out.push(v.overlaps.length
    ? h("ul", {}, v.overlaps.map((o) => h("li", {},
      h("b", {}, o.issue !== undefined ? `#${o.issue}` : `${o.title || "Untitled draft"} (draft)`),
      h("small", { class: "muted" }, o.areas.join(", ")), basis(o.basis), h("span", { class: "said" }, o.why),
      " ", o.basis === "found" ? OVERLAP_FOUND : OVERLAP_ESTIMATE)))
    : h("p", { class: "muted" }, "No other open story or draft named."));

  if (v.planReview) {
    out.push(h("h4", {}, "Plan review"), h("p", {}, v.planReview.text, basis("estimate")));
    out.push(h("ul", {}, (v.sensitive ?? []).map((x) => h("li", {}, h("b", {}, x.topic), basis(x.basis), h("span", { class: "said" }, x.why)))));
    const label = v.planReview.label;
    if (act && label) out.push(labelBox(d, act, `${LABEL_ASK} ("${label}")`));
    else if (!act && label && d.addReviewLabel) out.push(h("p", { class: "muted" }, `The review label "${label}" is added when this story is published.`));
  }
  return out;
}

const labelBox = (d, act, text) => h("label", { class: "check check-row" },
  h("input", {
    type: "checkbox", checked: d.addReviewLabel === true, "data-focus": "review-label", class: "fit",
    onChange: (e) => act.setLabel(e.currentTarget, e.currentTarget.checked),
  }), text);

/** A stored choice to add the review label that the view does not offer now (no recommendation or no label): shown so it can be seen and cleared. */
export function staleChoiceNodes(d, act) {
  if (d.addReviewLabel !== true || d.impact?.planReview?.label) return [];
  if (!act) return [h("p", { class: "muted" }, "You chose to add the review label when this story is published. No review label is offered now.")];
  return [h("p", { class: "muted" }, "No review label is offered now (no review is recommended, or no label is set)."),
    labelBox(d, act, `${LABEL_ASK} — untick to remove this choice`)];
}

/** The nodes of the whole part. `act` null: read-only, [] without a view. Otherwise `act`: { line(architect), ask(btn), setLabel(box, add) }. */
export function impactNodes(s, d, act) {
  if (!act) return d.impact || d.addReviewLabel === true ? [h("h4", {}, VIEW_TITLE), ...viewNodes(s, d, null), ...staleChoiceNodes(d, null)] : [];
  const st = impactState(s, d);
  const out = [h("h4", {}, VIEW_TITLE)];
  const ask = (text) => h("button", { class: "small", "data-focus": "impact", onClick: (e) => act.ask(e.currentTarget) }, text);
  if (st.kind === "line") {
    out.push(act.line(s.architect));
    if (st.again) out.push(ask(st.again));
  } else if (st.kind === "hint") out.push(h("p", { class: "muted" }, st.text));
  else if (st.kind === "button") out.push(ask(st.label));
  if (!d.impact && (st.kind === "none" || st.kind === "button")) out.push(h("p", { class: "muted" }, NO_VIEW));
  out.push(...viewNodes(s, d, act), ...staleChoiceNodes(d, act));
  return out;
}

/** A log line of the view in words, or "" when the line is not one of them. */
export function impactLogText(entry) {
  const who = entry.who || "Someone";
  if (entry.what === "impact-asked") return `${who} asked for the architect's view of a story draft`;
  if (entry.what === "architect-impact") {
    return ["small", "medium", "large"].includes(entry.detail)
      ? `The architect wrote its view of a story draft: ${entry.detail}`
      : "The architect wrote its view of a story draft";
  }
  return "";
}
