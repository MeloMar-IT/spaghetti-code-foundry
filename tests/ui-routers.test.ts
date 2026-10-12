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
    viewport: await import("../ui/viewport.js" as string),
    runsFilter: await import("../ui/runs-filter.js" as string),
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
  // as a browser: replaceState changes the address (without a hashchange)
  g.history = { replaceState: vi.fn((_s: unknown, _t: string, url: string) => { g.location.hash = url; }) };
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
const contextStub = (over: Record<string, any> = {}) => ({
  initContext: vi.fn(() => ({ ready: Promise.resolve(), scoped: () => null, keep: (h: string) => h, current: () => ({ active: false, repo: "", own: false }), refresh: async () => {}, stop: vi.fn(), ...over })),
});

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
    "/runs-filter.js": real.runsFilter,
    "/refinement.js": never,
    "/repos.js": never,
    "/repo-view.js": never,
    "/user/runs.js": never,
    "/user/start.js": { homeHash: async () => "#/runs", renderStart: vi.fn() },
    "/shell.js": { showPage: vi.fn(), initShell: vi.fn(), namePage: vi.fn() },
    "/palette.js": { initPalette: vi.fn(() => () => {}) },
    "/ask.js": { initAsk: vi.fn(async () => null) },
    "/context.js": contextStub(),
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

  it("starts the palette for a user, and stops it when the view ends", async () => {
    const stop = vi.fn();
    const initPalette = vi.fn(() => stop);
    let onEnded!: () => void;
    const beginView = (_as: string, _me: unknown, opts: { onEnded: () => void }) => {
      onEnded = opts.onEnded;
      return { readOnly: true, ready: true };
    };
    await loadRouter("user/app.js", deps({ "/palette.js": { initPalette }, "/view-as.js": { beginView } }));
    expect(initPalette).toHaveBeenCalledWith({ role: "user", user: { id: "u1" }, preview: true });
    expect(stop).not.toHaveBeenCalled();
    onEnded();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("starts Ask SCF for a user, and not in a preview or when the view cannot be shown", async () => {
    const initAsk = vi.fn(async () => null);
    await loadRouter("user/app.js", deps({ "/ask.js": { initAsk } }));
    expect(initAsk.mock.calls).toEqual([["user"]]);
    initAsk.mockClear();
    await loadRouter("user/app.js", deps({ "/ask.js": { initAsk }, "/view-as.js": { beginView: () => ({ readOnly: true, ready: true }) } }));
    await loadRouter("user/app.js", deps({ "/ask.js": { initAsk }, "/view-as.js": { beginView: () => ({ readOnly: false, ready: false }) } }));
    expect(initAsk).not.toHaveBeenCalled();
  });

  it("starts no palette when the view cannot be shown", async () => {
    const initPalette = vi.fn();
    await loadRouter("user/app.js", deps({ "/palette.js": { initPalette }, "/view-as.js": { beginView: () => ({ readOnly: false, ready: false }) } }));
    expect(initPalette).not.toHaveBeenCalled();
  });

  it("scopes a bare page", async () => {
    const scoped = vi.fn((h: string) => (h === "#/runs" ? "#/runs?repo=a%2Fb" : null));
    const renderMyRuns = vi.fn();
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns }, "/context.js": contextStub({ scoped }) }));
    expect(g.history.replaceState).toHaveBeenCalledWith(null, "", "#/runs?repo=a%2Fb");
    expect(renderMyRuns.mock.calls[0]![1].query).toEqual({ repo: "a/b" });
  });

  it("gives My runs the filter of the address, without the owner", async () => {
    setup("#/runs?q=x&owner=u1&status=failed");
    const renderMyRuns = vi.fn();
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns } }));
    const opts = renderMyRuns.mock.calls[0]![1];
    expect(opts.filter).toEqual(real.runsFilter.parseFilter(g.location.hash));
    expect(opts.filter.q).toBe("x");
    expect(opts.filter.status).toBe("failed");
    expect(opts.alive()).toBe(true);
  });

  it("does not scope an address that was replaced", async () => {
    setup("#/nope");
    const scoped = vi.fn(() => "#/runs?repo=a%2Fb");
    const renderMyRuns = vi.fn();
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns }, "/context.js": contextStub({ scoped }) }));
    expect(scoped).not.toHaveBeenCalled();
    expect(renderMyRuns.mock.calls[0]![1].query).toEqual({});
  });

  it("starts the context with readOnly, stops it when the view ends, and starts none when the view cannot be shown", async () => {
    const stop = vi.fn();
    const ctx = contextStub({ stop });
    let onEnded!: () => void;
    const beginView = (_as: string, _me: unknown, opts: { onEnded: () => void }) => { onEnded = opts.onEnded; return { readOnly: true, ready: true }; };
    await loadRouter("user/app.js", deps({ "/context.js": ctx, "/view-as.js": { beginView } }));
    expect(ctx.initContext).toHaveBeenCalledWith("user", { id: "u1" }, { readOnly: true, go: expect.any(Function) });
    onEnded();
    expect(stop).toHaveBeenCalledTimes(1);
    const none = contextStub();
    await loadRouter("user/app.js", deps({ "/context.js": none, "/view-as.js": { beginView: () => ({ readOnly: false, ready: false }) } }));
    expect(none.initContext).not.toHaveBeenCalled();
  });

  it("draws the first page only after the context is ready, and draws the latest address once", async () => {
    let settle!: () => void;
    const ready = new Promise<void>((r) => { settle = r; });
    const renderMyRuns = vi.fn();
    const renderRepos = vi.fn();
    const started = loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns }, "/repos.js": { renderRepos }, "/context.js": contextStub({ ready }) }));
    await tick();
    expect(renderMyRuns).not.toHaveBeenCalled();
    expect(hashchange).toBeUndefined();
    g.location.hash = "#/repos";
    settle();
    await started;
    expect(renderMyRuns).not.toHaveBeenCalled();
    expect(renderRepos).toHaveBeenCalledTimes(1);
  });

  it("gives the context a go that navigates, or only rewrites the address", async () => {
    const ctx = contextStub();
    const renderMyRuns = vi.fn();
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns }, "/context.js": ctx }));
    const go = (ctx.initContext.mock.calls[0] as any)[2].go;
    g.history.replaceState.mockClear();
    go("#/repos?repo=all", { replace: true, draw: false });
    expect(g.history.replaceState).toHaveBeenCalledWith(null, "", "#/repos?repo=all");
    expect(renderMyRuns).toHaveBeenCalledTimes(1);
    go("#/runs", { replace: true });
    await tick();
    expect(renderMyRuns).toHaveBeenCalledTimes(2);
    g.history.replaceState.mockClear();
    go("#/repos");
    expect(g.location.hash).toBe("#/repos");
    expect(g.history.replaceState).not.toHaveBeenCalled();
  });

  it("sends filter changes of the three pages through context.keep, writing the address only", async () => {
    const ctx = contextStub({ keep: (h: string) => (h.includes("repo=") ? h : h.replace("#/runs", "#/runs?repo=all").replace(/\?repo=all\?/, "?repo=all&")) });
    const renderMyRuns = vi.fn();
    const renderRepos = vi.fn();
    const renderRefinement = vi.fn();
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns }, "/repos.js": { renderRepos }, "/refinement.js": { renderRefinement }, "/context.js": ctx }));
    const go = renderMyRuns.mock.calls[0]![1].go;
    g.history.replaceState.mockClear();
    go("#/runs?owner=u1");
    expect(g.history.replaceState).toHaveBeenCalledWith(null, "", "#/runs?repo=all&owner=u1");
    expect(g.location.hash).toBe("#/runs?repo=all&owner=u1");
    await tick();
    expect(renderMyRuns).toHaveBeenCalledTimes(1); // the address changed, the page did not draw again
    for (const [hash, fn] of [["#/repos", renderRepos], ["#/refinement", renderRefinement]] as const) {
      setup(hash);
      await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns }, "/repos.js": { renderRepos }, "/refinement.js": { renderRefinement }, "/context.js": ctx }));
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());
      expect(typeof fn.mock.calls.at(-1)![1].go, hash).toBe("function");
    }
  });

  it("draws one repository on #/repos/<id> and the list on #/repos", async () => {
    const renderRepos = vi.fn();
    const renderRepo = vi.fn();
    setup("#/repos/r1");
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns: vi.fn() }, "/repos.js": { renderRepos }, "/repo-view.js": { renderRepo } }));
    await vi.waitFor(() => expect(renderRepo).toHaveBeenCalledTimes(1));
    expect(renderRepo.mock.calls[0]![1]).toMatchObject({ id: "r1", admin: false });
    expect(Object.keys(renderRepo.mock.calls[0]![1])).not.toEqual(expect.arrayContaining(["sections"]));
    expect(renderRepo.mock.calls[0]![1].source).toBeUndefined();
    expect(renderRepo.mock.calls[0]![1].attention).toBeUndefined();
    expect(renderRepos).not.toHaveBeenCalled();
    setup("#/repos");
    await loadRouter("user/app.js", deps({ "/user/runs.js": { renderMyRun: vi.fn(), renderMyRuns: vi.fn() }, "/repos.js": { renderRepos }, "/repo-view.js": { renderRepo } }));
    await vi.waitFor(() => expect(renderRepos).toHaveBeenCalledTimes(1));
    expect(renderRepo).toHaveBeenCalledTimes(1);
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
      "./editor.js", "./graph.js", "./library.js", "./admin.js", "./watchers.js", "./maintenance.js", "./models.js", "./dashboard.js", "./problems.js", "./flow-problems.js", "./runs.js",
      "./admin-repos.js", "./admin-credentials.js", "./operations.js", "./refinement.js", "./repos.js", "./repo-view.js", "./repo-admin-sections.js", "./users.js", "./user-detail.js", "./user/start.js", "./audit.js", "./board.js",
    ];
    return {
      "/vendor/yaml/index.js": { default: { parse: () => ({}) } },
      "./api.js": { api: { info: async () => ({ repo: "r" }), flows: async () => [] } },
      "./auth.js": { ...real.auth, enterDisplay: async () => ({ id: "a1" }) },
      "./dom.js": real.dom,
      "./ia.js": real.ia,
      "./viewport.js": real.viewport,
      "./shell.js": { showPage: vi.fn(), initShell: vi.fn(), namePage: vi.fn() },
      "./palette.js": { initPalette: vi.fn() },
      "./ask.js": { initAsk: vi.fn(async () => null) },
      "./context.js": contextStub(),
      "./states.js": real.states,
      "./icons.js": { flowNameMark: () => "" },
      "./work.js": never,
      "./home-admin.js": never,
      "./runs-filter.js": real.runsFilter,
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

  it("opens a provider on #/models/:name", async () => {
    setup("#/models/ollama");
    const renderModels = vi.fn();
    const renderModelDetail = vi.fn();
    await loadRouter("app.js", stub({ "./models.js": { refreshModelLists: vi.fn(), renderModels, renderModelDetail } }));
    await vi.waitFor(() => expect(renderModelDetail).toHaveBeenCalledTimes(1));
    expect(renderModelDetail.mock.calls[0]![1]).toBe("ollama");
    expect(renderModels).not.toHaveBeenCalled();
  });

  it("routes the watcher and problem pages with an id, and the lists without", async () => {
    const page = (name: string) => vi.fn(async (box: FakeElement) => { real.dom.mount(box, el(name)); });
    for (const [hash, fn, expected] of [
      ["#/watchers/w1", "renderWatcherDetail", ["w1", { readOnly: false }]], ["#/watchers", "renderWatchers", [{ readOnly: false }]],
      ["#/problems/abc", "renderProblemDetail", ["abc"]], ["#/problems", "renderProblems", []],
    ] as const) {
      setup(hash);
      const mocks = {
        renderWatchers: page("watchers list"), renderWatcherDetail: page("watcher detail"),
        renderProblems: page("problems list"), renderProblemDetail: page("problem detail"),
      };
      await loadRouter("app.js", stub({
        "./watchers.js": { renderWatchers: mocks.renderWatchers, renderWatcherDetail: mocks.renderWatcherDetail },
        "./problems.js": { renderProblems: mocks.renderProblems, renderProblemDetail: mocks.renderProblemDetail },
      }));
      await vi.waitFor(() => expect(mocks[fn]).toHaveBeenCalledTimes(1));
      expect(mocks[fn].mock.calls[0]!.slice(1), hash).toEqual(expected);
      for (const [name, other] of Object.entries(mocks)) if (name !== fn) expect(other, hash).not.toHaveBeenCalled();
    }
  });

  it("starts Ask SCF for an admin", async () => {
    setup("#/dashboard");
    const initAsk = vi.fn(async () => null);
    await loadRouter("app.js", stub({ "./ask.js": { initAsk }, "./dashboard.js": { renderDashboard: vi.fn() } }));
    expect(initAsk.mock.calls).toEqual([["admin"]]);
  });

  it("starts the palette for an admin", async () => {
    setup("#/dashboard");
    const initPalette = vi.fn();
    await loadRouter("app.js", stub({ "./palette.js": { initPalette }, "./dashboard.js": { renderDashboard: vi.fn() } }));
    expect(initPalette).toHaveBeenCalledWith({ role: "admin", user: { id: "a1" } });
  });

  it("scopes #/board and gives the repository to the board", async () => {
    setup("#/board");
    const renderBoard = vi.fn();
    await loadRouter("app.js", stub({ "./board.js": { renderBoard }, "./context.js": contextStub({ scoped: () => "#/board/a%2Fb" }) }));
    await vi.waitFor(() => expect(renderBoard).toHaveBeenCalledTimes(1));
    expect(renderBoard.mock.calls[0]![1]).toBe("a/b");
    expect(g.history.replaceState).toHaveBeenCalledWith(null, "", "#/board/a%2Fb");
  });

  it("sends filter changes of the Runs list, the classic board and the redesigned board through context.keep", async () => {
    const keep = vi.fn((h: string) => (h.includes("repo=") ? h : `${h}${h.includes("?") ? "&" : "?"}repo=all`));
    for (const [hash, redesign] of [["#/runs", false], ["#/board", false], ["#/board", true]] as const) {
      setup(hash);
      const renderRunsList = vi.fn();
      const renderBoard = vi.fn();
      const renderWork = vi.fn();
      await loadRouter("app.js", stub({
        "./context.js": contextStub({ keep }),
        "./runs.js": { renderRunsList }, "./board.js": { renderBoard }, "./work.js": { renderWork },
        "./api.js": { api: { info: async () => ({ repo: "r", redesign }), flows: async () => [] } },
      }));
      const fn = hash === "#/runs" ? renderRunsList : redesign ? renderWork : renderBoard;
      await vi.waitFor(() => expect(fn).toHaveBeenCalledTimes(1));
      const call = fn.mock.calls[0]!;
      const go = (call[2] ?? call[1]).go;
      g.history.replaceState.mockClear();
      go(`${hash}?owner=u1`);
      expect(g.history.replaceState, `${hash} ${redesign}`).toHaveBeenCalledWith(null, "", `${hash}?owner=u1&repo=all`);
      expect(g.location.hash).toBe(`${hash}?owner=u1&repo=all`);
    }
  });

  it("gives the redesigned board the address filters", async () => {
    setup("#/board?repo=all&owner=me");
    const renderWork = vi.fn();
    await loadRouter("app.js", stub({
      "./work.js": { renderWork },
      "./api.js": { api: { info: async () => ({ repo: "r", redesign: true }), flows: async () => [] } },
    }));
    await vi.waitFor(() => expect(renderWork).toHaveBeenCalledTimes(1));
    expect(renderWork.mock.calls[0]![2].query).toEqual({ owner: "me" });
  });

  it("does not scope a redirected address, and starts the context for the admin", async () => {
    setup("#/nope");
    const scoped = vi.fn(() => "#/board/a%2Fb");
    const ctx = contextStub({ scoped });
    await loadRouter("app.js", stub({ "./context.js": ctx }));
    await tick();
    expect(scoped).not.toHaveBeenCalled();
    expect(ctx.initContext).toHaveBeenCalledWith("admin", { id: "a1" }, { go: expect.any(Function) });
  });

  it("waits for the context, and a navigation meanwhile is drawn once afterwards", async () => {
    setup("#/dashboard");
    let settle!: () => void;
    const ready = new Promise<void>((r) => { settle = r; });
    const renderDashboard = vi.fn();
    const renderProblems = vi.fn();
    void loadRouter("app.js", stub({ "./dashboard.js": { renderDashboard }, "./problems.js": { renderProblems }, "./context.js": contextStub({ ready }) }));
    await tick();
    expect(renderDashboard).not.toHaveBeenCalled();
    g.location.hash = "#/problems";
    hashchange!();
    await tick();
    expect(renderProblems).not.toHaveBeenCalled();
    settle();
    await vi.waitFor(() => expect(renderProblems).toHaveBeenCalledTimes(1));
    expect(renderDashboard).not.toHaveBeenCalled();
  });

  it("gives the context a go that only rewrites the address, or draws again", async () => {
    setup("#/dashboard");
    const renderDashboard = vi.fn();
    const ctx = contextStub();
    await loadRouter("app.js", stub({ "./dashboard.js": { renderDashboard }, "./context.js": ctx }));
    await vi.waitFor(() => expect(renderDashboard).toHaveBeenCalledTimes(1));
    const go = (ctx.initContext.mock.calls[0] as any)[2].go;
    g.history.replaceState.mockClear();
    go("#/dashboard?repo=all", { replace: true, draw: false });
    expect(g.history.replaceState).toHaveBeenCalledWith(null, "", "#/dashboard?repo=all");
    expect(renderDashboard).toHaveBeenCalledTimes(1);
    go("#/dashboard", { replace: true });
    await vi.waitFor(() => expect(renderDashboard).toHaveBeenCalledTimes(2));
  });

  it("keeps the generation check before the error state", () => {
    const lines = readFileSync("ui/app.js", "utf8").split("\n");
    const i = lines.findIndex((l) => l.includes("errorState(explainError(e,"));
    expect(i).toBeGreaterThan(0);
    expect(lines[i - 1]).toContain("if (mine !== routeGen) return;");
  });
});

