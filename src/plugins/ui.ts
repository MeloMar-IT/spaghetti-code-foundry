import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, posix, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SettingDescription } from "../settings/describe.js";
import type { PluginRule } from "../server/permissions.js";
import type { Registration } from "./load.js";

// The `ui` extension point of the plugin API (#787): pages, menu items and a settings section.

export type PluginRole = "admin" | "user";
export interface PluginPageSpec {
  id: string;
  title: string;
  /** A `.js` file inside `dir`; the browser loads it with import(). */
  module: string;
  roles: PluginRole[];
  /** More files of the page (`.js`, `.css`, `.svg`) inside `dir`. */
  files?: string[];
}
export interface PluginMenuSpec {
  page: string;
  label: string;
  roles: PluginRole[];
}
export type PluginSettingKind = "number" | "yes-no" | "text" | "list" | "choice";
export interface PluginSettingField {
  key: string;
  kind: PluginSettingKind;
  label: string;
  help?: string;
  default?: unknown;
  integer?: boolean;
  min?: number;
  max?: number;
  choices?: string[];
  maxItems?: number;
}
export interface PluginSettingsSpec {
  title: string;
  fields: PluginSettingField[];
}
export interface PluginUiSpec {
  dir: string;
  pages?: PluginPageSpec[];
  menu?: PluginMenuSpec[];
  settings?: PluginSettingsSpec;
}
/** What `api.ui()` returns. */
export interface PluginUiHandle {
  readonly name: string;
  /** The current values of the plugin's settings, defaults filled in. */
  settings(): Record<string, unknown>;
}
/** A checked `api.ui()` call. `dir` is the real path; it never leaves the server. */
export interface PluginUiEntry {
  name: string;
  label: string;
  dir: string;
  blocked: string[];
  pages: PluginPageSpec[];
  menu: PluginMenuSpec[];
  settings?: PluginSettingsSpec;
  rules: PluginRule[];
}

export const MAX_PAGES = 20;
export const MAX_MENU = 20;
export const MAX_FIELDS = 50;
export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 1_000_000;
export const FILE_TYPES = [".js", ".css", ".svg"];
const ROLES: PluginRole[] = ["admin", "user"];
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const inside = (file: string, folder: string) => file === folder || file.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const realPath = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

/** The URL name of a plugin: its label in lower case, `@ / . _` as `-`, no script ending, at most 64 characters. */
export function pluginUiName(label: string): string {
  // a scoped package "@acme/x" would start with "-": the dashes at the start are dropped
  const name = label.toLowerCase().replace(/\.(mjs|js|cjs)$/, "").replace(/[@/._]/g, "-").replace(/^-+/, "").slice(0, 64);
  if (!NAME.test(name)) throw new Error(`its name "${label}" cannot be made into a web address name (letters, digits and - only)`);
  return name;
}

function text(v: unknown, what: string, max: number, min = 1): string {
  if (typeof v !== "string" || v.trim().length < min || v.length > max) throw new Error(`${what} must be a text of ${min} to ${max} characters`);
  if (CONTROL.test(v)) throw new Error(`${what} has a control character`);
  return v;
}

function roles(v: unknown, what: string): PluginRole[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > ROLES.length) throw new Error(`${what} must list "admin" and/or "user"`);
  for (const r of v) if (!ROLES.includes(r as PluginRole)) throw new Error(`${what} has an unknown role ${JSON.stringify(String(r)).slice(0, 40)}: use "admin" or "user"`);
  if (new Set(v).size !== v.length) throw new Error(`${what} names a role twice`);
  return [...v] as PluginRole[];
}

