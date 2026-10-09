import { api } from "./api.js";
import { aiProps, h, modal, toast } from "./dom.js";

// The talk of a refinement session: the architect's questions, the person's answers and the map. Every text is set as text, never as HTML.

export const ASK_ROUND = "Ask the architect for questions";
export const ANOTHER_ROUND = "Ask for another round";
export const NO_BRIEF = "Ask the architect to look at the code first. Then it can ask its questions.";
export const ROUND_NOTE = "The architect then reads your answers, proposes entries for the map and asks what is still open.";
export const ROUND_WAIT = "Answer every question to ask for another round.";
export const TALK_HIDDEN = "The talk is not shown while the repository is not in My repositories.";
const NOTHING_LEFT = "The architect has nothing important left to ask";
const VIEW_LABELS = { need: "The user's need", build: "The build", test: "The test" };
const LIST_TITLES = { rules: "Rules", examples: "Examples", open: "Open questions" };
const LIST_OF = { rule: "rules", example: "examples", open: "open" };
const LIST_WORD = { rule: "a rule", example: "an example", open: "an open question" };
const EMPTY = { rounds: [], proposals: [], map: { rules: [], examples: [], open: [] }, asked: [] };

/** Texts typed but not sent yet, by session: they survive a redraw. */
export const drafts = new Map();

const text = (s) => String(s ?? "").trim();

/** What the architect's run is for: "brief" (also when there is no run), "round", "question", "suggest", "review", "impact", "ready" or "split". */
export const kindOf = (a) => (["round", "question", "suggest", "review", "impact", "ready", "split"].includes(a?.kind) ? a.kind : "brief");

/** True when the buttons and fields of the talk may be shown: an own session that is open and whose repository is there. */
export const mayChange = (s) => Boolean(s?.mine) && s.state !== "dropped" && s.repoAvailable !== false && !s.talkHidden;

/** The answer of a question in words, or "" when it is open. */
export function answerText(q) {
  const a = q?.answer;
  if (!a) return "";
  if (a.option !== undefined) return `Option ${a.option}: ${q.options?.[a.option - 1]?.text ?? ""}`;
  if (a.text !== undefined) return a.text;
  return "I don't know yet";
}

/** The line about open questions of the map, or "" when there are none. */
export function openLine(n) {
  if (!n) return "";
  return `${n} open ${n === 1 ? "question" : "questions"} — a story with open questions is not ready`;
}

/** The sentence of the architect for a round with nothing left to ask. */
export const doneText = (d) => text(d) || NOTHING_LEFT;

const lastRound = (talk) => talk?.rounds?.at(-1);
const hasOpen = (talk) => Boolean(lastRound(talk)?.questions?.some((q) => !q.answer));

/** The label of the button that asks for a round, or "" when there is none. */
export function roundLabel(s) {
  if (!mayChange(s)) return "";
  const state = s.architect?.state;
  const kind = kindOf(s.architect);
  if (state === "queued" || state === "running") return "";
  if (state === "paused") return kind === "round" ? "Ask again" : "";
  if (state === "failed" && kind === "round") return "Try again";
  if (!s.brief) return "";
  const talk = s.talk ?? EMPTY;
  if (!talk.rounds.length) return ASK_ROUND;
  return hasOpen(talk) ? "" : ANOTHER_ROUND;
}

/** The question of the person that the architect has not answered yet, from the log; "" when it is not known. */
export function pendingQuestion(s) {
  const l = [...(s?.log ?? [])].reverse().find((x) => x.what === "asked");
  return text(l?.detail);
}

/** The label of the button that asks an own question again, or "" when there is none. */
export function againLabel(s) {
  if (!mayChange(s) || kindOf(s.architect) !== "question") return "";
  const state = s.architect?.state;
  if (state === "paused") return "Ask again";
  if (state === "failed") return pendingQuestion(s) ? "Try again" : "";
  return "";
}

/** True when the field for an own question is shown. */
export function canAsk(s) {
  if (!mayChange(s)) return false;
  const state = s.architect?.state;
  return !state || state === "idle" || state === "failed";
}

/** The draft is dropped when the call worked, before the page is drawn again. */
const forget = async (key, call) => {
  const next = await call;
  drafts.delete(key);
  return next;
};

const withDetail = (base, d) => (text(d) ? `${base}: ${text(d)}` : base);

