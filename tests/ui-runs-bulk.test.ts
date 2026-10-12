import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// The Archived view and bulk archive on the admin Runs list and on My runs. Fake DOM, fake fetch, fake timers.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let runs: any;
let mine: any;
let rf: any;
beforeAll(async () => {
  restore = installFakeDom();
  rf = await import("../ui/runs-filter.js" as string);
  runs = await import("../ui/runs.js" as string);
  mine = await import("../ui/user/runs.js" as string);
});
afterAll(() => restore());

const doc = () => (globalThis as any).document;
const rec = (who: string) => ({ who, kind: "running", status: "s", text: "t", help: "h" });
let seq = 0;
const mk = (id: string, over: Record<string, unknown> = {}) => ({
  runId: id, flow: `flow-${id}`, status: "succeeded", startedAt: new Date(Date.UTC(2026, 9, 1, 10, 0, 60 - ++seq)).toISOString(), history: [], totalCostUsd: 0,
  task: `task ${id}`, vars: { github_repo: "acme/app", issue: "7" }, next: rec("Foundry"), ...over,
});
const walk = (el: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  for (const c of el.children) if (c instanceof FakeElement) { out.push(c); walk(c, out); }
  return out;
};
const named = (m: FakeElement, name: string) => walk(m).find((e) => e.attrs["data-focus"] === name)!;
const heads = (m: FakeElement) => m.all("h2").map((x) => x.textContent);
const titles = (m: FakeElement) => m.all("li").map((r) => r.all("b")[0]!.textContent);
const tick = (n: boolean, el: FakeElement) => { el.checked = n; el.fire("change", { target: el }); };
const toastText = () => doc().getElementById("toast").textContent as string;
const connected = () => {
  const m = new FakeElement("div") as FakeElement & { isConnected: boolean };
  m.isConnected = true;
  return m;
};
const bar = (m: FakeElement) => walk(m).find((e) => e.attrs["aria-label"] === "Selected runs")!;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => { vi.useFakeTimers(); doc().getElementById("toast").replaceChildren(); doc().activeElement = null; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("the admin Runs list", () => {
  const realFetch = globalThis.fetch;
  let asked: string[];
  let answers: Record<string, unknown>;
  let refuse: Record<string, string>;
  let gate: Promise<void> | null;
  beforeEach(() => {
    asked = [];
    refuse = {};
    gate = null;
    answers = {
      "/api/runs": [mk("r1"), mk("r2", { status: "failed" }), mk("r3", { status: "running" })],
      "/api/runs?archived=1": [mk("a1"), mk("a2", { next: rec("You") }), mk("a3", { vars: { github_repo: "other/x" } })],
      "/api/queue": { pending: [{ runId: "q1", kind: "run", githubRepo: "acme/app", ahead: 0 }], active: [], concurrency: 2 },
      "/api/run-owners": [],
      "/api/run-filters": { repos: [], flows: [] },
    };
    (globalThis as any).addEventListener = () => {};
    (globalThis as any).fetch = async (url: string, init?: any) => {
      const method = init?.method ?? "GET";
      asked.push(`${method} ${url}`);
      if (method === "POST") {
        if (gate) await gate;
        const id = url.split("/")[3]!;
        return refuse[id]
          ? { ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: refuse[id] }) }
          : { ok: true, status: 200, statusText: "OK", json: async () => ({}) };
      }
      return { ok: true, status: 200, statusText: "OK", json: async () => answers[url] ?? {} };
    };
  });
  afterEach(() => { globalThis.fetch = realFetch; delete (globalThis as any).addEventListener; });
  const posts = () => asked.filter((u) => u.startsWith("POST"));
  const gets = () => asked.filter((u) => u.startsWith("GET /api/runs"));
  const archivedFilter = (over: object = {}) => ({ ...rf.emptyFilter(), view: "archived", ...over });

  it("asks for the archived runs and draws one Archived section, newest first, with no queued jobs", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { filter: archivedFilter() });
    expect(gets()).toEqual(["GET /api/runs?archived=1"]);
    expect(heads(m)).toEqual(["Archived (3)"]);
    expect(titles(m)).toEqual(["flow-a1", "flow-a2", "flow-a3"]);
    expect(named(m, "runs-view-archived").attrs["aria-pressed"]).toBe("true");
    stop();
  });

  it("asks the server for a known repository and filters an unknown one in the browser", async () => {
    answers["/api/run-filters"] = { repos: ["acme/app"], flows: [] };
    answers["/api/runs?repo=acme%2Fapp&archived=1"] = [mk("a1")];
    const m = connected();
    const stop = await runs.renderRunsList(m, { filter: archivedFilter({ repo: "acme/app" }) });
    expect(gets()).toEqual(["GET /api/runs?repo=acme%2Fapp&archived=1"]);
    expect(heads(m)).toEqual(["Archived (1)"]);
    stop();
    answers["/api/run-filters"] = { repos: [], flows: [] };
    const n = connected();
    const stop2 = await runs.renderRunsList(n, { filter: archivedFilter({ repo: "other/x" }) });
    expect(titles(n)).toEqual(["flow-a3"]);
    const pick = named(n, "select-a3");
    tick(true, pick);
    expect(bar(n).textContent).toContain("1 selected");
    stop2();
  });

  it("narrows the Archived view with Only what needs me, in count, list and selection", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { filter: archivedFilter() });
    tick(true, named(m, "select-a1"));
    tick(true, named(m, "select-a2"));
    expect(bar(m).textContent).toContain("2 selected");
    const needs = named(m, "runs-needs");
    needs.checked = true;
    needs.fire("change", { target: needs });
    await flush();
    expect(heads(m)).toEqual(["Archived (1)"]);
    expect(titles(m)).toEqual(["flow-a2"]);
    expect(bar(m).textContent).toContain("1 selected");
    expect(walk(m).find((e) => e.attrs.role === "status" && e.textContent === "1 run matches.")).toBeDefined();
    stop();
  });

  it("archives the ticked runs one after the other after one question, then reloads", async () => {
    const m = connected();
    const ask = vi.fn(async () => true);
    const stop = await runs.renderRunsList(m, { ask });
    expect(heads(m)).toEqual(["Running (1)", "Queued (1)", "Failed (1)", "Completed (1)"]);
    expect(walk(m).some((e) => e.attrs["data-focus"] === "select-r3")).toBe(false);
    tick(true, named(m, "select-r1"));
    tick(true, named(m, "select-r2"));
    expect(bar(m).hidden).toBe(false);
    expect(named(m, "bulk-act").textContent).toBe("Archive 2 runs");
    const before = gets().length;
    named(m, "bulk-act").click();
    await flush();
    expect(ask).toHaveBeenCalledTimes(1);
    expect((ask.mock.calls[0] as any[])[1]).toBe("Archive 2 runs? They stay available under Archived.");
    expect(posts()).toEqual(["POST /api/runs/r1/archive", "POST /api/runs/r2/archive"]);
    expect(toastText()).toBe("Archived 2 runs.");
    expect(gets().length).toBeGreaterThan(before);
    expect(bar(m).hidden).toBe(true);
    stop();
  });

  it("names the refused runs in the toast", async () => {
    refuse.r2 = "Only a finished run can be archived.";
    const m = connected();
    const stop = await runs.renderRunsList(m, { ask: async () => true });
    tick(true, named(m, "select-r1"));
    tick(true, named(m, "select-r2"));
    named(m, "bulk-act").click();
    await flush();
    expect(toastText()).toBe("Archived 1 run. 1 was refused: Only a finished run can be archived.");
    stop();
  });

  it("starts nothing twice while the question or the batch is open", async () => {
    let yes!: (v: boolean) => void;
    const ask = vi.fn(() => new Promise<boolean>((r) => { yes = r; }));
    let release!: () => void;
    const m = connected();
    const stop = await runs.renderRunsList(m, { ask });
    tick(true, named(m, "select-r1"));
    tick(true, named(m, "select-r2"));
    named(m, "bulk-act").click();
    named(m, "bulk-act").click();
    named(m, "bulk-clear").click();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(named(m, "bulk-act").attrs["aria-disabled"]).toBe("true");
    expect(bar(m).textContent).toContain("2 selected");
    gate = new Promise<void>((r) => { release = r; });
    yes(true);
    await flush();
    named(m, "bulk-act").click();
    expect(posts()).toEqual(["POST /api/runs/r1/archive"]);
    release();
    await flush();
    expect(posts()).toEqual(["POST /api/runs/r1/archive", "POST /api/runs/r2/archive"]);
    expect(ask).toHaveBeenCalledTimes(1);
    stop();
  });

  it("says and draws nothing when the page is left during a batch", async () => {
    let release!: () => void;
    const m = connected();
    const stop = await runs.renderRunsList(m, { ask: async () => true });
    tick(true, named(m, "select-r1"));
    gate = new Promise<void>((r) => { release = r; });
    named(m, "bulk-act").click();
    await flush();
    expect(posts()).toHaveLength(1);
    const before = asked.length;
    stop();
    release();
    await flush();
    expect(toastText()).toBe("");
    expect(asked.length).toBe(before);
  });

  it("starts no request when the page is left while the question is open", async () => {
    let yes!: (v: boolean) => void;
    const m = connected();
    const stop = await runs.renderRunsList(m, { ask: () => new Promise<boolean>((r) => { yes = r; }) });
    tick(true, named(m, "select-r1"));
    named(m, "bulk-act").click();
    stop();
    yes(true);
    await flush();
    expect(posts()).toEqual([]);
    expect(toastText()).toBe("");
  });

  it("keeps the selection when the answer is no", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { ask: async () => false });
    tick(true, named(m, "select-r1"));
    named(m, "bulk-act").click();
    await flush();
    expect(posts()).toEqual([]);
    expect(bar(m).textContent).toContain("1 selected");
    expect(named(m, "bulk-act").attrs["aria-disabled"]).toBeUndefined();
    stop();
  });

  it("takes runs out of the archive without asking", async () => {
    const ask = vi.fn(async () => true);
    const m = connected();
    const stop = await runs.renderRunsList(m, { filter: archivedFilter(), ask });
    tick(true, named(m, "select-a1"));
    expect(named(m, "bulk-act").textContent).toBe("Take out of the archive");
    named(m, "bulk-act").click();
    await flush();
    expect(ask).not.toHaveBeenCalled();
    expect(posts()).toEqual(["POST /api/runs/a1/unarchive"]);
    expect(toastText()).toBe("Took 1 run out of the archive.");
    stop();
  });

  it("keeps the selection over a refresh and drops a run that is no longer in a selectable section", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { ask: async () => true });
    tick(true, named(m, "select-r1"));
    tick(true, named(m, "select-r2"));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bar(m).textContent).toContain("2 selected");
    expect(named(m, "select-r1").checked).toBe(true);
    answers["/api/runs"] = [mk("r1"), mk("r2", { status: "running" }), mk("r3", { status: "running" })];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bar(m).textContent).toContain("1 selected");
    expect(named(m, "select-r1").checked).toBe(true);
    stop();
  });

  it("keeps a selected Completed run that moves from the tenth to the eleventh place", async () => {
    const list = Array.from({ length: 10 }, (_, i) => mk(`c${i}`));
    answers["/api/runs"] = list;
    const m = connected();
    const stop = await runs.renderRunsList(m, {});
    tick(true, named(m, "select-c9"));
    answers["/api/runs"] = [mk("new", { startedAt: "2026-12-01T00:00:00Z" }), ...list];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(named(m, "select-c9")).toBeUndefined();
    expect(bar(m).textContent).toContain("1 selected");
    stop();
  });

  it("clears the selection when the view goes to or from Archived, not between other views", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { ask: async () => true });
    tick(true, named(m, "select-r2"));
    named(m, "runs-view-failed").click();
    await flush();
    expect(bar(m).textContent).toContain("1 selected");
    named(m, "runs-view-archived").click();
    expect(bar(m).hidden).toBe(true);
    await flush();
    expect(heads(m)).toEqual(["Archived (3)"]);
    tick(true, named(m, "select-a1"));
    named(m, "runs-view-all").click();
    expect(bar(m).hidden).toBe(true);
    await flush();
    expect(heads(m)).toContain("Failed (1)");
    stop();
  });

  it("clears the selection with Clear selection", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, {});
    tick(true, named(m, "select-r1"));
    named(m, "bulk-clear").click();
    expect(named(m, "select-r1").checked).toBe(false);
    expect(bar(m).hidden).toBe(true);
    stop();
  });
});

