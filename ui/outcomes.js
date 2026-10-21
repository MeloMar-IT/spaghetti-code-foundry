import { h, mount, table } from "./dom.js";
import { loadingState } from "./states.js";

export const OUTCOME_WINDOWS = [7, 30, 90];

/** Mirrors `outcomeText` in src/outcomes.ts: "—" for no value; ms as minutes or hours, share as %, usd as $0.00. */
export function outcomeValueText(def, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  switch (def?.unit) {
    case "ms": return value < 3_600_000 ? `${Math.round(value / 60_000)} min` : `${Math.round(value / 360_000) / 10} h`;
    case "share": return `${Math.round(value * 1000) / 10}%`;
    case "usd": return `$${value.toFixed(2)}`;
    default: return String(value);
  }
}

const NOUNS = { runs: ["run", "runs"], "work items": ["work item", "work items"], accounts: ["account", "accounts"] };

/** "1 run", "3 runs", "2 work items". An unknown `countOf` gives the bare number. */
export function countText(n, countOf) {
  const words = NOUNS[countOf];
  const num = Number.isFinite(n) ? n : 0;
  return words ? `${num} ${num === 1 ? words[0] : words[1]}` : String(num);
}

/** Groups: each speed or cost measure with the measures to read with it, then the rest as "Other measures". */
export function outcomeGroups(definitions) {
  const defs = Array.isArray(definitions) ? definitions.filter((d) => d && typeof d.id === "string") : [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  const used = new Set();
  const groups = [];
  for (const lead of defs.filter((d) => d.category === "speed" || d.category === "cost")) {
    const paired = (Array.isArray(lead.pairedWith) ? lead.pairedWith : []).map((id) => byId.get(id)).filter(Boolean);
    const items = [lead, ...paired];
    items.forEach((d) => used.add(d.id));
    groups.push({ title: lead.label, caption: `${lead.label} and the measures to read with it`, items });
  }
  const rest = defs.filter((d) => !used.has(d.id));
  if (rest.length) groups.push({ title: "Other measures", caption: "Other measures", items: rest });
  return groups;
}

/** One group as a table. `measuresById`: Map of id to { value, counted, excluded }. */
export function outcomeTable(group, measuresById) {
  const rows = group.items.map((def) => {
    const m = measuresById.get(def.id) ?? { value: null, counted: 0, excluded: 0 };
    const d = def.decision ?? {};
    const extra = d.detector ? ` Detector: ${d.detector}` : d.setting ? ` Setting: ${d.setting}` : "";
    return h("tr", {},
      h("td", {}, def.label),
      h("td", { class: "mono" }, outcomeValueText(def, m.value)),
      h("td", {}, countText(m.counted, def.countOf)),
      h("td", {}, countText(m.excluded, "runs")),
      h("td", {}, def.owner),
      h("td", {}, d.text, extra ? h("span", { class: "muted text-sm" }, extra) : null),
      h("td", {}, h("details", {},
        h("summary", {}, "Definition and exclusions", h("span", { class: "sr-only" }, ` of ${def.label}`)),
        h("p", {}, def.definition),
        h("p", {}, "Not counted: ", def.exclusions))));
  });
  return table(["Measure", "Value", "Counted", "Left out", "Owner", "Decision", "Definition and exclusions"], rows, { cards: true, caption: group.caption });
}

/**
 * The Outcomes card. `load(params)` fetches the answer of GET /api/outcomes, `note(what, error, retry)` draws a failure.
 * Returns the card and `ready`, the promise of the latest load (it never rejects).
 */
export function outcomesSection({ load, note }) {
  const state = { repo: "", flow: "", model: "", policy: "", days: "30" };
  let loads = 0;
  let latest = Promise.resolve();
  const result = h("div", {});

  const select = (name) => h("select", { name, class: "small-select", onChange: (e) => { state[name] = e.target.value; reload(); } });
  const repoSel = select("repo");
  const flowSel = select("flow");
  const modelSel = select("model");
  const policySel = select("policy");
  const daysSel = select("days");
  mount(daysSel, OUTCOME_WINDOWS.map((d) => h("option", { value: String(d) }, `${d} days`)));
  daysSel.value = state.days;
  const wrap = (text, sel) => h("label", { class: "row" }, h("span", { class: "muted" }, text), sel);
  const modelLabel = wrap("Model route", modelSel);
  const policyLabel = wrap("Policy version", policySel);
  modelLabel.hidden = true;
  policyLabel.hidden = true;

  const el = h("div", { class: "card span-all" }, h("h3", {}, "Outcomes"),
    h("p", { class: "muted" }, "Every speed or cost number is shown with the numbers to read it with. — means there is no value; Left out counts the runs that were not counted."),
    h("div", { class: "toolbar" }, wrap("Repository", repoSel), wrap("Flow", flowSel), modelLabel, policyLabel, wrap("Window", daysSel)),
    result);

  function fillSelect(sel, allText, list, current) {
    const items = Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
    if (current && !items.includes(current)) items.push(current);
    mount(sel, [h("option", { value: "" }, allText), ...items.map((x) => h("option", { value: x }, x))]);
    sel.value = current;
  }

  function fill(data) {
    const values = data?.values ?? {};
    fillSelect(repoSel, "All repositories", values.repos, state.repo);
    fillSelect(flowSel, "All flows", values.flows, state.flow);
    const hasModels = Array.isArray(values.models);
    const hasPolicies = Array.isArray(values.policies);
    if (hasModels) fillSelect(modelSel, "All model routes", values.models, state.model);
    if (hasPolicies) fillSelect(policySel, "All policy versions", values.policies, state.policy);
    modelLabel.hidden = !hasModels;
    policyLabel.hidden = !hasPolicies;
    const defs = Array.isArray(data?.definitions) ? data.definitions : [];
    if (!defs.length) return mount(result, h("p", { class: "muted" }, "No outcome measures yet."));
    const byId = new Map((Array.isArray(data.measures) ? data.measures : []).filter((m) => m && m.id).map((m) => [m.id, m]));
    mount(result, outcomeGroups(defs).flatMap((g) => [h("h4", {}, g.title), outcomeTable(g, byId)]));
  }

  function reload() {
    const my = ++loads;
    mount(result, loadingState("Loading the outcomes…", { rows: 4, shape: "table" }));
    const params = {};
    for (const k of ["repo", "flow", "model", "policy"]) if (state[k]) params[k] = state[k];
    params.days = Number(state.days);
    let started;
    try { started = Promise.resolve(load(params)); } catch (e) { started = Promise.reject(e); }
    latest = started.then(
      (data) => { if (my === loads) fill(data); },
      (e) => { if (my === loads) mount(result, note("the outcomes", e, reload)); });
  }

  reload();
  return { el, get ready() { return latest; } };
}
