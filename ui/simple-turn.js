import { h, mount } from "./dom.js";
import { ANSWER, plainWords, safeText } from "./simple-words.js";
import { FILLER } from "./turn-act.js";

// The question cards of the Simple project page: the Foundry's questions in plain words, a suggestion button and an answer box
// for each, sent through the same detail / act calls as Your turn. Only word-list text and plainWords/safeText output is shown.

export const ASK_KINDS = new Set(["questions", "planner_questions", "owner_action"]);

/**
 * What the person did on each question card, by run id. The page is drawn again when the data changes, so the draft lives here, not
 * in the element. Phases: closed, loading, loadFailed, open, sending, sent.
 */
const drafts = new Map();

/** The item of `GET /api/your-turn/mine` that the question card `card` (with `card.ask`, a run id) can be answered through; else null. */
export function askItemFor(card, turns) {
  if (!card?.ask || !Array.isArray(turns)) return null;
  return turns.find((i) => i && typeof i.key === "string" && i.key && i.runId === card.ask
    && ASK_KINDS.has(i.kind) && Array.isArray(i.acts) && i.acts.includes("answer")) ?? null;
}

/** True while an answer is typed (or on its way) and not sent, in any phase: a 401 or a poll must not reload the page and lose it. */
export function hasUnsentAnswers() {
  for (const d of drafts.values()) {
    if (d.phase === "sending") return true;
    if (d.phase !== "sent" && ([...d.texts.values()].some((t) => t.trim()) || d.took.size)) return true;
  }
  return false;
}

/** Forgets every draft (the page was left, or a test starts again). */
export function clearAnswerDrafts() {
  drafts.clear();
}

const sigOf = (q) => JSON.stringify([q.n ?? null, q.title ?? "", q.text ?? "", q.recommendation ?? ""]);

/** The blocks to draw: one per parsed question, or one for the whole text when the server found no question. */
export function questionBlocks(detail) {
  const qs = Array.isArray(detail?.questions) ? detail.questions : [];
  // `titleRaw` is what the server wrote as the title: when its plain form is empty, the question still counts as written
  const block = (id, n, title, titleRaw, text, rec, sig) => {
    const raw = String(text ?? "");
    const lines = plainWords(raw).split("\n").filter(Boolean);
    const sug = rec ? safeText(rec) : "";
    const noPlain = lines.length === 0 && (raw.trim() !== "" || (String(titleRaw ?? "").trim() !== "" && !title));
    return {
      id, n, title, lines, noPlain,
      hasRec: Boolean(String(rec ?? "").trim()), suggestion: sug ? ANSWER.suggestion(sug) : ANSWER.useSuggestion, sig,
    };
  };
  if (qs.length) return qs.map((q, i) => block(String(q.n ?? i + 1), q.n ?? i + 1, safeText(q.title), q.title, q.text, q.recommendation, sigOf(q)));
  return [block("one", undefined, ANSWER.oneQuestion, "", detail?.text, "", sigOf({ text: detail?.text }))];
}

/** → { action: "defaults" } | { action: "answer", answers } | { missing } (the number of the first question without an answer, or "one"). */
export function answersOf(draft, blocks, detail) {
  const typed = (b) => String(draft.texts.get(b.id) ?? "").trim();
  const taken = (b) => b.hasRec && draft.took.has(b.id);
  if (blocks.length && Array.isArray(detail?.questions) && detail.questions.length && blocks.every((b) => !typed(b) && taken(b)) && (detail.acts ?? []).includes("defaults")) return { action: "defaults" };
  const answers = [];
  for (const b of blocks) {
    const text = typed(b) || (taken(b) ? FILLER : "");
    if (!text) return { missing: b.n ?? "one" };
    answers.push(b.n === undefined ? { text } : { n: b.n, text });
  }
  return { action: "answer", answers };
}

const freshDraft = (key) => ({ key, phase: "closed", detail: null, texts: new Map(), took: new Set(), note: "", old: null, sent: null, checking: false, answer: null, paint: null, status: null });

function reset(d, key) {
  Object.assign(d, freshDraft(key), { paint: d.paint, answer: d.answer });
}

async function open(d) {
  d.phase = "loading";
  d.note = "";
  d.paint?.();
  let detail;
  try {
    detail = await Promise.resolve().then(() => d.answer.detail(d.key));
    if (!detail || typeof detail !== "object") throw new Error("no detail");
  } catch {
    d.phase = "loadFailed";
    d.note = ANSWER.loadFailed;
    d.paint?.();
    return;
  }
  d.detail = detail;
  if (d.old) {
    // after a changed question: an answer comes back only for a question that is exactly as it was
    d.texts = new Map();
    d.took = new Set();
    for (const b of questionBlocks(detail)) {
      const was = d.old.get(b.sig);
      if (!was) continue;
      if (was.text) d.texts.set(b.id, was.text);
      if (was.took) d.took.add(b.id);
    }
    d.old = null;
  }
  d.phase = "open";
  d.paint?.();
}

