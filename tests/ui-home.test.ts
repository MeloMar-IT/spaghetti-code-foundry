import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/home.js" as string);
});
afterAll(() => restore());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () => vi.advanceTimersByTimeAsync(0);
const iso = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();
const rec = (kind: any, runId = "r1", d: any = {}) => nextStep(kind, { runId }, d);
const run = (id: string, kind: any, over: any = {}, d: any = {}) => ({
  runId: id, flow: `flow-${id}`, task: `task ${id}\nsecond line`, status: "running", startedAt: iso(10), vars: {}, history: [], next: rec(kind, id, d), ...over,
});
const job = (id: string, over: any = {}) => ({ runId: id, kind: "run", enqueuedAt: iso(5), task: `queued ${id}`, ahead: 0, next: rec("queued", id), ...over });
const view = (nodes: any[]) => {
  const root = new FakeElement("div");
  root.append(...nodes.filter(Boolean));
  return root;
};
const text = (nodes: any[]) => view(nodes).textContent;
const links = (root: FakeElement) => root.all("a");

describe("homeModel", () => {
  it("groups by the next-step record, not by the status", () => {
    const m = ui.homeModel([
      run("need", "approval"),
      run("wrong", "failed", { status: "failed" }),
      run("go", "running"),
      run("wait", "dependency", { status: "waiting" }, { blockers: [] }),
      run("rel", "release", { status: "succeeded" }), // succeeded, but a release waits for the person
      run("limit", "daily_budget", { status: "waiting" }),
      run("done", "done", { status: "succeeded", finishedAt: iso(1) }),
      run("old", "done", { status: "succeeded", finishedAt: iso(50) }),
      run("cx", "cancelled", { status: "cancelled" }),
      run("sup", "superseded"),
      run("closed", "issue_closed"),
      { runId: "legacy", flow: "f", startedAt: iso(3), status: "succeeded" },
    ], [job("j")]);
    const ids = (l: any[]) => l.map((e) => e.run?.runId ?? `job:${e.job.runId}`).sort();
    expect(ids(m.needs)).toEqual(["need", "rel", "wrong"]);
    expect(m.problems).toEqual([]);
    expect(ids(m.active)).toEqual(["go", "job:j", "limit", "wait"]);
    expect(m.recent.map((e: any) => e.run.runId)).toEqual(["done", "old"]);
    expect(m.total).toBe(12); // the legacy run has no record and is in no list
  });

  it("handles bad input", () => {
    expect(ui.homeModel(null, "x")).toEqual({ needs: [], problems: [], active: [], recent: [], total: 0 });
    expect(ui.homeModel({}, undefined).total).toBe(0);
  });

  it("needsUser follows the server rule", () => {
    expect(ui.needsUser(rec("approval"))).toBe(true);
    expect(ui.needsUser(rec("failed"))).toBe(true);
    expect(ui.needsUser(rec("cancelled"))).toBe(false);
    expect(ui.needsUser(rec("running"))).toBe(false);
    expect(ui.needsUser(undefined)).toBe(false);
  });
});

describe("recordLink", () => {
  const n = (url: string, label = "Open it") => ({ ...rec("approval"), where: { label, url } });
  it("keeps an external https address and a run address", () => {
    expect(ui.recordLink(n("https://github.com/o/r/pull/1"), "user", "r1")).toMatchObject({ href: "https://github.com/o/r/pull/1", external: true });
    expect(ui.recordLink(n("#/runs/x"), "user", "r1")).toMatchObject({ href: "#/runs/x", external: false });
    expect(ui.recordLink(n("#/runs/x"), "admin", "r1")).toMatchObject({ href: "#/runs/x" });
  });
  it("gives a user only pages the user display has", () => {
    expect(ui.recordLink(n("#/board"), "user", "r1")).toMatchObject({ href: "#/runs/r1" });
    expect(ui.recordLink(n("#/board"), "admin", "r1")).toMatchObject({ href: "#/board" });
  });
  it("never uses a javascript: address and gives undefined without a run", () => {
    expect(ui.recordLink(n("javascript:alert(1)"), "user", "r1")).toMatchObject({ href: "#/runs/r1" });
    expect(ui.recordLink(n("javascript:alert(1)"), "user")).toBeUndefined();
  });
});

