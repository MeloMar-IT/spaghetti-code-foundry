import { api, keepPage } from "./api.js";
import { h, mount } from "./dom.js";
import { withActive } from "./home.js";
import { keepScroll, liveStates, poller } from "./live.js";
import { changeRepoOf, changesOf } from "./simple-change-model.js";
import { homeModel, projectsModel } from "./simple-model.js";
import { currentLook, homeLayout } from "./simple-home.js";
import { greeting } from "./today.js";
import { githubSignInKind, moveController } from "./simple-move.js";
import { openAsk } from "./ask-handoff.js";
import { requestView } from "./request-box.js";
import { REQUEST } from "./request-model.js";
import { askCard, checkCard, hasUnsentAnswers, stuckCard } from "./simple-turn.js";
import { CHANGE, FINAL, GUIDE, HELP, TERM_MEANINGS, TRY, WORDS, termWords } from "./simple-words.js";

// The Simple view: My projects (#/home) and the project page (#/repos/<id>). All text comes from the word list.

const REFRESH_MS = 30_000;
const DONE_SHOWN = 5;
const GROUPS = [["planned", WORDS.planned], ["building", WORDS.building], ["check", WORDS.check], ["done", WORDS.done]];

/** A link or button of the pages: big, a real `a[href]`. External links open in a new tab and say so. */
function linkNode(l, cls, focus) {
  if (!l.external) return h("a", { class: cls, href: l.href, "data-focus": focus }, l.label);
  return h("a", { class: cls, href: l.href, target: "_blank", rel: "noopener noreferrer", "data-focus": focus }, l.label, h("span", { class: "sr-only" }, WORDS.newTab));
}

/** My projects: one card per project with its state line and one big button. */
export function projectsView(projects) {
  const body = projects.length
    ? h("ul", { class: "simple-projects" }, projects.map((p) => h("li", { class: "simple-card" },
      h("h3", {}, h("a", { href: `#/repos/${encodeURIComponent(p.id)}`, "data-focus": `simple-project-${p.id}` }, p.name)),
      h("p", { class: "simple-state" }, p.state),
      linkNode(p.next, "btn primary simple-big", `simple-next-${p.id}`))))
    : h("p", { class: "simple-empty" }, WORDS.empty);
  // The greeting of Today is the h1 of the page; My projects follows it.
  return [h("h2", {}, WORDS.myProjects), h("p", {}, h("a", { href: "#/start-guide", "data-focus": "simple-get-started" }, GUIDE.getStarted)), body];
}

/** "Yes, build this" of a Planned request, by request id: "sending" | "failed". Kept here because the page is drawn again after a build. */
const builds = new Map();

/** The Yes, build this button of a request kept for later, with its polite status line. `onBuild(id)` rejects when it did not work. */
function buildButton(c, onBuild) {
  const state = builds.get(c.build);
  const status = h("p", { class: "muted", "aria-live": "polite" }, state === "failed" ? CHANGE.failed : state === "sending" ? CHANGE.sending : "");
  const button = h("button", {
    type: "button", class: "btn primary simple-big", "data-focus": `simple-build-${c.id}`, disabled: state === "sending" ? true : undefined,
    onClick: async () => {
      if (builds.get(c.build) === "sending") return;
      builds.set(c.build, "sending");
      button.disabled = true;
      status.textContent = CHANGE.sending;
      try {
        await onBuild?.(c.build);
        builds.delete(c.build);
        status.textContent = "";
      } catch {
        builds.set(c.build, "failed");
        status.textContent = CHANGE.failed;
        button.disabled = false;
      }
    },
  }, CHANGE.build);
  return [button, status];
}

function cardView(c, onBuild) {
  return h("li", { class: "simple-card" },
    h("h4", {}, c.title),
    c.sentence ? h("p", {}, c.sentence) : null,
    c.line ? h("p", { class: "muted" }, c.line) : null,
    c.progress ? h("p", { class: "simple-progress" }, c.progress) : null,
    c.build ? buildButton(c, onBuild) : null);
}

function groupView(key, title, cards, { doneOpen, onToggle, onBuild }) {
  const shown = key === "done" ? cards.slice(0, DONE_SHOWN) : cards;
  const rest = key === "done" ? cards.slice(DONE_SHOWN) : [];
  return h("section", { class: "simple-group" },
    h("h3", {}, title),
    shown.length ? h("ul", { class: "simple-list" }, shown.map((c) => cardView(c, onBuild))) : h("p", { class: "muted" }, WORDS.nothingInGroup),
    rest.length
      ? h("details", { open: doneOpen, onToggle: (e) => onToggle?.(e?.target?.open ?? !doneOpen) },
        h("summary", { "data-focus": "simple-done-summary" }, WORDS.showAllDone(cards.length)),
        h("ul", { class: "simple-list" }, rest.map((c) => cardView(c, onBuild))))
      : null);
}

