import { api } from "./api.js";
import { h, modal, mount, timeAgo, toast } from "./dom.js";
import { draftSection, unsaved } from "./refinement-draft.js";
import { suggestLogText } from "./refinement-suggest.js";
import { kindOf, talkLogText, talkSection } from "./refinement-talk.js";

/** The states of a refinement session, in words. The first story draft makes it Drafting; Drop and Restore change it too. Later steps add the others. */
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
  if (entry.what === "dropped") return `${who} dropped the session`;
  if (entry.what === "restored") return `${who} restored the session`;
  if (entry.what === "architect-started") return `${who} asked the architect to look at the code`;
  if (entry.what === "architect-resumed") return `${who} asked the architect to carry on`;
  if (entry.what === "architect-brief") return "The architect wrote the context brief";
  if (entry.what === "architect-failed") return `The architect could not finish${entry.detail ? `: ${entry.detail}` : ""}`;
  if (entry.what === "draft-added") return `${who} added a story draft`;
  if (entry.what === "draft-removed") return `${who} removed a story draft${entry.detail ? `: "${entry.detail}"` : ""}`;
  if (entry.what === "epic-set") return `${who} set the Epic${entry.detail ? ` to ${entry.detail}` : ""}`;
  if (entry.what === "epic-cleared") return `${who} cleared the Epic`;
  return talkLogText(entry) || suggestLogText(entry) || `${who}: ${entry.what}`;
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
    // A round, an answer or a suggestion: fixed sentences only, never the words of the step.
    if (/clone|check out/i.test(t)) return "Getting the code.";
    if (/reads the code/i.test(t)) return "Reading the code.";
    if (/^check/i.test(t)) return kind === "suggest" ? "Checking the suggestion." : "Checking the answer.";
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

const QUEUED_DETAIL = { brief: "Then it reads the code.", round: "Then it writes its questions.", question: "Then it answers your question.", suggest: "Then it writes a suggestion." };
const RUNNING_TEXT = { brief: "The architect is at work.", round: "The architect is writing its questions.", question: "The architect is answering your question.", suggest: "The architect is writing a suggestion." };

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
  const own = kindOf(s.architect) === "brief"; // a round, a question or a suggestion is asked again where it shows
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
  // Only a run for the brief draws its line here; a round or a question is shown in the talk, a suggestion on the draft page.
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
        h("p", { style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 } }, p.body),
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
const onPage = () => {
  if (typeof location === "undefined") return true;
  try {
    return decodeURIComponent((location.hash ?? "").split("/")[1] ?? "") === "refinement";
  } catch {
    return false;
  }
};

const date = (iso) => new Date(iso).toLocaleDateString();
const goTo = (hash) => {
  location.hash = hash;
};

let showDropped = false;

