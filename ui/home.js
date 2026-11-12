import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { keepScroll, liveStates, poller } from "./live.js";
import { whereTarget } from "./next.js";
// This module, ./today.js and ./simple-model.js import each other: none of them uses another at the top level, only inside functions.
import { greeting, todayModel, todayView } from "./today.js";

// Home is Today (./today.js): every card is one authoritative next-step record (`run.next` or `job.next`); the groups come
// from the record, never from the run's status. No cost, model or health here.

export const EMPTY = "Nothing here yet. Start work to begin.";
const REFRESH_MS = 30_000;
// Addresses the user display has a page for (see USER_HASH in auth.js).
const USER_PAGE = /^#\/(home|start|runs(\/[\w-]+)?|refinement(\/[\w-]+)?|repos)$/;

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

/** The link of a record: { href, label, external }; undefined when there is none we may use. A user only gets pages that display has. */
export function recordLink(n, role, runId) {
  const t = whereTarget(n?.where);
  const label = n?.where?.label || n?.action || "Open";
  if (t?.external) return { href: t.href, label: `${label} ↗`, external: true };
  if (t && (role !== "user" || USER_PAGE.test(t.href))) return { href: t.href, label, external: false };
  return runId ? { href: `#/runs/${encodeURIComponent(runId)}`, label: "Open the run", external: false } : undefined;
}

/** The user page as nodes: always the whole Today layout; with nothing at all it also says so and offers the first steps. */
export function homeView(model) {
  return todayView(model, { focus: "home", onboarding: model.total === 0 });
}

/** The user Home; asks every 30 seconds while the tab is visible; never rejects; returns a cleanup. */
export async function renderHome(main, { a = api, setup = false } = {}) {
  const box = h("div", { class: "home" });
  mount(main, box);
  let poll;
  const states = liveStates({
    body: box,
    heading: () => h("h1", { class: "today-greeting" }, greeting()),
    label: "Loading Home",
    what: "Home could not be loaded.",
    retry: () => poll.refresh(),
    focus: "home",
  });
  poll = poller({
    load: async () => {
      // the items the person may answer here; a failed read gives none, and the cards link to the issue as before
      const mine = Promise.resolve().then(() => a.myTurn()).then((v) => (Array.isArray(v?.items) ? v.items : []), () => []);
      const [runs, queue, items] = await Promise.all([a.runs(), a.queue(), mine]);
      return { runs: await withActive(a, runs, queue), pending: queue?.pending, mine: items };
    },
    draw: ({ runs, pending, mine }) => {
      const [head, ...rest] = homeView(todayModel(runs, pending, { role: "user", mine }));
      const more = setup ? h("p", { class: "muted" }, h("a", { href: "#/setup" }, "Setup check"), " — what this computer still needs") : null;
      keepScroll(box, () => mount(box, head, states.alert, ...rest, more, states.note));
    },
    every: REFRESH_MS,
    onState: states.onState,
  });
  await poll.ready;
  return () => poll.stop();
}
