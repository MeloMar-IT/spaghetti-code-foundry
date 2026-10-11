import { h, mount } from "./dom.js";
import { mayChange } from "./refinement-draft.js";
import { importLogText } from "./refinement-import.js";
import { impactLogText } from "./refinement-impact.js";
import { ASK_BRIEF, publishable } from "./refinement-next.js";
import { onGithub } from "./refinement-publish.js";
import { readyLogText } from "./refinement-ready.js";
import { reviewLogText } from "./refinement-remarks.js";
import { splitLogText } from "./refinement-split.js";
import { suggestLogText } from "./refinement-suggest.js";
import { kindOf, talkLogText } from "./refinement-talk.js";

// The session page as one workspace: the title row stays on top, under it a row of parts shows one at a time.
// The architect's lines, the brief and the log live here too, so refinement.js stays small.

const text = (s) => String(s ?? "").trim();

/** One line of the log in words. */
export function logText(entry) {
  const who = entry.who || "Someone";
  if (entry.what === "created") return `${who} started the session`;
  if (entry.what === "renamed") return `${who} renamed it${entry.detail ? ` to "${entry.detail}"` : ""}`;
  if (entry.what === "source-refreshed") return `${who} kept the GitHub version of the issue${entry.detail ? ` ${entry.detail}` : ""}`;
  if (entry.what === "dropped") return `${who} dropped the session`;
  if (entry.what === "restored") return `${who} restored the session`;
  if (entry.what === "architect-started") return `${who} asked the architect to look at the code`;
  if (entry.what === "architect-resumed") return `${who} asked the architect to carry on`;
  if (entry.what === "architect-brief") return "The architect wrote the context brief";
  if (entry.what === "architect-failed") return `The architect could not finish${entry.detail ? `: ${entry.detail}` : ""}`;
  if (entry.what === "draft-added") return `${who} added a story draft`;
  if (entry.what === "draft-published") return `${who} published a story draft${entry.detail ? `: ${entry.detail}` : ""}`;
  if (entry.what === "draft-removed") return `${who} removed a story draft${entry.detail ? `: "${entry.detail}"` : ""}`;
  if (entry.what === "epic-set") return `${who} set the Epic${entry.detail ? ` to ${entry.detail}` : ""}`;
  if (entry.what === "epic-cleared") return `${who} cleared the Epic`;
  return importLogText(entry) || talkLogText(entry) || suggestLogText(entry) || reviewLogText(entry) || impactLogText(entry) || splitLogText(entry) || readyLogText(entry) || `${who}: ${entry.what}`;
}

const sentence = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

/** What the step is, in words for the user: never a folder or file name of the run. */
export function activityText(doing, kind = "brief") {
  const t = text(doing);
  if (!t) return "";
  if (kind !== "brief") {
    // A round, an answer, a suggestion, a review or a view: fixed sentences only, never the words of the step.
    if (/clone|check out/i.test(t)) return "Getting the code.";
    if (/reads the code/i.test(t)) return "Reading the code.";
    if (kind === "impact" && /issues/i.test(t)) return "Reading the open issues.";
    if (/^check/i.test(t)) return kind === "suggest" ? "Checking the suggestion." : kind === "review" ? "Checking the review." : kind === "impact" ? "Checking the view." : kind === "ready" ? "Checking the judgement." : kind === "split" ? "Checking the ways." : "Checking the answer.";
    if (/^getting ready/i.test(t)) return "Getting ready.";
    return "";
  }
  if (/clone|check out/i.test(t)) return "Getting the code.";
  if (/reads the code/i.test(t)) return "Reading the code and writing the brief.";
  if (/issues/i.test(t) && /read/i.test(t)) return "Reading the open issues.";
  if (/check/i.test(t) && /brief/i.test(t)) return "Checking the brief.";
  if (/[\w.-]+\/|\.\w{1,4}\b/.test(t)) return "Working on the brief.";
  return t;
}

