import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { audit } from "./helpers/a11y.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

// Pages that redraw themselves keep the focus on the same control, wait while a field is in use, and say a run's
// new status once. Fake DOM and fake timers; the server is a table of answers.

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let board: any;
let turn: any;
let runs: any;
let since: any;
let health: any;
let mine: any;
let next: any;
beforeAll(async () => {
  restore = installFakeDom();
  board = await import("../ui/board.js" as string);
  turn = await import("../ui/turn.js" as string);
  runs = await import("../ui/runs.js" as string);
  since = await import("../ui/since.js" as string);
  health = await import("../ui/health.js" as string);
  mine = await import("../ui/user/runs.js" as string);
  next = await import("../ui/next.js" as string);
});
afterAll(() => restore());

const doc = () => (globalThis as any).document;
const realFetch = globalThis.fetch;
let answers: Record<string, unknown>;
let asked: string[];
let winListeners: Record<string, ((e?: unknown) => void)[]>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  answers = {};
  asked = [];
  winListeners = {};
  doc().activeElement = null;
  doc().getElementById("modal-root").replaceChildren();
  doc().getElementById("main").replaceChildren();
  (globalThis as any).addEventListener = (t: string, f: (e?: unknown) => void) => (winListeners[t] ??= []).push(f);
  (globalThis as any).removeEventListener = (t: string, f: unknown) => { winListeners[t] = (winListeners[t] ?? []).filter((x) => x !== f); };
  (globalThis as any).fetch = async (url: string) => {
    asked.push(url);
    return { ok: true, status: 200, statusText: "OK", json: async () => answers[url] ?? {} };
  };
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  delete (globalThis as any).addEventListener;
  delete (globalThis as any).removeEventListener;
  delete (globalThis as any).EventSource;
});

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const flush = () => vi.advanceTimersByTimeAsync(0);

// ── helpers ──

const kids = (el: FakeElement): FakeElement[] => el.children.filter((c): c is FakeElement => c instanceof FakeElement);
const walk = (el: FakeElement, out: FakeElement[] = []): FakeElement[] => {
  for (const c of kids(el)) { out.push(c); walk(c, out); }
  return out;
};
/** The controls Tab stops at. */
const stops = (root: FakeElement) => walk(root).filter((el) =>
  (el.tag === "a" && "href" in el.attrs) || ["button", "select", "textarea", "input", "summary"].includes(el.tag) || el.attrs.tabindex === "0");
const byName = (root: FakeElement, name: string) => walk(root).find((el) => el.attrs["data-focus"] === name);
const named = (root: FakeElement, name: string) => {
  const el = byName(root, name);
  if (!el) throw new Error(`no control named ${name}`);
  return el;
};
/** Every control of the redrawn area has a name, and no name is used twice. */
function expectNamed(root: FakeElement) {
  const list = stops(root);
  expect(list.filter((el) => !el.attrs["data-focus"]).map((el) => `${el.tag} "${el.textContent.trim()}"`)).toEqual([]);
  const names = list.map((el) => el.attrs["data-focus"]);
  expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
}
/** The focus is on the control with this name, in this area, and it is a new node (the area was drawn again). */
function expectKept(root: FakeElement, name: string, before: FakeElement) {
  const now = doc().activeElement as FakeElement;
  expect(now?.attrs["data-focus"]).toBe(name);
  expect(root.contains(now)).toBe(true);
  expect(now).not.toBe(before);
}
/** audit() without the row click: it is a pointer shortcut, the link in the first cell is the keyboard way. */
function auditPage(root: FakeElement) {
  const rowWithLink = (element: string) => element.startsWith("tr");
  const rows = new Set(walk(root).filter((el) => el.tag === "tr" && kids(el)[0] && walk(kids(el)[0]!).some((a) => a.tag === "a" && "href" in a.attrs)).map(() => "tr"));
  return audit(root).filter((v) => !(v.rule === "click-needs-key" && rows.size && rowWithLink(v.element)));
}
const connected = () => { const m = new FakeElement("main"); (m as any).isConnected = true; return m; };

