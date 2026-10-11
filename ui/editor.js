import { glyph, h } from "./dom.js";
import { field, list, select, setKey, text } from "./fields.js";
import { STEP_TYPES, stepBody } from "./step-types.js";
import { subtitle } from "./graph.js";
import { markProblems } from "./flow-problems.js";

export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];

function uniqueId(flow, base) {
  const ids = new Set(flow.steps.map((s) => s.id));
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}

function renameStep(flow, from, to) {
  for (const s of flow.steps) {
    for (const k of ["on_success", "on_failure", "resume", "resume_from"]) if (s[k] === from) s[k] = to;
    for (const r of s.routes ?? []) if (r.goto === from) r.goto = to;
    if (s.type === "parallel") s.steps = (s.steps ?? []).map((id) => (id === from ? to : id));
  }
}

// ── flow settings ──

function settingsCard(flow, onChange, rerender) {
  flow.defaults ??= {};
  flow.vars ??= {};
  const d = flow.defaults;
  const vars = Object.entries(flow.vars);
  const setVars = (entries) => { flow.vars = Object.fromEntries(entries); onChange(); };

  const filled = (o) => Object.values(o ?? {}).some((v) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
  const safetyOpen = filled(flow.limits) || filled(flow.sandbox) || flow.one_per_repo != null;

  return h("div", { class: "card inspector", id: "flow-settings", "data-section": "flow" },
    h("div", { class: "card-head" }, h("strong", {}, "Flow settings")),
    h("div", { class: "grid" },
      field("Name", text(flow, "name", onChange, { mono: true, placeholder: "my-flow" }), "Also the file name"),
      field("Workspace", select(flow, "workspace", [["worktree", "git worktree of local repo (isolated branch)"], ["empty", "empty folder (clone from GitHub in a step)"], ["inplace", "in place (edit repo directly)"]], onChange))),
    field("Description", text(flow, "description", onChange, { placeholder: "What this flow does" })),
    h("details", { "data-section": "defaults", open: filled(d) },
      h("summary", {}, "Defaults for agent steps"),
      h("div", { class: "grid" },
        field("Model", text(d, "model", onChange, { list: "models", mono: true, placeholder: "(router / default)" }), "e.g. sonnet, codex, ollama:qwen3-coder"),
        field("Agent", select(d, "agent", [["claude", "Claude Code"], ["codex", "Codex (ChatGPT)"]], onChange, { emptyLabel: "from model spec" })),
        field("Provider", text(d, "provider", onChange, { list: "provider-names", mono: true, placeholder: "from model spec" })),
        field("Permission mode", select(d, "permission_mode", PERMISSION_MODES.map((m) => [m, m]), onChange, { emptyLabel: "acceptEdits (default)" })),
        field("Timeout (sec)", text(d, "timeout_sec", onChange, { type: "number" })),
        field("Max visits / step", text(d, "max_visits", onChange, { type: "number", placeholder: "5" })),
        field("Budget / step ($)", text(d, "max_budget_usd", onChange, { type: "number" }))),
      h("div", { class: "mt-10" },
        field("Allowed tools", list(d, "allowed_tools", onChange, 'Read, Edit, Write, Bash(npm *)'), "Comma-separated. Shell commands Claude may run without asking."))),
    h("details", { "data-section": "limits sandbox", open: safetyOpen },
      h("summary", {}, "Safety"),
      h("div", { class: "grid" },
        field("Max cost per run ($)", text((flow.limits ??= {}), "max_cost_usd", onChange, { type: "number", placeholder: "no limit" }), "The run fails once it has spent this much."),
        field("Docker image for sandboxed shell steps", text((flow.sandbox ??= {}), "docker_image", onChange, { mono: true, placeholder: "e.g. node:22 (global default in Settings)" }))),
      h("label", { class: "row tight text-sm mt-8" },
        h("input", { type: "checkbox", class: "fit", "data-field": "claude", checked: !!flow.sandbox.claude, onChange: (e) => { setKey(flow.sandbox, "claude", e.target.checked || ""); onChange(); } }),
        h("span", {}, "Sandbox agents' shell commands (writes limited to the workspace)")),
      h("label", { class: "row tight text-sm mt-4" },
        h("input", { type: "checkbox", class: "fit", "data-field": "one_per_repo", checked: !!flow.one_per_repo, onChange: (e) => { setKey(flow, "one_per_repo", e.target.checked || ""); onChange(); } }),
        h("span", {}, "One run at a time per repository (for flows that change code; other runs of such flows wait in the queue)"))),
    h("details", { "data-section": "vars", open: vars.length > 0 },
      h("summary", {}, `Variables (${vars.length})`),
      h("div", { class: "kv" },
        vars.flatMap(([k, v], i) => [
          h("input", { class: "mono", value: k, placeholder: "name", "aria-label": `Variable ${i + 1} name`, onChange: (e) => { vars[i][0] = e.target.value.trim(); movePublishVar(flow, k, vars[i][0]); setVars(vars); rerender(); } }),
          h("input", { class: "mono", "data-field": k, value: String(v), placeholder: "value", "aria-label": `Variable ${i + 1} value`, onInput: (e) => { vars[i][1] = e.target.value; setVars(vars); } }),
          h("button", { class: "icon", title: "Remove", "aria-label": "Remove variable", onClick: () => { movePublishVar(flow, k, undefined); vars.splice(i, 1); setVars(vars); rerender(); } }, glyph("✕")),
        ])),
      h("button", { class: "small mt-8", onClick: () => { vars.push([`var${vars.length + 1}`, ""]); setVars(vars); rerender(); } }, "+ Variable"),
      h("small", { class: "muted block mt-6" }, "Use as {{vars.name}} in prompts and shell commands; override per run.")),
    publishPanel(flow, onChange, rerender));
}

// ── step inspector ──

function stepInspector(flow, step, i, ctx) {
  const { onChange, rerender, onSelect } = ctx;
  const move = (delta) => {
    const j = i + delta;
    if (j < 0 || j >= flow.steps.length) return;
    [flow.steps[i], flow.steps[j]] = [flow.steps[j], flow.steps[i]];
    onSelect(j, false);
    rerender();
  };
  const btn = (name, title, label, props) => h("button", { class: "icon", title, "aria-label": title, "data-focus": name, ...props }, label);
  const vars = Object.keys(flow.vars ?? {});
  const earlier = flow.steps.filter((s) => s !== step).map((s) => s.id);
  const prevId = step.id;

  return h("div", { class: `card inspector${step.jump_only ? " jump-only" : ""}`, id: `step-${i}` },
    h("div", { class: "card-head" },
      h("span", { class: "num" }, `${i + 1}`),
      text(step, "id", onChange, {
        label: `Step ${i + 1} id`,
        onCommit: (e) => {
          // References still point at the id this card was rendered with.
          const next = e.target.value.trim();
          step.id = next;
          if (next && prevId && next !== prevId) renameStep(flow, prevId, next);
          rerender();
        },
      }),
      h("span", { class: `pill ${step.type}` }, glyph(STEP_TYPES[step.type]?.icon ?? "?"), " ", step.type),
      h("span", { class: "spacer" }),
      btn("step-up", "Move up", "↑", { disabled: i === 0, onClick: () => move(-1) }),
      btn("step-down", "Move down", "↓", { disabled: i === flow.steps.length - 1, onClick: () => move(1) }),
      btn("step-block", "Save as reusable block", "☆", { onClick: () => ctx.onSaveBlock?.(step) }),
      btn("step-dup", "Duplicate", "⧉", { onClick: () => {
        flow.steps.splice(i + 1, 0, { ...structuredClone(step), id: uniqueId(flow, step.id) });
        onSelect(i + 1, false);
        rerender();
      } }),
      btn("step-del", "Delete step", "🗑", { onClick: () => {
        flow.steps.splice(i, 1);
        onSelect(flow.steps.length ? Math.min(i, flow.steps.length - 1) : "settings", false);
        rerender();
      } })),
    field("Description", text(step, "description", onChange, { placeholder: "optional" })),
    ...stepBody(flow, step, i, { onChange, rerender, vars, earlier }));
}

// ── structure list ──

/** Where a new step goes: at the top, after the selected step, or at the end. */
function insertIndex(flow, sel, where) {
  if (where === "top") return 0;
  if (where === "end" || sel === "settings") return flow.steps.length;
  return sel + 1;
}

function insertBar(flow, sel, { rerender, onSelect, onLibrary }) {
  let where = "after";
  const at = () => insertIndex(flow, sel, where);
  const add = (type) => {
    const i = at();
    const step = { id: uniqueId(flow, type), ...structuredClone(STEP_TYPES[type].blank) };
    flow.steps.splice(i, 0, step);
    onSelect(i, false);
    rerender();
  };
  return h("div", { class: "insert" },
    h("select", { class: "small-select", title: "Where new steps go", "aria-label": "Where new steps go", "data-focus": "step-add-where", onChange: (e) => { where = e.target.value; } },
      [["after", sel === "settings" ? "Add at the end" : "Add after selected"], ["top", "Add at the top"], ["end", "Add at the end"]]
        .filter(([v]) => v !== "end" || sel !== "settings")
        .map(([v, l]) => h("option", { value: v, selected: v === "after" }, l))),
    h("button", { class: "small", "data-focus": "step-add-claude", onClick: () => add("claude") }, "+ Agent step"),
    h("button", { class: "small", "data-focus": "step-add-shell", onClick: () => add("shell") }, "+ Shell step"),
    h("select", { class: "small-select", title: "More step types", "aria-label": "More step types", onChange: (e) => { if (e.target.value) add(e.target.value); } },
      h("option", { value: "" }, "+ more…"),
      ["approval", "parallel", "flow"].map((t) => h("option", { value: t }, STEP_TYPES[t].label))),
    h("button", { class: "small", "data-focus": "step-add-library", onClick: () => onLibrary?.(at()) }, "+ From library"));
}

const problemMark = () => {
  const mark = h("span", { class: "mark-bad", "data-mark": "problem" }, glyph("!"), h("span", { class: "sr-only" }, "has a problem"));
  mark.hidden = true;
  return mark;
};

/** The list: "Flow settings", then a row per step. `sync()` refreshes the id and summary texts after an edit. */
function structureList(flow, sel, ctx) {
  const { onSelect } = ctx;
  const syncs = [];
  const row = (key, children, props) => h("button", { type: "button", class: "structure-row" + (sel === key ? " selected" : ""), "data-step": String(key), "data-focus": `flow-row-${key}`, "aria-current": sel === key ? "true" : null, onClick: () => onSelect(key), ...props }, children);

  const sum = h("span", { class: "sum" }, flow.name ?? "");
  syncs.push(() => { sum.textContent = flow.name ?? ""; });
  const rows = [row("settings", [h("span", { class: "num" }), h("span", {}), h("span", { class: "id" }, "Flow settings"), h("span", { class: "marks" }, problemMark()), sum])];
  flow.steps.forEach((s, i) => {
    const id = h("span", { class: "id" }, s.id ?? "");
    const su = h("span", { class: "sum" }, subtitle(s));
    syncs.push(() => { id.textContent = s.id ?? ""; su.textContent = subtitle(s); });
    rows.push(row(i, [
      h("span", { class: "num" }, `${i + 1}`),
      h("span", {}, glyph(STEP_TYPES[s.type]?.icon ?? "?"), h("span", { class: "sr-only" }, String(s.type))),
      id,
      h("span", { class: "marks" }, s.jump_only ? h("span", {}, glyph("↪"), h("span", { class: "sr-only" }, "only via jumps")) : null, problemMark()),
      su,
    ]));
  });
  return {
    el: h("div", { class: "structure" }, h("h3", { class: "mb-4" }, "Structure"), rows, insertBar(flow, sel, ctx)),
    sync: () => syncs.forEach((f) => f()),
  };
}

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** True when the visual editor can draw this value: `steps` is a list of objects and the settings blocks are objects. */
export function editable(flow) {
  if (!isObject(flow)) return false;
  if (flow.steps != null && !(Array.isArray(flow.steps) && flow.steps.every(isObject))) return false;
  return ["defaults", "vars", "limits", "sandbox", "publish"].every((k) => flow[k] == null || isObject(flow[k]));
}

/** Visual editor for a flow object. Field edits call onChange; structural edits call rerender. */
export function renderEditor(flow, ctx) {
  flow.steps ??= [];
  const sel = Number.isInteger(ctx.selected) && flow.steps[ctx.selected] ? ctx.selected : "settings";
  let structure;
  const inner = { ...ctx, selected: sel, onChange: () => { ctx.onChange(); structure.sync(); } };
  structure = structureList(flow, sel, inner);
  markProblems(structure.el, ctx.problems ?? []);
  return h("div", { class: "flow-form" }, structure.el,
    sel === "settings" ? settingsCard(flow, inner.onChange, ctx.rerender) : stepInspector(flow, flow.steps[sel], sel, inner));
}

/** Strip empty values so the YAML stays tidy. */
export function cleanFlow(flow) {
  const out = structuredClone(flow);
  const prune = (o, skip = []) => {
    for (const [k, v] of Object.entries(o)) {
      if (skip.includes(k)) continue;
      if (v === "" || v == null || (Array.isArray(v) && !v.length)) delete o[k];
      else if (typeof v === "object" && !Array.isArray(v)) {
        prune(v);
        if (!Object.keys(v).length) delete o[k];
      }
    }
  };
  // Empty values mean something in `vars` and in `publish.vars.*.default`, so those are kept as they are.
  prune(out, ["vars", "publish"]);
  for (const s of out.steps ?? []) prune(s);
  if (out.publish) {
    for (const k of ["name", "description"]) if (!out.publish[k]) delete out.publish[k];
    if (out.publish.vars && !Object.keys(out.publish.vars).length) delete out.publish.vars;
    if (!Object.keys(out.publish).length) delete out.publish;
  }
  if (out.vars && !Object.keys(out.vars).length) delete out.vars;
  return out;
}

// ── publish to users ──

/** Sets how a variable shows to users. "hidden" removes the entry; a mode change keeps label and help text. */
export function setPublishMode(flow, name, mode) {
  const vars = ((flow.publish ??= {}).vars ??= {});
  if (mode === "hidden") return void delete vars[name];
  const old = vars[name];
  if (old?.mode === mode) return;
  vars[name] = { mode, ...(old?.label ? { label: old.label } : {}), ...(old?.help ? { help: old.help } : {}) };
}

/** Follows a variable that was renamed (`to` is the new name) or removed (`to` is undefined). */
export function movePublishVar(flow, from, to) {
  const vars = flow.publish?.vars;
  if (!vars || !Object.hasOwn(vars, from) || from === to) return;
  const entries = Object.entries(vars).flatMap(([k, v]) => (k !== from ? [[k, v]] : to ? [[to, v]] : []));
  flow.publish.vars = Object.fromEntries(entries);
}

const MODES = [["hidden", "Hidden (admin default)"], ["fixed", "Fixed (shown, read-only)"], ["input", "User fills in"]];

/** The default of an input: its own value (even an empty one) or, when unticked, the flow's value. */
function defaultControl(flow, name, spec, onChange, rerender) {
  const own = Object.hasOwn(spec, "default");
  return h("div", { class: "field" },
    h("label", { class: "row tight text-sm" },
      h("input", { type: "checkbox", class: "fit", "data-field": `vars.${name}.own-default`, checked: own, onChange: (e) => {
        if (e.target.checked) spec.default = "";
        else delete spec.default;
        onChange();
        rerender();
      } }),
      h("span", {}, "Own default")),
    own
      ? h("input", { class: "mono", "data-field": `vars.${name}.default`, value: spec.default, placeholder: "default value", "aria-label": `Default value for ${name}`, onInput: (e) => { spec.default = e.target.value; onChange(); } })
      : h("small", { class: "muted" }, `Uses the flow's value: ${flow.vars?.[name] === "" || flow.vars?.[name] == null ? "(empty)" : String(flow.vars[name])}`));
}

function publishVarRow(flow, name, onChange, rerender) {
  const spec = flow.publish?.vars?.[name];
  return h("div", { class: "card-sub" },
    h("div", { class: "row" },
      h("strong", { class: "mono" }, name),
      h("select", { "data-field": `vars.${name}.mode`, "aria-label": `How ${name} shows to users`, onChange: (e) => { setPublishMode(flow, name, e.target.value); onChange(); rerender(); } },
        MODES.map(([v, l]) => h("option", { value: v, selected: (spec?.mode ?? "hidden") === v }, l)))),
    spec && spec.mode !== "hidden"
      ? h("div", { class: "grid" },
        field("Label", text(spec, "label", onChange, { placeholder: name, field: `vars.${name}.label` })),
        field("Help text", text(spec, "help", onChange, { field: `vars.${name}.help` })))
      : null,
    spec?.mode === "input"
      ? [
        h("label", { class: "row tight text-sm" },
          h("input", { type: "checkbox", class: "fit", "data-field": `vars.${name}.required`, checked: !!spec.required, onChange: (e) => { setKey(spec, "required", e.target.checked || ""); onChange(); } }),
          h("span", {}, "Required")),
        defaultControl(flow, name, spec, onChange, rerender),
      ]
      : null);
}

/** The "Publish to users" panel: what users may run and what they may fill in. */
export function publishPanel(flow, onChange, rerender) {
  const p = (flow.publish ??= {});
  const names = Object.keys(flow.vars ?? {});
  const stored = p.enabled != null || !!p.name || !!p.description || Object.keys(p.vars ?? {}).length > 0;
  return h("details", { "data-section": "publish", open: stored },
    h("summary", {}, p.enabled ? `Publish to users — version ${p.version ?? 1}` : "Publish to users"),
    h("label", { class: "row tight text-sm mt-6" },
      h("input", { type: "checkbox", class: "fit", "data-field": "enabled", checked: p.enabled === true, onChange: (e) => { setKey(p, "enabled", e.target.checked || ""); onChange(); rerender(); } }),
      h("span", {}, "Available to users")),
    h("div", { class: "grid" },
      field("Name for users", text(p, "name", onChange, { placeholder: flow.name ?? "" })),
      field("Description for users", text(p, "description", onChange, { placeholder: flow.description ?? "" }))),
    names.map((n) => publishVarRow(flow, n, onChange, rerender)),
    h("small", { class: "muted block mt-6" },
      "The version goes up by itself when you save a change. Runs keep the version they started with. A published flow cannot have sub-flow steps."));
}
