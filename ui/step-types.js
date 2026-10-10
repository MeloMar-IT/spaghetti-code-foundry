import { glyph, h } from "./dom.js";
import { area, field, insertAtCursor, list, select, setKey, text } from "./fields.js";

const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** Per step type: icon, label, the fields of a new step and the option groups it has. */
export const STEP_TYPES = {
  claude: { icon: "◆", label: "Agent (Claude Code or Codex)", blank: { type: "claude", prompt: "" }, groups: ["routing", "limits", "sandbox", "model"] },
  shell: { icon: "$", label: "Shell", blank: { type: "shell", run: "" }, groups: ["routing", "limits", "sandbox"] },
  approval: { icon: "✋", label: "Approval (wait for a human)", blank: { type: "approval", message: "Continue?" }, groups: ["routing", "limits"] },
  parallel: { icon: "⇉", label: "Parallel (run steps at once)", blank: { type: "parallel", steps: [] }, groups: ["routing", "limits"] },
  flow: { icon: "⧉", label: "Sub-flow (run another flow)", blank: { type: "flow", flow: "" }, groups: ["routing", "limits"] },
};

const chips = (target, values) =>
  h("div", { class: "chips" }, values.map((c) => h("button", { class: "chip", type: "button", onClick: () => insertAtCursor(target, c) }, c)));

/** Jump targets for a step: the fixed ones and every other step. */
export function targetOptions(flow, self, fallback) {
  const base = [["next", "next step"], ["end", "end (success)"], ["fail", "fail run"], ["stop", "stop (needs a human)"]];
  const steps = flow.steps.filter((s) => s !== self).map((s) => [s.id, `→ ${s.id}`]);
  return [["", `${fallback} (default)`], ...base.filter(([v]) => v !== fallback), ...steps];
}

/** The essentials of a step by type: prompt and model, the command, the question, the step picker or the sub-flow. */
export function stepMain(flow, step, i, { onChange, rerender, vars = [], earlier = [] }) {
  const d = flow.defaults ?? {};
  switch (step.type) {
    case "claude": {
      const prompt = area(step, "prompt", onChange, { rows: 7, placeholder: "What should the agent do? Use {{task}} for the run's task." });
      return [
        field("Prompt", prompt),
        chips(prompt, ["{{task}}", "{{learnings}}", "{{run.history}}", ...vars.map((v) => `{{vars.${v}}}`), ...earlier.map((id) => `{{steps.${id}.output}}`)]),
        field("Model", text(step, "model", onChange, { list: "models", mono: true, placeholder: d.model ?? "(router / default)" }), "sonnet · codex · ollama:qwen3-coder"),
      ];
    }
    case "shell": {
      const run = area(step, "run", onChange, { rows: 3, placeholder: "npm test" });
      return [
        field("Command", run, "Exit code 0 = success. Untrusted text is in env: $FACTORY_TASK, $FACTORY_OUT_<STEP_ID>, $FACTORY_VAR_<NAME>."),
        chips(run, ["{{workdir}}", "{{run.id}}", ...vars.map((v) => `{{vars.${v}}}`)]),
      ];
    }
    case "approval":
      return [
        field("Question for the approver", area(step, "message", onChange, { rows: 2 }), "The run pauses here. Approve → on success, reject → on failure. Approve in the UI, with `scf approve`, or /approve on the ticket."),
      ];
    case "parallel": {
      const candidates = flow.steps.filter((s) => s !== step && (s.type === "claude" || s.type === "shell"));
      step.steps ??= [];
      return [
        field("Run these steps at the same time", h("div", { class: "checks", "data-field": "steps", tabindex: "-1" },
          candidates.length
            ? candidates.map((s) => h("label", { class: "row tight" },
                h("input", { type: "checkbox", class: "fit", "data-field": `steps.${s.id}`, checked: step.steps.includes(s.id), onChange: (e) => {
                  step.steps = e.target.checked ? [...step.steps, s.id] : step.steps.filter((x) => x !== s.id);
                  rerender();
                } }),
                h("span", { class: "mono" }, s.id), s.jump_only ? null : h("span", { class: "muted" }, "(tip: mark it “only reachable via jumps”)")))
            : h("span", { class: "muted" }, "Add claude or shell steps first.")),
          "Succeeds when all of them succeed. Output combines theirs."),
      ];
    }
    case "flow": {
      step.vars ??= {};
      const entries = Object.entries(step.vars);
      const setVars = (e) => { step.vars = Object.fromEntries(e); onChange(); };
      return [
        field("Flow to run", text(step, "flow", onChange, { list: "flow-names", mono: true, placeholder: "flow name" }), "Runs in the same workspace. Its steps appear as <this id>/<step>."),
        h("div", { class: "kv", "data-field": "vars", tabindex: "-1" },
          entries.flatMap(([k, v], j) => [
            h("input", { class: "mono", value: k, placeholder: "var", onChange: (e) => { entries[j][0] = e.target.value.trim(); setVars(entries); rerender(); } }),
            h("input", { class: "mono", value: v, placeholder: "value (may use {{vars.x}})", "data-field": `vars.${k}`, onInput: (e) => { entries[j][1] = e.target.value; setVars(entries); } }),
            h("button", { class: "icon", title: "Remove variable", "aria-label": "Remove variable", onClick: () => { entries.splice(j, 1); setVars(entries); rerender(); } }, glyph("✕")),
          ])),
        h("button", { class: "small", onClick: () => { entries.push([`var${entries.length + 1}`, ""]); setVars(entries); rerender(); } }, "+ Variable for sub-flow"),
      ];
    }
    default:
      return [h("p", { class: "status bad" }, `Unknown step type "${step.type}" — edit it in the YAML tab.`)];
  }
}

