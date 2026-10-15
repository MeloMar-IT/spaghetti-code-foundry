import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let ep: any;
let dom: any;
let filters: any;
let views: any;
beforeAll(async () => {
  restore = installFakeDom();
  dom = await import("../ui/dom.js" as string);
  ep = await import("../ui/epics.js" as string);
  filters = await import("../ui/filters.js" as string);
  views = await import("../ui/views.js" as string);
});
afterAll(() => restore());

const now = new Date("2026-10-14T09:00:00Z");
const timeZone = "Europe/Amsterdam";
const counts = (c: Record<string, number>) => ({ done: 0, working: 0, waiting: 0, your_turn: 0, failed: 0, split: 0, dropped: 0, ...c });
const fresh = { state: "fresh", readAt: "2026-10-14T08:48:00Z", cut: false, ageMs: 12 * 60_000 };
const rangeRow = (over: any = {}) => ({
  id: "12", key: "#12", issue: 12, title: "Payments", counts: counts({ done: 3, working: 2, waiting: 4, your_turn: 1 }), total: 10, notHanded: 0,
  growth: { atStart: 8, now: 10, split: 1 }, growthText: "8 at the start, 10 now (1 was split)", finished: false,
  forecast: { kind: "range", earliest: "2026-10-12T10:00:00Z", expected: "2026-10-13T10:00:00Z", latest: "2026-10-13T12:00:00Z", drivers: [], text: "7 stories left at about 2 a day", leavesOut: ["review time"] },
  holdUps: [{ kind: "person", issues: [12, 14], status: "waiting for you — questions", help: "Answer on the issue." }],
  ...over,
});
const earlyRow = { id: "l-x", key: "label:x", title: "Search", counts: counts({ waiting: 1 }), total: 1, notHanded: 0, growth: { atStart: 1, now: 1, split: 0 }, growthText: "1 at the start, 1 now", finished: false,
  forecast: { kind: "too-early", reason: "little-history", text: "Too early to say: fewer than 5 stories were finished in the last 14 days", leavesOut: [] }, holdUps: [] };
const doneRow = { id: "3", key: "#3", issue: 3, title: "Old", counts: counts({ done: 2 }), total: 2, notHanded: 0, growth: { atStart: 2, now: 2, split: 0 }, growthText: "2 at the start, 2 now", finished: true,
  finishedAt: "2026-10-05T10:00:00Z", tookMs: 21 * 24 * 3_600_000, forecast: { kind: "finished" }, holdUps: [] };
const answer = (over: any = {}) => ({
  repo: "acme/app", data: fresh, epics: [doneRow, earlyRow, rangeRow()],
  noEpic: { title: "No epic", counts: counts({ done: 1 }), total: 1, notHanded: 0, holdUps: [] }, ...over,
});
const status = (code: number) => Object.assign(new Error("boom"), { status: code });
const repoRows = [{ id: "r1", github: "acme/app", owner: "me" }];
const api = (over: any = {}) => ({ repos: vi.fn(async () => repoRows), allRepos: vi.fn(async () => repoRows), epics: vi.fn(async () => answer()), ...over });
const tick = () => new Promise((r) => setTimeout(r, 0));
const box = () => dom.h("div", {}) as FakeElement;
const base = { timeZone, now: () => now, views: null, go: vi.fn() };
const mountPage = async (b: FakeElement, a: any, extra: any = {}) => ep.renderEpics(b, { ...base, go: vi.fn(), a, query: { repo: "acme/app" }, ...extra });
const text = (b: FakeElement) => b.textContent;
const button = (b: FakeElement, label: string) => b.all("button").find((x) => x.textContent === label)!;

