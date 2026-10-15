import { api } from "./api.js";
import { chartPoints, chartRows, chainNotes, criticalPathView, forecastView, historyLines, paceView, storyItems } from "./epic-page-model.js";
import { h, mount, svg, table } from "./dom.js";
import { progressBar } from "./epics.js";
import { freshText, growthSentence, pickRepo, progressText, repoChoices } from "./epics-model.js";
import { withQuery } from "./filters.js";
import { chainGraph } from "./graph.js";
import { emptyState, errorState, explainError, loadingState, permissionState, staleNote } from "./states.js";
import { detailPage } from "./templates.js";

// The page of one epic, from GET /api/repos/:id/epics/:issue. The server decides every number and the forecast; the model
// (ui/epic-page-model.js) turns them into words, this file draws them. Dates use the person's time zone.

const HISTORY_SHOWN = 7;
const CANNOT_KNOW = "It cannot know when a usage limit stops work or when a person will answer.";
const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const tr = (...cells) => h("tr", {}, cells.map((c) => h("td", {}, c)));

/** The chart: two lines (stories in the epic, stories done) as plain SVG, with a legend. null without points. */
export function epicChart(points) {
  if (!points) return null;
  const { width: W, height: H, left, bottom } = points;
  const grid = points.ticks.map((t) => [
    svg("line", { x1: left, x2: W, y1: t.y, y2: t.y, class: "grid-line" }),
    svg("text", { x: left - 6, y: t.y + 4, "text-anchor": "end", class: "axis" }, String(t.value)),
  ]);
  const dots = points.stories.length === 1
    ? [svg("circle", { class: "dot-stories", cx: points.stories[0].x, cy: points.stories[0].y, r: 3 }), svg("circle", { class: "dot-done", cx: points.done[0].x, cy: points.done[0].y, r: 3 })]
    : [];
  const labels = points.labels.map((l) => svg("text", { x: l.x, y: H - 6, "text-anchor": l.anchor, class: "axis" }, l.text));
  return h("div", {},
    h("div", { class: "chart epic-chart" },
      svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Stories in the epic and stories done, per day" },
        grid, svg("line", { x1: left, x2: W, y1: H - bottom, y2: H - bottom, class: "base-line" }),
        svg("path", { class: "line-stories", d: points.paths.stories }), svg("path", { class: "line-done", d: points.paths.done }), dots, labels)),
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "seg-stories" }), "Stories"), h("span", {}, h("i", { class: "seg-done" }), "Done")));
}

const section = (id, title, ...body) => h("section", { class: "card epic-section", "aria-labelledby": `epic-${id}` }, h("h2", { id: `epic-${id}` }, title), ...body);
const details = (summary, ...body) => h("details", {}, h("summary", {}, summary), ...body);

function finishSection(d, opts) {
  const fin = forecastView(d.epic, opts);
  const lines = historyLines(d.history, opts);
  const li = (l) => h("li", {}, h("strong", {}, l.text), l.range && !l.text.endsWith(`: ${l.range}`) ? ` (${l.range})` : "", l.change ? h("span", { class: "muted" }, ` — ${l.change}`) : null);
  const likely = fin.likely && fin.likely !== fin.text ? ` (most likely ${fin.likely})` : "";
  return section("finish", "Expected finish",
    h("p", {}, h("strong", {}, fin.text, likely)),
    fin.reason ? h("p", { class: "muted" }, fin.reason) : null,
    fin.leavesOut ? h("p", { class: "muted" }, fin.leavesOut) : null,
    fin.kind !== "finished" ? h("p", { class: "muted" }, CANNOT_KNOW) : null,
    h("h3", {}, "How it moved"),
    lines.length
      ? [h("ul", { class: "epic-history" }, lines.slice(0, HISTORY_SHOWN).map(li)),
        lines.length > HISTORY_SHOWN ? details(`Earlier (${lines.length - HISTORY_SHOWN})`, h("ul", { class: "epic-history" }, lines.slice(HISTORY_SHOWN).map(li))) : null]
      : h("p", { class: "muted" }, "No forecast saved yet. The first one is saved when the Epics page asks for this epic; earlier days are not filled in."));
}

function pathSection(d) {
  const v = criticalPathView(d.chains, d.stories);
  return section("path", "Critical path", h("p", {}, v.summary), v.path ? h("p", { class: "mono epic-path" }, v.path) : null, v.now ? h("p", {}, v.now) : null);
}

function storiesSection(d, repo) {
  const items = storyItems(d.stories, d.chains, repo);
  return section("stories", "Stories in build order",
    items.length
      ? h("ol", { class: "epic-stories" }, items.map((s) => h("li", {},
        s.href ? h("a", { href: s.href, target: "_blank", rel: "noopener" }, `#${s.issue} ${s.title}`) : `#${s.issue} ${s.title}`,
        h("span", { class: "epic-words" }, ` — ${s.words}`),
        s.status ? h("p", { class: "muted" }, s.status) : null,
        s.help ? h("p", { class: "muted" }, s.help) : null,
        s.notes.length ? h("p", { class: "muted" }, s.notes.join("; ")) : null)))
      : h("p", { class: "muted" }, "This epic has no stories yet."));
}

