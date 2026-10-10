import YAML from "/vendor/yaml/index.js";
import { api } from "./api.js";
import { confirmDialog, glyph, h, modal, mount, toast } from "./dom.js";
import { emptyState, errorState, explainError, loadingState, permissionState } from "./states.js";

const RESERVED = ["next", "end", "fail", "stop"];
const CATEGORY_ORDER = ["GitHub", "Git", "Claude", "Agents", "Checks"];

const categoryOf = (b) => b.block?.category ?? "Invalid";

function byCategory(blocks) {
  const groups = new Map();
  for (const b of blocks) {
    const cat = categoryOf(b);
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(b);
  }
  const rank = (c) => (CATEGORY_ORDER.indexOf(c) + 1 || 99);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Blocks that match the text (id, name, description, category, scope) and the category. "" means all. */
export function filterBlocks(blocks, { q = "", category = "" } = {}) {
  const text = String(q ?? "").trim().toLowerCase();
  return blocks.filter((b) => {
    if (category && categoryOf(b) !== category) return false;
    if (!text) return true;
    return [b.id, b.block?.name, b.block?.description, categoryOf(b), b.scope].map((x) => x ?? "").join("\n").toLowerCase().includes(text);
  });
}

/** "12 blocks", "1 block", or "3 of 12 blocks" when a filter hides some. */
export function countText(shown, total) {
  const noun = total === 1 ? "block" : "blocks";
  return shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
}

/** What inserting a block does: new ids, the cloned steps with their references mapped, and the variables to add. */
function planInsert(flow, block) {
  const taken = new Set((flow.steps ?? []).map((s) => s.id));
  const rename = new Map();
  for (const s of block.steps) {
    let id = s.id;
    for (let n = 2; taken.has(id); n++) id = `${s.id}${n}`;
    rename.set(s.id, id);
    taken.add(id);
  }
  const to = (id) => (typeof id === "string" && rename.has(id) ? rename.get(id) : id);
  const steps = block.steps.map((s) => {
    const c = structuredClone(s);
    c.id = rename.get(s.id);
    for (const k of ["on_success", "on_failure", "resume", "resume_from"]) if (c[k]) c[k] = to(c[k]);
    for (const r of c.routes ?? []) if (r.goto) r.goto = to(r.goto);
    if (c.type === "parallel" && Array.isArray(c.steps)) c.steps = c.steps.map(to);
    return c;
  });
  const have = flow.vars ?? {};
  const vars = Object.fromEntries(Object.entries(block.vars ?? {}).filter(([k]) => !Object.hasOwn(have, k)));
  return { rename, steps, vars };
}

const renamedOf = (rename) => [...rename].filter(([a, b]) => a !== b);

/** What insertBlock would do, without changing the flow. */
export function previewInsert(flow, block) {
  const plan = planInsert(flow, block);
  return { steps: plan.steps.map((s) => ({ id: s.id, type: s.type })), vars: plan.vars, renamed: renamedOf(plan.rename) };
}

/** Insert a block's steps at `at`, renaming ids that already exist (and the block's own references to them). */
export function insertBlock(flow, block, at) {
  const plan = planInsert(flow, block);
  flow.steps.splice(at, 0, ...plan.steps);
  // Rebuilt, not assigned key by key: a variable named __proto__ must stay a data property.
  flow.vars = Object.fromEntries([...Object.entries(flow.vars ?? {}), ...Object.entries(plan.vars)]);
  return { count: plan.steps.length, renamed: renamedOf(plan.rename) };
}

function blockCard(b, onClick) {
  const blk = b.block;
  return h("button", { class: "block-card", onClick, disabled: !blk, title: b.error ?? "", "data-focus": `block-${b.id}` },
    h("span", { class: "row" }, h("b", {}, blk?.name ?? b.id), h("span", { class: "spacer" }),
      blk ? null : h("span", { class: "pill fail" }, "Invalid"), h("span", { class: "pill" }, b.scope)),
    h("span", { class: "muted d" }, blk?.description ?? b.error ?? ""),
    h("span", { class: "chips" }, (blk?.steps ?? []).map((s) =>
      h("span", { class: `pill ${s.type}` }, glyph(s.type === "claude" ? "◆" : "$"), " ", h("span", { class: "sr-only" }, s.type === "claude" ? "Agent step: " : "Shell step: "), `${s.id}${s.jump_only ? " ↪" : ""}`))));
}

/** Search box and category select; `filter` ({ q, category }) is changed in place and `onChange` is called after each change. */
function filterControls(blocks, filter, onChange) {
  const input = h("input", { type: "search", placeholder: "Search blocks…", value: filter.q, "data-focus": "block-search", onInput: () => { filter.q = input.value; onChange(); } });
  const select = h("select", { "data-focus": "block-category", onChange: () => { filter.category = select.value; onChange(); } },
    h("option", { value: "" }, "All categories"),
    byCategory(blocks).map(([cat]) => h("option", { value: cat }, cat)));
  select.value = filter.category;
  const f = (label, el) => h("label", { class: "field" }, h("span", {}, label), el);
  return h("div", { class: "grid" }, f("Search", input), f("Category", select));
}

/** The blocks by category; `item(b)` draws one block. */
const blockGroups = (hits, item) => byCategory(hits).map(([cat, list]) =>
  h("div", { class: "block-group" }, h("h3", {}, cat), h("div", { class: "block-grid" }, list.map(item))));

/** What a block will add, before anything changes. */
function previewView(b, plan, { onBack, onInsert }) {
  const blk = b.block;
  const vars = Object.entries(plan.vars);
  const was = new Map(plan.renamed.map(([from, to]) => [to, from]));
  return h("div", { class: "stack" },
    h("div", { class: "row" }, h("h3", {}, blk.name), h("span", { class: "pill" }, b.scope), h("span", { class: "pill" }, categoryOf(b))),
    blk.description ? h("p", { class: "muted" }, blk.description) : null,
    h("h4", {}, `Steps (${plan.steps.length})`),
    h("ul", {}, plan.steps.map((s) => h("li", {},
      h("span", { class: "mono" }, s.id), " ", h("span", { class: "pill" }, s.type),
      was.has(s.id) ? h("span", { class: "muted" }, ` (was ${was.get(s.id)})`) : null))),
    h("h4", {}, "Variables added"),
    vars.length ? h("ul", {}, vars.map(([k, v]) => h("li", { class: "mono" }, `${k} = ${v}`))) : h("p", { class: "muted" }, "No variables are added."),
    plan.renamed.length ? [
      h("h4", {}, "Renamed ids"),
      h("p", { class: "muted" }, "These ids already exist in the flow, so the new steps get another id."),
      h("ul", {}, plan.renamed.map(([from, to]) => h("li", { class: "mono" }, `${from} → ${to}`))),
    ] : null,
    h("div", { class: "row" }, h("span", { class: "spacer" }),
      h("button", { type: "button", onClick: onBack }, "Back"),
      h("button", { type: "button", class: "primary", "data-focus": "block-insert", onClick: onInsert }, "Insert")));
}

/** Modal to pick a block, with a preview before anything changes. Resolves with the block listing after "Insert", else undefined. */
export async function pickBlock(flow) {
  const blocks = await api.blocks();
  return modal("Insert from library", (close) => {
    const filter = { q: "", category: "" };
    const list = h("div");
    const box = h("div");
    const focusIn = (name) => [...box.querySelectorAll("[data-focus]")].find((el) => el.getAttribute("data-focus") === name)?.focus();
    const drawList = () => {
      const hits = filterBlocks(blocks, filter);
      mount(list, hits.length
        ? blockGroups(hits, (b) => blockCard(b, () => showPreview(b)))
        : emptyState("No blocks match.", { label: "Clear filters", onClick: () => { filter.q = ""; filter.category = ""; showList(); } }));
    };
    const showList = (focusId) => {
      mount(box, h("div", { class: "stack" }, filterControls(blocks, filter, drawList), list));
      drawList();
      focusIn(focusId ? `block-${focusId}` : "block-search");
    };
    const showPreview = (b) => {
      if (!b.block) return;
      mount(box, previewView(b, previewInsert(flow, b.block), { onBack: () => showList(b.id), onInsert: () => close(b) }));
      focusIn("block-insert");
    };
    showList();
    return box;
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
  const filter = { q: "", category: "" };
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
  const draw = (items) => {
    if (filter.category && !items.some((b) => categoryOf(b) === filter.category)) filter.category = "";
    const count = h("span", { class: "muted" });
    const list = h("div");
    const drawList = () => {
      const hits = filterBlocks(items, filter);
      count.textContent = countText(hits.length, items.length);
      mount(list, !items.length
        ? emptyState("No blocks yet.")
        : !hits.length
          ? emptyState("No blocks match.", { label: "Clear filters", onClick: () => { filter.q = ""; filter.category = ""; draw(items); } })
          : blockGroups(hits, (b) => h("div", { class: "block-item" },
            blockCard(b, null),
            h("details", {}, h("summary", {}, "YAML"), h("pre", { class: "mono" }, b.yaml)),
            b.scope !== "builtin" ? h("button", { class: "small danger", onClick: () => remove(b) }, "Delete") : null)));
    };
    mount(box,
      h("div", { class: "toolbar" }, h("h1", {}, "Block library"), count),
      h("p", { class: "muted mt-neg-6" },
        "Reusable steps you can drop into any flow with “+ From library”. Create your own with “☆ Save as block” on any step."),
      items.length ? filterControls(items, filter, drawList) : null,
      failure,
      list);
    drawList();
  };
  await load();
}
