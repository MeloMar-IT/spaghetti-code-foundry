import { h } from "./dom.js";

// The remarks on the draft page: the code checks, the architect's review, and Move to notes. Every text is set as text, never as HTML.

/** The fields that get remarks: every field but the notes for the builder. */
export const REMARK_FIELDS = ["title", "who", "what", "why", "criteria", "outOfScope"];
export const KIND_WORDS = { uncheckable: "Cannot be checked", vague: "Vague", contradiction: "Contradicts", how: "Describes how to build", plan: "An implementation plan" };
export const STALE = "written before your last change";
export const BUILD_STEP = "This belongs in the build step.";
export const REVIEW = "Review draft";
export const MOVE = "Move to notes for the builder";
export const MOVE_ASK = "Move this text to the notes for the builder? It is taken out of its field.";
export const WRITE_FIRST = "Write something in the draft first. Then the architect can review it.";
const FIELD_WORDS = { title: "the title", who: "“As …”", what: "“I want …”", why: "“so that …”", criteria: "a criterion", outOfScope: "out of scope" };

const sameAt = (r, field, item) => r.field === field && r.item === item;

/** The architect's run when it is a review of this draft, else null. */
export const reviewRun = (s, did) => {
  const a = s?.architect;
  return a?.kind === "review" && a.draft === did ? a : null;
};

/** True when the draft has nothing the architect could review (the notes count, "depends on" does not). */
export const isEmpty = (d) => !d.title && !d.who && !d.what && !d.why && !d.outOfScope && !d.notes && !(d.criteria ?? []).length;

/** What the review box shows: { kind: "line" | "none" | "hint" | "button", again?, text? }. */
export function reviewState(s, d) {
  const a = reviewRun(s, d.id);
  const st = a?.state;
  if (a && (st === "queued" || st === "running")) return { kind: "line", again: "" };
  if (a && st === "paused") return { kind: "line", again: "Ask again" };
  if (a && st === "failed") return { kind: "line", again: "Try again" };
  const other = s.architect?.state;
  if (other === "queued" || other === "running" || other === "paused") return { kind: "none" };
  if (!s.brief) return { kind: "none" };
  if (isEmpty(d)) return { kind: "hint", text: WRITE_FIRST };
  return { kind: "button" };
}

/** The remarks of one field (or criterion): { code, review }. */
export function remarksAt(d, field, item) {
  return {
    code: (d.remarks ?? []).filter((r) => sameAt(r, field, item)),
    review: (d.review?.remarks ?? []).filter((r) => sameAt(r, field, item)),
  };
}

/** The review remarks about a criterion that is not in the draft any more. */
export const orphanRemarks = (d) => {
  const ids = new Set((d.criteria ?? []).map((c) => c.id));
  return (d.review?.remarks ?? []).filter((r) => r.field === "criteria" && !ids.has(r.item));
};

/** True when the text may be moved to the notes: a plan remark of the code checks, or a fresh plan or how remark of the review. */
export function canMove(d, field, item) {
  const { code, review } = remarksAt(d, field, item);
  return code.some((r) => r.kind === "plan") || review.some((r) => (r.kind === "plan" || r.kind === "how") && !r.stale);
}

export const remarkKey = (d, field, item) => JSON.stringify([remarksAt(d, field, item), canMove(d, field, item)]);
export const reviewKey = (s, d) => JSON.stringify([reviewState(s, d), reviewRun(s, d.id), d.review ?? null]);

/** "Reviewed <date and time>". */
export const reviewMeta = (review) => `Reviewed ${new Date(review.at).toLocaleString()}`;

/**
 * The nodes under a field or a criterion. `act` null: no button. Otherwise `act`: { move(btn) }.
 */
export function remarkNodes(d, field, item, act) {
  const { code, review } = remarksAt(d, field, item);
  if (!code.length && !review.length) return [];
  const out = code.map((r) => h("p", { class: "remark" }, r.text));
  for (const r of review) {
    out.push(h("p", { class: "remark" },
      h("span", { class: "pill" }, KIND_WORDS[r.kind] ?? r.kind), " ", h("span", { class: "said" }, r.text),
      r.kind === "plan" || r.kind === "how" ? ` ${BUILD_STEP}` : null,
      r.stale ? h("small", { class: "muted" }, STALE) : null));
  }
  if (act && canMove(d, field, item)) {
    out.push(h("button", { class: "small", "data-focus": `move-${item ?? field}`, onClick: (e) => act.move(e.currentTarget) }, MOVE));
  }
  return out;
}

/** The nodes of the review box. `act`: { line(architect), ask(btn) }. */
export function reviewNodes(s, d, act) {
  const st = reviewState(s, d);
  const out = [];
  if (st.kind === "line") {
    out.push(act.line(s.architect));
    if (st.again) out.push(h("button", { class: "small", "data-focus": "review", onClick: (e) => act.ask(e.currentTarget) }, st.again));
  } else if (st.kind === "hint") out.push(h("p", { class: "muted" }, st.text));
  else if (st.kind === "button") out.push(h("button", { class: "small", "data-focus": "review", onClick: (e) => act.ask(e.currentTarget) }, REVIEW));
  if (d.review) out.push(h("p", { class: "muted" }, reviewMeta(d.review) + (d.review.remarks.length ? "" : " · The architect found nothing to remark.")));
  return out;
}

/** A log line of the review in words, or "" when the line is not one of them. */
export function reviewLogText(entry) {
  const who = entry.who || "Someone";
  switch (entry.what) {
    case "review-asked": return `${who} asked the architect to review a story draft`;
    case "architect-reviewed": {
      const n = Number(entry.detail);
      if (entry.detail === undefined || entry.detail === "" || !Number.isInteger(n) || n < 0) return "The architect reviewed a story draft";
      return `The architect reviewed a story draft: ${n === 0 ? "no remarks" : n === 1 ? "1 remark" : `${n} remarks`}`;
    }
    case "moved-to-notes": return `${who} moved ${FIELD_WORDS[entry.detail] ?? "a text"} to the notes for the builder`;
    default: return "";
  }
}