/** A log line of the talk in words, or "" when the line is not one of the talk. Never shows a run id. */
export function talkLogText(entry) {
  const who = entry.who || "Someone";
  const d = entry.detail;
  const what = LIST_WORD[entry.list];
  switch (entry.what) {
    case "round-started": return `${who} asked the architect for a round of questions`;
    case "architect-round": return "The architect wrote its questions";
    case "question": return withDetail("The architect asked", d);
    case "answered": return withDetail(`${who} answered`, d);
    case "open-added": return withDetail("An open question was added", d);
    case "entry-accepted": return withDetail(`${who} accepted ${what ?? "an entry"} for the map`, d);
    case "entry-rejected": return withDetail(`${who} rejected a proposed ${what ? what.replace(/^an? /, "") : "entry"}`, d);
    case "entry-changed": return withDetail(`${who} changed ${what ?? "an entry"}`, d);
    case "entry-removed": return withDetail(`${who} removed ${what ?? "an entry"} from the map`, d);
    case "asked": return withDetail(`${who} asked the architect`, d);
    case "architect-answered": return withDetail("The architect answered", d);
    case "round-done": return withDetail("The architect has nothing important left to ask", d);
    case "proposals-left-out": {
      const n = Number(d);
      if (n === 1) return "1 proposed entry was left out: too many are waiting";
      if (Number.isInteger(n) && n > 1) return `${n} proposed entries were left out: too many are waiting`;
      return "Some proposed entries were left out: too many are waiting";
    }
    default: return "";
  }
}

/** Asks for a new text of a map entry. Resolves true when it was changed. */
function editDialog(ctx, sessionId, entry) {
  let busy = false;
  return modal("Edit entry", (close) => {
    const area = h("textarea", { name: "entry", rows: 4, value: entry.text });
    const err = h("p", { class: "status bad flush" });
    const run = async () => {
      if (busy) return;
      const next = text(area.value);
      if (!next) return void (err.textContent = "Write the entry.");
      if (next === entry.text) return close(undefined);
      err.textContent = "";
      busy = true;
      // A failure shows the server's sentence as a toast and reloads the page; the dialog closes so no retry runs against the old page.
      const ok = await ctx.send(save, () => api.changeMapEntry(sessionId, entry.id, next));
      busy = false;
      close(ok ? true : undefined);
    };
    const save = h("button", { class: "primary", onClick: run }, "Save");
    return h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, "Entry"), area), err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  }, { busy: () => busy });
}

function questionCard(s, q, can, ctx) {
  const answered = Boolean(q.answer);
  const key = `${s.id} own ${q.id}`;
  const area = h("textarea", { rows: 2, "data-focus": `own-${q.id}`, value: drafts.get(key) ?? "", onInput: () => drafts.set(key, area.value) });
  const sendOwn = (e) => {
    const t = text(area.value);
    if (!t) return toast("Write your answer first.", "error");
    return ctx.send(e.currentTarget, () => forget(key, api.answerQuestion(s.id, q.id, { text: t })));
  };
  return h("div", { class: "card" },
    // Only the architect's question, reason and options are in the AI region; the person's answer and form stay outside it.
    h("div", { class: "stack", ...aiProps("question from the architect") },
    h("div", { class: "row" }, h("span", { class: "pill" }, VIEW_LABELS[q.view] ?? q.view), h("b", {}, q.text)),
    h("p", { class: "muted" }, `Why it matters: ${q.why}`),
    h("ol", {}, q.options.map((o, i) => {
      const n = i + 1;
      return h("li", { class: "entry" }, o.text, " ", h("span", { class: "muted" }, `Trade-off: ${o.tradeoff}`),
        q.recommended === n ? h("span", { class: "pill ok" }, "Recommended") : null,
        !answered && can ? h("button", { class: "small", "data-focus": `opt-${q.id}-${n}`, "aria-label": `Choose option ${n}`,
          onClick: (e) => ctx.send(e.currentTarget, () => api.answerQuestion(s.id, q.id, { option: n })) }, "Choose") : null);
    }))),
    answered ? h("p", { class: "said" }, h("b", {}, "Answer: "), answerText(q)) : null,
    !answered && can ? [
      h("label", { class: "field" }, h("span", {}, "My own answer"), area),
      h("div", { class: "row" },
        h("button", { class: "small", "data-focus": `own-send-${q.id}`, onClick: sendOwn }, "Send my answer"),
        h("button", { class: "small", "data-focus": `unknown-${q.id}`,
          onClick: (e) => ctx.send(e.currentTarget, () => api.answerQuestion(s.id, q.id, { unknown: true })) }, "I don't know yet")),
    ] : null,
    !answered && !can ? h("p", { class: "muted" }, "Not answered yet.") : null);
}

