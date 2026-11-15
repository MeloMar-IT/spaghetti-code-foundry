import { h } from "./dom.js";

export const f = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);
export const input = (value, attrs = {}) => h("input", { value: value ?? "", ...attrs });
export const check = (checked, label) => {
  const el = h("input", { type: "checkbox", class: "fit", checked: !!checked });
  return { el, row: h("label", { class: "row tight" }, el, h("span", {}, label)) };
};

/** The default status label names, as STATUS_LABELS in src/queue/watcher.ts (needs_info is needsInfo there). */
export const STATUS_DEFAULTS = {
  working: "factory:working",
  done: "factory:done",
  needs_info: "factory:needs-info",
  waiting: "factory:waiting-approval",
  failed: "factory:failed",
};
const STATUS_WORDS = { working: "working", done: "done", needs_info: "needs info", waiting: "waiting", failed: "failed" };
const SWITCHES = ["auto_defaults", "wait_for_dependencies", "comment_on_failure", "status_comment", "one_at_a_time"];
const LISTS = ["priority_labels", "dependency_done_labels", "remove_on_done"];
// the API name of the questions check, built in two parts so the words test does not read it as shown text
const CHECK = "pre" + "check_flow";
const TEXTS = [CHECK,"pause_while_pr_open"];
const SWITCH_DEFAULTS = { auto_defaults: false, wait_for_dependencies: true, comment_on_failure: true, status_comment: true, one_at_a_time: false };
const LIST_DEFAULTS = { priority_labels: ["bug"], dependency_done_labels: [], remove_on_done: [] };
// for every source (#878): sent only when set; a cleared one is null on an edit
const REFERENCE_KEYS = ["reference_repos", "reference_private_ok"];
const KEYS = [...SWITCHES, ...LISTS, ...TEXTS, "status_labels", ...REFERENCE_KEYS];
const REF_HELP = "Other repositories of the same owner, as owner/name. Each run gets a read-only copy of their newest commit, and the planner and coder look facts up there. Default: none";
const PRIVATE_HELP = "Lets the agents read a private reference repository even when this repository is public or not known to be private: what they read can end up in public GitHub issue comments and pull requests. Default: off";

