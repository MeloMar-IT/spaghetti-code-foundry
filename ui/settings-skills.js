// The Skills card of the Settings page: one generated control for each described skills key.
import { h, mount } from "./dom.js";
import { settingControl } from "./kit/forms.js";

/** The longest key that is `path` or a dotted prefix of it; undefined when none is. */
export function issueKey(path, keys) {
  if (typeof path !== "string") return undefined;
  let best;
  for (const k of keys) {
    if ((path === k || path.startsWith(`${k}.`)) && (best === undefined || k.length > best.length)) best = k;
  }
  return best;
}

/** The text shown at a control: `Line N` for a list entry, `Row N, <field>` for a record, else the plain message. */
export function issueText(path, key, message, description) {
  const rest = path === key ? [] : path.slice(key.length + 1).split(".");
  if (description?.kind === "list" && /^\d+$/.test(rest[0] ?? "")) {
    const n = Number(rest[0]) + 1;
    if (description.fields) return rest[1] ? `Row ${n}, ${rest[1]}: ${message}` : `Row ${n}: ${message}`;
    return `Line ${n}: ${message}`;
  }
  return message;
}

/** Groups of the card. A pattern ending in "." is a prefix; any other pattern is an exact key. */
export const SKILL_GROUPS = [
  { title: "Where skills come from", keys: ["skills.builtin", "skills.roots", "skills.repository", "skills.releases.allow_unreleased", "skills.releases.approved"] },
  { title: "Catalogue for the planner", keys: ["skills.catalogue."] },
  { title: "Selection", keys: ["skills.selection."] },
  { title: "Review checks", keys: ["skills.review."] },
  { title: "Skills that cannot be used", keys: ["skills.unresolved."] },
  { title: "Tools a skill may ask for", keys: ["skills.tools."] },
];

const matches = (key, p) => (p.endsWith(".") ? key.startsWith(p) : key === p);

/** The title of the group a setting key belongs to, or undefined. */
export const groupOf = (key) => SKILL_GROUPS.find((g) => g.keys.some((p) => matches(String(key), p)))?.title;

