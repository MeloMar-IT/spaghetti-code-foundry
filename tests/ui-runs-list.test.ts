import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// The sections of the runs lists: the pure model, the row, and the keyed updater. Fake DOM, no server.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let rl: any;
let runs: any;
beforeAll(async () => {
  restore = installFakeDom();
  rl = await import("../ui/runs-list.js" as string);
  runs = await import("../ui/runs.js" as string);
});
afterAll(() => restore());

const doc = () => (globalThis as any).document;
const rec = (who: string, kind = "running") => ({ who, kind, status: `${kind} status`, text: `${kind} text`, help: "help" });
const run = (id: string, over: Record<string, unknown> = {}) => ({ runId: id, flow: `flow-${id}`, status: "running", startedAt: "2026-10-01T10:00:00Z", history: [], totalCostUsd: 0, task: `task ${id}\nsecond`, vars: { github_repo: "o/r", issue: "7" }, next: rec("Foundry"), ...over });
const job = (id: string, over: Record<string, unknown> = {}) => ({ runId: id, kind: "run", enqueuedAt: "2026-10-01T11:00:00Z", task: "queued", ahead: 0, next: rec("Foundry", "queued"), ...over });
const walk = (el: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  for (const c of el.children) if (c instanceof FakeElement) { out.push(c); walk(c, out); }
  return out;
};
const named = (root: FakeElement, name: string) => walk(root).find((el) => el.attrs["data-focus"] === name)!;
const box = () => document.createElement("div") as unknown as FakeElement;
const heads = (b: FakeElement) => b.all("h2").map((h) => h.textContent);
const items = (b: FakeElement) => b.all("li");

beforeEach(() => { doc().activeElement = null; });
afterEach(() => { doc().activeElement = null; });

describe("sectionOf", () => {
  const of = (r: any, j: any = null) => rl.sectionOf({ run: r, job: j });
  it("follows the record, the queue and the status", () => {
    expect(of(run("a", { status: "waiting", next: rec("You", "approval") }))).toBe("needs");
    expect(of(run("a", { status: "failed", next: rec("You", "failed") }))).toBe("needs");
    expect(of(null, job("q"))).toBe("queued");
    expect(of(run("a", { status: "stopped" }), job("a"))).toBe("queued");
    expect(of(run("a"))).toBe("running");
    expect(of(run("a", { status: "waiting" }))).toBe("running");
    expect(of(run("a", { status: "failed" }))).toBe("failed");
    for (const status of ["succeeded", "cancelled", "stopped"]) expect(of(run("a", { status }))).toBe("completed");
    expect(of(null, job("q", { next: rec("You", "approval") }))).toBe("needs");
  });
});

describe("runSections", () => {
  it("returns the sections in order, leaves empty ones out and lists a run once", () => {
    const all = [run("r1", { status: "succeeded" }), run("r2"), run("r3", { status: "failed" }), run("r4", { next: rec("You") }), run("r5", { status: "succeeded" })];
    const secs = rl.runSections(all, [job("q1"), job("r2")]);
    expect(secs.map((s: any) => s.id)).toEqual(["needs", "running", "queued", "failed", "completed"].filter((id) => id !== "running"));
    const ids = secs.flatMap((s: any) => s.entries.map((e: any) => e.run?.runId ?? e.job.runId));
    expect(ids.sort()).toEqual(["q1", "r1", "r2", "r3", "r4", "r5"]);
    expect(rl.runSections(undefined, undefined)).toEqual([]);
  });

  it("gives a queued entry its place in the whole queue, whatever the filter keeps", () => {
    const pending = [job("q1", { githubRepo: "a/b" }), job("q2", { githubRepo: "o/r" }), job("q3", { githubRepo: "o/r" })];
    const secs = rl.runSections([], pending, (e: any) => e.job.githubRepo === "o/r");
    expect(secs[0].entries.map((e: any) => [e.job.runId, e.place])).toEqual([["q2", { n: 2, of: 3 }], ["q3", { n: 3, of: 3 }]]);
  });
});

