// Start work: required decisions first (repository, task, required inputs), the rest under "More options"; a flow
// picker only with several flows. The server does every real check
// (published flow, inputs, ownership); this page only shows its answer. "Review" shows what will be sent, "Start" sends
// it; the draft is kept in page memory (start-draft.js). The choices of how to begin (start-entry.js) come above. Relative imports, so a test can load it:
// in the browser "../api.js" from /user/start.js is the same module as "/api.js". The admin display uses the page too.
import { api } from "../api.js";
import { errorText } from "../auth.js";
import { h, mount, toast } from "../dom.js";
import { clearInvalid, markInvalid } from "../fields.js";
import { onWish, takeWish } from "../palette-data.js";
import { connectionStatus, repoDialog } from "../repos.js";
import { emptyState, errorState, explainError, loadingState, permissionState } from "../states.js";

import { entryChoices } from "./start-entry.js";
import { clearDraft, draftRevision, DRAFT_LINE, readDraft, REPO_FIELD, restoreDraft, reviewView, writeDraft } from "./start-draft.js";

export { REPO_FIELD };
export const NO_FLOWS = "No flows yet. Ask your administrator to publish one.";
export const NO_FLOWS_ADMIN = "No published flows yet. Publish one in the flow editor.";
export const NO_REPOS = "You have no GitHub repository yet. Add the repository you work in.";
export const FLOWS_FAILED = "The flows could not be loaded.";
export const FLOWS_DENIED = "You are not allowed to start work.";
export const REPOS_FAILED = "Your repositories could not be loaded.";
export const REPOS_FAILED_SAFE = "Nothing was changed. A flow that needs no repository still works.";
export const START_FAILED = "The run could not be started.";
export const START_KEPT = "What you typed is still here.";
export const START_UNSURE = "The run may have started or not. What you typed is still here.";
export const START_UNSURE_NEXT = "Check your runs first. Try again only if no run was created.";

/** The server's answer to Start in the three parts errorState needs. No answer or a 5xx: the run may exist. */
export function explainStart(e) {
  const info = explainError(e, { what: START_FAILED });
  if (info.kind === "offline" || info.kind === "server") return { ...info, safe: START_UNSURE, next: START_UNSURE_NEXT };
  return { ...info, safe: `${info.safe} ${START_KEPT}` };
}

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

