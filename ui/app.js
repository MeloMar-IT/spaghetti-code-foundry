import YAML from "/vendor/yaml/index.js";
import { api } from "./api.js";
import { flowNameMark } from "./icons.js";
import { enterDisplay, linkToken } from "./auth.js";
import { confirmDialog, debounce, h, modal, mount, toast } from "./dom.js";
import { cleanFlow, renderEditor } from "./editor.js";
import { resolve, splitHash } from "./ia.js";
import { initShell, showPage } from "./shell.js";
import { emptyState, errorState, explainError, loadingState, permissionState, staleNote } from "./states.js";
import { renderGraph } from "./graph.js";
import { insertBlock, pickBlock, renderLibrary, saveStepAsBlock } from "./library.js";
import { renderSettings, renderWatchers } from "./admin.js";
import { renderMaintenance } from "./maintenance.js";
import { refreshModelLists, renderModels } from "./models.js";
import { renderDashboard } from "./dashboard.js";
import { renderProblems } from "./problems.js";
import { renderRunDetail, renderRunsList } from "./runs.js";
import { renderAllRepos } from "./admin-repos.js";
import { renderCredentials } from "./admin-credentials.js";
import { renderRefinement } from "./refinement.js";
import { renderRepos } from "./repos.js";
import { renderUsers } from "./users.js";
import { renderStart } from "./user/start.js";
import { renderAudit } from "./audit.js";
import { renderBoard } from "./board.js";
import { renderWork } from "./work.js";
import { loadHealth, startHealth } from "./health.js";
import { startSince } from "./since.js";
import { renderAdminHome } from "./home-admin.js";
import { startBadge, startHash } from "./turn.js";

const sidebar = document.getElementById("sidebar");
const main = document.getElementById("main");
const healthEl = document.getElementById("health");
const NAME_RE = /^[\w-]+$/;

const BLANK = `name: my-flow
description: Describe what this flow does
workspace: worktree
defaults:
  model: sonnet
  allowed_tools: [Read, Edit, Write, Glob, Grep]
vars:
  test_cmd: npm test
steps:
  - id: implement
    type: claude
    prompt: "{{task}}"
  - id: test
    type: shell
    run: "{{vars.test_cmd}}"
`;

/**
 * cur: the flow being edited.
 * { name: saved name | null, scope, saveScope, yaml, obj, mode: "visual"|"yaml", dirty, selected, validation }
 */
const S = { info: null, flows: [], flowsLoaded: false, cur: null, cleanup: null, lastHash: "", me: "" };
// The flow list in the sidebar: "loading" | "ready" | "error". An error with `flowsLoaded` keeps the old entries (stale).
const L = { state: "loading", error: null, at: 0, gen: 0 };

