import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin, createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, normalize, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse } from "yaml";
import { FACTORY_HOME } from "../flow/load.js";
import { disposeUsage, subscribeUsage } from "../usage/hub.js";
import type { UsageHandler } from "../usage/schema.js";
import { disposeWorkspaces, supplyWorkspaces, suppliedWorkspaces, type WorkspaceStore } from "../workspaces/list.js";
import { checkUiSpec, pluginUiName, registrationsOf, settingsValues, type PluginUiEntry, type PluginUiHandle } from "./ui.js";

/** The version of the plugin API: what `register(api)` gets as `api.version`. */
export const PLUGIN_API_VERSION = "0.3";
export const REGISTER_TIMEOUT_MS = 30_000;
export const MAX_PLUGINS = 20;
export const MAX_USAGE_HANDLERS = 10;
let ownerSeq = 0;

export interface PluginEntry {
  module: string;
  options: Record<string, unknown>;
}
/** What register(api) gets. Later parts of #779 add one method per extension point. */
export interface PluginApi {
  readonly version: string;
  readonly options: Readonly<Record<string, unknown>>;
  /** Adds pages, menu items and a settings section to the web interface. Once, and only while register(api) runs. */
  readonly ui: (spec: unknown) => PluginUiHandle;
  /**
   * Gets every usage event (a frozen copy), later and never inside the run. At most 10 handlers per plugin, and only while
   * register(api) runs. A handler that throws or takes longer than 5 s is reported in the problem list.
   */
  readonly onUsage: (handler: UsageHandler) => void;
  /**
   * Supplies the workspaces (#816): `store.list()` returns the whole list at once (not a promise); it replaces `workspaces` in
   * config.yaml. One plugin only, once, and only while register(api) runs.
   */
  readonly workspaces: (store: WorkspaceStore) => void;
}
export interface Registration {
  point: string;
  name: string;
}
export interface LoadedPlugin {
  label: string;
  module: string;
  version: string;
  registered: Registration[];
}
export interface PluginProblem {
  plugin: string;
  reason: string;
}
export interface PluginRegistry {
  readonly entries: readonly PluginEntry[];
  readonly plugins: readonly LoadedPlugin[];
  readonly problems: PluginProblem[];
  /** What plugins registered with `api.ui()`. */
  readonly ui: readonly PluginUiEntry[];
  /** Removes what the plugins subscribed to (usage handlers). The server calls it when it closes or fails to start. */
  dispose?: () => void;
}

/** A plugin that cannot be loaded. The message always names the plugin's `module`. */
export class PluginLoadError extends Error {
  constructor(readonly module: string, reason: string) {
    super(`plugin "${module}" ${reason}`);
    this.name = "PluginLoadError";
  }
}

const URL_START = /^[a-z][a-z0-9+.-]*:/i;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/** Why `spec` cannot name a plugin (static checks only); undefined when it can. */
export function pluginModuleProblem(spec: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(spec)) return "has a control character";
  if (URL_START.test(spec) && !/^[a-z]:[\\/]/i.test(spec)) return "must not be a URL: use a package name or an absolute path";
  if (isAbsolute(spec)) return normalize(spec) === spec ? undefined : "must be an absolute path without . or .. parts";
  if (PACKAGE_NAME.test(spec) && spec.length <= 214) return isBuiltin(spec) ? "names a built-in Node module, not a plugin" : undefined;
  return "must be a package name or an absolute path, not a relative path";
}

/** The short name shown for a plugin: the package name, or the file name of an absolute path. */
export function pluginLabel(spec: string): string {
  return isAbsolute(spec) ? basename(spec) : spec;
}

/** Whether `file` is `folder` or inside it. Both are real paths already. */
export function insideFolder(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

export function emptyRegistry(): PluginRegistry {
  return { entries: [], plugins: [], problems: [], ui: [] };
}

export interface LoadDeps {
  /** Folders a plugin must not live in: the runs folders and the repositories the Foundry works on. */
  blockedDirs: string[];
  resolve?: (spec: string) => string;
  importModule?: (url: string) => Promise<Record<string, unknown>>;
  timeoutMs?: number;
  log?: (m: string) => void;
  /** The `plugin_settings` of config.yaml as it is now (for `handle.settings()`). */
  pluginSettings?: () => Record<string, unknown> | undefined;
}

const firstLine = (e: unknown, max = 300) => String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, max);

function defaultResolve(spec: string): string {
  if (isAbsolute(spec)) return spec;
  try {
    return fileURLToPath(import.meta.resolve(spec));
  } catch {
    return createRequire(import.meta.url).resolve(spec);
  }
}

