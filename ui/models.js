import { api } from "./api.js";
import { fieldFor, glyph, h, markInvalid, mount, toast } from "./dom.js";
import { emptyState, errorState, explainError, loadingState, permissionState } from "./states.js";

const f = (label, el, hint) => h("label", { class: "field" }, h("span", {}, label), el, hint ? h("small", {}, hint) : null);
const input = (value, attrs = {}) => h("input", { value: value ?? "", ...attrs });
const section = (title, ...children) => h("div", { class: "card mb-14" }, h("h3", {}, title), ...children);
const okPill = (ok, text) => h("span", { class: `pill ${ok ? "ok" : "fail"}` }, text ?? (ok ? "ready" : "not ready"));

/** Model specs to suggest in every model field. */
function specSuggestions(providers) {
  const out = ["sonnet", "opus", "haiku", "codex"];
  for (const p of providers) {
    if (!p.ok || !p.models.length) continue;
    for (const m of p.models) {
      out.push(`${p.name}:${m}`);
      if (p.agents.includes("codex")) out.push(`codex:${p.name}:${m}`);
    }
  }
  return out;
}

/** Body-level datalists (#models, #provider-names) used by every model/provider field. */
export async function refreshModelLists(st) {
  try {
    st ??= await api.providers();
  } catch {
    st = { providers: [] };
  }
  const put = (id, values) => {
    let dl = document.getElementById(id);
    if (!dl) document.body.append((dl = h("datalist", { id })));
    mount(dl, values.map((v) => h("option", { value: v })));
  };
  put("models", specSuggestions(st.providers));
  put("provider-names", st.providers.map((p) => p.name));
  return st;
}

// The last model test lives here, not in the page: Reload draws the page again and the result stays.
const test = { spec: "", busy: false, result: null, error: null, view: null };

/** The provider a test went through: the first name in the target (or the typed spec) that is a provider. */
const testedProvider = (providers) => {
  const names = new Set(providers.map((p) => p.name));
  const tokens = [...String(test.result?.target ?? "").split(":"), ...String(test.spec).split(":")];
  return tokens.find((t) => names.has(t));
};

const testSummary = () => (test.result ? `${test.result.ok ? "works" : "failed"} · ${test.result.seconds}s` : "");

function paintTest() {
  const v = test.view;
  if (!v) return;
  test.marks?.();
  v.btn.disabled = test.busy;
  if (test.busy) return mount(v.out, h("span", { class: "spinner" }), " asking the model… (local models can take a few minutes)");
  const r = test.result;
  if (r) {
    return mount(v.out, okPill(r.ok, r.ok ? "works" : "failed"), h("span", { class: "mono" }, ` ${r.target} · ${r.seconds}s`),
      !r.ok ? h("span", { class: "status bad", role: "alert" }, ` ${r.error ?? r.output}`) : null);
  }
  if (test.error) mount(v.out, h("span", { class: "status bad", role: "alert" }, `The model could not be tested. ${test.error.message}`));
  else mount(v.out, null);
}

function testBox(defaultSpec) {
  const spec = input(test.spec || defaultSpec, { class: "mono", list: "models", placeholder: "e.g. ollama:qwen3-coder", "aria-label": "Model to try" });
  const out = h("span", { class: "muted" });
  const btn = h("button", { onClick: async () => {
    if (test.busy) return;
    test.busy = true;
    test.spec = spec.value.trim();
    markInvalid([spec]);
    paintTest();
    try {
      test.result = await api.testModel(test.spec);
      test.error = null;
    } catch (e) {
      test.result = null;
      test.error = e;
    } finally {
      test.busy = false;
      // The page may have been drawn again meanwhile: the newest one shows the answer.
      paintTest();
      if (test.error?.status === 400 && test.view) markInvalid([test.view.spec], test.view.spec);
    }
  } }, "Test");
  test.view = { spec, btn, out };
  paintTest();
  return h("div", { class: "row", "data-model-test-row": "" }, spec, btn, out);
}

// Every change to the config is read, changed and written inside this queue: two actions cannot overwrite each other.
let configLock = Promise.resolve();
function changeConfig(change) {
  const run = configLock.then(async () => {
    const c = await api.config();
    change(c);
    await api.saveConfig(c);
  });
  configLock = run.catch(() => {});
  return run;
}