describe("activityAt", () => {
  it("takes the newest timestamp the answer has", () => {
    const r = run("a", { startedAt: "2026-10-01T10:00:00Z", history: [{ startedAt: "2026-10-01T10:30:00Z", durationMs: 60_000 }], answers: [{ at: "2026-10-01T10:20:00Z" }] });
    expect(rl.activityAt(r)).toBe(new Date("2026-10-01T10:31:00Z").toISOString());
    expect(rl.activityAt({ startedAt: "2026-10-01T10:00:00Z", finishedAt: "2026-10-01T10:05:00Z" })).toBe("2026-10-01T10:05:00Z");
    expect(rl.activityAt({})).toBe("");
  });
});

describe("listRow", () => {
  it("shows the parts in order and the admin parts last", () => {
    const li = rl.listRow({ run: run("r1"), job: null }, { admin: true });
    const labels = walk(li).map((e) => e.attrs["data-label"]).filter(Boolean);
    expect(labels).toEqual(["What happens next", "Task", "Repository", "Owner", "Steps", "Cost"]);
    expect(li.textContent).toContain("task r1");
    expect(li.textContent).not.toContain("second");
    expect(li.textContent).toContain("o/r#7");
    expect(li.textContent).toContain("Updated ");
    const user = rl.listRow({ run: run("r1"), job: null });
    expect(walk(user).map((e) => e.attrs["data-label"]).filter(Boolean)).toEqual(["What happens next", "Task", "Repository"]);
    const link = li.all("a")[0]!;
    expect(link.attrs.href).toBe("#/runs/r1");
    expect(link.attrs["data-focus"]).toBe("open-r1");
  });

  it("shows the queue position, goes first and the runs ahead, and Remove last", () => {
    const onRemove = vi.fn();
    const entry = { run: null, job: job("q1", { priority: true, ahead: 2 }), place: { n: 1, of: 4 } };
    const li = rl.listRow(entry, { onRemove });
    expect(li.textContent).toContain("goes first");
    expect(li.textContent).toContain("1 of 4");
    expect(li.textContent).toContain("2 runs ahead of you");
    const buttons = li.all("button");
    expect(buttons[buttons.length - 1]!.attrs["data-focus"]).toBe("remove-q1");
    buttons[buttons.length - 1]!.click();
    expect(onRemove).toHaveBeenCalledWith(entry.job);
    const plain = rl.listRow({ run: null, job: job("q2"), place: { n: 2, of: 4 } });
    expect(plain.textContent).not.toContain("ahead of you");
    expect(plain.textContent).not.toContain("goes first");
    expect(plain.all("button").some((b) => b.attrs["data-focus"] === "remove-q2")).toBe(false);
  });

  it("does not throw for a run with no record", () => {
    expect(() => rl.listRow({ run: run("r1", { next: undefined }), job: null })).not.toThrow();
  });
});

