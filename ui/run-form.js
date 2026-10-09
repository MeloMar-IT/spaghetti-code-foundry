import { api } from "./api.js";
import { h } from "./dom.js";

/**
 * The body of the Run dialog. `cur` is the editor's live state ({ yaml, dirty, name }): it is read when Start is
 * clicked, so a save while the dialog is open is seen. `close(runId)` ends the dialog.
 */
export function runForm({ flow, cur, repo: repoPath, close, a = api }) {
  const usesTask = /\{\{\s*task\s*\}\}|(FACTORY|SCF)_TASK/.test(cur.yaml);
  const task = h("textarea", { rows: 5, placeholder: "Describe the task, e.g. “Add a --json flag to the export command”" });
  const repo = h("input", { class: "mono", value: repoPath });
  const vars = Object.entries(flow.vars).map(([k, v]) => [k, h("input", { class: "mono", value: v })]);
  const err = h("p", { class: "status bad flush", role: "alert" });
  const start = h("button", { class: "primary", onClick: async () => {
    if (!task.value.trim() && flow.workspace !== "empty" && !confirm("Run without a task description?")) return;
    start.disabled = true;
    try {
      const body = {
        task: task.value, repo: repo.value,
        vars: Object.fromEntries(vars.map(([k, el]) => [k, el.value])),
        ...(cur.dirty || !cur.name ? { yaml: cur.yaml } : { flow: cur.name }),
      };
      close((await a.startRun(body)).runId);
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
    cur.dirty ? h("small", { class: "muted" }, "Runs your unsaved edits.") : null,
    err,
    h("div", { class: "row" }, h("span", { class: "spacer" }), h("small", { class: "muted" }, "⌘↵"), start));
}
