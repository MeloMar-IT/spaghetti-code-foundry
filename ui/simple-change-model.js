import { ANSWER, CHANGE, WORDS, forbiddenIn, mapTerms, plainText, plainWords, safeText } from "./simple-words.js";

// The Ask for a change page as plain data. No DOM here. The server's text is shown only through the plain-word filters.
// The limits are those of the server (src/refinement/draft.ts and talk.ts); a text over a limit is refused with a message, never cut.

export const OPEN_STATES = ["thinking", "questions", "cards", "stuck"];
export const TEXT_MAX = 10_000;
export const ANSWER_MAX = 2000;
// Pictures (#835): the limits of the server. The type here is only the browser's hint; the server checks the content.
export const PICTURES_MAX = 5;
export const PICTURE_MAX_BYTES = 5 * 1024 * 1024;
export const PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const PICTURE_ACCEPT = PICTURE_TYPES.join(",");

/** Why a file cannot be added as picture number `count + 1`: "many" | "empty" | "big" | "type"; null when it can. */
export function pictureProblem(file, count) {
  if (count >= PICTURES_MAX) return "many";
  if (!file || !PICTURE_TYPES.includes(file.type)) return "type";
  if (!file.size) return "empty";
  if (file.size > PICTURE_MAX_BYTES) return "big";
  return null;
}

/** The file as one base64 string. The bytes become one binary string and `btoa` runs once, so no padding appears inside the text. */
export async function readAsBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
  return btoa(parts.join(""));
}
export const TITLE_MAX = 120;
export const CRITERION_MAX = 500;
export const CRITERIA_MAX = 50;

const chars = (s) => [...String(s ?? "")].length;
const UNDERSTOOD_PREFIX = /^\s*This is what I understood:\s*/i;

/** The list of requests from `GET /api/changes` ({ changes: [...] }); a plain list is accepted too. Anything else gives none. */
export function changesOf(answer) {
  const list = Array.isArray(answer) ? answer : answer?.changes;
  return Array.isArray(list) ? list.filter((c) => c && typeof c === "object") : [];
}

/** The name the change API takes for a project: "owner/name" for GitHub, the local name for a local project, else null. */
export function changeRepoOf(repo) {
  if (typeof repo?.github === "string" && repo.github) return repo.github;
  if (typeof repo?.localName === "string" && repo.localName) return repo.localName;
  return null;
}

const newest = (a, b) => (Date.parse(b.updated ?? "") || 0) - (Date.parse(a.updated ?? "") || 0) || (Date.parse(b.created ?? "") || 0) - (Date.parse(a.created ?? "") || 0);

/** The newest request that is still open (thinking, questions, cards or stuck), or null. */
export function openChangeOf(list) {
  return changesOf(list).filter((c) => OPEN_STATES.includes(c.state)).sort(newest)[0] ?? null;
}

/** "write" | "thinking" | "questions" | "cards" | "planned" | "stuck"; "write" for no request or a state this page does not know. */
export function phaseOf(view) {
  const s = view?.state;
  return ["thinking", "questions", "cards", "planned", "stuck"].includes(s) ? s : "write";
}

/** The questions in plain words. `n` of a question and of an option is 1-based, as the answers take it. */
export function questionItems(view) {
  const list = Array.isArray(view?.questions) ? view.questions : [];
  return list.map((q, i) => {
    const options = Array.isArray(q?.options) ? q.options : [];
    return {
      id: String(q?.id ?? ""),
      n: i + 1,
      text: plainWords(q?.text) || ANSWER.noPlain,
      why: plainWords(q?.why),
      options: options.map((o, j) => ({ n: j + 1, text: plainWords(o) || CHANGE.option(j + 1), recommended: q.recommended === j + 1 })),
    };
  });
}

/** The cards in plain words. The summary of the server starts with "This is what I understood: "; that is not said twice. */
export function cardItems(view) {
  const list = Array.isArray(view?.cards) ? view.cards : [];
  return list.map((c) => {
    const title = safeText(c?.title, WORDS.untitled);
    const said = plainWords(String(c?.understood ?? "").replace(UNDERSTOOD_PREFIX, ""));
    return {
      id: String(c?.id ?? ""),
      title,
      understood: CHANGE.understood(said || title),
      criteria: (Array.isArray(c?.criteria) ? c.criteria : []).map((x) => safeText(x)).filter(Boolean),
    };
  });
}

/** The first `max` characters' worth of text made plain for an edit box: "" when a forbidden term is left. Not cut by the filter. */
const editable = (s, max) => {
  const t = mapTerms(plainText(s, max + 1)).trim();
  return forbiddenIn(t).length === 0 ? t : "";
};

/**
 * What a card edit starts from. The boxes show filtered text (`shown`); the server's own text stays in `raw`, so a save
 * never writes filtered text over a part the person did not touch.
 */
