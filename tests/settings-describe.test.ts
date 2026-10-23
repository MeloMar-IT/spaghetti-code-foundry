import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ConfigSchema } from "../src/config.js";
import { EFFECT_TEXT, ITEM_SETTINGS, SETTING_TEXTS, describeSettings, isCovered, schemaLeaves, settingKeys, settingValue, startupSettings, unsupportedSettings, type SettingLeaf } from "../src/settings/describe.js";

type Entry = [key: string, value: unknown];

/** The nested object with just these keys. */
function build(entries: Entry[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const parts = key.split(".");
    let cur = root;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    cur[parts[parts.length - 1]!] = value;
  }
  return root;
}
const issues = (entries: Entry[]) => ConfigSchema.safeParse(build(entries)).error?.issues ?? [];
const issuesAt = (key: string, value: unknown) => issues([[key, value]]).filter((i) => i.path.join(".") === key);
const issuesUnder = (entries: Entry[], key: string) => issues(entries).filter((i) => i.path.join(".").startsWith(key));
const accepts = (key: string) => (v: unknown) => issuesAt(key, v).length === 0;

const leaf = (key: string): SettingLeaf => {
  const l = schemaLeaves().find((x) => x.key === key);
  if (!l) throw new Error(`no leaf ${key}`);
  return l;
};
const described = describeSettings();

/** One line for every rule of the advertised range that the schema does not follow. */
function numberProblems(l: SettingLeaf, ok: (v: number) => boolean): string[] {
  const out: string[] = [];
  const check = (what: string, got: boolean, want: boolean) => got !== want && out.push(`${l.key}: ${what}`);
  const e = 1e-6;
  const { min, max, exclusiveMin: ex } = l;
  if (l.integer) {
    if (min !== undefined) {
      check(`accepts ${min}`, ok(min), true);
      check(`refuses ${min - 1}`, ok(min - 1), false);
    }
    if (max !== undefined) {
      check(`accepts ${max}`, ok(max), true);
      check(`refuses ${max + 1}`, ok(max + 1), false);
    }
    if (ex !== undefined) {
      check(`refuses ${ex}`, ok(ex), false);
      check(`accepts ${ex + 1}`, ok(ex + 1), true);
    }
    const lowest = min ?? (ex !== undefined ? ex + 1 : 0);
    if (max === undefined || lowest + 0.5 <= max) check(`refuses ${lowest + 0.5}`, ok(lowest + 0.5), false);
  } else {
    if (min !== undefined) {
      check(`accepts ${min}`, ok(min), true);
      check(`refuses ${min - e}`, ok(min - e), false);
    }
    if (max !== undefined) {
      check(`accepts ${max}`, ok(max), true);
      check(`refuses ${max + e}`, ok(max + e), false);
    }
    if (ex !== undefined) {
      check(`refuses ${ex}`, ok(ex), false);
      check(`accepts ${ex + e}`, ok(ex + e), true);
    }
    const base = min ?? ex ?? 0;
    if (max === undefined || base + 0.5 <= max) check(`accepts ${base + 0.5}`, ok(base + 0.5), true);
  }
  if (max === undefined) check("accepts 1e9", ok(1e9), true);
  if (min === undefined && ex === undefined) check("accepts -1e9", ok(-1e9), true);
  return out;
}

