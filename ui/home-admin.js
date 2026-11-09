import { api } from "./api.js";
import { clarityCard } from "./dashboard.js";
import { h, mount } from "./dom.js";
import { withActive } from "./home.js";
import { keepScroll, liveStates, poller } from "./live.js";
import { nextParts } from "./next.js";
import { droppedRuns, greeting, todayModel, todayView } from "./today.js";
import { renderYourTurn } from "./turn.js";

// The admin Home: Today (./today.js, drawn from the runs), then Your turn (the server's answer, drawn by turn.js), Since,
// Problems and Metrics. A run is shown once: Today leaves out the runs Your turn shows (it has their Approve and Retry
// buttons), and Your turn leaves out what #838 dropped (closed issue, "Not now"). The summary counts both feeds, and never
// says "Nothing needs you" while Your turn is unknown. Each feed has its own poller (Your turn every 5 s, runs every 30 s).
// Health is a part of the runs answer and can fail alone.

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
  let turnFailed = false; // the newest Your turn request failed
  let runsData = null; // the newest { runs, pending }, null until runs and queue answered
  let dropped = new Set(); // run ids Today and Your turn drop (#838), from the newest runs answer
  const hook = {}; // hook.redraw(): Your turn draws its last answer again
  let health = null; // the last good health answer
  let healthFailed = false; // the newest health request failed
  let lineText = ""; // the text of the Problems line on the page
  let poll;
  const needsBox = h("div", { class: "home-section" });
  const todayBox = h("div", { class: "today" });
  const problemsList = h("div");
  const problemsLine = h("div");
  const problemsBox = h("div", {}, problemsList, problemsLine);
  const metricsBox = h("details", { class: "home-section" });
  const states = liveStates({
    body: todayBox,
    heading: () => h("h1", { class: "today-greeting" }, greeting()),
    label: "Loading today's work",
    what: "Today's work could not be loaded.",
    retry: () => poll.refresh(),
    focus: "home-today",
  });
  const box = h("div", { class: "home" }, todayBox, states.alert, needsBox, since, problemsBox, states.note, metricsBox);

  /** Your turn without what #838 dropped. */
  const keep = (item) => !dropped.has(item.next?.runId);
  const turnItems = () => (turn?.groups ?? []).flatMap((g) => g.items).filter(keep);

  /**
   * The run ids Today leaves out because Your turn shows them: the runs of its items, of its "Done — continuing" items, and
   * the members of a grouped release (the server sends a release group without member run ids, only its shared release address).
   */
  const coveredRuns = (runs, items) => {
    const ids = new Set([...items, ...(turn?.continuing ?? [])].map((i) => i.next?.runId).filter(Boolean));
    const releases = new Set(items.filter((i) => i.key?.startsWith("release|")).map((i) => i.next?.where?.url).filter(Boolean));
    for (const r of runs ?? []) {
      if (r?.next?.kind === "release" && releases.has(r.next.where?.url)) ids.add(r.runId);
    }
    return ids;
  };

  /** The records of Problems: the health answer without the ones Your turn already shows. */
  const problemRecords = () => {
    const shown = new Set([...(turn?.groups ?? []).flatMap((g) => g.items), ...(turn?.continuing ?? [])].map((i) => keyOf(i.next)));
    return (health?.problems ?? []).filter((n) => !shown.has(keyOf(n)));
  };
  const skills = () => health?.skillProblems ?? [];
  const skillsMore = () => health?.skillProblemsMore ?? 0;
  const problemCount = () => problemRecords().length + skills().length + skillsMore() + (health?.monitorFindings?.open > 0 ? 1 : 0);

  /** The Problems line is mounted only when its text changes, so repeated failures leave the same node. */
  function drawLine() {
    const text = !healthFailed ? "" : health ? PROBLEMS_STALE : PROBLEMS_FAILED;
    states.note.hidden = healthFailed; // "Updated" would claim more than is true
    if (text === lineText) return;
    lineText = text;
    mount(problemsLine, text ? h("p", { class: "stale-note failed", role: "status" }, text) : null);
  }

  function drawWork() {
    if (!runsData) return;
    drawLine();
    // A run is shown once: Your turn has the runs it lists, with their buttons; Today has the rest.
    const items = turnItems();
    const covered = coveredRuns(runsData.runs, items);
    const model = todayModel(runsData.runs, runsData.pending, { role: "admin", exclude: covered, extraNeeds: items.length });
    // Your turn is unknown (no answer yet, or the last one failed): nothing is said to be clear.
    model.needsUnknown = (turn === null || turnFailed) && model.attention.length + items.length === 0;
    // No page-wide "empty" claim without a health answer.
    const empty = model.total === 0 && (turn?.count ?? 0) === 0 && problemCount() === 0 && health !== null && !model.needsUnknown;
    mount(todayBox, ...todayView(model, { focus: "home", onboarding: empty }));
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
  }

  const redraw = () => keepScroll(box, () => drawWork());

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
  // Each feed stands alone: Your turn failing leaves Today, and the other way round.
  let stopTurn = () => {};
  const turnDone = renderYourTurn(needsBox, {
    embedded: true,
    focus: "home-needs",
    keep,
    hook,
    onState: (st) => {
      turnFailed = st?.failed === true;
      if (!gone && runsData) redraw();
    },
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
      runsData = { runs, pending };
      dropped = droppedRuns(runs);
      healthFailed = !hl.ok;
      if (hl.ok) health = hl.value;
      redraw();
      // Your turn follows the new flags at once, whichever answer came first; its own failed refresh does not matter.
      hook.redraw?.();
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