const stubEventSource = () => {
  const handlers: Record<string, (e: { data: string }) => void> = {};
  (globalThis as any).EventSource = class {
    static CLOSED = 2;
    readyState = 1;
    addEventListener(type: string, fn: (e: { data: string }) => void) { handlers[type] = fn; }
    close() {}
  };
  return handlers;
};
const es = () => ({ addEventListener: (t: string, f: any) => { esHandlers[t] = f; }, close() {}, readyState: 1 });
let esHandlers: Record<string, (e: { data: string }) => void> = {};

// ── Board ──

const COLS = ["your_turn", "waiting", "queued", "planning", "coding", "reviewing", "merging", "done", "failed"];
const card = (issue: number, over: Record<string, unknown> = {}) => ({
  key: `acme/app#${issue}`, issue, title: `Story ${issue}`, column: "waiting", runId: `r${issue}`, after: [], chain: [88], watcher: "w1",
  next: nextStep("dependency", { repo: "acme/app", issue, title: `Story ${issue}`, runId: `r${issue}` }, { watched: true, blockers: [{ issue: 88 }] }), ...over,
});
const boardData = (cards: any[]) => ({ repos: [{ repo: "acme/app", columns: COLS.map((id) => ({ id, title: id, cards: cards.filter((c) => c.column === id) })) }] });

describe("Board", () => {
  it("keeps the focus on a card and on its button, and is clean", async () => {
    answers["/api/board"] = boardData([card(89, { after: [88] })]);
    const main = connected();
    const stop = board.renderBoard(main, "acme/app");
    await flush();
    expectNamed(main);
    expect(auditPage(main)).toEqual([]);
    for (const name of ["card-acme/app#89", "card-acme/app#89-chain"]) {
      const before = named(main, name);
      before.focus();
      answers["/api/board"] = boardData([card(89, { after: [88], title: `changed ${name}` })]);
      await tick(5000);
      expectKept(main, name, before);
    }
    stop();
  });

  it("moves the focus to the heading when the focused card is gone", async () => {
    answers["/api/board"] = boardData([card(89), card(90)]);
    const main = connected();
    const stop = board.renderBoard(main, "acme/app");
    await flush();
    named(main, "card-acme/app#89").focus();
    answers["/api/board"] = boardData([card(90)]);
    await tick(5000);
    const h1 = main.all("h1")[0]!;
    expect(doc().activeElement).toBe(h1);
    expect(h1.attrs.tabindex).toBe("-1");
    stop();
  });

  it("does not draw a changed answer while the owner filter has the focus, and draws it when the focus has moved", async () => {
    answers["/api/board"] = boardData([card(89, { owner: "u1", ownerName: "Ann" })]);
    const main = connected();
    const stop = board.renderBoard(main, "acme/app");
    await flush();
    const select = named(main, "owner-filter");
    select.focus();
    answers["/api/board"] = boardData([card(89, { owner: "u1", ownerName: "Ann", title: "Changed" })]);
    await tick(5000);
    expect(named(main, "owner-filter")).toBe(select);
    expect(main.textContent).not.toContain("Changed");
    named(main, "card-acme/app#89").focus();
    await tick(5000);
    expect(main.textContent).toContain("Changed");
    stop();
  });
});

// ── Your turn ──

const turnItem = (issue: number, over: Record<string, unknown> = {}) => {
  const n = nextStep("closed_elsewhere", { repo: "o/a", issue, title: `T${issue}`, runId: `r${issue}` }, { issueUrl: `https://github.com/o/a/issues/${issue}` });
  return { key: `k${issue}`, repo: "o/a", what: `Item ${issue}`, next: n, since: "2026-10-01T10:00:00Z", unblocks: 0, dismissable: true, ...over };
};
const turnData = (items: any[]) => ({ count: items.length, groups: [{ repo: "o/a", items }], dismissed: 0, continuing: [] });