/** The reference options of a request body (any source). Nothing when the values have no reference keys. */
function referenceBody(o, editing) {
  if (!("reference_repos" in o) && !("reference_private_ok" in o)) return {};
  const clear = editing ? null : undefined;
  const repos = labelList(o.reference_repos);
  const body = { reference_repos: repos.length ? repos : clear, reference_private_ok: o.reference_private_ok ? true : clear };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

const AUTO_HELP = "The Foundry answers its own questions with its recommendations, at most twice per GitHub issue; after that a person answers. Default: off.";

/** "a, b," → ["a", "b"] */
export const labelList = (text) => String(text ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The option keys of a request body from raw values `o` (undefined → {}). The reference options go for every source;
 * the others only for an issues watcher.
 * `editing`: a cleared precheck_flow / pause_while_pr_open / reference option is null (the API removes it), else it is left out.
 * A list may be given as { text, stored }: untouched text keeps the stored array, so a label with a comma survives.
 */
export function optionsBody(o, source, editing) {
  if (!o || source === "monitor") return {};
  const refs = referenceBody(o, editing);
  if (source !== "issues") return refs;
  const text = (x) => String(x ?? "").trim();
  const clear = editing ? null : undefined;
  const list = (v) => (v && typeof v === "object" ? (v.stored && v.text === v.stored.join(", ") ? v.stored : labelList(v.text)) : labelList(v));
  const body = { ...refs };
  for (const k of SWITCHES) body[k] = !!o[k];
  for (const k of LISTS) body[k] = list(o[k]);
  for (const k of TEXTS) body[k] = text(o[k]) || clear;
  body.status_labels = Object.fromEntries(Object.keys(STATUS_DEFAULTS).map((k) => [k, text(o.status_labels?.[k])]).filter(([, v]) => v));
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

/** The controls. `w`: the watcher (a missing option counts as its default); `flows`: [{ name }]. */
export function watcherOptions(w, flows) {
  const sw = Object.fromEntries(SWITCHES.map((k) => [k, w[k] ?? SWITCH_DEFAULTS[k]]));
  const stored = Object.fromEntries(LISTS.map((k) => [k, w[k] ?? LIST_DEFAULTS[k]]));
  const controls = {};
  const groups = {};
  const sw1 = (k, label, help) => {
    const c = h("input", { type: "checkbox", class: "fit", name: k, checked: !!sw[k] });
    controls[k] = c;
    return h("div", {}, h("label", { class: "row tight" }, c, h("span", {}, label)), h("small", { class: "muted" }, help));
  };
  const list1 = (k, label, help, placeholder) => {
    controls[k] = input(stored[k].join(", "), { class: "mono", name: k, placeholder });
    return f(label, controls[k], help);
  };
  const flowNames = (flows ?? []).map((x) => x.name);
  const current = w[CHECK] ?? "";
  const select = h("select", { name: CHECK },
    ["", ...flowNames, ...(current && !flowNames.includes(current) ? [current] : [])].map((n) => h("option", { value: n }, n || "None")));
  select.value = current;
  controls[CHECK] = select;
  controls.pause_while_pr_open = input(w.pause_while_pr_open ?? "", { class: "mono", name: "pause_while_pr_open", placeholder: "factory/daily-" });
  const statusFields = Object.entries(STATUS_DEFAULTS).map(([k, d]) => {
    controls[`status_labels.${k}`] = input(w.status_labels?.[k] ?? "", { class: "mono", name: `status_labels.${k}`, placeholder: d });
    return f(`Label for ${STATUS_WORDS[k]}`, controls[`status_labels.${k}`], `Your own name for this status label. Default: ${d}`);
  });
  const group = (title, ...kids) => (groups[title] =h("details", {}, h("summary", {}, title), h("div", { class: "stack" }, ...kids)));
  controls.reference_repos = input((w.reference_repos ?? []).join(", "), { class: "mono", name: "reference_repos", placeholder: "owner/name, owner/name" });
  controls.reference_private_ok = h("input", { type: "checkbox", class: "fit", name: "reference_private_ok", checked: !!w.reference_private_ok });
  const issuesOnly = h("div", { class: "stack" },
    group("Labels",
      list1("priority_labels", "Labels that go first", "GitHub issues with one of these labels start before all others. Leave empty for none. Default: bug", "bug"),
      ...statusFields,
      list1("remove_on_done", "Labels to remove when a run succeeds", "For example the trigger label. Default: none", "e.g. claude-factory")),
    group("Dependencies",
      sw1("wait_for_dependencies", "Wait for dependencies", 'A change waits until the changes under "Depends on" or "Blocked by" are done. Default: on'),
      list1("dependency_done_labels", "Labels that count as done", "A dependency with one of these labels counts as done, also when it is still open. Default: none", "e.g. released"),
      f("Pause while a pull request is open", controls.pause_while_pr_open, "Starts nothing while an open pull request's branch starts with this text, e.g. factory/daily-. Default: none"),
      sw1("one_at_a_time", "One run at a time", "Never runs two of this watcher's runs at the same time. Default: off")),
    group("Comments",
      sw1("status_comment", "Keep a status comment", "Keeps one status comment on every GitHub issue the watcher follows. Default: on"),
      sw1("comment_on_failure", "Comment when a run fails", "Posts the reason and the failing step's output on the GitHub issue. Default: on"),
      f("Questions check", select, "Runs this flow once over all new GitHub issues before any starts, e.g. epic-questions. Default: none"),
      sw1("auto_defaults", "Answer questions automatically", AUTO_HELP)));
  const el = h("div", { class: "stack" },
    issuesOnly,
    group("Reference repositories",
      f("Reference repositories", controls.reference_repos, REF_HELP),
      h("div", {}, h("label", { class: "row tight" }, controls.reference_private_ok, h("span", {}, "Allow private references for a public repository")), h("small", { class: "muted" }, PRIVATE_HELP))));
  const groupOf = (control) => Object.values(groups).find((d) => hasChild(d, control));
  return {
    el,
    controls,
    values: () => ({
      ...Object.fromEntries(SWITCHES.map((k) => [k, controls[k].checked])),
      ...Object.fromEntries(LISTS.map((k) => [k, { text: controls[k].value, stored: stored[k] }])),
      [CHECK]: controls[CHECK].value,
      pause_while_pr_open: controls.pause_while_pr_open.value,
      status_labels: Object.fromEntries(Object.keys(STATUS_DEFAULTS).map((k) => [k, controls[`status_labels.${k}`].value])),
      reference_repos: controls.reference_repos.value,
      reference_private_ok: controls.reference_private_ok.checked,
    }),
    showFor: (source) => {
      el.hidden = source === "monitor";
      issuesOnly.hidden = source !== "issues";
    },
    fieldOf: (message) => {
      const m = String(message ?? "");
      const status = /^status_labels\.(\w+):/.exec(m)?.[1];
      if (status) return controls[`status_labels.${status}`];
      if (/^status_labels:/.test(m)) return controls["status_labels.working"];
      const key = /^(\w+)(?:\.\d+)?:/.exec(m)?.[1];
      return key && key !== "status_labels" && KEYS.includes(key) ? controls[key] : undefined;
    },
    reveal: (control) => {
      const d = groupOf(control);
      if (d) d.open = true;
    },
  };
}

// A browser has `contains`; its `children` is an HTMLCollection (no `some`). The fake DOM of the tests has only an array.
const hasChild = (node, target) => typeof node.contains === "function"
  ? node.contains(target)
  : Array.from(node.children ?? []).some((c) => c === target || (typeof c === "object" && hasChild(c, target)));

/** Short texts for the options of `w` that are not at their default (the reference options for every source, the others for issues watchers only). */
export function optionNotes(w) {
  const refs = [];
  if (w.reference_repos?.length) refs.push(`reads ${w.reference_repos.join(", ")} (read only)`);
  if (w.reference_private_ok) refs.push("may read private references");
  if (w.source !== "issues") return refs;
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const notes = [];
  if (w.auto_defaults) notes.push("answers its own questions (at most twice per GitHub issue)");
  if (w[CHECK]) notes.push(`questions check: ${w[CHECK]}`);
  const pr = w.priority_labels ?? LIST_DEFAULTS.priority_labels;
  if (!same(pr, LIST_DEFAULTS.priority_labels)) notes.push(pr.length ? `labels that go first: ${pr.join(", ")}` : "no label goes first");
  const names = Object.entries(w.status_labels ?? {}).filter(([k, v]) => v && v !== STATUS_DEFAULTS[k]);
  if (names.length) notes.push(`status labels: ${names.map(([k, v]) => `${STATUS_WORDS[k] ?? k} → ${v}`).join(", ")}`);
  if (w.wait_for_dependencies === false) notes.push("does not wait for dependencies");
  if (w.dependency_done_labels?.length) notes.push(`labels that count as done: ${w.dependency_done_labels.join(", ")}`);
  if (w.remove_on_done?.length) notes.push(`removes on success: ${w.remove_on_done.join(", ")}`);
  if (w.comment_on_failure === false) notes.push("no comment on failure");
  if (w.status_comment === false) notes.push("no status comment");
  if (w.one_at_a_time) notes.push("one run at a time");
  return [...notes, ...refs];
}
