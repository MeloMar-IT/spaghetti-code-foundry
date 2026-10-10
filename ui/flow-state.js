// What the flow editor says about the flow it has open: pure functions, no page.

const KEY = "scf-overview";

/** The texts of the editor header for `cur` (the flow being edited), drawn from the list `flows`. */
export function editorState(cur, flows = []) {
  const objName = typeof cur.obj?.name === "string" && cur.obj.name ? cur.obj.name : null;
  const title = objName ?? cur.name ?? "flow";
  const scope = cur.name ? (cur.scope ?? flows.find((f) => f.name === cur.name)?.scope ?? null) : null;
  const target = cur.saveScope === "global" ? "global flows" : "this repo";
  const saveLabel = scope === "builtin" ? `Saves your own copy to ${target}` : `Saves to ${target}`;
  const dirty = !!cur.dirty;
  return {
    title,
    scopeLabel: scope ?? "not saved yet",
    saveLabel,
    dirtyLabel: dirty ? "Unsaved changes" : "Saved",
    validation: validationOf(cur),
    primary: dirty || !cur.name ? "save" : "run",
  };
}

function validationOf(cur) {
  if (cur.checking || !cur.validation) return { kind: "checking", label: "Checking…" };
  if (cur.validation.ok) return { kind: "valid", label: "Valid" };
  const n = cur.problems?.length || 1;
  return { kind: "problems", label: n === 1 ? "1 problem" : `${n} problems` };
}

/** The flows whose name or description holds `query` (any case). */
export function filterFlows(flows, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return flows;
  return flows.filter((f) => `${f.name ?? ""}\n${f.description ?? ""}`.toLowerCase().includes(q));
}

/** Whether the overview is open when the page opens: only when the person chose so. */
export function overviewStartsOpen({ stored }) {
  return stored === "open";
}

/**
 * The remembered choice, in a store that may throw or be missing. get() is "open", "closed" or null.
 * `key` keeps the choice of a wide and a narrow window apart.
 */
export function overviewStore(storage, key = KEY) {
  return {
    get() {
      try {
        const v = storage?.getItem(key);
        return v === "open" || v === "closed" ? v : null;
      } catch {
        return null;
      }
    },
    set(open) {
      try { storage?.setItem(key, open ? "open" : "closed"); } catch { /* storage is off: the choice lasts until reload */ }
    },
  };
}

/** The store of this window: its own key at 1100 px and below. */
export function overviewStoreFor(storage, narrow) {
  return overviewStore(storage, narrow ? `${KEY}-narrow` : KEY);
}