export function cardEdit(card) {
  return {
    did: String(card?.id ?? ""),
    rawTitle: String(card?.title ?? ""),
    title: editable(card?.title, TITLE_MAX),
    slots: (Array.isArray(card?.criteria) ? card.criteria : []).map((c) => ({ raw: String(c ?? ""), shown: editable(c, CRITERION_MAX) })),
  };
}

/**
 * The body of a card save from what is in the boxes: `values` = { title, criteria: [one text per slot with a shown text, in order], added }.
 * Only parts that changed are sent; each criterion is one entry (a newline inside one stays). → { body }, { unchanged: true } or { problem }.
 */
export function cardBody(edit, values) {
  const body = {};
  const title = String(values?.title ?? "");
  if (title !== edit.title) {
    if (!title.trim()) return { problem: CHANGE.titleNeeded };
    if (chars(title.trim()) > TITLE_MAX) return { problem: CHANGE.titleTooLong };
    body.title = title.trim();
  }
  const typed = Array.isArray(values?.criteria) ? values.criteria : [];
  const criteria = [];
  let at = 0;
  let changed = false;
  for (const [i, slot] of edit.slots.entries()) {
    if (!slot.shown) {
      criteria.push(slot.raw); // hidden from the person: kept as it is
      continue;
    }
    const v = String(typed[at++] ?? "");
    if (v === slot.shown) {
      criteria.push(slot.raw);
      continue;
    }
    changed = true;
    if (!v.trim()) continue; // emptied: removed
    if (chars(v.trim()) > CRITERION_MAX) return { problem: CHANGE.criterionTooLong(i + 1) };
    criteria.push(v.trim());
  }
  const added = String(values?.added ?? "").trim();
  if (added) {
    changed = true;
    if (chars(added) > CRITERION_MAX) return { problem: CHANGE.criterionTooLong(criteria.length + 1) };
    criteria.push(added);
  }
  if (changed) {
    if (criteria.length > CRITERIA_MAX) return { problem: CHANGE.tooManyCriteria };
    body.criteria = criteria;
  }
  return Object.keys(body).length ? { body } : { unchanged: true };
}

/**
 * The body of the answers: `{ answers: [{ question, option | text }] }`. `answers`: question id → { option?, text? }.
 * Typed text wins over the chosen option. → { body }, { missing: n } (first question without an answer) or { tooLong: n }.
 */
export function answersBody(questions, answers) {
  const out = [];
  for (const [i, q] of (Array.isArray(questions) ? questions : []).entries()) {
    const a = answers?.[q?.id] ?? {};
    const text = String(a.text ?? "").trim();
    const count = Array.isArray(q?.options) ? q.options.length : 0;
    if (text) {
      if (chars(text) > ANSWER_MAX) return { tooLong: i + 1 };
      out.push({ question: q.id, text });
    } else if (Number.isInteger(a.option) && a.option >= 1 && a.option <= count) out.push({ question: q.id, option: a.option });
    else return { missing: i + 1 };
  }
  return { body: { answers: out } };
}

/** One Planned card per request kept for later ("Not now"), newest first. A request sent to build is not listed. */
export function plannedCards(list) {
  return changesOf(list)
    .filter((c) => c.state === "planned" && c.building !== true && c.id)
    .sort(newest)
    .map((c) => {
      const cards = Array.isArray(c.cards) ? c.cards : [];
      return {
        id: `change-${c.id}`,
        title: safeText(cards[0]?.title, WORDS.untitled),
        sentence: cards.length > 1 ? CHANGE.parts(cards.length) : "",
        line: CHANGE.keptLine,
        build: String(c.id),
      };
    });
}

// ---- what the person typed and did not send yet, by project id --------------------------------------------------

const drafts = new Map();

/** The draft of a project: { text, answers: { question id → { option, text } }, edit: null | { did, values, dirty } }. */
export function changeDraft(projectId) {
  const key = String(projectId);
  if (!drafts.has(key)) drafts.set(key, { text: "", answers: {}, edit: null });
  return drafts.get(key);
}

/** Clears "text", "answers" or "edit" of the draft, or all of it. */
export function clearChangeDraft(projectId, part) {
  const d = changeDraft(projectId);
  if (!part || part === "text") d.text = "";
  if (!part || part === "answers") d.answers = {};
  if (!part || part === "edit") d.edit = null;
}

/** True when a draft holds text that was not sent: the request, an answer in the free-text box, or a card edit that was changed. */
export function hasUnsentChange() {
  return [...drafts.values()].some((d) => d.text.trim() !== "" || Object.values(d.answers).some((a) => String(a?.text ?? "").trim() !== "") || d.edit?.dirty === true);
}