function agentsCard(agents) {
  return section("Coding agents",
    h("p", { class: "muted flush" }, "Agent steps run on Claude Code or on OpenAI's Codex CLI (with your ChatGPT account). Pick one per step, per flow, or with routing rules below."),
    h("table", { class: "table compact", "aria-label": "Coding agents" },
      h("thead", {}, h("tr", {}, ["Agent", "Status", "Version", "Detail"].map((x) => h("th", { scope: "col" }, h("span", { class: "sr-only" }, x))))),
      h("tbody", {}, agents.map((a) => h("tr", {},
        h("td", {}, h("b", {}, a.agent === "claude" ? "Claude Code" : "Codex (ChatGPT)")),
        h("td", {}, okPill(a.installed && a.loggedIn !== false, !a.installed ? "not installed" : a.loggedIn === false ? "not logged in" : "ready")),
        h("td", { class: "mono muted" }, a.version ?? ""),
        h("td", { class: "muted" }, a.detail))))),
    agents.find((a) => a.agent === "codex" && (!a.installed || a.loggedIn === false))
      ? h("p", { class: "muted flush" }, "To use ChatGPT: run ", h("code", {}, "npm i -g @openai/codex"), " then ", h("code", {}, "codex login"), " in a terminal, and reload this page.")
      : null);
}

function providersCard(cfg, providers, reload, problem) {
  const custom = new Set(Object.keys(cfg.providers));
  const name = input("", { class: "mono", placeholder: "my-proxy" });
  const kind = h("select", {}, ["ollama", "lmstudio", "anthropic-compatible"].map((k) => h("option", { value: k }, k)));
  const url = input("", { class: "mono", placeholder: "http://localhost:11434" });
  const keyEnv = input("", { class: "mono", placeholder: "MY_API_KEY (optional)" });
  const defModel = input("", { class: "mono", placeholder: "qwen3-coder" });
  const add = async () => {
    const n = name.value.trim();
    const inputs = [name, kind, url, keyEnv, defModel];
    if (!/^[a-z][\w-]*$/.test(n)) {
      markInvalid(inputs, name);
      return toast("Name: lowercase letters, digits, - or _", "error");
    }
    markInvalid(inputs);
    // What was typed when the button was pressed is what is saved, even if the fields change while the config loads.
    const entry = { kind: kind.value, base_url: url.value.trim() || undefined, api_key_env: keyEnv.value.trim() || undefined, default_model: defModel.value.trim() || undefined };
    try {
      await changeConfig((c) => { c.providers[n] = entry; });
    } catch (e) {
      markInvalid(inputs, fieldFor(e.message, [[/base_url/, url], [/api_key_env/, keyEnv], [/default_model/, defModel], [/"kind"/, kind], [/providers/, name]]));
      return toast(e.message, "error");
    }
    toast(`Provider ${n} saved`);
    reload();
  };
  const remove = async (n) => {
    try {
      await changeConfig((c) => { delete c.providers[n]; });
    } catch (e) {
      return toast(e.message, "error");
    }
    reload();
  };
  // The provider row the last test went through says so; a new test result updates it without drawing the page again.
  const marks = new Map(providers.map((p) => [p.name, h("div", { class: "muted text-2xs" })]));
  test.marks = () => {
    const tested = testedProvider(providers);
    for (const [name, slot] of marks) {
      const on = name === tested && testSummary();
      if (on) slot.setAttribute("data-model-test", "");
      else slot.removeAttribute("data-model-test");
      mount(slot, on ? `Last test: ${testSummary()}` : null);
    }
  };
  test.marks();
  const table = problem
    ? errorState(problem, { onRetry: reload })
    : providers.length
      ? h("table", { class: "table compact", "aria-label": "Providers" },
        h("thead", {}, h("tr", {}, ["Provider", "Status", "Used by", "Models", h("span", { class: "sr-only" }, "Actions")].map((x) => h("th", { scope: "col" }, x)))),
        h("tbody", {}, providers.map((p) => h("tr", {},
          h("td", {}, h("b", { class: "mono" }, p.name), h("div", { class: "muted mono text-3xs" }, p.base_url ?? p.kind)),
          h("td", {}, okPill(p.ok, p.ok ? "ok" : "unreachable"), h("div", { class: "muted text-2xs" }, p.detail),
            marks.get(p.name)),
          h("td", { class: "muted" }, p.agents.join(", ")),
          h("td", {}, p.models.length ? h("div", { class: "row tighter" }, p.models.map((m) => h("span", { class: "pill mono" }, m))) : h("span", { class: "muted" }, "—")),
          h("td", {}, custom.has(p.name) ? h("button", { class: "small danger", onClick: () => remove(p.name) }, "Remove") : null)))))
      : emptyState("No providers.");
  return section("Providers",
    h("p", { class: "muted flush" }, "Where models run. Local providers cost nothing and keep code on your Mac; runs record them at $0."),
    table,
    providers.some((p) => p.kind === "ollama" && p.ok && !p.models.some((m) => /coder|gpt-oss|devstral/.test(m)))
      ? h("p", { class: "muted flush" }, "Tip: general chat models are weak at tool use. Pull a coding model, e.g. ", h("code", {}, "ollama pull qwen3-coder:30b"), " or ", h("code", {}, "ollama pull gpt-oss:20b"), ".")
      : null,
    h("div", { class: "field" }, h("span", {}, "Try a model"),
      testBox(providers.find((p) => p.kind === "ollama" && p.models.length) ? `ollama:${providers.find((p) => p.kind === "ollama").models[0]}` : "haiku"),
      h("small", {}, "Sends one tiny read-only prompt through the agent and provider.")),
    h("details", {}, h("summary", {}, "Add a provider (another Ollama/LM Studio host, or an Anthropic-compatible API)"),
      h("div", { class: "grid mt-10" }, f("Name", name), f("Kind", kind), f("Base URL", url), f("API key env var", keyEnv), f("Default model", defModel)),
      h("div", { class: "row mt-8" }, h("button", { class: "primary", onClick: add }, "Add provider"))));
}