describe("Your turn", () => {
  it("keeps the focus on Dismiss when an item is added before it", async () => {
    answers["/api/your-turn"] = turnData([turnItem(5)]);
    const main = connected();
    const stop = await turn.renderYourTurn(main);
    expectNamed(main);
    expect(auditPage(main)).toEqual([]);
    const before = named(main, "turn-dismiss-k5");
    before.focus();
    answers["/api/your-turn"] = turnData([turnItem(4), turnItem(5)]);
    await tick(5000);
    expectKept(main, "turn-dismiss-k5", before);
    stop();
  });

  it("holds the redraw while a dialog is open and draws the newest answer after it closed", async () => {
    answers["/api/your-turn"] = turnData([turnItem(5)]);
    const main = connected();
    const stop = await turn.renderYourTurn(main);
    const opener = named(main, "turn-dismiss-k5");
    opener.focus();
    const modalRoot = doc().getElementById("modal-root") as FakeElement;
    modalRoot.append(new FakeElement("div"));
    answers["/api/your-turn"] = turnData([turnItem(5, { what: "Newest" })]);
    await tick(5000);
    expect(named(main, "turn-dismiss-k5")).toBe(opener);
    expect(main.textContent).not.toContain("Newest");
    modalRoot.replaceChildren();
    await tick(300);
    expect(main.textContent).toContain("Newest");
    expect(doc().activeElement?.attrs["data-focus"]).toBe("turn-dismiss-k5");
    stop();
  });
});

// ── Runs list ──

const approval = (id: string) => nextStep("approval", { repo: "o/r", runId: id }, {});
const RUN = (id: string, over: Record<string, unknown> = {}) => ({ runId: id, flow: `flow-${id}`, status: "waiting", startedAt: new Date().toISOString(), history: [], totalCostUsd: 0, task: "do it", vars: {}, next: approval(id), ...over });
const listAnswers = (list: any[]) => {
  answers["/api/runs"] = list;
  answers["/api/queue"] = { pending: [], active: [], concurrency: 2 };
  answers["/api/run-owners"] = [{ id: "u1", name: "Ann", runs: 1 }];
};

describe("Runs list", () => {
  it("the first cell is a link; the focus stays on it in both tables", async () => {
    listAnswers([RUN("r1")]);
    const main = connected();
    const stop = await runs.renderRunsList(main);
    expectNamed(main);
    expect(auditPage(main)).toEqual([]);
    const row = main.all("tr").find((tr) => tr.all("a").length)!;
    expect(kids(kids(row)[0]!).some((a) => a.tag === "a" && a.attrs.href === "#/runs/r1")).toBe(true);
    for (const name of ["run-r1", "needs-r1"]) {
      const before = named(main, name);
      before.focus();
      listAnswers([RUN("r1", { task: `changed ${name}` })]);
      await tick(30_000);
      expectKept(main, name, before);
    }
    stop();
  });

  it("does not ask or draw while the owner filter has the focus", async () => {
    listAnswers([RUN("r1")]);
    const main = connected();
    const stop = await runs.renderRunsList(main);
    const select = named(main, "owner-filter");
    select.focus();
    asked.length = 0;
    await tick(30_000);
    expect(asked).toEqual([]);
    expect(named(main, "owner-filter")).toBe(select);
    named(main, "run-r1").focus();
    await tick(30_000);
    expect(asked).toContain("/api/runs");
    expect(named(main, "owner-filter")).not.toBe(select);
    stop();
  });

  it("does not draw an answer that comes after the focus moved into the filter", async () => {
    listAnswers([RUN("r1")]);
    const main = connected();
    const stop = await runs.renderRunsList(main);
    named(main, "run-r1").focus();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as any).fetch = async (url: string) => {
      asked.push(url);
      await gate;
      return { ok: true, status: 200, statusText: "OK", json: async () => answers[url] ?? {} };
    };
    await tick(30_000);
    const select = named(main, "owner-filter");
    select.focus();
    release();
    await flush();
    expect(named(main, "owner-filter")).toBe(select);
    stop();
  });
});

// ── Since strip ──

const sinceAnswer = (entries: any[], over: Record<string, unknown> = {}) => ({
  since: "2026-10-01T10:00:00Z", total: entries.length, complete: false, notes: [], groups: [{ id: "waiting", label: "Waiting", count: entries.length, items: entries }], ...over,
});
const sinceEntry = (issue: number) => ({ repo: "o/a", issue, title: `Four ${issue}`, where: { label: "Open", url: "https://github.com/o/a/issues/" + issue } });
const memStore = (initial: unknown) => {
  const s: any = { data: JSON.stringify(initial), getItem: () => s.data ?? null, setItem: (_k: string, v: string) => { s.data = v; } };
  return s;
};

