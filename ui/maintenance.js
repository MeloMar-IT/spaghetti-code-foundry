import { api } from "./api.js";
import { confirmDialog, h, mount, toast } from "./dom.js";
import { check, input } from "./fields.js";

/** The admin page for clean-up work: removes old run workspaces. */
export async function renderMaintenance(main) {
  const days = input("7", { type: "number", min: 0, class: "w-90" });
  const purge = check(false, "Also delete run logs");
  const paused = check(false, "Include stopped / waiting runs (they can't be resumed afterwards)");
  const out = h("div");
  const go = async (dryRun) => {
    if (!dryRun && !(await confirmDialog({ title: "Remove these workspaces now?", text: "Branches in your repos are kept.", confirm: "Clean up" }))) return;
    try {
      const r = await api.clean({ olderThanDays: Number(days.value), purge: purge.el.checked, includePaused: paused.el.checked, dryRun });
      mount(out, h("p", { class: dryRun ? "muted flush" : "status ok flush" },
        `${dryRun ? "Would remove" : "Removed"} ${r.workspaces.length} workspace(s)${r.runs.length ? ` and ${r.runs.length} run(s)` : ""} · ${r.freedMb} MB`,
        r.kept.length ? ` · keeping ${r.kept.length} paused/running` : ""));
    } catch (e) {
      toast(e.message, "error");
    }
  };
  mount(main,
    h("div", { class: "toolbar" }, h("h1", {}, "Maintenance")),
    h("div", { class: "card mb-14" },
      h("h3", {}, "Disk"),
      h("p", { class: "muted flush" }, "Each run keeps its workspace (worktree or clone) so you can inspect or resume it. Clean up old ones here or with ", h("code", {}, "scf clean"), "."),
      h("div", { class: "row" }, h("span", {}, "Runs finished more than"), days, h("span", {}, "days ago")),
      purge.row, paused.row,
      h("div", { class: "row" }, h("button", { onClick: () => go(true) }, "Preview"), h("button", { class: "danger", onClick: () => go(false) }, "Clean up"), out)));
}