describe("My runs", () => {
  const api = (list: any[] = [mk("r1"), mk("r2", { status: "failed" }), mk("r3", { status: "running" })], archived: any[] = [mk("a1"), mk("a2", { next: rec("You") })]) => ({
    runs: vi.fn(async (q?: any) => (q?.archived ? archived : list)),
    queue: async () => ({ pending: [] }),
    runFilters: async () => ({ repos: [], flows: [] }),
    archiveRun: vi.fn(async (_id: string): Promise<object> => ({})),
    unarchiveRun: vi.fn(async (_id: string): Promise<object> => ({})),
    cancelRun: vi.fn(async () => ({})),
  });
  const view = (v = "") => ({ ...rf.emptyFilter(), view: v });

  it("has checkboxes on finished runs only, and none in the read-only preview", async () => {
    const a = api();
    const m = connected();
    const stop = await mine.renderMyRuns(m, { a, ask: async () => true });
    expect(walk(m).filter((e) => e.attrs.class === "run-select" && !e.attrs["data-focus"]!.startsWith("select-all")).map((e) => e.attrs["data-focus"]).sort()).toEqual(["select-r1", "select-r2"]);
    expect(named(m, "select-r1").attrs["aria-label"]).toBe("Select run flow-r1 acme/app#7");
    stop();
    const ro = connected();
    const stopRo = await mine.renderMyRuns(ro, { a, readOnly: true });
    expect(walk(ro).some((e) => e.attrs.class === "run-select" && !e.attrs["data-focus"]!.startsWith("select-all"))).toBe(false);
    expect(bar(ro).hidden).toBe(true);
    stopRo();
  });

  it("asks once, archives, tells the result and reloads", async () => {
    const a = api();
    const ask = vi.fn(async () => true);
    const m = connected();
    const stop = await mine.renderMyRuns(m, { a, ask });
    tick(true, named(m, "select-r1"));
    expect(named(m, "bulk-act").textContent).toBe("Archive 1 run");
    const before = a.runs.mock.calls.length;
    named(m, "bulk-act").click();
    await flush();
    expect((ask.mock.calls[0] as any[])[1]).toBe("Archive 1 run? It stays available under Archived.");
    expect(a.archiveRun).toHaveBeenCalledWith("r1");
    expect(toastText()).toBe("Archived 1 run.");
    expect(a.runs.mock.calls.length).toBeGreaterThan(before);
    expect(bar(m).hidden).toBe(true);
    stop();
  });

  it("does not draw an answer while the question is open and ignores a second click", async () => {
    const a = api();
    let yes!: (v: boolean) => void;
    const ask = vi.fn(() => new Promise<boolean>((r) => { yes = r; }));
    const m = connected();
    const stop = await mine.renderMyRuns(m, { a, ask });
    tick(true, named(m, "select-r1"));
    named(m, "bulk-act").click();
    named(m, "bulk-act").click();
    expect(ask).toHaveBeenCalledTimes(1);
    a.runs.mockImplementation(async () => [mk("r1", { task: "changed task" })]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(m.textContent).not.toContain("changed task");
    yes(false);
    await flush();
    expect(a.archiveRun).not.toHaveBeenCalled();
    expect(bar(m).textContent).toContain("1 selected");
    stop();
  });

  it("toasts nothing when it is left during the batch", async () => {
    const a = api();
    let release!: () => void;
    a.archiveRun.mockImplementation(() => new Promise<any>((r) => { release = () => r({}); }));
    const m = connected();
    const stop = await mine.renderMyRuns(m, { a, ask: async () => true });
    tick(true, named(m, "select-r1"));
    named(m, "bulk-act").click();
    await flush();
    stop();
    release();
    await flush();
    expect(toastText()).toBe("");
  });

  it("names a refusal in the toast", async () => {
    const a = api();
    a.archiveRun.mockImplementation(async (id: string) => { if (id === "r2") throw new Error("Busy."); return {}; });
    const m = connected();
    const stop = await mine.renderMyRuns(m, { a, ask: async () => true });
    tick(true, named(m, "select-r1"));
    tick(true, named(m, "select-r2"));
    named(m, "bulk-act").click();
    await flush();
    expect(toastText()).toBe("Archived 1 run. 1 was refused: Busy.");
    stop();
  });

  it("asks the server for the archived runs and does not title the old list Archived while that is out", async () => {
    const a = api();
    const m = connected();
    const stop = await mine.renderMyRuns(m, { a });
    expect(heads(m)).toEqual(["Running (1)", "Failed (1)", "Completed (1)"]);
    tick(true, named(m, "select-r1"));
    let release!: () => void;
    a.runs.mockImplementation(async (q?: any) => { await new Promise<void>((r) => { release = r; }); return q?.archived ? [mk("a1")] : []; });
    named(m, "runs-view-archived").click();
    expect(heads(m)).not.toContain("Archived (3)");
    expect(heads(m).some((t) => t.startsWith("Archived"))).toBe(false);
    expect(bar(m).hidden).toBe(true);
    release();
    await flush();
    expect(a.runs).toHaveBeenLastCalledWith({ archived: "1" });
    expect(heads(m)).toEqual(["Archived (1)"]);
    stop();
  });

  it("takes out of the archive without asking, with needs and a repository filter applied", async () => {
    const a = api(undefined, [mk("a1"), mk("a2", { next: rec("You") }), mk("a3", { vars: { github_repo: "other/x" } })]);
    const ask = vi.fn(async () => true);
    const m = connected();
    const stop = await mine.renderMyRuns(m, { a, ask, filter: { ...view("archived"), needs: true } });
    expect(titles(m)).toEqual(["flow-a2"]);
    stop();
    const n = connected();
    const stop2 = await mine.renderMyRuns(n, { a, ask, filter: { ...view("archived"), repo: "other/x" } });
    expect(titles(n)).toEqual(["flow-a3"]);
    tick(true, named(n, "select-a3"));
    named(n, "bulk-act").click();
    await flush();
    expect(ask).not.toHaveBeenCalled();
    expect(a.unarchiveRun).toHaveBeenCalledWith("a3");
    expect(toastText()).toBe("Took 1 run out of the archive.");
    stop2();
  });
});