function checkbox(obj, key, label, onChange, inherited) {
  return h("label", { class: "row tight text-sm" },
    h("input", { type: "checkbox", class: "fit", "data-field": key, checked: obj[key] ?? !!inherited, onChange: (e) => { setKey(obj, key, e.target.checked || (inherited ? false : "")); onChange(); } }),
    h("span", {}, label));
}

const has = (v) => v != null && v !== "";

function routingGroup(flow, step, { onChange, rerender }) {
  const routes = step.routes ?? [];
  const setRoutes = (r) => { setKey(step, "routes", r.filter((x) => x.if || x.goto)); onChange(); };
  const targets = targetOptions(flow, step, "next").slice(1);
  const opts = [["", "choose…"], ...targets];
  // Agent, shell and approval steps always show the pattern fields; the others only while that field holds a value.
  const always = step.type === "claude" || step.type === "shell" || step.type === "approval";
  const patterns = [];
  if (always || has(step.pass_if)) patterns.push(field("Pass only if output matches", text(step, "pass_if", onChange, { mono: true, placeholder: "regex, e.g. ^VERDICT: APPROVE" })));
  if (always || has(step.fail_if)) patterns.push(field("Fail if output matches", text(step, "fail_if", onChange, { mono: true, placeholder: "regex" })));
  return {
    id: "routing",
    title: `Routing${routes.length ? ` (${routes.length} route${routes.length > 1 ? "s" : ""})` : ""}`,
    open: has(step.on_success) || has(step.on_failure) || routes.length > 0 || !!step.jump_only || has(step.pass_if) || has(step.fail_if) || has(step.resume_from),
    nodes: [
      h("div", { class: "grid" },
        field("On success →", select(step, "on_success", targets, () => { onChange(); }, { emptyLabel: "next (default)" })),
        field("On failure →", select(step, "on_failure", targetOptions(flow, step, "fail").slice(1), () => { onChange(); }, { emptyLabel: "fail run (default)" }))),
      h("label", { class: "row tight text-sm" },
        // The data-field key is split so the words test does not read it as shown text.
        h("input", { type: "checkbox", class: "fit", "data-field": "jump" + "_only", checked: !!step.jump_only,
          onChange: (e) => { setKey(step, "jump_only", e.target.checked || ""); rerender(); } }),
        h("span", {}, "Only reachable via jumps"),
        h("span", { class: "muted" }, "— skipped in normal order, e.g. an “ask for info” or “fix” handler")),
      patterns.length ? h("div", { class: "grid" }, patterns) : null,
      h("div", { class: "route-list", "data-field": "routes", tabindex: "-1" },
        routes.map((r, j) => h("div", { class: "route" },
          h("span", { class: "muted" }, "if output matches"),
          h("input", { class: "mono", value: r.if ?? "", placeholder: "^ROUTE: small", "data-field": `routes.${j}.if`, onInput: (e) => { routes[j].if = e.target.value; setRoutes(routes); } }),
          h("span", { class: "muted" }, "go to"),
          h("select", { "data-field": `routes.${j}.goto`, onChange: (e) => { routes[j].goto = e.target.value; setRoutes(routes); rerender(); } },
            opts.map(([v, l]) => h("option", { value: v, selected: r.goto === v }, l))),
          h("button", { class: "icon", title: "Remove route", "aria-label": "Remove route", onClick: () => { routes.splice(j, 1); setRoutes(routes); rerender(); } }, glyph("✕"))))),
      h("button", { class: "small", onClick: () => { step.routes = [...routes, { if: "", goto: "" }]; rerender(); } }, "+ Route"),
      h("small", { class: "muted block mt-6 mb-10" }, "Checked on success, before “On success”. First match wins."),
      field("When resumed after stopping here, restart at",
        select(step, "resume_from", flow.steps.filter((s) => s !== step).map((s) => [s.id, s.id]), () => { onChange(); rerender(); }, { emptyLabel: step.jump_only ? "the step that jumped here" : "this step" })),
    ],
  };
}

