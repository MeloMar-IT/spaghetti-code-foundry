import { api } from "./api.js";
import { fieldFor, h, modal, showError } from "./dom.js";

const f = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);
const input = (value, attrs = {}) => h("input", { value: value ?? "", ...attrs });
const check = (checked, label) => {
  const el = h("input", { type: "checkbox", class: "fit", checked: !!checked });
  return { el, row: h("label", { class: "row tight" }, el, h("span", {}, label)) };
};

const SOURCES = {
  issues: "Issues with a label → run a flow (default issue-gitflow)",
  schedule: "On a schedule → run a flow (default release-daily)",
};
// No shipped flow for these any more; still shown for a watcher that already uses them.
const OLD_SOURCES = {
  "pr-feedback": "Review comments on Foundry PRs → your flow",
  "ci-failures": "CI red on the default branch → your flow",
};
const DEFAULT_FLOWS = { issues: "issue-gitflow", schedule: "release-daily" };
const CHORES = [
  ["Dependencies", "Update dependencies that have known security vulnerabilities (npm audit / pip-audit / cargo audit etc.) to the smallest fixed version. Do not do major upgrades."],
  ["Flaky tests", "Run the test suite 3 times. If any test fails only sometimes, find why it is flaky and make it deterministic. Do not delete or skip tests."],
  ["Test coverage", "Find the most important untested code path (business logic, not trivial getters) and add focused tests for it."],
  ["Docs", "Check that README and docs match the code (commands, options, examples). Fix anything outdated."],
  ["Lint / TODOs", "Run the linter and fix the warnings that are safe to fix. Resolve TODO/FIXME comments that are quick and clearly specified."],
];