/** Asks for the repository, the idea and an optional title. Resolves with the new session, or undefined when closed. */
function newSessionDialog(repos, onMade) {
  return modal("New refinement session", (close) => {
    if (!repos.length) {
      return h("div", { style: { display: "grid", gap: "12px" } },
        h("p", { class: "muted" }, "You need a GitHub repository first. Add one under My repositories."),
        h("a", { href: "#/repos", onClick: () => close(undefined) }, "Go to My repositories"));
    }
    const select = h("select", { name: "repo" }, repos.map((r) => h("option", { value: r }, r)));
    select.value = repos[0];
    const title = h("input", { name: "title", placeholder: "Optional. The first line of the idea is used when empty.", autocomplete: "off" });
    const idea = h("textarea", { name: "idea", rows: 8, placeholder: "Describe your idea in your own words" });
    const err = h("p", { class: "status bad", style: { margin: 0 } });
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
    return h("div", { style: { display: "grid", gap: "12px" } },
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
    const err = h("p", { class: "status bad", style: { margin: 0 } });
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
    return h("div", { style: { display: "grid", gap: "12px" } },
      h("label", { class: "field" }, h("span", {}, "Title"), input), err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
}

/** The Refinement pages: the list (no `id`) and one session. Returns a cleanup. */
export async function renderRefinement(main, { admin = false, id } = {}) {
  const mine = ++generation;
  stopPoll();
  const current = () => mine === generation && onPage();
  // A reload draws a new page; the cleanup the app holds must reach that page, so navigation always ends the current one.
  let reloaded;
  const reload = () => renderRefinement(main, { admin, id }).then((c) => {
    reloaded = c;
  }, (e) => toast(errorText(e), "error"));
  const restore = (btn, sid) =>
    whileBusy(btn, async () => {
      try {
        await api.restoreRefinement(sid);
        toast("Session restored");
      } catch (e) {
        toast(errorText(e), "error");
      }
      await reload();
    });
  let leaveDrafts = () => {};
  const cleanup = () => {
    if (reloaded) return reloaded();
    leaveDrafts(); // text that waits for its timer is sent now
    generation++;
    stopPoll();
  };

  if (id) {
    const gone = (e) => mount(main, h("a", { href: "#/refinement" }, "← All sessions"), h("p", { class: "status bad" }, errorText(e)));
    let s;
    try {
      s = await api.refinementSession(id);
    } catch (e) {
      if (!current()) return () => {};
      gone(e);
      return cleanup;
    }
    if (!current()) return () => {};
    const upper = h("div");
    const lower = h("div");
    let shownUpper = null;
    let shownLower = null;
    let shown = "";
    let draws = 0; // counts the pages drawn: a poll that began before one is out of date
    const show = (next) => {
      draws++;
      const json = JSON.stringify(next);
      if (json !== shown) {
        shown = json;
        draw(next);
      }
      stopPoll();
      if (architectStatus(next.architect).busy) poll = setTimeout(tick, POLL_MS);
    };
    const tick = async () => {
      poll = undefined;
      if (!current()) return;
      const before = draws;
      let next;
      try {
        next = await api.refinementSession(id);
      } catch (e) {
        if (!current()) return;
        if (e?.status === 404) return gone(e);
        if (before === draws) poll = setTimeout(tick, POLL_MS); // the page stays; the next round asks again
        return;
      }
      if (!current() || before !== draws) return;
      // A change is on its way: this answer may show its state before its own answer does. Ask again later.
      if (active) poll = setTimeout(tick, POLL_MS);
      else show(next);
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
        if (current() && !(e?.status === 401 && unsaved.size)) await reload();
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
        buttons.push(h("button", { class: "small danger", onClick: (e) => {
          const btn = e.currentTarget;
          if (!confirm(`Drop "${s.title}"? You can restore it for 30 days.`)) return;
          return whileBusy(btn, async () => {
            try {
              await api.dropRefinement(s.id);
              toast("Session dropped");
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
        s.repoAvailable === false ? h("p", { class: "status bad" }, "This repository is not in My repositories any more. Add it again to keep working on this session.") : null,
        !open && s.removedOn ? h("p", { class: "muted" }, `Dropped. It is removed on ${date(s.removedOn)}.`) : null,
        h("h2", {}, "Idea"),
        h("p", { style: { whiteSpace: "pre-wrap" } }, s.idea),
        ...briefSection(s, ask),
        ...talkSection(s, { send, errorText, line: ["round", "question"].includes(kindOf(s.architect)) ? statusLine(architectStatus(s.architect)) : null }),
        );
      }
      sections.update(s);
      const lowerKey = JSON.stringify(s.log);
      if (lowerKey !== shownLower) {
        shownLower = lowerKey;
        mount(lower, h("h2", {}, "Log"), h("ul", { class: "log" }, s.log.map((l) => h("li", {}, `${timeAgo(l.at)} — ${logText(l)}`))));
      }
    };
    const sections = draftSection({ id, save, send, errorText, statusLine: (a) => statusLine(architectStatus(a)) });
    leaveDrafts = sections.leave;
    show(s);
    mount(main, upper, sections.node, lower); // after the first draw, so the focus finds its control again
    return cleanup;
  }

  let listed;
  try {
    listed = await api.refinement();
  } catch (err) {
    if (!current()) return () => {};
    throw err;
  }
  if (!current()) return () => {};
  const { sessions, repos } = listed;
  const shown = sessions.filter((s) => (s.state === "dropped") === showDropped);
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
  const filter = (label, dropped) => h("button", { class: `small${showDropped === dropped ? " primary" : ""}`, onClick: () => {
    showDropped = dropped;
    reload();
  } }, label);
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Refinement"),
      h("span", { class: "muted" }, "Where a rough idea grows into a story"),
      h("span", { class: "spacer" }), filter("Open sessions", false), filter("Dropped", true),
      h("button", { class: "primary", onClick: async () => {
        await newSessionDialog(repos, (made) => {
          if (!made?.id) return;
          if (current()) goTo(`#/refinement/${encodeURIComponent(made.id)}`);
          else toast("Refinement session started");
        });
      } }, "New session")),
    shown.length
      ? h("div", { class: "table-box" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, ["Title", "Repository", "State", "Last change", admin ? "Owner" : null].filter(Boolean).map((t) => h("th", {}, t)))),
        h("tbody", {}, shown.map(row))))
      : h("div", { class: "empty" }, showDropped ? "No dropped sessions." : "No refinement sessions yet. Start one with a rough idea."));
  return cleanup;
}