function questionsSection(s, talk, can, kind, ctx) {
  const state = s.architect?.state;
  const label = roundLabel(s);
  const rounds = talk.rounds;
  const line = kind === "round" ? ctx.line : null;
  const again = againLabel(s);
  const waiting = kind === "question" && ["queued", "running", "paused", "failed"].includes(state);
  const asking = canAsk(s);
  const askKey = `${s.id} ask`;
  const area = h("textarea", { rows: 3, "data-focus": "ask", value: drafts.get(askKey) ?? "", onInput: () => drafts.set(askKey, area.value) });
  const sendAsk = (e) => {
    const t = text(area.value);
    if (!t) return toast("Write your question first.", "error");
    return ctx.send(e.currentTarget, () => forget(askKey, api.askOwnQuestion(s.id, t)));
  };
  return h("section", { class: "talk" },
    h("h2", {}, "Questions"),
    rounds.map((r, i) => [
      h("h3", {}, `Round ${i + 1}`),
      r.questions.map((q) => questionCard(s, q, can, ctx)),
      r.done ? h("p", { class: "status ok", ...aiProps("closing note of the round") }, doneText(r.done)) : null,
    ]),
    line,
    !rounds.length && !line ? h("p", { class: "muted" }, !s.brief ? NO_BRIEF : "No questions yet.") : null,
    label ? h("button", { class: label === ASK_ROUND || label === ANOTHER_ROUND ? "primary" : "", "data-focus": "round",
      onClick: (e) => ctx.send(e.currentTarget, () => api.askRound(s.id)) }, label) : null,
    label === ANOTHER_ROUND ? h("p", { class: "muted" }, ROUND_NOTE) : null,
    can && hasOpen(talk) ? h("p", { class: "muted" }, ROUND_WAIT) : null,
    h("h3", {}, "Questions to the architect"),
    talk.asked.map((a) => h("div", { class: "card" },
      h("p", { class: "said" }, h("b", {}, "Question: "), a.question),
      h("p", { class: "said", ...aiProps("answer of the architect") }, h("b", {}, "The architect: "), a.answer))),
    waiting ? h("div", { class: "card" },
      pendingQuestion(s) ? h("p", { class: "said" }, h("b", {}, "Question: "), pendingQuestion(s)) : null,
      ctx.line,
      again ? h("button", { class: "small", "data-focus": "again",
        onClick: (e) => ctx.send(e.currentTarget, () => api.askOwnQuestion(s.id, pendingQuestion(s))) }, again) : null) : null,
    !talk.asked.length && !waiting && !asking ? h("p", { class: "muted" }, "No questions to the architect yet.") : null,
    asking ? [
      h("label", { class: "field" }, h("span", {}, "Ask the architect a question"), area),
      h("div", { class: "row" }, h("button", { "data-focus": "ask-send", onClick: sendAsk }, "Send my question")),
    ] : null);
}

function mapSection(s, talk, can, ctx) {
  const open = talk.map.open.length;
  return h("section", { class: "talk" },
    h("h2", {}, "Map"),
    openLine(open) ? h("p", { class: "status open-line" }, openLine(open)) : null,
    ["rules", "examples", "open"].map((key) => {
      const entries = talk.map[key];
      const proposals = talk.proposals.filter((p) => LIST_OF[p.list] === key);
      return [
        h("h3", {}, LIST_TITLES[key]),
        !entries.length && !proposals.length ? h("p", { class: "muted" }, "None yet.") : h("ul", {},
          entries.map((e) => h("li", { class: "entry" }, h("span", { class: "said" }, e.text),
            can ? [
              h("button", { class: "small", "data-focus": `edit-${e.id}`, onClick: async () => {
                await editDialog(ctx, s.id, e);
              } }, "Edit"),
              h("button", { class: "small danger", "data-focus": `remove-${e.id}`, onClick: (ev) => {
                const btn = ev.currentTarget;
                if (!confirm("Remove this entry from the map?")) return;
                return ctx.send(btn, () => api.removeMapEntry(s.id, e.id));
              } }, "Remove"),
            ] : null)),
          proposals.map((p) => h("li", { class: "entry" }, h("span", aiProps("proposed map entry"), h("span", { class: "pill" }, "Proposed"), " ", h("span", { class: "said" }, p.text)),
            can ? [
              h("button", { class: "small", "data-focus": `accept-${p.id}`, onClick: (e) => ctx.send(e.currentTarget, () => api.acceptProposal(s.id, p.id)) }, "Accept"),
              h("button", { class: "small", "data-focus": `reject-${p.id}`, onClick: (e) => ctx.send(e.currentTarget, () => api.rejectProposal(s.id, p.id)) }, "Reject"),
            ] : null))),
      ];
    }));
}

/**
 * The Questions and Map parts of the session page. Returns nodes.
 * `ctx`: `send(btn, call)` runs one change at a time, shows the answer and reloads after a failure (true when it worked);
 * `line`: the status line of the architect for a round or a question run; `errorText(e)`.
 */
export function talkSection(s, ctx) {
  if (s.talkHidden) return [h("section", { class: "talk" }, h("h2", {}, "Questions"), h("p", { class: "muted" }, TALK_HIDDEN), ctx.line)];
  const talk = s.talk ?? EMPTY;
  const can = mayChange(s);
  const kind = kindOf(s.architect);
  return [questionsSection(s, talk, can, kind, ctx), mapSection(s, talk, can, ctx)];
}
