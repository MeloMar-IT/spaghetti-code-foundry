import { api, keepPage } from "./api.js";
import { defaultGo, filterBar, filterEmpty, filterGone, sameRepo, splitHash, withQuery } from "./filters.js";
import { confirmDialog, h, modal, mount, table, timeAgo, toast } from "./dom.js";
import { onWish, takeWish } from "./palette-data.js";
import { draftSection, unsaved } from "./refinement-draft.js";
import { dialogOpen } from "./live.js";
import { announcer, failState } from "./refinement-states.js";
import { banner, emptyState, loadingState, staleNote } from "./states.js";
import { renderBacklog } from "./refinement-backlog.js";
import { sourceSection } from "./refinement-import.js";
import { newSessionDialog } from "./refinement-new.js";
import { publishSection } from "./refinement-publish.js";
import { nextNode, sessionNext } from "./refinement-next.js";
import { drafts as talkDrafts, kindOf, talkSection } from "./refinement-talk.js";
import { PARTS, architectStatus, briefSection, chosen, defaultPart, handoffNote, homePart, logText, nextStep, partSummary, statusLine, workspace } from "./refinement-workspace.js";

/** The states of a refinement session, in words. The first story draft makes it Drafting; Drop and Restore change it too. A session is Ready when every draft is ready. */
export const STATE_LABELS = {
  exploring: "Exploring",
  drafting: "Drafting",
  ready: "Ready",
  published: "Published",
  dropped: "Dropped",
};

export { sessionBody, sessionProblem } from "./refinement-new.js";

const text = (s) => String(s ?? "").trim();

export { activityText, architectStatus, askLabel, briefMeta, briefParts, logText } from "./refinement-workspace.js";

