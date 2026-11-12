import { api } from "./api.js";
import { h } from "./dom.js";
import { needsUser, recordLink } from "./home.js";
import { phaseStrip } from "./kit/product.js";
import { PHASES } from "./phases.js";
import { filterHash } from "./runs-filter.js";
import { firstLine } from "./run-header.js";
import { myRunsEntries } from "./runs-list.js";
import { ownerLabel } from "./runs.js";
import { groupOf, runPhase } from "./simple-model.js";
import { FINAL, STUCK, kindWords, plainWords, safeText } from "./simple-words.js";
import { PANEL_KINDS, openTurnItem } from "./turn-act.js";

// Today: the first page of every view. One model (built from GET /api/runs through `groupOf`, which reads the #838 flags),
// one view. Simple, Advanced and Admin call it and add their own extras. No help button, no server text on the cards.
// This module, ./home.js and ./simple-model.js import each other: none of them uses another at the top level, only inside functions.

export const SHOWN = 5;

export const TODAY = {
  morning: "Good morning",
  afternoon: "Good afternoon",
  evening: "Good evening",
  needsTitle: "Needs you",
  buildingTitle: "Building now",
  finishedTitle: "Finished recently",
  seeWhat: "See what happened",
  noCause: "The Foundry did not say more about it.",
  openRun: "Open the run",
  showAll: "Show all",
  nothingBuilding: "Nothing is being built right now.",
  nothingFinished: "Nothing finished yet.",
  empty: "Nothing here yet. Start work to begin.",
  start: "Start work",
  repos: "My repositories",
  unknownNeeds: "We could not check yet what needs you",
  countersLabel: "Your work",
  progress: "Progress",
  back: "Back to Today",
  nothingInList: "Nothing here.",
  more: (n) => `+${n} more`,
  untitled: "A change",
  counters: { waiting: "Waiting", building: "Building", check: "Needs your check", "finished-today": "Finished today" },
  lists: { waiting: "Waiting", building: "Building", check: "Needs your check", finished: "Finished", "finished-today": "Finished today" },
};

/** "Good morning" before 12, "Good afternoon" before 18, else "Good evening". */
export function greeting(now = new Date()) {
  const hour = new Date(now).getHours();
  return hour < 12 ? TODAY.morning : hour < 18 ? TODAY.afternoon : TODAY.evening;
}

/** "1 thing needs you, 1 change is being built, 3 finished today". `unknown`: what needs the person is not known (a feed failed). */
export function summaryLine({ check = 0, building = 0, finishedToday = 0, unknown = false } = {}) {
  const needs = unknown ? TODAY.unknownNeeds : check <= 0 ? "Nothing needs you" : check === 1 ? "1 thing needs you" : `${check} things need you`;
  return [
    needs,
    building > 0 ? (building === 1 ? "1 change is being built" : `${building} changes are being built`) : null,
    finishedToday > 0 ? `${finishedToday} finished today` : null,
  ].filter(Boolean).join(", ");
}

const startOfDay = (now) => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};
const finishedMs = (e) => Date.parse(e.run?.finishedAt ?? e.run?.startedAt ?? "") || 0;
const READY = new Set(["approval", "approve_plan", "approve_split", "release"]);
/** Work that waits for a check (not a question, not stuck work): an approval, a plan, a split, a release, or a final version. */
export const isReady = (n) => !!n && (READY.has(n.kind) || n.final === true);
/** True when the entry finished on or after local midnight 6 days ago (today and the 6 days before). */
export function inLastWeek(entry, now = Date.now()) {
  const d = new Date(now);
  return finishedMs(entry) >= new Date(d.getFullYear(), d.getMonth(), d.getDate() - 6).getTime();
}
const lastStep = (id) => String(id ?? "").split("/").at(-1);
/**
 * Confirmed publication: a finished record ("done", not a release that still waits, not a split that made its parts) whose run
 * has delivery evidence in its history: a merge that worked, a push to main that worked, or for a daily release the final merge
 * (a rejected final version also ends succeeded, but published nothing). A planning run that finished has none of these.
 */
export function isPublished(entry) {
  if (recordOf(entry)?.kind !== "done" || groupOf(entry) !== "done") return false;
  const history = entry.run?.history ?? [];
  if (entry.run?.flow === "release-daily") return history.some((x) => lastStep(x?.id) === "final_merge" && x.ok);
  return history.some((x) => x?.ok && (lastStep(x.id) === "merge" || (lastStep(x.id) === "push_main" && (x.pushed === true || /^PUSHED:/m.test(x.output ?? "")))));
}
/** Whole calendar days (local midnights) from `ms` to `now`; never below 0. */
export function daysAgo(ms, now = Date.now()) {
  const a = new Date(ms);
  const b = new Date(now);
  const day = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.max(0, Math.round((day(b) - day(a)) / 86400000));
}
/** A record that says work waits for today's limit. A user gets a daily budget as `usage_limit` that keeps `until: "tomorrow"` (see userRecord). */
const dailyLimited = (n) => n.kind === "daily_budget" || n.kind === "project_limit" || (n.kind === "usage_limit" && n.until === "tomorrow");
const GROUP_OF = { waiting: "planned", building: "building", check: "check", finished: "done", "finished-today": "done" };