const QUEUED_DETAIL = { brief: "Then it reads the code.", round: "Then it writes its questions.", question: "Then it answers your question.", suggest: "Then it writes a suggestion.", review: "Then it reviews your draft.", impact: "Then it looks at what your draft touches.", ready: "Then it judges what code could not decide.", split: "Then it looks for ways to split your draft." };
const RUNNING_TEXT = { brief: "The architect is at work.", round: "The architect is writing its questions.", question: "The architect is answering your question.", suggest: "The architect is writing a suggestion.", review: "The architect is reviewing your draft.", impact: "The architect is looking at what your draft touches.", ready: "The architect is judging the readiness of your draft.", split: "The architect is looking for ways to split your draft." };

/** What the architect is doing, in words: { busy, bad, text, detail }. An unknown or missing state is idle. */
export function architectStatus(a) {
  const state = a?.state;
  const kind = kindOf(a);
  if (state === "queued") return { busy: true, text: "The architect is waiting for its turn.", detail: QUEUED_DETAIL[kind] };
  if (state === "running") return { busy: true, text: RUNNING_TEXT[kind], detail: activityText(a.doing, kind) };
  if (state === "paused") return { busy: false, text: "The architect paused.", detail: sentence(text(a.reason)) };
  if (state === "failed") return { busy: false, bad: true, text: "The architect could not finish.", detail: sentence(text(a.reason)) };
  return { busy: false, text: "", detail: "" };
}

/** The label of the ask button, or "" when there is none. */
export function askLabel(s) {
  if (!s?.mine || s.state === "dropped" || s.repoAvailable === false) return "";
  const state = s.architect?.state;
  if (state === "queued" || state === "running") return "";
  const own = kindOf(s.architect) === "brief"; // a round, a question, a suggestion, a review or a view is asked again where it shows
  if (state === "paused") return own ? "Ask again" : "";
  if (state === "failed" && own) return "Try again";
  return s.brief ? "Refresh" : ASK_BRIEF;
}

/** The brief as parts: [{ title, body }], one per "## " heading. */
export function briefParts(input) {
  const parts = [];
  let cur = { title: "", lines: [] };
  for (const line of String(input ?? "").split(/\r?\n/)) {
    const m = /^## +(.+?)\s*$/.exec(line);
    if (m) {
      parts.push(cur);
      cur = { title: m[1], lines: [] };
    } else cur.lines.push(line);
  }
  parts.push(cur);
  return parts.map((p) => ({ title: p.title, body: p.lines.join("\n").trim() })).filter((p) => p.title || p.body);
}

/** "Made <date and time> · branch <name>"; the branch part only when there is one. */
export function briefMeta(brief) {
  return `Made ${new Date(brief.at).toLocaleString()}${brief.branch ? ` · branch ${brief.branch}` : ""}`;
}

/** The line for the state of the architect: a spinner while it works, its words otherwise; null when idle. */
export function statusLine(st) {
  if (st.busy) return h("div", { class: "row" }, h("span", { class: "spinner" }), h("b", {}, st.text), h("span", { class: "muted" }, st.detail));
  return st.text ? h("p", { class: st.bad ? "status bad" : "status" }, `${st.text} ${st.detail}`) : null;
}

/** The "Context brief" part: status line, button, brief. Returns nodes. */
export function briefSection(s, onAsk) {
  // Only a run for the brief draws its line here; a round or a question is shown in the talk, a suggestion, a review or a view on the draft page.
  const st = architectStatus(kindOf(s.architect) === "brief" ? s.architect : undefined);
  const label = askLabel(s);
  const b = s.brief;
  const line = statusLine(st);
  return [
    h("h2", {}, "Context brief"),
    line,
    s.briefHidden ? h("p", { class: "muted" }, "The brief is not shown while the repository is not in My repositories.") : null,
    !b && !s.briefHidden && !st.text ? h("p", { class: "muted" }, "No context brief yet.") : null,
    label ? h("button", { class: label === "Refresh" ? "" : "primary", onClick: (e) => onAsk(e.currentTarget) }, label) : null,
    b && !s.briefHidden ? h("div", { class: "card" },
      h("p", { class: "muted" }, briefMeta(b)),
      b.cut ? h("p", { class: "muted" }, "The brief was too long to keep whole; the end is missing.") : null,
      briefParts(b.text).map((p) => [
        p.title ? h("h3", {}, p.title) : null,
        h("p", { class: "flush pre-wrap wrap-anywhere" }, p.body),
      ])) : null,
  ];
}