describe("bestAction and countsText", () => {
  const first = { ...rec("approval"), runId: "r1", where: { label: "Review", url: "#/runs/r1" } };
  const a = { run: run("a", "running") };
  it("picks need, then problem, then active, then Start work", () => {
    expect(ui.bestAction({ first, problems: [first], active: [a] }, "user")).toMatchObject({ href: "#/runs/r1", label: "Review", primary: false });
    const p = { ...rec("failed", "p1"), runId: "p1", where: { label: "See", url: "#/runs/p1" } };
    expect(ui.bestAction({ problems: [p], active: [a] }, "admin")).toMatchObject({ href: "#/runs/p1", primary: false });
    expect(ui.bestAction({ active: [a] }, "user")).toMatchObject({ href: "#/runs/a", label: "Follow", primary: false });
    expect(ui.bestAction({}, "user")).toMatchObject({ href: "#/start", label: "Start work", primary: true });
  });
  it("counts", () => {
    expect(ui.countsText({ needs: 1, active: 0, problems: 0 })).toBe("1 needs you");
    expect(ui.countsText({ needs: 2, active: 1, problems: 1 })).toBe("2 need you · 1 active · 1 problem");
    expect(ui.countsText({ needs: 0, active: 0, problems: 3 })).toBe("3 problems");
    expect(ui.countsText({ needs: 0, active: 0, problems: 0 })).toBe("");
  });
});

describe("workRow", () => {
  it("shows status, the first line of the task and the record's sentence, with one primary link", () => {
    const e = { run: run("a", "approval", { vars: { github_repo: "o/r", issue: "7" } }), job: null };
    const row = view([ui.workRow(e)]);
    expect(row.textContent).toContain("task a");
    expect(row.textContent).not.toContain("second line");
    expect(row.textContent).toContain(e.run.next.text);
    expect(row.textContent).toContain("o/r#7");
    expect(row.all("span").some((s) => s.attrs.class?.startsWith("pill"))).toBe(true);
    expect(links(row).filter((l) => l.attrs.class?.includes("primary"))).toHaveLength(1);
    expect(links(row).filter((l) => l.attrs.class?.includes("primary"))[0]!.attrs.href).toBeDefined();
  });
  it("has a Details link only when it differs from the primary link", () => {
    const same = { run: { ...run("a", "approval"), next: { ...rec("approval", "a"), where: { label: "Open", url: "#/runs/a" } } }, job: null };
    expect(links(view([ui.workRow(same)])).some((l) => l.textContent === "Details")).toBe(false);
    const other = { run: { ...run("a", "approval"), next: { ...rec("approval", "a"), where: { label: "PR", url: "https://github.com/o/r/pull/1" } } }, job: null };
    const l = links(view([ui.workRow(other)])).find((x) => x.textContent === "Details")!;
    expect(l.attrs.href).toBe("#/runs/a");
  });
  it("shows the owner only for the admin", () => {
    const e = { run: run("a", "running", { ownerName: "Ann" }), job: null };
    expect(text([ui.workRow(e)])).not.toContain("Ann");
    expect(text([ui.workRow(e, { owner: true, role: "admin" })])).toContain("Ann");
  });
  it("can draw a queued job with no run", () => {
    expect(text([ui.workRow({ run: null, job: job("j") })])).toContain("queued j");
  });
});

