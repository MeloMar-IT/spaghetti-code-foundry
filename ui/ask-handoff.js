import { pageLink } from "./ask-model.js";

// Taking an answer of Ask SCF to another page. Pure: the words, the checks of what the server offered, and the preview.
// The server works out every offer (and checks it again at the confirm); nothing here decides what may be copied.

const REFINEMENT_NOTE = "Refinement opens its New session form with this text. You can change it there. Nothing is saved until you press Start session. Administrators of this Foundry can read refinement sessions.";
const NAVIGATION_NOTE = "This page opens. Nothing is copied.";

/** The fixed words for each target: the title (also for the record), the confirm label and a note. */
export const TARGET_WORDS = {
  run: { title: "Run details", confirm: "Open run details", note: NAVIGATION_NOTE },
  problems: { title: "Problems", confirm: "Open Problems", note: NAVIGATION_NOTE },
  "your-turn": { title: "Your turn on Home", confirm: "Open Home", note: NAVIGATION_NOTE },
  refinement: { title: "Refinement", confirm: "Open Refinement", note: REFINEMENT_NOTE },
  "issue-draft": { title: "Refinement", confirm: "Open Refinement", note: REFINEMENT_NOTE },
};

const ADMIN_ONLY = new Set(["problems", "your-turn"]);
const TITLE_MAX = 120;
const TEXT_MAX = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `v` has the shape of a conversation id. */
export const isConversationId = (v) => typeof v === "string" && UUID.test(v);

function fillOf(f) {
  if (f === undefined) return { ok: true };
  if (!f || typeof f !== "object") return { ok: false };
  if (typeof f.title !== "string" || !f.title || f.title.length > TITLE_MAX) return { ok: false };
  if (typeof f.text !== "string" || !f.text || f.text.length > TEXT_MAX) return { ok: false };
  if (f.repo !== undefined && (typeof f.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(f.repo))) return { ok: false };
  if (!isConversationId(f.fromHelp)) return { ok: false };
  return { ok: true, fill: { title: f.title, text: f.text, ...(f.repo ? { repo: f.repo } : {}), fromHelp: f.fromHelp } };
}

/** The offers the server gave, kept only when every part is something this display can show and send back. */
export function offersOf(raw, role) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw) {
    if (!o || typeof o !== "object" || typeof o.key !== "string" || !o.key) continue;
    if (!Object.hasOwn(TARGET_WORDS, o.where)) continue;
    if (ADMIN_ONLY.has(o.where) && role !== "admin") continue;
    if (typeof o.page !== "string" || pageLink(role, o.page)?.href !== o.page) continue;
    const f = fillOf(o.fill);
    if (!f.ok) continue;
    out.push({ key: o.key, where: o.where, title: typeof o.title === "string" && o.title ? o.title : TARGET_WORDS[o.where].title, page: o.page, ...(f.fill ? { fill: f.fill } : {}) });
  }
  return out;
}

/** What the preview shows: the target, the rows (only what the fill holds), the note and the confirm label. */
export function previewOf(offer, conversationTitle = "") {
  const words = TARGET_WORDS[offer.where];
  const f = offer.fill;
  const rows = f
    ? [
        { label: "Title", text: f.title },
        { label: "Text", text: f.text },
        ...(f.repo ? [{ label: "Repository (chosen in the form; you can change it)", text: f.repo }] : []),
        { label: "Link back (saved in the session; only you can see it)", text: `This Ask SCF conversation: ${conversationTitle}` },
      ]
    : [];
  return { title: offer.title || words.title, rows, nothing: !f, note: words.note, confirm: words.confirm };
}

/** The wish the refinement page takes: the fill, or nothing for a hand-off that only opens a page. */
export const wishOf = (offer) => (offer?.fill ? { page: "refinement", wish: { fill: offer.fill } } : null);

/** The hand-offs recorded for one answer, as lines. A link only for a page of the role. */
export function recordsOf(conversation, messageId, role) {
  const list = Array.isArray(conversation?.handoffs) ? conversation.handoffs : [];
  return list
    .filter((r) => r && r.message === messageId && Object.hasOwn(TARGET_WORDS, r.where))
    .map((r) => ({ text: `You took this answer to ${TARGET_WORDS[r.where].title}`, href: pageLink(role, r.page)?.href ?? null, at: r.at }));
}

/** The event that opens the drawer on one conversation (the link back from a session). */
export const ASK_OPEN_EVENT = "scf-ask-open";

export function openAskConversation(id) {
  if (typeof CustomEvent === "function") globalThis.dispatchEvent?.(new CustomEvent(ASK_OPEN_EVENT, { detail: { id } }));
}