async function send(d) {
  const detail = d.detail;
  const blocks = questionBlocks(detail);
  const r = answersOf(d, blocks, detail);
  if (r.missing !== undefined) {
    d.note = r.missing === "one" ? ANSWER.needsOne : ANSWER.needs(r.missing);
    if (d.status) d.status.textContent = d.note;
    return;
  }
  const body = { key: d.key, action: r.action, stamp: detail.stamp, digest: detail.digest, ...(r.answers ? { answers: r.answers } : {}) };
  d.phase = "sending";
  d.note = ANSWER.sending;
  d.paint?.();
  try {
    await Promise.resolve().then(() => d.answer.act(body));
  } catch (e) {
    d.note = ANSWER.failed;
    if (e?.status === 409) {
      // the questions changed: ask for them again, and give an answer back only to a question that did not change
      d.old = new Map(blocks.map((b) => [b.sig, { text: String(d.texts.get(b.id) ?? ""), took: d.took.has(b.id) }]));
      d.detail = null;
      d.phase = "closed";
    } else {
      d.phase = "open";
    }
    d.paint?.();
    return;
  }
  d.phase = "sent";
  d.sent = { stamp: detail.stamp, digest: detail.digest };
  d.note = ANSWER.sent;
  d.texts = new Map();
  d.took = new Set();
  d.paint?.();
  d.answer.done?.();
}

function blockView(d, b, off) {
  const box = h("textarea", {
    rows: 3, maxlength: 5000, disabled: off, "data-focus": `simple-ask-box-${d.key}-${b.id}`,
    "aria-label": b.n === undefined ? ANSWER.ownOne : ANSWER.yourAnswer(b.n),
    placeholder: b.n === undefined ? ANSWER.ownOne : ANSWER.yourAnswer(b.n),
    value: d.texts.get(b.id) ?? "",
    onInput: (e) => { d.texts.set(b.id, String(e?.target?.value ?? box.value ?? "")); },
  });
  const take = b.hasRec ? h("button", {
    type: "button", disabled: off, "aria-pressed": d.took.has(b.id) ? "true" : "false", "data-focus": `simple-ask-take-${d.key}-${b.id}`,
    onClick: () => {
      if (d.took.has(b.id)) d.took.delete(b.id); else d.took.add(b.id);
      take.setAttribute("aria-pressed", d.took.has(b.id) ? "true" : "false");
    },
  }, b.suggestion) : null;
  return h("div", { class: "simple-ask-q" },
    h("strong", {}, b.n === undefined ? b.title : ANSWER.titled(b.n, b.title)),
    b.noPlain ? h("p", {}, ANSWER.noPlain) : b.lines.map((l) => h("p", {}, l)),
    take,
    box);
}

/**
 * The card of a question the person may answer here. `answer`: { detail(key), act(body), done() }. Returns an `li`, or null when the
 * caller draws the link card (no matching item and nothing was sent).
 */
export function askCard(card, turns, answer) {
  const item = askItemFor(card, turns);
  let d = drafts.get(card.ask);
  if (!item && d?.phase !== "sent") return null;
  if (!d) { d = freshDraft(item.key); drafts.set(card.ask, d); }
  d.answer = answer;
  if (item && item.key !== d.key && d.phase !== "sending") reset(d, item.key);
  // A listed item does not prove new questions: a sent card goes back to closed only when the questions read now are different.
  if (item && d.phase === "sent" && d.sent && !d.checking) {
    d.checking = true;
    Promise.resolve().then(() => answer.detail(d.key)).then((now) => {
      d.checking = false;
      if (d.phase === "sent" && now && (now.stamp !== d.sent.stamp || now.digest !== d.sent.digest)) { reset(d, d.key); d.paint?.(); }
    }, () => { d.checking = false; });
  }
  const li = h("li", { class: "simple-card" });
  const body = () => {
    const off = d.phase === "sending" ? true : undefined;
    const status = h("p", { class: "muted", "aria-live": "polite" }, d.note);
    d.status = status;
    const parts = [h("strong", {}, card.title), card.line ? h("p", { class: "muted" }, card.line) : null];
    if (d.phase === "closed" || d.phase === "loadFailed") {
      parts.push(h("button", { type: "button", class: "btn primary simple-big", "data-focus": `simple-ask-${card.id}`, onClick: () => open(d) }, ANSWER.open));
    } else if (d.phase === "loading") {
      parts.push(h("p", {}, ANSWER.loading));
    } else if (d.phase === "open" || d.phase === "sending") {
      parts.push(...questionBlocks(d.detail).map((b) => blockView(d, b, off)),
        h("button", { type: "button", class: "btn primary simple-big", disabled: off, "data-focus": `simple-ask-send-${card.id}`, onClick: () => send(d) }, ANSWER.send));
    }
    parts.push(status);
    return parts;
  };
  d.paint = () => mount(li, ...body());
  d.paint();
  return li;
}
