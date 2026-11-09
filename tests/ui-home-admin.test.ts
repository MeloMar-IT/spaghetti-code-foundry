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
  (document as any).visibilityState = "visible";
  (document as any).activeElement = null;
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
  (document as any).visibilityState = "visible";
  (document as any).activeElement = null;
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
const named = (root: FakeElement, name: string) => root.all("button").filter((b) => b.attrs["data-focus"] === name);
const STALE = "Problems could not be refreshed. Showing the last answer.";
const status = (root: FakeElement) => root.all("p").filter((p) => p.attrs.role === "status");
const approval = () => nextStep("approval", { repo: "o/a", issue: 5, runId: "r9" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5" });

describe("renderAdminHome", () => {
  it("draws Your turn from the server's answer with its count, and the item's button", async () => {
    const next = nextStep("approval", { repo: "o/a", issue: 5, runId: "r9" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5" });
    set({ turn: turn([turnItem(next)]) });
    const { main, off } = await open();
    expect(h2(main)).toContain("Your turn (1)");
    expect(main.all("h1").map((e) => e.textContent)).toEqual([expect.stringMatching(/^Good /)]);
    expect(main.textContent).toContain("1 thing needs you");
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
    expect(h2(main)).not.toContain("Your turn (1)");
    answers["/api/your-turn/restore"] = turn([item]);
    toastEl.all("button").find((b) => b.textContent === "Undo")!.click();
    await flush();
    expect(sent[1]).toEqual({ method: "POST", path: "/api/your-turn/restore", body: JSON.stringify({ key: "k1" }) });
    expect(h2(main)).toContain("Your turn (1)");
    off();
  });

  it("shows the empty text of Your turn and no first steps when there is work", async () => {
    set({ runs: [run("d", "done", { finishedAt: iso(1) })] });
    const { main, off } = await open();
    expect(main.textContent).toContain("Nothing needs you.");
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toMatch(/^Nothing needs you/);
    expect(main.all("a").filter((a) => a.attrs.class?.includes("primary"))).toEqual([]);
    off();
  });

  it("with nothing at all, shows the empty state text once, inside the whole Today layout", async () => {
    set({});
    const { main, off } = await open();
    expect(main.textContent).toContain("Nothing here yet. Start work to begin.");
    expect(main.textContent.split("Nothing here yet. Start work to begin.")).toHaveLength(2);
    expect(h2(main)).toEqual(expect.arrayContaining(["Building now", "Finished recently"]));
    expect(main.all("nav")[0]!.all("a")).toHaveLength(4);
    off();
  });

  it("a turn refresh updates the summary", async () => {
    set({ runs: [run("a", "running")] });
    const { main, off } = await open();
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("Nothing needs you, 1 change is being built");
    answers["/api/your-turn"] = turn([turnItem(nextStep("approval", { repo: "o/a", issue: 5, runId: "r9" }, { watched: true, issueUrl: "https://github.com/o/a/issues/5" }))]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("1 thing needs you, 1 change is being built");
    off();
  });

  it("draws Today from the runs and the queue, in the order Today, Your turn, Since, Problems, Metrics", async () => {
    set({
      turn: turn([turnItem(approval())]),
      runs: [run("a", "running", { ownerName: "Ann" }), run("d", "done", { finishedAt: new Date().toISOString(), ownerName: "Bob" })],
      queue: { pending: [{ runId: "j", kind: "run", enqueuedAt: iso(2), task: "queued job", ahead: 0, next: nextStep("queued", { runId: "j" }) }] },
      health: { ok: false, summary: "1", problems: [nextStep("watcher_error", { repo: "o/b" }, { error: "x" } as any)] },
    });
    const since = new FakeElement("div");
    since.append(new FakeElement("h2"));
    since.all("h2")[0]!.append("Since");
    const { main, off } = await open(since);
    expect(h2(main)).toEqual(["Building now", "Finished recently", "Your turn (1)", "Since", "Problems"].map((t) => t));
    expect(main.all("summary").map((s) => s.textContent)).toContain("Metrics");
    expect(main.textContent).toContain("task a");
    expect(main.textContent).toContain("Owner: Ann");
    const counters = main.all("nav")[0]!.all("a").map((a) => a.textContent);
    expect(counters).toEqual(["1 Waiting", "1 Building", "0 Needs your check", "1 Finished today"]);
    off();
  });

  it("shows a run once: Your turn has it with its buttons, Today has no second card", async () => {
    const mine = nextStep("approval", { repo: "o/a", issue: 5, runId: "r9" }, { watched: true });
    const other = run("o1", "approval");
    set({ turn: turn([turnItem(mine)]), runs: [run("r9", "approval"), other] });
    const { main, off } = await open();
    const cards = main.all("li").filter((l) => l.attrs.class?.includes("today-card"));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("task o1");
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("2 things need you");
    off();
  });

  it("a run Your turn shows as done and continuing gets no Today card", async () => {
    const acted = nextStep("approval", { repo: "o/a", issue: 5, runId: "r9" }, { watched: true });
    set({ turn: { ...turn([]), continuing: [{ ...turnItem(acted), key: "k9" }] }, runs: [run("r9", "approval")] });
    const { main, off } = await open();
    expect(main.all("li").filter((l) => l.attrs.class?.includes("today-card"))).toHaveLength(0);
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("Nothing needs you");
    off();
  });

  it("a grouped release gives one card in Your turn and none in Today for its member runs", async () => {
    const url = "https://github.com/o/a/releases/tag/v1";
    const member = (id: string) => ({ ...run(id, "release", { status: "waiting" }), next: { ...nextStep("release", { runId: id }), where: { label: "Release", url } } });
    // the server sends the group without member run ids, only its shared release address
    const group = { key: "release|" + url, repo: "o/a", what: "Version 1", next: { ...nextStep("release", { repo: "o/a" }), issue: undefined, title: "Version 1", where: { label: "Release", url } }, since: iso(5), unblocks: 0, dismissable: true, acts: [] };
    set({ turn: turn([group]), runs: [member("m1"), member("m2")] });
    const { main, off } = await open();
    expect(main.all("li").filter((l) => l.attrs.class?.includes("today-card"))).toHaveLength(0);
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("1 thing needs you");
    expect(h2(main)).toContain("Your turn (1)");
    off();
  });

  it("does not show the label advice of a watched failure anywhere on the page", async () => {
    const failedNext = { ...nextStep("failed", { repo: "o/a", issue: 5, runId: "r9" }), action: "Fix it, then remove the `ready` label to start over", why: "The tests did not pass." };
    set({ turn: turn([turnItem(failedNext)]), runs: [{ ...run("r9", "failed", { status: "failed" }), next: failedNext }] });
    const { main, off } = await open();
    expect(main.textContent).not.toContain("remove the");
    expect(main.textContent).toContain("The tests did not pass.");
    expect(main.all("details").some((d) => d.all("summary")[0]?.textContent === "See what happened")).toBe(true);
    off();
  });

  it("hides what #838 dropped from Your turn and gives it no card", async () => {
    const closed = { ...nextStep("failed", { repo: "o/a", issue: 5, runId: "r1" }), issueClosed: true };
    const aside = { ...nextStep("failed", { repo: "o/a", issue: 6, runId: "r2" }), notNow: true };
    const live = nextStep("approval", { repo: "o/a", issue: 7, runId: "r3" }, { watched: true });
    set({
      turn: { ...turn([{ ...turnItem(closed), key: "k1" }, { ...turnItem(aside), key: "k2" }, { ...turnItem(live), key: "k3" }]), count: 3 },
      runs: [{ ...run("r1", "failed", { status: "failed" }), next: closed }, { ...run("r2", "failed", { status: "failed" }), next: aside }, run("r3", "approval")],
    });
    const { main, off } = await open();
    expect(h2(main)).toContain("Your turn (1)");
    expect(main.all("li").filter((l) => l.attrs.class?.includes("today-card"))).toHaveLength(0);
    expect(main.textContent).toContain("1 thing needs you");
    off();
  });

  it("Your turn follows the flags whichever answer comes first, and after a failed refresh of its own", async () => {
    const closed = { ...nextStep("failed", { repo: "o/a", issue: 5, runId: "r1" }), issueClosed: true };
    set({ turn: turn([turnItem(closed)]), runs: [] });
    answers["/api/runs"] = [run("r1", "failed", { status: "failed" })]; // the flags are not in yet
    const { main, off } = await open();
    expect(h2(main)).toContain("Your turn (1)");
    // the runs answer now carries the flags, and Your turn fails from now on: it still redraws from its last answer
    answers["/api/runs"] = [{ ...run("r1", "failed", { status: "failed" }), next: closed }];
    answers["/api/your-turn"] = new Error("down");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h2(main)).toContain("Your turn");
    expect(h2(main)).not.toContain("Your turn (1)");
    off();
  });

  it("Your turn answering before the runs shows the flags as soon as the runs come", async () => {
    const closed = { ...nextStep("failed", { repo: "o/a", issue: 5, runId: "r1" }), issueClosed: true };
    set({ turn: turn([turnItem(closed)]) });
    let release!: (v: any) => void;
    const inner = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => {
      if (url.startsWith("/api/runs")) {
        const body = await new Promise((r) => { release = r; });
        return { ok: true, status: 200, statusText: "OK", json: async () => body };
      }
      return inner(url, init);
    };
    const main = new FakeElement("main");
    const pending = ui.renderAdminHome(main, {});
    await flush();
    expect(h2(main)).toContain("Your turn (1)"); // the turn answered; the runs did not
    release([{ ...run("r1", "failed", { status: "failed" }), next: closed }]);
    const off = await pending;
    await flush();
    expect(h2(main)).not.toContain("Your turn (1)");
    off();
  });

  it("never says that nothing needs the person while Your turn is unknown or failed", async () => {
    set({ runs: [run("a", "running")] });
    answers["/api/your-turn"] = new Error("down");
    const { main, off } = await open();
    const line = main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent;
    expect(line).not.toContain("Nothing needs you");
    expect(main.textContent).not.toContain("Nothing here yet");
    off();
  });

  it("a watcher or monitor item alone is counted as needing the person", async () => {
    const watcher = nextStep("watcher_error", { repo: "o/b" }, { error: "cannot reach" } as any);
    set({ turn: turn([turnItem(watcher)]), runs: [] });
    const { main, off } = await open();
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("1 thing needs you");
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
    expect(main.all("p").find((p) => p.attrs.class === "today-summary")!.textContent).toBe("1 thing needs you, 1 change is being built"); // the shown failure is not counted twice
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
    expect(main.textContent).toContain("Problems could not be loaded.");
    off();
  });

  it("keeps Needs you when runs fail, and does not claim the page is empty", async () => {
    set({});
    answers["/api/runs"] = new Error("down");
    const { main, off } = await open();
    expect(h2(main)).toContain("Your turn");
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
    expect(main.textContent).toContain("1 thing needs you");
    expect(main.textContent).not.toContain("1 problem");
    off();
  });

  it("counts skill problems that the server cut off and says so", async () => {
    set({ health: { ok: false, summary: "x", problems: [], skillProblems: [{ root: "r", reason: "bad" }], skillProblemsMore: 3 } });
    const { main, off } = await open();
    expect(main.textContent).toContain("3 more skill problems not shown");
    off();
  });

  it("Your turn failing leaves Today on the page", async () => {
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
    expect(main.textContent).toContain("Today's work could not be loaded.");
    expect(named(main, "home-today-retry")).toHaveLength(1);
    expect(main.all("h1").map((e) => e.textContent)).toEqual([expect.stringMatching(/^Good /)]);
    expect(main.all("a").some((a) => a.attrs.href === "#/start")).toBe(false);
    off();
  });

  it("cleanup stops both pollers", async () => {
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

  it("keeps Problems with one line when health fails; a later success removes it", async () => {
    const problem = nextStep("watcher_error", { repo: "o/b" }, { error: "x" } as any);
    set({ runs: [run("a", "running")], health: { ok: false, summary: "1", problems: [problem] } });
    const { main, off } = await open();
    expect(h2(main)).toContain("Problems");
    expect(status(main)).toHaveLength(0);
    answers["/api/health"] = new Error("down");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h2(main)).toContain("Problems");
    expect(main.all("section").find((s) => s.all("h2")[0]?.textContent === "Problems")!.all("li")).toHaveLength(1);
    expect(status(main).map((p) => p.textContent)).toEqual([STALE]);
    expect(named(main, "home-today-refresh-retry")).toHaveLength(0);
    const holder = main.all("p").find((p) => p.attrs.class?.includes("stale-note") && p.textContent.includes("Updated"))?.parent as FakeElement | undefined;
    expect(holder?.hidden).toBe(true);
    const line = status(main)[0];
    answers["/api/runs"] = [run("a", "running"), run("b", "running")];
    await vi.advanceTimersByTimeAsync(30_000);
    expect(main.textContent).toContain("task b");
    expect(status(main)[0]).toBe(line);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status(main)[0]).toBe(line);
    answers["/api/health"] = { ok: true, summary: "ok", problems: [] };
    await vi.advanceTimersByTimeAsync(30_000);
    expect(status(main)).toHaveLength(0);
    expect(h2(main)).not.toContain("Problems");
    expect(holder?.hidden).toBe(false);
    off();
  });

  it("with no good health answer the line says so, there is no list and no empty claim", async () => {
    set({});
    answers["/api/health"] = new Error("down");
    const { main, off } = await open();
    expect(h2(main)).toContain("Problems");
    expect(status(main).map((p) => p.textContent)).toEqual(["Problems could not be loaded."]);
    const section = main.all("section").find((s) => s.all("h2")[0]?.textContent === "Problems")!;
    expect(section.all("ul")).toHaveLength(0);
    expect(main.textContent).not.toContain("Nothing here yet");
    off();
  });

  it("both feeds failing at once give unique Retry names", async () => {
    set({});
    answers["/api/your-turn"] = new Error("down");
    answers["/api/runs"] = new Error("down");
    const first = await open();
    expect(named(first.main, "home-needs-retry")).toHaveLength(1);
    expect(named(first.main, "home-today-retry")).toHaveLength(1);
    expect(first.main.all("h1").map((e) => e.textContent)).toEqual([expect.stringMatching(/^Good /)]);
    first.off();

    set({ runs: [run("a", "running")] });
    const second = await open();
    answers["/api/your-turn"] = new Error("down");
    answers["/api/runs"] = new Error("down");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(named(second.main, "home-needs-refresh-retry")).toHaveLength(1);
    expect(named(second.main, "home-today-refresh-retry")).toHaveLength(1);
    expect(second.main.textContent).toContain("task a");
    second.off();
  });

  it("keeps scroll and focus when a Your turn answer redraws the parent sections", async () => {
    const problem = nextStep("watcher_error", { repo: "o/b" }, { error: "x" } as any);
    set({ runs: [run("a", "running"), run("d", "done", { finishedAt: iso(1) })], health: { ok: false, summary: "1", problems: [problem] } });
    const { main, off } = await open();
    const link = main.all("a").find((a) => a.attrs["data-focus"] === "home-building-a")!;
    link.focus();
    const root = (document as any).documentElement;
    root.scrollTop = 120;
    const page = main.children[0] as FakeElement;
    for (const part of page.children as FakeElement[]) {
      const own = part.replaceChildren.bind(part);
      part.replaceChildren = (...nodes: any[]) => { root.scrollTop = 0; own(...nodes); };
    }
    answers["/api/your-turn"] = turn([turnItem(approval())]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(main.textContent).toContain("1 thing needs you, 1 change is being built");
    expect(root.scrollTop).toBe(120);
    expect((document as any).activeElement?.attrs["data-focus"]).toBe("home-building-a");
    root.scrollTop = 0;
    off();
  });

  it("Retry in Today loads it", async () => {
    set({});
    answers["/api/runs"] = new Error("down");
    const { main, off } = await open();
    answers["/api/runs"] = [run("a", "running")];
    named(main, "home-today-retry")[0]!.click();
    await flush();
    expect(main.textContent).toContain("task a");
    expect(main.textContent).not.toContain("Today's work could not be loaded");
    expect(h2(main).some((t) => t.startsWith("Your turn"))).toBe(true);
    off();
  });

  it("a Your turn failure keeps Today polling; a later success draws Your turn", async () => {
    set({ runs: [run("a", "running")] });
    answers["/api/your-turn"] = new Error("down");
    const { main, off } = await open();
    expect(main.textContent).toContain("task a");
    answers["/api/your-turn"] = turn([turnItem(approval())]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h2(main)).toContain("Your turn (1)");
    log.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(log).toContain("/api/runs");
    off();
  });

  it("cleanup right after a slow first load leaves no request and no listener", async () => {
    set({ runs: [run("a", "running")] });
    const before = (document as any).listeners.visibilitychange?.length ?? 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inner = (globalThis as any).fetch;
    (globalThis as any).fetch = async (url: string, init?: any) => { await gate; return inner(url, init); };
    const pending = ui.renderAdminHome(new FakeElement("main"), {});
    await flush();
    release();
    const off = await pending;
    off();
    log.length = 0;
    for (const fn of [...((document as any).listeners.visibilitychange ?? [])]) fn();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log).toEqual([]);
    expect((document as any).listeners.visibilitychange?.length ?? 0).toBe(before);
  });

  it("a hidden tab makes no requests", async () => {
    set({ runs: [run("a", "running")] });
    (document as any).visibilityState = "hidden";
    const { main, off } = await open();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(log).toEqual([]);
    expect(main.all("div").some((d) => d.attrs.class?.startsWith("skeleton"))).toBe(true);
    off();
  });

  it("gives every Tab stop a unique data-focus, also for records with the same key", async () => {
    const dup = (text: string) => nextStep("watcher_error", { repo: "o/b" }, { error: text } as any);
    set({
      turn: turn([turnItem(approval())]),
      runs: [...["a", "b", "c", "d", "e", "f", "g"].map((id) => run(id, "running")), run("z", "done", { finishedAt: iso(1) })],
      health: { ok: false, summary: "3", problems: [nextStep("failed", { repo: "o/a", issue: 7, runId: "r7" }), dup("x"), dup("y")], monitorFindings: { open: 1 } },
      clarity: { sampled: false },
    });
    const { main, off } = await open(new FakeElement("div"));
    const d = main.all("details").find((x) => x.all("summary")[0]?.textContent === "Metrics")!;
    d.setAttribute("open", "");
    d.fire("toggle");
    await flush();
    const stops = [...main.all("a").filter((a) => a.attrs.href), ...main.all("button"), ...main.all("summary")];
    const names = stops.map((e) => e.attrs["data-focus"]);
    expect(names.every((n) => !!n)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    for (const n of ["home-findings", "home-metrics", "home-all-metrics"]) expect(names).toContain(n);
    expect(names.some((n) => n?.startsWith("home-problem-"))).toBe(true);
    off();
  });
});
