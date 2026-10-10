import YAML from "/vendor/yaml/index.js";
import { debounce, h, modal, mount, toast } from "./dom.js";
import { cleanFlow, editable, renderEditor } from "./editor.js";
import { editorState, overviewStartsOpen, overviewStoreFor } from "./flow-state.js";
import { renderHeader, renderNavigator } from "./flow-shell.js";
import { openInVisual, openInYaml, problemsOf, renderFlowProblems } from "./flow-problems.js";
import { splitHash } from "./ia.js";
import { renderGraph } from "./graph.js";
import { insertBlock, pickBlock, saveStepAsBlock } from "./library.js";

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

  async function refreshFlows() {
    state.flows = await api.flows();
    // Names for the sub-flow picker in the editor.
    let dl = document.getElementById("flow-names");
    if (!dl) document.body.append((dl = h("datalist", { id: "flow-names" })));
    mount(dl, state.flows.map((f) => h("option", { value: f.name })));
    renderSidebar();
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
      onBlank: () => confirmDiscard() && openNew(),
    }));
  }

  function confirmDiscard() {
    return !state.cur?.dirty || confirm(`Discard unsaved changes to "${state.cur.obj?.name ?? "new flow"}"?`);
  }

  // ── flow view ──

  async function openFlow(name) {
    if (state.cur?.name === name) return renderFlowView(); // keep in-memory edits
    const f = await api.flow(name);
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
    const body = h("div", { class: "editor-body" });
    const graph = h("div", {});
    const pane = h("div", { class: "overview-pane", id: "flow-overview" }, h("h3", { class: "mb-8" }, "Overview"), graph);
    const grid = h("div", { class: "editor" }, pane, body);
    ui = { head, errors, body, graph, pane, grid };
    mount(main, head, errors, grid);
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
      onMode: setMode,
      onSave: save,
      onRun: runDialog,
      onOverview: toggleOverview,
      onProblems: focusProblems,
      onAsk: () => generateDialog(true),
      onScope: (v) => { c.saveScope = v; drawHeader(); },
      onDelete: remove,
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

  async function validate() {
    const c = state.cur;
    const yaml = c.yaml;
    c.checking = true;
    drawHeader();
    const r = await api.validate(yaml).catch((e) => ({ ok: false, error: e.message }));
    if (c !== state.cur || yaml !== c.yaml) return; // stale
    c.validation = r;
    c.problems = r.ok ? [] : problemsOf(r, yaml, YAML);
    c.checking = false;
    mount(ui.errors, r.ok ? null : renderFlowProblems(c.problems, { mode: c.mode, onOpen: (p) => openProblem(p, yaml) }));
    drawHeader();
  }
  const validateSoon = debounce(validate, 300);

  async function save() {
    const c = state.cur;
    if (!c) return;
    await validate();
    if (!c.validation?.ok) return toast("Fix the errors before saving", "error");
    const name = c.obj?.name;
    if (!NAME_RE.test(name ?? "")) return toast("Flow name may only contain letters, digits, _ and -", "error");
    const exists = state.flows.find((f) => f.name === name);
    if (name !== c.name && exists && exists.scope !== "builtin" && !confirm(`A flow named "${name}" already exists. Overwrite it?`)) return;
    try {
      const saved = await api.saveFlow(name, c.yaml, c.saveScope);
      if (saved?.yaml && saved.yaml !== c.yaml) {
        c.yaml = saved.yaml;
        c.obj = tryParse(saved.yaml) ?? c.obj;
      }
      if (c.name && c.name !== name && c.scope !== "builtin") await api.deleteFlow(c.name); // rename
      const target = c.saveScope;
      Object.assign(c, { name, scope: target, dirty: false });
      onNavigate(`#/flows/${name}`, "replace");
      await refreshFlows();
      // The scope shown is the one that wins in the list: a repo copy still beats a global one.
      const effective = state.flows.find((f) => f.name === name)?.scope ?? target;
      Object.assign(c, { scope: effective, saveScope: effective === "builtin" ? "repo" : effective });
      if (effective !== target) {
        // A copy with a higher priority wins: show and run what it holds, not the text just saved to the other scope.
        const wins = await api.flow(name);
        Object.assign(c, { yaml: wins.yaml, obj: tryParse(wins.yaml) ?? c.obj, selected: null });
      }
      renderFlowView();
      toast(effective !== target ? `Saved ${name} to ${target} flows, but the ${effective} copy still wins` :
        saved?.version ? `Saved ${name} — version ${saved.version} for users` : `Saved ${name}`);
    } catch (e) {
      toast(e.message, "error");
    }
  }

  async function remove() {
    const c = state.cur;
    if (!confirm(`Delete flow "${c.name}"? This removes the file.`)) return;
    try {
      await api.deleteFlow(c.name);
    } catch (e) {
      toast(e.message, "error"); // the flow and its edits stay
      return;
    }
    state.cur = null;
    await refreshFlows();
    onNavigate("#/flows", "go");
  }

  // ── dialogs ──

  async function runDialog() {
    const c = state.cur;
    await validate();
    if (!c.validation?.ok) return toast("Fix the errors before running", "error");
    const flow = c.validation.flow;
    const runId = await modal(`Run ${flow.name}`, (close) => {
      const usesTask = /\{\{\s*task\s*\}\}|(FACTORY|SCF)_TASK/.test(c.yaml);
      const task = h("textarea", { rows: 5, placeholder: "Describe the task, e.g. “Add a --json flag to the export command”" });
      const repo = h("input", { class: "mono", value: state.info.repo });
      const vars = Object.entries(flow.vars).map(([k, v]) => [k, h("input", { class: "mono", value: v })]);
      const err = h("p", { class: "status bad flush" });
      const start = h("button", { class: "primary", onClick: async () => {
        if (!task.value.trim() && flow.workspace !== "empty" && !confirm("Run without a task description?")) return;
        start.disabled = true;
        try {
          const body = {
            task: task.value, repo: repo.value,
            vars: Object.fromEntries(vars.map(([k, el]) => [k, el.value])),
            ...(c.dirty || !c.name ? { yaml: c.yaml } : { flow: c.name }),
          };
          close((await api.startRun(body)).runId);
        } catch (e) {
          err.textContent = e.message;
          start.disabled = false;
        }
      } }, "▶ Start run");
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
        err,
        h("div", { class: "row" }, h("span", { class: "spacer" }), h("small", { class: "muted" }, "⌘↵"), start));
    });
    if (runId) onNavigate(`#/runs/${runId}`, "go");
  }

  async function generateDialog(modify) {
    if (!modify && !confirmDiscard()) return;
    const result = await modal(modify ? "Ask Claude to change this flow" : "Draft a flow with Claude", (close) => {
      const ta = h("textarea", {
        rows: 6,
        placeholder: modify
          ? "e.g. Add a lint step before the tests and use haiku for the fix step"
          : "e.g. Write failing tests first, implement until they pass, run eslint, then an opus security review that must approve before committing.",
      });
      const status = h("div", { class: "row" });
      const go = h("button", { class: "primary", onClick: async () => {
        if (!ta.value.trim()) return;
        go.disabled = ta.disabled = true;
        mount(status, h("span", { class: "spinner" }), h("span", { class: "muted" }, "Claude is drafting… usually 20–60 seconds"));
        try {
          close(await api.generate(ta.value, modify ? state.cur.yaml : undefined));
        } catch (e) {
          mount(status, h("span", { class: "status bad" }, e.message));
          go.disabled = ta.disabled = false;
        }
      } }, modify ? "✨ Apply" : "✨ Draft");
      ta.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && go.click());
      return h("div", { class: "stack" },
        ta,
        h("small", { class: "muted" }, "Uses your local claude CLI (sonnet). You review the result before saving."),
        h("div", { class: "row" }, status, h("span", { class: "spacer" }), go));
    });
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

  return { refreshFlows, renderSidebar, renderFlowView, openFlow, openNew, save, generateDialog, confirmDiscard };
}
