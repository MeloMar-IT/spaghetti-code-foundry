// Start work: pick a flow, a repository, fill in the fields and start. The server does every real check
// (published flow, inputs, ownership); this page only shows its answer. Relative imports, so a test can load it:
// in the browser "../api.js" from /user/start.js is the same module as "/api.js". The admin display uses the page too.
import { api } from "../api.js";
import { errorText } from "../auth.js";
import { h, mount, toast } from "../dom.js";
import { connectionStatus, repoDialog } from "../repos.js";

export const REPO_FIELD = "github_repo";
export const NO_FLOWS = "No flows yet. Ask your administrator to publish one.";
export const NO_FLOWS_ADMIN = "No published flows yet. Publish one in the flow editor.";
export const NO_REPOS = "You have no GitHub repository yet. Add the repository you work in.";

/** The records that are GitHub repositories (they have a name as "owner/name"). */
export const githubRepos = (repos) => (Array.isArray(repos) ? repos : []).filter((r) => typeof r?.github === "string" && r.github !== "");

/** `wanted` (any case) when it is listed, else the first one, else "". */
export function pickRepo(repos, wanted) {
  const list = githubRepos(repos);
  const hit = list.find((r) => r.github.toLowerCase() === String(wanted ?? "").toLowerCase());
  return (hit ?? list[0])?.github ?? "";
}

/** The `github` name of the record the dialog made, when the new list holds it; else "". */
export function addedRepo(created, after) {
  if (!created || typeof created.github !== "string" || !created.github) return "";
  return githubRepos(after).some((r) => r.id === created.id) ? created.github : "";
}

/** The first required input that is empty: { field, text }, or null. */
export function startProblem(flow, values) {
  for (const f of flow.fields) {
    if (f.mode !== "input" || !f.required) continue;
    if (String(values[f.name] ?? "").trim() !== "") continue;
    return { field: f.name, text: f.name === REPO_FIELD ? "Choose a repository." : `Fill in "${f.label}".` };
  }
  return null;
}

/** The body of POST /api/runs: only inputs. No repository chosen means no `github_repo`, so the server decides. */
export function startBody(flow, task, values) {
  const vars = {};
  for (const f of flow.fields) {
    if (f.mode !== "input" || values[f.name] === undefined) continue;
    if (f.name === REPO_FIELD && values[f.name] === "") continue;
    vars[f.name] = values[f.name];
  }
  return { flow: flow.name, task: flow.usesTask === false ? "" : task, vars };
}

const fixedField = (f, label) =>
  h("div", { class: "field" }, h("span", {}, label), h("span", { class: "mono" }, f.value === "" ? "—" : f.value), f.help ? h("small", {}, f.help) : null);

