import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
let restore: () => void;
let real: Record<string, any>;
beforeAll(async () => {
  restore = installFakeDom();
  real = {
    dom: await import("../ui/dom.js" as string),
    states: await import("../ui/states.js" as string),
    ia: await import("../ui/ia.js" as string),
    auth: await import("../ui/auth.js" as string),
  };
});
afterAll(() => restore());

/** Runs a router file with its imports taken from `deps`. Returns the promise of the module body; it is not awaited here. */
function loadRouter(file: string, deps: Record<string, any>, text?: string): Promise<void> {
  const src = (text ?? readFileSync(`ui/${file}`, "utf8"))
    .replace(/^import (\w+) from "([^"]+)";$/gm, (_m, x, s) => `const ${x} = ${dep(deps, s)}.default;`)
    .replace(/^import \{([^}]+)\} from "([^"]+)";$/gm, (_m, names, s) => `const {${names}} = ${dep(deps, s)};`);
  if (/^import /m.test(src)) throw new Error(`loadRouter: an import form is not supported in ${file}`);
  return new AsyncFunction("__deps", `"use strict";\n${src}`)(deps);
}
function dep(deps: Record<string, any>, spec: string): string {
  if (!(spec in deps)) throw new Error(`loadRouter: no stub for ${spec}`);
  return `__deps[${JSON.stringify(spec)}]`;
}

let hashchange: (() => unknown) | undefined;
const g = globalThis as any;
function setup(hash: string) {
  g.location = { hash, search: "", reload: vi.fn() };
  g.history = { replaceState: vi.fn() };
  g.window = { addEventListener: (t: string, fn: () => unknown) => { if (t === "hashchange") hashchange = fn; } };
  hashchange = undefined;
  g.document.getElementById("main").replaceChildren();
}
afterEach(() => {
  delete g.location;
  delete g.history;
  delete g.window;
});
beforeEach(() => setup("#/runs"));

const el = (text: string) => real.dom.h("p", {}, text);
const main = () => g.document.getElementById("main") as FakeElement;
const alerts = () => main().all("div").filter((d) => d.getAttribute("role") === "alert");
const buttons = () => main().all("button");
const tick = () => new Promise((r) => setTimeout(r, 0));
const never = new Proxy({}, { get: () => vi.fn() });

describe("loadRouter", () => {
  it("fails loudly on an import form it does not know", () => {
    expect(() => loadRouter("x.js", {}, 'import * as x from "y";\n')).toThrow(/not supported/);
  });

  it("fails loudly on an import without a stub", () => {
    expect(() => loadRouter("x.js", {}, 'import { a } from "y";\n')).toThrow(/no stub/);
  });
});

describe("user router", () => {
  const deps = (over: Record<string, any>) => ({
    "/auth.js": { ...real.auth, enterDisplay: async () => ({ id: "u1" }) },
    "/dom.js": real.dom,
    "/ia.js": real.ia,
    "/refinement.js": never,
    "/repos.js": never,
    "/user/runs.js": never,
    "/user/start.js": { homeHash: async () => "#/runs", renderStart: vi.fn() },
    "/shell.js": { showPage: vi.fn(), initShell: vi.fn(), namePage: vi.fn() },
    "/home.js": never,
    "/states.js": real.states,
    "/view-as.js": { beginView: () => ({ readOnly: false, ready: true }) },
    ...over,
  });

  it("shows an error with Retry, and Retry loads the page", async () => {
    const renderMyRuns = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 500 }))
      .mockImplementationOnce(async (box: FakeElement) => { real.dom.mount(box, el("runs page")); });
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns } }));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.textContent).toContain("This page could not be loaded.");
    expect(alerts()[0]?.textContent).toContain("boom");
    const retry = buttons().find((b) => b.textContent === "Retry")!;
    retry.click();
    await tick();
    expect(renderMyRuns).toHaveBeenCalledTimes(2);
    expect(alerts()).toHaveLength(0);
    expect(main().textContent).toContain("runs page");
  });

  it("marks a network failure as offline", async () => {
    const renderMyRuns = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns } }));
    expect(alerts()[0]?.getAttribute("data-kind")).toBe("offline");
  });

  it("does not let a late error replace a newer page", async () => {
    let fail!: (e: unknown) => void;
    const renderMyRuns = vi.fn().mockReturnValueOnce(new Promise((_r, rej) => { fail = rej; }));
    const renderRepos = vi.fn(async (box: FakeElement) => { real.dom.mount(box, el("repos page")); });
    const started = loadRouter("user/app.js", deps({
      "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns },
      "/repos.js": { renderRepos },
    }));
    await tick();
    expect(hashchange).toBeTypeOf("function");
    g.location.hash = "#/repos";
    await hashchange!();
    expect(main().textContent).toContain("repos page");
    fail(new Error("late"));
    await started;
    await tick();
    expect(alerts()).toHaveLength(0);
    expect(main().textContent).toContain("repos page");
  });

  it("keeps the generation check", () => {
    const src = readFileSync("ui/user/app.js", "utf8");
    expect(src).toContain("mine === generation && !stopped");
    expect(src).toContain("errorState(explainError(e,");
  });
});

