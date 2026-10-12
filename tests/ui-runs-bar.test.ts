import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeElement, installFakeDom } from "./helpers/fake-dom.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
let restore: () => void;
let b: any;
let rf: any;
beforeAll(async () => {
  restore = installFakeDom();
  b = await import("../ui/runs-bar.js" as string);
  rf = await import("../ui/runs-filter.js" as string);
});
afterAll(() => restore());
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const focus = (bar: any, name: string): FakeElement => {
  const all: FakeElement[] = [];
  const walk = (e: FakeElement) => { for (const c of e.children) if (c instanceof FakeElement) { all.push(c); walk(c); } };
  walk(bar.el);
  return all.find((e) => e.attrs["data-focus"] === name)!;
};
const make = (over: any = {}) => {
  const onChange = vi.fn();
  const bar = b.runsBar({ admin: true, onChange, ...over });
  bar.sync(rf.emptyFilter());
  return { bar, onChange };
};
const type = (bar: any, text: string) => { bar.search.value = text; bar.search.fire("input", { target: bar.search }); };

describe("the controls", () => {
  it("each has a stable data-focus name and an accessible name", () => {
    const { bar } = make();
    const names = { "runs-search": "Search runs", "runs-repo": "Repository", "runs-flow": "Flow", "runs-status": "Status", "runs-time": "Time", "owner-filter": "Owner" };
    for (const [name, label] of Object.entries(names)) expect(focus(bar, name).attrs["aria-label"], name).toBe(label);
    expect(focus(bar, "runs-needs").parent!.textContent).toBe("Only what needs me");
    const shows = ["all", "needs", "running", "queued", "failed", "completed", "archived"].map((id) => focus(bar, `runs-view-${id}`).textContent);
    expect(shows).toEqual(["All", "Needs you", "Running", "Queued", "Failed", "Completed", "Archived"]);
    expect(focus(bar, "runs-clear").textContent).toBe("Clear filters");
    expect(bar.search.attrs.maxlength).toBe("200");
    expect(bar.search.attrs.placeholder).toBe("Run id, #7 or text");
  });
  it("has no Owner select for a user", () => {
    const { bar } = make({ admin: false });
    expect(focus(bar, "owner-filter")).toBeUndefined();
  });
});

