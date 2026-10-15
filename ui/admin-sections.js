// The Settings page sections that are drawn from the setting description (GET /api/settings), and the helpers that put
// the same hint under the hand-built controls of ui/admin.js.
import { h, mount } from "./dom.js";
import { lockReadOnly } from "./fields.js";
import { settingHint } from "./kit/core.js";
import { settingControl } from "./kit/forms.js";
import { valueAt, withValue } from "./settings-skills.js";

// The same rules as STEP_ENV_NAME and STEP_ENV_REFUSED in src/config.ts (ui/ cannot import src/); tests/ui-admin-sections.test.ts pins them.
export const STEP_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*(_\*)?$/;
export const STEP_ENV_REFUSED = /^(FACTORY_|SCF_|GH_|GITHUB_|GIT_|SSH_)/;

/** Why the value of the described setting would be refused, in one sentence; undefined when it is fine. */
export function settingProblem(d, value) {
  const items = Array.isArray(value) ? value : [];
  if (d.kind === "list" && d.maxItems !== undefined && items.length > d.maxItems) return `At most ${d.maxItems} items; this list has ${items.length}.`;
  if (d.key === "step_env.pass" || d.key === "step_env.agent_pass") {
    for (const n of items) {
      if (STEP_ENV_REFUSED.test(n)) return `"${n}" is never passed: names that start with FACTORY_, SCF_, GH_, GITHUB_, GIT_ or SSH_ are refused.`;
      if (!STEP_ENV_NAME.test(n)) return `"${n}" is not a variable name: use letters, digits and _, and end a prefix with _*.`;
    }
  }
  if (d.key === "sandbox.user_read") {
    for (const p of items) if (!p.startsWith("/")) return `"${p}" is not an absolute path: it must start with /.`;
  }
  return undefined;
}

/** The hint of `key` for a hand-built control: settingHint(d, { format: false }) plus `extra`; just `extra` (or "") when the key is not described. */
export function hintFor(described, key, extra) {
  const d = described.find((x) => x.key === key);
  return [d ? settingHint(d, { format: false }) : "", extra].filter(Boolean).join(" ");
}

let seq = 0;

/** `row` with a small hint under it, linked to `control` by aria-describedby. Returns row unchanged for an empty text. */
export function hinted(row, control, text) {
  if (!text) return row;
  const id = `setting-hint-${++seq}`;
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  control.setAttribute("aria-describedby", [...ids, id].join(" "));
  return h("div", {}, row, h("small", { class: "muted", id }, text));
}

const KEYS = {
  isolate_agents: "isolate_agents",
  "failure_summary.enabled": "failure_summary",
  "failure_summary.model": "failure_summary",
  "step_env.pass": "pass",
  "step_env.agent_pass": "agent_pass",
  "sandbox.user_read": "user_read",
};