describe("Since strip", () => {
  const start = async (first: unknown) => {
    const main = doc().getElementById("main") as FakeElement;
    main.append(new FakeElement("h1"));
    const el = new FakeElement("div");
    const now = new Date();
    const stop = since.startSince(el, { store: memStore({ seen: now.toISOString(), from: "2026-10-01T10:00:00Z" }), now: () => new Date() });
    asked.length = 0;
    answers["/api/since?since=2026-10-01T10%3A00%3A00Z"] = first;
    await flush();
    return { el, main, stop };
  };
  const key = "/api/since?since=2026-10-01T10%3A00%3A00Z";

  it("keeps the focus on Dismiss and on an entry when a newer entry comes in above it", async () => {
    answers[key] = sinceAnswer([sinceEntry(4)]);
    const { el, stop } = await start(sinceAnswer([sinceEntry(4)]));
    expectNamed(el);
    expect(auditPage(el)).toEqual([]);
    for (const name of ["since-dismiss", "since-waiting-o/a#4-issue"]) {
      const before = named(el, name);
      before.focus();
      answers[key] = sinceAnswer([sinceEntry(5), sinceEntry(4)]);
      await tick(since.RETRY_MS + 30_000);
      expectKept(el, name, before);
    }
    stop();
  });

  it("entries with the same title and no issue get different names", async () => {
    const rel = (url: string) => ({ repo: "o/a", title: "Release", where: { label: "Open", url } });
    const { el, stop } = await start(sinceAnswer([rel("https://github.com/o/a/releases/1"), rel("https://github.com/o/a/releases/2")]));
    expectNamed(el);
    const before = named(el, "since-waiting-o/a|https://github.com/o/a/releases/2|Release-where");
    before.focus();
    answers[key] = sinceAnswer([rel("https://github.com/o/a/releases/3"), rel("https://github.com/o/a/releases/1"), rel("https://github.com/o/a/releases/2")]);
    await tick(since.RETRY_MS + 30_000);
    expectKept(el, "since-waiting-o/a|https://github.com/o/a/releases/2|Release-where", before);
    stop();
  });

  it("Dismiss moves the focus to the heading of the page", async () => {
    const { el, main, stop } = await start(sinceAnswer([sinceEntry(4)]));
    const btn = named(el, "since-dismiss");
    btn.focus();
    btn.fire("click");
    expect(el.hidden).toBe(true);
    expect(doc().activeElement).toBe(main.all("h1")[0]);
    expect(main.all("h1")[0]!.attrs.tabindex).toBe("-1");
    stop();
  });

  it("a timed empty answer moves the focus to the heading too", async () => {
    answers[key] = sinceAnswer([sinceEntry(4)]);
    const { el, main, stop } = await start(sinceAnswer([sinceEntry(4)]));
    named(el, "since-dismiss").focus();
    answers[key] = sinceAnswer([], { complete: false });
    await tick(since.RETRY_MS + 30_000);
    expect(el.hidden).toBe(true);
    expect(doc().activeElement).toBe(main.all("h1")[0]);
    stop();
  });

  it("another tab dismissing it moves the focus to the heading", async () => {
    const main = doc().getElementById("main") as FakeElement;
    main.append(new FakeElement("h1"));
    const el = new FakeElement("div");
    const store = memStore({ seen: new Date().toISOString(), from: "2026-10-01T10:00:00Z" });
    const stop = since.startSince(el, { store, now: () => new Date() });
    answers[key] = sinceAnswer([sinceEntry(4)]);
    await flush();
    named(el, "since-dismiss").focus();
    store.data = JSON.stringify({ seen: new Date().toISOString() });
    for (const f of winListeners.storage ?? []) f({ key: "scf.since" });
    expect(el.hidden).toBe(true);
    expect(doc().activeElement).toBe(main.all("h1")[0]);
    stop();
  });
});

// ── Health ──