/** The value at a dotted path (relative to `skills`); undefined when missing. */
export function valueAt(obj, path) {
  let cur = obj;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** A copy of `obj` with `value` at the dotted path. Copies each level on the path; the input is never changed. */
export function withValue(obj, path, value) {
  const [head, ...tail] = path.split(".");
  const base = obj !== null && typeof obj === "object" ? obj : {};
  return { ...base, [head]: tail.length ? withValue(base[head], tail.join("."), value) : value };
}

const list = (v) => (Array.isArray(v) ? v : []);

const WORDS = { unknown: "unknown", missing: "not installed", untrusted: "not from an approved release", conflict: "in conflict", oversized: "too large" };

const turnedOn = (key, text) => ({
  key,
  sentences: (before, after) => (valueAt(after, key) === true && valueAt(before, key) !== true ? [text] : []),
});

/** The changes that lower safety. `sentences(before, after)` works on the values of `skills`. */
export const RISKS = [
  turnedOn("repository", "The skills folder of the repository a run works on is read too; anyone who can push to that repository decides what is in it. Repository skills are listed but never selected for a run."),
  turnedOn("releases.allow_unreleased", "Skill folders that are not an approved catalogue release are loaded; each skill must still match its pin. For development only."),
  {
    key: "roots",
    sentences: (before, after) => {
      const old = new Set(list(valueAt(before, "roots")));
      return list(valueAt(after, "roots")).some((r) => !old.has(r))
        ? ["Skills in a new folder can reach the agents once they are pinned; make sure only administrators can write to it."]
        : [];
    },
  },
  ...Object.entries(WORDS).map(([name, words]) => ({
    key: `unresolved.${name}`,
    sentences: (before, after) => (valueAt(after, `unresolved.${name}`) === "warn" && valueAt(before, `unresolved.${name}`) !== "warn"
      ? [`A requested skill that is ${words} no longer stops the run; it only gives a warning.`] : []),
  })),
  {
    key: "unresolved.high_risk",
    sentences: (before, after) => {
      const now = new Set(list(valueAt(after, "unresolved.high_risk")));
      return list(valueAt(before, "unresolved.high_risk")).filter((t) => !now.has(t)).map((t) => `A skill marked high-risk by ${t} no longer always stops the run.`);
    },
  },
  turnedOn("tools.network", "Skills that ask for network access may pass the plan gate."),
  {
    key: "tools.missing",
    sentences: (before, after) => (valueAt(after, "tools.missing") === "degrade" && valueAt(before, "tools.missing") !== "degrade"
      ? ["A skill whose tool is not available no longer stops the run; it runs without that tool."] : []),
  },
];

/** The risky changes from the saved skills to the draft: [{ key: "skills.<path>", text }]. */
export function riskyChanges(saved, draft) {
  return RISKS.flatMap((r) => r.sentences(saved, draft).map((text) => ({ key: `skills.${r.key}`, text })));
}

const clone = (v) => structuredClone(v ?? {});

/** The card. `value()` is the `skills` to save, `risks()` the risky changes since the last save, `saved(skills)` moves the baseline. */
export function skillsSection(descriptions, skills, { disabled = false } = {}) {
  let baseline = clone(skills);
  let draft = clone(skills);
  const shown = (Array.isArray(descriptions) ? descriptions : []).filter((d) => groupOf(d?.key) !== undefined);
  if (shown.length === 0) {
    return {
      el: h("div", { class: "card mb-14" }, h("h3", {}, "Skills"), h("p", { class: "muted flush" }, "The skills settings could not be described by the server.")),
      value: () => skills,
      risks: () => [],
      saved: () => {},
      busy: () => {},
      showIssues: (issues) => (Array.isArray(issues) ? issues : []),
    };
  }
  const slots = {};
  const descriptionOf = {};
  let messages = {};
  let locked = false;
  const build = (d) => {
    const rel = d.key.slice("skills.".length);
    const texts = messages[d.key];
    return settingControl(d, {
      value: valueAt(draft, rel),
      disabled: disabled || locked,
      error: texts?.length ? texts.map((t) => h("div", {}, t)) : undefined,
      onChange: (v) => { draft = withValue(draft, rel, v); },
    });
  };
  const draw = (key) => mount(slots[key], build(descriptionOf[key]));
  const groups = SKILL_GROUPS.map((g) => {
    const mine = shown.filter((d) => groupOf(d.key) === g.title);
    if (!mine.length) return null;
    const controls = mine.map((d) => {
      descriptionOf[d.key] = d;
      slots[d.key] = h("div", {}, build(d));
      return slots[d.key];
    });
    return h("div", { class: "stack mt-10" }, h("h4", {}, g.title), h("div", { class: "grid" }, controls));
  });
  const shownKeys = Object.keys(slots);
  return {
    el: h("div", { class: "card mb-14" }, h("h3", {}, "Skills"), ...groups),
    value: () => draft,
    risks: () => riskyChanges(baseline, draft),
    saved: (s) => { baseline = clone(s); },
    /** Locks the controls while a save runs, so no typing is lost when the answer redraws them. */
    busy: (on) => { locked = on === true; for (const k of shownKeys) draw(k); },
    /** Shows each issue at its control, redraws the controls from the draft; returns the issues it could not place. */
    showIssues: (issues) => {
      const old = Object.keys(messages);
      const next = {};
      const unplaced = [];
      for (const i of Array.isArray(issues) ? issues : []) {
        const key = typeof i?.path === "string" && typeof i?.message === "string" ? issueKey(i.path, shownKeys) : undefined;
        if (key === undefined) unplaced.push(i);
        else (next[key] ??= []).push(issueText(i.path, key, i.message, descriptionOf[key]));
      }
      messages = next;
      for (const k of new Set([...old, ...Object.keys(next)])) draw(k);
      return unplaced;
    },
  };
}