describe("reading the schema", () => {
  it("renders the schema as JSON Schema with the bounds of a key", () => {
    const json = z.toJSONSchema(ConfigSchema, { io: "input", unrepresentable: "any", reused: "inline" }) as any;
    const resumes = json.properties.monitor.properties.restart_loop.properties.resumes;
    expect([resumes.minimum, resumes.maximum]).toEqual([1, 49]);
  });

  it("schemaLeaves() knows the kind and range of known keys", () => {
    expect(leaf("monitor.restart_loop.resumes")).toMatchObject({ kind: "number", integer: true, min: 1, max: 49 });
    expect(leaf("monitor.github_limit.percent")).toMatchObject({ kind: "number", min: 1, max: 100 });
    expect(leaf("monitor.github_limit.percent").integer).toBe(false);
    expect(leaf("monitor.slow_step.factor")).toMatchObject({ min: 1.5, integer: false });
    expect(leaf("isolate_agents").kind).toBe("yes-no");
    expect(leaf("skills.tools.filesystem")).toMatchObject({ kind: "choice", choices: ["read", "write"] });
    expect(leaf("sandbox.user_read")).toMatchObject({ kind: "list", maxItems: 50 });
    expect(leaf("sandbox.user_read").fields).toBeUndefined();
    expect(leaf("monitor.report_to").kind).toBe("text");
    expect(leaf("skills.releases.approved")).toMatchObject({ kind: "list", maxItems: 50, fields: [{ key: "catalogue", kind: "text" }, { key: "version", kind: "text" }, { key: "digest", kind: "text" }, { key: "key", kind: "text" }, { key: "signature", kind: "text" }, { key: "artifact", kind: "text" }] });
    expect(leaf("daily_budget_usd")).toMatchObject({ exclusiveMin: 0 });
    expect(leaf("daily_budget_usd").min).toBeUndefined();
    for (const l of schemaLeaves()) for (const n of [l.min, l.max, l.exclusiveMin]) expect(Math.abs(n ?? 0)).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  it("unsupportedSettings() names what no single control can edit", () => {
    const unsupported = unsupportedSettings();
    for (const k of ["watchers", "providers", "router.rules"]) {
      expect(unsupported).toContain(k);
      expect(schemaLeaves().some((l) => l.key === k)).toBe(false);
    }
  });
});

describe("what is described", () => {
  it("has a text for every covered key and no text for another", () => {
    const keys = new Set(schemaLeaves().map((l) => l.key));
    for (const k of Object.keys(SETTING_TEXTS)) expect(keys.has(k), k).toBe(true);
    for (const l of schemaLeaves()) if (isCovered(l.key)) expect(SETTING_TEXTS[l.key], l.key).toBeDefined();
    for (const k of unsupportedSettings()) expect(isCovered(k) && !k.startsWith("monitor.") && !k.startsWith("skills.")).toBe(false);
    expect(isCovered("sandbox.user_read")).toBe(true);
    expect(isCovered("sandbox.user_runs")).toBe(true);
    expect(isCovered("monitoring")).toBe(false);
    for (const k of ["ui.redesign", "help.enabled", "default_model", "router.fallback"]) expect(isCovered(k), k).toBe(true);
    for (const k of ["help.disabled_accounts", "help.pilot_accounts", "help.sensitive_patterns", "providers", "router.rules"]) expect(isCovered(k), k).toBe(false);
    for (const k of ["delivery.signing_key_path", "delivery.required_checks", "delivery.artifacts", "delivery.provenance"]) expect(isCovered(k), k).toBe(true);
    expect(isCovered("delivery.repositories")).toBe(false);
    expect(described).toHaveLength(130);
  });

  it("lists the keys down to the leaves, lists of records once by their item shape", () => {
    const keys = settingKeys();
    for (const k of ["watchers.*.source", "watchers.*.status_labels.working", "watchers.*.vars", "providers.*.kind", "providers.*.price.input_per_mtok", "router.rules.*.model", "skills.releases.approved", "help.disabled_accounts", "help.sensitive_patterns", "ui.redesign"]) {
      expect(keys, k).toContain(k);
    }
    expect(keys.some((k) => k.startsWith("skills.releases.approved."))).toBe(false);
    expect(new Set(keys).size).toBe(keys.length);
    for (const l of schemaLeaves()) expect(keys, l.key).toContain(l.key);
    for (const k of unsupportedSettings()) expect(keys.includes(k) || keys.some((x) => x.startsWith(`${k}.*.`)), k).toBe(true);
    for (const [k, item] of Object.entries(ITEM_SETTINGS)) {
      expect(unsupportedSettings(), k).toContain(k);
      for (const f of Object.keys(item.fields)) expect(keys, `${k}.*.${f}`).toContain(`${k}.*.${f}`);
    }
  });

  it("describes the settings of the Settings page with their effects and controls", () => {
    const by = (k: string) => described.find((d) => d.key === k)!;
    expect(by("failure_summary.model")).toMatchObject({ default: "haiku", effect: "new-runs" });
    expect(by("server.listen").effect).toBe("restart");
    // the command and its outcomes are read from the run's own copy of the settings
    for (const k of ["notify.command", "notify.on"]) expect(by(k).effect, k).toBe("new-runs");
    for (const k of ["notify.macos", "notify.slack_webhook"]) expect(by(k).effect, k).toBe("now");
    expect(by("notify.slack_webhook").default).toBeUndefined();
    const own = described.filter((d) => d.control === "admin-sections.js").map((d) => d.key).sort();
    expect(own).toEqual(["failure_summary.enabled", "failure_summary.model", "isolate_agents", "sandbox.user_read", "step_env.agent_pass", "step_env.pass"]);
  });
});

describe("the advertised ranges are the schema's", () => {
  it("every number leaf, with neighbouring integers and a small step for the others", () => {
    const numbers = schemaLeaves().filter((l) => l.kind === "number");
    expect(numbers.length).toBeGreaterThan(40);
    for (const l of numbers) expect(numberProblems(l, accepts(l.key) as (v: number) => boolean)).toEqual([]);
  });

  it("a wrong range fails the check", () => {
    const checks = leaf("monitor.watcher_error.checks");
    expect(checks).toMatchObject({ min: 1, max: 1000 });
    const ok = accepts(checks.key) as (v: number) => boolean;
    expect(numberProblems({ ...checks, min: 2 }, ok)).not.toEqual([]);
    expect(numberProblems({ ...checks, max: 999 }, ok)).not.toEqual([]);
    expect(numberProblems({ ...checks, min: 0 }, ok)).not.toEqual([]);
    const factor = leaf("monitor.slow_step.factor");
    expect(numberProblems({ ...factor, integer: true }, accepts(factor.key) as (v: number) => boolean)).not.toEqual([]);
    const { max: _max, ...open } = leaf("monitor.restart_loop.resumes");
    expect(numberProblems(open, accepts(open.key) as (v: number) => boolean)).not.toEqual([]);
  });

  it("literal numbers", () => {
    expect(accepts("monitor.slow_step.factor")(1.5)).toBe(true);
    expect(accepts("monitor.slow_step.factor")(1.49)).toBe(false);
    expect(accepts("monitor.restart_loop.resumes")(49.5)).toBe(false);
    expect(accepts("monitor.restart_loop.resumes")(50)).toBe(false);
    expect(accepts("monitor.watcher_error.checks")(1)).toBe(true);
    expect(accepts("monitor.watcher_error.checks")(1000)).toBe(true);
    expect(accepts("monitor.watcher_error.checks")(0)).toBe(false);
    expect(accepts("monitor.watcher_error.checks")(1001)).toBe(false);
    expect(accepts("daily_budget_usd")(0)).toBe(false);
    expect(accepts("daily_budget_usd")(0.01)).toBe(true);
  });

  it("choices", () => {
    for (const d of described.filter((x) => x.kind === "choice")) {
      for (const c of d.choices!) expect(issuesAt(d.key, c), `${d.key} ${c}`).toEqual([]);
      expect(issuesAt(d.key, "__no__"), d.key).not.toEqual([]);
    }
  });

  const item = (key: string, i: number): unknown => {
    if (key === "step_env.pass" || key === "step_env.agent_pass") return `VAR_${i}`;
    if (key === "sandbox.user_read" || key === "skills.roots") return `/p/${i}`;
    if (key === "skills.releases.keys") return { id: `k${i}`, ed25519: Buffer.alloc(32, i + 1).toString("base64") };
    if (key === "skills.releases.approved") return { catalogue: `c${i}`, version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
    return `s${i}`;
  };
  const companions = (key: string): Entry[] => {
    const top = (k: string): Entry => [k, leaf(k).max];
    if (key === "skills.catalogue.include") return [top("skills.catalogue.max_candidates"), top("skills.catalogue.max_tokens")];
    if (key === "skills.selection.include") return [top("skills.selection.max_skills")];
    return [];
  };
  const TABLE = new Set([
    "step_env.pass", "step_env.agent_pass", "sandbox.user_read", "skills.roots", "skills.releases.approved", "skills.releases.keys",
    "skills.catalogue.include", "skills.selection.include", "skills.catalogue.exclude", "skills.selection.exclude", "skills.selection.exclusive", "skills.unresolved.high_risk",
    "delivery.required_checks", "delivery.artifacts",
  ]);

  it("list limits: exactly maxItems are accepted, one more is not", () => {
    const lists = described.filter((d) => d.kind === "list" && d.maxItems !== undefined);
    expect(lists.length).toBeGreaterThan(5);
    for (const d of lists) {
      expect(TABLE.has(d.key), `${d.key} has no row in the table`).toBe(true);
      const items = (n: number) => Array.from({ length: n }, (_, i) => item(d.key, i));
      expect(issuesUnder([...companions(d.key), [d.key, items(d.maxItems!)]], d.key), d.key).toEqual([]);
      expect(issuesAt(d.key, items(d.maxItems! + 1)), d.key).not.toEqual([]);
    }
    expect(issuesAt("sandbox.user_read", Array.from({ length: 50 }, (_, i) => `/p/${i}`))).toEqual([]);
    expect(issuesAt("sandbox.user_read", Array.from({ length: 51 }, (_, i) => `/p/${i}`))).not.toEqual([]);
  });
});

describe("defaults and texts", () => {
  it("default is the schema's, optional when it has none", () => {
    const parsed = ConfigSchema.parse({});
    for (const d of described) {
      const v = d.key.split(".").reduce((o: any, k) => o?.[k], parsed);
      expect(d.default, d.key).toEqual(v);
      expect(d.optional, d.key).toBe(v === undefined);
    }
    expect(described.find((d) => d.key === "monitor.report_to")!.optional).toBe(true);
    expect(described.find((d) => d.key === "isolate_agents")!.default).toBe(true);
  });
  it("approved releases: help names the catalogue id, version and digest, and every skills setting has a generated control", () => {
    const d = described.find((x) => x.key === "skills.releases.approved")!;
    expect(d.help).toBe("The catalogue releases this installation accepts, each with its catalogue id, version and digest, and optionally the local folder (artifact) that `scf skills release adopt` copies it from.");
    expect(d.help).not.toMatch(/one per line/i);
    const skills = described.filter((x) => x.key.startsWith("skills."));
    expect(skills.length).toBeGreaterThan(10);
    for (const s of skills) expect(s.control, s.key).toBe("generated");
  });

  it("every entry has a label, one sentence of help, and a known effect and control", () => {
    for (const d of described) {
      expect(d.label.trim(), d.key).not.toBe("");
      expect(d.help, d.key).toMatch(/\.$/);
      expect(d.help.slice(0, -1), d.key).not.toMatch(/\.\s/);
      expect(d.effectText).toBe(EFFECT_TEXT[d.effect]);
      expect(d.control === "generated" || existsSync(join("ui", d.control)), d.key).toBe(true);
      expect(d.help, d.key).not.toMatch(/\.\s/);
      if (d.key.startsWith("monitor.")) expect(d.effect, d.key).toBe("now");
    }
    expect(described.find((d) => d.key === "isolate_agents")!.effect).toBe("new-runs");
    expect(EFFECT_TEXT["new-runs"]).toBe("when a run starts or resumes");
  });
});

describe("startupSettings", () => {
  const v = { home: "/h", port: 4000, repo: "/r", claudeBin: "claude", codexBin: "codex", ghBin: "gh" };
  it("lists six settings with their values, changed by a restart", () => {
    const s = startupSettings(v);
    expect(s.map((x) => x.key)).toEqual(["FACTORY_HOME", "port", "repo", "FACTORY_CLAUDE_BIN", "FACTORY_CODEX_BIN", "FACTORY_GH_BIN"]);
    expect(s.map((x) => x.value)).toEqual(["/h", 4000, "/r", "claude", "codex", "gh"]);
    for (const x of s) {
      expect(x.change).not.toBe("");
      expect(x.effectText).toBe("after a restart");
    }
  });

  it("marks the monitor keys as edited on the Problems page, and no other key", () => {
    for (const d of describeSettings()) expect(d.control === "problems.js", d.key).toBe(d.key.startsWith("monitor."));
  });

  it("settingValue walks a dotted key", () => {
    expect(settingValue({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(settingValue({}, "a.b")).toBeUndefined();
    expect(settingValue(undefined, "a")).toBeUndefined();
  });

  it("does not hold the value of a variable of the server", () => {
    const hidden = randomBytes(12).toString("hex");
    process.env.SETTINGS_492_PROBE = hidden;
    try {
      expect(JSON.stringify({ settings: describeSettings(), startup: startupSettings(v) })).not.toContain(hidden);
    } finally {
      delete process.env.SETTINGS_492_PROBE;
    }
  });
});