describe("Health", () => {
  const problem = (runId: string) => nextStep("closed_elsewhere", { repo: "o/a", issue: 4, title: "Four", runId }, { issueUrl: "https://github.com/o/a/issues/4" });
  const bad = (ids: string[]) => ({ ok: false, summary: `${ids.length} problems`, problems: ids.map(problem), repos: [] });

  it("problems of the same kind without a run or issue get different names", () => {
    const el = new FakeElement("div");
    const p = (title: string) => nextStep("closed_elsewhere", { repo: "o/a", title }, { issueUrl: "https://github.com/o/a/issues/4" });
    health.renderHealth(el, { ok: false, summary: "2", problems: [p("One"), p("Two")], repos: [] });
    const names = stops(el).map((e) => e.attrs["data-focus"]);
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the focus on Cancel run; when the problem is gone the page heading takes it", async () => {
    const page = new FakeElement("div");
    const h1 = new FakeElement("h1");
    const el = new FakeElement("div");
    page.append(h1, el);
    const chip = doc().getElementById("health-btn") as FakeElement;
    answers["/api/health"] = bad(["r1"]);
    const stop = health.startHealth(el);
    await flush();
    chip.fire("click"); // the line is shown only when the chip was pressed
    expect(el.hidden).toBe(false);
    expectNamed(el);
    expect(auditPage(el)).toEqual([]);
    const before = named(el, "health-cancel-r1");
    before.focus();
    answers["/api/health"] = bad(["r0", "r1"]);
    await tick(30_000);
    expectKept(el, "health-cancel-r1", before);
    answers["/api/health"] = bad(["r0"]);
    await tick(30_000);
    expect(doc().activeElement).toBe(h1);
    expect(h1.attrs.tabindex).toBe("-1");
    stop();
  });

  it("says 'does not answer' once, as an alert", async () => {
    const el = new FakeElement("div");
    (globalThis as any).fetch = async (url: string) => {
      asked.push(url);
      throw new TypeError("down");
    };
    const stop = health.startHealth(el);
    try {
      await flush();
      const b = el.all("b")[0]!;
      expect(b.attrs.role).toBe("alert");
      expect(auditPage(el)).toEqual([]);
      await tick(30_000);
      expect(el.all("b")[0]).toBe(b);
    } finally {
      stop();
    }
  });

  it("does not redraw while the Cancel dialog is open, and the focus goes back to Cancel run", async () => {
    const el = new FakeElement("div");
    const chip = doc().getElementById("health-btn") as FakeElement;
    answers["/api/health"] = bad(["r1"]);
    const stop = health.startHealth(el);
    try {
      await flush();
      chip.fire("click");
      const before = named(el, "health-cancel-r1");
      before.focus();
      before.click();
      await flush();
      answers["/api/health"] = bad(["r0", "r1"]);
      await tick(30_000);
      expect(named(el, "health-cancel-r1")).toBe(before);
      const keep = (doc().getElementById("modal-root") as FakeElement).all("button").find((b) => b.textContent === "Keep running")!;
      keep.click();
      await tick(250);
      expectKept(el, "health-cancel-r1", before);
      expect(asked.some((u) => u.includes("/cancel"))).toBe(false);
    } finally {
      stop();
    }
  });
});

// ── My runs ──

const myRun = (id: string, over: Record<string, unknown> = {}) => ({ runId: id, flow: `flow-${id}`, task: "t", status: "running", startedAt: new Date().toISOString(), vars: {}, history: [], next: nextStep("running", { runId: id }, {}), ...over });
const myJob = (id: string) => ({ runId: id, kind: "run", enqueuedAt: new Date().toISOString(), task: "q", ahead: 0, next: nextStep("queued", { runId: id }, {}) });

describe("My runs", () => {
  it("keeps the focus on a link and on Remove, and moves it to the heading when the card is removed", async () => {
    let runsNow: any[] = [myRun("r1")];
    let queueNow: any[] = [myJob("q1")];
    const a = { runs: async () => runsNow, queue: async () => ({ pending: queueNow }) };
    const main = connected();
    const stop = await mine.renderMyRuns(main, { a });
    const list = main.children[2] as FakeElement;
    expectNamed(list);
    expect(auditPage(main)).toEqual([]);
    for (const name of ["open-r1", "remove-q1"]) {
      const before = named(list, name);
      before.focus();
      runsNow = [myRun("r1", { task: name })];
      await tick(30_000);
      expectKept(list, name, before);
    }
    queueNow = [];
    await tick(30_000);
    expect(doc().activeElement).toBe(main.all("h1")[0]);
    expect(main.all("h1")[0]!.attrs.tabindex).toBe("-1");
    stop();
  });

  it("does not draw while the Remove dialog is open, and draws the newest answer after it", async () => {
    let runsNow: any[] = [myRun("r1")];
    const a = { runs: async () => runsNow, queue: async () => ({ pending: [myJob("q1")] }) };
    let answer!: (v: boolean) => void;
    const ask = () => new Promise<boolean>((r) => { answer = r; });
    const main = connected();
    const stop = await mine.renderMyRuns(main, { a, ask });
    const list = main.children[2] as FakeElement;
    const opener = named(list, "remove-q1");
    opener.focus();
    opener.fire("click");
    runsNow = [myRun("r1", { flow: "Newest" })];
    await tick(30_000);
    expect(named(list, "remove-q1")).toBe(opener);
    answer(false);
    await flush();
    expect(list.textContent).toContain("Newest");
    expect(doc().activeElement?.attrs["data-focus"]).toBe("remove-q1");
    stop();
  });
});

