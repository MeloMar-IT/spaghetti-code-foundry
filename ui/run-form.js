import { api } from "./api.js";
import { h, mount } from "./dom.js";
import { errorState, explainError } from "./states.js";

/**
 * The body of the Run dialog. `cur` is the editor's live state ({ yaml, dirty, name }) and `yaml` the text that
 * was checked. `close(runId)` ends the dialog; `onBusy(true|false)` tells it a start is under way.
 */
export function runForm({ flow, yaml, cur, repo: repoPath, close, onBusy = () => {}, a = api }) {
  let starting = false;
  const usesTask = /\{\{\s*task\s*\}\}|(FACTORY|SCF)_TASK/.test(yaml);
  const task = h("textarea", { rows: 5, placeholder: "Describe the task, e.g. “Add a --json flag to the export command”" });
  const repo = h("input", { class: "mono", value: repoPath });
  const vars = Object.entries(flow.vars).map(([k, v]) => [k, h("input", { class: "mono", value: v })]);
  const warn = h("p", { class: "status bad flush", role: "status" });
  const err = h("div");
  let confirmedEmpty = false; // the first click on an empty task only warns
  const start = h("button", { class: "primary", onClick: async () => {
    if (starting) return;
    if (!task.value.trim() && flow.workspace !== "empty" && !confirmedEmpty) {
      confirmedEmpty = true;
      warn.textContent = "There is no task text. Click “Run without a task” to start anyway.";
      start.textContent = "▶ Run without a task";
      return;
    }
    starting = true;
    onBusy(true);
    start.disabled = task.disabled = true;
    mount(err, null);
    try {
      const body = {
        task: task.value, repo: repo.value,
        vars: Object.fromEntries(vars.map(([k, el]) => [k, el.value])),
        ...(cur.dirty || !cur.name ? { yaml } : { flow: cur.name }),
      };
      close((await a.startRun(body)).runId);
    } catch (e) {
      const info = explainError(e, { what: "The run was not started.", safe: "Your task is kept. Nothing was started." });
      mount(err, errorState(info));
      starting = false;
      onBusy(false);
      start.disabled = task.disabled = false;
    }
  } }, "▶ Start run");
  task.addEventListener("input", () => {
    confirmedEmpty = false;
    warn.textContent = "";
    start.textContent = "▶ Start run";
  });
  task.addEventListener("keydown", (e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && start.click());
  return h("div", { class: "stack" },
    h("label", { class: "field" }, h("span", {}, flow.workspace === "empty" ? "Extra instructions (optional)" : "Task"), task,
      !usesTask ? h("small", {}, "This flow doesn't use the task text.") : null),
    flow.workspace === "empty"
      ? h("small", { class: "muted" }, "Runs in a fresh empty folder — the flow fetches its own code (e.g. clones from GitHub).")
      : h("label", { class: "field" }, h("span", {}, "Repository"), repo,
          h("small", {}, flow.workspace === "worktree" ? "Runs in a fresh git worktree + branch — your checkout is not touched." : "⚠ in-place: Claude edits this directory directly.")),
    vars.length ? h("div", { class: "grid" }, vars.map(([k, el]) => h("label", { class: "field" }, h("span", { class: "mono" }, k), el))) : null,
    cur.dirty ? h("small", { class: "muted" }, "Runs your unsaved edits.") : null,
    warn, err,
    h("div", { class: "row" }, h("span", { class: "spacer" }), h("small", { class: "muted" }, "⌘↵"), start));
}