describe("renderSections", () => {
  const sample = (over: Record<string, unknown> = {}) => rl.runSections(
    [run("r1", { next: rec("You", "approval") }), run("r2"), run("r3", { status: "failed" }), run("r4", { status: "succeeded", ...over })],
    [job("q1"), job("q2")]);
  const draw = (b: FakeElement, secs: any, opts: any = {}) => rl.renderSections(b, secs, { notes: { queued: "2/3 running" }, ...opts });

  it("writes the headings with counts, the note on Queued only, and the tone classes", () => {
    const b = box();
    draw(b, sample());
    expect(heads(b)).toEqual(["Needs you (1)", "Running (1)", "Queued (2)", "Failed (1)", "Completed (1)"]);
    const secs = b.all("section");
    expect(secs.map((s) => s.attrs.class)).toEqual(["run-section strong", "run-section strong", "run-section strong", "run-section", "run-section quiet"]);
    expect(secs[2]!.textContent).toContain("2/3 running");
    expect(secs[0]!.textContent).not.toContain("2/3 running");
  });

  it("collapses Completed to ten rows with Show all, which stays on after an update", () => {
    const many = Array.from({ length: 11 }, (_, i) => run(`c${String(i).padStart(2, "0")}`, { status: "succeeded", startedAt: `2026-09-${String(10 + i)}T10:00:00Z` }));
    const b = box();
    draw(b, rl.runSections(many, []));
    expect(items(b)).toHaveLength(10);
    const more = named(b, "more-completed");
    more.click();
    expect(items(b)).toHaveLength(11);
    expect(named(b, "more-completed")).toBeUndefined();
    expect(doc().activeElement?.attrs["data-focus"]).toMatch(/^open-/);
    draw(b, rl.runSections(many, []));
    expect(items(b)).toHaveLength(11);
    const b2 = box();
    draw(b2, rl.runSections(many.slice(0, 10), []));
    expect(items(b2)).toHaveLength(10);
    expect(named(b2, "more-completed")).toBeUndefined();
  });

  it("hides a section on toggle, and it stays closed after an update and after it emptied and came back", () => {
    const b = box();
    draw(b, sample());
    const toggle = named(b, "sec-failed");
    toggle.click();
    expect(toggle.attrs["aria-expanded"]).toBe("false");
    const body = () => b.all("section")[3]!.all("div").find((d) => d.attrs.id === "run-sec-failed")!;
    expect(body().hidden).toBe(true);
    draw(b, sample());
    expect(body().hidden).toBe(true);
    draw(b, rl.runSections([run("r2")], []));
    expect(named(b, "sec-failed")).toBeUndefined();
    draw(b, sample());
    expect(named(b, "sec-failed").attrs["aria-expanded"]).toBe("false");
    expect(body().hidden).toBe(true);
  });

  it("changes only the row that changed, and keeps the focus on an unchanged row", () => {
    const b = box();
    draw(b, sample());
    const before = new Map(items(b).map((li) => [li.all("a")[0]!.attrs["data-focus"], li]));
    const link = named(b, "open-r2");
    link.focus();
    draw(b, sample({ task: "changed" })); // r4 changes
    const after = new Map(items(b).map((li) => [li.all("a")[0]!.attrs["data-focus"], li]));
    expect(after.get("open-r1")).toBe(before.get("open-r1"));
    expect(after.get("open-r2")).toBe(before.get("open-r2"));
    expect(after.get("open-r4")).not.toBe(before.get("open-r4"));
    expect(doc().activeElement).toBe(link);
  });

  it("puts the focus on the new node of a rebuilt row", () => {
    const b = box();
    draw(b, sample());
    const old = named(b, "open-r2");
    old.focus();
    rl.renderSections(b, rl.runSections([run("r1", { next: rec("You", "approval") }), run("r2", { task: "new" })], []), {});
    const now = named(b, "open-r2");
    expect(now).not.toBe(old);
    expect(doc().activeElement).toBe(now);
  });

  it("moves the focus to a section toggle when the focused row is gone, and does not touch focus outside the list", () => {
    const b = box();
    draw(b, sample());
    named(b, "open-r3").focus();
    draw(b, rl.runSections([run("r2")], []));
    expect(doc().activeElement?.attrs["data-focus"]).toBe("sec-running");
    const outside = document.createElement("button") as unknown as FakeElement;
    outside.focus();
    draw(b, sample());
    expect(doc().activeElement).toBe(outside);
  });

  it("moves the focus to the page heading when the last focused row is gone", () => {
    const page = box();
    const h1 = document.createElement("h1") as unknown as FakeElement;
    const b = box();
    page.append(h1, b);
    draw(b, rl.runSections([run("r2")], []));
    named(b, "open-r2").focus();
    draw(b, []);
    expect(doc().activeElement).toBe(h1);
    expect(h1.attrs.tabindex).toBe("-1");
  });

  it("labels the position of a user as one of their own queued runs, next to the server's ahead count", () => {
    const user = rl.listRow({ run: null, job: job("q1", { ahead: 3 }), place: { n: 1, of: 1 } });
    expect(user.textContent).toContain("1 of 1 of your queued runs");
    expect(user.textContent).toContain("3 runs ahead of you");
    const admin = rl.listRow({ run: null, job: job("q1"), place: { n: 1, of: 4 } }, { admin: true });
    expect(admin.textContent).toContain("1 of 4");
    expect(admin.textContent).not.toContain("your queued runs");
  });

  it("moves the focus to the toggle when the row moves into a closed section", () => {
    const b = box();
    draw(b, sample());
    named(b, "sec-completed").click();
    named(b, "open-r2").focus();
    draw(b, rl.runSections([run("r2", { status: "succeeded" })], []));
    expect(doc().activeElement?.attrs["data-focus"]).toBe("sec-completed");
  });

  it("lists a run that changed section once", () => {
    const b = box();
    draw(b, rl.runSections([run("r2")], []));
    draw(b, rl.runSections([run("r2", { status: "succeeded" })], []));
    expect(items(b)).toHaveLength(1);
    expect(heads(b)).toEqual(["Completed (1)"]);
  });

  it("changes no node when the sections are the same", () => {
    const b = box();
    draw(b, sample());
    const all = walk(b);
    const shape = all.map((e) => e.children.slice());
    draw(b, sample());
    const again = walk(b);
    expect(again).toEqual(all);
    again.forEach((e, i) => expect(e.children).toEqual(shape[i]));
    again.forEach((e, i) => e.children.forEach((c, j) => expect(c).toBe(shape[i]![j])));
  });

  it("shows no Remove without onRemove", () => {
    const b = box();
    draw(b, sample());
    expect(b.all("button").some((x) => x.textContent === "Remove")).toBe(false);
    draw(b, sample(), { onRemove: () => {} });
    expect(b.all("button").filter((x) => x.textContent === "Remove")).toHaveLength(2);
  });
});

