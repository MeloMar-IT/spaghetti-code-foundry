import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/home-admin.js" as string);
});
afterAll(() => restore());

const realFetch = globalThis.fetch;
let answers: Record<string, any>;
let log: string[];
let sent: { method: string; path: string; body?: string }[];
beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  answers = {};
  sent = [];
  (globalThis as any).fetch = async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.split("?")[0]!;
    log.push(path);
    if (init?.method && init.method !== "GET") sent.push({ method: init.method, path, body: init.body });
    const a = typeof answers[path] === "function" ? answers[path]() : answers[path];
    if (a instanceof Error) return { ok: false, status: 500, statusText: "x", json: async () => ({ error: a.message }) };
    return { ok: true, status: 200, statusText: "OK", json: async () => a ?? {} };
  };
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const iso = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();
const run = (id: string, kind: any, over: any = {}) => ({
  runId: id, flow: `flow-${id}`, task: `task ${id}`, status: "running", startedAt: iso(10), vars: {}, history: [], next: nextStep(kind, { runId: id }), ...over,
});
const turnItem = (next: any) => ({ key: "k1", repo: "o/a", what: "Five", next, since: iso(5), unblocks: 0, dismissable: true });
const turn = (items: any[], extra: any = {}) => ({ count: items.length, groups: items.length ? [{ repo: "o/a", items }] : [], dismissed: 0, ...(items.length ? {} : { empty: "Nothing needs you." }), ...extra });
const set = (o: { turn?: any; runs?: any; queue?: any; health?: any; clarity?: any }) => {
  answers["/api/your-turn"] = o.turn ?? turn([]);
  answers["/api/runs"] = o.runs ?? [];
  answers["/api/queue"] = o.queue ?? { pending: [], active: [] };
  answers["/api/health"] = o.health ?? { ok: true, summary: "All good", problems: [] };
  if (o.clarity) answers["/api/clarity"] = o.clarity;
};
const open = async (since: FakeElement | null = null) => {
  const main = new FakeElement("main");
  const off = await ui.renderAdminHome(main, { since });
  await flush();
  return { main, off };
};
const h2 = (root: FakeElement) => root.all("h2").map((e) => e.textContent);

