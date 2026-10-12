import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nextStep } from "../src/next-step.js";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let f: any;
let ia: any;
let runs: any;
let mine: any;
let rf: any;
beforeAll(async () => {
  restore = installFakeDom();
  rf = await import("../ui/runs-filter.js" as string);
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

  it("reads repo=all, exactly", () => {
    expect(f.parseQuery("repo=all")).toEqual({ repo: "all" });
    expect(f.parseQuery("?repo=all&owner=u1")).toEqual({ repo: "all", owner: "u1" });
    for (const t of ["repo=All", "repo=ALL"]) expect(f.parseQuery(t), t).toEqual({});
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

  it("writes repo=all", () => {
    expect(f.formatQuery({ repo: "all" })).toBe("?repo=all");
    expect(f.withQuery("#/runs", { repo: "all", owner: "u1" })).toBe("#/runs?repo=all&owner=u1");
    expect(f.parseQuery(f.formatQuery({ repo: "all" }))).toEqual({ repo: "all" });
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

describe("the context offer", () => {
  afterEach(() => f.setContextOffer(null));
  const offer = (onUse = vi.fn()) => ({ label: "All repositories", onUse });
  const texts = (bar: FakeElement) => bar.all("button").map((b) => b.textContent);

  it("contextOffer is null by default, takes an object or a function, and null when the function throws", () => {
    expect(f.contextOffer()).toBeNull();
    const o = offer();
    f.setContextOffer(o);
    expect(f.contextOffer()).toBe(o);
    f.setContextOffer((arg: unknown) => ({ ...o, label: JSON.stringify(arg) }));
    expect(f.contextOffer({ repo: "x/y" }).label).toBe('{"repo":"x/y"}');
    f.setContextOffer(() => { throw new Error("no"); });
    expect(f.contextOffer()).toBeNull();
  });

  it("with no chips the bar names the scope and has no Clear filters", () => {
    f.setContextOffer(offer());
    const bar = f.filterBar({}, {}) as FakeElement;
    expect(bar.textContent).toContain("All repositories");
    expect(texts(bar)).toEqual(["Use as my context"]);
    expect(bar.all("button")[0]!.attrs["data-focus"]).toBe("filter-context");
  });

  it("with an owner chip: the chip, Clear filters, the scope and the button, in that order; no scope text with a repository chip", () => {
    f.setContextOffer(offer());
    const bar = f.filterBar({ owner: "u1" }, {}) as FakeElement;
    expect(texts(bar)).toEqual(["×", "Clear filters", "Use as my context"]);
    expect(bar.textContent.indexOf("Owner: u1")).toBeLessThan(bar.textContent.indexOf("All repositories"));
    expect(f.filterBar({ repo: "a/b" }, {}).textContent).not.toContain("All repositories");
  });

  it("a click calls onUse once and hides the button; the bar goes too when it had no chips", () => {
    const onUse = vi.fn();
    f.setContextOffer(offer(onUse));
    const bare = f.filterBar({}, {}) as FakeElement;
    const [scope] = bare.all("span");
    click(button(bare, "Use as my context"));
    expect(onUse).toHaveBeenCalledOnce();
    expect(button(bare, "Use as my context").hidden).toBe(true);
    expect(scope!.hidden).toBe(true);
    expect(bare.hidden).toBe(true);
    const chips = f.filterBar({ owner: "u1" }, {}) as FakeElement;
    click(button(chips, "Use as my context"));
    expect(button(chips, "Use as my context").hidden).toBe(true);
    expect(chips.hidden).toBeFalsy();
  });

  it("onContext: null shows no offer; an explicit offer wins over the registered one", () => {
    f.setContextOffer(offer());
    expect(f.filterBar({}, { onContext: null })).toBeNull();
    expect(texts(f.filterBar({ owner: "u1" }, { onContext: null }))).toEqual(["×", "Clear filters"]);
    const mine = { label: "Repository: x/y", onUse: vi.fn() };
    const bar = f.filterBar({}, { onContext: mine }) as FakeElement;
    expect(bar.textContent).toContain("Repository: x/y");
    click(button(bar, "Use as my context"));
    expect(mine.onUse).toHaveBeenCalledOnce();
  });

  it("refreshContextOffer hides the offer of a bar on the page once the source has none", () => {
    f.setContextOffer(offer());
    const bar = f.filterBar({ owner: "u1" }, {}) as FakeElement;
    f.refreshContextOffer();
    expect(button(bar, "Use as my context").hidden).toBeFalsy();
    f.setContextOffer(() => null);
    f.refreshContextOffer();
    expect(button(bar, "Use as my context").hidden).toBe(true);
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

describe("githubOf, matchesRepo, filterGone", () => {
  it("reads owner/name from every stored GitHub form", () => {
    for (const url of ["https://github.com/o/n", "https://github.com/o/n.git", "git@github.com:o/n", "git@github.com:o/n.git", "ssh://git@github.com/o/n.git", "https://github.com/o/n/", "https://github.com/o/n.git.git"]) {
      expect(f.githubOf(url), url).toBe("o/n");
    }
    expect(f.githubOf("https://github.com/O/N/")).toBe("O/N");
  });

  it("keeps a repository that is named .git", () => {
    expect(f.githubOf("https://github.com/o/.git")).toBe("o/.git");
    expect(f.githubOf("git@github.com:o/.git.git")).toBe("o/.git");
    expect(f.matchesRepo({ url: "https://github.com/o/.git" }, "o/.git")).toBe(true);
  });

  it("gives an empty text for anything else", () => {
    for (const url of ["https://gitlab.com/o/n", "https://github.com/o", "https://github.com/o/n/x", "https://evil.com/github.com/o/n", "", undefined, 5]) {
      expect(f.githubOf(url), String(url)).toBe("");
    }
  });

  it("matchesRepo prefers github, falls back to the address and ignores case", () => {
    expect(f.matchesRepo({ github: "o/a", url: "https://github.com/o/b" }, "O/A")).toBe(true);
    expect(f.matchesRepo({ github: "o/a", url: "https://github.com/o/b" }, "o/b")).toBe(false);
    expect(f.matchesRepo({ url: "git@github.com:O/A.git" }, "o/a")).toBe(true);
    expect(f.matchesRepo({}, "o/a")).toBe(false);
    expect(f.matchesRepo({ url: "https://github.com/o/a" }, "")).toBe(false);
  });

  it("filterGone has a fixed text and clears", () => {
    const onClear = vi.fn();
    const el = f.filterGone({ onClear }) as FakeElement;
    expect(el.textContent).toContain(f.NOT_IN_LIST);
    expect(f.NOT_IN_LIST).toBe("This repository is not in your list. It may have been removed, or you may not have access.");
    click(button(el, "Clear filters"));
    expect(onClear).toHaveBeenCalledOnce();
  });
});

describe("the routers", () => {
  it("every page that checks the address compares the path without the query", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["admin-credentials", "operations", "users", "audit"]) {
      const src = readFileSync(`ui/${file}.js`, "utf8");
      expect(src, file).toMatch(/location\.hash( \?\? "")?\)?\.split\("\?"\)\[0\]\.split\("\/"\)\[1\]/);
      expect(src, file).not.toMatch(/location\.hash( \?\? "")?\)?\.split\("\/"\)/);
    }
    for (const file of ["refinement", "repos"]) {
      const src = readFileSync(`ui/${file}.js`, "utf8");
      expect(src, file).toContain("splitHash(location.hash");
      expect(src, file).not.toMatch(/location\.hash( \?\? "")?\)?\.split\(/);
    }
  });

  it("the routers pass the query to the repository pages", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("ui/app.js", "utf8");
    expect(app).toContain("renderAllRepos(main, { query: to.query, go })");
    expect(app).toContain("renderRefinement(main, { admin: true, id: arg, query: to.query, go })");
    expect(app).toContain("renderRepos(box, { admin: true, switcher: true, query: to.query, go })");
    const user = readFileSync("ui/user/app.js", "utf8");
    expect(user).toContain("renderRefinement(box, { admin: false, id: page.id, readOnly, query: to.query, go })");
    expect(user).toContain("renderRepos(box, { admin: false, readOnly, query: to.query, go })");
  });

  it("the admin router passes the query and a way to write the address", async () => {
    const { readFileSync } = await import("node:fs");
    const app = readFileSync("ui/app.js", "utf8");
    expect(app).toContain("renderRunsList(box, { admin: true, query: to.query, go, filter: parseFilter(hash), alive: () => mine === routeGen })");
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
      "/api/run-filters": { repos: [], flows: [] },
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
  const rows = (m: FakeElement) => m.all("li").map((r) => r.all("b")[0]!.textContent).filter((t) => t !== "Queued run");
  const chips = (m: FakeElement) => m.all("span").filter((s) => s.attrs.class === "filter-chip").map((s) => s.textContent.replace("×", ""));
  const queued = (m: FakeElement) => m.all("a").map((a) => a.attrs["data-focus"] ?? "").filter((n) => n.startsWith("open-q")).map((n) => n.slice(5));
  const named = (m: FakeElement, name: string) => m.all("select").find((s) => s.attrs["data-focus"] === name)!;
  const val = (m: FakeElement, name: string) => named(m, name).value;
  const pick = (m: FakeElement, value: string, name = "owner-filter") => named(m, name).fire("change", { target: { value } });
  const runsAsked = () => asked.filter((u) => u.startsWith("/api/runs"));

  it("filters runs and queued jobs by repository, ignoring case, with one request each", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "ACME/app" }, go });
    expect(rows(m)).toEqual(["flow-r1", "flow-r3"]);
    expect(queued(m)).toEqual(["q1"]);
    expect(val(m, "runs-repo")).toBe("ACME/app");
    expect(asked).toEqual(["/api/run-filters", "/api/run-owners", "/api/queue", "/api/runs"]);
    expect(go).not.toHaveBeenCalled();
    stop();
  });

  it("with no filter there are no chips, Clear filters is hidden and go is never called", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, go });
    expect(byClass(m, "filter-bar")).toHaveLength(0);
    expect(button(m, "Clear filters").hidden).toBe(true);
    expect(rows(m)).toHaveLength(3);
    expect(go).not.toHaveBeenCalled();
    stop();
  });

  it("asks for the owner on the first draw, preselects it, and writes the address on a change", async () => {
    const m = connected();
    const go = vi.fn();
    answers["/api/runs?owner=u1"] = [mk("r6", "acme/app")];
    const stop = await runs.renderRunsList(m, { admin: true, query: { owner: "u2" }, go });
    expect(asked).toContain("/api/runs?owner=u2");
    expect(val(m, "owner-filter")).toBe("u2");
    pick(m, "u1");
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenLastCalledWith("#/runs?owner=u1");
    expect(runsAsked().at(-1)).toBe("/api/runs?owner=u1");
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

  it("clearing the repository of a name the server does not know asks again and shows everything", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app" }, go });
    expect(rows(m)).toEqual(["flow-r1", "flow-r3"]);
    pick(m, "", "runs-repo");
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenCalledWith("#/runs");
    expect(rows(m)).toHaveLength(3);
    expect(button(m, "Clear filters").hidden).toBe(true);
    stop();
  });

  const box = (m: FakeElement) => m.all("input").find((i) => i.attrs["data-focus"] === "runs-search")!;
  const type = (m: FakeElement, text: string) => { const b = box(m); b.value = text; b.fire("input", { target: b }); };
  const say = (m: FakeElement) => m.all("div").find((d) => d.attrs.role === "status" && d.attrs["aria-live"] === "polite" && d.attrs.class === "sr-only" && d.parent?.attrs.class === "runs-bar")!;
  const start = (m: FakeElement, hash: string, go: any = vi.fn()) => runs.renderRunsList(m, { admin: true, go, filter: rf.parseFilter(hash) });

  it("a cold load of the repository in any letter case asks the server for the name of the list", async () => {
    answers["/api/run-filters"] = { repos: ["Acme/App", "other/thing"], flows: [] };
    answers["/api/runs?repo=Acme%2FApp"] = [mk("far", "Acme/App")];
    const m = connected();
    const stop = await start(m, "#/runs?repo=ACME/APP");
    expect(asked).toEqual(["/api/run-filters", "/api/run-owners", "/api/queue", "/api/runs?repo=Acme%2FApp"]);
    expect(rows(m)).toEqual(["flow-far"]);
    expect(val(m, "runs-repo")).toBe("Acme/App");
    stop();
  });

  it("two spellings of one repository are both asked and merged, newest first, without doubles", async () => {
    answers["/api/run-filters"] = { repos: ["Acme/App", "acme/app"], flows: [] };
    answers["/api/runs?repo=Acme%2FApp"] = [mk("a1", "Acme/App", { startedAt: "2026-01-01T00:00:00Z" }), mk("dup", "Acme/App", { startedAt: "2026-01-03T00:00:00Z" })];
    answers["/api/runs?repo=acme%2Fapp"] = [mk("b1", "acme/app", { startedAt: "2026-01-02T00:00:00Z" }), mk("dup", "Acme/App", { startedAt: "2026-01-03T00:00:00Z" })];
    const m = connected();
    const stop = await start(m, "#/runs?repo=acme/app");
    expect(runsAsked().sort()).toEqual(["/api/runs?repo=Acme%2FApp", "/api/runs?repo=acme%2Fapp"]);
    expect(rows(m)).toEqual(["flow-dup", "flow-b1", "flow-a1"]);
    stop();
  });

  it("sends search, flow, status, time and owner to the server, but not needs or view", async () => {
    answers["/api/run-filters"] = { repos: ["acme/app"], flows: ["flow-r1"] };
    const m = connected();
    const go = vi.fn();
    const stop = await start(m, "#/runs", go);
    pick(m, "flow-r1", "runs-flow");
    await vi.advanceTimersByTimeAsync(0);
    pick(m, "failed", "runs-status");
    await vi.advanceTimersByTimeAsync(0);
    pick(m, "7d", "runs-time");
    await vi.advanceTimersByTimeAsync(0);
    pick(m, "u1");
    await vi.advanceTimersByTimeAsync(0);
    type(m, "boom");
    await vi.advanceTimersByTimeAsync(300);
    const last = runsAsked().at(-1)!;
    const p = new URLSearchParams(last.split("?")[1]);
    expect([...p.keys()]).toEqual(["q", "flow", "status", "since", "owner"]);
    expect(p.get("since")).toBe(rf.sinceOf("7d", Date.now()));
    expect(go).toHaveBeenLastCalledWith("#/runs?q=boom&flow=flow-r1&status=failed&time=7d&owner=u1");
    named(m, "runs-status").fire("change", { target: { value: "" } });
    await vi.advanceTimersByTimeAsync(0);
    asked.length = 0;
    m.all("input").find((i) => i.attrs["data-focus"] === "runs-needs")!.fire("change", { target: { checked: true } });
    button(m, "Failed").fire("click");
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.filter((u) => u.startsWith("/api/runs"))).toHaveLength(0);
    expect(go).toHaveBeenLastCalledWith("#/runs?q=boom&flow=flow-r1&time=7d&owner=u1&needs=1&view=failed");
    stop();
  });

  it("typing asks the server once, 300 ms after the last key, and the box keeps node, text and focus over a refresh", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await start(m, "#/runs", go);
    const b = box(m);
    b.focus();
    type(m, "a");
    await vi.advanceTimersByTimeAsync(200);
    type(m, "ab");
    await vi.advanceTimersByTimeAsync(100);
    click(m.all("button").find((x) => x.attrs["data-focus"] === "refresh")!);
    await vi.advanceTimersByTimeAsync(150);
    type(m, "abc");
    expect(runsAsked().filter((u) => u.includes("q="))).toHaveLength(0);
    expect(box(m)).toBe(b);
    expect(b.value).toBe("abc");
    await vi.advanceTimersByTimeAsync(299);
    expect(runsAsked().filter((u) => u.includes("q="))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(runsAsked().filter((u) => u.includes("q="))).toEqual(["/api/runs?q=abc"]);
    expect(go).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(box(m)).toBe(b);
    expect(b.value).toBe("abc");
    expect((document as any).activeElement).toBe(b);
    stop();
  });

  it("another control takes the pending text with it", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await start(m, "#/runs", go);
    type(m, "pending");
    pick(m, "failed", "runs-status");
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenLastCalledWith("#/runs?q=pending&status=failed");
    await vi.advanceTimersByTimeAsync(500);
    expect(go).toHaveBeenCalledTimes(1);
    expect(runsAsked().filter((u) => u.includes("q="))).toEqual(["/api/runs?q=pending&status=failed"]);
    stop();
  });

  it("queued jobs without a run follow repository, flow, time, search and owner, and are hidden under a status", async () => {
    const at = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    answers["/api/runs"] = [];
    answers["/api/queue"] = { active: [], concurrency: 2, pending: [
      { runId: "qa", kind: "run", githubRepo: "acme/app", flow: "f1", enqueuedAt: at, ownerName: "Ann", issue: "7", task: "fix the login", ahead: 0 },
      { runId: "qb", kind: "run", githubRepo: "other/thing", flow: "f2", enqueuedAt: old, ownerName: "Bob", task: "other", ahead: 0 },
    ] };
    const check = async (hash: string, expected: string[]) => {
      const m = connected();
      const stop = await start(m, hash);
      expect(queued(m), hash).toEqual(expected);
      stop();
    };
    await check("#/runs", ["qa", "qb"]);
    await check("#/runs?repo=ACME/app", ["qa"]);
    await check("#/runs?flow=f2", ["qb"]);
    await check("#/runs?time=30d", ["qa"]);
    await check("#/runs?q=%237", ["qa"]);
    await check("#/runs?q=LOGIN", ["qa"]);
    await check("#/runs?owner=u2", ["qb"]);
    await check("#/runs?status=running", []);
  });

  it("a filter change always redraws, also for an answer equal to the old one: count and empty state follow", async () => {
    const m = connected();
    const stop = await start(m, "#/runs");
    expect(say(m).textContent).toBe("");
    answers["/api/runs?owner=u1"] = answers["/api/runs"];
    pick(m, "u1");
    await vi.advanceTimersByTimeAsync(0);
    expect(say(m).textContent).toBe("3 runs match.");
    pick(m, "", "owner-filter");
    await vi.advanceTimersByTimeAsync(0);
    expect(say(m).textContent).toBe("");
    answers["/api/runs?status=failed"] = [];
    answers["/api/queue"] = { pending: [], active: [], concurrency: 2 };
    pick(m, "failed", "runs-status");
    await vi.advanceTimersByTimeAsync(0);
    expect(m.textContent).toContain("No runs match your search and filters.");
    answers["/api/runs?status=succeeded"] = [];
    pick(m, "succeeded", "runs-status");
    await vi.advanceTimersByTimeAsync(0);
    expect(m.textContent).toContain("No runs match your search and filters.");
    expect(say(m).textContent).toBe("0 runs match.");
    stop();
  });

  it("says 1 run matches", async () => {
    answers["/api/runs?status=failed"] = [mk("only", "acme/app")];
    answers["/api/queue"] = { pending: [], active: [], concurrency: 2 };
    const m = connected();
    const stop = await start(m, "#/runs?status=failed");
    expect(say(m).textContent).toBe("1 run matches.");
    stop();
  });

  it("no match: Clear filters restores #/runs and the list", async () => {
    answers["/api/runs?status=failed"] = [];
    answers["/api/queue"] = { pending: [], active: [], concurrency: 2 };
    const m = connected();
    const go = vi.fn();
    const stop = await start(m, "#/runs?status=failed", go);
    expect(rows(m)).toHaveLength(0);
    click(m.all("button").find((b) => b.attrs["data-focus"] === "runs-empty-clear")!);
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenLastCalledWith("#/runs");
    expect(rows(m)).toHaveLength(3);
    expect(val(m, "runs-status")).toBe("");
    stop();
  });

  it("200 runs with a server-side filter say only the newest 200 matches are shown", async () => {
    answers["/api/runs?status=failed"] = Array.from({ length: 200 }, (_, i) => mk(`x${i}`, "acme/app"));
    const m = connected();
    const stop = await start(m, "#/runs?status=failed");
    expect(m.textContent).toContain(runs.MATCH_NOTE);
    expect(m.textContent).not.toContain(runs.CAP_NOTE);
    stop();
  });

  it("a failed reload puts address, bar and list back and shows the error", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await start(m, "#/runs?status=failed", go);
    const ok = (globalThis as any).fetch;
    (globalThis as any).fetch = (url: string) => (url.includes("status=succeeded") ? Promise.reject(new Error("boom")) : ok(url));
    const before = rows(m);
    pick(m, "succeeded", "runs-status");
    await vi.advanceTimersByTimeAsync(0);
    expect(go.mock.calls.map((c) => c[0])).toEqual(["#/runs?status=succeeded", "#/runs?status=failed"]);
    expect(val(m, "runs-status")).toBe("failed");
    expect(rows(m)).toEqual(before);
    expect((document as any).getElementById("toast").textContent).toContain("boom");
    stop();
  });

  it("a change overtaken by a newer one that fails goes back to what was drawn, not to the overtaken one", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await start(m, "#/runs", go);
    const ok = (globalThis as any).fetch;
    (globalThis as any).fetch = (url: string) => (url.includes("owner=u1") ? new Promise(() => {}) : url.includes("owner=u2") ? Promise.reject(new Error("boom")) : ok(url));
    const before = rows(m);
    pick(m, "u1");
    await vi.advanceTimersByTimeAsync(0);
    pick(m, "u2");
    await vi.advanceTimersByTimeAsync(0);
    expect(go.mock.calls.map((c) => c[0])).toEqual(["#/runs?owner=u1", "#/runs?owner=u2", "#/runs"]);
    expect(val(m, "owner-filter")).toBe("");
    expect(rows(m)).toEqual(before);
    stop();
  });

  it("after the page was left nothing is asked and the address is not written", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await start(m, "#/runs", go);
    type(m, "late");
    stop();
    const n = asked.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toHaveLength(n);
    expect(go).not.toHaveBeenCalled();
  });

  it("a page left while the lists load does not ask for the runs", async () => {
    let open = true;
    const m = connected();
    const done = runs.renderRunsList(m, { admin: true, go: vi.fn(), filter: rf.parseFilter("#/runs"), alive: () => open });
    open = false;
    await vi.advanceTimersByTimeAsync(0);
    (await done)();
    expect(runsAsked()).toEqual([]);
  });

  it("a refresh queued while the first load is pending starts nothing once the page was left", async () => {
    let open = true;
    let release!: () => void;
    const ok = (globalThis as any).fetch;
    (globalThis as any).fetch = (url: string) => (url === "/api/run-filters" && !release
      ? new Promise((r) => { release = () => r(ok(url)); })
      : ok(url));
    const m = connected();
    const done = runs.renderRunsList(m, { admin: true, go: vi.fn(), filter: rf.parseFilter("#/runs"), alive: () => open });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000); // a tick queues a follow-up request
    open = false;
    const n = asked.length;
    release();
    await vi.advanceTimersByTimeAsync(0);
    (await done)();
    expect(asked.slice(n).filter((u) => u !== "/api/run-filters")).toEqual([]);
    expect(runsAsked()).toEqual([]);
  });

  it("an active saved owner view keeps working with more filters", async () => {
    const parts = vi.fn(() => ({}));
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, go: vi.fn(), filter: rf.parseFilter("#/runs?owner=u1&status=failed"), views: { parts } });
    expect(parts.mock.calls[0]![0]).toEqual({ owner: "u1" });
    expect(parts.mock.calls[0]![1].owners).toEqual(["u1", "u2"]);
    stop();
  });

  it("Clear filters clears both and reloads once for the owner", async () => {
    const m = connected();
    const go = vi.fn();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app", owner: "u2" }, go });
    click(button(m, "Clear filters"));
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenCalledWith("#/runs");
    expect(runsAsked().at(-1)).toBe("/api/runs");
    expect(rows(m)).toHaveLength(3);
    stop();
  });

  it("a filter that matches nothing names the filter and Clear filters restores the list", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "other/repo" }, go: vi.fn() });
    expect(m.textContent).toContain("No runs match your search and filters.");
    expect(rows(m)).toHaveLength(0);
    click(m.all("button").find((b) => b.attrs["data-focus"] === "runs-empty-clear")!);
    await vi.advanceTimersByTimeAsync(0);
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
    expect(val(m, "runs-repo")).toBe("acme/app");
    expect(val(m, "owner-filter")).toBe("u2");
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
    await vi.advanceTimersByTimeAsync(0);
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
    expect(val(m, "owner-filter")).toBe("");
    expect(val(m, "runs-repo")).toBe("acme/app");
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
    expect(val(again, "runs-repo")).toBe(val(m, "runs-repo"));
    expect(val(again, "owner-filter")).toBe(val(m, "owner-filter"));
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
    a = {
      runs: vi.fn(async (q: any = {}) => data.runs.filter((r) => !q.repo || r.vars.github_repo === q.repo)),
      runFilters: vi.fn(async () => ({ repos: ["o/r", "x/y"], flows: [] })),
      queue: vi.fn(async () => ({ pending: data.pending, active: [] })),
      cancelRun: vi.fn(),
    };
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const repoSelect = (m: FakeElement) => m.all("select").find((s) => s.attrs["data-focus"] === "runs-repo")!;

  it("shows only the matching runs and queued jobs for ?repo=", async () => {
    const { main, stop } = await open({ query: { repo: "O/R" }, go: vi.fn() });
    expect(cards(main)).toHaveLength(2);
    expect(cards(main).join(" ")).toContain("flow-r1");
    expect(cards(main).join(" ")).toContain("queued j1");
    expect(cards(main).join(" ")).not.toContain("flow-r2");
    expect(repoSelect(main).value).toBe("o/r");
    expect(a.runs).toHaveBeenCalledWith({ repo: "o/r" });
    stop();
  });

  it("ignores ?owner= and asks for the runs without an argument", async () => {
    const { main, stop } = await open({ query: { owner: "u9" }, go: vi.fn() });
    expect(cards(main)).toHaveLength(4);
    expect(byClass(main, "filter-bar")).toHaveLength(0);
    expect(a.runs).toHaveBeenCalledWith();
    stop();
  });

  it("choosing All repositories writes #/runs and shows everything", async () => {
    const go = vi.fn();
    const { main, stop } = await open({ query: { repo: "o/r" }, go });
    expect(cards(main)).toHaveLength(2);
    repoSelect(main).fire("change", { target: { value: "" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(go).toHaveBeenCalledWith("#/runs");
    expect(cards(main)).toHaveLength(4);
    stop();
  });

  it("an empty match shows the message and Clear filters, not the no-runs text", async () => {
    const { main, stop } = await open({ query: { repo: "no/pe" }, go: vi.fn() });
    expect(main.textContent).toContain("No runs match your search and filters.");
    expect(main.textContent).not.toContain(mine.NO_RUNS);
    click(button(main, "Clear filters"));
    await vi.advanceTimersByTimeAsync(0);
    expect(cards(main)).toHaveLength(4);
    stop();
  });

  it("notes the cap: for the browser's own filter with an unknown repository, and for 200 server matches", async () => {
    data.runs = Array.from({ length: 200 }, (_, i) => run(`x${i}`, i === 0 ? "o/r" : "x/y"));
    a.runs = vi.fn(async () => data.runs);
    const unknown = await open({ query: { repo: "no/pe" }, go: vi.fn() });
    expect(unknown.main.textContent).toContain(runs.CAP_NOTE);
    unknown.stop();
    const known = await open({ query: { repo: "o/r" }, go: vi.fn() });
    expect(known.main.textContent).toContain(runs.MATCH_NOTE);
    known.stop();
    const { main, stop } = await open({ go: vi.fn() });
    expect(main.textContent).not.toContain(runs.CAP_NOTE);
    expect(main.textContent).not.toContain(runs.MATCH_NOTE);
    stop();
  });

  it("keeps the filter after the 30 second timer", async () => {
    const { main, stop } = await open({ query: { repo: "o/r" }, go: vi.fn() });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.runs.mock.calls.length).toBeGreaterThan(1);
    expect(cards(main)).toHaveLength(2);
    stop();
  });

  describe("search and filters", () => {
    const sel = (m: FakeElement, name: string) => m.all("select").find((s) => s.attrs["data-focus"] === name);
    const search = (m: FakeElement) => m.all("input").find((i) => i.attrs["data-focus"] === "runs-search")!;
    const pickIn = (m: FakeElement, name: string, value: string) => sel(m, name)!.fire("change", { target: { value } });
    const say = (m: FakeElement) => m.all("div").find((d) => d.attrs.role === "status" && d.attrs.class === "sr-only" && d.parent?.attrs.class === "runs-bar")!;

    it("shows the bar without the Owner select, ignores owner, and asks without an argument when nothing is set", async () => {
      const go = vi.fn();
      const { main, stop } = await open({ go });
      expect(search(main)).toBeDefined();
      for (const n of ["runs-repo", "runs-flow", "runs-status", "runs-time"]) expect(sel(main, n), n).toBeDefined();
      expect(sel(main, "owner-filter")).toBeUndefined();
      expect(a.runs).toHaveBeenCalledWith();
      expect(go).not.toHaveBeenCalled();
      stop();
      const filtered = await open({ filter: rf.parseFilter("#/runs?owner=u9&status=failed"), go });
      expect(a.runs).toHaveBeenLastCalledWith({ status: "failed" });
      expect(a.runs.mock.calls.every((c: any[]) => !c[0] || !("owner" in c[0]))).toBe(true);
      filtered.stop();
    });

    it("writes the address and asks the server for a status change; needs only narrows the rows", async () => {
      const go = vi.fn();
      const { main, stop } = await open({ go });
      pickIn(main, "runs-status", "failed");
      await vi.advanceTimersByTimeAsync(0);
      expect(go).toHaveBeenLastCalledWith("#/runs?status=failed");
      expect(a.runs).toHaveBeenLastCalledWith({ status: "failed" });
      const calls = a.runs.mock.calls.length;
      main.all("input").find((i) => i.attrs["data-focus"] === "runs-needs")!.fire("change", { target: { checked: true } });
      expect(go).toHaveBeenLastCalledWith("#/runs?status=failed&needs=1");
      expect(a.runs.mock.calls.length).toBe(calls);
      stop();
    });

    it("types once, 300 ms after the last key, and keeps the search box over a refresh", async () => {
      const { main, stop } = await open({ go: vi.fn() });
      const box = search(main);
      const calls = a.runs.mock.calls.length;
      box.value = "boom";
      box.fire("input", { target: box });
      await vi.advanceTimersByTimeAsync(299);
      expect(a.runs.mock.calls.length).toBe(calls);
      await vi.advanceTimersByTimeAsync(1);
      expect(a.runs).toHaveBeenLastCalledWith({ q: "boom" });
      expect(a.runs.mock.calls.length).toBe(calls + 1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(search(main)).toBe(box);
      expect(box.value).toBe("boom");
      stop();
    });

    it("always redraws on a filter change, also for an equal answer: count and empty state follow", async () => {
      data.runs = [];
      data.pending = [];
      const { main, stop } = await open({ go: vi.fn() });
      expect(main.textContent).toContain(mine.NO_RUNS);
      pickIn(main, "runs-status", "failed");
      await vi.advanceTimersByTimeAsync(0);
      expect(main.textContent).toContain("No runs match your search and filters.");
      expect(say(main).textContent).toBe("0 runs match.");
      stop();
    });

    it("keeps the new filter and shows Could not refresh with Retry when the reload fails", async () => {
      const go = vi.fn();
      const { main, stop } = await open({ go });
      a.runs.mockRejectedValueOnce(new Error("boom"));
      pickIn(main, "runs-status", "failed");
      await vi.advanceTimersByTimeAsync(0);
      expect(go).toHaveBeenCalledTimes(1);
      expect(sel(main, "runs-status")!.value).toBe("failed");
      expect(cards(main)).toHaveLength(4);
      expect(main.textContent).toContain("Could not refresh");
      click(button(main, "Retry"));
      await vi.advanceTimersByTimeAsync(0);
      expect(a.runs).toHaveBeenLastCalledWith({ status: "failed" });
      expect(go).toHaveBeenCalledTimes(1);
      stop();
    });

    it("draws the list with empty menus when runFilters is missing or fails", async () => {
      delete a.runFilters;
      const one = await open({ go: vi.fn() });
      expect(cards(one.main)).toHaveLength(4);
      expect(sel(one.main, "runs-repo")!.all("option")).toHaveLength(1);
      one.stop();
      a.runFilters = vi.fn(async () => { throw new Error("no"); });
      const two = await open({ go: vi.fn() });
      expect(cards(two.main)).toHaveLength(4);
      expect(sel(two.main, "runs-flow")!.all("option")).toHaveLength(1);
      two.stop();
    });

    it("drops the answer of a request overtaken by a filter change, then asks again with the latest filter", async () => {
      const { main, stop } = await open({ go: vi.fn() });
      let first!: (r: any[]) => void;
      a.runs.mockImplementationOnce(() => new Promise((r) => { first = r; }));
      pickIn(main, "runs-status", "failed");
      await vi.advanceTimersByTimeAsync(0);
      pickIn(main, "runs-flow", "flow-r1");
      first([run("r2", "x/y")]);
      await vi.advanceTimersByTimeAsync(0);
      expect(a.runs).toHaveBeenLastCalledWith({ flow: "flow-r1", status: "failed" });
      expect(cards(main).join(" ")).not.toContain("flow-r2 ");
      stop();
    });

    it("clearing the filters before a pending reload ends shows everything again", async () => {
      const { main, stop } = await open({ go: vi.fn() });
      main.all("input").find((i) => i.attrs["data-focus"] === "runs-needs")!.fire("change", { target: { checked: true } });
      expect(cards(main)).toHaveLength(0);
      let first!: (r: any[]) => void;
      a.runs.mockImplementationOnce(() => new Promise((r) => { first = r; }));
      pickIn(main, "runs-status", "failed");
      await vi.advanceTimersByTimeAsync(0);
      click(button(main, "Clear filters"));
      first([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(a.runs).toHaveBeenLastCalledWith();
      expect(cards(main)).toHaveLength(4);
      stop();
    });

    it("does nothing after the cleanup, also with text typed less than 300 ms before", async () => {
      const go = vi.fn();
      const { main, stop } = await open({ go });
      const box = search(main);
      box.value = "late";
      box.fire("input", { target: box });
      stop();
      const calls = a.runs.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(a.runs.mock.calls.length).toBe(calls);
      expect(go).not.toHaveBeenCalled();
    });

    it("asks nothing when the page was left during the repository lookup", async () => {
      let lookup!: (v: any) => void;
      a.runFilters = vi.fn(() => new Promise((r) => { lookup = r; }));
      let live = true;
      const main = document.createElement("div") as unknown as FakeElement;
      const opened = mine.renderMyRuns(main, { a, query: { repo: "o/r" }, go: vi.fn(), alive: () => live });
      await vi.advanceTimersByTimeAsync(0);
      live = false;
      lookup({ repos: ["o/r"], flows: [] });
      await vi.advanceTimersByTimeAsync(0);
      const stop = (await opened) as () => void;
      expect(a.runs).not.toHaveBeenCalled();
      stop();
    });

    it("shows the bar and filters in the read-only preview", async () => {
      const { main, stop } = await open({ readOnly: true, go: vi.fn() });
      expect(search(main)).toBeDefined();
      pickIn(main, "runs-status", "failed");
      await vi.advanceTimersByTimeAsync(0);
      expect(a.runs).toHaveBeenLastCalledWith({ status: "failed" });
      expect(main.all("button").filter((b) => b.textContent === "Remove")).toHaveLength(0);
      stop();
    });
  });
});

describe("saved views in the filter bar and the empty states", () => {
  afterEach(() => f.setContextOffer(null));
  const texts = (bar: FakeElement) => bar.all("button").map((b) => b.textContent);

  it("onSave draws a bar with only Save view; without it the bar is still null", () => {
    expect(f.filterBar({}, {})).toBeNull();
    const onSave = vi.fn();
    const bar = f.filterBar({}, { onSave }) as FakeElement;
    expect(texts(bar)).toEqual(["Save view"]);
    expect(bar.all("button")[0]!.attrs["data-focus"]).toBe("filter-save");
    click(bar.all("button")[0]!);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("Save view comes after Clear filters", () => {
    const bar = f.filterBar({ owner: "u1" }, { onSave: vi.fn() }) as FakeElement;
    expect(texts(bar)).toEqual(["×", "Clear filters", "Save view"]);
  });

  it("a row is drawn above the bar in div.filter-area; with a row and nothing else, only the row", () => {
    const row = new FakeElement("nav");
    const both = f.filterBar({ owner: "u1" }, { row }) as FakeElement;
    expect(both.attrs.class).toBe("filter-area");
    expect(both.children[0]).toBe(row);
    expect((both.children[1] as FakeElement).attrs.class).toBe("filter-bar");
    const only = f.filterBar({}, { row }) as FakeElement;
    expect(only.attrs.class).toBe("filter-area");
    expect(only.children).toEqual([row]);
    expect(f.filterBar({}, { row: null })).toBeNull();
    expect(f.filterBar({}, { row: undefined })).toBeNull();
  });

  it("using the context offer does not hide a bar that has Save view", () => {
    f.setContextOffer({ label: "All repositories", onUse: vi.fn() });
    const bar = f.filterBar({}, { onSave: vi.fn() }) as FakeElement;
    click(button(bar, "Use as my context"));
    expect(bar.hidden).toBe(false);
    expect(button(bar, "Use as my context").hidden).toBe(true);
  });

  it("filterEmpty and filterGone draw Delete this view only with onDelete, and call it", () => {
    expect(button(f.filterEmpty("runs", { repo: "a/b" }, {}), "Delete this view")).toBeUndefined();
    expect(button(f.filterGone({}), "Delete this view")).toBeUndefined();
    const del = vi.fn();
    const empty = f.filterEmpty("runs", { repo: "a/b" }, { onDelete: del });
    expect(button(empty, "Delete this view").attrs["data-focus"]).toBe("filter-empty-delete");
    click(button(empty, "Delete this view"));
    const gone = f.filterGone({ onDelete: del });
    expect(button(gone, "Clear filters")).toBeDefined();
    click(button(gone, "Delete this view"));
    expect(del).toHaveBeenCalledTimes(2);
  });
});

describe("saved views on the admin Runs list and My runs", () => {
  const realFetch = globalThis.fetch;
  const asked: string[] = [];
  const mkRun = (id: string, repo: string) => ({ runId: id, flow: `flow-${id}`, status: "succeeded", startedAt: new Date().toISOString(), history: [], totalCostUsd: 0, task: `task ${id}`, vars: { github_repo: repo } });
  const fakeViews = (list: any[]) => {
    const parts = vi.fn((_filters: any, o: any) => ({
      row: list.length ? new FakeElement("nav") : null,
      onSave: vi.fn(async () => { list.push({}); o.redraw(); }),
      onDelete: null,
      stale: false,
    }));
    return { parts };
  };
  const connected = () => {
    const m = new FakeElement("div") as FakeElement & { isConnected: boolean };
    m.isConnected = true;
    return m;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    asked.length = 0;
    const answers: Record<string, unknown> = {
      "/api/runs": [mkRun("r1", "acme/app")],
      "/api/queue": { pending: [], active: [], concurrency: 2 },
      "/api/run-owners": [{ id: "u1", name: "Ann", runs: 1 }],
    };
    (globalThis as any).fetch = (url: string) => {
      asked.push(url);
      return Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => answers[url] ?? {} });
    };
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it("admin Runs: the row is above the list, Save view is offered without filters, and the owner ids are given", async () => {
    const list: any[] = [{}];
    const views = fakeViews(list);
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, go: vi.fn(), views });
    expect(views.parts.mock.calls[0]![1].owners).toEqual(["u1"]);
    expect(m.all("nav")).toHaveLength(1);
    expect(button(m, "Save view")).toBeDefined();
    const before = asked.length;
    click(button(m, "Save view"));
    await vi.advanceTimersByTimeAsync(0);
    expect(asked.length).toBe(before); // saving a view asks the server for nothing
    stop();
  });

  it("admin Runs: an out-of-date view shows the empty state with both actions, even though runs are listed", async () => {
    const del = vi.fn();
    const views = { parts: () => ({ row: new FakeElement("nav"), onSave: vi.fn(), onDelete: del, stale: true }) };
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, query: { repo: "acme/app" }, go: vi.fn(), views });
    expect(m.all("tr").filter((r) => r.attrs.class === "link")).toHaveLength(0);
    expect(button(m, "Clear filters")).toBeDefined();
    click(button(m, "Delete this view"));
    expect(del).toHaveBeenCalled();
    stop();
  });

  it("admin Runs without views: no Save view, nothing changes", async () => {
    const m = connected();
    const stop = await runs.renderRunsList(m, { admin: true, go: vi.fn(), views: null });
    expect(button(m, "Save view")).toBeUndefined();
    expect(byClass(m, "filter-bar")).toHaveLength(0);
    stop();
  });

  it("My runs: the row and Save view show, and an out-of-date view gets the empty state", async () => {
    const a = { runs: vi.fn(async () => [{ runId: "r1", flow: "f", status: "succeeded", startedAt: new Date().toISOString(), history: [], vars: { github_repo: "o/r" } }]), queue: vi.fn(async () => ({ pending: [], active: [] })), cancelRun: vi.fn() };
    const main = new FakeElement("div") as FakeElement & { isConnected: boolean };
    main.isConnected = true;
    const stop = (await mine.renderMyRuns(main, { a, go: vi.fn(), views: fakeViews([{}]) })) as () => void;
    expect(main.all("nav")).toHaveLength(1);
    expect(button(main, "Save view")).toBeDefined();
    stop();
    const del = vi.fn();
    const m2 = new FakeElement("div") as FakeElement & { isConnected: boolean };
    m2.isConnected = true;
    const stop2 = (await mine.renderMyRuns(m2, { a, query: { repo: "o/r" }, go: vi.fn(), views: { parts: () => ({ row: null, onSave: vi.fn(), onDelete: del, stale: true }) } })) as () => void;
    expect(m2.all("li")).toHaveLength(0);
    click(button(m2, "Delete this view"));
    expect(del).toHaveBeenCalled();
    stop2();
  });
});
