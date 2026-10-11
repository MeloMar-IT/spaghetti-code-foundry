// Start work: "How do you want to begin?" — a task now, an idea, an existing issue, or a refinement session you
// already have. The repositories for the refine choices are read when one is pressed. Relative imports, so a test can load it.
import { errorText } from "../auth.js";
import { h, toast } from "../dom.js";
import { keptSession, newSessionDialog } from "../refinement-new.js";

export const ENTRY_TITLE = "How do you want to begin?";
export const ENTRY_TASK = "Start a task now";
export const ENTRY_TASK_DRAFT = "Start a task now: carry on with your draft";
export const ENTRY_IDEA = "Refine an idea first";
export const ENTRY_ISSUE = "Refine an existing issue";
export const ENTRY_CONTINUE = "Continue a refinement session";

/** { node, setDraft(has) }. Without `onTask` (no form to start a task from) the first choice is left out. `open` is the dialog (a test may pass its own). */
export function entryChoices({ a, go, readOnly = false, hasDraft = false, onTask, isGone = () => false, open = newSessionDialog }) {
  const task = onTask
    ? h("button", { class: "small primary", "aria-current": "true", "data-focus": "entry-task", onClick: onTask }, hasDraft ? ENTRY_TASK_DRAFT : ENTRY_TASK)
    : null;
  let reading = false;
  const made = (session) => {
    if (!session?.id) return;
    if (isGone()) toast("Refinement session started");
    else go("#/refinement/" + encodeURIComponent(session.id));
  };
  const refine = (label, kind) => h("button", { class: "small", "data-focus": `entry-${kind}`, onClick: async () => {
    if (reading) return;
    reading = true;
    let repos;
    try {
      repos = (await a.refinement(Boolean(keptSession()))).repos; // kept text: a 401 must not reload the page
    } catch (e) {
      toast(errorText(e), "error");
      return;
    } finally {
      reading = false;
    }
    if (isGone()) return;
    await open(repos ?? [], made, { kind });
  } }, label);
  const node = h("div", { class: "start-entry", role: "group", "aria-label": ENTRY_TITLE },
    h("p", { class: "start-label" }, ENTRY_TITLE),
    h("div", { class: "row" }, task,
      readOnly ? null : [refine(ENTRY_IDEA, "idea"), refine(ENTRY_ISSUE, "issue")],
      h("a", { class: "button small", href: "#/refinement" }, ENTRY_CONTINUE)));
  return { node, setDraft: (has) => { if (task) task.textContent = has ? ENTRY_TASK_DRAFT : ENTRY_TASK; } };
}