/**
 * The card of a version that waits for the owner's OK: the finished changes in plain words, the big button, and "Not yet" with an
 * optional reason. `onDecide(runId, approved, note)` answers true when it worked; the answer is told in a polite status line.
 */
/**
 * What the person typed in a "Not yet" box and whether the box is open, by run id. The page is drawn again every few seconds,
 * so the draft lives here, not in the element; it goes when the answer is sent and worked.
 */
const drafts = new Map();

function decideCard(c, onDecide) {
  const draft = drafts.get(c.decide) ?? { note: "", open: false };
  drafts.set(c.decide, draft);
  const status = h("p", { class: "muted", "aria-live": "polite" });
  const note = h("textarea", {
    rows: 3, maxlength: 500, "aria-label": FINAL.why, placeholder: FINAL.why, "data-focus": `simple-why-${c.id}`, value: draft.note,
    onInput: (e) => { draft.note = String(e?.target?.value ?? note.value ?? ""); },
  });
  const send = async (approved, text) => {
    status.textContent = "";
    let ok = false;
    try {
      ok = (await onDecide?.(c.decide, approved, text)) === true;
    } catch {
      ok = false;
    }
    if (ok) drafts.delete(c.decide);
    status.textContent = ok ? FINAL.sent : FINAL.failed;
  };
  return h("li", { class: "simple-card" },
    h("strong", {}, c.title),
    c.line ? h("p", { class: "muted" }, c.line) : null,
    c.items?.length ? h("div", {}, h("p", {}, FINAL.what), h("ul", {}, c.items.map((t) => h("li", {}, t)))) : null,
    h("button", { type: "button", class: "btn primary simple-big", "data-focus": `simple-todo-${c.id}`, onClick: () => send(true, "") }, FINAL.yes),
    h("details", { open: draft.open ? true : undefined, onToggle: (e) => { draft.open = e?.target?.open === true || e?.target?.hasAttribute?.("open") === true; } },
      h("summary", { "data-focus": `simple-notyet-${c.id}` }, FINAL.notYet),
      note,
      h("button", { type: "button", "data-focus": `simple-keep-${c.id}`, onClick: () => send(false, String(note.value ?? draft.note ?? "").trim()) }, FINAL.keep)),
    status);
}

// ---- Try it ----

/** The only address Simple links to: the preview of this computer. */
export const TRY_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/$/;
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1", "[::1]"];
/** Is the page opened on the computer where the Foundry runs? */
export const isLocalHost = (host) => LOCAL_HOSTS.includes(String(host ?? "").toLowerCase());

/** The server's preview view as a phase: "idle" | "starting" | "ready" | "failed". A ready preview with a strange address is failed. */
export function phaseOfPreview(v) {
  const state = v?.state;
  if (state === "starting") return "starting";
  if (state === "ready") return TRY_URL.test(String(v?.url ?? "")) ? "ready" : "failed";
  if (state === "failed") return "failed";
  return "idle";
}

/**
 * The Try it part, as nodes. `s`: { phase: "idle" | "choosing" | "starting" | "ready" | "failed", url?, error?, busy? };
 * `busy`: a start or stop is on its way, so the buttons wait. Never shows the preview's output, reason or detail.
 */
export function tryItView(s, { local = true, choices = [], onTry, onPick, onNotNow, onStop } = {}) {
  if (!local) return [h("p", { class: "simple-try-note" }, TRY.elsewhere)];
  const off = s.busy ? true : undefined;
  const big = (label, focus, onClick) => h("button", { type: "button", class: "simple-big", "data-focus": focus, disabled: off, onClick }, label);
  const stop = () => h("button", { type: "button", "data-focus": "simple-try-stop", disabled: off, onClick: () => onStop?.() }, TRY.stop);
  const note = s.error ? h("p", { class: "muted", "aria-live": "polite" }, TRY.didNotWork) : null;
  let body;
  if (s.phase === "starting") {
    body = [h("p", { "aria-live": "polite" }, TRY.starting), stop()];
  } else if (s.phase === "ready") {
    body = [linkNode({ href: s.url, external: true, label: TRY.open }, "btn primary simple-big", "simple-try-open"), stop()];
  } else if (s.phase === "choosing") {
    body = [h("div", { role: "group", "aria-label": TRY.which },
      h("p", {}, TRY.which),
      big(TRY.current, "simple-try-current", () => onPick?.({ version: "develop" })),
      choices.map((c, i) => big(choices.length > 1 ? TRY.checkingOf(c.title) : TRY.checking, `simple-try-checking-${i}`, () => onPick?.({ version: "checking", runId: c.runId }))),
      h("button", { type: "button", "data-focus": "simple-try-notnow", disabled: off, onClick: () => onNotNow?.() }, TRY.notNow))];
  } else {
    body = [s.phase === "failed" ? h("p", {}, TRY.failed) : null, big(WORDS.actions.tryIt, "simple-action-tryIt", () => onTry?.())];
  }
  return [...body, note];
}