function tryParse(text) {
  try {
    const v = YAML.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ── sidebar ──

/** Loads the flow list. Never throws. A newer call wins: an older answer (or failure) is dropped. True when the list is fresh. */
async function refreshFlows() {
  const mine = ++L.gen;
  if (!S.flowsLoaded) {
    L.state = "loading";
    renderSidebar();
  }
  try {
    const list = await api.flows();
    if (mine !== L.gen) return L.state === "ready";
    S.flows = list;
    S.flowsLoaded = true;
    L.state = "ready";
    L.error = null;
    L.at = Date.now();
    // Names for the sub-flow picker in the editor.
    let dl = document.getElementById("flow-names");
    if (!dl) document.body.append((dl = h("datalist", { id: "flow-names" })));
    mount(dl, S.flows.map((f) => h("option", { value: f.name })));
  } catch (e) {
    if (mine !== L.gen) return L.state === "ready";
    L.state = "error";
    L.error = e;
  }
  renderSidebar();
  return L.state === "ready";
}

async function newBlank() {
  if (await confirmDiscard()) openNew();
}

function sidebarList(current) {
  if (!S.flowsLoaded) {
    if (L.state === "loading") return loadingState("Loading flows…", { rows: 4 });
    if (Number(L.error?.status) === 403) return permissionState("You may not see the list of flows.");
    return errorState(explainError(L.error, { what: "The flows could not be loaded." }), { onRetry: refreshFlows });
  }
  const unsaved = current && !current.name;
  return [
    h("ul", { class: "flow-list" },
      unsaved ? h("li", {}, h("a", { href: "#/new", class: "active" }, h("span", { class: "n" }, current.obj?.name ?? "new flow", h("span", { class: "pill claude" }, "unsaved")))) : null,
      S.flows.map((f) => h("li", { class: f.error ? "bad" : null },
        h("a", { href: `#/flows/${f.name}`, class: current?.name === f.name ? "active" : null },
          h("span", { class: "n" }, h("span", {}, flowNameMark(f), current?.name === f.name && current.dirty ? " •" : ""), f.published ? h("span", { class: "pill ok" }, "published") : null, h("span", { class: "pill" }, f.scope)),
          h("span", { class: "d" }, f.error ? "invalid flow" : f.description ?? ""))))),
    !S.flows.length && !unsaved ? emptyState("No flows yet.") : null,
    L.state === "error" ? staleNote(L.at, { failed: true, onRetry: refreshFlows }) : null,
  ];
}

function renderSidebar() {
  const inFlows = splitHash(location.hash).path.startsWith("#/flows/") || splitHash(location.hash).path === "#/new";
  const current = inFlows ? S.cur : null;
  mount(sidebar,
    h("div", { class: "side-actions" },
      h("button", { class: "primary", onClick: () => generateDialog(false) }, "✨ Draft flow with Claude"),
      h("button", { onClick: newBlank }, "+ Blank flow")),
    h("h3", {}, "Flows"),
    sidebarList(current));
}

// A dialog is open when the modal root has content. The router leaves the page alone then, so no dialog is replaced or bypassed.
const dialogOpen = () => document.getElementById("modal-root").children.length > 0;

/** Asks before a draft is thrown away. True when there is nothing to lose or the person agrees; false when another dialog is open. */
async function confirmDiscard() {
  if (!S.cur?.dirty) return true;
  if (dialogOpen()) return false;
  return confirmDialog({ title: "Discard unsaved changes?", text: `Discard unsaved changes to "${S.cur.obj?.name ?? "new flow"}"?`, confirm: "Discard" });
}

// ── flow view ──

function flowOpenError(e, name, retry) {
  const back = { href: "#/flows", label: "Back to flows" };
  const status = Number(e?.status);
  if (status === 403) return permissionState("You may not open this flow.", back);
  if (status === 404) {
    const missing = explainError(e, { what: `There is no flow named "${name}".` });
    return errorState(missing, { back });
  }
  const info = explainError(e, { what: `The flow "${name}" could not be opened.` });
  return errorState(info, { onRetry: retry, back });
}

/** `mine` is the router's generation: an answer that comes after the person went elsewhere draws nothing. */
async function openFlow(name, mine = routeGen) {
  if (S.cur?.name === name) return renderFlowView(); // keep in-memory edits
  mount(main, loadingState("Loading flow…", { shape: "detail" }));
  let f;
  try {
    f = await api.flow(name);
  } catch (e) {
    if (mine !== routeGen) return;
    mount(main, flowOpenError(e, name, () => openFlow(name, ++routeGen)));
    return;
  }
  if (mine !== routeGen) return;
  const obj = tryParse(f.yaml);
  S.cur = {
    name: f.name, scope: f.scope, saveScope: f.scope === "builtin" ? "repo" : f.scope,
    yaml: f.yaml, obj, mode: obj ? "visual" : "yaml", dirty: false, selected: null, validation: null,
  };
  renderFlowView();
}

function openNew(yaml = BLANK) {
  S.cur = { name: null, scope: null, saveScope: "repo", yaml, obj: tryParse(yaml), mode: "visual", dirty: true, selected: null, validation: null };
  if (!S.cur.obj) S.cur.mode = "yaml";
  history.pushState(null, "", "#/new");
  S.lastHash = "#/new";
  loadHealth(healthEl); // pushState fires no hashchange
  renderFlowView();
}

let ui = {};

function renderFlowView() {
  const c = S.cur;
  renderSidebar();
  ui = { bar: h("div"), errors: h("div"), failure: h("div"), body: h("div"), graph: h("div") };
  mount(main,
    ui.bar,
    c.scope === "builtin" ? h("p", { class: "muted mt-neg-6" }, "Built-in flow — saving creates your own copy that overrides it.") : null,
    ui.errors,
    ui.failure,
    h("div", { class: "editor" }, ui.body, h("div", { class: "graph-pane" }, h("h3", { class: "mb-8" }, "Flow"), ui.graph)));
  drawToolbar();
  drawBody();
  drawGraph();
  validate();
}

/** The toolbar draws on its own, so a save can update the name and the dirty dot without touching the editor. */
function drawToolbar() {
  const c = S.cur;
  ui.title = h("h1", {}, c.obj?.name ?? c.name ?? "flow");
  ui.dirty = h("span", { class: c.dirty ? "dirty-dot" : "dirty-dot clean", title: "Unsaved changes" });
  ui.status = h("span", { class: "status" });
  ui.save = h("button", { onClick: () => save(), title: "⌘S" }, "Save");
  ui.save.disabled = !!c.saving;
  ui.del = c.name && c.scope !== "builtin" ? h("button", { class: "icon", title: "Delete flow", "aria-label": "Delete flow", onClick: () => remove() }, "🗑") : null;
  if (ui.del) ui.del.disabled = !!c.deleting;
  if (c.validation) setStatus(c.validation);
  const seg = (mode, label) => h("button", { class: c.mode === mode ? "on" : null, onClick: () => setMode(mode) }, label);
  const scopeSel = h("select", { class: "fit", title: "Where to save", onChange: (e) => (c.saveScope = e.target.value) },
    h("option", { value: "repo", selected: c.saveScope === "repo" }, "this repo"),
    h("option", { value: "global", selected: c.saveScope === "global" }, "global"));
  mount(ui.bar, h("div", { class: "toolbar" },
    ui.title, ui.dirty,
    h("span", { class: `pill ${c.name ? "" : "claude"}` }, c.name ? c.scope : "unsaved"),
    h("span", { class: "seg" }, seg("visual", "Visual"), seg("yaml", "YAML")),
    ui.status,
    h("span", { class: "spacer" }),
    h("button", { onClick: () => generateDialog(true), title: "Describe a change and let Claude edit this flow" }, "✨ Ask Claude"),
    h("span", { class: "muted text-xs" }, "save to"), scopeSel,
    ui.save,
    h("button", { class: "primary", onClick: () => runDialog() }, "▶ Run"),
    ui.del));
}

function setStatus(r) {
  ui.status.className = `status ${r.ok ? "ok" : "bad"}`;
  ui.status.textContent = r.ok ? "valid" : "invalid";
}

function drawBody() {
  const c = S.cur;
  if (c.mode === "yaml") {
    mount(ui.body, h("textarea", {
      class: "yaml-editor", spellcheck: "false", value: c.yaml,
      onInput: (e) => {
        c.yaml = e.target.value;
        const obj = tryParse(c.yaml);
        if (obj) c.obj = obj;
        changed();
      },
      onKeydown: (e) => {
        if (e.key !== "Tab") return;
        e.preventDefault();
        document.execCommand("insertText", false, "  ");
      },
    }));
    return;
  }
  const lostComments = /^\s*#/m.test(c.yaml);
  mount(ui.body,
    lostComments ? h("p", { class: "muted mt-0" }, "Note: visual edits rewrite the YAML and drop its comments.") : null,
    renderEditor(c.obj, {
      selected: c.selected,
      onChange: () => {
        c.yaml = YAML.stringify(cleanFlow(c.obj), { lineWidth: 0 });
        changed();
      },
      rerender: () => {
        c.yaml = YAML.stringify(cleanFlow(c.obj), { lineWidth: 0 });
        drawBody();
        changed();
      },
      onSelect: (i, scroll = true) => select(i, scroll),
      onLibrary: async (at) => {
        const picked = await pickBlock().catch((e) => toast(e.message, "error"));
        if (!picked?.block) return;
        const { count, renamed } = insertBlock(c.obj, picked.block, at);
        c.selected = at;
        c.yaml = YAML.stringify(cleanFlow(c.obj), { lineWidth: 0 });
        drawBody();
        changed();
        toast(`Inserted “${picked.block.name}” (${count} step${count > 1 ? "s" : ""})` +
          (renamed.length ? ` — renamed ${renamed.map(([a, b]) => `${a}→${b}`).join(", ")}` : ""));
      },
      onSaveBlock: (step) => saveStepAsBlock(c.obj, step).catch((e) => toast(e.message, "error")),
    }));
}

function drawGraph() {
  mount(ui.graph, renderGraph(S.cur.obj, { selected: S.cur.selected, onSelect: (i) => select(i, true) }));
}

function select(i, scroll) {
  S.cur.selected = i;
  document.querySelectorAll(".card[id^='step-']").forEach((el) => el.classList.toggle("selected", el.id === `step-${i}`));
  drawGraph();
  if (scroll && S.cur.mode === "visual") document.getElementById(`step-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

function setMode(mode) {
  const c = S.cur;
  if (mode === c.mode) return;
  if (mode === "visual") {
    const obj = tryParse(c.yaml);
    if (!obj) return toast("Fix the YAML syntax before switching to the visual editor", "error");
    c.obj = obj;
  }
  c.mode = mode;
  renderFlowView();
}

function changed() {
  S.cur.dirty = true;
  ui.dirty.classList.toggle("clean", !S.cur.dirty);
  ui.title.textContent = S.cur.obj?.name ?? "flow";
  drawGraph();
  validateSoon();
}

/**
 * Checks the YAML as it is now. Returns `{ r, yaml }` for that exact text; null when the flow is gone or the text changed meanwhile (the answer is stale).
 * `lead`: an explicit check (Save, Run) — its answer carries the lead line and takes the focus. An older answer never draws over a newer one.
 */
async function validate(lead) {
  const c = S.cur;
  if (!c) return null;
  const yaml = c.yaml;
  const seq = (c.vseq = (c.vseq ?? 0) + 1);
  const r = await api.validate(yaml).catch((e) => ({ ok: false, error: e.message }));
  if (c !== S.cur || yaml !== c.yaml) return null;
  if (seq < (c.drawn ?? 0)) return { r, yaml, c };
  c.drawn = seq;
  c.validation = r;
  setStatus(r);
  if (r.ok) mount(ui.errors, null);
  else drawErrors(c, yaml, lead, r.error);
  return { r, yaml, c };
}
const validateSoon = debounce(() => S.cur && validate(), 300);

/** The errors box above the editor: an optional lead line and the text. Draws only when `yaml` is still the text of `c`. */
function drawErrors(c, yaml, lead, text) {
  if (c !== S.cur || yaml !== c.yaml) return;
  c.drawn = Math.max(c.drawn ?? 0, c.vseq ?? 0);
  mount(ui.errors, h("div", { class: "errors", role: "alert" }, lead ? h("p", { class: "flush" }, lead) : null, String(text ?? "").replace(/^<flow>: /, "")));
  if (lead) pointAtErrors();
}

function pointAtErrors() {
  const box = ui.errors.children[0];
  if (!box) return;
  box.setAttribute("tabindex", "-1");
  box.focus();
}

/** An inline explanation of a failed action, with Retry. A flow that is not on the page (another page keeps the draft in memory) gets a toast instead. */
function showFailure(c, info, retry) {
  if (c !== S.cur || !main.contains(ui.failure)) return toast(info.what, "error");
  mount(ui.failure, errorState(info, { onRetry: retry }));
}

async function save() {
  const c = S.cur;
  if (!c || c.saving) return;
  c.saving = true;
  const btn = ui.save;
  btn.disabled = true;
  try {
    await doSave(c);
  } finally {
    c.saving = false;
    btn.disabled = false;
    if (c === S.cur && ui.save) ui.save.disabled = false;
  }
}

async function doSave(c) {
  mount(ui.failure, null);
  const scope = c.saveScope;
  const old = { name: c.name, scope: c.scope };
  const v = await validate("Fix these errors before saving.");
  if (!v || !v.r.ok) return;
  const { yaml } = v;
  const name = tryParse(yaml)?.name;
  if (!NAME_RE.test(name ?? "")) return drawErrors(c, yaml, "Fix these errors before saving.", "Flow name may only contain letters, digits, _ and -");
  if (name !== old.name) {
    // Nothing on the server stops a save over another flow, so the list is loaded again before the question is asked.
    if (!(await refreshFlows())) {
      return showFailure(c, explainError(L.error, { what: "The flow was not saved. The list of flows could not be checked for a flow with this name.", safe: "Your changes are still here, marked as unsaved." }), () => save());
    }
    const exists = S.flows.find((f) => f.name === name);
    if (exists && exists.scope !== "builtin" && !(await askOverwrite(name))) return;
  }
  let saved;
  try {
    saved = await api.saveFlow(name, yaml, scope);
  } catch (e) {
    return showFailure(c, explainError(e, { what: `The flow "${name}" was not saved.`, safe: "Your changes are still here, marked as unsaved." }), () => save());
  }
  const untouched = c === S.cur && c.yaml === yaml; // no edit while the request ran
  if (untouched && saved?.yaml && saved.yaml !== yaml) {
    c.yaml = saved.yaml;
    c.obj = tryParse(saved.yaml) ?? c.obj;
  }
  const here = splitHash(location.hash).path;
  const viewing = c === S.cur && here === (old.name ? `#/flows/${old.name}` : "#/new");
  // Commit the save first: what the person does during the cleanup below must not be undone by it.
  if (c.name !== name || c.scope !== scope) Object.assign(c, { name, scope });
  if (untouched) c.dirty = false;
  if (viewing) {
    history.replaceState(null, "", `#/flows/${name}`);
    S.lastHash = location.hash;
    mount(ui.failure, null);
    drawToolbar();
    if (untouched && saved?.yaml) {
      drawBody();
      drawGraph();
    }
  }
  let leftover = null;
  if (old.name && old.name !== name && old.scope !== "builtin") leftover = await removeOld(old.name); // rename
  await refreshFlows();
  toast(saved?.version ? `Saved ${name} — version ${saved.version} for users` : `Saved ${name}`);
  if (leftover) showRemoveOld(c, old.name, leftover);
}

const askOverwrite = (name) => confirmDialog({ title: "Overwrite flow?", text: `A flow named "${name}" already exists. Overwrite it?`, confirm: "Overwrite" });

/** Removes the file of the old name after a rename. Returns the error, or null. Never throws. */
async function removeOld(old) {
  try {
    await api.deleteFlow(old);
    return null;
  } catch (e) {
    return e;
  }
}

function showRemoveOld(c, old, e) {
  let busy = false;
  const retry = async () => {
    if (busy) return;
    busy = true;
    const again = await removeOld(old);
    busy = false;
    if (again) return showRemoveOld(c, old, again);
    if (c === S.cur) mount(ui.failure, null);
    await refreshFlows();
  };
  showFailure(c, explainError(e, { what: `The old flow "${old}" could not be removed.`, safe: "The flow is saved under the new name." }), retry);
}

async function remove() {
  const c = S.cur;
  if (!c?.name || c.deleting) return;
  const text = `Delete flow "${c.name}"? This removes the file.${c.dirty ? " Your unsaved changes will be lost." : ""}`;
  if (dialogOpen() || !(await confirmDialog({ title: "Delete flow?", text, confirm: "Delete" }))) return;
  await doRemove(c);
}

async function doRemove(c) {
  if (c.deleting) return;
  c.deleting = true;
  if (c === S.cur && ui.del) ui.del.disabled = true;
  const name = c.name;
  const yaml0 = c.yaml;
  try {
    await api.deleteFlow(name);
  } catch (e) {
    c.deleting = false;
    if (c === S.cur && ui.del) ui.del.disabled = false;
    return showFailure(c, explainError(e, { what: `The flow "${name}" was not deleted.`, safe: "The flow is still there." }), () => doRemove(c));
  }
  c.deleting = false;
  toast(`Deleted ${name}`);
  if (S.cur !== c) return void refreshFlows(); // another flow is open now: leave it alone
  const viewing = splitHash(location.hash).path === `#/flows/${name}`;
  if (c.yaml !== yaml0) {
    // Typed while the request ran: the file is gone, the text is not. It stays as a new unsaved draft.
    Object.assign(c, { name: null, scope: null, saveScope: c.saveScope === "global" ? "global" : "repo", dirty: true });
    if (viewing) {
      history.replaceState(null, "", "#/new");
      S.lastHash = location.hash;
      mount(ui.failure, null);
      drawToolbar();
    }
    await refreshFlows();
    return;
  }
  S.cur = null;
  await refreshFlows();
  // Only the page that showed the flow goes to the list; another page stays where it is.
  if (!S.cur && viewing) location.hash = "#/flows";
}

// ── dialogs ──

async function runDialog() {
  const c = S.cur;
  if (!c || dialogOpen()) return;
  const v = await validate("Fix these errors before running.");
  if (!v || c !== S.cur || !v.r.ok) return;
  const { yaml } = v;
  const flow = v.r.flow;
  let starting = false;
  const runId = await modal(`Run ${flow.name}`, (close) => {
    const usesTask = /\{\{\s*task\s*\}\}|(FACTORY|SCF)_TASK/.test(yaml);
    const task = h("textarea", { rows: 5, placeholder: "Describe the task, e.g. “Add a --json flag to the export command”" });
    const repo = h("input", { class: "mono", value: S.info.repo });
    const vars = Object.entries(flow.vars).map(([k, v]) => [k, h("input", { class: "mono", value: v })]);
    const warn = h("p", { class: "status bad flush", role: "status" });
    const err = h("div");
    let confirmedEmpty = false; // the first click on an empty task only warns
    const start = h("button", { class: "primary", onClick: async () => {
      if (starting) return;
      if (!task.value.trim() && flow.workspace !== "empty" && !confirmedEmpty) {
        confirmedEmpty = true;
        warn.textContent = "There is no task text. Click “Run without a task” to start anyway.";
        start.textContent = "▶ Run without a task";
        return;
      }
      starting = true;
      start.disabled = task.disabled = true;
      mount(err, null);
      try {
        const body = {
          task: task.value, repo: repo.value,
          vars: Object.fromEntries(vars.map(([k, el]) => [k, el.value])),
          ...(c.dirty || !c.name ? { yaml } : { flow: c.name }),
        };
        close((await api.startRun(body)).runId);
      } catch (e) {
        const info = explainError(e, { what: "The run was not started.", safe: "Your task is kept. Nothing was started." });
        mount(err, errorState(info));
        starting = false;
        start.disabled = task.disabled = false;
      }
    } }, "▶ Start run");
    task.addEventListener("input", () => {
      confirmedEmpty = false;
      warn.textContent = "";
      start.textContent = "▶ Start run";
    });
    task.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && start.click());
    return h("div", { class: "stack" },
      h("label", { class: "field" }, h("span", {}, flow.workspace === "empty" ? "Extra instructions (optional)" : "Task"), task,
        !usesTask ? h("small", {}, "This flow doesn't use the task text.") : null),
      flow.workspace === "empty"
        ? h("small", { class: "muted" }, "Runs in a fresh empty folder — the flow fetches its own code (e.g. clones from GitHub).")
        : h("label", { class: "field" }, h("span", {}, "Repository"), repo,
            h("small", {}, flow.workspace === "worktree" ? "Runs in a fresh git worktree + branch — your checkout is not touched." : "⚠ in-place: Claude edits this directory directly.")),
      vars.length ? h("div", { class: "grid" }, vars.map(([k, el]) => h("label", { class: "field" }, h("span", { class: "mono" }, k), el))) : null,
      c.dirty ? h("small", { class: "muted" }, "Runs your unsaved edits.") : null,
      warn, err,
      h("div", { class: "row" }, h("span", { class: "spacer" }), h("small", { class: "muted" }, "⌘↵"), start));
  }, { busy: () => starting });
  if (runId) location.hash = `#/runs/${runId}`;
}

async function generateDialog(modify) {
  if (dialogOpen()) return;
  if (!modify && !(await confirmDiscard())) return;
  let working = false;
  const result = await modal(modify ? "Ask Claude to change this flow" : "Draft a flow with Claude", (close) => {
    const ta = h("textarea", {
      rows: 6,
      placeholder: modify
        ? "e.g. Add a lint step before the tests and use haiku for the fix step"
        : "e.g. Write failing tests first, implement until they pass, run eslint, then an opus security review that must approve before committing.",
    });
    const status = h("div", { class: "row" });
    const go = h("button", { class: "primary", onClick: async () => {
      if (!ta.value.trim() || working) return;
      working = true;
      go.disabled = ta.disabled = true;
      mount(status, h("span", { class: "spinner" }), h("span", { class: "muted" }, "Claude is drafting… usually 20–60 seconds"));
      try {
        close(await api.generate(ta.value, modify ? S.cur.yaml : undefined));
      } catch (e) {
        const info = explainError(e, { what: "Claude could not draft the flow.", safe: "Your text is kept. Nothing was changed." });
        mount(status, errorState(info));
        working = false;
        go.disabled = ta.disabled = false;
      }
    } }, modify ? "✨ Apply" : "✨ Draft");
    ta.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && go.click());
    return h("div", { class: "stack" },
      ta,
      h("small", { class: "muted" }, "Uses your local claude CLI (sonnet). You review the result before saving."),
      h("div", { class: "row" }, status, h("span", { class: "spacer" }), go));
  }, { busy: () => working });
  if (!result) return;
  if (modify) {
    Object.assign(S.cur, { yaml: result.yaml, obj: tryParse(result.yaml) ?? S.cur.obj, dirty: true });
    renderFlowView();
  } else {
    openNew(result.yaml);
  }
  toast(result.error ? "Claude's draft has issues — see the errors" : `Done · $${result.costUsd.toFixed(3)} — review, then Save`, result.error ? "error" : "info");
}

// ── routing ──

function welcome() {
  mount(main, h("div", { class: "empty" },
    h("h1", { class: "mb-8" }, "Welcome to Spaghetti Code Foundry"),
    h("p", {}, "Build your own coding flows: pick a flow on the left, start from a blank one, or describe what you want and let Claude draft it."),
    h("div", { class: "row center mt-16" },
      h("button", { class: "primary", onClick: () => generateDialog(false) }, "✨ Draft flow with Claude"),
      h("button", { onClick: newBlank }, "+ Blank flow"))));
}

let routeGen = 0;
// The "since you last looked" box: Home places it; it stays hidden until there is something to say.
const sinceEl = h("div", { class: "since" });
sinceEl.hidden = true;

async function route() {
  // While a dialog is open (the discard question included) the address is put back: the dialog is not replaced and a busy one is not bypassed.
  // This sits before the generation is counted, or the navigation the person confirms would be dropped as stale.
  if (dialogOpen() && S.lastHash) {
    if (location.hash !== S.lastHash) history.replaceState(null, "", S.lastHash);
    return;
  }
  const mine = ++routeGen;
  // A set-password link is only for the sign-in page: load it again to show that page.
  if (linkToken(location.hash)) return location.reload();
  const to = resolve("admin", location.hash);
  if (to.hash !== location.hash) history.replaceState(null, "", to.hash);
  const hash = to.hash;
  const { path } = splitHash(hash);
  const [, section, arg] = path.split("/").map(decodeURIComponent);
  const leavingDraft = S.cur?.dirty && (section !== "flows" || arg !== S.cur.name) && path !== "#/new";
  // Filters change the address without a navigation; the page keeps the address in step.
  const go = (next) => { history.replaceState(null, "", next); S.lastHash = next; };
  // Only warn when opening a *different* flow; other pages keep the draft in memory.
  if (leavingDraft && section === "flows" && arg) {
    history.replaceState(null, "", S.lastHash);
    if (!(await confirmDiscard())) return;
    history.replaceState(null, "", hash);
  }
  S.lastHash = hash;
  S.cleanup?.();
  S.cleanup = null;
  showPage("admin", to);
  document.body.classList.toggle("no-side", to.dest !== "flows");
  try {
    if (section === "home") {
      // Draws into its own box, so a slow load that ends after a hash change leaves nothing running.
      const box = h("div", {});
      mount(main, box);
      const done = await renderAdminHome(box, { since: sinceEl });
      if (mine !== routeGen) done?.();
      else S.cleanup = done;
    }
    else if (section === "board") S.cleanup = S.info.redesign ? renderWork(main, arg, { user: S.me }) : renderBoard(main, arg, { query: to.query, go });
    else if (section === "library") await renderLibrary(main);
    else if (section === "dashboard") await renderDashboard(main);
    else if (section === "watchers") await renderWatchers(main);
    else if (section === "problems") await renderProblems(main);
    else if (section === "settings") await renderSettings(main);
    else if (section === "maintenance") await renderMaintenance(main);
    else if (section === "models") await renderModels(main);
    else if (section === "all-repos") S.cleanup = await renderAllRepos(main);
    else if (section === "credentials") {
      const off = await renderCredentials(main);
      if (mine === routeGen) S.cleanup = off;
      else off(); // the person went on to another page meanwhile
    }
    else if (section === "refinement") S.cleanup = await renderRefinement(main, { admin: true, id: arg });
    else if (section === "repos") S.cleanup = await renderRepos(main, { admin: true });
    else if (section === "users") S.cleanup = await renderUsers(main, { me: S.me });
    else if (section === "audit") S.cleanup = await renderAudit(main);
    else if (section === "start") {
      // The page draws into its own box, so a slow load that ends after a hash change cannot touch the page that took over.
      const box = h("div", {});
      mount(main, box);
      const done = await renderStart(box, { admin: true });
      if (mine !== routeGen) done?.();
      else S.cleanup = done;
    }
    else if (section === "runs" && arg) S.cleanup = renderRunDetail(main, arg, { admin: true });
    else if (section === "runs") {
      // The list draws into its own box, so a slow answer that comes after a hash change cannot touch the next page.
      const box = h("div", {});
      mount(main, box);
      const done = await renderRunsList(box, { admin: true, query: to.query, go });
      if (mine !== routeGen) done?.();
      else S.cleanup = done;
    }
    else if (section === "new") S.cur && !S.cur.name ? renderFlowView() : openNew();
    else if (section === "flows" && arg) await openFlow(arg, mine);
    else welcome();
  } catch (e) {
    if (mine !== routeGen) return; // a late error must not replace the page that is shown now
    mount(main, errorState(explainError(e, { what: "This page could not be loaded." }), { onRetry: route }));
  }
  renderSidebar();
}

window.addEventListener("beforeunload", (e) => S.cur?.dirty && e.preventDefault());
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s" && S.cur && (splitHash(location.hash).path.startsWith("#/flows/") || splitHash(location.hash).path === "#/new")) {
    e.preventDefault();
    save();
  }
});

// A user never gets past this line: enterDisplay sends that account to /user/ and does not return.
const me = await enterDisplay("admin");
S.me = me.id;
initShell("admin", { user: me });
// Only now: before the role is known, a hash change must not draw a page.
window.addEventListener("hashchange", route);
await startAdmin();

async function startAdmin() {
  startHealth(healthEl);
  S.info = await api.info();
  document.getElementById("repo").textContent = S.info.repo;
  void refreshFlows(); // the sidebar draws its own loading and failure; the pages do not wait for it
  void refreshModelLists();
  // When something waits for the owner, the app opens on the Your turn page.
  const to = startHash(location.hash, await startBadge());
  if (to) history.replaceState(null, "", to);
  route();
  startSince(sinceEl);
}