describe("homeView", () => {
  const model = (over: any = {}) => ({ needs: [], problems: [], active: [], recent: [], total: 1, ...over });
  const headings = (root: FakeElement) => root.all("h2").map((h) => h.textContent);

  it("orders head, Needs you, Active, and closes Recently completed", () => {
    const m = ui.homeModel([run("n", "approval"), run("a", "running"), run("d", "done", { finishedAt: iso(1) })], []);
    const root = view(ui.homeView(m));
    expect(root.all("h1")[0]!.textContent).toBe("Home");
    expect(headings(root)).toEqual(["Needs you (1)", "Active (1)"]);
    const d = root.all("details")[0]!;
    expect(d.all("summary")[0]!.textContent).toBe("Recently completed (1)");
    expect(root.textContent).toContain("1 needs you · 1 active");
    // one primary button at the top only when nothing needs the person
    expect(links(root).filter((l) => l.attrs.class?.includes("primary"))).toHaveLength(0);
  });

  it("shows no cost, model, owner or other-account text", () => {
    const m = ui.homeModel([run("a", "running", { totalCostUsd: 1.23, model: "opus-x", ownerName: "Ann" })], []);
    const t = text(ui.homeView(m));
    expect(t).not.toMatch(/\$|Owner|Ann|opus|cost/i);
  });

  it("caps a section and links to the full list", () => {
    const runs = Array.from({ length: 8 }, (_, i) => run(`r${i}`, "running", { startedAt: iso(i) }));
    const root = view(ui.homeView(ui.homeModel(runs, [])));
    expect(root.all("li").length).toBe(ui.SHOWN);
    const more = links(root).find((l) => l.textContent === "+3 more")!;
    expect(more.attrs.href).toBe("#/runs");
  });

  it("empty state: a start action and a link to repositories, no tiles or tables", () => {
    const root = view(ui.homeView(ui.homeModel([], [])));
    expect(root.textContent).toContain(ui.EMPTY);
    expect(links(root).find((l) => l.attrs.href === "#/start")!.attrs.class).toContain("primary");
    expect(links(root).some((l) => l.attrs.href === "#/repos")).toBe(true);
    expect(root.all("table")).toHaveLength(0);
    expect(JSON.stringify(root.all("div").map((d) => d.attrs.class))).not.toContain("tile");
  });

  it("all clear: says so and keeps Start work as the one primary action", () => {
    const root = view(ui.homeView(ui.homeModel([run("d", "done", { finishedAt: iso(1) })], [])));
    expect(root.textContent).toContain(ui.ALL_CLEAR);
    expect(root.textContent).toContain(ui.NOTHING_ACTIVE);
    expect(links(root).filter((l) => l.attrs.class?.includes("primary")).map((l) => l.attrs.href)).toEqual(["#/start"]);
  });

  it("every Tab stop has a unique data-focus", () => {
    const entries = (n: number, kind: any, over: any = {}) => Array.from({ length: n }, (_, i) => run(`${kind}${i}`, kind, { startedAt: iso(i), ...over }));
    const runs = [
      ...entries(7, "running"),
      { ...run("n", "approval"), next: { ...rec("approval", "n"), where: { label: "PR", url: "https://github.com/o/r/pull/1" } } },
      run("d", "done", { status: "succeeded", finishedAt: iso(1) }),
    ];
    const root = view(ui.homeView(ui.homeModel(runs, [job("j")]), { prompts: ["One", "Two"] }));
    const stops = [...root.all("a").filter((a) => a.attrs.href), ...root.all("button"), ...root.all("summary")];
    const names = stops.map((s) => s.attrs["data-focus"]);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    for (const want of ["home-action", "home-open-n", "home-more-active", "home-summary-recently-completed", "home-ask-0", "home-ask-1", "home-status-n"]) {
      expect(names.some((x) => x === want) || root.querySelectorAll("[data-focus]").some((e) => e.attrs["data-focus"] === want)).toBe(true);
    }
    const all = root.querySelectorAll("[data-focus]").map((e) => e.attrs["data-focus"]);
    expect(all.some((x) => x?.startsWith("home-details-"))).toBe(true);
    const empty = view(ui.homeView(ui.homeModel([], []))).querySelectorAll("[data-focus]").map((e) => e.attrs["data-focus"]);
    expect(empty).toEqual(expect.arrayContaining(["home-start", "home-repos"]));
  });

  it("a job without an id uses x", () => {
    const root = view([ui.workRow({ run: null, job: { ...job("j"), runId: undefined } })]);
    const all = root.querySelectorAll("[data-focus]").map((e) => e.attrs["data-focus"]);
    expect(all.some((x) => x?.endsWith("-x"))).toBe(true);
  });

  it("Ask section: last with prompts, absent without, click calls onAsk", () => {
    const m = ui.homeModel([run("a", "running")], []);
    expect(headings(view(ui.homeView(m)))).not.toContain("Ask SCF");
    const onAsk = vi.fn();
    const nodes = ui.homeView(m, { prompts: ["What needs me?"], onAsk });
    const root = view(nodes);
    expect(headings(root).at(-1)).toBe("Ask SCF");
    root.all("button").find((b) => b.textContent === "What needs me?")!.click();
    expect(onAsk).toHaveBeenCalledWith("What needs me?");
    expect(ui.askView([], onAsk)).toBeNull();
  });
});

