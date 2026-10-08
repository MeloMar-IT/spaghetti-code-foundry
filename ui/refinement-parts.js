import { h } from "./dom.js";
import { NOWHERE } from "./refinement-split.js";

// After a split, on the draft page: what the original was split into, the parts, moving a criterion and merging two drafts.
// Every text is set as text. `act` null: read-only, no buttons and no selects.

export const SPLIT_INTO = "Split into";
export const ALL_PLACED = "Every criterion has a place.";
export const HINT_LABEL = "Hint from the architect";
export const HINT_NOTE = "(not part of the story)";
export const MOVE_TO = "Move to…";
export const MERGE = "Merge with";
export const MERGE_BUTTON = "Merge";
export const BACK_TO_ORIGINAL = `${NOWHERE} (the original)`;
const LAYER_TEXT = "This part delivers nothing a user can see or check.";

const oneLine = (t, max = 60) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** The title of a draft in a list: the same words as the draft list shows. */
export const titleOf = (d) => String(d?.preview?.title || d?.title?.text || "Untitled draft");

const originalOf = (d, drafts) => (d?.part ? drafts.find((x) => x.id === d.part.of && x.splitInto) : undefined);

/** `{ n, m, original }` for a part of a split that is there; null otherwise. */
export function partPlace(d, drafts) {
  const original = originalOf(d, drafts);
  const n = original ? original.splitInto.indexOf(d.id) + 1 : 0;
  return n ? { n, m: original.splitInto.length, original } : null;
}

/** False when `o` is the original of the split `d` is a part of, or a later part of it: the server refuses such a link. */
export function mayDependOn(d, o, drafts) {
  const place = partPlace(d, drafts);
  if (!place) return true;
  if (o.id === place.original.id) return false;
  const at = place.original.splitInto.indexOf(o.id);
  return at < 0 || at < place.n - 1;
}

/** Where a criterion of `d` can go: `[{ id, label }]`. A published draft is left out. */
export function moveTargets(s, d) {
  const drafts = s.drafts ?? [];
  const original = d.splitInto ? d : originalOf(d, drafts);
  if (!original) return [];
  const parts = original.splitInto.map((id, i) => ({ d: drafts.find((x) => x.id === id), i })).filter((x) => x.d && x.d.id !== d.id && !x.d.published);
  const out = parts.map((x) => ({ id: x.d.id, label: `Part ${x.i + 1}: ${titleOf(x.d)}` }));
  if (!d.splitInto && !original.published) out.push({ id: original.id, label: BACK_TO_ORIGINAL });
  return out;
}

/** The drafts that `d` can be merged with: not itself, not a split original, not on GitHub. [] for a split original. */
export const mergeTargets = (s, d) => (d.splitInto || d.published ? [] : (s.drafts ?? []).filter((o) => o.id !== d.id && !o.splitInto && !o.published));

/** The question before a merge: what is kept, what is joined, what is cleared. It follows the rules of the server. */
export const mergeAsk = (d, other) => [
  `Merge "${titleOf(other)}" into "${titleOf(d)}"?`,
  "",
  `"${titleOf(d)}" keeps its title, who, what and why (an empty one is taken from the other draft). Its accepted-anyway marks stay.`,
  "The criteria, the depends-on items and the rejected suggestions of the other draft are added. Out of scope and the notes are joined.",
  "The request for the review label is kept if either draft had it.",
  `"${titleOf(other)}" is removed. Drafts that depended on it now depend on "${titleOf(d)}", and their readiness check is cleared. Links that would point to a later part or to the original are removed.`,
  "The readiness check, the review, the view of the code and the waiting suggestions of the merged draft are cleared.",
].join("\n");

