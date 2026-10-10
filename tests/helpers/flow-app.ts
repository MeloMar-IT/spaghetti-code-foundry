import { vi } from "vitest";
import type { FakeElement } from "./fake-dom.js";
import { loadUiSource } from "./ui-load.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const g = globalThis as any;

export const flowJson = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, workspace: "worktree", steps: [{ id: "s", type: "shell", run: "x" }], ...extra });
export const httpError = (status: number, message = "boom") => Object.assign(new Error(message), { status });

/** A promise the test settles by hand. */
export function held<T = unknown>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const el = (id: string) => g.document.getElementById(id) as FakeElement;
export const main = () => el("main");
export const sidebar = () => el("sidebar");
export const root = () => el("modal-root");
export const toastEl = () => el("toast");
export const alertsIn = (box: FakeElement) => box.all("div").filter((d) => d.getAttribute("role") === "alert");
export const buttonIn = (box: FakeElement, text: string) => box.all("button").find((b) => b.textContent === text);
export const click = (box: FakeElement, text: string) => {
  const b = buttonIn(box, text);
  if (!b) throw new Error(`no button "${text}" in: ${box.textContent.slice(0, 200)}`);
  b.click();
};
/** Presses Escape the way the browser reaches the open dialog. */
export const escape = () => { for (const fn of [...(g.document.listeners.keydown ?? [])]) fn({ key: "Escape" }); };
const nowhere = () => undefined;

/**
 * A browser stand-in: `location`, `history` whose `pushState` and `replaceState` update `location.hash` as the browser does,
 * and a `window` that keeps the `hashchange` listener. Clears the page elements the app draws into.
 */
export function setupBrowser(hash: string) {
  const loc = { hash, search: "", reload: vi.fn() };
  const url = (u: string) => { loc.hash = u.includes("#") ? u.slice(u.indexOf("#")) : ""; };
  const state: { hashchange: () => unknown } = { hashchange: nowhere };
  g.location = loc;
  g.history = { replaceState: vi.fn((_s: unknown, _t: string, u: string) => url(u)), pushState: vi.fn((_s: unknown, _t: string, u: string) => url(u)) };
  g.window = { addEventListener: (t: string, fn: () => unknown) => { if (t === "hashchange") state.hashchange = fn; } };
  g.document.listeners.keydown = [];
  g.document.activeElement = null;
  for (const id of ["main", "sidebar", "modal-root", "toast"]) el(id).replaceChildren();
  toastEl().className = "";
  /** Changes the address and fires `hashchange`, as a click on a link does. */
  const go = (to: string) => { loc.hash = to; return state.hashchange(); };
  return { loc, go };
}
export function dropBrowser() {
  delete g.location;
  delete g.history;
  delete g.window;
}

/** Starts the admin app (`ui/app.js`) on `hash` with stubs; `api` replaces single calls. Returns what the tests need. */
export async function launchApp(real: Record<string, any>, hash: string, over: Record<string, any> = {}, depsOver: Record<string, any> = {}) {
  const browser = setupBrowser(hash);
  const api: Record<string, any> = {
    info: vi.fn(async () => ({ repo: "r" })),
    flows: vi.fn(async () => []),
    flow: vi.fn(async (name: string) => ({ name, scope: "repo", yaml: flowJson(name) })),
    validate: vi.fn(async () => ({ ok: true, flow: { name: "my-flow", workspace: "worktree", vars: {} } })),
    saveFlow: vi.fn(async (_n: string, yaml: string) => ({ yaml })),
    deleteFlow: vi.fn(async () => ({})),
    startRun: vi.fn(async () => ({ runId: "run1" })),
    generate: vi.fn(),
    ...over,
  };
  const never = new Proxy({}, { get: () => vi.fn() });
  const debounced: Array<() => unknown> = [];
  const deps: Record<string, any> = {
    "/vendor/yaml/index.js": { default: { parse: JSON.parse, stringify: (v: unknown) => JSON.stringify(v) } },
    "./api.js": { api },
    "./auth.js": { ...real.auth, enterDisplay: async () => ({ id: "a1" }) },
    // no timers: the typing check never runs by itself; a test can call the function the debounce would have called
    "./dom.js": { ...real.dom, debounce: (fn: () => unknown) => { debounced.push(fn); return () => undefined; } },
    "./ia.js": real.ia,
    "./shell.js": { showPage: vi.fn(), initShell: vi.fn() },
    "./states.js": real.states,
    "./icons.js": { flowNameMark: (f: { name: string }) => f.name },
    "./editor.js": { renderEditor: () => real.dom.h("div"), cleanFlow: (x: unknown) => x, editable: (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x) },
    "./graph.js": { renderGraph: () => real.dom.h("div") },
    "./health.js": { loadHealth: vi.fn(), startHealth: vi.fn() },
    "./since.js": { startSince: vi.fn() },
    "./turn.js": { startBadge: async () => 0, startHash: () => null },
    "./flow-problems.js": await import("../../ui/flow-problems.js" as string),
    "./library.js": never,
    "./models.js": { refreshModelLists: vi.fn(), renderModels: vi.fn() },
    "./home-admin.js": never,
    "./work.js": never,
  };
  for (const n of ["./admin.js", "./maintenance.js", "./dashboard.js", "./problems.js", "./runs.js", "./admin-repos.js", "./admin-credentials.js", "./operations.js",
    "./refinement.js", "./repos.js", "./users.js", "./user/start.js", "./audit.js", "./board.js"]) deps[n] = never;
  // The flow page is its own module: load it with the same stubs and hand the app the page it makes.
  deps["./flow-state.js"] = await import("../../ui/flow-state.js" as string);
  deps["./flow-shell.js"] = await import("../../ui/flow-shell.js" as string);
  const all = { ...deps, ...depsOver };
  const { createFlowPage } = await loadUiSource("flow-page.js", all, ["createFlowPage"]);
  let page: any;
  all["./flow-page.js"] = { createFlowPage: (o: unknown) => (page = createFlowPage({ ...(o as object), storage: undefined, isNarrow: () => false, watchNarrow: undefined })) };
  await loadUiSource("app.js", all);
  const mod = { refreshFlows: () => page.refreshFlows() };
  return { api, mod, debounced, ...browser };
}

/** Makes the open flow dirty: switches to YAML and types into the textarea. Returns the textarea. */
export function edit(text: string): FakeElement {
  if (!main().all("textarea").length) click(main(), "YAML");
  const ta = main().all("textarea").find((t) => t.getAttribute("class") === "yaml-editor")!;
  ta.value = text;
  ta.fire("input", { target: ta });
  return ta;
}
