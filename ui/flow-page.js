import YAML from "/vendor/yaml/index.js";
import { confirmDialog, debounce, h, modal, mount, toast } from "./dom.js";
import { cleanFlow, editable, renderEditor } from "./editor.js";
import { editorState, overviewStartsOpen, overviewStoreFor } from "./flow-state.js";
import { renderHeader, renderNavigator } from "./flow-shell.js";
import { openInVisual, openInYaml, problemsOf, renderFlowProblems } from "./flow-problems.js";
import { splitHash } from "./ia.js";
import { emptyState, errorState, explainError, loadingState, permissionState, staleNote } from "./states.js";
import { renderGraph } from "./graph.js";
import { insertBlock, pickBlock, saveStepAsBlock } from "./library.js";
import { runForm } from "./run-form.js";

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

function tryParse(text) {
  try {
    const v = YAML.parse(text);
    return editable(v) ? v : null;
  } catch {
    return null;
  }
}

function browserStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}

/**
 * The flow page: the editor, its header and the flow list on the left.
 * `state` is the shared { info, flows, cur, ... } of the app; cur is the flow being edited:
 * { name: saved name | null, scope, saveScope, yaml, obj, mode: "visual"|"yaml", dirty, selected, validation, problems, checking }
 * `onNavigate(hash, "go" | "push" | "replace")` changes the address. `storage` and `isNarrow` can be replaced in tests.
 */