/** The cards "Agents" and "User runs" built from the description, and their state. */
export function describedSections(config, described, { section, readOnly = false }) {
  const byKey = Object.fromEntries(described.map((d) => [d.key, d]));
  const state = {
    isolate_agents: config.isolate_agents,
    "failure_summary.enabled": config.failure_summary?.enabled,
    "failure_summary.model": config.failure_summary?.model,
    "step_env.pass": config.step_env?.pass ?? [],
    "step_env.agent_pass": config.step_env?.agent_pass ?? [],
    "sandbox.user_read": config.sandbox?.user_read ?? [],
  };
  const errors = {};
  const slots = {};
  const build = (key) => settingControl(byKey[key], {
    value: state[key],
    error: errors[key],
    onChange: (v) => {
      state[key] = v;
      update(key);
    },
  });
  const draw = (key) => {
    mount(slots[key], build(key));
    if (readOnly) lockReadOnly(slots[key]);
  };
  /** Checks one key; the control is built again only when its message changed. Returns the message. */
  const update = (key) => {
    const problem = settingProblem(byKey[key], state[key]);
    if (problem !== errors[key]) {
      errors[key] = problem;
      draw(key);
    }
    return problem;
  };
  const slot = (key) => {
    if (!byKey[key]) return null;
    slots[key] = h("div");
    draw(key);
    return slots[key];
  };
  const agents = section("Agents", slot("isolate_agents"), slot("failure_summary.enabled"), slot("failure_summary.model"));
  const userRuns = section("User runs", slot("step_env.pass"), slot("step_env.agent_pass"), slot("sandbox.user_read"));
  const element = (key) => slots[key]?.querySelectorAll("input, textarea")[0];
  return {
    cards: [agents, userRuns],
    values() {
      const model = String(state["failure_summary.model"] ?? "").trim();
      return {
        isolate_agents: state.isolate_agents,
        failure_summary: { ...config.failure_summary, enabled: state["failure_summary.enabled"], model: model || byKey["failure_summary.model"]?.default || config.failure_summary?.model },
        step_env: { ...config.step_env, pass: state["step_env.pass"], agent_pass: state["step_env.agent_pass"] },
        user_read: state["sandbox.user_read"],
      };
    },
    check() {
      let first;
      for (const key of Object.keys(slots)) if (update(key) && !first) first = element(key);
      return first;
    },
    /** Marks the controls that have a message again, after the page cleared the marks. */
    restore() {
      for (const key of Object.keys(slots)) if (errors[key]) element(key)?.setAttribute("aria-invalid", "true");
    },
    inputs() {
      const out = {};
      for (const key of Object.keys(slots)) out[KEYS[key]] = element(key); // failure_summary ends as the model field
      return out;
    },
  };
}

/**
 * A card with a generated control for every described key under `prefix` (control "generated"), in description order.
 * `values()` is the stored object at the prefix with only the drawn keys set, so a key with no control (such as
 * help.sensitive_patterns) is saved back exactly as it was stored.
 */
export function generatedSection(title, prefix, config, described, { section, readOnly = false }) {
  const root = prefix.replace(/\.$/, "");
  const list = described.filter((d) => d.key.startsWith(prefix) && d.control === "generated");
  const byKey = Object.fromEntries(list.map((d) => [d.key, d]));
  const state = Object.fromEntries(list.map((d) => [d.key, valueAt(config, d.key)]));
  const errors = {};
  const slots = {};
  const draw = (key) => {
    mount(slots[key], settingControl(byKey[key], {
      value: state[key],
      error: errors[key],
      onChange: (v) => {
        state[key] = v;
        update(key);
      },
    }));
    if (readOnly) lockReadOnly(slots[key]);
  };
  const update = (key) => {
    const problem = settingProblem(byKey[key], state[key]);
    if (problem !== errors[key]) {
      errors[key] = problem;
      draw(key);
    }
    return problem;
  };
  for (const d of list) {
    slots[d.key] = h("div");
    draw(d.key);
  }
  const element = (key) => slots[key]?.querySelectorAll("input, textarea, select")[0];
  const stored = valueAt(config, root);
  return {
    card: list.length ? section(title, ...Object.values(slots)) : null,
    values() {
      if (!list.length) return stored;
      let out = stored !== null && typeof stored === "object" ? { ...stored } : {};
      for (const d of list) {
        const v = state[d.key];
        const empty = v === undefined || (d.optional && Array.isArray(v) && v.length === 0);
        out = withValue(out, d.key.slice(prefix.length), empty ? undefined : v);
      }
      return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
    },
    check() {
      let first;
      for (const key of Object.keys(slots)) if (update(key) && !first) first = element(key);
      return first;
    },
    restore() {
      for (const key of Object.keys(slots)) if (errors[key]) element(key)?.setAttribute("aria-invalid", "true");
    },
    inputs() {
      const out = {};
      for (const key of Object.keys(slots)) out[key] = element(key);
      return out;
    },
  };
}

/** The read-only card "Set at start-up". */
export function startupSection(startup, section) {
  return section("Set at start-up",
    h("p", { class: "muted flush" }, "These come from how the server was started; change them there and restart."),
    startup.map((s) => h("p", { class: "flush" },
      h("strong", {}, `${s.label}: `), h("span", { class: "mono" }, String(s.value)), " ", h("span", { class: "muted" }, `${s.change} Takes effect ${s.effectText}.`))));
}