/** The warnings about a part, in words. They are stored on the original. */
export function partWarningTexts(s, d) {
  const drafts = s.drafts ?? [];
  const original = originalOf(d, drafts);
  const out = [];
  for (const w of original?.partWarnings ?? []) {
    if (w.kind === "layer" && w.part === d.id) out.push(LAYER_TEXT);
    if (w.kind === "same-code" && w.parts.includes(d.id)) {
      const other = drafts.find((x) => x.id === w.parts.find((id) => id !== d.id));
      const areas = w.areas ?? [];
      out.push(`This part touches the same code as "${titleOf(other)}"${areas.length ? ` (${areas.join(", ")})` : ""}; build one after the other.`);
    }
  }
  return out;
}

/** Changes when the parts box, the merge box or a "Move to" select must be drawn again. */
export const partsKey = (s, d) => JSON.stringify([d.id, d.part ?? null, d.splitInto ?? null, d.criteria.map((c) => [c.id, c.text]),
  (s.drafts ?? []).map((o) => [o.id, titleOf(o), o.splitInto ?? null, o.part?.of ?? null, Boolean(o.published), o.partWarnings ?? null])]);

/** The "Move to…" select of one criterion; null without `act` or without a place to go. */
export function moveNodes(s, d, c, act) {
  const targets = moveTargets(s, d);
  if (!act || !targets.length) return null;
  const sel = h("select", { class: "move", "aria-label": `Move to: ${oneLine(c.text)}`, "data-focus": `part-move-${c.id}`, onChange: async () => {
    if (!sel.value) return;
    const ok = await act.move(sel, c.id, sel.value);
    if (!ok) sel.value = "";
  } }, [h("option", { value: "" }, MOVE_TO), ...targets.map((t) => h("option", { value: t.id }, t.label))]);
  return sel;
}

const openButton = (act, id, text) => h("button", { class: "small", "data-focus": `part-open-${id}`, onClick: () => act.open(id) }, text);

/** The parts part of a draft: for an original, what it was split into and the criteria that fit nowhere; for a part, its head. */
export function partsNodes(s, d, act) {
  const drafts = s.drafts ?? [];
  if (d.splitInto) {
    const parts = d.splitInto.map((id, i) => ({ d: drafts.find((x) => x.id === id), i })).filter((x) => x.d);
    const label = (x) => `Part ${x.i + 1}: ${titleOf(x.d)}`;
    return [
      h("p", {}, h("b", {}, SPLIT_INTO), " ", act ? parts.map((x) => openButton(act, x.d.id, label(x))) : parts.map(label).join(", ")),
      h("h4", {}, NOWHERE),
      d.criteria.length ? h("ul", {}, d.criteria.map((c) => h("li", {}, c.text, moveNodes(s, d, c, act)))) : h("p", { class: "muted" }, ALL_PLACED),
    ];
  }
  const place = partPlace(d, drafts);
  if (!place) return [];
  const warnings = partWarningTexts(s, d);
  return [
    h("p", {}, h("b", {}, `Part ${place.n} of ${place.m} of `), act ? openButton(act, place.original.id, titleOf(place.original)) : titleOf(place.original)),
    d.part.hint ? h("p", { class: "muted part-hint" }, h("span", { class: "pill" }, HINT_LABEL), " ", d.part.hint, " ", h("small", {}, HINT_NOTE)) : null,
    warnings.length ? h("ul", {}, warnings.map((t) => h("li", {}, h("span", { class: "pill" }, "Warning"), t))) : null,
  ].filter(Boolean);
}

/** "Merge with …": a select of the other drafts and a button that asks first. [] when there is nothing to merge with. */
export function mergeNodes(s, d, act) {
  const targets = mergeTargets(s, d);
  if (!act || !targets.length) return [];
  const sel = h("select", { "aria-label": MERGE, "data-focus": "merge-with" }, targets.map((o) => h("option", { value: o.id }, titleOf(o))));
  sel.value = targets[0].id;
  return [h("label", {}, `${MERGE} `, sel), h("button", { "data-focus": "merge", onClick: (e) => {
    const other = targets.find((o) => o.id === sel.value);
    if (!other) return undefined;
    if (!confirm(mergeAsk(d, other))) return undefined;
    return act.merge(e.currentTarget, other.id);
  } }, MERGE_BUTTON)];
}