/** Parses "name=value" lines. Returns { vars } or { error: 'vars: "x" should be name=value' }. */
export function parseVars(text) {
  const vars = {};
  for (const line of String(text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf("=");
    if (i < 1) return { error: `vars: "${line}" should be name=value` };
    vars[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { vars };
}

/** { available: repos that can have a watcher, unavailable: [{ repo, reason }] }, each sorted by address. */
export function repoChoices(repos) {
  const byUrl = (a, b) => String(a.url).localeCompare(String(b.url));
  const sorted = [...repos].sort(byUrl);
  return {
    available: sorted.filter((r) => !r.watcherProblem),
    unavailable: sorted.filter((r) => r.watcherProblem).map((repo) => ({ repo, reason: repo.watcherProblem })),
  };
}

/**
 * The request body from the raw form values. `editing`: no id, and a cleared option is null (the API removes it);
 * else it is left out.
 */
export function repoWatcherBody(v, editing) {
  const clear = editing ? null : undefined;
  const text = (x) => String(x ?? "").trim();
  const opt = (on, x) => (on && text(x) ? text(x) : clear);
  const body = {
    ...(editing ? {} : { id: text(v.id) }),
    source: v.source,
    flow: text(v.flow),
    label: text(v.label),
    every: text(v.every),
    max_per_tick: Number(v.max) || 1,
    enabled: !!v.enabled,
    vars: v.vars ?? {},
    exclude_labels: text(v.exclude).split(",").map((x) => x.trim()).filter(Boolean),
    task: opt(v.source === "schedule", v.task),
    at: opt(v.source === "schedule", v.at),
    timezone: opt(v.source === "schedule", v.timezone),
    branch: opt(v.source === "ci-failures", v.branch),
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

// Sentences about the watcher id: the dialog's own, a config path ending in "id", and the duplicate messages.
const ID_PAIRS = [[/the id "/, "id"], [/^id:/, "id"], [/"watchers"[\s\S]*"id"/, "id"], [/the watcher id/, "id"], [/a watcher .* already exists/, "id"]];

/** Runs `send` once at a time: the button and the dialog's close stay off while it runs. `mark(message)` shows an error ("" clears it). */
function guarded(state, button, send, close, mark) {
  return async () => {
    if (state.busy) return;
    state.busy = true;
    button.disabled = true;
    mark("");
    try {
      await send();
    } catch (e) {
      state.busy = false;
      button.disabled = false;
      mark(e.message);
      return;
    }
    state.busy = false;
    close(true);
  };
}

/** Add (existing = null) or edit a watcher of a repository. Resolves true when saved. */
export function repoWatcherDialog({ repos, flows, existing }) {
  const w = existing ?? { id: "", source: "issues", flow: "issue-gitflow", label: "claude-factory", every: "5m", max_per_tick: 1, enabled: true, vars: {} };
  const { available, unavailable } = repoChoices(repos ?? []);
  const state = { busy: false };
  return modal(existing ? `Edit watcher ${w.id}` : "Add a watcher", (close) => {
    const id = input(w.id, { class: "mono", placeholder: "my-repo", disabled: !!existing });
    const repo = h("select", { name: "repo" }, available.map((r) => h("option", { value: r.id }, `${r.url} — ${r.account?.email ?? "unknown owner"}`)));
    if (available.length) repo.value = available[0].id;
    const flow = input(w.flow, { class: "mono", list: "watcher-flows" });
    const sources = { ...SOURCES, ...(OLD_SOURCES[w.source] ? { [w.source]: OLD_SOURCES[w.source] } : {}) };
    const source = h("select", { name: "source", onChange: () => {
      if (DEFAULT_FLOWS[source.value] && Object.values(DEFAULT_FLOWS).includes(flow.value)) flow.value = DEFAULT_FLOWS[source.value];
      if (source.value === "schedule" && /^\d+(s|m)$/.test(every.value)) every.value = "7d";
      showFor();
    } }, Object.entries(sources).map(([v, label]) => h("option", { value: v }, label)));
    source.value = w.source;
    const task = h("textarea", { rows: 3, placeholder: "What the chore should do each time", value: w.task ?? "" });
    const branch = input(w.branch ?? "", { class: "mono", placeholder: "default branch" });
    const exclude = input((w.exclude_labels ?? []).join(", "), { class: "mono", placeholder: "e.g. geni, wontfix" });
    const at = input(w.at ?? "", { class: "mono", placeholder: "HH:MM (optional)" });
    const tz = input(w.timezone ?? "", { class: "mono", placeholder: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const label = input(w.label, { class: "mono" });
    const every = input(w.every, { class: "mono", placeholder: "5m" });
    const max = input(String(w.max_per_tick), { type: "number", min: 1 });
    const vars = h("textarea", { rows: 3, class: "mono", placeholder: "test_cmd=npm test\nrequire_approval=yes", value: Object.entries(w.vars ?? {}).map(([k, v]) => `${k}=${v}`).join("\n") });
    const enabled = check(w.enabled, "Enabled");
    const err = h("p", { class: "status bad flush", role: "alert" });
    const fields = { id, flow, label, exclude, every, max, task, branch, at, timezone: tz, vars };
    const PAIRS = [[/^vars:/, "vars"], ...ID_PAIRS, [/^flow:/, "flow"], [/^label:/, "label"], [/^exclude_labels:/, "exclude"],
      [/^every:/, "every"], [/^max_per_tick:/, "max"], [/^task:/, "task"], [/^branch:/, "branch"], [/^at:/, "at"], [/^timezone:/, "timezone"]];
    const mark = (m) => showError(err, m, { fields: Object.values(fields), field: fields[fieldFor(m, PAIRS)] });
    const noRepo = !existing && !available.length;
    const save = h("button", { class: "primary", disabled: noRepo, onClick: () => {
      if (state.busy || noRepo) return;
      const parsed = parseVars(vars.value);
      if (parsed.error) return void mark(parsed.error);
      const body = repoWatcherBody({
        id: id.value, source: source.value, flow: flow.value, label: label.value, exclude: exclude.value, every: every.value, max: max.value,
        enabled: enabled.el.checked, vars: parsed.vars, task: task.value, branch: branch.value, at: at.value, timezone: tz.value,
      }, !!existing);
      const send = () => (existing ? api.saveRepoWatcher(existing.repoId, existing.id, body) : api.addRepoWatcher(repo.value, body));
      return guarded(state, save, send, close, mark)();
    } }, "Save watcher");
    const labelField = h("div", { class: "grid" }, f("Trigger label", label), f("Skip issues with these labels", exclude));
    const atField = h("div", { class: "grid" }, f("Once a day at", at, "Instead of every interval"), f("Time zone", tz));
    const taskField = h("div", {}, f("Chore", task, "Becomes the run's task. The flow opens a PR only if something changed."),
      h("div", { class: "chips mt-6" }, CHORES.map(([name, text]) => h("button", { class: "chip", type: "button", onClick: () => (task.value = text) }, name))));
    const branchField = f("Branch to watch", branch);
    const showFor = () => {
      labelField.hidden = source.value !== "issues";
      taskField.hidden = source.value !== "schedule";
      atField.hidden = source.value !== "schedule";
      branchField.hidden = source.value !== "ci-failures";
    };
    showFor();
    const repoField = existing
      ? f("Repository", h("span", { class: "mono" }, existing.github_repo || existing.repoId))
      : available.length ? f("Repository", repo) : h("p", { class: "status bad flush", role: "alert" }, "No connected repository can have a watcher.");
    return h("div", { class: "stack" },
      h("datalist", { id: "watcher-flows" }, (flows ?? []).map((x) => h("option", { value: x.name }))),
      repoField,
      !existing && unavailable.length
        ? h("div", { class: "muted text-sm" }, h("div", {}, "Not available:"),
          unavailable.map(({ repo: r, reason }) => h("div", {}, `${r.url} — ${reason}`)))
        : null,
      f("Id", id),
      f("Source", source),
      h("div", { class: "grid" }, f("Flow", flow), labelField, branchField),
      taskField,
      atField,
      h("div", { class: "grid" }, f("Check every", every, "e.g. 5m, 1h — for chores: how often it runs, e.g. 1d, 7d"), f("Max new runs per check", max)),
      f("Variables for each run", vars, "One name=value per line. github_repo and issue/pr are set automatically."),
      enabled.row, err, h("div", { class: "row" }, h("span", { class: "spacer" }), save));
  }, { busy: () => state.busy });
}

/** Add or edit the monitor: id, interval, enabled. `save({ id, every, enabled })` may throw; its message shows in the dialog. */
export function monitorDialog(existing, save) {
  const w = existing ?? { id: "monitor", every: "1h", enabled: true };
  const state = { busy: false };
  return modal(existing ? `Edit watcher ${w.id}` : "Add the monitor", (close) => {
    const id = input(w.id, { class: "mono", disabled: !!existing });
    const every = input(w.every, { class: "mono", placeholder: "1h" });
    const enabled = check(w.enabled, "Enabled");
    const err = h("p", { class: "status bad flush", role: "alert" });
    const fields = { id, every };
    const mark = (m) => showError(err, m, { fields: Object.values(fields), field: fields[fieldFor(m, [...ID_PAIRS, [/"watchers"[\s\S]*"every"/, "every"], [/^every:/, "every"]])] });
    const go = h("button", { class: "primary", onClick: () =>
      guarded(state, go, () => save({ id: id.value.trim(), every: every.value.trim(), enabled: enabled.el.checked }), close, mark)() }, "Save watcher");
    return h("div", { class: "stack" },
      h("p", { class: "muted flush" }, "The monitor checks the Foundry itself for problems. It is saved in config.yaml."),
      f("Id", id), f("Check every", every, "e.g. 5m, 1h"), enabled.row, err, h("div", { class: "row" }, h("span", { class: "spacer" }), go));
  }, { busy: () => state.busy });
}
