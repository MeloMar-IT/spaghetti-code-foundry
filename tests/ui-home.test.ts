import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";
import { audit } from "./helpers/a11y.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let today: any;
let filter: any;
let list: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/home.js" as string);
  today = await import("../ui/today.js" as string);
  filter = await import("../ui/runs-filter.js" as string);
  list = await import("../ui/runs-list.js" as string);
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
const NOON = new Date(2026, 0, 1, 15, 0).getTime();
const at = (dayOffset: number, hour: number) => new Date(2026, 0, 1 + dayOffset, hour).toISOString();
/** A failed run whose record carries #838 flags. */
const failed = (id: string, flags: any = {}, over: any = {}) => ({
  ...run(id, "failed", { status: "failed", ...over }),
  next: { ...rec("failed", id), ...flags },
});

describe("needsUser", () => {
  it("follows the server rule", () => {
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

describe("greeting and summaryLine", () => {
  it("greets by the hour", () => {
    expect(today.greeting(new Date(2026, 0, 1, 7))).toBe("Good morning");
    expect(today.greeting(new Date(2026, 0, 1, 12))).toBe("Good afternoon");
    expect(today.greeting(new Date(2026, 0, 1, 17, 59))).toBe("Good afternoon");
    expect(today.greeting(new Date(2026, 0, 1, 18))).toBe("Good evening");
  });
  it("says each part, singular and plural, and leaves zero parts out", () => {
    expect(today.summaryLine({ check: 1, building: 1, finishedToday: 3 })).toBe("1 thing needs you, 1 change is being built, 3 finished today");
    expect(today.summaryLine({ check: 2, building: 4, finishedToday: 1 })).toBe("2 things need you, 4 changes are being built, 1 finished today");
    expect(today.summaryLine({})).toBe("Nothing needs you");
    expect(today.summaryLine({ building: 1 })).toBe("Nothing needs you, 1 change is being built");
  });
  it("does not say that nothing needs the person when that is not known", () => {
    expect(today.summaryLine({ unknown: true, building: 1 })).not.toContain("Nothing needs you");
  });
});

describe("todayModel", () => {
  it("groups by the record, not by the status", () => {
    const m = today.todayModel([
      run("need", "approval"),
      run("wrong", "failed", { status: "failed" }),
      run("go", "running"),
      run("wait", "dependency", { status: "waiting" }, { blockers: [] }),
      run("done", "done", { status: "succeeded", finishedAt: at(0, 10) }),
      run("old", "done", { status: "succeeded", finishedAt: at(-3, 10) }),
      run("cx", "cancelled", { status: "cancelled" }),
      run("sup", "superseded"),
      { runId: "legacy", flow: "f", startedAt: iso(3), status: "succeeded" },
    ], [job("j")], { now: NOON });
    expect(m.attention.map((c: any) => c.id).sort()).toEqual(["need", "wrong"]);
    expect(m.building.map((b: any) => b.id)).toEqual(["go"]);
    expect(m.counts.waiting).toBe(2); // the queued job and the run that waits for another
    expect(m.finished.map((f: any) => f.id)).toEqual(["done", "old"]);
    expect(m.counts["finished-today"]).toBe(1);
    expect(m.total).toBe(9); // the legacy run has no record
  });

  it("drops a failed run whose change is closed or put aside, and counts a split that made all its parts as finished", () => {
    const m = today.todayModel([
      failed("closed", { issueClosed: true }),
      failed("aside", { notNow: true }),
      failed("split", { splitMade: "all" }, { finishedAt: at(0, 9) }),
      failed("some", { splitMade: "some" }),
    ], [], { now: NOON });
    expect(m.attention.map((c: any) => c.id)).toEqual(["some"]);
    expect(m.counts.check).toBe(1);
    expect(m.finished.map((f: any) => f.id)).toEqual(["split"]);
    expect([...today.droppedRuns([failed("closed", { issueClosed: true }), failed("aside", { notNow: true }), failed("x"), run("r", "running")])].sort()).toEqual(["aside", "closed"]);
  });

  it("counts finished today by the day it finished, not the day it started", () => {
    const m = today.todayModel([
      run("a", "done", { status: "succeeded", startedAt: at(-1, 20), finishedAt: at(0, 8) }),
      run("b", "done", { status: "succeeded", startedAt: at(0, 7), finishedAt: at(-1, 23) }),
    ], [], { now: NOON });
    expect(m.counts["finished-today"]).toBe(1);
    expect(m.lists["finished-today"].map((i: any) => i.id)).toEqual(["a"]);
  });

  it("counts Ready to check for approvals, plans, splits, releases and final versions, not for questions or stuck work", () => {
    const m = today.todayModel([
      run("a", "approval"), run("p", "approve_plan"), run("s", "approve_split"), run("rel", "release"),
      { ...run("fin", "approval", {}, { final: true }) },
      run("q", "questions"), failed("f"),
    ], [], { now: NOON });
    expect(m.lists.ready.map((i: any) => i.id).sort()).toEqual(["a", "fin", "p", "rel", "s"]);
    expect(m.counts.ready).toBe(m.lists.ready.length);
    expect(m.counts.ready).toBe(5);
  });

  it("counts Published this week from today to 6 days back, not 7, and only confirmed publications", () => {
    const merged = [{ id: "merge", ok: true }];
    const done = (id: string, day: number, over: any = {}) => run(id, "done", { status: "succeeded", finishedAt: at(day, 10), history: merged, ...over });
    const m = today.todayModel([
      done("today", 0), done("six", -6), done("seven", -7),
      // a planning run that finished published nothing
      run("plan", "done", { flow: "issue-plan", status: "succeeded", finishedAt: at(0, 10), history: [{ id: "plan", ok: true }] }),
      // a merge that failed published nothing
      run("nomerge", "done", { status: "succeeded", finishedAt: at(0, 10), history: [{ id: "merge", ok: false }] }),
      // a daily release that was rejected ("Not yet") ends succeeded but published nothing
      done("rejected", 0, { flow: "release-daily", history: [{ id: "final_merge", ok: false }] }),
      done("merged", 0, { flow: "release-daily", history: [{ id: "final_merge", ok: true }] }),
      done("pushed", 0, { history: [{ id: "push_main", ok: true, output: "PUSHED: main" }] }),
      // a split that made all its parts is finished, not published
      failed("split", { splitMade: "all" }, { finishedAt: at(0, 9) }),
      // a scheduled release that waits is not published
      run("waits", "release", { status: "succeeded", finishedAt: at(0, 9) }),
    ], [], { now: NOON });
    expect(m.lists["published-week"].map((i: any) => i.id).sort()).toEqual(["merged", "pushed", "six", "today"]);
    expect(m.counts["published-week"]).toBe(4);
  });

  it("Simple puts the project on cards and running work, Advanced does not", () => {
    const projectOf = () => "p1";
    const runs = [run("a", "approval"), run("b", "running", { startedAt: at(0, 9) }), run("c", "dependency", { status: "waiting", history: [{ id: "implement" }] }, { blockers: [] })];
    const s = today.todayModel(runs, [], { simple: true, projectOf, now: NOON });
    expect(s.attention[0].project).toBe("p1");
    expect(s.building.map((b: any) => [b.id, b.project, b.running]).sort()).toEqual([["b", "p1", true], ["c", "p1", false]]);
    expect(s.building.find((b: any) => b.id === "b").startedMs).toBe(Date.parse(at(0, 9)));
    const adv = today.todayModel(runs, [], { now: NOON });
    expect(Object.hasOwn(adv.attention[0], "project")).toBe(false);
    expect(Object.hasOwn(adv.building[0], "project")).toBe(false);
  });

  it("Simple tags each card with its state, Advanced does not", () => {
    const projectOf = () => "p1";
    const kinds: [string, any, string][] = [
      ["approval", {}, "check"], ["approve_plan", {}, "check"], ["release", {}, "check"], ["approval", { final: true }, "check"],
      ["questions", {}, "question"], ["planner_questions", {}, "question"], ["failed", { status: "failed" }, "stuck"], ["owner_action", {}, "todo"],
    ];
    for (const [kind, over, tag] of kinds) {
      const r = kind === "approval" && over.final ? { ...run("x", kind), next: { ...rec(kind, "x"), final: true } } : run("x", kind, over);
      const s = today.todayModel([r], [], { simple: true, projectOf, now: NOON });
      expect(s.attention[0]?.tag, `${kind} ${JSON.stringify(over)}`).toBe(tag);
      const adv = today.todayModel([r], [], { now: NOON });
      expect(Object.hasOwn(adv.attention[0], "tag")).toBe(false);
    }
    expect(today.tagOf(undefined)).toBe("todo");
    expect(today.tagOf({ kind: "stopped" })).toBe("stuck");
  });

  it("exports the card views and the predicates", () => {
    expect(typeof today.attentionCard).toBe("function");
    expect(typeof today.buildingItem).toBe("function");
    expect(today.isReady(rec("approve_plan"))).toBe(true);
    expect(today.isReady(rec("questions"))).toBe(false);
    expect(today.isReady(undefined)).toBe(false);
    expect(today.inLastWeek({ run: { finishedAt: at(-6, 0) } }, NOON)).toBe(true);
    expect(today.inLastWeek({ run: { finishedAt: at(-7, 23) } }, NOON)).toBe(false);
  });

  it("handles bad input", () => {
    for (const m of [today.todayModel(null, "x"), today.todayModel({}, undefined)]) {
      expect(m.total).toBe(0);
      expect(m.attention).toEqual([]);
      expect(m.counts).toEqual({ waiting: 0, building: 0, check: 0, ready: 0, "published-week": 0, "finished-today": 0 });
    }
  });

  it("Simple: only work of a known project, with the project's address", () => {
    const projectOf = (e: any) => (e.run?.runId === "mine" ? "p1" : null);
    const m = today.todayModel([run("mine", "approval"), run("other", "approval")], [], { simple: true, projectOf });
    expect(m.total).toBe(1);
    expect(m.attention[0].action.href).toBe("#/repos/p1");
  });

  it("the counters and the Runs list a counter opens use the same predicate", () => {
    const runs = [run("a", "approval"), run("b", "running"), run("c", "running", { history: [{ id: "implement" }] }), run("d", "done", { finishedAt: at(0, 9) }), failed("e", { splitMade: "all" }, { finishedAt: at(0, 10) }), failed("f")];
    const m = today.todayModel(runs, [job("j")], { now: NOON });
    const entries = list.myRunsEntries(runs, [job("j")]);
    for (const key of ["waiting", "building", "check", "finished-today"]) {
      const listed = entries.filter((e: any) => today.inGroup(key, e, NOON));
      expect(listed.length, key).toBe(m.counts[key]);
    }
    // a failed split that made all its parts is in Finished, not in the Failed section of the list
    expect(entries.filter((e: any) => today.inGroup("finished", e, NOON)).map((e: any) => e.run.runId).sort()).toEqual(["d", "e"]);
    expect(list.sectionOf(entries.find((e: any) => e.run?.runId === "e"))).toBe("failed");
  });
});

describe("counters and their destinations", () => {
  it("links the four counters to a filtered Runs list, and to a list on Home in Simple", () => {
    const c = today.counterLinks({ waiting: 1, building: 2, check: 3, "finished-today": 4 });
    expect(c.map((x: any) => [x.label, x.count, x.href])).toEqual([
      ["Waiting", 1, "#/runs?group=waiting"], ["Building", 2, "#/runs?group=building"],
      ["Needs your check", 3, "#/runs?group=check"], ["Finished today", 4, "#/runs?group=finished-today"],
    ]);
    expect(today.counterLinks({}, { simple: true }).map((x: any) => x.href)).toEqual([
      "#/home?list=waiting", "#/home?list=building", "#/home?list=check", "#/home?list=finished-today"]);
  });
  it("the Runs address round-trips through the filter", () => {
    for (const g of filter.GROUPS) expect(filter.parseFilter(filter.filterHash({ group: g })).group).toBe(g);
    expect(filter.parseFilter("#/runs?group=nope").group).toBe("");
  });
  it("Simple: a counter opens its list on Home", () => {
    const projectOf = () => "p1";
    const m = today.todayModel([run("b", "running", { task: "Build it" })], [], { simple: true, projectOf, now: NOON });
    const root = view(today.todayView(m, { focus: "t", simple: true, list: "building" }));
    expect(root.all("section").find((s) => s.attrs.class === "today-list")!.textContent).toContain("Build it");
    expect(links(root).some((a) => a.attrs.href === "#/home")).toBe(true);
    // an unknown list name shows no list
    expect(view(today.todayView(m, { focus: "t", simple: true, list: "nope" })).all("section").some((s) => s.attrs.class === "today-list")).toBe(false);
  });
});

describe("todayView", () => {
  const model = (runs: any[], pending: any[] = [], opts: any = {}) => today.todayModel(runs, pending, { now: NOON, ...opts });
  const headings = (root: FakeElement) => root.all("h2").map((h) => h.textContent);

  it("starts with the greeting and the summary, then cards, counters, Building now and Finished recently", () => {
    const root = view(today.todayView(model([run("n", "approval"), run("a", "running"), run("d", "done", { finishedAt: at(0, 10) })]), { focus: "home" }));
    expect(root.all("h1")).toHaveLength(1);
    expect(root.all("h1")[0]!.textContent).toMatch(/^Good (morning|afternoon|evening)$/);
    expect(root.all("p")[0]!.textContent).toBe("1 thing needs you, 1 change is being built, 1 finished today");
    expect(headings(root)).toEqual(["Needs you", "Building now", "Finished recently"]);
    expect(root.all("nav")[0]!.all("a").map((a) => a.attrs.href)).toHaveLength(4);
  });

  it("one card per run that needs the person, with the title, a word-list sentence, one button and the cause behind a disclosure", () => {
    const n = { ...rec("approval", "n"), title: "Add dark mode", why: "The plan is ready." };
    const root = view(today.todayView(model([{ ...run("n", "approval"), next: n }, run("m", "approval")]), { focus: "home" }));
    const cards = root.all("li").filter((l) => l.attrs.class?.includes("today-card"));
    expect(cards).toHaveLength(2);
    const card = cards.find((c) => c.textContent.includes("Add dark mode"))!;
    expect(card.all("h3")[0]!.textContent).toBe("Add dark mode");
    expect(card.textContent).not.toContain("flow-n");
    expect(card.all("a").filter((a) => a.attrs.class === "btn primary")).toHaveLength(1);
    const d = card.all("details")[0]!;
    expect(d.all("summary")[0]!.textContent).toBe("See what happened");
    expect(d.textContent).toContain("The plan is ready.");
    expect(new Set(cards.map((c) => c.all("h3")[0]!.textContent)).size).toBe(2);
  });

  it("a watched failed run: the card has the stuck sentence, the run page and no label advice", () => {
    const n = { ...rec("failed", "w"), text: "Failed: remove the `ready` label.", action: "Fix it, then remove the `ready` label to start over", why: "The tests did not pass." };
    const root = view(today.todayView(model([{ ...run("w", "failed", { status: "failed" }), next: n }]), { focus: "home" }));
    const t = root.textContent;
    expect(t).not.toContain("label");
    expect(t).not.toContain("remove the");
    expect(t).not.toContain(n.text);
    expect(t).toContain("This got stuck");
    expect(root.all("details")[0]!.textContent).toContain("The tests did not pass.");
    expect(root.all("a").find((a) => a.attrs.class === "btn primary")!.attrs.href).toBe("#/runs/w");
  });

  it("a user gets no link to a page the user display lacks, and an external link opens in a new tab", () => {
    const board = { ...rec("approval", "b"), where: { label: "Look", url: "#/board" } };
    const ext = { ...rec("approval", "e"), where: { label: "Review", url: "https://github.com/o/r/pull/1" } };
    const root = view(today.todayView(model([{ ...run("b", "approval"), next: board }, { ...run("e", "approval"), next: ext }]), { focus: "home" }));
    expect(root.all("a").some((a) => a.attrs.href === "#/board")).toBe(false);
    const x = root.all("a").find((a) => a.attrs.href === "https://github.com/o/r/pull/1")!;
    expect(x.attrs.target).toBe("_blank");
    expect(x.attrs.rel).toContain("noopener");
    expect(x.textContent).toContain("↗");
  });

  it("Building now: the phase strip with the current phase, and the phase line of running work", () => {
    const r = run("b", "running", { state: { next: "implement" } });
    const root = view(today.todayView(model([r]), { focus: "home" }));
    const strip = root.all("ol")[0]!;
    expect(strip.attrs.class).toContain("scf-phase-strip");
    const current = strip.all("li").filter((li) => li.attrs["aria-current"] === "step");
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain("Build");
    expect(root.textContent).toContain("Making the change.");
    // no step: nothing is marked
    const none = view(today.todayView(model([run("c", "running")]), { focus: "home" }));
    expect(none.all("li").some((li) => li.attrs["aria-current"] === "step")).toBe(false);
  });

  it("paused work with a history and a step says what it waits for, not that it is being built", () => {
    const r = run("p", "daily_budget", { status: "waiting", history: [{ id: "implement" }], state: { next: "implement" } });
    const m = model([r]);
    expect(m.building).toHaveLength(1);
    expect(m.building[0].line).not.toBe("Making the change.");
    expect(m.building[0].line.length).toBeGreaterThan(0);
    expect(m.building[0].phase.word).toBe("Build"); // the strip still shows where it stopped
  });

  it("Finished recently: at most 5 titles and a Show all link", () => {
    const runs = Array.from({ length: 7 }, (_, i) => run(`d${i}`, "done", { status: "succeeded", finishedAt: at(0, 1 + i) }));
    const root = view(today.todayView(model(runs), { focus: "home" }));
    const sec = root.all("section").find((s) => s.attrs.class === "today-finished")!;
    expect(sec.all("li")).toHaveLength(5);
    expect(sec.all("li")[0]!.textContent).toBe("task d6"); // newest first
    expect(sec.all("a").at(-1)!.textContent).toBe("Show all");
    expect(sec.all("a").at(-1)!.attrs.href).toBe("#/runs?group=finished");
  });

  it("more than 5 cards give '+n more' to the check list", () => {
    const root = view(today.todayView(model(Array.from({ length: 7 }, (_, i) => run(`n${i}`, "approval", { startedAt: iso(i) }))), { focus: "home" }));
    expect(root.all("li").filter((l) => l.attrs.class?.includes("today-card"))).toHaveLength(5);
    const more = root.all("a").find((a) => a.textContent === "+2 more")!;
    expect(more.attrs.href).toBe("#/runs?group=check");
  });

  it("has no help button anywhere", () => {
    const root = view(today.todayView(model([run("n", "approval"), run("a", "running")]), { focus: "home" }));
    expect(root.all("button").filter((b) => b.attrs.class?.includes("help-mark"))).toEqual([]);
    expect(root.querySelectorAll("[aria-label]").some((e) => e.attrs["aria-label"] === "What does this mean?")).toBe(false);
  });

  it("empty: still the whole layout, with the first steps added", () => {
    const root = view(ui.homeView(model([])));
    expect(root.all("h1")).toHaveLength(1);
    expect(root.all("p")[0]!.textContent).toBe("Nothing needs you");
    expect(headings(root)).toEqual(["Building now", "Finished recently"]);
    expect(root.all("nav")[0]!.all("a")).toHaveLength(4);
    expect(root.textContent).toContain(ui.EMPTY);
    expect(links(root).filter((l) => l.attrs.class?.includes("primary")).map((l) => l.attrs.href)).toEqual(["#/start"]);
    // with work, no first steps
    expect(view(ui.homeView(model([run("a", "running")]))).textContent).not.toContain(ui.EMPTY);
  });

  it("every Tab stop has a unique data-focus, the audit passes and the headings step by one", () => {
    const runs = [
      ...Array.from({ length: 7 }, (_, i) => run(`running${i}`, "running", { startedAt: iso(i) })),
      ...Array.from({ length: 7 }, (_, i) => run(`approval${i}`, "approval", { startedAt: iso(i) })),
      run("d", "done", { status: "succeeded", finishedAt: at(0, 9) }),
    ];
    const root = view(today.todayView(model(runs, [job("j")]), { focus: "home" }));
    const stops = [...root.all("a").filter((a) => a.attrs.href), ...root.all("button"), ...root.all("summary")];
    const names = stops.map((s) => s.attrs["data-focus"]);
    expect(names.every(Boolean)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(audit(root)).toEqual([]);
    const levels = root.querySelectorAll("h1, h2, h3").map((e) => Number(e.tag[1]));
    levels.reduce((prev, l) => { expect(l - prev).toBeLessThanOrEqual(1); return l; }, 0);
  });

  it("keeps a disclosure open across a redraw", () => {
    const m = model([run("n", "approval")]);
    const first = view(today.todayView(m, { focus: "keep" }));
    const d = first.all("details")[0]!;
    d.fire("toggle", { target: { open: true } });
    const second = view(today.todayView(m, { focus: "keep" }));
    expect("open" in second.all("details")[0]!.attrs).toBe(true);
    second.all("details")[0]!.fire("toggle", { target: { open: false } });
    expect("open" in view(today.todayView(m, { focus: "keep" })).all("details")[0]!.attrs).toBe(false);
  });

  it("an admin sees the owner on a card; the summary counts the other needs and does not claim a clear page when unknown", () => {
    const m = today.todayModel([{ ...run("n", "approval"), ownerName: "alice" }], [], { role: "admin", now: NOON, extraNeeds: 2 });
    const root = view(today.todayView(m, { focus: "home" }));
    expect(root.textContent).toContain("Owner:");
    expect(root.all("p")[0]!.textContent).toBe("3 things need you");
    m.needsUnknown = true;
    m.extraNeeds = 0;
    m.attention = [];
    expect(text(today.todayView(m, { focus: "home" }))).not.toContain("Nothing needs you");
  });

  it("exclude leaves out the runs another panel shows, without losing the counters", () => {
    const m = today.todayModel([run("n", "approval"), run("m", "approval")], [], { now: NOON, exclude: new Set(["n"]) });
    expect(m.attention.map((c: any) => c.id)).toEqual(["m"]);
    expect(m.counts.check).toBe(2);
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

  it("draws the Advanced Home the same under every look", async () => {
    const root = (globalThis as any).document.documentElement;
    const drawn: string[] = [];
    for (const look of ["calm", "midnight", "friendly", "editorial", "bento"]) {
      root.setAttribute("data-look", look);
      const main = new FakeElement("main");
      const off = await ui.renderHome(main, { a: api([run("a", "running"), run("b", "approval")]) });
      drawn.push(JSON.stringify([main.all("h2").map((e) => e.textContent), main.all("a").map((e) => e.attrs.href)]));
      off();
    }
    delete root.attrs["data-look"];
    expect(new Set(drawn).size).toBe(1);
  });

  it("calls only runs and queue, and refreshes every 30 seconds", async () => {
    const a = api([run("a", "running")]);
    const main = new FakeElement("main");
    const off = await ui.renderHome(main, { a });
    expect(main.textContent).toContain("task a");
    expect(main.all("h1")[0]!.textContent).toMatch(/^Good /);
    expect(a.runs).toHaveBeenCalledTimes(1);
    a.runs.mockResolvedValue([run("b", "approval")]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(main.textContent).toContain("task b");
    expect(main.querySelectorAll("button").filter((b) => b.attrs.class?.includes("help-mark"))).toEqual([]);
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