// ── The run pages ──

describe("User run page", () => {
  it("keeps the focus on Cancel of a queued run", async () => {
    const a = {
      run: async () => { throw Object.assign(new Error("none"), { status: 404 }); },
      queue: async () => ({ pending: [myJob("r1")] }),
      events: () => es(),
    };
    const main = connected();
    const stop = mine.renderMyRun(main, "r1", { a });
    await flush();
    const head = main.children[0] as FakeElement;
    expect(auditPage(head)).toEqual([]);
    const before = named(head, "act-cancel");
    before.focus();
    await tick(30_000);
    expectKept(head, "act-cancel", before);
    stop();
  });

  it("the run log is a labelled live region the keyboard can scroll", async () => {
    const a = { run: async () => myRun("r1"), queue: async () => ({ pending: [] }), events: () => es() };
    const main = connected();
    const stop = mine.renderMyRun(main, "r1", { a });
    await flush();
    const log = named(main, "log");
    expect(log.attrs).toMatchObject({ role: "log", "aria-live": "polite", "aria-label": "Run log", tabindex: "0" });
    esHandlers.log!({ data: JSON.stringify({ line: "▶ step" }) });
    expect(auditPage(main).filter((v) => v.element.includes("log"))).toEqual([]);
    stop();
  });

  it("announces a new status once, through the stream and through refresh()", async () => {
    let current: any = myRun("r1");
    const a = { run: async () => current, queue: async () => ({ pending: [] }), events: () => es() };
    const main = connected();
    const stop = mine.renderMyRun(main, "r1", { a });
    await flush();
    const region = main.all("div").find((d) => d.attrs.role === "status")!;
    expect(region.textContent).toBe("");
    const waiting = myRun("r1", { status: "waiting", next: approval("r1") });
    const send = (s: unknown) => esHandlers.update!({ data: JSON.stringify({ summary: s }) });
    send(myRun("r1"));
    expect(region.textContent).toBe("");
    send(waiting);
    expect(region.textContent).toBe(`Run status: ${waiting.next.status}`);
    region.textContent = "";
    send(waiting);
    expect(region.textContent).toBe("");
    current = waiting;
    await tick(0);
    stop();
  });
});