describe("renderAdminHome", () => {
  it("draws Needs you from Your turn with its count, and the item's button", async () => {
    const next = nextStep("approval", { repo: "o/a", issue: 5, runId: "r9" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5" });
    set({ turn: turn([turnItem(next)]) });
    const { main, off } = await open();
    expect(h2(main)).toContain("Needs you (1)");
    expect(main.all("h1").map((e) => e.textContent)).toEqual(["Home"]);
    expect(main.textContent).toContain("1 needs you");
    expect(main.all("a").some((a) => a.attrs.class?.includes("btn"))).toBe(true);
    off();
  });

  it("Dismiss offers Undo, which restores only that item and draws it again in Needs you", async () => {
    const next = nextStep("approval", { repo: "o/a", issue: 5, runId: "r9" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5" });
    const item = turnItem(next);
    set({ turn: turn([item]) });
    answers["/api/your-turn/dismiss"] = turn([], { dismissed: 1 });
    const { main, off } = await open();
    const toastEl = document.getElementById("toast") as unknown as FakeElement;
    toastEl.textContent = "";
    main.all("button").find((b) => b.textContent === "Dismiss")!.click();
    await flush();
    expect(sent).toEqual([{ method: "POST", path: "/api/your-turn/dismiss", body: JSON.stringify({ key: "k1" }) }]);
    expect(h2(main)).not.toContain("Needs you (1)");
    answers["/api/your-turn/restore"] = turn([item]);
    toastEl.all("button").find((b) => b.textContent === "Undo")!.click();
    await flush();
    expect(sent[1]).toEqual({ method: "POST", path: "/api/your-turn/restore", body: JSON.stringify({ key: "k1" }) });
    expect(h2(main)).toContain("Needs you (1)");
    off();
  });

  it("shows the empty text of Your turn and the Start work action when the count is 0", async () => {
    set({ runs: [run("d", "done", { finishedAt: iso(1) })] });
    const { main, off } = await open();
    expect(main.textContent).toContain("Nothing needs you.");
    expect(main.all("a").filter((a) => a.attrs.class?.includes("primary")).map((a) => a.attrs.href)).toEqual(["#/start"]);
    off();
  });

  it("with nothing at all, shows the empty state text once", async () => {
    set({});
    const { main, off } = await open();
    expect(main.textContent).toContain("Nothing here yet. Start work to begin.");
    off();
  });

  it("a turn refresh updates the head action", async () => {
    set({ runs: [run("a", "running")] });
    const { main, off } = await open();
    expect(main.all("a").some((a) => a.textContent === "Follow")).toBe(true);
    answers["/api/your-turn"] = turn([turnItem(nextStep("approval", { repo: "o/a", issue: 5, runId: "r9" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5" }))]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(main.textContent).toContain("1 needs you · 1 active");
    expect(main.all("a").some((a) => a.textContent === "Follow")).toBe(false);
    off();
  });

  it("draws Active and Recently completed from runs and the queue, with the owner", async () => {
    set({
      runs: [run("a", "running", { ownerName: "Ann" }), run("d", "done", { finishedAt: iso(1), ownerName: "Bob" })],
      queue: { pending: [{ runId: "j", kind: "run", enqueuedAt: iso(2), task: "queued job", ahead: 0, next: nextStep("queued", { runId: "j" }) }] },
    });
    const { main, off } = await open();
    expect(h2(main)).toContain("Active (2)");
    expect(main.textContent).toContain("task a");
    expect(main.textContent).toContain("queued job");
    expect(main.textContent).toContain("Owner: Ann");
    expect(main.all("summary").map((s) => s.textContent)).toContain("Recently completed (1)");
    off();
  });

  it("lists health problems under Problems, without the ones Your turn already shows", async () => {
    const shown = nextStep("failed", { repo: "o/a", issue: 5, runId: "r9" });
    const other = nextStep("watcher_error", { repo: "o/b" }, { error: "cannot reach" } as any);
    set({
      turn: turn([turnItem(shown)]),
      runs: [run("a", "running")],
      health: { ok: false, summary: "2 problems", problems: [shown, other], skillProblems: [{ root: "r", reason: "bad skill" }], monitorFindings: { open: 2 } },
    });
    const { main, off } = await open();
    expect(h2(main)).toContain("Problems");
    const problems = main.all("section").find((s) => s.all("h2")[0]?.textContent === "Problems")!;
    expect(problems.all("li")).toHaveLength(2); // the other record and the skill problem
    expect(problems.textContent).toContain("bad skill");
    expect(problems.all("a").some((a) => a.attrs.href === "#/problems")).toBe(true);
    expect(main.textContent).toContain("1 needs you · 1 active · 3 problems"); // the shown failure is not counted twice
    off();
  });

  it("has no Problems section when health is fine", async () => {
    set({ runs: [run("a", "running")] });
    const { main, off } = await open();
    expect(h2(main)).not.toContain("Problems");
    off();
  });

  it("a health-only problem is not an empty page", async () => {
    set({ health: { ok: false, summary: "1 problem", problems: [nextStep("watcher_error", { repo: "o/b" }, { error: "x" } as any)] } });
    const { main, off } = await open();
    expect(main.textContent).not.toContain("Nothing here yet");
    expect(h2(main)).toContain("Problems");
    off();
  });

  it("still draws when health fails", async () => {
    set({ runs: [run("a", "running")] });
    answers["/api/health"] = new Error("down");
    const { main, off } = await open();
    expect(main.textContent).toContain("task a");
    off();
  });

  it("keeps Needs you when runs fail, and does not claim the page is empty", async () => {
    set({});
    answers["/api/runs"] = new Error("down");
    const { main, off } = await open();
    expect(h2(main)).toContain("Needs you");
    expect(main.textContent).not.toContain("Nothing here yet");
    off();
  });

  it("loads the metrics only when opened, and only once", async () => {
    set({ clarity: { sampled: false } });
    const { main, off } = await open();
    expect(log).not.toContain("/api/clarity");
    const d = main.all("details").find((x) => x.all("summary")[0]?.textContent === "Metrics")!;
    d.fire("toggle"); // closed: nothing
    await flush();
    expect(log).not.toContain("/api/clarity");
    d.setAttribute("open", "");
    d.fire("toggle");
    d.fire("toggle");
    await flush();
    expect(log.filter((p) => p === "/api/clarity")).toHaveLength(1);
    expect(d.textContent).toContain("Your turn in numbers");
    expect(d.all("a").some((a) => a.attrs.href === "#/dashboard")).toBe(true);
    off();
  });

  it("places the since element under Active, inside the page", async () => {
    set({ runs: [run("a", "running")] });
    const since = new FakeElement("div");
    const { main, off } = await open(since);
    const top = main.children[0] as FakeElement; // the page box
    const kids = top.children as FakeElement[];
    expect(kids.indexOf(since)).toBeGreaterThan(-1);
    off();
  });

  it("shows an active run that is not in the runs list", async () => {
    set({ queue: { pending: [], active: [{ runId: "old" }] } });
    answers["/api/runs/old"] = run("old", "running");
    const { main, off } = await open();
    expect(main.textContent).toContain("task old");
    expect(main.textContent).not.toContain("Nothing here yet");
    off();
  });

  it("a Foundry failure in Your turn is not listed again under Problems, whatever its text", async () => {
    const full = nextStep("failed", { runId: "r1", repo: "o/a", issue: 5, cause: "factory", failure: "secret path" } as any);
    const brief = { ...full, text: "The Foundry failed, not the code.", why: "The Foundry failed, not the code", title: "" };
    set({ turn: turn([turnItem(full)]), health: { ok: false, summary: "1 problem", problems: [brief] } });
    const { main, off } = await open();
    expect(h2(main)).not.toContain("Problems");
    expect(main.textContent).toContain("1 needs you");
    expect(main.textContent).not.toContain("1 problem");
    off();
  });

  it("counts skill problems that the server cut off and says so", async () => {
    set({ health: { ok: false, summary: "x", problems: [], skillProblems: [{ root: "r", reason: "bad" }], skillProblemsMore: 3 } });
    const { main, off } = await open();
    expect(main.textContent).toContain("4 problems");
    expect(main.textContent).toContain("3 more skill problems not shown");
    off();
  });

  it("Your turn failing leaves Active on the page", async () => {
    set({ runs: [run("a", "running")] });
    answers["/api/your-turn"] = new Error("down");
    const { main, off } = await open();
    expect(main.textContent).toContain("Could not load what needs you");
    expect(main.textContent).toContain("task a");
    off();
  });

  it("runs failing leaves Needs you and offers no Start work", async () => {
    set({});
    answers["/api/runs"] = new Error("down");
    const { main, off } = await open();
    expect(main.textContent).toContain("Active work could not be loaded");
    expect(main.all("a").some((a) => a.attrs.href === "#/start")).toBe(false);
    off();
  });

  it("cleanup stops both timers", async () => {
    set({ runs: [run("a", "running")] });
    const { off } = await open();
    off();
    log.length = 0;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log).toEqual([]);
  });

  it("an answer that comes after cleanup draws nothing", async () => {
    set({ runs: [run("a", "running")] });
    const { main, off } = await open();
    let release!: (v: any) => void;
    answers["/api/runs"] = () => new Promise((r) => { release = r; });
    // the refresh call is out, but its body only ends when released
    (globalThis as any).fetch = async (url: string) => {
      const body = url.startsWith("/api/runs") ? await new Promise((r) => { release = r; }) : (answers[url.split("?")[0]!] ?? {});
      return { ok: true, status: 200, statusText: "OK", json: async () => body };
    };
    await vi.advanceTimersByTimeAsync(30_000);
    off();
    release([run("late", "running")]);
    await flush();
    expect(main.textContent).not.toContain("task late");
  });
});
