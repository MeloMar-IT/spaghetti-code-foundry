// Start work: one text box ("What would you like to change?"), a starting point and one button, "Make a plan". The page is
// drawn at once, before any request has answered. A flow, the repository and the flow's fields are under the closed
// "Advanced". A flow chosen there goes to "Review" and then "Start"; without a flow "Make a plan" sends a change request or
// opens a refinement session (start-entry.js). The server does every real check; this page only shows its answer. The draft
// is kept in page memory (start-draft.js). Relative imports, so a test can load it: in the browser "../api.js" from
// /user/start.js is the same module as "/api.js". The admin display uses the page too.
import { api, keepPage } from "../api.js";
import { errorText } from "../auth.js";
import { COMPOSER, advancedBox, composerBox } from "../composer.js";
import { h, mount, toast } from "../dom.js";
import { clearInvalid, markInvalid } from "../fields.js";
import { onWish, takeWish } from "../palette-data.js";
import { connectionStatus, repoDialog } from "../repos.js";
import { changesOf, openChangeOf } from "../simple-change-model.js";
import { projectName } from "../simple-model.js";
import { emptyState, errorState, explainError, loadingState } from "../states.js";

import {
  IDEA_HINT, ISSUE_HINT, ISSUE_LABEL, NO_PLAN_PROJECT, NO_PLAN_REPO, PLAN_FAILED, SESSION_EXISTS, conversationList, existingSession, inRepo, pickPlanRepo,
  planProblem, planRepos, planRequest, planTarget, startPoints, isKind,
} from "./start-entry.js";
import {
  FLOW_NONE, MORE_OPTIONS, NO_FLOWS_NOTE, REPO_FIELD, DRAFT_LINE, addedRepo, clearDraft, draftRevision, githubRepos, moreSummary, pickRepo, readDraft,
  restoreDraft, reviewView, splitFields, startBody, startProblem, writeDraft,
} from "./start-draft.js";

export { REPO_FIELD, MORE_OPTIONS, addedRepo, githubRepos, moreSummary, pickRepo, splitFields, startBody, startProblem };
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
export const REPO_FAILED_NOTE = "The last connection test of this repository failed. Check it in ";
export const PICK_FLOW = "What do you want to start?";
// The words of Simple: fixed text, so a server message with a forbidden term never shows there.
export const SIMPLE_PLAN_FAILED = { kind: "other", what: "The plan could not be started.", safe: START_KEPT, next: "Try again in a moment. If it keeps failing, ask the person who set up the Foundry." };
export const SIMPLE_PLAN_UNSURE = { kind: "offline", what: "The plan may have been started or not.", safe: START_KEPT, next: "Look at your project first. Try again only if you find nothing new." };
export const SIMPLE_PROJECTS_FAILED = { kind: "other", what: "Your projects could not be loaded.", safe: "Nothing was changed.", next: "Try again in a moment." };
export const PLAN_UNSURE = "The plan may have been started or not. What you typed is still here.";
export const PLAN_UNSURE_NEXT = "Check your change requests first. Try again only if none was created.";

/** The server's answer to Start in the three parts errorState needs. No answer or a 5xx: the run may exist. */
export function explainStart(e) {
  const info = explainError(e, { what: START_FAILED });
  if (info.kind === "offline" || info.kind === "server") return { ...info, safe: START_UNSURE, next: START_UNSURE_NEXT };
  return { ...info, safe: `${info.safe} ${START_KEPT}` };
}

const fixedField = (f, label) =>
  h("div", { class: "field" }, h("span", {}, label), h("span", { class: "mono" }, f.value === "" ? "—" : f.value), f.help ? h("small", {}, f.help) : null);

// Only the newest render may take or register a wish: an older one that finishes late must not.
let renders = 0;

