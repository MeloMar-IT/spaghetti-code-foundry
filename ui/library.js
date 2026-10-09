import YAML from "/vendor/yaml/index.js";
import { api } from "./api.js";
import { confirmDialog, glyph, h, modal, mount, toast } from "./dom.js";
import { emptyState, errorState, explainError, loadingState, permissionState } from "./states.js";

const RESERVED = ["next", "end", "fail", "stop"];
const CATEGORY_ORDER = ["GitHub", "Git", "Claude", "Agents", "Checks"];

function byCategory(blocks) {
  const groups = new Map();
  for (const b of blocks) {
    const cat = b.block?.category ?? "Invalid";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(b);
  }
  const rank = (c) => (CATEGORY_ORDER.indexOf(c) + 1 || 99);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Insert a block's steps at `at`, renaming ids that already exist (and the block's own references to them). */
export function insertBlock(flow, block, at) {
  const taken = new Set(flow.steps.map((s) => s.id));
  const rename = {};
  for (const s of block.steps) {
    let id = s.id;
    for (let n = 2; taken.has(id); n++) id = `${s.id}${n}`;
    rename[s.id] = id;
    taken.add(id);
  }
  const steps = block.steps.map((s) => {
    const c = structuredClone(s);
    c.id = rename[s.id];
    for (const k of ["on_success", "on_failure", "resume"]) if (c[k] && rename[c[k]]) c[k] = rename[c[k]];
    return c;
  });
  flow.steps.splice(at, 0, ...steps);
  flow.vars ??= {};
  for (const [k, v] of Object.entries(block.vars ?? {})) if (!(k in flow.vars)) flow.vars[k] = v;
  const renamed = Object.entries(rename).filter(([a, b]) => a !== b);
  return { count: steps.length, renamed };
}

function blockCard(b, onClick) {
  const blk = b.block;
  return h("button", { class: "block-card", onClick, disabled: !blk, title: b.error ?? "" },
    h("span", { class: "row" }, h("b", {}, blk?.name ?? b.id), h("span", { class: "spacer" }), b.scope !== "builtin" ? h("span", { class: "pill" }, b.scope) : null),
    h("span", { class: "muted d" }, blk?.description ?? b.error ?? ""),
    h("span", { class: "chips" }, (blk?.steps ?? []).map((s) =>
      h("span", { class: `pill ${s.type}` }, glyph(s.type === "claude" ? "◆" : "$"), " ", h("span", { class: "sr-only" }, s.type === "claude" ? "Agent step: " : "Shell step: "), `${s.id}${s.jump_only ? " ↪" : ""}`))));
}

/** Modal to pick a block. Resolves with the block listing or undefined. */
export async function pickBlock() {
  const blocks = await api.blocks();
  return modal("Insert from library", (close) => {
    const list = h("div");
    const search = h("input", { placeholder: "Search blocks…", onInput: () => draw() });
    const draw = () => {
      const q = search.value.toLowerCase();
      const hits = blocks.filter((b) => !q || `${b.id} ${b.block?.name} ${b.block?.description} ${b.block?.category}`.toLowerCase().includes(q));
      mount(list, byCategory(hits).map(([cat, items]) =>
        h("div", { class: "block-group" }, h("h3", {}, cat), h("div", { class: "block-grid" }, items.map((b) => blockCard(b, () => close(b)))))));
    };
    draw();
    return h("div", { class: "stack" }, search, list);
  });
}

/** Variables a step refers to, via {{vars.x}} or $FACTORY_VAR_X / $SCF_VAR_X. */
function referencedVars(step, flowVars) {
  const text = JSON.stringify(step);
  return Object.fromEntries(Object.entries(flowVars ?? {}).filter(([k]) => {
    const suffix = k.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    return text.includes(`vars.${k}`) || text.includes(`FACTORY_VAR_${suffix}`) || text.includes(`SCF_VAR_${suffix}`);
  }));
}