/** The Start work page. Returns a cleanup. */
export async function renderStart(main, { a = api, dialog = repoDialog, go = (hash) => { location.hash = hash; }, admin = false, readOnly = false } = {}) {
  const flows = admin ? await a.flows(true) : await a.flows();
  if (!Array.isArray(flows) || flows.length === 0) {
    mount(main, h("h1", {}, "Start work"), h("div", { class: "empty" }, admin ? NO_FLOWS_ADMIN : NO_FLOWS));
    return () => {};
  }
  let gone = false;
  let busy = false;
  let drawn = 0;
  const state = { flow: flows[0], task: "", values: {} };
  let loading = false;
  for (const f of flows) state.values[f.name] = Object.fromEntries(f.fields.filter((x) => x.mode === "input").map((x) => [x.name, x.value]));

  // Repositories are only asked for when the chosen flow needs one, so a failing list cannot block other flows.
  const repoData = { repos: undefined, options: undefined, error: "" };
  const needsRepos = (flow) => flow.fields.some((f) => f.name === REPO_FIELD && f.mode === "input");
  async function loadRepos() {
    if (repoData.repos) return;
    try {
      const [repos, options] = await Promise.all([a.repos(), a.repoMethods().catch(() => undefined)]);
      repoData.repos = githubRepos(repos);
      repoData.options = options;
      repoData.error = "";
    } catch (e) {
      repoData.error = errorText(e);
    }
  }

  const taskBox = h("textarea", { name: "task", rows: 5 });
  taskBox.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault?.();
      submit();
    }
  });
  let controls = {};
  let repoSelect = null;
  let addBtn = null;
  const err = h("p", { class: "status bad", role: "alert" });
  const submitBtn = h("button", { class: "primary", type: "submit" }, "Start");
  const rest = h("div", { class: "start-rest" });

  /** Copies what is typed into the state, before every redraw and at submit. */
  function keep() {
    state.task = taskBox.value;
    const mine = state.values[state.flow.name];
    for (const [name, el] of Object.entries(controls)) mine[name] = el.value;
    if (repoSelect) mine[REPO_FIELD] = repoSelect.value;
  }

  function repoStep(field, n) {
    const legend = h("legend", {}, `${n}. Repository`);
    if (field.mode === "fixed") return h("fieldset", {}, legend, fixedField(field, field.label === REPO_FIELD ? "Repository" : field.label));
    const list = repoData.repos ?? [];
    // a preview never adds anything
    const add = readOnly ? null : h("button", { type: "button", "data-focus": "add-repo", onClick: addRepository }, "Add repository");
    addBtn = add;
    const addRow = add ? h("div", { class: "row" }, add) : null;
    if (!list.length) {
      return h("fieldset", {}, legend, repoData.error ? h("p", { class: "status bad" }, repoData.error) : null, h("p", { class: "muted" }, NO_REPOS), addRow);
    }
    repoSelect = h("select", { name: REPO_FIELD, "aria-required": field.required ? "true" : null },
      list.map((r) => h("option", { value: r.github }, `${r.github} — ${connectionStatus(r)}`)));
    const mine = state.values[state.flow.name];
    repoSelect.value = pickRepo(list, mine[REPO_FIELD]);
    mine[REPO_FIELD] = repoSelect.value;
    return h("fieldset", {}, legend,
      h("label", { class: "field" }, h("span", {}, field.label === REPO_FIELD ? "Repository" : field.label, field.required ? h("span", { class: "req" }, " (required)") : null), repoSelect, field.help ? h("small", {}, field.help) : null),
      addRow);
  }

  function detailsStep(n) {
    const flow = state.flow;
    const rows = [];
    if (flow.usesTask !== false) rows.push(h("label", { class: "field" }, h("span", {}, "Task"), taskBox));
    for (const f of flow.fields) {
      if (f.name === REPO_FIELD) continue;
      if (f.mode === "fixed") {
        rows.push(fixedField(f, f.label));
        continue;
      }
      const input = h("input", { name: f.name, type: "text", autocomplete: "off", "aria-required": f.required ? "true" : null, value: state.values[flow.name][f.name] ?? "" });
      controls[f.name] = input;
      rows.push(h("label", { class: "field" }, h("span", {}, f.label, f.required ? h("span", { class: "req" }, " (required)") : null), input, f.help ? h("small", {}, f.help) : null));
    }
    return rows.length ? h("fieldset", {}, h("legend", {}, `${n}. Task and details`), rows) : null;
  }

  function drawRest() {
    controls = {};
    repoSelect = null;
    addBtn = null;
    const field = state.flow.fields.find((f) => f.name === REPO_FIELD);
    const repo = field ? repoStep(field, 2) : null;
    mount(rest, repo, detailsStep(field ? 3 : 2));
  }

  function flowStep() {
    return h("fieldset", {}, h("legend", {}, "1. Flow"),
      flows.map((f) => {
        const radio = h("input", { type: "radio", name: "flow", value: f.name, checked: f === state.flow });
        radio.addEventListener("change", () => choose(f));
        return h("label", { class: "choice" }, radio, h("b", {}, f.title), f.description ? h("span", { class: "muted" }, f.description) : null);
      }));
  }

  async function choose(flow) {
    keep();
    const mine = ++drawn;
    // The controls on the page belong to state.flow until the new flow is ready; Start waits meanwhile.
    if (needsRepos(flow) && !repoData.repos) {
      loading = true;
      submitBtn.disabled = true;
      await loadRepos();
      if (gone || mine !== drawn) return;
    }
    loading = false;
    submitBtn.disabled = busy;
    state.flow = flow;
    drawRest();
  }

  async function addRepository() {
    keep();
    err.textContent = "";
    const created = await dialog({ admin, options: repoData.options });
    try {
      const after = await a.repos();
      repoData.repos = githubRepos(after);
      repoData.error = "";
      const wanted = addedRepo(created, after);
      if (wanted) state.values[state.flow.name][REPO_FIELD] = wanted;
    } catch (e) {
      err.textContent = errorText(e);
      return;
    }
    if (!gone) drawRest();
  }

  async function submit() {
    if (readOnly) return;
    if (busy || loading) return;
    keep();
    const flow = state.flow;
    const values = { ...state.values[flow.name] };
    // only a repository that is listed and chosen is sent; a default that is not listed is not
    if (needsRepos(flow)) values[REPO_FIELD] = repoSelect ? repoSelect.value : "";
    const problem = startProblem(flow, values);
    if (problem) {
      err.textContent = problem.text;
      (controls[problem.field] ?? (problem.field === REPO_FIELD ? repoSelect ?? addBtn : null))?.focus();
      return;
    }
    busy = true;
    submitBtn.disabled = true;
    err.textContent = "";
    try {
      const body = startBody(flow, state.task, values);
      const run = await a.startRun(admin ? { ...body, likeUser: true } : body);
      if (gone) return toast("Run started");
      go("#/runs/" + run.runId);
    } catch (e) {
      busy = false;
      if (gone) return toast(errorText(e), "error");
      err.textContent = errorText(e);
      submitBtn.disabled = false;
    }
  }

  if (needsRepos(state.flow)) await loadRepos();
  drawRest();
  const form = h("form", { class: "start-form", novalidate: true, onSubmit: (e) => { e?.preventDefault?.(); submit(); } },
    flowStep(), rest, err, readOnly ? null : h("div", { class: "row" }, submitBtn));
  mount(main, h("h1", {}, "Start work"), form);
  return () => { gone = true; };
}