describe("Admin run page", () => {
  const FLOW = { steps: [{ id: "a" }, { id: "b" }] };
  const stopped = (over: Record<string, unknown> = {}) => RUN("r1", { status: "stopped", state: { next: "a" }, flowDef: FLOW, next: nextStep("usage_limit", { repo: "o/r", runId: "r1" }), ...over });

  it("keeps the focus on its controls, and is clean", async () => {
    const handlers = stubEventSource();
    answers["/api/users"] = [];
    const main = connected();
    const stop = runs.renderRunDetail(main, "r1");
    const head = main.children[0] as FakeElement;
    handlers.update!({ data: JSON.stringify({ summary: RUN("r1", { next: undefined }) }) });
    const s = RUN("r1", { status: "waiting" });
    handlers.update!({ data: JSON.stringify({ summary: s }) });
    expectNamed(head);
    expect(auditPage(head)).toEqual([]);
    const before = named(head, "act-approve");
    before.focus();
    handlers.update!({ data: JSON.stringify({ summary: { ...s, task: "changed" } }) });
    expectKept(head, "act-approve", before);
    stop();
  });

  it("does not replace the retry select while it has the focus, and draws the held update after the focus left", async () => {
    const handlers = stubEventSource();
    const main = connected();
    const stop = runs.renderRunDetail(main, "r1", { admin: false });
    const head = main.children[0] as FakeElement;
    const send = (s: unknown) => handlers.update!({ data: JSON.stringify({ summary: s }) });
    send(stopped());
    const select = named(head, "act-retry-from");
    expect(select.attrs["aria-label"]).toBe("Re-run from a step");
    select.focus();
    send(stopped({ task: "Held text" }));
    expect(named(head, "act-retry-from")).toBe(select);
    expect(head.textContent).not.toContain("Held text");
    named(head, "back").focus();
    head.fire("focusout");
    await tick(0);
    expect(head.textContent).toContain("Held text");
    stop();
  });

  it("a late answer of the users call does not draw over an update that is held", async () => {
    const handlers = stubEventSource();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    (globalThis as any).fetch = async (url: string) => {
      if (url === "/api/users") await gate;
      return { ok: true, status: 200, statusText: "OK", json: async () => [] };
    };
    const main = connected();
    const stop = runs.renderRunDetail(main, "r1");
    const head = main.children[0] as FakeElement;
    const send = (s: unknown) => handlers.update!({ data: JSON.stringify({ summary: s }) });
    send(stopped());
    named(head, "act-retry-from").focus();
    send(stopped({ task: "Newest text" }));
    release();
    await flush();
    expect(head.textContent).not.toContain("Newest text");
    named(head, "back").focus();
    head.fire("focusout");
    await tick(0);
    expect(head.textContent).toContain("Newest text");
    stop();
  });

  it("the run log is a labelled live region; the status is announced once", async () => {
    const handlers = stubEventSource();
    const main = connected();
    const stop = runs.renderRunDetail(main, "r1", { admin: false });
    const log = named(main, "log");
    expect(log.attrs).toMatchObject({ role: "log", "aria-live": "polite", "aria-label": "Run log", tabindex: "0" });
    handlers.log!({ data: JSON.stringify({ line: "✔ done" }) });
    expect(auditPage(main).filter((v) => v.element.includes("log"))).toEqual([]);
    const region = main.all("div").find((d) => d.attrs.role === "status")!;
    const send = (s: unknown) => handlers.update!({ data: JSON.stringify({ summary: s }) });
    send(RUN("r1", { status: "running", next: nextStep("running", { runId: "r1" }, {}) }));
    expect(region.textContent).toBe("");
    send(RUN("r1", { status: "running", next: nextStep("running", { runId: "r1" }, {}) }));
    expect(region.textContent).toBe("");
    const waiting = RUN("r1", { status: "waiting" });
    send(waiting);
    expect(region.textContent).toBe(`Run status: ${waiting.next.status}`);
    region.textContent = "";
    send(waiting);
    expect(region.textContent).toBe("");
    stop();
  });
});

// ── The "?" and the rows ──

describe("helpMark", () => {
  it("is a button that Escape closes, without reaching a dialog around it", () => {
    const m = next.helpMark("One. Two.", "x-help") as FakeElement;
    const btn = m.all("button")[0]!;
    expect(btn.attrs).toMatchObject({ type: "button", "aria-expanded": "false", "data-focus": "x-help" });
    const stopPropagation = vi.fn();
    btn.fire("keydown", { key: "Escape", stopPropagation });
    expect(stopPropagation).not.toHaveBeenCalled();
    btn.click();
    expect(btn.attrs["aria-expanded"]).toBe("true");
    btn.fire("keydown", { key: "Enter", stopPropagation });
    expect(btn.attrs["aria-expanded"]).toBe("true");
    btn.fire("keydown", { key: "Escape", stopPropagation });
    expect(btn.attrs["aria-expanded"]).toBe("false");
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("rows", () => {
  it("runRow has a link to the run in its first cell", () => {
    const row = runs.runRow(RUN("r1")) as FakeElement;
    const link = row.all("td")[0]!.all("a")[0]!;
    expect(link.attrs.href).toBe("#/runs/r1");
    expect(link.attrs["data-focus"]).toBe("run-r1");
    expect(link.attrs["aria-label"]).toContain("open run flow-r1");
  });
});