/** How often the session page asks again while the architect is queued or running, in ms. */
export const POLL_MS = 5000;
let poll; // one session page at a time
const stopPoll = () => {
  clearTimeout(poll);
  poll = undefined;
};
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
    return decodeURIComponent(splitHash(location.hash ?? "").path.split("/")[1] ?? "") === "refinement";
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
export async function renderRefinement(main, { admin = false, id, readOnly = false, quiet = false, query = {}, go = defaultGo, view } = {}) {
  // one state for the page and its reloads, so a filter removed while a reload runs stays removed (a session page has none)
  view ??= { filters: !id && query.repo ? { repo: query.repo } : {} };
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
    return renderRefinement(main, { admin, id, readOnly, query: view.filters, go, view, quiet: !loud }).then((c) => {
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
  let unwish = () => {};
  const cleanup = () => {
    if (reloaded) return reloaded();
    unwish();
    leaveDrafts(); // text that waits for its timer is sent now
    keepPage(null);
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
    const ideaBox = h("div");
    const talkBox = h("div");
    const handNote = h("div");
    const nextBox = h("div"); // the next-step sentence; it also depends on the drafts, so it is drawn on its own
    const note = h("div"); // "Could not refresh" while the poll fails
    const waiting = announcer(); // "The architect is working", said once
    let at = Date.now(); // when the page last had an answer
    let noteUp = false;
    let inflight = false; // one poll request at a time, also for Retry
    let held = null; // the newest answer that waits while the person types
    let waitTimer;
    const pendingText = () => {
      const el = document.activeElement;
      const typing = Boolean(el) && ["TEXTAREA", "INPUT"].includes(String(el.tagName ?? el.tag ?? "").toUpperCase()) && [upper, ideaBox, talkBox].some((box) => box.contains(el));
      return typing || talkText(id);
    };
    const guarding = () => pendingText() || dialogOpen(); // the draft editor guards its own unsaved fields
    const textWaits = () => pendingText() || unsaved.size > 0;
    keepPage(() => unsaved.size > 0 || talkText(id)); // a 401 of any call keeps the page while text waits
    let shownUpper = null;
    let shownNext = null;
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
      waitTimer = undefined;
      if (!held || !current()) return;
      if (held.draws !== draws) held = null; // a newer page was drawn meanwhile
      else if (guarding()) waitTimer = setTimeout(release, 250);
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
      else if (guarding()) {
        held = { next, draws };
        waitTimer ??= setTimeout(release, 250);
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
        nextBox,
        ...sourceSection(s, { send }),
        s.repoAvailable === false ? h("p", { class: "status bad" }, "This repository is not in My repositories any more. Add it again to keep working on this session.") : null,
        !open && s.removedOn ? h("p", { class: "muted" }, `Dropped. It is removed on ${date(s.removedOn)}.`) : null,
        );
        mount(ideaBox, h("h2", {}, "Idea"), h("p", { class: "pre-wrap" }, s.idea), ...briefSection(s, ask));
        mount(talkBox, ...talkSection(s, { send, errorText, line: ["round", "question"].includes(kindOf(s.architect)) ? statusLine(architectStatus(s.architect)) : null }));
      }
      const nextKey = JSON.stringify(sessionNext(s));
      if (nextKey !== shownNext) {
        shownNext = nextKey;
        mount(nextBox, nextNode(s));
      }
      const st = architectStatus(s.architect);
      waiting.say(st.busy ? st.text : "");
      sections.update(s);
      publishing.update(s);
      const hn = handoffNote(s);
      handNote.replaceChildren(...(hn ? [h("p", { class: "muted" }, hn)] : []));
      ws.update({ summary: partSummary(s), next: nextStep(s), line: st.busy ? { home: homePart(s.architect, s), st } : null });
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
    const nodes = { brief: ideaBox, talk: talkBox, drafts: sections.node, handoff: h("div", {}, publishing.node, handNote), log: lower };
    const ws = workspace({ id, parts: PARTS.map((p) => ({ ...p, node: nodes[p.id] })), initial: chosen.get(id) ?? defaultPart(s) });
    show(s);
    mount(main, upper, note, waiting.node, ws.node); // after the first draw, so the focus finds its control again
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
    h("td", { class: s.state === "dropped" && s.mine ? "actions" : null }, h("span", { class: `pill state-${s.state}` }, STATE_LABELS[s.state] ?? s.state),
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
  const setFilters = (next) => {
    view.filters = next;
    go(withQuery("#/refinement", next));
    if (last) drawList();
  };
  const clear = () => setFilters({});
  const toolbar = (full) => h("div", { class: "toolbar" }, h("h1", {}, "Refinement"),
    h("span", { class: "muted" }, "Where a rough idea grows into a story"),
    h("span", { class: "spacer" }), full ? [filter("Open sessions", false), filter("Dropped", true)] : null,
    full && !readOnly ? [
      h("a", { class: "button", href: "#/refinement/backlog" }, "Backlog readiness"),
      h("button", { onClick: () => newSessionDialog(repos, opened, { kind: "issue", preferred: view.filters.repo }) }, "Refine an existing issue"),
      h("button", { class: "primary", onClick: async () => {
        await newSessionDialog(repos, opened, { preferred: view.filters.repo });
      } }, "New session"),
    ] : null);
  const drawList = () => {
    const { filters } = view;
    const all = last.sessions.map(seen);
    const inRepo = filters.repo ? all.filter((s) => sameRepo(s.repo, filters.repo)) : all;
    const shown = inRepo.filter((s) => (s.state === "dropped") === showDropped);
    const known = !filters.repo || inRepo.length > 0 || repos.some((r) => sameRepo(r, filters.repo));
    mount(head, toolbar(true), filterBar(filters, { onRemove: clear, onClear: clear }));
    mount(body, shown.length
      ? table(["Title", "Repository", "State", "Last change", admin ? "Owner" : null], shown.map(row), { cards: true, caption: showDropped ? "Dropped sessions" : "Refinement sessions" })
      : !known ? filterGone({ onClear: clear })
        : filters.repo ? filterEmpty(showDropped ? "dropped sessions" : "refinement sessions", filters, { onClear: clear })
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
  if (!readOnly && current()) {
    // The palette's "New refinement session": a wish that came before this page, or one for the page as it is.
    if (takeWish("refinement")) void newSessionDialog(repos, opened);
    unwish = onWish("refinement", () => void newSessionDialog(repos, opened));
  }
  return cleanup;
}