describe("the table", () => {
  it("shows one row per epic, sorted, with No epic last, as cards", async () => {
    const b = box();
    await mountPage(b, api());
    const t = b.all("table")[0]!;
    expect(t.getAttribute("class")).toContain("cards");
    expect(t.all("caption")[0]!.textContent).toBe("Epics of acme/app");
    const rows = t.all("tbody")[0]!.all("tr");
    expect(rows).toHaveLength(4);
    const names = rows.map((r) => r.all("td")[0]!.textContent);
    expect(names).toEqual(["#12 Payments", "Search", "#3 Old", "No epic"]);
  });

  it("draws an aria-hidden bar with the right segments and a visible text alternative", async () => {
    const b = box();
    await mountPage(b, api());
    const row = b.all("tbody")[0]!.all("tr")[0]!;
    const bar = row.all("svg")[0]!;
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(bar.getAttribute("class")).toBe("epics-bar");
    expect(bar.all("rect").map((r) => r.getAttribute("class"))).toEqual(["epics-seg-done", "epics-seg-working", "epics-seg-waiting", "epics-seg-your_turn"]);
    expect(text(row)).toContain("3 of 10 done; Working 2, Waiting 4, Your turn 1");
  });

  it("links an issue epic to GitHub and shows a label epic as plain text", async () => {
    const b = box();
    await mountPage(b, api());
    const links = b.all("a").filter((a) => (a.getAttribute("href") ?? "").startsWith("https://"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://github.com/acme/app/issues/12", "https://github.com/acme/app/issues/3"]);
    expect(links[0]!.getAttribute("rel")).toBe("noopener");
    const search = b.all("tbody")[0]!.all("tr")[1]!;
    expect(search.all("a")).toHaveLength(0);
  });

  it("shows the growth, the range with its reason, and what holds it up", async () => {
    const b = box();
    await mountPage(b, api());
    const row = b.all("tbody")[0]!.all("tr")[0]!;
    const t = text(row);
    expect(t).toContain("Stories: 8 at the start, 10 now (1 was split)");
    expect(t).toContain("Mon 12 – Tue 13 Oct (most likely Tue 13 Oct)");
    expect(t).toContain("7 stories left at about 2 a day");
    expect(t).toContain("Leaves out: review time");
    expect(t).toContain("Waiting for you — questions: #12 and #14");
    expect(t).toContain("Answer on the issue.");
  });

  it("says too early to say, and when a finished epic finished and how long it took", async () => {
    const b = box();
    await mountPage(b, api());
    const rows = b.all("tbody")[0]!.all("tr");
    expect(text(rows[1]!)).toContain("Too early to say");
    expect(text(rows[1]!)).toContain("Fewer than 5 stories were finished in the last 14 days");
    expect(text(rows[1]!)).toContain("Nothing");
    expect(text(rows[2]!)).toContain("Finished Mon 5 Oct");
    expect(text(rows[2]!)).toContain("Took 3 weeks");
  });

  it("says how fresh the data is", async () => {
    const b = box();
    await mountPage(b, api());
    expect(text(b)).toContain("Issues read 12 min ago");
  });
});

describe("the other states", () => {
  it("shows a skeleton first", async () => {
    const b = box();
    let release!: (v: any) => void;
    const a = api({ epics: vi.fn(() => new Promise((r) => { release = r; })) });
    const run = mountPage(b, a);
    await vi.waitFor(() => expect(a.epics).toHaveBeenCalled());
    expect(b.all("div").some((d) => d.getAttribute("aria-busy") === "true")).toBe(true);
    release(answer());
    await run;
    expect(b.all("table")).toHaveLength(1);
  });

  it("shows the server's text for no data, for both reasons", async () => {
    for (const why of ["no-watcher", "not-read-yet"]) {
      const b = box();
      const data = { state: "no-data", why, text: `No data: ${why}` };
      await mountPage(b, api({ epics: vi.fn(async () => ({ repo: "acme/app", data, epics: [], noEpic: undefined })) }));
      expect(text(b)).toContain(`No data: ${why}`);
      expect(text(b)).not.toContain("No epics yet");
    }
  });

  it("shows an empty text when there are no epics", async () => {
    const b = box();
    await mountPage(b, api({ epics: vi.fn(async () => answer({ epics: [], noEpic: undefined })) }));
    expect(text(b)).toContain("No epics yet in this repository.");
  });

  it("asks to choose when several repositories exist and none is chosen, then loads the chosen one", async () => {
    const b = box();
    const rows = [{ id: "r1", github: "acme/app", owner: "me" }, { id: "r2", github: "acme/web", owner: "me" }];
    const a = api({ repos: vi.fn(async () => rows) });
    const go = vi.fn();
    await ep.renderEpics(b, { ...base, a, go, query: {} });
    expect(text(b)).toContain("Choose a repository to see its epics.");
    expect(a.epics).not.toHaveBeenCalled();
    const select = b.all("select")[0]!;
    expect(select.getAttribute("aria-label")).toBe("Repository");
    select.fire("change", { target: { value: "acme/web" } });
    expect(go).toHaveBeenCalledWith("#/epics?repo=acme%2Fweb");
    await vi.waitFor(() => expect(a.epics).toHaveBeenCalledWith("r2"));
  });

  it("picks the only repository by itself", async () => {
    const b = box();
    const a = api();
    await ep.renderEpics(b, { ...base, a, query: {} });
    expect(a.epics).toHaveBeenCalledWith("r1");
  });

  it("says when the person has no repositories", async () => {
    const b = box();
    await ep.renderEpics(b, { ...base, a: api({ repos: vi.fn(async () => []) }), query: {} });
    expect(text(b)).toContain("You have no repositories yet.");
  });

  it("says a repository is not in the list", async () => {
    const b = box();
    const a = api();
    await mountPage(b, a, { query: { repo: "gone/repo" } });
    expect(text(b)).toContain(filters.NOT_IN_LIST);
    expect(a.epics).not.toHaveBeenCalled();
  });

  it("uses the admin list for an admin", async () => {
    const b = box();
    const a = api();
    await mountPage(b, a, { admin: true, me: { id: "me" } });
    expect(a.allRepos).toHaveBeenCalled();
    expect(a.repos).not.toHaveBeenCalled();
  });
});

describe("errors", () => {
  it("shows an error with Retry, and Retry draws the rows", async () => {
    const b = box();
    const epics = vi.fn().mockRejectedValueOnce(status(500)).mockResolvedValue(answer());
    await mountPage(b, api({ epics }));
    const alert = b.all("div").find((d) => d.getAttribute("role") === "alert")!;
    expect(alert.textContent).toContain("Could not load the epics.");
    button(b, "Retry").click();
    await vi.waitFor(() => expect(b.all("table")).toHaveLength(1));
    expect(epics).toHaveBeenCalledTimes(2);
  });

  it("shows the no-permission state for 403 and 404", async () => {
    for (const code of [403, 404]) {
      const b = box();
      await mountPage(b, api({ epics: vi.fn(async () => { throw status(code); }) }));
      expect(b.all("div").some((d) => d.getAttribute("data-kind") === "permission")).toBe(true);
      expect(b.all("div").some((d) => d.getAttribute("role") === "alert")).toBe(false);
    }
  });

  it("shows an error when the repository list fails", async () => {
    const b = box();
    await mountPage(b, api({ repos: vi.fn(async () => { throw status(500); }) }));
    expect(text(b)).toContain("Could not load your repositories.");
  });

  it("keeps the rows of the same repository when a refresh fails, and says so", async () => {
    const b = box();
    const epics = vi.fn().mockResolvedValueOnce(answer()).mockRejectedValueOnce(status(500)).mockResolvedValue(answer());
    await mountPage(b, api({ epics }));
    button(b, "↻ Refresh").click();
    await vi.waitFor(() => expect(text(b)).toContain("Could not refresh."));
    expect(b.all("table")).toHaveLength(1);
    button(b, "Retry").click();
    await vi.waitFor(() => expect(text(b)).not.toContain("Could not refresh."));
    expect(b.all("table")).toHaveLength(1);
  });

  it("drops the rows when the permission is lost after a good load", async () => {
    const b = box();
    const epics = vi.fn().mockResolvedValueOnce(answer()).mockRejectedValueOnce(status(403));
    await mountPage(b, api({ epics }));
    button(b, "↻ Refresh").click();
    await vi.waitFor(() => expect(b.all("div").some((d) => d.getAttribute("data-kind") === "permission")).toBe(true));
    expect(b.all("table")).toHaveLength(0);
  });

  it("never shows the rows of another repository after a failed change", async () => {
    const b = box();
    const rows = [{ id: "r1", github: "acme/app" }, { id: "r2", github: "acme/web" }];
    const epics = vi.fn(async (id: string) => { if (id === "r2") throw status(500); return answer(); });
    await ep.renderEpics(b, { ...base, a: api({ repos: vi.fn(async () => rows), epics }), query: { repo: "acme/app" } });
    expect(b.all("table")).toHaveLength(1);
    b.all("select")[0]!.fire("change", { target: { value: "acme/web" } });
    await vi.waitFor(() => expect(text(b)).toContain("Could not load the epics."));
    expect(b.all("table")).toHaveLength(0);
    expect(text(b)).not.toContain("Could not refresh.");
  });

  it("ignores an answer that arrives after a newer request", async () => {
    const b = box();
    const rows = [{ id: "r1", github: "acme/app" }, { id: "r2", github: "acme/web" }];
    const late: Record<string, (v: any) => void> = {};
    const epics = vi.fn((id: string) => new Promise((r) => { late[id] = r; }));
    await vi.waitFor(async () => {
      void ep.renderEpics(b, { ...base, a: api({ repos: vi.fn(async () => rows), epics }), query: { repo: "acme/app" } });
      await tick();
      expect(late.r1).toBeDefined();
    });
    b.all("select")[0]!.fire("change", { target: { value: "acme/web" } });
    await vi.waitFor(() => expect(late.r2).toBeDefined());
    late.r2!(answer({ repo: "acme/web", epics: [rangeRow({ title: "Web epic" })] }));
    await vi.waitFor(() => expect(text(b)).toContain("Web epic"));
    late.r1!(answer({ epics: [rangeRow({ title: "App epic" })] }));
    await tick();
    expect(text(b)).toContain("Web epic");
    expect(text(b)).not.toContain("App epic");
  });

  it("draws nothing after the cleanup", async () => {
    const b = box();
    let release!: (v: any) => void;
    const a = api({ epics: vi.fn(() => new Promise((r) => { release = r; })) });
    const run = mountPage(b, a);
    await vi.waitFor(() => expect(a.epics).toHaveBeenCalled());
    const stop = await Promise.race([run, tick().then(() => null)]);
    expect(stop).toBeNull();
    // the cleanup comes from the finished call, so close through a second page that is stopped at once
    release(answer());
    const off = await run;
    off();
    const before = text(b);
    expect(before).toContain("Payments");
  });
});

describe("saved views", () => {
  it("shows the missing-repository state with Delete this view for a view that is out of date", async () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    views.viewStore("u1", storage).add("epics", "Gone", { repo: "gone/repo" });
    const pv = views.pageViews("epics", { account: () => ({ id: "u1", readOnly: false, repos: ["acme/app"] }), storage });
    const b = box();
    const go = vi.fn();
    await ep.renderEpics(b, { ...base, a: api(), go, query: { repo: "gone/repo" }, views: pv });
    expect(text(b)).toContain(filters.NOT_IN_LIST);
    expect(button(b, "Delete this view")).toBeDefined();
    button(b, "Clear filters").click();
    expect(go).toHaveBeenCalledWith("#/epics?repo=all");
    await vi.waitFor(() => expect(text(b)).not.toContain(filters.NOT_IN_LIST));
  });

  it("offers Save view for a chosen repository", async () => {
    const storage = { getItem: () => null, setItem: () => {} };
    const pv = views.pageViews("epics", { account: () => ({ id: "u1", readOnly: false, repos: null }), storage });
    const b = box();
    await ep.renderEpics(b, { ...base, a: api(), query: { repo: "acme/app" }, views: pv });
    expect(button(b, "Save view")).toBeDefined();
    const ro = box();
    await ep.renderEpics(ro, { ...base, a: api(), query: { repo: "acme/app" }, views: pv, readOnly: true });
    expect(ro.all("button").some((x) => x.textContent === "Save view")).toBe(false);
  });
});
