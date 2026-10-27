// The Context sources section of a run page. It draws the answer of GET /api/runs/:id/context (see
// src/server/context-view.ts) and decides nothing: the server has already filtered it for the role. Every value goes in
// as text, never as HTML. A user's display shows no address, id or folder even if the view has one.
// Relative imports, so a test can load it.
import { h, mount } from "./dom.js";
import { errorState, explainError } from "./states.js";
import { saveFile } from "./run-evidence.js";
import { timeText } from "./run-tabs.js";

export const SOURCES_TITLE = "Context sources";
export const NO_BUNDLE = "This run has no context bundle.";
export const NO_SOURCES = "No sources were given to this run.";
export const NO_OMITTED = "Nothing was left out.";
export const SELECTION_LABELS = {
  task: "the task",
  instructions: "instructions for agents",
  ownership: "ownership",
  "api-schema": "an interface description",
  discovery: "a discovery rule",
  refinement: "the refinement",
};
export const CLASSIFICATION_LABELS = { public: "Public", internal: "Internal", confidential: "Confidential", restricted: "Restricted" };
export const FRESHNESS_LABELS = { fresh: "Fresh", stale: "Stale" };

const list = (v) => (Array.isArray(v) ? v : []);
const safeName = (id) => String(id ?? "").replace(/[^\w-]/g, "_");
const short = (c) => String(c ?? "").slice(0, 7);
const at = (t) => timeText(t) || String(t ?? "");

function pickedFor(sel) {
  const reason = SELECTION_LABELS[sel?.reason] ?? String(sel?.reason ?? "");
  return sel?.rule ? `${reason} (rule ${sel.rule})` : reason;
}

function sourceModel(x, admin) {
  const lines = [`Picked for: ${pickedFor(x.selection)}`];
  const rev = x.revision;
  if (rev?.commit) lines.push(`Commit ${short(rev.commit)}`);
  else if (rev?.version) lines.push(`Version ${rev.version}`);
  lines.push(`Read ${at(x.retrievedAt)} · ${FRESHNESS_LABELS[x.freshness] ?? String(x.freshness ?? "")}`);
  lines.push(`Classification: ${CLASSIFICATION_LABELS[x.classification] ?? String(x.classification ?? "")}`);
  if (Array.isArray(x.owners) && x.owners.length) lines.push(`Owners: ${x.owners.join(", ")}`);
  if (x.sha256) lines.push(`SHA-256 ${x.sha256}`);
  if (typeof x.bytes === "number") lines.push(`${x.bytes} bytes`);
  if (admin && x.uri) lines.push(`Address: ${x.uri}${x.id ? ` (${x.id})` : ""}`);
  const out = { head: String(x.label ?? ""), lines };
  if (x.freshness === "stale" && x.next) out.next = `What to do: ${x.next}`;
  return out;
}

function omittedModel(x, admin) {
  const lines = [`Would have been picked for: ${pickedFor(x.selection)}`];
  if (admin && x.uri) lines.push(`Address: ${x.uri}${x.id ? ` (${x.id})` : ""}`);
  return { head: String(x.label ?? ""), status: String(x.statusLabel ?? x.status ?? ""), next: `What to do: ${x.next ?? ""}`, lines };
}

/**
 * Pure. view: the answer of GET /api/runs/:id/context (or undefined). A user never gets an address, an id or a detail,
 * even if the view has them.
 */
export function contextSourcesModel(view, { admin = false } = {}) {
  const state = view?.state === "available" || view?.state === "unreadable" ? view.state : "absent";
  const model = { state, text: "", rows: [], sources: [], omitted: [] };
  if (state === "absent") {
    model.text = NO_BUNDLE;
    return model;
  }
  if (state === "unreadable") {
    const p = view?.problem ?? {};
    model.text = [String(p.reason ?? "This run's context bundle cannot be read."), admin && p.detail ? String(p.detail) : ""].filter(Boolean).join(" ");
    return model;
  }
  const rows = model.rows;
  const row = (label, value) => value && rows.push({ label, value: String(value) });
  row("Bundle", view.sha256);
  row("Sources hash", view.sourcesSha256);
  row("Made", view.createdAt ? at(view.createdAt) : "");
  const repo = view.repository;
  row("Commit", repo?.commit ? `${repo.repository ? `${repo.repository} at ` : ""}${short(repo.commit)}` : "");
  const b = view.budget;
  row("Limits", b ? `${b.maxSources} sources, ${b.maxSourceBytes} bytes each, ${b.maxTotalBytes} bytes together` : "");
  model.sources = list(view.sources).map((x) => sourceModel(x ?? {}, admin));
  model.omitted = list(view.omitted).map((x) => omittedModel(x ?? {}, admin));
  return model;
}

