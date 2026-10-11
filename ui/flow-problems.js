import { h } from "./dom.js";

/**
 * @typedef {{ message: string, path: (string|number)[], stepIndex: number|null, stepId: string|null,
 *             field: string|null, section: string|null, line: number|null, col: number|null }} Problem
 */

const SECTIONS = ["defaults", "limits", "sandbox", "vars"];
const FLOW_KEYS = ["name", "description", "workspace", "one_per_repo"];

/** Where in the editor a path points: a step (and field) or a settings section (and field). */
export function locate(path) {
  const none = { stepIndex: null, field: null, section: null };
  if (!Array.isArray(path) || !path.length) return none;
  const [a, b, c] = path;
  if (a === "steps") {
    if (!Number.isInteger(b) || b < 0) return none;
    // A route entry points at its own input: steps.0.routes.1.if -> "routes.1.if".
    if (c === "routes" && Number.isInteger(path[3]) && typeof path[4] === "string") return { stepIndex: b, field: `routes.${path[3]}.${path[4]}`, section: null };
    // A sub-flow variable points at its own value input: steps.0.vars.x -> "vars.x".
    if (c === "vars" && typeof path[3] === "string") return { stepIndex: b, field: `vars.${path[3]}`, section: null };
    return { stepIndex: b, field: typeof c === "string" ? c : null, section: null };
  }
  if (SECTIONS.includes(a)) return { stepIndex: null, field: typeof b === "string" ? b : null, section: a };
  if (a === "publish") {
    let field = null;
    if (path.length === 2 && typeof b === "string") field = b;
    else if (b === "vars" && path.length === 4 && typeof c === "string" && typeof path[3] === "string") field = `vars.${c}.${path[3]}`;
    return { stepIndex: null, field, section: "publish" };
  }
  if (path.length === 1 && FLOW_KEYS.includes(a)) return { stepIndex: null, field: a, section: "flow" };
  return none;
}

/** The 1-based { line, col } of a path in the YAML text, or null when the path is not there. */
export function lineOf(yamlText, path, YAML) {
  try {
    if (!Array.isArray(path) || !path.length) return null;
    const lc = new YAML.LineCounter();
    const doc = YAML.parseDocument(yamlText, { lineCounter: lc });
    let node = doc.contents;
    let pos = node;
    for (let i = 0; i < path.length; i++) {
      const seg = path[i];
      let next = null;
      let at = null;
      if (YAML.isMap(node)) {
        const pair = node.items.find((p) => String(p.key?.value ?? p.key) === String(seg));
        if (pair) { next = pair.value; at = pair.key; }
      } else if (YAML.isSeq(node) && Number.isInteger(seg)) {
        next = node.items[seg];
        at = next;
      }
      if (!at) {
        // A missing last key (a required field) is reported on its parent.
        if (i === path.length - 1 && YAML.isMap(node) && pos?.range) return lc.linePos(pos.range[0]);
        return null;
      }
      pos = at;
      node = next;
    }
    return pos?.range ? lc.linePos(pos.range[0]) : null;
  } catch {
    return null;
  }
}

/** Character offset of a 1-based line and column, kept inside the text. */
export function offsetOf(text, line, col) {
  const lines = text.split("\n");
  let off = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i++) off += lines[i].length + 1;
  if (line - 1 >= lines.length) return text.length;
  return Math.max(0, Math.min(text.length, off + Math.max(0, col - 1)));
}

/** The problems of a validate answer, each with the place it points at. [] when the flow is valid. */
export function problemsOf(result, yamlText, YAML) {
  if (!result || result.ok) return [];
  let doc = null;
  let lc = null;
  let js = null;
  try {
    lc = new YAML.LineCounter();
    doc = YAML.parseDocument(yamlText, { lineCounter: lc });
    js = doc.toJS();
  } catch { /* the text does not parse; fall through */ }
  const blank = { stepIndex: null, stepId: null, field: null, section: null, line: null, col: null };
  if (Array.isArray(result.issues) && result.issues.length) {
    return result.issues.map((i) => {
      const loc = locate(i.path);
      const id = loc.stepIndex != null ? js?.steps?.[loc.stepIndex]?.id : null;
      const at = lineOf(yamlText, i.path, YAML);
      return { message: i.message, path: i.path, ...blank, ...loc, stepId: typeof id === "string" ? id : null, line: at?.line ?? null, col: at?.col ?? null };
    });
  }
  const message = String(result.error ?? "").replace(/^<flow>: /, "");
  // Only an explicit `issues: []` from the server means a syntax error; anything else (network error, old server) stays plain.
  const syntax = Array.isArray(result.issues) && doc?.errors?.length ? doc.errors[0].linePos?.[0] : null;
  return [{ message, path: [], ...blank, line: syntax?.line ?? null, col: syntax?.col ?? null }];
}