/**
 * Runs Try it for one project: keeps the state, reads the preview again every `every` ms while it starts, and lets one start or
 * stop run at a time (reads wait, and an older answer never replaces a newer one). `node` is drawn again by itself.
 */
function tryController({ id, a, local, every }) {
  const node = h("div", { class: "simple-try" });
  const s = { phase: "idle", url: "", error: false, busy: false };
  let choices = [];
  let timer;
  let dead = false;
  let seq = 0;
  const call = (fn) => Promise.resolve().then(fn);
  const draw = () => mount(node, ...tryItView(s, { local, choices, onTry, onPick: start, onNotNow, onStop: stop }));
  const schedule = () => {
    clearTimeout(timer);
    if (!dead && !s.busy && s.phase === "starting") timer = setTimeout(load, every);
  };
  const apply = (v) => {
    s.phase = phaseOfPreview(v);
    s.url = s.phase === "ready" ? String(v.url) : "";
    s.error = false;
    draw();
    schedule();
  };
  /** Reads the preview. A failed read keeps the last state, says so while it starts, and tries again. */
  async function load() {
    if (dead || s.busy) return;
    const mine = ++seq;
    try {
      const v = await call(() => a.preview(id));
      if (dead || mine !== seq) return;
      if (s.phase === "choosing" && phaseOfPreview(v) === "idle") return;
      apply(v);
    } catch {
      if (dead || mine !== seq) return;
      if (s.phase === "starting") s.error = true;
      draw();
      schedule();
    }
  }
  /** One mutation at a time: reads in flight are dropped, the timer waits, the controls are off. */
  async function mutate(fn, { next, shown }) {
    if (dead || s.busy || !local) return;
    const before = s.phase;
    seq += 1;
    clearTimeout(timer);
    s.busy = true;
    s.error = false;
    if (shown) s.phase = shown;
    draw();
    try {
      const v = await call(fn);
      if (dead) return;
      s.busy = false;
      if (next) { s.phase = next; s.url = ""; s.error = false; draw(); schedule(); } else apply(v);
    } catch {
      if (dead) return;
      s.busy = false;
      s.phase = before;
      s.error = true;
      draw();
      schedule();
    }
  }
  function start(body) {
    return mutate(() => a.startPreview(id, body.version, body.runId), { shown: "starting" });
  }
  function stop() {
    return mutate(() => a.stopPreview(id), { next: "idle" });
  }
  function onTry() {
    if (s.busy) return;
    s.error = false;
    if (choices.length) { s.phase = "choosing"; draw(); } else start({ version: "develop" });
  }
  function onNotNow() {
    if (s.busy) return;
    s.phase = "idle";
    draw();
  }
  draw();
  return {
    node,
    setChoices(list) {
      choices = list;
      if (s.phase === "choosing" && !s.busy) draw();
    },
    load,
    tryRun(runId) {
      return start({ version: "checking", runId });
    },
    stop() {
      dead = true;
      clearTimeout(timer);
    },
  };
}

/**
 * The project page. `actions`: the action row, [{ id: "change" | "tryIt" | "final", href?, onClick?, node? }] (`node`: drawn as it is); nothing is drawn
 * without actions. `doneOpen` and `onToggle` keep the "Show all done" box open across a refresh.
 */
