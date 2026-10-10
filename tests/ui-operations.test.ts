import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ui: any;
let health: any;
let auth: any;
beforeAll(async () => {
  restore = installFakeDom();
  ui = await import("../ui/operations.js" as string);
  health = await import("../ui/health.js" as string);
  auth = await import("../ui/auth.js" as string);
});
afterAll(() => restore());

const read = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

describe("watcherSummary", () => {
  it("counts, lists the problems and finds the oldest good check", () => {
    const s = ui.watcherSummary([
      { id: "a", enabled: true, status: { lastOk: "2026-10-02T00:00:00Z" } },
      { id: "b", enabled: true, status: { lastOk: "2026-10-01T00:00:00Z", lastError: "boom\nsecond line" } },
      { id: "c", enabled: false, problem: "blocked: no token" },
      { id: "d", enabled: true },
    ]);
    expect(s).toEqual({
      total: 4, enabled: 3,
      problems: [{ id: "b", text: "boom" }, { id: "c", text: "blocked: no token" }],
      oldestOk: "2026-10-01T00:00:00Z", neverOk: 1,
    });
  });
  it("gives zeros for nothing", () => {
    for (const w of [[], undefined]) expect(ui.watcherSummary(w)).toEqual({ total: 0, enabled: 0, problems: [], oldestOk: null, neverOk: 0 });
  });
  it("cuts a long text to 200 characters", () => {
    expect(ui.watcherSummary([{ id: "a", enabled: true, problem: "x".repeat(300) }]).problems[0].text).toHaveLength(200);
  });
});

describe("queueSummary", () => {
  it("counts and shows the first five", () => {
    const pending = Array.from({ length: 7 }, (_, i) => ({ runId: `r${i}`, flow: "f" }));
    const s = ui.queueSummary({ active: [{}, {}], pending, concurrency: 3 });
    expect(s).toMatchObject({ running: 2, waiting: 7, concurrency: 3, more: 2 });
    expect(s.first).toHaveLength(5);
  });
  it("names the work, passes next and owner on, and never shows the task", () => {
    const s = ui.queueSummary({ active: [], pending: [
      { runId: "r1", flow: "fix", githubRepo: "o/a", issue: 4, ownerName: "Ann", next: { text: "waits" }, task: "secret" },
      { runId: "r2", kind: "resume" },
    ] });
    expect(s.first[0]).toEqual({ runId: "r1", what: "fix · o/a#4", next: "waits", owner: "Ann" });
    expect(s.first[1]).toEqual({ runId: "r2", what: "resume", next: "", owner: "" });
    expect(JSON.stringify(s)).not.toContain("secret");
  });
  it("gives zeros for nothing", () => {
    for (const q of [{}, undefined]) expect(ui.queueSummary(q)).toMatchObject({ running: 0, waiting: 0, first: [], more: 0 });
  });
});

describe("limitSummary", () => {
  it("reads the budget and whether limits are enforced", () => {
    expect(ui.limitSummary({ spentToday: 2, dailyBudget: 5 }, {}).spend).toEqual({ spentToday: 2, dailyBudget: 5, enforced: true });
    expect(ui.limitSummary({}, {}).spend).toEqual({ spentToday: 0, dailyBudget: undefined, enforced: true });
    expect(ui.limitSummary({ costLimits: false }, {}).spend.enforced).toBe(false);
  });
  it("lists the accounts at a limit", () => {
    const s = ui.limitSummary({}, { byUser: [{ name: "Ann", atLimit: ["dailyBudgetUsd"] }, { name: "Bob", atLimit: [] }] });
    expect(s.atLimit).toEqual([{ name: "Ann", fields: ["dailyBudgetUsd"] }]);
    expect(ui.limitSummary({}, {}).atLimit).toEqual([]);
  });
  it("gives null for a missing source", () => {
    expect(ui.limitSummary(undefined, undefined)).toEqual({ spend: null, atLimit: null });
  });
});

describe("providerSummary", () => {
  it("puts agents first and counts the ready ones", () => {
    const s = ui.providerSummary({
      agents: [{ agent: "claude", installed: true, detail: "1.0" }, { agent: "codex", installed: true, loggedIn: false, detail: "no login" }],
      providers: [{ name: "local", ok: false, detail: "down" }],
    });
    expect(s.rows.map((r: any) => [r.kind, r.name, r.ready])).toEqual([["agent", "claude", true], ["agent", "codex", false], ["provider", "local", false]]);
    expect(s).toMatchObject({ ready: 1, total: 3 });
  });
  it("gives zeros for nothing", () => {
    expect(ui.providerSummary({})).toEqual({ rows: [], ready: 0, total: 0 });
  });
});

