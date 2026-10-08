import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { nextStatus, whenParts, whereTarget } from "./next.js";
import { ownerLabel } from "./runs.js";
import { firstLine, myRunsEntries, workText } from "./user/runs.js";

// Home: what needs the person, what is running, what finished. Every row is one authoritative next-step record
// (`run.next` or `job.next`); the groups come from the record, never from the run's status. No cost, model or health here.

export const SHOWN = 5;
export const EMPTY = "Nothing here yet. Start work to begin.";
export const ALL_CLEAR = "Nothing needs you.";
export const NOTHING_ACTIVE = "Nothing is running.";
const REFRESH_MS = 30_000;
// Addresses the user display has a page for (see USER_HASH in auth.js).
const USER_PAGE = /^#\/(home|start|runs(\/[\w-]+)?|refinement(\/[\w-]+)?|repos)$/;
// Records that end the story of a run: nothing is running and nothing waits.
const ENDED = new Set(["cancelled", "superseded", "issue_closed"]);

/**
 * The runs plus every active job whose run is not in the list (the list is the newest 200): those are fetched one by
 * one, so a resumed old run still shows as active. A run that cannot be fetched is left out.
 */
export async function withActive(a, runs, queue) {
  const list = Array.isArray(runs) ? runs : [];
  const have = new Set(list.map((r) => r.runId));
  const missing = (Array.isArray(queue?.active) ? queue.active : []).map((x) => x.runId).filter((id) => id && !have.has(id));
  const extra = (await Promise.all(missing.map((id) => Promise.resolve().then(() => a.run(id)).catch(() => null)))).filter((r) => r?.runId);
  return extra.length ? [...list, ...extra] : list;
}

/** The same rule as `needsUser` on the server: the record says the next move is the person's, or something is wrong. */
export const needsUser = (n) => !!n && n.kind !== "cancelled" && (n.who === "You" || n.who === "Something is wrong");

const recordOf = (e) => e.run?.next ?? e.job?.next;
const idOf = (e) => e.run?.runId ?? e.job?.runId;
const finishedMs = (e) => Date.parse(e.run?.finishedAt ?? e.run?.startedAt ?? "") || 0;

/**
 * → { needs, problems, active, recent, total } of { run, job } entries. A failure is a need (as in Your turn), so
 * `problems` is empty here; the admin Home fills its own Problems from the health answer.
 */
export function homeModel(runs, pending) {
  const out = { needs: [], problems: [], active: [], recent: [], total: 0 };
  for (const e of myRunsEntries(runs, pending)) {
    const n = recordOf(e);
    if (!n) continue; // old run data without a record stays on the Runs page
    out.total++;
    if (needsUser(n)) out.needs.push(e);
    else if (n.kind === "done") out.recent.push(e);
    else if (!ENDED.has(n.kind)) out.active.push(e);
  }
  out.recent.sort((a, b) => finishedMs(b) - finishedMs(a));
  return out;
}

/** The link of a record: { href, label, external }; undefined when there is none we may use. A user only gets pages that display has. */
export function recordLink(n, role, runId) {
  const t = whereTarget(n?.where);
  const label = n?.where?.label || n?.action || "Open";
  if (t?.external) return { href: t.href, label: `${label} ↗`, external: true };
  if (t && (role !== "user" || USER_PAGE.test(t.href))) return { href: t.href, label, external: false };
  return runId ? { href: `#/runs/${encodeURIComponent(runId)}`, label: "Open the run", external: false } : undefined;
}

/**
 * The one best action: the next record of the first need, then the first problem, then the first active run, else Start work.
 * `first` and `problems` are records (with `runId`); `active` is a list of entries. `primary` only when nothing needs the person.
 */
export function bestAction({ first, problems = [], active = [] }, role = "user") {
  for (const n of [first, ...problems]) {
    const l = n && recordLink(n, role, n.runId);
    if (l) return { ...l, primary: false };
  }
  const id = active[0] && idOf(active[0]);
  if (id) return { href: `#/runs/${encodeURIComponent(id)}`, label: "Follow", external: false, primary: false };
  return { href: "#/start", label: "Start work", external: false, primary: true };
}

/** "2 need you · 1 active · 1 problem"; "" when all are 0. */
export function countsText({ needs = 0, active = 0, problems = 0 }) {
  return [
    needs > 0 ? `${needs} ${needs === 1 ? "needs" : "need"} you` : null,
    active > 0 ? `${active} active` : null,
    problems > 0 ? `${problems} ${problems === 1 ? "problem" : "problems"}` : null,
  ].filter(Boolean).join(" · ");
}

function linkNode(l, cls) {
  return l.external
    ? h("a", { class: cls, href: l.href, target: "_blank", rel: "noopener noreferrer" }, l.label)
    : h("a", { class: cls, href: l.href }, l.label);
}

