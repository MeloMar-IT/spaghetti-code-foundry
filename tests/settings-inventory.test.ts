// "Every setting has a control or a reviewed exception": reads the schema, the description, the shipped flows and the text of ui/*.js.
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listFlows, loadFlow } from "../src/flow/load.js";
import { ITEM_SETTINGS, describeSettings, settingKeys, type ItemSettingText, type SettingDescription } from "../src/settings/describe.js";
import { SETTING_EXCEPTIONS } from "../src/settings/exceptions.js";

/** The Settings page modules whose text counts for a generated control. */
const SETTINGS_MODULES = ["admin.js", "admin-sections.js", "settings-skills.js"];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` mentions the dotted `key` as a token, or builds it from a quoted prefix such as "skills.catalogue." or `monitor.${. */
export function mentions(text: string, key: string): boolean {
  if (new RegExp(`(?<![\\w$])${escape(key)}(?![\\w$])`).test(text)) return true;
  const parts = key.split(".");
  for (let n = 1; n < parts.length; n++) {
    const prefix = escape(`${parts.slice(0, n).join(".")}.`);
    if (new RegExp(`["'\`]${prefix}(?:["'\`]|\\$\\{)`).test(text)) return true;
  }
  return false;
}

const hasWord = (text: string, word: string) => new RegExp(`(?<![\\w$])${escape(word)}(?![\\w$])`).test(text);

export interface Inventory {
  keys: string[];
  described: Pick<SettingDescription, "key" | "control">[];
  items: Record<string, Pick<ItemSettingText, "fields">>;
  exceptions: Record<string, string>;
  /** The text of ui/<file>; undefined when the file is missing. */
  uiText: (file: string) => string | undefined;
  settingsModules: string[];
  flows: { name: string; vars: string[]; info: Record<string, unknown> }[];
}

const ADD = (key: string) => `Describe it in src/settings/describe.ts with a control, or add "${key}" with a reason to src/settings/exceptions.ts.`;

/** One sentence for every setting or flow variable that has no control and no reviewed exception, and for every stale entry. */
export function inventoryProblems(inv: Inventory): string[] {
  const out: string[] = [];
  const keys = new Set(inv.keys);

  const controlProblem = (key: string): string | undefined => {
    const at = key.indexOf(".*.");
    if (at >= 0) {
      const prefix = key.slice(0, at);
      const field = key.slice(at + 3);
      const module = inv.items[prefix]?.fields[field];
      if (!module) return `${key} has no control: ${ADD(key).replace("Describe it in src/settings/describe.ts with a control", `List "${field}" with its module in ITEM_SETTINGS.${prefix}.fields in src/settings/describe.ts`)}`;
      const text = inv.uiText(module);
      if (text === undefined) return `${key}: ui/${module} does not exist.`;
      const missing = field.split(".").find((w) => !hasWord(text, w));
      return missing ? `${key}: ui/${module} does not mention "${missing}".` : undefined;
    }
    const d = inv.described.find((x) => x.key === key);
    if (!d) return `${key} has no control. ${ADD(key)}`;
    if (d.control === "generated") {
      return inv.settingsModules.some((f) => mentions(inv.uiText(f) ?? "", key)) ? undefined : `${key} is described as generated, but no Settings page module (${inv.settingsModules.join(", ")}) mentions it.`;
    }
    const text = inv.uiText(d.control);
    if (text === undefined) return `${key}: the control ui/${d.control} does not exist.`;
    return mentions(text, key) ? undefined : `${key}: ui/${d.control} does not mention "${key}".`;
  };

  for (const key of inv.keys) {
    const problem = controlProblem(key);
    const reason = inv.exceptions[key];
    if (reason === undefined) {
      if (problem) out.push(problem);
    } else if (!problem) {
      out.push(`${key} has a control and an exception: remove the exception from src/settings/exceptions.ts.`);
    }
  }
  for (const [key, reason] of Object.entries(inv.exceptions)) {
    if (!keys.has(key)) out.push(`The exception "${key}" names no setting: remove it from src/settings/exceptions.ts.`);
    if (!reason.trim()) out.push(`The exception "${key}" has no reason: give it one in src/settings/exceptions.ts.`);
  }
  for (const [prefix, item] of Object.entries(inv.items)) {
    for (const field of Object.keys(item.fields)) {
      if (!keys.has(`${prefix}.*.${field}`)) out.push(`ITEM_SETTINGS.${prefix}.fields lists "${field}", which names no setting: remove it from src/settings/describe.ts.`);
    }
  }
  for (const f of inv.flows) {
    for (const v of f.vars) {
      if (!Object.hasOwn(f.info, v)) out.push(`Flow ${f.name}: the variable "${v}" has no var_info entry. Give it one, or mark it set_by_run: true, in scripts/build-flows.mjs.`);
    }
  }
  return out;
}

const uiDir = join(import.meta.dirname, "..", "ui");
const uiText = (file: string) => (existsSync(join(uiDir, file)) ? readFileSync(join(uiDir, file), "utf8") : undefined);

function shippedFlows(): Inventory["flows"] {
  const repo = mkdtempSync(join(tmpdir(), "scf-inventory-"));
  return listFlows(repo)
    .filter((f) => f.scope === "builtin")
    .map((f) => {
      const { flow } = loadFlow(f.path, repo);
      return { name: f.name, vars: Object.keys(flow.vars), info: (flow.var_info ?? {}) as Record<string, unknown> };
    });
}

const base: Inventory = {
  keys: ["foo.bar"],
  described: [],
  items: {},
  exceptions: {},
  uiText: () => undefined,
  settingsModules: ["admin.js"],
  flows: [],
};

describe("every setting has a control or a reviewed exception", () => {
  it("holds for the schema and the shipped flows", () => {
    const flows = shippedFlows();
    expect(flows.length).toBeGreaterThan(0);
    const problems = inventoryProblems({
      keys: settingKeys(),
      described: describeSettings(),
      items: ITEM_SETTINGS,
      exceptions: SETTING_EXCEPTIONS,
      uiText,
      settingsModules: SETTINGS_MODULES,
      flows,
    });
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("only names ui modules that exist", () => {
    const files = new Set(readdirSync(uiDir));
    for (const m of SETTINGS_MODULES) expect(files.has(m), m).toBe(true);
  });

  it("has exactly the reviewed exceptions, each with a reason", () => {
    expect(Object.keys(SETTING_EXCEPTIONS).sort()).toEqual(["help.disabled_accounts", "help.pilot_accounts", "help.sensitive_patterns", "policy.packs", "providers.*.price.input_per_mtok", "providers.*.price.output_per_mtok", "telemetry.keep_days", "telemetry.local", "telemetry.otlp.enabled", "telemetry.otlp.endpoint", "telemetry.otlp.timeout_ms"]);
    for (const [k, r] of Object.entries(SETTING_EXCEPTIONS)) expect(r.endsWith("."), k).toBe(true);
  });

  it("names the key and what to add when a setting has no control", () => {
    const [p] = inventoryProblems(base);
    expect(p).toContain("foo.bar");
    expect(p).toContain("src/settings/describe.ts");
    expect(p).toContain("src/settings/exceptions.ts");
  });

  it("accepts a reviewed exception", () => {
    expect(inventoryProblems({ ...base, exceptions: { "foo.bar": "Because." } })).toEqual([]);
  });

  it("fails when the control file does not mention the key", () => {
    const inv = { ...base, described: [{ key: "foo.bar", control: "admin.js" }], uiText: () => "nothing here" };
    expect(inventoryProblems(inv)[0]).toContain("ui/admin.js does not mention");
    expect(inventoryProblems({ ...inv, uiText: () => 'hint("foo.bar")' })).toEqual([]);
  });

  it("fails when the control file is missing", () => {
    expect(inventoryProblems({ ...base, described: [{ key: "foo.bar", control: "gone.js" }] })[0]).toContain("does not exist");
  });

  it("fails when no Settings page module mentions a generated key", () => {
    const inv = { ...base, described: [{ key: "foo.bar", control: "generated" }], uiText: () => "x" };
    expect(inventoryProblems(inv)[0]).toContain("no Settings page module");
    expect(inventoryProblems({ ...inv, uiText: (f: string) => (f === "admin.js" ? "foo.bar" : "x") })).toEqual([]);
  });

  it("fails for an exception whose key is gone or has no reason", () => {
    expect(inventoryProblems({ ...base, exceptions: { "foo.bar": "x.", "old.key": "x." } })).toEqual([expect.stringContaining('"old.key" names no setting')]);
    expect(inventoryProblems({ ...base, exceptions: { "foo.bar": " " } })[0]).toContain("has no reason");
  });

  it("fails for an exception on a key that has a control", () => {
    const inv = { ...base, described: [{ key: "foo.bar", control: "admin.js" }], uiText: () => "foo.bar", exceptions: { "foo.bar": "x." } };
    expect(inventoryProblems(inv)[0]).toContain("remove the exception");
  });

  describe("item keys", () => {
    const item = { ...base, keys: ["watchers.*.new_option"], items: { watchers: { fields: { new_option: "watcher-options.js" } } } };
    it("needs the field in the named module", () => {
      expect(inventoryProblems({ ...item, uiText: () => "other" })[0]).toContain('does not mention "new_option"');
      expect(inventoryProblems({ ...item, uiText: () => "const x = new_option;" })).toEqual([]);
    });
    it("fails for a field that is not listed, even when the module has the word", () => {
      const inv = { ...base, keys: ["providers.*.model"], items: { providers: { fields: { kind: "models.js" } } }, uiText: () => "model kind" };
      const [p] = inventoryProblems(inv);
      expect(p).toContain("providers.*.model");
      expect(p).toContain("ITEM_SETTINGS.providers.fields");
      expect(p).toContain("src/settings/exceptions.ts");
    });
    it("counts only the module named for the field", () => {
      const inv = { ...item, uiText: (f: string) => (f === "watchers.js" ? "new_option" : "other") };
      expect(inventoryProblems(inv)[0]).toContain("does not mention");
    });
    it("fails for a listed field that no longer exists", () => {
      const inv = { ...base, keys: [], items: { watchers: { fields: { gone: "watchers.js" } } } };
      expect(inventoryProblems(inv)[0]).toContain("names no setting");
    });
  });

  describe("mentions", () => {
    it("takes a quoted prefix that a module builds keys from", () => {
      expect(mentions("`monitor.${name}.x`", "monitor.restart_loop.resumes")).toBe(true);
      expect(mentions('keys: ["skills.catalogue."]', "skills.catalogue.include")).toBe(true);
    });
    it("does not take a neighbour key or a longer word", () => {
      expect(mentions('hint("notify.macos")', "notify.on")).toBe(false);
      expect(mentions("notify_onx", "notify.on")).toBe(false);
      expect(mentions("xnotify.on", "notify.on")).toBe(false);
    });
  });

  describe("flow variables", () => {
    it("fails for a variable without var_info and names where to fix it", () => {
      const [p] = inventoryProblems({ ...base, exceptions: { "foo.bar": "x." }, flows: [{ name: "f", vars: ["a"], info: {} }] });
      expect(p).toContain("Flow f");
      expect(p).toContain('"a"');
      expect(p).toContain("var_info");
      expect(p).toContain("set_by_run");
      expect(p).toContain("scripts/build-flows.mjs");
    });
    it("accepts a described variable and one set by the run", () => {
      const flows = [{ name: "f", vars: ["a", "b"], info: { a: { label: "A" }, b: { set_by_run: true } } }];
      expect(inventoryProblems({ ...base, exceptions: { "foo.bar": "x." }, flows })).toEqual([]);
    });
  });
});