export const PARTS = [
  { id: "brief", label: "Idea and brief" },
  { id: "talk", label: "Conversation" },
  { id: "drafts", label: "Story drafts" },
  { id: "handoff", label: "Hand off" },
  { id: "log", label: "Log" },
];

/** The part a person chose, by session id. Page memory only. */
export const chosen = new Map();

export const HANDOFF_NOTE = "Only the owner can hand off, in an open session whose repository is in My repositories.";

const visibleDrafts = (s) => (s?.draftsHidden ? [] : s?.drafts ?? []);
const isBusy = (a) => a?.state === "queued" || a?.state === "running";
const many = (n, one, other) => `${n} ${n === 1 ? one : other}`;
const unanswered = (talk) => (talk?.rounds?.at(-1)?.questions ?? []).filter((q) => !q.answer).length;

/** "drafts" when the session shows at least one draft, else "brief". */
export const defaultPart = (s) => (visibleDrafts(s).length ? "drafts" : "brief");

/** The part that already draws the architect's line: brief → "brief"; round, question → "talk"; the rest → "drafts" (or "" when drafts are hidden, then no part draws it). */
export function homePart(architect, s) {
  const kind = kindOf(architect);
  if (kind === "brief") return "brief";
  if (kind === "round" || kind === "question") return "talk";
  return s?.draftsHidden ? "" : "drafts";
}

/** The short state of each part: { brief, talk, drafts, handoff, log }. */
export function partSummary(s) {
  const x = s ?? {};
  const kind = kindOf(x.architect);
  const busy = isBusy(x.architect);
  const talk = x.talkHidden ? undefined : x.talk;
  const drafts = visibleDrafts(x).filter((d) => d.state !== "split");
  const open = unanswered(talk) + (talk?.map?.open?.length ?? 0);
  const proposed = talk?.proposals?.length ?? 0;
  const ready = drafts.filter((d) => d.state === "ready").length;
  const github = onGithub(x).length;
  const publish = publishable(visibleDrafts(x)).length;
  let conversation = open ? many(open, "question", "questions") + " open" : "no questions open";
  if (proposed) conversation += `, ${proposed} proposed`;
  if (busy && (kind === "round" || kind === "question")) conversation += ", working";
  const hand = [github ? `${github} on GitHub` : "", publish ? `${publish} ready` : ""].filter(Boolean).join(", ");
  return {
    brief: x.briefHidden ? "not shown" : busy && kind === "brief" ? "working" : x.brief ? "made" : "none",
    talk: x.talkHidden ? "not shown" : conversation,
    drafts: x.draftsHidden ? "not shown" : drafts.length ? `${many(drafts.length, "draft", "drafts")}, ${ready} ready` : "no drafts",
    handoff: x.draftsHidden ? "not shown" : hand || "nothing ready",
    log: "",
  };
}

const lower = (t) => t.charAt(0).toLowerCase() + t.slice(1);
const STEPS = {
  ask: { part: "brief", text: lower(ASK_BRIEF) },
  answer: { part: "talk", text: "answer the questions" },
  draft: { part: "drafts", text: "add a draft" },
  check: { part: "drafts", text: "check readiness" },
  publish: { part: "handoff", text: "publish" },
};
const step = (name) => ({ step: name, ...STEPS[name] });

/** The next step, or null: { step: "ask"|"answer"|"draft"|"check"|"publish", part, text }. Advice only; it follows `sessionNext`. */
export function nextStep(s) {
  if (!s || s.state === "dropped" || !s.mine || s.repoAvailable === false) return null;
  if (["queued", "running", "paused", "failed"].includes(s.architect?.state)) return null;
  const drafts = visibleDrafts(s);
  const talk = s.talkHidden ? undefined : s.talk;
  if (s.source?.replace === "due") return step("publish");
  if (s.state === "published") return null;
  if (publishable(drafts).length) return step("publish");
  if (unanswered(talk) || talk?.proposals?.length) return step("answer");
  if (!drafts.length) return step(s.brief ? "draft" : "ask");
  if (talk?.map?.open?.length) return step("answer");
  const drafting = drafts.filter((d) => d.state !== "split" && !d.published);
  if (drafting.some((d) => !d.readiness || d.readiness.stale)) return step("check");
  if (!s.brief && drafting.some((d) => (d.readiness.items ?? []).some((i) => i.result === "unsure"))) return step("ask");
  return step("check");
}