describe("the pages", () => {
  const realFetch = globalThis.fetch;
  let answers: Record<string, any>;
  let gate: Promise<void> | null;
  let asked: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    answers = {};
    asked = [];
    gate = null;
    doc().getElementById("modal-root").replaceChildren();
    (globalThis as any).addEventListener = () => {};
    (globalThis as any).removeEventListener = () => {};
    (globalThis as any).fetch = async (url: string, init?: any) => {
      asked.push(`${init?.method ?? "GET"} ${url}`);
      const path = url.split("?")[0]!;
      const body = answers[url] ?? answers[path] ?? {};
      if (gate && path === "/api/runs") await gate;
      return { ok: true, status: 200, statusText: "OK", json: async () => body };
    };
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
    delete (globalThis as any).addEventListener;
    delete (globalThis as any).removeEventListener;
  });
  const connected = () => { const m = new FakeElement("main"); (m as any).isConnected = true; return m; };
  const good = (list: any[], queue: any = { pending: [], active: [], concurrency: 3 }) => {
    answers["/api/runs"] = list;
    answers["/api/queue"] = queue;
    answers["/api/run-owners"] = [{ id: "u1", name: "Ann", runs: 1 }, { id: "u2", name: "Bob", runs: 1 }];
  };
  const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it("shows the concurrency in the Queued heading, no Queue card and a Remove that asks again", async () => {
    good([run("r1")], { pending: [job("q1"), job("q2")], active: [{ runId: "r1" }, { runId: "x" }], concurrency: 3 });
    const main = connected();
    const stop = await runs.renderRunsList(main);
    expect(heads(main)).toContain("Queued (2)");
    expect(main.textContent).toContain("2/3 running");
    expect(main.textContent).toContain("1 of 2");
    expect(main.all("h3")).toHaveLength(0);
    asked.length = 0;
    named(main, "remove-q1").click();
    await tick(0);
    expect(asked).toContain("POST /api/runs/q1/cancel");
    expect(asked.filter((a) => a === "GET /api/runs").length).toBeGreaterThan(0);
    stop();
  });

  it("a late answer of an older request never overwrites a newer one", async () => {
    good([run("r1", { task: "first" })]);
    answers["/api/runs?owner=u2"] = [run("r2", { task: "second" })];
    const main = connected();
    const stop = await runs.renderRunsList(main);
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    await tick(30_000); // an older request waits at the gate
    const old = gate;
    gate = null;
    main.all("select").find((s) => s.attrs["data-focus"] === "owner-filter")!.fire("change", { target: { value: "u2" } });
    await tick(0);
    expect(main.textContent).toContain("second");
    gate = old;
    release();
    await tick(0);
    expect(main.textContent).toContain("second");
    expect(main.textContent).not.toContain("first");
    stop();
  });

  it("draws nothing after the page was left", async () => {
    good([run("r1", { task: "first" })]);
    const main = connected();
    const stop = await runs.renderRunsList(main);
    let release!: () => void;
    gate = new Promise<void>((r) => { release = r; });
    answers["/api/runs"] = [run("r1", { task: "later" })];
    await tick(30_000);
    stop();
    const text = main.textContent;
    release();
    await tick(0);
    expect(main.textContent).toBe(text);
  });

  it("keeps the owner select and the focus when a run changes", async () => {
    good([run("r1"), run("r2")]);
    const main = connected();
    const stop = await runs.renderRunsList(main);
    const select = named(main, "owner-filter");
    const link = named(main, "open-r2");
    link.focus();
    good([run("r1", { task: "changed" }), run("r2")]);
    await tick(30_000);
    expect(named(main, "owner-filter")).toBe(select);
    expect(named(main, "open-r2")).toBe(link);
    expect(doc().activeElement).toBe(link);
    stop();
  });

  it("keeps the focused row when the owner counts change", async () => {
    good([run("r1")]);
    const main = connected();
    const stop = await runs.renderRunsList(main);
    const link = named(main, "open-r1");
    link.focus();
    answers["/api/run-owners"] = [{ id: "u1", name: "Ann", runs: 5 }, { id: "u2", name: "Bob", runs: 1 }];
    await tick(30_000);
    expect(main.textContent).toContain("Ann (5)");
    expect(doc().activeElement).toBe(link);
    expect(named(main, "open-r1")).toBe(link);
    stop();
  });

  it("My runs shows the sections in order, no Remove for readOnly, and keeps the scroll", async () => {
    const mine = await import("../ui/user/runs.js" as string);
    const a = {
      runs: async () => answers.mine,
      queue: async () => ({ pending: answers.pending }),
      cancelRun: vi.fn(async () => ({ cancelled: true })),
    };
    answers.mine = [run("r1", { status: "succeeded" }), run("r2"), run("r3", { next: rec("You", "approval") })];
    answers.pending = [job("q1")];
    const main = connected();
    const ask = vi.fn(async () => true);
    const stop = await mine.renderMyRuns(main, { a, ask });
    expect(heads(main)).toEqual(["Needs you (1)", "Running (1)", "Queued (1)", "Completed (1)"]);
    doc().documentElement.scrollTop = 120;
    answers.mine = [run("r1", { status: "succeeded", task: "changed" }), run("r2"), run("r3", { next: rec("You", "approval") })];
    await tick(30_000);
    expect(main.textContent).toContain("changed");
    expect(doc().documentElement.scrollTop).toBe(120);
    named(main, "remove-q1").click();
    await tick(0);
    expect(ask).toHaveBeenCalled();
    expect(a.cancelRun).toHaveBeenCalledWith("q1");
    stop();
    const ro = connected();
    const stopRo = await mine.renderMyRuns(ro, { a, readOnly: true });
    expect(ro.all("button").some((x) => x.textContent === "Remove")).toBe(false);
    stopRo();
  });
});
