import { api, holdReload } from "./api.js";
import { confirmDialog, h, modal, mount, timeAgo, toast } from "./dom.js";
import { draftSection, unsaved } from "./refinement-draft.js";
import { dialogOpen } from "./live.js";
import { announcer, failState } from "./refinement-states.js";
import { banner, emptyState, loadingState, staleNote } from "./states.js";
import { renderBacklog } from "./refinement-backlog.js";
import { importDialog, importLogText, sourceSection } from "./refinement-import.js";
import { publishSection } from "./refinement-publish.js";
import { impactLogText } from "./refinement-impact.js";
import { splitLogText } from "./refinement-split.js";
import { readyLogText } from "./refinement-ready.js";
import { reviewLogText } from "./refinement-remarks.js";
import { suggestLogText } from "./refinement-suggest.js";
import { drafts as talkDrafts, kindOf, talkLogText, talkSection } from "./refinement-talk.js";

/** The states of a refinement session, in words. The first story draft makes it Drafting; Drop and Restore change it too. A session is Ready when every draft is ready. */
export const STATE_LABELS = {
  exploring: "Exploring",
  drafting: "Drafting",
  ready: "Ready",
  published: "Published",
  dropped: "Dropped",
};

const text = (s) => String(s ?? "").trim();

/** What is missing in the input, or "" when it can be sent. */
export function sessionProblem({ repo, idea } = {}) {
  if (!text(repo)) return "Choose a repository.";
  if (!text(idea)) return "Describe your idea.";
  return "";
}

/** The request body: the title is left out when it is blank. */
export function sessionBody({ repo, idea, title }) {
  const body = { repo: text(repo), idea: String(idea ?? "") };
  if (text(title)) body.title = text(title);
  return body;
}

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

const ASK = "Ask the architect to look at the code";
/** How often the session page asks again while the architect is queued or running, in ms. */
export const POLL_MS = 5000;
let poll; // one session page at a time
const stopPoll = () => {
  clearTimeout(poll);
  poll = undefined;
};
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
  return s.brief ? "Refresh" : ASK;
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
function statusLine(st) {
  if (st.busy) return h("div", { class: "row" }, h("span", { class: "spinner" }), h("b", {}, st.text), h("span", { class: "muted" }, st.detail));
  return st.text ? h("p", { class: st.bad ? "status bad" : "status" }, `${st.text} ${st.detail}`) : null;
}

/** The "Context brief" part: status line, button, brief. Returns nodes. */
function briefSection(s, onAsk) {
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

/** The server's sentence for a failed call. */
export function errorText(e) {
  if (e instanceof TypeError) return "Could not reach the server.";
  return e?.message || "Something went wrong.";
}

async function whileBusy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}

// Each load gets a number; an answer that is not the newest load, or that arrives after the person left the page, is dropped.
let generation = 0;
// The page drawn last (`id` is undefined for the list), so an Undo knows what to draw again.
let openPage = { id: undefined, reload: async () => {} };
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent((location.hash ?? "").split("?")[0].split("/")[1] ?? "") === "refinement";
  } catch {
    return false;
  }
};

const date = (iso) => new Date(iso).toLocaleDateString();
const goTo = (hash) => {
  location.hash = hash;
};

let showDropped = false;

/** True when a question or answer of this session is typed and not sent: a poll must not draw over it, and a 401 must not reload the browser. */
const talkText = (id) => [...talkDrafts].some(([k, v]) => k.startsWith(`${id} `) && text(v));
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", (e) => {
    if (![...talkDrafts.values()].some(text)) return;
    e.preventDefault();
    e.returnValue = "";
  });
}