/** "" when the hand-off part draws itself, else the reason it is empty. */
export const handoffNote = (s) => (mayChange(s) ? "" : HANDOFF_NOTE);

/**
 * The tab row and panels. `parts`: [{ id, label, node }]; `id`: the session id; `initial`: the part to open.
 * Returns { node, show(partId, { focus } = {}), update({ summary, next, line }), current() }.
 * `line`: { home, st } while the architect is busy, else null. The panels are hidden, never rebuilt, so typed text stays.
 */
export function workspace({ id, parts, initial }) {
  const uid = `ws${Math.random().toString(36).slice(2, 8)}`;
  const ids = parts.map((p) => p.id);
  let cur = Math.max(0, ids.indexOf(initial));
  const states = parts.map(() => h("span", { class: "part-state" }));
  const select = (i, { byUser = false, focus = false } = {}) => {
    cur = i;
    if (byUser) chosen.set(id, ids[i]);
    tabs.forEach((b, j) => {
      b.setAttribute("aria-selected", String(j === cur));
      b.tabIndex = j === cur ? 0 : -1; // the property, so the arrow keys move between the tabs and Tab leaves the row
      panels[j].hidden = j !== cur;
    });
    drawLine();
    if (focus) tabs[cur].focus();
  };
  // A link to the page's own address, not a button: the parts also open in a read-only preview, which shows no buttons.
  const tabs = parts.map((p, i) => h("a", {
    href: `#/refinement/${encodeURIComponent(id)}`, role: "tab", class: "scf-tabs__tab", id: `${uid}-tab-${i}`, "aria-controls": `${uid}-panel-${i}`,
    "data-part": p.id, "data-focus": `part-${p.id}`,
    onClick: (e) => {
      e?.preventDefault?.(); // the address stays as it is
      select(i, { byUser: true });
    },
    onKeydown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault?.();
        return select(i, { byUser: true });
      }
      const to ={ ArrowRight: (i + 1) % parts.length, ArrowLeft: (i - 1 + parts.length) % parts.length, Home: 0, End: parts.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault?.();
      select(to, { byUser: true, focus: true });
    },
  }, p.label, " ", states[i]));
  const panels = parts.map((p, i) => h("div", { role: "tabpanel", class: "scf-tabs__panel", id: `${uid}-panel-${i}`, "aria-labelledby": `${uid}-tab-${i}` }, p.node));
  const list = h("div", { role: "tablist", "aria-label": "Session parts", class: "scf-tabs__list" }, tabs);
  const nextBox = h("div");
  const lineBox = h("div");
  let nextKey = "";
  let line = null;
  let lineKey = "";
  function drawLine() {
    const key = line && line.home !== ids[cur] ? JSON.stringify(line) : "";
    if (key === lineKey) return;
    lineKey = key;
    lineBox.replaceChildren(...(key ? [statusLine(line.st)].filter(Boolean) : []));
  }
  const show = (partId, { focus = false } = {}) => {
    const i = ids.indexOf(partId);
    if (i >= 0) select(i, { byUser: true, focus });
  };
  const update = ({ summary = {}, next = null, line: l = null } = {}) => {
    parts.forEach((p, i) => {
      states[i].textContent = summary[p.id] ?? "";
    });
    const key = JSON.stringify(next);
    if (key !== nextKey) {
      nextKey = key;
      mount(nextBox, next ? h("button", { type: "button", class: "ws-next", "data-focus": "next-part", onClick: () => show(next.part, { focus: true }) }, `Next: ${next.text}`) : null);
    }
    line = l;
    drawLine();
  };
  const node = h("div", { class: "scf-tabs session-parts" }, list, nextBox, lineBox, panels);
  select(cur);
  return { node, show, update, current: () => ids[cur] };
}