/** One row: status, task, the record's sentence, one primary link and a Details link to the run. */
export function workRow(entry, { role = "user", owner = false, primary = true } = {}) {
  const { run, job } = entry;
  const n = recordOf(entry);
  const id = idOf(entry);
  const task = firstLine(run?.task ?? job?.task);
  const work = run ? workText(run.vars?.github_repo, run.vars?.issue) : workText(job?.githubRepo, job?.issue);
  const detail = id ? `#/runs/${encodeURIComponent(id)}` : null;
  const link = n ? recordLink(n, role, id) : undefined;
  const who = owner ? ownerLabel(run?.ownerName) : "";
  return h("li", { class: "home-row" },
    h("div", { class: "home-main" },
      h("div", { class: "row" }, n ? nextStatus(n) : null, h("b", {}, task || run?.flow || job?.flow || "Queued run")),
      work ? h("div", { class: "muted mono" }, work) : null,
      n ? h("div", { class: "muted" }, n.text) : null,
      n && whenParts(n).length ? h("div", { class: "next-parts timing" }, whenParts(n)) : null,
      who ? h("div", { class: "muted" }, `Owner: ${who}`) : null),
    h("div", { class: "home-side" },
      link ? linkNode(link, primary ? "btn primary" : "btn") : null,
      detail && link?.href !== detail ? h("a", { class: "btn ghost small", href: detail }, "Details") : null));
}

/** A section: h2 and rows (at most SHOWN, then "+n more" → #/runs). opts: { empty, collapsed, role, owner }. null with no entries and no `empty`. */
export function sectionView(title, entries, { empty, collapsed = false, role = "user", owner = false } = {}) {
  if (!entries.length && !empty) return null;
  // The head owns the one primary button; rows use plain buttons.
  const body = entries.length
    ? [h("ul", { class: "home-list" }, entries.slice(0, SHOWN).map((e) => workRow(e, { role, owner, primary: false }))),
      entries.length > SHOWN ? h("a", { class: "home-more", href: "#/runs" }, `+${entries.length - SHOWN} more`) : null]
    : [h("p", { class: "home-clear" }, empty)];
  if (collapsed) return h("details", { class: "home-section" }, h("summary", {}, `${title} (${entries.length})`), ...body);
  return h("section", { class: "home-section" }, h("h2", {}, entries.length ? `${title} (${entries.length})` : title), ...body);
}

/** The top of the page: the counts and the one best action. */
export function headView({ counts, action }) {
  return h("div", { class: "home-head" },
    h("h1", {}, "Home"),
    counts ? h("span", { class: "home-counts muted" }, counts) : null,
    h("span", { class: "spacer" }),
    action ? linkNode(action, action.primary ? "btn primary" : "btn") : null);
}

/** The Ask SCF prompts, last on the page; null for none. */
export function askView(prompts, onAsk) {
  if (!prompts?.length) return null;
  return h("section", { class: "home-ask" },
    h("h2", {}, "Ask SCF"),
    h("div", { class: "row" }, prompts.map((p) => h("button", { type: "button", class: "small", onClick: () => onAsk?.(p) }, p))));
}

/** The best action of a model. */
export function modelAction(model, role) {
  const n = model.needs[0] && recordOf(model.needs[0]);
  return bestAction({
    first: n ? { ...n, runId: idOf(model.needs[0]) } : undefined,
    problems: model.problems.map((e) => ({ ...recordOf(e), runId: idOf(e) })),
    active: model.active,
  }, role);
}

/** The user page as nodes. */
export function homeView(model, { role = "user", prompts = [], onAsk } = {}) {
  if (model.total === 0) {
    return [
      headView({ counts: "", action: null }),
      h("div", { class: "home-clear" },
        h("p", {}, EMPTY),
        h("div", { class: "row" }, h("a", { class: "btn primary", href: "#/start" }, "Start work"), h("a", { href: "#/repos" }, "My repositories"))),
      askView(prompts, onAsk),
    ];
  }
  return [
    headView({ counts: countsText({ needs: model.needs.length, active: model.active.length, problems: model.problems.length }), action: modelAction(model, role) }),
    sectionView("Needs you", model.needs, { empty: ALL_CLEAR, role }),
    sectionView("Active", model.active, { empty: NOTHING_ACTIVE, role }),
    sectionView("Recently completed", model.recent, { collapsed: true, role }),
    askView(prompts, onAsk),
  ];
}

/** The user Home; refreshes every 30 seconds; returns a cleanup. */
export async function renderHome(main, { a = api } = {}) {
  let gone = false;
  let seq = 0;
  const box = h("div", { class: "home" });
  async function load() {
    const mine = ++seq;
    const [runs, queue] = await Promise.all([a.runs(), a.queue()]);
    const all = await withActive(a, runs, queue);
    if (gone || mine !== seq) return;
    mount(box, homeView(homeModel(all, queue?.pending), { role: "user" }));
  }
  mount(main, box);
  await load();
  const timer = setInterval(() => load().catch(() => {}), REFRESH_MS);
  return () => {
    gone = true;
    clearInterval(timer);
  };
}