/**
 * The one predicate of a group of work, for the counters of Today and for the Runs list a counter opens: `key` is one of
 * waiting, building, check, finished, finished-today. "Finished today" is by the day the work finished, not the day it started.
 */
export function inGroup(key, entry, now = Date.now()) {
  if (!Object.hasOwn(GROUP_OF, key) || groupOf(entry) !== GROUP_OF[key]) return false;
  return key === "finished-today" ? finishedMs(entry) >= startOfDay(now) : true;
}

/** The four counters: { key, label, count, href }, in order. `home`: Simple has no Runs page, so it opens a list on Home. */
export function counterLinks(counts, { simple = false } = {}) {
  return ["waiting", "building", "check", "finished-today"].map((key) => ({
    key,
    label: TODAY.counters[key],
    count: counts?.[key] ?? 0,
    href: groupHref(key, simple),
  }));
}

/** The address of the list of a group: the Runs page, or (Simple) Home with `list=`. */
export const groupHref = (key, simple = false) => (simple ? `#/home?list=${encodeURIComponent(key)}` : filterHash({ group: key }));

const recordOf = (e) => e.run?.next ?? e.job?.next;
const idOf = (e) => e.run?.runId ?? e.job?.runId;
const enc = encodeURIComponent;

/** Run ids whose failure Today and Your turn drop: closed issue, "Not now", a split that made all its parts (#838). */
export function droppedRuns(runs) {
  const out = new Set();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (run?.next?.kind === "failed" && groupOf({ run, job: null }) !== "check") out.add(run.runId);
  }
  return out;
}

/**
 * → { total, now, attention, building, finished, counts, lists } of the runs and queued jobs.
 * opts: { role, simple, projectOf (Simple: (entry) => project id | null), now, exclude (run ids another panel of the page already shows),
 * extraNeeds (needs that are not runs, counted in the summary), needsUnknown (what needs the person is not known) }.
 */
export function todayModel(runs, pending, { role = "user", simple = false, projectOf, now = Date.now(), exclude, extraNeeds = 0, needsUnknown = false, mine } = {}) {
  const out = {
    total: 0, now, attention: [], building: [], finished: [], extraNeeds, needsUnknown,
    counts: { waiting: 0, building: 0, check: 0, ready: 0, "published-week": 0, "finished-today": 0 },
    lists: { waiting: [], building: [], check: [], ready: [], "published-week": [], finished: [], "finished-today": [] },
    lastPublished: null, limitedToday: 0,
  };
  const entries = [];
  for (const e of myRunsEntries(runs, pending)) {
    const n = recordOf(e);
    if (!n) continue; // old run data without a record stays on the Runs page
    const pid = simple ? projectOf?.(e) ?? null : null;
    if (simple && pid === null) continue;
    out.total++;
    entries.push({ e, n, pid });
  }
  const skip = exclude instanceof Set ? exclude : new Set();
  const finished = [];
  for (const { e, n, pid } of entries) {
    const id = idOf(e);
    const g = groupOf(e);
    if (!g) continue;
    if ((g === "building" || g === "planned") && dailyLimited(n)) out.limitedToday++;
    const title = titleOf(e, n, simple);
    const href = simple ? `#/repos/${enc(pid)}` : `#/runs/${enc(id ?? "")}`;
    const item = { id, title, href };
    if (g === "planned") { out.counts.waiting++; out.lists.waiting.push(item); }
    if (g === "check") {
      out.counts.check++;
      out.lists.check.push(item);
      if (isReady(n)) { out.counts.ready++; out.lists.ready.push(item); }
      if (!skip.has(id)) out.attention.push(attentionOf(e, n, { role, simple, title, pid, mine }));
    }
    if (g === "building") {
      out.counts.building++;
      out.lists.building.push(item);
      out.building.push(buildingOf(e, n, { role, simple, title, href, pid }));
    }
    if (g === "done") finished.push({ e, item });
  }
  finished.sort((a, b) => finishedMs(b.e) - finishedMs(a.e));
  for (const { e, item } of finished) {
    out.finished.push(item);
    out.lists.finished.push(item);
    const published = isPublished(e);
    if (published && !out.lastPublished) out.lastPublished = { ...item, finishedMs: finishedMs(e) };
    if (published && inLastWeek(e, now)) { out.counts["published-week"]++; out.lists["published-week"].push(item); }
    if (inGroup("finished-today", e, now)) { out.counts["finished-today"]++; out.lists["finished-today"].push(item); }
  }
  return out;
}