// ---- the page ----

interface Call { method: string; url: string }
let calls: Call[];
let answers: Record<string, any>;
let failing: Set<string>;
let held: Map<string, (() => void)[]>;
let holdAll: (() => void)[][] | null;
const realFetch = globalThis.fetch;
const realConfirm = (globalThis as any).confirm;

const goodHealth = { ok: true, summary: "All good", problems: [], repos: [], monitorFindings: { open: 2, total: 5 } };
const stuck = { ok: false, summary: "A problem", problems: [{ kind: "closed_elsewhere", runId: "r1", repo: "o/a", issue: 4, title: "Four", action: "cancel" }], repos: [] };
const audit10 = { entries: Array.from({ length: 10 }, (_, i) => ({ time: "2026-10-01T08:00:00.000Z", actor: { type: "system" }, action: `act-${i}`, target: { type: "run", id: `r${i}` } })) };

const defaults = (): Record<string, any> => ({
  "/api/health": goodHealth,
  "/api/stats": { byUser: [{ name: "Ann", atLimit: ["dailyBudgetUsd"] }, { name: "Bob", atLimit: [] }] },
  "/api/info": { spentToday: 1.5, dailyBudget: 10 },
  "/api/queue": { active: [{ runId: "a1" }], pending: [{ runId: "p1", flow: "fix", githubRepo: "o/a", issue: 4, ownerName: "Ann", next: { text: "waits for a slot" }, task: "TOPSECRET" }], concurrency: 2 },
  "/api/watchers": [{ id: "w1", enabled: true, status: { lastOk: "2026-10-01T00:00:00Z" } }, { id: "w2", enabled: true, status: { lastError: "bad token\nmore" } }],
  "/api/providers": { agents: [{ agent: "claude", installed: true, detail: "1.0" }], providers: [{ name: "local", ok: false, detail: "down" }] },
  "/api/audit": audit10,
});
const GETS = Object.keys(defaults());