export function projectView(model, { actions = [], doneOpen = false, onToggle, onDecide, onBuild, turns = [], answer } = {}) {
  return [
    h("a", { class: "simple-back", href: "#/home", "data-focus": "simple-back" }, WORDS.back),
    h("h1", {}, model.name),
    h("section", { class: "simple-todo" },
      h("h2", {}, WORDS.todo),
      model.todo.length
        ? h("ul", { class: "simple-list" }, model.todo.map((c) => c.decide ? decideCard(c, onDecide) : (c.ask && answer && askCard(c, turns, answer))
          || (c.approve && answer && checkCard(c, turns, answer)) || (c.stuck && answer && stuckCard(c, turns, answer)) || h("li", { class: "simple-card" },
          h("strong", {}, c.title),
          c.line ? h("p", { class: "muted" }, c.line) : null,
          c.points ? requestView(c.points, { heading: "h3", note: REQUEST.notYours }) : null,
          c.link ? linkNode({ ...c.link, label: c.todo }, "btn primary simple-big", `simple-todo-${c.id}`) : null)))
        : h("p", {}, WORDS.nothingTodo)),
    h("section", { class: "simple-making" },
      h("h2", {}, WORDS.making),
      GROUPS.map(([key, title]) => groupView(key, title, model.groups[key], { doneOpen, onToggle, onBuild }))),
    actions.length
      ? h("div", { class: "simple-actions" }, actions.filter((x) => WORDS.actions[x.id]).map((x) => x.node ? x.node : x.href
        ? h("a", { class: "btn simple-big", href: x.href, "data-focus": `simple-action-${x.id}` }, WORDS.actions[x.id])
        : h("button", { type: "button", class: "simple-big", "data-focus": `simple-action-${x.id}`, onClick: x.onClick }, WORDS.actions[x.id])))
      : null,
  ];
}

/** Loads the three lists and polls them; `draw(projects)` gets the projects. Returns a cleanup. */
async function live(main, { a, draw, turns = false, changesFor }) {
  const box = h("div", { class: "simple" });
  mount(main, box);
  let poll;
  const states = liveStates({
    body: box,
    heading: () => h("h1", {}, turns ? WORDS.myProjects : greeting()),
    label: WORDS.loading,
    what: WORDS.loadFailed,
    retry: () => poll.refresh(),
    focus: "simple",
  });
  poll = poller({
    load: async () => {
      // the items the person may answer; a failed or missing read gives none, so no card has an answer button
      const mine = turns ? Promise.resolve().then(() => a.myTurn()).then((v) => (Array.isArray(v?.items) ? v.items : []), () => []) : [];
      const [repos, runs, queue, mineItems] = await Promise.all([a.repos(), a.runs(), a.queue(), mine]);
      // the project page also reads this project's change requests (those kept for later are listed under Planned); a failed read gives none
      const changes = {};
      const project = changesFor === undefined ? null : (Array.isArray(repos) ? repos : []).find((r) => String(r.id) === String(changesFor));
      const name = project ? changeRepoOf(project) : null;
      if (name && typeof a.changes === "function") changes[String(project.id)] = await Promise.resolve().then(() => a.changes(name)).then(changesOf, () => []);
      return { repos, runs: await withActive(a, runs, queue), pending: queue?.pending, mineItems, changes };
    },
    draw: ({ repos, runs, pending, mineItems, changes }) => {
      const nodes = draw(projectsModel(repos, runs, pending, changes), () => poll.refresh(), repos, mineItems, { runs, pending });
      keepScroll(box, () => mount(box, ...nodes, states.alert, states.note));
    },
    every: REFRESH_MS,
    onState: states.onState,
  });
  await poll.ready;
  return () => poll.stop();
}

/** The Help page: the words, two how-tos and, when there is contact text, who to ask. The contact is drawn as text, never as HTML. */
export function helpView(contact = "") {
  const who = String(contact ?? "").trim();
  return [
    h("h1", {}, HELP.title),
    h("section", { class: "simple-group" },
      h("h2", {}, HELP.wordsTitle),
      h("p", {}, HELP.wordsIntro),
      h("dl", {}, termWords().flatMap((w) => [h("dt", {}, w), h("dd", {}, TERM_MEANINGS[w])]))),
    h("section", { class: "simple-group" },
      h("h2", {}, HELP.howTitle),
      HELP.howtos.flatMap((t) => [h("h3", {}, t.q), h("p", {}, t.a)])),
    h("section", { class: "simple-group" },
      h("h2", {}, HELP.agentsTitle),
      h("p", {}, HELP.agentsText),
      h("p", {}, h("a", { href: "#/agents" }, HELP.agentsLink))),
    who ? h("section", { class: "simple-group simple-help-contact" }, h("h2", {}, HELP.contactTitle), h("p", {}, who)) : null,
  ];
}