function chainsSection(d, repo) {
  if (!d.chains?.nodes?.length) return null;
  const by = new Map(d.stories.map((s) => [s.issue, s]));
  const notes = chainNotes(d.chains);
  return section("chains", "Dependency chains",
    h("p", { class: "muted" }, "Left to right is the build order. Each box links to its issue. Below 768 px the graph scrolls sideways."),
    chainGraph(d.chains, { hrefOf: (n) => (repo ? `https://github.com/${repo}/issues/${n}` : ""), wordsOf: (n) => by.get(n)?.words }),
    notes.length ? h("ul", {}, notes.map((n) => h("li", {}, n))) : null);
}

function chartSection(d, now) {
  const chart = epicChart(chartPoints(d.series, { now }));
  return section("chart", "Stories over time",
    chart ?? h("p", { class: "muted" }, "No history yet."),
    chart ? details("Show as table", table(["Day", "Stories", "Done"], chartRows(d.series, { now }).map((r) => tr(r.day, r.stories, r.done)), { class: "compact", label: "Stories and done stories per day" })) : null,
    h("p", { class: "muted" }, "The chart counts per UTC day."));
}

function paceSection(d) {
  const v = paceView(d.pace, d.medianStoryMs);
  return section("pace", "Pace",
    h("p", {}, v.perDay), h("p", {}, v.median),
    v.rows.length ? details("Show per day", table(["Period", "Finished"], v.rows.map((r) => tr(r.label, r.done)), { class: "compact", label: "Stories finished per day" })) : null);
}

/** Draws the page of one epic into `box`. Returns the cleanup function. */
export async function renderEpic(box, { id, admin = false, me, query = {}, a = api, timeZone = localZone(), now = () => new Date(), onName } = {}) {
  let closed = false;
  let seq = 0;
  let choices = null;
  let choice = null;
  let detail = null;
  let at = null;
  let notice = null;
  let title = "Epic";
  let bodyOf = () => loadingState("Loading the epic", { shape: "detail", rows: 6 });
  const wanted = typeof query.repo === "string" ? query.repo : "";

  const draw = () => {
    if (closed) return;
    const repo = choice?.name ?? wanted;
    const ok = detail?.epic;
    const when = now();
    const opts = { timeZone, now: when };
    const epic = ok ? detail.epic : null;
    mount(box, detailPage({
      title,
      back: { href: repo ? withQuery("#/epics", { repo }) : "#/epics", label: "Epics", focus: "back-epics" },
      actions: [
        detail && freshText(detail.data) ? h("p", { class: "muted epics-fresh" }, freshText(detail.data)) : null,
        detail ? staleNote(at) : null,
        h("button", { type: "button", class: "small", "data-focus": "refresh", onClick: () => void load() }, "↻ Refresh"),
      ],
      notices: notice,
      meta: epic ? [
        progressBar(epic.counts, epic.total), h("p", {}, progressText(epic.counts, epic.total)),
        growthSentence(epic) ? h("p", { class: "muted" }, growthSentence(epic)) : null,
        epic.issue != null && choice ? h("p", {}, h("a", { href: `https://github.com/${choice.name}/issues/${epic.issue}`, target: "_blank", rel: "noopener" }, "On GitHub")) : null,
      ] : null,
      sections: bodyOf(opts),
    }));
  };

  const gone = () => permissionState("This epic is not there, or you cannot see it.", { href: "#/epics", label: "Epics" });

  const load = async () => {
    const n = ++seq;
    if (!choices) {
      bodyOf = () => loadingState("Loading the epic", { shape: "detail", rows: 6 });
      draw();
      let rows;
      try {
        rows = await (admin ? a.allRepos() : a.repos());
      } catch (e) {
        if (closed || n !== seq) return;
        bodyOf = () => (e?.status === 403 ? gone() : errorState(explainError(e, { what: "Could not load your repositories." }), { onRetry: () => void load() }));
        draw();
        return;
      }
      if (closed || n !== seq) return;
      choices = repoChoices(rows, { admin, meId: me?.id });
    }
    const pick = pickRepo(choices, wanted);
    if (!pick.choice) {
      bodyOf = () => (pick.gone ? gone()
        : [emptyState("Open this epic from the Epics page, so the repository is known."), h("p", {}, h("a", { href: "#/epics" }, "Go to Epics"))]);
      draw();
      return;
    }
    choice = pick.choice;
    if (!detail) {
      bodyOf = () => loadingState("Loading the epic", { shape: "detail", rows: 6 });
      draw();
    }
    let got;
    try {
      got = await a.epic(choice.id, id);
    } catch (e) {
      if (closed || n !== seq) return;
      if (e?.status === 403 || e?.status === 404) {
        detail = null;
        notice = null;
        bodyOf = gone;
      } else if (detail) {
        notice = staleNote(at, { failed: true, onRetry: () => void load() });
      } else {
        bodyOf = () => errorState(explainError(e, { what: "Could not load the epic." }), { onRetry: () => void load() });
      }
      draw();
      return;
    }
    if (closed || n !== seq) return;
    detail = got;
    at = Date.now();
    notice = null;
    const repo = choice.name;
    if (got.data?.state === "no-data") {
      bodyOf = () => emptyState(got.data.text);
    } else if (!got.epic) {
      bodyOf = gone;
    } else {
      const e = got.epic;
      title = e.issue != null ? `#${e.issue} ${e.title}` : e.title;
      onName?.(title);
      bodyOf = (opts) => [finishSection(got, opts), pathSection(got), storiesSection(got, repo), chainsSection(got, repo), chartSection(got, opts.now), paceSection(got)];
    }
    draw();
  };

  draw();
  await load();
  return () => {
    closed = true;
  };
}
