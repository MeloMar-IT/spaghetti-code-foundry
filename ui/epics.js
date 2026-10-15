import { api } from "./api.js";
import { h, mount, svg, table } from "./dom.js";
import { ALL_REPOS } from "./ia.js";
import { defaultGo, filterGone, withQuery } from "./filters.js";
import { barSegments, finishView, freshText, growthSentence, blockTexts, pickRepo, progressText, repoChoices, sortRows } from "./epics-model.js";
import { emptyState, errorState, explainError, loadingState, permissionState, staleNote } from "./states.js";
import { collectionPage } from "./templates.js";
import { pageViews } from "./views.js";

// The Epics page: one row per epic of one repository, from GET /api/repos/:id/epics. The server decides the numbers, the
// forecast and the words; ui/epics-model.js only joins them with dates and sorts. The pure parts are tested there.

const HEADERS = ["Epic", "Progress", "Grew", "Expected finish", "Held up by"];
const BAR_HEIGHT = 8;

/** The bar: one rect per non-zero state, for the eye only (the text next to it says the same). */
export function progressBar(counts, total) {
  return svg("svg", { class: "epics-bar", viewBox: `0 0 100 ${BAR_HEIGHT}`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" },
    barSegments(counts, total).map((s) => svg("rect", { class: `epics-seg-${s.id}`, x: s.x, y: 0, width: s.width, height: BAR_HEIGHT })));
}

const muted = (text) => (text ? h("p", { class: "muted" }, text) : null);

/** One row of the table. `row` is an epic of the answer, or the "No epic" row with `noEpic: true`. */
export function epicRow(row, { repo, timeZone, now = new Date() } = {}) {
  const opts = { timeZone, now };
  const fin = finishView(row, opts);
  const blocks = blockTexts(row.holdUps);
  const name = row.issue != null && repo
    ? h("a", { href: `https://github.com/${repo}/issues/${row.issue}`, target: "_blank", rel: "noopener" }, `#${row.issue} ${row.title}`)
    : row.title;
  const likely = fin.likely && fin.likely !== fin.text ? ` (most likely ${fin.likely})` : "";
  const heldCell = fin.kind === "finished" ? "—"
    : blocks.length ? h("ul", { class: "epics-holds" }, blocks.map((u) => h("li", { "data-kind": u.kind }, u.text, muted(u.help))))
      : "Nothing";
  return h("tr", {},
    h("td", {}, h("strong", {}, name)),
    h("td", {}, progressBar(row.counts, row.total), h("p", {}, progressText(row.counts, row.total))),
    h("td", {}, row.noEpic ? "—" : growthSentence(row) || "—"),
    h("td", {}, row.noEpic ? "—" : [h("strong", {}, fin.text, likely), muted(fin.reason), muted(fin.note)]),
    h("td", {}, row.noEpic && !blocks.length ? "Nothing" : heldCell));
}

/** The table of an answer: the epics in order, "No epic" last. */
export function epicsTable(list, { timeZone, now = new Date() } = {}) {
  const rows = sortRows(list.epics ?? []).map((r) => epicRow(r, { repo: list.repo, timeZone, now }));
  if (list.noEpic) rows.push(epicRow({ ...list.noEpic, noEpic: true }, { repo: list.repo, timeZone, now }));
  return table(HEADERS, rows, { cards: true, caption: `Epics of ${list.repo}`, class: "epics-table" });
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Draws the page into `box`. Returns the cleanup function. */
export async function renderEpics(box, { admin = false, me, readOnly = false, query = {}, go = defaultGo, a = api, timeZone = localZone(), now = () => new Date(), views = pageViews("epics") } = {}) {
  let closed = false;
  let seq = 0;
  let want = typeof query.repo === "string" ? query.repo : "";
  let choices = null;
  let choice = null; // the repository the rows below belong to
  let list = null; // the last good answer for `choice`; never kept across a change of repository
  let at = null;
  let notice = null;
  let bodyOf = () => loadingState("Loading epics", { shape: "table", rows: 4 });

  const filtersOf = () => (choice ? { repo: choice.name } : want ? { repo: want } : {});
  const setRepo = (value) => {
    want = value;
    choice = null;
    list = null;
    notice = null;
    go(withQuery("#/epics", { repo: value || ALL_REPOS }));
    void load();
  };
  const clearView = () => setRepo("");

  const draw = () => {
    if (closed) return;
    const vp = views?.parts(filtersOf(), { redraw: draw }) ?? {};
    const fresh = list ? freshText(list.data) : "";
    const picker = choices?.length
      ? h("select", { "aria-label": "Repository", "data-focus": "epics-repo", onChange: (e) => setRepo(e.target.value) },
        h("option", { value: "" }, "Choose a repository"),
        choices.map((c) => h("option", { value: c.name, selected: choice?.name === c.name }, c.name)))
      : null;
    mount(box, collectionPage({
      title: "Epics",
      actions: [
        fresh ? h("p", { class: "muted epics-fresh" }, fresh) : null,
        list ? staleNote(at) : null,
        views && !readOnly && choice ? h("button", { type: "button", class: "small", "data-focus": "save-view", onClick: () => vp.onSave?.() }, "Save view") : null,
        h("button", { type: "button", class: "small", "data-focus": "refresh", onClick: () => void load() }, "↻ Refresh"),
      ],
      notices: notice,
      filters: [vp.row, picker],
      list: bodyOf(vp),
    }));
  };

  const permission = () => permissionState("You cannot see the epics of this repository.", admin ? { href: "#/all-repos", label: "All repositories" } : { href: "#/repos", label: "My repositories" });

  const load = async () => {
    const n = ++seq;
    if (!choices) {
      bodyOf = () => loadingState("Loading epics", { shape: "table", rows: 4 });
      draw();
      let rows;
      try {
        rows = await (admin ? a.allRepos() : a.repos());
      } catch (e) {
        if (closed || n !== seq) return;
        bodyOf = () => (e?.status === 403
          ? permission()
          : errorState(explainError(e, { what: "Could not load your repositories." }), { onRetry: () => void load() }));
        draw();
        return;
      }
      if (closed || n !== seq) return;
      choices = repoChoices(rows, { admin, meId: me?.id });
    }
    const pick = pickRepo(choices, want);
    if (!pick.choice) {
      choice = null;
      list = null;
      notice = null;
      bodyOf = (vp) => (pick.gone ? filterGone({ onClear: clearView, onDelete: vp?.onDelete })
        : emptyState(choices.length ? "Choose a repository to see its epics." : "You have no repositories yet. Add one under My repositories."));
      draw();
      return;
    }
    if (choice?.id !== pick.choice.id) {
      choice = pick.choice;
      list = null;
      notice = null;
    }
    const mine = choice;
    if (!list) {
      bodyOf = () => loadingState("Loading epics", { shape: "table", rows: 4 });
      draw();
    }
    let got;
    try {
      got = await a.epics(mine.id);
    } catch (e) {
      if (closed || n !== seq) return;
      if (e?.status === 403 || e?.status === 404) {
        list = null;
        notice = null;
        bodyOf = permission;
      } else if (list) {
        notice = staleNote(at, { failed: true, onRetry: () => void load() });
      } else {
        bodyOf = () => errorState(explainError(e, { what: "Could not load the epics." }), { onRetry: () => void load() });
      }
      draw();
      return;
    }
    if (closed || n !== seq) return;
    list = got;
    at = Date.now();
    notice = null;
    bodyOf = () => {
      if (got.data?.state === "no-data") return emptyState(got.data.text);
      if (!got.epics?.length && !got.noEpic) return emptyState("No epics yet in this repository.");
      return epicsTable(got, { timeZone, now: now() });
    };
    draw();
  };

  draw();
  await load();
  return () => {
    closed = true;
  };
}