describe("admin router", () => {
  const stub = (over: Record<string, any> = {}) => {
    const names = [
      "./editor.js", "./graph.js", "./library.js", "./admin.js", "./maintenance.js", "./models.js", "./dashboard.js", "./problems.js", "./flow-problems.js", "./runs.js",
      "./admin-repos.js", "./admin-credentials.js", "./refinement.js", "./repos.js", "./users.js", "./user-detail.js", "./user/start.js", "./audit.js", "./board.js",
    ];
    return {
      "/vendor/yaml/index.js": { default: { parse: () => ({}) } },
      "./api.js": { api: { info: async () => ({ repo: "r" }), flows: async () => [] } },
      "./auth.js": { ...real.auth, enterDisplay: async () => ({ id: "a1" }) },
      "./dom.js": real.dom,
      "./ia.js": real.ia,
      "./shell.js": { showPage: vi.fn(), initShell: vi.fn(), namePage: vi.fn() },
      "./states.js": real.states,
      "./icons.js": { flowNameMark: () => "" },
      "./work.js": never,
      "./home-admin.js": never,
      "./health.js": { loadHealth: vi.fn(), startHealth: vi.fn() },
      "./since.js": { startSince: vi.fn() },
      "./turn.js": { renderYourTurn: vi.fn(), startBadge: async () => 0, startHash: () => null },
      ...Object.fromEntries(names.map((n) => [n, never])),
      "./models.js": { refreshModelLists: vi.fn(), renderModels: vi.fn() },
      "./flow-page.js": { createFlowPage: () => ({ refreshFlows: async () => {}, renderSidebar: vi.fn(), renderFlowView: vi.fn(), openFlow: vi.fn(), openNew: vi.fn(), newBlank: vi.fn(), save: vi.fn(), generateDialog: vi.fn(), confirmDiscard: async () => true, dialogOpen: () => false }) },
      ...over,
    };
  };

  it("shows an error with Retry, and Retry loads the page", async () => {
    setup("#/dashboard");
    const renderDashboard = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("no"), { status: 403 }))
      .mockImplementationOnce(async (box: FakeElement) => { real.dom.mount(box, el("dashboard page")); });
    await loadRouter("app.js", stub({ "./dashboard.js": { renderDashboard } }));
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    expect(alerts()[0]?.getAttribute("data-kind")).toBe("permission");
    buttons().find((b) => b.textContent === "Retry")!.click();
    await vi.waitFor(() => expect(main().textContent).toContain("dashboard page"));
    expect(renderDashboard).toHaveBeenCalledTimes(2);
    expect(alerts()).toHaveLength(0);
  });

  it("does not let a late error replace a newer page", async () => {
    setup("#/dashboard");
    let fail!: (e: unknown) => void;
    const renderDashboard = vi.fn().mockReturnValueOnce(new Promise((_r, rej) => { fail = rej; }));
    const renderProblems = vi.fn(async (box: FakeElement) => { real.dom.mount(box, el("problems page")); });
    await loadRouter("app.js", stub({ "./dashboard.js": { renderDashboard }, "./problems.js": { renderProblems } }));
    await vi.waitFor(() => expect(renderDashboard).toHaveBeenCalledTimes(1));
    g.location.hash = "#/problems";
    hashchange!();
    await vi.waitFor(() => expect(main().textContent).toContain("problems page"));
    fail(new Error("late"));
    await tick();
    expect(alerts()).toHaveLength(0);
    expect(main().textContent).toContain("problems page");
  });

  it("keeps the generation check before the error state", () => {
    const lines = readFileSync("ui/app.js", "utf8").split("\n");
    const i = lines.findIndex((l) => l.includes("errorState(explainError(e,"));
    expect(i).toBeGreaterThan(0);
    expect(lines[i - 1]).toContain("if (mine !== routeGen) return;");
  });
});