describe("support levels", () => {
  const listeners: Record<string, () => unknown> = {};
  let observed: (() => unknown) | undefined;
  let dialogs = 0;
  const note = () => g.document.getElementById("level-note") as FakeElement;
  const adminDeps = (over: Record<string, any> = {}) => ({
    "/vendor/yaml/index.js": { default: { parse: () => ({}) } },
    "./api.js": { api: { info: async () => ({ repo: "r" }), flows: async () => [] } },
    "./auth.js": { ...real.auth, enterDisplay: async () => ({ id: "a1" }) },
    "./dom.js": real.dom,
    "./ia.js": real.ia,
    "./viewport.js": real.viewport,
    "./shell.js": { showPage: vi.fn(), initShell: vi.fn(), namePage: vi.fn() },
    "./palette.js": { initPalette: vi.fn() },
    "./ask.js": { initAsk: vi.fn(async () => null) },
    "./context.js": contextStub(),
    "./states.js": real.states,
    "./icons.js": { flowNameMark: () => "" },
    "./work.js": never,
    "./home-admin.js": never,
    "./runs-filter.js": real.runsFilter,
    "./health.js": { loadHealth: vi.fn(), startHealth: vi.fn() },
    "./since.js": { startSince: vi.fn() },
    "./turn.js": { renderYourTurn: vi.fn(), startBadge: async () => 0, startHash: () => null },
    ...Object.fromEntries(["./library.js", "./admin.js", "./watchers.js", "./maintenance.js", "./dashboard.js", "./problems.js", "./runs.js", "./admin-repos.js",
      "./admin-credentials.js", "./operations.js", "./refinement.js", "./repos.js", "./repo-view.js", "./repo-admin-sections.js", "./users.js", "./user-detail.js", "./user/start.js", "./audit.js", "./board.js"].map((n) => [n, never])),
    "./models.js": { refreshModelLists: vi.fn(), renderModels: vi.fn(), renderModelDetail: vi.fn() },
    "./flow-page.js": { createFlowPage: () => ({ refreshFlows: async () => {}, renderSidebar: vi.fn(), renderFlowView: vi.fn(), openFlow: vi.fn(), openNew: vi.fn(), newBlank: vi.fn(), save: vi.fn(), generateDialog: vi.fn(), confirmDiscard: async () => true, dialogOpen: () => dialogs > 0 }) },
    ...over,
  });
  const width = (w: number | undefined) => { if (w === undefined) delete g.innerWidth; else g.innerWidth = w; };
  const fire = async (name: "compact" | "wide") => { listeners[name]!(); await tick(); };
  const closeDialog = async () => { dialogs = 0; observed!(); await new Promise((r) => setTimeout(r, 5)); };
  const load = async (hash: string, w: number | undefined, over: Record<string, any> = {}) => {
    setup(hash);
    width(w);
    return loadRouter("app.js", adminDeps(over));
  };
  const page = () => vi.fn(async (box: FakeElement) => { real.dom.mount(box, el("page")); });

  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
    observed = undefined;
    dialogs = 0;
    g.matchMedia = (q: string) => ({ addEventListener: (_t: string, fn: () => unknown) => { listeners[q.includes("max-width: 767") ? "compact" : "wide"] = fn; } });
    g.MutationObserver = class { constructor(cb: () => unknown) { observed = cb; } observe() {} };
    note().hidden = true;
    note().textContent = "";
  });
  afterEach(() => {
    delete g.innerWidth;
    delete g.matchMedia;
    delete g.MutationObserver;
  });

  it("is full with no innerWidth and shows no notice", async () => {
    const renderUsers = page();
    await load("#/users", undefined, { "./users.js": { renderUsers } });
    await vi.waitFor(() => expect(renderUsers).toHaveBeenCalledTimes(1));
    expect(renderUsers.mock.calls[0]![1].readOnly).toBe(false);
    expect(note().hidden).toBe(true);
  });

  it("is read-only at 360 and shows the notice; full at 768", async () => {
    const renderUsers = page();
    await load("#/users", 360, { "./users.js": { renderUsers } });
    await vi.waitFor(() => expect(renderUsers).toHaveBeenCalledTimes(1));
    expect(renderUsers.mock.calls[0]![1].readOnly).toBe(true);
    expect(note().textContent).toBe("Editing needs a wider screen (768 px or more).");
    expect(note().hidden).toBe(false);
    const wide = page();
    await load("#/users", 768, { "./users.js": { renderUsers: wide } });
    await vi.waitFor(() => expect(wide).toHaveBeenCalledTimes(1));
    expect(wide.mock.calls[0]![1].readOnly).toBe(false);
    expect(note().hidden).toBe(true);
  });

  it("shows the flow notice below 1024 px and none at 1024", async () => {
    await load("#/flows", 800);
    await vi.waitFor(() => expect(note().hidden).toBe(false));
    expect(note().textContent).toBe("Editing a flow needs a wider screen (1024 px or more).");
    await load("#/flows", 1024);
    await vi.waitFor(() => expect(note().hidden).toBe(true));
  });

  it("passes readOnly to the user page and Settings", async () => {
    const renderUserDetail = page();
    await load("#/users/u1", 360, { "./user-detail.js": { renderUserDetail } });
    await vi.waitFor(() => expect(renderUserDetail).toHaveBeenCalledTimes(1));
    expect(renderUserDetail.mock.calls[0]![2].readOnly).toBe(true);
    const renderSettings = page();
    await load("#/settings", 360, { "./admin.js": { renderSettings } });
    await vi.waitFor(() => expect(renderSettings).toHaveBeenCalledTimes(1));
    expect(renderSettings.mock.calls[0]![1].readOnly).toBe(true);
  });

  it("draws one repository on #/repos/<id> and the list on #/repos", async () => {
    const renderRepo = page();
    const renderRepos = page();
    await load("#/repos/r1", 1024, { "./repo-view.js": { renderRepo }, "./repos.js": { renderRepos } });
    await vi.waitFor(() => expect(renderRepo).toHaveBeenCalledTimes(1));
    expect(renderRepo.mock.calls[0]![1]).toMatchObject({ id: "r1", admin: true });
    expect(Object.keys(renderRepo.mock.calls[0]![1])).toEqual(expect.arrayContaining(["sections", "source", "attention"]));
    expect(renderRepos).not.toHaveBeenCalled();
    await load("#/repos", 1024, { "./repo-view.js": { renderRepo }, "./repos.js": { renderRepos } });
    await vi.waitFor(() => expect(renderRepos).toHaveBeenCalledTimes(1));
    expect(renderRepos.mock.calls[0]![1]).toMatchObject({ admin: true, switcher: true });
    expect(renderRepo).toHaveBeenCalledTimes(1);
  });

  it("shows the notice only on Dashboard, Credentials and Audit", async () => {
    for (const [hash, over] of [
      ["#/dashboard", { "./dashboard.js": { renderDashboard: page() } }],
      ["#/credentials", { "./admin-credentials.js": { renderCredentials: async () => () => {} } }],
      ["#/audit", { "./audit.js": { renderAudit: () => () => {} } }],
    ] as const) {
      await load(hash, 360, over);
      await vi.waitFor(() => expect(note().hidden, hash).toBe(false));
    }
  });

  it("shows no notice on pages that are not wired yet", async () => {
    for (const hash of ["#/problems", "#/models"]) {
      note().hidden = true;
      await load(hash, 360, { "./problems.js": { renderProblems: page() } });
      await tick();
      expect(note().hidden, hash).toBe(true);
    }
  });

  it("redraws on a crossing that changes the level, and only then", async () => {
    const renderUsers = page();
    await load("#/users", 1024, { "./users.js": { renderUsers } });
    await vi.waitFor(() => expect(renderUsers).toHaveBeenCalledTimes(1));
    width(360);
    await fire("compact");
    await vi.waitFor(() => expect(renderUsers).toHaveBeenCalledTimes(2));
    expect(renderUsers.mock.calls[1]![1].readOnly).toBe(true);
    width(800);
    await fire("compact");
    await vi.waitFor(() => expect(renderUsers).toHaveBeenCalledTimes(3));
    expect(renderUsers.mock.calls[2]![1].readOnly).toBe(false);
    width(1100);
    await fire("wide");
    expect(renderUsers).toHaveBeenCalledTimes(3);
  });

  it("draws nothing on a crossing on a page whose level does not change", async () => {
    const renderProblems = page();
    await load("#/problems", 1024, { "./problems.js": { renderProblems } });
    await vi.waitFor(() => expect(renderProblems).toHaveBeenCalledTimes(1));
    width(360);
    await fire("compact");
    expect(renderProblems).toHaveBeenCalledTimes(1);
    const renderRuns = page();
    await load("#/runs", 1024, { "./runs.js": { renderRunsList: renderRuns } });
    await vi.waitFor(() => expect(renderRuns).toHaveBeenCalledTimes(1));
    width(360);
    await fire("compact");
    expect(renderRuns).toHaveBeenCalledTimes(1);
  });

  it("keeps an open dialog on a crossing and redraws once after it closes (wide to narrow)", async () => {
    const renderUsers = page();
    await load("#/users", 1024, { "./users.js": { renderUsers } });
    await vi.waitFor(() => expect(renderUsers).toHaveBeenCalledTimes(1));
    dialogs = 1;
    width(360);
    await fire("compact");
    expect(renderUsers).toHaveBeenCalledTimes(1);
    await closeDialog();
    expect(renderUsers).toHaveBeenCalledTimes(2);
    expect(renderUsers.mock.calls[1]![1].readOnly).toBe(true);
  });

  it("keeps an open dialog on a crossing and redraws once after it closes (narrow to wide)", async () => {
    const renderUsers = page();
    await load("#/users", 360, { "./users.js": { renderUsers } });
    await vi.waitFor(() => expect(renderUsers).toHaveBeenCalledTimes(1));
    dialogs = 1;
    width(1024);
    await fire("wide");
    expect(renderUsers).toHaveBeenCalledTimes(1);
    await closeDialog();
    expect(renderUsers).toHaveBeenCalledTimes(2);
    expect(renderUsers.mock.calls[1]![1].readOnly).toBe(false);
  });

  it("draws nothing when the width crosses and returns while a dialog is open", async () => {
    const renderUsers = page();
    await load("#/users", 1024, { "./users.js": { renderUsers } });
    await vi.waitFor(() => expect(renderUsers).toHaveBeenCalledTimes(1));
    dialogs = 1;
    width(360);
    await fire("compact");
    width(1024);
    await fire("compact");
    await closeDialog();
    expect(renderUsers).toHaveBeenCalledTimes(1);
  });

  it("redraws a task after the dialog closes, so the action's own follow-up runs first", () => {
    expect(readFileSync("ui/app.js", "utf8")).toContain("setTimeout(onWidth, 0)");
  });

  it("passes readOnly to Watchers, one watcher and the Overview", async () => {
    const renderWatchers = page();
    await load("#/watchers", 360, { "./watchers.js": { renderWatchers } });
    await vi.waitFor(() => expect(renderWatchers).toHaveBeenCalledTimes(1));
    expect(renderWatchers.mock.calls[0]![1].readOnly).toBe(true);
    expect(note().hidden).toBe(false);
    expect(note().textContent).toBe("Editing needs a wider screen (768 px or more).");
    const renderWatcherDetail = page();
    await load("#/watchers/w1", 360, { "./watchers.js": { renderWatcherDetail } });
    await vi.waitFor(() => expect(renderWatcherDetail).toHaveBeenCalledTimes(1));
    expect(renderWatcherDetail.mock.calls[0]![2].readOnly).toBe(true);
    expect(note().hidden).toBe(false);
    const renderOperations = vi.fn(async () => () => {});
    await load("#/operations", 360, { "./operations.js": { renderOperations } });
    await vi.waitFor(() => expect(renderOperations).toHaveBeenCalledTimes(1));
    expect((renderOperations.mock.calls[0] as any[])[1].readOnly).toBe(true);
    expect(note().hidden).toBe(false);
    const wide = page();
    await load("#/watchers", 768, { "./watchers.js": { renderWatchers: wide } });
    await vi.waitFor(() => expect(wide).toHaveBeenCalledTimes(1));
    expect(wide.mock.calls[0]![1].readOnly).toBe(false);
    expect(note().hidden).toBe(true);
  });

  it("redraws Watchers read-only on a crossing", async () => {
    const renderWatchers = page();
    await load("#/watchers", 1024, { "./watchers.js": { renderWatchers } });
    await vi.waitFor(() => expect(renderWatchers).toHaveBeenCalledTimes(1));
    width(360);
    await fire("compact");
    await vi.waitFor(() => expect(renderWatchers).toHaveBeenCalledTimes(2));
    expect(renderWatchers.mock.calls[1]![1].readOnly).toBe(true);
  });

  it("keeps NOT_YET to the six pages not wired yet", () => {
    const src = readFileSync("ui/app.js", "utf8");
    const ids = [...src.match(/const NOT_YET = new Set\(\[([^\]]*)\]/)![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...ids].sort()).toEqual(["all-repos", "maintenance", "model", "models", "problem", "problems"]);
    const known = real.ia.PAGES.map((p: { id: string }) => p.id);
    for (const id of ids) expect(known).toContain(id);
  });
});