beforeEach(() => {
  calls = [];
  answers = defaults();
  failing = new Set();
  held = new Map();
  holdAll = null;
  (globalThis as any).location = { hash: "#/operations" };
  (document as any).getElementById("modal-root").replaceChildren();
  (globalThis as any).fetch = async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const wait = holdAll?.shift() ?? null;
    if (wait) await new Promise<void>((r) => wait.push(r));
    if (method === "POST" && url.endsWith("/cancel")) {
      return failing.has(url) ? { ok: false, status: 500, statusText: "x", json: async () => ({ error: "cancel broke" }) } : { ok: true, status: 200, statusText: "x", json: async () => ({}) };
    }
    if (failing.has(url)) return { ok: false, status: 500, statusText: "x", json: async () => ({ error: `${url} broke` }) };
    return { ok: true, status: 200, statusText: "x", json: async () => answers[url] };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  (globalThis as any).confirm = realConfirm;
  delete (globalThis as any).location;
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const main = () => (document as any).getElementById("main") as FakeElement;
const walk = (el: FakeElement): FakeElement[] => el.children.flatMap((c) => (c instanceof FakeElement ? [c, ...walk(c)] : []));
const h3s = () => walk(main()).filter((e) => e.tag === "h3").map((e) => e.textContent);
const cardOf = (title: string) => walk(main()).find((e) => e.tag === "div" && e.attrs.class?.startsWith("card") && e.children.some((c) => c instanceof FakeElement && c.tag === "h3" && c.textContent === title))!;
const tileOf = (label: string) => walk(main()).find((e) => e.attrs.class === "tile" && e.textContent.startsWith(label))!;
const hrefs = () => walk(main()).filter((e) => e.tag === "a").map((e) => e.attrs.href);
const root = () => (document as any).getElementById("modal-root") as FakeElement;
const dialogButton = (text: string) => root().all("button").find((b) => b.textContent === text)!;
const show = () => ui.renderOperations(main());
const getsOnly = () => calls.filter((c) => c.method === "GET").map((c) => c.url);
const CARDS = ["Health", "Problems", "Providers", "Queue", "Watchers", "Limits", "Recent audit"];

describe("the page", () => {
  it("draws seven cards with their links and no button", async () => {
    await show();
    expect(h3s()).toEqual(CARDS);
    for (const l of ["#/problems", "#/models", "#/runs", "#/watchers", "#/settings", "#/users", "#/audit"]) expect(hrefs()).toContain(l);
    expect(walk(main()).find((e) => e.attrs.class === "health ok")!.textContent).toContain("All good");
    expect(cardOf("Recent audit").all("tr")).toHaveLength(1 + 8);
    expect(cardOf("Queue").textContent).toContain("p1");
    expect(cardOf("Queue").textContent).toContain("waits for a slot");
    expect(main().textContent).not.toContain("TOPSECRET");
    expect(cardOf("Limits").textContent).toContain("Spent today $1.50 of $10.00 daily budget.");
    expect(cardOf("Limits").textContent).toContain("Ann");
    expect(cardOf("Problems").textContent).toContain("2 open of 5 stored");
    expect(walk(main()).filter((e) => e.tag === "button")).toEqual([]);
    expect(getsOnly().sort()).toEqual([...GETS].sort());
    expect(calls).toHaveLength(7);
  });

  it("shows a skeleton and no card while the answers are out", async () => {
    const waits: (() => void)[][] = Array.from({ length: 7 }, () => []);
    holdAll = [...waits];
    const p = show();
    await flush();
    expect(walk(main()).filter((e) => e.attrs.class?.startsWith("skeleton "))).toHaveLength(1);
    expect(h3s()).toEqual([]);
    waits.forEach((w) => w.forEach((r) => r()));
    await p;
    expect(h3s()).toEqual(CARDS);
  });

  it("uses the same sentences as the health band", async () => {
    await show();
    const plain = (document as any).createElement("div");
    health.renderHealth(plain, goodHealth);
    expect(walk(main()).find((e) => e.attrs.class === "health ok")!.textContent).toBe(plain.textContent);
  });

  it("does not draw an oldest check for watchers that never succeeded", async () => {
    answers["/api/watchers"] = [{ id: "w1", enabled: true }];
    await show();
    expect(cardOf("Watchers").textContent).not.toContain("Oldest successful check");
    expect(cardOf("Watchers").textContent).toContain("1 enabled without a successful check yet");
    answers["/api/watchers"] = [];
    await show();
    expect(cardOf("Watchers").textContent).not.toContain("Oldest successful check");
    expect(cardOf("Watchers").textContent).toContain("0 of 0 enabled");
  });

  it("says the no-budget and not-enforced sentences", async () => {
    answers["/api/info"] = { spentToday: 1 };
    await show();
    expect(cardOf("Limits").textContent).toContain("Spent today $1.00. No daily budget set.");
    expect(tileOf("Spent today").textContent).toContain("no daily budget set");
    answers["/api/info"] = { spentToday: 1, costLimits: false };
    await show();
    expect(cardOf("Limits").textContent).toContain("No limits are enforced.");
  });

  it("shows empty texts", async () => {
    answers["/api/queue"] = { active: [], pending: [], concurrency: 1 };
    answers["/api/audit"] = { entries: [] };
    answers["/api/stats"] = {};
    answers["/api/health"] = { ...goodHealth, monitorFindings: undefined };
    await show();
    expect(cardOf("Queue").textContent).toContain("Nothing is waiting.");
    expect(cardOf("Recent audit").textContent).toContain("No entries.");
    expect(cardOf("Limits").textContent).toContain("No account is at a limit.");
    expect(cardOf("Problems").textContent).toContain("No findings stored.");
  });

  it("puts server text in as text", async () => {
    answers["/api/watchers"] = [{ id: "w1", enabled: true, problem: "<img src=x onerror=1>" }];
    await show();
    expect(cardOf("Watchers").textContent).toContain("<img src=x onerror=1>");
    expect(walk(main()).filter((e) => e.tag === "img")).toEqual([]);
  });
});

describe("Cancel run", () => {
  beforeEach(() => { answers["/api/health"] = stuck; });
  const cancelButton = () => walk(main()).filter((e) => e.tag === "button");

  it("is the only button; Keep running sends nothing", async () => {
    await show();
    expect(cancelButton().map((b) => b.textContent)).toEqual(["Cancel run"]);
    cancelButton()[0]!.click();
    await flush();
    dialogButton("Keep running").click();
    await flush();
    expect(calls).toHaveLength(7);
  });

  it("posts the cancel and asks everything again", async () => {
    await show();
    cancelButton()[0]!.click();
    await flush();
    dialogButton("Cancel the run").click();
    await flush();
    await flush();
    expect(calls[7]).toEqual({ method: "POST", url: "/api/runs/r1/cancel" });
    expect(calls.slice(8).map((c) => c.url).sort()).toEqual([...GETS].sort());
  });

  it("goes on after a failed cancel and does not reject", async () => {
    failing.add("/api/runs/r1/cancel");
    await show();
    cancelButton()[0]!.click();
    await flush();
    dialogButton("Cancel the run").click();
    await flush();
    await flush();
    expect(calls).toHaveLength(7 + 1 + 7);
  });

  it("does not redraw when the person left the page", async () => {
    await show();
    cancelButton()[0]!.click();
    await flush();
    (globalThis as any).location.hash = "#/users";
    dialogButton("Cancel the run").click();
    await flush();
    await flush();
    expect(calls).toHaveLength(8);
  });
});

describe("a failing call", () => {
  const NA = "Not available";
  // url, cards that say Not available, tiles that show "—"
  it.each([
    ["/api/health", ["Health", "Problems"], ["Problems"]],
    ["/api/queue", ["Queue"], ["Queue"]],
    ["/api/watchers", ["Watchers"], ["Watchers"]],
    ["/api/providers", ["Providers"], []],
    ["/api/info", ["Limits"], ["Spent today"]],
    ["/api/stats", ["Limits"], []],
    ["/api/audit", ["Recent audit"], []],
  ])("%s only hurts what depends on it", async (url, cards, tiles) => {
    failing.add(url);
    await show();
    expect(h3s()).toEqual(CARDS);
    for (const c of CARDS) {
      const text = cardOf(c).textContent;
      if (cards.includes(c)) {
        expect(text, c).toContain(NA);
        expect(text, c).toContain(`${url} broke`);
      } else expect(text, c).not.toContain(NA);
    }
    for (const t of ["Problems", "Queue", "Watchers", "Spent today"]) {
      expect(tileOf(t).textContent.includes("—"), t).toBe(tiles.includes(t));
    }
    for (const l of ["#/problems", "#/models", "#/runs", "#/watchers", "#/settings", "#/users", "#/audit"]) expect(hrefs()).toContain(l);
    if (url === "/api/info") expect(cardOf("Limits").textContent).toContain("Ann");
    if (url === "/api/stats") expect(cardOf("Limits").textContent).toContain("Spent today $1.50");
  });
});

describe("late answers", () => {
  it("drops an answer that arrives after the person left", async () => {
    holdAll = Array.from({ length: 7 }, () => []);
    const waits = [...holdAll];
    const p = show();
    await flush();
    (globalThis as any).location.hash = "#/users";
    main().replaceChildren();
    for (const w of waits) w.forEach((r) => r());
    await p;
    expect(main().children).toHaveLength(0);
  });

  it("an old cleanup does not stop the newer render", async () => {
    const a: (() => void)[][] = Array.from({ length: 7 }, () => []);
    const b: (() => void)[][] = Array.from({ length: 7 }, () => []);
    holdAll = [...a, ...b];
    const pa = show();
    await flush();
    const pb = show();
    await flush();
    a.forEach((w) => w.forEach((r) => r()));
    const offA = await pa;
    offA();
    b.forEach((w) => w.forEach((r) => r()));
    await pb;
    expect(h3s()).toEqual(CARDS);
  });

  it("a new render draws after the cleanup of a finished one", async () => {
    const off = await show();
    off();
    await show();
    expect(h3s()).toEqual(CARDS);
  });
});

describe("wiring", () => {
  it("is routed and keeps to the rules", () => {
    expect(read("ui/app.js")).toContain('from "./operations.js"');
    expect(read("ui/app.js")).toContain('section === "operations"');
    const src = read("ui/operations.js");
    expect(src).not.toContain("innerHTML");
    expect(src).not.toContain("setInterval");
    expect(src).not.toContain("confirm(");
    expect(src).toContain('location.hash.split("?")[0].split("/")[1]');
  });
  it("is not a user page", () => {
    expect(auth.userHash("#/operations")).toBe("#/runs");
  });
});