const PRESETS = (local) => [
  { label: "Retries on Opus", rules: [{ step: "^(fix|fix_tests|fix_ci|address_review)$", min_visit: 2, model: "opus" }] },
  { label: "Codex reviews Claude's code", rules: [{ step: "^review$", model: "codex" }] },
  ...(local ? [{ label: `Small jobs on ${local}`, rules: [{ step: "^(triage|learn)$", model: local }] }] : []),
];

function routingCard(cfg, specs, localSpec) {
  const rules = cfg.router.rules.map((r) => ({ ...r }));
  const body = h("tbody");
  const defModel = input(cfg.default_model ?? "", { class: "mono", list: "models", placeholder: "Claude Code's default" });
  const fallback = input(cfg.router.fallback.join(", "), { class: "mono", placeholder: `e.g. codex, ${localSpec ?? "ollama:qwen3-coder"}` });
  const onRate = h("input", { type: "checkbox", class: "fit", checked: cfg.router.fallback_on.includes("rate_limit") });
  const onBudget = h("input", { type: "checkbox", class: "fit", checked: cfg.router.fallback_on.includes("budget") });

  const COLUMN = { step: "Step", flow: "Flow", min_visit: "From visit", model: "Model" };
  // the inputs of each rule by key, filled by `cell` on every draw
  let ruleInputs = [];
  const cell = (r, key, attrs, i) => {
    const el = input(r[key] ?? "", { class: "mono", ...attrs, "aria-label": `${COLUMN[key]} of rule ${i + 1}`, onInput: (e) => {
      const v = e.target.value.trim();
      if (key === "min_visit") r[key] = v ? Number(v) : undefined;
      else r[key] = v || undefined;
    } });
    ruleInputs[i][key] = el;
    return h("td", {}, el);
  };
  const draw = () => {
    ruleInputs = rules.map(() => ({}));
    mount(body, rules.length ? rules.map((r, i) => h("tr", {},
      cell(r, "step", { placeholder: "any step (regex)" }, i),
      cell(r, "flow", { placeholder: "any flow (regex)" }, i),
      cell(r, "min_visit", { type: "number", min: 1, class: "mono w-70", placeholder: "1" }, i),
      cell(r, "model", { list: "models", placeholder: "model spec" }, i),
      h("td", {}, h("button", { class: "small", title: "Move up", "aria-label": `Move rule ${i + 1} up`, disabled: i === 0, onClick: () => { rules.splice(i - 1, 0, rules.splice(i, 1)[0]); draw(); } }, "↑"),
        h("button", { class: "small danger", title: "Remove rule", "aria-label": `Remove rule ${i + 1}`, onClick: () => { rules.splice(i, 1); draw(); } }, glyph("✕"))))) :
      h("tr", {}, h("td", { colspan: 5, class: "muted" }, "No rules: steps use their own model, then the flow's, then the default.")));
  };
  draw();
  const everyInput = () => [defModel, fallback, ...ruleInputs.flatMap((x) => Object.values(x))];
  // the control a saved-config error names: `"rules", 2, "model"` is the model of rule 3
  const configField = (m) => {
    const rule = /"rules",\s*(\d+),\s*"(\w+)"/.exec(m);
    if (rule) return ruleInputs[Number(rule[1])]?.[rule[2]];
    return fieldFor(m, [[/default_model/, defModel], [/fallback/, fallback]]);
  };

  const save = async () => {
    const bad = rules.find((r) => !r.model);
    if (bad) {
      markInvalid(everyInput(), ruleInputs[rules.indexOf(bad)]?.model);
      return toast("Every rule needs a model", "error");
    }
    markInvalid(everyInput());
    // Snapshot first: the fields may change while the config loads.
    const snap = {
      default_model: defModel.value.trim() || undefined,
      router: {
        rules: rules.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined && v !== ""))),
        fallback: fallback.value.split(",").map((s) => s.trim()).filter(Boolean),
        fallback_on: [onRate.checked && "rate_limit", onBudget.checked && "budget"].filter(Boolean),
      },
    };
    try {
      await changeConfig((c) => { Object.assign(c, snap); });
    } catch (e) {
      markInvalid(everyInput(), configField(e.message));
      return toast(e.message, "error");
    }
    toast("Routing saved");
  };

  return section("Routing",
    h("p", { class: "muted flush" },
      "A model spec picks agent, provider and model: ", h("code", {}, "sonnet"), " · ", h("code", {}, "codex"), " · ", h("code", {}, "codex:gpt-5"), " · ",
      h("code", {}, "ollama:qwen3-coder"), " · ", h("code", {}, "codex:ollama:gpt-oss:20b"),
      ". The first matching rule wins — even over models set in flows and blocks. Otherwise: the step's model, the flow's default, then the default below."),
    f("Default model", defModel),
    h("div", {}, h("div", { class: "row mb-6" }, h("b", {}, "Rules"), h("span", { class: "spacer" }),
      ...PRESETS(localSpec).map((p) => h("button", { class: "small", onClick: () => { rules.push(...p.rules.map((r) => ({ ...r }))); draw(); } }, `+ ${p.label}`)),
      h("button", { class: "small", onClick: () => { rules.push({ model: "" }); draw(); } }, "+ Rule")),
      h("table", { class: "table compact", "aria-label": "Routing rules" }, h("thead", {}, h("tr", {}, ["Step", "Flow", "From visit", "Model", h("span", { class: "sr-only" }, "Actions")].map((x) => h("th", { scope: "col" }, x)))), body)),
    f("Fallback models", fallback, "Comma-separated, tried in order."),
    h("div", { class: "row" },
      h("label", { class: "row tight" }, onRate, h("span", {}, "Use them when a model hits a rate or usage limit")),
      h("label", { class: "row tight" }, onBudget, h("span", {}, "Continue on the first free one (local / ChatGPT) when a budget runs out, instead of pausing"))),
    h("div", { class: "row" }, h("span", { class: "spacer" }), h("button", { class: "primary", onClick: save }, "Save routing")));
}