/** Asks for the repository, the idea and an optional title. Resolves with the new session, or undefined when closed. */
function newSessionDialog(repos, onMade) {
  return modal("New refinement session", (close) => {
    if (!repos.length) {
      return h("div", { class: "stack" },
        h("p", { class: "muted" }, "You need a GitHub repository first. Add one under My repositories."),
        h("a", { href: "#/repos", onClick: () => close(undefined) }, "Go to My repositories"));
    }
    const select = h("select", { name: "repo" }, repos.map((r) => h("option", { value: r }, r)));
    select.value = repos[0];
    const title = h("input", { name: "title", placeholder: "Optional. The first line of the idea is used when empty.", autocomplete: "off" });
    const idea = h("textarea", { name: "idea", rows: 8, placeholder: "Describe your idea in your own words" });
    const err = h("p", { class: "status bad flush" });
    let busy = false;
    const run = async () => {
      if (busy) return;
      const input = { repo: select.value, idea: idea.value, title: title.value };
      const problem = sessionProblem(input);
      if (problem) return void (err.textContent = problem);
      busy = true;
      start.disabled = true;
      err.textContent = "";
      try {
        const made = await api.createRefinement(sessionBody(input));
        onMade?.(made); // also when the dialog was closed while the request ran
        close(made);
      } catch (e) {
        busy = false;
        err.textContent = errorText(e);
        start.disabled = false;
      }
    };
    const start = h("button", { class: "primary", onClick: run }, "Start session");
    return h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, "Repository"), select),
      h("label", { class: "field" }, h("span", {}, "Title"), title),
      h("label", { class: "field" }, h("span", {}, "Your idea"), idea),
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), start));
  });
}

/** Asks for a new title. Resolves true when the session was renamed. */
function renameDialog(session, onRenamed) {
  return modal("Rename session", (close) => {
    const input = h("input", { name: "title", value: session.title, autocomplete: "off" });
    const err = h("p", { class: "status bad flush" });
    let busy = false;
    const run = async () => {
      if (busy) return;
      const title = text(input.value);
      if (!title) return void (err.textContent = "Give the session a title.");
      busy = true;
      save.disabled = true;
      err.textContent = "";
      try {
        await api.renameRefinement(session.id, { title });
      } catch (e) {
        busy = false;
        err.textContent = errorText(e);
        save.disabled = false;
        return;
      }
      toast("Session renamed");
      onRenamed?.();
      close(true);
    };
    const save = h("button", { class: "primary", onClick: run }, "Save");
    return h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, "Title"), input), err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
}

