import { h, mount } from "./dom.js";
import { approveLabel, createCheckList } from "./run-checks.js";
import { ANSWER, CHECK, STUCK, WORDS, plainText, plainWords, safeText } from "./simple-words.js";
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
  for (const d of checks.values()) {
    if (d.phase === "sending") return true;
    if (d.phase !== "sent" && d.text.trim()) return true;
  }
  return false;
}

/** Forgets every draft (the page was left, or a test starts again). */
export function clearAnswerDrafts() {
  drafts.clear();
  checks.clear();
  stuck.clear();
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

// ---- Check cards (an approval or a plan to look at) and stuck cards (a failed run) ----

export const CHECK_KINDS = new Set(["approval", "approve_plan"]);

/** The item of `GET /api/your-turn/mine` that the check card `card` (with `card.approve`, a run id) can be decided through; else null. */
export function checkItemFor(card, turns) {
  if (!card?.approve || !Array.isArray(turns)) return null;
  return turns.find((i) => i && typeof i.key === "string" && i.key && i.runId === card.approve && CHECK_KINDS.has(i.kind)
    && Array.isArray(i.acts) && i.acts.includes("approve") && i.acts.includes("reject")) ?? null;
}

/** The item through which the failed run `card.stuck` can be tried again; else null. */
export function retryItemFor(card, turns) {
  if (!card?.stuck || !Array.isArray(turns)) return null;
  return turns.find((i) => i && typeof i.key === "string" && i.key && i.runId === card.stuck && i.kind === "failed"
    && Array.isArray(i.acts) && i.acts.includes("retry")) ?? null;
}

/** What was made, as one plain paragraph: the Goal of the proposal, else the summary sentence, else a fixed line. */
export function madeOf(detail, card) {
  let lines = String(detail?.proposal?.text ?? "").replace(/\r\n/g, "\n").split("\n");
  const at = lines.findIndex((l) => /^\s*#{1,6}\s*Goal\b/i.test(l));
  if (at >= 0) {
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => /^\s*#{1,6}\s/.test(l));
    const part = end >= 0 ? rest.slice(0, end) : rest;
    if (part.some((l) => l.trim())) lines = part;
  }
  const plain = plainWords(lines.map((l) => plainText(l, 1000)).filter(Boolean).join("\n"))
    .split("\n").filter(Boolean).join(" ");
  return plainText(plain, 400) || card?.sentence || CHECK.made;
}

/** What the person did on each check card, by run id. Phases: loading, loadFailed, ready, sending, sent. */
const checks = new Map();
/** The same for stuck cards: phase idle, sending, sent; `at` is the failure the draft belongs to. */
const stuck = new Map();

const freshCheck = (key, old = {}) => ({ key, phase: "ready", detail: null, open: false, text: "", note: "", sent: null, checking: false, answer: null, paint: null, status: null, ...old });

async function loadCheck(d) {
  d.phase = "loading";
  d.note = "";
  d.paint?.();
  try {
    const detail = await Promise.resolve().then(() => d.answer.detail(d.key));
    if (!detail || typeof detail !== "object") throw new Error("no detail");
    d.detail = detail;
    d.phase = "ready";
  } catch {
    d.phase = "loadFailed";
    d.note = CHECK.loadFailed;
  }
  d.paint?.();
}

async function decide(d, card, item, reject) {
  const text = d.text.trim();
  if (reject && !text) {
    d.note = CHECK.needsWhat;
    if (d.status) d.status.textContent = d.note;
    return;
  }
  const id = card.approve;
  const detail = d.detail;
  d.phase = "sending";
  d.note = CHECK.sending;
  d.paint?.();
  try {
    if (item) {
      await Promise.resolve().then(() => d.answer.act({ key: item.key, action: reject ? "reject" : "approve", stamp: detail?.stamp, digest: detail?.digest, ...(reject ? { text } : {}) }));
    } else {
      await Promise.resolve().then(() => (reject ? d.answer.rejectRun(id, text) : d.answer.approveRun(id, "")));
    }
  } catch (e) {
    if (item && e?.status === 409) {
      await loadCheck(d);
      d.note = CHECK.changed;
      d.paint?.();
      return;
    }
    d.phase = "ready";
    d.note = CHECK.failed;
    d.paint?.();
    return;
  }
  d.phase = "sent";
  d.note = CHECK.sent;
  d.text = "";
  if (item) d.sent = { stamp: detail?.stamp, digest: detail?.digest }; else checks.delete(id);
  d.paint?.();
  d.answer.done?.();
}

/**
 * The card of a check the person may decide here. `answer`: { detail, act, done, approveRun, rejectRun, tryIt? }. Returns an `li`, or
 * null when the caller draws the link card (no item, not the person's own run, and nothing was sent).
 */
export function checkCard(card, turns, answer) {
  const item = checkItemFor(card, turns);
  let d = checks.get(card.approve);
  if (!item && !card.own && d?.phase !== "sent") return null;
  if (!d) { d = freshCheck(item?.key ?? ""); checks.set(card.approve, d); }
  d.answer = answer;
  if (item && item.key !== d.key && d.phase !== "sending") Object.assign(d, freshCheck(item.key, { text: d.text, open: d.open, paint: d.paint, answer }));
  if (item && d.phase === "ready" && !d.detail) void loadCheck(d);
  // A listed item does not prove a new check: a sent card goes back to ready only when the proposal read now is different.
  if (item && d.phase === "sent" && d.sent && !d.checking) {
    d.checking = true;
    Promise.resolve().then(() => answer.detail(d.key)).then((now) => {
      d.checking = false;
      if (d.phase === "sent" && now && (now.stamp !== d.sent.stamp || now.digest !== d.sent.digest)) {
        Object.assign(d, freshCheck(d.key, { detail: now, paint: d.paint, answer: d.answer }));
        d.paint?.();
      }
    }, () => { d.checking = false; });
  }
  // The checks to try, kept per card so a focused button survives a new draw. Marks need the person's own run.
  if (card.checkRun) {
    const canMark = !!(card.own && answer.markCheck);
    if (!d.list || d.listMarks !== canMark) {
      d.listMarks = canMark;
      d.list = createCheckList({
        onMark: canMark ? async (cid, mark, rev) => {
          const r = await d.answer.markCheck(card.approve, cid, mark, rev);
          d.answer.done?.();
          return r;
        } : null,
      });
    }
    d.list.update(card.checkRun);
  }
  const li = h("li", { class: "simple-card" });
  const body = () => {
    const off = d.phase === "sending" ? true : undefined;
    const status = h("p", { class: "muted", "aria-live": "polite" }, d.note);
    d.status = status;
    const parts = [h("strong", {}, card.title), card.line ? h("p", { class: "muted" }, card.line) : null];
    if (d.phase !== "sent") {
      parts.push(h("p", {}, d.phase === "loading" ? CHECK.loading : madeOf(d.detail, card)));
      if (card.checkRun && d.list) parts.push(d.list.el);
      if (card.tryRun && answer.tryIt) {
        parts.push(h("button", { type: "button", disabled: off, "data-focus": `simple-check-try-${card.id}`, onClick: () => answer.tryIt(card.tryRun) }, WORDS.actions.tryIt));
      }
    }
    if (d.phase === "loadFailed") {
      parts.push(h("button", { type: "button", "data-focus": `simple-check-reload-${card.id}`, onClick: () => loadCheck(d) }, CHECK.reload));
    } else if (d.phase === "ready" || d.phase === "sending") {
      const box = h("textarea", {
        rows: 3, maxlength: 5000, disabled: off, "data-focus": `simple-check-box-${card.id}`, "aria-label": CHECK.what, placeholder: CHECK.what, value: d.text,
        onInput: (e) => { d.text = String(e?.target?.value ?? box.value ?? ""); },
      });
      parts.push(
        h("button", { type: "button", class: "btn primary simple-big", disabled: off, "data-focus": `simple-check-yes-${card.id}`, onClick: () => decide(d, card, item, false) }, approveLabel(card.checkRun, CHECK.yes)),
        h("details", { open: d.open ? true : undefined, onToggle: (e) => { d.open = e?.target?.open === true || e?.target?.hasAttribute?.("open") === true; } },
          h("summary", { "data-focus": `simple-check-no-${card.id}` }, CHECK.no),
          box,
          h("button", { type: "button", disabled: off, "data-focus": `simple-check-send-${card.id}`, onClick: () => decide(d, card, item, true) }, CHECK.send)));
    }
    parts.push(status);
    return parts;
  };
  d.paint = () => mount(li, ...body());
  d.paint();
  return li;
}

async function retry(d, card, item) {
  d.phase = "sending";
  d.note = STUCK.sending;
  d.paint?.();
  try {
    await Promise.resolve().then(() => (item ? d.answer.act({ key: item.key, action: "retry" }) : d.answer.resumeRun(card.stuck)));
  } catch {
    d.phase = "idle";
    d.note = STUCK.failed;
    d.paint?.();
    return;
  }
  d.phase = "sent";
  d.note = STUCK.sent;
  d.paint?.();
  d.answer.done?.();
}

/** "Not now": the card is hidden until the run fails again. */
async function putAside(d, card) {
  d.phase = "sending";
  d.note = STUCK.sending;
  d.paint?.();
  try {
    await Promise.resolve().then(() => d.answer.notNow(card.stuck));
  } catch {
    d.phase = "idle";
    d.note = STUCK.asideFailed;
    d.paint?.();
    return;
  }
  d.phase = "aside";
  d.note = "";
  d.paint?.();
  d.answer.done?.();
}

/**
 * The card of a failed run: one fixed sentence, Try again (when the run can be tried again from here) and Ask for help.
 * Never shows the reason, the step or an error text. A new failure of the same run (another `card.stuckAt`) starts a fresh draft.
 */
export function stuckCard(card, turns, answer) {
  const item = retryItemFor(card, turns);
  let d = stuck.get(card.stuck);
  if (!d || (d.at !== (card.stuckAt ?? "") && d.phase !== "sending")) {
    d = { phase: "idle", note: "", at: card.stuckAt ?? "", answer, paint: null };
    stuck.set(card.stuck, d);
  }
  d.answer = answer;
  const li = h("li", { class: "simple-card" });
  const body = () => {
    const off = d.phase === "sending" ? true : undefined;
    const parts = [h("strong", {}, card.title), h("p", {}, STUCK.line)];
    const open = d.phase !== "sent" && d.phase !== "aside";
    if ((item || card.resume) && open) {
      parts.push(h("button", { type: "button", class: "btn primary simple-big", disabled: off, "data-focus": `simple-again-${card.id}`, onClick: () => retry(d, card, item) }, STUCK.again));
    }
    parts.push(h("button", { type: "button", disabled: off, "data-focus": `simple-help-${card.id}`, onClick: () => d.answer.help?.() }, STUCK.help));
    if (d.answer.notNow && open) {
      parts.push(h("button", { type: "button", disabled: off, "data-focus": `simple-notnow-${card.id}`, onClick: () => putAside(d, card) }, STUCK.notNow));
    }
    parts.push(h("p", { class: "muted", "aria-live": "polite" }, d.note));
    return parts;
  };
  d.paint = () => mount(li, ...body());
  d.paint();
  return li;
}
