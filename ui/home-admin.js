import { api } from "./api.js";
import { clarityCard } from "./dashboard.js";
import { h, mount } from "./dom.js";
import { EMPTY, NOTHING_ACTIVE, bestAction, countsText, headView, homeModel, sectionView, withActive } from "./home.js";
import { keepScroll, liveStates, poller } from "./live.js";
import { nextParts } from "./next.js";
import { renderYourTurn } from "./turn.js";

// The admin Home. "Needs you" is the Your turn section itself (the server's answer, drawn by turn.js); Active and
// Recently completed come from the runs' next-step records; Problems are what the health answer lists on top of that.
// Each feed has its own poller (Your turn every 5 s, Active every 30 s). Health is a part of the Active answer and can fail alone.

const REFRESH_MS = 30_000;
const PROBLEMS_STALE = "Problems could not be refreshed. Showing the last answer.";
const PROBLEMS_FAILED = "Problems could not be loaded.";

/** A key that is the same for the same record, whichever list it came from. The text is left out: the health answer rewrites it for a Foundry failure. */
const keyOf = (n) => [n.kind, n.runId ?? "", n.repo ?? "", n.issue ?? ""].join("|");

/**
 * The admin Home. `since`: the element startSince draws into (may be null). Returns a cleanup.
 * `a` is the API object; Your turn always uses the real one, as it does on its own page.
 */