const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolvePath(p);
  }
};

/**
 * Runs `work` and fails with a PluginLoadError when it does not settle in time. The timer is referenced on purpose: a
 * pending promise alone does not keep Node alive, and the start would end silently. It is cleared on every path.
 */
async function withDeadline<T>(spec: string, what: string, ms: number, work: () => T | PromiseLike<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      const limit = ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`;
      timer = setTimeout(() => reject(new PluginLoadError(spec, `${what} did not finish within ${limit}`)), ms);
    });
    return await Promise.race([Promise.resolve().then(work), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The version of a plugin: its exported `version` (or the default export's), else the nearest package.json above the file, else "unknown". */
function versionOf(mod: Record<string, unknown>, def: Record<string, unknown> | undefined, file: string): string {
  const own = [mod.version, def?.version].find((v) => typeof v === "string" && v);
  if (typeof own === "string") return own.slice(0, 100);
  let dir = dirname(file);
  for (;;) {
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const v = (JSON.parse(readFileSync(pj, "utf8")) as { version?: unknown }).version;
        if (typeof v === "string" && v) return v.slice(0, 100);
      } catch {
        /* an unreadable package.json: keep looking */
      }
    }
    const up = dirname(dir);
    if (up === dir) return "unknown";
    dir = up;
  }
}

/** Loads the plugins once, in order. The first one that fails throws a PluginLoadError and the rest are not loaded. */
export async function loadPlugins(entries: readonly PluginEntry[], deps: LoadDeps): Promise<PluginRegistry> {
  if (!entries.length) return emptyRegistry();
  const owner = `plugins-${++ownerSeq}`;
  try {
    return await loadAll(entries, deps, owner, []);
  } catch (e) {
    // what the plugins before the failing one subscribed to must not outlive the failed start
    disposeUsage(owner);
    disposeWorkspaces(owner);
    throw e;
  }
}

async function loadAll(entries: readonly PluginEntry[], deps: LoadDeps, owner: string, problems: PluginProblem[]): Promise<PluginRegistry> {
  const resolveSpec = deps.resolve ?? defaultResolve;
  const importModule = deps.importModule ?? ((u: string) => import(u) as Promise<Record<string, unknown>>);
  const timeoutMs = deps.timeoutMs ?? REGISTER_TIMEOUT_MS;
  const blocked = deps.blockedDirs.map(real);
  const plugins: LoadedPlugin[] = [];
  const uiEntries: PluginUiEntry[] = [];
  for (const entry of entries) {
    const spec = entry.module;
    const bad = pluginModuleProblem(spec);
    if (bad) throw new PluginLoadError(spec, bad);
    let file: string;
    try {
      file = resolveSpec(spec);
    } catch (e) {
      throw new PluginLoadError(spec, `cannot be found (${firstLine(e)})`);
    }
    const path = real(file);
    const dir = blocked.find((b) => insideFolder(path, b));
    if (dir) throw new PluginLoadError(spec, "is inside a folder where runs write: install it outside");
    let mod: Record<string, unknown>;
    try {
      mod = await withDeadline(spec, "import", timeoutMs, () => importModule(pathToFileURL(path).href));
    } catch (e) {
      if (e instanceof PluginLoadError) throw e;
      throw new PluginLoadError(spec, `could not be imported: ${firstLine(e)}`);
    }
    const def = mod?.default as Record<string, unknown> | undefined;
    const register = typeof mod?.register === "function" ? mod.register : typeof def?.register === "function" ? def.register : undefined;
    if (!register) throw new PluginLoadError(spec, "does not export a function register(api)");
    const label = pluginLabel(spec);
    let ui: PluginUiEntry | undefined;
    let open = true;
    const usage: Registration[] = [];
    let suppliesWorkspaces = false;
    const api: PluginApi = Object.freeze({
      version: PLUGIN_API_VERSION,
      options: Object.freeze(structuredClone(entry.options)),
      ui: (given: unknown): PluginUiHandle => {
        if (!open) throw new Error("ui(spec) can only be called while register(api) runs");
        if (ui) throw new Error("ui(spec) can only be called once");
        const name = pluginUiName(label);
        if (uiEntries.some((x) => x.name === name)) throw new Error(`ui(spec): the web address name "${name}" is already used by another plugin`);
        const mine = checkUiSpec(given, { label, name, blocked });
        ui = mine;
        return Object.freeze({ name, settings: () => settingsValues(mine, deps.pluginSettings?.()?.[name]) });
      },
      onUsage: (handler: UsageHandler): void => {
        if (!open) throw new Error("onUsage(handler) can only be called while register(api) runs");
        if (typeof handler !== "function") throw new TypeError("onUsage(handler): the handler must be a function");
        if (usage.length >= MAX_USAGE_HANDLERS) throw new Error(`onUsage(handler): at most ${MAX_USAGE_HANDLERS} handlers per plugin`);
        subscribeUsage({
          owner,
          plugin: label,
          handler,
          report: (reason) => {
            problems.push({ plugin: label, reason });
            deps.log?.(`plugin ${label}: ${reason}`);
          },
        });
        usage.push({ point: "usage", name: "onUsage" });
      },
      workspaces: (store: WorkspaceStore): void => {
        if (!open) throw new Error("workspaces(store) can only be called while register(api) runs");
        if (!store || typeof store !== "object" || typeof store.list !== "function") throw new TypeError("workspaces(store): the store needs a list() function");
        if (suppliesWorkspaces) throw new Error("workspaces(store) can only be called once");
        suppliesWorkspaces = true;
        const r = supplyWorkspaces({
          owner,
          plugin: label,
          store,
          report: (reason) => {
            problems.push({ plugin: label, reason });
            deps.log?.(`plugin ${label}: ${reason}`);
          },
        });
        if (r !== "ok") {
          problems.push({ plugin: label, reason: `workspaces(store): plugin "${r.taken}" supplies the workspaces already; this list is not used` });
          return;
        }
        usage.push({ point: "workspaces", name: "workspaces" });
      },
    });
    try {
      await withDeadline(spec, "register(api)", timeoutMs, () => (register as (a: PluginApi) => unknown)(api));
    } catch (e) {
      if (e instanceof PluginLoadError) throw e;
      throw new PluginLoadError(spec, `register(api) failed: ${firstLine(e)}`);
    } finally {
      open = false;
    }
    const loaded: LoadedPlugin = { label, module: spec, version: versionOf(mod, def, path), registered: [...(ui ? registrationsOf(ui) : []), ...usage] };
    if (ui) uiEntries.push(ui);
    plugins.push(loaded);
    if (suppliesWorkspaces) suppliedWorkspaces(); // a bad list shows in the problem list at start
    deps.log?.(`plugin ${loaded.label} ${loaded.version} loaded`);
  }
  return {
    entries: structuredClone(entries),
    plugins,
    problems,
    ui: uiEntries,
    dispose: () => {
      disposeUsage(owner);
      disposeWorkspaces(owner);
    },
  };
}

/** The plugins in config.yaml as it is on disk now; undefined when it cannot be read or is not valid. */
export function readFilePlugins(path = join(process.env.FACTORY_HOME ?? FACTORY_HOME, "config.yaml")): PluginEntry[] | undefined {
  try {
    if (!existsSync(path)) return [];
    const doc = parse(readFileSync(path, "utf8")) as { plugins?: unknown } | null;
    const list = doc?.plugins;
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) return undefined;
    const out: PluginEntry[] = [];
    for (const p of list) {
      if (typeof p !== "object" || p === null || typeof (p as PluginEntry).module !== "string") return undefined;
      const o = (p as { options?: unknown }).options;
      if (o !== undefined && (typeof o !== "object" || o === null || Array.isArray(o))) return undefined;
      out.push({ module: (p as PluginEntry).module.trim(), options: (o ?? {}) as Record<string, unknown> });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** The plugin problems: those recorded at runtime, and a difference between the loaded list and the file. Never file content or options. */
export function pluginProblems(reg: PluginRegistry, inFile: readonly PluginEntry[] | undefined): PluginProblem[] {
  const out = [...reg.problems];
  if (inFile === undefined) out.push({ plugin: "config.yaml", reason: "cannot be read; the plugin list could not be checked" });
  else if (!isDeepStrictEqual(reg.entries, inFile)) out.push({ plugin: "config.yaml", reason: "lists other plugins than the ones loaded at the start; restart the server to load them" });
  return out;
}

/** What GET /api/plugins answers. No options. */
export function pluginsView(reg: PluginRegistry, inFile: readonly PluginEntry[] | undefined): { apiVersion: string; plugins: LoadedPlugin[]; problems: PluginProblem[] } {
  return { apiVersion: PLUGIN_API_VERSION, plugins: reg.plugins.map((p) => ({ ...p, registered: [...p.registered] })), problems: pluginProblems(reg, inFile) };
}