/** The Help page; reads the contact text from the view answer, and draws without it when that fails. Never rejects. */
export async function renderSimpleHelp(main, { a = api } = {}) {
  let contact = "";
  try {
    const v = await a.myView();
    if (typeof v?.helpContact === "string") contact = v.helpContact;
  } catch { /* no contact line */ }
  mount(main, h("div", { class: "simple" }, ...helpView(contact)));
  return () => {};
}

/**
 * My projects; never rejects; returns a cleanup. `openGuide()` is called once, when the first successful load shows no project and
 * `alive()` still says this page is the one on screen (a slow answer that arrives after the person left must not move them).
 */
export function renderSimpleHome(main, { a = api, openGuide, alive = () => true, list = "", look = currentLook } = {}) {
  let first = true;
  return live(main, {
    a,
    draw: (projects, _refresh, repos, _turns, { runs, pending } = {}) => {
      const empty = first && projects.length === 0;
      first = false;
      if (empty && alive()) {
        try {
          openGuide?.();
        } catch {
          // the page stays as it is
        }
      }
      // Today first, drawn by the layout of the person's look (work of the person's projects only), then My projects.
      // A counter opens `list` on this page.
      const model = homeModel(runs, pending, repos, projects, { list });
      return [...homeLayout(model, look(), { focus: "simple-today" }), ...projectsView(projects)];
    },
  });
}

/** The project page for repository `id`. */
export async function renderSimpleProject(main, { id, a = api, onName, actions = [], admin = false, host = globalThis.location?.hostname ?? "", tryEvery = 2000 } = {}) {
  let doneOpen = false;
  let previewRead = false;
  let answer;
  const local = isLocalHost(host);
  const ctl = tryController({ id, a, local, every: tryEvery });
  const mv = moveController({ id, a });
  const order = ["change", "tryIt", "final", "github"];
  const all = [...actions.filter((x) => x.id !== "tryIt"), { id: "tryIt", node: ctl.node }].sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id));
  // typed answers wait in memory: a 401 (of any call, a poll too) must not reload the page and throw them away
  keepPage(hasUnsentAnswers);
  const off = await live(main, {
    a,
    turns: true,
    changesFor: id,
    draw: (projects, refresh, repos, turns) => {
      const p = projects.find((x) => String(x.id) === String(id));
      // The move removes the local record: while it runs and after it worked, its box stays even though the project is gone.
      if (!p && mv.keepsPage()) return [h("a", { class: "simple-back", href: "#/home" }, WORDS.back), mv.node];
      if (!p) return [h("a", { class: "simple-back", href: "#/home" }, WORDS.back), h("p", {}, WORDS.notFound)];
      onName?.(p.name);
      mv.setContext({ kind: githubSignInKind(repos), name: p.name });
      ctl.setChoices(p.todo.filter((c) => c.tryRun).map((c) => ({ runId: c.tryRun, title: c.title })));
      // the first successful render reads the preview once, even when the first list read failed
      if (!previewRead && local) {
        previewRead = true;
        ctl.load();
      }
      // Questions are read and answered through Your turn; the page is read again after an answer worked.
      answer = {
        detail: (k) => a.turnDetail(k), act: (b) => a.actTurn(b), done: () => refresh?.(),
        approveRun: (rid, note) => a.approveRun(rid, note), rejectRun: (rid, note) => a.rejectRun(rid, note), resumeRun: (rid) => a.resumeRun(rid),
        notNow: (rid) => a.notNowRun(rid),
        markCheck: (rid, cid, mark, rev) => a.markCheck(rid, cid, mark, rev),
        addCheck: (rid, t, e, rev) => a.addCheck(rid, t, e, rev),
        tryIt: local ? (runId) => ctl.tryRun(runId) : null,
        help: () => { if (!openAsk()) globalThis.location.hash = "#/help"; },
      };
      // The answer goes to the run's own approve / reject call; the page is read again after it worked.
      const onDecide = async (runId, approved, note) => {
        try {
          await (approved ? a.approveRun(runId, note) : a.rejectRun(runId, note));
        } catch {
          return false;
        }
        refresh?.();
        return true;
      };
      // "Yes, build this" of a request kept for later; the page is read again after it worked
      const onBuild = async (cid) => {
        await a.buildChange(cid);
        refresh?.();
      };
      return projectView(p, { onBuild, actions: admin && p.local ? [...all, { id: "github", node: mv.node }].sort((x, y) => order.indexOf(x.id) - order.indexOf(y.id)) : all, doneOpen, onToggle: (open) => { doneOpen = open; }, onDecide, turns, answer });
    },
  });
  return () => { keepPage(null); off(); ctl.stop(); mv.stop(); };
}