describe("renderHome", () => {
  const api = (runs: any, queue: any = { pending: [] }) => ({
    runs: vi.fn(async () => runs),
    queue: vi.fn(async () => queue),
    health: () => { throw new Error("health must not be called"); },
    clarity: () => { throw new Error("clarity must not be called"); },
    yourTurn: () => { throw new Error("yourTurn must not be called"); },
  });

  it("calls only runs and queue, and refreshes every 30 seconds", async () => {
    const a = api([run("a", "running")]);
    const main = new FakeElement("main");
    const off = await ui.renderHome(main, { a });
    expect(main.textContent).toContain("task a");
    expect(a.runs).toHaveBeenCalledTimes(1);
    a.runs.mockResolvedValue([run("b", "approval")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(main.textContent).toContain("task b");
    off();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(a.runs).toHaveBeenCalledTimes(2);
  });

  it("one request at a time: a tick during a slow load sends no second request, then one follow-up", async () => {
    let slow!: (v: any) => void;
    const a = api([run("a", "running")]);
    const main = new FakeElement("main");
    const off = await ui.renderHome(main, { a });
    a.runs.mockImplementationOnce(() => new Promise((r) => { slow = r; }));
    await vi.advanceTimersByTimeAsync(30_000); // starts the slow load
    expect(a.runs).toHaveBeenCalledTimes(2);
    a.runs.mockResolvedValue([run("new", "running")]);
    await vi.advanceTimersByTimeAsync(30_000); // a tick during the flight
    expect(a.runs).toHaveBeenCalledTimes(2);
    slow([run("old", "running")]);
    await flush();
    expect(a.runs).toHaveBeenCalledTimes(3);
    expect(main.textContent).toContain("task new");
    off();
  });

  it("a first-load failure resolves with a cleanup, shows the error with Retry, and Retry draws", async () => {
    const a = api([run("a", "running")]);
    a.runs.mockRejectedValueOnce(new Error("down"));
    const main = new FakeElement("main");
    const off = await ui.renderHome(main, { a });
    expect(typeof off).toBe("function");
    expect(main.textContent).toContain("Home could not be loaded.");
    const retry = main.querySelectorAll("button").find((b) => b.attrs["data-focus"] === "home-retry")!;
    expect(retry.textContent).toBe("Retry");
    retry.click();
    await flush();
    expect(main.textContent).toContain("task a");
    expect(main.textContent).not.toContain("Home could not be loaded.");
    off();
  });

  it("a refresh failure keeps the page and shows one banner with Retry", async () => {
    const a = api([run("a", "running")]);
    const main = new FakeElement("main");
    const off = await ui.renderHome(main, { a });
    a.runs.mockRejectedValue(new Error("down"));
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(main.textContent).toContain("task a");
    expect(main.querySelectorAll("button").filter((b) => b.attrs["data-focus"] === "home-refresh-retry")).toHaveLength(1);
    off();
  });

  it("shows a skeleton with a hidden label before the first answer, and an Updated note after it", async () => {
    let first!: (v: any) => void;
    const a = api([run("a", "running")]);
    a.runs.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    const main = new FakeElement("main");
    const p = ui.renderHome(main, { a });
    await flush();
    expect(main.all("div").some((d) => d.attrs.class?.startsWith("skeleton"))).toBe(true);
    expect(main.textContent).toContain("Loading Home");
    first([run("a", "running")]);
    const off = await p;
    expect(main.all("div").some((d) => d.attrs.class?.startsWith("skeleton"))).toBe(false);
    expect(main.textContent).toContain("Updated");
    off();
  });

  it("a hidden tab makes no request", async () => {
    const a = api([run("a", "running")]);
    (document as any).visibilityState = "hidden";
    try {
      const off = await ui.renderHome(new FakeElement("main"), { a });
      await vi.advanceTimersByTimeAsync(90_000);
      expect(a.runs).not.toHaveBeenCalled();
      off();
    } finally {
      (document as any).visibilityState = "visible";
    }
  });

  it("keeps the scroll position across a redraw", async () => {
    const a = api([run("a", "running")]);
    const main = new FakeElement("main");
    const off = await ui.renderHome(main, { a });
    const box = main.children[0] as FakeElement;
    const root = (document as any).documentElement;
    root.scrollTop = 120;
    const real = box.replaceChildren.bind(box);
    box.replaceChildren = (...nodes: any[]) => { root.scrollTop = 0; real(...nodes); };
    a.runs.mockResolvedValue([run("b", "running")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(main.textContent).toContain("task b");
    expect(root.scrollTop).toBe(120);
    root.scrollTop = 0;
    off();
  });

  it("shows an active run that is beyond the list limit, fetched by id", async () => {
    const a: any = { ...api([run("a", "done", { finishedAt: iso(1) })], { pending: [], active: [{ runId: "old" }, { runId: "a" }, { runId: "gone" }] }),
      run: vi.fn(async (id: string) => { if (id === "gone") throw new Error("404"); return run(id, "running"); }) };
    const main = new FakeElement("main");
    const off = await ui.renderHome(main, { a });
    expect(a.run.mock.calls.map((c: any) => c[0]).sort()).toEqual(["gone", "old"]);
    expect(main.textContent).toContain("task old");
    expect(main.textContent).not.toContain("Nothing here yet");
    off();
  });

  it("a late answer after cleanup draws nothing", async () => {
    let late!: (v: any) => void;
    const a = api([run("a", "running")]);
    const main = new FakeElement("main");
    const off = await ui.renderHome(main, { a });
    a.runs.mockImplementationOnce(() => new Promise((r) => { late = r; }));
    await vi.advanceTimersByTimeAsync(30_000);
    off();
    late([run("zzz", "running")]);
    await flush();
    expect(main.textContent).not.toContain("task zzz");
  });
});