describe("typing", () => {
  it("asks once, 300 ms after the last key, with the trimmed text", () => {
    const { bar, onChange } = make();
    type(bar, "a");
    vi.advanceTimersByTime(200);
    type(bar, "ab");
    vi.advanceTimersByTime(200);
    type(bar, " abc ");
    vi.advanceTimersByTime(299);
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...rf.emptyFilter(), q: "abc" });
  });
  it("calls nothing for text equal to the committed one", () => {
    const { bar, onChange } = make();
    type(bar, "  ");
    vi.advanceTimersByTime(300);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("hands the pending text over with a change of another control, once", () => {
    const { bar, onChange } = make();
    type(bar, "x");
    focus(bar, "runs-status").fire("change", { target: { value: "failed" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...rf.emptyFilter(), q: "x", status: "failed" });
    vi.advanceTimersByTime(500);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it("sync leaves a pending draft alone and writes the box after the commit", () => {
    const { bar } = make();
    type(bar, "draft");
    bar.sync({ ...rf.emptyFilter(), q: "other" });
    expect(bar.search.value).toBe("draft");
    vi.advanceTimersByTime(300);
    bar.sync({ ...rf.emptyFilter(), q: "other" });
    expect(bar.search.value).toBe("other");
  });
  it("stop() during the 300 ms means no call ever", () => {
    const { bar, onChange } = make();
    type(bar, "x");
    bar.stop();
    vi.advanceTimersByTime(1000);
    focus(bar, "runs-status").fire("change", { target: { value: "failed" } });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("sync and setValues", () => {
  it("draws options, keeps the select node, adds an unknown current value and hides Owner without a list", () => {
    const { bar } = make();
    const repo = focus(bar, "runs-repo");
    bar.setValues({ repos: ["a/b", "c/d"], flows: ["f"], owners: [{ id: "u1", name: "Ann", runs: 2 }, { id: "u2", name: "deleted account", runs: 1 }] });
    expect(repo.all("option").map((o) => o.textContent)).toEqual(["All repositories", "a/b", "c/d"]);
    expect(focus(bar, "owner-filter").all("option").map((o) => o.textContent)).toEqual(["All owners", "Ann (2)", "deleted user (1)"]);
    expect(focus(bar, "owner-filter").hidden).toBe(false);
    bar.sync({ ...rf.emptyFilter(), repo: "x/y" });
    expect(focus(bar, "runs-repo")).toBe(repo);
    expect(repo.all("option").map((o) => o.textContent)).toContain("x/y");
    expect(repo.value).toBe("x/y");
    bar.setValues({ repos: ["a/b"], flows: [], owners: null });
    expect(focus(bar, "owner-filter").hidden).toBe(true);
  });
  it("marks the Show button, the checkbox and Clear filters", () => {
    const { bar, onChange } = make();
    expect(focus(bar, "runs-clear").hidden).toBe(true);
    bar.sync({ ...rf.emptyFilter(), view: "failed", needs: true });
    expect(focus(bar, "runs-view-failed").attrs["aria-pressed"]).toBe("true");
    expect(focus(bar, "runs-view-all").attrs["aria-pressed"]).toBe("false");
    expect(focus(bar, "runs-needs").checked).toBe(true);
    expect(focus(bar, "runs-clear").hidden).toBe(false);
    focus(bar, "runs-view-all").fire("click");
    expect(onChange).toHaveBeenLastCalledWith({ ...rf.emptyFilter(), needs: true, view: "" });
    focus(bar, "runs-clear").fire("click");
    expect(onChange).toHaveBeenLastCalledWith(rf.emptyFilter());
  });
  it("say sets the polite status region", () => {
    const { bar } = make();
    bar.say("2 runs match.");
    const region = bar.el.children.find((c: any) => c instanceof FakeElement && c.attrs.role === "status");
    expect(region.textContent).toBe("2 runs match.");
    expect(region.attrs["aria-live"]).toBe("polite");
  });
});

describe("the Archived button", () => {
  it("asks for view archived", () => {
    const { bar, onChange } = make();
    focus(bar, "runs-view-archived").click();
    expect(onChange).toHaveBeenCalledWith({ ...rf.emptyFilter(), view: "archived" });
  });
});

describe("bulkBar", () => {
  const bulk = (over: any = {}) => {
    const onAct = vi.fn();
    const onClear = vi.fn();
    const bar = b.bulkBar({ onAct, onClear, ...over });
    return { bar, onAct, onClear };
  };
  const text = (bar: any, name: string) => focus(bar, name).textContent;

  it("is hidden for none, then says how many and what the action does", () => {
    const { bar } = bulk();
    expect(bar.el.hidden).toBe(true);
    expect(bar.el.attrs.role).toBe("group");
    expect(bar.el.attrs["aria-label"]).toBe("Selected runs");
    bar.show(1, false, false);
    expect(bar.el.hidden).toBe(false);
    expect(bar.el.textContent).toContain("1 selected");
    expect(text(bar, "bulk-act")).toBe("Archive 1 run");
    bar.show(3, false, false);
    expect(bar.el.textContent).toContain("3 selected");
    expect(text(bar, "bulk-act")).toBe("Archive 3 runs");
    expect(text(bar, "bulk-clear")).toBe("Clear selection");
    bar.show(2, true, false);
    expect(text(bar, "bulk-act")).toBe("Take out of the archive");
    bar.show(0, true, false);
    expect(bar.el.hidden).toBe(true);
  });

  it("calls onAct and onClear, but not while busy", () => {
    const { bar, onAct, onClear } = bulk();
    bar.show(2, false, false);
    focus(bar, "bulk-act").click();
    focus(bar, "bulk-clear").click();
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    bar.show(2, false, true);
    expect(focus(bar, "bulk-act").attrs["aria-disabled"]).toBe("true");
    expect(focus(bar, "bulk-clear").attrs["aria-disabled"]).toBe("true");
    focus(bar, "bulk-act").click();
    focus(bar, "bulk-clear").click();
    expect(onAct).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
    bar.show(2, false, false);
    expect(focus(bar, "bulk-act").attrs["aria-disabled"]).toBeUndefined();
  });

  it("gives the focus to home when it hides with the focus inside", () => {
    const home = new FakeElement("button");
    const { bar } = bulk({ home: () => home });
    bar.show(1, false, false);
    focus(bar, "bulk-clear").focus();
    bar.show(0, false, false);
    expect((globalThis as any).document.activeElement).toBe(home);
    (globalThis as any).document.activeElement = null;
    bar.show(1, false, false);
    bar.show(0, false, false);
    expect((globalThis as any).document.activeElement).toBeNull();
  });
});

describe("bulkArchive", () => {
  const api = (over: any = {}) => ({ archiveRun: vi.fn(async () => ({})), unarchiveRun: vi.fn(async () => ({})), ...over });

  it("asks once with the sentence for one or many, then sends one request per run", async () => {
    const a = api();
    const ask = vi.fn(async () => true);
    expect(await b.bulkArchive(["r1"], { a, ask })).toEqual({ done: 1, refused: [] });
    expect(ask).toHaveBeenLastCalledWith("Archive runs", "Archive 1 run? It stays available under Archived.", "Archive the run", "Keep them");
    expect(await b.bulkArchive(["r1", "r2", "r3"], { a, ask })).toEqual({ done: 3, refused: [] });
    expect(ask).toHaveBeenLastCalledWith("Archive runs", "Archive 3 runs? They stay available under Archived.", "Archive the runs", "Keep them");
    expect(a.archiveRun.mock.calls.map((c: any[]) => c[0])).toEqual(["r1", "r1", "r2", "r3"]);
  });

  it("does nothing for no ids, a no, a failing question or a page that was left", async () => {
    const a = api();
    expect(await b.bulkArchive([], { a, ask: async () => true })).toBeNull();
    expect(await b.bulkArchive(["r1"], { a, ask: async () => false })).toBeNull();
    expect(await b.bulkArchive(["r1"], { a, ask: async () => { throw new Error("x"); } })).toBeNull();
    expect(await b.bulkArchive(["r1"], { a, ask: async () => true, gone: () => true })).toBeNull();
    expect(a.archiveRun).not.toHaveBeenCalled();
  });

  it("takes runs out without asking", async () => {
    const a = api();
    const ask = vi.fn(async () => true);
    expect(await b.bulkArchive(["r1", "r2"], { unarchive: true, a, ask })).toEqual({ done: 2, refused: [] });
    expect(ask).not.toHaveBeenCalled();
    expect(a.unarchiveRun).toHaveBeenCalledTimes(2);
    expect(a.archiveRun).not.toHaveBeenCalled();
  });

  it("sends the requests one after the other", async () => {
    const releases: (() => void)[] = [];
    const a = api({ archiveRun: vi.fn(() => new Promise<void>((r) => releases.push(r))) });
    const done = b.bulkArchive(["r1", "r2"], { a, ask: async () => true });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(a.archiveRun).toHaveBeenCalledTimes(1);
    releases[0]!();
    await vi.waitFor(() => expect(a.archiveRun).toHaveBeenCalledTimes(2));
    releases[1]!();
    expect(await done).toEqual({ done: 2, refused: [] });
  });

  it("collects the sentences of refused runs and keeps going", async () => {
    const a = api({
      archiveRun: vi.fn(async (id: string) => {
        if (id === "r1") throw new Error("Only a finished run can be archived.");
        if (id === "r2") throw new TypeError("fetch failed");
        if (id === "r3") throw {};
        return {};
      }),
    });
    expect(await b.bulkArchive(["r1", "r2", "r3", "r4"], { a, ask: async () => true })).toEqual({
      done: 1, refused: ["Only a finished run can be archived.", "Could not reach the server.", "The server refused."],
    });
  });
});

describe("bulkText", () => {
  it("says how many were archived or taken out", () => {
    expect(b.bulkText({ done: 1, refused: [] }, false)).toBe("Archived 1 run.");
    expect(b.bulkText({ done: 10, refused: [] }, false)).toBe("Archived 10 runs.");
    expect(b.bulkText({ done: 1, refused: [] }, true)).toBe("Took 1 run out of the archive.");
    expect(b.bulkText({ done: 10, refused: [] }, true)).toBe("Took 10 runs out of the archive.");
  });
  it("adds how many were refused and why, each sentence once", () => {
    expect(b.bulkText({ done: 1, refused: ["Busy."] }, false)).toBe("Archived 1 run. 1 was refused: Busy.");
    expect(b.bulkText({ done: 8, refused: ["Busy.", "Busy."] }, true)).toBe("Took 8 runs out of the archive. 2 were refused: Busy.");
    expect(b.bulkText({ done: 0, refused: ["A.", "B."] }, false)).toBe("Archived 0 runs. 2 were refused: A. B.");
  });
});

describe("noMatch", () => {
  it("says so, shows a note and clears", () => {
    const onClear = vi.fn();
    const el = b.noMatch({ onClear, note: "a note" });
    expect(el.textContent).toContain("No runs match your search and filters.");
    expect(el.textContent).toContain("a note");
    el.all("button").find((x: FakeElement) => x.attrs["data-focus"] === "runs-empty-clear")!.fire("click");
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