/** True when a click on the problem can go somewhere in this mode ("visual" or "yaml"). */
export function hasPlace(p, mode) {
  return mode === "yaml" ? p.line != null : p.stepIndex != null || p.section != null;
}

/** One row per problem: a button when it has a place, plain text otherwise. */
export function renderProblems(problems, { onOpen, mode = "visual" } = {}) {
  if (!problems?.length) return null;
  return h("div", { class: "errors" },
    h("ul", { class: "problem-list" },
      problems.map((p) => {
        const label = p.path.length ? `${p.path.join(".")}: ${p.message}` : p.message;
        return h("li", {}, hasPlace(p, mode)
          ? h("button", { type: "button", class: "problem-link", onClick: () => onOpen?.(p) }, label)
          : h("span", {}, label));
      })));
}

/** `renderProblems` under a name that does not clash with the monitor page's `renderProblems` in ui/app.js. */
export const renderFlowProblems = renderProblems;

const byAttr =(root, attr, test) => [...root.querySelectorAll(`[${attr}]`)].find((el) => test(el.getAttribute(attr)));

function openDetails(el) {
  for (let d = el.closest?.("details"); d; d = d.parentNode?.closest?.("details")) d.open = true;
}

function focusControl(el) {
  openDetails(el);
  el.focus?.({ preventScroll: true });
  el.scrollIntoView?.({ behavior: "smooth", block: "center" });
}

/** Finds the control of a field; a nested field ("routes.1.if") falls back to its parent ("routes"). */
function findControl(box, field) {
  for (let f = field; f; f = f.includes(".") ? f.slice(0, f.lastIndexOf(".")) : "") {
    const el = byAttr(box, "data-field", (v) => v === f);
    if (el) return el;
  }
  return null;
}

/**
 * Shows the "has a problem" mark on the rows of the structure list: on the step rows of steps with a problem
 * and on the settings row for a problem in a settings section. An empty list clears all marks.
 */
export function markProblems(root, problems) {
  if (!root) return;
  for (const row of root.querySelectorAll("[data-step]")) {
    const mark = row.querySelector("[data-mark]");
    if (!mark) continue;
    const key = row.getAttribute("data-step");
    mark.hidden = !(problems ?? []).some((p) => (key === "settings" ? p.stepIndex == null && p.section != null : p.stepIndex === Number(key)));
  }
}

/** Selects the step or opens the settings section a problem points at. False when it is not there. */
export function openInVisual(root, p, select) {
  if (!root) return false;
  if (p.stepIndex != null) {
    const find = () => byAttr(root, "id", (v) => v === `step-${p.stepIndex}`);
    if (!find() && !byAttr(root, "data-step", (v) => v === String(p.stepIndex))) return false;
    select(p.stepIndex, true);
    const card = find();
    if (!card) return false;
    const control = findControl(card, p.field);
    if (control) focusControl(control);
    return true;
  }
  if (p.section) {
    const find = () => byAttr(root, "data-section", (v) => v.split(" ").includes(p.section));
    let box = find();
    if (!box) {
      select("settings", true);
      box = find();
    }
    if (!box) return false;
    openDetails(box);
    const control = findControl(box, p.field);
    if (control) focusControl(control);
    else box.scrollIntoView?.({ block: "center" });
    return true;
  }
  return false;
}

/** Puts the cursor of the YAML textarea on the problem's line. False when the place is not in the text. */
export function openInYaml(textarea, p, YAML) {
  if (!textarea) return false;
  const text = textarea.value;
  const at = p.path.length ? lineOf(text, p.path, YAML) : p.line != null ? { line: p.line, col: p.col ?? 1 } : null;
  if (!at) return false;
  textarea.focus();
  textarea.selectionStart = textarea.selectionEnd = offsetOf(text, at.line, at.col);
  const lines = text.split("\n").length;
  textarea.scrollTop = Math.max(0, ((textarea.scrollHeight || 0) * (at.line - 1)) / lines - (textarea.clientHeight || 0) / 2);
  textarea.scrollIntoView?.({ block: "nearest" });
  return true;
}