export function createFlowPage({ main, sidebar, state, api, onNavigate, storage = browserStorage(), isNarrow = () => !!globalThis.matchMedia?.("(max-width: 1100px)")?.matches, watchNarrow = (fn) => globalThis.matchMedia?.("(max-width: 1100px)")?.addEventListener?.("change", fn) }) {
  let ui = {};
  let overview = null; // null until the first flow is drawn
  let store = overviewStoreFor(storage, false);
  let bucket = null; // the width the choice was read for: true = narrow
  // A window that is resized while the editor is open switches to the choice of its new width.
  watchNarrow?.(() => {
    if (!state.cur || !ui.grid || !main.contains(ui.grid) || !syncOverview()) return;
    applyOverview();
    drawGraph();
    drawHeader();
  });
  let query = "";

  // ── flow list ──

  // The flow list in the sidebar: "loading" | "ready" | "error". An error with `state.flowsLoaded` keeps the old entries (stale).
  const L = { state: "loading", error: null, at: 0, gen: 0 };

  /** Loads the flow list. Never throws. A newer call wins: an older answer (or failure) is dropped. True when the list is fresh. */
  async function refreshFlows() {
    const mine = ++L.gen;
    if (!state.flowsLoaded) {
      L.state = "loading";
      renderSidebar();
    }
    try {
      const list = await api.flows();
      if (mine !== L.gen) return L.state === "ready";
      state.flows = list;
      state.flowsLoaded = true;
      L.state = "ready";
      L.error = null;
      L.at = Date.now();
      // Names for the sub-flow picker in the editor.
      let dl = document.getElementById("flow-names");
      if (!dl) document.body.append((dl = h("datalist", { id: "flow-names" })));
      mount(dl, state.flows.map((f) => h("option", { value: f.name })));
    } catch (e) {
      if (mine !== L.gen) return L.state === "ready";
      L.state = "error";
      L.error = e;
    }
    renderSidebar();
    return L.state === "ready";
  }

  /** What takes the place of the list while it is not there: loading, no permission, or a failure with Retry. Null once it is loaded. */
  function listStatus() {
    if (state.flowsLoaded) return null;
    if (L.state === "loading") return loadingState("Loading flows…", { rows: 4 });
    if (Number(L.error?.status) === 403) return permissionState("You may not see the list of flows.");
    return errorState(explainError(L.error, { what: "The flows could not be loaded." }), { onRetry: refreshFlows });
  }

  function renderSidebar() {
    const { path } = splitHash(location.hash);
    const inFlows = path.startsWith("#/flows/") || path === "#/new";
    mount(sidebar, renderNavigator({
      flows: state.flows,
      current: inFlows ? state.cur : null,
      query,
      onQuery: (q) => { query = q; renderSidebar(); },
      onDraft: () => generateDialog(false),
      onBlank: newBlank,
      status: listStatus(),
      empty: emptyState("No flows yet."),
      note: L.state === "error" ? staleNote(L.at, { failed: true, onRetry: refreshFlows }) : null,
    }));
  }

  async function newBlank() {
    if (await confirmDiscard()) openNew();
  }

  // A dialog is open when the modal root has content. The router leaves the page alone then, so no dialog is replaced or bypassed.
  const dialogOpen = () => document.getElementById("modal-root").children.length > 0;

  /** Asks before a draft is thrown away. True when there is nothing to lose or the person agrees; false when another dialog is open. */
  async function confirmDiscard() {
    if (!state.cur?.dirty) return true;
    if (dialogOpen()) return false;
    return confirmDialog({ title: "Discard unsaved changes?", text: `Discard unsaved changes to "${state.cur.obj?.name ?? "new flow"}"?`, confirm: "Discard" });
  }

  // ── flow view ──

  function flowOpenError(e, name, retry) {
    const back = { href: "#/flows", label: "Back to flows" };
    const status = Number(e?.status);
    if (status === 403) return permissionState("You may not open this flow.", back);
    if (status === 404) return errorState(explainError(e, { what: `There is no flow named "${name}".` }), { back });
    return errorState(explainError(e, { what: `The flow "${name}" could not be opened.` }), { onRetry: retry, back });
  }

  /** `isCurrent()` is the router's check: an answer that comes after the person went elsewhere draws nothing. */
  async function openFlow(name, isCurrent = () => true) {
    if (state.cur?.name === name) return renderFlowView(); // keep in-memory edits
    mount(main, loadingState("Loading flow…", { shape: "detail" }));
    let f;
    try {
      f = await api.flow(name);
    } catch (e) {
      if (!isCurrent()) return;
      mount(main, flowOpenError(e, name, () => openFlow(name, isCurrent)));
      return;
    }
    if (!isCurrent()) return;
    const obj = tryParse(f.yaml);
    state.cur = {
      name: f.name, scope: f.scope, saveScope: f.scope === "builtin" ? "repo" : f.scope,
      yaml: f.yaml, obj, mode: obj ? "visual" : "yaml", dirty: false, selected: null, validation: null, checking: false, problems: [],
    };
    renderFlowView();
  }

  function openNew(yaml = BLANK) {
    state.cur = { name: null, scope: null, saveScope: "repo", yaml, obj: tryParse(yaml), mode: "visual", dirty: true, selected: null, validation: null, checking: false, problems: [] };
    if (!state.cur.obj) state.cur.mode = "yaml";
    onNavigate("#/new", "push");
    renderFlowView();
  }

  function renderFlowView() {
    renderSidebar();
    const head = h("div", {});
    const errors = h("div", { tabindex: "-1", "aria-label": "Problems" });
    const failure = h("div", {});
    const body = h("div", { class: "editor-body" });
    const graph = h("div", {});
    const pane = h("div", { class: "overview-pane", id: "flow-overview" }, h("h3", { class: "mb-8" }, "Overview"), graph);
    const grid = h("div", { class: "editor" }, pane, body);
    ui = { head, errors, failure, body, graph, pane, grid };
    mount(main, head, errors, failure, grid);
    syncOverview();
    applyOverview();
    drawHeader();
    drawBody();
    drawGraph();
    validate();
  }

  /** Reads the choice of the current width (wide or narrow) when the width changed since the last time. */
  function syncOverview() {
    const narrow = isNarrow();
    if (overview !== null && narrow === bucket) return false;
    bucket = narrow;
    store = overviewStoreFor(storage, narrow);
    overview = overviewStartsOpen({ stored: store.get() });
    return true;
  }

  function applyOverview() {
    ui.pane.hidden = !overview;
    ui.grid.classList.toggle("with-overview", !!overview);
  }

  function toggleOverview() {
    overview = !overview;
    store.set(overview);
    applyOverview();
    drawGraph();
    drawHeader();
  }

  function drawHeader() {
    const c = state.cur;
    if (!c || !ui.head) return;
    const moreOpen = !!ui.head.querySelector("details")?.open;
    mount(ui.head, renderHeader(editorState(c, state.flows), {
      mode: c.mode,
      overviewOpen: !!overview,
      moreOpen,
      saveScope: c.saveScope,
      canDelete: !!c.name && c.scope !== "builtin",
      saving: !!c.saving,
      deleting: !!c.deleting,
      onMode: setMode,
      onSave: () => save(),
      onRun: () => runDialog(),
      onOverview: toggleOverview,
      onProblems: focusProblems,
      onAsk: () => generateDialog(true),
      onScope: (v) => { c.saveScope = v; drawHeader(); },
      onDelete: () => remove(),
    }));
  }

  /** Moves the focus to the problem list: its first problem, or the list itself. */
  function focusProblems() {
    const c = state.cur;
    if (!c || editorState(c, state.flows).validation.kind !== "problems") return;
    const target = ui.errors.querySelector("button") ?? ui.errors;
    target.focus();
    target.scrollIntoView?.({ block: "center" });
  }

  function drawBody() {
    const c = state.cur;
    if (c.mode === "yaml") {
      mount(ui.body, h("textarea", {
        class: "yaml-editor", spellcheck: "false", "aria-label": "Flow YAML", value: c.yaml,
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
          const picked = await pickBlock(c.obj).catch((e) => toast(e.message, "error"));
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
    if (!overview) return;
    mount(ui.graph, renderGraph(state.cur.obj, { selected: state.cur.selected, onSelect: (i) => select(i, true) }));
  }

  function select(i, scroll) {
    state.cur.selected = i;
    document.querySelectorAll(".card[id^='step-']").forEach((el) => el.classList.toggle("selected", el.id === `step-${i}`));
    drawGraph();
    if (scroll && state.cur.mode === "visual") document.getElementById(`step-${i}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function setMode(mode) {
    const c = state.cur;
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
    const c = state.cur;
    const wasClean = !c.dirty;
    c.dirty = true;
    c.checking = true;
    drawHeader();
    drawGraph();
    if (wasClean) renderSidebar(); // the list marks the open flow as unsaved
    validateSoon();
  }

  /**
   * Checks the YAML as it is now. Returns `{ r, yaml, c }` for that exact text; null when the flow is gone or the text changed meanwhile (the answer is stale).
   * `lead`: an explicit check (Save, Run) — its answer carries the lead line and takes the focus. An older answer never draws over a newer one.
   */
  async function validate(lead) {
    const c = state.cur;
    if (!c) return null;
    const yaml = c.yaml;
    const seq = (c.vseq = (c.vseq ?? 0) + 1);
    c.checking = true;
    drawHeader();
    const r = await api.validate(yaml).catch((e) => ({ ok: false, error: e.message }));
    if (c !== state.cur || yaml !== c.yaml) return null;
    if (seq < (c.drawn ?? 0)) return { r, yaml, c };
    c.drawn = seq;
    c.validation = r;
    c.problems = r.ok ? [] : problemsOf(r, yaml, YAML);
    c.checking = false;
    if (r.ok) mount(ui.errors, null);
    else drawErrors(c, yaml, lead, r.error, r);
    drawHeader();
    return { r, yaml, c };
  }
  const validateSoon = debounce(() => state.cur && validate(), 300);

  /** The errors box above the editor: an optional lead line and the text. Draws only when `yaml` is still the text of `c`. */
  function drawErrors(c, yaml, lead, text, r) {
    if (c !== state.cur || yaml !== c.yaml || !ui.errors) return;
    c.drawn = Math.max(c.drawn ?? 0, c.vseq ?? 0);
    const list = r ? renderFlowProblems(c.problems ?? problemsOf(r, yaml, YAML), { mode: c.mode, onOpen: (p) => openProblem(p, yaml) })?.children[0] : null;
    mount(ui.errors, h("div", { class: "errors", role: "alert" }, lead ? h("p", { class: "flush" }, lead) : null, list ?? String(text ?? "").replace(/^<flow>: /, "")));
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
    if (c !== state.cur || !main.contains(ui.failure)) return toast(info.what, "error");
    mount(ui.failure, errorState(info, { onRetry: retry }));
  }

  async function save() {
    const c = state.cur;
    if (!c || c.saving) return;
    c.saving = true;
    drawHeader();
    try {
      await doSave(c);
    } finally {
      c.saving = false;
      if (c === state.cur && ui.head) drawHeader();
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
      const exists = state.flows.find((f) => f.name === name);
      if (exists && exists.scope !== "builtin" && !(await askOverwrite(name))) return;
    }
    let saved;
    try {
      saved = await api.saveFlow(name, yaml, scope);
    } catch (e) {
      return showFailure(c, explainError(e, { what: `The flow "${name}" was not saved.`, safe: "Your changes are still here, marked as unsaved." }), () => save());
    }
    const untouched = c === state.cur && c.yaml === yaml; // no edit while the request ran
    if (untouched && saved?.yaml && saved.yaml !== yaml) {
      c.yaml = saved.yaml;
      c.obj = tryParse(saved.yaml) ?? c.obj;
    }
    const here = splitHash(location.hash).path;
    const viewing = c === state.cur && here === (old.name ? `#/flows/${old.name}` : "#/new");
    // Commit the save first: what the person does during the cleanup below must not be undone by it.
    if (c.name !== name || c.scope !== scope) Object.assign(c, { name, scope });
    if (untouched) c.dirty = false;
    if (viewing) {
      onNavigate(`#/flows/${name}`, "replace");
      mount(ui.failure, null);
      drawHeader();
      if (untouched && saved?.yaml) {
        drawBody();
        drawGraph();
      }
    }
    let leftover = null;
    if (old.name && old.name !== name && old.scope !== "builtin") leftover = await removeOld(old.name); // rename
    await refreshFlows();
    // The scope shown is the one that wins in the list: a repo copy still beats a global one.
    const effective = state.flows.find((f) => f.name === name)?.scope ?? scope;
    if (c.name === name && c.scope === scope && effective !== scope) {
      Object.assign(c, { scope: effective, saveScope: effective === "builtin" ? "repo" : effective });
      // A copy with a higher priority wins: show and run what it holds, not the text just saved to the other scope.
      if (untouched && c.yaml === yaml) {
        try {
          const wins = await api.flow(name);
          if (c === state.cur && c.yaml === yaml) Object.assign(c, { yaml: wins.yaml, obj: tryParse(wins.yaml) ?? c.obj, selected: null });
        } catch { /* the text shown stays: it is what was saved */ }
      }
      if (c === state.cur && ui.head && main.contains(ui.head)) {
        drawHeader();
        drawBody();
        drawGraph();
      }
    } else if (c.name === name && c.scope === scope) {
      Object.assign(c, { saveScope: effective === "builtin" ? "repo" : effective });
    }
    toast(effective !== scope ? `Saved ${name} to ${scope} flows, but the ${effective} copy still wins` :
      saved?.version ? `Saved ${name} — version ${saved.version} for users` : `Saved ${name}`);
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
      if (c === state.cur) mount(ui.failure, null);
      await refreshFlows();
    };
    showFailure(c, explainError(e, { what: `The old flow "${old}" could not be removed.`, safe: "The flow is saved under the new name." }), retry);
  }

  async function remove() {
    const c = state.cur;
    if (!c?.name || c.deleting) return;
    const text = `Delete flow "${c.name}"? This removes the file.${c.dirty ? " Your unsaved changes will be lost." : ""}`;
    if (dialogOpen() || !(await confirmDialog({ title: "Delete flow?", text, confirm: "Delete" }))) return;
    await doRemove(c);
  }

  async function doRemove(c) {
    if (c.deleting) return;
    c.deleting = true;
    if (c === state.cur && ui.head) drawHeader();
    const name = c.name;
    const yaml0 = c.yaml;
    try {
      await api.deleteFlow(name);
    } catch (e) {
      c.deleting = false;
      if (c === state.cur && ui.head) drawHeader();
      return showFailure(c, explainError(e, { what: `The flow "${name}" was not deleted.`, safe: "The flow is still there." }), () => doRemove(c));
    }
    c.deleting = false;
    toast(`Deleted ${name}`);
    if (state.cur !== c) return void refreshFlows(); // another flow is open now: leave it alone
    const viewing = splitHash(location.hash).path === `#/flows/${name}`;
    if (c.yaml !== yaml0) {
      // Typed while the request ran: the file is gone, the text is not. It stays as a new unsaved draft.
      Object.assign(c, { name: null, scope: null, saveScope: c.saveScope === "global" ? "global" : "repo", dirty: true });
      if (viewing) {
        onNavigate("#/new", "replace");
        mount(ui.failure, null);
        drawHeader();
      }
      await refreshFlows();
      return;
    }
    state.cur = null;
    await refreshFlows();
    // Only the page that showed the flow goes to the list; another page stays where it is.
    if (!state.cur && viewing) onNavigate("#/flows", "go");
  }

  // ── dialogs ──

  async function runDialog() {
    const c = state.cur;
    if (!c || dialogOpen()) return;
    const v = await validate("Fix these errors before running.");
    if (!v || c !== state.cur || !v.r.ok) return;
    const { yaml } = v;
    const flow = v.r.flow;
    let starting = false;
    const runId = await modal(`Run ${flow.name}`, (close) =>
      runForm({ flow, yaml, cur: c, repo: state.info.repo, close, onBusy: (b) => { starting = b; }, a: api }),
    { busy: () => starting });
    if (runId) onNavigate(`#/runs/${runId}`, "go");
  }

  async function generateDialog(modify) {
    if (dialogOpen()) return;
    if (!modify && !(await confirmDiscard())) return;
    let working = false;
    const result = await modal(modify ? "Ask Claude to change this flow" : "Draft a flow with Claude", (close) => {
      const ta = h("textarea", {
        rows: 6,
        "aria-label": modify ? "Describe the change" : "Describe the flow",
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
          close(await api.generate(ta.value, modify ? state.cur.yaml : undefined));
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
      Object.assign(state.cur, { yaml: result.yaml, obj: tryParse(result.yaml) ?? state.cur.obj, dirty: true });
      renderFlowView();
    } else {
      openNew(result.yaml);
    }
    toast(result.error ? "Claude's draft has issues — see the errors" : `Done · $${result.costUsd.toFixed(3)} — review, then Save`, result.error ? "error" : "info");
  }

  /** Goes to the place of a problem; does nothing when the text changed since it was checked. */
  function openProblem(p, yaml) {
    const c = state.cur;
    if (!c || c.yaml !== yaml) return false;
    if (c.mode === "yaml") {
      const textarea = ui.body.querySelector(".yaml-editor");
      return textarea?.value === yaml && openInYaml(textarea, p, YAML);
    }
    return openInVisual(ui.body, p, select);
  }

  return { refreshFlows, renderSidebar, renderFlowView, openFlow, openNew, newBlank, save, generateDialog, confirmDiscard, dialogOpen };
}