function titleOf(e, n, simple) {
  const task = firstLine(e.run?.task ?? e.job?.task);
  return simple ? safeText(n.title || task, TODAY.untitled) : n.title || task || TODAY.untitled;
}

/**
 * The item of `GET /api/your-turn/mine` that answers or decides this run here: the same run, a kind with a panel, and an act the
 * panel uses. Null when there is none (the card then links to where the item lives, such as the issue on GitHub).
 */
export function answerItemFor(id, kind, mine) {
  if (!id || !Array.isArray(mine) || !PANEL_KINDS.has(kind)) return null;
  const item = mine.find((i) => i && typeof i.key === "string" && i.key && i.runId === id && i.kind === kind
    && Array.isArray(i.acts) && (i.acts.includes("answer") || i.acts.includes("approve")));
  return item ? { key: item.key, kind: item.kind } : null;
}

function attentionOf(e, n, { role, simple, title, pid, mine }) {
  const id = idOf(e);
  const failed = n.kind === "failed";
  const words = kindWords(n.kind, n.who);
  const link = !simple && !failed ? recordLink(n, role, id) : undefined;
  let href;
  let external = false;
  if (simple) href = `#/repos/${enc(pid)}`;
  else if (link && !failed) { href = link.href; external = !!link.external; }
  else if (id) href = `#/runs/${enc(id)}`;
  const label = n.final ? FINAL.yes : words.todo;
  // a question or a decision this person may give here opens its panel on the page (as Your turn does), not the issue
  const answer = answerItemFor(id, n.kind, mine);
  return {
    ...(simple ? { project: pid, tag: tagOf(n) } : {}),
    ...(answer ? { answer: { ...answer, label } } : {}),
    id,
    title,
    sentence: failed ? STUCK.line : n.final ? FINAL.line : words.line,
    action: href ? { label: external ? `${label} ↗` : label, href, external } : null,
    cause: simple ? plainWords(n.why, TODAY.noCause) : String(n.why ?? "").trim() || TODAY.noCause,
    runHref: !simple && id ? `#/runs/${enc(id)}` : null,
    owner: role === "admin" ? ownerLabel(e.run?.ownerName) : "",
  };
}

function buildingOf(e, n, { role, simple, title, href, pid }) {
  const phase = e.run ? runPhase(e.run) : null;
  const words = kindWords(n.kind, n.who).line;
  // Only work that runs is described by its phase; paused or waiting work says what it waits for.
  const line = n.kind === "running" ? phase?.line || words : words || phase?.line || "";
  const owner = role === "admin" ? ownerLabel(e.run?.ownerName) : "";
  // Simple also says which project, whether the work really runs (not paused) and when it started: the current project is picked from that.
  const extra = simple ? { project: pid, running: n.kind === "running", startedMs: Date.parse(e.run?.startedAt ?? "") || 0 } : {};
  return { id: idOf(e), title, phase, line, href, owner, ...extra };
}

/** The `details` that were opened by the person, by focus name and run: kept across redraws. */
const opened = new Set();

const link = (cls, href, focus, external, ...kids) => (external
  ? h("a", { class: cls, href, target: "_blank", rel: "noopener noreferrer", "data-focus": focus }, ...kids)
  : h("a", { class: cls, href, "data-focus": focus }, ...kids));

/** The "See what happened" details of an attention item; the open state is kept by focus name and run. */
export function causeDetails(c, focus) {
  const fid = c.id ?? "x";
  const key = `${focus}:${fid}`;
  return h("details", {
    class: "today-cause",
    open: opened.has(key) ? true : undefined,
    onToggle: (e) => {
      const open = e?.target?.open === true || e?.target?.hasAttribute?.("open") === true;
      if (open) opened.add(key); else opened.delete(key);
    },
  },
    h("summary", { "data-focus": `${focus}-cause-${fid}` }, TODAY.seeWhat),
    h("p", {}, c.cause),
    c.runHref ? h("a", { href: c.runHref, "data-focus": `${focus}-run-${fid}` }, TODAY.openRun) : null);
}

/** The state tag of a Simple attention item, from the record kind. */
export function tagOf(n) {
  if (n?.kind === "failed" || n?.kind === "stopped") return "stuck";
  if (isReady(n)) return "check";
  if (n?.kind === "questions" || n?.kind === "planner_questions") return "question";
  return "todo";
}

/**
 * The button of an attention item: with `c.answer`, a button that opens the panel to answer or decide in place (the page refreshes by
 * itself after the answer is sent); else the link of `c.action`; else nothing. `onAct` is for tests.
 */