/** The Refinement pages: the list (no `id`) and one session. Returns a cleanup. */
export async function renderRefinement(main, { admin = false, id, readOnly = false, quiet = false } = {}) {
  // In a preview the server answers as the viewed user (`mine: true`); every button hangs on `mine`, so it is turned off here.
  const seen = (s) => (readOnly ? { ...s, mine: false } : s);
  const mine = ++generation;
  stopPoll();
  const current = () => mine === generation && onPage();
  // A reload draws a new page; the cleanup the app holds must reach that page, so navigation always ends the current one.
  let reloaded;
  let reloadList; // the list reads itself again in place; a session draws itself again, without a skeleton so the focus stays
  const reload = (loud = false) => {
    if (reloadList) return reloadList();
    return renderRefinement(main, { admin, id, readOnly, quiet: !loud }).then((c) => {
      reloaded = c;
    }, (e) => toast(errorText(e), "error"));
  };
  openPage = { id, reload };
  const restoreNow = async (sid) => {
    try {
      await api.restoreRefinement(sid);
      toast("Session restored");
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const restore = (btn, sid) =>
    whileBusy(btn, async () => {
      await restoreNow(sid);
      await reload();
    });
  // Undo after Drop runs when the person may be elsewhere: draw only the page they are on, never the dropped session over it.
  const undoDrop = async (sid) => {
    await restoreNow(sid);
    if (onPage() && (openPage.id === undefined || openPage.id === sid)) await openPage.reload();
  };
  let leaveDrafts = () => {};
  const cleanup = () => {
    if (reloaded) return reloaded();
    leaveDrafts(); // text that waits for its timer is sent now
    holdReload(null);
    generation++;
    stopPoll();
  };

  if (id === "backlog") {
    let repos = [];
    // A preview makes no request: the list is read with the owner's GitHub sign-in.
    if (!readOnly) {
      try {
        repos = (await api.refinement()).repos;
      } catch (err) {
        if (!current()) return () => {};
        throw err;
      }
    }
    if (!current()) return () => {};
    const leave = await renderBacklog(main, { repos, readOnly, errorText, current, goTo });
    return () => {
      leave();
      cleanup();
    };
  }

  if (id) {
    // Not found and no permission are their own states; a failure that may pass can be tried again.
    const gone = (e) => mount(main, failState(e, { errorText, onRetry: () => reload(true) }));
    if (!quiet) mount(main, loadingState("Loading the session", { rows: 4, shape: "detail" }));
    let s;
    try {
      s = seen(await api.refinementSession(id));
    } catch (e) {
      if (!current()) return () => {};
      gone(e);
      return cleanup;
    }
    if (!current()) return () => {};
    const upper = h("div");
    const lower = h("div");
    const note = h("div"); // "Could not refresh" while the poll fails
    const waiting = announcer(); // "The architect is working", said once
    let at = Date.now(); // when the page last had an answer
    let noteUp = false;
    let inflight = false; // one poll request at a time, also for Retry
    let held = null; // the newest answer that waits while the person types
    let holdTimer;
    const pendingText = () => {
      const el = document.activeElement;
      const typing = Boolean(el) && ["TEXTAREA", "INPUT"].includes(String(el.tagName ?? el.tag ?? "").toUpperCase()) && upper.contains(el);
      return typing || talkText(id);
    };
    const holding = () => pendingText() || dialogOpen(); // the draft editor guards its own unsaved fields
    const textWaits = () => pendingText() || unsaved.size > 0;
    holdReload(() => unsaved.size > 0 || talkText(id)); // a 401 of any call keeps the page while text waits
    let shownUpper = null;
    let shownLower = null;
    let shown = "";
    let draws = 0; // counts the pages drawn: a poll that began before one is out of date
    const show = (next) => {
      draws++;
      held = null;
      at = Date.now();
      if (noteUp) {
        noteUp = false;
        mount(note);
      }
      const json = JSON.stringify(next);
      if (json !== shown) {
        shown = json;
        draw(next);
      }
      stopPoll();
      if (architectStatus(next.architect).busy) poll = setTimeout(tick, POLL_MS);
    };
    // An answer that came while the person types waits; the newest one is drawn when the typing and the dialog are over.
    const release = () => {
      holdTimer = undefined;
      if (!held || !current()) return;
      if (held.draws !== draws) held = null; // a newer page was drawn meanwhile
      else if (holding()) holdTimer = setTimeout(release, 250);
      else show(held.next);
    };
    const tick = async () => {
      poll = undefined;
      if (!current() || inflight) return;
      const before = draws;
      let next;
      inflight = true;
      try {
        next = seen(await api.refinementSession(id, unsaved.size > 0 || talkText(id))); // typed text: a 401 must not reload the browser
      } catch (e) {
        inflight = false;
        if (!current()) return;
        if (e?.status === 404 || e?.status === 403) {
          if (!textWaits()) return gone(e);
          // The page stays so typed text can still be copied; polling stops.
          noteUp = true;
          return mount(note, banner("error", `${errorText(e)} Your typed text is still here. Copy it before you leave.`));
        }
        if (!noteUp) {
          noteUp = true;
          mount(note, staleNote(at, { failed: true, onRetry: () => { stopPoll(); tick(); } }));
        }
        if (before === draws) poll = setTimeout(tick, POLL_MS); // the page stays; the next round asks again
        return;
      }
      inflight = false;
      if (!current() || before !== draws) return;
      at = Date.now();
      if (noteUp) {
        noteUp = false;
        mount(note);
      }
      // A change is on its way: this answer may show its state before its own answer does. Ask again later.
      if (active) poll = setTimeout(tick, POLL_MS);
      else if (holding()) {
        held = { next, draws };
        holdTimer ??= setTimeout(release, 250);
        if (architectStatus(next.architect).busy) poll = setTimeout(tick, POLL_MS);
      } else show(next);
    };
    let sending = false; // one button change at a time
    // Changes go to the server one after the other: a change waits for the one in flight; with none in flight it starts at once.
    let active = 0;
    let tail = Promise.resolve();
    const inTurn = (call) => {
      const run = active ? tail.then(call) : call();
      active++;
      tail = Promise.resolve(run).catch(() => {}).finally(() => active--);
      return run;
    };
    // The answer is shown inside the turn, so the next change sees it.
    const save = (call) => inTurn(async () => {
      const next = await call();
      if (next && current()) show(next);
      return next;
    });
    const send = async (btn, call) => {
      if (sending || btn.disabled) return false;
      sending = true;
      btn.disabled = true;
      try {
        await save(call);
        return true;
      } catch (e) {
        toast(errorText(e), "error");
        // A session that ended with typed text waiting: loading the page again would reload the browser and lose it.
        if (current() && !(e?.status === 401 && (unsaved.size || talkText(id)))) await reload();
        return false;
      } finally {
        sending = false;
        btn.disabled = false;
      }
    };
    const ask = (btn) => send(btn, () => api.askArchitect(id));
    const draw = (s) => {
      const open = s.state !== "dropped";
      const buttons = [];
      if (s.mine && open) {
        buttons.push(h("button", { class: "small", "data-focus": "rename", onClick: async (e) => {
          const btn = e.currentTarget;
          if (btn.disabled) return;
          await renameDialog(s, () => current() && reload());
        } }, "Rename"));
      }
      if (open && (s.mine || admin)) {
        buttons.push(h("button", { class: "small danger", onClick: async (e) => {
          const btn = e.currentTarget;
          if (!(await confirmDialog({ title: "Drop this session", text: `Drop "${s.title}"? You can restore it for 30 days.`, confirm: "Drop" }))) return undefined;
          return whileBusy(btn, async () => {
            try {
              await api.dropRefinement(s.id);
              // Only the owner can restore; Undo stays until used or replaced, so the keyboard can reach it.
              toast("Session dropped", "info", s.mine ? { sticky: true, action: { label: "Undo", run: () => undoDrop(s.id) } } : {});
            } catch (err) {
              toast(errorText(err), "error");
            }
            await reload();
          });
        } }, "Drop"));
      }
      if (!open && s.mine) buttons.push(h("button", { class: "small", onClick: (e) => restore(e.currentTarget, s.id) }, "Restore"));
      // The page has three parts: what is above the drafts, the drafts, the log. A part is drawn again only when it changed.
      const { drafts: _drafts, epic: _epic, log: _log, updated: _updated, ...rest } = s;
      const upperKey = JSON.stringify(rest);
      if (upperKey !== shownUpper) {
        shownUpper = upperKey;
        mount(upper,
        h("a", { href: "#/refinement" }, "← All sessions"),
        h("div", { class: "toolbar" }, h("h1", {}, s.title), h("span", { class: `pill state-${s.state}` }, STATE_LABELS[s.state] ?? s.state),
          h("span", { class: "muted" }, s.repo), s.ownerName && !s.mine ? h("span", { class: "muted" }, `Owner: ${s.ownerName}`) : null,
          h("span", { class: "spacer" }), buttons),
        ...sourceSection(s, { send }),
        s.repoAvailable === false ? h("p", { class: "status bad" }, "This repository is not in My repositories any more. Add it again to keep working on this session.") : null,
        !open && s.removedOn ? h("p", { class: "muted" }, `Dropped. It is removed on ${date(s.removedOn)}.`) : null,
        h("h2", {}, "Idea"),
        h("p", { class: "pre-wrap" }, s.idea),
        ...briefSection(s, ask),
        ...talkSection(s, { send, errorText, line: ["round", "question"].includes(kindOf(s.architect)) ? statusLine(architectStatus(s.architect)) : null }),
        );
      }
      const st = architectStatus(s.architect);
      waiting.say(st.busy ? st.text : "");
      sections.update(s);
      publishing.update(s);
      const lowerKey = JSON.stringify(s.log);
      if (lowerKey !== shownLower) {
        shownLower = lowerKey;
        mount(lower, h("h2", {}, "Log"), h("ul", { class: "log" }, s.log.map((l) => h("li", {}, `${timeAgo(l.at)} — ${logText(l)}`))));
      }
    };
    const read = async () => seen(await api.refinementSession(id));
    const sections = draftSection({ id, save, send, errorText, read, statusLine: (a) => statusLine(architectStatus(a)) });
    const publishing = publishSection({ id, save, errorText, current, saveAll: sections.saveAll, read });
    leaveDrafts = sections.leave;
    show(s);
    mount(main, upper, note, waiting.node, sections.node, publishing.node, lower); // after the first draw, so the focus finds its control again
    return cleanup;
  }

  const head = h("div");
  const note = h("div"); // "Could not refresh" when a reload fails and the rows stay
  const body = h("div");
  let at = Date.now();
  let last = null; // the last good answer of the server
  let seq = 0; // each read gets a number; an answer that is not the newest read is dropped
  let repos = [];
  const opened = (made) => {
    if (!made?.id) return;
    if (current()) goTo(`#/refinement/${encodeURIComponent(made.id)}`);
    else toast("Refinement session started");
  };
  const row = (s) => h("tr", { class: "link", onClick: () => goTo(`#/refinement/${encodeURIComponent(s.id)}`) },
    h("td", {}, h("a", { href: `#/refinement/${encodeURIComponent(s.id)}`, onClick: (e) => e.stopPropagation() }, s.title)),
    h("td", { class: "mono" }, s.repo),
    h("td", {}, h("span", { class: `pill state-${s.state}` }, STATE_LABELS[s.state] ?? s.state),
      s.state === "dropped" ? [" ", h("span", { class: "muted" }, `removed on ${date(s.removedOn)}`)] : null,
      s.state === "dropped" && s.mine ? [" ", h("button", { class: "small", onClick: (e) => {
        e.stopPropagation();
        return restore(e.currentTarget, s.id);
      } }, "Restore")] : null),
    h("td", {}, timeAgo(s.updated)),
    admin ? h("td", {}, s.ownerName ?? "") : null);
  const filter = (label, dropped) => h("button", { class: `small${showDropped === dropped ? " primary" : ""}`, "data-focus": `filter-${dropped}`, onClick: () => {
    showDropped = dropped;
    if (last) drawList();
    load(false);
  } }, label);
  const toolbar = (full) => h("div", { class: "toolbar" }, h("h1", {}, "Refinement"),
    h("span", { class: "muted" }, "Where a rough idea grows into a story"),
    h("span", { class: "spacer" }), full ? [filter("Open sessions", false), filter("Dropped", true)] : null,
    full && !readOnly ? [
      h("a", { class: "button", href: "#/refinement/backlog" }, "Backlog readiness"),
      h("button", { onClick: () => importDialog(repos, opened, errorText) }, "Refine an existing issue"),
      h("button", { class: "primary", onClick: async () => {
        await newSessionDialog(repos, opened);
      } }, "New session"),
    ] : null);
  const drawList = () => {
    const shown = last.sessions.map(seen).filter((s) => (s.state === "dropped") === showDropped);
    mount(head, toolbar(true));
    mount(body, shown.length
      ? h("div", { class: "table-box" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Title", "Repository", "State", "Last change", admin ? "Owner" : null].filter(Boolean).map((t) => h("th", {}, t)))),
        h("tbody", {}, shown.map(row))))
      : emptyState(showDropped ? "No dropped sessions." : "No refinement sessions yet. Start one with a rough idea."));
  };
  /** Reads the list. `first`: nothing is shown yet (or the person pressed Retry), so a failure replaces the page; later a failure keeps the rows and says so. */
  const load = async (first) => {
    const n = ++seq;
    if (first) mount(body, loadingState("Loading the sessions", { rows: 4, shape: "table" }));
    let listed;
    try {
      listed = await api.refinement();
    } catch (e) {
      if (!current() || n !== seq) return;
      if (first || !last || e?.status === 403 || e?.status === 404) {
        last = null;
        mount(note);
        mount(body, failState(e, { errorText, onRetry: () => load(true), back: null }));
      } else mount(note, staleNote(at, { failed: true, onRetry: () => load(false) }));
      return;
    }
    if (!current() || n !== seq) return;
    at = Date.now();
    last = listed;
    repos = listed.repos;
    mount(note);
    drawList();
  };
  reloadList = () => load(false);
  mount(main, head, note, body);
  mount(head, toolbar(false));
  await load(true);
  return cleanup;
}