/** The file of Export context: exactly the API answer, pretty-printed. */
export function contextExport(view, runId) {
  return { name: `context-${safeName(runId)}.json`, text: `${JSON.stringify(view, null, 2)}\n` };
}

let counter = 0;

function sourceNode(x) {
  return h("li", { class: "wrap-anywhere" }, h("b", {}, x.head), x.lines.map((l) => [h("br"), l]), x.next ? [h("br"), x.next] : null);
}

function omittedNode(x) {
  return h("li", { class: "wrap-anywhere" }, h("b", {}, x.head), " — ", x.status, x.lines.map((l) => [h("br"), l]), h("br"), x.next);
}

/**
 * The section placed by evidencePanel({ sources }). load: () => Promise<view>. It loads when built, on Check again, and
 * when the run finishes. While the last answer was "absent" it also loads when the run gets a new step (the bundle is
 * written before the first agent step).
 */
export function contextSourcesSection({ load, admin = false, runId, save = saveFile }) {
  const uid = `cs${++counter}`;
  const body = h("div");
  const alertEl = h("p", { class: "status bad", role: "alert" });
  const refresh = h("button", { type: "button", "data-focus": "sources-refresh", onClick: () => reload().catch(() => {}) }, "Check again");
  const exportBtn = h("button", { type: "button", "data-focus": "sources-export", onClick: () => doExport().catch(() => {}) }, "Export context");
  let seq = 0;
  let view;
  let loaded = false;
  let bodyKey = null;

  function draw(error) {
    const m = contextSourcesModel(view, { admin });
    const key = error ? `error:${error.what}` : loaded ? JSON.stringify(m) : "loading";
    if (key === bodyKey) return;
    bodyKey = key;
    if (error) mount(body, errorState(error, { onRetry: () => reload().catch(() => {}), focus: "sources-retry" }));
    else if (!loaded) mount(body, h("p", { class: "muted" }, "Loading the context sources…"));
    else if (m.state !== "available") mount(body, h("p", { class: "muted" }, m.text));
    else {
      mount(body, [
        h("dl", { class: "meta" }, m.rows.map((r) => [h("dt", {}, r.label), h("dd", { class: "wrap-anywhere" }, r.value)])),
        h("h4", {}, "Sources"),
        m.sources.length ? h("ul", { class: "flush" }, m.sources.map(sourceNode)) : h("p", { class: "muted" }, NO_SOURCES),
        h("h4", {}, "Left out"),
        m.omitted.length ? h("ul", { class: "flush" }, m.omitted.map(omittedNode)) : h("p", { class: "muted" }, NO_OMITTED),
      ]);
    }
  }

  async function reload() {
    const mine = ++seq;
    refresh.disabled = true;
    try {
      const v = await load();
      if (mine !== seq) return;
      view = v;
      loaded = true;
      refresh.disabled = false;
      draw();
    } catch (e) {
      if (mine !== seq) return;
      loaded = false;
      view = undefined;
      refresh.disabled = false;
      draw(explainError(e, { what: "Could not load the context sources." }));
    }
  }

  async function doExport() {
    exportBtn.disabled = true;
    try {
      const f = contextExport(await load(), runId);
      save(f.name, f.text);
      alertEl.textContent = "";
    } catch (e) {
      alertEl.textContent = explainError(e, { what: "Could not export the context." }).what;
    } finally {
      exportBtn.disabled = false;
    }
  }

  return {
    build() {
      draw();
      reload().catch(() => {});
      return h("section", { class: "mb-16", "aria-labelledby": `${uid}-h` },
        h("h3", { id: `${uid}-h` }, SOURCES_TITLE), body, h("div", { class: "row" }, refresh, exportBtn), alertEl);
    },
    update(s, prev) {
      if (!prev) return;
      const finished = s?.finishedAt && prev.finishedAt !== s.finishedAt;
      const stepped = loaded && view?.state === "absent" && list(s?.history).length !== list(prev.history).length;
      if (finished || stepped) reload().catch(() => {});
    },
  };
}