/** The option groups of a step: `[{ id, title, open, nodes }]`. A group is open when it holds a value. */
export function stepGroups(flow, step, i, ctx) {
  const { onChange } = ctx;
  const d = flow.defaults ?? {};
  const out = [];
  for (const id of STEP_TYPES[step.type]?.groups ?? []) {
    if (id === "routing") out.push(routingGroup(flow, step, ctx));
    else if (id === "limits") {
      out.push({
        id, title: "Limits",
        open: has(step.max_visits) || has(step.timeout_sec) || has(step.max_budget_usd),
        nodes: [h("div", { class: "grid" },
          field("Max visits", text(step, "max_visits", onChange, { type: "number", placeholder: String(d.max_visits ?? 5) })),
          field("Timeout (sec)", text(step, "timeout_sec", onChange, { type: "number", placeholder: d.timeout_sec ? String(d.timeout_sec) : "none" })),
          step.type === "claude" ? field("Budget ($)", text(step, "max_budget_usd", onChange, { type: "number" }), "Claude Code only") : null)],
      });
    } else if (id === "sandbox") {
      out.push({
        id, title: "Sandbox & access",
        open: step.sandbox != null || !!step.repo_access,
        nodes: step.type === "shell"
          ? [
            checkbox(step, "sandbox", "Run in Docker (for commands that execute repo code, like tests)", onChange),
            checkbox(step, "repo_access", "Needs repository access (for commands that call gh, or clone, fetch, pull or push)", onChange),
          ]
          : [checkbox(step, "sandbox", "Sandbox the agent's shell commands for this step", onChange, flow.sandbox?.claude)],
      });
    } else if (id === "model") {
      const prior = flow.steps.slice(0, i).filter((s) => s.type === "claude").map((s) => [s.id, s.id]);
      out.push({
        id, title: "Model & agent settings",
        open: has(step.agent) || has(step.provider) || has(step.permission_mode) || !!step.allowed_tools?.length || has(step.system_prompt) || has(step.resume) || has(step.effort) || has(step.skill_role),
        nodes: [
          h("div", { class: "grid" },
            field("Agent", select(step, "agent", [["claude", "Claude Code"], ["codex", "Codex (ChatGPT)"]], onChange, { emptyLabel: d.agent ? `${d.agent} (flow default)` : "from model" })),
            field("Provider", text(step, "provider", onChange, { list: "provider-names", mono: true, placeholder: d.provider ?? "from model" }), "anthropic, openai, ollama, lmstudio or your own"),
            field("Permissions", select(step, "permission_mode", PERMISSION_MODES.map((m) => [m, m]), onChange, { emptyLabel: `${d.permission_mode ?? "acceptEdits"} (default)` })),
            field("Effort", select(step, "effort", EFFORTS.map((m) => [m, m]), onChange, { emptyLabel: d.effort ? `${d.effort} (flow default)` : "(default)" })),
            field("Skill role", select(step, "skill_role", [["coder", "coder"], ["reviewer", "reviewer"]], onChange, { emptyLabel: "(none)" })),
            field("Continue session of", select(step, "resume", prior, onChange, { emptyLabel: "— new session —" }))),
          field("Allowed tools", list(step, "allowed_tools", onChange, d.allowed_tools?.join(", ") || "(flow default)")),
          field("Extra system prompt", area(step, "system_prompt", onChange, { rows: 2 })),
        ],
      });
    }
  }
  return out;
}

/** A group as a `details` that is open when it holds a value. */
export function groupBox(g) {
  return h("details", { class: "group", "data-group": g.id, open: g.open }, h("summary", {}, g.title), g.nodes);
}

/** The whole body of a step: the essentials, then the groups. */
export function stepBody(flow, step, i, ctx) {
  return [...stepMain(flow, step, i, ctx), ...stepGroups(flow, step, i, ctx).map(groupBox)];
}

/** The routing group, or null when the step type has none. */
export function stepAdvanced(flow, step, ctx) {
  const g = stepGroups(flow, step, flow.steps.indexOf(step), ctx).find((x) => x.id === "routing");
  return g ? groupBox(g) : null;
}