/** The form of "Save step as block". Resolves with the typed values, or undefined when it is closed. `info` (an explained error) is drawn above the buttons. */
function blockForm(values, categories, info) {
  return modal("Save step as block", (close) => {
    const id = h("input", { class: "mono", value: values.id });
    const name = h("input", { value: values.name });
    const category = h("input", { value: values.category, list: "block-cats" });
    const description = h("input", { placeholder: "What this block does", value: values.description });
    const scope = h("select", {}, h("option", { value: "global", selected: values.scope === "global" }, "global (all repos)"), h("option", { value: "repo", selected: values.scope === "repo" }, "this repo"));
    scope.value = values.scope;
    const err = h("p", { class: "status bad flush" });
    const save = h("button", { class: "primary", onClick: () => {
      if (!/^[\w-]+$/.test(id.value)) return (err.textContent = "Id may only contain letters, digits, _ and -");
      close({ id: id.value, name: name.value, category: category.value, description: description.value, scope: scope.value });
    } }, "Save block");
    const f = (label, el) => h("label", { class: "field" }, h("span", {}, label), el);
    return h("div", { class: "stack" },
      h("datalist", { id: "block-cats" }, categories.map((c) => h("option", { value: c }))),
      h("div", { class: "grid" }, f("Id (file name)", id), f("Category", category)),
      f("Name", name), f("Description", description), f("Save to", scope),
      h("small", { class: "muted" }, "Jumps to other steps are removed so the block works in any flow."),
      info ? errorState(info) : null,
      err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  });
}

/** The YAML of a block made from one step and the vars it uses. */
function blockYaml(flow, step, v) {
  const s = structuredClone(step);
  // Blocks must be self-contained: drop jumps/resume that point at other steps.
  for (const k of ["on_success", "on_failure"]) if (s[k] && !RESERVED.includes(s[k])) delete s[k];
  delete s.resume;
  const block = { name: v.name || v.id, category: v.category || "Custom", description: v.description || undefined, vars: referencedVars(step, flow.vars), steps: [s] };
  if (!Object.keys(block.vars).length) delete block.vars;
  return YAML.stringify(block, { lineWidth: 0 });
}

/** Save one step (plus the vars it uses) as a reusable block. The form closes before the request, so a failure or a "no" reopens it with the typed values. */
export async function saveStepAsBlock(flow, step) {
  const blocks = await api.blocks();
  const categories = [...new Set(blocks.map((b) => b.block?.category).filter(Boolean))];
  let values = { id: step.id.replace(/_/g, "-"), name: step.description ?? step.id, category: "Custom", description: "", scope: "global" };
  let info;
  for (;;) {
    const typed = await blockForm(values, categories, info);
    if (!typed) return;
    values = typed;
    info = undefined;
    if (blocks.some((b) => b.id === typed.id && b.scope !== "builtin")
      && !(await confirmDialog({ title: "Overwrite block?", text: `Overwrite block "${typed.id}"?`, confirm: "Overwrite" }))) continue;
    try {
      await api.saveBlock(typed.id, blockYaml(flow, step, typed), typed.scope);
    } catch (e) {
      info = explainError(e, { what: "The block was not saved.", safe: "Your entries are kept. Nothing was changed." });
      // Another dialog was opened meanwhile: do not replace it; say what happened instead.
      if (document.getElementById("modal-root").children.length) return toast(`The block "${typed.id}" was not saved. ${e.message}`, "error");
      continue;
    }
    return toast(`Saved block "${typed.id}" to the library`);
  }
}

/** The Library page: browse blocks, view their YAML, delete your own. */
export async function renderLibrary(main) {
  // The page draws into its own box, so an answer that comes after another page was mounted cannot touch it.
  const box = h("div");
  mount(main, box);
  const failure = h("div");
  const deleting = new Set();
  let gen = 0;
  const load = async () => {
    const mine = ++gen;
    mount(box, loadingState("Loading library…", { shape: "cards" }));
    let blocks;
    try {
      blocks = await api.blocks();
    } catch (e) {
      if (mine !== gen) return;
      mount(box, Number(e?.status) === 403
        ? permissionState("You may not open the block library.")
        : errorState(explainError(e, { what: "The library could not be loaded." }), { onRetry: load }));
      return;
    }
    if (mine === gen) draw(blocks);
  };
  const doDelete = async (b) => {
    if (deleting.has(b.id)) return;
    deleting.add(b.id);
    try {
      await api.deleteBlock(b.id);
    } catch (e) {
      mount(failure, errorState(explainError(e, { what: `The block "${b.id}" was not deleted.`, safe: "The block is still in the library." }), { onRetry: () => doDelete(b) }));
      return;
    } finally {
      deleting.delete(b.id);
    }
    mount(failure, null);
    toast(`Deleted block "${b.id}"`);
    await load();
  };
  const remove = async (b) => {
    if (!(await confirmDialog({ title: "Delete block?", text: `Delete block "${b.id}"?`, confirm: "Delete" }))) return;
    await doDelete(b);
  };
  const draw = (items) => mount(box,
    h("div", { class: "toolbar" }, h("h1", {}, "Block library"), h("span", { class: "muted" }, `${items.length} blocks`)),
    h("p", { class: "muted mt-neg-6" },
      "Reusable steps you can drop into any flow with “+ From library”. Create your own with “☆ Save as block” on any step."),
    failure,
    items.length ? null : emptyState("No blocks yet."),
    byCategory(items).map(([cat, list]) => h("div", { class: "block-group" }, h("h3", {}, cat),
      h("div", { class: "block-grid" }, list.map((b) => h("div", { class: "block-item" },
        blockCard(b, null),
        h("details", {}, h("summary", {}, "YAML"), h("pre", { class: "mono" }, b.yaml)),
        b.scope !== "builtin" ? h("button", { class: "small danger", onClick: () => remove(b) }, "Delete") : null))))));
  await load();
}
