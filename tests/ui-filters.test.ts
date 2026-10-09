import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let f: any;
let ia: any;
let runs: any;
let mine: any;
beforeAll(async () => {
  restore = installFakeDom();
  f = await import("../ui/filters.js" as string);
  ia = await import("../ui/ia.js" as string);
  runs = await import("../ui/runs.js" as string);
  mine = await import("../ui/user/runs.js" as string);
});
afterAll(() => restore());

const click = (el: FakeElement) => el.listeners.click![0]!();
const byClass = (root: FakeElement, cls: string) => root.all("div").filter((e) => (e.attrs.class ?? "").split(" ").includes(cls));
const button = (root: FakeElement, text: string) => root.all("button").find((b) => b.textContent === text)!;

describe("parseQuery", () => {
  it("reads the known keys with or without the ?, encoded or raw", () => {
    expect(f.parseQuery("?repo=acme%2Fapp&owner=u-1")).toEqual({ repo: "acme/app", owner: "u-1" });
    expect(f.parseQuery("repo=acme%2Fapp&owner=u-1")).toEqual({ repo: "acme/app", owner: "u-1" });
    expect(f.parseQuery("repo=acme/app")).toEqual({ repo: "acme/app" });
  });

  it("drops unknown keys and bad values", () => {
    expect(f.parseQuery("x=1&repo=acme%2Fapp&__proto__=1&constructor=2")).toEqual({ repo: "acme/app" });
    for (const bad of ["acme", "a/b/c", "a b/c", "<x>/y", `${"a".repeat(100)}/${"b".repeat(100)}`]) expect(f.parseQuery(`repo=${encodeURIComponent(bad)}`), bad).toEqual({});
    for (const bad of ["a/b", "a b", "a".repeat(65)]) expect(f.parseQuery(`owner=${encodeURIComponent(bad)}`), bad).toEqual({});
  });

  it("ignores bad encoding, empty values and handles odd input", () => {
    expect(f.parseQuery("repo=%E0%A4%A&owner=u1")).toEqual({ owner: "u1" });
    expect(f.parseQuery("repo=&owner=")).toEqual({});
    for (const t of ["", "?", undefined, null, 5]) expect(f.parseQuery(t), String(t)).toEqual({});
    expect(f.parseQuery("owner=u1&owner=u2")).toEqual({ owner: "u1" });
    expect(f.parseQuery("owner=a%2Fb&owner=u2")).toEqual({ owner: "u2" });
  });

  it("gives a plain object with only own keys repo and owner", () => {
    const q = f.parseQuery("repo=a%2Fb&owner=u1&x=1");
    expect(Object.keys(q).sort()).toEqual(["owner", "repo"]);
  });
});

describe("formatQuery and withQuery", () => {
  it("writes nothing for no filter, a fixed order and %2F", () => {
    expect(f.formatQuery({})).toBe("");
    expect(f.formatQuery(undefined)).toBe("");
    expect(f.formatQuery({ owner: "u1", repo: "acme/app" })).toBe("?repo=acme%2Fapp&owner=u1");
    expect(f.withQuery("#/runs", { owner: "u1" })).toBe("#/runs?owner=u1");
    expect(f.withQuery("#/runs", {})).toBe("#/runs");
  });

  it("leaves out invalid values and round-trips", () => {
    expect(f.formatQuery({ repo: "nope", owner: "a b" })).toBe("");
    for (const x of [{}, { repo: "a/b" }, { owner: "u-1" }, { repo: "a.b/c_d", owner: "x" }]) expect(f.parseQuery(f.formatQuery(x))).toEqual(x);
  });
});

describe("splitHash, sameRepo, without", () => {
  it("splits at the first ?", () => {
    expect(f.splitHash("#/runs?repo=a%2Fb")).toEqual({ path: "#/runs", query: "repo=a%2Fb" });
    expect(f.splitHash("#/runs")).toEqual({ path: "#/runs", query: "" });
    expect(f.splitHash("#/runs?")).toEqual({ path: "#/runs", query: "" });
    expect(f.splitHash(undefined)).toEqual({ path: "", query: "" });
  });

  it("matches repositories ignoring case, never an empty one", () => {
    expect(f.sameRepo("Acme/App", "acme/app")).toBe(true);
    expect(f.sameRepo(undefined, "acme/app")).toBe(false);
    expect(f.sameRepo("", "")).toBe(false);
    expect(f.without({ repo: "a/b", owner: "u" }, "repo")).toEqual({ owner: "u" });
  });
});