export async function renderAdminHome(main, { a = api, since = null } = {}) {
  let gone = false;
  let turn = null; // the newest Your turn answer
  let model = null; // the newest homeModel, null until runs and queue answered
  let health = null; // the last good health answer
  let healthFailed = false; // the newest health request failed
  let lineText = ""; // the text of the Problems line on the page
  let poll;
  const head = h("div");
  const needsBox = h("div", { class: "home-section" });
  const activeBox = h("div");
  const problemsList = h("div");
  const problemsLine = h("div");
  const problemsBox = h("div", {}, problemsList, problemsLine);
  const recentBox = h("div");
  const metricsBox = h("details", { class: "home-section" });
  const states = liveStates({
    body: activeBox,
    heading: () => h("h2", {}, "Active"),
    label: "Loading active work",
    what: "Active work could not be loaded.",
    retry: () => poll.refresh(),
    focus: "home-active",
  });
  const box = h("div", { class: "home" }, head, states.alert, needsBox, activeBox, since, problemsBox, recentBox, states.note, metricsBox);

  /** The records of Problems: the health answer without the ones Your turn already shows. */
  const problemRecords = () => {
    const shown = new Set([...(turn?.groups ?? []).flatMap((g) => g.items), ...(turn?.continuing ?? [])].map((i) => keyOf(i.next)));
    return (health?.problems ?? []).filter((n) => !shown.has(keyOf(n)));
  };
  const skills = () => health?.skillProblems ?? [];
  const skillsMore = () => health?.skillProblemsMore ?? 0;
  const problemCount = () => problemRecords().length + skills().length + skillsMore() + (health?.monitorFindings?.open > 0 ? 1 : 0);

  function drawHead() {
    const m = model ?? { active: [] };
    const first = turn?.groups?.[0]?.items?.[0]?.next;
    const needs = turn?.count ?? 0;
    // Without runs and queue there is no honest "Start work" to offer.
    const known = model || needs > 0 || problemCount() > 0;
    mount(head, headView({
      counts: countsText({ needs, active: m.active.length, problems: problemCount() }),
      action: !known ? null : bestAction({
        first: first,
        problems: problemRecords(),
        active: m.active,
      }, "admin"),
    }));
  }

  /** The Problems line is mounted only when its text changes, so repeated failures leave the same node. */
  function drawLine() {
    const text = !healthFailed ? "" : health ? PROBLEMS_STALE : PROBLEMS_FAILED;
    states.note.hidden = healthFailed; // "Updated" would claim more than is true
    if (text === lineText) return;
    lineText = text;
    mount(problemsLine, text ? h("p", { class: "stale-note failed", role: "status" }, text) : null);
  }

  function drawWork() {
    if (!model) return;
    drawLine();
    // No page-wide "empty" claim without a health answer.
    const empty = model.total === 0 && (turn?.count ?? 0) === 0 && problemCount() === 0 && health !== null;
    mount(activeBox, sectionView("Active", model.active, { empty: empty ? EMPTY : NOTHING_ACTIVE, role: "admin", owner: true }));
    const records = problemRecords();
    const f = health?.monitorFindings;
    // Two records can share a key (one usage limit per agent): the focus name still has to be unique.
    const seen = new Map();
    const focusOf = (n) => {
      const key = keyOf(n);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return "home-problem-" + key + (count > 1 ? "-" + count : "");
    };
    mount(problemsList, records.length || skills().length || skillsMore() || f?.open > 0 || healthFailed
      ? h("section", { class: "home-section" },
        h("h2", {}, "Problems"),
        records.length || skills().length ? h("ul", { class: "home-list" },
          records.map((n) => h("li", { class: "home-row" }, h("div", { class: "home-main" }, nextParts(n, { status: false, focus: focusOf(n) })))),
          skills().map((p) => h("li", { class: "home-row" }, h("div", { class: "home-main muted" }, `Skills (${p.root}${p.package ? " / " + p.package : ""}): ${p.reason}`)))) : null,
        skillsMore() ? h("p", { class: "muted" }, `${skillsMore()} more skill problem${skillsMore() === 1 ? "" : "s"} not shown. See the health line.`) : null,
        f?.open > 0 ? h("a", { href: "#/problems", "data-focus": "home-findings" }, `${f.open} open finding${f.open === 1 ? "" : "s"} of the monitor`) : null)
      : null);
    mount(recentBox, sectionView("Recently completed", model.recent, { collapsed: true, role: "admin", owner: true }));
  }

  const redraw = () => keepScroll(box, () => { drawHead(); drawWork(); });

  // Metrics stay closed; they load on the first open only.
  let metricsAsked = false;
  const summary = h("summary", { "data-focus": "home-metrics" }, "Metrics");
  const metricsBody = h("div", {});
  mount(metricsBox, summary, metricsBody);
  metricsBox.addEventListener("toggle", async () => {
    if (metricsAsked || !(metricsBox.open === true || metricsBox.getAttribute("open") != null)) return;
    metricsAsked = true;
    try {
      const c = await a.clarity();
      if (gone) return;
      mount(metricsBody, clarityCard(c), h("a", { href: "#/dashboard", "data-focus": "home-all-metrics" }, "All metrics"));
    } catch (e) {
      metricsAsked = false;
      if (!gone) mount(metricsBody, h("p", { class: "status bad", role: "alert" }, e.message));
    }
  });

  mount(main, box);
  drawHead();
  // Each feed stands alone: Your turn failing leaves Active, and the other way round.
  let stopTurn = () => {};
  const turnDone = renderYourTurn(needsBox, {
    embedded: true,
    focus: "home-needs",
    onData: (data) => {
      turn = data;
      if (!gone) redraw();
    },
  }).then((stop) => { stopTurn = stop; });
  poll = poller({
    load: async () => {
      const [runs, queue, hl] = await Promise.all([
        a.runs(),
        a.queue(),
        a.health().then((value) => ({ ok: true, value }), () => ({ ok: false })),
      ]);
      return { runs: await withActive(a, runs, queue), pending: queue?.pending, health: hl };
    },
    draw: ({ runs, pending, health: hl }) => {
      model = homeModel(runs, pending);
      healthFailed = !hl.ok;
      if (hl.ok) health = hl.value;
      redraw();
    },
    every: REFRESH_MS,
    onState: states.onState,
  });
  await Promise.all([turnDone, poll.ready]);
  return () => {
    gone = true;
    stopTurn();
    poll.stop();
  };
}