function onlyKeys(o: Record<string, unknown>, allowed: string[], what: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${what} has an unknown key "${k.slice(0, 40)}"`);
}

/** A path inside `dir` for a file of one of `types`; the result is the clean relative path. The file must exist, now and later. */
function filePath(dir: string, blocked: string[], v: unknown, what: string, types: string[]): string {
  if (typeof v !== "string" || !v || v.length > 200) throw new Error(`${what} must be a path of 1 to 200 characters`);
  if (CONTROL.test(v) || v.includes("\\")) throw new Error(`${what} has a control character or a backslash`);
  if (isAbsolute(v) || v.startsWith("/")) throw new Error(`${what} must be a relative path inside the plugin folder`);
  if (v.split("/").some((p) => p === "" || p === "." || p === "..")) throw new Error(`${what} must not have empty, . or .. parts`);
  const rel = posix.normalize(v);
  const type = types.find((t) => rel.endsWith(t));
  if (!type) throw new Error(`${what} must end in ${types.join(", ")}`);
  const real = realPath(join(dir, rel));
  if (!real) throw new Error(`${what} does not name a file in the plugin folder`);
  if (!inside(real, dir)) throw new Error(`${what} leads out of the plugin folder`);
  if (blocked.some((b) => inside(real, b))) throw new Error(`${what} is inside a folder where runs write`);
  const st = statSync(real);
  if (!st.isFile()) throw new Error(`${what} is not a file`);
  if (st.size > MAX_FILE_BYTES) throw new Error(`${what} is larger than ${MAX_FILE_BYTES} bytes`);
  return rel;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function checkField(raw: unknown, i: number): PluginSettingField {
  const at = `settings.fields[${i}]`;
  if (!isObj(raw)) throw new Error(`${at} must be an object`);
  const key = raw.key;
  if (typeof key !== "string" || !KEY.test(key)) throw new Error(`${at}.key must be 1 to 40 characters: a lower-case letter, then lower-case letters, digits and _`);
  const kind = raw.kind;
  if (!["number", "yes-no", "text", "list", "choice"].includes(kind as string)) throw new Error(`${at}.kind must be number, yes-no, text, list or choice`);
  const per: Record<string, string[]> = {
    number: ["integer", "min", "max"], "yes-no": [], text: [], list: ["maxItems"], choice: ["choices"],
  };
  onlyKeys(raw, ["key", "kind", "label", "help", "default", ...per[kind as string]!], at);
  const f: PluginSettingField = { key, kind: kind as PluginSettingKind, label: text(raw.label, `${at}.label`, 80) };
  if (raw.help !== undefined) f.help = text(raw.help, `${at}.help`, 300, 0);
  const d = raw.default;
  if (kind === "number") {
    if (raw.integer !== undefined && typeof raw.integer !== "boolean") throw new Error(`${at}.integer must be true or false`);
    if (raw.integer !== undefined) f.integer = raw.integer;
    for (const k of ["min", "max"] as const) {
      if (raw[k] === undefined) continue;
      if (!finite(raw[k])) throw new Error(`${at}.${k} must be a number`);
      f[k] = raw[k];
    }
    if (f.min !== undefined && f.max !== undefined && f.min > f.max) throw new Error(`${at}.min is larger than ${at}.max`);
  } else if (kind === "list") {
    if (raw.maxItems !== undefined) {
      if (!Number.isInteger(raw.maxItems) || (raw.maxItems as number) < 1 || (raw.maxItems as number) > 100) throw new Error(`${at}.maxItems must be a whole number from 1 to 100`);
      f.maxItems = raw.maxItems as number;
    }
  } else if (kind === "choice") {
    const c = raw.choices;
    if (!Array.isArray(c) || c.length < 1 || c.length > 50) throw new Error(`${at}.choices must list 1 to 50 texts`);
    f.choices = c.map((x, j) => text(x, `${at}.choices[${j}]`, 80));
    if (new Set(f.choices).size !== f.choices.length) throw new Error(`${at}.choices names a choice twice`);
  }
  if (d !== undefined) {
    const bad = fieldSchema(f).safeParse(d);
    if (!bad.success) throw new Error(`${at}.default ${bad.error.issues[0]?.message ?? "is not valid"}`);
    f.default = d;
  }
  return f;
}

/** The zod check of one value of a field (without `optional`). */
function fieldSchema(f: PluginSettingField): z.ZodType {
  if (f.kind === "number") {
    let n = f.integer ? z.number().int() : z.number();
    if (f.min !== undefined) n = n.min(f.min);
    if (f.max !== undefined) n = n.max(f.max);
    return n;
  }
  if (f.kind === "yes-no") return z.boolean();
  if (f.kind === "text") return z.string().max(2000);
  if (f.kind === "list") return z.array(z.string().min(1).max(200)).max(f.maxItems ?? 100);
  return z.enum(f.choices as [string, ...string[]]);
}

/** The check of a plugin's settings: every key optional, unknown keys are the caller's business. */
export function settingsSchema(fields: readonly PluginSettingField[]): z.ZodType<Record<string, unknown>> {
  return z.object(Object.fromEntries(fields.map((f) => [f.key, fieldSchema(f).optional()]))).strip() as unknown as z.ZodType<Record<string, unknown>>;
}

/**
 * Checks a whole `api.ui()` spec and gives the entry to keep. Throws an Error with a plain message on any problem.
 * `blocked` are real paths of folders a plugin's files must not lie in.
 */
export function checkUiSpec(spec: unknown, who: { label: string; name: string; blocked: string[] }): PluginUiEntry {
  if (!isObj(spec)) throw new Error("ui(spec) needs an object");
  onlyKeys(spec, ["dir", "pages", "menu", "settings"], "ui(spec)");
  if (typeof spec.dir !== "string" || !isAbsolute(spec.dir) || normalize(spec.dir) !== spec.dir || CONTROL.test(spec.dir)) {
    throw new Error("ui(spec).dir must be an absolute path without . or .. parts");
  }
  const dir = realPath(spec.dir);
  if (!dir || !statSync(dir).isDirectory()) throw new Error("ui(spec).dir is not a folder");
  if (who.blocked.some((b) => inside(dir, b))) throw new Error("ui(spec).dir is inside a folder where runs write");
  const pages: PluginPageSpec[] = [];
  const rawPages = spec.pages ?? [];
  if (!Array.isArray(rawPages) || rawPages.length > MAX_PAGES) throw new Error(`ui(spec).pages must be a list of at most ${MAX_PAGES}`);
  rawPages.forEach((p, i) => {
    const at = `pages[${i}]`;
    if (!isObj(p)) throw new Error(`${at} must be an object`);
    onlyKeys(p, ["id", "title", "module", "roles", "files"], at);
    if (typeof p.id !== "string" || !ID.test(p.id)) throw new Error(`${at}.id must be 1 to 40 characters: lower-case letters, digits and -`);
    if (pages.some((x) => x.id === p.id)) throw new Error(`${at}.id "${p.id}" is used twice`);
    const page: PluginPageSpec = {
      id: p.id,
      title: text(p.title, `${at}.title`, 80),
      module: filePath(dir, who.blocked, p.module, `${at}.module`, [".js"]),
      roles: roles(p.roles, `${at}.roles`),
    };
    if (p.files !== undefined) {
      if (!Array.isArray(p.files) || p.files.length > MAX_FILES) throw new Error(`${at}.files must be a list of at most ${MAX_FILES}`);
      page.files = p.files.map((f, j) => filePath(dir, who.blocked, f, `${at}.files[${j}]`, FILE_TYPES));
    }
    pages.push(page);
  });
  const menu: PluginMenuSpec[] = [];
  const rawMenu = spec.menu ?? [];
  if (!Array.isArray(rawMenu) || rawMenu.length > MAX_MENU) throw new Error(`ui(spec).menu must be a list of at most ${MAX_MENU}`);
  rawMenu.forEach((m, i) => {
    const at = `menu[${i}]`;
    if (!isObj(m)) throw new Error(`${at} must be an object`);
    onlyKeys(m, ["page", "label", "roles"], at);
    const page = pages.find((p) => p.id === m.page);
    if (!page) throw new Error(`${at}.page names no page of this plugin`);
    const r = roles(m.roles, `${at}.roles`);
    if (!r.every((x) => page.roles.includes(x))) throw new Error(`${at}.roles is wider than the roles of page "${page.id}"`);
    menu.push({ page: page.id, label: text(m.label, `${at}.label`, 40), roles: r });
  });
  let settings: PluginSettingsSpec | undefined;
  if (spec.settings !== undefined) {
    const s = spec.settings;
    if (!isObj(s)) throw new Error("settings must be an object");
    onlyKeys(s, ["title", "fields"], "settings");
    if (!Array.isArray(s.fields) || s.fields.length < 1 || s.fields.length > MAX_FIELDS) throw new Error(`settings.fields must be a list of 1 to ${MAX_FIELDS}`);
    const fields = s.fields.map(checkField);
    if (new Set(fields.map((f) => f.key)).size !== fields.length) throw new Error("settings.fields names a key twice");
    settings = { title: text(s.title, "settings.title", 60), fields };
  }
  // One rule per file; a file that several pages list is open to the roles of all of them.
  const byPath = new Map<string, Set<PluginRole>>();
  const notes = new Map<string, string>();
  for (const p of pages) {
    for (const f of [p.module, ...(p.files ?? [])]) {
      const set = byPath.get(f) ?? new Set<PluginRole>();
      p.roles.forEach((r) => set.add(r));
      byPath.set(f, set);
      if (!notes.has(f)) notes.set(f, `a file of the page "${p.id}" of the plugin ${who.label}`);
    }
  }
  const rules: PluginRule[] = [...byPath].map(([path, set]) => ({ plugin: who.name, method: "GET", path, roles: ROLES.filter((r) => set.has(r)), note: notes.get(path)! }));
  return { name: who.name, label: who.label, dir, blocked: who.blocked, pages, menu, settings, rules };
}

/** The stored settings of a plugin with defaults filled in. A stored value that is not valid, or of a key the plugin dropped, is ignored. */
export function settingsValues(entry: Pick<PluginUiEntry, "settings">, stored: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const own = isObj(stored) ? stored : {};
  for (const f of entry.settings?.fields ?? []) {
    const v = Object.hasOwn(own, f.key) && fieldSchema(f).safeParse(own[f.key]).success ? own[f.key] : f.default;
    if (v !== undefined) out[f.key] = structuredClone(v);
  }
  return out;
}

/** The pages and menu items a role may see, with the web address of each module. Never `dir`. */
export function uiView(entries: readonly PluginUiEntry[], role: string): {
  pages: { plugin: string; id: string; title: string; module: string; roles: PluginRole[] }[];
  menu: { plugin: string; page: string; label: string }[];
} {
  const pages = [];
  const menu = [];
  for (const e of entries) {
    for (const p of e.pages) {
      if (role === "admin" || p.roles.includes(role as PluginRole)) pages.push({ plugin: e.name, id: p.id, title: p.title, module: `/plugins/${e.name}/${p.module.split("/").map(encodeURIComponent).join("/")}`, roles: [...p.roles] });
    }
    for (const m of e.menu) if (m.roles.includes(role as PluginRole)) menu.push({ plugin: e.name, page: m.page, label: m.label });
  }
  return { pages, menu };
}

/** The settings sections for GET /api/settings: `fields` in the description shape, and the effective `values`. */
export function settingSections(entries: readonly PluginUiEntry[], stored: unknown): { plugin: string; title: string; fields: SettingDescription[]; values: Record<string, unknown> }[] {
  const all = isObj(stored) ? stored : {};
  return entries.filter((e) => e.settings).map((e) => ({
    plugin: e.name,
    title: e.settings!.title,
    fields: e.settings!.fields.map((f) => ({
      key: `plugin_settings.${e.name}.${f.key}`,
      kind: f.kind,
      label: f.label,
      help: f.help ?? "",
      default: f.default,
      optional: f.default === undefined,
      effect: "now" as const,
      effectText: "at once",
      control: "generated",
      ...(f.integer !== undefined ? { integer: f.integer } : {}),
      ...(f.min !== undefined ? { min: f.min } : {}),
      ...(f.max !== undefined ? { max: f.max } : {}),
      ...(f.maxItems !== undefined ? { maxItems: f.maxItems } : {}),
      ...(f.choices ? { choices: [...f.choices] } : {}),
    })),
    values: settingsValues(e, all[e.name]),
  }));
}

export interface PluginSettingsCheck {
  problem?: { path: string; message: string };
  /** The `plugin_settings` to save: obsolete keys of loaded plugins removed, entries of plugins that are not loaded kept. */
  cleaned: Record<string, Record<string, unknown>>;
}

/**
 * Checks the `plugin_settings` of a save against the loaded plugins' schemas. `stored` is what config.yaml holds now.
 * A key the plugin no longer has is dropped when it was already stored (never an error); an invalid value that was already
 * stored and is unchanged is kept; a changed value must be valid. Entries of plugins that are not loaded stay as stored.
 */
export function pluginSettingsProblem(next: Record<string, Record<string, unknown>>, stored: Record<string, Record<string, unknown>>, entries: readonly PluginUiEntry[]): PluginSettingsCheck {
  const cleaned: Record<string, Record<string, unknown>> = {};
  for (const [name, values] of Object.entries(next)) {
    const entry = entries.find((e) => e.name === name);
    const was = stored[name] ?? {};
    if (!entry?.settings) {
      if (!isDeepStrictEqual(values, was)) return { cleaned, problem: { path: `plugin_settings.${name}`, message: "belongs to a plugin that has no settings loaded, so it cannot be changed" } };
      cleaned[name] = values;
      continue;
    }
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const f = entry.settings.fields.find((x) => x.key === key);
      if (!f) {
        if (Object.hasOwn(was, key)) continue; // obsolete: dropped
        return { cleaned, problem: { path: `plugin_settings.${name}.${key}`, message: "is not a setting of this plugin" } };
      }
      const r = fieldSchema(f).safeParse(value);
      if (!r.success && !(Object.hasOwn(was, key) && isDeepStrictEqual(value, was[key]))) {
        return { cleaned, problem: { path: `plugin_settings.${name}.${key}`, message: r.error.issues[0]?.message ?? "is not valid" } };
      }
      kept[key] = value;
    }
    if (Object.keys(kept).length) cleaned[name] = kept;
  }
  for (const [name, values] of Object.entries(stored)) {
    if (!Object.hasOwn(cleaned, name) && !entries.some((e) => e.name === name && e.settings) && !Object.hasOwn(next, name)) cleaned[name] = values;
  }
  return { cleaned };
}

/** What a plugin registered with `ui`, for GET /api/plugins. */
export function registrationsOf(e: PluginUiEntry): Registration[] {
  return [
    ...e.pages.map((p) => ({ point: "ui", name: `page ${p.id}` })),
    ...e.menu.map((m) => ({ point: "ui", name: `menu ${m.label}` })),
    ...(e.settings ? [{ point: "ui", name: `settings ${e.settings.title}` }] : []),
  ];
}