describe("filterBar and filterEmpty", () => {
  it("is null without a filter", () => expect(f.filterBar({}, {})).toBeNull());

  it("draws chips in a fixed order, with labels or raw values, and calls back", () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    const bar = f.filterBar({ owner: "u1", repo: "acme/app" }, { labels: { owner: "Ann" }, onRemove, onClear }) as FakeElement;
    expect(byClass(bar as any, "filter-bar").length + (bar.attrs.class === "filter-bar" ? 1 : 0)).toBeGreaterThan(0);
    const chips = bar.all("span").filter((s) => s.attrs.class === "filter-chip");
    expect(chips.map((c) => c.textContent.replace("×", ""))).toEqual(["Repository: acme/app", "Owner: Ann"]);
    click(chips[0]!.all("button")[0]!);
    click(chips[1]!.all("button")[0]!);
    expect(onRemove.mock.calls).toEqual([["repo"], ["owner"]]);
    click(button(bar, "Clear filters"));
    expect(onClear).toHaveBeenCalledOnce();
    expect(f.filterBar({ owner: "u1" }, {}).textContent).toContain("Owner: u1");
  });

  it("draws a value as text, never as HTML", () => {
    const bar = f.filterBar({ repo: "<b>x</b>" }, {}) as FakeElement;
    expect(bar.textContent).toContain("<b>x</b>");
    expect(bar.all("b")).toHaveLength(0);
  });

  it("filterEmpty names the filters, shows the note and clears", () => {
    const onClear = vi.fn();
    const el = f.filterEmpty("runs", { repo: "a/b", owner: "u1" }, { labels: { owner: "Ann" }, note: "A note.", onClear }) as FakeElement;
    expect(el.textContent).toContain("No runs match Repository: a/b, Owner: Ann.");
    expect(el.textContent).toContain("A note.");
    click(button(el, "Clear filters"));
    expect(onClear).toHaveBeenCalledOnce();
    expect(f.filterEmpty("cards", { owner: "u9" }, {}).textContent).not.toContain("A note.");
  });

  it("names the buttons after `focus`, with the default `filter`", () => {
    const names = (el: FakeElement) => el.all("button").map((b) => b.attrs["data-focus"]);
    const filters = { repo: "a/b", owner: "u1" };
    expect(names(f.filterBar(filters))).toEqual(["filter-remove-repo", "filter-remove-owner", "filter-clear"]);
    expect(names(f.filterBar(filters, { focus: "x" }))).toEqual(["x-remove-repo", "x-remove-owner", "x-clear"]);
    expect(names(f.filterEmpty("runs", filters))).toEqual(["filter-empty-clear"]);
    expect(names(f.filterEmpty("runs", filters, { focus: "x" }))).toEqual(["x-empty-clear"]);
    const all = [...names(f.filterBar(filters)), ...names(f.filterEmpty("runs", filters))];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("the routers", () => {
  it("every page that checks the address compares the path without the query", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["refinement", "repos", "admin-repos", "admin-credentials", "users", "audit"]) {
      const src = readFileSync(`ui/${file}.js`, "utf8");
      expect(src, file).toMatch(/location\.hash( \?\? "")?\)?\.split\("\?"\)\[0\]\.split\("\/"\)\[1\]/);
      expect(src, file).not.toMatch(/location\.hash( \?\? "")?\)?\.split\("\/"\)/);
    }
  });

  it("the admin router passes the query and a way to write the address", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("ui/app.js", "utf8");
    expect(app).toContain("renderRunsList(box, { admin: true, query: to.query, go })");
    expect(app).toContain("renderBoard(main, arg, { query: to.query, go })");
    expect(app).toContain("const { path } = splitHash(hash);");
    expect(app).toContain('path !== "#/new"');
  });
});

describe("ui/style.css", () => {
  it("has the filter bar and chip rules", async () => {
    const css = (await import("./helpers/ui-css.js")).readUiCss();
    expect(css).toContain(".filter-bar {");
    expect(css).toContain(".filter-chip {");
  });
});