export async function renderModels(main) {
  // The page draws into its own box, so an answer that comes after another page was mounted cannot touch it.
  const box = h("div");
  mount(main, box);
  let gen = 0;
  const load = async () => {
    const mine = ++gen;
    mount(box, loadingState("Checking agents and providers…", { shape: "table" }));
    const [cfg, st] = await Promise.allSettled([api.config(), api.providers()]);
    if (mine !== gen) return;
    if (cfg.status === "rejected") {
      mount(box, Number(cfg.reason?.status) === 403
        ? permissionState("You may not open the model settings.")
        : errorState(explainError(cfg.reason, { what: "The models page could not be loaded." }), { onRetry: load }));
      return;
    }
    const head = h("div", { class: "toolbar" }, h("h1", {}, "Models"), h("span", { class: "muted" }, "Agents, providers and which model runs which step"),
      h("span", { class: "spacer" }), h("button", { onClick: load, "aria-label": "Reload" }, "↻"));
    if (st.status === "rejected") {
      // The routing rules do not need the provider list: they stay usable and can be saved.
      const problem = explainError(st.reason, { what: "The agents and providers could not be checked.", safe: "Routing below still works and can be saved." });
      mount(box, head, providersCard(cfg.value, [], load, problem), routingCard(cfg.value, specSuggestions([]), undefined));
      return;
    }
    void refreshModelLists(st.value);
    const specs = specSuggestions(st.value.providers);
    const localSpec = specs.find((s) => /^(ollama|lmstudio):/.test(s) && /coder|gpt-oss|devstral/.test(s)) ?? specs.find((s) => /^(ollama|lmstudio):/.test(s) && !/:(0\.5b|135m|1b)$/.test(s));
    mount(box, head, agentsCard(st.value.agents), providersCard(cfg.value, st.value.providers, load), routingCard(cfg.value, specs, localSpec));
  };
  await load();
}