/** The Start work page. Returns a cleanup. */
export async function renderStart(main, { a = api, dialog = repoDialog, go = (hash) => { location.hash = hash; }, admin = false, readOnly = false, simple = false, contextRepo = () => "" } = {}) {
  const newest = ++renders;
  let gone = false;
  const noop = () => {};
  let off = noop;
  const onPage = () => typeof location === "undefined" || /^#\/start(?:[/?]|$)/.test(location.hash ?? "#/start");
  const heading = () => h("h1", {}, "Start work");

  const from = readOnly ? null : readDraft();
  const state = { kind: simple ? "idea" : (isKind(from?.kind) ? from.kind : "idea"), flow: null, task: from?.task ?? "", values: from?.values ?? {}, repo: from?.repo || contextRepo() || "" };
  let pendingFlow = from?.flow ?? ""; // the flow of a restored draft, applied when the flows arrive; Clear cancels it
  const flowData = { state: simple ? "none" : "loading", flows: null, error: null };
  const repoData = { all: undefined, options: undefined, error: null, pending: null };
  let dirty = Boolean(from);
  let busy = false;
  let started = false;
  let unsure = false; // a change request may have been saved: it is read again before another one is made
  let sentRev = -1;
  let reviewing = null;
  let moreOpen = false;
  let more = null;
  let controls = {};
  let repoSelect = null;
  let addBtn = null;
  let repoGroup = null;
  let invalid = null;
  let flowRadios = [];

  const persist = () => {
    if (!readOnly && !gone && dirty && !started) {
      writeDraft({ flow: state.flow ? state.flow.name : flowData.flows ? "" : pendingFlow, task: state.task, kind: state.kind, repo: state.repo, values: state.values });
    }
  };
  // typed text must survive a 401 of a background read (the page would reload): the same guard the change page has
  const releaseGuard = keepPage(() => !readOnly && !started && !gone && (dirty || (taskBox?.value ?? "").trim() !== ""));
  const touch = () => { dirty = true; keep(); };

  // ---- the composer -------------------------------------------------------------------------------------------
  const err = h("p", { class: "status bad", role: "alert", id: "start-error" });
  function unmark() {
    if (!invalid) return;
    clearInvalid(invalid, "start-error");
    invalid = null;
    err.textContent = "";
  }
  const edited = (el) => () => { if (invalid === el) unmark(); };
  const composer = composerBox({ name: "task", value: state.task, hint: IDEA_HINT, onInput: () => { edited(taskBox)(); touch(); }, onSubmit: () => submit() });
  const taskBox = composer.box;
  const failBox = h("div", {});
  const draftBox = h("div", {}, from && !readOnly ? h("p", { class: "start-note", role: "status" }, DRAFT_LINE) : null);
  const points = simple ? null : startPoints({ kind: state.kind, onChange: (k) => { if (busy) return; keep(); state.kind = k; dirty = true; persist(); mount(failBox); unmark(); drawTop(); drawLine(); } });
  const pointsHolder = h("div", {});
  const textHolder = h("div", {});
  const convHolder = h("div", {});
  const lineHolder = h("div", { class: "start-repo-line" });
  const submitBtn = h("button", { class: "primary", type: "submit", "data-focus": "make-plan" }, COMPOSER.plan);
  const clearBtn = h("button", { type: "button", onClick: () => clear() }, "Clear");
  const rowHolder = h("div", {});
  const flowHolder = h("div", {});
  const planRepoHolder = h("div", {});
  const rest = h("div", { class: "start-rest" });
  const repoBox = h("div", {});
  const noteBox = h("div", {});

  const needsRepos = (flow) => Boolean(flow) && flow.fields.some((f) => f.name === REPO_FIELD && f.mode === "input");
  const waiting = () => needsRepos(state.flow) && Boolean(repoData.pending);
  const syncStart = () => { submitBtn.disabled = busy || waiting(); };
  const plans = () => planRepos(repoData.all);
  const current = () => pickPlanRepo(plans(), state.repo);

  /** Copies what is typed into the state, before every redraw and at submit; keeps a changed draft. */
  function keep() {
    state.task = taskBox.value;
    if (state.flow) {
      const mine = state.values[state.flow.name];
      for (const [name, el] of Object.entries(controls)) mine[name] = el.value;
      if (repoSelect) mine[REPO_FIELD] = repoSelect.value;
    }
    persist();
  }

  // ---- the top: starting point, text box, conversations, repository -------------------------------------------
  function drawTop() {
    const flow = state.flow;
    const conversation = !flow && state.kind === "conversation";
    mount(pointsHolder, points && !flow ? points.node : null);
    const issue = !flow && state.kind === "issue";
    composer.labelEl.textContent = issue ? ISSUE_LABEL : COMPOSER.what;
    if (composer.hintEl) composer.hintEl.textContent = flow ? "" : issue ? ISSUE_HINT : IDEA_HINT;
    taskBox.rows = issue ? 2 : 5;
    mount(textHolder, conversation || (flow && flow.usesTask === false) ? null : composer.field);
    mount(convHolder, conversation ? conversationList({ a, isGone: () => gone || !onPage() }) : null);
    mount(rowHolder, readOnly ? null : h("div", { class: "row" }, conversation ? null : submitBtn, clearBtn));
  }

  function planSelect(label) {
    const list = plans();
    const select = h("select", { name: "plan_repo", onChange: () => { state.repo = select.value; touch(); drawLine(); } },
      list.map((r) => h("option", { value: r.name }, simple ? projectName(repoData.all.find((x) => x.id === r.id), repoData.all) : r.name)));
    select.value = current()?.name ?? "";
    return h("label", { class: "field" }, h("span", {}, label), select);
  }

  const retryRepos = () => { keep(); loadRepos(true); syncStart(); drawAll(); };
  function drawLine() {
    const conversation = !state.flow && state.kind === "conversation";
    if (state.flow || conversation) return mount(lineHolder);
    if (repoData.pending) return mount(lineHolder, h("p", { class: "muted" }, simple ? "Loading your projects…" : "Loading your repositories…"));
    if (repoData.error && !repoData.all) {
      return mount(lineHolder, errorState(simple ? SIMPLE_PROJECTS_FAILED : explainError(repoData.error, { what: REPOS_FAILED, safe: REPOS_FAILED_SAFE }), { onRetry: retryRepos, focus: "retry-repos" }));
    }
    const list = plans();
    const now = current();
    if (!now) return mount(lineHolder);
    if (simple) {
      const all = repoData.all;
      const record = all.find((r) => r.id === now.id);
      return mount(lineHolder, list.length > 1 ? planSelect("Project") : h("p", {}, inRepo(projectName(record, all))));
    }
    mount(lineHolder, h("p", {}, inRepo(now.name), " ",
      h("button", { type: "button", class: "small", "data-focus": "change-repo", onClick: () => { openAdvanced(); (planSelectEl() ?? adv).focus(); } }, "Change")));
  }
  const planSelectEl = () => (planRepoHolder.querySelectorAll ? planRepoHolder.querySelectorAll("select")[0] : null);

  function drawPlanRepo() {
    if (state.flow || !plans().length) return mount(planRepoHolder);
    mount(planRepoHolder, planSelect("Where does the change go?"));
  }

  // ---- the repositories ---------------------------------------------------------------------------------------
  function loadRepos(force = false, created = undefined) {
    if (repoData.all && !force) return undefined;
    if (repoData.pending) return repoData.pending;
    repoData.error = null;
    repoData.pending = (async () => {
      try {
        const [repos, options] = await Promise.all([a.repos(), simple ? undefined : Promise.resolve().then(() => a.repoMethods?.()).catch(() => undefined)]);
        repoData.all = Array.isArray(repos) ? repos : [];
        repoData.options = options ?? repoData.options;
        const made = planRepos(repoData.all).find((r) => created && r.id === created.id);
        if (made) { state.repo = made.name; dirty = true; }
        const wanted = addedRepo(created, repos);
        if (wanted && needsRepos(state.flow)) { state.values[state.flow.name][REPO_FIELD] = wanted; dirty = true; }
        if (dirty) persist();
      } catch (e) {
        repoData.error = e;
      }
      repoData.pending = null;
      if (gone) return;
      syncStart();
      drawRepo();
      drawLine();
      drawPlanRepo();
    })();
    return repoData.pending;
  }

  async function addRepository() {
    keep();
    unmark();
    err.textContent = "";
    const created = await dialog({ admin, options: repoData.options });
    if (gone) return;
    // the reload goes through the loading path; a failure keeps the last known list and says so with Retry
    keep();
    loadRepos(true, created);
    syncStart();
    drawAll();
  }

  const req = () => h("span", { class: "req" }, " (required)");
  function drawNote() {
    const r = repoSelect ? githubRepos(repoData.all).find((x) => x.github === repoSelect.value) : null;
    mount(noteBox, r && connectionStatus(r) === "Failed"
      ? h("p", { class: "start-note" }, REPO_FAILED_NOTE, h("a", { href: "#/repos" }, "My repositories"), ".")
      : null);
  }

  function repoStep(field) {
    const name = field.label === REPO_FIELD ? "Repository" : field.label;
    const label = () => h("span", { class: "start-label" }, name, req());
    if (repoData.pending) return h("div", { class: "start-repo" }, label(), loadingState("Loading your repositories…", { rows: 2 }));
    const list = githubRepos(repoData.all);
    const add = readOnly ? null : h("button", { type: "button", "data-focus": "add-repo", onClick: addRepository }, "Add repository");
    addBtn = add;
    const addRow = add ? h("div", { class: "row" }, add) : null;
    const failed = repoData.error
      ? errorState(explainError(repoData.error, { what: REPOS_FAILED, safe: REPOS_FAILED_SAFE }), { onRetry: retryRepos, focus: "retry-repos" })
      : null;
    if (!list.length) {
      const box = failed ? null : emptyState(NO_REPOS);
      if (box && add) box.append(add);
      repoGroup = h("div", { role: "group", "aria-label": "Repository", tabindex: "-1" }, failed, box, failed ? addRow : null);
      return h("div", { class: "start-repo" }, label(), repoGroup);
    }
    repoSelect = h("select", { name: REPO_FIELD, "aria-required": field.required ? "true" : null, onChange: () => { if (invalid === repoSelect) unmark(); drawNote(); touch(); } },
      list.map((r) => h("option", { value: r.github }, `${r.github} — ${connectionStatus(r)}`)));
    const mine = state.values[state.flow.name];
    const listed = list.some((r) => r.github.toLowerCase() === String(mine[REPO_FIELD] ?? "").toLowerCase());
    repoSelect.value = pickRepo(list, listed ? mine[REPO_FIELD] : field.value);
    mine[REPO_FIELD] = repoSelect.value;
    drawNote();
    return h("div", { class: "start-repo" }, failed,
      h("label", { class: "field" }, h("span", {}, name, req()), repoSelect, field.help ? h("small", {}, field.help) : null),
      noteBox, addRow);
  }

  const repoInput = () => state.flow?.fields.find((f) => f.name === REPO_FIELD && f.mode === "input");
  function drawRepo() {
    const field = repoInput();
    if (!field) return;
    if (invalid && invalid === (repoSelect ?? repoGroup)) unmark();
    repoSelect = null;
    addBtn = null;
    repoGroup = null;
    mount(repoBox, repoStep(field));
  }

  // ---- the flow (inside Advanced) -----------------------------------------------------------------------------
  function inputRow(f) {
    const input = h("input", { name: f.name, type: "text", autocomplete: "off", "aria-required": f.required ? "true" : null, value: state.values[state.flow.name][f.name] ?? "" });
    input.addEventListener("input", edited(input));
    input.addEventListener("input", touch);
    controls[f.name] = input;
    return h("label", { class: "field" }, h("span", {}, f.label, f.required ? req() : null), input, f.help ? h("small", {}, f.help) : null);
  }

  function drawRest() {
    unmark();
    controls = {};
    repoSelect = null;
    addBtn = null;
    repoGroup = null;
    if (!state.flow) return mount(rest);
    const parts = splitFields(state.flow);
    if (repoInput()) mount(repoBox, repoStep(repoInput()));
    const rows = [];
    if (parts.required[0]?.name === REPO_FIELD) rows.push(repoBox);
    for (const f of parts.required) if (f.name !== REPO_FIELD) rows.push(inputRow(f));
    more = parts.optional.length + parts.fixed.length === 0 ? null
      : h("details", { class: "start-more", open: moreOpen, onToggle: (e) => { moreOpen = !!e?.target?.open; } },
        h("summary", {}, moreSummary(parts.optional.length, parts.fixed.length)),
        h("div", { class: "start-more-body" }, parts.optional.map(inputRow), parts.fixed.map((f) => fixedField(f, f.label === REPO_FIELD ? "Repository" : f.label))));
    mount(rest, rows.length ? h("div", { class: "start-main" }, rows) : null, more);
  }

  function drawFlowArea() {
    flowRadios = [];
    if (flowData.state === "loading") return mount(flowHolder, loadingState("Loading the flows…", { rows: 2 }));
    if (flowData.state === "denied") return mount(flowHolder, h("p", { class: "muted" }, FLOWS_DENIED));
    if (flowData.state === "failed") return mount(flowHolder, errorState(explainError(flowData.error, { what: FLOWS_FAILED }), { onRetry: loadFlows }));
    if (flowData.state === "empty") return mount(flowHolder, h("p", { class: "muted" }, NO_FLOWS_NOTE, admin ? [" ", h("a", { href: "#/flows" }, "Open the flow editor")] : null));
    if (flowData.state !== "list") return mount(flowHolder);
    const option = (flow, title, description) => {
      const radio = h("input", { type: "radio", name: "flow", value: flow ? flow.name : "", checked: flow === state.flow });
      radio.addEventListener("change", () => choose(flow));
      flowRadios.push({ flow, radio });
      return h("label", { class: "choice" }, radio, h("b", {}, title), description ? h("span", { class: "muted" }, description) : null);
    };
    mount(flowHolder, h("fieldset", {}, h("legend", {}, PICK_FLOW),
      option(null, FLOW_NONE), flowData.flows.map((f) => option(f, f.title, f.description))));
  }

  function choose(flow) {
    if (busy) return;
    keep();
    mount(failBox);
    unmark();
    state.flow = flow;
    dirty = true;
    persist();
    moreOpen = false;
    for (const r of flowRadios) r.radio.checked = r.flow === flow;
    if (needsRepos(flow)) loadRepos();
    syncStart();
    drawAll();
  }

  function drawAll() {
    drawTop();
    drawLine();
    drawPlanRepo();
    drawRest();
  }

  async function loadFlows() {
    if (simple) return;
    flowData.state = "loading";
    drawFlowArea();
    let list;
    try {
      list = admin ? await a.flows(true) : await a.flows();
    } catch (e) {
      if (gone) return;
      flowData.state = e?.status === 403 ? "denied" : "failed";
      flowData.error = e;
      drawFlowArea();
      return;
    }
    if (gone) return;
    const flows = Array.isArray(list) ? list : [];
    flowData.flows = flows;
    flowData.state = flows.length ? "list" : "empty";
    const restored = restoreDraft(flows, { flow: pendingFlow, values: state.values });
    state.values = restored.values;
    state.flow = restored.flow;
    if (state.flow) {
      openAdvanced();
      if (needsRepos(state.flow)) loadRepos();
    }
    drawFlowArea();
    syncStart();
    drawAll();
    // A wish from another page chooses the flow once the flows are known; only the newest render takes it, once.
    if (newest === renders && off === noop) {
      off = onWish("start", (w) => pick(w?.flow));
      pick(takeWish("start")?.flow);
    }
  }

  // ---- Make a plan / Review -----------------------------------------------------------------------------------
  const refuse = (text, target) => {
    err.textContent = text;
    if (!target) return;
    markInvalid(target, "start-error");
    invalid = target;
    target.focus();
  };

  async function submit() {
    if (readOnly || busy || waiting()) return;
    keep();
    unmark();
    mount(failBox);
    err.textContent = "";
    if (state.flow) return review();
    if (state.kind === "conversation") return undefined;
    return makePlan();
  }

  function review() {
    const flow = state.flow;
    const values = { ...state.values[flow.name] };
    // only a repository that is listed and chosen is sent; a default that is not listed is not
    if (needsRepos(flow)) values[REPO_FIELD] = repoSelect ? repoSelect.value : "";
    const problem = startProblem(flow, values);
    if (problem) {
      openAdvanced();
      const target = controls[problem.field] ?? (problem.field === REPO_FIELD ? repoSelect ?? repoGroup ?? addBtn : null);
      return refuse(problem.text, target);
    }
    // the review shows this very object and Start sends it unchanged
    const body = startBody(flow, state.task, values);
    if (admin) body.likeUser = true;
    reviewing = reviewView({ flow, body, repos: githubRepos(repoData.all), onStart: () => send(flow, body), onBack: back });
    mount(main, heading(), reviewing.node);
    reviewing.heading.focus();
    return undefined;
  }

  const planFailure = (e) => {
    if (simple) return errorState(SIMPLE_PLAN_FAILED);
    return errorState(explainError(e, { what: PLAN_FAILED, safe: START_KEPT }));
  };
  const planUnsure = () => errorState(simple ? SIMPLE_PLAN_UNSURE : { kind: "offline", what: PLAN_UNSURE, safe: START_KEPT, next: PLAN_UNSURE_NEXT });

  /** The plan went through: the draft it was made from goes, and the page it made opens. */
  function planned(kind, repo, answer) {
    started = true;
    if (draftRevision() === sentRev) clearDraft();
    if (gone || !onPage()) return toast("Your change was sent");
    return go(planTarget(kind, repo, answer));
  }

  /** "found" | "none" | "unknown": is the change request that may have been lost saved? */
  async function savedChange(repo, text) {
    try {
      const found = openChangeOf(changesOf(await Promise.resolve().then(() => a.changes(repo.name))));
      return found && found.text?.trim() === text.trim() ? "found" : "none";
    } catch {
      return "unknown";
    }
  }

  async function makePlan() {
    if (repoData.pending) {
      busy = true;
      syncStart();
      await repoData.pending;
      busy = false;
      syncStart();
      if (gone) return;
    }
    const repo = current();
    const input = { kind: state.kind, text: state.task, repo };
    const problem = planProblem(input);
    if (problem === NO_PLAN_REPO) {
      if (repoData.error) return;
      mount(failBox, simple
        ? h("p", {}, NO_PLAN_PROJECT, " ", h("a", { href: "#/home" }, "My projects"))
        : h("div", { class: "row" }, h("p", {}, NO_PLAN_REPO), readOnly ? null : h("button", { type: "button", "data-focus": "add-repo", onClick: addRepository }, "Add repository")));
      return;
    }
    if (problem) {
      const noGithub = state.kind === "issue" && repo && !repo.github;
      if (noGithub) openAdvanced();
      return refuse(problem, noGithub ? planSelectEl() : taskBox);
    }
    const { call, body } = planRequest(input);
    busy = true;
    syncStart();
    for (const r of flowRadios) r.radio.disabled = true;
    sentRev = draftRevision();
    const ready = () => { busy = false; for (const r of flowRadios) r.radio.disabled = false; syncStart(); };
    // a lost answer may have saved the request: read it again before a second one is made
    if (unsure && call === "createChange") {
      const seen = await savedChange(repo, body.text);
      if (gone) return;
      if (seen === "found") { ready(); return planned(state.kind, repo); }
      if (seen === "unknown") { ready(); return mount(failBox, planUnsure()); }
      unsure = false;
    }
    try {
      const answer = await a[call](body);
      ready();
      return planned(state.kind, repo, answer);
    } catch (e) {
      const session = existingSession(e);
      if (session) {
        ready();
        started = true;
        if (draftRevision() === sentRev) clearDraft();
        if (!gone && onPage()) { go("#/refinement/" + encodeURIComponent(session)); toast(SESSION_EXISTS); }
        return undefined;
      }
      if (call === "createChange" && (!e?.status || e.status >= 500)) {
        unsure = true;
        const seen = await savedChange(repo, body.text);
        if (gone) return undefined;
        ready();
        if (seen === "found") return planned(state.kind, repo);
        if (seen === "unknown") return mount(failBox, planUnsure());
        unsure = false;
      }
      ready();
      if (gone) return toast(simple ? "The plan could not be started." : errorText(e), "error");
      return mount(failBox, planFailure(e));
    }
  }

  function back() {
    if (busy) return;
    reviewing = null;
    mount(main, heading(), form);
    submitBtn.focus();
  }

  async function send(flow, body) {
    if (busy) return;
    busy = true;
    const view = reviewing;
    if (view) view.startBtn.disabled = view.backBtn.disabled = true;
    submitBtn.disabled = true;
    for (const r of flowRadios) r.radio.disabled = true;
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
      for (const r of flowRadios) r.radio.disabled = false;
      if (gone) return toast(errorText(e), "error");
      // the picker is off while sending, so this is still the flow that was sent: show every value that went out
      openAdvanced();
      moreOpen = true;
      more?.setAttribute("open", "");
      mount(failBox, errorState(explainStart(e)));
      syncStart();
      reviewing = null;
      mount(main, heading(), form);
      submitBtn.focus();
    }
    return undefined;
  }

  function clear() {
    if (busy) return;
    clearDraft();
    pendingFlow = ""; // a flow restored from the cleared draft must not come back when the flows load
    dirty = false;
    unsure = false;
    state.flow = null;
    state.kind = "idea";
    state.task = "";
    state.repo = contextRepo() || "";
    state.values = flowData.flows ? restoreDraft(flowData.flows, null).values : {};
    taskBox.value = "";
    if (points) for (const r of points.radios) r.checked = r.value === "idea";
    for (const r of flowRadios) r.radio.checked = r.flow === null;
    mount(failBox);
    mount(draftBox);
    moreOpen = false;
    syncStart();
    drawAll();
  }

  // ---- draw at once -------------------------------------------------------------------------------------------
  const adv = simple ? null : advancedBox(h("div", { class: "start-advanced" }, planRepoHolder, flowHolder, rest));
  function openAdvanced() {
    if (!adv) return;
    adv.setAttribute("open", "");
    adv.open = true;
  }
  const form = h("form", { class: "start-form", novalidate: true, onSubmit: (e) => { e?.preventDefault?.(); submit(); } },
    draftBox, pointsHolder, textHolder, convHolder, lineHolder, failBox, err, rowHolder, adv);
  /** The palette chose a flow: Advanced opens, the radios follow; typed text is kept. */
  const pick = (name) => {
    if (!name || simple) return;
    const flow = flowData.flows?.find((f) => f.name === name);
    if (!flow || flow === state.flow) return;
    openAdvanced();
    choose(flow);
  };
  drawFlowArea();
  drawAll();
  syncStart();
  mount(main, heading(), form);
  // the two reads run side by side; nothing above waits for them
  const reads = [loadRepos(), loadFlows()];
  drawLine();
  await Promise.all(reads);
  return () => {
    gone = true;
    off();
    releaseGuard();
  };
}