export function actionNode(c, focus, { onAct = (body) => api.actTurn(body) } = {}) {
  const fid = c.id ?? "x";
  if (c.answer) {
    return h("button", { type: "button", class: "btn primary", "data-focus": `${focus}-act-${fid}`, onClick: () => openTurnItem({ key: c.answer.key, next: { kind: c.answer.kind } }, onAct) }, c.answer.label);
  }
  return c.action ? link("btn primary", c.action.href, `${focus}-act-${fid}`, c.action.external, c.action.label) : null;
}

export function attentionCard(c, focus) {
  return h("li", { class: "card today-card" },
    h("h3", {}, c.title),
    h("p", {}, c.sentence),
    c.owner ? h("p", { class: "muted" }, `Owner: ${c.owner}`) : null,
    actionNode(c, focus),
    causeDetails(c, focus));
}

export function buildingItem(b, focus) {
  const fid = b.id ?? "x";
  return h("li", { class: "today-item" },
    h("h3", {}, h("a", { href: b.href, "data-focus": `${focus}-building-${fid}` }, b.title)),
    phaseStrip({ label: `${TODAY.progress}: ${b.title}`, phases: PHASES.map((p) => p.word), current: b.phase?.index ?? null }),
    b.line ? h("p", { class: "muted" }, b.line) : null,
    b.owner ? h("p", { class: "muted" }, `Owner: ${b.owner}`) : null);
}

/**
 * Today as nodes: greeting, summary line, a card for each thing that needs the person, the four counters, Building now and
 * Finished recently. opts: { focus (prefix of the Tab stops), simple, list (Simple: the group whose list is shown under the counters),
 * onboarding (nothing at all yet: say so and offer the first steps) }.
 */
export function todayView(model, { focus = "today", simple = false, list = "", onboarding = false } = {}) {
  const cards = model.attention;
  const needs = cards.length + (model.extraNeeds ?? 0);
  const counters = counterLinks(model.counts, { simple });
  const more = (n, href, name) => (n > 0 ? h("p", {}, h("a", { href, "data-focus": `${focus}-more-${name}` }, TODAY.more(n))) : null);
  const listed = simple && Object.hasOwn(model.lists, list) ? list : "";
  return [
    h("h1", { class: "today-greeting" }, greeting(model.now)),
    h("p", { class: "today-summary" }, summaryLine({ check: needs, building: model.counts.building, finishedToday: model.counts["finished-today"], unknown: model.needsUnknown })),
    onboarding
      ? h("div", { class: "today-empty home-clear" },
        h("p", {}, TODAY.empty),
        h("div", { class: "row" }, h("a", { class: "btn primary", href: "#/start", "data-focus": `${focus}-start` }, TODAY.start), h("a", { href: "#/repos", "data-focus": `${focus}-repos` }, TODAY.repos)))
      : null,
    cards.length
      ? h("section", { class: "today-attention" },
        h("h2", {}, TODAY.needsTitle),
        h("ul", { class: "today-cards" }, cards.slice(0, SHOWN).map((c) => attentionCard(c, focus))),
        more(cards.length - SHOWN, counters[2].href, "needs"))
      : null,
    h("nav", { class: "today-counters", "aria-label": TODAY.countersLabel },
      h("ul", {}, counters.map((c) => h("li", {},
        h("a", { class: "today-counter", href: c.href, "data-focus": `${focus}-count-${c.key}` },
          h("span", { class: "today-count" }, String(c.count)), " ", h("span", {}, c.label)))))),
    listed
      ? h("section", { class: "today-list" },
        h("h2", {}, TODAY.lists[listed]),
        model.lists[listed].length
          ? h("ul", {}, model.lists[listed].map((i) => h("li", {}, h("a", { href: i.href, "data-focus": `${focus}-list-${i.id ?? "x"}` }, i.title))))
          : h("p", { class: "muted" }, TODAY.nothingInList),
        h("p", {}, h("a", { href: "#/home", "data-focus": `${focus}-list-back` }, TODAY.back)))
      : null,
    h("section", { class: "today-building" },
      h("h2", {}, TODAY.buildingTitle),
      model.building.length
        ? h("ul", {}, model.building.slice(0, SHOWN).map((b) => buildingItem(b, focus)))
        : h("p", { class: "muted" }, TODAY.nothingBuilding),
      more(model.building.length - SHOWN, counters[1].href, "building")),
    h("section", { class: "today-finished" },
      h("h2", {}, TODAY.finishedTitle),
      model.finished.length
        ? h("ul", {}, model.finished.slice(0, SHOWN).map((i) => h("li", {}, h("a", { href: i.href, "data-focus": `${focus}-finished-${i.id ?? "x"}` }, i.title))))
        : h("p", { class: "muted" }, TODAY.nothingFinished),
      h("p", {}, h("a", { href: groupHref("finished", simple), "data-focus": `${focus}-show-all` }, TODAY.showAll))),
  ];
}