describe("the admin Runs list", () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  const mk = (id: string, repo: string, over: any = {}) => ({ runId: id, flow: `flow-${id}`, status: "succeeded", startedAt: new Date().toISOString(), history: [], totalCostUsd: 0, task: `task ${id}`, vars: { github_repo: repo }, ...over });
  const pend = (id: string, repo?: string) => ({ runId: id, kind: "run", githubRepo: repo, ahead: 0 });
  let answers: Record<string, unknown>;
  let delay: Record<string, (() => void)[]> = {};
  let hold = false;

  beforeEach(() => {
    vi.useFakeTimers();
    asked.length = 0;
    hold = false;
    delay = {};
    answers = {
      "/api/runs": [mk("r1", "acme/app"), mk("r2", "other/thing"), mk("r3", "Acme/App")],
      "/api/runs?owner=u2": [mk("r4", "acme/app"), mk("r5", "other/thing")],
      "/api/queue": { pending: [pend("q1", "acme/app"), pend("q2", "other/thing")], active: [], concurrency: 2 },
      "/api/run-owners": [{ id: "u1", name: "Ann", runs: 3 }, { id: "u2", name: "Bob", runs: 2 }],
    };
    (globalThis as any).fetch = (url: string) => {
      asked.push(url);
      const respond = () => ({ ok: true, status: 200, statusText: "OK", json: async () => answers[url] ?? {} });
      if (hold && url.startsWith("/api/runs")) return new Promise((resolve) => (delay[url] ??= []).push(() => resolve(respond())));
      return Promise.resolve(respond());
    };
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  const connected = () => {
    const m = new FakeElement("div") as FakeElement & { isConnected: boolean };
    m.isConnected = true;
    return m;
  };
  const rows = (m: FakeElement) => m.all("tr").filter((r) => r.attrs.class === "link").map((r) => r.all("b")[0]!.textContent);
  const chips = (m: FakeElement) => m.all("span").filter((s) => s.attrs.class === "filter-chip").map((s) => s.textContent.replace("×", ""));
  const queued = (m: FakeElement) => m.all("span").filter((s) => s.attrs.class === "mono").map((s) => s.textContent);
  const pick = (m: FakeElement, value: string) => m.all("select")[0]!.fire("change", { target: { value } });

  it("filters runs and queued jobs by repository, ignoring case, with one request each", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "ACME/app" }, go });
    expect(rows(m)).toEqual(["flow-r1", "flow-r3"]);
    expect(queued(m)).toEqual(["q1"]);
    expect(chips(m)).toEqual(["Repository: ACME/app"]);
    expect(asked).toEqual(["/api/runs", "/api/queue", "/api/run-owners"]);
    expect(go).not.toHaveBeenCalled();
    stop();
  });

  it("with no filter there is no bar and go is never called", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, go });
    expect(byClass(m, "filter-bar")).toHaveLength(0);
    expect(rows(m)).toHaveLength(3);
    expect(go).not.toHaveBeenCalled();
    stop();
  });

  it("asks for the owner on the first draw, preselects it, and writes the address on a change", async () => {
    const m = connected();
    const go = vi.fn();
    answers["/api/runs?owner=u1"] = [mk("r6", "acme/app")];
    const stop = await runs.renderRunsList(m, { admin: true, query: { owner: "u2" }, go });
    expect(asked[0]).toBe("/api/runs?owner=u2");
    expect(m.all("option").find((o) => o.attrs.selected !== undefined)?.textContent).toBe("Bob (2)");
    expect(chips(m)).toEqual(["Owner: Bob"]);
    pick(m, "u1");
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenLastCalledWith("#/runs?owner=u1");
    expect(asked.at(-3)).toBe("/api/runs?owner=u1");
    pick(m, "");
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenLastCalledWith("#/runs");
    stop();
  });

  it("keeps the repository in the address when the owner changes", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app" }, go });
    pick(m, "u2");
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenLastCalledWith("#/runs?repo=acme%2Fapp&owner=u2");
    expect(rows(m)).toEqual(["flow-r4"]);
    stop();
  });

  it("removing only the repository chip filters what is here and asks the server for nothing", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app" }, go });
    const before = asked.length;
    click(m.all("span").find((s) => s.attrs.class === "filter-chip")!.all("button")[0]!);
    expect(asked).toHaveLength(before);
    expect(go).toHaveBeenCalledWith("#/runs");
    expect(rows(m)).toHaveLength(3);
    expect(byClass(m, "filter-bar")).toHaveLength(0);
    stop();
  });

  it("Clear filters clears both and reloads once for the owner", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app", owner: "u2" }, go });
    click(button(m, "Clear filters"));
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenCalledWith("#/runs");
    expect(asked.at(-3)).toBe("/api/runs");
    expect(rows(m)).toHaveLength(3);
    stop();
  });

  it("a filter that matches nothing names the filter and Clear filters restores the list", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "other/repo" }, go: vi.fn() });
    expect(m.textContent).toContain("No runs match Repository: other/repo.");
    expect(rows(m)).toHaveLength(0);
    click(button(m, "Clear filters"));
    expect(rows(m)).toHaveLength(3);
    stop();
  });

  it("a matching queued job is a result: no empty state beside the Queue card", async () => {
    answers["/api/runs"] = [mk("r2", "other/thing")];
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app" }, go: vi.fn() });
    expect(queued(m)).toEqual(["q1"]);
    expect(m.textContent).not.toContain("No runs match");
    stop();
  });

  it("notes the 200-run cap only with a repository filter", async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => mk(`x${i}`, "acme/app"));
    for (const [n, repo, note] of [[200, "acme/app", true], [199, "acme/app", false], [200, undefined, false]] as const) {
      answers["/api/runs"] = many(n);
      const m = connected();
      const stop = await runs.renderRunsList(m, { admin: true, query: repo ? { repo } : {}, go: vi.fn() });
      expect(m.textContent.includes(runs.CAP_NOTE), `${n} ${repo}`).toBe(note);
      stop();
    }
    answers["/api/runs"] = many(200);
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "none/here" }, go: vi.fn() });
    expect(m.textContent).toContain(runs.CAP_NOTE);
    stop();
  });

  it("keeps the filters after the 30 second refresh", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app", owner: "u2" }, go: vi.fn() });
    asked.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(asked).toContain("/api/runs?owner=u2");
    expect(rows(m)).toEqual(["flow-r4"]);
    expect(chips(m)).toEqual(["Repository: acme/app", "Owner: Bob"]);
    stop();
  });

  it("a user list ignores the owner and never asks for owners", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: false, query: { owner: "u1", repo: "acme/app" }, go: vi.fn() });
    expect(new Set(asked)).toEqual(new Set(["/api/runs", "/api/queue"]));
    expect(chips(m)).toEqual(["Repository: acme/app"]);
    stop();
  });

  it("an older answer does not overwrite a newer one, and a page that was left is not drawn on", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, go: vi.fn() });
    hold = true;
    pick(m, "u1");
    pick(m, "u2");
    await vi.advanceTimersByTimeAsync(0);
    answers["/api/runs?owner=u1"] = [mk("old", "acme/app")];
    delay["/api/runs?owner=u2"]![0]!();
    await vi.advanceTimersByTimeAsync(0);
    delay["/api/runs?owner=u1"]![0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(rows(m)).toEqual(["flow-r4", "flow-r5"]);
    pick(m, "");
    await vi.advanceTimersByTimeAsync(0);
    stop();
    const text = m.textContent;
    delay["/api/runs"]![0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(m.textContent).toBe(text);
  });

  it("when the server fails after an owner change, the address and the filter go back", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app" }, go });
    const ok = (globalThis as any).fetch;
    (globalThis as any).fetch = (url: string) => (url.startsWith("/api/runs?owner=u1") ? Promise.reject(new Error("boom")) : ok(url));
    const before = rows(m);
    pick(m, "u1");
    await vi.advanceTimersByTimeAsync(0);
    expect(go.mock.calls.map((c) => c[0])).toEqual(["#/runs?repo=acme%2Fapp&owner=u1", "#/runs?repo=acme%2Fapp"]);
    expect(rows(m)).toEqual(before);
    expect(chips(m)).toEqual(["Repository: acme/app"]);
    stop();
  });

  it("round trip: the address a change writes reproduces the view", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app" }, go });
    pick(m, "u2");
    await vi.advanceTimersByTimeAsync(0);
    const again = connected();
    const stop2 = await runs.renderRunsList(again, { admin: true, query: ia.resolve("admin", go.mock.calls.at(-1)![0]).query, go: vi.fn() });
    expect(rows(again)).toEqual(rows(m));
    expect(chips(again)).toEqual(chips(m));
    stop();
    stop2();
  });
});