/** The first required input that is empty, in the order the page shows them: { field, text }, or null. */
export function startProblem(flow, values) {
  // the page shows the repository first, then the other fields
  const shown = [...flow.fields.filter((f) => f.name === REPO_FIELD), ...flow.fields.filter((f) => f.name !== REPO_FIELD)];
  for (const f of shown) {
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

export const MORE_OPTIONS = "More options";
export const REPO_FAILED_NOTE = "The last connection test of this repository failed. Check it in ";
export const PICK_FLOW = "What do you want to start?";

/** The fields of a flow in the three groups the page draws. `required`: the github_repo input first (also when it is
 *  optional), then inputs with required: true in flow order. `optional`: the other inputs. `fixed`: mode "fixed". */
export function splitFields(flow) {
  const fields = Array.isArray(flow?.fields) ? flow.fields : [];
  const inputs = fields.filter((f) => f.mode === "input");
  return {
    required: [...inputs.filter((f) => f.name === REPO_FIELD), ...inputs.filter((f) => f.name !== REPO_FIELD && f.required)],
    optional: inputs.filter((f) => f.name !== REPO_FIELD && !f.required),
    fixed: fields.filter((f) => f.mode !== "input"),
  };
}

/** The summary of the disclosure: "More options: 2 optional fields, 1 fixed value". Parts with 0 are left out. */
export function moreSummary(optional, fixed) {
  const parts = [];
  if (optional) parts.push(`${optional} optional field${optional === 1 ? "" : "s"}`);
  if (fixed) parts.push(`${fixed} fixed value${fixed === 1 ? "" : "s"}`);
  return parts.length ? `${MORE_OPTIONS}: ${parts.join(", ")}` : MORE_OPTIONS;
}

const fixedField = (f, label) =>
  h("div", { class: "field" }, h("span", {}, label), h("span", { class: "mono" }, f.value === "" ? "—" : f.value), f.help ? h("small", {}, f.help) : null);

// Only the newest render may take or register a wish: an older one that finishes late must not.
let renders = 0;

/** The Start work page. Returns a cleanup. */
export async function renderStart(main, { a = api, dialog = repoDialog, go = (hash) => { location.hash = hash; }, admin = false, readOnly = false } = {}) {
  const newest = ++renders;
  let gone = false;
  let off = () => {};
  const heading = () => h("h1", {}, "Start work");
  // The choices of how to begin: drawn in every state, so a refinement can start without a published flow.
  // `gone` is only set when the page is left after it has finished loading, so the address is checked too.
  const onPage = () => typeof location === "undefined" || /^#\/start(?:[/?]|$)/.test(location.hash ?? "#/start");
  const choices = (opts = {}) => entryChoices({ a, go, readOnly, isGone: () => gone || !onPage(), ...opts });
  const entryNode = () => choices().node;

  async function load() {
    mount(main, heading(), entryNode(), loadingState("Loading the flows…", { rows: 4, shape: "detail" }));
    let flows;
    try {
      flows = admin ? await a.flows(true) : await a.flows();
    } catch (e) {
      if (gone) return;
      mount(main, heading(), entryNode(), e?.status === 403
        ? permissionState(FLOWS_DENIED)
        : errorState(explainError(e, { what: FLOWS_FAILED }), { onRetry: load }));
      return;
    }
    if (gone) return;
    // Taken before the empty-list return, so a wish is always used up.
    const wished = newest === renders ? takeWish("start") : null;
    if (!Array.isArray(flows) || flows.length === 0) {
      const box = emptyState(admin ? NO_FLOWS_ADMIN : NO_FLOWS);
      if (admin) box.append(h("a", { href: "#/flows" }, "Open the flow editor"));
      mount(main, heading(), entryNode(), box);
      return;
    }
    await showForm(flows, wished);
  }

  async function showForm(flows, wished) {
    let busy = false;
    const from = restoreDraft(flows, readOnly ? null : readDraft());
    // A wish from another page chooses the flow; the rest of the draft is kept.
    const state = { flow: flows.find((f) => f.name === wished?.flow) ?? from.flow, task: from.task, values: from.values };
    let dirty = from.restored;
    let started = false;
    let sentRev = -1;
    let reviewing = null;
    // A preview never writes a draft. Every change is kept at once, so leaving the page at any time loses nothing.
    const persist = () => {
      if (!readOnly && !gone && dirty && !started) writeDraft({ flow: state.flow.name, task: state.task, values: state.values });
    };
    const touch = () => { dirty = true; keep(); };

    // Repositories are only asked for when the chosen flow needs one, so a failing list cannot block other flows.
    const repoData = { repos: undefined, options: undefined, error: null, pending: null };
    const needsRepos = (flow) => flow.fields.some((f) => f.name === REPO_FIELD && f.mode === "input");
    const waiting = () => needsRepos(state.flow) && Boolean(repoData.pending);
    const syncStart = () => { submitBtn.disabled = busy || waiting(); };
    function loadRepos(force = false, created = undefined) {
      if (repoData.repos && !force) return undefined;
      if (repoData.pending) return repoData.pending;
      repoData.error = null;
      repoData.pending = (async () => {
        try {
          const [repos, options] = await Promise.all([a.repos(), a.repoMethods().catch(() => undefined)]);
          repoData.repos = githubRepos(repos);
          repoData.options = options ?? repoData.options;
          const wanted = addedRepo(created, repos);
          if (wanted) {
            state.values[state.flow.name][REPO_FIELD] = wanted;
            dirty = true;
            persist();
          }
        } catch (e) {
          repoData.error = e;
        }
        repoData.pending = null;
        if (gone) return;
        syncStart();
        drawRepo();
      })();
      return repoData.pending;
    }

    const taskBox = h("textarea", { name: "task", rows: 5 });
    taskBox.value = state.task;
    taskBox.addEventListener("input", touch);
    taskBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault?.();
        submit();
      }
    });
    let controls = {};
    let repoSelect = null;
    let addBtn = null;
    let repoGroup = null;
    let more = null;
    let moreOpen = false;
    const err = h("p", { class: "status bad", role: "alert", id: "start-error" });
    // The field the message in `err` is about, while it is marked.
    let invalid = null;
    function unmark() {
      if (!invalid) return;
      clearInvalid(invalid, "start-error");
      invalid = null;
      err.textContent = "";
    }
    /** Typing in, or choosing for, the marked field takes the mark off. */
    const edited = (el) => () => { if (invalid === el) unmark(); };
    const failBox = h("div", {});
    const entry = choices({
      hasDraft: from.restored && !readOnly,
      onTask: readOnly ? undefined : () => (state.flow.usesTask !== false ? taskBox : submitBtn).focus(),
    });
    const submitBtn = h("button", { class: "primary", type: "submit", "data-focus": "start-review" }, "Review");
    const clearBtn = h("button", { type: "button", onClick: () => clear() }, "Clear");
    const draftBox = h("div", {}, from.restored && !readOnly ? h("p", { class: "start-note", role: "status" }, DRAFT_LINE) : null);
    const rest = h("div", { class: "start-rest" });
    const repoBox = h("div", {});

    /** Copies what is typed into the state, before every redraw and at submit; keeps a changed draft. */
    function keep() {
      state.task = taskBox.value;
      const mine = state.values[state.flow.name];
      for (const [name, el] of Object.entries(controls)) mine[name] = el.value;
      if (repoSelect) mine[REPO_FIELD] = repoSelect.value;
      persist();
    }

    const retryRepos = () => {
      keep();
      loadRepos(true);
      syncStart();
      drawRepo();
    };

    const req = () => h("span", { class: "req" }, " (required)");
    const noteBox = h("div", {});
    function drawNote() {
      const r = repoSelect ? (repoData.repos ?? []).find((x) => x.github === repoSelect.value) : null;
      mount(noteBox, r && connectionStatus(r) === "Failed"
        ? h("p", { class: "start-note" }, REPO_FAILED_NOTE, h("a", { href: "#/repos" }, "My repositories"), ".")
        : null);
    }

    function repoStep(field) {
      const name = field.label === REPO_FIELD ? "Repository" : field.label;
      const label = () => h("span", { class: "start-label" }, name, req());
      if (repoData.pending) return h("div", { class: "start-repo" }, label(), loadingState("Loading your repositories…", { rows: 2 }));
      const list = repoData.repos ?? [];
      // a preview never adds anything
      const add = readOnly ? null : h("button", { type: "button", "data-focus": "add-repo", onClick: addRepository }, "Add repository");
      addBtn = add;
      const addRow = add ? h("div", { class: "row" }, add) : null;
      const failed = repoData.error
        ? errorState(explainError(repoData.error, { what: REPOS_FAILED, safe: REPOS_FAILED_SAFE }), { onRetry: retryRepos, focus: "retry-repos" })
        : null;
      if (!list.length) {
        // No repository to choose: the group is what a "Choose a repository." message points at.
        const box = failed ? null : emptyState(NO_REPOS);
        if (box && add) box.append(add);
        repoGroup = h("div", { role: "group", "aria-label": "Repository", tabindex: "-1" }, failed, box, failed ? addRow : null);
        return h("div", { class: "start-repo" }, label(), repoGroup);
      }
      repoSelect = h("select", { name: REPO_FIELD, "aria-required": field.required ? "true" : null, onChange: () => { if (invalid === repoSelect) unmark(); drawNote(); touch(); } },
        list.map((r) => h("option", { value: r.github }, `${r.github} — ${connectionStatus(r)}`)));
      const mine = state.values[state.flow.name];
      // a kept repository that is no longer listed falls back to the flow's default
      const listed = list.some((r) => r.github.toLowerCase() === String(mine[REPO_FIELD] ?? "").toLowerCase());
      repoSelect.value = pickRepo(list, listed ? mine[REPO_FIELD] : field.value);
      mine[REPO_FIELD] = repoSelect.value;
      drawNote();
      return h("div", { class: "start-repo" }, failed,
        h("label", { class: "field" }, h("span", {}, name, req()), repoSelect, field.help ? h("small", {}, field.help) : null),
        noteBox, addRow);
    }

    const repoInput = () => state.flow.fields.find((f) => f.name === REPO_FIELD && f.mode === "input");

    function drawRepo() {
      const field = repoInput();
      if (!field) return;
      if (invalid && invalid === (repoSelect ?? repoGroup)) unmark();
      repoSelect = null;
      addBtn = null;
      repoGroup = null;
      mount(repoBox, repoStep(field));
    }

    function inputRow(f) {
      const input = h("input", { name: f.name, type: "text", autocomplete: "off", "aria-required": f.required ? "true" : null, value: state.values[state.flow.name][f.name] ?? "" });
      input.addEventListener("input", edited(input));
      input.addEventListener("input", touch);
      controls[f.name] = input;
      return h("label", { class: "field" }, h("span", {}, f.label, f.required ? req() : null), input, f.help ? h("small", {}, f.help) : null);
    }

    function mainPart(parts) {
      const rows = [];
      if (parts.required[0]?.name === REPO_FIELD) rows.push(repoBox);
      if (state.flow.usesTask !== false) rows.push(h("label", { class: "field" }, h("span", {}, "Task", req()), taskBox));
      for (const f of parts.required) if (f.name !== REPO_FIELD) rows.push(inputRow(f));
      return rows.length ? h("div", { class: "start-main" }, rows) : null;
    }

    function morePart(parts) {
      if (parts.optional.length + parts.fixed.length === 0) return null;
      return h("details", { class: "start-more", open: moreOpen, onToggle: (e) => { moreOpen = !!e?.target?.open; } },
        h("summary", {}, moreSummary(parts.optional.length, parts.fixed.length)),
        h("div", { class: "start-more-body" }, parts.optional.map(inputRow),
          parts.fixed.map((f) => fixedField(f, f.label === REPO_FIELD ? "Repository" : f.label))));
    }

    function drawRest() {
      unmark();
      controls = {};
      repoSelect = null;
      addBtn = null;
      repoGroup = null;
      const parts = splitFields(state.flow);
      if (repoInput()) mount(repoBox, repoStep(repoInput()));
      more = morePart(parts);
      mount(rest, mainPart(parts), more);
    }

    const radios = [];
    const radioOf = new Map();
    function flowStep() {
      if (flows.length < 2) return null;
      return h("fieldset", {}, h("legend", {}, PICK_FLOW),
        flows.map((f) => {
          const radio = h("input", { type: "radio", name: "flow", value: f.name, checked: f === state.flow });
          radio.addEventListener("change", () => choose(f));
          radios.push(radio);
          radioOf.set(f.name, radio);
          return h("label", { class: "choice" }, radio, h("b", {}, f.title), f.description ? h("span", { class: "muted" }, f.description) : null);
        }));
    }

    function choose(flow) {
      if (busy) return;
      keep();
      mount(failBox);
      state.flow = flow;
      dirty = true;
      persist();
      moreOpen = false;
      if (needsRepos(flow)) loadRepos();
      syncStart();
      drawRest();
    }

    async function addRepository() {
      keep();
      unmark();
      err.textContent = "";
      const created = await dialog({ admin, options: repoData.options });
      if (gone) return;
      // the reload goes through the loading path: skeleton, Start off, then the new record is chosen.
      // A failure keeps the last known list; the step says what failed and offers Retry.
      keep();
      loadRepos(true, created);
      syncStart();
      drawRepo();
    }

    async function submit() {
      if (readOnly) return;
      if (busy || waiting()) return;
      keep();
      unmark();
      mount(failBox);
      err.textContent = "";
      const flow = state.flow;
      const values = { ...state.values[flow.name] };
      // only a repository that is listed and chosen is sent; a default that is not listed is not
      if (needsRepos(flow)) values[REPO_FIELD] = repoSelect ? repoSelect.value : "";
      const problem = startProblem(flow, values);
      if (problem) {
        err.textContent = problem.text;
        const target = controls[problem.field] ?? (problem.field === REPO_FIELD ? repoSelect ?? repoGroup ?? addBtn : null);
        if (target) {
          markInvalid(target, "start-error");
          invalid = target;
          target.focus();
        }
        return;
      }
      // the review shows this very object and Start sends it unchanged
      const body = startBody(flow, state.task, values);
      if (admin) body.likeUser = true;
      reviewing = reviewView({ flow, body, repos: repoData.repos ?? [], onStart: () => send(flow, body), onBack: back });
      mount(main, heading(), reviewing.node);
      reviewing.heading.focus();
    }

    function back() {
      if (busy) return;
      reviewing = null;
      mount(main, heading(), entry.node, form);
      submitBtn.focus();
    }

    async function send(flow, body) {
      if (busy) return;
      busy = true;
      const view = reviewing;
      if (view) view.startBtn.disabled = view.backBtn.disabled = true;
      submitBtn.disabled = true;
      for (const r of radios) r.disabled = true;
      sentRev = draftRevision();
      try {
        const run = await a.startRun(body);
        started = true;
        // only the draft this start was made from: newer work in another page instance stays
        if (draftRevision() === sentRev) clearDraft();
        if (gone) return toast("Run started");
        go("#/runs/" + run.runId);
      } catch (e) {
        busy = false;
        for (const r of radios) r.disabled = false;
        if (gone) return toast(errorText(e), "error");
        // the picker is off while sending, so this is still the flow that was sent: show every value that went out
        moreOpen = true;
        more?.setAttribute("open", "");
        mount(failBox, errorState(explainStart(e)));
        syncStart();
        reviewing = null;
        mount(main, heading(), entry.node, form);
        submitBtn.focus();
      }
    }

    function clear() {
      if (busy) return;
      clearDraft();
      dirty = false;
      const blank = restoreDraft(flows, null);
      state.flow = blank.flow;
      state.task = "";
      state.values = blank.values;
      taskBox.value = "";
      for (const r of radios) r.checked = r.value === state.flow.name;
      mount(failBox);
      mount(draftBox);
      entry.setDraft(false);
      moreOpen = false;
      if (needsRepos(state.flow)) loadRepos();
      syncStart();
      drawRest();
    }

    const first = needsRepos(state.flow) ? loadRepos() : undefined;
    syncStart();
    drawRest();
    const form = h("form", { class: "start-form", novalidate: true, onSubmit: (e) => { e?.preventDefault?.(); submit(); } },
      draftBox, flowStep(), rest, failBox, err, readOnly ? null : h("div", { class: "row" }, submitBtn, clearBtn));
    mount(main, heading(), entry.node, form);
    /** The palette chose a flow: the radios and the page follow; typed text is kept. */
    const pick = (name) => {
      const flow = flows.find((f) => f.name === name);
      if (!flow || flow === state.flow) return;
      for (const [n, radio] of radioOf) radio.checked = n === name;
      choose(flow);
    };
    if (newest === renders) {
      off = onWish("start", (w) => pick(w?.flow));
      // A wish that came while the flows were loading waited for this handler.
      pick(takeWish("start")?.flow);
    }
    await first;
  }

  await load();
  return () => {
    gone = true;
    off();
  };
}
