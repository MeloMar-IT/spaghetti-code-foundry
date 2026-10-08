import { api } from "./api.js";
import { clarityCard } from "./dashboard.js";
import { h, mount } from "./dom.js";
import { EMPTY, NOTHING_ACTIVE, bestAction, countsText, headView, homeModel, sectionView, withActive } from "./home.js";
import { nextParts } from "./next.js";
import { renderYourTurn } from "./turn.js";

// The admin Home. "Needs you" is the Your turn section itself (the server's answer, drawn by turn.js); Active and
// Recently completed come from the runs' next-step records; Problems are what the health answer lists on top of that.

const REFRESH_MS = 30_000;

/** A key that is the same for the same record, whichever list it came from. The text is left out: the health answer rewrites it for a Foundry failure. */
const keyOf = (n) => [n.kind, n.runId ?? "", n.repo ?? "", n.issue ?? ""].join("|");

/**
 * The admin Home. `since`: the element startSince draws into (may be null). Returns a cleanup.
 * `a` is the API object; Your turn always uses the real one, as it does on its own page.
 */
export async function renderAdminHome(main, { a = api, since = null } = {}) {
  let gone = false;
  let seq = 0;
  let turn = null; // the newest Your turn answer
  let model = null; // the newest homeModel, null until runs and queue answered
  let health = null;
  let loadFailed = false; // runs or queue did not answer and there is nothing older to show
  const head = h("div");
  const needsBox = h("div", { class: "home-section" });
  const activeBox = h("div");
  const problemsBox = h("div");
  const recentBox = h("div");
  const metricsBox = h("details", { class: "home-section" });
  const box = h("div", { class: "home" }, head, needsBox, activeBox, since, problemsBox, recentBox, metricsBox);

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

  function drawWork() {
    if (!model) {
      if (loadFailed) mount(activeBox, h("section", { class: "home-section" }, h("h2", {}, "Active"), h("p", { class: "home-clear", role: "alert" }, "Active work could not be loaded. It will try again.")));
      return;
    }
    const empty = model.total === 0 && (turn?.count ?? 0) === 0 && problemCount() === 0;
    mount(activeBox, sectionView("Active", model.active, { empty: empty ? EMPTY : NOTHING_ACTIVE, role: "admin", owner: true }));
    const records = problemRecords();
    const f = health?.monitorFindings;
    mount(problemsBox, records.length || skills().length || skillsMore() || f?.open > 0
      ? h("section", { class: "home-section" },
        h("h2", {}, "Problems"),
        h("ul", { class: "home-list" },
          records.map((n) => h("li", { class: "home-row" }, h("div", { class: "home-main" }, nextParts(n, { status: false })))),
          skills().map((p) => h("li", { class: "home-row" }, h("div", { class: "home-main muted" }, `Skills (${p.root}${p.package ? " / " + p.package : ""}): ${p.reason}`)))),
        skillsMore() ? h("p", { class: "muted" }, `${skillsMore()} more skill problem${skillsMore() === 1 ? "" : "s"} not shown. See the health line.`) : null,
        f?.open > 0 ? h("a", { href: "#/problems" }, `${f.open} open finding${f.open === 1 ? "" : "s"} of the monitor`) : null)
      : null);
    mount(recentBox, sectionView("Recently completed", model.recent, { collapsed: true, role: "admin", owner: true }));
    drawHead();
  }

  async function load() {
    const mine = ++seq;
    const [runs, queue, hl] = await Promise.all([a.runs(), a.queue(), a.health().catch(() => null)]);
    const all = await withActive(a, runs, queue);
    if (gone || mine !== seq) return;
    loadFailed = false;
    model = homeModel(all, queue?.pending);
    health = hl;
    drawWork();
  }

  // Metrics stay closed; they load on the first open only.
  let metricsAsked = false;
  const summary = h("summary", {}, "Metrics");
  const metricsBody = h("div", {});
  mount(metricsBox, summary, metricsBody);
  metricsBox.addEventListener("toggle", async () => {
    if (metricsAsked || !(metricsBox.open === true || metricsBox.getAttribute("open") != null)) return;
    metricsAsked = true;
    try {
      const c = await a.clarity();
      if (gone) return;
      mount(metricsBody, clarityCard(c), h("a", { href: "#/dashboard" }, "All metrics"));
    } catch (e) {
      metricsAsked = false;
      if (!gone) mount(metricsBody, h("p", { class: "status bad", role: "alert" }, e.message));
    }
  });

  mount(main, box);
  // Each feed stands alone: Your turn failing leaves Active, and the other way round.
  let stopTurn = () => {};
  const turnDone = renderYourTurn(needsBox, {
    embedded: true,
    onData: (data) => {
      turn = data;
      if (!gone) {
        drawHead();
        drawWork();
      }
    },
  }).then((stop) => { stopTurn = stop; }, (e) => {
    if (!gone) mount(needsBox, h("section", { class: "home-section" }, h("h2", {}, "Needs you"), h("p", { class: "home-clear", role: "alert" }, `Could not load what needs you: ${e.message}`)));
  });
  const first = load().catch(() => { loadFailed = true; if (!gone) drawWork(); });
  await Promise.all([turnDone, first]);
  // The person went on to another page while Home was loading: nothing of this call may stay.
  if (gone) stopTurn();
  const timer = setInterval(() => load().catch(() => {}), REFRESH_MS);
  return () => {
    gone = true;
    stopTurn();
    clearInterval(timer);
  };
}