describe("My runs", () => {
  const iso = (min: number) => new Date(Date.UTC(2026, 0, 1, 12, 0) - min * 60_000).toISOString();
  const run = (id: string, repo: string, min = 10) => ({ runId: id, flow: `flow-${id}`, task: `task ${id}`, status: "running", startedAt: iso(min), vars: { github_repo: repo }, history: [], next: nextStep("running", { runId: id }) });
  const job = (id: string, repo: string) => ({ runId: id, kind: "run", enqueuedAt: iso(1), task: `queued ${id}`, githubRepo: repo, ahead: 0, next: nextStep("queued", { runId: id }) });
  let data: { runs: any[]; pending: any[] };
  let a: any;
  const open = async (opts: any = {}) => {
    const main = document.createElement("div") as unknown as FakeElement;
    const stop = (await mine.renderMyRuns(main, { a, ...opts })) as () => void;
    return { main, stop };
  };
  const cards = (m: FakeElement) => m.all("li").map((li) => li.textContent);

  beforeEach(() => {
    vi.useFakeTimers();
    data = { runs: [run("r1", "o/r"), run("r2", "x/y", 20)], pending: [job("j1", "o/r"), job("j2", "x/y")] };
    a = { runs: vi.fn(async () => data.runs), queue: vi.fn(async () => ({ pending: data.pending, active: [] })), cancelRun: vi.fn() };
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shows only the matching runs and queued jobs for ?repo=", async () => {
    const { main, stop } = await open({ query: { repo: "O/R" }, go: vi.fn() });
    expect(cards(main)).toHaveLength(2);
    expect(cards(main).join(" ")).toContain("flow-r1");
    expect(cards(main).join(" ")).toContain("queued j1");
    expect(cards(main).join(" ")).not.toContain("flow-r2");
    expect(main.textContent).toContain("Repository: O/R");
    stop();
  });

  it("ignores ?owner= and asks for the runs without an argument", async () => {
    const { main, stop } = await open({ query: { owner: "u9" }, go: vi.fn() });
    expect(cards(main)).toHaveLength(4);
    expect(byClass(main, "filter-bar")).toHaveLength(0);
    expect(a.runs).toHaveBeenCalledWith();
    stop();
  });

  it("removes the chip, writes #/runs and shows everything, without a new request", async () => {
    const go = vi.fn();
    const { main, stop } = await open({ query: { repo: "o/r" }, go });
    const calls = a.runs.mock.calls.length;
    click(main.all("span").find((s) => s.attrs.class === "filter-chip")!.all("button")[0]!);
    expect(go).toHaveBeenCalledWith("#/runs");
    expect(cards(main)).toHaveLength(4);
    expect(a.runs.mock.calls.length).toBe(calls);
    stop();
  });

  it("an empty match shows the filter and Clear filters, not the no-runs text", async () => {
    const { main, stop } = await open({ query: { repo: "no/pe" }, go: vi.fn() });
    expect(main.textContent).toContain("No runs match Repository: no/pe.");
    expect(main.textContent).not.toContain(mine.NO_RUNS);
    click(button(main, "Clear filters"));
    expect(cards(main)).toHaveLength(4);
    stop();
  });

  it("notes the cap with a repository filter, whether or not anything matches", async () => {
    data.runs = Array.from({ length: 200 }, (_, i) => run(`x${i}`, i === 0 ? "o/r" : "x/y"));
    for (const repo of ["o/r", "no/pe"]) {
      const { main, stop } = await open({ query: { repo }, go: vi.fn() });
      expect(main.textContent, repo).toContain(runs.CAP_NOTE);
      stop();
    }
    const { main, stop } = await open({ go: vi.fn() });
    expect(main.textContent).not.toContain(runs.CAP_NOTE);
    stop();
  });

  it("keeps the filter after the 30 second timer", async () => {
    const { main, stop } = await open({ query: { repo: "o/r" }, go: vi.fn() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.runs.mock.calls.length).toBeGreaterThan(1);
    expect(cards(main)).toHaveLength(2);
    stop();
  });
});
